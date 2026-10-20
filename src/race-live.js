// ox vs "<prompt>" (lumiomac's "Claude Code vs Codex", watched from the notch):
// the same prompt to two or more coding tools, each in its own fresh folder and
// its own Terminal tab; ox follows both from their own transcripts and pins the
// moments that matter on each lane (skills picked, a test written, a test
// failing on purpose, tests passing, a browser check), then names the winner
// and the time it took.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slugOf, nameOf, openInTerminal, entryOf } from './make-app.js';

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export const RACERS = {
  claude: { label: 'Claude Code', cmd: (p) => `claude --permission-mode acceptEdits ${q(p)}` },
  codex: { label: 'Codex', cmd: (p) => `codex --full-auto ${q(p)}` },
  gemini: { label: 'Gemini CLI', cmd: (p) => `gemini --yolo -i ${q(p)}` },
  opencode: { label: 'OpenCode', cmd: (p) => `opencode run ${q(p)}` },
  ox: { label: 'ox', cmd: (p) => `ox --yes-edits ${q(p)}` },
};

const BIN = { claude: 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode', ox: 'ox' };
const FIX = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex', gemini: 'npm install -g @google/gemini-cli', opencode: 'brew install sst/tap/opencode', ox: 'npm install -g ox-agent' };
/** Whether a tool's command starts here: null when it does, else what is wrong and the fix. */
export function notReady(tool, { run = (b) => spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 15_000 }) } = {}) {
  const r = run(BIN[tool]);
  if (r.error?.code === 'ENOENT') return `${RACERS[tool].label} is not installed (${FIX[tool]})`;
  if (r.status !== 0) return `${RACERS[tool].label} is installed but does not start: ${String(r.stderr || r.stdout || '').trim().split('\n')[0].slice(0, 120)} (reinstall: ${FIX[tool]})`;
  return null;
}

const TESTY = /\b(test|tests|spec|jest|vitest|pytest|mocha|node --test|npm t\b)|test[-_.]/i;
const FAILED = /(\bfail(ed|ing|s|ure)?\b|✗|AssertionError|Error:|ENOENT|exit code [1-9]|not ok\b)/i;
const BROWSER = /\b(chrome|chromium|playwright|puppeteer|headless|open [^|;&]*\.html)\b/i;

/**
 * Moments from a list of tool calls, each { at, name, input, output, error }:
 * [{ at, kind, label }]. The same rules for every tool.
 */
export function momentsOf(calls) {
  const out = [];
  const once = new Set();
  const add = (at, kind, label) => { if (once.has(kind)) return; once.add(kind); out.push({ at, kind, label }); };
  let failedAt = null;
  for (const c of calls) {
    const input = c.input ?? {};
    const cmd = String(input.command ?? input.cmd ?? (Array.isArray(input.command) ? input.command.join(' ') : '') ?? '');
    const file = String(input.file_path ?? input.path ?? '');
    if (/^skill$/i.test(c.name)) { const s = input.skill ?? input.name ?? input.command ?? ''; once.delete('skill'); add(c.at, 'skill', `skills: ${String(s).replace(/^\//, '')}`); continue; }
    if (/^(write|edit|multiedit|apply_patch)$/i.test(c.name) && TESTY.test(file + cmd)) add(c.at, 'test-written', 'writes a test');
    if (cmd && BROWSER.test(cmd)) add(c.at, 'browser', 'checks it in a browser');
    if (cmd && TESTY.test(cmd)) {
      const bad = c.error === true || FAILED.test(String(c.output ?? ''));
      if (bad && failedAt === null) { failedAt = c.at; add(c.at, 'test-fails', once.has('test-written') ? 'test fails, on purpose' : 'test fails'); }
      else if (!bad && failedAt !== null) add(c.at, 'tests-pass', 'tests pass');
    }
  }
  return out;
}

/** Tool calls from a Claude Code transcript (.jsonl lines). */
export function claudeCalls(text) {
  const uses = new Map(), calls = [];
  for (const line of String(text).split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const at = Date.parse(j.timestamp ?? '') || 0;
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const x of content) {
      if (x.type === 'tool_use') { const c = { at, name: x.name, input: x.input ?? {}, output: '', error: false }; uses.set(x.id, c); calls.push(c); }
      if (x.type === 'tool_result') {
        const c = uses.get(x.tool_use_id);
        if (c) { c.error = x.is_error === true; c.output = typeof x.content === 'string' ? x.content : (Array.isArray(x.content) ? x.content.map((p) => p.text ?? '').join('\n') : ''); }
      }
    }
  }
  return calls;
}

/** Tool calls from a Codex rollout (.jsonl lines). */
export function codexCalls(text) {
  const byId = new Map(), calls = [];
  for (const line of String(text).split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const at = Date.parse(j.timestamp ?? '') || 0;
    const p = j.payload ?? {};
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input = {}; try { input = JSON.parse(p.arguments ?? p.input ?? '{}'); } catch { input = { command: String(p.input ?? '') }; }
      if (Array.isArray(input.command)) input.command = input.command.join(' ');
      const c = { at, name: p.name === 'shell' || p.name === 'exec_command' ? 'Bash' : p.name, input, output: '', error: false };
      byId.set(p.call_id, c); calls.push(c);
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const c = byId.get(p.call_id);
      if (c) { const o = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''); c.output = o; c.error = /"exit_code":\s*[1-9]|Process exited with code [1-9]/.test(o); }
    }
  }
  return calls;
}

