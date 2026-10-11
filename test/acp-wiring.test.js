import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpSession,
  createAcpServer,
  toolKindOf,
  textFromPromptBlocks,
  MODES,
  PERMISSION_TIMEOUT_MS,
  RpcError,
  ACP_PROTOCOL_VERSION,
} from '../src/acp.js';

const oxDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('toolKindOf maps ox tool names onto ACP tool kinds', () => {
  assert.equal(toolKindOf('read_file'), 'read');
  assert.equal(toolKindOf('edit_file'), 'edit');
  assert.equal(toolKindOf('write_file'), 'edit');
  assert.equal(toolKindOf('bash'), 'execute');
  assert.equal(toolKindOf('grep'), 'search');
  assert.equal(toolKindOf('glob'), 'search');
  assert.equal(toolKindOf('web_get'), 'fetch');
  assert.equal(toolKindOf('todo'), 'think');
  assert.equal(toolKindOf('smoke-tool'), 'other');
});

test('textFromPromptBlocks flattens prompt blocks to plain text', () => {
  assert.equal(textFromPromptBlocks([{ type: 'text', text: 'hello' }]), 'hello');
  assert.equal(textFromPromptBlocks([{ type: 'text', text: '' }]), '');
  assert.equal(textFromPromptBlocks([]), '');
});

test('AcpSession is constructed with the right defaults', () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  assert.equal(s.id, 'ses_1');
  assert.equal(s.mode, 'code');
  assert.equal(s.cwd, '/tmp');
  assert.equal(s.prompting, false);
  assert.equal(s.promptRpcId, null);
  assert.deepEqual(s.modesState(), {
    currentModeId: 'code',
    availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })),
  });
});

test('setMode emits session/update carrying the ox event meta key', () => {
  const calls = [];
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: (n) => calls.push(n) });
  s.setMode('plan');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'session/update');
  assert.deepEqual(calls[0].params, {
    sessionId: 'ses_1',
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
      _meta: { 'com.ox.event': { type: 'mode', mode: 'plan' } },
    },
  });
});

test('resolveTarget fails closed with auth_required when nothing is reachable', () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  // assert.throws RETURNS UNDEFINED — match the error in place instead of
  // reading properties off its (null) return value.
  assert.throws(() => s.resolveTarget(), {
    name: 'RpcError',
    code: RpcError.Codes.AUTH_REQUIRED,
    message: /^auth_required/,
  });
});

test('cancel() is a no-op safe to call twice', () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  assert.deepEqual(s.cancel(), {});
  assert.deepEqual(s.cancel(), {});
  assert.equal(s.cancelled, true);
  assert.equal(s.prompting, false);
});

test('close() releases the MCP hub', async () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  s.ensureMcp([{ name: 'bridge', command: 'echo' }]);
  assert.ok(s.hub);
  await s.close();
  assert.equal(s.hub, null);
  assert.equal(s.mcpTools.length, 0);
});

// ---------------------------------------------------------------------------
// Stdio helpers: the parent is the client, a real child process is the server,
// and both directions travel over pipes exactly like Zed/JetBrains.
// ---------------------------------------------------------------------------

const childFixture = join(oxDir, 'test', 'fixtures', 'acp-child.mjs');

function spawnServer({ cwd, configDefaultBot, env, onLine }) {
  const child = spawn(process.execPath, [childFixture], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      TERM: 'dumb',
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      OX_DEFAULT_BOT: configDefaultBot,
      ...env,
    },
    cwd,
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try {
          onLine(JSON.parse(line), line);
        } catch (err) {
          onLine({ __raw__: line, __parse_error: err.message }, line);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    for (const line of Buffer.concat([chunk]).toString().split('\n')) {
      if (line.trim()) process.stderr.write(`[child stderr] ${line}\n`);
    }
  });
  return child;
}

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function nextLine(child, state) {
  return new Promise((resolve) => {
    if (state.lines.length) return resolve(state.lines.shift());
    state.waiting = resolve;
  });
}

// onLine side of nextLine(): wake a parked waiter FIRST, else buffer. Without
// the waiting check, a reply that lands after nextLine() parked is pushed into
// `lines` and nobody ever resolves — the await hangs forever (this was every
// stdio test's timeout).
function collector(state) {
  return (msg) => {
    if (state.waiting) {
      const wake = state.waiting;
      state.waiting = null;
      wake(msg);
    } else {
      state.lines.push(msg);
    }
  };
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    child.once('exit', () => resolve(child.exitCode));
  });
}

