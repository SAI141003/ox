// ox race's winner, picked by evidence (src/race-select.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as S from '../src/race-select.js';

const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-race-sel-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'src/clamp.js'), 'export function clamp(x, lo, hi) {\n  return x;\n}\n');
  g(root, 'init', '-q'); g(root, 'add', '.'); g(root, 'commit', '-qm', 'base');
  return root;
}
function lane(root, name, code, testText) {
  const dir = path.join(root, '..', `${path.basename(root)}-${name}`);
  g(root, 'worktree', 'add', '-q', '-b', name, dir);
  fs.writeFileSync(path.join(dir, 'src/clamp.js'), code);
  if (testText) { fs.mkdirSync(path.join(dir, 'test'), { recursive: true }); fs.writeFileSync(path.join(dir, `test/${name}.test.js`), testText); }
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', name);
  const st = g(dir, 'diff', '--shortstat', 'HEAD~1', 'HEAD').stdout;
  return { agent: name, dir, files: Number(/(\d+) files? changed/.exec(st)?.[1] ?? 0), plus: 3, minus: 1, checks: [], checksOk: true };
}
const T = (body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/clamp.js';\ntest('clamp', () => { ${body} });\n`;

test('race: the lane that really does the task wins, on evidence', async () => {
  const root = repo();
  const ask = async ({ system }) => (system === S.REPRO_SYSTEM ? T('assert.equal(clamp(15, 0, 10), 10); assert.equal(clamp(-3, 0, 10), 0); assert.equal(clamp(4, 0, 10), 4);') : 'A');
  const keep = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-race-keep-'));
  const repro = await S.reproTest(root, 'clamp(x, lo, hi) keeps x between lo and hi', { ask, dir: keep });
  assert.equal(repro.failsBefore, true, 'the reproduction test fails on the code before the race');
  assert.ok(!fs.existsSync(path.join(root, repro.rel)), 'and is not left in the project');
  // "lazy": only the upper bound, with a test that agrees with itself; "right": both bounds
  const lazy = lane(root, 'lazy', 'export function clamp(x, lo, hi) {\n  return x > hi ? hi : x;\n}\n', T('assert.equal(clamp(15, 0, 10), 10);'));
  const right = lane(root, 'right', 'export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n', T('assert.equal(clamp(-3, 0, 10), 0); assert.equal(clamp(15, 0, 10), 10);'));
  const none = { agent: 'idle', dir: root, files: 0, plus: 0, minus: 0, checks: [], checksOk: false };
  const r = await S.rankLanes(root, 'clamp', [lazy, none, right], { repro });
  assert.equal(r.winner, 'right');
  assert.deepEqual(r.ranked.map((x) => x.agent), ['right', 'lazy', 'idle']);
  assert.match(r.ranked[0].why, /passes the reproduction test/);
  assert.match(r.ranked[0].why, /passes 1\/1 of the other lanes' tests/);
  assert.match(r.ranked[1].why, /fails the reproduction test/);
  assert.match(r.ranked[1].why, /passes 0\/1 of the other lanes' tests/);
  assert.equal(fs.readdirSync(path.join(lazy.dir, 'test')).length, 1, 'rivals\' tests are taken out again');
  for (const d of [lazy.dir, right.dir, root, keep]) fs.rmSync(d, { recursive: true, force: true });
});

test('race: a judge that flips with the order decides nothing', async () => {
  let n = 0;
  const flip = async () => (n++ % 2 === 0 ? 'A' : 'A');
  assert.equal(await S.judge('t', 'diff one', 'diff two', flip), null, 'A both times means it prefers the first slot, not a change');
  const fair = async ({ user }) => (user.indexOf('good') < user.indexOf('bad') ? 'A' : 'B');
  assert.equal(await S.judge('t', 'good', 'bad', fair), 'a');
});
