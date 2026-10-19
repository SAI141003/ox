import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { make, nameOf, briefOf, terminalCommand, slugOf } from '../src/make-app.js';
import { parseIntent } from '../src/offline.js';

test('make: a name, a full brief and a quoted Terminal command from one sentence', () => {
  assert.equal(nameOf('a pumpkin-carver game'), 'Pumpkin Carver');
  assert.equal(nameOf('build me a simple todo app with Claude'), 'Todo');
  assert.equal(slugOf('Pumpkin Carver'), 'pumpkin-carver');
  const brief = briefOf('a pumpkin-carver game', 'Pumpkin Carver');
  assert.match(brief, /plain HTML, CSS and JavaScript and no build step/);
  assert.match(brief, /README\.md/);
  const cmd = terminalCommand("/tmp/it's here", "say 'hi'", 'claude');
  assert.equal(cmd, `cd '/tmp/it'\\''s here' && claude --permission-mode acceptEdits 'say '\\''hi'\\'''`, 'quotes survive the shell');
  assert.match(terminalCommand('/x', 'b', 'codex'), / && codex --full-auto 'b'$/);
});

test('make: Vovy\'s sentence is understood; a build without a named tool is left to ox', () => {
  assert.deepEqual(parseIntent('I want to build a pumpkin-carver game with Claude. Can you get it going for me?'), { intent: 'make', idea: 'a pumpkin-carver game', builder: 'claude' });
  assert.equal(parseIntent('build me a todo app with codex')?.builder, 'codex');
  assert.equal(parseIntent('build me a pumpkin carver game'), null);
});

test('make: narrates each step, waits for the agent, opens the page once it is quiet', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-make-'));
  const steps = [];
  let ran = null, opened = null, polls = 0;
  const dir = path.join(home, 'ox-builds', 'pumpkin-carver');
  const live = async () => {
    polls++;
    if (polls === 2) fs.writeFileSync(path.join(dir, 'index.html'), '<h1>pumpkin</h1>');
    return [{ cwd: dir, idleSec: polls < 4 ? 2 : 40 }];
  };
  const r = await make('a pumpkin-carver game', { home, say: (s, done) => steps.push(`${done ? '✓' : '·'} ${s}`), terminal: (c) => { ran = c; return { ok: true }; }, open: (p) => { opened = p; }, live, sleep: async () => {}, pollMs: 0 });
  assert.equal(r.opened, true);
  assert.equal(opened, path.join(dir, 'index.html'));
  assert.match(ran, /&& claude --permission-mode acceptEdits '/);
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'a git repo for the agent');
  assert.deepEqual(steps, ['· Checking your project setup', '· Opening Claude Code in a new tab', '· Handing Claude your prompt', '· Claude Code is building', '✓ Claude Code is building', '✓ Pumpkin Carver is live']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('make: gives up politely when the agent never finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-make-'));
  const r = await make('a clock', { home, terminal: () => ({ ok: true }), open: () => { throw new Error('should not open'); }, live: async () => [], sleep: async () => {}, pollMs: 0, timeoutMs: 5 });
  assert.equal(r.opened, false);
  fs.rmSync(home, { recursive: true, force: true });
});
