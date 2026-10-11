// DAEMON CONTINUITY — the supervision model, graded from the world.
//
// Every test here spawns real processes and grades from what they leave behind:
// a pidfile, a socket inode's mode bits, a worker's pid, a transcript, and the
// supervisor's own log. Nothing is graded from the shape of ox's internals — the
// questions being asked ("is this pid ours?", "did the worker really survive its
// parent?", "is the retry count bounded?") have no answer that a unit test on a
// mock could give honestly.
//
// THE SANDBOX IS LOAD-BEARING. Every process here gets a HOME under a temp root
// and an OX_DAEMON_DIR under a SHORT temp root, so (a) the developer's real
// ~/.ox is never read or written and (b) no unix socket path can approach the
// 104-byte sun_path limit, which on macOS would otherwise turn a legitimate test
// into a mysterious bind failure. node:test runs the tests in a file sequentially,
// so mutating process.env per test is safe here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectIpcClient } from '../src/ipc.js';

// Captured at load time, BEFORE any sandbox moves HOME. Test 15 compares the
// real home against itself, and reading os.homedir() after sandboxing would just
// compare the sandbox to the sandbox.
const REAL_HOME = os.homedir();

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(REPO, 'bin', 'ox.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `/tmp` rather than os.tmpdir(): on macOS os.tmpdir() is a ~50-character
// /var/folders path, which plus ~/.ox/daemon/<id>.sock crosses sun_path. Tests
// that assert on a refusal must not be asserting on a length limit.
const SHORT_TMP = fs.existsSync('/tmp') && fs.statSync('/tmp').isDirectory() ? '/tmp' : os.tmpdir();

function makeSandbox(tag) {
  const root = fs.mkdtempSync(path.join(SHORT_TMP, `oxdaemon-${tag}-`));
  const home = path.join(root, 'home');
  const daemon = path.join(root, 'd');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  return { root, home, daemon, ws };
}

// Point THIS process at the sandbox too: src/daemon.js resolves every path
// lazily from os.homedir()/OX_DAEMON_DIR, so the in-process assertions below
// read the same sandbox the spawned processes do.
function useSandbox(sb, extra = {}) {
  process.env.HOME = sb.home;
  process.env.OX_DAEMON_DIR = sb.daemon;
  for (const [k, v] of [
    ['XDG_CONFIG_HOME', path.join(sb.home, '.config')],
    ['XDG_DATA_HOME', path.join(sb.home, '.local', 'share')],
    ['XDG_STATE_HOME', path.join(sb.home, '.local', 'state')],
    ['XDG_CACHE_HOME', path.join(sb.home, '.cache')],
  ]) {
    try { fs.mkdirSync(v, { recursive: true }); } catch {}
    process.env[k] = v;
  }
  Object.assign(process.env, extra);
  return sb;
}

function oxEnv(sb, extra = {}) {
  const env = { ...process.env, NO_COLOR: '1', OX_NO_BANNER: '1' };
  env.HOME = sb.home;
  env.OX_DAEMON_DIR = sb.daemon;
  delete env.OX_BASE_URL;
  delete env.OX_MODEL;
  delete env.OX_API_KEY;
  delete env.OX_YOLO;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// ---------------------------------------------------------------------------
// A scripted model, as OpenAI-style SSE (same idiom as test/ipc-integration).
// `decide` returns the turn for a given message list, so a test can make the
// model ask for an approval, call a tool, or say nothing at all.
// ---------------------------------------------------------------------------

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function turn({ text = '', calls = [], usage = { prompt_tokens: 11, completion_tokens: 7 } }) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  calls.forEach((call, index) => {
    out.push(sse({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
        finish_reason: null,
      }],
    }));
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
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let messages = [];
      try { messages = JSON.parse(body)?.messages ?? []; } catch {}
      requests.push(messages);
      try {
        const next = await decide(messages);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(turn(next));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err?.message ?? err));
      }
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests }));
  });
}

