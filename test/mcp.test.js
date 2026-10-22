import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MCP_STARTUP_TIMEOUT_MS, McpHub } from '../src/mcp.js';

const FIXTURE = [
  "import readline from 'node:readline';",
  "const mode = process.argv[2] || 'main';",
  'const rl = readline.createInterface({ input: process.stdin });',
  "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
  'const reply = (id, result) => send({ jsonrpc: "2.0", id, result });',
  'rl.on("line", (line) => {',
  '  let msg;',
  '  try { msg = JSON.parse(line); } catch { return; }',
  '  if (msg.id !== undefined && msg.method === undefined) {',
  '    if (String(msg.id).startsWith("srv-ping")) process.stderr.write(`PING_REPLY ${JSON.stringify(msg.result)}\\n`);',
  '    return;',
  '  }',
  '  if (msg.method === "initialize") {',
  '    reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } });',
  '    return;',
  '  }',
  '  if (msg.method === "notifications/initialized") {',
  '    if (mode === "main") send({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping" });',
  '    return;',
  '  }',
  '  if (msg.method === "notifications/cancelled") {',
  '    process.stderr.write(`CANCELLED ${msg.params && msg.params.requestId}\\n`);',
  '    return;',
  '  }',
  '  if (msg.method === "tools/list") {',
  '    const cursor = msg.params && msg.params.cursor;',
  '    const page = mode === "calls"',
  '      ? { tools: [{ name: "errtool", description: "always errors", inputSchema: { type: "object" } }, { name: "rpcfail", description: "protocol error", inputSchema: { type: "object" } }] }',
  '      : mode === "overflow"',
  '      ? { tools: [{ name: "flood", description: "floods stdout", inputSchema: { type: "object" } }] }',
  '      : cursor ? { tools: [{ name: "b", description: "tool b", inputSchema: { type: "object" } }] } : { tools: [{ name: "a", description: "tool a", inputSchema: { type: "object" } }], nextCursor: "page-2" };',
  '    reply(msg.id, page);',
  '    return;',
  '  }',
  '  if (msg.method === "tools/call") {',
  "    if (mode === 'overflow') {",
  '      if (!global.__flooding) {',
  '        global.__flooding = true;',
  "        const chunk = Buffer.alloc(1024 * 1024, 0x78).toString('utf8');",
  '        const iv = setInterval(() => process.stdout.write(chunk), 5);',
  '        setTimeout(() => clearInterval(iv), 60000);',
  '      }',
  '      return;',
  '    }',
  '    const name = msg.params.name;',
  '    if (mode === "slow") { setTimeout(() => reply(msg.id, { content: [{ type: "text", text: "late" }] }), 300); return; }',
  '    if (name === "a") reply(msg.id, { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] });',
  '    else if (name === "errtool") reply(msg.id, { isError: true, content: [{ type: "text", text: "nope" }] });',
  '    else if (name === "rpcfail") send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } });',
  '    else reply(msg.id, { content: [] });',
  '    return;',
  '  }',
  '});',
].join('\n');

let root;
let fixture;
let mainHub;
let slowHub;
let overflowHub;

test('MCP startup timeout accommodates real servers with expensive initialization', () => {
  assert.equal(DEFAULT_MCP_STARTUP_TIMEOUT_MS, 30_000);
  assert.equal(new McpHub({}).startupTimeoutMs, DEFAULT_MCP_STARTUP_TIMEOUT_MS);
  assert.equal(new McpHub({}, { startupTimeoutMs: 5000 }).startupTimeoutMs, 5000, 'explicit test and user overrides remain respected');
});

async function waitFor(fn, ms = 2000, step = 20) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mcp-'));
  fixture = path.join(root, 'fixture-server.mjs');
  fs.writeFileSync(fixture, FIXTURE);
  mainHub = new McpHub(
    {
      t: { command: process.execPath, args: [fixture, 'main'] },
      u: { command: process.execPath, args: [fixture, 'calls'] },
    },
    { startupTimeoutMs: 5000, callTimeoutMs: 5000 }
  );
  await mainHub.start();
});

