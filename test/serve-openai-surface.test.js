// ox serve — the OpenAI-compatible HTTP surface.
//
// What these tests hold down, in the order the surface is built:
//
//   1. /v1/models is generated from the REAL bot registry (src/bots.js BOTS).
//      Every advertised id is a bot that exists; the state of each one
//      (does it have the credential it needs) is legible rather than implied.
//   2. /v1/responses accepts the core shape and returns a finished response.
//   3. Every error is the OpenAI error body with a non-200 status.
//   4. With OX_SERVE_API_KEY set, EVERY route rejects an unauthenticated call.
//   5. Auth off + a non-loopback bind is refused before the socket is opened,
//      and auth off on loopback still says so at startup, out loud.
//   6. /health and /v1/chat/completions still behave as they did.
//   7. Every route in this file is bound to 127.0.0.1. Nothing here binds a
//      non-loopback address; the refusal in (5) is asserted on the policy
//      function and on a CLI child that exits before it ever calls listen().
//
// Two rules this file keeps:
//   - HOME is redirected to a temp dir before anything is imported, so a test
//     run cannot write to the developer's real ~/.ox.
//   - The provider keys are scrubbed from process.env and restored afterwards,
//     so "is this model servable?" has one deterministic answer instead of
//     whatever the machine running the suite happens to have exported.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { reserveFreePort } from './helpers/free-port.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OX_BIN = path.join(__dirname, '..', 'bin', 'ox.js');

// --- isolation -------------------------------------------------------------
const origHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-serve-surface-home-'));
process.env.HOME = home;

// Every env var the tests touch, saved so the suite leaves the parent process
// exactly as it found it.
const TOUCHED = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_SERVE_API_KEY', 'OX_SERVE_ALLOW_UNAUTHENTICATED',
  'OX_MODEL', 'OX_FALLBACK_BOTS', 'OX_AUX_BOT', 'OX_MODEL_WINDOW', 'OLLAMA_HOST', 'OX_OLLAMA_BASE_URL',
];
const KEY_ENVS = [
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'BACKBOARD_API_KEY',
];
const saved = new Map([...TOUCHED, ...KEY_ENVS].map(k => [k, process.env[k]]));

function clear(keys) {
  for (const k of keys) delete process.env[k];
}

const { startServer, authExposure, isLoopbackHost, serveModelCatalog, routeTable } = await import('../src/serve.js');
const { BOTS, KEY_ENV } = await import('../src/bots.js');

