// Run traces and plain-English signals (after lmnr-ai/laminar): every run
// keeps its model turns (tokens, cost, time) and tool calls (name, arguments,
// time, result size, ok) in ~/.ox/traces/<id>.jsonl, and a watcher raises a
// signal when the run looks stuck: the same call over and over, errors piling
// up, or many turns with nothing changing. A signal is said (a notification and
// a line in the trace), never acted on: stopping the run stays yours.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'traces');
const CAP = 2 * 1024 * 1024;
const KEEP = 300;

export function traceEnabled(env = process.env) {
  return env.OX_TRACE !== '0' && !env.NODE_TEST_CONTEXT || env.OX_TRACE === '1';
}

/** The watcher: feed it events, it returns a signal when one is due (each kind once per run). */
export function stuckWatcher({ repeat = 3, errors = 4, quietTurns = 12 } = {}) {
  const calls = [];
  let errRun = 0, turns = 0, sinceChange = 0;
  const said = new Set();
  const once = (kind, text) => { if (said.has(kind)) return null; said.add(kind); return { kind, text }; };
  const changes = /^(edit_file|write_file|apply_patch|create_file|multi_edit|str_replace)/;
  return (ev) => {
    if (ev.type === 'tool-start') {
      const key = `${ev.name}|${ev.argsPreview ?? ''}`;
      calls.push(key);
      const last = calls.slice(-repeat);
      if (last.length === repeat && last.every((k) => k === key)) return once('loop', `stuck in a loop: called ${ev.name} with the same arguments ${repeat} times in a row`);
      const last6 = calls.slice(-6);
      if (last6.length === 6 && last6[0] === last6[2] && last6[2] === last6[4] && last6[1] === last6[3] && last6[3] === last6[5] && last6[0] !== last6[1]) return once('loop', 'stuck in a loop: going back and forth between the same two calls');
      if (changes.test(ev.name)) sinceChange = 0;
    } else if (ev.type === 'tool-end') {
      errRun = ev.ok === false || ev.isError ? errRun + 1 : 0;
      if (errRun >= errors) return once('errors', `${errRun} tool calls failed in a row (last: ${ev.name})`);
    } else if (ev.type === 'usage') {
      turns++; sinceChange++;
      if (sinceChange >= quietTurns) return once('quiet', `${sinceChange} model turns without changing a file: it may be going in circles`);
    }
    return null;
  };
}

const preview = (opts) => {
  const m = [...(opts?.messages ?? [])].reverse().find((x) => x?.role === 'user');
  const c = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? '').join(' ') : opts?.prompt ?? '';
  return String(c).replace(/\s+/g, ' ').slice(0, 200);
};

/** Wrap a run's event stream: trace it and watch it. A side channel: it never throws into the run. */
export async function* withTrace(opts, source, { notify = defaultNotify, env = process.env } = {}) {
  if (!traceEnabled(env)) { yield* source; return; }
  let file = null;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
    file = path.join(dir(), `${id}.jsonl`);
    prune();
  } catch { file = null; }
  const t0 = Date.now();
  let size = 0;
  const write = (row) => {
    if (!file || size > CAP) return;
    try { const l = `${JSON.stringify({ at: Date.now() - t0, ...row })}\n`; size += l.length; fs.appendFileSync(file, l, { mode: 0o600 }); } catch {}
  };
  write({ t: 'run', started: new Date(t0).toISOString(), prompt: preview(opts), model: opts?.target?.model ?? null, provider: opts?.target?.provider ?? null, cwd: opts?.ctx?.cwd ?? opts?.cwd ?? process.cwd(), surface: env.OX_SURFACE ?? 'cli', agent: env.OX_ORG_AGENT ?? env.OX_AGENT_NAME ?? null, task: env.OX_TASK_ID ?? null });
  const watch = stuckWatcher();
  const started = new Map();
  let outcome = 'done';
  try {
    for await (const ev of source) {
      try {
        if (ev?.type === 'tool-start') { started.set(ev.id, Date.now()); write({ t: 'tool', name: ev.name, args: ev.argsPreview ?? '' }); }
        else if (ev?.type === 'tool-end') write({ t: 'tool-end', name: ev.name, ok: ev.ok !== false && !ev.isError, ms: ev.ms ?? (started.has(ev.id) ? Date.now() - started.get(ev.id) : null), bytes: ev.bytes ?? null });
        else if (ev?.type === 'usage') write({ t: 'turn', model: ev.model ?? null, in: ev.inputTokens ?? 0, out: ev.outputTokens ?? 0, cost: ev.costUsd ?? null });
        else if (ev?.type === 'error') { outcome = 'error'; write({ t: 'error', error: String(ev.error ?? ev.message ?? '').slice(0, 400) }); }
        const sig = ev && watch(ev);
        if (sig) { write({ t: 'signal', ...sig }); try { notify(sig, opts); } catch {} }
      } catch {}
      yield ev;
    }
  } catch (e) {
    outcome = 'error';
    write({ t: 'error', error: String(e?.message ?? e).slice(0, 400) });
    throw e;
  } finally {
    write({ t: 'end', outcome, ms: Date.now() - t0 });
  }
}

function prune() {
  try {
    const files = fs.readdirSync(dir()).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(dir(), f), { force: true });
  } catch {}
}

async function defaultNotify(sig) {
  if (process.env.NODE_TEST_CONTEXT) return;
  try {
    const { osCmd } = await import('./tools/operator.js');
    const { spawnSync } = await import('node:child_process');
    const c = osCmd('notify', `ox: ${sig.text}`);
    if (c) spawnSync(c[0], c.slice(1), { timeout: 5000 });
  } catch {}
}

/** One trace, summed: turns, tokens, cost, tools, errors, signals. */
export function readTrace(idOrFile) {
  const f = idOrFile.includes('/') ? idOrFile : path.join(dir(), idOrFile.endsWith('.jsonl') ? idOrFile : `${idOrFile}.jsonl`);
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const run = rows.find((r) => r.t === 'run') ?? {};
  const end = rows.find((r) => r.t === 'end');
  const turns = rows.filter((r) => r.t === 'turn');
  const tools = rows.filter((r) => r.t === 'tool-end');
  const byTool = {};
  for (const t of tools) { const b = (byTool[t.name] ??= { calls: 0, failed: 0, ms: 0 }); b.calls++; if (!t.ok) b.failed++; b.ms += t.ms ?? 0; }
  return {
    id: path.basename(f, '.jsonl'), ...run, rows,
    outcome: end?.outcome ?? 'running', ms: end?.ms ?? (rows.at(-1)?.at ?? 0),
    turns: turns.length, inTokens: turns.reduce((a, r) => a + r.in, 0), outTokens: turns.reduce((a, r) => a + r.out, 0),
    cost: turns.some((r) => r.cost != null) ? turns.reduce((a, r) => a + (r.cost ?? 0), 0) : null,
    tools: tools.length, failed: tools.filter((t) => !t.ok).length, byTool,
    signals: rows.filter((r) => r.t === 'signal'),
  };
}

/** Recent runs, newest first. */
export function listTraces({ limit = 20, signals = false } = {}) {
  let files = [];
  try { files = fs.readdirSync(dir()).filter((f) => f.endsWith('.jsonl')).sort().reverse(); } catch {}
  const out = [];
  for (const f of files) {
    try { const t = readTrace(path.join(dir(), f)); delete t.rows; if (!signals || t.signals.length) out.push(t); } catch {}
    if (out.length >= limit) break;
  }
  return out;
}
