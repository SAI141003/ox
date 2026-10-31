import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { expandVars } from './config.js';
import { sanitizeEnv } from './env-sanitize.js';
import { recordDecision } from './audit.js';
import { prepareSandbox } from './sandbox.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A server and everything it started (its process group), then its pipes
// closed, so nothing it left behind keeps ox from exiting.
function killTree(proc, sig) {
  try { if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, sig); else proc.kill(sig); } catch { try { proc.kill(sig); } catch {} }
  if (sig === 'SIGKILL') { for (const s of [proc.stdin, proc.stdout, proc.stderr]) { try { s?.destroy(); } catch {} } try { proc.unref(); } catch {} }
}

// Detached servers do not get the terminal's Ctrl+C or a hang-up: whatever is
// still running when ox exits, for any reason it can catch, is stopped with it.
const LIVE = new Set();
let exitHooked = false;
function trackChild(proc) {
  LIVE.add(proc);
  proc.once('exit', () => LIVE.delete(proc));
  if (exitHooked) return;
  exitHooked = true;
  const stopAll = () => { for (const p of LIVE) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } };
  process.once('exit', stopAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { stopAll(); if (process.listenerCount(sig) === 0) process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[sig]); });
}

// Which servers failed to start lately (name → when), so runs stop waiting on them.
const MCP_HEALTH = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'mcp-health.json');
function readMcpHealth() { try { return JSON.parse(fs.readFileSync(MCP_HEALTH(), 'utf8')) ?? {}; } catch { return {}; } }
function writeMcpHealth(h) { if (process.env.NODE_TEST_CONTEXT && !process.env.OX_HOME) return; try { fs.writeFileSync(MCP_HEALTH(), JSON.stringify(h)); } catch {} }

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_CLIENT_INFO = { name: 'ox', version: '0.1.0' };
// Some real MCP servers compile/load sizeable tool catalogs before replying to
// initialize. The 10s default caused valid servers to be killed during startup.
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
export const MAX_TOOLS_PER_SERVER = 200;
export const STDERR_TAIL_LINES = 50;
export const MAX_CONTENT_CHARS = 25_000;
export const MAX_STDOUT_BUFFER_BYTES = 10 * 1024 * 1024;
export const MAX_HTTP_RESPONSE_BYTES = MAX_STDOUT_BUFFER_BYTES;
export const MAX_REDIRECT_HOPS = 3;
export const MCP_MAX_RECONNECT_ATTEMPTS = 5;
export const MCP_RECONNECT_BASE_MS = 500;

// DeepSeek dsh: deterministic short collision-hash (12 hex) for tool identity.
export function collisionHash (str) {
  return createHash('sha256').update(String(str ?? '')).digest('hex').slice(0, 12);
}

// Wave5a G: allowed-hosts list validation — exact host or host:port entries
// ONLY; wildcards and URL-form entries are refused fail-closed at startup.
export function normalizeAllowedHosts(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const entry = String(raw ?? '').trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('*') || entry.includes('://') || entry.includes('@') || entry.includes('/') || /\s/.test(entry)) {
      throw new Error(
        `ox: mcp_allowed_hosts entry '${raw}' refused — exact host or host:port only (wildcards/URL forms are fail-closed)`
      );
    }
    out.push(entry.replace(/\.$/, ''));
  }
  return out;
}

function hostPortOf(u) {
  const host = String(u.hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '');
  return { host, hostPort: `${host}${u.port ? `:${u.port}` : ''}` };
}

