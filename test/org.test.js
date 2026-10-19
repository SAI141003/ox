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

test('hire from a sentence: schedule, budget, runtime, approval, folder read from the words', async () => {
  const p = O.parseHire('someone called Rex who reviews my pull requests every morning on claude code, read only, $15 a month, in ~/ox');
  assert.equal(p.name, 'Rex');
  assert.equal(p.heartbeatMin, 1440);
  assert.equal(p.budgetUsd, 15);
  assert.equal(p.runtime, 'claude-plan');
  assert.equal(p.approval, 'read');
  assert.match(p.cwd, /\/ox$/);
  assert.equal(p.title, 'Reviewer');
  assert.equal(O.parseHire('watch the build every 2 hours').heartbeatMin, 120);
  // A model fills name, title and instructions; the words' facts stay.
  const d = await O.draftHire('fix failing tests every 30 minutes, $5 a month', { ask: async () => '{"name":"Tess","title":"Test Fixer","instructions":"Run the tests.\nFix what fails."}' });
  assert.equal(d.name, 'Tess');
  assert.equal(d.title, 'Test Fixer');
  assert.equal(d.heartbeatMin, 30);
  assert.equal(d.budgetUsd, 5);
  assert.equal(d.fromModel, true);
  const bad = await O.draftHire('fix failing tests every 30 minutes and more', { ask: async () => 'not json' });
  assert.equal(bad.fromModel, false);
  assert.equal(bad.name, 'QA', 'no model: named from the title the words suggest');
});

test('tell, thread and timeline: work in words, every run kept, irreversible actions counted', async () => {
  const o = fresh();
  O.hire({ name: 'Ada', title: 'Engineer' }, o);
  const { task } = await O.tell('ada', 'Rename the helper', o);
  assert.equal(task.assignee, 'ada');
  const r = await O.beat('ada', { ...o, run: async () => ({ ok: true, output: 'renamed it', costUsd: 0.01 }) });
  assert.equal(r.state, 'ran');
  const th = O.thread('ada', o);
  assert.equal(th.runs.length, 1);
  assert.equal(th.runs[0].said, 'renamed it');
  const audit = path.join(path.dirname(o.file), 'audit.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(audit, [
    { ts: now, ref: 'a', tool: 'exec', detail: 'git push origin main', decision: 'allow', agent: 'ada' },
    { ts: now, ref: 'a', t: 'outcome', ok: true },
    { ts: now, ref: 'b', tool: 'exec', detail: 'rm -rf build', decision: 'deny', agent: 'ada' },
    { ts: now, ref: 'c', tool: 'read_file', detail: 'a.js', decision: 'allow', agent: 'ada' },
    { ts: now, ref: 'd', tool: 'exec', detail: 'git push', decision: 'allow' },
  ].map((x) => JSON.stringify(x)).join('\n'));
  const t = O.timeline({ ...o, auditFile: audit });
  assert.equal(t.irreversible, 1, 'the push went through; the denied rm did not; a call by no agent is not counted');
  assert.equal(t.denied, 1);
  assert.ok(t.items.some((x) => /you asked ada: Rename the helper/.test(x.text)));
  assert.ok(t.items.some((x) => /ada finished ada/.test(x.text)));
  assert.equal(O.isIrreversible('mail_send'), true);
  assert.equal(O.isIrreversible('exec', 'git status'), false);
});

test('hire from a sentence: weekdays are weekly, and "every Friday" is not "every N days"', () => {
  assert.equal(O.parseHire('writes release notes every Friday').heartbeatMin, 10080);
  assert.equal(O.parseHire('checks dependencies on Mondays').heartbeatMin, 10080);
  assert.equal(O.parseHire('every fifteen minutes check the queue').heartbeatMin, 15);
  assert.equal(O.parseHire('every day at 9 summarize').heartbeatMin, 1440);
});

test('a team from one sentence: the chief drafts it, it is hired, and its group chat answers in turn', async () => {
  const o = fresh();
  const draft = await O.draftTeam('a writer who drafts blog posts and a coder who writes and reviews code', {
    ask: async () => '{"team":"Content & Code","agents":[{"name":"Wren","title":"Writer","instructions":"Draft posts"},{"name":"Cody","title":"Coder","instructions":"Write and review code"}]}',
  });
  assert.deepEqual(draft.agents.map((a) => a.name), ['Wren', 'Cody']);
  const t = O.hireTeam(draft, o);
  assert.equal(t.group, 'content-code');
  assert.deepEqual(t.members, ['wren', 'cody']);
  assert.match(O.group('content-code', o).messages[0].text, /Team's up: Wren \(Writer\), Cody \(Coder\)/);
  const seen = [];
  const replies = await O.groupSay('content-code', 'Write a post about ox mesh', { ...o, ask: async ({ system, user }) => { seen.push(user); return system.includes('Cody') ? '(pass)' : 'I will draft it today.'; } });
  assert.deepEqual(replies, [{ from: 'Wren', text: 'I will draft it today.' }]);
  assert.match(seen[1], /Wren: I will draft it today\./, 'the second member sees the first one\'s reply');
  assert.equal(O.group('content-code', o).messages.length, 3);
  await assert.rejects(O.draftTeam('x', { ask: async () => '{"agents":[{"name":"A","title":"B"}]}' }), /could not make a team/);
});