test('initialize/authenticate/session/new over stdio match the Zed wire format', { timeout: 60_000 }, async (t) => {
  const state = { lines: [] };
  const child = spawnServer({
    cwd: oxDir,
    configDefaultBot: 'ox-ollama',
    env: { TERM: 'dumb', HOME: process.env.HOME, PATH: process.env.PATH },
    onLine: collector(state),
  });
  try {
    // Every request carries a JSON-RPC id: without one the message is a
    // NOTIFICATION and the server correctly stays silent — that silence was
    // the 60s timeout.
    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } });
    const init = await nextLine(child, state);
    assert.ok(init.id);
    assert.equal(init.result.protocolVersion, ACP_PROTOCOL_VERSION);
    assert.equal(init.result.agentInfo.name, 'ox');
    assert.deepEqual(init.result.authMethods.map((m) => m.id), ['byok']);
    assert.ok(
      init.result.authMethods.every((m) => m.type === undefined || m.type === 'agent'),
      'byok must default to the spec default type (agent)'
    );
    assert.equal(
      init.result.authMethods.find((m) => m.id === 'terminal-setup'),
      undefined,
      'no terminal method without terminal capability'
    );

    send(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        clientCapabilities: { terminal: true, auth: { terminal: true }, _meta: { 'terminal-auth': true } },
      },
    });
    const init2 = await nextLine(child, state);
    assert.ok(
      init2.result.authMethods.some((m) => m.id === 'terminal-setup' && m.type === 'terminal'),
      'terminal-setup must be advertised when the client declares terminal capability'
    );

    send(child, { jsonrpc: '2.0', id: 3, method: 'authenticate', params: { methodId: 'byok' } });
    const auth = await nextLine(child, state);
    assert.deepEqual(auth.result, {});

    send(child, { jsonrpc: '2.0', id: 4, method: 'session/new', params: { cwd: oxDir } });
    const newSession = await nextLine(child, state);
    assert.equal(newSession.result.sessionId, init.result.sessionId ?? newSession.result.sessionId);
    assert.equal(newSession.result.modes.currentModeId, 'code');
    assert.ok(Array.isArray(newSession.result.modes.availableModes));

    send(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'session/set_mode',
      params: { sessionId: newSession.result.sessionId, modeId: 'plan' },
    });
    // setMode emits the session/update notification WHILE being handled, so on
    // the wire the notification lands before the set_mode reply.
    const update = await nextLine(child, state);
    assert.equal(update.method, 'session/update');
    assert.equal(update.params.update.sessionUpdate, 'current_mode_update');
    assert.equal(update.params.update.currentModeId, 'plan');
    assert.deepEqual(update.params.update._meta, { 'com.ox.event': { type: 'mode', mode: 'plan' } });
    const setMode = await nextLine(child, state);
    assert.deepEqual(setMode.result, {});

    // Closing stdin is the client disconnect: the pump ends and the fixture
    // exits on its own — no signal needed, no 60s wait.
    child.stdin.end();
    await waitForChildExit(child);
  } finally {
    child.kill('SIGTERM');
  }
});


test('requestApproval without a channel declines instead of hanging', async () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  assert.equal(await s.requestApproval('write_file', { path: '/tmp/x' }, 'write /tmp/x'), false);
});

test('requestApproval records the request and routes allow_once through it', async () => {
  const recorded = [];
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  s.onSendRequest = (req) => {
    recorded.push(req);
    return Promise.resolve({ outcome: { type: 'selected', optionId: 'allow_once' } });
  };

  const ok = await s.requestApproval('write_file', { path: '/tmp/x' }, 'write /tmp/x');
  assert.equal(ok, true);
  assert.equal(recorded.length, 1);
  const req = recorded[0];
  assert.equal(req.method, 'session/request_permission');
  assert.equal(req.id, `req_perm_${s.id}`);
  assert.equal(req.params.sessionId, 'ses_1');
  assert.deepEqual(req.params.toolCall, {
    toolCallId: `pc_${s.id}`,
    // The title carries the detail so the permission dialog says WHAT is being
    // written, not just which tool asked.
    title: 'write_file: write /tmp/x',
    name: 'write_file',
    kind: 'edit',
    status: 'pending',
  });
  assert.equal(req.params.options.length, 4);
  assert.deepEqual(
    req.params.options.map((o) => o.optionId),
    ['allow_once', 'allow_always', 'reject_once', 'reject_always']
  );
});

test('allow_always outcome flips the session trustAll flag', async () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  s.onSendRequest = () =>
    Promise.resolve({ outcome: { type: 'selected', optionId: 'allow_always' } });
  assert.equal(await s.requestApproval('bash', { cmd: 'ls' }, 'ls'), true);
  assert.equal(s.trustAll, true);
  assert.equal(await s.requestApproval('bash', { cmd: 'ls' }, 'ls'), true);
});

