// The app's Bots page: make, edit, rename and delete your own bots, and see
// what they can run on. Same files as `ox agent` (~/.ox/agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-bots-home-'));
process.env.HOME = home;
const { botsView, botSave, botDelete } = await import('../src/app-api.js');
const { loadAgent } = await import('../src/agents.js');
test.after(() => { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }); });

test('make, edit, rename and delete a bot', async () => {
  const env = {};
  let v = await botSave({ name: 'reviewer', description: 'Reviews diffs', bot: 'ox-ollama', mode: 'ask', tools: ['read_file', 'grep'], instructions: 'Cite file:line.' }, env);
  assert.equal(v.mine.length, 1);
  assert.deepEqual(v.mine[0], { ...v.mine[0], name: 'reviewer', bot: 'ox-ollama', mode: 'ask', tools: ['read_file', 'grep'], instructions: 'Cite file:line.' });
  await assert.rejects(botSave({ name: 'reviewer' }, env), /already a bot/);
  v = await botSave({ name: 'critic', from: 'reviewer', description: 'Reviews diffs', bot: 'ox-ollama', mode: 'plan', tools: [], instructions: 'Be blunt.' }, env);
  assert.equal(loadAgent('reviewer'), null);
  assert.equal(loadAgent('critic').mode, 'plan');
  assert.equal(loadAgent('critic').tools, null); // none ticked: everything its mode allows
  assert.deepEqual(v.mine.map((b) => b.name), ['critic']);
  await assert.rejects(botSave({ name: 'x', mode: 'nonsense' }, env), /unknown mode/);
  await assert.rejects(botSave({ name: 'x', bot: 'no-such-bot-zz' }, env), /unknown bot/);
  await assert.rejects(botSave({ name: '../etc' }, env), /bot name/);
  v = await botDelete('critic', env);
  assert.equal(v.mine.length, 0);
  await assert.rejects(botDelete('critic', env), /no bot/);
});

test('what bots run on: models, plans and endpoints, each marked ready or not', async () => {
  const v = await botsView({ ANTHROPIC_API_KEY: 'k' });
  const claude = v.runsOn.find((r) => r.id === 'ox-claude');
  assert.equal(claude?.ready, true);
  assert.equal(v.runsOn.find((r) => r.id === 'ox-gpt')?.ready, false);
  assert.ok(v.runsOn.some((r) => r.kind === 'plan' && r.id === 'claude-plan'));
  assert.ok(v.modes.includes('ask') && v.tools.includes('read_file'));
});
