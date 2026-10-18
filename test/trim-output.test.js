// Query-aware trimming of long tool output (src/trim-output.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimForQuery } from '../src/trim-output.js';

const log = (n, special = {}) => Array.from({ length: n }, (_, i) => special[i] ?? `info: step ${i} finished in 3ms`).join('\n');

test('short output is left alone', () => {
  assert.deepEqual(trimForQuery('a\nb', 'x'), { text: 'a\nb', trimmed: false, kept: null, total: null });
});

test('errors deep in a long log survive, with context; cuts are said', () => {
  const r = trimForQuery(log(4000, { 3100: 'TypeError: x is not a function', 3101: '    at run (src/a.js:4:9)' }), 'run the tests', { budget: 4000 });
  assert.equal(r.trimmed, true);
  assert.match(r.text, /TypeError: x is not a function\n {4}at run \(src\/a\.js:4:9\)/);
  assert.match(r.text, /… \d+ lines cut …/);
  assert.ok(r.text.length < 5500);
  assert.match(r.text, /^info: step 0 /, 'the head is kept');
  assert.match(r.text, /step 3999 finished/, 'and the tail');
});

test('lines matching the request are kept over plain noise', () => {
  const r = trimForQuery(log(4000, { 1500: 'redis connected on 6379' }), 'is redis connected?', { budget: 3000 });
  assert.match(r.text, /redis connected on 6379/);
});
