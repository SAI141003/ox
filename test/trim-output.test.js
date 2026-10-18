import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offloadLarge, relevantLines, OFFLOAD_OVER } from '../src/tools/index.js';

const log = (n = 1500, at = 733) => {
  const lines = Array.from({ length: n }, (_, i) => `ok ${i} - suite/test case number ${i} passes and prints some noise here`);
  lines.splice(at, 0, 'not ok 733 - movingAverage returns the mean of the window', '  AssertionError: expected 2.5 but got 3', '    at Object.<anonymous> (/repo/src/stats.js:41:9)');
  return lines.join('\n');
};

test('a long log keeps the failure buried in its middle, in fewer characters than start + end', () => {
  const text = log();
  assert.ok(text.length > OFFLOAD_OVER);
  const oldWay = text.slice(0, 4000) + text.slice(-1500);
  assert.equal(/expected 2\.5/.test(oldWay), false, 'the start and end alone miss it');
  const r = offloadLarge('bash', { content: text }, { taskText: 'fix the failing movingAverage test' });
  assert.match(r.content, /734\| not ok 733 - movingAverage/);
  assert.match(r.content, /AssertionError: expected 2\.5 but got 3/);
  assert.match(r.content, /stats\.js:41:9/);
  assert.ok(r.content.length < oldWay.length, `${r.content.length} < ${oldWay.length}`);
  assert.ok(r.meta.offloaded.file, 'the whole output is kept on disk');
});

test('lines are kept exactly, numbered, with what was left out said', () => {
  const r = relevantLines(log(), 'movingAverage');
  assert.match(r.text, /^\s+1\| ok 0 /m, 'the start');
  assert.match(r.text, /… \(\d+ lines left out\)/);
  assert.match(r.text, /1503\| ok 1499 /, 'the end');
});

test('nothing stands out: plain start and end, as before', () => {
  const quiet = Array.from({ length: 2000 }, (_, i) => `row ${i} value ${i * 2}`).join('\n');
  assert.equal(relevantLines(quiet, ''), null);
  const r = offloadLarge('bash', { content: quiet }, {});
  assert.match(r.content, /the start and the end are shown/);
});

test('read_file is never trimmed (it pages already)', () => {
  const r = offloadLarge('read_file', { content: log() }, { taskText: 'x' });
  assert.equal(r.content, log());
});