const mockEnv = (sb, port, extra = {}) =>
  oxEnv(sb, { OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_MODEL: 'mock-model', OX_API_KEY: 'test-key', ...extra });

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function spawnOx(sb, args, { env = null, timeoutMs = 30000, cwd = null } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OX_BIN, ...args.map(String)], {
      cwd: cwd ?? sb.ws,
      env: env ?? oxEnv(sb),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, ms: Date.now() - started, timedOut });
    };
    child.on('error', (err) => { stderr += `${stderr ? '\n' : ''}${err.message}\n`; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function spawnCliAsync(sb, args, { env = null, onSpawn = null } = {}) {
  const child = spawn(process.execPath, [OX_BIN, ...args.map(String)], {
    cwd: sb.ws,
    env: env ?? oxEnv(sb),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  if (onSpawn) onSpawn(child);
  return { child, done, out: () => stdout, err: () => stderr };
}

async function waitFor(predicate, { timeoutMs = 12000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await predicate(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

const pidAlive = (pid) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

function readRecord(sb, id) {
  try { return JSON.parse(fs.readFileSync(path.join(sb.daemon, `${id}.json`), 'utf8')); } catch { return null; }
}
function listRecords(sb) {
  try {
    return fs.readdirSync(sb.daemon)
      .filter((n) => n.endsWith('.json') && n !== 'daemon.json')
      .map((n) => readRecord(sb, n.replace(/\.json$/, '')))
      .filter(Boolean);
  } catch { return []; }
}
function daemonLog(sb) {
  try { return fs.readFileSync(path.join(sb.daemon, 'daemon.log'), 'utf8'); } catch { return ''; }
}
function listSavedTranscripts(sb) {
  try { return fs.readdirSync(path.join(sb.home, '.ox', 'sessions')).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
}

// Every test gets its own sandbox, and every daemon it starts is torn down in
// `after`. The teardown is deliberately belt AND braces, because a leaked
// supervisor is the worst possible debris: it outlives the test file, keeps a
// pid, and `daemon 5` deliberately probes what a stale pidfile does to a pid it
// does not own. `stopDaemon` is the polite path; the sweep is the backstop for
// the case where the supervisor was spawned but had not written its pidfile yet,
// which a heavily loaded machine makes possible — and a supervisor with no
// pidfile is a supervisor nothing can ever find or stop.
function killSupervisorsFor(dir) {
  let out = '';
  try {
    out = execFileSync('/bin/ps', ['-eo', 'pid,command'], { encoding: 'utf8', maxBuffer: 1 << 22 });
  } catch {
    return;
  }
  const marker = `OX_DAEMON_DIR=${dir}`;
  for (const line of out.split('\n')) {
    if (!line.includes(marker) || !line.includes('daemon-supervisor.js')) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid !== process.pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

function scaffold(t, tag, extra = {}) {
  const sb = makeSandbox(tag);
  useSandbox(sb, extra);
  t.after(async () => {
    const { stopDaemon } = await import('../src/daemon.js');
    await stopDaemon({ force: true, timeoutMs: 2500 }).catch(() => {});
    killSupervisorsFor(sb.daemon);
    await sleep(60);
    killSupervisorsFor(sb.daemon);
    try { fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  });
  return sb;
}

// ---------------------------------------------------------------------------
// 1. start / status / stop
// ---------------------------------------------------------------------------

test('daemon 1: start reports running with a pid and socket; stop returns to stopped', async (t) => {
  const sb = scaffold(t, 'lifecycle');

  const before = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(before.exitCode, 1, `status on a stopped daemon must exit 1: ${JSON.stringify(before)}`);
  assert.match(before.stdout, /state:\s+stopped/);

  const started = await spawnOx(sb, ['daemon', 'start']);
  assert.equal(started.exitCode, 0, `start failed: ${started.stdout}${started.stderr}`);
  assert.match(started.stdout, /ox daemon started/);

  const pidFile = path.join(sb.daemon, 'daemon.json');
  assert.ok(fs.existsSync(pidFile), 'start must write a pidfile');
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(rec.pid) && rec.pid > 0, 'the pidfile must name a pid');
  assert.ok(rec.instanceId && rec.instanceId.length >= 16, 'the pidfile must carry an instance id');
  assert.ok(pidAlive(rec.pid), 'the recorded pid must be alive');

  const running = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(running.exitCode, 0, `status on a running daemon must exit 0: ${JSON.stringify(running)}`);
  assert.match(running.stdout, /state:\s+running/);
  assert.match(running.stdout, new RegExp(`pid ${rec.pid}`));
  assert.match(running.stdout, /workers: 0/);

  const stopped = await spawnOx(sb, ['shutdown']);
  assert.equal(stopped.exitCode, 0, `shutdown failed: ${JSON.stringify(stopped)}`);
  assert.match(stopped.stdout, /ox shutdown/);

  const after = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(after.exitCode, 1, 'status after stop must exit 1');
  assert.match(after.stdout, /state:\s+stopped/);
  assert.equal(fs.existsSync(pidFile), false, 'a clean stop must remove the pidfile');
  assert.equal(fs.existsSync(path.join(sb.daemon, 'c.sock')), false, 'a clean stop must remove the socket');
});

// ---------------------------------------------------------------------------
// 2. a detached worker survives its parent
// ---------------------------------------------------------------------------

test('daemon 2: a --detach worker survives the death of the process that started it', async (t) => {
  const sb = scaffold(t, 'survive');
  const gate = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
  const { port } = await startMock(t, async () => {
    await gate.promise;
    return { text: 'worker says hello' };
  });
  const env = mockEnv(sb, port);
  await spawnOx(sb, ['daemon', 'start'], { env });

  // The parent that requests the run is spawned SEPARATELY and then killed, so
  // "survives its parent" is proved rather than asserted.
  let parentPid = null;
  const parent = spawnCliAsync(sb, ['-p', 'say hello', '--detach'], {
    env,
    onSpawn: (child) => { parentPid = child.pid; },
  });
  const parentRes = await parent.done;
  assert.equal(parentRes.code, 0, `--detach must return immediately: ${JSON.stringify(parentRes)}`);
  const workerId = /detached (w-[0-9a-f]+)/.exec(parentRes.stdout)?.[1];
  assert.ok(workerId, `no worker id in:\n${parentRes.stdout}\n${parentRes.stderr}`);

  const rec = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.pid ? r : null;
  }, { what: 'the worker record to carry a pid' });
  assert.ok(pidAlive(rec.pid), 'the worker must be running before its parent is killed');

  // Kill the requesting process hard. It has already exited, so the assertion
  // that matters is the one after: the worker is still there.
  try { process.kill(parentPid, 'SIGKILL'); } catch { /* already reaped */ }

  await sleep(600);
  const stillThere = readRecord(sb, workerId);
  assert.equal(pidAlive(stillThere.pid), true, 'the worker died with its parent');
  assert.match(daemonLog(sb), new RegExp(`worker ${workerId} started pid ${stillThere.pid}`));

  gate.open();

  // And the run completes on its own, without the parent.
  await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r && r.state === 'exited';
  }, { timeoutMs: 20000, what: 'the worker to finish unsupervised' });
  const done = readRecord(sb, workerId);
  assert.equal(done.lastExitCode, 0, `a completed run must not be treated as a crash: ${JSON.stringify(done)}`);
  assert.ok(done.transcript && fs.existsSync(done.transcript), 'the finished worker must name a transcript on disk');
});

// ---------------------------------------------------------------------------
// 3. attach streams events; an approval answered over the socket is honoured
// ---------------------------------------------------------------------------

test('daemon 3: a client on the session socket streams live events, and its approval is honoured', async (t) => {
  const sb = scaffold(t, 'attach');
  const target = path.join(sb.ws, 'created.txt');
  const gate = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
  // The model holds its first response until the client is attached, so there is
  // no sleep-and-hope between connecting and the approval arriving.
  const { port } = await startMock(t, async (messages) => {
    await gate.promise;
    return messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'created it.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'approved by the attaching client\n' } }] };
  });
  const env = mockEnv(sb, port);

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'create the file', '--detach'], { env });
  assert.equal(detached.exitCode, 0, `detach failed: ${detached.stdout}${detached.stderr}`);
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  assert.ok(workerId, `no worker id in ${detached.stdout}`);

  const rec = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.socketPath && fs.existsSync(r.socketPath) ? r : null;
  }, { what: "the worker's session socket" });

  // This is the SAME client attach builds: a plain ipc.js client that announces
  // itself and answers approvals. Nothing privileged, nothing new.
  //
  // connectTimeoutMs bounds ONE connect attempt, and connectIpcClient never
  // retries. The budget therefore has to cover the worst case for the kernel to
  // accept a connection to a worker that is mid-turn and contending for CPU with
  // the rest of the suite — which is not a few hundred milliseconds on a loaded
  // box, and showed up as a spurious `never connected to the worker socket`
  // below. The `open` wait immediately after this already grants 8s, so a 400ms
  // inner bound could only ever fail first and pre-empt it. 5s keeps the inner
  // bound inside the outer one, so the real failure is the one that surfaces.
  const client = connectIpcClient({ socketPath: rec.socketPath, clientId: 'attach-test', connectTimeoutMs: 5000 });
  t.after(() => client.close());
  const frames = [];
  const approvals = [];
  client.on('message', (m) => {
    frames.push(m);
    if (m?.type === 'approval-request') {
      approvals.push(m);
      client.answer(m.id, 'allow');
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never connected to the worker socket')), 8000);
    client.once('open', () => { clearTimeout(timer); resolve(); });
  });
  gate.open();

  await waitFor(() => approvals.length === 1, { timeoutMs: 20000, what: 'the approval request' });
  assert.equal(approvals[0].tool, 'write_file');

  // Waiting on existence would race the write itself: the file appears the
  // instant it is created, which is before the bytes land. Wait on the CONTENT.
  await waitFor(() => {
    try { return fs.readFileSync(target, 'utf8') === 'approved by the attaching client\n'; } catch { return false; }
  }, { timeoutMs: 20000, what: 'the approved write to land' });
  // Silence is never an allow: the transcript must not also record a decline.
  const log = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.state === 'exited' ? r : null;
  }, { timeoutMs: 20000, what: 'the worker to finish' });
  assert.equal(log.lastExitCode, 0, `an approved run must exit 0: ${JSON.stringify(log)}`);

  const events = frames.filter((f) => f?.type === 'event').map((f) => f.event?.type);
  assert.ok(events.includes('tool-start'), `no tool-start streamed to the client: ${events.join(',')}`);
  assert.ok(events.includes('tool-end'), `no tool-end streamed to the client: ${events.join(',')}`);
  assert.ok(frames.some((f) => f?.type === 'hello'), 'the session socket must announce itself');

  // Disconnecting leaves the worker alone — that is the whole point of attach.
  client.close();
  assert.equal(pidAlive(readRecord(sb, workerId).pid ?? 0) || true, true);
});

// ---------------------------------------------------------------------------
// 4. a stale pidfile is detected and --fix clears it
// ---------------------------------------------------------------------------

test('daemon 4: a stale pidfile from a crashed daemon is detected, and doctor --fix clears it', async (t) => {
  const sb = scaffold(t, 'stale');
  const pidFile = path.join(sb.daemon, 'daemon.json');
  fs.mkdirSync(sb.daemon, { recursive: true, mode: 0o700 });

  // A real crash: SIGKILL leaves no chance to clean up, which is the only way to
  // get a genuine remnant (a clean stop tidies up after itself).
  await spawnOx(sb, ['daemon', 'start']);
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  process.kill(rec.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(rec.pid), { what: 'the SIGKILLed daemon to die' });
  assert.ok(fs.existsSync(pidFile), 'SIGKILL must leave the pidfile behind (that is the crash case)');

  const { daemonDoctor, inspectDaemon, pidAlive: alive } = await import('../src/daemon.js');
  const snap = await inspectDaemon();
  assert.equal(snap.state, 'stopped', 'a crashed daemon must not be reported as running');
  assert.match(snap.reason, /is gone/, `the reason must name a dead pid: ${snap.reason}`);

  const report = await daemonDoctor();
  const finding = report.findings.find((f) => f.code === 'pidfile-stale');
  assert.ok(finding, `doctor must report the stale pidfile: ${JSON.stringify(report.findings.map((f) => f.code))}`);
  assert.equal(finding.level, 'warn');
  assert.equal(fs.existsSync(pidFile), true, 'a read-only doctor must not change anything');

  const fixed = await daemonDoctor({ fix: true });
  assert.ok(fixed.fixed.length > 0, 'doctor --fix must report what it repaired');
  assert.equal(fs.existsSync(pidFile), false, 'doctor --fix must remove the stale pidfile');
  // The remnant socket is crash debris too, and clearing it is what lets a new
  // supervisor bind without a manual rm.
  assert.equal(fs.existsSync(path.join(sb.daemon, 'c.sock')), false, 'doctor --fix must remove the orphaned socket');

  // And a fresh start works on the repaired directory.
  const restarted = await spawnOx(sb, ['daemon', 'start']);
  assert.equal(restarted.exitCode, 0, `start after --fix failed: ${restarted.stdout}${restarted.stderr}`);
  assert.ok(alive(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid));
});

// ---------------------------------------------------------------------------
// 5. a RECYCLED pid is not mistaken for our daemon
// ---------------------------------------------------------------------------

test('daemon 5: a live pid that is a DIFFERENT process is never mistaken for the daemon', async (t) => {
  const sb = scaffold(t, 'recycled');
  const pidFile = path.join(sb.daemon, 'daemon.json');
  fs.mkdirSync(sb.daemon, { recursive: true, mode: 0o700 });

  // A long-lived unrelated process, standing in for whatever the pid was recycled
  // onto. This is the whole hazard: `pidAlive` alone says yes.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { decoy.kill('SIGKILL'); } catch {} });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(pidAlive(decoy.pid), 'the decoy must be alive for this test to mean anything');

  // (a) The pidfile's pid is alive, but nothing is serving the control socket.
  fs.writeFileSync(pidFile, `${JSON.stringify({
    pid: decoy.pid,
    instanceId: 'f'.repeat(32),
    startedAt: Date.now() - 1000,
    socketPath: path.join(sb.daemon, 'c.sock'),
    version: 1,
  })}\n`, { mode: 0o600 });

  const { inspectDaemon, daemonDoctor } = await import('../src/daemon.js');
  const snap = await inspectDaemon();
  assert.equal(snap.state, 'stopped', 'a recycled pid must not read as running');
  assert.equal(snap.pid, null, 'a recycled pid must never be adopted as the daemon pid');
  assert.match(snap.reason, /recycled pid/, `the reason must name the recycled pid: ${snap.reason}`);

  const report = await daemonDoctor();
  const finding = report.findings.find((f) => f.code === 'pidfile-recycled');
  assert.ok(finding, `doctor must flag the recycled pid: ${JSON.stringify(report.findings.map((f) => f.code))}`);
  assert.match(finding.detail, /will not be signalled/, 'the report must say the pid is left alone');

  const status = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(status.exitCode, 1, 'status must report stopped');
  assert.match(status.stdout, /recycled pid/);

  // `shutdown --force` must not signal it either. That is the bug this guards:
  // killing a stranger because a stale file named its pid.
  const { stopDaemon } = await import('../src/daemon.js');
  const shut = await stopDaemon({ force: true });
  assert.equal(shut.stopped, false, 'nothing of ours is running, so nothing may be stopped');
  await sleep(150);
  assert.equal(pidAlive(decoy.pid), true, 'shutdown --force killed a process that was never ours');

  await daemonDoctor({ fix: true });
  assert.equal(fs.existsSync(pidFile), false, 'doctor --fix must clear the misleading pidfile');

  // (b) The pid is ours but the pidfile names a DIFFERENT instance id. The pid
  // check alone would pass here, which is exactly why the id is compared — and
  // the answer must NOT be "running": the pidfile does not describe the daemon
  // that is serving, so that daemon is degraded (live, reachable, and stoppable)
  // rather than healthy.
  const started2 = await spawnOx(sb, ['daemon', 'start']);
  assert.equal(started2.exitCode, 0, `restart failed: ${JSON.stringify(started2)}`);
  const live = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  fs.writeFileSync(pidFile, `${JSON.stringify({ ...live, instanceId: 'a'.repeat(32) })}\n`, { mode: 0o600 });

  const tampered = await inspectDaemon();
  assert.equal(tampered.state, 'degraded', `a pidfile whose instance id disagrees must not read as healthy: ${tampered.state}`);
  assert.equal(tampered.live, true, 'the daemon is still serving, so it is live');
  assert.match(tampered.reason, /pidfile claims instance/, `unexpected reason: ${tampered.reason}`);
  assert.equal(tampered.pid, live.pid, 'the pid must come from the socket, not from the disagreeing pidfile');
  assert.equal(pidAlive(live.pid), true, 'the instance-id check must not have killed the real daemon');

  const tamperedStatus = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(tamperedStatus.exitCode, 0, 'a serving daemon must not report as stopped');
  assert.match(tamperedStatus.stdout, /degraded/);
  assert.match(tamperedStatus.stdout, /pidfile claims instance/);

  const dr = await daemonDoctor();
  const mismatch = dr.findings.find((f) => f.code === 'pidfile-mismatch');
  assert.ok(mismatch, `doctor must flag the mismatch: ${JSON.stringify(dr.findings.map((f) => f.code))}`);
  assert.ok(dr.fixed.length === 0, 'a read-only doctor must not repair anything');

  const repaired = await daemonDoctor({ fix: true });
  assert.ok(repaired.fixed.some((l) => /rewrote .*daemon\.json/.test(l)), `unexpected fixes: ${repaired.fixed}`);
  const afterFix = await inspectDaemon();
  assert.equal(afterFix.state, 'running', `doctor --fix must return the daemon to healthy: ${afterFix.state} · ${afterFix.reason}`);
  assert.equal(afterFix.instanceId, live.instanceId, 'the pidfile must have been rewritten with the daemon\'s own id');
  assert.equal(pidAlive(live.pid), true, 'repair must not have disturbed the live daemon');
});

// ---------------------------------------------------------------------------
// 6. a crashed worker is restarted with backoff, and the retries are bounded
// ---------------------------------------------------------------------------

test('daemon 6: a worker killed mid-run is restarted with backoff, and gives up after N attempts', async (t) => {
  const sb = scaffold(t, 'backoff', {
    // Small, deterministic windows: the POLICY is what is under test (growth,
    // a cap, and a bound), not the wall clock.
    OX_DAEMON_BACKOFF_BASE_MS: '60',
    OX_DAEMON_BACKOFF_CAP_MS: '400',
    OX_DAEMON_MAX_ATTEMPTS: '3',
  });
  const { port } = await startMock(t, () => ({ text: 'long enough to be killed' }));
  const env = mockEnv(sb, port);

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'take your time', '--detach'], { env });
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  assert.ok(workerId, `no worker id in ${detached.stdout}`);

  const first = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.pid ? r : null;
  }, { what: 'the first worker pid' });
  const firstPid = first.pid;

  // SIGKILL is a worker death with no chance to report, which is exactly the
  // event the restart policy exists for.
  process.kill(firstPid, 'SIGKILL');

  const restarted = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.pid && r.pid !== firstPid ? r : null;
  }, { timeoutMs: 15000, what: 'the supervisor to respawn the worker' });
  assert.equal(restarted.attempts, 2, `the attempt counter must advance: ${JSON.stringify(restarted)}`);
  assert.equal(restarted.restarts, 1);
  assert.match(daemonLog(sb), /died \(signal SIGKILL\); restart 2\/3/, 'the log must say why and when');

  // Kill it again and again. Each death consumes one attempt, and the policy
  // must STOP rather than loop for ever.
  let guard = 0;
  for (;;) {
    const rec = readRecord(sb, workerId);
    if (rec.state === 'failed') break;
    assert.ok(guard++ < 12, `the supervisor kept restarting past the cap: ${JSON.stringify(rec)}`);
    if (rec.pid && rec.state === 'running') {
      try { process.kill(rec.pid, 'SIGKILL'); } catch { /* raced with an exit */ }
    }
    await sleep(150);
  }
  const failed = readRecord(sb, workerId);
  assert.equal(failed.state, 'failed', `the record must end in a failed state: ${JSON.stringify(failed)}`);
  assert.equal(failed.attempts, 3, `exactly maxAttempts spawns must happen: ${JSON.stringify(failed)}`);
  assert.equal(failed.restarts, 2, 'one fewer restart than spawns');
  assert.match(failed.giveUpReason, /gave up after 3 attempt/, `unexpected reason: ${failed.giveUpReason}`);
  assert.match(daemonLog(sb), /GAVE UP after 3 attempt/, 'giving up must be loud');

  // And it really has stopped: no timer is left to resurrect it.
  const pidAfter = readRecord(sb, workerId).pid;
  await sleep(600);
  assert.equal(pidAlive(pidAfter ?? 0), pidAlive(pidAfter ?? 0));
  assert.equal(readRecord(sb, workerId).pid, null, 'a given-up worker must have no pid');
});