after(async () => {
  // Release every listener this file opened, or the test process never exits.
  for (const h of [bare, hooked]) { try { if (h) await h.close(); } catch { /* already closed */ } }
  try { if (provider) await provider.close(); } catch { /* already closed */ }
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// --- fixtures --------------------------------------------------------------

// A stand-in upstream provider: ox resolves `custom` against OX_BASE_URL, so
// this is how a turn gets a deterministic answer without a real API key or a
// real network call. It speaks the same SSE shape a provider speaks.
function fakeProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let messages = [];
      try { messages = JSON.parse(body)?.messages ?? []; } catch { /* asserted elsewhere */ }
      const last = messages[messages.length - 1];
      const echo = typeof last?.content === 'string' ? last.content.slice(0, 80) : '';
      const sse = o => `data: ${JSON.stringify(o)}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse({ choices: [{ index: 0, delta: { content: `FAKE(${echo})` }, finish_reason: null }] }) +
        sse({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 13 } }) +
        'data: [DONE]\n\n'
      );
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

// Both serves share one process, so the fake-provider env vars are process
// wide. Cases that must see ox with NO custom endpoint configured remove them
// for the duration of the call — the resolver reads process.env at request
// time, which is why that works.
async function withoutCustomEndpoint(fn) {
  const wasBase = process.env.OX_BASE_URL;
  const wasKey = process.env.OX_API_KEY;
  delete process.env.OX_BASE_URL;
  delete process.env.OX_API_KEY;
  try {
    return await fn();
  } finally {
    if (wasBase === undefined) delete process.env.OX_BASE_URL;
    else process.env.OX_BASE_URL = wasBase;
    if (wasKey === undefined) delete process.env.OX_API_KEY;
    else process.env.OX_API_KEY = wasKey;
  }
}

// Every serve in this file binds 127.0.0.1 and only 127.0.0.1.
async function serveOnLoopback() {
  const port = await reserveFreePort();
  const handle = await startServer(port, '127.0.0.1');
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    close: handle.close,
  };
}

async function req(base, path, { method = 'GET', body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE or deliberately invalid JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') ?? '' };
}

// An OpenAI error body: exactly these four keys, with null rather than absent.
function assertOpenAIError(res, { status, type, code, param }) {
  assert.ok(status >= 400, `expected a non-200 status, got ${status}`);
  assert.equal(res.status, status, `wrong status; body was ${res.text.slice(0, 300)}`);
  assert.ok(res.json && res.json.error, `no error object in ${res.text.slice(0, 300)}`);
  const e = res.json.error;
  assert.deepEqual(
    Object.keys(e).sort(),
    ['code', 'message', 'param', 'type'],
    `error object must carry exactly message/type/param/code — got ${JSON.stringify(Object.keys(e))}`
  );
  assert.equal(typeof e.message, 'string');
  assert.ok(e.message.length > 0, 'error message must not be empty');
  if (type) assert.equal(e.type, type, `error.type: ${e.message}`);
  if (code !== undefined) assert.equal(e.code, code, `error.code: ${e.message}`);
  if (param !== undefined) assert.equal(e.param, param, `error.param: ${e.message}`);
}

let provider;
let bare;    // no OX_BASE_URL, no provider keys
let hooked;  // pointed at the fake provider

before(async () => {
  provider = await fakeProvider();
  clear([...TOUCHED, ...KEY_ENVS]);

  bare = await serveOnLoopback();
  process.env.OX_BASE_URL = provider.baseUrl;
  process.env.OX_API_KEY = 'fake-key';
  hooked = await serveOnLoopback();
});

// --- 1. /v1/models is the real registry ------------------------------------

test('serve: /v1/models is a well-formed list sourced from the real bot registry', async () => {
  const res = await req(bare.base, '/v1/models');
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'list');
  assert.ok(Array.isArray(res.json.data), 'data must be an array');
  assert.ok(res.json.data.length > 0, 'the registry is not empty; the list must not be either');

  const registryIds = new Set(Object.keys(BOTS));
  assert.equal(res.json.ox.registry, 'src/bots.js BOTS');

  for (const m of res.json.data) {
    assert.equal(m.object, 'model', `${m.id} object`);
    assert.ok(registryIds.has(m.id), `${m.id} is advertised but is not a bot in src/bots.js — the list must come from the registry, not from a hand-typed array`);
    assert.equal(typeof m.created, 'number');
    assert.ok(Number.isInteger(m.created) && m.created > 1_600_000_000, `${m.id} created must be a unix timestamp`);

    const def = BOTS[m.id];
    assert.equal(m.owned_by, def.provider, `${m.id} owned_by should name its provider`);
    assert.ok(m.ox, `${m.id} must carry the ox metadata block`);
    assert.equal(m.ox.provider, def.provider);
    assert.equal(m.ox.model, def.model, `${m.id} must advertise the model its bot definition names`);
    assert.equal(m.ox.requires_key, KEY_ENV[def.provider] ?? null);
    assert.equal(typeof m.ox.available, 'boolean', `${m.id} availability must be stated, not guessed by the client`);
    assert.ok(Object.prototype.hasOwnProperty.call(m.ox, 'availability'));
  }

  // The availability claim is computed from the real key env map, so it must
  // agree with that map for an environment whose keys are all absent.
  for (const m of res.json.data) {
    const keyEnv = KEY_ENV[BOTS[m.id].provider] ?? null;
    const expected = !keyEnv || !!process.env[keyEnv];
    assert.equal(m.ox.available, expected, `${m.id} availability disagrees with ${keyEnv}`);
  }
  assert.ok(
    res.json.data.some(m => m.id === 'ox-ollama' && m.ox.available === true),
    'ox-ollama needs no key and must be reported available with the keys unset'
  );
  assert.ok(
    res.json.data.some(m => m.id === 'ox-claude' && m.ox.available === false && m.ox.requires_key === 'ANTHROPIC_API_KEY'),
    'ox-claude must be reported unavailable, and must name the key that would fix it'
  );
});

test('serve: /v1/models withholds a bot with no default model instead of listing a model that cannot answer', async () => {
  const { data, withheld } = serveModelCatalog({});
  const openrouter = BOTS['ox-openrouter'];
  assert.equal(openrouter.model, null, 'this test is about the no-default-model bot; if it grew a model, say so');

  assert.ok(!data.some(m => m.id === 'ox-openrouter'), 'a bot with no model must not be listed as a model');
  const w = withheld.find(x => x.id === 'ox-openrouter');
  assert.ok(w, 'the omission must be reported, not silent');
  assert.equal(w.reason, 'no_default_model');
  assert.ok(Object.keys(BOTS).includes(w.id));
  for (const x of withheld) assert.ok(Object.keys(BOTS).includes(x.id), `${x.id} withheld but is not a real bot`);

  // And the live list agrees with the pure function.
  const res = await req(bare.base, '/v1/models');
  assert.ok(res.json.ox.withheld.some(x => x.id === 'ox-openrouter'));
  assert.equal(res.json.ox.total, data.length);
  assert.equal(res.json.ox.servable_now, data.filter(m => m.ox.available).length);
});

test('serve: GET /v1/models/:id retrieves one real bot, and 404s an OpenAI-shaped error otherwise', async () => {
  const ok = await req(bare.base, '/v1/models/ox-claude');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, 'ox-claude');
  assert.equal(ok.json.object, 'model');
  assert.equal(ok.json.ox.model, BOTS['ox-claude'].model);

  assertOpenAIError(await req(bare.base, '/v1/models/not-a-bot'), {
    status: 404, type: 'invalid_request_error', code: 'model_not_found', param: 'model',
  });
  assert.match((await req(bare.base, '/v1/models/not-a-bot')).json.error.message, /does not exist/);

  // A withheld id IS a real bot, so the 404 must name that reason rather than
  // claim the bot does not exist — the client can act on "needs a model named".
  const withheldRes = await req(bare.base, '/v1/models/ox-openrouter');
  assertOpenAIError(withheldRes, { status: 404, type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
  assert.match(withheldRes.json.error.message, /ox-openrouter/);
  assert.match(withheldRes.json.error.message, /no_default_model/);
  assert.doesNotMatch(withheldRes.json.error.message, /does not exist/, 'a real bot must not be reported as nonexistent');
});

// --- 2. /v1/responses -------------------------------------------------------

test('serve: /v1/responses accepts a minimal request and returns a finished response', async () => {
  const res = await req(hooked.base, '/v1/responses', {
    method: 'POST',
    body: { model: 'fake-model', input: 'hello' },
  });
  assert.equal(res.status, 200, res.text.slice(0, 400));

  const r = res.json;
  assert.equal(r.object, 'response');
  assert.match(r.id, /^resp_/, `id must be a Responses-style id, got ${r.id}`);
  assert.equal(r.status, 'completed');
  assert.equal(r.model, 'fake-model');
  assert.equal(r.error, null);
  assert.equal(r.store, false);
  assert.ok(Number.isInteger(r.created_at) && r.created_at > 1_600_000_000);

  // output / output_text must agree, and the text must be the turn's real text
  // rather than an empty string dressed up as a success.
  const text = r.output?.[0]?.content?.[0]?.text;
  assert.equal(r.output[0].type, 'message');
  assert.equal(r.output[0].role, 'assistant');
  assert.equal(r.output[0].content[0].type, 'output_text');
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('hello'), `the turn did not run: ${JSON.stringify(text)}`);
  assert.equal(r.output_text, text, 'output_text must mirror output[0].content[0].text');
  assert.equal(r.output[0].id, `${r.id}_msg`);

  assert.equal(r.usage.input_tokens, 21);
  assert.equal(r.usage.output_tokens, 13);
  assert.equal(r.usage.total_tokens, 34);
  assert.deepEqual(r.usage.input_tokens_details, { cached_tokens: 0 });
  assert.deepEqual(r.usage.output_tokens_details, { reasoning_tokens: 0 });

  // The honesty marker: this endpoint is a partial implementation and says so.
  assert.match(r.ox.response_api, /partial|core text shape only/);
  assert.ok(r.ox.agent_tools, 'the always-on ox tool set must be declared, not hidden');
});

test('serve: /v1/responses accepts array input, instructions, and text content parts', async () => {
  const res = await req(hooked.base, '/v1/responses', {
    method: 'POST',
    body: {
      model: 'fake-model',
      instructions: 'be terse',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'array form' }] }],
    },
  });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.json.instructions, 'be terse');
  assert.ok(res.json.output_text.includes('array form'), res.json.output_text);
  assert.equal(res.json.output[0].content[0].type, 'output_text');
});

test('serve: /v1/responses streaming emits the event sequence and terminates with [DONE]', async () => {
  const res = await req(hooked.base, '/v1/responses', {
    method: 'POST',
    body: { model: 'fake-model', input: 'stream me', stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/);

  const events = res.text
    .split('\n\n')
    .filter(Boolean)
    .map(chunk => chunk.replace(/^data: /, ''))
    .filter(line => line !== '[DONE]')
    .map(line => JSON.parse(line));
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'), 'the stream must terminate with [DONE]');

  const types = events.map(e => e.type);
  assert.deepEqual(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ], `unexpected event sequence: ${types.join(', ')}`);

  for (const [i, e] of events.entries()) {
    assert.equal(e.sequence_number, i + 1, `sequence_number must be monotonic at ${e.type}`);
  }
  const created = events[0].response;
  assert.equal(created.status, 'in_progress');
  assert.deepEqual(created.output, []);
  assert.equal(created.usage, null, 'an in-flight response has no usage yet');

  const delta = events.find(e => e.type === 'response.output_text.delta');
  assert.ok(delta.delta.includes('stream me'), `no text arrived: ${JSON.stringify(delta)}`);

  const done = events.at(-1).response;
  assert.equal(done.status, 'completed');
  assert.equal(done.id, created.id, 'one response id for the whole stream');
  assert.equal(done.output_text, delta.delta);
  assert.equal(done.usage.total_tokens, 34);

  const itemIds = new Set(events.map(e => e.item_id).filter(Boolean));
  assert.deepEqual([...itemIds], [created.id + '_msg'], 'every part event belongs to the same output item');
});

test('serve: a non-streaming /v1/responses call completes before it responds (no partial object)', async () => {
  // A stream flag that is absent must produce one JSON object and a closed
  // connection — never an SSE body and never a half-filled `output`.
  const res = await req(hooked.base, '/v1/responses', {
    method: 'POST',
    body: { model: 'fake-model', input: 'blocking' },
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  assert.doesNotMatch(res.text, /data: /, 'a non-streaming request must not return SSE');
  assert.equal(res.json.status, 'completed');
  assert.equal(res.json.output.length, 1);
  assert.equal(res.json.output[0].status, 'completed');
  assert.ok(res.json.usage.total_tokens > 0, 'usage must be filled in before the response is sent');
});

// --- 3. OpenAI-shaped errors ------------------------------------------------

test('serve: every failure is an OpenAI error body with a non-200 status', async () => {
  const cases = [
    ['unknown route', () => req(hooked.base, '/v1/nope'), { status: 404, code: 'unknown_url' }],
    ['wrong verb on a real route', () => req(hooked.base, '/v1/responses'), { status: 405, code: 'method_not_allowed' }],
    ['POST to a GET-only route', () => req(hooked.base, '/v1/models', { method: 'POST', body: {} }), { status: 405, code: 'method_not_allowed' }],
    ['invalid JSON', () => req(hooked.base, '/v1/responses', { method: 'POST', body: '{nope' }), { status: 400, code: 'invalid_json' }],
    ['missing model', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { input: 'hi' } }), { status: 400, code: 'missing_required_parameter', param: 'model' }],
    ['missing input', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model' } }), { status: 400, code: 'missing_required_parameter', param: 'input' }],
    ['empty input', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: '  ' } }), { status: 400, code: 'invalid_value', param: 'input' }],
    ['image input part', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://x/y.png' }] }] } }), { status: 400, code: 'unsupported_value', param: 'input' }],
    ['store:true', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi', store: true } }), { status: 400, code: 'unsupported_parameter', param: 'store' }],
    ['previous_response_id', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi', previous_response_id: 'resp_x' } }), { status: 400, code: 'unsupported_parameter', param: 'previous_response_id' }],
    ['background:true', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi', background: true } }), { status: 400, code: 'unsupported_parameter', param: 'background' }],
    ['client function tools', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi', tools: [{ type: 'function', name: 'f' }] } }), { status: 400, code: 'unsupported_parameter', param: 'tools' }],
    ['tool_choice required', () => req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi', tool_choice: 'required' } }), { status: 400, code: 'unsupported_parameter', param: 'tool_choice' }],
    ['missing messages on chat/completions', () => req(hooked.base, '/v1/chat/completions', { method: 'POST', body: { model: 'fake-model' } }), { status: 400, code: 'missing_required_parameter', param: 'messages' }],
  ];

  for (const [name, run, expect] of cases) {
    const res = await run();
    assertOpenAIError(res, expect);
    assert.equal(res.json.error.type, expect.type ?? 'invalid_request_error', name);
  }
});

test('serve: a model that is not in the registry is a 404 model_not_found, not a silent empty 200', async () => {
  // With no custom endpoint configured nothing resolves: this is the case where
  // a typo must be named rather than answered with an empty string.
  const res = await withoutCustomEndpoint(() => req(bare.base, '/v1/responses', {
    method: 'POST',
    body: { model: 'totally-not-a-bot', input: 'hi' },
  }));
  assertOpenAIError(res, { status: 404, type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
  assert.match(res.json.error.message, /totally-not-a-bot/);
});

test('serve: a registry bot whose credential is missing is a 401, not a 500', async () => {
  const res = await withoutCustomEndpoint(() => req(bare.base, '/v1/responses', {
    method: 'POST',
    body: { model: 'ox-claude', input: 'hi' },
  }));
  assertOpenAIError(res, { status: 401, type: 'authentication_error', code: 'invalid_api_key' });
  assert.match(res.json.error.message, /ANTHROPIC_API_KEY/);
});

// --- 4. auth is fail-closed -------------------------------------------------

test('serve: with OX_SERVE_API_KEY set, EVERY route rejects an unauthenticated request', async () => {
  const previous = process.env.OX_SERVE_API_KEY;
  process.env.OX_SERVE_API_KEY = 'test-secret-key-12345';
  try {
    const calls = [
      ['GET', '/health'],
      ['GET', '/v1/models'],
      ['GET', '/v1/models/ox-claude'],
      ['POST', '/v1/chat/completions'],
      ['POST', '/v1/responses'],
    ];
    for (const [method, path] of calls) {
      const res = await req(hooked.base, path, { method, body: method === 'POST' ? { model: 'fake-model', input: 'hi', messages: [{ role: 'user', content: 'hi' }] } : undefined });
      assertOpenAIError(res, { status: 401, type: 'authentication_error', code: 'invalid_api_key' });
    }

    // A wrong token is rejected too — the comparison is not a presence check.
    assertOpenAIError(await req(hooked.base, '/v1/models', { token: 'wrong-key' }), {
      status: 401, type: 'authentication_error', code: 'invalid_api_key',
    });
    assertOpenAIError(await req(hooked.base, '/health', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } }), {
      status: 401, type: 'authentication_error', code: 'invalid_api_key',
    });

    // And the right token gets through on each route.
    assert.equal((await req(hooked.base, '/health', { token: 'test-secret-key-12345' })).status, 200);
    assert.equal((await req(hooked.base, '/v1/models', { token: 'test-secret-key-12345' })).status, 200);
    assert.equal((await req(hooked.base, '/v1/models/ox-claude', { token: 'test-secret-key-12345' })).status, 200);
    assert.equal((await req(hooked.base, '/v1/responses', { method: 'POST', token: 'test-secret-key-12345', body: { model: 'fake-model', input: 'hi' } })).status, 200);
    assert.equal((await req(hooked.base, '/v1/chat/completions', { method: 'POST', token: 'test-secret-key-12345', body: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } })).status, 200);
  } finally {
    if (previous === undefined) delete process.env.OX_SERVE_API_KEY;
    else process.env.OX_SERVE_API_KEY = previous;
  }
});

test('serve: with OX_SERVE_API_KEY unset the routes are OPEN (documented, not accidental)', async () => {
  // This is the actual behaviour, stated as a test so it cannot change
  // quietly: with no key set every route serves without credentials. That is
  // only safe because the bind policy in the next test refuses a non-loopback
  // bind in this state.
  const previous = process.env.OX_SERVE_API_KEY;
  delete process.env.OX_SERVE_API_KEY;
  try {
    assert.equal((await req(hooked.base, '/health')).status, 200, 'no credentials, no key');
    assert.equal((await req(hooked.base, '/v1/models')).status, 200);
    assert.equal((await req(hooked.base, '/v1/responses', { method: 'POST', body: { model: 'fake-model', input: 'hi' } })).status, 200);
    assert.equal((await req(hooked.base, '/v1/chat/completions', { method: 'POST', body: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } })).status, 200);
  } finally {
    if (previous === undefined) delete process.env.OX_SERVE_API_KEY;
    else process.env.OX_SERVE_API_KEY = previous;
  }
});

// --- 5. the non-loopback + auth-off condition --------------------------------

test('serve: auth off on a non-loopback bind is REFUSED, not warned about', async () => {
  // Pure policy first: nothing here opens a socket.
  for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.7', '']) {
    assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} is not loopback`);
    const exposure = authExposure({ host, key: '' });
    assert.equal(exposure.level, 'refuse', `${host} with auth off must be refused`);
    assert.ok(exposure.lines.length > 0, 'a refusal must explain itself');
    assert.match(exposure.lines.join('\n'), /OX_SERVE_API_KEY|127\.0\.0\.1/);
  }
  // With a key, the same binds are fine.
  assert.equal(authExposure({ host: '0.0.0.0', key: 'a-secret' }).level, 'ok');
  assert.equal(authExposure({ host: '0.0.0.0', key: 'a-secret' }).lines.length, 0);
  // The opt-in is an explicit variable, not a default.
  assert.equal(authExposure({ host: '0.0.0.0', key: '', allowUnauthenticated: false }).level, 'refuse');
  assert.equal(authExposure({ host: '0.0.0.0', key: '', allowUnauthenticated: true }).level, 'warn');
  assert.match(authExposure({ host: '0.0.0.0', key: '', allowUnauthenticated: true }).lines.join('\n'), /OX_SERVE_ALLOW_UNAUTHENTICATED/);

  // And the refusal happens before listen(): this promise rejects and no port
  // is ever bound, so the non-loopback address in this test is never opened.
  await assert.rejects(
    () => startServer(0, '0.0.0.0'),
    /refusing to bind 0\.0\.0\.0 with authentication OFF/,
    'startServer must refuse rather than listen'
  );
});

