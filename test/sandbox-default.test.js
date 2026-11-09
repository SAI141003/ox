// The sandbox is on by default where the OS can enforce it, and the default
// still lets everyday work through: device files, temp, package caches, git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultSandboxName, defaultWritable, resolveSandbox, prepareSandbox, resetSandboxCompileCacheForTest } from '../src/sandbox.js';

const hasSandboxExec = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

function outsideTests(fn) {
  const saved = process.env.NODE_TEST_CONTEXT;
  const savedSb = process.env.OX_SANDBOX;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.OX_SANDBOX;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
    if (savedSb !== undefined) process.env.OX_SANDBOX = savedSb;
  }
}

test('the default is workspace where a kernel backend exists, off elsewhere', () => {
  outsideTests(() => {
    assert.equal(defaultSandboxName({ platform: 'win32' }), 'off');
    if (hasSandboxExec) assert.equal(defaultSandboxName({ platform: 'darwin' }), 'workspace');
  });
  // Inside the test runner the old default holds, so other tests are unaffected.
  assert.equal(defaultSandboxName({ platform: 'darwin' }), 'off');
});

test('OX_SANDBOX and config still choose, and off turns it off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sbdef-'));
  outsideTests(() => {
    process.env.OX_SANDBOX = 'off';
    try {
      const p = resolveSandbox({ config: {}, cwd: home, home });
      assert.equal(p.name, 'off');
      assert.equal(p.source, 'env');
    } finally {
      delete process.env.OX_SANDBOX;
    }
    const c = resolveSandbox({ config: { sandbox: { profile: 'off' } }, cwd: home, home });
    assert.equal(c.name, 'off');
    assert.equal(c.source, 'config');
  });
});

test('the default widens only to paths that exist: caches and the git directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sbdef-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.npm'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const w = defaultWritable({ cwd: repo, home });
  assert.ok(w.includes(path.join(home, '.npm')), 'an existing cache is writable');
  assert.ok(!w.includes(path.join(home, '.cargo')), 'a missing one is not listed (bwrap cannot bind it)');
  assert.ok(w.some((p) => p.endsWith(`${path.sep}.git`)), `the git directory is writable: ${w.join(', ')}`);
});

test('REAL: under the default, the project, /dev/null, temp and git work; the rest of home does not', { skip: !hasSandboxExec }, () => {
  resetSandboxCompileCacheForTest();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sbdef-')));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const profile = outsideTests(() => resolveSandbox({ config: {}, cwd: repo, home }));
  assert.equal(profile.name, 'workspace');
  assert.equal(profile.source, 'default');
  // The test root sits in temp, which is writable; point temp elsewhere so the
  // "rest of home" really is outside every root.
  const runner = prepareSandbox({ ...profile, tmpDir: '/nonexistent-ox-tmp' });
  const run = (cmd) =>
    spawnSync(runner.argvPrefix[0], [...runner.argvPrefix.slice(1), '/bin/sh', '-c', cmd], { cwd: repo, encoding: 'utf8' }).status;
  assert.equal(run('echo hi > ./a.txt'), 0, 'the project is writable');
  assert.equal(run('echo hi > /dev/null'), 0, '/dev/null is writable');
  assert.equal(run('git update-ref refs/ox-probe HEAD 2>/dev/null || git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x'), 0, 'git can commit');
  assert.notEqual(run(`echo hi > ${JSON.stringify(path.join(home, 'Documents', 'x.txt'))}`), 0, 'the rest of home is not');
  assert.ok(!fs.existsSync(path.join(home, 'Documents', 'x.txt')));
});
