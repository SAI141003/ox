import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-settings-home-'));
process.env.HOME = home;
process.env.OX_HOME = path.join(home, '.ox');
const file = path.join(home, '.ox', 'instructions.md');
process.env.OX_INSTRUCTIONS_FILE = file;
const api = await import('../src/app-api.js');
const { buildContext } = await import('../src/context.js');
const { buildSystemPrompt } = await import('../src/system-prompt.js');
const { planBrief } = await import('../src/subscriptions.js');

test('your instructions are saved, then reach every prompt, quick answers and plans included', async () => {
  await api.saveInstructions('Always reply in French.');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Always reply in French.\n');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-settings-cwd-'));
  const parts = buildContext({ cwd });
  for (const answerOnly of [false, true]) {
    const p = await buildSystemPrompt({ cwd, contextParts: parts, answerOnly });
    assert.match(p, /# THE USER'S INSTRUCTIONS[\s\S]*Always reply in French\./, `answerOnly=${answerOnly}`);
  }
  assert.match(planBrief({}, process.env), /How the user wants you to work:\nAlways reply in French\./);
  await assert.rejects(api.saveInstructions('x'.repeat(4001)), /4,000/);
  await api.saveInstructions('   ');
  assert.equal(fs.existsSync(file), false, 'clearing removes the file');
});

test("a project's own instructions still come after yours (they win a conflict)", async () => {
  await api.saveInstructions('Use tabs.');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-settings-proj-'));
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Use two spaces.');
  fs.mkdirSync(path.join(cwd, '.git'));
  const p = await buildSystemPrompt({ cwd, contextParts: buildContext({ cwd }) });
  assert.ok(p.indexOf('Use tabs.') < p.indexOf('Use two spaces.'));
  await api.saveInstructions('');
});

test('connectors: add a local or remote MCP server, list it, remove it; bad input is refused', async () => {
  let list = await api.saveConnector({ name: 'github', command: 'npx', args: '-y @modelcontextprotocol/server-github' });
  assert.deepEqual(list, [{ name: 'github', kind: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', env: [] }]);
  list = await api.saveConnector({ name: 'remote', url: 'https://example.com/mcp' });
  assert.equal(list.find((c) => c.name === 'remote').kind, 'http');
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.deepEqual(doc.mcpServers.github, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
  await assert.rejects(api.saveConnector({ name: 'bad name!', command: 'x' }), /letters, numbers/);
  await assert.rejects(api.saveConnector({ name: 'x', url: 'ftp://nope' }), /http/);
  await assert.rejects(api.saveConnector({ name: 'x' }), /command .* or a URL/);
  list = await api.saveConnector({ name: 'github', action: 'remove' });
  assert.deepEqual(list.map((c) => c.name), ['remote']);
});

test('the Settings pages exist and are searchable', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  for (const id of ['instructions', 'connectors', 'data']) assert.match(html, new RegExp(`\\['${id}', `), id);
  assert.match(html, /sec === 'instructions'/);
  assert.match(html, /Export all chats/);
  assert.match(html, /Check for updates/);
  assert.match(html, /let renderSeq = 0/, 'stale pages cannot overwrite the current one');
});

test('backup model: saved from Settings, and app chats get it as a fallback target', () => {
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /typeof body\.fallbackBot === 'string'/);
  assert.match(serve, /ctx\.fallbackTargets = /);
  assert.match(serve, /fallback: \(doc\.fallback_bots \?\? doc\.fallbackBots \?\? \[\]\)\[0\]/);
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /row\('Backup model'/);
});
