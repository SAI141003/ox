// ox improves ox — the way the Darwin Gödel Machine does it (Zhang et al.,
// "Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents",
// arXiv 2505.22954): propose a change to its own code, measure it, keep it
// only if it measured better, and keep an archive of every attempt.
//
// What makes it safe enough to run on your machine:
//   * Every attempt happens in its own git worktree on its own branch
//     (~/.ox/self/evolve/<id>), never in the copy of ox you are running.
//   * The attempt is made by ox itself, headless, in a workspace sandbox, with
//     a cost cap.
//   * It is judged by the same unit suite that gates a release, against the
//     current version's own result; a change that breaks one test more than
//     before is rejected, and so is one that changes nothing.
//   * Nothing is merged on its own. `ox evolve accept <id>` fast-forwards your
//     checkout onto it after you have looked; `ox evolve reject <id>` drops it.
//
// Where the goals come from: what you ask for (`ox evolve "<goal>"`), and ox's
// own failures — every crash of the CLI is recorded (secrets redacted) in
// ~/.ox/self/failures.jsonl, and `ox evolve` with no goal picks the one that
// happened most.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = () => path.join(process.env.OX_SELF_HOME || path.join(os.homedir(), '.ox', 'self'));
const FAILURES = () => path.join(SELF(), 'failures.jsonl');
const ARCHIVE = () => path.join(SELF(), 'archive.jsonl');

const git = (cwd, args, opts = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000, ...opts });

