import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-e2e-'));
  // Never throws: a hook that throws stops every later t.after (the mock
  // server's close among them) and the process then never exits. Windows
  // reports EBUSY while a just-exited child still holds the folder.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir */ } });
  return dir;
}

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];

// Children inherit the parent env; HOME is overridden to the sandbox in the
// child's env BEFORE spawn so config/session state never touches the real ~.
function childEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// One scripted model turn as OpenAI-style SSE: content delta(s), tool_call
// deltas, finish_reason, usage tail on an empty-choices chunk, [DONE].
function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } }) {
  const out = [];
  if (text) {
    out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  }
  calls.forEach((call, index) => {
    out.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
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

// localhost-only mock; decide(messages) -> {text, calls} per request
function startMock(t, decide) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push(messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn(decide(messages)));
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

// 45s, not 25s: this budget is a watchdog for a child that will never exit, NOT
// a test assertion - every run below is scripted against a loopback mock and
// finishes in well under a second. 25s left no slack once the suite runs
// --test-concurrency=2 and sibling suites deliberately burn 15-33s waiting out
// real timeouts, so external load could turn a slow machine into a mystery
// failure. The timeout still rejects with the child's stdout+stderr.
const SPAWN_BUDGET_MS = 45000;

function spawnOx({ home, cwd, base, args, stdin = '', extraEnv = {} }) {
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd,
    env: childEnv(home, {
      OX_BASE_URL: `http://127.0.0.1:${base}/v1`,
      OX_API_KEY: 'test',
      ...extraEnv,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ox did not exit within ${SPAWN_BUDGET_MS}ms and was SIGKILLed\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, SPAWN_BUDGET_MS);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
  if (typeof stdin === 'string') child.stdin.end(stdin);
  return { child, done };
}

async function waitFor(fn, { intervalMs = 100, tries = 80 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(intervalMs);
  }
  return !!fn();
}

test('A: headless tool loop reads note.txt and streams marker back', async (t) => {
  const home = makeSandbox(t);
  const marker = 'OX_E2E_MARKER_7c9d42';
  fs.writeFileSync(path.join(home, 'note.txt'), `hello\n${marker}\nbye\n`);
  const { port, requests } = await startMock(t, (messages) => {
    const answered = messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_a1');
    if (!answered) {
      return {
        text: 'Reading the note.',
        calls: [{ id: 'call_a1', name: 'read_file', args: { path: path.join(home, 'note.txt') } }],
      };
    }
    return { text: `The note says ${marker}`, calls: [] };
  });
  const { done } = spawnOx({ home, cwd: home, base: port, args: ['-p', 'read it'] });
  const { code, stdout, stderr } = await done;
  assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.ok(stdout.includes(marker), `marker missing in stdout:\n${stdout}`);
  assert.equal(requests.length, 2, 'expected exactly two model turns');
});

test('B: --json emits NDJSON agent events including a usage-bearing event', async (t) => {
  const home = makeSandbox(t);
  const { port } = await startMock(t, () => ({ text: 'json reply ok' }));
  const { done } = spawnOx({ home, cwd: home, base: port, args: ['--json', '-p', 'say hi'] });
  const { code, stdout, stderr } = await done;
  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n').filter((l) => l.trim());
  assert.ok(lines.length > 0, 'no NDJSON lines emitted');
  const events = [];
  for (const line of lines) {
    let ev;
    assert.doesNotThrow(() => {
      ev = JSON.parse(line);
    }, `non-JSON line: ${line}`);
    events.push(ev);
  }
  const usageBearing = events.filter((ev) => (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0) > 0);
  assert.ok(usageBearing.length >= 1, `no usage-bearing event among:\n${stdout}`);
});

test('C: self-heal retries edit_file with corrected old_string and edits the file', async (t) => {
  const home = makeSandbox(t);
  const file = path.join(home, 'note-c.txt');
  fs.writeFileSync(file, 'hello world\n');
  const { port, requests } = await startMock(t, (messages) => {
    if (!messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_c1')) {
      return {
        text: 'attempting the edit',
        calls: [
          {
            id: 'call_c1',
            name: 'edit_file',
            args: { path: file, old_string: 'ABSENT_TEXT_XYZ', new_string: 'goodbye world' },
          },
        ],
      };
    }
    if (!messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_c2')) {
      return {
        text: 'correcting approach with exact current text',
        calls: [
          {
            id: 'call_c2',
            name: 'edit_file',
            args: { path: file, old_string: 'hello world', new_string: 'goodbye world' },
          },
        ],
      };
    }
    return { text: 'C_FINAL edited okay', calls: [] };
  });
  const { done } = spawnOx({
    home,
    cwd: home,
    base: port,
    args: ['--yes-edits', '-p', 'fix the greeting'],
  });
  const { code, stdout, stderr } = await done;
  assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.equal(requests.length, 3, 'expected fail -> retry -> final turns');
  assert.match(fs.readFileSync(file, 'utf8'), /goodbye world/, 'file not edited on disk');
});

// REAL contract verified in src/headless.js: denialCount>0 maps to exit 2 via
// `failed ? 1 : denialCount > 0 ? 2 : 0`. A decline is fed back as an isError
// tool result, so the mock serves one final text turn after the decline —
// otherwise self-heal exhaustion would set failed=true and exit 1 instead.
test('D: declined bash approval in non-TTY headless run exits 2', async (t) => {
  const home = makeSandbox(t);
  const { port, requests } = await startMock(t, (messages) => {
    if (!messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_d1')) {
      return {
        text: 'running echo for you',
        calls: [{ id: 'call_d1', name: 'bash', args: { command: 'echo hi' } }],
      };
    }
    return { text: 'understood, stopping without running it.', calls: [] };
  });
  // Wave5b K: `echo hi` alone would now ride the read-only auto-approve
  // ladder; --strict-approvals keeps this decline-path contract intact.
  const { done } = spawnOx({ home, cwd: home, base: port, args: ['--strict-approvals', '-p', 'echo hi please'] });
  const { code, stdout, stderr } = await done;
  assert.equal(code, 2, `expected exit 2\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /approval prompts unavailable/);
  assert.equal(requests.length, 2);
});

test('E: interactive REPL turn then /exit writes an episode markdown', async (t) => {
  const home = makeSandbox(t);
  const marker = 'OX_E2E_REPL_5b21af';
  fs.writeFileSync(path.join(home, 'note.txt'), `${marker}\n`);
  const { port, requests } = await startMock(t, (messages) => {
    if (!messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_e1')) {
      return {
        text: 'peeking at the note',
        calls: [{ id: 'call_e1', name: 'read_file', args: { path: path.join(home, 'note.txt') } }],
      };
    }
    return { text: `noted ${marker}`, calls: [] };
  });
  const { child, done } = spawnOx({ home, cwd: home, base: port, args: [], stdin: null });
  child.stdin.write('read it\n');
  const served = await waitFor(() => requests.length >= 2);
  assert.ok(served, `REPL turn never completed (${requests.length} requests)`);
  await sleep(400); // let the final stream drain and the prompt return
  child.stdin.write('/exit\n');
  child.stdin.end();
  const { code, stdout, stderr } = await done;
  assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  const epDir = path.join(home, '.agent', 'episodes');
  assert.ok(fs.existsSync(epDir), `missing episodes dir ${epDir}`);
  const episodes = fs.readdirSync(epDir).filter((f) => f.endsWith('.md'));
  assert.ok(episodes.length >= 1, `no .md episode under ${epDir}`);
});

test('F: --json redacts the terminal history event; OX_REDACT=0 restores full messages', async (t) => {
  const home = makeSandbox(t);
  const secret = 'OX_HISTORY_SECRET_9f2c1a';
  const { port } = await startMock(t, (messages) => ({ text: `final reply with ${secret}` }));

  const redactedRun = spawnOx({ home, cwd: home, base: port, args: ['--json', '-p', 'say it'] });
  const redacted = await redactedRun.done;
  assert.equal(redacted.code, 0, redacted.stderr);
  const redEvents = redacted.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const histRed = redEvents.find((ev) => ev.t === 'history');
  assert.ok(histRed, `no history event in:\n${redacted.stdout}`);
  assert.equal(typeof histRed.count, 'number', `history event lacks count: ${JSON.stringify(histRed)}`);
  assert.equal(histRed.messages, undefined, 'messages must be redacted by default');
  assert.ok(
    !JSON.stringify(histRed).includes(secret),
    'history event itself must not carry message payloads'
  );
  const leakedHistory = redEvents.find(
    (ev) => ev.t === 'history' && JSON.stringify(ev).includes(secret)
  );
  assert.equal(leakedHistory, undefined);

  const fullRun = spawnOx({
    home,
    cwd: home,
    base: port,
    args: ['--json', '-p', 'say it again'],
    extraEnv: { OX_REDACT: '0' },
  });
  const full = await fullRun.done;
  assert.equal(full.code, 0, full.stderr);
  const fullEvents = full.stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const histFull = fullEvents.find((ev) => ev.t === 'history');
  assert.ok(histFull, 'no history event in unredacted run');
  assert.ok(Array.isArray(histFull.messages), 'OX_REDACT=0 must emit full messages array');
  assert.ok(histFull.messages.some((m) => typeof m?.content === 'string' && m.content.includes(secret)));
});
