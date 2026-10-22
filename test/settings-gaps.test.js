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
  assert.match(html, /GitHub updates/);
  assert.match(html, /Enable update checks/);
  assert.match(html, /Install future verified updates automatically/);
  assert.match(html, /let renderSeq = 0/, 'stale pages cannot overwrite the current one');
  assert.match(html, /data-account-default/, 'a connected supported account can become the default from its card');
  assert.match(html, /a\.id !== 'claude'/, 'a Claude subscription is not made ox\'s default');
  assert.match(html, /This chat’s context meter appears here/, 'Usage explains when a current-context meter is available');
});

test('Plugins are a first-class Settings destination and Mini & Pets is implemented in the app', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /\['connectors', 'Plugins'/, 'Plugins is visible by name in Settings navigation');
  assert.match(html, /store\.set\('ox\.extTab', 'plugins'\)/, 'opening Plugins defaults to the actual plugin list');
  assert.match(html, /Plugins, MCP servers &amp; skills/);
  assert.match(html, /\['mini', 'Mini & Pets'/, 'Mini & Pets is an independently searchable Settings section');
  assert.match(html, /sec === 'mini'/);
  for (const pet of ['None', 'Codex', 'Dewey', 'Fireball', 'Hoots', 'Rocky', 'Seedy', 'Stacky', 'BSOD', 'Null Signal']) assert.match(html, new RegExp(`name: '${pet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), pet);
  assert.match(html, /pet-size/);
  assert.match(html, /Create pet/);
  assert.match(html, /ox\.mini\.customPets/);
  assert.match(html, /e\.code === 'Space'/, 'the documented option-space shortcut is wired in the focused app');
  assert.match(html, /separate from OX Island’s existing Blender characters/);
  assert.match(html, /id="pet-mini"/);
  assert.match(html, /id="pet-chat"/);
  assert.match(html, /id="pet-talk"/);
  assert.match(html, /id="pet-settings"/);
  assert.match(html, /const openPetChat = \(\) => \{ show\('chat'\)/, 'tapping the floating companion opens chat and focuses its composer');
  assert.match(html, /mini-sprite mini-/, 'built-in pets use illustrated sprite art instead of emoji placeholders');
  assert.match(html, /pet-stage::before/, 'the preview has a character-colored halo');
  assert.match(html, /pet-stage::after/, 'the preview animates a grounded shadow with the floating character');
  assert.match(html, /const MINI_EXPRESSIONS = \[/, 'Mini & Pets provides selectable companion expressions');
  for (const expression of ['happy', 'thinking', 'focused', 'sleepy', 'surprised', 'curious', 'worried', 'proud', 'celebrating']) {
    assert.match(html, new RegExp(`id: '${expression}'`), `${expression} expression is available`);
    assert.match(html, new RegExp(`expression === '${expression}'`), `${expression} is drawn into the character's face`);
  }
  assert.match(html, /data-mini-expression/, 'expression controls update the selected desktop companion');
  assert.match(html, /class="pet-expression-art">\$\{miniArt\(currentPet, 38, x\.id\)\}/, 'each expression choice previews the selected pet with that exact face');
  assert.match(html, /expression: miniExpression\(\)\.id/, 'the persistent macOS companion receives its selected expression');
  assert.match(html, /expressionSvgs: p\.id === 'none' \? \{\} : Object\.fromEntries\(MINI_EXPRESSIONS\.map/, 'the Mac companion receives all expression artwork so it can react while working');
  const desktopPet = fs.readFileSync(new URL('../desktop/island/Sources/OxApp/DesktopPet.swift', import.meta.url), 'utf8');
  assert.match(desktopPet, /petExpressionSVGs/, 'the desktop pet stores the expression artwork variants');
  assert.match(desktopPet, /private struct SVGPetArtwork: NSViewRepresentable/, 'the desktop pet renders the selected SVG in a native transparent surface');
  assert.match(desktopPet, /webView\.setValue\(false, forKey: "drawsBackground"\)/, 'the native pet has no opaque background tile');
  assert.doesNotMatch(desktopPet, /NSImage\(data: Data\(svg\.utf8\)\)/, 'the pet does not rely on unsupported SVG-to-NSImage decoding');
  assert.match(desktopPet, /controller\.isWorking \? workingMood : controller\.petExpression/, 'the desktop pet animates work expressions and restores the chosen mood');
  assert.match(html, /pet-heading-icon/, 'Mini & Pets uses the selected character instead of a generic bot glyph');
  assert.match(html, /Build your first OX bot/);
  assert.match(html, /botHeaderMark/);
  assert.match(html, /data-plugin-enabled=/, 'installed plugins can be paused or enabled in Settings');
  assert.match(html, /data-plugin-mcp=/, 'plugin MCP servers are a separate explicit control');
  assert.match(html, /data-plugin-remove=/, 'plugin removal is available with confirmation');
  assert.match(html, /Plugins\u2019 arbitrary hooks are never run/);
});

test('Code Review is reachable and shows real read-only pull-request status', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /data-view="review"[\s\S]*?Code Review/);
  assert.match(html, /id="v-review"/);
  assert.match(html, /async function loadCodeReview\(\)/);
  assert.match(html, /getJson\(`\/ox\/pr\$\{query\}`\)/);
  assert.match(html, /Review is read-only here; Ox will not edit, push, or merge/);
  assert.match(html, /status\.checks/);
  assert.match(html, /status\.comments/);
  assert.match(html, /esc\(c\.body\)/, 'reviewer text is escaped before rendering');
});

test('Settings opens as a full-width two-pane workspace with responsive navigation', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /\.sheet \{[^}]*width: 100%; max-width: none/);
  assert.match(html, /grid-template-columns: clamp\(250px, 20vw, 380px\) minmax\(0, 1fr\)/);
  assert.match(html, /\.sheet\.nav-open \.snav/);
});

test('plugin Settings actions use the existing safe plugin registry and reject unknown actions', async () => {
  await assert.rejects(api.pluginAction({ action: 'enable' }), /valid installed plugin/);
  await assert.rejects(api.pluginAction({ name: 'demo', action: 'execute-shell' }), /must be enable, disable, mcp or remove/);
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

test('Island companion and close controls are visible, persisted, and constrained', () => {
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(serve, /ISLAND_COMPANIONS/);
  assert.match(serve, /ISLAND_PETS/);
  assert.match(serve, /saveIslandPreferences/);
  assert.match(serve, /\[0, 3, 6, 15\]/);
  assert.match(serve, /islandPreferences/);
  assert.match(html, /Companion &amp; behavior/);
  assert.match(html, /data-island-pref="companion"/);
  assert.match(html, /data-island-pref="pet"/);
  assert.match(html, /data-island-pref="autoClose"/);
  assert.match(html, /data-island-pref="hideFullscreen"/);
});

test('the compact Island has no permanent Ox mascot, while optional pets remain available', () => {
  const island = fs.readFileSync(new URL('../desktop/island/Sources/OxIsland/IslandView.swift', import.meta.url), 'utf8');
  const compact = island.slice(island.indexOf('struct CompactBar'), island.indexOf('struct StatusGlyph'));
  assert.doesNotMatch(compact, /OxWalker\(/, 'the compact lane must not force the orange Ox mascot');
  assert.match(compact, /IslandPet\(kind: pet/, 'a pet selected by the person remains supported');
});

test('the installed Ox app and temporary runtime app use distinct macOS identities', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /bundleIdentifier = 'dev\.ox\.app\.runtime'/);
  assert.match(app, /buildMacApp\(\{ bundleIdentifier: 'dev\.ox\.app' \}\)/);
});
