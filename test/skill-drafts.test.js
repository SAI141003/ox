// ox learns from its own work: a run that finishes in several good steps
// becomes a draft skill, unused until accepted; nothing is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugFor, worthASkill } from '../src/skill-drafts.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('only real multi-step successes are worth a skill', () => {
  const call = (name, ok) => ({ name, ok, args: {} });
  assert.equal(worthASkill({ task: 't', calls: [call('read_file', true), call('grep', true), call('edit_file', true)] }), true);
  assert.equal(worthASkill({ task: 't', calls: [call('read_file', true), call('read_file', true), call('read_file', true)] }), false, 'one tool repeated');
  assert.equal(worthASkill({ task: 't', calls: [call('read_file', true), call('grep', true)] }), false, 'too short');
  assert.equal(worthASkill({ task: 't', calls: [call('read_file', true), call('grep', true), call('edit_file', true), call('bash', false)] }), false, 'ended in failure');
  assert.equal(slugFor('Please add a --verbose flag to the CLI!'), 'add-verbose-flag-cli');
});

// A model that reads, searches, writes, runs the tests, then reports.
const steps = [
  ['read_file', { path: 'app.js' }],
  ['grep', { pattern: 'greet' }],
  ['write_file', { path: 'app.js', content: 'export const greet = (n) => `hi ${n}`;\n' }],
  ['bash', { command: 'node --check app.js' }],
];
const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const done = (j.messages ?? []).filter((m) => m.role === 'tool').length;
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (done >= steps.length) {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'Added greet and checked it.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      return;
    }
    const [name, args] = steps[done];
    res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${done}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
after(() => model.close());

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-learn-h-'));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-learn-p-')));
fs.writeFileSync(path.join(cwd, 'app.js'), 'export const greet = 1;\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_NO_AWAKE: '1', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x' });
const run = (...a) => new Promise((resolve) => {
  const p = spawn(process.execPath, [OX, ...a], { cwd, env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
const oxSync = (...a) => { const r = spawnSync(process.execPath, [OX, ...a], { cwd, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

test('a run that finishes in good steps drafts a skill you can keep', async () => {
  const r = await run('-y', '--bot', 'custom:m', '-p', 'add a greet function to app.js');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /learned: drafted the skill 'add-greet-function-app-js'/);
  const draft = fs.readFileSync(path.join(cwd, '.agent', 'skill-drafts', 'add-greet-function-app-js', 'SKILL.md'), 'utf8');
  assert.match(draft, /^draft: true$/m);
  assert.match(draft, /1\. read_file — `app\.js`[^]*4\. bash — `node --check app\.js`/);
  assert.match(oxSync('self-improve', 'drafts').out, /add-greet-function-app-js\s+4 steps/);

  const kept = oxSync('self-improve', 'accept', 'add-greet-function-app-js');
  assert.equal(kept.code, 0, kept.out);
  const skill = fs.readFileSync(path.join(cwd, '.agents', 'skills', 'add-greet-function-app-js', 'SKILL.md'), 'utf8');
  assert.ok(!/draft: true/.test(skill), 'an accepted skill is no longer a draft');
  assert.ok(!fs.existsSync(path.join(cwd, '.agent', 'skill-drafts', 'add-greet-function-app-js')));
});

test('learning reports real counts, never re-drafts a session, and can be turned off', async () => {
  // `ox -p` keeps no transcript, so there is nothing on disk to re-read: the
  // count says so instead of inventing work.
  const r = oxSync('self-improve', 'run');
  assert.match(r.out, /read 0 session\(s\) from this project · 0 new lesson\(s\) for procedural memory · 0 skill draft\(s\)/, r.out);
  const off = await run('-y', '--bot', 'custom:m', '-p', 'add a farewell function to app.js');
  // Async: the model lives in this process, so a blocking spawn would deadlock it.
  const quiet = await new Promise((resolve) => {
    const p = spawn(process.execPath, [OX, '-y', '--bot', 'custom:m', '-p', 'rename greet in app.js'], { cwd, env: { ...env, OX_LEARN: '0' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
  });
  assert.ok(!/learned:/.test(quiet), 'OX_LEARN=0 drafts nothing');
  assert.match(off.out, /learned: drafted/, 'a different task is a different skill');
});
