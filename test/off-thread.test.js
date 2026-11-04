// Slow commands must not stop the server answering: the work runs on a worker thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(code) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30_000, cwd: ROOT });
}
const OT = JSON.stringify(path.join(ROOT, 'src/off-thread.js'));

test('work on the worker returns its answer, and the main thread keeps running meanwhile', () => {
  const r = run(`
    import { offThread } from ${OT};
    let ticks = 0; const t = setInterval(() => ticks++, 20);
    const v = await offThread('./usage-log.js', 'codeChanges', [{ days: 1, file: '/nonexistent' }]);
    clearInterval(t);
    console.log(JSON.stringify({ v, keys: typeof v }));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).keys, 'object');
});

test('a function that throws, or does not exist, rejects instead of hanging', () => {
  const r = run(`
    import { offThread } from ${OT};
    const a = await offThread('./usage-log.js', 'noSuchFunction').then(() => 'ok', (e) => 'rejected');
    console.log(a);
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rejected/);
});
