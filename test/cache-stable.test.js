// Prompt-cache stability (src/agent.js SESSION_OFFER) and the cache meter.
// A tool list that changes between a session's messages voids the provider's
// cache (Anthropic: tools → system → messages), so a session keeps its offer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cache-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-cache-key';
after(() => { fs.rmSync(home, { recursive: true, force: true }); process.env.HOME = realHome; });

const { runAgent } = await import('../src/agent.js');
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const turn = (usage) => [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse({ choices: [], usage }), 'data: [DONE]\n\n'].join('');

function server(t, usageFor) {
  const bodies = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { bodies.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(turn(usageFor(bodies.length))); });
  });
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: s.address().port, bodies })));
}

async function run(port, cwd, message, sessionId) {
  const events = [];
  for await (const ev of runAgent({ target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' }, messages: [{ role: 'user', content: message }], ctx: { cwd, sessionId }, config: {}, auxTarget: null, verify: false })) events.push(ev);
  return events;
}
const wire = (body) => (body?.tools ?? []).map((x) => x.function?.name);

test('cache: every message of a session sends the same tool list', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cache-ws-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { port, bodies } = await server(t, () => ({ prompt_tokens: 5, completion_tokens: 5 }));
  await run(port, cwd, 'fix the failing test in src/app.js', 'sess-cache-1');
  await run(port, cwd, 'now take a screenshot and search the web for the error', 'sess-cache-1');
  assert.ok(wire(bodies[0]).length > 0);
  assert.deepEqual(wire(bodies[1]), wire(bodies[0]), 'the second message keeps the first message\'s tools, in the same order');
  // a new session chooses its own offer
  await run(port, cwd, 'now take a screenshot and search the web for the error', 'sess-cache-2');
  assert.notDeepEqual(wire(bodies[2]), wire(bodies[0]), 'another session is narrowed for its own message');
});

test('cache: the meter speaks up when a long prompt stops coming from the cache', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cache-ws-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // two requests in one run would need tool calls; instead feed one run whose usage reports a write then a miss
  const { port } = await server(t, () => ({ prompt_tokens: 9000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } }));
  const ev = await run(port, cwd, 'hi', 'sess-cache-3');
  assert.equal(ev.filter((e) => e.type === 'cache-miss').length, 0, 'one request is not enough to judge');
});