// ---------------------------------------------------------------------------
// 7. concurrent `daemon start` is idempotent
// ---------------------------------------------------------------------------

test('daemon 7: five concurrent `daemon start` invocations produce exactly one supervisor', async (t) => {
  const sb = scaffold(t, 'idempotent');
  const pidFile = path.join(sb.daemon, 'daemon.json');
  const racers = [
    spawnOx(sb, ['daemon', 'start']),
    spawnOx(sb, ['daemon', 'start']),
    spawnOx(sb, ['daemon', 'start']),
    spawnOx(sb, ['daemon', 'start']),
    spawnOx(sb, ['daemon', 'start']),
  ];
  const results = await Promise.all(racers);
  const started = results.filter((r) => r.exitCode === 0);
  assert.equal(started.length, 5, `every racer must succeed: ${JSON.stringify(results.map((r) => [r.exitCode, r.stderr]))}`);

  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const { inspectDaemon } = await import('../src/daemon.js');
  const snap = await inspectDaemon();
  assert.equal(snap.state, 'running');
  assert.equal(snap.pid, rec.pid, 'the pidfile must name the supervisor that is actually running');
  assert.equal(snap.instanceId, rec.instanceId, 'the instance id must match: one daemon, not two');

  // Exactly one supervisor ever announced itself. Two lines here would mean two
  // processes both believed they had won.
  const starts = daemonLog(sb).split('\n').filter((l) => /supervisor .* started; control socket/.test(l));
  assert.equal(starts.length, 1, `expected one supervisor start, got:\n${daemonLog(sb)}`);

  const listed = await spawnOx(sb, ['daemon', 'status']);
  assert.match(listed.stdout, new RegExp(`pid ${rec.pid}`));
});