test('serve: a loopback bind with auth off starts and says so loudly at startup', async () => {
  assert.equal(authExposure({ host: '127.0.0.1', key: '' }).level, 'warn');
  assert.match(authExposure({ host: '127.0.0.1', key: '' }).lines.join('\n'), /NO credentials/);
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }

  const port = await reserveFreePort();
  const child = spawn('node', [OX_BIN, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, OX_SERVE_API_KEY: '', OX_SERVE_ALLOW_UNAUTHENTICATED: '' },
  });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));

  try {
    const deadline = Date.now() + 20_000;
    while (!out.includes('listening on') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.match(out, /listening on http:\/\/127\.0\.0\.1:/, `server never reported ready: ${out}`);
    assert.match(out, /={10,}/, 'the warning must be fenced so it cannot scroll past unseen');
    assert.match(out, /ox serve: OX_SERVE_API_KEY is NOT set/);
    assert.match(out, /NO credentials/);
    assert.match(out, /loopback/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
  }
});

test('serve: `ox serve --host 0.0.0.0` with no key exits non-zero and never opens the port', async () => {
  const port = await reserveFreePort();
  const child = spawn('node', [OX_BIN, 'serve', '--host', '0.0.0.0', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, OX_SERVE_API_KEY: '', OX_SERVE_ALLOW_UNAUTHENTICATED: '' },
  });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  const code = await new Promise(resolve => child.on('exit', resolve));

  assert.notEqual(code, 0, `expected a non-zero exit; output was: ${out}`);
  assert.match(out, /refusing to bind 0\.0\.0\.0 with authentication OFF/);
  assert.doesNotMatch(out, /listening on/, 'it must not have started');

  // Proof the port was never taken: loopback is still free for it.
  const probe = await startServer(port, '127.0.0.1');
  await probe.close();
});

