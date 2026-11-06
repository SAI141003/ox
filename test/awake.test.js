// ox keeps the computer awake while it works, with each OS's own mechanism,
// and lets go when it exits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inhibitCommand, parseDuration, lidHelp, awakeEnabled } from '../src/awake.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('each OS gets its own keep-awake command', () => {
  assert.deepEqual(inhibitCommand({ pid: 42, platform: 'darwin' }), ['caffeinate', ['-i', '-s', '-w', '42']]);
  assert.deepEqual(inhibitCommand({ secs: 60, platform: 'darwin' }), ['caffeinate', ['-i', '-s', '-t', '60']]);
  const linux = inhibitCommand({ pid: 42, platform: 'linux' });
  assert.equal(linux[0], 'systemd-inhibit');
  assert.ok(linux[1].includes('--what=idle:sleep:handle-lid-switch'));
  assert.match(linux[1].at(-1), /kill -0 42/);
  const win = inhibitCommand({ pid: 42, platform: 'win32' });
  assert.equal(win[0], 'powershell');
  assert.match(win[1].at(-1), /SetThreadExecutionState\(0x80000001\)[^]*Wait-Process -Id 42/);
  assert.equal(inhibitCommand({ pid: 1, platform: 'aix' }), null);
  assert.ok(lidHelp('win32').some((l) => /LIDACTION/.test(l)));
  assert.ok(lidHelp('darwin').some((l) => /disablesleep 0/.test(l)), 'the undo is always shown');
});

test('durations, and the off switch', () => {
  assert.equal(parseDuration('45m'), 2700);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('30'), 1800, 'bare numbers are minutes');
  assert.equal(parseDuration('8d'), null, 'at most a week');
  assert.equal(parseDuration('soon'), null);
  assert.equal(awakeEnabled({}, { OX_NO_AWAKE: '1' }), false);
  assert.equal(awakeEnabled({ awake: false }, {}), false);
});

// A slow provider, so the run is alive long enough to look at.
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }, 1500));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

test('a running ox holds the Mac awake, and the hold ends with it', { skip: process.platform !== 'darwin' }, async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-awake-')), OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
  const p = spawn(process.execPath, [OX, '--bot', 'custom:m', '-p', 'hi'], { cwd: os.tmpdir(), env });
  const holds = () => spawnSync('pgrep', ['-f', `caffeinate -i -s -w ${p.pid}$`], { encoding: 'utf8' }).stdout.trim();
  // Polled, not a fixed wait: a slow runner (CI's Intel Mac) takes over a second to start ox.
  let exited = false;
  const closed = new Promise((r) => p.on('close', () => { exited = true; r(); }));
  let seen = '';
  for (let i = 0; i < 150 && !seen && !exited; i++) { seen = holds(); if (!seen) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(seen, 'caffeinate is waiting on the ox process');
  await closed;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(holds(), '', 'and it is gone once ox exits');
});

test('lid closed: one password window, sleep off, and the undo scheduled in the same script', async () => {
  const aw = await import('../src/awake.js');
  const script = aw.lidScript(7200, { stop: "/Users/a b/.ox/lid'stop" });
  assert.match(script, /^pmset -a disablesleep 1 && \(\/bin\/sh -c '/);
  assert.match(script, /pmset -a disablesleep 0/);
  assert.match(script, /\+ 7200 \)\)/);
  assert.match(script, /Battery Power/);
  // The watcher only tests the stop file; root never writes or removes a file of yours.
  assert.doesNotMatch(script, /\brm\b|>\s*'\/Users/);
  assert.ok(script.includes(`'\\''`), 'quotes in a path are escaped for the shell');
  const as = aw.lidAppleScript('echo "x" \\ y');
  assert.equal(as, 'do shell script "echo \\"x\\" \\\\ y" with administrator privileges');
  assert.throws(() => aw.lidScript(0), /1 second to 7 days/);
  assert.throws(() => aw.lidScript(8 * 86400), /1 second to 7 days/);
});

test('lid closed: a cancelled password window changes nothing, and the status reads pmset', async () => {
  const aw = await import('../src/awake.js');
  if (process.platform !== 'darwin') return;
  assert.throws(() => aw.startLid(60, { run: () => ({ status: 1, stderr: 'execution error: User canceled. (-128)' }) }), /cancelled: sleep is unchanged/);
  assert.deepEqual(aw.lidStatus({ pm: ' SleepDisabled\t\t1\n' }).stale, true);
  assert.equal(aw.lidStatus({ pm: ' sleep 1\n' }).sleepDisabled, false);
});