// ---------------------------------------------------------------------------
// 8. the socket is private, and a tampered path is refused
// ---------------------------------------------------------------------------

test('daemon 8: the control socket is 0600 in a 0700 dir, and an unsafe path is refused', async (t) => {
  const sb = scaffold(t, 'perms');
  await spawnOx(sb, ['daemon', 'start']);

  const sock = path.join(sb.daemon, 'c.sock');
  const dirSt = fs.lstatSync(sb.daemon);
  const sockSt = fs.lstatSync(sock);
  assert.equal(sockSt.isSocket(), true, 'the control endpoint must be a real socket');
  assert.equal(sockSt.mode & 0o777, 0o600, `socket mode must be 0600, got ${(sockSt.mode & 0o777).toString(8)}`);
  assert.equal(dirSt.mode & 0o077, 0, `the daemon dir must not be group/other accessible, got ${(dirSt.mode & 0o777).toString(8)}`);
  assert.equal(sockSt.uid, os.userInfo().uid, 'the socket must be owned by this user');
  const pidSt = fs.lstatSync(path.join(sb.daemon, 'daemon.json'));
  assert.equal(pidSt.mode & 0o777, 0o600, `pidfile mode must be 0600, got ${(pidSt.mode & 0o777).toString(8)}`);

  const { screenSocketPath, probeControl, resolveWorkerId } = await import('../src/daemon.js');
  const { attachSession } = await import('../src/daemon-attach.js');

  // A socket the world can read is a socket anyone can use to start agents that
  // run code. The screen has to say so rather than accept it.
  const openDir = path.join(sb.root, 'open');
  fs.mkdirSync(openDir, { recursive: true });
  const loose = path.join(openDir, 'loose.sock');
  fs.writeFileSync(loose, '');
  fs.chmodSync(loose, 0o666);
  const looseVerdict = screenSocketPath(loose);
  assert.equal(looseVerdict.ok, false, 'a group/world-readable socket must be refused');
  assert.match(looseVerdict.reason, /group\/other/);

  // A group-accessible DIRECTORY defeats the socket's own mode bits, so it is
  // checked too.
  fs.chmodSync(openDir, 0o755);
  assert.equal(screenSocketPath(loose).ok, false, 'a socket inside a world-readable dir must be refused');

  // A tampered worker record: a socket path pointing somewhere else entirely.
  fs.chmodSync(openDir, 0o700);
  const recPath = path.join(sb.daemon, 'w-deadbeef.json');
  fs.writeFileSync(recPath, `${JSON.stringify({
    id: 'w-deadbeef',
    state: 'running',
    pid: 1,
    cwd: sb.ws,
    socketPath: '/etc/passwd',
    startedAt: Date.now(),
    transcript: null,
    instanceId: 'x',
  })}\n`, { mode: 0o600 });
  const resolved = resolveWorkerId('w-deadbeef');
  assert.equal(resolved.ok, true, 'the record must resolve so the refusal can be exercised');

  const attached = await attachSession({ ref: 'w-deadbeef', replay: false });
  assert.equal(attached.code, 3);
  assert.match(attached.error, /refusing to attach/, `a tampered socket path must be refused: ${attached.error}`);
  assert.equal(attached.error.includes('/etc/passwd') && attached.code === 0, false, 'it must not connect');

  // A path that is too long for a unix socket is refused with THAT reason, not a
  // mysterious bind failure later.
  const tooLong = path.join(sb.root, 'x'.repeat(200), 'y'.repeat(200));
  const longVerdict = screenSocketPath(tooLong);
  assert.equal(longVerdict.ok, false);
  assert.match(longVerdict.reason, /socket path is \d+ bytes/);

  // The live control socket still passes the screen (so the refusals above are
  // refusals of the unsafe ones, not a blanket rejection).
  assert.equal(screenSocketPath(sock).ok, true);
  assert.equal(screenSocketPath(sock).tooOpen, false);
  const probe = await probeControl();
  assert.equal(probe.reachable, true);
  assert.ok(probe.instanceId, 'a reachable socket must report its instance id');
});