// Wave5a G (OpenBot): MCP HTTP URL hygiene. Throws with a reason on any
// refusal; returns canonical info when acceptable.
export function validateMcpUrl(url, { allowedHosts = [] } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`invalid URL '${url}'`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`refused scheme '${u.protocol}' — http/https only`);
  }
  if (u.username || u.password) {
    throw new Error('credentials embedded in URL refused');
  }
  const { host, hostPort } = hostPortOf(u);
  if (!host) throw new Error('URL has no usable host');
  // IPv6 spellings lose their brackets for range checks.
  const v6 = u.hostname.startsWith('[') ? u.hostname.slice(1, -1).toLowerCase() : '';
  if (v6) {
    if (
      v6 === '::ffff:169.254.169.254' ||
      v6.startsWith('::ffff:169.254.') ||
      v6 === '::ffff:a9fe:a9fe' ||
      v6.startsWith('::ffff:a9fe:')
    ) {
      throw new Error(`metadata endpoint refused (${v6})`);
    }
    if (/^fc|fd[0-9a-f]{2}:/.test(v6)) {
      throw new Error(`unique-local/link-local IPv6 range fc00::/7 refused (${v6})`);
    }
    if (/^fe[89ab]/.test(v6)) {
      throw new Error(`link-local IPv6 range fe80::/10 refused (${v6})`);
    }
  } else {
    if (host === '169.254.169.254') throw new Error('metadata endpoint refused (169.254.169.254)');
    if (host === 'metadata.google.internal') throw new Error('metadata endpoint refused (metadata.google.internal)');
    if (/^169\.254\./.test(host)) throw new Error(`link-local IPv4 range refused (${host})`);
    if (host.endsWith('.internal') && !(allowedHosts.includes(host) || allowedHosts.includes(hostPort))) {
      throw new Error(`'*.internal' host '${host}' requires an explicit mcp_allowed_hosts entry`);
    }
  }
  const allowed = Array.isArray(allowedHosts) ? allowedHosts : [];
  if (allowed.length && !allowed.includes(host) && !allowed.includes(hostPort)) {
    throw new Error(`host '${hostPort || host}' is not in mcp_allowed_hosts`);
  }
  return { ok: true, host, port: u.port || null, url: u.toString() };
}

// Rides along on every http JSON-RPC message for new-era servers that read _meta.
export const MCP_HTTP_META = {
  'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
  clientInfo: { name: 'ox', version: '0.2.0' },
};

// Wave5a B: stdio server env unified through sanitizeEnv ('core'), with the
// per-server cfg.env merged AFTER so servers can still add their own vars.
function baseEnv(env = {}, sandbox = null) {
  const sanitized = sanitizeEnv(process.env, { mode: 'core' });
  const out = { ...sanitized, ...(env && typeof env === 'object' ? env : {}) };
  if (sandbox) {
    // So the server (and a human reading its logs) can tell it is confined and
    // under which policy, instead of guessing from a sandbox-exec in ps.
    out.OX_SANDBOX = '1';
    out.OX_SANDBOX_PROFILE = String(sandbox.name ?? 'custom');
    out.OX_SANDBOX_NETWORK = sandbox.restrict_network === true ? 'restricted' : 'unrestricted';
  }
  return out;
}

function isHttpConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  if (cfg.type === 'http') return true;
  const hasCommand = typeof cfg.command === 'string' && cfg.command.trim();
  const hasUrl = typeof cfg.url === 'string' && !!cfg.url.trim();
  return !hasCommand && hasUrl;
}

function httpHeaders(cfg) {
  // Header VALUES may carry ${VAR} refs; loadConfig already expands them, but a
  // hub built from raw config (tests, programmatic use) must expand here too.
  const raw = cfg && typeof cfg.headers === 'object' && cfg.headers ? cfg.headers : {};
  const user = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    user[k.toLowerCase()] = expandVars(typeof v === 'string' ? v : String(v ?? ''));
  }
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...user,
  };
}

function parseSseRpc(raw, id) {
  const msgs = [];
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    const evMatch = line.match(/^event\s*:\s*(.*)$/i);
    if (evMatch) {
      if (evMatch[1].trim().toLowerCase() === 'end') break;
      continue;
    }
    const dataMatch = line.match(/^data\s*:\s?(.*)$/i);
    if (!dataMatch) continue;
    const payload = dataMatch[1].trim();
    if (payload === '[DONE]') break;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') msgs.push(parsed);
    } catch {}
  }
  return (
    msgs.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined)) ??
    msgs.find((m) => m.result !== undefined || m.error !== undefined) ??
    null
  );
}

