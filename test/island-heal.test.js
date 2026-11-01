import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG = [
  '2026-10-31T11:51:09Z voice heard: "" (final: false, recording: true, peak: 0.0000)',
  '2026-10-31T11:51:16Z errand: macOS has not given ox Accessibility. Open System Settings',
  '2026-10-31T11:55:09Z request: "Open Word document" → "Open Word document" (live run: false)',
  '2026-10-31T11:55:09Z request: "Open Word document" → "Open Word document" (live run: false)',
  '2026-10-31T11:55:09Z heard: Open Word document',
  '2026-10-31T11:55:20Z replied: I can open Microsoft Word for you, but I need to know which specific document you\'d like to open.',
  '2026-10-31T11:56:00Z voice: recognizer error: Recognition request was canceled',
].join('\n');

test('island heal: reads its own log into fixes now and a goal for its code', async () => {
  const H = await import('../src/island-heal.js');
  const r = H.diagnose(LOG);
  assert.deepEqual(r.env.map((e) => e.id).sort(), ['accessibility', 'duplicate-islands', 'mic-silence']);
  assert.deepEqual(r.code.map((c) => c.id), ['clarify:open word document']);
  assert.match(H.goalFor(r.code), /"Open Word document" was answered with a question/);
  assert.equal(H.goalFor([]), null);
  assert.deepEqual(H.diagnose(LOG, { since: Date.parse('2026-10-31T11:55:30Z') }).code, []);
  const calls = [];
  H.fixEnvironment(r.env, { run: (cmd, args) => calls.push([cmd, ...args]) });
  assert.deepEqual(calls, [['tccutil', 'reset', 'Microphone', 'dev.ox.island'], ['tccutil', 'reset', 'SpeechRecognition', 'dev.ox.island']]);
});

test('island heal: a change that measured better is offered, applied and restarts the island', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-heal-'));
  process.env.OX_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'island.log'), LOG.replace(/2026-10-31/g, new Date().toISOString().slice(0, 10)));
    const H = await import('../src/island-heal.js');
    const goals = [];
    const st = await H.heal({ run: () => ({ status: 0 }), evolve: { evolve: async ({ goal }) => { goals.push(goal); return { id: 'a1', accepted: true, why: '+1 test', files: ['src/offline.js'] }; } } });
    assert.equal(goals.length, 1);
    assert.equal(st.offer.id, 'a1');
    let restarted = false;
    const after = await H.applyOffer({ accept: () => ({}), restart: async () => { restarted = true; } });
    assert.equal(after.applied.ok, true);
    assert.equal(after.offer, null);
    assert.ok(restarted);
  } finally { delete process.env.OX_HOME; fs.rmSync(home, { recursive: true, force: true }); }
});
