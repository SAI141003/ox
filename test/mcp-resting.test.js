// A connector that failed to start recently is left alone by runs: one that
// was never signed in used to open a browser sign-in on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mcp-rest-'));
process.env.OX_HOME = home;
const { McpHub } = await import('../src/mcp.js');

test('a run does not start a connector that failed in the last 6 hours; an older failure is retried', async () => {
  const marker = path.join(home, 'started.txt');
  const cfg = { command: process.execPath, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x')`] };
  fs.writeFileSync(path.join(home, 'mcp-health.json'), JSON.stringify({ recent: { at: Date.now() - 60_000, status: 'timeout' }, old: { at: Date.now() - 7 * 3_600_000, status: 'timeout' } }));
  const hub = new McpHub({ recent: cfg }, { fastStart: true, startupTimeoutMs: 2000 });
  await hub.start({ waitMs: 500 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), false, 'the resting connector was not started');
  const hub2 = new McpHub({ old: cfg }, { fastStart: true, startupTimeoutMs: 2000 });
  await hub2.start({ waitMs: 1500 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(marker), true, 'a failure from 7 hours ago is tried again');
  await hub.stop?.(); await hub2.stop?.();
});
