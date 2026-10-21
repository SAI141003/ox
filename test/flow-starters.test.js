// Five automations that work right after install (src/flows.js starters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-starters-'));
const F = await import('../src/flows.js');

test('five starters, all valid, installed switched off, each runs with its steps', async () => {
  const list = F.starters({ repo: '/tmp/some project' });
  assert.equal(list.length, 5);
  for (const s of list) assert.deepEqual(F.validateFlow(s), [], s.id);
  assert.match(list.find((s) => s.id === 'standup-notes').steps[0].command, /git -C '\/tmp\/some project'/, 'the repo path is quoted for the shell');
  const saved = F.installStarters(null, { repo: process.cwd() });
  assert.equal(saved.length, 5);
  assert.ok(saved.every((f) => f.enabled === false), 'nothing runs on its own until you turn it on');
  assert.deepEqual(F.dueFlows(Date.now() + 86_400_000).map((f) => f.id), [], 'switched off: never due');
  const shown = [];
  const fakeFetch = async (url) => new Response(JSON.stringify(
    url.includes('wttr') ? { current_condition: [{ temp_C: '12', FeelsLikeC: '10', weatherDesc: [{ value: 'Sunny' }] }] }
      : url.includes('frankfurter') ? { rates: { EUR: 0.9, GBP: 0.75, INR: 95 } }
        : url.includes('github') ? { name: 'v1.2.3', published_at: '2026-10-20' } : { hits: [{ title: 'x' }] }), { headers: { 'content-type': 'application/json' } });
  for (const id of ['weather-today', 'exchange-rates', 'release-watch']) {
    const r = await F.runFlow(id, { io: { fetch: fakeFetch, notify: async (t, x) => { shown.push(x); return 'shown'; } }, record: false });
    assert.equal(r.status, 'ok', `${id}: ${r.error ?? ''}`);
  }
  assert.deepEqual(shown, ['12°C, Sunny (feels like 10°C)', '1 USD = 0.9 EUR · 0.75 GBP · 95 INR', 'v1.2.3 (2026-10-20)']);
  assert.throws(() => F.installStarters(['nope']), /starters: weather-today/);
});
