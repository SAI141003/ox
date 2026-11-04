// The build room: one task, a team of agents building it at the same time,
// every line shown as it lands with the agent that wrote it, and every change
// reviewed by a different agent before it is merged.
//
//   1. A planner splits the task into parts that touch different files.
//   2. Each part gets a builder: its own git worktree and branch, and its own
//      ox run (`ox -p … --json`), so builders never overwrite each other.
//   3. Every file a builder writes is read back and diffed against what the
//      room last showed for it, so each line keeps the name of whoever wrote it.
//   4. When a builder finishes: its own tests run, then another agent reviews
//      the exact lines it changed (plus ox's security check). "Must fix"
//      comments and failing tests go back to the author, up to two rounds.
//   5. A part is merged only when its review passes and its tests are green.
//      A part that never gets there stays on its branch, named in the summary.
//
// Everything that happens is an event (kept in ~/.ox/builds/<id>/events.jsonl)
// that the Build view in the app replays and follows live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BUILDS_DIR = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'builds');
const OX_BIN = fileURLToPath(new URL('../bin/ox.js', import.meta.url));
const MAX_LINES = 3000;
const MAX_ROUNDS = 2;
export const MAX_AGENTS = 8;

const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
export const slugOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'build';

// ---------------------------------------------------------------------------
// Line attribution
// ---------------------------------------------------------------------------

/**
 * For each line of `next`, the index of the same line in `prev`, or -1 when
 * it is new. Common start and end are matched first; the middle by LCS (or,
 * when it is too big for that, treated as all new).
 */
export function matchLines(prev, next) {
  const out = new Array(next.length).fill(-1);
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) { out[a] = a; a++; }
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) {
    out[next.length - 1 - b] = prev.length - 1 - b; b++;
  }
  const P = prev.slice(a, prev.length - b), N = next.slice(a, next.length - b);
  if (!P.length || !N.length || P.length * N.length > 4_000_000) return out;
  const w = N.length + 1;
  const dp = new Uint32Array((P.length + 1) * w);
  for (let i = P.length - 1; i >= 0; i--) {
    for (let j = N.length - 1; j >= 0; j--) {
      dp[i * w + j] = P[i] === N[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < P.length && j < N.length) {
    if (P[i] === N[j]) { out[a + j] = a + i; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** New content attributed: lines kept from before keep their author, the rest are `agent`'s. */
export function attribute(prev, text, agent) {
  const lines = String(text).split('\n').slice(0, MAX_LINES);
  const m = matchLines(prev?.lines ?? [], lines);
  const owners = m.map((k) => (k >= 0 ? prev.owners[k] : agent));
  const changed = m.flatMap((k, i) => (k < 0 ? [i] : []));
  return { lines, owners, changed };
}

// ---------------------------------------------------------------------------
// Prompts and parsing
// ---------------------------------------------------------------------------

export const PLAN_SYSTEM = `You lead a small team of coding agents. Split the task into parts that different agents build AT THE SAME TIME, each in its own copy of the project, so no two parts may create or edit the same file.
Part 1 also sets up the project: package/dependency file, entry point, test setup, README. Every part writes the tests for its own files; never make a part that only writes tests. Prefer few dependencies and a stack that runs with no accounts or keys.
For each part give: a short title, the files it owns (paths), and a brief: what to build and the exact interfaces other parts rely on (function names and signatures, routes, file paths, data shapes).
Pick the command that runs all the tests.
Answer with JSON only: {"summary": "...", "stack": "...", "test": "...", "parts": [{"title": "...", "files": ["..."], "brief": "..."}]}`;

/** The plan from the model's answer, trimmed to `max` parts; a single part with the task when unreadable. */
export function parsePlan(text, task, max = 3) {
  let p = null;
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  if (m) { try { p = JSON.parse(m[0]); } catch {} }
  const parts = (Array.isArray(p?.parts) ? p.parts : [])
    .filter((x) => x && (x.title || x.brief))
    .slice(0, Math.max(1, max))
    .map((x) => ({
      title: String(x.title ?? 'Part').slice(0, 80),
      files: (Array.isArray(x.files) ? x.files : []).map(String).filter((f) => f && !f.includes('..') && !path.isAbsolute(f)).slice(0, 30),
      brief: String(x.brief ?? '').slice(0, 2000),
    }));
  if (!parts.length) return { summary: String(task).slice(0, 300), stack: '', test: '', parts: [{ title: 'Build it', files: [], brief: String(task) }] };
  return { summary: String(p.summary ?? '').slice(0, 600), stack: String(p.stack ?? '').slice(0, 200), test: String(p.test ?? '').slice(0, 200), parts };
}

export function builderPrompt({ task, plan, part, name, team }) {
  const others = team.filter((t) => t.name !== name).map((t) => `- ${t.name}: ${t.part.title} (${t.part.files.join(', ') || 'its own files'})`).join('\n');
  return [
    `You are ${name}, one of ${team.length} agents building this together: ${task}`,
    plan.summary && `The plan: ${plan.summary}${plan.stack ? ` Stack: ${plan.stack}.` : ''}`,
    `YOUR PART: ${part.title}\n${part.brief}`,
    part.files.length ? `Files you own: ${part.files.join(', ')}. You may add more files of your own (tests, helpers) next to them.` : '',
    others && `The other agents, working at the same time in their own copies:\n${others}\nNever create, copy in or edit their files; code against the interfaces the plan gives them. Their work appears in your copy as it is merged, and ox runs your tests again then.`,
    'Write tests for your part and run them. Do not run git: ox commits, reviews and merges your work. Finish with one line saying what you built.',
  ].filter(Boolean).join('\n\n');
}

export function fixPrompt({ base, comments, tests }) {
  const must = comments.filter((c) => c.severity === 'must-fix');
  return [
    base,
    'Your work came back from review. Fix this before it can be merged:',
    ...must.map((c) => `- ${c.file}${c.line ? `:${c.line}` : ''} (${c.by}): ${c.comment}`),
    tests && !tests.ok ? `Your tests fail (${tests.command ?? 'tests'}):\n${tests.out.slice(0, 3000)}` : '',
    'Change only what is needed, run your tests again, and finish with one line saying what you fixed.',
  ].filter(Boolean).join('\n');
}

export const REVIEW_SYSTEM = `You review a teammate's change line by line before it is merged. You see their part of the plan and every file they changed, with line numbers; lines they added or changed are marked "+".
Comment only on the changed lines. Use "must-fix" only for: a bug, a security problem, behaviour that does not do what the part asks, a missing piece of the part, or an edit to a file the part does not own. Use "suggestion" for anything smaller, and "good" for something done well (at most one).
Answer with JSON only: {"verdict": "pass" or "changes", "comments": [{"file": "...", "line": <number>, "severity": "must-fix" | "suggestion" | "good", "comment": "..."}]}. At most 10 comments. Verdict "changes" exactly when there is a must-fix.`;

export function parseReview(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/);
  let r = null;
  if (m) { try { r = JSON.parse(m[0]); } catch {} }
  if (!r) return null;
  const comments = (Array.isArray(r.comments) ? r.comments : []).slice(0, 10).map((c) => ({
    file: String(c?.file ?? ''),
    line: Number.isFinite(Number(c?.line)) ? Number(c.line) : 0,
    severity: ['must-fix', 'suggestion', 'good'].includes(c?.severity) ? c.severity : 'suggestion',
    comment: String(c?.comment ?? '').slice(0, 500),
  })).filter((c) => c.comment);
  return { verdict: comments.some((c) => c.severity === 'must-fix') ? 'changes' : 'pass', comments };
}

/** The files a branch changed, numbered, with changed lines marked "+", for the reviewer. */
export function reviewMaterial(dir, base) {
  const names = git(dir, ['diff', '--name-only', base, 'HEAD']).stdout.split('\n').filter(Boolean);
  const blocks = [];
  let budget = 2500;
  for (const f of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; } // deleted
    if (/\0/.test(text.slice(0, 2000)) || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)) continue;
    const changed = new Set();
    let hunk = null;
    for (const l of git(dir, ['diff', '-U0', base, 'HEAD', '--', f]).stdout.split('\n')) {
      if ((hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l))) {
        const s = Number(hunk[1]), n = hunk[2] == null ? 1 : Number(hunk[2]);
        for (let k = 0; k < n; k++) changed.add(s + k);
      }
    }
    const lines = text.split('\n').slice(0, Math.min(400, budget));
    budget -= lines.length;
    blocks.push(`=== ${f} ===\n${lines.map((l, i) => `${changed.has(i + 1) ? '+' : ' '}${String(i + 1).padStart(4)}| ${l}`).join('\n')}`);
    if (budget <= 0) break;
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ox's own copies (.ox-backups, .ox-build) and other hidden folders are never a part's tests.
const isTest = (f) => !/(^|\/)\./.test(f) && /(?:^|[._-])(?:test|spec)s?\.[cm]?[jt]sx?$|(?:^|\/)test_.*\.py$|_test\.(?:py|go)$|(?:^|\/)(?:test|tests|__tests__)\/.*\.[cm]?[jt]sx?$/.test(f);

// Tests and installs run beside the server, never blocking it (a Stop must get through
// while npm install takes minutes), in a process group of their own so a Stop ends
// everything they started. `runs` is where the room keeps what it can stop.
function sh(cwd, command, timeout = 5 * 60_000, runs = null) {
  const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', command] : ['-c', command], { cwd, env, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const add = (d) => { out += d; if (out.length > 4_000_000) out = out.slice(-2_000_000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const handle = { kill: () => killTree(child) };
    runs?.add(handle);
    const timer = setTimeout(() => killTree(child), timeout);
    const done = (code) => { clearTimeout(timer); runs?.delete(handle); resolve({ ok: code === 0, out: failureDigest(out) }); };
    child.on('close', done);
    child.on('error', (e) => { add(String(e.message)); done(1); });
  });
}

