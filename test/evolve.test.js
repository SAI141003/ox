// ox evolve: crashes are remembered without secrets, grouped by cause, and an
// attempt is kept only when it measured better.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_SELF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-self-'));
const E = await import('../src/evolve.js');

test('a crash is recorded without its secrets and grouped by cause', async () => {
  await E.recordFailure({ command: ['chat', 'sk-abc123secretsecretsecret'], error: new Error('read /Users/me/a.txt failed 42') });
  await E.recordFailure({ command: ['chat'], error: new Error('read /Users/you/b.txt failed 7') });
  const raw = fs.readFileSync(path.join(process.env.OX_SELF_HOME, 'failures.jsonl'), 'utf8');
  assert.equal(raw.includes('sk-abc123'), false);
  const f = E.failures();
  assert.equal(f.length, 1);
  assert.equal(f[0].count, 2);
  assert.match(f[0].sig, /read <path> failed N/);
});

test('kept only when measured better', () => {
  const before = { ok: true, pass: 10, fail: 1, failing: ['a'] };
  assert.equal(E.judge(before, { ok: true, pass: 11, fail: 1, failing: ['a'] }, { diffFiles: ['x.js'] }).accept, true);
  assert.equal(E.judge(before, { ok: true, pass: 11, fail: 2, failing: ['a', 'b'] }, { diffFiles: ['x.js'] }).accept, false);
  assert.equal(E.judge(before, { ok: true, pass: 10, fail: 1, failing: ['a'] }, { diffFiles: ['x.js'] }).accept, false);
  assert.equal(E.judge(before, { ok: true, pass: 12, fail: 0, failing: [] }, { diffFiles: [] }).accept, false);
  assert.equal(E.judge(before, { ok: false }, { diffFiles: ['x.js'] }).accept, false);
});

test('reads the verify report', () => {
  const r = E.parseVerify('noise\n{"results":[{"stage":"unit","detail":"5 pass · 2 fail · 0 cancelled\\n  - t one\\n  - t two"}]}');
  assert.deepEqual([r.pass, r.fail, r.failing], [5, 2, ['t one', 't two']]);
});
