// End to end: two messages of one session, with memory. The second request
// repeats the first one's messages exactly, so a provider's cache hits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-scr-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-cache-key';
after(() => { fs.rmSync(home, { recursive: true, force: true }); process.env.HOME = realHome; });

const { runAgent } = await import('../src/agent.js');
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const reply = [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }), 'data: [DONE]\n\n'].join('');

test('a session with memory sends the same earlier messages on its next turn', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-scr-ws-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bodies = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { bodies.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(reply); });
  });
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${s.address().port}/v1`, model: 'mock-model' };
  const profile = '# WHAT OX REMEMBERS\nAbout the user (always true until they say otherwise):\n- I work at Stripe';
  const go = async (messages, memoryBlock) => { for await (const _ of runAgent({ target, messages, ctx: { cwd, sessionId: 'scr-1', memoryBlock }, config: {}, auxTarget: null, verify: false })) { /* drain */ } };
  const first = [{ role: 'user', content: 'what does src/app.js do' }];
  await go(first, profile);
  // The client sends the plain conversation back, and memory recalls one more line for the new message.
  await go([...first, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and how do I test it' }], `${profile}\n\nRemembered and relevant to this task:\n- To test this project: \`npm test\``);
  const [a, b] = bodies.map((x) => x.messages);
  assert.match(a[1].content, /<recalled-memory>[\s\S]*I work at Stripe/);
  assert.equal(b[0].content, a[0].content, 'the system prompt did not change');
  assert.equal(b[1].content, a[1].content, 'the first message is what the cache holds');
  const last = b.at(-1).content;
  assert.match(last, /npm test/);
  assert.ok(!last.includes('I work at Stripe'), 'the profile is sent once per conversation');
});
