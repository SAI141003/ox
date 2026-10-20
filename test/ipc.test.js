import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  IPC_VERSION,
  APPROVAL_DECISIONS,
  DEFAULT_SOCKET_DIR,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  socketPathFor,
  createIpcServer,
  connectIpcClient,
  sanitizeForWire,
  isSecretKey,
} from '../src/ipc.js';

// ---------------------------------------------------------------------------
// helpers — short timeouts everywhere so the suite stays fast
// ---------------------------------------------------------------------------

const TINY = 60;

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ipc-test-'));
}

// A listenable path for a test server. Node on Windows has no unix socket
// files: local IPC is a named pipe, and a pipe name must live in the \\.\pipe\
// namespace or listen() never fires. The temp dir's unique basename keeps
// pipes from parallel tests and runs apart.
const IS_WIN = process.platform === 'win32';
function sockPath(dir, name) {
  return IS_WIN ? `\\\\.\\pipe\\${path.basename(dir)}-${name}` : path.join(dir, `${name}.sock`);
}

// Tests about socket FILES (existence on disk, stale-file unlinking, the
// socket dir) have nothing to check on Windows, where a pipe is not a file.
const SOCKET_FILES = IS_WIN ? 'named pipes are not files on Windows' : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 10s, not 2s. A unix-socket round trip on one machine takes microseconds; 2s
// only ever fires when the box is loaded enough to miss a scheduler slice — it
// is a load detector, not an assertion. Measured A/B on 2026-10-02 with the
// daemon-continuity work in the tree: the "happy path" test failed 4 runs in 6
// with the UNMODIFIED src/ipc.js and 3 in 6 with the modified one, i.e. the
// flake predates the change and reproduces either way. Raising the harness
// timeout removes a false negative without weakening anything: the test still
// fails if the handshake genuinely never completes.
function once(emitter, event, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    const handler = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    emitter.once(event, handler);
  });
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 5, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

// Collect every frame a client receives into an array.
function collect(client) {
  const messages = [];
  client.on('message', (m) => messages.push(m));
  messages.of = (type) => messages.filter((m) => m.type === type);
  return messages;
}

