// ox updates itself from the notch (Coucou 0.5.3's self-update): it asks once
// whether it may check GitHub for new versions; then it checks a few times a
// day and says so in the notch, at most once a day; one click updates.
//
// "Checked before anything": the update must come from ox's own GitHub
// repository over HTTPS, be a fast-forward of what you have (your own commits
// and edits are never overwritten or merged), and the changed JavaScript must
// load. If the check after updating fails, ox goes back to where it was.
// Then the island is rebuilt when its code changed, and everything restarts
// (the app's server picks up new code by itself).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const OX_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME_REPO = /^(?:https:\/\/github\.com\/|git@github\.com:)SAI141003\/ox(?:\.git)?\/?$/i;
const stateFile = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'update.json');
const git = (root, args, opts = {}) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, ...opts });
const CHECK_EVERY_MS = 6 * 3600_000;
const TELL_EVERY_MS = 24 * 3600_000;

export function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return { allowed: null }; } }
function writeState(s) { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); return s; }

/** Your answer to "may ox check GitHub for new versions?" */
export function setAllowed(yes) {
  const before = readState();
  return writeState({ ...before, allowed: !!yes, autoApply: yes ? !!before.autoApply : false, askedAt: Date.now() });
}

/** Explicitly opt in to unattended, verified fast-forward updates. */
export function setAutoUpdate(yes) {
  const before = readState();
  return writeState({ ...before, allowed: yes ? true : before.allowed, autoApply: !!yes, askedAt: Date.now() });
}

/** Where this ox comes from, and whether it can update itself. */
export function source(root = OX_ROOT, trusted = HOME_REPO) {
  if (!fs.existsSync(path.join(root, '.git'))) return { ok: false, why: 'this ox was installed from a download; get the newest from the GitHub releases page' };
  // The branch it follows, or (when none is set, as with plain `git push origin main`) the same branch on origin.
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const upstream = up.status === 0 ? up.stdout.trim() : branch && branch !== 'HEAD' ? `origin/${branch}` : null;
  if (!upstream) return { ok: false, why: 'this checkout is on no branch' };
  const remote = upstream.split('/')[0];
  const url = git(root, ['remote', 'get-url', remote]).stdout.trim();
  if (!url) return { ok: false, why: 'this checkout follows no branch on GitHub' };
  if (!trusted.test(url)) return { ok: false, why: `updates come only from ox's own repository (github.com/SAI141003/ox), not ${url || remote}` };
  return { ok: true, upstream, url };
}

/** Look for new versions (a git fetch; nothing about you is sent). → state */
export function check({ root = OX_ROOT, now = Date.now(), force = false, trusted = HOME_REPO } = {}) {
  const s = readState();
  if (s.allowed !== true) return { ...s, ask: s.allowed == null };
  if (!force && s.checkedAt && now - s.checkedAt < CHECK_EVERY_MS) return s;
  const src = source(root, trusted);
  if (!src.ok) return writeState({ ...s, checkedAt: now, available: null, problem: src.why });
  const f = git(root, ['fetch', '--quiet']);
  if (f.status !== 0) return writeState({ ...s, checkedAt: now, problem: `could not reach GitHub: ${f.stderr.trim().slice(0, 160)}` });
  const log = git(root, ['log', '--format=%h %s', `HEAD..${src.upstream}`]).stdout.trim();
  const incoming = log ? log.split('\n') : [];
  return writeState({ ...s, checkedAt: now, problem: null, available: incoming.length ? { count: incoming.length, upstream: src.upstream, subjects: incoming.slice(0, 20) } : null });
}

/** What the notch should show now: 'ask' once, 'update' at most once a day, or nothing. */
export function notice({ now = Date.now() } = {}) {
  const s = readState();
  if (s.allowed == null) return { kind: 'ask' };
  if (s.allowed && s.available?.count && (!s.toldAt || now - s.toldAt > TELL_EVERY_MS)) return { kind: 'update', count: s.available.count, subjects: s.available.subjects };
  return null;
}
/** "OK" on the result: the card goes. */
export function acknowledge() { return writeState({ ...readState(), applying: null }); }

/** "Later": not again today. */
export function later(now = Date.now()) { return writeState({ ...readState(), toldAt: now }); }

