import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { momentsOf, claudeCalls, codexCalls, raceLine, race } from '../src/race-live.js';

const line = (o) => JSON.stringify(o);
const T = (s) => `2026-10-19T12:0${s}:00.000Z`;

test('moments from a Claude Code transcript: test written, failing on purpose, passing, browser', () => {
  const jsonl = [
    line({ timestamp: T(1), message: { content: [{ type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'frontend-design' } }] } }),
    line({ timestamp: T(2), message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/x/test-ai.mjs' } }] } }),
    line({ timestamp: T(3), message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'node test-ai.mjs index.html' } }] } }),
    line({ timestamp: T(3), message: { content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'Error: ENOENT index.html' }] } }),
    line({ timestamp: T(5), message: { content: [{ type: 'tool_use', id: 'd', name: 'Bash', input: { command: 'node test-ai.mjs index.html' } }] } }),
    line({ timestamp: T(5), message: { content: [{ type: 'tool_result', tool_use_id: 'd', content: 'mean=396 PASS' }] } }),
    line({ timestamp: T(6), message: { content: [{ type: 'tool_use', id: 'e', name: 'Bash', input: { command: 'node browser-check.mjs # headless chrome' } }] } }),
  ].join('\n');
  const m = momentsOf(claudeCalls(jsonl));
  assert.deepEqual(m.map((x) => x.label), ['skills: frontend-design', 'writes a test', 'test fails, on purpose', 'tests pass', 'checks it in a browser']);
  assert.equal(m[2].at, Date.parse(T(3)));
});

test('moments from a Codex rollout: commands and their exit codes', () => {
  const jsonl = [
    line({ timestamp: T(1), payload: { type: 'function_call', name: 'shell', call_id: '1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } }),
    line({ timestamp: T(1), payload: { type: 'function_call_output', call_id: '1', output: '{"output":"1 failing","metadata":{"exit_code":1}}' } }),
    line({ timestamp: T(4), payload: { type: 'function_call', name: 'shell', call_id: '2', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } }),
    line({ timestamp: T(4), payload: { type: 'function_call_output', call_id: '2', output: '{"output":"12 passing","metadata":{"exit_code":0}}' } }),
  ].join('\n');
  assert.deepEqual(momentsOf(codexCalls(jsonl)).map((x) => x.label), ['test fails', 'tests pass']);
});

test('race: both tools in their own folder and tab, moments pinned, the first to finish wins', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-race-'));
  const tabs = [], said = [];
  let clock = 0, polls = 0;
  const now = () => clock;
  const files = {};
  const find = (tool, dir) => files[tool] ?? null;
  const live = async () => {
    polls++; clock += 30_000;
    const [c, x] = tabs.map((t) => /cd '([^']+)'/.exec(t)[1]);
    if (polls === 2) { fs.writeFileSync(path.join(c, 'index.html'), 'claude'); files.claude = path.join(home, 'claude.jsonl'); fs.writeFileSync(files.claude, line({ timestamp: new Date(0).toISOString(), message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'test-game.js' } }] } })); }
    if (polls === 5) fs.writeFileSync(path.join(x, 'index.html'), 'codex');
    return [{ cwd: c, idleSec: polls >= 3 ? 60 : 0 }, { cwd: x, idleSec: polls >= 6 ? 60 : 0 }];
  };
  const r = await race('make a self-driving snake game', { home, terminal: (cmd) => { tabs.push(cmd); return { ok: true }; }, live, find, say: (s, d) => said.push(`${d ? '✓ ' : ''}${s}`), now, sleep: async () => {}, pollMs: 0, check: false, bin: (n) => n });
  assert.equal(tabs.length, 2);
  assert.match(tabs[0], /&& claude --permission-mode acceptEdits 'make a self-driving snake game'$/);
  assert.match(tabs[1], /&& codex --sandbox workspace-write --ask-for-approval on-request /);
  assert.equal(r.winner.label, 'Claude Code');
  assert.ok(r.lanes[1].done > r.lanes[0].done);
  assert.deepEqual(r.lanes[0].moments.map((m) => m.label), ['writes a test']);
  assert.ok(said.includes('✓ Claude Code finishes first — 1m 30s'), said.join('\n'));
  assert.match(raceLine(r.lanes, clock), /^Claude Code ✓ 1m 30s · writes a test {3}\| {3}Codex ✓ /);
  await assert.rejects(race('x', { tools: ['claude', 'cobol'] }), /races claude, codex/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('race: a tool that is missing or broken is named with its fix, before any tab opens', async () => {
  const { notReady } = await import('../src/race-live.js');
  assert.equal(notReady('claude', { run: () => ({ status: 0, stdout: '2.1' }) }), null);
  assert.match(notReady('gemini', { run: () => ({ error: { code: 'ENOENT' } }) }), /Gemini CLI is not installed \(npm install -g @google\/gemini-cli\)/);
  assert.match(notReady('codex', { run: () => ({ status: 1, stderr: 'Error: spawn …/codex ENOENT' }), resolve: () => null }), /Codex is installed but does not start: Error: spawn/);
  // A broken codex command, but a working Codex inside the ChatGPT extension or app: ready.
  assert.equal(notReady('codex', { run: () => ({ status: 1, stderr: 'Error: spawn …/codex ENOENT' }), resolve: () => ({ where: '/x/codex', from: 'app' }) }), null);
  await assert.rejects(race('x', { tools: ['claude'] }), /two tools at least/);
});
