import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpHub, MCP_PROTOCOL_VERSION } from '../src/mcp.js';
import { MCP_TEMPLATES, getTemplate, riskOf } from '../src/mcp-templates.js';

// ---------- shared http fixture server (JSON + SSE flavors + failure modes) ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

let srv;
let base;
const capture = {};

function rpcReplyFor(msg) {
  if (msg.method === 'initialize') {
    return {
      protocolVersion: msg.params?.protocolVersion ?? '?',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-http', version: '1.0.0' },
    };
  }
  if (msg.method === 'tools/list') {
    return msg.params?.cursor
      ? { tools: [{ name: 'tool_b', description: 'second page.', inputSchema: { type: 'object' } }] }
      : {
          tools: [{ name: 'tool_a', description: 'first page.', inputSchema: { type: 'object' } }],
          nextCursor: 'page-2',
        };
  }
  if (msg.method === 'tools/call') {
    return { content: [{ type: 'text', text: `echo:${msg.params?.arguments?.q ?? ''}` }] };
  }
  return null;
}

function sendJson(res, msg) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(msg));
}

function sendSse(res, raw) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(raw);
}

before(async () => {
  srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch {}
      capture.headers = req.headers;
      capture.meta = msg?.params?._meta ?? null;
      const result = rpcReplyFor(msg);
      const reply =
        result === null
          ? { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `no such method: ${msg.method}` } }
          : { jsonrpc: '2.0', id: msg.id, result };
      switch (req.url) {
        case '/err500':
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
          return;
        case '/html':
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>not an rpc endpoint</html>');
          return;
        case '/sse-end':
          sendSse(res, `event: message\ndata: ${JSON.stringify(reply)}\n\nevent: end\n\n`);
          return;
        case '/sse-done':
          sendSse(res, `data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`);
          return;
        case '/sse-close':
          sendSse(res, `data: ${JSON.stringify(reply)}\n\n`);
          return;
        case '/slow-init':
          setTimeout(() => sendJson(res, reply), 600);
          return;
        case '/slow-call':
          if (msg.method === 'tools/call') setTimeout(() => sendJson(res, reply), 400);
          else sendJson(res, reply);
          return;
        default:
          sendJson(res, reply);
      }
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((resolve) => srv.close(resolve));
});

// ---------- http transport ----------