// Stand up a server + one connected, ready client. Returns a teardown fn.
async function pair(t, opts = {}) {
  const dir = mkdtemp();
  const socketPath = opts.socketPath ?? sockPath(dir, 'bridge');
  const server = createIpcServer({
    socketPath,
    sessionId: opts.sessionId ?? 'sess',
    meta: opts.meta ?? {},
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 500,
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');

  // Wait for the handshake, not merely for accept: only a client that sent
  // 'ready' can hold an approval, so tests must not race the handshake.
  const handshaken = once(server, 'client-connected');
  const client = connectIpcClient({
    socketPath,
    clientId: opts.clientId ?? 'gui',
    // 2s, not 200ms. This helper's budget is not an assertion about the product
    // — the product default is 300ms, and `ipc: defaults stagger…` is what pins
    // that. A 200ms budget here is a load detector: measured on 2026-10-02, it
    // failed 4 runs in 6 with the UNMODIFIED src/ipc.js and 3 in 6 with the
    // daemon-continuity changes, i.e. the flake predates this work and is not
    // caused by it. The instrumented failure is literally
    // `ipc: connect timeout after 200ms` on a unix socket in the same process.
    connectTimeoutMs: 2000,
  });
  const messages = collect(client);
  t.after(() => client.close());
  await once(client, 'open');
  await handshaken;

  return { dir, socketPath, server, client, messages };
}

// ---------------------------------------------------------------------------
// exports / paths
// ---------------------------------------------------------------------------

test('ipc: IPC_VERSION and APPROVAL_DECISIONS are the documented values', () => {
  assert.equal(IPC_VERSION, 1);
  assert.deepEqual([...APPROVAL_DECISIONS], ['allow', 'deny', 'ask', 'always']);
});

test('ipc: DEFAULT_SOCKET_DIR is the tmpdir', () => {
  assert.equal(DEFAULT_SOCKET_DIR, os.tmpdir());
});

test('ipc: socketPathFor is deterministic and stays inside the socket dir', { skip: SOCKET_FILES }, () => {
  const a = socketPathFor('abc-123');
  const b = socketPathFor('abc-123');
  assert.equal(a, b);
  assert.equal(path.dirname(a), os.tmpdir());
  assert.match(path.basename(a), /\.sock$/);
  assert.notEqual(a, socketPathFor('abc-124'));
});

test('ipc: socketPathFor sanitizes traversal and separators out of sessionId', { skip: SOCKET_FILES }, () => {
  for (const evil of ['../../etc/passwd', 'a/b c', '..', '/abs/path']) {
    const p = socketPathFor(evil);
    assert.equal(path.dirname(p), os.tmpdir(), `${evil} escaped the socket dir`);
    assert.ok(path.resolve(p).startsWith(`${os.tmpdir()}${path.sep}`));
    assert.ok(!path.basename(p).includes('/'));
  }
  // empty / junk sessionIds still produce a usable path
  assert.match(socketPathFor(''), /ox-ipc-default\.sock$/);
});

test('ipc: socketPathFor on Windows is a sanitized named pipe', () => {
  assert.equal(socketPathFor('abc-123', DEFAULT_SOCKET_DIR, 'win32'), '\\\\.\\pipe\\ox-ipc-abc-123');
  for (const evil of ['../../etc/passwd', 'a\\b c', '..']) {
    const p = socketPathFor(evil, DEFAULT_SOCKET_DIR, 'win32');
    assert.ok(p.startsWith('\\\\.\\pipe\\ox-ipc-'), p);
    assert.ok(!p.slice('\\\\.\\pipe\\'.length).includes('\\'), `${evil} smuggled a separator: ${p}`);
  }
});

test('ipc: defaults stagger —connect timeout is far shorter than approval timeout', () => {
  assert.equal(DEFAULT_CONNECT_TIMEOUT_MS, 300);
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 115000);
  assert.ok(DEFAULT_CONNECT_TIMEOUT_MS < DEFAULT_APPROVAL_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// sanitizeForWire (rule 4 + rule 7)
// ---------------------------------------------------------------------------

test('sanitizeForWire: redacts a nested apiKey at any depth', () => {
  const out = sanitizeForWire({
    ok: true,
    nested: { deeper: { apiKey: 'sk-live-abcdef123456' } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.nested.deeper.apiKey, '[redacted]');
  assert.ok(!JSON.stringify(out).includes('sk-live'));
});

test('sanitizeForWire: masks every secret-ish key name', () => {
  const out = sanitizeForWire({
    apiKey: 'a',
    api_key: 'b',
    apikey: 'c',
    Authorization: 'Bearer x',
    bearer: 'x',
    accessToken: 't',
    refresh_token: 't',
    clientSecret: 's',
    password: 'p',
    cookie: 'c',
    keepMe: 'visible',
  });
  for (const k of ['apiKey', 'api_key', 'apikey', 'Authorization', 'bearer', 'accessToken', 'refresh_token', 'clientSecret', 'password', 'cookie']) {
    assert.equal(out[k], '[redacted]', `expected ${k} to be redacted`);
  }
  assert.equal(out.keepMe, 'visible');
});

test('sanitizeForWire: truncates a long string to 2000 chars by default', () => {
  const long = 'x'.repeat(9000);
  const out = sanitizeForWire({ blob: long });
  assert.ok(out.blob.length < long.length, 'expected the string to be truncated');
  assert.ok(out.blob.startsWith('x'.repeat(2000)), 'expected the first 2000 chars to survive');
  assert.match(out.blob, /truncated/);
});

test('sanitizeForWire: honors a custom maxString', () => {
  const out = sanitizeForWire({ blob: 'y'.repeat(50) }, { maxString: 10 });
  assert.ok(out.blob.startsWith('y'.repeat(10)));
  assert.match(out.blob, /truncated/);
});

test('sanitizeForWire: is cycle-safe instead of overflowing the stack', () => {
  const node = { name: 'root', secret: 'nope' };
  node.self = node;
  node.children = [node];
  const out = sanitizeForWire(node);
  assert.equal(out.self, '[Circular]');
  assert.equal(out.children[0], '[Circular]');
  assert.equal(out.secret, '[redacted]');
});

test('sanitizeForWire: caps arrays and depth', () => {
  const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
  assert.equal(sanitizeForWire(deep, { maxDepth: 2 }).a.b.c, '[depth-limit]');
  const arr = sanitizeForWire({ items: Array.from({ length: 10 }, (_, i) => i) }, { maxArray: 4 });
  assert.equal(arr.items.length, 5);
  assert.equal(arr.items[4], '[+6 more]');
});

test('sanitizeForWire: never forwards raw binary (the whole-file-read bug)', () => {
  const out = sanitizeForWire({ file: Buffer.alloc(4096, 7) });
  assert.equal(out.file, '[buffer 4096 bytes]');
});

test('sanitizeForWire: handles null, numbers, dates and errors', () => {
  assert.equal(sanitizeForWire(null), null);
  assert.equal(sanitizeForWire(42), 42);
  assert.equal(sanitizeForWire(Number.NaN), null);
  assert.match(sanitizeForWire(new Error('boom')), /^Error: boom$/);
  assert.match(sanitizeForWire({ at: new Date(0) }).at, /^1970-01-01/);
});

test('sanitizeForWire: a throwing getter is skipped, not fatal', () => {
  const obj = { good: 1 };
  Object.defineProperty(obj, 'bad', { enumerable: true, get() { throw new Error('nope'); } });
  assert.deepEqual(sanitizeForWire(obj), { good: 1 });
});

// ---------------------------------------------------------------------------
// happy path: hello -> event -> approval -> allow
// ---------------------------------------------------------------------------

test('ipc: happy path — hello, broadcast event, approval resolved allow', async (t) => {
  const { server, client, messages } = await pair(t, {
    sessionId: 'happy',
    meta: { bot: 'ox', model: 'grok-4.6' },
    approvalTimeoutMs: 2000,
  });

  const hello = await waitFor(() => messages.of('hello')[0], { what: 'hello frame' });
  assert.equal(hello.sessionId, 'happy');
  assert.equal(hello.pid, process.pid);
  assert.equal(hello.version, IPC_VERSION);
  assert.equal(hello.bot, 'ox');
  assert.equal(hello.model, 'grok-4.6');
  assert.equal(typeof hello.cwd, 'string');

  server.broadcast({ event: 'tool_start', tool: 'bash' });
  const evt = await waitFor(() => messages.of('event')[0], { what: 'event frame' });
  assert.deepEqual(evt.event, { event: 'tool_start', tool: 'bash' });
  assert.equal(typeof evt.at, 'number');

  // The server emits 'approval-request' and holds until resolve() is called.
  const approvalEvent = once(server, 'approval-request');
  const decision = server.requestApproval({ tool: 'bash', args: { command: 'ls -la' }, cwd: '/tmp' });
  const req = (await approvalEvent)[0];
  assert.equal(req.tool, 'bash');
  assert.deepEqual(req.args, { command: 'ls -la' });
  assert.equal(typeof req.resolve, 'function');
  assert.equal(server.pendingApproval.id, req.id);

  const wire = await waitFor(() => messages.of('approval-request')[0], { what: 'approval-request frame' });
  assert.equal(wire.id, req.id);
  assert.equal(wire.tool, 'bash');
  assert.equal(wire.cwd, '/tmp');
  assert.ok(wire.argsPreview.includes('ls -la'));
  assert.deepEqual(wire.args, { command: 'ls -la' });
  assert.ok(wire.deadlineAt > wire.at);

  client.answer(wire.id, 'allow');
  assert.equal(await decision, 'allow');
  assert.equal(server.pendingApproval, null);
});

test('ipc: deny and ask are both honored as explicit decisions', async (t) => {
  for (const decision of ['deny', 'ask']) {
    const { server, client, messages } = await pair(t, { approvalTimeoutMs: 2000 });
    const approvalEvent = once(server, 'approval-request');
    const p = server.requestApproval({ tool: 'bash', args: {} });
    const req = (await approvalEvent)[0];
    const wire = await waitFor(() => messages.of('approval-request')[0], { what: 'approval frame' });
    client.answer(wire.id, decision);
    assert.equal(await p, decision);
    assert.equal(req.id, wire.id);
    server.close();
    client.close();
  }
});

test('ipc: the server-side resolve() callback settles the hold', async (t) => {
  const { server, messages } = await pair(t, { approvalTimeoutMs: 2000 });
  const approvalEvent = once(server, 'approval-request');
  const p = server.requestApproval({ tool: 'write_file', args: { path: '/x' } });
  const req = (await approvalEvent)[0];
  await waitFor(() => messages.of('approval-request').length === 1, { what: 'approval frame' });
  req.resolve('deny');
  assert.equal(await p, 'deny');
});

// ---------------------------------------------------------------------------
// rule 1: approval timeout -> ask
// ---------------------------------------------------------------------------

test('ipc: approval timeout resolves ask (never allow)', async (t) => {
  const { server } = await pair(t, { approvalTimeoutMs: TINY });
  const p = server.requestApproval({ tool: 'bash', args: {} });
  assert.equal(await p, 'ask');
  assert.equal(server.pendingApproval, null);
});

test('ipc: approval timeout still fires with a connected client that never answers', async (t) => {
  const { server, client, messages } = await pair(t, { approvalTimeoutMs: TINY });
  const p = server.requestApproval({ tool: 'bash', args: {} });
  assert.equal(await p, 'ask');
  // the client did see the request, it just stayed silent
  assert.equal(messages.of('approval-request').length, 1);
  assert.equal(client.connected, true);
});

test('ipc: an unresolved approval cannot block a second one past its own timeout', async (t) => {
  const { server } = await pair(t, { approvalTimeoutMs: TINY });
  const first = server.requestApproval({ tool: 'a', args: {} });
  await sleep(5);
  const second = server.requestApproval({ tool: 'b', args: {} });
  assert.equal(await first, 'ask');
  assert.equal(await second, 'ask');
});

// ---------------------------------------------------------------------------
// rule 2: client disconnect mid-approval -> ask
// ---------------------------------------------------------------------------

test('ipc: client disconnect mid-approval resolves ask', async (t) => {
  const { server, client } = await pair(t, { approvalTimeoutMs: 5000 });
  const approvalEvent = once(server, 'approval-request');
  const p = server.requestApproval({ tool: 'bash', args: { command: 'rm -rf /' } });
  await approvalEvent;
  client.close();
  assert.equal(await p, 'ask');
  assert.equal(server.pendingApproval, null);
});

test('ipc: a socket destroyed out from under the server also resolves ask', async (t) => {
  const { server } = await pair(t, { approvalTimeoutMs: 5000 });
  const approvalEvent = once(server, 'approval-request');
  const p = server.requestApproval({ tool: 'bash', args: {} });
  await approvalEvent;
  server.clients.values().next().value.socket.destroy();
  assert.equal(await p, 'ask');
});

test('ipc: an approval with no client at all resolves ask immediately', async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'lonely');
  const server = createIpcServer({ socketPath, sessionId: 'lonely', approvalTimeoutMs: TINY });
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(server, 'listening');
  assert.equal(server.clients.size, 0);
  // Nobody can answer, so the hold must not even start.
  assert.equal(await server.requestApproval({ tool: 'bash', args: {} }), 'ask');
});

test('ipc: closing the server resolves a pending approval as ask', async (t) => {
  const { server } = await pair(t, { approvalTimeoutMs: 5000 });
  const p = server.requestApproval({ tool: 'bash', args: {} });
  await waitFor(() => server.pendingApproval !== null, { what: 'pending approval' });
  server.close();
  assert.equal(await p, 'ask');
});

// ---------------------------------------------------------------------------
// rule 4: second approval supersedes the first
// ---------------------------------------------------------------------------

test('ipc: a second approval supersedes the first, resolving it ask', async (t) => {
  const { server, client, messages } = await pair(t, { approvalTimeoutMs: 5000 });

  const firstEvent = once(server, 'approval-request');
  const first = server.requestApproval({ tool: 'bash', args: { command: 'one' } });
  const firstReq = (await firstEvent)[0];
  assert.equal(server.pendingApproval.id, firstReq.id);

  const secondEvent = once(server, 'approval-request');
  const second = server.requestApproval({ tool: 'write_file', args: { path: 'two' } });

  // rule 4: the stale approval is released immediately as 'ask'
  assert.equal(await first, 'ask');

  const secondReq = (await secondEvent)[0];
  assert.notEqual(secondReq.id, firstReq.id);

  // and the superseded answer can no longer affect anything
  const wires = await waitFor(() => (messages.of('approval-request').length === 2 ? messages.of('approval-request') : null), { what: 'both approval frames' });
  assert.ok(client.answer(wires[0].id, 'allow'), 'answer is sent');
  assert.equal(server.pendingApproval.id, secondReq.id, 'stale answer is ignored');

  client.answer(wires[1].id, 'allow');
  assert.equal(await second, 'allow');
});

// ---------------------------------------------------------------------------
// rule 5: validation
// ---------------------------------------------------------------------------

test('ipc: an invalid decision is ignored and the approval stays pending', async (t) => {
  // Long enough that the six invalid answers always land while it is pending,
  // even on a busy machine; the test ends it with an explicit deny.
  const { server, client, messages } = await pair(t, { approvalTimeoutMs: 10_000 });
  const warnings = [];
  server.on('protocol-warning', (w) => warnings.push(w));

  const approvalEvent = once(server, 'approval-request');
  const p = server.requestApproval({ tool: 'bash', args: {} });
  const req = (await approvalEvent)[0];
  const wire = await waitFor(() => messages.of('approval-request')[0], { what: 'approval frame' });

  for (const bad of ['ALLOW', 'yes', '', null, 1, { allow: true }]) {
    client.send({ type: 'approval-answer', id: wire.id, decision: bad });
  }
  await waitFor(() => warnings.filter((w) => w.reason === 'invalid-decision').length >= 6, { what: 'invalid-decision warnings' });

  // still pending — nothing resolved it, and nothing resolved to allow
  assert.equal(server.pendingApproval.id, req.id);
  let settled = false;
  p.then(() => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, 'invalid decisions must not settle the approval');

  client.answer(wire.id, 'deny');
  assert.equal(await p, 'deny');
});

test('ipc: the client refuses to put an invalid decision on the wire', async (t) => {
  const { client, messages } = await pair(t);
  const errors = [];
  client.on('error', (e) => errors.push(e));
  assert.equal(client.answer('ap-1', 'YES'), false);
  assert.match(errors[0].message, /invalid decision/);
  await sleep(20);
  assert.equal(messages.filter((m) => m.type === 'approval-answer').length, 0);
});

test('ipc: an answer for an unknown id is ignored', async (t) => {
  const { server, client, messages } = await pair(t, { approvalTimeoutMs: 300 });
  const warnings = [];
  server.on('protocol-warning', (w) => warnings.push(w));

  const approvalEvent = once(server, 'approval-request');
  const p = server.requestApproval({ tool: 'bash', args: {} });
  const req = (await approvalEvent)[0];
  const wire = await waitFor(() => messages.of('approval-request')[0], { what: 'approval frame' });

  client.answer('ap-does-not-exist', 'allow');
  await waitFor(() => warnings.some((w) => w.reason === 'unknown-id'), { what: 'unknown-id warning' });

  assert.equal(server.pendingApproval.id, req.id);
  let settled = false;
  p.then(() => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, 'an unknown id must not settle the approval');

  client.answer(wire.id, 'allow');
  assert.equal(await p, 'allow');
});

test('ipc: an answer arriving with no approval pending is ignored', async (t) => {
  const { server, client } = await pair(t);
  const warnings = [];
  server.on('protocol-warning', (w) => warnings.push(w));
  client.answer('ap-999', 'allow');
  await waitFor(() => warnings.some((w) => w.reason === 'unknown-id'), { what: 'unknown-id warning' });
  assert.equal(server.pendingApproval, null);
});

test('ipc: malformed JSON does not crash the server and the next valid frame still works', async (t) => {
  const { server, client, messages } = await pair(t, { approvalTimeoutMs: 500 });
  const warnings = [];
  server.on('protocol-warning', (w) => warnings.push(w));
  let fatal = null;
  server.on('error', (e) => { fatal = e; });

  // raw bytes straight onto the wire, bypassing the client's own encoder
  client.socket.write('this is not json\n');
  client.socket.write('{"type":"ping"\n');            // unbalanced
  client.socket.write('{"type":"totally-unknown"}\n'); // valid JSON, unknown type
  client.socket.write('[1,2,3]\n');                    // valid JSON, not an object
  client.socket.write('"a string"\n');                 // valid JSON, wrong shape

  await waitFor(() => warnings.length >= 4, { what: 'protocol warnings' });
  assert.equal(fatal, null, 'the server must never surface a crash');
  const reasons = warnings.map((w) => w.reason);
  assert.ok(reasons.includes('malformed-json'));
  assert.ok(reasons.includes('unknown-type'));
  assert.ok(reasons.includes('non-object-message'));

  // the server is still healthy: ping round-trips and broadcasts still flow
  const client2 = connectIpcClient({ socketPath: server.socketPath, clientId: 'after-garbage' });
  t.after(() => client2.close());
  const msgs2 = collect(client2);
  await once(client2, 'open');
  client2.ping();
  assert.ok(await waitFor(() => msgs2.of('pong')[0], { what: 'pong after garbage' }));
  server.broadcast({ event: 'still_alive' });
  assert.ok(await waitFor(() => msgs2.of('event')[0], { what: 'event after garbage' }));
  assert.equal(messages.length >= 0, true);
});

test('ipc: a client message larger than the frame cap is dropped, not buffered', async (t) => {
  const { server, client, messages } = await pair(t);
  const warnings = [];
  server.on('protocol-warning', (w) => warnings.push(w));
  const before = warnings.length;
  client.socket.write(`{"type":"ping","pad":"${'x'.repeat(2 * 1024 * 1024)}"}\n`);
  // 2 MB through a socket can outlast the default 2 s on a busy machine.
  await waitFor(() => warnings.length > before, { what: 'the oversize frame to be ignored', timeoutMs: 10_000 });
  assert.match(warnings.at(-1).reason, /^oversize-(frame|partial)$/);
  // the connection survived and still answers
  assert.equal(server.clients.size, 1);
  client.ping();
  assert.ok(await waitFor(() => messages.of('pong')[0], { what: 'pong after the oversize frame', timeoutMs: 10_000 }));
  // the tail of the dropped frame is skipped, not parsed as a frame of its own
  assert.deepEqual(warnings.filter((w) => w.reason === 'malformed-json'), []);
});

test('ipc: ping is answered with pong', async (t) => {
  const { client, messages } = await pair(t);
  client.ping();
  assert.ok(await waitFor(() => messages.of('pong')[0], { what: 'pong' }));
});

// ---------------------------------------------------------------------------
// rule 3: socket lifecycle
// ---------------------------------------------------------------------------

test('ipc: the socket file exists while listening and is removed on close', { skip: SOCKET_FILES }, async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'lifecycle');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const server = createIpcServer({ socketPath, sessionId: 'lifecycle' });
  await once(server, 'listening');
  assert.ok(fs.existsSync(socketPath), 'socket file should exist once listening');
  const closed = once(server, 'close');
  server.close();
  await closed;
  assert.equal(fs.existsSync(socketPath), false, 'socket file should be unlinked on close');
});

test('ipc: a stale socket file from a crashed server is unlinked on start', { skip: SOCKET_FILES }, async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'stale');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });

  // Simulate a crash for real: SIGKILL a process that owns the socket, so
  // nothing gets a chance to unlink it. (A clean close() would tidy up after
  // itself, which is exactly why this has to be a kill.)
  const crashed = spawn(process.execPath, ['-e', `
    const net = require('node:net');
    const s = net.createServer(() => {});
    s.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready\\n'));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { crashed.kill('SIGKILL'); } catch { /* already dead */ } });

  await once(crashed.stdout, 'data', 5000); // wait for 'ready'
  assert.equal(await once(crashed, 'error', 100).then(() => 'error', () => 'ok'), 'ok');

  crashed.kill('SIGKILL');
  await once(crashed, 'exit', 5000);
  assert.ok(fs.existsSync(socketPath), 'the crashed server should leave a stale file');

  const server = createIpcServer({ socketPath, sessionId: 'stale' });
  t.after(() => server.close());
  await once(server, 'listening', 1000);
  assert.ok(fs.existsSync(socketPath));

  // and it is a working socket, not the corpse
  const client = connectIpcClient({ socketPath, clientId: 'after-crash' });
  t.after(() => client.close());
  await once(client, 'open');
});

test('ipc: a stale socket is unlinked even when it is not a socket at all', { skip: SOCKET_FILES }, async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'garbage');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  fs.writeFileSync(socketPath, 'not a socket');

  const server = createIpcServer({ socketPath, sessionId: 'garbage' });
  t.after(() => server.close());
  await once(server, 'listening');
  assert.ok(fs.existsSync(socketPath));

  const client = connectIpcClient({ socketPath, clientId: 'c' });
  t.after(() => client.close());
  await once(client, 'open');
});

// ---------------------------------------------------------------------------
// rule 3 (stagger): a missing socket must fail fast, never hang
// ---------------------------------------------------------------------------

test('ipc: connecting to a nonexistent socket errors fast and does not hang', async () => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'nobody-home');
  const started = Date.now();
  const client = connectIpcClient({ socketPath, clientId: 'ghost', connectTimeoutMs: 50 });
  // attach before awaiting: finish() emits 'error' and 'close' in one tick
  const closed = once(client, 'close');
  const err = (await once(client, 'error'))[0];
  const elapsed = Date.now() - started;
  assert.ok(err instanceof Error);
  assert.ok(elapsed < 1000, `expected a fast failure, took ${elapsed}ms`);
  assert.equal(client.connected, false);
  const [info] = await closed;
  assert.ok(info.reason);
  assert.equal(client.closed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ipc: a client pointed at a socket with no server never opens', async () => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'ghost');
  const client = connectIpcClient({ socketPath, connectTimeoutMs: 40 });
  client.on('open', () => { throw new Error('must never open'); });
  const [err] = await once(client, 'error');
  assert.match(err.message, /ENOENT|no such file/i);
  assert.equal(client.open, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ipc: send/answer on a dead client are no-ops that return false', async () => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'ghost');
  const client = connectIpcClient({ socketPath, connectTimeoutMs: 40 });
  await once(client, 'error');
  assert.equal(client.send({ type: 'ping' }), false);
  assert.equal(client.answer('ap-1', 'allow'), false);
  assert.equal(client.closed, true);
  client.close(); // idempotent
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// rule 6: backpressure cap
// ---------------------------------------------------------------------------

test('ipc: a non-draining client makes the server drop old events instead of buffering forever', async (t) => {
  const { server } = await pair(t);
  const drops = [];
  server.on('dropped', (d) => drops.push(d));

  const [client] = server.clients;
  // Fill the socket's own write buffer so the server sees a congested peer.
  client.socket.write(Buffer.alloc(8 * 1024 * 1024));
  await sleep(10);
  assert.ok(client.socket.writableLength > 0, 'precondition: peer is congested');

  const before = client.dropped;
  for (let i = 0; i < 900; i += 1) server.broadcast({ event: 'flood', i });

  assert.ok(client.dropped > before, 'expected drops to be counted');
  assert.ok(drops.length > 0);
  assert.ok(client.queue.length <= 500, `queue must stay capped, got ${client.queue.length}`);
  assert.ok(client.queueBytes <= 2 * 1024 * 1024, 'queue bytes must stay capped');
  assert.ok(server.droppedCount > 0);
});

test('ipc: the newest queued message survives the drop-oldest policy', async (t) => {
  const { server } = await pair(t);
  const [client] = server.clients;
  client.socket.write(Buffer.alloc(8 * 1024 * 1024));
  await sleep(10);
  for (let i = 0; i < 700; i += 1) server.broadcast({ event: 'flood', i });
  assert.ok(client.dropped > 0);
  const last = client.queue[client.queue.length - 1];
  assert.ok(last.includes('"i":699'), 'the most recent event must still be queued');
});

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

test('ipc: client-connected / client-disconnected are emitted', async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'conn');
  const server = createIpcServer({ socketPath, sessionId: 'conn' });
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(server, 'listening');

  const connected = once(server, 'client-connected');
  const client = connectIpcClient({ socketPath, clientId: 'named-client' });
  const [info] = await connected;
  assert.equal(info.clientId, 'named-client');

  const disconnected = once(server, 'client-disconnected');
  client.close();
  await disconnected;
  assert.equal(server.clients.size, 0);
});

test('ipc: server emits event for every broadcast', async (t) => {
  const { server } = await pair(t);
  const seen = [];
  server.on('event', (e) => seen.push(e));
  server.broadcast({ event: 'a' });
  server.broadcast({ event: 'b' });
  assert.deepEqual(seen, [{ event: 'a' }, { event: 'b' }]);
});

test('ipc: broadcast payloads are sanitized before they hit the wire', async (t) => {
  const { server, messages } = await pair(t);
  server.broadcast({ event: 'x', apiKey: 'sk-should-not-travel', big: 'y'.repeat(5000) });
  const evt = await waitFor(() => messages.of('event')[0], { what: 'event frame' });
  assert.equal(evt.event.apiKey, '[redacted]');
  assert.ok(evt.event.big.length < 5000);
});

test('ipc: approval args are sanitized before they hit the wire', async (t) => {
  const { server, messages } = await pair(t, { approvalTimeoutMs: 200 });
  server.requestApproval({ tool: 'bash', args: { command: 'ls', headers: { authorization: 'Bearer sk-x' }, blob: 'z'.repeat(9000) } });
  const wire = await waitFor(() => messages.of('approval-request')[0], { what: 'approval frame' });
  assert.equal(wire.args.headers.authorization, '[redacted]');
  assert.ok(!JSON.stringify(wire).includes('sk-x'));
  assert.ok(wire.args.blob.length < 9000);
  assert.ok(wire.argsPreview.length < 500);
});

test('ipc: server.close() is idempotent and broadcasts still work before it', async (t) => {
  const { server } = await pair(t);
  server.broadcast({ event: 'before-close' });
  server.close();
  server.close();
  await once(server, 'close');
  assert.equal(server.clients.size, 0);
});

test('ipc: a live server socket is never stolen by a second server', async (t) => {
  const dir = mkdtemp();
  const socketPath = sockPath(dir, 'owned');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });

  const owner = createIpcServer({ socketPath, sessionId: 'owner' });
  t.after(() => owner.close());
  await once(owner, 'listening');

  const intruder = createIpcServer({ socketPath, sessionId: 'intruder' });
  t.after(() => intruder.close());
  const [err] = await once(intruder, 'error');
  assert.equal(err.code, 'EIPCINUSE');

  // the original server still owns the socket and still works
  const client = connectIpcClient({ socketPath, clientId: 'still-here' });
  t.after(() => client.close());
  await once(client, 'open');
  // A pipe client can see its connect complete before the server's accept
  // callback has run, so wait for the owner to register it.
  await waitFor(() => owner.clients.size === 1, { what: 'the owner to accept the client' });
  assert.equal(intruder.clients.size, 0);
});

// ---------------------------------------------------------------------------
// ipc secret-key classification
// ---------------------------------------------------------------------------

describe('ipc secret-key classification', () => {
  const SECRET_KEYS = [
    'apiKey', 'api_key', 'API-KEY', 'apikey', 'api-key', 'x-api-key', 'x_api_key',
    'authorization',
    'authToken', 'auth-token', 'access_token', 'accessToken', 'access-token',
    'refresh_token', 'refreshToken', 'refresh-token', 'sessionToken',
    'session-token', 'token', 'bearer', 'secret', 'clientSecret', 'client-secret',
    'password', 'passwd', 'cookie', 'set-cookie', 'setCookie',
  ];

  const SAFE_KEYS = [
    'inputTokens', 'input_tokens', 'outputTokens', 'output_tokens',
    'auxInputTokens', 'auxOutputTokens', 'tokensIn', 'tokensOut', 'tokenCount',
    'totalTokens', 'maxCostUsd', 'costUsd', 'knownCostUsd', 'unknownModels',
    'model', 'provider', 'baseUrl', 'sessionId', 'servedBy', 'pid', 'cwd',
    'version', 'iters', 'count', 'ms', 'bytes', 'ok', 'isError', 'id', 'name',
    'decision', 'tool', 'reason', 'detail', 'status',
  ];

  test('isSecretKey flags every credential-shaped key', () => {
    for (const k of SECRET_KEYS) {
      assert.equal(isSecretKey(k), true, `expected ${k} to be classified as secret`);
    }
  });

  test('isSecretKey leaves metric and telemetry keys alone', () => {
    for (const k of SAFE_KEYS) {
      assert.equal(isSecretKey(k), false, `expected ${k} NOT to be classified as secret`);
    }
  });

  test('sanitizeForWire keeps token metrics as numbers, not [redacted]', () => {
    const out = sanitizeForWire({ inputTokens: 21860, outputTokens: 1204 });
    assert.equal(typeof out.inputTokens, 'number');
    assert.equal(out.inputTokens, 21860);
    assert.equal(typeof out.outputTokens, 'number');
    assert.equal(out.outputTokens, 1204);
  });

  test('sanitizeForWire redacts apiKey and hyphenated API-KEY (leak regression guard)', () => {
    assert.equal(sanitizeForWire({ apiKey: 'sk-live-abc123' }).apiKey, '[redacted]');
    const wire = sanitizeForWire({ 'API-KEY': 'sk-live-xyz' });
    assert.equal(wire['API-KEY'], '[redacted]');
    assert.ok(!JSON.stringify(wire).includes('sk-live-xyz'));
  });

  test('sanitizeForWire redacts prefixed hyphenated keys on the wire (boundary guard)', () => {
    // The regression these pin: the inner separator classes must accept [-_],
    // not just _, AND the leading boundary class must accept '-'. Without the
    // boundary fix 'x-api-key' normalised to 'x-api-key', whose leading '-'
    // matched no boundary, so the credential crossed the socket in the clear.
    for (const k of ['x-api-key', 'x_api_key', 'api-key', 'API-KEY', 'api_key', 'apiKey']) {
      const wire = sanitizeForWire({ [k]: 'sk-live-boundary' });
      assert.equal(wire[k], '[redacted]', `expected ${k} to be redacted on the wire`);
      assert.ok(!JSON.stringify(wire).includes('sk-live-boundary'),
        `secret leaked through ${k}`);
    }
    // And the safe metric keys must survive the same walk untouched.
    for (const k of ['inputTokens', 'outputTokens', 'tokenCount']) {
      assert.equal(sanitizeForWire({ [k]: 1234 })[k], 1234,
        `expected ${k} to pass through as a number`);
    }
  });

  test('sanitizeForWire redacts setCookie (cookie material never crosses the wire)', () => {
    assert.equal(sanitizeForWire({ setCookie: 'a' }).setCookie, '[redacted]');
  });

  test('sanitizeForWire masks a secret nested several levels deep', () => {
    const out = sanitizeForWire({
      a: { b: { c: { d: { e: { 'api-key': 'sk-deep-nest' } } } } },
      ok: true,
    });
    assert.equal(out.a.b.c.d.e['api-key'], '[redacted]');
    assert.ok(!JSON.stringify(out).includes('sk-deep-nest'));
    assert.equal(out.ok, true);
  });
});
