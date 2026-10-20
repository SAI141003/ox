// Settings › Projects, Worktrees, Server, What's new, and "changed files"
// (after OpenCode's settings): read from git and ox's own session files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

test('the changed file is read from ox tools, Claude Code tools, and never from reads', async () => {
  const { toolFile } = await import('../src/serve.js');
  assert.equal(toolFile({ name: 'edit_file', file: 'src/a.js' }), 'src/a.js');
  assert.equal(toolFile({ name: 'Write', argsPreview: '{"file_path":"/x/a \\"b\\".txt","content":"hi"}' }), '/x/a "b".txt');
  assert.equal(toolFile({ name: 'MultiEdit', argsPreview: '{"file_path":"/x/c.js","edits":[' }), '/x/c.js');
  assert.equal(toolFile({ name: 'Read', argsPreview: '{"file_path":"/x"}' }), null);
  assert.equal(toolFile({ name: 'Write', argsPreview: '{"file_path":"/x/cut-off' }), null, 'a path cut off by the preview is not guessed');
});

test('projects come from sessions; worktrees from git; removing keeps the branch and refuses the main checkout', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ws-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ws-repo-')));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const wt = path.join(repo, '..', `${path.basename(repo)}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  fs.mkdirSync(path.join(home, '.ox', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ox', 'sessions', '20261019-120000-abcdef.jsonl'), `${JSON.stringify({ t: 'meta', created: new Date().toISOString(), cwd: repo })}\n${JSON.stringify({ t: 'user', text: 'hi' })}\n`);
  const prev = process.env.OX_HOME, prevHome = process.env.HOME;
  process.env.OX_HOME = path.join(home, '.ox'); process.env.HOME = home;
  try {
    const A = await import(`../src/app-api.js?ws=${Date.now()}`);
    const p = A.projectsView().find((x) => x.path === repo);
    assert.ok(p, 'the session folder is a project');
    assert.equal(p.sessions, 1);
    assert.equal(p.branch, 'main');
    const trees = A.worktreesView().filter((t) => t.repo === repo);
    assert.deepEqual(trees.map((t) => [t.main, t.branch]), [[true, 'main'], [false, 'feature']]);
    assert.throws(() => A.removeWorktree(repo, repo), /main checkout/);
    assert.throws(() => A.removeWorktree(repo, '/etc'), /not a worktree/);
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x');
    assert.equal(A.worktreesView().find((t) => t.path === fs.realpathSync(wt)).dirty, true);
    assert.throws(() => A.removeWorktree(repo, fs.realpathSync(wt)), /modified or untracked|contains/, 'git refuses a worktree with changes');
    fs.rmSync(path.join(wt, 'dirty.txt'));
    A.removeWorktree(repo, fs.realpathSync(wt));
    assert.ok(!fs.existsSync(wt));
    assert.ok(git(repo, 'rev-parse', '--verify', 'feature').status === 0, 'the branch stays');
  } finally {
    if (prev == null) delete process.env.OX_HOME; else process.env.OX_HOME = prev;
    process.env.HOME = prevHome;
  }
});

test("what's new lists commits since the one you saw, and nothing for a bad or current one", async () => {
  const A = await import('../src/app-api.js');
  const head = A.whatsNew(null).head;
  if (!head) return; // not a git install
  assert.deepEqual(A.whatsNew(head).changes, []);
  assert.deepEqual(A.whatsNew('not-a-hash;rm').changes, []);
  const prev = spawnSync('git', ['rev-parse', '--short', 'HEAD~1'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).stdout.trim();
  const w = A.whatsNew(prev);
  assert.equal(w.changes.length, 1);
  assert.match(w.changes[0].date, /^\d{4}-\d\d-\d\d$/);
  const s = A.serverView({ port: 1234 });
  assert.equal(s.pid, process.pid);
  assert.equal(s.url, 'http://127.0.0.1:1234/');
});