/** End a process and everything it started (its group on macOS/Linux, its tree on Windows). */
export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000).unref?.();
}

/**
 * What a failing run says about its failures: each "not ok" with the lines
 * under it (TAP), or Python/Jest "FAILED"/"●" blocks; else the end of the
 * output. A fix round that only sees the passing tail cannot fix anything.
 */
export function failureDigest(out, max = 6000) {
  const ls = String(out ?? '').split('\n');
  const blocks = [];
  for (let i = 0; i < ls.length; i++) {
    // A failing test, a Python/Jest failure, or an error a test file died of (node prints those as "# Error …").
    if (/^\s*not ok \d+/.test(ls[i]) || /^(FAILED|ERROR) |^\s*● /.test(ls[i]) || /^(#\s+)?(\w*Error\b|.*Cannot find module)/.test(ls[i])) {
      const end = ls.findIndex((l, j) => j > i && (/^\s*(not )?ok \d+/.test(l) || /^\s*● /.test(l) || /^# Subtest/.test(l)));
      blocks.push(ls.slice(i, end < 0 ? i + 12 : Math.min(end, i + 30)).filter((l) => l.trim() && !/^(duration_ms|type|failureType|signal):|^(\.\.\.|---)$|^#?\s*at /.test(l.trim())).join('\n'));
    }
  }
  const summary = ls.filter((l) => /^# (tests|pass|fail) \d+/.test(l)).join('  ');
  const text = blocks.length ? `${blocks.join('\n')}\n${summary}` : ls.join('\n');
  return text.length > max ? (blocks.length ? text.slice(0, max) : text.slice(-max)) : text;
}

/** A part's own tests: the test files its branch added, run the project's way. */
export async function partTests(dir, base, runs = null) {
  const files = git(dir, ['diff', '--name-only', base, 'HEAD']).stdout.split('\n').filter((f) => f && isTest(f) && fs.existsSync(path.join(dir, f)));
  if (!files.length) return { ok: true, none: true, out: 'no tests in this part', files };
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  let cmd;
  if (files.every((f) => f.endsWith('.py'))) cmd = `python3 -m pytest -q ${files.map(q).join(' ')}`;
  else {
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    if ((deps.vitest || deps.jest) && !fs.existsSync(path.join(dir, 'node_modules'))) await sh(dir, 'npm install --no-audit --no-fund', 5 * 60_000, runs);
    cmd = deps.vitest ? `npx vitest run ${files.map(q).join(' ')}` : deps.jest ? `npx jest ${files.map(q).join(' ')}` : `node --test ${files.map(q).join(' ')}`;
  }
  return { ...(await sh(dir, cmd, 5 * 60_000, runs)), files, command: cmd };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** One builder run: `ox -p` in its worktree, JSONL events on stdout. → { lines (async iterable), done (Promise<code>), kill } */
export function spawnOxBuilder({ cwd, prompt, bot = null }) {
  const args = [OX_BIN, '-p', prompt, '--json', '-y', '--sandbox', 'workspace', '--cwd', cwd, ...(bot ? ['--bot', bot] : [])];
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, OX_MCP: '0', OX_LEARN: '0', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  child.stderr.resume();
  const done = new Promise((resolve) => child.on('close', (code) => resolve(code ?? 1)));
  async function* lines() {
    let buf = '';
    for await (const chunk of child.stdout) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) yield buf;
  }
  return { lines: lines(), done, kill: () => killTree(child) };
}

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** Make `dir` a git repository with at least one commit; → the base commit. */
export function prepareRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) {
    // A folder of your own files is never committed for you: an empty folder or a git repository.
    if (fs.readdirSync(dir).some((f) => f !== '.DS_Store')) throw new Error(`${dir} has files and is not a git repository: pick an empty folder or a git repository`);
    git(dir, ['init', '-q']);
  }
  const ident = ['-c', 'user.name=ox build', '-c', 'user.email=build@ox.local'];
  if (git(dir, ['rev-parse', '--verify', 'HEAD']).status !== 0) git(dir, [...ident, 'commit', '-q', '--allow-empty', '-m', 'Start']);
  // The builders' copies live inside the project; git never sees them.
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  try {
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    const want = ['.ox-build/', '.ox-backups/', 'node_modules/'].filter((x) => !cur.split('\n').includes(x));
    if (want.length) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}${want.join('\n')}\n`); }
  } catch {}
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

const IDENT = ['-c', 'user.name=ox build', '-c', 'user.email=build@ox.local'];
const commitAll = (dir, msg) => { git(dir, ['add', '-A']); return git(dir, [...IDENT, 'commit', '-q', '-m', msg]).status === 0; };

export class BuildRoom extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.task
   * @param {string} o.dir           project folder (made, and made a git repo, when needed)
   * @param {number} [o.agents]      builders at most (default: as many as the plan needs, up to MAX_AGENTS)
   * @param {Function} o.ask         ({ system, user }) → text: the planner and the reviewers
   * @param {Function} [o.spawnBuilder] ({ cwd, prompt, name }) → { lines, done, kill }
   */
  constructor({ task, dir, agents = 3, ask, spawnBuilder = spawnOxBuilder, bot = null, env = process.env, id = null, sessionId = null }) {
    super();
    this.sessionId = sessionId ? String(sessionId).slice(0, 120) : null;
    this.id = id ?? `${new Date().toISOString().slice(0, 10)}-${slugOf(task).slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    this.task = String(task);
    this.dir = path.resolve(dir);
    // As many builders as the task splits into, up to MAX_AGENTS (a number asks for at most that many).
    this.maxAgents = Math.max(1, Math.min(MAX_AGENTS, Number(agents) || MAX_AGENTS));
    this.ask = ask;
    this.spawnBuilder = spawnBuilder;
    this.bot = bot;
    this.events = [];
    this.files = new Map();   // path → { lines, owners }
    this.runs = new Set();
    this.stopped = false;
    this.state = 'starting';
    this.retryScale = Number(env.OX_BUILD_RETRY_SCALE ?? 1);   // tests shrink the pauses
    this.notes = new Map();   // agent → what you told it, taken into its next step
    this.log = path.join(BUILDS_DIR(env), this.id, 'events.jsonl');
    fs.mkdirSync(path.dirname(this.log), { recursive: true });
  }

  emitEv(ev) {
    const e = { at: Date.now(), ...ev };
    this.events.push(e);
    try { fs.appendFileSync(this.log, `${JSON.stringify(e)}\n`, { mode: 0o600 }); } catch {}
    this.emit('event', e);
    return e;
  }

  status(agent, status, doing = '') { this.emitEv({ type: 'agent', agent, status, doing }); }

  stop() {
    this.stopped = true;
    for (const r of this.runs) r.kill();
    if (this.state !== 'done') { this.state = 'stopped'; this.emitEv({ type: 'done', ok: false, stopped: true, summary: 'Stopped.' , dir: this.dir }); }
  }

  /** A builder's file write, as the room shows it. */
  showFile(agent, wt, rel) {
    const abs = path.join(wt, rel);
    let text;
    try { if (fs.statSync(abs).size > 512 * 1024) return; text = fs.readFileSync(abs, 'utf8'); } catch { return; }
    if (/\0/.test(text.slice(0, 2000))) return;
    const shown = attribute(this.files.get(rel), text, agent);
    this.files.set(rel, { lines: shown.lines, owners: shown.owners });
    this.emitEv({ type: 'file', agent, file: rel, ...shown });
  }

  /** One ox run for a builder, its events turned into the room's. → { code, said } */
  async runBuilder(member, prompt) {
    // A run cut off by the model (rate limit, a stalled stream) is tried again
    // after a pause, carrying on from what is already in the copy; it does not
    // count as a review round.
    let r = await this.runBuilderOnce(member, prompt);
    for (let wait = 30; r.modelError && !this.stopped && wait <= 60; wait *= 2) {
      this.status(member.name, 'waiting', `the model is busy; trying again in ${wait}s`);
      await new Promise((ok) => setTimeout(ok, wait * 1000 * this.retryScale));
      if (this.stopped) break;
      this.status(member.name, 'writing', 'carrying on');
      r = await this.runBuilderOnce(member, `${prompt}\n\nYou were cut off by a model error. Your copy already has what you wrote so far: look at it and carry on from there.`);
    }
    return r;
  }

  /** Something you tell one agent: it takes it into its next step (a builder cannot be spoken to mid-run). */
  tell(agent, text) {
    const t = String(text ?? '').trim().slice(0, 2000);
    if (!t) throw new Error('say something');
    if (!this.team?.some((m) => m.name === agent)) throw new Error(`no ${agent} in this build`);
    (this.notes.get(agent) ?? this.notes.set(agent, []).get(agent)).push(t);
    this.emitEv({ type: 'told', agent, text: t });
  }

  async runBuilderOnce(member, prompt) {
    const { name, wt } = member;
    const told = this.notes.get(name)?.splice(0) ?? [];
    if (told.length) prompt = `${prompt}\n\nTHE OWNER TOLD YOU, AND IT COMES FIRST:\n${told.map((t) => `- ${t}`).join('\n')}`;
    let modelError = false;
    const run = this.spawnBuilder({ cwd: wt, prompt, name, bot: this.bot });
    this.runs.add(run);
    const calls = new Map();
    let said = '';
    try {
      for await (const line of run.lines) {
        if (this.stopped) break;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const type = ev.type ?? ev.t;
        if (type === 'assistant-turn') {
          for (const tc of ev.message?.tool_calls ?? []) {
            let args = {}; try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch {}
            calls.set(tc.id, { name: tc.function?.name, args });
          }
          if (ev.message?.content) said = String(ev.message.content);
        } else if (type === 'tool-start') {
          const c = calls.get(ev.id) ?? { name: ev.name, args: {} };
          const file = c.args?.path ?? c.args?.file_path ?? ev.file;
          if (c.name === 'bash' || c.name === 'run_command') {
            const command = String(c.args?.command ?? c.args?.cmd ?? '').slice(0, 400);
            this.status(name, 'running', command);
            this.emitEv({ type: 'cmd', agent: name, id: ev.id, command });
          } else if (file && /write|edit|patch|create/i.test(String(c.name))) {
            this.status(name, 'writing', path.relative(wt, path.resolve(wt, String(file))));
          } else {
            this.status(name, 'reading', String(c.name ?? ev.name ?? ''));
          }
        } else if (type === 'tool-end') {
          const c = calls.get(ev.id);
          if (c && (c.name === 'bash' || c.name === 'run_command')) this.emitEv({ type: 'cmd-end', agent: name, id: ev.id, ok: !ev.isError, ms: ev.ms });
          const touched = new Set((ev.filesTouched ?? []).map(String));
          const f = c?.args?.path ?? c?.args?.file_path;
          if (!ev.isError && f && /write|edit|patch|create/i.test(String(c?.name))) touched.add(String(f));
          for (const t of touched) {
            const rel = path.relative(wt, path.resolve(wt, t));
            if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])(node_modules|\.git|\.ox-backups|\.ox-build)([\\/]|$)/.test(rel)) continue;
            this.showFile(name, wt, rel.split(path.sep).join('/'));
          }
        } else if (type === 'final') {
          said = String(ev.message?.content ?? said);
        } else if (type === 'error') {
          const text = String(ev.message ?? ev.error ?? 'error');
          if (/\b429\b|rate.?limit|too many requests|stalled|overloaded|\b50[234]\b|timed? ?out|ECONNRESET|socket hang up/i.test(text)) modelError = true;
          this.emitEv({ type: 'note', agent: name, text: text.slice(0, 300) });
        }
      }
    } finally {
      this.runs.delete(run);
    }
    const code = await run.done;
    if (said) this.emitEv({ type: 'say', agent: name, text: said.slice(0, 600) });
    return { code, said, modelError };
  }

  /** Another agent reads the lines this one changed, plus ox's security check. */
  async review(member, reviewer, round) {
    this.status(reviewer, 'reviewing', `${member.name}'s ${member.part.title}`);
    const own = git(member.wt, ['merge-base', 'HEAD', this.mainBranch]).stdout.trim() || this.base;
    const material = reviewMaterial(member.wt, own);
    if (!material.trim()) return { verdict: 'pass', comments: [] };
    let r = null;
    for (let tries = 0; tries < 2 && !r; tries++) {
      try { r = parseReview(await this.ask({ system: REVIEW_SYSTEM, user: `THE PART: ${member.part.title}\n${member.part.brief}\nFiles it owns: ${member.part.files.join(', ') || '(its own)'}\n\n${material}` })); } catch {}
    }
    const unreached = !r;
    r ??= { verdict: 'pass', comments: [{ file: '', line: 0, severity: 'suggestion', comment: 'The reviewer could not be reached; ox\'s security check and the tests decided.' }] };
    const comments = r.comments.map((c) => ({ ...c, by: reviewer }));
    try {
      const { scanDiff } = await import('./security-scan.js');
      for (const f of scanDiff({ cwd: member.wt, base: own }).findings.filter((x) => x.severity === 'high' && !x.test).slice(0, 5)) {
        comments.push({ file: f.file, line: f.line, severity: 'must-fix', comment: `${f.message}. Fix: ${f.fix}`, by: 'security check' });
      }
    } catch {}
    const verdict = comments.some((c) => c.severity === 'must-fix') ? 'changes' : 'pass';
    // Not reached is not approved: the part stays unmerged, and the build says why.
    this.emitEv({ type: 'review', agent: member.name, reviewer, round, verdict: unreached && verdict === 'pass' ? 'unreviewed' : verdict, comments });
    this.status(reviewer, 'waiting', '');
    if (unreached) member.unreviewed = true;
    return { verdict, comments, unreached };
  }

  /** One change to the project at a time: merges, and your own edits. */
  async withLock(fn) {
    const prev = this.mergeLock ?? Promise.resolve();
    let release;
    this.mergeLock = new Promise((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }

  /** Merge one finished part into the project; a conflict goes back to its author once. */
  merge(member) { return this.withLock(() => this.mergeNow(member)); }

  async mergeNow(member) {
    this.status(member.name, 'merging', member.branch);
    // Bring the project's latest into the branch first, so the merge into the project is clean.
    let up = git(member.wt, [...IDENT, 'merge', '--no-edit', '-q', this.mainBranch]);
    if (up.status !== 0) {
      // A conflict in another agent's file: that agent's merged version wins.
      for (const f of git(member.wt, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean)) {
        const owner = this.ownerOf(f);
        if (owner && owner !== member) { git(member.wt, ['checkout', '--theirs', '--', f]); git(member.wt, ['add', '--', f]); }
      }
      if (!git(member.wt, ['diff', '--name-only', '--diff-filter=U']).stdout.trim()) up = git(member.wt, [...IDENT, 'commit', '-q', '--no-edit']);
    }
    if (up.status !== 0) {
      this.status(member.name, 'fixing', 'merge conflict');
      await this.runBuilder(member, `${member.prompt}\n\nYour branch has merge conflicts with the other agents' merged work (git status shows them). Resolve every conflict keeping both sides' behaviour, run your tests, and finish with one line. Do not commit; ox does.`);
      if (git(member.wt, ['diff', '--name-only', '--diff-filter=U']).stdout.trim()) { git(member.wt, ['merge', '--abort']); return { ok: false, note: 'merge conflict could not be resolved' }; }
      commitAll(member.wt, `Merge ${this.mainBranch} into ${member.branch}`);
    }
    const m = git(this.dir, [...IDENT, 'merge', '--no-ff', '-q', '-m', `${member.name}: ${member.part.title}`, member.branch]);
    if (m.status !== 0) { git(this.dir, ['merge', '--abort']); return { ok: false, note: (m.stderr || m.stdout).trim().slice(0, 300) }; }
    for (const f of git(this.dir, ['diff', '--name-only', 'HEAD~1', 'HEAD']).stdout.split('\n').filter(Boolean)) {
      if (!this.files.has(f)) this.showFile(member.name, this.dir, f);
    }
    return { ok: true };
  }

  /** Who owns a path in the plan (null: nobody named it). */
  ownerOf(file) { return this.team?.find((m) => m.part.files.includes(file)) ?? null; }

  /**
   * A builder that writes another agent's file (a stub so its own tests pass,
   * a package.json of its own) would collide with the real one at merge time.
   * ox puts such files back as they were; the owner's version arrives with
   * its merge. → the files put back.
   */
  keepToOwnFiles(member) {
    const back = [];
    for (const l of git(member.wt, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean)) {
      const file = l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
      const owner = this.ownerOf(file);
      if (!owner || owner === member) continue;
      if (git(member.wt, ['cat-file', '-e', `HEAD:${file}`]).status === 0) git(member.wt, ['checkout', 'HEAD', '--', file]);
      else fs.rmSync(path.join(member.wt, file), { force: true });
      back.push({ file, owner: owner.name });
    }
    if (back.length) this.emitEv({ type: 'note', agent: member.name, text: `wrote ${back.map((b) => `${b.owner}'s ${b.file}`).join(', ')}; ox put ${back.length === 1 ? 'it' : 'them'} back: the owner's version arrives when it merges` });
    return back;
  }

  /** Pull what the team has merged so far into a builder's copy (a conflict is left for the merge step). */
  syncMain(member) {
    const r = git(member.wt, [...IDENT, 'merge', '--no-edit', '-q', this.mainBranch]);
    if (r.status !== 0) git(member.wt, ['merge', '--abort']);
    return r.status === 0;
  }

  /**
   * Tests that fail only because a teammate's file is not merged yet are not
   * the author's fault: wait for that teammate (at most 10 minutes), pull the
   * merged work in, and test again. → the teammates waited for.
   */
  async waitForTeammates(member, out) {
    if (!/cannot find module|err_module_not_found|no such file|enoent|modulenotfounderror|failed to resolve import/i.test(out)) return [];
    const pending = this.team.filter((m) => m !== member && !m.settled && !m.waiting && m.part.files.some((f) => out.includes(path.basename(f).replace(/\.[^.]+$/, ''))));
    if (!pending.length) return [];
    member.waiting = true;
    this.status(member.name, 'waiting', `for ${pending.map((m) => m.name).join(' and ')} to merge`);
    await Promise.race([Promise.all(pending.map((m) => m.settledPromise)), new Promise((r) => setTimeout(r, 10 * 60_000).unref?.())]);
    member.waiting = false;
    this.syncMain(member);
    return pending;
  }

  /** One builder from start to merge. */
  async buildPart(member) {
    const reviewer = member.reviewer;
    this.status(member.name, 'writing', member.part.title);
    let { code } = await this.runBuilder(member, member.prompt);
    for (let round = 1; !this.stopped; round++) {
      this.keepToOwnFiles(member);
      commitAll(member.wt, `${member.name}: ${member.part.title}${round > 1 ? ` (fix ${round - 1})` : ''}`);
      this.syncMain(member);
      this.status(member.name, 'testing', '');
      let tests = await partTests(member.wt, this.base, this.runs);
      if (!tests.ok && (await this.waitForTeammates(member, tests.out)).length) {
        this.status(member.name, 'testing', 'with the merged work');
        tests = await partTests(member.wt, this.base, this.runs);
      }
      member.noTests = !!tests.none;
      this.emitEv({ type: 'tests', agent: member.name, round, ok: tests.ok, none: !!tests.none, command: tests.command ?? '', out: tests.out.slice(-2500) });
      const rv = await this.review(member, reviewer, round);
      // Fail closed: work nobody could review waits on its branch rather than joining the
      // project looking approved. OX_ALLOW_UNREVIEWED=1 merges it, and the summary says so.
      if (rv.unreached && process.env.OX_ALLOW_UNREVIEWED !== '1') {
        member.result = { merged: false, why: `no reviewer could be reached, so it was not merged; the work is on ${member.branch}` };
        this.status(member.name, 'needs you', member.result.why);
        return member.result;
      }
      if (tests.ok && rv.verdict === 'pass' && code === 0) break;
      if (round > MAX_ROUNDS) {
        member.result = { merged: false, why: !tests.ok ? 'tests still fail' : rv.verdict !== 'pass' ? 'review still asks for changes' : 'the run did not finish' };
        this.status(member.name, 'needs you', member.result.why);
        return member.result;
      }
      this.status(member.name, 'fixing', `${rv.comments.filter((c) => c.severity === 'must-fix').length} review comment(s)${tests.ok ? '' : ', failing tests'}`);
      ({ code } = await this.runBuilder(member, fixPrompt({ base: member.prompt, comments: rv.comments, tests })));
    }
    if (this.stopped) return { merged: false, why: 'stopped' };
    const m = await this.merge(member);
    this.emitEv({ type: 'merge', agent: member.name, ok: m.ok, note: m.note ?? '' });
    member.result = m.ok ? { merged: true } : { merged: false, why: m.note };
    this.status(member.name, m.ok ? 'merged' : 'needs you', m.ok ? member.part.title : m.note);
    return member.result;
  }

  async run() {
    try {
      this.emitEv({ type: 'build', id: this.id, task: this.task, dir: this.dir, sessionId: this.sessionId });
      // A new project is built in place. In a project of yours the team works on
      // a branch of its own, in its own copy: your checkout, your branch and
      // anything you have not committed are never touched; you merge when ready.
      const fresh = !fs.existsSync(this.dir) || !fs.readdirSync(this.dir).some((f) => f !== '.DS_Store');
      this.base = prepareRepo(this.dir);
      this.projectDir = this.dir;
      if (!fresh) {
        this.teamBranch = `ox-team/${this.id.slice(-6)}`;
        const wt = path.join(this.projectDir, '.ox-build', `${this.id.slice(-6)}-team`);
        const add = git(this.projectDir, ['worktree', 'add', '-q', '-b', this.teamBranch, wt, this.base]);
        if (add.status !== 0) throw new Error(`could not make the team's branch: ${add.stderr.trim()}`);
        this.dir = wt;
        this.emitEv({ type: 'note', agent: 'Planner', text: `Working on branch ${this.teamBranch}, in its own copy: your checkout and uncommitted work stay as they are.` });
      }
      this.mainBranch = git(this.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'HEAD';
      // The planner.
      this.status('Planner', 'planning', this.task.slice(0, 80));
      const tree = git(this.dir, ['ls-files']).stdout.split('\n').filter(Boolean).slice(0, 200).join('\n');
      let answer = '';
      try { answer = await this.ask({ system: PLAN_SYSTEM, user: `TASK: ${this.task}\n\nAs many parts as the task really splits into (each worth an agent of its own), at most ${this.maxAgents}.\n\nFILES ALREADY IN THE PROJECT:\n${tree || '(none: an empty project)'}` }); } catch (e) { this.emitEv({ type: 'note', agent: 'Planner', text: `planner failed: ${String(e?.message ?? e).slice(0, 200)}` }); }
      const plan = parsePlan(answer, this.task, this.maxAgents);
      this.plan = plan;
      if (this.stopped) return;
      const team = plan.parts.map((part, i) => ({ name: `Agent ${i + 1}`, part }));
      team.forEach((m, i) => {
        m.reviewer = team.length > 1 ? team[(i + 1) % team.length].name : 'Reviewer';
        m.settledPromise = new Promise((r) => { m.settle = () => { m.settled = true; r(); }; });
      });
      this.team = team;
      this.emitEv({ type: 'plan', summary: plan.summary, stack: plan.stack, test: plan.test, parts: team.map((m) => ({ agent: m.name, reviewer: m.reviewer, title: m.part.title, files: m.part.files, brief: m.part.brief })) });
      this.status('Planner', 'done', `${team.length} part${team.length === 1 ? '' : 's'}`);
      // A worktree and a branch each.
      for (const m of team) {
        m.branch = `ox-build/${this.id.slice(-6)}-${slugOf(m.name)}`;
        m.wt = path.join(this.projectDir, '.ox-build', `${this.id.slice(-6)}-${slugOf(m.name)}`);
        const add = git(this.projectDir, ['worktree', 'add', '-q', '-b', m.branch, m.wt, this.base]);
        if (add.status !== 0) throw new Error(`could not make ${m.name}'s copy: ${add.stderr.trim()}`);
        m.prompt = builderPrompt({ task: this.task, plan, part: m.part, name: m.name, team });
      }
      this.state = 'building';
      // Started a few seconds apart, so a free-tier model is not hit by every agent at once.
      const results = await Promise.all(team.map((m, i) => new Promise((ok) => setTimeout(ok, i * 4000 * this.retryScale)).then(() => this.buildPart(m)).catch((e) => {
        m.result = { merged: false, why: String(e?.message ?? e).slice(0, 200) };
        this.status(m.name, 'needs you', m.result.why);
        return m.result;
      }).finally(() => m.settle())));
      if (this.stopped) return;
      // The whole project, once everything that passed is in.
      let final = null;
      if (plan.test && results.some((r) => r.merged)) {
        this.status('Planner', 'testing', plan.test);
        if (fs.existsSync(path.join(this.dir, 'package.json')) && !fs.existsSync(path.join(this.dir, 'node_modules'))) await sh(this.dir, 'npm install --no-audit --no-fund', 5 * 60_000, this.runs);
        if (this.stopped) return;
        final = await sh(this.dir, plan.test, 5 * 60_000, this.runs);
        this.emitEv({ type: 'tests', agent: 'Planner', round: 0, ok: final.ok, command: plan.test, out: final.out.slice(-2500), whole: true });
      }
      for (const m of team) {
        if (m.result?.merged) {
          git(this.dir, ['worktree', 'remove', '--force', m.wt]);
          git(this.dir, ['branch', '-D', m.branch]);
        }
      }
      const merged = team.filter((m) => m.result?.merged).length;
      const left = team.filter((m) => !m.result?.merged).map((m) => `${m.name} (${m.part.title}): ${m.result?.why ?? 'not merged'}, on branch ${m.branch}`);
      const ok = merged === team.length && (!final || final.ok);
      this.state = 'done';
      this.status('Planner', 'done', '');
      this.emitEv({
        type: 'done', ok, dir: this.dir, merged, parts: team.length,
        branch: this.teamBranch ?? null,
        summary: `${merged} of ${team.length} part${team.length === 1 ? '' : 's'} ${team.some((m) => m.noTests) ? `(${team.filter((m) => m.noTests).length} with no tests) ` : ''}${team.some((m) => m.unreviewed) ? `merged, ${team.filter((m) => m.unreviewed).length} with no review because the reviewer could not be reached,` : 'reviewed and merged'}${this.teamBranch ? ` on branch ${this.teamBranch} (in your project: git merge ${this.teamBranch})` : ''}${final ? `; the whole project's tests ${final.ok ? 'pass' : 'fail'}` : ''}.${left.length ? ` Not merged: ${left.join('; ')}.` : ''}`,
      });
    } catch (e) {
      this.state = 'done';
      this.emitEv({ type: 'done', ok: false, dir: this.dir, summary: `The build stopped: ${String(e?.message ?? e).slice(0, 300)}` });
    }
  }
}

// ---------------------------------------------------------------------------
// The builds this machine has (for the app's list and for replay)
// ---------------------------------------------------------------------------

const live = new Map();
// When ox's server stops, its builders stop with it (none left running on their own).
process.once('exit', () => { for (const r of live.values()) for (const run of r.runs) run.kill(); });

export function startBuild(opts) {
  const dir = path.resolve(opts.dir);
  for (const r of live.values()) {
    if (r.dir === dir && r.state !== 'done' && r.state !== 'stopped') throw new Error(`a team is still building in ${dir}: wait for it, or stop it first`);
  }
  const room = new BuildRoom(opts);
  live.set(room.id, room);
  room.run().finally(() => setTimeout(() => live.delete(room.id), 10 * 60_000).unref?.());
  return room;
}

export const liveBuild = (id) => live.get(id) ?? null;

export function readBuild(id, { env = process.env } = {}) {
  if (!/^[\w.-]+$/.test(String(id))) return null;
  const room = live.get(id);
  if (room) return { events: room.events, live: room.state !== 'done' && room.state !== 'stopped' };
  try {
    const events = fs.readFileSync(path.join(BUILDS_DIR(env), id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, live: false };
  } catch { return null; }
}

export function listBuilds({ env = process.env, limit = 20 } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(BUILDS_DIR(env)); } catch {}
  return ids.map((id) => {
    const b = readBuild(id, { env });
    if (!b?.events.length) return null;
    const first = b.events[0], last = b.events[b.events.length - 1];
    const done = b.events.findLast?.((e) => e.type === 'done') ?? null;
    return { id, task: first.task ?? '', dir: first.dir ?? '', sessionId: first.sessionId ?? null, at: first.at, updated: last.at, live: b.live, ok: done?.ok ?? null, summary: done?.summary ?? '' };
  }).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Your own edit to a file the team built: written into the project and
 * committed as yours (between merges, so it never lands half way through
 * one), and shown in the room with your name on the lines you changed.
 * A file still only in a builder's copy is that builder's until it merges.
 */
export async function editBuildFile(id, file, content, { env = process.env } = {}) {
  const b = readBuild(id, { env });
  if (!b) throw new Error('no such build');
  const rel = String(file ?? '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').some((x) => x === '..' || x === '') || /^(\.git|\.ox-build|\.ox-backups)(\/|$)/.test(rel)) throw new Error('not a file of this project');
  if (String(content).length > 1024 * 1024) throw new Error('that file is too big to edit here');
  const room = live.get(id) ?? null;
  // Where the team's work is: its branch's copy in a project of yours, else the project itself.
  const dir = room?.dir ?? [...b.events].reverse().find((e) => e.type === 'done')?.dir ?? b.events.find((e) => e.type === 'build')?.dir;
  if (!dir || !fs.existsSync(dir)) throw new Error('the project folder is gone');
  const write = () => {
    if (git(dir, ['cat-file', '-e', `HEAD:${rel}`]).status !== 0) {
      const writer = [...b.events].reverse().find((e) => e.type === 'file' && e.file === rel)?.agent;
      throw new Error(`${writer ?? 'An agent'} is still writing ${rel}: you can edit it once it is merged`);
    }
    fs.writeFileSync(path.join(dir, rel), String(content));
    git(dir, ['add', '--', rel]);
    if (git(dir, [...IDENT, 'commit', '-q', '-m', `You: edit ${rel}`]).status !== 0 && git(dir, ['diff', '--cached', '--quiet']).status !== 0) throw new Error('could not save the edit');
    if (room) { room.showFile('You', dir, rel); return; }
    // A finished build: the edit joins its record, attributed against what was last shown.
    const prev = [...b.events].reverse().find((e) => e.type === 'file' && e.file === rel);
    const shown = attribute(prev ? { lines: prev.lines, owners: prev.owners } : null, String(content), 'You');
    fs.appendFileSync(path.join(BUILDS_DIR(env), id, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), type: 'file', agent: 'You', file: rel, ...shown })}\n`);
  };
  if (room) await room.withLock(write); else write();
  return { ok: true, file: rel };
}

const STATUS_Q = /\b(what'?s|what is|how'?s|how is|status|progress|update on|where are)\b[^?]{0,60}\b(going|going on|happening|running|doing|build|building|agents?|team|working|progress|status)\b|\b(agents?|team|builds?)\b[^?]{0,40}\b(doing|status|progress|working on|up to)\b|^\s*(status|progress)\s*\??\s*$/i;

/**
 * "What's going on?" from any chat session: the team builds on this Mac, live
 * and lately finished, read from their records (no model). null when the
 * question is not about them or there are none.
 */
export function statusReply(text, { sessionId = null, env = process.env, now = Date.now() } = {}) {
  if (!STATUS_Q.test(String(text ?? '')) || String(text).length > 200) return null;
  const builds = listBuilds({ env, limit: 10 }).filter((b) => b.live || now - (b.updated ?? b.at) < 3 * 3600_000);
  if (!builds.length) return null;
  const lines = [];
  for (const b of builds) {
    const ev = readBuild(b.id, { env })?.events ?? [];
    const where = b.sessionId && b.sessionId === sessionId ? 'started in this chat' : 'started in another chat';
    if (b.live) {
      const agents = new Map();
      for (const e of ev) if (e.type === 'agent') agents.set(e.agent, e);
      const merged = ev.filter((e) => e.type === 'merge' && e.ok).map((e) => e.agent);
      lines.push(`**Building now** (${where}): ${b.task}`);
      for (const [name, e] of agents) {
        if (name === 'Planner' && e.status === 'done') continue;
        lines.push(`- ${name}: ${merged.includes(name) ? 'merged' : e.status}${e.doing ? ` · ${e.doing}` : ''}`);
      }
      lines.push(`- Folder: \`${b.dir}\``);
    } else {
      lines.push(`**Finished** (${where}): ${b.task}\n- ${b.summary || (b.ok ? 'Built.' : 'Stopped.')}`);
    }
  }
  return `${lines.join('\n')}\n\nStart another with Team mode, or "build with a team: …".`;
}

