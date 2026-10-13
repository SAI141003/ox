// `ox -p` reads piped input from a shell pipe, but a parent that spawns ox and
// leaves stdin open and silent must not cost it a 10-second wait.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const bodies = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    bodies.push(b);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-stdin-h-')), OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-stdin-c-'));
const run = (cmd, args) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(cmd, args, { cwd, env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
});

test('a silent open stdin does not stall the run', async () => {
  const r = await run(process.execPath, [OX, '--bot', 'custom:m', '-p', 'hello']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ms < 5000, `took ${r.ms}ms`);
});

test('a shell pipe is still read into the prompt', async () => {
  bodies.length = 0;
  const r = await run('/bin/sh', ['-c', `printf 'PIPED-CONTEXT' | "${process.execPath}" "${OX}" --bot custom:m -p summarise`]);
  assert.equal(r.code, 0, r.out);
  assert.match(bodies.join('\n'), /PIPED-CONTEXT/);
});
