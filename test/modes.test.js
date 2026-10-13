// Modes are enforced where tools run: ask cannot write, plan writes only plan
// files, and auto names the mode it picked for each message.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyMode, modeRefusal, resolveTurnMode, normalizeMode } from '../src/modes.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('auto routes each message to the mode it reads as', () => {
  assert.equal(classifyMode('the login page crashes with a TypeError').mode, 'debug');
  assert.equal(classifyMode('what does src/router.js do?').mode, 'ask');
  assert.equal(classifyMode('plan the migration to postgres').mode, 'plan');
  assert.equal(classifyMode('rename the helper in every package in parallel').mode, 'orchestrate');
  assert.equal(classifyMode('add a --verbose flag to the cli').mode, 'code');
  assert.equal(classifyMode('analyze sales.csv and chart the monthly trend').mode, 'data');
  assert.deepEqual(resolveTurnMode('ask', 'fix the crash'), { mode: 'ask', routed: false, reason: null });
  assert.equal(resolveTurnMode('auto', 'fix the crash').routed, true);
  assert.equal(normalizeMode('Orchestrator'), 'orchestrate');
  assert.equal(normalizeMode('nope'), null);
});

test('the tool gate: ask reads only, plan writes only .agent/plans/*.md', () => {
  const cwd = '/repo';
  assert.equal(modeRefusal('ask', 'read_file', {}, cwd), null);
  assert.match(modeRefusal('ask', 'write_file', { path: 'a.js' }, cwd), /ask mode only reads/);
  assert.match(modeRefusal('ask', 'bash', { command: 'ls' }, cwd), /ask mode/);
  assert.equal(modeRefusal('plan', 'write_file', { path: '.agent/plans/db.md' }, cwd), null);
  assert.match(modeRefusal('plan', 'write_file', { path: 'src/a.js' }, cwd), /only writes plan files/);
  assert.match(modeRefusal('plan', 'write_file', { path: '.agent/plans/../../x.md' }, cwd), /only writes plan files/);
  assert.match(modeRefusal('plan', 'bash', {}, cwd), /read-only/);
  assert.equal(modeRefusal('debug', 'bash', {}, cwd), null);
  assert.equal(modeRefusal('code', 'write_file', {}, cwd), null);
  assert.equal(modeRefusal('data', 'write_file', { path: '.agent/data/sales/01-load.py' }, cwd), null);
  assert.match(modeRefusal('data', 'write_file', { path: 'src/app.js' }, cwd), /data mode writes only/);
  assert.equal(modeRefusal('data', 'bash', { command: 'python3 .agent/data/sales/01-load.py' }, cwd), null);
});

// A model that always tries to write the file it is told about, then stops.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const msgs = j.messages ?? [];
    const toolMsg = msgs.find((m) => m.role === 'tool');
    const user = msgs.find((m) => m.role === 'user')?.content ?? '';
    const target = String(user).match(/FILE=(\S+)/)?.[1] ?? 'x.txt';
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (toolMsg) {
      res.end(sse({ choices: [{ index: 0, delta: { content: `TOOL SAID: ${toolMsg.content}` }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } else {
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'hi\n' }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-modes-home-'));
function ox(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [OX, '--bot', 'custom:m', '-y', ...args], { cwd, env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('ask mode: the write is refused even with -y', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-modes-ask-'));
  const r = await ox(cwd, '--mode', 'ask', '-p', 'FILE=a.txt write it');
  assert.equal(fs.existsSync(path.join(cwd, 'a.txt')), false, r.out);
  assert.match(r.out, /ask mode only reads/, r.out);
});

test('plan mode: a plan file is written, source is not', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-modes-plan-'));
  const ok = await ox(cwd, '--mode', 'plan', '-p', 'FILE=.agent/plans/p.md write it');
  assert.equal(fs.readFileSync(path.join(cwd, '.agent/plans/p.md'), 'utf8'), 'hi\n', ok.out);
  const no = await ox(cwd, '--mode', 'plan', '-p', 'FILE=src.js write it');
  assert.equal(fs.existsSync(path.join(cwd, 'src.js')), false, no.out);
  assert.match(no.out, /only writes plan files/);
});

test('auto mode says where it routed, and a question cannot edit', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-modes-auto-'));
  const r = await ox(cwd, '--mode', 'auto', '-p', 'what is in FILE=q.txt?');
  assert.match(r.out, /auto → ask \(is a question\)/, r.out);
  assert.equal(fs.existsSync(path.join(cwd, 'q.txt')), false);
  const w = await ox(cwd, '--mode', 'auto', '-p', 'create FILE=w.txt');
  assert.match(w.out, /auto → code/);
  assert.equal(fs.readFileSync(path.join(cwd, 'w.txt'), 'utf8'), 'hi\n', w.out);
});