/** The newest transcript a tool wrote for a folder, or null. */
export function transcriptFor(tool, dir, { home = os.homedir(), since = 0 } = {}) {
  let real = dir; try { real = fs.realpathSync(dir); } catch {}
  const pick = (files) => files.map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } }).filter((x) => x && x.m >= since).sort((a, b) => b.m - a.m)[0]?.f ?? null;
  if (tool === 'claude') {
    for (const d of [dir, real]) {
      const folder = path.join(home, '.claude', 'projects', d.replace(/[^A-Za-z0-9]/g, '-'));
      try { const f = pick(fs.readdirSync(folder).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(folder, n))); if (f) return f; } catch {}
    }
    return null;
  }
  if (tool === 'codex') {
    const day = path.join(home, '.codex', 'sessions', ...new Date().toISOString().slice(0, 10).split('-'));
    let files = [];
    try { files = fs.readdirSync(day).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(day, n)); } catch { return null; }
    return pick(files.filter((f) => { try { const first = fs.readFileSync(f, 'utf8').split('\n', 1)[0]; const cwd = JSON.parse(first).payload?.cwd; return cwd === dir || cwd === real; } catch { return false; } }));
  }
  return null;
}

const mmss = (ms) => `${Math.floor(ms / 60000)}m ${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;

/** One line for the notch: each lane's time and its latest moment. */
export function raceLine(lanes, now = Date.now()) {
  return lanes.map((l) => `${l.label} ${l.done ? `✓ ${mmss(l.done)}` : mmss(now - l.started)}${l.moments.at(-1) ? ` · ${l.moments.at(-1).label}` : ''}`).join('   |   ');
}

/**
 * Run the race. `say(line, done?)` narrates; `update(lanes)` gets every change.
 * → { lanes, winner }
 */
export async function race(prompt, {
  tools = ['claude', 'codex'], home = os.homedir(), say = () => {}, update = () => {}, terminal = openInTerminal,
  live = null, read = (f) => fs.readFileSync(f, 'utf8'), find = transcriptFor, quietSec = 30, timeoutMs = 60 * 60_000, pollMs = 3000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), check = true,
} = {}) {
  if (!String(prompt ?? '').trim()) throw new Error('usage: ox vs "<prompt>" [--tools claude,codex]');
  const bad = tools.filter((t) => !RACERS[t]);
  if (bad.length) throw new Error(`ox vs races ${Object.keys(RACERS).join(', ')} (not ${bad.join(', ')})`);
  if (tools.length < 2) throw new Error('a race needs two tools at least: --tools claude,codex');
  const broken = check ? tools.map((t) => notReady(t)).filter(Boolean) : [];
  if (broken.length) throw new Error(broken.join('; '));
  const base = path.join(home, 'ox-builds', `race-${slugOf(nameOf(prompt))}-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`);
  const t0 = now();
  const lanes = tools.map((t) => ({ tool: t, label: RACERS[t].label, dir: path.join(base, t), started: t0, moments: [], done: null, file: null, quietSince: null }));
  for (const l of lanes) {
    fs.mkdirSync(l.dir, { recursive: true });
    const r = terminal(`cd ${q(l.dir)} && ${RACERS[l.tool].cmd(prompt)}`);
    if (r?.error) throw new Error(`could not open Terminal for ${l.label}: ${r.error}`);
  }
  say(`${lanes.map((l) => l.label).join(' vs ')}: ready, go`);
  const sessions = live ?? (async () => (await import('./agents-live.js')).liveAgents({ fresh: true }));
  while (now() - t0 < timeoutMs && lanes.some((l) => !l.done)) {
    await sleep(pollMs);
    let rows = [];
    try { rows = (await sessions()) ?? []; } catch {}
    let changed = false;
    for (const l of lanes.filter((x) => !x.done)) {
      l.file ??= find(l.tool, l.dir, { home, since: t0 - 5000 });
      if (l.file) {
        let calls = [];
        try { calls = l.tool === 'codex' ? codexCalls(read(l.file)) : claudeCalls(read(l.file)); } catch {}
        const m = momentsOf(calls);
        if (m.length !== l.moments.length) { l.moments = m; changed = true; }
      }
      const mine = rows.find((s) => s.cwd && (s.cwd === l.dir || s.cwd.endsWith(path.join(path.basename(base), l.tool))));
      const quiet = mine ? (mine.idleSec ?? 0) >= quietSec : !!l.file;
      if (entryOf(l.dir) && quiet) { l.done = now() - t0; changed = true; say(`${l.label} — ${mmss(l.done)}`, true); }
    }
    if (changed) update(lanes);
    say(raceLine(lanes, now()));
  }
  const finished = lanes.filter((l) => l.done).sort((a, b) => a.done - b.done);
  const winner = finished[0] ?? null;
  if (winner) say(`${winner.label} finishes first — ${mmss(winner.done)}`, true);
  return { lanes, winner, dir: base };
}
