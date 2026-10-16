// The name you give ox: saved once, used as its identity in every prompt, and
// your agents can be renamed without losing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-name-home-'));
process.env.HOME = home;
delete process.env.OX_NAME;

const { assistantName, setAssistantName, identityLine, cleanName } = await import('../src/identity.js');
const { buildSystemPrompt } = await import('../src/system-prompt.js');
const { readConfigDoc, saveConfigDoc } = await import('../src/config.js');
const { saveAgent, loadAgent, renameAgent, agentPersonaBlock } = await import('../src/agents.js');

test.after(() => { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }); });

test('ox until renamed; the prompt then names it and says it answers to that name', async () => {
  assert.equal(assistantName({}), 'ox');
  assert.equal(identityLine('ox'), 'You are ox, a featherweight coding agent.');
  assert.equal(setAssistantName('  Nova  '), 'Nova');
  assert.equal(readConfigDoc().name, 'Nova');
  assert.equal(assistantName({}), 'Nova');
  const prompt = await buildSystemPrompt({ cwd: home, now: 0 });
  assert.match(prompt, /^You are Nova, a featherweight coding agent/);
  assert.match(prompt, /when the user says it — at the start, in the middle or at the end/);
  assert.match(prompt, /call yourself Nova, never ox/);
  // OX_NAME wins for one run; names in any script work.
  assert.equal(assistantName({ OX_NAME: 'Jarvis' }), 'Jarvis');
  assert.equal(cleanName('ジャービス'), 'ジャービス');
  // Back to ox: empty, or 'ox' itself.
  assert.equal(setAssistantName(''), 'ox');
  assert.equal(readConfigDoc().name, undefined);
});

test('names that could break the prompt or the island are refused', () => {
  for (const bad of ['a'.repeat(25), '<script>', '-dash', 'Nova; rm -rf', 'x"y']) {
    assert.throws(() => setAssistantName(bad), /a name is/);
  }
  // Line breaks can never reach the prompt: whitespace collapses to one space.
  assert.equal(cleanName('No\nva'), 'No va');
});

test('renaming an agent keeps its setup and moves the default with it', () => {
  saveAgent('reviewer', { bot: 'ox-grok', mode: 'ask', systemPrompt: 'review diffs', tools: ['read_file'] });
  const before = loadAgent('reviewer');
  saveConfigDoc((doc) => { doc.defaultBot = 'agent:reviewer'; });
  renameAgent('reviewer', 'critic', { saveConfig: saveConfigDoc });
  assert.equal(loadAgent('reviewer'), null);
  const after = loadAgent('critic');
  assert.equal(after.name, 'critic');
  assert.equal(after.mode, 'ask');
  assert.deepEqual(after.tools, ['read_file']);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(readConfigDoc().defaultBot, 'agent:critic');
  assert.match(agentPersonaBlock(after), /critic is your name/);
  assert.throws(() => renameAgent('critic', 'bad name'), /agent name/);
  assert.throws(() => renameAgent('../etc', 'x'), /no agent/);
  saveAgent('other', { systemPrompt: 'x' });
  assert.throws(() => renameAgent('critic', 'other'), /already an agent/);
});
