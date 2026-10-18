// The company layer (src/org.js): org chart, hiring with approval, pause and
// budgets per agent, and heartbeats that pick up assigned work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as O from '../src/org.js';
import { addTask, getTask, updateTask } from '../src/tasks.js';

const fresh = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-org-'));
  return { file: path.join(d, 'org.json'), tasks: { dir: path.join(d, 'tasks') }, usageFile: path.join(d, 'usage.jsonl') };
};

test('org chart: managers above their reports, budgets and states shown', () => {
  const o = fresh();
  O.hire({ name: 'Ada', title: 'CTO', runtime: 'claude-plan', budgetUsd: 50 }, o);
  O.hire({ name: 'Bo', title: 'Engineer', reportsTo: 'ada' }, o);
  O.hire({ name: 'Cy', title: 'Engineer', reportsTo: 'ada' }, o);
  O.pause('cy', o);
  const lines = O.chart(o);
  assert.equal(lines[0], 'you');
  assert.match(lines[1], /^└─ Ada — CTO \[claude-plan\] · \$0\.00\/\$50$/);
  assert.match(lines[2], /^   ├─ Bo — Engineer \[ox\]$/);
  assert.match(lines[3], /^   └─ Cy — Engineer \[ox\] · paused/);
});

test('no reporting to someone missing, no loops, no duplicate hires', () => {
  const o = fresh();
  O.hire({ name: 'Ada' }, o);
  O.hire({ name: 'Bo', reportsTo: 'ada' }, o);
  assert.throws(() => O.hire({ name: 'Zed', reportsTo: 'nobody' }, o), /no agent nobody/);
  assert.throws(() => O.update('ada', { reportsTo: 'bo' }, o), /cannot report/);
  assert.throws(() => O.hire({ name: 'Ada' }, o), /already works here/);
});

test('governance: an agent only proposes a hire; only you approve it', () => {
  const o = fresh();
  O.hire({ name: 'Ada', title: 'CTO' }, o);
  const p = O.hire({ name: 'Eve', reportsTo: 'ada' }, { ...o, by: 'ada' });
  assert.equal(p.status, 'proposed');
  assert.throws(() => O.approveHire('eve', { ...o, by: 'ada' }), /only you/);
  assert.equal(O.approveHire('eve', o).status, 'active');
  assert.ok(O.readOrg(o).log.some((e) => e.action === 'proposed hire' && e.by === 'ada'));
});

test('budget: a warning at 80 %, a pause at the budget, resume refused until raised', () => {
  const o = fresh();
  O.hire({ name: 'Ada', budgetUsd: 10 }, o);
  assert.deepEqual([O.chargeAgent('ada', 7, o).warned, O.chargeAgent('ada', 1.5, o).warned], [false, true]);
  const stop = O.chargeAgent('ada', 2, o);
  assert.equal(stop.stopped, true);
  assert.equal(O.readOrg(o).agents.ada.status, 'paused');
  assert.throws(() => O.resume('ada', o), /over this month's budget/);
  O.update('ada', { budgetUsd: 20 }, o);
  assert.equal(O.resume('ada', o).status, 'active');
});

test('heartbeat: takes only its own ready task, runs it, records result and cost', async () => {
  const o = fresh();
  O.hire({ name: 'Bo', title: 'Engineer', budgetUsd: 5, instructions: 'Write tests first.' }, o);
  const goal = addTask({ title: 'Ship v2' }, o.tasks);
  const mine = addTask({ title: 'Fix login', parentId: goal.id }, o.tasks);
  updateTask(mine.id, { assignee: 'bo' }, o.tasks);
  const other = addTask({ title: 'Not mine' }, o.tasks);
  let prompt = '';
  const run = async (agent, task, p) => { prompt = p; return { ok: true, output: 'fixed it', costUsd: 0.25 }; };
  const r = await O.beat('bo', { ...o, run });
  assert.equal(r.state, 'ran');
  assert.equal(r.task, mine.id);
  assert.match(prompt, /You are Bo, Engineer\. You report to the owner\./);
  assert.match(prompt, /Write tests first\./);
  assert.match(prompt, /Why: Ship v2/);
  assert.equal(getTask(mine.id, o.tasks).status, 'done');
  assert.equal(getTask(mine.id, o.tasks).spentUsd, 0.25);
  assert.equal(getTask(other.id, o.tasks).status, 'pending');
  assert.equal(O.spentThisMonth(O.readOrg(o).agents.bo), 0.25);
  assert.equal((await O.beat('bo', { ...o, run })).state, 'idle');
});

test('heartbeat: a paused agent is not woken; a failed run fails the task with the reason', async () => {
  const o = fresh();
  O.hire({ name: 'Bo' }, o);
  const t = addTask({ title: 'x' }, o.tasks);
  updateTask(t.id, { assignee: 'bo' }, o.tasks);
  O.pause('bo', o);
  assert.equal((await O.beat('bo', { ...o, run: async () => assert.fail('woke') })).state, 'skipped');
  O.resume('bo', o);
  const r = await O.beat('bo', { ...o, run: async () => ({ ok: false, output: '', error: 'not signed in' }) });
  assert.equal(r.ok, false);
  assert.equal(getTask(t.id, o.tasks).status, 'failed');
  assert.match(getTask(t.id, o.tasks).comments.at(-1).text, /not signed in/);
});

test('due agents: an interval passed, active only; cost read from the usage log when the run gives none', async () => {
  const o = fresh();
  O.hire({ name: 'Bo', heartbeatMin: 10 }, o);
  O.hire({ name: 'Cy' }, o);
  assert.deepEqual(O.dueAgents(o).map((a) => a.id), ['bo']);
  const t = addTask({ title: 'y' }, o.tasks);
  updateTask(t.id, { assignee: 'bo' }, o.tasks);
  const run = async () => { fs.appendFileSync(o.usageFile, JSON.stringify({ at: Date.now(), agent: 'bo', cost: 0.1, in: 1, out: 1 }) + '\n'); return { ok: true, output: 'ok' }; };
  const [r] = await O.beatDue({ ...o, run });
  assert.equal(r.costUsd, 0.1);
  assert.deepEqual(O.dueAgents(o).map((a) => a.id), []);
  assert.deepEqual(O.dueAgents({ ...o, now: Date.now() + 11 * 60_000 }).map((a) => a.id), ['bo']);
});

test('approval level: edits by default, read or all only when set, anything else refused', () => {
  const o = fresh();
  assert.equal(O.hire({ name: 'Bo' }, o).approval, 'edits');
  assert.equal(O.hire({ name: 'Cy', approval: 'read' }, o).approval, 'read');
  assert.throws(() => O.update('bo', { approval: 'root' }, o), /read, edits or all/);
  assert.equal(O.update('bo', { approval: 'all' }, o).approval, 'all');
  assert.match(O.chart(o).join('\n'), /Bo — Agent \[ox\] · no approvals/);
});
