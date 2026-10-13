// Commands that used to pretend now do real work (or say plainly what to use):
// kanban is a view of the real task board, brain reads real research reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-facade-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-facade-proj-'));
const ox = (...args) => {
  const r = spawnSync(process.execPath, [OX, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home, OX_ISLAND: '0', NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('kanban shows the real task board, in columns', () => {
  assert.match(ox('kanban').out, /board is empty/);
  const added = ox('kanban', 'add', 'write the release notes');
  assert.match(added.out, /created task task_/);
  const id = added.out.match(/task_\d+_[a-z0-9]+/)[0];
  assert.match(ox('task', 'list').out, new RegExp(id), 'the same store as ox task');
  ox('task', 'claim', id, '--as', 'mira');
  const board = ox('kanban').out;
  assert.match(board, /doing \(1\)/);
  assert.match(board, /write the release notes · mira/);
  assert.match(ox('kanban', 'swarm', 'x').out, /replaced by real runs/);
});

test('brain lists real reports and their open questions', () => {
  assert.match(ox('brain').out, /no reports yet/);
  fs.mkdirSync(path.join(cwd, '.agent', 'research'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.agent', 'research', '2026-10-12-caching.md'),
    '# Caching\nfinding [1]\n\n## Sources\n1. https://example.com\n\n## Open questions\n- does it survive restarts?\n- what is the eviction policy\n');
  assert.match(ox('brain').out, /2026-10-12-caching\.md/);
  const gaps = ox('brain', 'gaps').out;
  assert.match(gaps, /○ does it survive restarts\?/);
  assert.match(gaps, /○ what is the eviction policy/);
});

test('arena explains itself instead of crashing', () => {
  const r = ox('arena', '--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /the same task, several models, one winner/);
  assert.match(ox('arena', 'fix it', '--bots', 'only-one').out, /at least two bots/);
});
