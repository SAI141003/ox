// ox updates itself from the notch (src/self-update.js), on real git repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-upd-'));
process.env.OX_HOME = path.join(home, '.ox');
const U = await import('../src/self-update.js');
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
const ANY = /.*/;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-upd-repo-'));
  const hub = path.join(root, 'hub.git'), dev = path.join(root, 'dev'), mine = path.join(root, 'mine');
  g(root, 'init', '-q', '--bare', '-b', 'main', hub);
  g(root, 'clone', '-q', hub, dev);
  fs.mkdirSync(path.join(dev, 'src')); fs.writeFileSync(path.join(dev, 'src', 'a.js'), 'export const v = 1;\n');
  g(dev, 'add', '.'); g(dev, 'commit', '-qm', 'v1'); g(dev, 'push', '-q', 'origin', 'HEAD:main');
  g(root, 'clone', '-q', hub, mine);
  const ship = (text, msg, file = 'src/a.js') => { fs.mkdirSync(path.dirname(path.join(dev, file)), { recursive: true }); fs.writeFileSync(path.join(dev, file), text); g(dev, 'add', '.'); g(dev, 'commit', '-qm', msg); g(dev, 'push', '-q', 'origin', 'HEAD:main'); };
  return { root, mine, ship };
}

test('self-update: asks once, checks only when allowed, tells at most once a day', () => {
  const { mine, ship } = setup();
  assert.deepEqual(U.notice(), { kind: 'ask' });
  assert.equal(U.check({ root: mine, trusted: ANY }).ask, true, 'nothing is checked before you say yes');
  U.setAllowed(true);
  ship('export const v = 2;\n', 'Faster island');
  const s = U.check({ root: mine, trusted: ANY, force: true });
  assert.equal(s.available.count, 1);
  assert.match(s.available.subjects[0], /Faster island/);
  assert.equal(U.notice().kind, 'update');
  U.later();
  assert.equal(U.notice(), null, 'Later: not again today');
  assert.equal(U.notice({ now: Date.now() + 25 * 3600_000 }).kind, 'update', 'the next day it says it again');
});

test('self-update: only from ox\'s own GitHub', () => {
  const { mine } = setup();
  assert.match(U.source(mine).why, /only from ox's own repository/);
  assert.ok(U.HOME_REPO.test('https://github.com/SAI141003/ox.git'));
  assert.ok(!U.HOME_REPO.test('https://github.com/someone-else/ox.git'));
});

test('self-update: updates by fast-forward, rebuilds the island when its code changed', () => {
  const { mine, ship } = setup();
  ship('// island\n', 'island', 'desktop/island/Sources/x.swift');
  let rebuilt = 0, restarted = 0;
  const r = U.apply({ root: mine, trusted: ANY, rebuildIsland: () => { rebuilt++; return { ok: true }; }, restartIsland: () => { restarted++; } });
  assert.equal(r.ok, true, r.why);
  assert.equal(fs.readFileSync(path.join(mine, 'desktop/island/Sources/x.swift'), 'utf8'), '// island\n');
  assert.equal(process.platform === 'darwin' ? rebuilt : 1, 1);
  assert.deepEqual(r.steps.at(-1), 'Up to date');
  assert.equal(U.apply({ root: mine, trusted: ANY }).upToDate, true);
});

test('self-update: code that does not load is rolled back; your own commits are never overwritten', () => {
  const { mine, ship } = setup();
  ship('export const v = ;\n', 'broken');
  const r = U.apply({ root: mine, trusted: ANY });
  assert.equal(r.ok, false);
  assert.match(r.why, /did not load, so ox went back/);
  assert.equal(fs.readFileSync(path.join(mine, 'src/a.js'), 'utf8'), 'export const v = 1;\n', 'back where it was');
  // a commit of your own: no update over it
  fs.writeFileSync(path.join(mine, 'src/mine.js'), 'export const m = 1;\n'); g(mine, 'add', '.'); g(mine, 'commit', '-qm', 'mine');
  ship('export const v = 3;\n', 'v3');
  const r2 = U.apply({ root: mine, trusted: ANY });
  assert.equal(r2.ok, false);
  assert.match(r2.why, /its own commits/);
});