/** One agent's own record in a build, for answering "what are you doing?" in its voice. */
export function agentContext(events, agent) {
  const mine = events.filter((e) => e.agent === agent || e.reviewer === agent);
  const plan = [...events].reverse().find((e) => e.type === 'plan');
  const part = plan?.parts?.find((p) => p.agent === agent);
  const status = [...mine].reverse().find((e) => e.type === 'agent');
  const files = [...new Set(mine.filter((e) => e.type === 'file' && e.agent === agent).map((e) => e.file))];
  const cmds = mine.filter((e) => e.type === 'cmd').slice(-8).map((e) => e.command);
  const reviews = events.filter((e) => e.type === 'review' && (e.agent === agent || e.reviewer === agent)).slice(-3)
    .map((e) => `${e.reviewer} reviewed ${e.agent} (round ${e.round}): ${e.verdict}${e.comments?.length ? `: ${e.comments.map((c) => `${c.file}:${c.line} ${c.severity} ${c.comment}`).join(' | ')}` : ''}`);
  const tests = mine.filter((e) => e.type === 'tests').slice(-2).map((e) => `${e.ok ? 'pass' : 'fail'}${e.ok ? '' : `: ${String(e.out ?? '').slice(0, 400)}`}`);
  const said = [...mine].reverse().find((e) => e.type === 'say')?.text ?? '';
  const told = mine.filter((e) => e.type === 'told').map((e) => e.text);
  return [
    part ? `YOUR PART: ${part.title}\n${part.brief}\nFiles you own: ${part.files.join(', ') || '(your own)'}` : '',
    status ? `RIGHT NOW: ${status.status}${status.doing ? `: ${status.doing}` : ''}` : '',
    files.length ? `FILES YOU WROTE: ${files.join(', ')}` : '',
    cmds.length ? `COMMANDS YOU RAN LATELY:\n${cmds.map((c) => `$ ${c}`).join('\n')}` : '',
    tests.length ? `YOUR TESTS: ${tests.join(' / ')}` : '',
    reviews.length ? `REVIEWS:\n${reviews.join('\n')}` : '',
    said ? `WHAT YOU LAST SAID: ${said}` : '',
    told.length ? `WHAT THE OWNER TOLD YOU: ${told.join(' | ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export const AGENT_CHAT_SYSTEM = `You are one agent of a team building software. The owner asks you a question while you work. Answer as that agent, in the first person, in two to five short sentences: what you are doing right now, what is done, what is next, and anything blocking you. Use only your record below; if it does not say, say you do not know yet. Never claim work your record does not show.`;

/** Ask one agent of a build what it is doing. → its answer */
export async function askBuildAgent(id, agent, question, { ask, env = process.env } = {}) {
  const b = readBuild(id, { env });
  if (!b) throw new Error('no such build');
  const ctx = agentContext(b.events, agent);
  if (!ctx) throw new Error(`no ${agent} in this build`);
  try {
    const said = String(await ask({ system: AGENT_CHAT_SYSTEM, user: `YOU ARE ${agent}.\n\n${ctx}\n\nTHE OWNER ASKS: ${String(question ?? '').slice(0, 1000)}` }) ?? '').trim();
    if (said) return said;
  } catch {}
  // The model is busy (its builders use it too) or down: the answer from its record, plainly.
  return plainStatus(b.events, agent);
}

/** "What are you doing?" answered from the record alone, with no model. */
export function plainStatus(events, agent) {
  const mine = events.filter((e) => e.agent === agent);
  const st = [...mine].reverse().find((e) => e.type === 'agent');
  const files = [...new Set(mine.filter((e) => e.type === 'file').map((e) => e.file))];
  const cmd = [...mine].reverse().find((e) => e.type === 'cmd');
  const part = [...events].reverse().find((e) => e.type === 'plan')?.parts?.find((p) => p.agent === agent);
  return [
    part ? `My part: ${part.title}.` : '',
    st ? `Right now I am ${st.status}${st.doing ? `: ${st.doing}` : ''}.` : 'I have not started yet.',
    files.length ? `So far I wrote ${files.join(', ')}.` : '',
    cmd ? `Last command: ${cmd.command}.` : '',
  ].filter(Boolean).join(' ');
}
