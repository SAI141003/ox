// The web chat on `ox serve`: GET / is the page, and the chat stream carries
// tool activity as an `ox` extension that OpenAI clients ignore.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { listToolSchemas, dispatchTool } from '../src/tools/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-webchat-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-webchat-ws-'));
fs.writeFileSync(path.join(ws, 'SECRET_NOTE.txt'), 'the tool output must never reach the stream\n');
const saved = Object.fromEntries(['HOME', 'OX_MEMORY_HOME', 'OX_BRAIN_DIR', 'OX_LEARN', 'OX_BASE_URL', 'OX_API_KEY', 'OX_BOT', 'OX_MODEL', 'OX_SERVE_API_KEY', 'OX_ISLAND'].map((k) => [k, process.env[k]]));
const origCwd = process.cwd();

// A provider that lists the workspace once, then answers.
let turn = 0;
const received = [];
const heldSteerRuns = new Map();
const steerTurns = new Map();
const PLAN = [{ content: 'Read the code', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }, { content: 'Run the tests', status: 'pending' }];
const provider = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    turn++;
    let request;
    try { request = JSON.parse(body); received.push(request); } catch {}
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const starter = request?.messages?.find((m) => m.role === 'user' && String(m.content ?? '').includes('hold-for-steer'))?.content ?? '';
    const sessionId = starter.match(/hold-for-steer\s+(session-steer-[a-z]+)/)?.[1] ?? null;
    if (sessionId) {
      const n = (steerTurns.get(sessionId) ?? 0) + 1;
      steerTurns.set(sessionId, n);
      if (n === 1) {
        heldSteerRuns.set(sessionId, () => res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${sessionId}`, type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: null }] })
          + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'));
        return;
      }
      res.end(sse({ choices: [{ index: 0, delta: { content: 'continued after steer.' }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
      return;
    }
    const wantsPlan = body.includes('make a plan');
    if (turn % 2 === 1) {
      const call = wantsPlan
        ? { index: 0, id: 'call_plan', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: PLAN }) } }
        : { index: 0, id: 'call_ls', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } else {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'one file here.' }, finish_reason: null }] })
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  HOME: home, OX_MEMORY_HOME: path.join(home, 'memory'), OX_LEARN: '1', OX_ISLAND: '0', OX_BOT: 'custom', OX_MODEL: 'mock', OX_API_KEY: 'k',
  OX_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
});
process.env.OX_BRAIN_DIR = path.join(home, '.ox', 'brain');
fs.mkdirSync(process.env.OX_BRAIN_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.OX_BRAIN_DIR, 'INDEX.md'), '- PRIVATE_BRAIN_MARKER\n');
fs.mkdirSync(path.join(ws, '.agent'), { recursive: true });
fs.writeFileSync(path.join(ws, '.agent', 'MEMORY.md'), '# Project memory\n- PRIVATE_PROJECT_MEMORY_MARKER\n');
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
  assert.match(res.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
  assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await res.text();
  assert.match(html, /<title>ox<\/title>/);
  assert.match(html, /\/v1\/chat\/completions/);
  for (const [, source] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new vm.Script(source), 'inline page scripts must parse before the splash can hand off to chat'); // ox-secure-ignore: parses trusted HTML from the local server in a syntax test; the script is never executed.
  }
  assert.equal((await fetch(`${base}/chat`)).status, 200);
});

test('the optional Mochi bot character is served from its exact package and not exposed as arbitrary node_modules files', async () => {
  const module = await fetch(`${base}/vendor/mochi-avatar/dist/element/index.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(await module.text(), /dough-avatar\.js/);
  assert.equal((await fetch(`${base}/vendor/mochi-avatar/package.json`)).status, 404);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Mochi — original character by HANDO K\.K\./);
  for (const emotion of ['neutral', 'happy', 'shy', 'sad', 'angry', 'surprised', 'thinking', 'sleepy']) assert.match(html, new RegExp(`'${emotion}'`));
  assert.match(html, /data-mochi-colorway=/, 'Mochi colorways should be direct visual choices');
  assert.match(html, /data-mochi-emotion=/, 'all expressions should be directly previewable');
  assert.match(html, /bot-character-controls\[hidden\].*display:none!important/, 'the inactive character controls must stay hidden');
  assert.doesNotMatch(html, /\$\('b-colorway'\)/, 'the removed native colorway select must not leave a stale editor reference');
});

