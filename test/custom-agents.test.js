// Your own agents: `ox agent new` saves a bot, a mode and instructions, and
// `ox --agent <name>` really runs with all three (checked at the model and at
// the tool gate, not just printed back).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const seen = [];
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    seen.push(j);
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((j.messages ?? []).some((m) => m.role === 'tool')) {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } else {
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'x' }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agents-home-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agents-proj-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
const oxSync = (...a) => {
  const r = spawnSync(process.execPath, [OX, ...a], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
const oxAsync = (...a) => new Promise((resolve) => {
  const p = spawn(process.execPath, [OX, ...a], { cwd, env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

test('agent new validates its bot, mode and name', () => {
  assert.match(oxSync('agent', 'new', 'bad name').out, /letters, digits/);
  assert.match(oxSync('agent', 'new', 'r', '--mode', 'wizard').out, /--mode must be one of/);
  assert.match(oxSync('agent', 'new', 'r', '--bot', 'nosuchprovider:x').out, /--bot nosuchprovider:x: .*unknown bot or provider/);
  assert.equal(fs.existsSync(path.join(home, '.ox', 'agents', 'r.json')), false);
});

test('an agent runs on its bot, in its mode, with its instructions', async () => {
  const made = oxSync('agent', 'new', 'reviewer', '--bot', 'custom:review-model', '--mode', 'ask', '--prompt', 'Always cite file:line. PERSONA-MARK', '--description', 'reads diffs');
  assert.equal(made.code, 0, made.out);
  assert.match(oxSync('agent', 'list').out, /reviewer\s+custom:review-model\s+ask\s+reads diffs/);
  seen.length = 0;
  const r = await oxAsync('--agent', 'reviewer', '-y', '-p', 'look at x');
  const first = seen[0];
  assert.equal(first.model, 'review-model', 'the agent picked the bot');
  assert.match(JSON.stringify(first.messages), /PERSONA-MARK/, 'its instructions reach the model');
  const toolMsg = seen.flatMap((j) => j.messages ?? []).find((m) => m.role === 'tool');
  assert.match(String(toolMsg?.content), /ask mode only reads/, `its mode is enforced\n${r.out}`);
  assert.equal(fs.existsSync(path.join(cwd, 'x.txt')), false);
});

test('flags still win over the agent, and a missing agent is an error', async () => {
  seen.length = 0;
  await oxAsync('--agent', 'reviewer', '--mode', 'code', '--bot', 'custom:other', '-y', '-p', 'go');
  assert.equal(seen[0].model, 'other');
  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'x');
  const r = oxSync('--agent', 'ghost', '-p', 'go');
  assert.equal(r.code, 3);
  assert.match(r.out, /no agent 'ghost'/);
});
