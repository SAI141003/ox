// bench/cost/lib.mjs - sandbox, mock endpoint, and token accounting for the
// COST measurement suite.
//
// Deliberately self-contained, mirroring bench/real/lib.mjs: this file does NOT
// import bench/harness.mjs or bench/runner.mjs. A cost number contaminated by a
// replay harness bug is worse than no number.
//
// Integrity rules encoded here:
//   RULE 1 - MEASURE OR SAY UNMEASURED. Every field is either a value read off
//            something observed in THIS process/run, or the string
//            'unmeasured' plus a `reason`. Nothing is interpolated, averaged
//            from a previous run, or hand-computed to fill a gap.
//   RULE 2 - SAY WHICH BYTES. Token figures are ox's OWN estimator
//            (src/context.js estimateTokens, chars/4) applied to the exact
//            bytes ox put on the wire. That is a byte measurement plus a
//            documented conversion - it is NOT a provider tokenizer, and every
//            field that depends on it carries `estimator`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateTokens } from '../../src/context.js';

export const COST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(COST_DIR, '..', '..');
export const BIN_OX = path.join(REPO_ROOT, 'bin', 'ox.js');

// The one estimator every token figure in this suite goes through.
export const ESTIMATOR = 'src/context.js:estimateTokens (ceil(chars/4))';

// estimateTokens measures a STRING (ceil(length/4)); passing a count here would
// silently measure the digits. Callers hand it the exact text ox put on the wire.
export function toTokens(text) {
  return estimateTokens(String(text ?? ''));
}

export const UNMEASURED = 'unmeasured';

export function unmeasured(reason) {
  return { value: UNMEASURED, reason };
}

// ---------------------------------------------------------------------------
// Sandboxes - a real temp dir with HOME (and every XDG dir ox consults)
// redirected inside it. The repo is never written and the developer's real
// ~/.ox is never read.
// ---------------------------------------------------------------------------

