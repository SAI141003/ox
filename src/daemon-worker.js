// The daemon worker: one ox session, in its own process, supervised by the
// daemon.
//
// This is deliberately NOT a second run path. The supervisor spawns the ordinary
// CLI — `node bin/ox.js -p "<prompt>" <the user's own flags> --daemon-worker
// <id>` — so the worker gets the real flag parser, the real config load, the
// real sandbox resolution, and the real headless loop. The only thing this module
// adds is the two seams a detached run needs:
//
//   1. A session-scoped ipc.js server, so events reach an attaching client and
//      approvals can be answered out of band. It is the SAME server, with the
//      SAME createIpcApprover wiring, that `ox --ipc` builds — so the approval
//      path is byte-for-byte the existing fail-closed one. Nothing here can
//      turn silence into an allow: no client means no approval holder, and every
//      failure still converges on 'ask'.
//   2. A throttled status report to the supervisor, so `ox agents` can name the
//      current tool of a session running in a process this CLI never sees.
//
// Exit code discipline (this is what makes the supervisor's restart rule
// correct): a run that CONCLUDED exits 0, whatever headless reported. headless
// uses 1 for a stream error, 2 for a declined approval or a budget stop, and
// those are outcomes of the run, not crashes of the worker. A non-zero exit here
// therefore means "this worker died", which is the only thing worth restarting.
// Run the token budget out mid-session and you get a declined prompt, not a
// respawn loop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectIpcClient, createIpcServer } from './ipc.js';
import {
  controlRequest,
  controlSocketPath,
  currentUid,
  ensureDaemonDir,
  hardenSocket,
  probeControl,
  screenSocketPath,
  workerSocketPath,
} from './daemon.js';

const STATUS_MIN_INTERVAL_MS = 200;
const TRANSCRIPT_SCAN_LIMIT = 80;

// ---------------------------------------------------------------------------
// Authorization. `--daemon-worker` is on a public CLI surface, so a human (or
// anything else that can run ox) must not be able to use it to bind a socket in
// ~/.ox and get a session that looks supervised. A worker is only a worker if a
// supervisor started it: both env vars must be present AND the control socket
// must answer with the instance id this process was launched with.
// ---------------------------------------------------------------------------

export async function authorizeWorker(workerId) {
  const id = String(workerId ?? '').trim();
  if (!id) return { ok: false, reason: '--daemon-worker needs a worker id' };
  const instanceId = process.env.OX_DAEMON_INSTANCE_ID || null;
  const control = process.env.OX_DAEMON_CONTROL_SOCKET || null;
  if (!instanceId || !control) {
    return { ok: false, reason: '--daemon-worker is internal: it only runs under `ox daemon` (no OX_DAEMON_INSTANCE_ID in the environment)' };
  }
  const expected = controlSocketPath();
  let claimed = null;
  try { claimed = path.resolve(control); } catch { claimed = control; }
  if (claimed !== path.resolve(expected)) {
    return { ok: false, reason: `OX_DAEMON_CONTROL_SOCKET is ${claimed}, not this user's daemon socket ${path.resolve(expected)}` };
  }
  const verdict = screenSocketPath(control);
  if (!verdict.ok || !verdict.exists) {
    return { ok: false, reason: `the daemon socket is unusable: ${verdict.reason ?? 'absent'}` };
  }
  const probe = await probeControl({ timeoutMs: 1000 });
  if (!probe.reachable) return { ok: false, reason: `no daemon is listening on ${expected} (${probe.reason})` };
  if (probe.instanceId !== instanceId) {
    return { ok: false, reason: `the daemon on ${expected} is a different instance than the one that launched this worker` };
  }
  return { ok: true, workerId: id, instanceId, controlSocket: expected };
}

// ---------------------------------------------------------------------------
// The transcript. The supervisor has to know which JSONL a worker owns, and the
// honest way to say it is in the transcript itself: headless stamps the session
// meta with the worker id, so the join is a property of the durable record and
// not a guess about file mtimes.
// ---------------------------------------------------------------------------

