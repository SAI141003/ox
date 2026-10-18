// The task board (src/tasks.js): atomic checkout, blockers, goal ancestry,
// budget stops, review gates and the activity log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addTask, getTask, claimTask, releaseTask, completeTask, approveTask, rejectTask,
  nextTask, readyTasks, goalChain, taskBrief, addSpend, taskActivity, taskOwner, listTasks,
} from '../src/tasks.js';

const fresh = () => ({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-board-')), actor: 'tester' });

test('one owner per task: a second claimer is refused and told who holds it', () => {
  const o = fresh();
  const t = addTask({ title: 'fix login' }, o);
  assert.equal(claimTask(t.id, { ...o, owner: 'mira' }).ok, true);
  const second = claimTask(t.id, { ...o, owner: 'theo' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /claimed by mira/);
  assert.equal(getTask(t.id, o).assignee, 'mira');
  assert.equal(getTask(t.id, o).status, 'running');
});

async function race(o, t) {
  const mod = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tasks.js');
  // Every process waits at a start line (the "go" file), claims at once, and
  // stays alive until all have answered, so no lock is ever legitimately stale.
  const go = path.join(o.dir, 'go');
  const done = path.join(o.dir, 'done');
  const code = `import(${JSON.stringify(mod)}).then(async m=>{const fs=await import('node:fs');
    while(!fs.existsSync(${JSON.stringify(go)}))await new Promise(r=>setTimeout(r,5));
    const r=m.claimTask(${JSON.stringify(t.id)},{dir:${JSON.stringify(o.dir)},owner:'p'+process.pid});
    process.stdout.write(r.ok?'WIN':'LOSE');
    while(!fs.existsSync(${JSON.stringify(done)}))await new Promise(r=>setTimeout(r,20));})`;
  const answers = [];
  const procs = Array.from({ length: 8 }, () => {
    const p = spawn(process.execPath, ['-e', code]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out === 'WIN' || out === 'LOSE') answers.push(out); });
    return new Promise((resolve) => p.on('close', resolve));
  });
  await new Promise((r) => setTimeout(r, 1500)); // let them all reach the start line
  fs.writeFileSync(go, '');
  while (answers.length < 8) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(done, '');
  await Promise.all(procs);
  return answers;
}

test('a race between real processes has exactly one winner', async () => {
  const o = fresh();
  const t = addTask({ title: 'contended' }, o);
  const answers = await race(o, t);
  assert.equal(answers.filter((r) => r === 'WIN').length, 1, `results: ${answers.join(',')}`);
});

test('racing over a STALE lock still has exactly one winner', async () => {
  const o = fresh();
  const t = addTask({ title: 'orphan, contended' }, o);
  fs.mkdirSync(path.join(o.dir, '.locks'), { recursive: true });
  fs.writeFileSync(path.join(o.dir, '.locks', `${t.id}.lock`), JSON.stringify({ owner: 'ghost', pid: 999999 }));
  const answers = await race(o, t);
  assert.equal(answers.filter((r) => r === 'WIN').length, 1, `results: ${answers.join(',')}`);
});

test('a lock left by a dead process is stale and can be taken over', () => {
  const o = fresh();
  const t = addTask({ title: 'orphaned' }, o);
  fs.mkdirSync(path.join(o.dir, '.locks'), { recursive: true });
  fs.writeFileSync(path.join(o.dir, '.locks', `${t.id}.lock`), JSON.stringify({ owner: 'ghost', pid: 999999 }));
  assert.equal(taskOwner(t.id, o), null);
  assert.equal(claimTask(t.id, { ...o, owner: 'lin' }).ok, true);
});

test('blockers: a task is not ready or claimable until its blockers are done', () => {
  const o = fresh();
  const design = addTask({ title: 'design' }, o);
  const build = addTask({ title: 'build', blockedBy: [design.id] }, o);
  assert.deepEqual(readyTasks(o).map((t) => t.title), ['design']);
  assert.match(claimTask(build.id, o).reason, /blocked by/);
  assert.equal(nextTask({ ...o, owner: 'ade' }).id, design.id);
  completeTask(design.id, { ...o, owner: 'ade' });
  assert.equal(nextTask({ ...o, owner: 'ade' }).id, build.id);
  assert.equal(nextTask({ ...o, owner: 'ade' }), null, 'nothing else ready');
  assert.throws(() => addTask({ title: 'x', blockedBy: ['task_missing'] }, o), /does not exist/);
});

test('goal ancestry reaches the agent as the "why"', () => {
  const o = fresh();
  const goal = addTask({ title: 'Ship v1 to 100 users' }, o);
  const epic = addTask({ title: 'Onboarding', parentId: goal.id }, o);
  const task = addTask({ title: 'Add signup email', parentId: epic.id, budgetUsd: 2 }, o);
  assert.deepEqual(goalChain(task.id, o).map((t) => t.title), ['Add signup email', 'Onboarding', 'Ship v1 to 100 users']);
  const brief = taskBrief(task.id, o);
  assert.match(brief, /Why: Onboarding ← Ship v1 to 100 users/);
  assert.match(brief, /Budget: \$2\.00 left of \$2\.00/);
});

test('budget is a hard stop: spend past it is refused and the task blocks', () => {
  const o = fresh();
  const t = addTask({ title: 'research', budgetUsd: 0.5 }, o);
  assert.equal(addSpend(t.id, 0.3, o).ok, true);
  const over = addSpend(t.id, 0.3, o);
  assert.equal(over.ok, false);
  const after = getTask(t.id, o);
  assert.equal(after.status, 'blocked');
  assert.match(after.blockedReason, /over budget/);
});

test('review gate: finishing goes to review; only approval makes it done', () => {
  const o = fresh();
  const t = addTask({ title: 'refactor auth', review: true }, o);
  claimTask(t.id, { ...o, owner: 'rui' });
  assert.equal(completeTask(t.id, { ...o, owner: 'rui', note: 'done, tests green' }).task.status, 'in_review');
  assert.equal(rejectTask(t.id, { ...o, note: 'add a test for expiry' }).task.status, 'pending');
  claimTask(t.id, { ...o, owner: 'rui' });
  completeTask(t.id, { ...o, owner: 'rui' });
  assert.equal(approveTask(t.id, o).task.status, 'done');
  assert.equal(approveTask(t.id, o).ok, false, 'cannot approve twice');
  assert.deepEqual(getTask(t.id, o).comments.map((c) => c.text), ['done, tests green', 'add a test for expiry']);
});

test('only the owner can finish or release; every step is in the activity log', () => {
  const o = fresh();
  const t = addTask({ title: 'deploy' }, o);
  claimTask(t.id, { ...o, owner: 'sol' });
  assert.match(completeTask(t.id, { ...o, owner: 'theo' }).reason, /claimed by sol/);
  assert.match(releaseTask(t.id, { ...o, owner: 'theo' }).reason, /claimed by sol/);
  assert.equal(releaseTask(t.id, { ...o, owner: 'sol' }).ok, true);
  assert.equal(getTask(t.id, o).status, 'pending');
  assert.deepEqual(taskActivity({ ...o, id: t.id }).map((e) => e.action), ['created', 'updated', 'claimed', 'updated', 'released']);
});

test('old task files without the new fields still load', () => {
  const o = fresh();
  fs.writeFileSync(path.join(o.dir, 'task_1_old.json'), JSON.stringify({ id: 'task_1_old', title: 'legacy', status: 'pending', createdAt: '2026-01-01' }));
  const [t] = listTasks(o);
  assert.deepEqual([t.title, t.blockedBy, t.spentUsd, t.review], ['legacy', [], 0, false]);
  assert.equal(claimTask('task_1_old', o).ok, true);
});

test('a goal is not handed out while tasks under it are open', () => {
  const o = fresh();
  const goal = addTask({ title: 'Ship v1' }, o);
  const step = addTask({ title: 'Write docs', parentId: goal.id }, o);
  assert.match(claimTask(goal.id, o).reason, /goal with 1 open task/);
  assert.equal(nextTask({ ...o, owner: 'mira' }).id, step.id);
  completeTask(step.id, { ...o, owner: 'mira' });
  assert.equal(claimTask(goal.id, o).ok, true, 'claimable once its tasks are done');
});

test('a CLI claim (no process) holds for its lease, then lapses', () => {
  const o = fresh();
  const t = addTask({ title: 'manual work' }, o);
  assert.equal(claimTask(t.id, { ...o, owner: 'theo', pid: null }).ok, true);
  assert.match(claimTask(t.id, { ...o, owner: 'mira', pid: null }).reason, /claimed by theo/);
  assert.match(completeTask(t.id, { ...o, owner: 'mira' }).reason, /claimed by theo/);
  // Age the lease past its limit: the claim lapses and someone else may take it.
  const lock = path.join(o.dir, '.locks', `${t.id}.lock`);
  const rec = JSON.parse(fs.readFileSync(lock, 'utf8'));
  fs.writeFileSync(lock, JSON.stringify({ ...rec, at: new Date(Date.now() - rec.leaseMs - 1000).toISOString() }));
  assert.equal(taskOwner(t.id, o), null);
  assert.equal(claimTask(t.id, { ...o, owner: 'mira', pid: null }).ok, true);
});

// Windows refuses a rename onto a file another process holds open (EPERM,
// EBUSY). The write waits for the holder to let go instead of failing.
test('a task write retries a rename refused because the file is held', (t) => {
  const o = fresh();
  const task = addTask({ title: 'held' }, o);
  const real = fs.renameSync;
  let refusals = 0;
  t.after(() => { fs.renameSync = real; });
  fs.renameSync = (from, to) => {
    if (refusals < 2) { refusals++; throw Object.assign(new Error('held'), { code: refusals === 1 ? 'EPERM' : 'EBUSY' }); }
    return real(from, to);
  };
  assert.equal(claimTask(task.id, { ...o, owner: 'mira' }).ok, true);
  assert.equal(refusals, 2);
  assert.equal(getTask(task.id, o).assignee, 'mira');
});

test('a task write that cannot rename throws and leaves no temp file behind', (t) => {
  const o = fresh();
  const task = addTask({ title: 'stuck' }, o);
  const real = fs.renameSync;
  t.after(() => { fs.renameSync = real; });
  fs.renameSync = () => { throw Object.assign(new Error('nope'), { code: 'ENOSPC' }); };
  assert.throws(() => claimTask(task.id, { ...o, owner: 'mira' }), /nope/);
  fs.renameSync = real;
  assert.deepEqual(fs.readdirSync(o.dir).filter((f) => f.endsWith('.tmp')), []);
});
