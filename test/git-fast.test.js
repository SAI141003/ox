// src/git-fast.js reads the repo root and branch without spawning git; it must
// agree with git itself, including in a linked worktree and a detached HEAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitToplevel, gitBranch } from '../src/git-fast.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gitfast-')));
  git(dir, 'init', '-q', '-b', 'trunk');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  return dir;
}

test('root and branch match git, from a nested folder', () => {
  const dir = repo();
  const sub = path.join(dir, 'a', 'b');
  assert.equal(gitToplevel(sub), git(sub, 'rev-parse', '--show-toplevel'));
  assert.equal(gitBranch(sub), 'trunk');
});

test('a linked worktree: its own root and branch (.git is a file)', () => {
  const dir = repo();
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  git(dir, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  assert.equal(gitToplevel(wt), git(wt, 'rev-parse', '--show-toplevel'));
  assert.equal(gitBranch(wt), 'feature/x');
});

test('detached HEAD reads as HEAD, like --abbrev-ref', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '--detach');
  assert.equal(gitBranch(dir), git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'));
});

test('outside a repository: null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-nogit-'));
  // The temp dir itself must not sit inside a repo for this to mean anything.
  if (gitToplevel(path.dirname(dir))) return;
  assert.equal(gitToplevel(dir), null);
  assert.equal(gitBranch(dir), null);
});
