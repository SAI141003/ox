// Claude Code in OX Island: hook events become island events, a permission
// request is answered from the island, silence is always "ask", and the
// settings installer only ever adds or removes ox's own hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { handleHook, runRelay, toEvents, decisionOutput, withHooks, installed, planInstall, applyInstall } from '../src/agent-hooks.js';

// A short dir: unix socket paths are capped near 104 bytes on macOS.
const sockDir = () => fs.mkdtempSync(path.join('/tmp', 'oxh-'));

// Plays the island: connects, says ready, records events, answers approvals.
function island(socketPath, answer) {
  const events = [];
  const sock = net.createConnection(socketPath);
  let buf = '';
  sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'ready', clientId: 'test-island' })}\n`));
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.type === 'event') events.push(m.event);
      if (m.type === 'hello') events.push({ type: 'hello', bot: m.bot });
      if (m.type === 'approval-request') { events.push({ type: 'approval', tool: m.tool, preview: m.argsPreview }); sock.write(`${JSON.stringify({ type: 'approval-answer', id: m.id, decision: answer })}\n`); }
    }
  });
  return { events, close: () => sock.destroy() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('events map to what the island already draws, and decisions to what Claude Code reads', () => {
  assert.deepEqual(toEvents({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }), [{ type: 'tool-start', id: 't1', name: 'bash', argsPreview: 'npm test' }]);
  assert.deepEqual(toEvents({ hook_event_name: 'Stop' }), [{ type: 'turn-end', stopReason: 'end_turn' }]);
  assert.match(decisionOutput('allow'), /"behavior":"allow"/);
  assert.match(decisionOutput('always'), /"behavior":"allow"/);
  assert.match(decisionOutput('deny'), /"behavior":"deny"/);
  assert.equal(decisionOutput('ask'), '');
  assert.equal(decisionOutput(undefined), '');
});

test('a Claude Code session shows in the island and its permission is answered there', async (t) => {
  const dir = sockDir();
  const relays = [];
  t.after(() => relays.forEach((r) => r.server.close()));
  const spawnRelay = ({ agent, sessionId, cwd }) => relays.push(runRelay({ agent, sessionId, cwd, socketDir: dir }));
  const opts = { socketDir: dir, spawnRelay };
  const base = { session_id: 'abc-123', cwd: '/tmp/proj' };
  assert.equal(await handleHook('claude', JSON.stringify({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }), opts), '');
  const isl = island(relays[0].socketPath, 'allow');
  t.after(isl.close);
  await wait(150);
  await handleHook('claude', JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'u1', tool_input: { file_path: 'src/a.ts' } }), opts);
  const out = await handleHook('claude', JSON.stringify({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), opts);
  assert.match(out, /"behavior":"allow"/);
  await wait(50);
  assert.equal(relays.length, 1, 'one relay per session');
  assert.deepEqual(isl.events[0], { type: 'hello', bot: 'Claude Code' });
  assert.ok(isl.events.some((e) => e.type === 'tool-start' && e.name === 'edit_file' && e.argsPreview === 'src/a.ts'));
  assert.ok(isl.events.some((e) => e.type === 'approval' && e.tool === 'bash' && e.preview === 'rm -rf build'));
});

test('"Always" is remembered for the rest of the session; Deny denies', async (t) => {
  const dir = sockDir();
  const relays = [];
  t.after(() => relays.forEach((r) => r.server.close()));
  const opts = { socketDir: dir, spawnRelay: ({ agent, sessionId, cwd }) => relays.push(runRelay({ agent, sessionId, cwd, socketDir: dir })) };
  await handleHook('claude', JSON.stringify({ session_id: 's2', hook_event_name: 'UserPromptSubmit' }), opts);
  const a = island(relays[0].socketPath, 'always');
  await wait(150);
  const ask = (tool) => handleHook('claude', JSON.stringify({ session_id: 's2', hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: { command: 'ls' } }), opts);
  assert.match(await ask('Bash'), /allow/);
  a.close();
  await wait(100);
  assert.match(await ask('Bash'), /allow/, 'remembered without asking again');
  const d = island(relays[0].socketPath, 'deny');
  t.after(d.close);
  await wait(150);
  assert.match(await ask('Write'), /"behavior":"deny"/);
});

test('with no island, a permission request falls back to the terminal (prints nothing)', async (t) => {
  const dir = sockDir();
  const relays = [];
  t.after(() => relays.forEach((r) => r.server.close()));
  const opts = { socketDir: dir, spawnRelay: ({ agent, sessionId, cwd }) => relays.push(runRelay({ agent, sessionId, cwd, socketDir: dir, waitForIslandMs: 200 })) };
  const t0 = Date.now();
  assert.equal(await handleHook('claude', JSON.stringify({ session_id: 's3', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} }), opts), '');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(await handleHook('claude', 'not json', opts), '');
  assert.equal(await handleHook('nope', '{"hook_event_name":"Stop"}', opts), '');
});

test('install adds only ox hooks, keeps everything else, backs up, and uninstall removes only ours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-claude-settings-'));
  const file = path.join(dir, 'settings.json');
  const mine = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-guard.sh' }] }] } };
  fs.writeFileSync(file, JSON.stringify(mine));
  const plan = planInstall('claude', { file });
  assert.ok(plan.changed);
  const backup = applyInstall(plan);
  assert.ok(fs.existsSync(backup));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.ok(installed(after));
  assert.ok(after.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'my-own-guard.sh')), 'your own hook is kept');
  assert.equal(after.hooks.PermissionRequest[0].hooks[0].timeout, 120);
  assert.equal(planInstall('claude', { file }).changed, false, 'installing twice changes nothing');
  applyInstall(planInstall('claude', { file, remove: true }));
  const removed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!installed(removed));
  assert.deepEqual(removed, mine);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => planInstall('claude', { file }), /not valid JSON/);
  assert.deepEqual(withHooks({}, { remove: true }), {});
});

test('Gemini CLI, Cursor and Copilot CLI: each in its own format, payloads read as one shape', async (t) => {
  const { normalize, decisionOutput: out } = await import('../src/agent-hooks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agents-'));
  // Gemini: groups with a * matcher everywhere, ms timeouts, the event on the command line.
  const g = path.join(dir, 'gemini.json');
  fs.writeFileSync(g, JSON.stringify({ theme: 'dark' }));
  applyInstall(planInstall('gemini', { file: g }));
  const gd = JSON.parse(fs.readFileSync(g, 'utf8'));
  assert.equal(gd.theme, 'dark');
  assert.equal(gd.hooks.BeforeTool[0].matcher, '*');
  assert.equal(gd.hooks.BeforeTool[0].hooks[0].timeout, 5000);
  assert.match(gd.hooks.BeforeTool[0].hooks[0].command, /hook gemini BeforeTool$/);
  assert.equal(gd.hooks.AfterModel, undefined, 'AfterModel would flood the island');
  // Cursor: flat entries and a version.
  const cu = path.join(dir, 'cursor.json');
  applyInstall(planInstall('cursor', { file: cu }));
  const cd = JSON.parse(fs.readFileSync(cu, 'utf8'));
  assert.equal(cd.version, 1);
  assert.match(cd.hooks.preToolUse[0].command, /hook cursor$/);
  // Copilot: its own file, bash + timeoutSec, and removing the last entry leaves nothing.
  const co = path.join(dir, 'copilot.json');
  applyInstall(planInstall('copilot', { file: co }));
  const cod = JSON.parse(fs.readFileSync(co, 'utf8'));
  assert.equal(cod.hooks.permissionRequest[0].timeoutSec, 120);
  assert.match(cod.hooks.permissionRequest[0].bash, /hook copilot permissionRequest$/);
  applyInstall(planInstall('copilot', { file: co, remove: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(co, 'utf8')), {});
  // Payloads: every agent's names become Claude Code's.
  const gem = normalize({ toolCall: { name: 'run_shell_command', args: { CommandLine: 'npm test' } }, conversationId: 'c1', workspacePaths: ['/w'] }, 'BeforeTool');
  assert.deepEqual([gem.hook_event_name, gem.tool_name, gem.tool_input.command, gem.session_id, gem.cwd], ['PreToolUse', 'run_shell_command', 'npm test', 'c1', '/w']);
  const cop = normalize({ toolName: 'bash', toolArgs: '{"command":"ls"}', workdir: '/p' }, 'permissionRequest');
  assert.deepEqual([cop.hook_event_name, cop.tool_input.command, cop.cwd], ['PermissionRequest', 'ls', '/p']);
  assert.equal(normalize({ hook_event_name: 'stop', status: 'error' }).hook_event_name, 'StopFailure');
  assert.equal(normalize({ tool_name: 'Bash', toolName: 'other' }).tool_name, 'Bash', 'what the payload says is never overwritten');
  // Copilot is fail-closed: always valid JSON, "ask" when nobody clicked.
  assert.equal(out('ask', 'bare'), '{"permissionDecision":"ask"}');
  assert.equal(out('always', 'bare'), '{"permissionDecision":"allow"}');
  assert.equal(out('allow', 'none'), '');
  // A Copilot permission request with no island answers "ask", never nothing.
  const sd = sockDir();
  const relays = [];
  t.after(() => relays.forEach((r) => r.server.close()));
  const opts = { socketDir: sd, event: 'permissionRequest', spawnRelay: ({ agent, sessionId, cwd }) => relays.push(runRelay({ agent, sessionId, cwd, socketDir: sd, waitForIslandMs: 100 })) };
  assert.equal(await handleHook('copilot', JSON.stringify({ sessionId: 's9', toolName: 'bash', toolArgs: { command: 'ls' } }), opts), '{"permissionDecision":"ask"}');
  assert.equal(await handleHook('copilot', 'garbage', opts), '{"permissionDecision":"ask"}');
});

test('Codex: hooks.json groups without a matcher, its own mark, and its tools read as ox tools', async () => {
  const { toolName, preview } = await import('../src/agent-hooks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-codex-'));
  const file = path.join(dir, 'hooks.json');
  applyInstall(planInstall('codex', { file }));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(installed(doc, 'codex'));
  assert.ok(!installed(doc, 'claude'), 'one agent never counts as another');
  assert.equal(doc.hooks.PreToolUse[0].matcher, undefined);
  assert.equal(doc.hooks.PermissionRequest[0].hooks[0].timeout, 120);
  assert.match(doc.hooks.PermissionRequest[0].hooks[0].statusMessage, /OX Island/);
  assert.match(doc.hooks.SessionStart[0].hooks[0].command, /hook codex$/);
  // Claude Code's hooks and Codex's live side by side in one document.
  const both = withHooks(withHooks({}, { agent: 'claude' }), { agent: 'codex' });
  assert.ok(installed(both, 'claude') && installed(both, 'codex'));
  assert.ok(installed(withHooks(both, { agent: 'codex', remove: true }), 'claude'));
  assert.equal(toolName('apply_patch'), 'edit_file');
  assert.equal(toolName('exec_command'), 'bash');
  assert.equal(preview({ command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch' }), 'src/app.ts');
  assert.equal(preview({ command: ['git', 'status'] }), 'git status');
});
