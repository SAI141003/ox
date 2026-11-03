// Proactive cards: loose ends turned into prepared next steps, never sent, and
// shown in the morning brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-proactive-'));
const env = { ...process.env, OX_HOME: path.join(dir, '.ox') };
const P = await import('../src/proactive.js');
const T = await import('../src/today.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('loose ends become at most five prepared cards, saved, with nothing claimed as done', async () => {
  let prompt;
  const items = [
    { source: 'messages', text: '+1555 is waiting on your reply: "are we still on for Friday?"' },
    { source: 'calendar', text: 'Kickoff with Acme — 2026-11-04T10:00:00' },
  ];
  const r = await P.prepareCards({ env, items, now: Date.parse('2026-11-03T03:00:00Z'), ask: async ({ system, user }) => {
    prompt = { system, user };
    return 'ok: [{"title":"Reply about Friday","why":"waiting a day","prepared":"Yes, still on! [time] works for me.","source":"messages"},{"title":"bad"}]';
  } });
  assert.match(prompt.user, /1\. \[messages\]/);
  assert.match(prompt.system, /Never claim anything was sent or done/);
  assert.equal(r.cards.length, 1, 'a card without a prepared step is dropped');
  assert.deepEqual(P.readCards({ env }).cards[0].title, 'Reply about Friday');
});

test('nothing to look at: no model call and no cards', async () => {
  const r = await P.prepareCards({ env, items: [], ask: async () => { throw new Error('should not be asked'); } });
  assert.deepEqual(r.cards, []);
});

test('the morning brief lists what was prepared', () => {
  const b = T.compose({ cards: [{ title: 'Reply about Friday' }] });
  assert.ok(b.ready.includes('Prepared: Reply about Friday (ox proactive)'));
});

test('a night run happens once, after 2 AM, and never in tests', async () => {
  assert.equal(await P.prepareTonight({ env }), null);
});
