// Read-side screening for SESSION REPLAY (--resume / --continue / /rewind).
//
// A transcript is the user's own record, so the screen is applied to the
// INJECTED form only, at the one seam where stored events become messages
// (replayMessages in src/cli.js). Nothing on disk is rewritten.
//
// The contract under test:
//   1. a credential in a past USER message AND in a past TOOL RESULT injects
//      neither;
//   2. message COUNT, ORDER and role are preserved, and every tool_call keeps
//      its tool_call_id (a withheld message must never become an orphan, which
//      a provider rejects);
//   3. the stored transcript is byte-identical afterwards (sha256);
//   4. the withholding is visible: a notice rides in the prompt, the count
//      lands in memoryScreenStats() and the OX_AUDIT ledger;
//   5. CONTROL: a clean transcript injects byte-identically and adds zero bytes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

// HOME must move BEFORE src/config.js is loaded, because CONFIG_DIR is resolved
// at import time. Same pattern as test/subagent-memory-screen.test.js.
const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-resume-'));
process.env.HOME = HOME_SANDBOX;

const { loadSessionWithStatus } = await import('../src/session.js');
const { replayMessages } = await import('../src/cli.js');
const { memoryScreenStats, resetMemoryScreenStats, shortWithheldNotice } = await import('../src/memory.js');
const { auditFilePath, auditEnabled } = await import('../src/audit.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

// High-confidence credential shapes (the ones the src/memory.js tables match).
const USER_SECRET = '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';
const TOOL_SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let seq = 0;

function plantTranscript(home, events) {
  const dir = path.join(home, '.ox', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `20260930-00000${seq++}-abcdef.jsonl`);
  const lines = [{ t: 'meta', created: new Date().toISOString(), cwd: home }, ...events].map((e) => JSON.stringify(e));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// A credential in a user message AND in a tool result (a failed auth call
// quoting the key it rejected) -- the two highest-value replay vectors -- plus a
// third in a tool_call argument, which also reaches the model.
function dirtyEvents() {
  return [
    { t: 'user', text: `here is the key for the staging box: ${USER_SECRET}` },
    {
      t: 'assistant',
      text: 'Checking the deploy token.',
      tool_calls: [
        {
          id: 'call_auth_1',
          function: {
            name: 'bash',
            arguments: "{\"command\":\"curl -H 'Authorization: Bearer 7Yd1pQ4rZ8mN2vL6xW0cB3eT5gH9jK1sA4dF' https://api.example.test/v1\"}",
          },
        },
      ],
    },
    {
      t: 'tool-result',
      callId: 'call_auth_1',
      name: 'bash',
      isError: true,
      content: `401 Unauthorized\nbody: {"token":"${TOOL_SECRET}","error":"revoked"}`,
    },
    { t: 'assistant', text: 'That token is rejected.' },
    { t: 'user', text: 'thanks, try the staging host instead' },
  ];
}

function cleanEvents() {
  return [
    { t: 'user', text: 'add a healthcheck to the server' },
    {
      t: 'assistant',
      text: 'Reading the server file.',
      tool_calls: [{ id: 'call_read_1', function: { name: 'read_file', arguments: '{"path":"src/server.js"}' } }],
    },
    { t: 'tool-result', callId: 'call_read_1', name: 'read_file', content: 'export const health = () => "ok";' },
    { t: 'assistant', text: 'Added the healthcheck.' },
  ];
}

test('replay withholds a credential in a user message, a tool_call and a tool result', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  const loaded = loadSessionWithStatus(file);
  assert.equal(loaded.status, 'ok');

  const msgs = replayMessages(loaded.messages);
  const wire = JSON.stringify(msgs);

  assert.equal(wire.includes(USER_SECRET), false, `user-message secret leaked:\n${wire}`);
  assert.equal(wire.includes('9edd82d6dd'), false, 'key material leaked from the user message');
  assert.equal(wire.includes(TOOL_SECRET), false, `tool-result secret leaked:\n${wire}`);
  assert.equal(wire.includes('ghp_ABCDEF'), false, 'tool-result key material leaked');
  assert.equal(wire.includes('7Yd1pQ4rZ8mN2vL6xW0cB3eT5gH9jK1sA4dF'), false, 'tool_call argument leaked');
});

test('order, role and count are preserved -- a withheld message keeps its slot', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  const msgs = replayMessages(loadSessionWithStatus(file).messages);

  assert.equal(msgs.length, 5, 'a withheld message must still occupy its position');
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
  assert.match(msgs[0].content, /\[memory-screen\] withheld 1 message\b/);
  assert.match(msgs[2].content, /\[memory-screen\] withheld 1 message\b/);
  // clean siblings untouched, and still in position
  assert.equal(msgs[1].tool_calls[0].function.name, 'bash');
  assert.match(msgs[3].content, /That token is rejected/);
  assert.match(msgs[4].content, /staging host instead/);
});

