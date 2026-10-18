// Speech sentence by sentence with emotion tags (src/tts.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentences } from '../src/tts.js';

test('sentences: emotion tags carry forward, are not spoken, and short pieces ride with the next', () => {
  const s = sentences('(excited) It passed! The PR is open. (calm) Want me to merge it now? Done.');
  assert.deepEqual(s.map((x) => [x.text, x.mood]), [['It passed! The PR is open.', 'excited'], ['Want me to merge it now? Done.', 'calm']]);
  assert.equal(s[0].speed, 1.15);
  assert.equal(s[1].speed, 0.92);
  assert.deepEqual(sentences('[whispering] the baby is asleep').map((x) => [x.text, x.mood]), [['the baby is asleep', 'whispering']]);
  assert.deepEqual(sentences('(unknowntag) hello there friend').map((x) => x.text), ['(unknowntag) hello there friend'], 'unknown tags are left as words');
});
