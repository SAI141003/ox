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
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(holds(), 'caffeinate is waiting on the ox process');
  await new Promise((r) => p.on('close', r));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(holds(), '', 'and it is gone once ox exits');
});
