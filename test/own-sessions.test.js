// A run ox starts inside Claude Code or Codex is shown once, as ox (src/own-sessions.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-own-'));
process.env.OX_HOME = path.join(home, '.ox');
const O = await import('../src/own-sessions.js');
const A = await import('../src/agents-live.js');
const H = await import('../src/agent-hooks.js');

test('own sessions: a Claude Code session ox started is left out of the agents list', () => {
  const proj = path.join(home, '.claude', 'projects', '-tmp-shop');
  fs.mkdirSync(proj, { recursive: true });
  const line = (id) => `${JSON.stringify({ type: 'assistant', cwd: '/tmp/shop', sessionId: id, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }] } })}\n`;
  fs.writeFileSync(path.join(proj, 'aaaa.jsonl'), line('aaaa'));
  fs.writeFileSync(path.join(proj, 'bbbb.jsonl'), line('bbbb'));
  const ids = () => A.liveAgents({ home, fresh: true }).map((s) => s.id).sort();
  assert.deepEqual(ids(), ['claude:aaaa', 'claude:bbbb']);
  O.markOwn('claude', 'bbbb');
  assert.deepEqual(ids(), ['claude:aaaa'], 'ox\'s own run is not shown again as Claude Code');
  assert.equal(O.isOwn('claude:bbbb'), true);
});

test('own sessions: hooks inside a run ox started stay quiet', async () => {
  const raw = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1', cwd: '/tmp' });
  let relayed = false;
  const out = await H.handleHook('claude', raw, { env: { OX_OWN_RUN: '1' }, spawnRelay: () => { relayed = true; } });
  assert.equal(out, '');
  assert.equal(relayed, false);
});