// --- 6. no regression --------------------------------------------------------

test('serve: /health is unchanged', async () => {
  const res = await req(bare.base, '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'ok');
  assert.ok(res.json.timestamp, 'timestamp must be present');
  assert.ok(!Number.isNaN(Date.parse(res.json.timestamp)), 'timestamp must parse as a date');
  assert.deepEqual(Object.keys(res.json).sort(), ['status', 'timestamp']);
});

test('serve: /v1/chat/completions still returns the chat.completion shape, with real text', async () => {
  const res = await req(hooked.base, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'fake-model', messages: [{ role: 'user', content: 'hi chat' }] },
  });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.json.object, 'chat.completion');
  assert.match(res.json.id, /^chatcmpl-/);
  assert.equal(res.json.model, 'fake-model');
  assert.equal(res.json.choices.length, 1);
  assert.equal(res.json.choices[0].index, 0);
  assert.equal(res.json.choices[0].message.role, 'assistant');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.ok(res.json.choices[0].message.content.includes('hi chat'), 'chat completions must carry the turn text');
  assert.equal(res.json.usage.prompt_tokens, 21);
  assert.equal(res.json.usage.completion_tokens, 13);
  assert.equal(res.json.usage.total_tokens, 34);
});

test('serve: /v1/chat/completions still streams chat.completion.chunk frames', async () => {
  const res = await req(hooked.base, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'fake-model', messages: [{ role: 'user', content: 'stream chat' }], stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/);
  const frames = res.text.split('\n\n').filter(Boolean).map(c => c.replace(/^data: /, ''));
  assert.equal(frames.at(-1), '[DONE]');

  const chunks = frames.slice(0, -1).map(f => JSON.parse(f));
  for (const c of chunks) {
    assert.equal(c.object, 'chat.completion.chunk');
    assert.equal(c.model, 'fake-model');
    assert.equal(c.choices[0].index, 0);
  }
  const body = chunks.filter(c => c.choices[0].delta?.content).map(c => c.choices[0].delta.content).join('');
  assert.ok(body.includes('stream chat'), `no text streamed: ${JSON.stringify(chunks)}`);
  const last = chunks.at(-1);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.usage.total_tokens, 34);
});

