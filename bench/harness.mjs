// bench/harness.mjs — shared deterministic test infrastructure for the ox bench.
// Zero deps. Network is loopback-only (mock OpenAI-SSE server on 127.0.0.1:0).
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN_OX = path.join(REPO_ROOT, 'bin', 'ox.js');
export const SSE_DONE = '[DONE]';

// ---------------------------------------------------------------------------
// SSE payload builders (minimal reimplementation — no imports from test/)
// ---------------------------------------------------------------------------

let chunkSeq = 0;
function baseChunk(model) {
  chunkSeq += 1;
  return {
    id: `chatcmpl-bench-${chunkSeq}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
}

export function sseText(text, model = 'grok-4.6') {
  const c = baseChunk(model);
  c.choices[0].delta = { content: text };
  return c;
}

export function sseToolCall(calls, model = 'grok-4.6') {
  // calls: [{ id, name, args }] emitted as one OpenAI-style delta fragment each
  const c = baseChunk(model);
  c.choices[0].delta = {
    tool_calls: calls.map((call, i) => ({
      index: i,
      id: call.id ?? `call_bench_${chunkSeq}_${i}`,
      type: 'function',
      function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}) },
    })),
  };
  return c;
}

export function sseFinish(reason = 'stop', model = 'grok-4.6') {
  const c = baseChunk(model);
  c.choices[0].finish_reason = reason;
  return c;
}

export function sseUsage({ in: tin = 0, out: tout = 0 }) {
  return { usage: { prompt_tokens: tin, completion_tokens: tout } };
}

// One full assistant completion: optional text, optional tool calls, usage.
export function turn({ text = '', calls = null, usage = { in: 600, out: 120 }, finish = null, model = 'grok-4.6' } = {}) {
  const out = [];
  if (text) out.push(sseText(text, model));
  if (calls && calls.length) {
    out.push(sseToolCall(calls, model));
    finish = finish ?? 'tool_calls';
  }
  out.push(sseFinish(finish ?? 'stop', model));
  out.push(sseUsage(usage));
  out.push(SSE_DONE);
  return out;
}

// ---------------------------------------------------------------------------
// Mock OpenAI-SSE server (loopback only, port 0)
// ---------------------------------------------------------------------------

export function startMock({ script, tokensPerTurn = { in: 600, out: 120 }, model = "grok-4.6", ws = null } = {}) {
  const state = {
    requests: [],   // parsed request bodies in arrival order
    flags: {},      // scenarios record assertions here
    errors: [],
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d.toString('utf8'); });
    req.on('end', async () => {
      const okUrl = req.method === 'POST' && String(req.url).endsWith('/chat/completions');
      if (!okUrl) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bench mock: unsupported ${req.method} ${req.url}` } }));
        return;
      }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bench mock: bad JSON body: ${e.message}` } }));
        return;
      }
      const idx = state.requests.length;
      state.requests.push(body);
      let payloads;
      try {
        payloads = await script(body, ws, state);
      } catch (e) {
        state.errors.push(`script threw on request #${idx}: ${e?.message ?? e}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        return;
      }
      if (!Array.isArray(payloads)) payloads = [];
      if (!payloads.includes(SSE_DONE)) payloads = [...payloads, SSE_DONE];
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const p of payloads) {
        res.write(p === SSE_DONE ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(p)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}/v1`,
        requests: state.requests,
        flags: state.flags,
        errors: state.errors,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Sandboxes
// ---------------------------------------------------------------------------

export function createSandbox(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-bench-${tag}-`));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  return { root, home, ws };
}