/** The changed JavaScript files load (node --check). → [problems] */
function loads(root, files) {
  const bad = [];
  for (const f of files.filter((x) => /\.(m?js)$/.test(x) && fs.existsSync(path.join(root, x)))) {
    // Code with import/export is checked as a module: Node 22 lets an ambiguous
    // .js file with a broken export pass a plain --check.
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const esm = f.endsWith('.mjs') || /^\s*(?:import\s|export\s)/m.test(text);
    const r = esm ? spawnSync(process.execPath, ['--input-type=module', '--check'], { input: text, encoding: 'utf8' }) : spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${f}: ${String(r.stderr).trim().split('\n').slice(-1)[0]}`);
  }
  return bad;
}

/**
 * Update now. `rebuildIsland()` and `restartIsland()` are called when the
 * island's code changed. → { ok, steps, from, to, islandRebuilt } or { ok: false, why }
 */
export function apply({ root = OX_ROOT, rebuildIsland = defaultRebuild, restartIsland = defaultRestart, say = () => {}, trusted = HOME_REPO } = {}) {
  const steps = [];
  const step = (t) => { steps.push(t); say(t); };
  const src = source(root, trusted);
  if (!src.ok) return { ok: false, why: src.why, steps };
  step('Checking the update');
  const from = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const fetch = git(root, ['fetch', '--quiet']);
  if (fetch.status !== 0) return { ok: false, why: 'could not reach GitHub', steps };
  const to = git(root, ['rev-parse', src.upstream]).stdout.trim();
  if (from === to) { writeState({ ...readState(), available: null }); return { ok: true, upToDate: true, steps, from, to }; }
  if (git(root, ['merge-base', '--is-ancestor', 'HEAD', src.upstream]).status !== 0) return { ok: false, why: 'this copy has its own commits that GitHub does not; ox will not overwrite or merge them', steps };
  const files = git(root, ['diff', '--name-only', from, to]).stdout.trim().split('\n').filter(Boolean);
  step(`Updating (${files.length} file${files.length === 1 ? '' : 's'})`);
  const m = git(root, ['merge', '--ff-only', '--quiet', src.upstream]);
  if (m.status !== 0) return { ok: false, why: (m.stderr.trim() || 'could not update').replace(/\s+/g, ' ').slice(0, 200), steps };
  const bad = loads(root, files);
  if (bad.length) {
    // Back to where it was, keeping any edits of yours (--keep refuses to touch them).
    git(root, ['reset', '--keep', from]);
    return { ok: false, why: `the new code did not load, so ox went back: ${bad[0]}`, steps };
  }
  let islandRebuilt = false;
  if (files.some((f) => f.startsWith('desktop/island/')) && process.platform === 'darwin') {
    step('Rebuilding the island');
    const r = rebuildIsland(root);
    if (r?.ok === false) step(`The island could not be rebuilt (${r.why}); the rest is updated`);
    else { islandRebuilt = true; restartIsland(root); }
  }
  writeState({ ...readState(), available: null, updatedAt: Date.now(), updatedTo: to.slice(0, 7) });
  step('Up to date');
  return { ok: true, steps, from: from.slice(0, 7), to: to.slice(0, 7), files: files.length, islandRebuilt };
}

/** Run check or apply in a separate ox process (git and the island build take a while); progress lands in the state. */
export function inBackground(action, { root = OX_ROOT } = {}) {
  if (action === 'apply') writeState({ ...readState(), applying: { steps: ['Checking the update'], done: false, at: Date.now() } });
  const p = spawn(process.execPath, [path.join(root, 'bin', 'ox.js'), 'update', action === 'apply' ? '--notch-apply' : '--notch-check'], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
  return { started: true };
}

/** For `ox update --notch-apply`: apply, writing each step where the notch can read it. */
export function applyWithProgress(opts = {}) {
  const steps = [];
  const put = (extra) => writeState({ ...readState(), applying: { steps, at: Date.now(), done: false, ...extra } });
  const r = apply({ ...opts, say: (t) => { steps.push(t); put(); } });
  put({ done: true, ok: r.ok, why: r.why ?? null, upToDate: !!r.upToDate });
  return r;
}

function defaultRebuild(root) {
  const r = spawnSync('swift', ['build', '-c', 'release'], { cwd: path.join(root, 'desktop', 'island'), encoding: 'utf8', timeout: 20 * 60_000 });
  return r.status === 0 ? { ok: true } : { ok: false, why: String(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] };
}
function defaultRestart(root) {
  // Started apart and not waited for, so the island that asked can be replaced by the new one.
  spawn(process.execPath, [path.join(root, 'bin', 'ox.js'), 'island', 'restart'], { detached: true, stdio: 'ignore' }).unref();
}
