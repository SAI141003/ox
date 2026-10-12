// --backend docker (src/docker-backend.js + the bash tool). A stand-in docker
// (OX_DOCKER_BIN) records every call and runs `exec` commands in the mounted
// project, so the whole flow is checked without a Docker engine; a real engine
// is exercised at the end when one is running.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBackendSpec, containerCwd, dockerProblem, stopSession, DEFAULT_DOCKER_IMAGE } from '../src/docker-backend.js';
import { bashTool } from '../src/tools/exec.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-docker-')));
const log = path.join(tmp, 'docker.log');
const project = path.join(tmp, 'project');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'hello.txt'), 'hi from the project\n');
// A repository: the container mounts its root even when a command starts in a subfolder.
spawnSync('git', ['init', '-q', project]);

// The fake: `version` answers (or fails when FAKE_DOCKER_DOWN), `run` prints an
// id, `exec -w /workspace/x <id> sh -lc CMD` runs CMD in <mount>/x.
const fake = path.join(tmp, 'docker');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'version') { if (process.env.FAKE_DOCKER_DOWN) { console.error('Cannot connect to the Docker daemon'); process.exit(1); } console.log('27.0.0'); process.exit(0); }
if (a[0] === 'run') { const v = a[a.indexOf('-v') + 1]; fs.writeFileSync(${JSON.stringify(path.join(tmp, 'mount'))}, v.split(':/workspace')[0]); console.log('a1b2c3d4e5f6a1b2'); process.exit(0); }
if (a[0] === 'exec') {
  if (a[1] !== '-i') process.exit(0); // kill -TERM -1
  const mount = fs.readFileSync(${JSON.stringify(path.join(tmp, 'mount'))}, 'utf8');
  const w = a[a.indexOf('-w') + 1];
  const dir = path.join(mount, path.relative('/workspace', w));
  const r = spawnSync('sh', ['-c', a[a.length - 1]], { cwd: dir, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
process.exit(0);
`, { mode: 0o755 });

const saved = { bin: process.env.OX_DOCKER_BIN, down: process.env.FAKE_DOCKER_DOWN };
process.env.OX_DOCKER_BIN = fake;
after(() => {
  if (saved.bin === undefined) delete process.env.OX_DOCKER_BIN; else process.env.OX_DOCKER_BIN = saved.bin;
  delete process.env.FAKE_DOCKER_DOWN;
  fs.rmSync(tmp, { recursive: true, force: true });
});
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(log, { force: true });

test('backend specs: docker, docker:<image>, offline, and refusals', () => {
  assert.equal(parseBackendSpec(''), null);
  assert.equal(parseBackendSpec('local'), null);
  assert.deepEqual(parseBackendSpec('docker', {}), { kind: 'docker', image: DEFAULT_DOCKER_IMAGE, network: 'bridge', session: null });
  assert.equal(parseBackendSpec('docker:python:3.12-slim', {}).image, 'python:3.12-slim');
  assert.deepEqual(parseBackendSpec('docker:alpine:offline', {}), { kind: 'docker', image: 'alpine', network: 'none', session: null });
  assert.equal(parseBackendSpec('docker', { OX_DOCKER_IMAGE: 'ubuntu:24.04' }).image, 'ubuntu:24.04');
  assert.throws(() => parseBackendSpec('kubernetes'), /unknown backend/);
  assert.throws(() => parseBackendSpec('docker:bad image;rm'), /invalid image/);
});

test('host folders map to /workspace paths; outside the project is /workspace', () => {
  assert.equal(containerCwd('/p', '/p'), '/workspace');
  assert.equal(containerCwd('/p', '/p/src/lib'), '/workspace/src/lib');
  assert.equal(containerCwd('/p', '/elsewhere'), '/workspace');
});

test('bash runs in one container per session, with the project mounted', async () => {
  reset();
  const backend = parseBackendSpec('docker', {});
  const ctx = { cwd: path.join(project, 'src'), backend, yolo: true };
  const first = await bashTool({ command: 'cat hello.txt && pwd' }, ctx);
  assert.notEqual(first.isError, true, first.content);
  assert.match(first.content, /hi from the project/);
  const second = await bashTool({ command: 'echo again' }, ctx);
  assert.match(second.content, /again/);

  const c = calls();
  const runs = c.filter((a) => a[0] === 'run');
  assert.equal(runs.length, 1, 'one container for the session');
  const run = runs[0];
  assert.ok(run.includes(`${project}:/workspace`), `mount: ${run.join(' ')}`);
  assert.ok(run.includes('--rm') && run.includes('sleep') && run.includes('infinity'));
  assert.equal(run[run.indexOf('--network') + 1], 'bridge');
  assert.ok(!run.some((x) => /\.ssh|HOME=/.test(x)), 'nothing else from the host is mounted or passed');
  const exec = c.find((a) => a[0] === 'exec');
  assert.equal(exec[exec.indexOf('-w') + 1], '/workspace/src', 'commands start in the matching folder');

  stopSession(backend);
  assert.deepEqual(calls().at(-1), ['rm', '-f', 'a1b2c3d4e5f6a1b2']);
  assert.equal(backend.session, null);
});

test('parallel first commands (subagents) still start only one container', async () => {
  reset();
  const backend = parseBackendSpec('docker', {});
  const ctx = { cwd: project, backend, yolo: true };
  const outs = await Promise.all([1, 2, 3, 4].map((n) => bashTool({ command: `echo run${n}` }, ctx)));
  outs.forEach((o, i) => assert.match(o.content, new RegExp(`run${i + 1}`)));
  assert.equal(calls().filter((a) => a[0] === 'run').length, 1);
  stopSession(backend);
});

test('Docker not running: a clear, actionable error and nothing started', async () => {
  reset();
  process.env.FAKE_DOCKER_DOWN = '1';
  try {
    assert.match(dockerProblem(), /not running: start Docker Desktop/);
    const r = await bashTool({ command: 'echo nope' }, { cwd: project, backend: parseBackendSpec('docker', {}), yolo: true });
    assert.equal(r.isError, true);
    assert.match(r.content, /docker backend.*start Docker Desktop/);
    assert.equal(calls().filter((a) => a[0] === 'run').length, 0);
  } finally {
    delete process.env.FAKE_DOCKER_DOWN;
  }
});

test('the CLI refuses an unknown backend before doing anything', () => {
  const ox = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');
  const r = spawnSync(process.execPath, [ox, '-p', 'hi', '--backend', 'kubernetes'], { encoding: 'utf8', env: { ...process.env, OX_ISLAND: '0' } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unknown backend 'kubernetes'/);
});

// A real engine, when one is running: the container really is separate.
const realDocker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
test('real Docker: commands run in the container, files are shared', { skip: !realDocker && 'Docker engine not running' }, async () => {
  delete process.env.OX_DOCKER_BIN;
  const backend = parseBackendSpec('docker:alpine', {});
  try {
    const ctx = { cwd: project, backend, yolo: true, timeout_ms: 600_000 };
    const r = await bashTool({ command: 'cat /etc/os-release | head -1; cat src/hello.txt; echo made > from-container.txt' }, ctx);
    assert.match(r.content, /Alpine/);
    assert.match(r.content, /hi from the project/);
    assert.equal(fs.readFileSync(path.join(project, 'from-container.txt'), 'utf8'), 'made\n');
  } finally {
    stopSession(backend);
    process.env.OX_DOCKER_BIN = fake;
  }
});
