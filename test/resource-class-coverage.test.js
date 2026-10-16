// Every tool ox offers a model must have a resource class: `unknown` is refused
// by the agent loop even for a single call, so an unclassified tool is a tool
// that can never run. Happened twice (todo_write; then 15 of 25 tools, including
// web_search and show_ui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_IMPLS, BUILTIN_SCHEMAS } from '../src/tools/index.js';
import { classifyTool, batchPlan } from '../src/resource-class.js';

test('no registered or offered tool is left unknown', () => {
  const names = [...new Set([...Object.keys(TOOL_IMPLS), ...BUILTIN_SCHEMAS.map((s) => s.name)])];
  assert.ok(names.length >= 20, `expected the full tool set, got ${names.length}`);
  const unknown = names.filter((n) => classifyTool(n) === 'unknown');
  assert.deepEqual(unknown, [], `unclassified tools: ${unknown.join(', ')}`);
});

test('web search and show_ui run alone and side by side with reads', () => {
  for (const calls of [['web_search'], ['show_ui'], ['web_search', 'web_fetch', 'read_file']]) {
    const plan = batchPlan(calls.map((name) => ({ function: { name } })));
    assert.notEqual(plan.mode, 'reject', calls.join('+'));
    assert.ok(plan.groups.every((g) => g.class !== 'unknown'), calls.join('+'));
  }
  // Acting on the computer still runs one at a time.
  assert.equal(batchPlan([{ function: { name: 'type_text' } }, { function: { name: 'open_app' } }]).mode, 'reject');
});