test('requestApproval fails closed on client errors, timeouts and unknown outcomes', async () => {
  const s = new AcpSession({ id: 'ses_1', cwd: '/tmp', config: {}, target: null, onNotify: () => {} });
  s.onSendRequest = () => Promise.reject(new Error('boom'));
  assert.equal(await s.requestApproval('write_file', {}, 'd'), false);

  s.onSendRequest = () => Promise.resolve({ outcome: { type: 'nonsense', optionId: 'whatever' } });
  assert.equal(await s.requestApproval('write_file', {}, 'd'), false);

  s.onSendRequest = () => Promise.resolve({});
  assert.equal(await s.requestApproval('write_file', {}, 'd'), false);

  s.onSendRequest = () => Promise.resolve({ outcome: { type: 'selected', optionId: 'bogus' } });
  assert.equal(await s.requestApproval('write_file', {}, 'd'), false);
});

test('requestApproval denies sandbox-conflicted tools before contacting the client', async () => {
  const s = new AcpSession({
    id: 'ses_1',
    cwd: '/tmp',
    config: { sandbox: { profile: 'strict', network_allow: [] } },
    target: null,
    onNotify: () => {},
  });
  let called = 0;
  s.onSendRequest = () => {
    called += 1;
    return Promise.resolve({ outcome: { type: 'selected', optionId: 'allow_once' } });
  };
  assert.equal(await s.requestApproval('web_get', { url: 'https://evil.example.com' }, 'fetch'), false);
  assert.equal(called, 0, 'blocking tools must never reach the client');
});



test('prompt with no reachable provider fails with auth_required (-32000)', { timeout: 30_000 }, async (t) => {
  // One shared state, like every other stdio test here: `nextLine` waits on
  // the object `onLine` pushes into. A fresh `{ lines: [] }` per call waits on
  // a queue nothing ever writes to — that was this test's 30s timeout.
  const state = { lines: [] };
  const child = spawnServer({
    cwd: oxDir,
    configDefaultBot: undefined, // config = {} -> no fallback -> auth_required
    env: { TERM: 'dumb', HOME: process.env.HOME, PATH: process.env.PATH },
    onLine: collector(state),
  });
  try {
    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } });
    const init = await nextLine(child, state);
    assert.equal(init.result.protocolVersion, ACP_PROTOCOL_VERSION);

    send(child, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: oxDir } });
    const newSession = await nextLine(child, state);
    assert.ok(newSession.result.sessionId);

    send(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: newSession.result.sessionId, prompt: [{ type: 'text', text: 'echo hi' }] },
    });
    const prompt = await nextLine(child, state);
    // The reply echoes the request id we sent (3).
    assert.equal(prompt.id, 3);
    assert.equal(prompt.error.code, RpcError.Codes.AUTH_REQUIRED);
    assert.match(prompt.error.message, /^auth_required/);

    send(child, { jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: newSession.result.sessionId } });
    const closed = await nextLine(child, state);
    assert.deepEqual(closed.result, {});
  } finally {
    child.kill('SIGTERM');
  }
});

test('$/cancel_request and session/cancel are no-ops on the wire, close survives', { timeout: 30_000 }, async (t) => {
  // Shared state — a fresh `{ lines: [] }` per nextLine() call waits on a
  // queue nothing writes to and the test times out at 30s.
  const state = { lines: [] };
  const child = spawnServer({
    cwd: oxDir,
    configDefaultBot: 'ox-ollama',
    env: { TERM: 'dumb', HOME: process.env.HOME, PATH: process.env.PATH },
    onLine: collector(state),
  });
  try {
    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: {} } });
    await nextLine(child, state);
    send(child, { jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'byok' } });
    await nextLine(child, state);
    send(child, { jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: oxDir } });
    const created = await nextLine(child, state);
    const sessionId = created.result.sessionId;

    // session/cancel is a notification: nothing is written to the client in
    // reply, so the next line after the request must be the reply to the next
    // request we sent (session/close).
    send(child, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    send(child, { jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId } });
    const closed = await nextLine(child, state);
    assert.deepEqual(closed.result, {});

    // Cancelling an unknown session is a notification too: silently ignored,
    // and the next line must be the reply to the NEXT request we sent.
    send(child, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'does-not-exist' } });
    send(child, { jsonrpc: '2.0', id: 5, method: 'session/close', params: { sessionId: 'does-not-exist' } });
    const err = await nextLine(child, state);
    assert.equal(err.error.code, RpcError.Codes.INVALID_PARAMS);

    // session/request_permission is never sent on this path: the turn never
    // reaches a tool call.
    send(child, { jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId } });
    await nextLine(child, state);
  } finally {
    child.kill('SIGTERM');
  }
});