test('tool_call / tool-result pairing survives screening', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  const msgs = replayMessages(loadSessionWithStatus(file).messages);

  const callIds = [];
  for (const m of msgs) for (const c of m.tool_calls ?? []) callIds.push(String(c.id));
  const resultIds = msgs.filter((m) => m.role === 'tool').map((m) => String(m.tool_call_id));
  assert.equal(callIds.length, 1);
  assert.equal(resultIds.length, 1);
  assert.deepEqual(resultIds, callIds, 'every tool_call must keep its matching tool result');

  const callAt = msgs.findIndex((m) => Array.isArray(m.tool_calls) && m.tool_calls.length);
  assert.equal(msgs[callAt + 1].role, 'tool', 'the result must stay adjacent to its call');
  assert.equal(msgs[callAt + 1].tool_call_id, 'call_auth_1');
  // A provider rejects a tool_call whose `arguments` is not valid JSON, so the
  // screen may swap the argument TEXT but never the shape of the field. Tool
  // `content` is free text and stays a string.
  assert.doesNotThrow(() => JSON.parse(msgs[callAt].tool_calls[0].function.arguments), 'arguments must stay valid JSON');
  assert.equal(typeof msgs[callAt + 1].content, 'string');
  assert.equal(msgs[callAt + 1].tool_call_id, msgs[callAt].tool_calls[0].id);
});

test('screening a replay leaves the transcript on disk byte-identical', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  const before = sha(file);
  const size = fs.statSync(file).size;

  replayMessages(loadSessionWithStatus(file).messages);

  assert.equal(sha(file), before, 'the read path must not rewrite the transcript');
  assert.equal(fs.statSync(file).size, size);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(USER_SECRET), true, "the user's own record must still hold it");
  assert.equal(text.includes(TOOL_SECRET), true);
});

test('the notice rides in the prompt and the count lands in the counters', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  resetMemoryScreenStats();

  const msgs = replayMessages(loadSessionWithStatus(file).messages);

  const notices = msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith('[memory-screen]'));
  assert.equal(notices.length, 2, 'the user message and the tool result are withheld');
  for (const n of notices) assert.equal(n.content, shortWithheldNotice(1, 'message'));

  assert.deepEqual(memoryScreenStats(), { withheld: 3, reads: 1 }, '3 = message + tool_call args + tool result');
  resetMemoryScreenStats();
});

test('the ledger records the aggregate count, once, with no secret text', () => {
  const file = plantTranscript(HOME_SANDBOX, dirtyEvents());
  const ledger = auditFilePath();
  fs.rmSync(ledger, { force: true });

  replayMessages(loadSessionWithStatus(file).messages);

  assert.equal(auditEnabled(), true, 'audit must be on for this assertion to mean anything');
  const rows = fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const screened = rows.filter((r) => r.t === 'memory-screen' && r.event === 'read-withheld');
  assert.equal(screened.length, 1, JSON.stringify(rows));
  assert.equal(screened[0].count, 3);
  assert.equal(screened[0].where, 'session replay into prompt');
  assert.equal(screened[0].source, 'session transcript replay');
  assert.equal(JSON.stringify(screened).includes(USER_SECRET), false, 'ledger must not carry the secret');
  assert.equal(JSON.stringify(screened).includes(TOOL_SECRET), false);
});

test('CONTROL: a clean transcript injects byte-identically, at zero cost', () => {
  const file = plantTranscript(HOME_SANDBOX, cleanEvents());
  resetMemoryScreenStats();

  const msgs = replayMessages(loadSessionWithStatus(file).messages);

  assert.deepEqual(msgs, [
    { role: 'user', content: 'add a healthcheck to the server' },
    {
      role: 'assistant',
      content: 'Reading the server file.',
      tool_calls: [
        {
          id: 'call_read_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/server.js"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'export const health = () => "ok";' },
    { role: 'assistant', content: 'Added the healthcheck.' },
  ]);
  assert.equal(/memory-screen/.test(JSON.stringify(msgs)), false, 'no notice on a clean transcript');
  assert.deepEqual(memoryScreenStats(), { withheld: 0, reads: 1 });
  resetMemoryScreenStats();
});

// ---- END TO END: resume a real transcript against a scripted provider --------

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mockTurn() {
  return [
    sse({ choices: [{ index: 0, delta: { content: 'resumed' }, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ].join('');
}

async function startMock(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push({ messages, raw: body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(mockTurn());
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests };
}

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];

test('E2E: --resume injects no secret, keeps pairing, and leaves the file untouched', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-resume-e2e-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = plantTranscript(home, dirtyEvents());
  const before = sha(file);

  const { port, requests } = await startMock(t);
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const child = spawn(process.execPath, [OX_BIN, '-p', 'carry on', '--resume', file], {
    cwd: home,
    env: { ...env, HOME: home, NO_COLOR: '1', OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ox did not exit\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 45000);
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });
  assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);

  assert.equal(requests.length, 1, `expected one model turn, got ${requests.length}`);
  const sent = requests[0];
  const wire = sent.raw;

  assert.equal(wire.includes(USER_SECRET), false, 'injected prompt carried the user-message key');
  assert.equal(wire.includes(TOOL_SECRET), false, 'injected prompt carried the tool-result token');
  assert.equal(wire.includes('ghp_ABCDEF'), false);
  assert.equal(wire.includes('9edd82d6dd'), false);
  assert.match(wire, /\[memory-screen\] withheld 1 message/);

  const assistant = sent.messages.find(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length
  );
  assert.ok(assistant, 'the assistant tool_call must survive the resume');
  const tool = sent.messages.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id, 'orphaned tool result in the injected prompt');
  assert.doesNotThrow(() => JSON.parse(assistant.tool_calls[0].function.arguments));

  assert.match(stderr, /replayed message/);
  assert.equal(sha(file), before, 'resume must not rewrite the transcript');
  assert.equal(fs.readFileSync(file, 'utf8').includes(USER_SECRET), true, 'the record still holds it');
});