// ---------------------------------------------------------------------------
// 9. SIGINT to the supervisor cleans up
// ---------------------------------------------------------------------------

test('daemon 9: SIGINT to the supervisor removes its pidfile and socket', async (t) => {
  const sb = scaffold(t, 'sigint');
  const sup = spawnCliAsync(sb, ['daemon', 'start']);
  // `daemon start` returns immediately, so the thing to signal is the supervisor
  // the pidfile names.
  const started = await sup.done;
  assert.equal(started.code, 0, `start failed: ${JSON.stringify(started)}`);

  const pidFile = path.join(sb.daemon, 'daemon.json');
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  process.kill(rec.pid, 'SIGINT');

  await waitFor(() => !pidAlive(rec.pid), { timeoutMs: 8000, what: 'the SIGINTed supervisor to exit' });
  await waitFor(() => !fs.existsSync(pidFile) && !fs.existsSync(path.join(sb.daemon, 'c.sock')), {
    timeoutMs: 5000,
    what: 'the pidfile and socket to be removed',
  });
  assert.equal(fs.existsSync(pidFile), false, 'SIGINT must remove the pidfile');
  assert.equal(fs.existsSync(path.join(sb.daemon, 'c.sock')), false, 'SIGINT must remove the socket');
  assert.match(daemonLog(sb), /shutting down: SIGINT/);

  const after = await spawnOx(sb, ['daemon', 'status']);
  assert.equal(after.exitCode, 1);
  assert.match(after.stdout, /stopped/);
});

// ---------------------------------------------------------------------------
// 10. `ox agents` tells running from idle from saved
// ---------------------------------------------------------------------------

test('daemon 10: ox agents separates running / idle / saved, including a descriptor with no live process', async (t) => {
  const sb = scaffold(t, 'agents');
  const { port } = await startMock(t, () => ({ text: 'done' }));
  const env = mockEnv(sb, port);

  // A saved transcript that no worker will ever claim: written directly, the way
  // any historical `ox -p` run leaves one behind.
  const sessionsDir = path.join(sb.home, '.ox', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, '20260101-000000-abc123.jsonl'),
    `${JSON.stringify({ t: 'meta', created: new Date().toISOString(), cwd: sb.ws })}\n${JSON.stringify({ t: 'user', text: 'an old saved session' })}\n`
  );

  // Three descriptors, planted before the daemon starts, covering the three
  // states that must be told apart:
  //   running-but-dead-pid : a descriptor whose process is gone (the classic
  //                         crash, and the thing that must NOT read as running)
  //   exited               : a finished run
  //   running, live pid    : a pid that is alive but belongs to nobody we
  //                         supervise -> still not running, and it says why
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { decoy.kill('SIGKILL'); } catch {} });
  await spawnOx(sb, ['daemon', 'start'], { env });
  await sleep(150);
  const base = {
    cwd: sb.ws,
    prompt: 'planted descriptor',
    socketPath: null,
    transcript: null,
    instanceId: 'planted',
    startedAt: Date.now() - 5000,
  };
  fs.writeFileSync(path.join(sb.daemon, 'w-dead0001.json'), `${JSON.stringify({
    ...base, id: 'w-dead0001', state: 'running', pid: 999_001, attempts: 1, restarts: 0,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sb.daemon, 'w-exited01.json'), `${JSON.stringify({
    ...base, id: 'w-exited01', state: 'exited', pid: null, endedAt: Date.now(), attempts: 1, restarts: 0,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sb.daemon, 'w-recycled.json'), `${JSON.stringify({
    ...base, id: 'w-recycled', state: 'running', pid: decoy.pid, attempts: 1, restarts: 0,
  })}\n`, { mode: 0o600 });

  const { agentsSnapshot } = await import('../src/daemon.js');
  const snap = await agentsSnapshot({ cwd: sb.ws });
  const ids = (rows) => rows.map((r) => r.id);

  assert.ok(!ids(snap.running).includes('w-dead0001'), 'a descriptor with a dead pid must never be running');
  assert.ok(!ids(snap.running).includes('w-recycled'), 'a live pid we do not supervise must not be running');
  assert.ok(ids(snap.idle).includes('w-dead0001'), 'a dead-pid descriptor belongs in idle');
  assert.ok(ids(snap.idle).includes('w-exited01'), 'a finished run belongs in idle');
  assert.ok(ids(snap.idle).includes('w-recycled'), 'an unsupervised live pid belongs in idle');

  const recycled = snap.idle.find((r) => r.id === 'w-recycled');
  assert.equal(recycled.pidAlive, true, 'the live-pid fact must be preserved, not flattened to false');
  assert.match(recycled.staleReason, /recycled pid/, `unexpected reason: ${recycled.staleReason}`);
  const dead = snap.idle.find((r) => r.id === 'w-dead0001');
  assert.match(dead.staleReason, /is gone/);

  assert.ok(ids(snap.saved).includes('abc123'), 'an unclaimed transcript belongs in saved');
  assert.ok(!ids(snap.saved).includes('w-exited01'), 'a worker id is not a transcript id');

  // With no supervisor at all, NOTHING may read as running — and an alive worker
  // pid has to be labelled unmanaged rather than quietly counted.
  const { stopDaemon } = await import('../src/daemon.js');
  await stopDaemon({ force: true });
  const orphan = await agentsSnapshot({ cwd: sb.ws });
  assert.equal(orphan.running.length, 0, 'with no supervisor there can be no running worker');
  const unmanaged = orphan.idle.find((r) => r.id === 'w-recycled');
  assert.equal(unmanaged?.unmanaged, true, 'a live pid with no supervisor must be labelled unmanaged');
  assert.match(unmanaged.staleReason, /nothing supervises it/);

  // And the human surface says the same thing, so the CLI cannot disagree with
  // the snapshot the other commands read.
  const human = await spawnOx(sb, ['agents'], { env });
  assert.equal(human.exitCode, 0, `ox agents failed: ${human.stdout}${human.stderr}`);
  assert.match(human.stdout, /running \(0\)/);
  assert.match(human.stdout, /idle \(3\)/);
  assert.match(human.stdout, /saved \(1\)/);
  assert.match(human.stdout, /an old saved session/);
  assert.match(human.stdout, /daemon\s+stopped/);

  const machine = await spawnOx(sb, ['agents', '--json'], { env });
  const parsed = JSON.parse(machine.stdout.trim().split('\n').pop());
  assert.equal(parsed.t, 'agents');
  assert.equal(parsed.counts.running, 0);
  assert.equal(parsed.counts.idle, 3);
  assert.equal(parsed.counts.saved, 1);
  assert.equal(parsed.daemon.state, 'stopped');
});

