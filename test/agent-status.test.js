// Agents checking on each other: agent_status reads the live registry, so one
// agent sees what another is doing right now without waiting for a reply.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSubagent, markSubagentStarted, updateSubagent, finishSubagent, noteFinishedSnapshot, _resetRegistry } from '../src/subagent-registry.js';
import { dispatchTool, listToolSchemas } from '../src/tools/index.js';
import { makeAgentTeamsHandler, AGENT_MESSAGE_TOOLS } from '../src/agent-teams.js';
import { modeRefusal } from '../src/modes.js';

afterEach(() => _resetRegistry());
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agentstatus-'));

test('offered with the mailbox tools, and allowed in read-only modes', () => {
  const names = listToolSchemas({ agentTeamsHandler: makeAgentTeamsHandler(cwd) }).map((s) => s.name);
  assert.ok(names.includes('agent_status'));
  assert.ok(AGENT_MESSAGE_TOOLS.includes('agent_status'));
  assert.ok(!listToolSchemas({}).map((s) => s.name).includes('agent_status'), 'not offered with no team');
  assert.equal(modeRefusal('ask', 'agent_status'), null);
  assert.equal(modeRefusal('plan', 'agent_status'), null);
});

test('a subagent sees its running peer, but not itself', async () => {
  registerSubagent({ id: 'sa_tests', task: 'write the auth tests', cwd });
  markSubagentStarted('sa_tests');
  updateSubagent('sa_tests', { currentTool: 'bash', currentToolArgsPreview: 'npm test -- auth', iterations: 4, filesTouched: 2 });
  registerSubagent({ id: 'sa_docs', task: 'update the README', cwd });
  markSubagentStarted('sa_docs');

  const asDocs = await dispatchTool('agent_status', {}, { cwd, subagentId: 'sa_docs' });
  assert.match(asDocs.content, /sa_tests \[\w+\] write the auth tests — now: bash npm test -- auth; 4 steps, 2 files/);
  assert.ok(!asDocs.content.includes('sa_docs'), 'an agent is not shown to itself');

  const one = await dispatchTool('agent_status', { id: 'sa_docs' }, { cwd, subagentId: 'parent' });
  assert.match(one.content, /sa_docs/);
  assert.ok(!one.content.includes('sa_tests'));
});

test('finished agents are reported as finished, and nothing is invented when no one runs', async () => {
  assert.equal((await dispatchTool('agent_status', {}, { cwd })).content, 'no other agents are running');
  registerSubagent({ id: 'sa_done', task: 'rename the helper', cwd });
  markSubagentStarted('sa_done');
  // As src/subagent.js does at the end of a run.
  noteFinishedSnapshot(finishSubagent('sa_done', { status: 'done' }));
  const r = await dispatchTool('agent_status', {}, { cwd });
  assert.match(r.content, /sa_done \[done\] rename the helper — finished/);
});
