import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a routine whose sources did not change is skipped; a change runs it', async () => {
  const W = await import('../src/schedule-watch.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-watch-'));
  const env = { OX_HOME: home };
  const folder = path.join(home, 'inbox');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'a.txt'), 'one');
  const sch = { id: 'r1', cwd: home, watch: [folder] };
  const first = W.shouldRun(sch, { env });
  assert.equal(first.run, true);
  W.noteRun('r1', first.fp, { env });
  const again = W.shouldRun(sch, { env });
  assert.equal(again.run, false);
  assert.match(again.why, /nothing new/);
  fs.writeFileSync(path.join(folder, 'b.txt'), 'two');
  assert.equal(W.shouldRun(sch, { env }).run, true);
  assert.equal(W.shouldRun({ id: 'r2', watch: [] }, { env }).run, true);
  // An unreadable source counts as changed: a routine never goes quiet because a site is down.
  const failing = () => ({ status: 1, stdout: '' });
  assert.equal(W.shouldRun({ id: 'r3', watch: ['https://example.invalid'] }, { env, run: failing }).run, true);
  assert.equal(W.validSource('rm -rf /'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a routine from a description: cadence, sources, cap, each with a reason', async () => {
  const { suggestRoutine } = await import('../src/schedule-watch.js');
  const daily = suggestRoutine('each morning at 7:30am brief me on ~/Projects/site');
  assert.deepEqual(daily.cadence, { at: '07:30' });
  assert.deepEqual(daily.watch, ['~/Projects/site']);
  const weekly = suggestRoutine('every monday summarize the PRs waiting for my review');
  assert.deepEqual(weekly.cadence, { every: '7d' });
  assert.equal(weekly.maxCostUsd, 0.5);
  assert.ok(weekly.watch.includes('gh:review-requested:@me is:open'));
  const watcher = suggestRoutine('watch https://news.ycombinator.com for posts about ox');
  assert.deepEqual(watcher.cadence, { every: '30m' });
  assert.ok(watcher.reasons.length >= 3);
});

test('a Windows folder is a source to watch too', async () => {
  const W = await import('../src/schedule-watch.js');
  for (const s of ['C:\\Users\\me\\inbox', 'D:/work/repo', '~\\notes', 'git:C:\\repo']) assert.equal(W.validSource(s), true, s);
  assert.equal(W.validSource('inbox'), false);
});
