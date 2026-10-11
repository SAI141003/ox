import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-debug-isolation-'));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OX_')) delete process.env[key];
}
process.env.HOME = home;
process.env.OX_API_KEY = 'isolation-test-key';
process.env.OX_MODEL_WINDOW = '128000';
process.env.OX_REPO_MAP = '0';

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const { runAgent } = await import('../src/agent.js');
const { streamVia } = await import('../src/providers/index.js');
const { makeOpenAICompat } = await import('../src/providers/openai-compat.js');
const { dispatchTool } = await import('../src/tools/index.js');
const { makeSubagentToolHandler, readDescriptor } = await import('../src/subagent.js');
const { createSession, appendEvent, loadSession } = await import('../src/session.js');

function denyGlobalAppends(t) {
  const original = fs.appendFileSync;
  const denied = [];
  t.mock.method(fs, 'appendFileSync', (file, ...args) => {
    const resolved = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
    if (!resolved.startsWith(home + path.sep)) {
      denied.push(resolved);
      throw Object.assign(new Error(`EACCES: sandbox denied append: ${resolved}`), { code: 'EACCES' });
    }
    return original.call(fs, file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(denied, [], 'no global debug-log append attempts, even if caught');
  });
  const diagnostics = t.mock.method(console, 'error', () => {});
  t.after(() => assert.equal(diagnostics.mock.callCount(), 0, 'no unconditional debug console spam'));
}

const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const reply = (text = 'isolated answer', call = null) => [
  sse({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: 'report-1', type: 'function', function: call }] } : { content: text } }] }),
  sse({ choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }),
  sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
  'data: [DONE]\n\n',
].join('');

