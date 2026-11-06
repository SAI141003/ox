import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('needs you: GitHub reviews, failing checks, changes requested, assigned issues, with links', async () => {
  const N = await import('../src/needs-you.js');
  const run = (_cmd, args) => {
    const a = args.join(' ');
    if (a.includes('--review-requested=@me')) return { status: 0, stdout: JSON.stringify([{ title: 'Add search', url: 'https://github.com/o/r/pull/1', repository: { nameWithOwner: 'o/r' }, updatedAt: '2026-10-31T10:00:00Z' }]) };
    if (a.includes('graphql')) return { status: 0, stdout: JSON.stringify({ data: { viewer: { pullRequests: { nodes: [{ title: 'Fix login', url: 'https://github.com/o/r/pull/2', reviewDecision: 'CHANGES_REQUESTED', repository: { nameWithOwner: 'o/r' }, updatedAt: '2026-10-31T09:00:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }] } } } }) };
    if (a.includes('--assignee=@me')) return { status: 0, stdout: '[]' };
    return { status: 1, stdout: '' };
  };
  const g = N.githubNeeds({ run });
  assert.deepEqual(g.items.map((i) => i.kind), ['review', 'failing', 'changes']);
  assert.equal(g.items[0].url, 'https://github.com/o/r/pull/1');
  assert.deepEqual(N.githubNeeds({ run: () => ({ status: 1 }) }).skipped, ['GitHub (gh is not signed in, or offline)']);
  const ox = N.oxNeeds({ tasks: [{ title: 'Ship it', status: 'in_review' }], schedules: [{ enabled: true, prompt: 'nightly report', lastRun: { at: Date.now(), state: 'failed', note: 'no key' } }] });
  assert.deepEqual(ox.map((i) => i.kind), ['review', 'routine']);
  assert.match(N.formatNeeds({ items: g.items, skipped: ['Mail (not open)'] }), /Not read: Mail/);
});

test('pages: saved with sources, listed, rendered with the sources at the bottom and nothing unescaped', async () => {
  const P = await import('../src/pages.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pages-'));
  const env = { OX_HOME: home };
  const r = P.savePage({ title: 'Churn risk, week 36', body: '## Acme\n- Invoice failed **three** times [1]\n\n<script>alert(1)</script>', sources: ['https://stripe.example/inv/1042', 'Slack #billing, Oct 30'] }, { env, now: new Date('2026-10-31T09:00:00Z') });
  assert.equal(r.id, '2026-10-31-churn-risk-week-36');
  assert.equal(P.listPages({ env })[0].sources, 2);
  const html = P.pageHtml(P.readPage(r.id, { env }));
  assert.match(html, /<h3>Acme<\/h3>/);
  assert.match(html, /<b>three<\/b>/);
  assert.match(html, /<footer><h2>Sources<\/h2><ol><li id="s1"><a href="https:\/\/stripe.example\/inv\/1042">/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.throws(() => P.readPage('../../etc/passwd', { env }), /no such page/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Silent words app: its own bundle with the Motion, microphone and speech reasons', async () => {
  const { buildSubvoxApp } = await import('../src/island.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-silent-'));
  const pkg = path.join(home, 'pkg');
  assert.equal(buildSubvoxApp({ pkg, home }), null);
  fs.mkdirSync(path.join(pkg, '.build', 'release'), { recursive: true });
  fs.writeFileSync(path.join(pkg, '.build', 'release', 'OxSubvox'), '#!/bin/sh\n');
  const app = buildSubvoxApp({ pkg, home });
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  for (const k of ['NSMotionUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription', '<string>OxSubvox</string>', 'dev.ox.silentwords']) assert.ok(plist.includes(k), k);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a slow page opens on what was gathered last and refreshes behind it', async () => {
  const { keptFresh } = await import('../src/serve.js');
  let n = 0;
  const make = async () => { n += 1; await new Promise((r) => setTimeout(r, 30)); return n; };
  const key = `t-${process.pid}`;
  assert.equal(await keptFresh(key, make, { maxAgeMs: 0 }), 1, 'the first open waits once');
  const t = Date.now();
  assert.equal(await keptFresh(key, make, { maxAgeMs: 0 }), 1, 'then the last answer, at once');
  assert.ok(Date.now() - t < 25);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await keptFresh(key, make, { maxAgeMs: 60_000 }), 2, 'the refresh behind it landed');
  assert.equal(n, 2, 'one refresh, not one per open');
});
