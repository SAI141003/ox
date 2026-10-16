// The web chat on `ox serve`: GET / is the page, and the chat stream carries
// tool activity as an `ox` extension that OpenAI clients ignore.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-webchat-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-webchat-ws-'));
fs.writeFileSync(path.join(ws, 'SECRET_NOTE.txt'), 'the tool output must never reach the stream\n');
const saved = Object.fromEntries(['HOME', 'OX_BASE_URL', 'OX_API_KEY', 'OX_BOT', 'OX_MODEL', 'OX_SERVE_API_KEY', 'OX_ISLAND'].map((k) => [k, process.env[k]]));
const origCwd = process.cwd();

// A provider that lists the workspace once, then answers.
let turn = 0;
const provider = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    turn++;
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (turn % 2 === 1) {
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ls', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } else {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'one file here.' }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  HOME: home, OX_ISLAND: '0', OX_BOT: 'custom', OX_MODEL: 'mock', OX_API_KEY: 'k',
  OX_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
});
delete process.env.OX_SERVE_API_KEY;
process.chdir(ws);

const { startServer, routeTable } = await import('../src/serve.js');
const port = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = await startServer(port, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await server.close();
  provider.closeAllConnections?.();
  await new Promise((r) => provider.close(r));
  process.chdir(origCwd);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

test('GET / serves the chat page with a locked-down CSP', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await res.text();
  assert.match(html, /<title>ox<\/title>/);
  assert.match(html, /\/v1\/chat\/completions/);
  assert.equal((await fetch(`${base}/chat`)).status, 200);
});

test('the OpenAI route table is unchanged by the page', () => {
  // The OpenAI-compatible surface is the same five routes; everything the app
  // adds lives under /ox/ and is GET or POST.
  const routes = routeTable();
  assert.equal(routes.filter((r) => !r.includes('\\/ox\\/')).length, 5, routes.join('\n'));
  assert.ok(routes.filter((r) => r.includes('\\/ox\\/')).every((r) => /^(GET|POST) \^\\\/ox\\\//.test(r)), routes.join('\n'));
});

test('the stream carries tool activity as an ox extension, never tool output', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'what is here?' }] }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  const chunks = raw.split('\n\n').map((f) => f.replace(/^data: /, '')).filter((d) => d && d !== '[DONE]').map((d) => JSON.parse(d));
  const ox = chunks.map((c) => c.ox).filter(Boolean);
  assert.deepEqual(ox.map((e) => e.type), ['tool-start', 'tool-end']);
  assert.equal(ox[0].name, 'list_dir');
  assert.equal(ox[0].id, ox[1].id);
  for (const c of chunks) assert.equal(c.object, 'chat.completion.chunk', 'every frame is still a valid OpenAI chunk');
  assert.match(chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join(''), /one file here\./);
  assert.doesNotMatch(raw, /SECRET_NOTE|must never reach/, 'tool output stays on the server');
});

test('with an API key set the page loads, but the API it calls is locked', async () => {
  process.env.OX_SERVE_API_KEY = 'web-chat-key';
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer web-chat-key' } })).status, 200);
  } finally {
    delete process.env.OX_SERVE_API_KEY;
  }
});
