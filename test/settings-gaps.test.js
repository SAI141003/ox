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

test('connectors: add a local or remote MCP server, show and save its permission, remove it; bad input is refused', async () => {
  let list = await api.saveConnector({ name: 'github', command: 'npx', args: '-y @modelcontextprotocol/server-github' });
  assert.deepEqual(list, [{ name: 'github', kind: 'stdio', target: 'npx -y @modelcontextprotocol/server-github', env: [], policy: 'ask' }]);
  list = await api.saveConnector({ name: 'remote', url: 'https://example.com/mcp' });
  assert.equal(list.find((c) => c.name === 'remote').kind, 'http');
  assert.equal(list.find((c) => c.name === 'remote').policy, 'ask');
  list = await api.saveConnector({ name: 'github', action: 'policy', policy: 'deny' });
  assert.equal(list.find((c) => c.name === 'github').policy, 'deny');
  list = await api.saveConnector({ name: 'github', action: 'policy', policy: 'allow' });
  assert.equal(list.find((c) => c.name === 'github').policy, 'allow');
  list = await api.saveConnector({ name: 'github', action: 'policy', policy: 'ask' });
  assert.equal(list.find((c) => c.name === 'github').policy, 'ask', 'ask is the safe, explicit default');
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.deepEqual(doc.mcpServers.github, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] });
  await assert.rejects(api.saveConnector({ name: 'bad name!', command: 'x' }), /letters, numbers/);
  await assert.rejects(api.saveConnector({ name: 'x', url: 'ftp://nope' }), /http/);
  await assert.rejects(api.saveConnector({ name: 'x' }), /command .* or a URL/);
  await assert.rejects(api.saveConnector({ name: 'github', action: 'policy', policy: 'unsafe' }), /permission/);
  await assert.rejects(api.saveConnector({ name: 'missing', action: 'policy', policy: 'deny' }), /does not exist/);
  list = await api.saveConnector({ name: 'github', action: 'remove' });
  assert.deepEqual(list.map((c) => c.name), ['remote']);
});

test('the Settings pages exist and are searchable', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  for (const id of ['instructions', 'connectors', 'data', 'devices']) assert.match(html, new RegExp(`\\['${id}', `), id);
  assert.match(html, /sec === 'instructions'/);
  assert.match(html, /sec === 'devices'/);
  assert.match(html, /Offline &amp; devices/);
  assert.match(html, /AWDL, Bluetooth and sound transport ideas are research\/phase-one components/);
  assert.match(html, /ox mesh audit/);
  assert.match(html, /\/ox\/mesh\/invite/);
  assert.match(html, /\/ox\/mesh\/peer/);
  assert.match(html, /\/ox\/mesh\/run/);
  assert.match(html, /Export all chats/);
  assert.match(html, /Check for updates/);
  assert.match(html, /let renderSeq = 0/, 'stale pages cannot overwrite the current one');
  assert.match(html, /data-account-default/, 'a connected supported account can become the default from its card');
  assert.match(html, /a\.id !== 'claude'/, 'a Claude subscription is not made ox\'s default');
  assert.match(html, /This chat’s context meter appears here/, 'Usage explains when a current-context meter is available');
});

test('the app exposes paired-machine session inspection and approval-gated remote Ox tasks', () => {
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /mesh\\\/peer/);
  assert.match(serve, /node\.ask\(machine, 'agents'/);
  assert.match(serve, /mesh\\\/run/);
  assert.match(serve, /\.ask\(machine, 'run'/);
  assert.match(serve, /This is deliberately an Ox task, not a raw shell endpoint/);
});

test('backup model: saved from Settings, and app chats get it as a fallback target', () => {
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /typeof body\.fallbackBot === 'string'/);
  assert.match(serve, /ctx\.fallbackTargets = /);
  assert.match(serve, /fallback: \(doc\.fallback_bots \?\? doc\.fallbackBots \?\? \[\]\)\[0\]/);
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /row\('Backup model'/);
});

test('extensions settings shows each connector permission and a safe default', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /Safe by default:/);
  assert.match(html, /Ask every call/);
  assert.match(html, /Allow automatically/);
  assert.match(html, /data-connector-policy/);
  assert.match(html, /action: 'policy'/);
});