function tagSafe(tag) {
  return String(tag ?? 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

export function createSandbox(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-costbench-${tagSafe(tag)}-`));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, home, ws, tag: tagSafe(tag) };
}

export function destroySandbox(sb) {
  if (!sb?.root) return false;
  try {
    fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

// Cost runs need one deviation from bench/real's liveEnv(): the deterministic
// escape hatches are NOT cleared, because this suite's whole point is pointing
// ox at a loopback mock (OX_BASE_URL) and at a priced model (OX_MODEL_OVERRIDE).
// OX_MAX_COST / OX_FALLBACK_COST / OX_FALLBACK_BOTS ARE cleared so a run can
// never silently inherit a spend cap or a fallback chain from the developer env.
export function sandboxEnv({ home, set = {}, env = process.env } = {}) {
  const out = { ...env, NO_COLOR: '1', OX_NO_BACKUPS: '1' };
  for (const k of ['OX_MAX_COST', 'OX_FALLBACK_COST', 'OX_MODEL_OVERRIDE', 'OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW']) {
    delete out[k];
  }
  out.HOME = home;
  for (const [name, dir] of [
    ['XDG_CONFIG_HOME', '.config'],
    ['XDG_DATA_HOME', path.join('.local', 'share')],
    ['XDG_STATE_HOME', path.join('.local', 'state')],
    ['XDG_CACHE_HOME', '.cache'],
  ]) {
    const full = path.join(home, dir);
    try { fs.mkdirSync(full, { recursive: true }); } catch {}
    out[name] = full;
  }
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || v === null) delete out[k];
    else out[k] = String(v);
  }
  return out;
}

export function writeWs(ws, rel, content) {
  const full = path.join(ws, String(rel ?? ''));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export function readWs(ws, rel) {
  return fs.readFileSync(path.join(ws, String(rel ?? '')), 'utf8');
}

export function oneLine(s, n = 400) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + String.fromCharCode(0x2026) : t;
}

export function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: oneLine(detail, 400) };
}

// ---------------------------------------------------------------------------
// spawnOx - the real agent binary, real tools, real provider wiring.
// ---------------------------------------------------------------------------

export function spawnOx({ args = [], cwd = process.cwd(), env = process.env, timeoutMs = 180_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN_OX, ...args.map(String)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1, Number(timeoutMs) || 180_000));
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, ms: Date.now() - started, timedOut });
    };
    child.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${err.message}\n`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export function parseNdjson(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch {}
  }
  return events;
}

// usage-total is authoritative for the totals; the per-turn `usage` events are
// NOT summed on top of it (that would double count). Both are reported so the
// reconciliation is visible.
export function usageTotals(events) {
  let fromTotal = null;
  const fromEvents = { inputTokens: 0, outputTokens: 0 };
  const auxEvents = { inputTokens: 0, outputTokens: 0 };
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    const t = ev.t ?? ev.type;
    if (t === 'usage-total') {
      fromTotal = {
        inputTokens: Number(ev.inputTokens) || 0,
        outputTokens: Number(ev.outputTokens) || 0,
        costUsd: ev.costUsd ?? null,
        model: ev.model ?? null,
        provider: ev.provider ?? null,
        baseUrl: ev.baseUrl ?? null,
        unknownModels: Array.isArray(ev.unknownModels) ? ev.unknownModels : [],
        knownCostUsd: ev.knownCostUsd ?? null,
        maxCostUsd: ev.maxCostUsd ?? null,
      };
    } else if (t === 'usage') {
      const i = Number(ev.inputTokens) || 0;
      const o = Number(ev.outputTokens) || 0;
      if (ev.aux) {
        auxEvents.inputTokens += i;
        auxEvents.outputTokens += o;
      } else {
        fromEvents.inputTokens += i;
        fromEvents.outputTokens += o;
      }
    }
  }
  return { fromTotal, fromEvents, auxEvents };
}

// ---------------------------------------------------------------------------
// decomposeTokens - where every input token went.
//
// The three component sizes are CHARACTER counts of the exact strings ox sent
// (measured off a captured request body by the caller). They are converted with
// ox's own estimator. `residualTokens` is the gap between the provider's own
// usage-total and ox's estimate of the same payload - it is REPORTED, never
// folded into conversationTokens, because doing so would silently attribute the
// tokenizer difference to the conversation.
// ---------------------------------------------------------------------------

export function decomposeTokens(events, { sizes = null, sizesReason = 'no request body captured in this run' } = {}) {
  const { fromTotal, fromEvents, auxEvents } = usageTotals(events);

  const haveSizes = Boolean(
    sizes &&
    typeof sizes.systemText === 'string' &&
    typeof sizes.schemaText === 'string' &&
    typeof sizes.conversationText === 'string',
  );

  const systemTokens = haveSizes ? toTokens(sizes.systemText) : unmeasured(sizesReason);
  const schemaTokens = haveSizes ? toTokens(sizes.schemaText) : unmeasured(sizesReason);
  const conversationTokens = haveSizes ? toTokens(sizes.conversationText) : unmeasured(sizesReason);

  const floor = haveSizes ? systemTokens + schemaTokens : unmeasured(sizesReason);
  const partsTotal = haveSizes ? systemTokens + schemaTokens + conversationTokens : unmeasured(sizesReason);

  const inputTokens = fromTotal ? fromTotal.inputTokens : unmeasured('no usage-total event in stream');
  const outputTokens = fromTotal ? fromTotal.outputTokens : unmeasured('no usage-total event in stream');

  let overheadRatio;
  if (!fromTotal) overheadRatio = unmeasured('no usage-total event in stream');
  else if (fromTotal.outputTokens > 0) overheadRatio = Number((fromTotal.inputTokens / fromTotal.outputTokens).toFixed(3));
  else overheadRatio = unmeasured('usage-total reports outputTokens=0, ratio undefined');

  const residualTokens = fromTotal && haveSizes ? fromTotal.inputTokens - partsTotal : unmeasured(sizesReason);

  return {
    estimator: ESTIMATOR,
    systemTokens,
    schemaTokens,
    conversationTokens,
    floor,
    partsTotal,
    inputTokens,
    outputTokens,
    overheadRatio,
    residualTokens,
    residualNote:
      fromTotal && haveSizes
        ? 'provider tokenizer vs ox chars/4 estimator; NOT attributed to any component'
        : null,
    sizes: haveSizes ? { systemChars: sizes.systemText.length, schemaChars: sizes.schemaText.length, conversationChars: sizes.conversationText.length } : null,
    sizesReason: haveSizes ? null : sizesReason,
    usageTotal: fromTotal,
    mainUsageEventSum: fromEvents,
    auxUsageEventSum: auxEvents,
    noDoubleCounting:
      fromTotal && haveSizes
        ? 'usage-total is authoritative; per-turn usage events reported separately (mainUsageEventSum) and never added on top'
        : null,
  };
}

// ---------------------------------------------------------------------------
// Mock OpenAI-SSE endpoint. Binds an ephemeral 127.0.0.1 port, records the EXACT
// bytes of every request body ox sends, and replies with a caller-supplied SSE
// script. Nothing leaves the loopback interface.
// ---------------------------------------------------------------------------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

export async function startMockSse({ respond } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      const record = {
        seq: requests.length,
        method: req.method,
        url: req.url,
        rawBytes: Buffer.byteLength(raw),
        raw,
        json,
      };
      requests.push(record);
      const reply = respond ? respond(record) : null;
      const status = reply?.status ?? 200;
      res.writeHead(status, { 'content-type': reply?.contentType ?? 'text/event-stream' });
      if (status === 200 && reply?.raw) {
        res.write(reply.raw);
      } else if (status === 200) {
        res.write(sse({ choices: [{ delta: { content: reply?.text ?? 'ok' } }] }));
        res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    // closeAllConnections is required, not optional: node fetch/undici holds
    // keep-alive sockets open, and server.close() alone waits for them forever.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(true));
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      }),
  };
}

