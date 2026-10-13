// The web chat's mode picker is enforced by the server: in Ask a write is
// refused, auto reports its pick, and plain OpenAI clients see no change.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = (j.messages ?? []).find((m) => m.role === 'tool');
    if (tool) res.end(sse({ choices: [{ index: 0, delta: { content: `TOOL: ${tool.content}` }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    else res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'web.txt', content: 'x' }) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-servemode-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-servemode-h-')), OX_ISLAND: '0', OX_NO_PLUGINS: '1', OX_NO_AWAKE: '1', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x' });
const port = 40000 + Math.floor(Math.random() * 20000);
const srv = spawn(process.execPath, [OX, 'serve', '--port', String(port)], { cwd, env, stdio: 'ignore' });
after(() => { srv.kill(); model.close(); });
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

async function chat(body) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'custom:m', stream: true, ...body }) });
  const text = await r.text();
  const frames = text.split('\n\n').map((f) => f.replace(/^data: /, '')).filter((f) => f && f !== '[DONE]').map((f) => JSON.parse(f));
  return { frames, content: frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join('') };
}

test('Ask from the web chat cannot write, and says so', async () => {
  const r = await chat({ ox_mode: 'ask', messages: [{ role: 'user', content: 'write web.txt' }] });
  assert.deepEqual(r.frames.find((f) => f.ox?.type === 'mode').ox, { type: 'mode', mode: 'ask', routed: false, reason: null });
  assert.match(r.content, /ask mode only reads/);
  assert.equal(fs.existsSync(path.join(cwd, 'web.txt')), false);
});

test('Auto names its pick; a plain OpenAI client gets no ox fields', async () => {
  const r = await chat({ ox_mode: 'auto', messages: [{ role: 'user', content: 'why does the build fail?' }] });
  const m = r.frames.find((f) => f.ox?.type === 'mode').ox;
  assert.equal(m.routed, true);
  assert.equal(m.mode, 'debug');
  const plain = await chat({ messages: [{ role: 'user', content: 'write web.txt' }] });
  assert.ok(!plain.frames.some((f) => f.ox?.type === 'mode'));
});