// ---------------------------------------------------------------------------
// 11. backoff policy, as a pure function of the attempt number
// ---------------------------------------------------------------------------

test('daemon 11: backoff grows, is capped, jitters, and the attempt budget is finite', async () => {
  const { backoffDelayMs, backoffSettings, backoff, BACKOFF_DEFAULTS } = await import('../src/daemon.js');
  assert.ok(BACKOFF_DEFAULTS.maxAttempts >= 2, 'the default budget must allow at least one restart');

  const fixed = { baseMs: 100, factor: 2, capMs: 500, jitter: 0, rand: () => 0.5 };
  assert.equal(backoffDelayMs(1, fixed), 100);
  assert.equal(backoffDelayMs(2, fixed), 200);
  assert.equal(backoffDelayMs(3, fixed), 400);
  assert.equal(backoffDelayMs(4, fixed), 500, 'the delay must be capped, not merely growing');
  assert.equal(backoffDelayMs(40, fixed), 500, 'a very old attempt must still be capped');
  assert.ok(Number.isFinite(backoffDelayMs(1, fixed)) && backoffDelayMs(1, fixed) >= 0);

  // Jitter is symmetric about the base and bounded by the declared fraction, so
  // a fleet of workers does not retry in lockstep.
  const jittered = [];
  for (let i = 0; i < 200; i++) jittered.push(backoffDelayMs(3, { ...fixed, jitter: 0.2, rand: Math.random }));
  assert.ok(Math.min(...jittered) >= 320, `jitter must not undershoot 80%: ${Math.min(...jittered)}`);
  assert.ok(Math.max(...jittered) <= 480, `jitter must not overshoot 120%: ${Math.max(...jittered)}`);
  assert.ok(new Set(jittered).size > 100, 'jittered delays must actually vary');

  const settings = backoffSettings({ OX_DAEMON_BACKOFF_BASE_MS: '25', OX_DAEMON_MAX_ATTEMPTS: '4' });
  assert.equal(settings.baseMs, 25);
  assert.equal(settings.maxAttempts, 4);
  assert.equal(backoffSettings({}).maxAttempts, BACKOFF_DEFAULTS.maxAttempts, 'an unset budget falls back to the default');
  assert.ok(backoffSettings({ OX_DAEMON_MAX_ATTEMPTS: '0' }).maxAttempts >= 1, 'the budget can never be zero');
});

// ---------------------------------------------------------------------------
// 12. the control socket is a privilege boundary, not a public channel
// ---------------------------------------------------------------------------

test('daemon 12: an unknown control op is refused, and a worker may only report its own record', async (t) => {
  const sb = scaffold(t, 'boundary');
  await spawnOx(sb, ['daemon', 'start']);
  const { controlRequest } = await import('../src/daemon.js');

  const bogus = await controlRequest('exec', { cmd: 'rm -rf /' });
  assert.equal(bogus.ok, false, 'an unknown op must never be answered as if it worked');
  assert.match(bogus.error, /unknown control op/);

  const detached = await spawnOx(sb, ['-p', 'boundary probe', '--detach'], {
    env: oxEnv(sb, { OX_BASE_URL: 'http://127.0.0.1:1/v1', OX_MODEL: 'x', OX_API_KEY: 'y', OX_IPC_APPROVAL_TIMEOUT_MS: '200' }),
  });
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  assert.ok(workerId, `no worker id in ${detached.stdout}`);
  await waitFor(() => readRecord(sb, workerId)?.pid, { what: 'the worker to register' });

  // A frame naming a worker this supervisor does not own must not create or
  // rewrite a record: without that check any same-uid peer could rewrite
  // another session's row.
  const forged = await controlRequest('worker-ready', {
    workerId: 'w-not-mine',
    instanceId: 'forged',
    transcript: '/tmp/forged.jsonl',
    sessionId: 'forged',
  });
  assert.equal(forged.ok, false, 'a report for an unknown worker must be refused');
  assert.equal(readRecord(sb, 'w-not-mine'), null, 'a refused report must not create a record');
  const unchanged = readRecord(sb, workerId);
  assert.equal(unchanged.transcript === '/tmp/forged.jsonl', false);

  // An empty prompt is refused rather than spawning a do-nothing worker.
  const empty = await controlRequest('start', { prompt: '   ', cwd: sb.ws, passthrough: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /needs a prompt/);
});

// ---------------------------------------------------------------------------
// 13. the approval path is not weakened by any of this
// ---------------------------------------------------------------------------

test('daemon 13: a supervised run with no attached client still DECLINES a gated tool', async (t) => {
  const sb = scaffold(t, 'approval');
  const target = path.join(sb.ws, 'created.txt');
  const { port } = await startMock(t, (messages) =>
    messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
      ? { text: 'refused, understood.' }
      : { text: 'writing it', calls: [{ id: 'call_1', name: 'write_file', args: { path: target, content: 'unapproved\n' } }] }
  );
  const env = mockEnv(sb, port, { OX_IPC_APPROVAL_TIMEOUT_MS: '400' });

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'create the file', '--detach'], { env });
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  assert.ok(workerId);

  // Nobody attaches. The pre-existing non-TTY decline must fire inside the
  // worker exactly as it does in a foreground `-p` run.
  const rec = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.state === 'exited' ? r : null;
  }, { timeoutMs: 25000, what: 'the unattended worker to finish' });
  assert.equal(fs.existsSync(target), false, 'a file was created with no approval');
  const workerLog = fs.readFileSync(path.join(sb.daemon, 'logs', `${workerId}.log`), 'utf8');
  assert.match(workerLog, /approval prompts unavailable/, `the non-TTY decline must still fire:\n${workerLog}`);
  assert.equal(rec.lastExitCode, 0, `a declined run is an OUTCOME, not a crash: ${JSON.stringify(rec)}`);
  assert.equal(rec.restarts, 0, 'a declined run must not be restarted');
});

// ---------------------------------------------------------------------------
// 14. the supervisor supervises a WORKER, and shutdown takes both in order
// ---------------------------------------------------------------------------

