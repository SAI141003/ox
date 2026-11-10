// Two things that used to throw the provider's cache away in the middle of a run:
// the summary of a long conversation (a separate, full-price transcript), and
// notes the loop wrote into the system prompt (a retry after a failure, a steer).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-cache-gaps-key';
for (const k of ['OX_MODEL_WINDOW', 'OX_COMPACT_AT', 'OX_KEEP_TURNS', 'OX_AUX_BOT', 'OX_COMPACT_CACHED']) delete process.env[k];
after(() => { fs.rmSync(home, { recursive: true, force: true }); process.env.HOME = realHome; });

const { runAgent, canSummarizeInPlace, buildInPlaceSummaryPrompt, TURN_NOTE } = await import('../src/agent.js');

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
function turn({ text = '', calls = [] } = {}) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  calls.forEach((c, index) => out.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }] }, finish_reason: null }] })));
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}
function serve(t, handler) {
  const bodies = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { const p = JSON.parse(b || '{}'); bodies.push(p); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(handler(p, bodies.length - 1)); });
  });
  t.after(() => { s.closeAllConnections?.(); s.close(); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ port: s.address().port, bodies })));
}
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps-ws-')); t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }); return d; };
const run = async (opts) => { const evs = []; for await (const e of runAgent(opts)) evs.push(e); return evs; };
// A provider that caches prompts, pointed at the mock.
const caching = (port) => ({ provider: 'openrouter', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model', keyEnv: 'OX_API_KEY' });
const msg = (role, n) => ({ role, content: `${role} ${'z'.repeat(n)}` });
const long = () => [msg('user', 6000), msg('assistant', 6000), msg('user', 6000), msg('assistant', 6000), msg('user', 200), msg('assistant', 200), msg('user', 200), msg('assistant', 200), { role: 'user', content: 'carry on' }];
const inPlace = (b) => String(b.messages?.at(-1)?.content ?? '').includes('Reply with a summary only');
const transcript = (b) => JSON.stringify(b.messages ?? []).includes('Summarize the following coding-agent');

test('a summary is asked for at the end of the conversation the provider already holds', async (t) => {
  const cwd = tmp(t);
  const srv = await serve(t, (b) => (inPlace(b) ? turn({ text: 'IN_PLACE_SUMMARY kept decisions' }) : turn({ text: 'DONE' })));
  const history = long();
  const events = await run({ target: caching(srv.port), messages: history, ctx: { cwd, modelWindow: 9000, sessionId: 'gaps-1' }, config: { tools: { narrow: false } }, auxTarget: null, verify: false });
  const c = events.find((e) => e.type === 'compaction');
  assert.ok(c, 'the run compacted');
  assert.equal(c.summaryFromCache, true);
  assert.ok(!srv.bodies.some(transcript), 'no separate transcript was sent');
  const ask = srv.bodies.find(inPlace);
  // Everything before the new message is the conversation as it stood: the same system prompt, messages and tools.
  assert.equal(ask.messages[0].role, 'system');
  assert.deepEqual(ask.messages.slice(1, -1).map((m) => m.content.replace(/\n*<recalled-memory>[\s\S]*$/, '')), history.map((m) => m.content));
  const next = srv.bodies[srv.bodies.indexOf(ask) + 1];
  assert.deepEqual(ask.tools, next.tools, 'the same tools, so the cached prefix matches');
  assert.equal(ask.prompt_cache_key, next.prompt_cache_key, 'the same cache key as the run');
  assert.ok(JSON.stringify(next.messages).includes('IN_PLACE_SUMMARY'), 'the run continued from that summary');
});

test('a model that calls a tool instead of summarising gets the transcript way', async (t) => {
  const cwd = tmp(t);
  const srv = await serve(t, (b) => (inPlace(b) ? turn({ text: 'let me look', calls: [{ id: 'c1', name: 'read_file', args: { path: 'x' } }] }) : transcript(b) ? turn({ text: 'TRANSCRIPT_SUMMARY' }) : turn({ text: 'DONE' })));
  const events = await run({ target: caching(srv.port), messages: long(), ctx: { cwd, modelWindow: 9000 }, config: { tools: { narrow: false } }, auxTarget: null, verify: false });
  const c = events.find((e) => e.type === 'compaction');
  assert.equal(c.summaryFromCache, false);
  assert.ok(JSON.stringify(srv.bodies.at(-1).messages).includes('TRANSCRIPT_SUMMARY'));
});

test('when a summary may read the cache', () => {
  const main = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
  assert.equal(canSummarizeInPlace(main, main, {}), true);
  assert.equal(canSummarizeInPlace({ ...main }, main, {}), true);
  assert.equal(canSummarizeInPlace({ provider: 'anthropic', model: 'claude-haiku-5-5' }, main, {}), false, 'a cheaper summariser has no cache of this run');
  assert.equal(canSummarizeInPlace(main, main, { OX_COMPACT_CACHED: '0' }), false);
  assert.equal(canSummarizeInPlace({ provider: 'ollama', model: 'm' }, { provider: 'ollama', model: 'm' }, {}), false, 'a local model has no priced cache');
  assert.equal(canSummarizeInPlace(main, { ...main, chatOnly: true }, {}), false);
  assert.match(buildInPlaceSummaryPrompt({ wordBudget: 150, keptMessages: 4 }), /150 words[\s\S]*last 4 messages/);
});

test('a retry note after a failed tool is said in the conversation; the system prompt does not change', async (t) => {
  const cwd = tmp(t);
  const srv = await serve(t, (_b, i) => (i === 0 ? turn({ calls: [{ id: 'c1', name: 'read_file', args: { path: 'no-such-file.txt' } }] }) : turn({ text: 'DONE' })));
  await run({ target: caching(srv.port), messages: [{ role: 'user', content: 'read it' }], ctx: { cwd, yolo: true }, config: { tools: { narrow: false } }, extraGuidance: 'CALLER-GUIDANCE', auxTarget: null, verify: false });
  const [a, b] = srv.bodies.map((x) => x.messages);
  assert.equal(b[0].content, a[0].content, 'the system prompt is the same on both requests');
  assert.ok(a[0].content.includes('CALLER-GUIDANCE'), 'what the caller asked for stays in the system prompt');
  assert.deepEqual(b.slice(0, a.length), a, 'the second request repeats the first one exactly');
  const note = b.find((m) => m.role === 'user' && String(m.content).startsWith(TURN_NOTE));
  assert.match(note.content, /Previous attempt failed[\s\S]*DIFFERENT APPROACH/);
});

test('a steering note is said once, in the conversation', async (t) => {
  const cwd = tmp(t);
  const srv = await serve(t, (_b, i) => (i === 0 ? turn({ calls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }] }) : turn({ text: 'DONE' })));
  let drains = 0;
  await run({ target: caching(srv.port), messages: [{ role: 'user', content: 'look around' }], ctx: { cwd, yolo: true, _steerInbox: async () => (drains++ === 1 ? '## Steering\n- STEER-NOTE-7' : '') }, config: { tools: { narrow: false } }, auxTarget: null, verify: false });
  const [a, b] = srv.bodies.map((x) => x.messages);
  assert.equal(b[0].content, a[0].content);
  assert.ok(!b[0].content.includes('STEER-NOTE-7'));
  assert.equal(b.filter((m) => m.role === 'user' && String(m.content).includes('STEER-NOTE-7')).length, 1);
  assert.deepEqual(b.slice(0, a.length), a);
});

test('a model that cannot read images is not asked again with the same picture', async () => {
  const { classifyProviderError } = await import('../src/agent.js');
  assert.equal(classifyProviderError('ox[nvidia]: upstream stream error (finish_reason=error, ValueError: Received multimodal data but multimodal processing is not enabled'), 'no-images');
  assert.equal(classifyProviderError('this model does not support image input'), 'no-images');
  assert.equal(classifyProviderError('model does not support tools'), 'no-tools');
  assert.equal(classifyProviderError('HTTP 503 upstream'), 'server');
});
