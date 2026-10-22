// bench/real/lib.mjs - self-contained helpers for the REAL agent benchmark.
//
// Deliberately self-contained: this file does NOT import from bench/harness.mjs
// or bench/runner.mjs. The whole point of bench/real is to measure the MODEL, and
// a shared harness would let a bug (or a pass) in the replay plumbing leak in and
// contaminate the signal. The escape hatch is copied as an idiom, not linked.
//
// Two rules define this suite:
//   RULE 1 - THE MODEL DECIDES. No scripted tool calls anywhere. The model picks
//            which tools to call, with what arguments, in what order.
//   RULE 2 - GRADING EXECUTES CODE. verify(ctx) spawns real processes (node, grep)
//            and grades from exit codes and real stdout. Nothing is graded from
//            the transcript's shape.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const REAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(REAL_DIR, '..', '..');
export const BIN_OX = path.join(REPO_ROOT, 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// Sandboxes
//
// A real temp dir under os.tmpdir(). The repo is never touched and the real
// ~/.ox is never read or written: HOME (plus every XDG dir ox might consult) is
// redirected inside the sandbox, so agent state cannot leak between runs or into
// the developer's actual configuration.
// ---------------------------------------------------------------------------

function tagSafe(tag) {
  return String(tag ?? 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

export function createSandbox(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-realbench-${tagSafe(tag)}-`));
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

// Live-mode env: real provider keys are KEPT (this suite talks to real models),
// but HOME/XDG are sandboxed and the deterministic-mode escape hatches
// (OX_BASE_URL / OX_MODEL / OX_API_KEY) are cleared so a run can never be
// silently redirected at a mock. Same idiom as bench/harness.mjs liveEnv().
export function agentEnv({ home, extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: '1', OX_NO_BACKUPS: '1' };
  delete env.OX_BASE_URL;
  delete env.OX_MODEL;
  delete env.OX_API_KEY;
  delete env.OX_YOLO;
  delete env.OX_MAX_COST;
  // A plan you pay for (chatgpt-plan, claude-plan…) runs the vendor's own CLI,
  // whose sign-in lives in the real home: point just that CLI at it, so the
  // sandbox stays sandboxed and the plan can still answer. Nothing of ox's own
  // (~/.ox) is exposed. Read before HOME is replaced.
  const realHome = process.env.HOME || os.homedir();
  if (!env.CODEX_HOME) env.CODEX_HOME = path.join(realHome, '.codex');
  if (!env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.join(realHome, '.claude');
  env.HOME = home;
  for (const [name, dir] of [
    ['XDG_CONFIG_HOME', '.config'],
    ['XDG_DATA_HOME', path.join('.local', 'share')],
    ['XDG_STATE_HOME', path.join('.local', 'state')],
    ['XDG_CACHE_HOME', '.cache'],
  ]) {
    const full = path.join(home, dir);
    try { fs.mkdirSync(full, { recursive: true }); } catch {}
    env[name] = full;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// ---------------------------------------------------------------------------
// Workspace file helpers (task setup(); the verifiers grade the world, not these)
// ---------------------------------------------------------------------------

export function wsPath(ws, rel = '') {
  return path.join(ws, String(rel ?? ''));
}

export function writeWs(ws, rel, content) {
  const full = wsPath(ws, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export function readWs(ws, rel) {
  return fs.readFileSync(wsPath(ws, rel), 'utf8');
}

export function existsWs(ws, rel) {
  return fs.existsSync(wsPath(ws, rel));
}

export function sha256(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// run() - the ONLY way a verifier talks to the world. spawnSync, hard timeout.
// Returns { status, signal, stdout, stderr, timedOut }. Never throws.
// ---------------------------------------------------------------------------

export function run(cmd, args = [], opts = {}) {
  const { cwd = process.cwd(), timeoutMs = 30_000, env = process.env, input = undefined } = opts;
  let r;
  try {
    r = spawnSync(cmd, args.map(String), {
      cwd,
      env,
      input,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: Math.max(1, Number(timeoutMs) || 30_000),
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    return { status: null, signal: null, stdout: '', stderr: `spawn failed: ${err?.message ?? err}`, timedOut: false };
  }
  return {
    status: r?.status ?? null,
    signal: r?.signal ?? null,
    stdout: r?.stdout ?? '',
    stderr: r?.stderr ?? (r?.error ? String(r.error.message ?? r.error) : ''),
    timedOut: Boolean(r?.error?.code === 'ETIMEDOUT'),
  };
}

// Convenience: run a command inside the workspace, carrying its command line for
// a diagnosable check row.
export function runIn(ws, cmd, args = [], opts = {}) {
  const res = run(cmd, args, { cwd: ws, timeoutMs: 30_000, env: process.env, ...opts });
  return { ...res, cmdLine: `${cmd} ${args.map(String).join(' ')}`.trim(), exit: res.status };
}

export function oneLine(s, n = 400) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Build a check row. ok === false is what a FAIL is made of.
export function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: oneLine(detail, 400) };
}

// ---------------------------------------------------------------------------
// spawnOx - the real agent, real provider, real tools.
// ---------------------------------------------------------------------------

export function spawnOx({ args = [], cwd = process.cwd(), env = process.env, timeoutMs = 180_000 }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [BIN_OX, ...args.map(String)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    const eventTimings = [];
    const timeLines = (chunk, final = false) => {
      pendingLine += chunk;
      const lines = pendingLine.split('\n');
      pendingLine = final ? '' : lines.pop();
      if (final && lines.length && lines.at(-1) === '') lines.pop();
      if (final && pendingLine) lines.push(pendingLine);
      for (const line of lines) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        try {
          const ev = JSON.parse(text);
          if (ev && typeof ev.t === 'string') eventTimings.push({ t: ev.t, atMs: performance.now() - started, id: ev.id ?? null, name: ev.name ?? null });
        } catch {}
      }
    };
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1, Number(timeoutMs) || 180_000));
    child.stdout?.on('data', (d) => { const text = d.toString(); stdout += text; timeLines(text); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      timeLines('', true);
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, ms: performance.now() - started, timedOut, eventTimings });
    };
    child.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${err.message}\n`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Event provenance
//
// --keep is the only moment the raw stream still exists in memory: the sandbox
// survives on disk, but the NDJSON dies with this process. So --keep writes the
// whole stream into the sandbox BEFORE the summary prints, and every token
// number the runner reports then traces back to the events that produced it
// instead of having to be reconstructed by hand.
//
// The file is written one JSON value per line, in stream order, so it is valid
// NDJSON by construction. A child SIGKILLed mid-write can leave a half-written
// final line; parseNdjsonEvents already dropped it, and the count of lost lines
// is returned rather than swallowed, so the caller can say so out loud.
// ---------------------------------------------------------------------------

export const EVENTS_FILE = 'events.ndjson';
export const TIMINGS_FILE = 'event-timings.json';

export function writeEventsFile(sb, events, rawStdout = '') {
  const dest = path.join(sb?.root ?? '', EVENTS_FILE);
  const lines = [];
  for (const ev of Array.isArray(events) ? events : []) {
    try {
      lines.push(JSON.stringify(ev));
    } catch {
      // circular / non-serialisable event: dropped, and counted below
    }
  }
  fs.writeFileSync(dest, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  const rawLines = String(rawStdout ?? '').split('\n').filter((l) => l.trim());
  return {
    path: dest,
    events: lines.length,
    unparsable: Math.max(0, rawLines.length - lines.length),
  };
}

// Keep arrival times separately so events.ndjson remains the exact, replayable
// child stream. The timeline deliberately contains no prompts, event payloads,
// tool arguments, or model output.
export function writeTimingsFile(sb, eventTimings = []) {
  const dest = path.join(sb?.root ?? '', TIMINGS_FILE);
  const safe = (Array.isArray(eventTimings) ? eventTimings : []).filter((x) => x && typeof x.t === 'string' && Number.isFinite(x.atMs))
    .map(({ t, atMs, id, name }) => ({ t, atMs, ...(id != null ? { id: String(id) } : {}), ...(name != null ? { name: String(name) } : {}) }));
  fs.writeFileSync(dest, `${JSON.stringify({ clock: 'child-stdout-arrival-ms-from-spawn', events: safe }, null, 2)}\n`, 'utf8');
  return { path: dest, events: safe.length };
}

export function parseNdjsonEvents(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch {}
  }
  return events;
}

// ---------------------------------------------------------------------------
// summarizeEvents - REAL metrics computed from the real NDJSON stream.
//
// No transcript-shape assertion is used for grading anywhere in bench/real.
// These numbers exist for the REPORT (thrashing? token burn? error rate?) and for
// operational sanity, never as a pass/fail signal.
//
// NOTE on args: ox emits tool args as `argsPreview`, truncated to 120 chars
// (src/agent.js). Redundant-call detection therefore compares (tool name +
// normalized argsPreview); two long calls differing only past 120 chars are
// reported as redundant. A documented over-count, not a silent one.
// ---------------------------------------------------------------------------

function normalizeArgs(preview) {
  const raw = String(preview ?? '').trim();
  if (!raw) return '';
  try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
}

export function summarizeEvents(events = [], eventTimings = []) {
  const calls = [];
  const perTool = Object.create(null);
  const seen = new Map();
  let turns = 0;
  let errorEvents = 0;
  let toolErrors = 0;
  let retryEvents = 0;
  let reflectionEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let auxInputTokens = 0;
  let auxOutputTokens = 0;
  let costUsd = null;
  let finalText = '';
  const firstError = [];
  // One entry per provider request, in stream order. An average hides the single
  // expensive turn that actually cost the run, so the per-turn series is kept
  // beside the totals and printed by the runner.
  const usageEvents = [];
  const starts = new Map();
  const toolDurations = [];
  let firstTextMs = null;
  let firstToolMs = null;

  // These are child-process arrival times, not provider-internal timings. They
  // include startup and local scheduling; keep the labels honest.
  for (const timed of Array.isArray(eventTimings) ? eventTimings : []) {
    if (!timed || !Number.isFinite(timed.atMs)) continue;
    if (timed.t === 'text-delta' && firstTextMs == null) firstTextMs = timed.atMs;
    if (timed.t === 'tool-start') {
      if (firstToolMs == null) firstToolMs = timed.atMs;
      const key = timed.id != null ? `id:${timed.id}` : `name:${timed.name ?? ''}`;
      const q = starts.get(key) ?? [];
      q.push(timed.atMs);
      starts.set(key, q);
    } else if (timed.t === 'tool-end') {
      const key = timed.id != null ? `id:${timed.id}` : `name:${timed.name ?? ''}`;
      const q = starts.get(key) ?? [];
      const began = q.shift();
      if (Number.isFinite(began) && timed.atMs >= began) toolDurations.push(timed.atMs - began);
    }
  }

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.t) {
      case 'tool-start': {
        const name = String(ev.name ?? '(unnamed)');
        const args = normalizeArgs(ev.argsPreview);
        calls.push({ name, args });
        perTool[name] = (perTool[name] ?? 0) + 1;
        const key = `${name} ${args}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
        break;
      }
      case 'tool-end':
        if (ev.isError === true) toolErrors += 1;
        break;
      case 'assistant-turn':
        turns += 1;
        break;
      case 'final':
        turns += 1;
        if (typeof ev.message?.content === 'string') finalText = ev.message.content;
        break;
      case 'text-delta':
        if (!finalText) finalText += String(ev.text ?? '');
        break;
      case 'error':
        errorEvents += 1;
        if (firstError.length < 5) firstError.push(String(ev.error ?? 'error'));
        break;
      case 'reflection':
        retryEvents += 1;
        reflectionEvents += 1;
        break;
      case 'continuation-retry':
        retryEvents += 1;
        break;
      case 'usage': {
        const inTok = Number(ev.inputTokens ?? 0) || 0;
        const outTok = Number(ev.outputTokens ?? 0) || 0;
        if (ev.aux) {
          auxInputTokens += inTok;
          auxOutputTokens += outTok;
        } else {
          inputTokens += inTok;
          outputTokens += outTok;
        }
        usageEvents.push({ turn: usageEvents.length + 1, aux: ev.aux === true, inputTokens: inTok, outputTokens: outTok });
        break;
      }
      case 'subagent-end': {
        // Nested agent request events are intentionally folded out of the
        // parent's event stream. The lifecycle summary is the only parent-side
        // accounting record for that nested run; keep it as an attributed aux
        // row instead of silently making per-request totals smaller than the
        // authoritative cumulative usage-total.
        const inTok = Number(ev.inputTokens ?? 0) || 0;
        const outTok = Number(ev.outputTokens ?? 0) || 0;
        if (inTok || outTok) {
          auxInputTokens += inTok;
          auxOutputTokens += outTok;
          usageEvents.push({
            turn: 'subagent', aux: true, inputTokens: inTok, outputTokens: outTok,
            agentId: ev.id ?? null, model: ev.model ?? null,
          });
          // If this provider does not emit an aggregate, still include nested
          // work in the best available run total. usage-total, when present,
          // replaces these counters below with the provider/session aggregate.
          inputTokens += inTok;
          outputTokens += outTok;
        }
        break;
      }
      case 'usage-total':
        inputTokens = Number(ev.inputTokens ?? inputTokens) || 0;
        outputTokens = Number(ev.outputTokens ?? outputTokens) || 0;
        if (ev.costUsd != null) costUsd = Number(ev.costUsd);
        break;
      default:
        break;
    }
  }

  const redundantDetail = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ key, count: n }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const uniqueCalls = seen.size;
  const toolNames = Object.keys(perTool).sort();

  return {
    events: (Array.isArray(events) ? events : []).length,
    toolCalls: calls.length,
    uniqueCalls,
    redundantCalls: calls.length - uniqueCalls,
    redundantDetail,
    tools: toolNames,
    toolCount: toolNames.length,
    perTool: { ...perTool },
    calls,
    turns,
    errorEvents,
    toolErrors,
    retryEvents,
    reflectionEvents,
    errors: firstError,
    finalText: String(finalText ?? ''),
    usageEvents,
    inputTokens,
    outputTokens,
    auxInputTokens,
    auxOutputTokens,
    costUsd,
    firstTextMs,
    firstToolMs,
    toolDurationMs: toolDurations.length ? toolDurations.reduce((a, b) => a + b, 0) / toolDurations.length : null,
    timedTools: toolDurations.length,
  };
}
