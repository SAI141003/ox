// The charge intro (ox through glass): deterministic, seamless handoff, and
// plain output when colour is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHARGE_SECONDS, LOGO, renderChargeFrame, renderLogo } from '../src/logo.js';

test('the last frame is exactly the mark, so the banner handoff cannot flicker', () => {
  assert.deepEqual(renderChargeFrame({ t: CHARGE_SECONDS, color: false }), renderLogo({ color: false }).split('\n'));
});

test('frames are deterministic for a seed', () => {
  for (const t of [0.3, 0.72, 0.9, 1.2]) {
    assert.deepEqual(renderChargeFrame({ t, seed: 3, color: false }), renderChargeFrame({ t, seed: 3, color: false }));
  }
});

test('story beats: pane before impact, shards after, mark at the end', () => {
  const before = renderChargeFrame({ t: 0.3, color: false }).join('\n');
  assert.ok(before.includes('│'), 'the glass pane is standing before the hit');
  const after = renderChargeFrame({ t: 0.9, color: false }).join('\n');
  assert.match(after, /[◢◣◤◥▴◆*]/, 'shards fly after the hit');
  const end = renderChargeFrame({ t: 1.69, color: false });
  assert.equal(end.length, LOGO.length, 'every frame keeps the mark height, so the screen never jumps');
});

test('colour off means no escape sequences in any frame', () => {
  for (const t of [0, 0.5, 0.72, 1.0, 1.5]) {
    for (const line of renderChargeFrame({ t, color: false })) assert.ok(!line.includes('\x1b'), `escape at t=${t}`);
  }
});