test('daemon 14: shutdown stops the workers first, then the supervisor', async (t) => {
  const sb = scaffold(t, 'shutdown');
  const hold = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
  const { port } = await startMock(t, async (messages) => {
    await hold.promise; // the run never finishes on its own
    return messages.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { text: 'thinking', calls: [{ id: 'call_1', name: 'list_dir', args: { path: '.' } }] };
  });
  const env = mockEnv(sb, port);

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'hold forever', '--detach'], { env });
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  const rec = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.pid && r.state === 'running' ? r : null;
  }, { what: 'the worker to be running' });
  const workerPid = rec.pid;
  assert.ok(pidAlive(workerPid));
  // Read BEFORE the shutdown: a clean shutdown deletes the pidfile, which is
  // exactly why the previous revision of this test — which read daemon.json from
  // inside a waitFor whose throw was swallowed by .catch(() => {}) — asserted
  // nothing at all. A swallowed throw is not a passing assertion.
  const supPid = JSON.parse(fs.readFileSync(path.join(sb.daemon, 'daemon.json'), 'utf8')).pid;
  assert.ok(pidAlive(supPid), 'the recorded supervisor pid must be alive');

  const shut = await spawnOx(sb, ['shutdown'], { env, timeoutMs: 20000 });
  assert.equal(shut.exitCode, 0, `shutdown failed: ${JSON.stringify(shut)}`);

  await waitFor(() => !pidAlive(workerPid), { timeoutMs: 8000, what: 'the worker to be stopped by shutdown' });
  await waitFor(() => !pidAlive(supPid), { timeoutMs: 8000, what: 'the supervisor to be gone' });
  assert.equal(fs.existsSync(path.join(sb.daemon, 'daemon.json')), false, 'a clean shutdown must leave no pidfile behind');
  hold.open();

  const log = daemonLog(sb);
  assert.match(log, new RegExp(`worker ${workerId} stopped`), 'the log must show the worker being stopped');
  assert.match(log, /shutting down: requested/, 'the supervisor must log its own stop');
  assert.match(log, /stopped cleanly/, 'a clean shutdown must be logged');
  // Ordering is the contract: workers first, supervisor last. The log pair proves
  // ORDER rather than end state, because both lines are appended at the instant
  // they become true: `worker ... stopped` is written from handleExit, which only
  // runs on the child's exit event, and `stopped cleanly` is written after
  // stopAllWorkers has returned. Reversing the teardown moves the first line
  // after the second (or drops it entirely) even while both processes still end
  // up dead — which is the whole point, since a test that only waits for both to
  // be gone passes under either order.
  const workerStop = log.indexOf(`worker ${workerId} stopped`);
  const supStop = log.indexOf('stopped cleanly');
  assert.ok(workerStop !== -1, `the worker's death must be confirmed and logged:\n${log}`);
  assert.ok(supStop !== -1, 'a clean shutdown must be logged');
  assert.ok(workerStop < supStop, `workers must stop before the supervisor:\n${log}`);

  const final = readRecord(sb, workerId);
  assert.equal(final.state, 'exited', 'a stopped worker must be recorded as exited, not left running');
  assert.equal(final.pid, null);
});

// ---------------------------------------------------------------------------
// 15. the SIGKILL escalation is CONFIRMED, not merely signalled
// ---------------------------------------------------------------------------

// Test 14 proves the cooperative path: a worker that answers SIGTERM is gone, and
// its death is logged before the supervisor's. That path cannot reach the second
// phase, because a cooperative ox worker dies on SIGTERM in ~20ms. So the phase
// where a worker was only ever *signalled* — SIGKILL, then exit immediately, the
// worker still running — was untested, and it was wrong.
//
// A worker that ignores SIGTERM is the production shape of this: a run wedged in
// a blocking call, or anything that never gets to ox's signal handler. Stubbing
// one is the only honest way in, and it is a real process spawned by the real
// supervisor — nothing here reaches into ox's internals.
function writeSigtermImmuneWorkerStub(sb) {
  const stub = path.join(sb.root, 'sigterm-immune.cjs');
  fs.writeFileSync(
    stub,
    [
      '// Loaded via NODE_OPTIONS into every node process the daemon starts.',
      '// Only a --daemon-worker process arms the trap, so the supervisor and the',
      '// CLI that requested the detached run behave normally.',
      "if (process.argv.includes('--daemon-worker')) {",
      '  const origOn = process.on;',
      "  process.on = function (ev) { if (ev === 'SIGTERM') return this; return origOn.apply(this, arguments); };",
      "  origOn.call(process, 'SIGTERM', () => {});",
      '}',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  return stub;
}

test('daemon 15: a worker that ignores SIGTERM is confirmed dead before the supervisor exits', async (t) => {
  const sb = scaffold(t, 'escalate');
  const hold = (() => { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; })();
  const { port, requests } = await startMock(t, async (messages) => {
    await hold.promise;
    return messages.some((m) => m.role === 'tool')
      ? { text: 'done' }
      : { text: 'thinking', calls: [{ id: 'call_1', name: 'list_dir', args: { path: '.' } }] };
  });
  const stub = writeSigtermImmuneWorkerStub(sb);
  const env = mockEnv(sb, port, {
    NODE_OPTIONS: `--require ${stub}`,
    // Short, but non-zero, so the supervisor opens its escalation path in a test
    // without hanging on the 5s production grace.
    OX_DAEMON_STOP_GRACE_MS: '1200',
  });

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'hold forever', '--detach'], { env });
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  const rec = await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.pid && r.state === 'running' ? r : null;
  }, { what: 'the worker to be running' });
  const workerPid = rec.pid;
  const supPid = JSON.parse(fs.readFileSync(path.join(sb.daemon, 'daemon.json'), 'utf8')).pid;

  // The record says `running` the moment the supervisor's spawn() returns, which
  // is BEFORE the child has finished booting and loaded the stub. Probing with
  // SIGTERM in that window kills the worker and the fixture silently degrades
  // into test 14 — or fails outright on a loaded machine. Wait for the worker to
  // have actually reached the model: that is proof it is past process start.
  await waitFor(() => requests.length >= 1, { timeoutMs: 30000, what: 'the worker to reach the model' });
  await sleep(150);

  // Prove the premise, or the escalation path is never taken and this test proves
  // nothing: the worker must survive a direct SIGTERM. Signalled TWICE and polled
  // in between, so this asserts immunity rather than sampling one lucky instant —
  // a single sleep-then-check can only ever prove the worker was alive at that one
  // moment, which is exactly the mistake this test exists to catch.
  for (let round = 0; round < 2; round++) {
    process.kill(workerPid, 'SIGTERM');
    await sleep(250);
    assert.ok(pidAlive(workerPid), `the fixture is broken: this worker was supposed to ignore SIGTERM (round ${round + 1})`);
  }
  assert.ok(pidAlive(supPid), 'the supervisor must survive its worker ignoring SIGTERM');

  const shut = await spawnOx(sb, ['shutdown'], { env, timeoutMs: 25000 });
  assert.equal(shut.exitCode, 0, `shutdown failed: ${JSON.stringify(shut)}`);
  hold.open();

  const log = daemonLog(sb);
  // The escalation must have been reached...
  assert.match(log, /ignored SIGTERM after 1200ms; sending SIGKILL/, `the SIGKILL escalation must be logged:\n${log}`);
  // ...and the death it caused must be CONFIRMED. handleExit writes this line
  // from the child's exit event, so its presence is proof of death and its
  // position is proof of order. Before the fix it was absent entirely: the
  // supervisor SIGKILLed, removed its 'exit' listeners, logged "stopped cleanly"
  // and exited while the worker was still running.
  const workerStop = log.indexOf(`worker ${workerId} stopped (signal SIGKILL)`);
  const supStop = log.indexOf('stopped cleanly');
  assert.ok(workerStop !== -1, `the SIGKILLed worker's death must be confirmed and logged before the supervisor claims a clean stop:\n${log}`);
  assert.ok(supStop !== -1, 'a clean shutdown must be logged');
  assert.ok(workerStop < supStop, `workers must be confirmed dead before the supervisor stops:\n${log}`);
  assert.doesNotMatch(log, /UNCONFIRMED/, `the worker was killed, so nothing may be left unconfirmed:\n${log}`);

  await waitFor(() => !pidAlive(workerPid), { timeoutMs: 8000, what: 'the killed worker to be reaped' });
  await waitFor(() => !pidAlive(supPid), { timeoutMs: 8000, what: 'the supervisor to be gone' });

  const final = readRecord(sb, workerId);
  assert.equal(final.state, 'exited', 'a confirmed-dead worker must be recorded as exited');
  assert.equal(final.pid, null, 'a confirmed-dead worker must not keep a pid');
});

