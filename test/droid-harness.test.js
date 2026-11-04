// Droid (Factory) through ox: its documented `exec -o json` result gives the answer,
// the tokens and the session. Shape from docs.factory.com/cli/droid-exec/overview;
// no real droid is run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../src/subscriptions.js';

const blank = () => ({ text: '', tools: new Map(), done: false, error: null, usage: null });

test('a result gives the answer as text, the tokens, and what came from cache', () => {
  const st = blank();
  const ev = parseLine('droid-json', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done it', session_id: 's1', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, factory_credits: 1 } }), st);
  assert.deepEqual(ev, [{ type: 'text-delta', text: 'done it' }]);
  assert.equal(st.text, 'done it');
  assert.deepEqual(st.usage, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 });
});

test('a failed run is reported, and anything else on the line is ignored', () => {
  const st = blank();
  assert.deepEqual(parseLine('droid-json', JSON.stringify({ type: 'result', is_error: true, result: 'not signed in' }), st), []);
  assert.equal(st.error, 'not signed in');
  assert.deepEqual(parseLine('droid-json', 'not json', blank()), []);
  assert.deepEqual(parseLine('droid-json', JSON.stringify({ type: 'system' }), blank()), []);
});
