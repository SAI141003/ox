// Old tool outputs hidden in batches (src/context-mask.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskOldOutputs } from '../src/context-mask.js';

const round = (i, out) => [
  { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.js` }) } }] },
  { role: 'tool', tool_call_id: `c${i}`, content: out },
];
const convo = (n, size) => [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }, ...Array.from({ length: n }, (_, i) => round(i, `${i}:`.padEnd(size, 'x'))).flat()];

test('mask: a small conversation is left alone', () => {
  const h = convo(4, 2000);
  assert.equal(maskOldOutputs(h), h);
});

test('mask: past the threshold, outputs older than the last 3 rounds are hidden at once, and stay hidden', () => {
  const h = convo(12, 15_000);
  const m = maskOldOutputs(h);
  assert.notEqual(m, h);
  const hidden = m.filter((x) => x.role === 'tool' && x.content.startsWith('[hidden'));
  assert.equal(hidden.length, 9, 'all but the newest 3 rounds');
  assert.match(hidden[0].content, /the output of read_file\(src\/f0\.js\), 15,000 characters\. Run the call again/);
  assert.ok(m.slice(-6).every((x) => !String(x.content).startsWith('[hidden')), 'the newest rounds are whole');
  // one more round: too little to hide yet, so nothing earlier changes (the cache stays warm)
  const next = [...m, ...round(12, '12:'.padEnd(15_000, 'x'))];
  assert.equal(maskOldOutputs(next), next);
});

test('mask: the same output seen again later is hidden in the earlier place', () => {
  const same = 'same test output '.padEnd(50_000, '.');
  const h = [...convo(1, 100_000), ...round(5, same), ...round(6, 'other'.padEnd(900, 'y')), ...round(7, 'z'.padEnd(900, 'z')), ...round(8, same)];
  const m = maskOldOutputs(h);
  assert.match(m.find((x) => x.tool_call_id === 'c5').content, /the same as a later output/);
  assert.equal(m.find((x) => x.tool_call_id === 'c8').content, same);
});

test('mask: OX_MASK_OUTPUTS=0 turns it off', () => {
  process.env.OX_MASK_OUTPUTS = '0';
  const h = convo(12, 15_000);
  assert.equal(maskOldOutputs(h), h);
  delete process.env.OX_MASK_OUTPUTS;
});
