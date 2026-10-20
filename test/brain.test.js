// ox brain: a markdown vault with a rebuildable SQLite index (src/brain.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from '../src/brain.js';

const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-brain-'));

test('brain: notes are plain markdown Obsidian opens, with front matter and links', () => {
  const dir = vault();
  const r = B.remember({ title: 'Billing provider', body: 'Payments go through [[Paddle]]; invoices monthly.', tags: ['billing', 'decision'], project: 'shop' }, { dir });
  const text = fs.readFileSync(r.path, 'utf8');
  assert.match(text, /^---\ntitle: Billing provider\ntype: note\ntags: \[billing, decision\]\nproject: shop\nvalid_from: \d{4}-\d\d-\d\d\n---\n\nPayments go through \[\[Paddle\]\]/);
  const { meta, body } = B.parseNote(text);
  assert.deepEqual(meta.tags, ['billing', 'decision']);
  assert.deepEqual(B.linksIn(body), ['Paddle']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('brain: search finds by words, follows one link, prefers what is current, stays small', async () => {
  const dir = vault();
  B.remember({ title: 'Paddle', body: 'Paddle is the merchant of record; webhooks at /api/paddle.' }, { dir });
  B.remember({ title: 'Billing provider', body: 'Payments go through Stripe.', tags: ['billing'] }, { dir });
  B.remember({ title: 'Billing provider 2026', body: 'Payments moved to [[Paddle]] in March; Stripe is gone.', tags: ['billing'], supersedes: ['Billing provider'] }, { dir });
  for (let i = 0; i < 30; i++) B.remember({ title: `Noise ${i}`, body: `unrelated note number ${i} about gardening`.repeat(20) }, { dir });
  const idx = await B.index({ dir });
  assert.equal(idx.total, 33);
  const hits = await B.search('which payments provider do we use for billing', { dir });
  assert.equal(hits[0].title, 'Billing provider 2026', 'the current fact first');
  assert.ok(!hits.some((h) => h.title === 'Billing provider'), 'the replaced fact is left out once its successor is found');
  assert.ok(hits.some((h) => h.title === 'Paddle' ), 'one hop along the link');
  assert.ok(hits.reduce((n, h) => n + h.text.length, 0) <= 1500 * 4, 'capped');
  const old = await B.search('stripe billing', { dir, includeOld: true });
  assert.ok(old.some((h) => h.title === 'Billing provider' && !h.current), 'history is kept, marked old');
  const closed = B.parseNote(fs.readFileSync(path.join(dir, 'billing-provider.md'), 'utf8')).meta;
  assert.ok(closed.valid_to && closed.superseded_by === 'Billing provider 2026', 'closed, not deleted');
  assert.match(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), /\[\[Paddle\]\]/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), /\[\[Billing provider\]\]/, 'the index lists current notes only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('brain: the index is derived: delete it and it comes back the same', async () => {
  const dir = vault();
  B.remember({ title: 'Deploy', body: 'We deploy with fly.io from main.' }, { dir });
  await B.index({ dir });
  fs.rmSync(path.join(dir, '.brain.db'));
  const hits = await B.search('deploy fly', { dir });
  assert.equal(hits[0].title, 'Deploy');
  // an edited note is picked up
  const f = path.join(dir, 'deploy.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('fly.io', 'render.com'));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  await B.index({ dir });
  assert.match((await B.search('render', { dir }))[0].text, /render\.com/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('brain: consolidation merges duplicates and deletes nothing', async () => {
  const dir = vault();
  B.remember({ title: 'Test command', body: 'Run npm test.' }, { dir });
  B.remember({ title: 'Running tests', body: 'Run npm test.' }, { dir });
  const before = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').length;
  const r = await B.consolidate({ dir });
  assert.equal(r.merged.length, 1);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md').length, before, 'nothing deleted');
  const hits = await B.search('npm test', { dir });
  assert.equal(hits.length, 1, 'one current note left');
  fs.rmSync(dir, { recursive: true, force: true });
});
