// System 1 (Laya): off in tests and when not installed, so routing falls back
// to the word lists; its answers are read strictly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTurn, system1Enabled, decide, TURN_QUESTIONS } from '../src/system1.js';

test('off under the test runner and when switched off; decide() gives null', async () => {
  assert.equal(system1Enabled({ NODE_TEST_CONTEXT: 'child' }), false);
  assert.equal(system1Enabled({ OX_SYSTEM1: '0' }), false);
  assert.equal(await decide('hi', TURN_QUESTIONS), null);
});

test('reads a choice and a yes-no answer, nothing else', () => {
  assert.deepEqual(readTurn({ kind: { choice: 'current', confidence: 0.91 }, plan: { noul: 0.12 } }), { kind: 'current', confidence: 0.91, plan: 0.12 });
  assert.deepEqual(readTurn({ kind: { choice: 'chat', probs: { chat: 0.8 } } }), { kind: 'chat', confidence: 0.8, plan: null });
  assert.equal(readTurn({ kind: { choice: 'launch-missiles' } }), null);
  assert.equal(readTurn({}), null);
  assert.equal(readTurn(null), null);
});
