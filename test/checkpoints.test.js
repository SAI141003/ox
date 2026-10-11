import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { takeCheckpoint, listCheckpoints, undoCheckpoint, rewindCheckpoint, pruneCheckpoints, diffCheckpoints } from '../src/checkpoints.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoints-test-'));
}

function setupFiles(cwd, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cwd, name), content);
  }
}

function readFile(cwd, name) {
  return fs.readFileSync(path.join(cwd, name), 'utf8');
}

function fileExists(cwd, name) {
  return fs.existsSync(path.join(cwd, name));
}

function writeFile(cwd, name, content) {
  fs.writeFileSync(path.join(cwd, name), content);
}

describe('checkpoints', () => {
  it('takeCheckpoint creates a checkpoint', () => {
    const cwd = makeDir();
    setupFiles(cwd, { 'a.txt': 'hello', 'b.txt': 'world' });
    const cp = takeCheckpoint({ cwd, turn: '1', files: ['a.txt', 'b.txt'] });
    assert.ok(cp.id, 'id should exist');
    assert.equal(cp.turn, '1');
    assert.deepEqual(cp.files, ['a.txt', 'b.txt']);
  });

  it('listCheckpoints returns checkpoints', () => {
    const cwd = makeDir();
    setupFiles(cwd, { 'a.txt': 'hello', 'b.txt': 'world' });
    takeCheckpoint({ cwd, turn: '1', files: ['a.txt', 'b.txt'] });
    writeFile(cwd, 'a.txt', 'updated');
    takeCheckpoint({ cwd, turn: '2', files: ['a.txt', 'b.txt'] });
    const list = listCheckpoints({ cwd });
    assert.equal(list.length, 2);
    assert.equal(list[0].turn, '1');
    assert.equal(list[1].turn, '2');
    assert.ok(list[0].size.includes('B'));
  });

  it('undoCheckpoint restores files', async () => {
    const cwd = makeDir();
    setupFiles(cwd, { 'a.txt': 'hello', 'b.txt': 'world' });
    takeCheckpoint({ cwd, turn: '1', files: ['a.txt', 'b.txt'] });
    writeFile(cwd, 'a.txt', 'updated');
    fs.unlinkSync(path.join(cwd, 'b.txt'));
    takeCheckpoint({ cwd, turn: '2', files: ['a.txt', 'b.txt'] });
    await undoCheckpoint({ cwd, target: 'last' });
    assert.equal(readFile(cwd, 'a.txt'), 'hello');
    assert.ok(fileExists(cwd, 'b.txt'));
  });

  it('rewindCheckpoint to a specific checkpoint', async () => {
    const cwd = makeDir();
    setupFiles(cwd, { 'a.txt': 'v1' });
    const cp1 = takeCheckpoint({ cwd, turn: '1', files: ['a.txt'] });
    writeFile(cwd, 'a.txt', 'v2');
    const cp2 = takeCheckpoint({ cwd, turn: '2', files: ['a.txt'] });
    writeFile(cwd, 'a.txt', 'v3');
    await rewindCheckpoint({ cwd, target: cp1.id });
    assert.equal(readFile(cwd, 'a.txt'), 'v1');
  });

  it('pruneCheckpoints removes old ones', () => {
    const cwd = makeDir();
    for (let i = 0; i < 12; i++) {
      setupFiles(cwd, { 'a.txt': String(i) });
      takeCheckpoint({ cwd, turn: String(i), files: ['a.txt'] });
    }
    const result = pruneCheckpoints({ cwd, keep: 5 });
    assert.equal(result.pruned, 7);
    const list = listCheckpoints({ cwd });
    assert.equal(list.length, 5);
    assert.equal(list[0].turn, '7');
  });

  it('diffCheckpoints shows differences', () => {
    const cwd = makeDir();
    setupFiles(cwd, { 'a.txt': 'line1\nline2\nline3', 'b.txt': 'same' });
    const cp1 = takeCheckpoint({ cwd, turn: '1', files: ['a.txt', 'b.txt'] });
    writeFile(cwd, 'a.txt', 'line1\nchanged\nline3');
    writeFile(cwd, 'b.txt', 'same');
    const cp2 = takeCheckpoint({ cwd, turn: '2', files: ['a.txt', 'b.txt'] });
    const diff = diffCheckpoints({ cwd, from: cp1.id, to: cp2.id });
    assert.ok(diff.includes('-line2'));
    assert.ok(diff.includes('+changed'));
    assert.ok(!diff.includes('b.txt'));
  });
});
