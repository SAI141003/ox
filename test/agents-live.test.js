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