function capText(text, cap = MAX_CONTENT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[truncated at ${cap} characters]`;
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') {
        if (typeof p.text === 'string') return p.text;
        return `[${String(p.type ?? 'unknown')}]`;
      }
      return '';
    });
    return parts.filter((x) => x !== '').join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export class McpHub {
  constructor(serversConfig = {}, opts = {}) {
    this.config =
      serversConfig && typeof serversConfig === 'object' && !Array.isArray(serversConfig) ? serversConfig : {};
    this.callTimeoutMs = Number.isFinite(opts.callTimeoutMs) && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : 30_000;
    // Wave5a A / gap #1: MCP servers are ordinary processes that routinely open
    // their own sockets, so spawning them outside the profile left the
    // "network is off" claim false for the whole server tree. The resolved
    // profile is passed in by the session assembler and the prefix from
    // prepareSandbox() is applied to the spawn. stdio framing is unaffected:
    // sandbox-exec and bwrap both pass the three inherited pipes straight
    // through, so a JSON-RPC server behaves identically inside the prefix.
    this.sandbox = opts.sandbox && typeof opts.sandbox === 'object' ? opts.sandbox : null;
    this.startupTimeoutMs =
      Number.isFinite(opts.startupTimeoutMs) && opts.startupTimeoutMs > 0 ? opts.startupTimeoutMs : DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    // Wave5a G: fail-closed startup validation of the allow list.
    this.allowedHosts = normalizeAllowedHosts(opts.allowedHosts);
    this.servers = new Map();
    this._started = false;
    this.fastStart = opts.fastStart === true;
  }

  // Written as each server settles (a short run may exit before the slow ones do).
  _noteHealth(name) {
    const st = this.servers.get(name)?.status;
    const next = readMcpHealth();
    if (st === 'ok') { if (!(name in next)) return; delete next[name]; }
    else if (['crashed', 'http-error', 'timeout'].includes(st)) next[name] = Date.now();
    else return;
    writeMcpHealth(next);
  }

  _state(name, cfg) {
    let s = this.servers.get(name);
    if (!s) {
      s = {
        name,
        cfg,
        status: 'stopped',
        proc: null,
        tools: [],
        stderr: [],
        stderrBuf: '',
        pending: new Map(),
        nextId: 1,
        warnedCrash: false,
        stopping: false,
        stdoutBuf: '',
        generation: 0,
      };
      this.servers.set(name, s);
    }
    return s;
  }

  async start({ waitMs = Number(process.env.OX_MCP_START_MS) || 8000 } = {}) {
    if (this._started) return;
    this._started = true;
    // `ox mcp` and other status checks wait for every server; a run (fastStart) does not.
    if (!this.fastStart) {
      await Promise.allSettled(Object.entries(this.config).map(([name, cfg]) => this._startServer(String(name), cfg)));
      return;
    }
    // All servers at once, and the run waits at most `waitMs` for them: they
    // used to start one after another, so two broken ones (an expired login,
    // Docker not running) held every terminal run back 37 s before its first
    // request. A slow server keeps starting and its tools are there once it is up.
    // A server that failed to start within the last hour (an expired login,
    // Docker off) still starts, in the background, but no run waits on it.
    const health = readMcpHealth();
    const now = Date.now();
    const runs = Object.entries(this.config).map(([name, cfg]) => ({ name: String(name), p: this._startServer(String(name), cfg).catch(() => {}) }));
    const waited = runs.filter((r) => !(health[r.name] && now - health[r.name] < 3_600_000)).map((r) => r.p);
    let timer;
    await Promise.race([Promise.allSettled(waited), new Promise((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]);
    clearTimeout(timer);
    // Still starting after the wait (one waiting on a sign-in in the browser never
    // finishes): later runs do not wait on it either, until it starts fine once.
    const slow = runs.filter((r) => this.servers.get(r.name)?.status === 'starting').map((r) => r.name);
    if (slow.length) { const h = readMcpHealth(); for (const n of slow) h[n] = Date.now(); writeMcpHealth(h); }
    for (const r of runs) r.p.then(() => this._noteHealth(r.name)).catch(() => {});
  }

  _warnHttpUnsupported(state, why) {
    state.status = 'http-unsupported';
    state.proc = null;
    console.warn(`ox: MCP server '${state.name}' skipped — ${why}`);
  }

  // The argv the server actually runs under: the same prefix src/tools/exec.js
  // puts on `bash`, so one profile governs every child process ox starts. A
  // missing/degraded backend degrades to an unsandboxed spawn and says so,
  // rather than pretending the server was confined.
  _spawnPlan(cfg) {
    const command = cfg.command;
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    const profile = this.sandbox;
    if (!profile || profile.kind === 'off') return { command, args, backend: null };
    let runner = null;
    try {
      runner = prepareSandbox(profile);
    } catch (err) {
      console.warn(
        `ox: MCP server '${command}' spawned WITHOUT the sandbox (compile failed: ${String(err?.message ?? err)}) — ` +
          'it can make unrestricted network calls'
      );
      return { command, args, backend: null };
    }
    if (!runner || runner.degraded || !Array.isArray(runner.argvPrefix)) {
      console.warn(
        `ox: MCP server '${command}' spawned WITHOUT the sandbox (no OS backend for profile ` +
          `'${profile.name ?? 'custom'}') — it can make unrestricted network calls`
      );
      return { command, args, backend: null };
    }
    return { command: runner.argvPrefix[0], args: [...runner.argvPrefix.slice(1), command, ...args], backend: runner.backend };
  }

  async _startServer(name, rawCfg) {
    const cfg = rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg) ? rawCfg : null;
    if (isHttpConfig(cfg)) return this._startHttpServer(name, cfg);
    const state = this._state(name, cfg);
    this._resetState(state);

    if (!cfg || typeof cfg.command !== 'string' || !cfg.command.trim()) {
      this._warnHttpUnsupported(state, 'entry has no usable command');
      return;
    }

    state.status = 'starting';
    const gen = state.generation;
    const plan = this._spawnPlan(cfg);
    state.sandboxBackend = plan.backend;
    let proc;
    try {
      proc = spawn(plan.command, plan.args, {
        env: baseEnv(cfg.env, plan.backend ? this.sandbox : null),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so stopping it stops what it started: `npx`
        // and `uvx` run the real server as a grandchild, which outlived a kill
        // of npx and held ox open for minutes after its answer.
        detached: process.platform !== 'win32',
      });
      if (process.platform !== 'win32') trackChild(proc);
    } catch (e) {
      state.status = 'crashed';
      console.error(`ox: MCP server '${name}' failed to spawn (${cfg.command}): ${String((e && e.message) || e)}`);
      return;
    }
    state.proc = proc;

    // A server that exits at once (a wrong command, `echo`) closes its stdin
    // while ox is still writing the handshake. The failed write arrives later
    // as an 'error' event on the pipe, which _send's try/catch cannot see, and
    // with no listener it was thrown as an uncaught EPIPE (Linux CI). It means
    // the server is gone: what was waiting on it fails, ox goes on.
    proc.stdin?.on('error', (e) => {
      if (state.generation !== gen) return;
      this._rejectPending(state, new Error(`MCP server '${name}' closed its input: ${String((e && e.message) || e)}`));
    });

    proc.on('error', (e) => {
      if (state.generation !== gen) return;
      if (!state.stopping && state.status !== 'crashed' && state.status !== 'timeout' && state.status !== 'stopped') {
        state.status = 'crashed';
      }
      this._crashWarn(state, `spawn error: ${String((e && e.message) || e)}`);
      this._rejectPending(state, new Error(`MCP server '${name}' failed: ${String((e && e.message) || e)}`));
    });

    proc.stdout.on('data', (chunk) => {
      if (state.generation !== gen) return;
      state.stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = state.stdoutBuf.indexOf('\n')) !== -1) {
        const line = state.stdoutBuf.slice(0, idx);
        state.stdoutBuf = state.stdoutBuf.slice(idx + 1);
        this._onFrame(state, line);
      }
      if (state.stdoutBuf.length > MAX_STDOUT_BUFFER_BYTES) {
        state.status = 'overflow';
        state.stdoutBuf = '';
        console.error(
          `ox: MCP server '${name}' exceeded the ${MAX_STDOUT_BUFFER_BYTES}-byte stdout frame buffer — killing it`
        );
        this._killNow(state);
        this._rejectPending(
          state,
          new Error(`MCP server '${name}' overflowed the stdout frame buffer (status: overflow)`)
        );
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (state.generation !== gen) return;
      state.stderrBuf += chunk.toString('utf8');
      let idx;
      while ((idx = state.stderrBuf.indexOf('\n')) !== -1) {
        const line = state.stderrBuf.slice(0, idx);
        state.stderrBuf = state.stderrBuf.slice(idx + 1);
        if (line.trim()) {
          state.stderr.push(line.slice(0, 500));
          while (state.stderr.length > STDERR_TAIL_LINES) state.stderr.shift();
        }
      }
    });

    proc.on('exit', (code, signal) => {
      if (state.generation !== gen) return;
      state.proc = null;
      const deliberate =
        state.stopping || state.status === 'stopped' || state.status === 'timeout' || state.status === 'overflow';
      if (!deliberate) {
        state.status = 'crashed';
        this._crashWarn(state, `exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`);
      }
      this._rejectPending(state, new Error(`MCP server '${name}' exited before responding`));
    });

    try {
      const initResult = await this._request(
        state,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        },
        this.startupTimeoutMs
      );
      void initResult;
    } catch (e) {
      if (state.generation !== gen) return;
      if (e?.timeout) {
        state.status = 'timeout';
        console.error(
          `ox: MCP server '${name}' did not complete initialize within ${this.startupTimeoutMs}ms — killing it`
        );
      } else if (state.status === 'starting') {
        state.status = 'crashed';
      }
      this._killNow(state);
      return;
    }
    if (state.generation !== gen) return;

    this._notify(state, 'notifications/initialized');

    try {
      await this._listTools(state);
    } catch (e) {
      if (state.generation !== gen) return;
      state.stderr.push(`tools/list failed: ${String((e && e.message) || e)}`.slice(0, 500));
      while (state.stderr.length > STDERR_TAIL_LINES) state.stderr.shift();
    }
    if (state.generation !== gen) return;
    state.status = 'ok';
  }

  _crashWarn(state, detail) {
    if (state.warnedCrash) return;
    state.warnedCrash = true;
    console.error(`ox: MCP server '${state.name}' crashed — ${detail}. Use /mcp restart to re-spawn it.`);
  }

  _resetState(state) {
    state.generation++;
    state.tools = [];
    state.stderr = [];
    state.stderrBuf = '';
    state.stdoutBuf = '';
    state.warnedCrash = false;
    state.stopping = false;
  }

  async _startHttpServer(name, cfg) {
    const state = this._state(name, cfg);
    this._resetState(state);
    const gen = state.generation;

    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    if (!url || !/^https?:\/\//i.test(url)) {
      state.status = 'http-unsupported';
      state.proc = null;
      console.warn(`ox: MCP server '${name}' skipped — http entry needs an absolute http(s) 'url'`);
      return;
    }
    // Wave5a G: URL/host hygiene at hub start (fail-closed).
    try {
      validateMcpUrl(url, { allowedHosts: this.allowedHosts });
    } catch (e) {
      state.status = 'http-error';
      state.proc = null;
      const why = String(e?.message ?? e);
      state.stderr.push(`url refused: ${why}`.slice(0, 500));
      console.error(`ox: MCP server '${name}' refused at startup — ${why}`);
      return;
    }

    state.status = 'starting';
    try {
      await this._request(
        state,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        },
        this.startupTimeoutMs
      );
    } catch (e) {
      if (state.generation !== gen) return;
      state.status = e?.timeout ? 'timeout' : 'http-error';
      const detail = String((e && e.message) || e).slice(0, 500);
      state.stderr.push(`initialize failed: ${detail}`);
      while (state.stderr.length > STDERR_TAIL_LINES) state.stderr.shift();
      console.error(`ox: MCP server '${name}' http initialize failed (${state.status}): ${detail}`);
      return;
    }
    if (state.generation !== gen) return;

    // Stateless single-shot transport: no notifications/initialized round-trip,
    // no server-initiated pings to answer.
    try {
      await this._listTools(state);
    } catch (e) {
      if (state.generation !== gen) return;
      state.stderr.push(`tools/list failed: ${String((e && e.message) || e)}`.slice(0, 500));
      while (state.stderr.length > STDERR_TAIL_LINES) state.stderr.shift();
    }
    if (state.generation !== gen) return;
    state.status = 'ok';
  }

  async _httpRequest(state, method, params, timeoutMs = this.callTimeoutMs) {
    const id = state.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...(params && typeof params === 'object' ? params : {}), _meta: { ...MCP_HTTP_META } },
    });
    // Wave5a G: per-request revalidation of the configured URL.
    validateMcpUrl(String(state.cfg.url), { allowedHosts: this.allowedHosts });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
    const mapFetchError = (e) => {
      let err;
      if (ctrl.signal.aborted) {
        err = new Error(`MCP '${state.name}': ${method} timed out after ${timeoutMs}ms`);
        err.timeout = true;
      } else {
        err = new Error(
          `MCP '${state.name}': ${method} request failed: ${String(e?.cause?.message ?? e?.message ?? e)}`
        );
      }
      return err;
    };
    // Wave5a G: manual redirect handling — every hop is re-validated and
    // audited; more than MAX_REDIRECT_HOPS hops aborts.
    let res = null;
    let currentUrl = String(state.cfg.url);
    for (let hop = 0; ; hop++) {
      let hopRes;
      try {
        hopRes = await fetch(currentUrl, {
          method: 'POST',
          headers: httpHeaders(state.cfg),
          body,
          signal: ctrl.signal,
          redirect: 'manual',
        });
      } catch (e) {
        clearTimeout(timer);
        // DeepSeek dsh: bounded auto-reconnect on transport death.
        if (await this._reconnectHttp(state)) {
          return this._httpRequest(state, method, params, timeoutMs);
        }
        throw mapFetchError(e);
      }
      if ([301, 302, 303, 307, 308].includes(hopRes.status)) {
        const loc = hopRes.headers.get('location');
        try {
          await hopRes.arrayBuffer();
        } catch {}
        if (hop >= MAX_REDIRECT_HOPS) {
          clearTimeout(timer);
          throw new Error(`MCP '${state.name}': ${method} redirect refused — more than ${MAX_REDIRECT_HOPS} hops`);
        }
        if (!loc) {
          clearTimeout(timer);
          throw new Error(`MCP '${state.name}': ${method} redirect refused — missing Location header`);
        }
        let nextAbs;
        try {
          nextAbs = new URL(loc, currentUrl).toString();
        } catch {
          clearTimeout(timer);
          throw new Error(`MCP '${state.name}': ${method} redirect refused — invalid Location '${loc}'`);
        }
        try {
          validateMcpUrl(nextAbs, { allowedHosts: this.allowedHosts });
        } catch (e) {
          clearTimeout(timer);
          recordDecision({
            session: state.name,
            tool: `mcp:${state.name}`,
            detail: `${currentUrl} → ${loc}`.slice(0, 120),
            decision: 'deny',
            rule: 'mcpRedirect',
            actor: 'policy',
          });
          throw new Error(`MCP '${state.name}': ${method} redirect refused — ${String(e?.message ?? e)}`);
        }
        recordDecision({
          session: state.name,
          tool: `mcp:${state.name}`,
          detail: nextAbs.slice(0, 120),
          decision: 'allow',
          rule: 'mcpRedirect',
          actor: 'policy',
        });
        currentUrl = nextAbs;
        continue;
      }
      res = hopRes;
      break;
    }
    if (!res.ok) {
      clearTimeout(timer);
      const err = new Error(`MCP '${state.name}': ${method} got HTTP ${res.status} ${res.statusText ?? ''}`.trim());
      err.httpStatus = res.status;
      throw err;
    }
    let raw;
    try {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_HTTP_RESPONSE_BYTES) {
        const err = new Error(
          `MCP server '${state.name}' exceeded the ${MAX_HTTP_RESPONSE_BYTES}-byte http response cap`
        );
        err.overflow = true;
        throw err;
      }
      raw = Buffer.from(ab).toString('utf8');
    } catch (e) {
      clearTimeout(timer);
      if (e?.overflow) throw e;
      let err;
      if (ctrl.signal.aborted) {
        err = new Error(`MCP '${state.name}': ${method} timed out after ${timeoutMs}ms`);
        err.timeout = true;
      } else {
        err = new Error(`MCP '${state.name}': ${method} response read failed: ${String(e?.message ?? e)}`);
      }
      throw err;
    }
    clearTimeout(timer);

    const ctype = String(res.headers.get('content-type') ?? '').toLowerCase();
    let msg;
    if (ctype.includes('text/event-stream')) {
      msg = parseSseRpc(raw, id);
      if (!msg) throw new Error(`MCP '${state.name}': ${method}: event-stream carried no JSON-RPC response`);
    } else if (ctype.includes('json') || /^\s*\{/.test(raw)) {
      try {
        msg = JSON.parse(raw);
      } catch {
        throw new Error(`MCP '${state.name}': ${method}: malformed JSON response`);
      }
      if (!msg || typeof msg !== 'object') {
        throw new Error(`MCP '${state.name}': ${method}: malformed JSON response`);
      }
    } else {
      throw new Error(`MCP '${state.name}': ${method}: unsupported content-type '${ctype || 'unknown'}'`);
    }

    if (msg.error !== undefined && msg.error !== null) {
      const err = new Error(
        `MCP error ${String(msg.error.code ?? '?')}: ${String(msg.error.message ?? 'unknown error')}`
      );
      err.rpcCode = msg.error.code;
      throw err;
    }
    return msg.result;
  }

  _send(state, msg) {
    const proc = state.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed || proc.exitCode !== null) return false;
    try {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  _notify(state, method, params = undefined) {
    if (isHttpConfig(state.cfg)) return false;
    const msg = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this._send(state, msg);
  }

  _request(state, method, params, timeoutMs = this.callTimeoutMs) {
    if (isHttpConfig(state.cfg)) return this._httpRequest(state, method, params, timeoutMs);
    const id = state.nextId++;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    promise.requestId = id;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      const e = new Error(`MCP '${state.name}': ${method} timed out after ${timeoutMs}ms`);
      e.timeout = true;
      rejectFn(e);
    }, timeoutMs);
    state.pending.set(id, { resolve: resolveFn, reject: rejectFn, timer });
    if (!this._send(state, { jsonrpc: '2.0', id, method, params })) {
      clearTimeout(timer);
      state.pending.delete(id);
      rejectFn(new Error(`MCP server '${state.name}' is not accepting input (status: ${state.status})`));
    }
    return promise;
  }

  _rejectPending(state, err) {
    for (const [id, p] of state.pending) {
      clearTimeout(p.timer);
      p.reject(err instanceof Error ? err : new Error(String(err)));
      state.pending.delete(id);
    }
  }

  _onFrame(state, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      if (msg.method === 'ping') {
        this._send(state, { jsonrpc: '2.0', id: msg.id, result: {} });
      } else {
        this._send(state, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not supported by ox client: ${msg.method}` },
        });
      }
      return;
    }

    if (msg.method != null && msg.id == null) {
      if (msg.method === 'notifications/tools/list_changed') {
        this._listTools(state).catch(() => {});
      }
      return;
    }

    if (msg.id === undefined || msg.id === null) return;
    const p = state.pending.get(msg.id);
    if (!p) return;
    state.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const e = new Error(
        `MCP error ${String(msg.error.code ?? '?')}: ${String(msg.error.message ?? 'unknown error')}`
      );
      e.rpcCode = msg.error.code;
      p.reject(e);
    } else {
      p.resolve(msg.result);
    }
  }

  async _listTools(state) {
    const tools = [];
    let cursor;
    do {
      const res = await this._request(state, 'tools/list', cursor ? { cursor } : {}, this.callTimeoutMs);
      const page = res && Array.isArray(res.tools) ? res.tools : [];
      for (const t of page) {
        if (tools.length >= MAX_TOOLS_PER_SERVER) break;
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        tools.push({
          server: state.name,
          name: t.name,
          qualified: `mcp__${state.name}__${t.name}`,
          schema: {
            description: typeof t.description === 'string' ? t.description : '',
            input_schema:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
          },
        });
      }
      cursor = res && typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
    } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
    state.tools = tools;
    return tools;
  }

  _findTool(qualified) {
    for (const state of this.servers.values()) {
      for (const t of state.tools) {
        if (t.qualified === qualified) return { state, tool: t };
      }
    }
    return null;
  }

  async call(qualified, args = {}) {
    const found = this._findTool(String(qualified ?? ''));
    if (!found) {
      return { content: `MCP tool not found: ${qualified}`, isError: true };
    }
    const { state, tool } = found;
    const isHttp = isHttpConfig(state.cfg);
    if (state.status !== 'ok' || (!isHttp && !state.proc)) {
      return {
        content: `MCP server '${state.name}' is ${state.status} — tool '${qualified}' unavailable.`,
        isError: true,
      };
    }
    let result;
    const req = this._request(
      state,
      'tools/call',
      { name: tool.name, arguments: args ?? {} },
      this.callTimeoutMs
    );
    try {
      result = await req;
    } catch (e) {
      if (e?.timeout) {
        if (!isHttp) {
          this._notify(state, 'notifications/cancelled', {
            requestId: req.requestId,
            reason: 'ox call timeout',
          });
        }
        throw e;
      }
      return { content: String((e && e.message) || e), isError: true };
    }
    if (result && typeof result === 'object' && result.isError === true) {
      return { content: capText(contentToText(result.content)), isError: true };
    }
    if (typeof result === 'string') return { content: capText(result) };
    return { content: capText(contentToText(result?.content)) };
  }

  async restart(serverName) {
    const name = String(serverName ?? '');
    const state = this.servers.get(name);
    if (!state) {
      throw new Error(`ox: no MCP server named '${name}' (known: ${[...this.servers.keys()].join(', ')})`);
    }
    const cfg = state.cfg;
    await this._kill(state, 1500);
    state.status = 'stopped';
    await this._startServer(name, cfg);
  }

  _killNow(state) {
    const proc = state.proc;
    if (!proc) return;
    try {
      if (proc.exitCode === null) killTree(proc, 'SIGKILL');
    } catch {}
  }

  _kill(state, graceMs) {
    state.stopping = true;
    return new Promise((resolve) => {
      const proc = state.proc;
      const finish = () => {
        state.stopping = true;
        this._rejectPending(state, new Error(`MCP server '${state.name}' stopped`));
        resolve();
      };
      if (!proc || proc.exitCode !== null) {
        finish();
        return;
      }
      let done = false;
      const onExit = () => {
        if (done) return;
        done = true;
        finish();
      };
      proc.once('exit', onExit);
      setTimeout(() => {
        try {
          if (proc.exitCode === null) killTree(proc, 'SIGKILL');
        } catch {}
      }, graceMs);
      setTimeout(onExit, graceMs + 500);
      try {
        proc.stdin?.end();
      } catch {}
      try {
        killTree(proc, 'SIGTERM');
      } catch {}
    });
  }

  status() {
    return [...this.servers.values()].map((s) => ({
      server: s.name,
      status: s.status,
      tools: s.tools.length,
      ...(s.stderr.length ? { stderrTail: s.stderr.join('\n') } : {}),
    }));
  }

  schemas() {
    const out = [];
    const seen = new Map();
    for (const state of this.servers.values()) {
      for (const t of state.tools) {
        let name = t.qualified;
        // DeepSeek dsh: deterministic collision-hash disambiguation when two
        // servers expose tools that normalize to the same qualified name.
        if (seen.has(name)) {
          name = `mcp__${t.server}__${collisionHash(t.name)}`;
        }
        seen.set(name, true);
        out.push({ name, description: t.schema.description, input_schema: t.schema.input_schema });
      }
    }
    return out;
  }

  // DeepSeek dsh: bounded auto-reconnect with exponential backoff budget.
  async _reconnectHttp(state) {
    if (state.stopping || !state.cfg || !isHttpConfig(state.cfg)) return false;
    state.reconnectAttempts = state.reconnectAttempts || 0;
    if (state.reconnectAttempts >= MCP_MAX_RECONNECT_ATTEMPTS) {
      state.status = 'http-unsupported';
      return false;
    }
    const backoff = MCP_RECONNECT_BASE_MS * 2 ** state.reconnectAttempts;
    state.reconnectAttempts++;
    await new Promise((r) => setTimeout(r, backoff));
    try {
      await this._startHttpServer(state.name, state.cfg);
      return state.status === 'ok';
    } catch {
      return false;
    }
  }

  async stop() {
    const kills = [];
    for (const state of this.servers.values()) {
      state.stopping = true;
      kills.push(this._kill(state, 2000).then(() => {
        state.status = 'stopped';
      }));
    }
    await Promise.all(kills);
    this._started = false;
  }
}