async function fixture(t, response = { status: 200, body: reply() }) {
  const cwd = fs.mkdtempSync(path.join(home, 'workspace-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, body: JSON.parse(body) });
    res.writeHead(response.status, { 'content-type': 'text/event-stream' });
    res.end(response.body);
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, opts) => {
    assert.equal(new URL(url).origin, new URL(baseUrl).origin, 'only the loopback mock is reachable');
    return originalFetch(url, opts);
  });
  denyGlobalAppends(t);
  return { cwd, requests, target: { provider: 'custom', model: 'mock-model', baseUrl } };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

const options = ({ cwd, target }) => ({
  target,
  ctx: { cwd, modelWindow: 128000 },
  config: { repoMap: false },
  auxTarget: null,
  messages: [{ role: 'user', content: 'Return an isolated answer.' }],
});

test('runAgent reaches the provider with global appends denied and preserves events and session logging', async (t) => {
  const f = await fixture(t);
  const opts = options(f);
  opts.ctx.mcpTools = Array.from({ length: 14 }, (_, i) => ({ server: 'fixture', name: `unused_${i}` }));
  const events = await collect(runAgent(opts));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/v1/chat/completions');
  assert.equal(f.requests[0].method, 'POST');
  assert.ok(f.requests[0].body.tools.some((tool) => tool.function.name === 'read_file'));
  // `context-breakdown` sits next to `context-estimate`: same payload, but
  // segmented, so `/context` reports what was really sent rather than a
  // re-derivation.
  assert.deepEqual(events.map((e) => e.type), [
    'tool-narrowing', 'context-estimate', 'context-breakdown', 'text-delta', 'usage', 'final', 'turn-end', 'usage-total', 'history',
  ]);
  assert.ok(events[1].tokens > events[1].schemaTokens, 'payload estimate includes history AND tool schemas');
  assert.equal(events[1].tokens, events[1].historyTokens + events[1].schemaTokens);
  assert.ok(events[1].schemaTokens > 0, 'the shipped tool offer is counted');
  // The breakdown segments sum to that same payload, and the schema block is a
  // first-class segment rather than an invisible footnote.
  assert.equal(events[2].total.tokens, events[1].tokens, 'segments sum to the payload that ships');
  const schemas = events[2].segments.find((s) => s.id === 'tool-definitions');
  assert.equal(schemas.tokens, events[1].schemaTokens, 'the schema segment is the schema block, exactly');
  assert.ok(schemas.tokens > 0, 'the shipped tool offer is a visible segment');
  assert.ok(events[2].segments.find((s) => s.id === 'system-prompt').tokens > 0, 'the system prompt is a visible segment');
  assert.equal(events[3].text, 'isolated answer');
  assert.equal(events[4].inputTokens, 11);
  assert.equal(events[4].outputTokens, 7);
  assert.deepEqual(events[5].message, { role: 'assistant', content: 'isolated answer' });
  assert.equal(events[7].inputTokens, 11);
  assert.equal(events[7].outputTokens, 7);
  assert.deepEqual(events[8].messages.at(-1), events[5].message);
  const session = createSession(f.cwd);
  for (const event of events) appendEvent(session, event);
  assert.deepEqual(loadSession(session.file).slice(1), events);
});

test('streamVia and the actual OpenAI-compatible adapter preserve text, usage and done under isolation', async (t) => {
  const f = await fixture(t);
  const expected = [
    { type: 'text-delta', text: 'isolated answer' },
    { type: 'usage', inputTokens: 11, outputTokens: 7 },
    { type: 'done', stopReason: 'stop' },
  ];
  assert.deepEqual(await collect(streamVia(f.target, { messages: [] })), expected);
  assert.deepEqual(await collect(makeOpenAICompat()({ ...f.target, messages: [] })), expected);
  assert.equal(f.requests.length, 2);
});

test('provider HTTP errors and agent terminal error/history survive denied global appends', async (t) => {
  const f = await fixture(t, { status: 401, body: 'ISOLATION_AUTH_FAILURE' });
  await assert.rejects(collect(streamVia(f.target, { messages: [] })), /HTTP 401 Unauthorized: ISOLATION_AUTH_FAILURE/);
  await assert.rejects(collect(makeOpenAICompat()({ ...f.target, messages: [] })), /HTTP 401 Unauthorized: ISOLATION_AUTH_FAILURE/);
  const events = await collect(runAgent(options(f)));
  assert.deepEqual(events.map((e) => e.type), [
    'tool-narrowing', 'context-estimate', 'context-breakdown', 'error', 'usage-total', 'history',
  ]);
  assert.match(events[3].error, /provider auth failure:.*HTTP 401.*ISOLATION_AUTH_FAILURE/);
  assert.equal(events[4].inputTokens, 0);
  assert.equal(events[4].outputTokens, 0);
  assert.equal(events[5].messages.at(-1).role, 'user');
  assert.equal(f.requests.length, 3, 'auth failures are not retried');
});

test('subagent dispatch and execution preserve report_result and scoped persistence without debug writes', async (t) => {
  const f = await fixture(t, { status: 200, body: reply('', { name: 'report_result', arguments: JSON.stringify({ output: 'delegated answer' }) }) });
  const handler = makeSubagentToolHandler({ config: { repoMap: false }, target: f.target, auxTarget: null });
  const result = await dispatchTool('subagent', { id: 'isolation-subagent', task: 'Report the answer.' }, {
    cwd: f.cwd, subagentHandler: handler, modelWindow: 128000,
  });
  assert.equal(result.isError, false);
  assert.equal(result.structured.status, 'done');
  assert.equal(result.structured.summary, 'delegated answer');
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].body.tools.some((tool) => tool.function.name === 'report_result'));
  const desc = readDescriptor(f.cwd, 'isolation-subagent');
  assert.equal(desc.status, 'done');
  assert.equal(desc.result, 'delegated answer');
  assert.deepEqual(desc.lessons, []);
});

test('subagent configuration and depth errors remain actionable with global appends denied', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await dispatchTool('subagent', { task: 'Report.' }, { cwd: f.cwd }), {
    content: 'subagent: subagent support is not configured in this context.', isError: true,
  });
  const handler = makeSubagentToolHandler({ config: {}, target: f.target, auxTarget: null });
  const result = await handler({ task: 'Report.' }, { cwd: f.cwd, depth: 2, maxDepth: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content, /max depth 2 reached/);
  assert.equal(f.requests.length, 0);
});
