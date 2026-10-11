import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Deployer, formatDeployResult } from '../src/deploy.js';

// Exercise the real public methods, replacing only the process boundary.
// No deployment CLI, Docker daemon, network, or real child is invoked.
function fixture(t, execute = () => Buffer.from('ok\n')) {
  const cwd = mkdtempSync(join(tmpdir(), 'ox-deploy-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const deployer = new Deployer(cwd, {
    execFile(command, args, options) {
      calls.push({ command, args: [...args], options });
      return execute(command, args, options);
    },
  });
  return { cwd, calls, deployer };
}

test('deploy executes the selected command with separate arguments and cwd', (t) => {
  const { cwd, calls, deployer } = fixture(t, () => Buffer.from('Deployed https://app.example\n'));
  const result = deployer.deploy('githubPages');
  assert.equal(result.success, true);
  assert.equal(result.url, 'https://app.example');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh-pages');
  assert.deepEqual(calls[0].args, ['-d', 'dist']);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(calls[0].options.shell, undefined);
});

test('deploy surfaces a fake process failure without reporting success', (t) => {
  const { calls, deployer } = fixture(t, () => {
    throw Object.assign(new Error('command failed'), {
      status: 7, stdout: Buffer.from('partial output\n'), stderr: Buffer.from('build failed'),
    });
  });
  const result = deployer.deploy('docker');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args, ['build', '-t', 'app', '.']);
  assert.equal(result.success, false);
  assert.equal(result.url, null);
  assert.match(result.output, /partial output\nbuild failed/);
  assert.ok(Number.isFinite(result.duration) && result.duration >= 0);
});

test('status and list use their own operations, not deployment arguments', (t) => {
  const { calls, deployer } = fixture(t, () => Buffer.from('one\ntwo\n'));
  assert.deepEqual(deployer.getStatus('docker'), { target: 'docker', status: 'one\ntwo' });
  assert.deepEqual(deployer.getDeployments('docker'), { target: 'docker', deployments: ['one', 'two'] });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['docker', ['ps']], ['docker', ['ps', '-a']],
  ]);
});

test('status, rollback and list preserve process failures', (t) => {
  const { calls, deployer } = fixture(t, () => { throw new Error('mock unavailable'); });
  assert.deepEqual(deployer.getStatus('fly'), { target: 'fly', status: null, error: 'mock unavailable' });
  assert.deepEqual(deployer.rollback('fly'), { rolledBack: false, target: 'fly', error: 'mock unavailable' });
  assert.deepEqual(deployer.getDeployments('fly'), { target: 'fly', deployments: [], error: 'mock unavailable' });
  assert.equal(calls.length, 3);
});

test('unsupported and unknown operations do not execute any process', (t) => {
  const { calls, deployer } = fixture(t);
  assert.match(deployer.getStatus('githubPages').error, /not supported/);
  assert.equal(deployer.rollback('netlify').rolledBack, false);
  assert.match(deployer.getDeployments('githubPages').error, /not supported/);
  assert.throws(() => deployer.deploy('nope'), /Unknown target/);
  assert.equal(calls.length, 0);
});

function previewFixture(t) {
  const { cwd } = fixture(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  const kills = [];
  child.kill = (signal) => { kills.push(signal); return true; };
  const calls = [];
  const deployer = new Deployer(cwd, {
    execFile() { assert.fail('preview must not synchronously execute a command'); },
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  t.after(() => { child.stdout.destroy(); child.stderr.destroy(); });
  return { deployer, child, calls, kills, cwd };
}

test('preview readiness is exercised through Deployer.preview with a fake child', async (t) => {
  const { deployer, child, calls, cwd } = previewFixture(t);
  let settled = false;
  const pending = deployer.preview('vercel', { timeoutMs: 1000 });
  pending.then(() => { settled = true; }, () => { settled = true; });
  child.stdout.write('Starting...\n');
  await Promise.resolve();
  assert.equal(settled, false, 'ordinary output is not readiness');
  child.stdout.write('Ready at http://localhost:3000\n');
  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.url, 'http://localhost:3000');
  assert.equal(result.pid, child.pid);
  assert.equal(result.process, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'vercel');
  assert.deepEqual(calls[0].args, ['dev', '--listen', '3000']);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(calls[0].options.env.PORT, '3000');
});

test('preview rejects child startup errors through its public API', async (t) => {
  const { deployer, child } = previewFixture(t);
  const pending = deployer.preview('vercel', { timeoutMs: 1000 });
  const check = assert.rejects(pending, /mock spawn failed/);
  child.emit('error', new Error('mock spawn failed'));
  await check;
});

test('preview rejects early exit without a fabricated URL', async (t) => {
  const { deployer, child } = previewFixture(t);
  const pending = deployer.preview('vercel', { timeoutMs: 1000 });
  const check = assert.rejects(pending, /exited early with code 7/);
  child.emit('close', 7);
  await check;
});

test('preview timeout terminates the fake child and rejects', async (t) => {
  const { deployer, kills } = previewFixture(t);
  await assert.rejects(deployer.preview('vercel', { timeoutMs: 10 }), /no readiness signal/);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('preview refuses targets without a dedicated preview operation', async (t) => {
  const { deployer, calls } = previewFixture(t);
  for (const target of ['docker', 'githubPages', 'render', 'fly']) {
    await assert.rejects(deployer.preview(target), /not supported/);
  }
  assert.equal(calls.length, 0);
});

test('preview validates options before spawning and uses netlify dev port arguments', async (t) => {
  const { deployer, calls, child } = previewFixture(t);
  for (const port of [0, -1, 65536, 2.5, 'invalid']) {
    await assert.rejects(deployer.preview('netlify', { port }), /port/);
  }
  for (const timeoutMs of [0, -1, Infinity, 'invalid']) {
    await assert.rejects(deployer.preview('netlify', { timeoutMs }), /timeout/);
  }
  assert.equal(calls.length, 0);
  const pending = deployer.preview('netlify', { port: 4321 });
  assert.deepEqual(calls[0].args, ['dev', '--port', '4321']);
  child.stdout.write('Server now ready on http://localhost:4321\n');
  assert.equal((await pending).port, 4321);
});

test('preview ignores incidental URLs and buffers split readiness lines', async (t) => {
  const { deployer, child } = previewFixture(t);
  let settled = false;
  const pending = deployer.preview('vercel');
  pending.then(() => { settled = true; }, () => { settled = true; });
  child.stderr.write('Documentation: https://example.com/help\n');
  child.stdout.write('Ready at https://example.com:3000\n');
  child.stdout.write('Ready at http://localhost:9999\n');
  child.stdout.write('Ready at http://local');
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdout.write('host:3000\n');
  assert.equal((await pending).url, 'http://localhost:3000');
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
});

test('preview handles synchronous spawn throws without claiming readiness', async (t) => {
  const { cwd } = fixture(t);
  const deployer = new Deployer(cwd, { spawnProcess() { throw new Error('spawn refused'); } });
  await assert.rejects(deployer.preview('vercel'), /spawn refused/);
});

test('target listing and formatting do not execute processes', (t) => {
  const { calls, deployer } = fixture(t);
  const targets = deployer.listTargets();
  assert.equal(targets.length, 6);
  assert.deepEqual(targets.find(({ id }) => id === 'githubPages').operations, ['deploy']);
  assert.match(formatDeployResult({ success: false, error: 'boom' }), /Success: no\nError: boom/);
  assert.match(formatDeployResult({ ready: true, url: 'https://app.example' }), /Ready: yes/);
  assert.equal(calls.length, 0);
});
