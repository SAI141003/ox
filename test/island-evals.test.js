// OX Island's evals (src/island-evals.js): the requests from the owner's videos
// and every case learned from real use must route right. ox evolve keeps an
// island change only when this suite (with the rest) measures better.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The router, not this machine: a fixed set of installed apps (CI's clean Macs have no Chrome or Spotify).
process.env.OX_APPS ??= 'Google Chrome,Safari,Spotify,Music,WhatsApp,Mail,Notes,Reminders,Calendar,Visual Studio Code,Terminal,System Settings,Finder';
const { offlineEvals, commandEvals, learnFromLog, evolveGoal, readCases } = await import('../src/island-evals.js');

test('every offline eval routes as expected (videos included)', () => {
  const r = offlineEvals();
  assert.ok(r.total >= 20);
  assert.deepEqual(r.failing, [], JSON.stringify(r.failing, null, 2));
});

test('the cases from the owner\'s videos are in the evals', () => {
  const texts = readCases().map((c) => c.text);
  for (const t of ['play Billie Jean by Michael Jackson', 'turn down the volume just a little bit', 'write an email to Camille, tell her it\'s done']) assert.ok(texts.includes(t), t);
});

test('island command evals pass through the island binary when it is built', { skip: process.platform !== 'darwin' }, (t) => {
  const r = commandEvals();
  if (r.skipped) return t.skip(r.skipped);
  assert.deepEqual(r.failing, []);
  assert.ok(r.pass >= 20);
});

test('learning from the island log: short requests that became agent runs, stopped runs', () => {
  const log = [
    '2026-10-18T10:00:00Z heard: turn the brightness down',
    '2026-10-18T10:00:01Z agent run (this needs ox to act) after 40 ms',
    '2026-10-18T10:01:00Z heard: play jazz',
    '2026-10-18T10:01:00Z offline in 3 ms: playing jazz',
    '2026-10-18T10:02:00Z heard: book a table for two',
    '2026-10-18T10:02:09Z replied: stopped: exit 2',
    '2026-10-18T10:03:00Z heard: turn the brightness down',
    '2026-10-18T10:03:01Z agent run (this needs ox to act) after 38 ms',
  ].join('\n');
  const c = learnFromLog(log);
  assert.deepEqual(c.map((x) => x.text), ['turn the brightness down', 'book a table for two']);
  assert.match(c[0].ask, /offline/);
});

test('the evolve goal names each failing case; none when all pass', () => {
  const g = evolveGoal({ offline: { failing: [{ text: 'dim the screen', want: 'brightness', got: null }] }, commands: { failing: ['island should take: shrink'] } });
  assert.match(g, /dim the screen/);
  assert.match(g, /shrink/);
  assert.equal(evolveGoal({ offline: { failing: [] }, commands: { failing: [] } }), null);
});