export function isCheckout(root = OX_ROOT) {
  return git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

// ---- failures ox has had ------------------------------------------------------

// A stable signature for a failure: the message without numbers, paths and ids,
// plus the first frame inside ox's own source.
export function signature(message = '', stack = '') {
  const msg = String(message).replace(/\/[^\s'"]+/g, '<path>').replace(/\b[0-9a-f]{6,}\b/gi, '<id>').replace(/\d+/g, 'N').slice(0, 160);
  const frame = String(stack).split('\n').find((l) => /\/src\/[\w./-]+\.js/.test(l)) ?? '';
  const where = (/\/(src\/[\w./-]+\.js):(\d+)/.exec(frame) ?? [])[1] ?? '';
  return `${msg}${where ? ` @ ${where}` : ''}`;
}

export async function recordFailure({ command = [], error } = {}) {
  if (process.env.OX_SELF_REPORT === '0') return null;
  try {
    // memory.js's redactSecrets returns { text, count }; only the text is kept.
    const { redactSecrets } = await import('./memory.js');
    const clean = (t) => redactSecrets(String(t)).text;
    const message = clean(error?.message ?? error ?? '');
    const stack = clean(error?.stack ?? '').split('\n').slice(0, 12).join('\n');
    const row = {
      at: Date.now(), sig: signature(message, stack), message, stack,
      command: clean(command.map(String).filter((a) => !a.startsWith('sk-')).join(' ')).slice(0, 200),
      version: JSON.parse(fs.readFileSync(path.join(OX_ROOT, 'package.json'), 'utf8')).version,
    };
    fs.mkdirSync(SELF(), { recursive: true });
    fs.appendFileSync(FAILURES(), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return row;
  } catch { return null; }
}

export function failures() {
  let rows = [];
  try { rows = fs.readFileSync(FAILURES(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const bySig = new Map();
  for (const r of rows) {
    const g = bySig.get(r.sig) ?? { sig: r.sig, count: 0, last: 0, example: r };
    g.count++; if (r.at > g.last) { g.last = r.at; g.example = r; }
    bySig.set(r.sig, g);
  }
  const fixed = new Set(archive().filter((a) => a.accepted && a.failureSig).map((a) => a.failureSig));
  return [...bySig.values()].filter((g) => !fixed.has(g.sig)).sort((a, b) => b.count - a.count || b.last - a.last);
}

// ---- the archive of attempts ----------------------------------------------------

export function archive() {
  const byId = new Map();
  try {
    for (const l of fs.readFileSync(ARCHIVE(), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); byId.set(r.id, { ...byId.get(r.id), ...r }); } catch {}
    }
  } catch {}
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

function note(row) {
  fs.mkdirSync(SELF(), { recursive: true });
  fs.appendFileSync(ARCHIVE(), `${JSON.stringify(row)}\n`);
}

// ---- measuring --------------------------------------------------------------------

// Pass / fail counts of the unit suite in `dir`. The current version's result
// is cached by commit, so it is measured once.
export async function measure(dir, { timeoutMs = 2_400_000, onLine = () => {} } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/verify.mjs', '--only', 'unit', '--json'], { cwd: dir, env: { ...process.env, OX_ISLAND: '0', OX_LEARN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) onLine(l); });
    p.on('close', () => {
      clearTimeout(t);
      resolve(parseVerify(out));
    });
  });
}

// verify.mjs --json: { results: [{ stage: 'unit', detail: 'N pass · M fail · K cancelled\n  - name …' }] }
export function parseVerify(out) {
  let report = null;
  for (const line of String(out).split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { report = JSON.parse(line); break; } catch {}
  }
  const unit = report?.results?.find((r) => r.stage === 'unit');
  const detail = String(unit?.detail ?? '');
  const m = /(\d+) pass · (\d+) fail/.exec(detail);
  const failing = [...detail.matchAll(/^\s+- (.+)$/gm)].map((x) => x[1].trim());
  return { pass: m ? Number(m[1]) : NaN, fail: m ? Number(m[2]) : NaN, failing, ok: !!m, tail: detail.split('\n').slice(0, 12).join('\n') || String(out).slice(-800) };
}

function baselineFile(sha) { return path.join(SELF(), `baseline-${sha}.json`); }

export async function baseline(root = OX_ROOT, opts = {}) {
  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  try { return JSON.parse(fs.readFileSync(baselineFile(sha), 'utf8')); } catch {}
  const r = { sha, ...(await measure(root, opts)) };
  if (r.ok) { fs.mkdirSync(SELF(), { recursive: true }); fs.writeFileSync(baselineFile(sha), JSON.stringify(r)); }
  return r;
}

// Better = no test that passed before fails now, and something improved:
// more tests pass, or the attempt's own new test passes.
export function judge(before, after, { diffFiles = [] } = {}) {
  if (!after.ok) return { accept: false, why: 'the test suite did not finish' };
  if (!diffFiles.length) return { accept: false, why: 'no change was made' };
  const newlyFailing = after.failing.filter((f) => !before.failing.includes(f));
  if (after.fail > before.fail || newlyFailing.length) return { accept: false, why: `breaks ${newlyFailing.length || after.fail - before.fail} test(s): ${newlyFailing.slice(0, 3).join('; ')}` };
  if (after.pass > before.pass || after.fail < before.fail) return { accept: true, why: `${after.pass} pass (was ${before.pass}), ${after.fail} fail (was ${before.fail})` };
  return { accept: false, why: 'tests unchanged — no measured improvement (add a test that shows the fix)' };
}

// ---- one attempt -------------------------------------------------------------------

function promptFor(goal, failure) {
  return [
    'You are improving ox itself — the coding agent whose source code is this folder.',
    goal ? `Goal: ${goal}` : '',
    failure ? `ox has crashed ${failure.count} time(s) with:\n${failure.example.message}\n${failure.example.stack}\nwhile running: ox ${failure.example.command}\nFind the cause and fix it.` : '',
    'Rules:',
    '- Make the smallest change that does it, in the style of the code around it.',
    '- Add or extend a test under test/ that fails before your change and passes after it.',
    '- Run that test file with `node --test test/<file>.test.js` and make it pass.',
    '- Do not touch scripts/verify.mjs, the test runner, or any test you did not write for this change.',
    '- Do not commit; ox measures and commits the attempt itself.',
  ].filter(Boolean).join('\n');
}

export async function evolve({ goal = '', root = OX_ROOT, maxCost = 2, bot = null, log = () => {} } = {}) {
  if (!isCheckout(root)) throw new Error(`ox can only change itself when it runs from a git checkout (this one is at ${root})`);
  const failure = goal ? null : failures()[0] ?? null;
  if (!goal && !failure) return { id: null, accepted: false, why: 'nothing to improve: no goal given and no recorded failures — try: ox evolve "<what to make better>"' };
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const branch = `ox-evolve/${id}`;
  const dir = path.join(SELF(), 'evolve', id);
  const goalText = goal || `fix: ${failure.sig}`;
  note({ id, at: Date.now(), goal: goalText, branch, dir, failureSig: failure?.sig ?? null, state: 'running' });

  log(`measuring the current version (once per commit)…`);
  const before = await baseline(root, { onLine: () => {} });
  if (!before.ok) { note({ id, state: 'failed', why: 'could not measure the current version' }); throw new Error(`could not measure the current version:\n${before.tail}`); }
  log(`current version: ${before.pass} pass, ${before.fail} fail`);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (add.status !== 0) { note({ id, state: 'failed', why: add.stderr.trim() }); throw new Error(`git worktree add failed: ${add.stderr.trim()}`); }

  log(`attempt ${id}: ox is working on itself in ${dir}`);
  const args = [path.join(root, 'bin', 'ox.js'), '-p', promptFor(goal, failure), '-y', '--sandbox', 'workspace', '--max-cost', String(maxCost), ...(bot ? ['--bot', bot] : [])];
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: dir, env: { ...process.env, OX_ISLAND: process.env.OX_ISLAND ?? '0', OX_SELF_REPORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => log(String(d).trimEnd()));
    p.stderr.on('data', (d) => log(String(d).trimEnd()));
    p.on('close', resolve);
  });
  const diffFiles = git(dir, ['status', '--porcelain']).stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  const stat = git(dir, ['diff', '--stat', 'HEAD']).stdout.trim();
  log(`ox finished (exit ${code}); changed: ${diffFiles.join(', ') || 'nothing'}`);

  let after = { ok: false, pass: NaN, fail: NaN, failing: [] };
  if (diffFiles.length) { log('measuring the attempt…'); after = await measure(dir); }
  const verdict = judge(before, after, { diffFiles });
  if (diffFiles.length) {
    git(dir, ['add', '-A']);
    git(dir, ['-c', 'user.name=ox', '-c', 'user.email=ox@localhost', 'commit', '-q', '-m', `ox evolve ${id}: ${goalText.slice(0, 120)}\n\n${verdict.why}`]);
  }
  const row = { id, state: verdict.accept ? 'ready' : 'rejected', why: verdict.why, before: { pass: before.pass, fail: before.fail }, after: { pass: after.pass, fail: after.fail }, files: diffFiles, stat, exit: code };
  note(row);
  if (!verdict.accept) cleanup(root, id, { keepBranch: diffFiles.length > 0 });
  return { id, accepted: verdict.accept, why: verdict.why, files: diffFiles, stat, before, after, branch };
}

function cleanup(root, id, { keepBranch = false } = {}) {
  const dir = path.join(SELF(), 'evolve', id);
  git(root, ['worktree', 'remove', '--force', dir]);
  if (!keepBranch) git(root, ['branch', '-D', `ox-evolve/${id}`]);
}

// Bring an accepted attempt into your checkout: fast-forward only, after the
// same suite passes on top of what you have now.
export function accept(id, { root = OX_ROOT } = {}) {
  const a = archive().find((x) => x.id === id);
  if (!a) throw new Error(`no attempt ${id} (ox evolve list)`);
  if (a.state !== 'ready') throw new Error(`attempt ${id} is ${a.state}: ${a.why ?? ''}`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  if (dirty) throw new Error('your ox checkout has uncommitted changes; commit or stash them first');
  const ff = git(root, ['merge', '--ff-only', a.branch]);
  if (ff.status !== 0) throw new Error(`cannot fast-forward onto ${a.branch} (your checkout moved on). Look at it with: git -C ${root} log ${a.branch}`);
  cleanup(root, id);
  note({ id, state: 'accepted', accepted: true, acceptedAt: Date.now() });
  return a;
}

export function reject(id, { root = OX_ROOT } = {}) {
  const a = archive().find((x) => x.id === id);
  if (!a) throw new Error(`no attempt ${id}`);
  cleanup(root, id);
  note({ id, state: 'rejected', why: a.why ?? 'rejected by you' });
  return a;
}

export function diff(id, { root = OX_ROOT } = {}) {
  const a = archive().find((x) => x.id === id);
  if (!a) throw new Error(`no attempt ${id}`);
  return git(root, ['diff', `${a.branch}~1`, a.branch]).stdout;
}

// ---- updating ox from where it came from ---------------------------------------------

// `ox update`: what is new upstream, and a fast-forward to it when you say so.
export function updateCheck(root = OX_ROOT) {
  if (!isCheckout(root)) return { kind: 'download', message: 'this ox was installed from a download — get the newest from the GitHub releases page' };
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.status !== 0) return { kind: 'none', message: 'this checkout has no upstream branch to update from' };
  const fetch = git(root, ['fetch', '--quiet'], { timeout: 60_000 });
  if (fetch.status !== 0) return { kind: 'error', message: `could not reach ${up.stdout.trim()}: ${fetch.stderr.trim()}` };
  const log = git(root, ['log', '--oneline', 'HEAD..@{u}']).stdout.trim();
  return { kind: 'git', upstream: up.stdout.trim(), incoming: log ? log.split('\n') : [] };
}

export function updateApply(root = OX_ROOT) {
  const r = git(root, ['merge', '--ff-only', '@{u}']);
  if (r.status !== 0) throw new Error(r.stderr.trim() || 'could not fast-forward');
  return r.stdout.trim();
}
