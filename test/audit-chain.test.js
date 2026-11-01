import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// In a child process with its own HOME: the log's path is fixed when config.js loads.
function inHome(home, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, OX_HOME: path.join(home, '.ox'), NODE_TEST_CONTEXT: '' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const url = new URL('../src/audit.js', import.meta.url).href;

test('the audit log is a chain: an edited, removed or inserted row is caught at that row', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-audit-'));
  inHome(home, `const A = await import(${JSON.stringify(url)}); for (let i = 0; i < 5; i++) { const r = A.recordDecision({ tool: 'bash', args: { i } }); A.recordOutcome({ ref: r, ok: true, error: 'ignored output' }); } console.log(JSON.stringify(1));`);
  const file = path.join(home, '.ox', 'audit.jsonl');
  const verify = () => inHome(home, `const A = await import(${JSON.stringify(url)}); console.log(JSON.stringify(A.verifyAudit()));`);
  const good = verify();
  assert.equal(good.ok, true);
  assert.equal(good.chained, 10);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ignored output'), 'a success keeps no output');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  // Edited: a deny turned into an allow (or any change).
  const edited = [...lines]; edited[4] = edited[4].replace('"tool":"bash"', '"tool":"read_file"');
  fs.writeFileSync(file, `${edited.join('\n')}\n`);
  assert.deepEqual([verify().ok, verify().brokenAt], [false, 5]);
  // Removed.
  fs.writeFileSync(file, `${[...lines.slice(0, 3), ...lines.slice(4)].join('\n')}\n`);
  assert.deepEqual([verify().ok, verify().brokenAt], [false, 4]);
  fs.rmSync(home, { recursive: true, force: true });
});
