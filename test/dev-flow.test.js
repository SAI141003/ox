// From change to mergeable PR (src/dev-flow.js): the environment recipe, ox pr
// open / status / fix against a local remote and a stand-in gh, task worktrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as D from '../src/dev-flow.js';

const run = (cwd, ...a) => spawnSync(a[0], a.slice(1), { cwd, encoding: 'utf8' });
function repo({ testCmd = 'node -e "process.exit(0)"' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dev-'));
  const remote = path.join(d, 'remote.git'), work = path.join(d, 'work');
  run(d, 'git', 'init', '-q', '--bare', '-b', 'main', remote);
  run(d, 'git', 'clone', '-q', remote, work);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) run(work, 'git', 'config', k, v);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: testCmd, lint: 'node -e "0"' } }));
  fs.writeFileSync(path.join(work, 'package-lock.json'), '{}');
  run(work, 'git', 'add', '-A'); run(work, 'git', 'commit', '-qm', 'init'); run(work, 'git', 'push', '-q', 'origin', 'main');
  // A stand-in gh: logs its arguments, answers pr create / view from files.
  const bin = path.join(d, 'gh');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${d}/gh.log"
case "$1 $2" in
  "pr create") echo "https://github.com/me/x/pull/7"; exit 0;;
  "pr view") if [ -f "${d}/view.json" ]; then cat "${d}/view.json"; exit 0; else echo "no pull requests found" >&2; exit 1; fi;;
  "repo view") echo "me/x"; exit 0;;
  "api "*) echo "[]"; exit 0;;
esac
exit 1
`, { mode: 0o755 });
  process.env.OX_GH_BIN = bin;
  return { d, work, log: () => fs.readFileSync(path.join(d, 'gh.log'), 'utf8') };
}

test('recipe: detected from package.json, saved once, edits respected', () => {
  const { work } = repo();
  const r = D.recipe(work);
  assert.equal(r.saved, true);
  assert.deepEqual(r.recipe, { install: 'npm ci', lint: 'npm run lint', test: 'npm test' });
  fs.writeFileSync(path.join(work, '.ox', 'environment.yml'), '# mine\ntest: node -e "1"\n');
  assert.deepEqual(D.recipe(work).recipe, { test: 'node -e "1"' });
  assert.equal(D.recipe(work).saved, false);
});

test('pr open: branch off main, commit, checks, push, PR with what was checked', () => {
  const { work, log } = repo();
  fs.writeFileSync(path.join(work, 'a.txt'), 'hello');
  const pr = D.openPr(work, { title: 'Add a greeting' });
  assert.equal(pr.url, 'https://github.com/me/x/pull/7');
  assert.match(pr.branch, /^ox\/add-a-greeting-/);
  assert.equal(pr.checks.ok, true);
  assert.deepEqual(pr.checks.results.map((r) => r.step), ['lint', 'test']);
  assert.equal(run(work, 'git', 'ls-remote', '--heads', 'origin', pr.branch).stdout.includes(pr.branch), true, 'pushed');
  const l = log();
  assert.match(l, /pr create --base main --head ox\/add-a-greeting/);
  assert.match(l, /Checked by ox before opening/);
  run(work, 'git', 'switch', '-q', 'main');
  assert.throws(() => D.openPr(work), /nothing changed/);
});

test('pr open still opens when a check fails, and says so in the body', () => {
  const { work, log } = repo({ testCmd: 'node -e "process.exit(1)"' });
  fs.writeFileSync(path.join(work, 'b.txt'), 'x');
  const pr = D.openPr(work, { title: 'Broken' });
  assert.equal(pr.checks.ok, false);
  assert.match(log(), /❌ `npm test`/);
});

test('pr status and fix: failing CI and a review comment become one ox task, then a push', async () => {
  const { d, work } = repo();
  fs.writeFileSync(path.join(work, 'c.txt'), 'x');
  const pr = D.openPr(work, { title: 'Feature', checks: false });
  fs.writeFileSync(path.join(d, 'view.json'), JSON.stringify({ number: 7, url: 'u', title: 'Feature', state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'CHANGES_REQUESTED', headRefName: pr.branch,
    statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/me/x/actions/runs/1/job/2' }],
    reviews: [{ author: { login: 'ana' }, body: 'Please rename c.txt to greeting.txt', state: 'CHANGES_REQUESTED' }], comments: [] }));
  const st = D.prStatus(work);
  assert.equal(st.canMerge, false);
  assert.equal(st.failing[0].name, 'test');
  let asked = null;
  const r = await D.fixPr(work, { runOx: async (cwd, prompt) => { asked = prompt; fs.renameSync(path.join(cwd, 'c.txt'), path.join(cwd, 'greeting.txt')); return { ok: true }; } });
  assert.match(asked, /Failing checks: test/);
  assert.match(asked, /ana: Please rename c.txt/);
  assert.equal(r.pushed, true);
  assert.match(run(work, 'git', 'log', '-1', '--format=%s').stdout, /Address review on #7/);
  // Green and approved: done, nothing run.
  fs.writeFileSync(path.join(d, 'view.json'), JSON.stringify({ number: 7, url: 'u', title: 'Feature', state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', headRefName: pr.branch, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }], reviews: [], comments: [] }));
  const done = await D.fixPr(work, { runOx: async () => { throw new Error('should not run'); } });
  assert.equal(done.done, true);
  assert.match(done.why, /can merge/);
});

test('task worktree: its own checkout and branch, kept out of git status', () => {
  const { work } = repo();
  const w = D.taskWorktree(work, 'T-12 fix login');
  assert.equal(w.branch, 'ox/task-t-12-fix-login');
  assert.ok(fs.existsSync(path.join(w.dir, 'package.json')));
  assert.equal(D.taskWorktree(work, 'T-12 fix login').created, false);
  assert.equal(run(work, 'git', 'status', '--porcelain').stdout.trim(), '', 'the worktree folder does not show as a change');
  assert.equal(D.removeWorktree(work, 'T-12 fix login'), true);
});
