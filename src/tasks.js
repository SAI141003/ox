// The ox task board: one JSON file per task under ~/.ox/tasks, plus an
// append-only activity log. Modeled on what makes Paperclip's task system
// work for teams of agents:
//
//   - Atomic checkout. A task has at most one owner. `claimTask` takes an
//     O_EXCL lock file, so two runs racing for the same task cannot both win;
//     a lock whose owner process is gone is stale and can be taken over.
//   - Blockers. `blockedBy` lists task ids; a task is ready only when every
//     blocker is done. `nextTask` hands out the oldest ready, unclaimed task.
//   - Goal ancestry. `parentId` links a task to the task or goal above it, so
//     an agent working on it sees the "why" (`goalChain`).
//   - Budgets. `budgetUsd` is a hard stop: `addSpend` refuses to record past
//     it and moves the task to `blocked` with the reason.
//   - Review gates. With `review: true`, finishing moves the task to
//     `in_review`; only `approveTask` makes it done, `rejectTask` sends it back.
//   - Activity. Every change is one line in activity.jsonl: who, what, when.
//
// Older task files (title/description/status/cron/tags only) load unchanged;
// the new fields default in `normalize`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const TASKS_DIR = path.join(os.homedir(), '.ox', 'tasks');

export const STATUSES = ['pending', 'running', 'in_review', 'blocked', 'done', 'failed', 'cancelled'];
const OPEN = new Set(['pending', 'running', 'in_review', 'blocked']);

const dirOf = (opts) => opts?.dir ?? TASKS_DIR;
const lockDir = (dir) => path.join(dir, '.locks');
const actor = (opts) => opts?.actor ?? process.env.OX_AGENT_NAME ?? os.userInfo().username ?? 'you';

