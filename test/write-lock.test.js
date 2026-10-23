import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatchTool } from '../src/tools/index.js';
import { pendingWriteLocks } from '../src/write-lock.js';

test('same-file writes are serialized and leave a complete file', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ox-write-lock-'));
  const file = path.join(cwd, 'shared.txt');
  const ctx = { cwd, yolo: true, approval: 'yolo', writtenFiles: new Set() };
  const [a, b] = await Promise.all([
    dispatchTool('write_file', { path: 'shared.txt', content: 'first\n' }, ctx),
    dispatchTool('write_file', { path: 'shared.txt', content: 'second\n' }, ctx),
  ]);
  assert.equal(a.isError, undefined);
  assert.equal(b.isError, undefined);
  assert.match(await fs.readFile(file, 'utf8'), /^(first|second)\n$/);
  assert.equal(pendingWriteLocks(), 0);
  await fs.rm(cwd, { recursive: true, force: true });
});

