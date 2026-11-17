// "Start Claude in ox and tell it to fix the failing test": parsed and resolved, nothing opened under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSession, findProject, sessionCommand, startSession, projectFolders } from '../src/voice-session.js';
import { parseIntent, doOffline } from '../src/offline.js';

test('the ways it is said', () => {
  assert.deepEqual(parseSession('start Claude in ox and tell it to fix the failing test'), { intent: 'session', tool: 'claude', project: 'ox', prompt: 'fix the failing test' });
  assert.deepEqual(parseSession('Start a new Claude Code session in gadget swap.'), { intent: 'session', tool: 'claude', project: 'gadget swap', prompt: '' });
  assert.deepEqual(parseSession('open codex in the trade in backend project, ask it to add a health route'), { intent: 'session', tool: 'codex', project: 'trade in backend', prompt: 'add a health route' });
  assert.deepEqual(parseSession('new claude session in ox: write the release notes'), { intent: 'session', tool: 'claude', project: 'ox', prompt: 'write the release notes' });
  assert.deepEqual(parseSession('start a session in ox with codex and tell it to run the tests'), { intent: 'session', tool: 'codex', project: 'ox', prompt: 'run the tests' });
  assert.equal(parseSession('open claude'), null, 'opening the app is not a session');
  assert.equal(parseSession('start a timer in ten minutes'), null);
});

test('the project is found by how its name sounds, and two that fit are not guessed between', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-vs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const d of ['ox', 'ox-demo', 'Projects/gadget-swap', 'Projects/trade-in-backend', 'Projects/trade-in-frontend', 'Library/ox']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const folders = projectFolders({ home });
  assert.ok(!folders.some((f) => f.includes('Library')), 'the Library is not searched');
  assert.equal(findProject('ox', folders).dir, path.join(home, 'ox'), 'the exact name, not ox-demo');
  assert.equal(findProject('gadget swap', folders).dir, path.join(home, 'Projects', 'gadget-swap'));
  assert.equal(findProject('Gadget', folders).dir, path.join(home, 'Projects', 'gadget-swap'), 'the start of a name, when only one fits');
  assert.match(findProject('trade in', folders).error, /could be trade-in-backend, trade-in-frontend/);
  assert.match(findProject('nothing here', folders).error, /no project folder/);
  assert.match(startSession({ tool: 'codex', project: 'gadget swap', prompt: 'add tests' }, { folders }).message, /would open Codex in gadget-swap with "add tests"/);
});

test('your words reach the agent as one quoted prompt, whatever is in them', () => {
  const cmd = sessionCommand('/tmp/my project', 'claude', `fix it; rm -rf ~ && echo 'done' $(whoami)`, { bin: (b) => b });
  assert.equal(cmd, `cd '/tmp/my project' && claude 'fix it; rm -rf ~ && echo '\\''done'\\'' $(whoami)'`);
  assert.equal(sessionCommand('/tmp/p', 'codex', '', { bin: (b) => b }), `cd '/tmp/p' && codex`);
});

test('the offline router knows it', () => {
  assert.equal(parseIntent('start claude in ox and tell it to fix the tests')?.intent, 'session');
  assert.equal(doOffline('start claude in ox and tell it to fix the tests', { dryRun: true }).handled, true);
});