test('bot avatar choice and Mochi colourway persist through the Bots API', async () => {
  const save = await fetch(`${base}/ox/bots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mochi-test', description: 'character persistence test', bot: null, mode: 'code', tools: [], instructions: '', character: 'mochi', colorway: 'ramune' }),
  });
  assert.equal(save.status, 200);
  const result = await save.json();
  assert.equal(result.mine.find((b) => b.name === 'mochi-test')?.character, 'mochi');
  assert.equal(result.mine.find((b) => b.name === 'mochi-test')?.colorway, 'ramune');
});

test('the app keeps chat history on this device by default (owner decision, 60a517f) and makes preference learning opt-in', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /saveChatHistory:\s*true/);
  assert.match(html, /learnFromChats:\s*false/);
  assert.match(html, /if\s*\(!prefs\.saveChatHistory\)\s*return/);
  assert.match(html, /ox_remember_preferences:\s*prefs\.learnFromChats\s*===\s*true/);
  assert.match(html, /Save chat history on this device/);
  assert.match(html, /Learn preferences from my chats/);
  assert.match(html, /Code changes are made in the project folder you chose/);
  assert.match(html, /terminal\/CLI runs save resumable transcripts/);
  assert.match(html, /locally under ~\/\.ox\/sessions/);
  assert.match(html, /tool-call arguments, which can contain code/);
  assert.match(html, /Use ox --incognito when you do not want a terminal run retained/);
  assert.match(html, /approved edits still apply in an incognito chat/);
  assert.match(html, /chat not retained · project edits still apply/);
});

test('the server does not learn app-chat preferences unless the client opts in', async () => {
  const post = (learn) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, ...(learn ? { ox_remember_preferences: true } : {}), messages: [{ role: 'user', content: 'I always use pnpm.' }] }),
  });
  const file = path.join(home, 'memory', 'graph.jsonl');
  await (await post(false)).text();
  assert.equal(fs.existsSync(file), false, 'a normal app message is not written into persistent memory');
  await (await post(true)).text();
  assert.match(fs.readFileSync(file, 'utf8'), /I always use pnpm/);
});

test('incognito app chats neither receive saved memory nor see memory tools', async () => {
  const before = received.length;
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, ox_incognito: true, messages: [{ role: 'user', content: 'what is here?' }] }),
  });
  assert.equal(res.status, 200);
  await res.text();
  const request = received[before];
  assert.ok(request, 'provider request was captured');
  const prompt = JSON.stringify(request.messages ?? []);
  assert.doesNotMatch(prompt, /PRIVATE_(?:BRAIN|PROJECT)_MARKER/);
  const names = (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
  assert.ok(!names.some((name) => /^memory_/.test(name) || name === 'brain'), `incognito must not expose memory tools: ${names.join(', ')}`);
  assert.ok(!listToolSchemas({ incognito: true }).some((tool) => /^memory_/.test(tool.name) || tool.name === 'brain'));
  const blocked = await dispatchTool('memory_list', {}, { incognito: true, cwd: ws });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content, /unavailable in an incognito chat/);
});

test('the OpenAI route table is unchanged by the page', () => {
  // The OpenAI-compatible surface is the same five routes; everything the app
  // adds lives under /ox/ and is GET or POST.
  const routes = routeTable();
  // Plus the signature-verified WhatsApp Cloud callback (GET verify, POST deliver).
  assert.equal(routes.filter((r) => !r.includes('\\/ox\\/') && !r.includes('\\/webhooks\\/whatsapp')).length, 5, routes.join('\n'));
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

test('the app receives the exact live context meter before model output', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, ox_ui: 'live', messages: [{ role: 'user', content: 'show context' }] }),
  });
  assert.equal(res.status, 200);
  const chunks = (await res.text()).split('\n\n').map((f) => f.replace(/^data: /, '')).filter((d) => d && d !== '[DONE]').map((d) => JSON.parse(d));
  const meter = chunks.find((c) => c.ox?.type === 'context')?.ox;
  assert.ok(meter, 'the app receives a context meter event');
  assert.ok(meter.tokens > 0, 'the meter includes the prompt actually sent');
  assert.ok(meter.window > meter.tokens, 'the meter includes the model context window');
  assert.ok(meter.schemaTokens >= 0 && meter.historyTokens > 0, 'the meter distinguishes history from tool schemas');
});

test('a plan the agent writes reaches the app as a checklist (Devin-style worklog)', async () => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'make a plan then do it' }] }),
  });
  const raw = await res.text();
  const ox = raw.split('\n\n').map((f) => f.replace(/^data: /, '')).filter((d) => d && d !== '[DONE]').map((d) => JSON.parse(d).ox).filter(Boolean);
  const start = ox.find((e) => e.type === 'tool-start' && e.name === 'todo_write');
  assert.deepEqual(start.plan, PLAN);
});

test('two app sessions run independently and a steer reaches only its session at the next model step', async () => {
  const start = (id) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', stream: true, ox_mode: 'code', ox_ui: 'live', ox_session_id: id, messages: [{ role: 'user', content: `hold-for-steer ${id}: inspect this workspace` }] }),
  });
  const one = start('session-steer-one');
  const two = start('session-steer-two');
  const waitHeld = async (id) => {
    for (let i = 0; i < 200 && !heldSteerRuns.has(id); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(heldSteerRuns.has(id), `${id} reached its in-flight model request`);
  };
  await Promise.all([waitHeld('session-steer-one'), waitHeld('session-steer-two')]);
  for (const [sessionId, text] of [['session-steer-one', 'Only one: use the small helper'], ['session-steer-two', 'Only two: keep the current approach']]) {
    const steer = await fetch(`${base}/ox/chat/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }) });
    assert.equal(steer.status, 200);
    assert.deepEqual(await steer.json(), { ok: true, queued: 1 });
  }
  heldSteerRuns.get('session-steer-one')(); heldSteerRuns.delete('session-steer-one');
  heldSteerRuns.get('session-steer-two')(); heldSteerRuns.delete('session-steer-two');
  const [resOne, resTwo] = await Promise.all([one, two]);
  const [rawOne, rawTwo] = await Promise.all([resOne.text(), resTwo.text()]);
  assert.match(rawOne, /continued after steer/);
  assert.match(rawTwo, /continued after steer/);
  const reqOne = received.filter((r) => JSON.stringify(r.messages).includes('hold-for-steer session-steer-one'));
  const reqTwo = received.filter((r) => JSON.stringify(r.messages).includes('hold-for-steer session-steer-two'));
  assert.ok(reqOne.length >= 2 && reqTwo.length >= 2, 'both sessions independently reached their next model turn');
  assert.match(JSON.stringify(reqOne.at(-1).messages), /Only one: use the small helper/);
  assert.doesNotMatch(JSON.stringify(reqOne.at(-1).messages), /Only two:/);
  assert.match(JSON.stringify(reqTwo.at(-1).messages), /Only two: keep the current approach/);
  assert.doesNotMatch(JSON.stringify(reqTwo.at(-1).messages), /Only one:/);
});

test('the chat page keeps runs per session and offers an explicit Steer now action', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /const runningControllers = new Map\(\)/);
  assert.match(html, /data-steer/);
  assert.match(html, /Steer now/);
  for (const text of ['Files and folders', 'Set a goal', 'Plan mode', 'Record a skill', 'Sketch', 'Plugins and connectors', 'Connect GitHub', 'Connect Notion', 'Documents and PDFs', 'Spreadsheet analysis', 'Create slide videos', 'Code review', 'Mini and pets']) assert.ok(html.includes(text), `${text} is reachable from the plus menu`);
  assert.match(html, /webkitdirectory directory multiple/);
  assert.match(html, /id="sketch-board"/);
  assert.match(html, /Add sketch to message/);
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
