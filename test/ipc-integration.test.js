// End-to-end proof of the IPC contract against a REAL `ox` process.
//
// Every test here spawns bin/ox.js, talks to it over a real unix socket, and
// grades from the world: the exit code, the bytes on the wire, and the file on
// disk. Nothing is graded from the shape of ox's internals.
//
// The subject of the suite is the SAFETY contract, not the plumbing:
//   silence is a decline. No client, no answer, a timeout, a disconnect, a
//   malformed frame, an unknown id, an invalid decision — every one of them
//   must land on the pre-existing non-TTY decline, and only a literal 'allow'
//   from a connected, ready client may let a gated tool through.
//
// Sandboxes follow bench/real/lib.mjs: a temp root with a sandboxed HOME and
// XDG dirs, so the developer's real ~/.ox is never read or written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  agentEnv,
  createSandbox,
  destroySandbox,
  existsWs,
  readWs,
  spawnOx,
  wsPath,
  writeWs,
} from '../bench/real/lib.mjs';
import { connectIpcClient } from '../src/ipc.js';

const OX_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A credential ox HOLDS (from the environment) and must never put on a socket.
const OX_CREDENTIAL = 'sk-ox-env-credential-3f8c1d';
// A secret the MODEL volunteers in a tool argument. sanitizeForWire redacts by
// KEY NAME, so this one proves the approval request's structured args are
// redacted. (A tool-start's flat argsPreview string is the model's own echo and
// is deliberately not claimed to be value-scrubbed.)
const INJECTED_SECRET = 'sk-model-injected-9ab4e2';

// Unix socket paths are capped near 104 bytes on macOS; keep the per-test
// socket directory short so a long TMPDIR cannot turn a test into a mystery.
function socketFor(sb) {
  const dir = path.join(sb.root, 'ipc');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 's.sock');
}

// ---------------------------------------------------------------------------
// A scripted model, as OpenAI-style SSE (same idiom as test/e2e.test.js).
// `decide` may return a promise, which is how a test holds the FIRST response
// until its GUI has finished the ready-handshake: no sleeps, no races.
// ---------------------------------------------------------------------------

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function turn({ text = '', textChunks = 0, calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } }) {
  const out = [];
  // textChunks > 1 splits the same text across many deltas, which is what
  // exercises the broadcaster's coalescing.
  const size = textChunks > 1 && text ? Math.max(1, Math.ceil(text.length / textChunks)) : 0;
  const pieces = size ? text.match(new RegExp(`.{1,${size}}`, 'gs')) : [text];
  for (const piece of pieces) {
    if (piece) out.push(sse({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
  }
  calls.forEach((call, index) => {
    out.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
  });
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function startMock(t, decide) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push(messages);
      try {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(turn(await decide(messages)));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err?.message ?? err));
      }
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests }));
  });
}

// ---------------------------------------------------------------------------
// The GUI side of the wire.
// ---------------------------------------------------------------------------

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, open: () => release() };
}

// ox binds its socket tens of milliseconds after spawn, so the first connect
// can legitimately miss. Each attempt is hard-bounded by connectTimeoutMs
// inside connectIpcClient, so this retry loop can never hang either.
async function connectWhenReady(socketPath, { clientId = 'gui-1', tries = 120, intervalMs = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    const client = connectIpcClient({ socketPath, clientId, connectTimeoutMs: 150 });
    const opened = await new Promise((resolve) => {
      client.once('open', () => resolve(true));
      client.once('close', () => resolve(false));
    });
    if (opened) return client;
    await sleep(intervalMs);
  }
  throw new Error(`ipc client never connected to ${socketPath}`);
}

// Connect, then PROVE the server processed our 'ready' frame: frames are
// handled in arrival order, so a 'pong' to our 'ping' can only arrive after
// 'ready' was consumed. Without this barrier a client can be connected but not
// yet eligible to hold an approval, and every approval test would flake.
async function handshake(client) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pong from the ipc server')), 15_000); // a busy machine can take seconds to schedule the server
    const onMessage = (msg) => {
      if (msg?.type !== 'pong') return;
      clearTimeout(timer);
      client.off('message', onMessage);
      resolve();
    };
    client.on('message', onMessage);
    client.ping();
  });
}

