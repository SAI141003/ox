// --backend ssh:user@host (src/ssh-backend.js + the bash tool). A stand-in ssh
// (OX_SSH_BIN) records every call and runs the remote command here, with a
// folder standing in for the host's home, so the flow is checked with no host.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The stand-in is a shell script, which Windows cannot run.
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

const realHome = process.env.HOME;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ssh-')));
process.env.HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
const remoteHome = path.join(tmp, 'remote-home');
fs.mkdirSync(path.join(remoteHome, 'proj'), { recursive: true });
fs.writeFileSync(path.join(remoteHome, 'proj', 'where.txt'), 'on the host\n');
const log = path.join(tmp, 'ssh.log');
const fake = path.join(tmp, 'ssh');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (process.env.FAKE_SSH_FAIL) { console.error(process.env.FAKE_SSH_FAIL); process.exit(255); }
if (a.includes('-O')) process.exit(0);
const i = a.indexOf('--');
const r = spawnSync('sh', ['-c', a[i + 1]], { cwd: ${JSON.stringify(remoteHome)}, env: { PATH: process.env.PATH, HOME: ${JSON.stringify(remoteHome)} }, stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
const savedBin = process.env.OX_SSH_BIN;
process.env.OX_SSH_BIN = fake;
after(() => {
  if (savedBin === undefined) delete process.env.OX_SSH_BIN; else process.env.OX_SSH_BIN = savedBin;
  delete process.env.FAKE_SSH_FAIL;
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { parseSshSpec, sshProblem, sshOptions, closeSshSession, sshNote, explainSshFailure, shq } = await import('../src/ssh-backend.js');
const { parseBackendSpec } = await import('../src/docker-backend.js');
const { bashTool } = await import('../src/tools/exec.js');
const { normalizeAgentBackend } = await import('../src/agents.js');
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(log, { force: true });

test('ssh specs: host, user, port, folder, and what is refused', () => {
  assert.deepEqual(parseBackendSpec('ssh:dev@box.example'), { kind: 'ssh', dest: 'dev@box.example', port: null, dir: '~', session: null });
  assert.deepEqual(parseSshSpec('ssh:gpu:/srv/work dir'), { kind: 'ssh', dest: 'gpu', port: null, dir: '/srv/work dir', session: null });
  assert.deepEqual(parseSshSpec('ssh:dev@10.0.0.5:2222:~/proj'), { kind: 'ssh', dest: 'dev@10.0.0.5', port: 2222, dir: '~/proj', session: null });
  // Nothing ssh could read as an option, and nothing a shell could run.
  assert.throws(() => parseSshSpec('ssh:-oProxyCommand=evil'), /invalid ssh destination/);
  assert.throws(() => parseSshSpec('ssh:dev@-box'), /invalid ssh destination/);
  assert.throws(() => parseSshSpec('ssh:dev@box;rm -rf ~'), /invalid ssh destination/);
  assert.throws(() => parseSshSpec('ssh:box:/srv/$(id)'), /invalid remote directory/);
  assert.throws(() => parseSshSpec('ssh:box:/srv/../etc'), /invalid remote directory/);
  assert.throws(() => parseSshSpec('ssh:box:relative/dir'), /invalid remote directory/);
  assert.throws(() => parseSshSpec('ssh:box:99999:/srv'), /invalid ssh port/);
  assert.equal(normalizeAgentBackend('ssh:dev@box:~/proj'), 'ssh:dev@box:~/proj');
  assert.throws(() => normalizeAgentBackend('ssh:-x'), /invalid ssh destination/);
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('ox never accepts a host key and never asks for a password', () => {
  const o = sshOptions(parseSshSpec('ssh:dev@box:2222:/srv'));
  assert.ok(o.includes('BatchMode=yes'));
  assert.ok(!o.some((x) => /StrictHostKeyChecking|UserKnownHostsFile/i.test(x)), 'host keys are checked the way your ssh is set up');
  assert.deepEqual(o.slice(-2), ['-p', '2222']);
  const control = o.find((x) => x.startsWith('ControlPath='));
  assert.ok(control.includes(path.join(process.env.HOME, '.ox', 'ssh')), 'the shared connection lives under ~/.ox');
  assert.equal(fs.statSync(path.join(process.env.HOME, '.ox', 'ssh')).mode & 0o077, 0, 'only you can use it');
});

test('bash runs on the host, in the folder, over one opened session', async () => {
  reset();
  const backend = parseSshSpec('ssh:dev@box:~/proj');
  const ctx = { cwd: tmp, backend, yolo: true };
  const first = await bashTool({ command: `cat where.txt && pwd && echo "it's $((1+1))"` }, ctx);
  assert.notEqual(first.isError, true, first.content);
  assert.match(first.content, /on the host/);
  assert.match(first.content, new RegExp(path.join(remoteHome, 'proj').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(first.content, /it's 2/, 'quotes in a command survive');
  const failed = await bashTool({ command: 'exit 7' }, ctx);
  assert.match(failed.content, /7/);
  const c = calls();
  assert.equal(c.filter((a) => a.at(-1).endsWith('&& pwd')).length, 1, 'the folder is checked once');
  for (const a of c) {
    assert.equal(a[a.indexOf('--') - 1], 'dev@box');
    assert.ok(!a.some((x) => x.includes(process.env.HOME) && !x.startsWith('ControlPath=')), 'nothing from this machine is sent');
  }
  assert.equal(fs.readdirSync('/tmp').filter((f) => f.startsWith(`ox-ssh-${process.pid}-`)).length, 0, 'a finished command leaves nothing behind');
  assert.match(sshNote(backend), /dev@box[\s\S]*THIS machine/);
  closeSshSession(backend);
  assert.deepEqual(calls().at(-1).slice(-3), ['-O', 'exit', 'dev@box']);
  assert.equal(backend.session, null);
});

test('a host that cannot be used says what to do', async () => {
  const backend = parseSshSpec('ssh:dev@newbox');
  process.env.FAKE_SSH_FAIL = 'Host key verification failed.';
  assert.match(sshProblem(backend), /does not accept a host key for you[\s\S]*ssh dev@newbox/);
  const r = await bashTool({ command: 'echo hi' }, { cwd: tmp, backend, yolo: true });
  assert.equal(r.isError, true);
  assert.match(r.content, /ssh backend/);
  process.env.FAKE_SSH_FAIL = 'dev@newbox: Permission denied (publickey).';
  assert.match(sshProblem(backend), /never asks for a password/);
  delete process.env.FAKE_SSH_FAIL;
  assert.match(explainSshFailure(parseSshSpec('ssh:b:/nope'), 'sh: line 0: cd: /nope: No such file or directory'), /does not exist on b/);
  assert.match(sshProblem(parseSshSpec('ssh:dev@box:/definitely/not/here')), /does not exist/);
  process.env.OX_SSH_BIN = path.join(tmp, 'no-ssh-here');
  assert.match(sshProblem(parseSshSpec('ssh:dev@box')), /ssh is not installed/);
  process.env.OX_SSH_BIN = fake;
});

test('a command that runs too long is stopped on the host too', async () => {
  reset();
  const backend = parseSshSpec('ssh:dev@box:~/proj');
  const marker = path.join(remoteHome, 'proj', 'still-running');
  const r = await bashTool({ command: `sleep 30; touch ${marker}`, timeout_ms: 1500 }, { cwd: tmp, backend, yolo: true });
  assert.match(r.content, /timed out|timeout/i);
  assert.ok(calls().some((a) => /kill -TERM/.test(a.at(-1))), 'the host was told to stop it');
  assert.equal(fs.existsSync(marker), false);
  closeSshSession(backend);
});
