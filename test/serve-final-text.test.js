// A provider that reports its answer only at the end (no text deltas, e.g. a
// local model after a tool call) must still reach the chat: the agent's `final`
// event carries a message object, not a string. Found by a real run on
// qwen2.5:3b through the app: 518 tokens generated, an empty reply shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalText } from '../src/serve.js';

test('final as a message object, as a string, as content parts; never twice', () => {
  assert.equal(finalText({ type: 'final', message: { role: 'assistant', content: 'the answer' } }, ''), 'the answer');
  assert.equal(finalText({ type: 'final', message: 'plain' }, ''), 'plain');
  assert.equal(finalText({ type: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, ''), 'ab');
  assert.equal(finalText({ type: 'final', message: { role: 'assistant', content: 'x' } }, 'already streamed'), '');
  assert.equal(finalText({ type: 'usage' }, ''), '');
});