after(async () => {
  try { await mainHub?.stop(); } catch {}
  try { await slowHub?.stop(); } catch {}
  try { await overflowHub?.stop(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test('start completes legacy initialize handshake; status() reflects ok; ping answered {}', async () => {
  const st = mainHub.status();
  assert.equal(st.length, 2);
  const t = st.find((x) => x.server === 't');
  assert.equal(t.status, 'ok');
  assert.ok(await waitFor(() => (mainHub.status().find((x) => x.server === 't').stderrTail ?? '').includes('PING_REPLY {}')), 'server-initiated ping must be answered with {}');
});

test('tools/list pagination across two pages via nextCursor', () => {
  assert.deepEqual(mainHub.schemas().filter((s) => s.name.startsWith('mcp__t__')).map((s) => s.name), ['mcp__t__a', 'mcp__t__b']);
  assert.deepEqual(mainHub.status().find((x) => x.server === 't').tools, 2);
});

test('tools/call success joins text content', async () => {
  const res = await mainHub.call('mcp__t__a', {});
  assert.equal(res.content, 'hello\nworld');
  assert.ok(!res.isError);
});

test('isError:true surfaced as { isError: true }', async () => {
  const res = await mainHub.call('mcp__u__errtool', {});
  assert.equal(res.isError, true);
  assert.equal(res.content, 'nope');
});

test('JSON-RPC protocol error surfaced as content with code', async () => {
  const res = await mainHub.call('mcp__u__rpcfail', {});
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('-32000'), res.content);
  assert.ok(res.content.includes('boom'), res.content);
});

test('unknown qualified tool returns isError result', async () => {
  const res = await mainHub.call('mcp__t__missing', {});
  assert.equal(res.isError, true);
  assert.ok(res.content.includes('not found'));
});

test('restart() respawns the child and re-lists tools', async () => {
  await mainHub.restart('t');
  assert.equal(mainHub.status().find((x) => x.server === 't').status, 'ok');
  assert.deepEqual(mainHub.schemas().filter((s) => s.name.startsWith('mcp__t__')).map((s) => s.name), ['mcp__t__a', 'mcp__t__b']);
});

test('stop() terminates the child within ~2s (stdin close → SIGTERM ladder)', async () => {
  const state = mainHub.servers.get('t');
  const pid = state.proc.pid;
  const t0 = Date.now();
  await mainHub.stop();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `stop took ${elapsed}ms`);
  assert.equal(state.proc, null);
  assert.equal(mainHub.status()[0].status, 'stopped');
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'child must be dead');
});

test('delayed reply rejects after callTimeoutMs and sends notifications/cancelled', async () => {
  slowHub = new McpHub({ t: { command: process.execPath, args: [fixture, 'slow'] } }, { startupTimeoutMs: 5000, callTimeoutMs: 150 });
  await slowHub.start();
  await assert.rejects(slowHub.call('mcp__t__a', {}), /timed out after 150ms/);
  assert.ok(await waitFor(() => (slowHub.status()[0].stderrTail ?? '').includes('CANCELLED')), 'hub must notify notifications/cancelled');
  await slowHub.stop();
});

test('stdout frame buffer >10MB kills the child, marks overflow and rejects pending calls', async () => {
  overflowHub = new McpHub(
    { o: { command: process.execPath, args: [fixture, 'overflow'] } },
    // Generous: this tests the overflow, not speed, and writing 10MB through a
    // pipe on a loaded machine has taken longer than 15s.
    { startupTimeoutMs: 20000, callTimeoutMs: 60000 }
  );
  await overflowHub.start();
  assert.equal(overflowHub.status()[0].status, 'ok');
  const res = await overflowHub.call('mcp__o__flood', {});
  assert.equal(res.isError, true);
  assert.match(res.content, /overflow/);
  const row = overflowHub.status().find((x) => x.server === 'o');
  assert.equal(row.status, 'overflow');
  const followup = await overflowHub.call('mcp__o__flood', {});
  assert.equal(followup.isError, true);
  assert.match(followup.content, /overflow/);
});