// decision: 'allow' | 'deny' | 'silent' (never answer) | 'disconnect'
async function attachGui(t, { socketPath, decision = 'allow', clientId = 'gui-1', onReady = null }) {
  const client = await connectWhenReady(socketPath, { clientId });
  t.after(() => client.close());
  const frames = [];
  const requests = [];
  client.on('message', (m) => {
    frames.push(m);
    if (m?.type !== 'approval-request') return;
    requests.push(m);
    if (decision === 'silent') return;
    if (decision === 'disconnect') {
      client.close();
      return;
    }
    client.answer(m.id, decision);
  });
  await handshake(client);
  if (onReady) await onReady();
  return {
    client,
    frames,
    requests,
    of: (type) => frames.filter((f) => f?.type === type),
    events: () => frames.filter((f) => f?.type === 'event').map((f) => f.event),
  };
}

function runOx(t, { sb, port, socket, args = [], extraEnv = {} }) {
  const env = agentEnv({
    home: sb.home,
    extra: {
      OX_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OX_API_KEY: OX_CREDENTIAL,
      ...extraEnv,
    },
  });
  return spawnOx({ args, cwd: sb.ws, env, timeoutMs: 20000 });
}

// ---------------------------------------------------------------------------

test('ipc integration 1: no IPC client + no TTY => a gated tool is still DECLINED', async (t) => {
  const sb = createSandbox('ipc-noclient');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  // A NEW file inside the workspace: write_file is approval-gated in default
  // mode, and creating a new in-workspace file asks exactly once (the tool's
  // own creation-outside-workspace gate does not fire).
  const { port } = await startMock(t, (messages) =>
    messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'understood, leaving it alone.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'nope\n' } }] }
  );

  // The bridge IS running. Nobody is connected. That must change nothing.
  const run = await runOx(t, { sb, port, socket, args: [`--ipc=${socket}`, '-p', 'create the file'] });

  assert.equal(run.timedOut, false, `ox hung:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.exitCode, 2, `expected the decline exit code 2\nstdout:${run.stdout}\nstderr:${run.stderr}`);
  assert.match(run.stdout, /approval prompts unavailable/, 'the pre-existing non-TTY decline message must still fire');
  assert.equal(existsWs(sb.ws, 'created.txt'), false, 'a file was created without any approval');
  assert.equal(fs.existsSync(socket), false, 'the socket file must be cleaned up on exit');
});

test('ipc integration 2: a connected client that answers allow => the tool runs and the file changes', async (t) => {
  const sb = createSandbox('ipc-allow');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise; // no model output until the GUI is ready
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'created it.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'approved content\n' } }] };
  });

  const run = runOx(t, { sb, port, socket, args: [`--ipc=${socket}`, '-p', 'create the file'] });
  const gui = await attachGui(t, { socketPath: socket, decision: 'allow', onReady: guiReady.open });
  const res = await run;

  assert.equal(res.timedOut, false, `ox hung:\n${res.stdout}\n${res.stderr}`);
  assert.equal(gui.requests.length, 1, `expected exactly one approval request, got ${gui.requests.length}`);
  assert.equal(gui.requests[0].tool, 'write_file');
  assert.equal(res.exitCode, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.doesNotMatch(res.stdout, /approval prompts unavailable/, 'the terminal decline must not have been used');
  assert.equal(existsWs(sb.ws, 'created.txt'), true, 'the approved write must have hit the disk');
  assert.equal(readWs(sb.ws, 'created.txt'), 'approved content\n');
  assert.equal(fs.existsSync(socket), false, 'the socket file must be cleaned up on exit');
});

test('ipc integration 3: a connected client that answers deny => the tool is refused and nothing changes', async (t) => {
  const sb = createSandbox('ipc-deny');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'ok, I will not write it.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'denied content\n' } }] };
  });

  const run = runOx(t, { sb, port, socket, args: [`--ipc=${socket}`, '-p', 'create the file'] });
  const gui = await attachGui(t, { socketPath: socket, decision: 'deny', onReady: guiReady.open });
  const res = await run;

  assert.equal(res.timedOut, false, `ox hung:\n${res.stdout}\n${res.stderr}`);
  assert.equal(gui.requests.length, 1);
  assert.equal(res.exitCode, 2, `a denial must surface as exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.equal(existsWs(sb.ws, 'created.txt'), false, 'a denied write must not touch the disk');
  // The refusal names the client that refused, so a user can tell WHICH GUI
  // vetoed the action.
  assert.match(res.stdout, /denied by IPC client gui-1/, `no client-named refusal in:\n${res.stdout}`);
});

test('ipc integration 4: a connected client that answers NOTHING => DECLINED, never allowed, never hung', async (t) => {
  const sb = createSandbox('ipc-silent');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'no answer came back, so I stopped.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'silent content\n' } }] };
  });

  const run = runOx(t, {
    sb,
    port,
    socket,
    args: [`--ipc=${socket}`, '-p', 'create the file'],
    extraEnv: { OX_IPC_APPROVAL_TIMEOUT_MS: '400' },
  });
  const gui = await attachGui(t, { socketPath: socket, decision: 'silent', onReady: guiReady.open });
  const res = await run;

  assert.equal(gui.requests.length, 1, 'the silent client must still have been asked');
  assert.equal(res.timedOut, false, `ox hung waiting for the approval:\n${res.stdout}\n${res.stderr}`);
  assert.ok(res.ms < 15000, `the tiny approval hold should have resolved fast, took ${res.ms}ms`);
  assert.equal(res.exitCode, 2, `silence must fall back to the non-TTY decline\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.equal(existsWs(sb.ws, 'created.txt'), false, 'silence must never allow the write');
  assert.match(res.stdout, /approval prompts unavailable/);
});

test('ipc integration 5: a client that disconnects mid-approval => DECLINED, no hang', async (t) => {
  const sb = createSandbox('ipc-drop');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'the client vanished, so I stopped.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'dropped content\n' } }] };
  });

  const run = runOx(t, {
    sb,
    port,
    socket,
    args: [`--ipc=${socket}`, '-p', 'create the file'],
    extraEnv: { OX_IPC_APPROVAL_TIMEOUT_MS: '30000' },
  });
  const gui = await attachGui(t, { socketPath: socket, decision: 'disconnect', onReady: guiReady.open });
  const res = await run;

  assert.equal(gui.requests.length, 1, 'the client must have received the approval request before dropping');
  assert.equal(res.timedOut, false, `a disconnect must not hang the approval\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  // The 30s hold was never used, so this can only have resolved on disconnect.
  assert.ok(res.ms < 15000, `disconnect should have ended the hold immediately, took ${res.ms}ms`);
  assert.equal(res.exitCode, 2, `a dropped client must fall back to the non-TTY decline\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.equal(existsWs(sb.ws, 'created.txt'), false, 'a dropped client must never allow the write');
  assert.match(res.stdout, /approval prompts unavailable/);
});

test('ipc integration 6: a subscribed client receives live tool-start / tool-end events', async (t) => {
  const sb = createSandbox('ipc-events');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const note = writeWs(sb.ws, 'note.txt', 'hello from the wire\n');
  const expected = 'live text that arrives in eight separate deltas';
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: expected, textChunks: 8 }
      : { text: 'reading', calls: [{ id: 'call_1', name: 'read_file', args: { path: note } }] };
  });

  const run = runOx(t, { sb, port, socket, args: [`--ipc=${socket}`, '-p', 'read the note'] });
  const gui = await attachGui(t, { socketPath: socket, decision: 'silent', onReady: guiReady.open });
  const res = await run;

  assert.equal(res.exitCode, 0, `exit ${res.exitCode}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.equal(gui.of('hello').length, 1, 'the server must announce itself with exactly one hello');
  const types = gui.events().map((e) => e?.type);
  assert.ok(types.includes('tool-start'), `no tool-start on the wire: ${types.join(',')}`);
  assert.ok(types.includes('tool-end'), `no tool-end on the wire: ${types.join(',')}`);
  assert.ok(types.includes('turn-end'), `no turn-end on the wire: ${types.join(',')}`);
  assert.ok(types.includes('usage-total'), `no usage-total on the wire: ${types.join(',')}`);
  const started = gui.events().find((e) => e?.type === 'tool-start');
  assert.equal(started.name, 'read_file');
  const ended = gui.events().find((e) => e?.type === 'tool-end');
  assert.equal(ended.isError, false);

  // Coalescing: the agent produced 8 text-delta events, so the wire must carry
  // FEWER frames than that (throttled) while losing none of the text.
  const textFrames = gui.events().filter((e) => e?.type === 'text-delta');
  assert.ok(textFrames.length >= 1, 'no text-delta reached the client');
  assert.ok(textFrames.length < 8, `text-delta was not coalesced: ${textFrames.length} frames for 8 deltas`);
  // Every delta of BOTH turns survives, in order: coalescing batches frames,
  // it never drops or reorders text.
  assert.equal(
    textFrames.map((e) => e.text).join(''),
    `reading${expected}`,
    'coalescing must not drop or reorder text'
  );
});

test('ipc integration 7: nothing secret crosses the wire', async (t) => {
  const sb = createSandbox('ipc-redact');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const target = wsPath(sb.ws, 'created.txt');
  const guiReady = gate();
  const { port } = await startMock(t, async (messages) => {
    await guiReady.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'refused, understood.' }
      : {
          text: 'writing it',
          calls: [
            {
              id: 'call_1',
              name: 'write_file',
              args: {
                path: target,
                content: 'redaction probe\n',
                apiKey: INJECTED_SECRET,
                authorization: `Bearer ${INJECTED_SECRET}`,
              },
            },
          ],
        };
  });

  const run = runOx(t, { sb, port, socket, args: [`--ipc=${socket}`, '-p', 'create the file'] });
  const gui = await attachGui(t, { socketPath: socket, decision: 'deny', onReady: guiReady.open });
  const res = await run;

  assert.equal(gui.requests.length, 1, 'expected one approval request carrying the args');
  const wire = JSON.stringify(gui.frames);

  // 1. The credential ox HOLDS (provider env) must never cross the socket, in
  //    any frame, ever.
  assert.doesNotMatch(wire, new RegExp(OX_CREDENTIAL), 'the provider API key leaked onto the wire');
  assert.doesNotMatch(wire, /"apiKey"\s*:\s*"(?!\[redacted\])/i, 'an apiKey-shaped field reached the wire unredacted');

  // 2. The approval request's structured args are redacted by KEY NAME, so the
  //    values the model smuggled in are not in that frame at all.
  const frame = gui.requests[0];
  assert.equal(frame.args.apiKey, '[redacted]');
  assert.equal(frame.args.authorization, '[redacted]');
  assert.doesNotMatch(JSON.stringify(frame), new RegExp(INJECTED_SECRET), 'the injected secret leaked in the approval request');

  assert.equal(res.exitCode, 2, `exit ${res.exitCode}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  assert.equal(existsWs(sb.ws, 'created.txt'), false);
});

// ---------------------------------------------------------------------------
// The CLI surface and its lifecycle guarantees.
// ---------------------------------------------------------------------------

test('ipc integration 8: ox ipc serve/status, a duplicate run, and SIGINT cleanup', async (t) => {
  const sb = createSandbox('ipc-cli');
  t.after(() => destroySandbox(sb));
  const socket = socketFor(sb);
  const env = agentEnv({ home: sb.home });

  const spawnCli = (args) => {
    const child = spawn(process.execPath, [OX_BIN, ...args], { cwd: sb.ws, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
    return { child, done, out: () => stdout, err: () => stderr };
  };

  const dead = await spawnCli(['ipc', 'status', '--socket', socket]).done;
  assert.equal(dead.code, 1, `status on a dead socket must exit 1: ${JSON.stringify(dead)}`);
  assert.match(dead.stdout, /not listening/);

  const serve = spawnCli(['ipc', 'serve', '--socket', socket, '--approval-timeout', '1234']);
  t.after(() => { try { serve.child.kill('SIGKILL'); } catch {} });
  // Wait for the LAST marker the assertions below depend on, not the first.
  // `serve` writes the socket line and the approval-hold line from the same
  // synchronous block, but stdout is a pipe here, so one read can carry the
  // first line and not the second. Polling only for `socket:` and then
  // asserting on the hold line is a race that shows up under load -- which is
  // what the full suite is -- and it fails on a run that actually worked.
  const served = () => serve.out().includes('socket:') && serve.out().includes('ms');
  for (let i = 0; i < 200 && !served(); i++) await sleep(25);
  assert.match(serve.out(), /socket: /, `serve never printed its socket:\n${serve.out()}\n${serve.err()}`);
  assert.ok(serve.out().includes(socket), `serve printed the wrong socket path:\n${serve.out()}`);
  assert.match(serve.out(), /1234ms/, 'serve must report the resolved approval hold');

  const live = await spawnCli(['ipc', 'status', '--socket', socket]).done;
  assert.equal(live.code, 0, `status on a live socket must exit 0: ${JSON.stringify(live)}`);
  assert.match(live.stdout, /listening/);

  // A second run pointed at the same socket is a clear error, never a takeover.
  const second = await spawnCli([`--ipc=${socket}`, '-p', 'hello']).done;
  assert.equal(second.code, 4, `a duplicate bridge must fail loudly: ${JSON.stringify(second)}`);
  assert.match(second.stderr, /already in use/);

  // SIGINT closes the server AND removes the socket file.
  serve.child.kill('SIGINT');
  await serve.done;
  for (let i = 0; i < 40 && fs.existsSync(socket); i++) await sleep(25);
  assert.equal(fs.existsSync(socket), false, 'SIGINT must not leave a stale socket file behind');
});