export function findTranscript(workerId) {
  const dir = path.join(os.homedir(), '.ox', 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const rows = [];
  for (const n of names) {
    const full = path.join(dir, n);
    try { rows.push([fs.statSync(full).mtimeMs, full]); } catch {}
  }
  rows.sort((a, b) => b[0] - a[0]);
  for (const [, full] of rows.slice(0, TRANSCRIPT_SCAN_LIMIT)) {
    let fd = null;
    try {
      // The meta event is the first line by construction (session.js writes it
      // first), so a bounded prefix read is enough and a long transcript is
      // never pulled into memory to answer "which file is mine".
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, read).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (!line.includes(workerId)) continue;
        const ev = JSON.parse(line);
        if (ev?.t === 'meta' && String(ev.workerId ?? '') === String(workerId)) {
          // createSession's meta event carries no id of its own, so the id is
          // derived from the filename stem exactly the way `ox sessions` does.
          const stem = path.basename(full, '.jsonl').match(/-([0-9a-f]{6})$/);
          return { file: full, sessionId: ev.id ?? (stem ? stem[1] : null) };
        }
        break; // only the first line can be the meta event
      }
    } catch {
      /* unreadable or torn: try the next candidate */
    } finally {
      try { fd?.close(); } catch {}
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The supervisor link. One lazily-opened client, reused for every report, so a
// long run does not open a socket per event. A closed client is simply reopened
// on the next report; a worker whose supervisor has died keeps running and stops
// reporting, which is the honest unmanaged case `ox agents` labels.
//
// Two kinds of report, deliberately delivered differently:
//
//   telemetry   (which tool is running now) is FIRE-AND-FORGET over the shared
//               client. Losing one costs a stale row, and waiting for a reply
//               would put a supervisor round trip in front of every tool call.
//   the record  (which transcript is mine, and the fact that the run ended) is a
//               REQUEST: the worker waits for the control reply. A socket write
//               followed immediately by close() can drop the last frames, and the
//               transcript join is the one thing that must not be lossy — without
//               it the session shows "no transcript" for ever.
// ---------------------------------------------------------------------------

function supervisorLink() {
  let client = null;
  let connecting = false;
  let queued = [];
  const connect = () => {
    if (client?.open) return client;
    if (connecting) return null;
    connecting = true;
    const next = connectIpcClient({
      socketPath: controlSocketPath(),
      clientId: `ox-worker-${process.pid}`,
      connectTimeoutMs: 500,
    });
    next.on('close', () => { if (client === next) client = null; });
    next.on('open', () => {
      connecting = false;
      const pending = queued;
      queued = [];
      for (const args of pending) send(args);
    });
    next.on('error', () => {});
    client = next;
    return next;
  };
  const send = (args) => {
    const c = connect();
    if (c?.open) c.send({ type: 'control', id: `${args.op}-${Date.now().toString(36)}`, op: args.op, args });
    else queued.push(args);
  };
  return { send, close() { try { client?.close(); } catch {} } };
}

// ---------------------------------------------------------------------------
// runDaemonWorker
// ---------------------------------------------------------------------------

export async function runDaemonWorker({ workerId, prompt, config, opts = {}, initialMessages = [], flags = {} } = {}) {
  const auth = await authorizeWorker(workerId);
  if (!auth.ok) {
    process.stderr.write(`ox: ${auth.reason}\n`);
    return { code: 4 };
  }
  const id = auth.workerId;
  const instanceId = auth.instanceId;
  const socketPath = workerSocketPath(id);

  // The worker's own socket is a second privilege surface (it can hold an
  // approval that runs code), so it gets exactly the same screen and the same
  // 0600 treatment as the control socket.
  ensureDaemonDir();
  const verdict = screenSocketPath(socketPath);
  if (!verdict.ok) {
    process.stderr.write(`ox: refusing to bind the worker socket: ${verdict.reason}\n`);
    return { code: 4 };
  }
  if (verdict.exists && verdict.foreign) {
    process.stderr.write(`ox: ${socketPath} is owned by another user — this worker will not touch it\n`);
    return { code: 4 };
  }

  const server = createIpcServer({
    socketPath,
    sessionId: id,
    socketOwnerUid: currentUid(),
    meta: {
      role: 'worker',
      workerId: id,
      daemonInstance: instanceId,
      cwd: config?.cwd ?? process.cwd(),
      bot: opts.bot ?? flags.bot ?? null,
      model: opts.model ?? flags.model ?? null,
    },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    process.stderr.write(`ox: worker ${id} could not bind ${socketPath}: ${err?.message ?? err}\n`);
    return { code: 4 };
  }
  hardenSocket(socketPath);

  const link = supervisorLink();
  const baseArgs = { workerId: id, instanceId };

  let readySent = false;
  let announcing = null;
  let announced = null;
  // The durable join, asked for as a request so its arrival is not a hope.
  const announceTranscript = () => {
    if (readySent) return Promise.resolve(announced);
    if (announcing) return announcing;
    // The DEFERRED start is load-bearing, not stylistic. An async body with no
    // await runs to completion synchronously, so an `announcing = null` in its
    // `finally` would clear the flag BEFORE the assignment below overwrites it
    // with an already-settled promise — and every later call would then return
    // that stale promise instead of trying again. The symptom is exactly what
    // this is guarding against: the transcript join is attempted once, before
    // the session file exists, and never again, so the record says
    // `transcript: null` for ever. Starting in a microtask makes the ordering
    // unconditional.
    announcing = Promise.resolve().then(async () => {
      try {
        const found = findTranscript(id);
        if (!found?.file) return null;
        const res = await controlRequest(
          'worker-ready',
          { ...baseArgs, transcript: found.file, sessionId: found.sessionId },
          { timeoutMs: 2500 }
        );
        if (!res.ok) return null;
        announced = found;
        readySent = true;
        return announced;
      } finally {
        announcing = null;
      }
    });
    return announcing;
  };

  // Lifecycle: an approved SIGINT stops the WORKER's socket, and then the signal
  // keeps its default disposition so an operator's Ctrl-C still kills the run
  // rather than being quietly swallowed.
  let closed = false;
  const closeLocal = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      closeLocal();
      process.removeListener(sig, onSignal);
      try { process.kill(process.pid, sig); } catch { process.exit(143); }
    };
    process.on(sig, onSignal);
  }
  process.on('exit', closeLocal);

  // Track the live state `ox agents` shows. The event stream is already the one
  // the agent loop publishes for the GUI, so this is a fold, not a second
  // instrumentation of the loop.
  const state = { currentTool: null, toolCalls: 0, turns: 0 };
  let lastReport = 0;
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < STATUS_MIN_INTERVAL_MS) return;
    lastReport = now;
    // Kick the durable join off early so `ox agents` can name the transcript
    // while the session is still running. Its outcome is not waited on here.
    if (!readySent) announceTranscript();
    link.send({
      op: 'worker-status',
      args: {
        ...baseArgs,
        currentTool: state.currentTool,
        toolCalls: state.toolCalls,
        turns: state.turns,
        state: 'running',
      },
    });
  };
  server.on('event', (ev) => {
    const type = ev?.type;
    if (type === 'tool-start') {
      state.currentTool = String(ev.name ?? 'unknown');
      state.toolCalls += 1;
      report(true);
      return;
    }
    if (type === 'tool-end') {
      state.currentTool = null;
      report(true);
      return;
    }
    if (type === 'turn-end' || type === 'final') {
      state.currentTool = null;
      state.turns += 1;
      report(true);
      return;
    }
    if (type === 'error') {
      state.currentTool = null;
      report(true);
    }
  });

  // The two seams, and nothing else changed about the run: the ipc server makes
  // the existing approver out-of-band-capable, and `session: true` makes
  // headless write the append-only transcript this whole feature exists to
  // preserve. No sandbox, approval, or trust behaviour is touched.
  // headless creates the transcript before its first model call, so the join can
  // be made up front — which is what lets `ox agents` name the transcript for a
  // worker still waiting on its first token.
  await announceTranscript();

  const { runHeadless } = await import('./headless.js');
  // The distinction the supervisor's restart rule turns on: `concluded` means the
  // run reached a verdict (whatever that verdict's code), so the worker exits 0.
  // Without it, code 1 would read as a crash; with it, code 1 is a stream error.
  let concluded = false;
  let code = 0;
  try {
    const res = await runHeadless({
      prompt,
      config,
      opts: { ...opts, ipcServer: server, session: true, workerId: id },
      initialMessages,
    });
    concluded = true;
    code = Number(res?.code ?? 0);
  } catch (err) {
    // A throw here is a WORKER failure, not a run outcome: the supervisor needs
    // to see a non-zero exit to restart with backoff.
    await controlRequest(
      'worker-status',
      { ...baseArgs, state: 'error', currentTool: null, turns: state.turns, toolCalls: state.toolCalls, error: String(err?.message ?? err) },
      { timeoutMs: 2500 }
    );
    process.stderr.write(`ox: worker ${id} failed: ${err?.message ?? err}\n`);
    code = 1;
  }

  // Final record: make sure the transcript join landed, then tell the supervisor
  // the run is over. Both are REQUESTS, so the supervisor has processed them
  // before this process goes away. A write followed straight into close() does
  // not guarantee that, and the whole premise of a supervisor is that what it
  // records outlives the process that reported it.
  await announceTranscript();
  await controlRequest(
    'worker-status',
    // `runCode` rides along on the final frame because it is the only signal the
    // supervisor gets about HOW the run ended: this process exits 0 for any
    // concluded run, so a budget stop (headless 2) would otherwise be
    // indistinguishable from a clean finish.
    { ...baseArgs, state: 'concluded', currentTool: null, turns: state.turns, toolCalls: state.toolCalls, runCode: code },
    { timeoutMs: 2500 }
  );
  closeLocal();
  link.close();
  // A concluded run exits 0 whatever headless reported: 1 (stream error) and 2
  // (denied / budget stop) are outcomes, not crashes. Only the catch above — the
  // worker itself dying — leaves this at 1, and only that earns a restart.
  process.exitCode = concluded ? 0 : 1;
  return { code: process.exitCode, runCode: code, concluded };
}

export { supervisorLink as _supervisorLink, findTranscript as _findTranscript };