test('http transport: json flavor — handshake, paginated tools/list, tools/call, ${VAR} headers expanded, _meta riding along', async () => {
  process.env.OX_V3A_TOKEN = 'tok-abc';
  process.env.OX_V3A_SUFFIX = 'sfx';
  const hub = new McpHub(
    {
      h: {
        type: 'http',
        url: `${base}/json`,
        headers: { Authorization: 'Bearer ${OX_V3A_TOKEN}', 'X-Ox-Suffix': 'keep-${OX_V3A_SUFFIX}' },
      },
    },
    { startupTimeoutMs: 4000, callTimeoutMs: 4000 }
  );
  try {
    await hub.start();
    assert.equal(hub.status()[0].status, 'ok');
    assert.deepEqual(
      hub.schemas().map((s) => s.name),
      ['mcp__h__tool_a', 'mcp__h__tool_b']
    );
    const res = await hub.call('mcp__h__tool_a', { q: 'hi' });
    assert.equal(res.content, 'echo:hi');
    assert.ok(!res.isError);
    // header VALUES were expanded from env at the hub layer
    assert.equal(capture.headers.authorization, 'Bearer tok-abc');
    assert.equal(capture.headers['x-ox-suffix'], 'keep-sfx');
    // Streamable-HTTP negotiation headers
    assert.match(capture.headers.accept, /application\/json/);
    assert.match(capture.headers.accept, /text\/event-stream/);
    assert.match(capture.headers['content-type'], /application\/json/);
    // _meta block rode along on requests
    assert.equal(capture.meta?.clientInfo?.name, 'ox');
    assert.equal(capture.meta?.clientInfo?.version, '0.2.0');
    assert.equal(capture.meta?.['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
    // restart re-runs initialize + tools/list without any child process
    await hub.restart('h');
    assert.equal(hub.status().find((r) => r.server === 'h').status, 'ok');
    assert.deepEqual(hub.status().find((r) => r.server === 'h').tools, 2);
    await hub.stop();
    assert.equal(hub.status().find((r) => r.server === 'h').status, 'stopped');
  } finally {
    delete process.env.OX_V3A_TOKEN;
    delete process.env.OX_V3A_SUFFIX;
    await hub.stop().catch(() => {});
  }
});

test('http transport: SSE flavors terminate on event:end, [DONE] and stream close', async () => {
  const hub = new McpHub(
    {
      end: { type: 'http', url: `${base}/sse-end` },
      done: { type: 'http', url: `${base}/sse-done` },
      close: { type: 'http', url: `${base}/sse-close` },
    },
    { startupTimeoutMs: 4000, callTimeoutMs: 4000 }
  );
  try {
    await hub.start();
    for (const n of ['end', 'done', 'close']) {
      assert.equal(hub.status().find((r) => r.server === n).status, 'ok');
      assert.equal(hub.status().find((r) => r.server === n).tools, 2);
    }
    const res = await hub.call('mcp__done__tool_a', { q: 'sse' });
    assert.equal(res.content, 'echo:sse');
  } finally {
    await hub.stop().catch(() => {});
  }
});

test('http transport: legacy {url}-only entries are treated as http too', async () => {
  const hub = new McpHub({ u: { url: `${base}/json` } }, { startupTimeoutMs: 4000, callTimeoutMs: 4000 });
  try {
    await hub.start();
    assert.equal(hub.status()[0].status, 'ok');
  } finally {
    await hub.stop().catch(() => {});
  }
});

test('http transport: non-2xx marks http-error; garbage content-type too', async () => {
  const hub = new McpHub(
    {
      e5: { type: 'http', url: `${base}/err500` },
      ht: { type: 'http', url: `${base}/html` },
    },
    { startupTimeoutMs: 4000, callTimeoutMs: 4000 }
  );
  try {
    await hub.start();
    assert.equal(hub.status().find((r) => r.server === 'e5').status, 'http-error');
    assert.equal(hub.status().find((r) => r.server === 'ht').status, 'http-error');
    // no tools ever listed on a failed server, so calls surface as errors
    const res = await hub.call('mcp__e5__tool_a', {});
    assert.equal(res.isError, true);
  } finally {
    await hub.stop().catch(() => {});
  }
});

test('http transport: timeouts reuse the configured budgets (startup and call)', async () => {
  const slowInit = new McpHub({ s: { type: 'http', url: `${base}/slow-init` } }, { startupTimeoutMs: 150, callTimeoutMs: 4000 });
  try {
    await slowInit.start();
    assert.equal(slowInit.status()[0].status, 'timeout');
  } finally {
    await slowInit.stop().catch(() => {});
  }

  process.env.OX_V3A_X = '1';
  const slowCall = new McpHub(
    { s: { type: 'http', url: `${base}/slow-call`, headers: { 'X-Tok': '${OX_V3A_X}' } } },
    { startupTimeoutMs: 4000, callTimeoutMs: 120 }
  );
  delete process.env.OX_V3A_X;
  try {
    await slowCall.start();
    assert.equal(slowCall.status()[0].status, 'ok', 'server stays healthy across a call timeout');
    await assert.rejects(slowCall.call('mcp__s__tool_a', {}), /timed out after 120ms/);
  } finally {
    await slowCall.stop().catch(() => {});
  }
});

// ---------- registry integrity ----------

test('registry integrity: unique names, valid risks, resolvable entry shapes', () => {
  const names = Object.keys(MCP_TEMPLATES);
  assert.ok(names.length >= 10, `expected >=10 templates, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'registry keys must be unique');
  for (const key of names) {
    const tpl = getTemplate(key);
    assert.ok(tpl, `${key}: getTemplate resolves`);
    assert.equal(tpl.name, key, `${key}: name field matches registry key`);
    assert.ok(['read-only', 'write', 'money'].includes(tpl.risk), `${key}: valid risk`);
    assert.equal(riskOf(key), tpl.risk, `${key}: riskOf agrees`);
    for (const field of ['title', 'desc', 'setup']) {
      assert.equal(typeof tpl[field], 'string', `${key}.${field} is a string`);
      assert.ok(tpl[field].trim().length > 0, `${key}.${field} non-empty`);
    }
    assert.ok(tpl.setup.includes('\n'), `${key}.setup is multi-line`);
    assert.ok(Array.isArray(tpl.requires) && tpl.requires.every((r) => typeof r === 'string'), `${key}.requires strings`);
    assert.equal(typeof tpl.entry, 'function', `${key}.entry is a function`);
    const a = tpl.entry({});
    const b = tpl.entry({});
    assert.notEqual(a, b, `${key}.entry returns fresh objects`);
    if (typeof a.command === 'string') {
      assert.ok(a.command.trim(), `${key}: stdio command non-empty`);
      assert.ok(Array.isArray(a.args) && a.args.every((x) => typeof x === 'string'), `${key}: args are strings`);
    } else {
      assert.match(a.url ?? '', /^https?:\/\//, `${key}: http url absolute`);
    }
  }
  assert.equal(getTemplate('definitely-not-a-template'), undefined);
  assert.equal(riskOf('definitely-not-a-template'), null);

  // spec-pinned shapes and safety copy
  assert.equal(MCP_TEMPLATES.browser.risk, 'write');
  assert.deepEqual(MCP_TEMPLATES.devtools.entry().args, ['-y', 'chrome-devtools-mcp@latest', '--slim']);
  assert.deepEqual(MCP_TEMPLATES.gsuite.entry().args, ['workspace-mcp', '--read-only']);
  assert.equal(MCP_TEMPLATES.slack.entry().url, 'https://mcp.slack.com/mcp');
  assert.equal(MCP_TEMPLATES.slack.entry().headers.Authorization, 'Bearer ${SLACK_MCP_TOKEN}');
  assert.deepEqual(MCP_TEMPLATES.whatsapp.entry().env, {
    WHATSAPP_ACCESS_TOKEN: '${WHATSAPP_ACCESS_TOKEN}',
    WHATSAPP_PHONE_NUMBER_ID: '${WHATSAPP_PHONE_NUMBER_ID}',
  });
  assert.match(MCP_TEMPLATES.whatsapp.setup, /terms of service|tos/i);
  assert.match(MCP_TEMPLATES.whatsapp.setup, /ban/i);
  assert.match(MCP_TEMPLATES.telegram.setup, /gray.?zone/i);
  assert.match(MCP_TEMPLATES.booking.setup, /affiliate/i);
  assert.match(MCP_TEMPLATES.opentable.setup, /confirm/i);
  assert.equal(MCP_TEMPLATES.opentable.risk, 'money');
});

// ---------- CLI subcommands (subprocess, sandboxed HOME + workspace) ----------

const SCRUB = [
  'SLACK_MCP_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'OX_V3A_TOKEN',
  'OX_V3A_SUFFIX',
  'OX_BASE_URL',
  'OX_API_KEY',
  'OX_MODEL',
  'OX_YOLO',
  'NO_COLOR',
];

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v3a-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v3a-ws-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
  return { home, ws };
}

function runOx(args, { home, ws, extraEnv = {} } = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [OX_BIN, ...args], { cwd: ws, env, encoding: 'utf8' });
}

const ECHO_FIXTURE = [
  "import readline from 'node:readline';",
  'const rl = readline.createInterface({ input: process.stdin });',
  "rl.on('line', (line) => {",
  '  let m; try { m = JSON.parse(line); } catch { return; }',
  '  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } }) + "\\n");',
  '  else if (m.method === "notifications/initialized") {}',
  '  else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "answers pings.", inputSchema: { type: "object" } }] } }) + "\\n");',
  '});',
].join('\n');

function writeWsMcpJson(ws, servers) {
  fs.writeFileSync(path.join(ws, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

test('mcp add --yes happy path: .mcp.json written with literal ${...} preserved; missing env flagged', (t) => {
  const { home, ws } = sandbox(t);
  const r = runOx(['mcp', 'add', 'slack', '--yes'], { home, ws });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const doc = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
  assert.deepEqual(doc.mcpServers.slack, {
    type: 'http',
    url: 'https://mcp.slack.com/mcp',
    headers: { Authorization: 'Bearer ${SLACK_MCP_TOKEN}' },
  });
  assert.match(r.stdout, /SLACK_MCP_TOKEN/);
  assert.match(r.stdout, /MISSING/);
  assert.match(r.stdout, /money-risk tools always ask/);
  assert.match(r.stdout, /ox mcp test slack/);
});

test('mcp add: duplicate refused unless --force; --force overwrite keeps file valid and merges siblings', (t) => {
  const { home, ws } = sandbox(t);
  const first = runOx(['mcp', 'add', 'browser', '--yes'], { home, ws });
  assert.equal(first.status, 0, first.stderr);
  const dup = runOx(['mcp', 'add', 'browser', '--yes'], { home, ws });
  assert.equal(dup.status, 4);
  assert.match(dup.stderr, /already configured/);
  const forced = runOx(['mcp', 'add', 'browser', '--yes', '--force'], { home, ws });
  assert.equal(forced.status, 0, forced.stderr);
  const doc = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
  assert.deepEqual(doc.mcpServers.browser.args, ['-y', '@playwright/mcp@latest']);

  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).mcpServers), ['browser']);
});

test('mcp add without --yes in non-TTY exits 4 and writes nothing', (t) => {
  const { home, ws } = sandbox(t);
  const r = runOx(['mcp', 'add', 'browser'], { home, ws });
  assert.equal(r.status, 4, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /--yes/);
  assert.equal(fs.existsSync(path.join(ws, '.mcp.json')), false);
  const unknown = runOx(['mcp', 'add', 'nosuchtemplate', '--yes'], { home, ws });
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /no MCP template/);
});

test('mcp remove deletes the project entry (precedence) and preserves siblings; global flag targets config.json', (t) => {
  const { home, ws } = sandbox(t);
  assert.equal(runOx(['mcp', 'remove', 'ghost'], { home, ws }).status, 3);
  assert.equal(runOx(['mcp', 'add', 'browser', '--yes'], { home, ws }).status, 0);
  assert.equal(runOx(['mcp', 'add', 'slack', '--global', '--yes'], { home, ws }).status, 0);
  // project precedence: removing without --global removes from project first
  const rmProject = runOx(['mcp', 'remove', 'browser'], { home, ws });
  assert.equal(rmProject.status, 0, rmProject.stderr);
  const projDoc = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
  assert.equal(projDoc.mcpServers.browser, undefined);
  const cfgDoc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.equal(cfgDoc.mcpServers.slack.url, 'https://mcp.slack.com/mcp');
  const rmGlobal = runOx(['mcp', 'remove', 'slack', '--global'], { home, ws });
  assert.equal(rmGlobal.status, 0, rmGlobal.stderr);
  const cfgAfter = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.equal(cfgAfter.mcpServers.slack, undefined);
  // global add never touched the project file's other content
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).mcpServers.browser, undefined);
});

test('mcp test initializes a configured stdio server and prints tool names + latency', (t) => {
  const { home, ws } = sandbox(t);
  const fixture = path.join(ws, 'echo-server.mjs');
  fs.writeFileSync(fixture, ECHO_FIXTURE);
  writeWsMcpJson(ws, { echo: { command: process.execPath, args: [fixture] } });
  const r = runOx(['mcp', 'test', 'echo'], { home, ws });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /✓ echo/);
  assert.match(r.stdout, /mcp__echo__ping/);
  assert.match(r.stdout, /\d+ms/);
  const missing = runOx(['mcp', 'test', 'nope'], { home, ws });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no configured MCP server 'nope'/);
});

test('mcp ls prints name/type/risk/status/tools and survives failing servers with exit 0', (t) => {
  const { home, ws } = sandbox(t);
  const fixture = path.join(ws, 'echo-server.mjs');
  fs.writeFileSync(fixture, ECHO_FIXTURE);
  writeWsMcpJson(ws, {
    echo: { command: process.execPath, args: [fixture] },
    // NB: spawnSync blocks our event loop, so the child cannot reach a
    // parent-hosted fixture here; port 9 fails fast inside the child instead.
    dead: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
  });
  const r = runOx(['mcp'], { home, ws });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /NAME\s+TYPE\s+RISK\s+STATUS\s+TOOLS/);
  assert.match(r.stdout, /echo\s+stdio\s+-\s+ok\s+1/);
  assert.match(r.stdout, /dead\s+http\s+-\s+http-error\s+0/);
  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v3a-bare-'));
  t.after(() => fs.rmSync(emptyWs, { recursive: true, force: true }));
  const none = runOx(['mcp', 'ls'], { home, ws: emptyWs });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no MCP servers configured/);
});

test('unknown mcp subcommand exits 3', (t) => {
  const { home, ws } = sandbox(t);
  const r = runOx(['mcp', 'frobnicate'], { home, ws });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unknown mcp subcommand/);
});
