import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reserveFreePort } from './helpers/free-port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OX_BIN = path.join(__dirname, '..', 'bin', 'ox.js');

function ox(args, env = {}) {
  return spawnSync('node', [OX_BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [OX_BIN, 'serve', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, ...env },
    });
    let output = '';
    let resolved = false;
    proc.stdout?.on('data', (data) => { output += data.toString(); checkReady(); });
    proc.stderr?.on('data', (data) => { output += data.toString(); checkReady(); });
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Server exited early (code ${code}): ${output}`));
      }
    });

    function checkReady() {
      if (resolved) return;
      if (output.includes('listening on')) {
        resolved = true;
        clearInterval(timer);
        resolve({ proc, output });
      }
    }

    const maxWait = 15000;
    const interval = 200;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += interval;
      checkReady();
      if (elapsed >= maxWait && !resolved) {
        resolved = true;
        clearInterval(timer);
        proc.kill();
        reject(new Error(`Server didn't start within ${maxWait}ms: ${output}`));
      }
    }, interval);
    checkReady();
  });
}

async function stopServer(server) {
  try { server.proc.kill('SIGTERM'); } catch {}
  await new Promise(r => setTimeout(r, 300));
}

async function withServer(port, env, fn) {
  let server;
  try {
    server = await startServer(port, env);
    return await fn(server);
  } finally {
    if (server) try { stopServer(server); } catch {}
  }
}

test('serve: health endpoint returns ok', async () => {
  const port = await reserveFreePort();
  await withServer(port, {}, async (server) => {
    const health = spawnSync('curl', ['-s', `http://localhost:${port}/health`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(health.status, 0);
    const data = JSON.parse(health.stdout.trim());
    assert.equal(data.status, 'ok');
    assert.ok(data.timestamp);
  });
});

test('serve: chat completions works without auth when no key set', async () => {
  const port = await reserveFreePort();
  await withServer(port, {}, async (server) => {
    const resp = spawnSync('curl', [
      '-s', '-X', 'POST', `http://localhost:${port}/v1/chat/completions`,
      '-H', 'Content-Type: application/json',
      '-d', '{"model":"ox","messages":[{"role":"user","content":"hi"}]}'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(resp.status, 0);
    const data = JSON.parse(resp.stdout.trim());
    assert.ok(data.choices, 'no choices in response');
    assert.ok(data.choices[0], 'no first choice');
  });
});

test('serve: chat completions rejects without auth when key set', async () => {
  const port = await reserveFreePort();
  await withServer(port, { OX_SERVE_API_KEY: 'test-secret-key-12345' }, async (server) => {
    const resp = spawnSync('curl', [
      '-s', '-X', 'POST', `http://localhost:${port}/v1/chat/completions`,
      '-H', 'Content-Type: application/json',
      '-d', '{"model":"ox","messages":[{"role":"user","content":"hi"}]}'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(resp.status, 0);
    const data = JSON.parse(resp.stdout.trim());
    assert.equal(data.error?.type, 'authentication_error');
  });
});

test('serve: chat completions accepts with correct Bearer token', async () => {
  const port = await reserveFreePort();
  await withServer(port, { OX_SERVE_API_KEY: 'test-secret-key-12345' }, async (server) => {
    const resp = spawnSync('curl', [
      '-s', '-X', 'POST', `http://localhost:${port}/v1/chat/completions`,
      '-H', 'Content-Type: application/json',
      '-H', 'Authorization: Bearer test-secret-key-12345',
      '-d', '{"model":"ox","messages":[{"role":"user","content":"hi"}]}'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(resp.status, 0);
    const data = JSON.parse(resp.stdout.trim());
    assert.ok(data.choices, 'no choices with auth');
  });
});

test('serve: wrong Bearer token rejected', async () => {
  const port = await reserveFreePort();
  await withServer(port, { OX_SERVE_API_KEY: 'test-secret-key-12345' }, async (server) => {
    const resp = spawnSync('curl', [
      '-s', '-X', 'POST', `http://localhost:${port}/v1/chat/completions`,
      '-H', 'Content-Type: application/json',
      '-H', 'Authorization: Bearer wrong-key',
      '-d', '{"model":"ox","messages":[{"role":"user","content":"hi"}]}'
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(resp.status, 0);
    const data = JSON.parse(resp.stdout.trim());
    assert.equal(data.error?.type, 'authentication_error');
  });
});
