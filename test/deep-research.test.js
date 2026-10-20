// ox research --deep (src/deep-research.js): plan, parallel workers, citation pass, into the brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as R from '../src/deep-research.js';
import * as B from '../src/brain.js';

test('deep research: claims without a read source are dropped; the report lands in the brain', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dr-home-'));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dr-vault-'));
  process.env.OX_HOME = path.join(home, '.ox');
  const calls = [];
  const lead = async ({ system, user }) => {
    calls.push(system);
    if (system === R.PLAN_SYSTEM) return '{"workers":[{"brief":"Licence of SQLite","queries":["sqlite license"]},{"brief":"Who maintains SQLite","queries":["sqlite maintainers"]}]}';
    assert.match(user, /public domain \[\d+\]/);
    assert.doesNotMatch(user, /invented/);
    return 'SQLite is in the public domain [1] and maintained by a small team [2].';
  };
  // Cites the page numbers it was given, as a model would.
  const num = (user, page) => Number(new RegExp(`\\[(\\d+)\\] https://sqlite\\.org/${page}`).exec(user)?.[1]);
  const worker = async ({ user }) => (user.includes('Brief: Licence')
    ? JSON.stringify({ claims: [{ claim: 'SQLite is in the public domain', sources: [num(user, 'copyright')] }, { claim: 'an invented claim', sources: [99] }, { claim: 'no source at all', sources: [] }], gaps: [] })
    : JSON.stringify({ claims: [{ claim: 'Maintained by a small team', sources: [num(user, 'crew')] }], gaps: ['exact names'] }));
  const searchRows = async (q) => [{ title: q, url: q.includes('license') ? 'https://sqlite.org/copyright.html' : 'https://sqlite.org/crew.html' }];
  const fetchText = async (url) => ({ ok: true, url, title: url.split('/').pop(), text: `${url} `.repeat(60) });
  const say = [];
  const r = await R.deepResearch('What licence is SQLite under and who maintains it?', { lead, worker, searchRows, fetchText, say: (s) => say.push(s), home, brain: { remember: (n) => B.remember(n, { dir: vault }), index: () => B.index({ dir: vault }) } });
  assert.equal(r.workers, 2);
  assert.equal(r.claims.length, 2);
  assert.deepEqual(r.dropped.sort(), ['an invented claim', 'no source at all']);
  assert.deepEqual(r.sources.map((s) => s.url).sort(), ['https://sqlite.org/copyright.html', 'https://sqlite.org/crew.html']);
  const note = fs.readFileSync(r.saved.path, 'utf8');
  assert.match(note, /^---\ntitle: "?Research: What licence is SQLite/);
  assert.match(note, /## Sources\n\d\. \[\w+\.html\]\(https:\/\/sqlite\.org\/\w+\.html\)\n\d\. /);
  assert.equal((await B.search('sqlite licence public domain', { dir: vault }))[0].title, r.saved.title, 'the next question finds it');
  // resumes from the checkpoint: no new plan, no new worker calls
  const before = calls.length;
  await R.deepResearch('What licence is SQLite under and who maintains it?', { lead, worker: async () => { throw new Error('should not run'); }, searchRows, fetchText, home, save: false });
  assert.equal(calls.filter((c) => c === R.PLAN_SYSTEM).length, 1, 'planned once');
  assert.ok(calls.length > before, 'the report is written again from the checkpoint');
  delete process.env.OX_HOME;
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(vault, { recursive: true, force: true });
});
