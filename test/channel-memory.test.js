// A team channel's memory (src/channel-memory.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('kept per channel; a question finds the lines that answer it, with who and when', async () => {
  process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-chan-'));
  const M = await import('../src/channel-memory.js');
  const t = 1792300000;
  M.remember('C1', { user: 'ana', text: 'Morning all', ts: t });
  M.remember('C1', { user: 'raj', text: 'We decided pricing is $20 a month for teams', ts: t + 60 });
  M.remember('C1', { user: 'ana', text: 'Agreed, ship it Friday', ts: t + 120 });
  M.remember('C2', { user: 'zoe', text: 'Pricing is secret here', ts: t });
  assert.equal(M.all('C1').length, 3);
  const lines = M.search('C1', 'what did we decide about pricing?');
  assert.ok(lines.some((l) => /\$20 a month/.test(l.text)));
  assert.ok(!lines.some((l) => /secret/.test(l.text)), 'other channels never leak in');
  const p = M.prompt('pricing?', lines);
  assert.match(p.system, /only from the channel messages/);
  assert.match(p.user, /raj: We decided pricing/);
  assert.match(p.user, /CHANNEL MESSAGES \(DATA\)/);
  assert.equal(M.remember('C1', { user: 'x', text: '   ' }), false);
});
