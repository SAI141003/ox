import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A reply with reasoning but no text and no tool call is not an answer: the run asks again.
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-empty-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-empty-ws-'));
process.env.HOME = home;
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-key';
after(() => { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); });
const { runAgent } = await import('../src/agent.js');

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const reply = (text) => [
  sse({ choices: [{ index: 0, delta: { reasoning_content: 'thinking about it' }, finish_reason: null }] }),
  ...(text ? [sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })] : []),
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
  'data: [DONE]\n\n',
].join('');

test('a reasoning-only reply is followed up, and the real answer ends the run', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b || '{}'); bodies.push(body);
      const asked = JSON.stringify(body.messages ?? []).includes('no answer and no tool call');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply(asked ? 'the answer' : ''));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-model' };
  const events = [];
  for await (const ev of runAgent({ target, cwd: ws, messages: [{ role: 'user', content: 'say hi' }], ctx: { cwd: ws, noTools: true } })) events.push(ev);
  assert.ok(events.some((e) => e.type === 'warning' && /reasoning only/.test(e.text)), 'it noticed the empty reply');
  const chat = bodies.filter((b) => !JSON.stringify(b.messages ?? []).includes('completion auditor'));
  assert.ok(chat.length >= 2, 'it asked again');
  assert.ok(JSON.stringify(events).includes('the answer'));
});