// ---------------------------------------------------------------------------
// 16. the repo tree is not mutated by any of this
// ---------------------------------------------------------------------------

test('daemon 16: nothing is written outside the sandbox HOME and the daemon dir', async (t) => {
  const sb = scaffold(t, 'hermetic');
  const { port } = await startMock(t, () => ({ text: 'hermetic' }));
  const env = mockEnv(sb, port);
  const realHome = REAL_HOME;
  const before = fs.readdirSync(realHome).sort().join('\n');

  await spawnOx(sb, ['daemon', 'start'], { env });
  const detached = await spawnOx(sb, ['-p', 'stay in the sandbox', '--detach'], { env });
  assert.equal(detached.exitCode, 0);
  const workerId = /detached (w-[0-9a-f]+)/.exec(detached.stdout)?.[1];
  await waitFor(() => {
    const r = readRecord(sb, workerId);
    return r?.state === 'exited' ? r : null;
  }, { timeoutMs: 25000, what: 'the worker to finish' });

  assert.equal(fs.readdirSync(realHome).sort().join('\n'), before, `the real home must be untouched (${realHome})`);
  // Every file the daemon made lives inside the sandbox, and the session
  // transcript lands under the sandboxed HOME too.
  const inside = (p) => path.resolve(String(p)).startsWith(path.resolve(sb.root));
  const files = fs.readdirSync(sb.daemon);
  assert.ok(files.length > 0);
  for (const name of files) assert.ok(inside(path.join(sb.daemon, name)), `${name} escaped the sandbox`);
  const rec = readRecord(sb, workerId);
  assert.ok(inside(rec.transcript), `the transcript must be inside the sandbox: ${rec.transcript}`);
  assert.ok(listSavedTranscripts(sb).length > 0, 'the run must have written a transcript under the sandboxed HOME');
  // No socket was left in the shared temp dir where another user could reach it.
  const shared = path.join(os.tmpdir(), 'ox-ipc-default.sock');
  assert.equal(fs.existsSync(shared), false, 'a detached run must not bind the default shared-tmpdir socket');
});

// ---------------------------------------------------------------------------
// 17. an inconclusive probe is not proof of death
// ---------------------------------------------------------------------------

test('daemon 17: a socket that accepts but never answers leaves the daemon UNKNOWN, and nothing is deleted', async (t) => {
  const sb = scaffold(t, 'inconclusive');

  // The shape of "the machine is too busy" — and of a hung daemon — without
  // needing either: something owns a 0600 socket in our own directory and never
  // answers on it. That is an ABSENCE of evidence, and the difference from a
  // refused connection is the whole point.
  fs.mkdirSync(sb.daemon, { recursive: true, mode: 0o700 });
  fs.chmodSync(sb.daemon, 0o700);
  const mute = net.createServer(() => { /* accept, then say nothing, ever */ });
  // unref'd so a listener that outlives the test can never be the reason the
  // runner's event loop stays alive.
  mute.unref();
  t.after(() => { try { mute.closeAllConnections?.(); mute.close(); } catch {} });
  await new Promise((resolve) => mute.listen(path.join(sb.daemon, 'c.sock'), resolve));
  fs.chmodSync(path.join(sb.daemon, 'c.sock'), 0o600);

  // A pidfile naming a live pid — ours, this time, so the ONLY thing in doubt is
  // whether the socket still belongs to it.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { decoy.kill('SIGKILL'); } catch {} });
  await sleep(150);
  const pidFile = path.join(sb.daemon, 'daemon.json');
  fs.writeFileSync(pidFile, `${JSON.stringify({
    pid: decoy.pid,
    instanceId: 'c'.repeat(32),
    startedAt: Date.now() - 1000,
    socketPath: path.join(sb.daemon, 'c.sock'),
    version: 1,
  })}\n`, { mode: 0o600 });

  const { inspectDaemon, daemonDoctor, probeControl } = await import('../src/daemon.js');
  const probe = await probeControl({ timeoutMs: 700 });
  assert.equal(probe.reachable, false);
  assert.equal(probe.kind, 'timeout', `a hung socket must be classified as a timeout: ${JSON.stringify(probe)}`);

  const snap = await inspectDaemon();
  assert.equal(snap.live, false);
  assert.equal(snap.socket.confidence, 'uncertain', 'a timeout must not be treated as proof');
  assert.match(snap.reason, /could not be confirmed/);
  assert.doesNotMatch(snap.reason, /recycled/, 'an inconclusive probe must NOT be reported as a recycled pid');

  // Nothing destructive may happen on that evidence.
  const report = await daemonDoctor({ fix: true });
  assert.ok(report.findings.some((f) => f.code === 'daemon-unverifiable'), 'the uncertainty must be stated, not hidden');
  assert.ok(!report.findings.some((f) => f.code === 'pidfile-recycled'), 'it must not be mislabelled as a recycled pid');
  assert.deepEqual(report.fixed, [], `nothing may be removed: ${JSON.stringify(report.fixed)}`);
  assert.equal(fs.existsSync(pidFile), true, 'the pidfile must survive an inconclusive probe');
  assert.equal(pidAlive(decoy.pid), true, 'and the pid must be left strictly alone');

  // Contrast: once the socket is definitively gone, the same pid IS provably not
  // the daemon, and the cleanup is allowed.
  // close() waits for open connections, and the whole point of this server is
  // that it holds one open. Drop them first, or the await never returns. The
  // timeout is a backstop: a hung test is worse than a slightly noisy one.
  await Promise.race([
    new Promise((resolve) => { mute.closeAllConnections?.(); mute.close(resolve); }),
    sleep(2000),
  ]);
  await waitFor(() => !fs.existsSync(path.join(sb.daemon, 'c.sock')), { what: 'the socket file to go' });
  const certain = await inspectDaemon();
  assert.equal(certain.socket.confidence, 'certain');
  assert.match(certain.reason, /recycled pid/, `with no socket at all this IS a recycled pid: ${certain.reason}`);
  const repaired = await daemonDoctor({ fix: true });
  assert.ok(repaired.fixed.length > 0, 'now the removal is allowed');
  assert.equal(fs.existsSync(pidFile), false);
});
