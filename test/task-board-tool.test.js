// The agent's side of the task board: offered only to a run started for a
// task, and every action works on that task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTask, claimTask, getTask, listTasks } from '../src/tasks.js';
import { taskBoardTool } from '../src/tools/task-board.js';
import { listToolSchemas, narrowToolSchemas } from '../src/tools/index.js';

const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-board-tool-'));

test('offered only when the run was started for a task', () => {
  const saved = process.env.OX_TASK_ID;
  delete process.env.OX_TASK_ID;
  try {
    assert.equal(listToolSchemas({}).some((s) => s.name === 'task_board'), false);
    assert.equal(listToolSchemas({ taskId: 'task_1_x' }).some((s) => s.name === 'task_board'), true);
  } finally {
    if (saved !== undefined) process.env.OX_TASK_ID = saved;
  }
});

test('narrowing never drops the task_board of a task run', () => {
  const all = listToolSchemas({ taskId: 'task_1_x' });
  const narrowed = narrowToolSchemas(all, { message: 'fix the flaky login test' });
  assert.ok(narrowed.some((s) => s.name === 'task_board'));
});

test('brief, note, add, done (with review) and next work on the run\'s own task', async () => {
  const dir = fresh();
  const goal = addTask({ title: 'Ship v1' }, { dir });
  const mine = addTask({ title: 'Add signup email', parentId: goal.id, review: true }, { dir });
  const later = addTask({ title: 'Write release notes', parentId: goal.id }, { dir });
  claimTask(mine.id, { dir, owner: 'ox-run' });
  const ctx = { taskId: mine.id, taskDir: dir, agentName: 'ox-run' };

  assert.match((await taskBoardTool({ action: 'brief' }, ctx)).content, /Why: Ship v1/);
  assert.match((await taskBoardTool({ action: 'next' }, ctx)).content, /finish your own task first/);
  assert.equal((await taskBoardTool({ action: 'note', text: 'template done' }, ctx)).content, 'noted');
  const filed = (await taskBoardTool({ action: 'add', text: 'Rate-limit signup' }, ctx)).content;
  assert.match(filed, /^filed task_/);
  assert.equal(listTasks({ dir }).find((t) => t.title === 'Rate-limit signup').parentId, mine.id);
  assert.equal((await taskBoardTool({ action: 'done', text: 'emails send on signup' }, ctx)).content, 'submitted for review');
  assert.equal(getTask(mine.id, { dir }).status, 'in_review');

  // `next` hands over the OLDEST ready task (release notes, filed first) and
  // re-points the run at it.
  const next = (await taskBoardTool({ action: 'next' }, ctx)).content;
  assert.match(next, /Write release notes/);
  assert.equal(ctx.taskId, later.id);
  assert.equal(getTask(later.id, { dir }).status, 'running');
  assert.equal(listTasks({ dir }).find((t) => t.title === 'Rate-limit signup').status, 'pending', 'still waiting for someone');
});

test('worker lifecycle actions expose Hermes-style handoffs safely', async () => {
  const dir = fresh();
  const task = addTask({ title: 'lane work' }, { dir });
  claimTask(task.id, { dir, owner: 'ox-run' });
  const ctx = { taskId: task.id, taskDir: dir, agentName: 'ox-run' };
  assert.equal((await taskBoardTool({ action: 'comment', text: 'ready for review' }, ctx)).content, 'commented');
  assert.match((await taskBoardTool({ action: 'heartbeat' }, ctx)).content, /^heartbeat /);
  assert.equal((await taskBoardTool({ action: 'link', url: 'https://example.com/artifact', label: 'artifact' }, ctx)).content, 'linked https://example.com/artifact');
  assert.equal((await taskBoardTool({ action: 'block', text: 'waiting on input' }, ctx)).content, 'blocked; the task is available for an operator to unblock');
  assert.equal((await taskBoardTool({ action: 'unblock' }, ctx)).content, 'unblocked; task returned to ready queue');
  const after = getTask(task.id, { dir });
  assert.equal(after.status, 'pending');
  assert.equal(after.links[0].label, 'artifact');
});

test('a run without a task gets a clear error, not a crash', async () => {
  const saved = process.env.OX_TASK_ID;
  delete process.env.OX_TASK_ID;
  try {
    const r = await taskBoardTool({ action: 'brief' }, {});
    assert.equal(r.isError, true);
    assert.match(r.content, /not started for a task/);
  } finally {
    if (saved !== undefined) process.env.OX_TASK_ID = saved;
  }
});