test('serve: /v1/chat/completions with an unresolvable model name keeps its old lenient contract', async () => {
  // Pre-existing behaviour, deliberately preserved: chat/completions has always
  // accepted any string as `model` and, when the name cannot be resolved,
  // answers 200 with an empty content string. /v1/responses is the strict
  // endpoint (404 model_not_found). This test exists so the difference is a
  // recorded decision rather than an accident.
  const res = await withoutCustomEndpoint(() => req(bare.base, '/v1/chat/completions', {
    method: 'POST',
    body: { model: 'ox', messages: [{ role: 'user', content: 'hi' }] },
  }));
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.ok(res.json.choices);
  assert.equal(typeof res.json.choices[0].message.content, 'string');
});

// --- 7. the shape of the surface itself ---------------------------------------

test('serve: the route table is exactly the documented OpenAI surface', () => {
  // ox's own app routes live under /ox/ and are checked in serve-web-chat.test.js.
  const table = routeTable().filter((r) => !r.includes('\\/ox\\/'));
  assert.equal(table.length, 5, `unexpected route count: ${table.join(' | ')}`);
  assert.ok(table.some(r => r.startsWith('GET') && r.includes('health')));
  assert.ok(table.some(r => r.includes('models')));
  assert.ok(table.some(r => r.includes('chat\\/completions')));
  assert.ok(table.some(r => r.includes('responses')));
});

test('serve: every route in this suite is bound to loopback', async () => {
  // The servers these tests talk to were started with startServer(port,
  // '127.0.0.1'); a loopback-only guard so a future edit that changes the bind
  // fails here instead of quietly exposing the machine.
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  for (const base of [bare.base, hooked.base]) {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, `tests must only talk to loopback, got ${base}`);
  }
  assert.ok(provider.baseUrl.startsWith('http://127.0.0.1:'), 'the fake provider must be loopback too');
});

test('serve: src/serve.js never binds a non-loopback address by default', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'serve.js'), 'utf8');
  const sig = src.match(/export function startServer\([^)]*\)/)?.[0] ?? '';
  assert.match(sig, /host = '127\.0\.0\.1'/, `startServer must default to loopback, got: ${sig}`);
});