export function destroySandbox(sb) {
  if (!sb?.root) return;
  try { fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

// ---------------------------------------------------------------------------
// ox child-process runner
// ---------------------------------------------------------------------------

const PROVIDER_KEY_ENVS = [
  'XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
];

// Deterministic-mode env: loopback provider via OX_BASE_URL, sandboxed HOME,
// real provider keys stripped so nothing can leave the machine.
export function deterministicEnv({ home, baseUrl, apiKey = 'bench', model = 'grok-4.6', extra = {} } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (PROVIDER_KEY_ENVS.includes(k)) continue;
    if (k === 'OX_BASE_URL' || k === 'OX_MODEL' || k === 'OX_YOLO' || k === 'OX_MAX_COST') continue;
    env[k] = v;
  }
  env.HOME = home;
  env.NO_COLOR = '1';
  env.OX_NO_BACKUPS = '1';
  if (baseUrl) env.OX_BASE_URL = baseUrl;
  env.OX_API_KEY = apiKey;
  if (model) env.OX_MODEL = model;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// Live-mode env: keep real keys, still isolate HOME + workspace.
export function liveEnv({ home, extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: '1', OX_NO_BACKUPS: '1' };
  delete env.OX_BASE_URL;
  delete env.OX_MODEL;
  env.HOME = home;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

export function parseNdjsonEvents(stdout) {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue; // non-JSON UI noise (approval notices etc.)
    try { events.push(JSON.parse(t)); } catch {}
  }
  return events;
}

export function spawnOx({ args = [], env = process.env, cwd = process.cwd(), timeoutMs = 25_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN_OX, ...args.map(String)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored → immediate EOF for piped-stdin probe
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      // Resolution happens on 'close', which fires only once the process is
      // reaped AND stdout/stderr have hit EOF. A SIGKILLed process that left a
      // grandchild holding the inherited pipe never closes it, so 'close' can
      // arrive long after the budget expired — one stalled scenario cost 82s of
      // a 25s budget, which is most of the wall time of a full bench run. The
      // output is truncated by definition on this path, so tear the pipes down
      // and let the death of the process end the wait. The success path is
      // untouched: its streams are only torn down when the run is already over.
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}\n`, ms: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, ms: Date.now() - started, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Request-inspection helpers for scripts and checks
// ---------------------------------------------------------------------------

export function systemOf(body) {
  const m = (body?.messages ?? []).find((x) => x?.role === 'system');
  return typeof m?.content === 'string' ? m.content : '';
}

export function toolCallsIn(body) {
  const out = [];
  for (const m of body?.messages ?? []) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) out.push(...m.tool_calls);
  }
  return out;
}

export function toolResultsIn(body, name = null) {
  return (body?.messages ?? []).filter(
    (m) => m?.role === 'tool' && (name == null || (toolCallsIn(body).some((c) => c.id === m.tool_call_id && c.function?.name === name)))
  );
}

export function countExecuted(body, name) {
  return toolResultsIn(body, name).length;
}

export function lastRole(body) {
  const msgs = body?.messages ?? [];
  return msgs.length ? msgs[msgs.length - 1]?.role : null;
}

export function finalTextOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.t === 'final' && typeof ev.message?.content === 'string') return ev.message.content;
  }
  return events.filter((e) => e?.t === 'text-delta').map((e) => e.text ?? '').join('');
}

export function usageTotals(events) {
  let tin = 0;
  let tout = 0;
  for (const ev of events) {
    if (ev?.t === 'usage') { tin += ev.inputTokens ?? 0; tout += ev.outputTokens ?? 0; }
    if (ev?.t === 'usage-total') { tin = ev.inputTokens ?? tin; tout = ev.outputTokens ?? tout; }
  }
  return { inputTokens: tin, outputTokens: tout };
}

export function readWs(sb, rel) {
  return fs.readFileSync(path.join(sb.ws, rel), 'utf8');
}

export function writeWs(sb, rel, content) {
  fs.mkdirSync(path.dirname(path.join(sb.ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(sb.ws, rel), content);
}

export function wsPath(sb, rel = '') {
  return path.join(sb.ws, rel);
}

// Cold-start timing helper (used by 15-overhead-profile)
export function timeColdStarts(n, args = ['--version']) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    spawnSync(process.execPath, [BIN_OX, ...args], { stdio: 'ignore' });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95 = samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * 0.95) - 1))];
  return { mean, p95, min: samples[0], max: samples[samples.length - 1], samples };
}
