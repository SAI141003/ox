// Opening OX left extra servers running: callers that overlapped each started one
// on the next port, and only the last was remembered. These run the real server start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = `
  import { ensureServer } from ${JSON.stringify(path.join(ROOT, 'src/app.js'))};
  const all = await Promise.all([1, 2, 3].map(() => ensureServer({ cwd: process.env.HOME })));
  console.log(JSON.stringify(all.map((s) => s.pid)));
`;

test('callers that overlap share one server, and the lock is let go', { timeout: 60_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-one-server-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, OX_HOME: path.join(home, '.ox'), OX_MESH: '0' };
  delete env.NODE_TEST_CONTEXT;
  let pids = [];
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { env, encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stderr);
    pids = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(new Set(pids).size, 1, `one server, got ${pids}`);
    assert.equal(fs.existsSync(path.join(home, '.ox', 'app.json.lock')), false);
  } finally {
    for (const p of new Set(pids)) { try { process.kill(p); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a lock left by a process that died does not hold the next open', { timeout: 60_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-one-server-'));
  fs.mkdirSync(path.join(home, '.ox'));
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(home, '.ox', 'app.json.lock'), dead);
  const env = { ...process.env, HOME: home, USERPROFILE: home, OX_HOME: path.join(home, '.ox'), OX_MESH: '0' };
  delete env.NODE_TEST_CONTEXT;
  let pids = [];
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { env, encoding: 'utf8', timeout: 50_000 });
    assert.equal(r.status, 0, r.stderr);
    pids = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(new Set(pids).size, 1);
  } finally {
    for (const p of new Set(pids)) { try { process.kill(p); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
