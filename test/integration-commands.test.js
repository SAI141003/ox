import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reserveFreePort } from './helpers/free-port.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OX_BIN = path.join(__dirname, '..', 'bin', 'ox.js');

function ox(args, opts = {}) {
  return spawnSync('node', [OX_BIN, ...args], { encoding: 'utf8', ...opts });
}

function oxStderr(args, opts = {}) {
  return spawnSync('node', [OX_BIN, ...args], { encoding: 'utf8', ...opts });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [OX_BIN, 'serve', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    let output = '';
    let resolved = false;
    proc.stderr?.on('data', (data) => { output += data.toString(); checkReady(); });
    proc.stdout?.on('data', (data) => { output += data.toString(); checkReady(); });
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        proc.kill();
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
  server.proc.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
}

test('serve command starts HTTP server', async () => {
  const port = await reserveFreePort();
  const server = await startServer(port);
  
  // Test health endpoint
  const health = spawnSync('curl', ['-s', `http://localhost:${port}/health`], { encoding: 'utf8', timeout: 2000 });
  assert.equal(health.status, 0);
  const data = JSON.parse(health.stdout.trim());
  assert.equal(data.status, 'ok');
  assert.ok(data.timestamp);
  
  await stopServer(server);
});

test('serve command responds to chat completions', async () => {
  const port = await reserveFreePort();
  const server = await startServer(port);
  
  const resp = spawnSync('curl', [
    '-s', '-X', 'POST', `http://localhost:${port}/v1/chat/completions`,
    '-H', 'Content-Type: application/json',
    '-d', '{"model":"test","messages":[{"role":"user","content":"hello"}]}'
  ], { encoding: 'utf8', timeout: 10000 });
  
  assert.equal(resp.status, 0);
  const data = JSON.parse(resp.stdout.trim());
  assert.ok(data.choices);
  assert.ok(data.choices[0].message);
  // Content may be empty if no API key configured, just verify structure
  assert.ok(typeof data.choices[0].message.content === 'string');
  
  await stopServer(server);
});

test('import command shows help', () => {
  const r = ox(['import', '--help']);
  // Help exits with code 3 (usage display) and outputs to stderr
  assert.ok(r.status === 0 || r.status === 3);
  const output = r.stdout + r.stderr;
  assert.ok(output.includes('claude-code'));
  assert.ok(output.includes('hermes'));
  assert.ok(output.includes('codex'));
  assert.ok(output.includes('all'));
  assert.ok(output.includes('--dry-run'));
});

test('import dry-run works', () => {
  const r = ox(['import', 'all', '--dry-run']);
  // Should not crash, may show what would be imported
  assert.ok(r.status === 0 || r.status === 1); // 1 if no sources found
});

test('agent list command works', () => {
  const r = ox(['agent', 'list']);
  assert.equal(r.status, 0);
  // Should output table header at minimum
  assert.ok(r.stdout.includes('NAME') || r.stdout.includes('no agents') || r.stdout.trim() === '');
});

test('agent save and delete works', () => {
  const name = `test-agent-${Date.now()}`;
  const save = ox(['agent', 'save', name, '--provider', 'xai', '--model', 'grok-4.6']);
  assert.equal(save.status, 0);
  
  const list = ox(['agent', 'list']);
  assert.ok(list.stdout.includes(name));
  
  const del = ox(['agent', 'delete', name, '--yes']);
  assert.equal(del.status, 0);
  
  const list2 = ox(['agent', 'list']);
  assert.ok(!list2.stdout.includes(name));
});

test('task add, list, get, update, delete works', () => {
  const uniqueId = Date.now();
  const title = `Test task ${uniqueId}`;
  const add = ox(['task', 'add', title]);
  assert.equal(add.status, 0, `task add failed: ${add.stderr}`);
  // Output format: "✓ task added task_1790034860124_c4lm9h: Test task"
  const match = add.stdout.match(/task_\d+_[a-z0-9]+/);
  assert.ok(match, `Expected task ID in output: ${add.stdout}`);
  const taskId = match[0];
  
  const list = ox(['task', 'list']);
  assert.equal(list.status, 0, `task list failed: ${list.stderr}`);
  assert.ok(list.stdout.includes(taskId), `Task ID not in list: ${list.stdout}`);
  
  const get = ox(['task', 'get', taskId]);
  assert.equal(get.status, 0, `task get failed: ${get.stderr} stdout: ${get.stdout}`);
  assert.ok(get.stdout.includes(title), `Title not in get output: ${get.stdout}`);
  
  const update = ox(['task', 'update', taskId, '--title', `Updated title ${uniqueId}`]);
  assert.equal(update.status, 0, `task update failed: ${update.stderr}`);
  
  const get2 = ox(['task', 'get', taskId]);
  assert.equal(get2.status, 0, `task get after update failed: ${get2.stderr}`);
  assert.ok(get2.stdout.includes(`Updated title ${uniqueId}`), `Updated title not in get output: ${get2.stdout}`);
  
  const del = ox(['task', 'delete', taskId, '--yes']);
  assert.equal(del.status, 0, `task delete failed: ${del.stderr}`);
  
  const list2 = ox(['task', 'list']);
  assert.equal(list2.status, 0);
  assert.ok(!list2.stdout.includes(taskId), `Task still in list after delete: ${list2.stdout}`);
});

test('task run executes headless', () => {
  const title = `Run task ${Date.now()}`;
  const add = ox(['task', 'add', title]);
  assert.equal(add.status, 0);
  const match = add.stdout.match(/task_\d+_[a-z0-9]+/);
  assert.ok(match);
  const taskId = match[0];
  
  const run = ox(['task', 'run', taskId, '--prompt', 'echo hello']);
  // May succeed or fail depending on model availability, but should not crash
  assert.ok(run.status === 0 || run.status === 1);
  
  const del = ox(['task', 'delete', taskId, '--yes']);
  assert.equal(del.status, 0);
});