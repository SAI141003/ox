// The Office's board: a run's own events say what it is doing; helpers sit
// beside their lead; finished runs leave after a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRun, onEvent, endRun, liveBoard, boardBroadcaster } from '../src/live-board.js';

test('a run shows the tool it is using, its helpers, and leaves when done', () => {
  const id = startRun({ who: 'scout', title: 'list the files' });
  const send = boardBroadcaster(id);
  const mine = () => liveBoard().runs.filter((r) => r.id === id || r.parent === id);
  assert.equal(mine()[0].state, 'thinking');
  send({ type: 'tool-start', name: 'list_dir', argsPreview: '{"path":"."}' });
  assert.deepEqual([mine()[0].state, mine()[0].tool, mine()[0].steps], ['tool', 'list_dir', 1]);
  send({ type: 'subagent-start', id: 's1', model: 'qwen', description: 'read README' });
  send({ type: 'subagent-progress', id: 's1', currentTool: 'read_file', currentToolArgsPreview: 'README.md' });
  const helper = mine().find((r) => r.parent === id);
  assert.equal(helper.tool, 'read_file');
  assert.equal(helper.title, 'read README');
  send({ type: 'tool-end' });
  send({ type: 'text-delta', text: 'Here' });
  assert.equal(mine()[0].state, 'writing');
  endRun(id);
  assert.ok(mine().every((r) => r.state === 'done'));
  assert.equal(liveBoard(Date.now() + 60_000).runs.some((r) => r.id === id), false);
});

test('a stopped run says why', () => {
  const id = startRun({ who: 'x', title: 't' });
  onEvent(id, { type: 'error', error: 'Missing API key' });
  endRun(id, { failed: true });
  const r = liveBoard().runs.find((x) => x.id === id);
  assert.equal(r.state, 'failed');
  assert.match(r.detail, /Missing API key/);
});