function ensureTasksDir(dir = TASKS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function taskPath(id, dir = TASKS_DIR) {
  if (!/^[\w.-]+$/.test(String(id))) throw new Error(`invalid task id: ${id}`);
  return path.join(dir, `${id}.json`);
}

function normalize(t) {
  return {
    parentId: null,
    blockedBy: [],
    assignee: null,
    budgetUsd: null,
    spentUsd: 0,
    review: false,
    comments: [],
    ...t,
  };
}

function writeTask(t, dir) {
  ensureTasksDir(dir);
  const file = taskPath(t.id, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
  fs.renameSync(tmp, file); // atomic replace: a reader never sees half a task
  return t;
}

function logActivity(dir, entry) {
  try {
    ensureTasksDir(dir);
    fs.appendFileSync(path.join(dir, 'activity.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}

function listTasks(opts = {}) {
  const dir = dirOf(opts);
  ensureTasksDir(dir);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return normalize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function getTask(id, opts = {}) {
  let p;
  try {
    p = taskPath(id, dirOf(opts));
  } catch {
    return null;
  }
  if (!fs.existsSync(p)) return null;
  try {
    return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

function addTask(task, opts = {}) {
  const dir = dirOf(opts);
  const id = task.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  for (const b of task.blockedBy ?? []) if (!getTask(b, opts)) throw new Error(`blocker ${b} does not exist`);
  if (task.parentId && !getTask(task.parentId, opts)) throw new Error(`parent ${task.parentId} does not exist`);
  const full = normalize({
    id,
    title: task.title || 'Untitled',
    description: task.description || '',
    status: task.status || 'pending',
    createdAt: now,
    updatedAt: now,
    cron: task.cron || null,
    tags: task.tags || [],
    parentId: task.parentId ?? null,
    blockedBy: task.blockedBy ?? [],
    assignee: task.assignee ?? null,
    budgetUsd: task.budgetUsd ?? null,
    review: task.review === true,
  });
  writeTask(full, dir);
  logActivity(dir, { task: id, by: actor(opts), action: 'created', title: full.title });
  return full;
}

function updateTask(id, updates, opts = {}) {
  const dir = dirOf(opts);
  const existing = getTask(id, opts);
  if (!existing) return null;
  const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  writeTask(updated, dir);
  const changed = Object.keys(updates).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(updates[k]));
  if (changed.length) logActivity(dir, { task: id, by: actor(opts), action: 'updated', fields: changed });
  return updated;
}

function deleteTask(id, opts = {}) {
  const dir = dirOf(opts);
  let p;
  try {
    p = taskPath(id, dir);
  } catch {
    return false;
  }
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  try { fs.unlinkSync(path.join(lockDir(dir), `${id}.lock`)); } catch {}
  logActivity(dir, { task: id, by: actor(opts), action: 'deleted' });
  return true;
}

// ---- checkout ---------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// A claim held by a running agent names its pid and dies with it. A claim made
// from the CLI (a person, or a script) has no process to watch, so it holds for
// a lease instead and then lapses.
export const CLAIM_LEASE_MS = 4 * 60 * 60 * 1000;

function lockLive(rec) {
  if (!rec) return false;
  if (rec.pid != null) return pidAlive(rec.pid);
  return Date.now() - Date.parse(rec.at ?? 0) < (rec.leaseMs ?? CLAIM_LEASE_MS);
}

/** Who holds the task now, or null. A lapsed claim does not count. */
function taskOwner(id, opts = {}) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(lockDir(dirOf(opts)), `${id}.lock`), 'utf8'));
    return lockLive(rec) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Take the task for `owner`. Exactly one concurrent caller wins: the lock is
 * created with O_EXCL. A stale lock (its process is gone) is replaced.
 * Returns { ok, task } or { ok: false, reason, owner }.
 */
function claimTask(id, opts = {}) {
  const dir = dirOf(opts);
  const owner = opts.owner ?? actor(opts);
  // `pid: null` = a lease claim (CLI); otherwise the claim lives with the process.
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const task = getTask(id, opts);
  if (!task) return { ok: false, reason: 'not-found' };
  if (!OPEN.has(task.status) || task.status === 'in_review') return { ok: false, reason: `task is ${task.status}` };
  const blockers = openBlockers(task, opts);
  if (blockers.length) return { ok: false, reason: `blocked by ${blockers.join(', ')}` };
  const kids = openChildren(task.id, opts);
  if (kids.length) return { ok: false, reason: `a goal with ${kids.length} open task(s) under it: work on those` };
  fs.mkdirSync(lockDir(dir), { recursive: true });
  const file = path.join(lockDir(dir), `${id}.lock`);
  const body = JSON.stringify({ owner, pid, at: new Date().toISOString(), ...(pid == null ? { leaseMs: opts.leaseMs ?? CLAIM_LEASE_MS } : {}) });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createLockAtomically(file, body);
      const t = updateTask(id, { status: 'running', assignee: owner }, { ...opts, actor: owner });
      logActivity(dir, { task: id, by: owner, action: 'claimed' });
      return { ok: true, task: t };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const held = taskOwner(id, opts);
      if (held) return { ok: false, reason: `claimed by ${held.owner}`, owner: held };
      // Stale: its process is gone. Two claimers can both see it stale, and a
      // plain unlink by the slower one would delete the faster one's FRESH
      // lock. So a stale lock is only removed under a short break lock, after
      // re-checking it is still the dead one.
      if (!breakStaleLock(file)) return { ok: false, reason: 'lost the race' };
    }
  }
  return { ok: false, reason: 'lost the race' };
}

// The lock must never be visible half-written: with `wx`, the file exists for
// a moment before its body does, another claimer reads it empty, takes it for
// stale and breaks a live lock. So the full body is written to a private temp
// file and hard-linked into place; link() is atomic and fails with EEXIST if a
// lock is already there, exactly like `wx`.
function createLockAtomically(file, body) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.linkSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function breakStaleLock(file) {
  const brk = `${file}.break`;
  try {
    fs.writeFileSync(brk, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    // A breaker that died mid-break leaves this behind; it is only ever held for
    // microseconds, so one older than 5 s is abandoned.
    try {
      if (Date.now() - fs.statSync(brk).mtimeMs > 5000) fs.unlinkSync(brk);
    } catch {}
    return false;
  }
  try {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (lockLive(rec)) return false; // someone re-took it: not stale any more
    try { fs.unlinkSync(file); } catch {}
    return true;
  } finally {
    try { fs.unlinkSync(brk); } catch {}
  }
}

/** Give a claimed task back without finishing it. */
function releaseTask(id, opts = {}) {
  const dir = dirOf(opts);
  const owner = opts.owner ?? actor(opts);
  const held = taskOwner(id, opts);
  if (held && held.owner !== owner && !opts.force) return { ok: false, reason: `claimed by ${held.owner}` };
  try { fs.unlinkSync(path.join(lockDir(dir), `${id}.lock`)); } catch {}
  const t = getTask(id, opts);
  if (t?.status === 'running') updateTask(id, { status: 'pending', assignee: null }, { ...opts, actor: owner });
  logActivity(dir, { task: id, by: owner, action: 'released' });
  return { ok: true };
}

/** Finish a task: done, or in_review when the task has a review gate. */
function completeTask(id, opts = {}) {
  const dir = dirOf(opts);
  const owner = opts.owner ?? actor(opts);
  const t = getTask(id, opts);
  if (!t) return { ok: false, reason: 'not-found' };
  const held = taskOwner(id, opts);
  if (held && held.owner !== owner) return { ok: false, reason: `claimed by ${held.owner}` };
  const status = opts.failed ? 'failed' : t.review ? 'in_review' : 'done';
  const comments = opts.note ? [...t.comments, { by: owner, at: new Date().toISOString(), text: String(opts.note) }] : t.comments;
  const out = updateTask(id, { status, comments, result: opts.result ?? t.result ?? null }, { ...opts, actor: owner });
  try { fs.unlinkSync(path.join(lockDir(dir), `${id}.lock`)); } catch {}
  logActivity(dir, { task: id, by: owner, action: status === 'in_review' ? 'submitted for review' : status });
  return { ok: true, task: out };
}

function approveTask(id, opts = {}) {
  const t = getTask(id, opts);
  if (!t) return { ok: false, reason: 'not-found' };
  if (t.status !== 'in_review') return { ok: false, reason: `task is ${t.status}, not in review` };
  const by = actor(opts);
  const out = updateTask(id, { status: 'done', approvedBy: by }, opts);
  logActivity(dirOf(opts), { task: id, by, action: 'approved' });
  return { ok: true, task: out };
}

function rejectTask(id, opts = {}) {
  const t = getTask(id, opts);
  if (!t) return { ok: false, reason: 'not-found' };
  if (t.status !== 'in_review') return { ok: false, reason: `task is ${t.status}, not in review` };
  const by = actor(opts);
  const comments = opts.note ? [...t.comments, { by, at: new Date().toISOString(), text: String(opts.note) }] : t.comments;
  const out = updateTask(id, { status: 'pending', assignee: null, comments }, opts);
  logActivity(dirOf(opts), { task: id, by, action: 'changes requested', note: opts.note ?? '' });
  return { ok: true, task: out };
}

// ---- dependencies, goals, budget ---------------------------------------------

/** Open tasks directly under `id`. A goal is finished through them, not claimed. */
function openChildren(id, opts = {}) {
  return listTasks(opts).filter((t) => t.parentId === id && OPEN.has(t.status)).map((t) => t.id);
}

function openBlockers(task, opts = {}) {
  return (task.blockedBy ?? []).filter((b) => getTask(b, opts)?.status !== 'done');
}

/** Ready = pending, every blocker done, nobody holding it. */
function readyTasks(opts = {}) {
  return listTasks(opts).filter((t) => t.status === 'pending' && !openBlockers(t, opts).length
    && !openChildren(t.id, opts).length && !taskOwner(t.id, opts));
}

/** Claim the oldest ready task for `owner`; null when nothing is ready. */
function nextTask(opts = {}) {
  const owner = opts.owner ?? actor(opts);
  // A task assigned to someone else (an org agent's work) is theirs to take.
  for (const t of readyTasks(opts).filter((x) => !x.assignee || x.assignee === owner)) {
    const r = claimTask(t.id, opts);
    if (r.ok) return r.task;
  }
  return null;
}

/** The task and everything above it, nearest first (cycles cut). */
function goalChain(id, opts = {}) {
  const chain = [];
  const seen = new Set();
  let cur = getTask(id, opts);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? getTask(cur.parentId, opts) : null;
  }
  return chain;
}

/** The context an agent gets for a task: its goal ancestry, blockers and review notes. */
function taskBrief(id, opts = {}) {
  const chain = goalChain(id, opts);
  if (!chain.length) return '';
  const [t, ...up] = chain;
  const lines = [`[TASK ${t.id}] ${t.title}`];
  if (t.description) lines.push(t.description);
  if (up.length) lines.push(`Why: ${up.map((g) => g.title).join(' ← ')}`);
  if (t.budgetUsd != null) lines.push(`Budget: $${(t.budgetUsd - t.spentUsd).toFixed(2)} left of $${Number(t.budgetUsd).toFixed(2)}`);
  const notes = t.comments.slice(-3).map((c) => `- ${c.by}: ${c.text}`);
  if (notes.length) lines.push('Notes:', ...notes);
  return lines.join('\n');
}

/**
 * Record spend. Past the budget it is refused: the task is blocked with the
 * reason, and { ok: false } tells the caller to stop.
 */
function addSpend(id, usd, opts = {}) {
  const t = getTask(id, opts);
  if (!t) return { ok: false, reason: 'not-found' };
  const spent = Math.round((t.spentUsd + Math.max(0, Number(usd) || 0)) * 1e6) / 1e6;
  if (t.budgetUsd != null && spent > t.budgetUsd) {
    updateTask(id, { spentUsd: spent, status: 'blocked', blockedReason: `over budget: $${spent.toFixed(4)} of $${t.budgetUsd}` }, opts);
    logActivity(dirOf(opts), { task: id, by: actor(opts), action: 'budget stop', spentUsd: spent });
    return { ok: false, reason: 'over budget', spentUsd: spent };
  }
  updateTask(id, { spentUsd: spent }, opts);
  return { ok: true, spentUsd: spent };
}

/** Recent activity, newest last; `id` narrows it to one task. */
function taskActivity(opts = {}) {
  try {
    const lines = fs.readFileSync(path.join(dirOf(opts), 'activity.jsonl'), 'utf8').split('\n').filter(Boolean);
    const all = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const mine = opts.id ? all.filter((e) => e.task === opts.id) : all;
    return mine.slice(-(opts.limit ?? 50));
  } catch {
    return [];
  }
}

function runTask(id, opts = {}) {
  const task = getTask(id, opts);
  if (!task) return { success: false, error: 'Task not found' };
  const claim = claimTask(id, { ...opts, owner: opts.owner ?? 'ox-run' });
  if (!claim.ok) return { success: false, error: claim.reason };
  const brief = taskBrief(id, opts);

  return new Promise((resolve) => {
    const args = ['-p', [brief, opts.prompt].filter(Boolean).join('\n\n')];
    execFile(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js'), ...args],
      // OX_TASK_ID offers the run its task_board tool (src/tools/task-board.js).
      { timeout: 300000, cwd: opts.cwd ?? process.cwd(), env: { ...process.env, OX_TASK_ID: id, OX_AGENT_NAME: 'ox-run' } }, (error, stdout, stderr) => {
        if (error) {
          completeTask(id, { ...opts, owner: 'ox-run', failed: true, note: error.message.slice(0, 300) });
          resolve({ success: false, error: error.message, stdout, stderr });
        } else {
          completeTask(id, { ...opts, owner: 'ox-run', result: stdout.slice(-2000) });
          resolve({ success: true, stdout, stderr });
        }
      });
  });
}

export {
  TASKS_DIR,
  ensureTasksDir,
  listTasks,
  getTask,
  addTask,
  updateTask,
  deleteTask,
  runTask,
  claimTask,
  releaseTask,
  completeTask,
  approveTask,
  rejectTask,
  taskOwner,
  readyTasks,
  nextTask,
  goalChain,
  taskBrief,
  addSpend,
  taskActivity,
};
