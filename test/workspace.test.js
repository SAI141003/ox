// ox works where you work: never inside its own install by default; a team
// builds in your project (on its own branch) or in a new folder beside your
// others; a new project gets a folder of its own and the run moves there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as W from '../src/workspace.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ws-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a chat never starts inside ox\'s own install; anywhere else it starts where ox was started', () => {
  assert.equal(W.defaultWorkspace({ cwd: W.OX_ROOT, home: '/Users/me' }), '/Users/me');
  assert.equal(W.defaultWorkspace({ cwd: root, home: '/Users/me' }), root);
  assert.equal(W.defaultWorkspace({ cwd: '/', home: '/Users/me' }), '/Users/me');
});

test('a team builds in the project you are in, else in a new folder beside your others', () => {
  const ws = path.join(root, 'Ox Workspace');
  const proj = path.join(ws, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  assert.equal(W.teamDirFor(proj, 'add a cart'), proj);
  assert.equal(W.teamDirFor(ws, 'hey build me a 3D game!'), path.join(ws, '3d-game'));
  fs.mkdirSync(path.join(ws, '3d-game'));
  assert.equal(W.teamDirFor(ws, 'hey build me a 3D game!'), path.join(ws, '3d-game-2'));
  assert.equal(W.slugOf('A tiny dice roller in plain Node (ESM, no dependencies)'), 'dice-roller-node-esm');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  assert.equal(W.teamDirFor(home, 'a notes app', { home, env: {} }), path.join(home, 'Projects', 'notes'));
  assert.equal(W.teamDirFor(W.OX_ROOT, 'a notes app', { home, env: {} }), path.join(home, 'Projects', 'notes'), 'never inside ox');
});

test('set_project makes the new project\'s folder beside the others and moves the run there', async () => {
  const { set_project } = await import('../src/tools/project.js');
  const ws = path.join(root, 'work');
  fs.mkdirSync(ws, { recursive: true });
  const moved = [];
  const ctx = { cwd: ws, onProject: (d) => moved.push(d) };
  const r = await set_project({ name: 'Todo App' }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(ctx.cwd, path.join(ws, 'todo-app'));
  assert.ok(fs.statSync(ctx.cwd).isDirectory());
  assert.deepEqual(moved, [ctx.cwd]);
  const named = await set_project({ path: path.join(ws, 'named') }, ctx);
  assert.match(named.content, /new folder/);
  assert.equal(ctx.cwd, path.join(ws, 'named'));
  const bad = await set_project({ path: W.OX_ROOT }, { cwd: ws });
  assert.equal(bad.isError, true);
});