// Split a captured OpenAI-compatible request body into the three buckets the
// accounting cares about, at the exact byte level.
export function measureRequestPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const otherMsgs = messages.filter((m) => m.role !== 'system');

  const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  const systemText = systemMsgs.map(textOf).join('\n');
  const conversationText = otherMsgs
    .map((m) => JSON.stringify({ role: m.role, content: m.content ?? null, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) }))
    .join('\n');
  const toolsJson = Array.isArray(body.tools) ? JSON.stringify(body.tools) : '';

  return {
    systemText,
    schemaText: toolsJson,
    conversationText: conversationText,
    messageCount: messages.length,
    systemMessageCount: systemMsgs.length,
    nonSystemMessageCount: otherMsgs.length,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    systemChars: systemText.length,
    systemBytes: Buffer.byteLength(systemText, 'utf8'),
    schemaChars: toolsJson.length,
    schemaBytes: Buffer.byteLength(toolsJson, 'utf8'),
    conversationChars: conversationText.length,
    conversationBytes: Buffer.byteLength(conversationText, 'utf8'),
    wholeBodyBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
    systemRole: systemMsgs.length ? String(systemMsgs[0].role) : null,
  };
}

// ---------------------------------------------------------------------------
// Logging reverse proxy. Points ox at a loopback port in front of a real local
// endpoint (Ollama), records the EXACT request bytes, and streams the upstream
// response straight back. Unlike startMockSse nothing about the reply is
// fabricated, so the provider's own usage totals are the real ones.
// ---------------------------------------------------------------------------

export async function startLoggingProxy({ upstreamBaseUrl, mutateBody = null } = {}) {
  const upstream = String(upstreamBaseUrl ?? '').replace(/\/+$/, '');
  if (!upstream) throw new Error('startLoggingProxy requires upstreamBaseUrl');
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      const record = { seq: requests.length, method: req.method, url: req.url, rawBytes: Buffer.byteLength(raw), raw, json };
      requests.push(record);


      // mutateBody changes the REQUEST only (never the response); the proxy
      // streams the upstream bytes back byte-for-byte, so every number ox then
      // reports is the upstream provider's own number.
      let upstreamRaw = raw;
      if (mutateBody && json) {
        try { upstreamRaw = JSON.stringify(mutateBody(json, record)); } catch {}
      }
      const headers = { 'content-type': req.headers['content-type'] ?? 'application/json' };
      const upReq = http.request(
        `${upstream}${req.url}`,
        { method: req.method, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
          upRes.on('error', () => res.end());
        },
      );
      upReq.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`proxy error: ${err.message}`);
      });
      upReq.end(upstreamRaw);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    upstreamBaseUrl: upstream,
    requests,
    // closeAllConnections is required, not optional: node fetch/undici holds
    // keep-alive sockets open, and server.close() alone waits for them forever.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(true));
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      }),
  };
}
