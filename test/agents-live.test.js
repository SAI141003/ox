// Other agents on this Mac, live (src/agents-live.js): Claude Code and Codex
// sessions read from their own transcripts, read-only, shown in the island and
// the app's Office.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveAgents, describeCall, projectName, asBoardRows } from '../src/agents-live.js';

const line = (o) => JSON.stringify(o);

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agents-'));
  const proj = path.join(home, '.claude', 'projects', '-Users-me-app');
  fs.mkdirSync(proj, { recursive: true });
  // working: a tool call with no result yet, written just now
  fs.writeFileSync(path.join(proj, 'aaa.jsonl'), [
    line({ type: 'user', cwd: '/Users/me/app', message: { content: 'fix the login' } }),
    line({ type: 'assistant', cwd: '/Users/me/app', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/Users/me/app/src/login.ts' } }] } }),
  ].join('\n'));
  // idle: answered with text, ten minutes ago
  const idle = path.join(home, '.claude', 'projects', '-Users-me-app--claude-worktrees-brave-turing-a1b2c3');
  fs.mkdirSync(idle, { recursive: true });
  const f = path.join(idle, 'bbb.jsonl');
  fs.writeFileSync(f, [line({ type: 'assistant', cwd: '/Users/me/app/.claude/worktrees/brave-turing-a1b2c3', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }] } })].join('\n'));
  const t = (Date.now() - 10 * 60_000) / 1000; fs.utimesSync(f, t, t);
  // an old one: not listed
  const old = path.join(proj, 'old.jsonl');
  fs.writeFileSync(old, line({ type: 'assistant', cwd: '/x', message: { model: 'm', content: [] } }));
  const o = (Date.now() - 3 * 3600_000) / 1000; fs.utimesSync(old, o, o);
  // codex at work
  const cx = path.join(home, '.codex', 'sessions', '2026', '10', '18');
  fs.mkdirSync(cx, { recursive: true });
  fs.writeFileSync(path.join(cx, 'rollout-1.jsonl'), [
    line({ type: 'session_meta', payload: { cwd: '/Users/me/api' } }),
    line({ type: 'turn_context', payload: { model: 'gpt-6' } }),
    line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } }),
  ].join('\n'));
  return home;
}

test('sessions of Claude Code and Codex: who, where, model, what now, idle time', () => {
  const rows = liveAgents({ home: fakeHome(), fresh: true });
  const by = Object.fromEntries(rows.map((r) => [r.project, r]));
  assert.equal(rows.length, 3);
  assert.deepEqual([by.app.tool, by.app.state, by.app.doing, by.app.model], ['Claude Code', 'tool', 'editing login.ts', 'claude-opus-5-5']);
  assert.equal(by['app · brave-turing'].state, 'idle');
  assert.ok(by['app · brave-turing'].idleSec >= 590);
  assert.deepEqual([by.api.tool, by.api.doing, by.api.model], ['Codex', '$ bash -lc npm test', 'gpt-6']);
});

test('board rows are marked external, and nothing is written to the agents folders', () => {
  const home = fakeHome();
  const before = fs.readdirSync(path.join(home, '.claude', 'projects', '-Users-me-app')).sort();
  const rows = asBoardRows(liveAgents({ home, fresh: true }));
  assert.ok(rows.every((r) => r.ext && r.id.startsWith('ext:')));
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'projects', '-Users-me-app')).sort(), before);
});

test('what a call does, in a few words; worktree names', () => {
  assert.equal(describeCall('Bash', { command: 'cd ~/ox && swift build -c release' }), '$ swift build -c release');
  assert.equal(describeCall('Read', { file_path: '/a/b/Bridge.swift' }), 'reading Bridge.swift');
  assert.equal(describeCall('mcp__github__create_pr', {}), 'create_pr');
  assert.equal(projectName('/Users/me/ox/.claude/worktrees/practical-vaughan-09501b'), 'ox · practical-vaughan');
  assert.equal(projectName('/Users/me/ox'), 'ox');
});

import { sendCommand, sendToSession, copilotSessions } from '../src/agents-live.js';
import { EventEmitter } from 'node:events';

test('each tool continues a session with its own resume, headless', () => {
  assert.deepEqual(sendCommand('claude', 'abc', 'hi'), ['claude', ['-p', 'hi', '--resume', 'abc']]);
  assert.deepEqual(sendCommand('codex', 'abc', 'hi'), ['codex', ['exec', 'resume', 'abc', 'hi']]);
  assert.deepEqual(sendCommand('hermes', 'abc', 'hi')[1], ['chat', '-q', 'hi', '--resume', 'abc', '-Q']);
  assert.equal(sendCommand('copilot', 'abc', 'hi'), null);
});

test('a session at work is never written to at the same time: the message waits', async () => {
  const home = fakeHome(); // its Claude session "aaa" is mid tool call
  let ran = 0;
  const run = () => { ran++; const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); setImmediate(() => p.emit('close', 0)); return p; };
  const r = await sendToSession('ext:claude:aaa', 'also add a test', { home, run });
  assert.equal(r.queued, true);
  assert.match(r.why, /as soon as it is idle/);
  assert.equal(ran, 0);
  // the idle worktree session takes the message now
  const ok = await sendToSession('ext:claude:bbb', 'thanks, now update the README', { home, run });
  assert.equal(ok.ok, true);
  assert.equal(ran, 1);
  await assert.rejects(sendToSession('ext:copilot:x', 'hi', { home, run }), /cannot send/);
});

test('Copilot sessions: folder, model, the command it runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cop-'));
  const d = path.join(home, '.copilot', 'session-state', 'c1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'events.jsonl'), [
    JSON.stringify({ type: 'session.start', data: { context: { cwd: '/Users/me/site' } } }),
    JSON.stringify({ type: 'assistant.turn_start', data: {} }),
    JSON.stringify({ type: 'tool.execution_start', data: { toolName: 'bash', arguments: { command: 'npm run build' }, model: 'gpt-5.6' } }),
  ].join('\n'));
  const [s] = copilotSessions({ home });
  assert.deepEqual([s.tool, s.project, s.model, s.state, s.doing], ['Copilot', 'site', 'gpt-5.6', 'tool', '$ npm run build']);
});

test('codex resume uses a model the account may use; errors read as words', async () => {
  const { sendCommand, plainError } = await import('../src/agents-live.js');
  assert.deepEqual(sendCommand('codex', 's1', 'hi', (t, f) => f, { modelArgs: () => ['-m', 'gpt-6-luna'] }), ['codex', ['exec', 'resume', '-m', 'gpt-6-luna', 's1', 'hi']]);
  assert.equal(plainError('ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account."}}'), "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(plainError('line one\nERROR: not signed in'), 'not signed in');
});
