// The ox daemon supervisor: a detached process whose only job is to keep other
// processes alive.
//
// Started by `ox daemon start` (src/daemon.js) as a detached, unref'd child, so
// it outlives the terminal that asked for it. It binds ONE privileged socket
// (~/.ox/daemon/c.sock, chmod 0600 inside a 0700 directory) and serves control
// requests on it. Workers are separate processes it spawns and watches; it never
// hosts a session in its own memory, which is what makes a worker crash
// survivable at all.
//
//   lifetime   bind socket -> write pidfile -> supervise -> (signal) -> stop
//              workers -> close socket -> remove pidfile -> exit
//   ordering   workers first, supervisor last, and "stopped" means the exit was
//              OBSERVED (handleExit cleared the pid), never merely signalled. The
//              SIGKILL escalation is confirmed in its own window: a worker that
//              survives the grace period is killed and then waited for. Workers
//              are spawned detached, so one still alive when the supervisor exits
//              outlives it as an orphan — and a record rewritten to `exited` with
//              a null pid is an orphan nothing can find again. That is why an
//              unconfirmed worker keeps its pid and is recorded as `orphaned`.
//              `daemon shutdown` is therefore useless exactly when you need it if
//              the supervisor can leave first, and it cannot: it returns only once
//              every worker's death is confirmed or reported as unconfirmed.
//              --force skips the grace period; it does NOT skip the confirmation.
//
//   liveness   the pidfile is written AFTER the bind, so a pidfile only ever
//              exists for a process that already owns the socket. A second
//              supervisor cannot produce a second pidfile: the bind is the
//              exclusive resource, and it refuses to steal a live socket.
//   restart    a worker that exits 0 concluded its run and is left alone. A
//              worker that exits non-zero was interrupted, and is respawned
//              with geometric backoff up to a bounded attempt count, after
//              which the supervisor gives up and says so in the log and in the
//              worker record rather than retrying forever.
//   crash      SIGINT/SIGTERM, an uncaught throw, and an unexpected exit all
//              run the same cleanup, so the only way to leave a socket or a
//              pidfile behind is SIGKILL — and `ox daemon doctor` is built to
//              find and clear exactly that.
//
// This process is the privilege boundary the task warns about: whoever can reach
// the control socket can start agents that execute code with this process's
// environment. The boundary IS the filesystem — 0700 directory, 0600 socket, and
// an ownership screen on every path found there. Node's net module exposes no
// peer credentials, so same-uid socket peers are trusted; that is the same
// trust model as every other unix tool, and it is why the mode bits matter.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { controlReply, createIpcServer } from './ipc.js';
// Schedules and heartbeats. Every decision (is this due, may it run, what is the
// prompt, what argv may it carry) is made in schedule.js; this file only decides
// WHEN to ask and routes the answer into the SAME startWorker every detached run
// already uses. There is deliberately no second execution path here.
import {
  HEARTBEAT_DECISIONS,
  buildHeartbeatPrompt,
  buildSchedulePrompt,
  claimSchedule,
  dueSchedules,
  heartbeatDecision,
  inflightVerdict,
  noteShutdown,
  readPolicy,
  recordDeferral,
  recordRun,
  schedulePassthrough,
  scheduleRunState,
  screenScheduleArgv,
  screenSchedulePrompt,
} from './schedule.js';
import { loadSessionWithStatus } from './session.js';
import { renderGoalBlock } from './goal.js';
import {
  CONTROL_OPS,
  OX_BIN,
  backoffDelayMs,
  backoffSettings,
  cleanupRemnants,
  controlSocketPath,
  currentUid,
  ensureDaemonDir,
  hardenSocket,
  newInstanceId,
  newWorkerId,
  appendLog,
  pidFilePath,
  probeControl,
  readWorkerRecord,
  screenSocketPath,
  workerLogDir,
  workerLogPath,
  workerSocketPath,
  writePidFile,
  writeWorkerRecord,
} from './daemon.js';

// Every file this process creates is private to the user, including the window
// between bind() and the chmod in the 'listening' handler. 022 would create the
// control socket 0755 — world-connectable on a machine with other users.
process.umask(0o077);

const instanceId = newInstanceId();
const socketPath = controlSocketPath();
const startedAt = Date.now();
const backoff = backoffSettings();

const MAX_PROMPT_CHARS = 4000;
const MAX_WORKERS = Math.max(1, Number(process.env.OX_DAEMON_MAX_WORKERS) || 16);

// `Number(x) || fallback` cannot express a zero window: `0 || 5000` is 5000, so
// OX_DAEMON_STOP_GRACE_MS=0 silently meant "wait five seconds" and the grace was
// impossible to switch off. An explicit NaN test keeps 0 honest.
function msFromEnv(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const STOP_GRACE_MS = msFromEnv('OX_DAEMON_STOP_GRACE_MS', 5000);
// The window in which a SIGKILLed worker must be observed dead. Separate from
// STOP_GRACE_MS because it answers a different question: not "how long may a
// worker take to wind down" but "how long may we claim to have stopped it".
const STOP_KILL_GRACE_MS = msFromEnv('OX_DAEMON_KILL_GRACE_MS', 2000);

// How often the schedule engine looks for due work. Five seconds is fine for the
// cadences a human sets (minutes, hours, a time of day); it is also the floor for
// how long `ox schedule add --enable` takes to become visible in the daemon,
// which is what the tests shorten rather than what a real install should.
const SCHEDULE_TICK_MS = msFromEnv('OX_DAEMON_SCHEDULE_TICK_MS', 5000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// id -> the LIVE map. This is the only thing that may answer "is a worker
// running right now"; the record files are intents, and the OS pid check is a
// second opinion, not the authority.
const workers = new Map();

let shuttingDown = false;
let cleanedUp = false;
let server = null;

// The schedule timer is a module-level handle because shutdown has to clear it:
// an unref'd timer alone would let the supervisor exit out from under a due
// schedule mid-claim, which is exactly the window claimSchedule exists to make
// survivable.
let scheduleTimer = null;
let scheduleTicked = false;

// ---------------------------------------------------------------------------
// Persisting a worker's durable record. Single-writer by construction: only this
// process writes worker records, and it does so after every state change, so a
// crash can never leave a half-updated "running" row behind.
// ---------------------------------------------------------------------------

function publicView(w) {
  return {
    id: w.id,
    state: w.state,
    pid: w.pid,
    cwd: w.cwd,
    prompt: w.prompt,
    startedAt: w.startedAt,
    spawnedAt: w.spawnedAt,
    endedAt: w.endedAt,
    restarts: w.restarts,
    attempts: w.attempts,
    maxAttempts: backoff.maxAttempts,
    lastExitCode: w.lastExitCode,
    lastSignal: w.lastSignal,
    nextRestartAt: w.nextRestartAt,
    giveUpReason: w.giveUpReason,
    currentTool: w.currentTool,
    currentToolAt: w.currentToolAt,
    toolCalls: w.toolCalls,
    turns: w.turns,
    lastEventAt: w.lastEventAt,
    transcript: w.transcript,
    sessionId: w.sessionId,
    socketPath: workerSocketPath(w.id),
    instanceId,
    bot: w.bot ?? null,
    model: w.model ?? null,
    // Which schedule spawned this worker, so `ox agents` and the in-flight cap
    // can tell an unattended run from one a human detached by hand.
    scheduleId: w.scheduleId ?? null,
    scheduleTrigger: w.scheduleTrigger ?? null,
    runCode: w.runCode ?? null,
  };
}

function persist(w) {
  const { child, timer, stopRequested, ...rest } = w;
  try {
    writeWorkerRecord({ ...rest, socketPath: workerSocketPath(w.id), instanceId });
  } catch (err) {
    appendLog(`!! could not write the record for worker ${w.id}: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// Spawn / restart
// ---------------------------------------------------------------------------

function spawnWorker(w) {
  const argv = [OX_BIN, '-p', w.prompt, ...(w.passthrough ?? []), '--daemon-worker', w.id];
  let out = null;
  try {
    fs.mkdirSync(workerLogDir(), { recursive: true, mode: 0o700 });
    out = fs.openSync(workerLogPath(w.id), 'a', 0o600);
  } catch {
    out = 'ignore';
  }
  let child;
  try {
    child = spawn(process.execPath, argv, {
      cwd: w.cwd,
      env: {
        ...process.env,
        OX_DAEMON_WORKER_ID: w.id,
        OX_DAEMON_INSTANCE_ID: instanceId,
        OX_DAEMON_CONTROL_SOCKET: socketPath,
        OX_NO_BANNER: '1',
      },
      // Its own process group: a signal aimed at the supervisor's group (a
      // `kill -- -pgid` from a terminal teardown, or a supervisor shutdown) must
      // not reach a worker by accident, and the worker must survive its parent
      // exiting. Shutdown signals it explicitly instead.
      detached: true,
      stdio: ['ignore', out, out],
    });
  } catch (err) {
    appendLog(`!! could not spawn worker ${w.id}: ${err?.message ?? err}`);
    if (typeof out === 'number') { try { fs.closeSync(out); } catch {} }
    w.state = 'failed';
    w.giveUpReason = `spawn failed: ${err?.message ?? err}`;
    w.endedAt = Date.now();
    persist(w);
    return;
  }
  if (typeof out === 'number') { try { fs.closeSync(out); } catch {} }
  // unref: a worker must never be the reason the supervisor stays alive, and a
  // worker exiting must never take the supervisor down with it.
  child.unref();

  w.child = child;
  w.pid = child.pid ?? null;
  w.state = 'running';
  w.spawnedAt = Date.now();
  w.lastEventAt = Date.now();
  w.nextRestartAt = null;
  w.giveUpReason = null;
  workers.set(w.id, w);
  persist(w);
  appendLog(`worker ${w.id} started pid ${w.pid} (attempt ${w.attempts}/${backoff.maxAttempts}) ${JSON.stringify(w.prompt.slice(0, 80))}`);

  child.on('error', (err) => {
    appendLog(`!! worker ${w.id} error: ${err?.message ?? err}`);
  });
  child.on('exit', (code, signal) => {
    try { handleExit(w, child, code, signal); } catch (err) {
      appendLog(`!! handling the exit of worker ${w.id} threw: ${err?.message ?? err}`);
    }
  });
}

// The restart decision, in one place.
//
//   exit 0            the run concluded (complete, denied, budget-stopped — all
//                     of which headless reports as a code, not a crash).
//                     Nothing to restart: the work is finished.
//   exit != 0, killed  interrupted. Restart with backoff, up to maxAttempts
//   spawns in total. Give up after that, LOUDLY.
//   stopRequested     we asked it to stop. Never restart that.
function handleExit(w, child, code, signal) {
  if (w.child !== child) return; // a newer child already replaced this one
  w.child = null;
  w.pid = null;
  w.lastExitCode = code;
  w.lastSignal = signal ?? null;
  w.lastEventAt = Date.now();
  w.currentTool = null;

  // The one place a worker's death is OBSERVED, so it is the one place a
  // schedule learns how its run went. Exit 2 from headless is a budget stop or a
  // declined approval — an outcome of the run, and recorded as such, with the
  // schedule left intact (claimSchedule already advanced nextRunAt, and this only
  // annotates lastRun).
  if (w.scheduleId) {
    const state = scheduleRunState({ code, signal, runCode: w.runCode, stopRequested: w.stopRequested || shuttingDown });
    try {
      recordRun(w.scheduleId, {
        at: Date.now(),
        state,
        workerId: w.id,
        code,
        countRuns: true,
        note: w.giveUpReason ?? '',
      });
      appendLog(`schedule ${w.scheduleId} run finished: ${state} (worker ${w.id}, exit ${code}, run ${w.runCode ?? '?'})`);
    } catch (err) {
      appendLog(`!! could not record the result of schedule ${w.scheduleId}: ${err?.message ?? err}`);
    }
  }

  if (w.stopRequested || shuttingDown) {
    w.state = 'exited';
    w.endedAt = Date.now();
    persist(w);
    appendLog(`worker ${w.id} stopped (${signal ? `signal ${signal}` : `exit ${code}`})`);
    return;
  }

  if (code === 0) {
    w.state = 'exited';
    w.endedAt = Date.now();
    persist(w);
    appendLog(`worker ${w.id} finished normally (exit 0) after ${w.turns} turn(s), ${w.toolCalls} tool call(s)`);
    return;
  }

  // A SCHEDULED RUN IS ONE RUN, NOT A RETRY BUDGET.
  //
  // The restart rule below answers "the work is still wanted, and the process
  // that was doing it died" — which is exactly right for a run a human detached,
  // and exactly wrong for a schedule. A schedule's work is wanted at the NEXT
  // tick, so honouring the backoff here spawned `backoff.maxAttempts` workers
  // for a single firing: five model sessions per schedule per interval, on a
  // timer, unattended, with the lastRun history recording five exits for one
  // claim. A keyless sandbox showed it plainly — 32 recorded runs and ~5 claims.
  //
  // So a scheduled worker is never restarted. Its exit is recorded (above), it is
  // marked done, and the next firing is the next tick's business. A human-detached
  // worker is untouched.
  if (w.scheduleId) {
    w.state = 'exited';
    w.endedAt = Date.now();
    w.nextRestartAt = null;
    w.giveUpReason = w.giveUpReason ?? `scheduled run ended with ${signal ? `signal ${signal}` : `exit ${code}`} (not retried: a schedule fires once per tick, so the next tick is the retry)`;
    persist(w);
    appendLog(`scheduled worker ${w.id} ended with ${signal ? `signal ${signal}` : `exit ${code}`} for schedule ${w.scheduleId}; not restarting (the next tick is the next attempt)`);
    return;
  }

  // A killed process has no exit code, and "exit null" in a log line reads like
  // a bug rather than a SIGKILL. Say what actually happened.
  const why = signal ? `signal ${signal}` : `exit ${code}`;
  if (w.attempts >= backoff.maxAttempts) {
    w.state = 'failed';
    w.endedAt = Date.now();
    w.giveUpReason = `gave up after ${w.attempts} attempts (last ${why})`;
    w.nextRestartAt = null;
    persist(w);
    appendLog(`!! worker ${w.id} GAVE UP after ${w.attempts} attempt(s): last ${why}. Not restarting again.`);
    return;
  }

  w.attempts += 1;
  const delay = backoffDelayMs(w.attempts, { baseMs: backoff.baseMs, factor: backoff.factor, capMs: backoff.capMs });
  w.state = 'restarting';
  w.nextRestartAt = Date.now() + delay;
  w.restarts += 1;
  persist(w);
  appendLog(`worker ${w.id} died (${why}); restart ${w.attempts}/${backoff.maxAttempts} in ${delay}ms`);
  w.timer = setTimeout(() => {
    w.timer = null;
    if (shuttingDown || w.stopRequested) return;
    if (!workers.has(w.id)) return;
    spawnWorker(w);
  }, delay);
  if (typeof w.timer.unref === 'function') w.timer.unref();
}

function adoptOrCreate(id, spec) {
  const existing = workers.get(id);
  if (existing) return existing;
  const record = readWorkerRecord(id);
  const w = {
    id,
    prompt: String(spec?.prompt ?? record?.prompt ?? ''),
    passthrough: Array.isArray(spec?.passthrough) ? spec.passthrough.map(String) : (record?.passthrough ?? []),
    cwd: String(spec?.cwd ?? record?.cwd ?? process.cwd()),
    bot: spec?.bot ?? record?.bot ?? null,
    model: spec?.model ?? record?.model ?? null,
    state: 'starting',
    pid: null,
    child: null,
    timer: null,
    stopRequested: false,
    startedAt: record?.startedAt ?? Date.now(),
    spawnedAt: null,
    endedAt: null,
    restarts: record?.restarts ?? 0,
    // A restart budget belongs to the RUN, not to the pidfile: an adopted
    // record that already burned four attempts keeps its history and its
    // remaining budget, so re-attaching to a doomed worker cannot reset the cap.
    attempts: Math.max(1, Number(record?.attempts) || 1),
    lastExitCode: record?.lastExitCode ?? null,
    lastSignal: record?.lastSignal ?? null,
    nextRestartAt: null,
    giveUpReason: null,
    currentTool: null,
    currentToolAt: null,
    toolCalls: record?.toolCalls ?? 0,
    turns: record?.turns ?? 0,
    lastEventAt: null,
    transcript: record?.transcript ?? null,
    sessionId: record?.sessionId ?? null,
    // A schedule id is durable: it is written to the worker record like every
    // other field, so an adopted worker is still counted against the schedule
    // in-flight cap after this supervisor restarts and adopts it.
    scheduleId: spec?.scheduleId ?? record?.scheduleId ?? null,
    runCode: record?.runCode ?? null,
    scheduleTrigger: spec?.scheduleTrigger ?? record?.scheduleTrigger ?? null,
  };
  workers.set(id, w);
  persist(w);
  return w;
}

function startWorker({ prompt, cwd, passthrough, bot, model, scheduleId = null, scheduleTrigger = null }) {
  const text = String(prompt ?? '').trim();
  if (!text) return { error: 'a detached run needs a prompt' };
  if (text.length > MAX_PROMPT_CHARS) return { error: `prompt is ${text.length} characters, over the ${MAX_PROMPT_CHARS} limit` };
  const live = [...workers.values()].filter((w) => w.state === 'running' || w.state === 'starting' || w.state === 'restarting');
  if (live.length >= MAX_WORKERS) return { error: `already supervising ${live.length} workers, at the ${MAX_WORKERS} cap` };
  const id = newWorkerId();
  const w = adoptOrCreate(id, { prompt: text, cwd, passthrough, bot, model, scheduleId, scheduleTrigger });
  spawnWorker(w);
  return { workerId: id, socketPath: workerSocketPath(id), pid: w.pid, restarted: false };
}

// ---------------------------------------------------------------------------
// Control request handling
// ---------------------------------------------------------------------------

function liveList() {
  return [...workers.values()].map(publicView);
}

function opStatus() {
  return {
    role: 'daemon',
    instanceId,
    pid: process.pid,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    version: 1,
    socketPath,
    home: os.homedir(),
    daemonDir: path.dirname(socketPath),
    maxWorkers: MAX_WORKERS,
    backoff: { ...backoff },
    // Whether the schedule engine may dispatch anything, and how many scheduled
    // runs are holding a worker right now. `ox daemon status` prints this so
    // "nothing ran" has an answer other than silence.
    schedules: (() => {
      try {
        const policy = readPolicy();
        return {
          optedIn: policy.optedIn,
          tickMs: SCHEDULE_TICK_MS,
          maxInFlight: policy.maxInFlight,
          inFlight: [...inFlightScheduleIds()],
        };
      } catch (err) {
        return { optedIn: false, error: String(err?.message ?? err) };
      }
    })(),
    workers: liveList(),
  };
}

function handleControl(msg) {
  if (msg?.type !== 'control') return undefined; // not ours: the warning path
  const op = String(msg.op ?? '');
  if (!CONTROL_OPS.includes(op)) {
    return controlReply(msg, { ok: false, error: `unknown control op '${op}'` });
  }
  const args = msg.args ?? {};
  switch (op) {
    case 'ping':
      return controlReply(msg, { result: { pong: true, instanceId, pid: process.pid, version: 1 } });

    case 'status':
      return controlReply(msg, { result: opStatus() });

    case 'list':
      return controlReply(msg, { result: { workers: liveList() } });

    case 'start': {
      const res = startWorker(args);
      return res.error ? controlReply(msg, { ok: false, error: res.error }) : controlReply(msg, { result: res });
    }

    // `ox schedule run-now` and a live `ox schedule enable` both need the
    // supervisor to dispatch, so both go through dispatchScheduleRun rather than
    // spawning from the CLI process. One gate, one audit trail.
    case 'schedule-run': {
      const res = dispatchScheduleRun(args.schedule, { trigger: args.trigger || 'manual', attended: args.attended === true });
      if (res.error) return controlReply(msg, { ok: false, error: res.error });
      if (res.stopped) return controlReply(msg, { result: { stopped: true, reason: res.reason } });
      return controlReply(msg, { result: { workerId: res.workerId, pid: res.pid, socketPath: res.socketPath } });
    }

    case 'stop-worker': {
      const w = workers.get(String(args.workerId ?? ''));
      if (!w) return controlReply(msg, { ok: false, error: `no live worker '${args.workerId}'` });
      if (!w.pid) return controlReply(msg, { result: { stopped: true, reason: 'worker has no process' } });
      // Only a pid this supervisor actually spawned is ever signalled.
      try { process.kill(w.pid, args.force ? 'SIGKILL' : 'SIGTERM'); } catch (err) {
        return controlReply(msg, { ok: false, error: `could not signal worker pid ${w.pid}: ${err?.code ?? err}` });
      }
      return controlReply(msg, { result: { stopped: true, pid: w.pid, signal: args.force ? 'SIGKILL' : 'SIGTERM' } });
    }

    case 'session-info': {
      const w = workers.get(String(args.workerId ?? ''));
      if (!w) return controlReply(msg, { ok: false, error: `no live worker '${args.workerId}'` });
      return controlReply(msg, { result: publicView(w) });
    }

    case 'worker-ready':
    case 'worker-status': {
      // A frame may only ever update a worker THIS supervisor spawned. Without
      // that check any same-uid peer could rewrite another session's record.
      const w = workers.get(String(args.workerId ?? ''));
      if (!w) return controlReply(msg, { ok: false, error: `no live worker '${args.workerId}'` });
      if (args.instanceId && args.instanceId !== instanceId) {
        return controlReply(msg, { ok: false, error: 'instance mismatch' });
      }
      if (typeof args.transcript === 'string' && args.transcript) w.transcript = args.transcript;
      if (args.sessionId) w.sessionId = String(args.sessionId);
      if (op === 'worker-status') {
        w.currentTool = args.currentTool ? String(args.currentTool) : null;
        w.currentToolAt = args.currentTool ? Date.now() : null;
        if (Number.isFinite(Number(args.toolCalls))) w.toolCalls = Number(args.toolCalls);
        if (Number.isFinite(Number(args.turns))) w.turns = Number(args.turns);
        if (args.state) w.state = String(args.state);
        // The run's OWN code, as opposed to the worker's exit code. runDaemonWorker
        // exits 0 for ANY concluded run, so this frame is the only place a budget
        // stop (headless 2) or a declined approval is visible to the supervisor at
        // all — without it every scheduled run would be filed as `ok`, which is
        // exactly the "we hit the cap and we finished" confusion this refuses.
        if (args.runCode !== undefined && args.runCode !== null) {
          const n = Number(args.runCode);
          if (Number.isFinite(n)) w.runCode = n;
        }
      }
      w.lastEventAt = Date.now();
      persist(w);
      return controlReply(msg, { result: { ok: true } });
    }

    case 'shutdown': {
      const res = { stopping: true, force: !!args.force, instanceId, pid: process.pid };
      // Reply first, then tear down: a client waiting on this reply must get it
      // before the socket it is waiting on goes away.
      queueMicrotask(() => shutdown(args.force ? 'forced' : 'requested'));
      return controlReply(msg, { result: res });
    }

    default:
      return controlReply(msg, { ok: false, error: `unhandled op '${op}'` });
  }
}

// ---------------------------------------------------------------------------
// The schedule engine.
//
// Every tick does the same four things, in this order, and every refusal is
// logged rather than swallowed:
//
//   1. read the policy and the store fresh, so `ox schedule add` / `remove` /
//      `enable` take effect on the next tick without an IPC round trip;
//   2. find the due rows — nothing at all happens unless the policy says opted in;
//   3. check the in-flight cap BEFORE claiming, so a backed-up schedule is
//      deferred with a recorded reason instead of spawning an unbounded pile;
//   4. claim, build the prompt, re-screen it, build an allowlisted argv, and hand
//      it to the SAME startWorker a hand-detached run uses.
//
// The tick is a plain interval, unref'd so it never keeps the supervisor alive,
// and it is a no-op by default because the store gate is closed by default.
// ---------------------------------------------------------------------------

// Which schedules currently hold a worker, counted from the live map by the
// `scheduleId` that spawnWorker stamped on it. Counted by worker, not by row, so
// a schedule that has been restarted by the backoff rule still occupies its slot.
function inFlightScheduleIds() {
  const ids = new Set();
  for (const w of workers.values()) {
    if (w.scheduleId && w.pid) ids.add(w.scheduleId);
  }
  return ids;
}

// The goal a heartbeat is advancing. Read from the session transcript by the
// SAME loader the foreground resume path uses, so a heartbeat can never see a
// goal state the user's own `ox --resume` would disagree with. A transcript that
// cannot be read yields no goal, which stops a goal-bound heartbeat rather than
// letting it run blind.
function goalForSession(file) {
  if (!file) return null;
  try {
    const rec = loadSessionWithStatus(String(file));
    return rec?.goal ?? null;
  } catch (err) {
    appendLog(`!! heartbeat could not read ${file}: ${err?.message ?? err}`);
    return null;
  }
}

function tickSchedules() {
  if (shuttingDown) return { skipped: true };
  const policy = readPolicy();
  const now = Date.now();
  const due = dueSchedules({ now, policy });
  const outcome = { due: due.length, started: [], deferred: [], missed: [], refused: [] };

  if (!due.length) return outcome;

  // Logged only on the transition, so a daemon with one schedule does not write
  // "opted in" to its log every five seconds.
  if (!scheduleTicked && policy.optedIn) {
    appendLog(`schedule engine ACTIVE — opt-in recorded, maxInFlight ${policy.maxInFlight}`);
    scheduleTicked = true;
  }

  const inflight = inFlightScheduleIds();

  for (const row of due) {
    // The cap is checked per row inside the pass, because a pass that starts a
    // worker consumes a slot for every row after it. `nextRunAt` is deliberately
    // NOT advanced on a deferral, so the row is still due on the next pass: it is
    // backed up, not skipped.
    const verdict = inflightVerdict({ inflight, maxInFlight: policy.maxInFlight, id: row.id });
    if (!verdict.allowed) {
      recordDeferral(row.id, verdict.reason);
      appendLog(`schedule ${row.id} ${verdict.reason}`);
      outcome.deferred.push({ id: row.id, reason: verdict.reason });
      continue;
    }

    const claim = claimSchedule(row.id, { now, policy, trigger: 'tick' });
    if (claim.refusal) {
      appendLog(`!! schedule ${row.id} not dispatched: ${claim.refusal}`);
      outcome.refused.push({ id: row.id, reason: claim.refusal });
      continue;
    }
    if (claim.missed) {
      appendLog(`schedule ${claim.schedule.id} MISSED — ${claim.schedule.lastRun?.note ?? 'not running when due'}`);
      outcome.missed.push({ id: claim.schedule.id });
      continue;
    }

    const rec = claim.schedule;
    const dispatched = dispatchScheduleRun(rec, { policy, trigger: 'tick' });
    if (dispatched.error) {
      appendLog(`!! schedule ${rec.id} not dispatched: ${dispatched.error}`);
      outcome.refused.push({ id: rec.id, reason: dispatched.error });
      continue;
    }
    inflight.add(rec.id);
    outcome.started.push({ id: rec.id, workerId: dispatched.workerId, pid: dispatched.pid });
    appendLog(`schedule ${rec.id} dispatched as worker ${dispatched.workerId} (pid ${dispatched.pid}, cap $${rec.maxCostUsd} ${rec.costCapSource})`);
  }
  return outcome;
}

// Claim -> prompt -> screens -> allowlisted argv -> the ordinary spawn. Shared by
// the tick and by `ox schedule run-now`, so a manual run obeys exactly the same
// safety gates as a timer: the manual path cannot become the way around them.
function dispatchScheduleRun(rec, { policy = readPolicy(), trigger = 'tick', attended = false } = {}) {
  // The daemon-wide opt-in gates UNATTENDED dispatch. An attended claim (see the
  // note on `claimSchedule`) is a human who asked for this one run from a
  // terminal and is about to be shown the outcome; it is still cost-capped, still
  // prompt-screened below, and still cannot set a privilege flag. Everything the
  // tick can do it can do except fire without someone present — which the
  // `scheduleTicked` path never does, because it reads `dueSchedules`, which reads
  // this same policy and knows nothing about `attended`.
  if (!policy.optedIn && !attended) return { error: 'schedules are not opted in for this daemon — `ox schedule opt-in` first' };

  // Second screen, immediately before the run. The first ran at creation; this
  // one is what makes a hand-edited events.jsonl safe to dispatch.
  let prompt = rec.kind === 'heartbeat' ? rec.prompt : buildSchedulePrompt(rec);
  const heartbeatRefusal = screenSchedulePrompt(prompt);
  if (heartbeatRefusal) return { error: `refusing to run: ${heartbeatRefusal}` };

  if (rec.kind === 'heartbeat') {
    const goal = goalForSession(rec.session);
    const decision = heartbeatDecision({ schedule: rec, goal, policy });
    if (decision.action !== HEARTBEAT_DECISIONS.RUN) {
      // A stop is recorded and the schedule disabled, so the next tick does not
      // re-evaluate a terminal condition every five seconds for ever.
      try {
        recordRun(rec.id, { at: Date.now(), state: `stopped:${decision.reason}`, note: `heartbeat stopped: ${decision.reason}` });
      } catch {}
      appendLog(`heartbeat ${rec.id} stopped: ${decision.reason}`);
      return { error: null, stopped: true, reason: decision.reason };
    }
    prompt = buildHeartbeatPrompt({
      schedule: rec,
      goalBlock: goal ? renderGoalBlock(goal) : '',
      next: decision.next,
      budget: decision.budget,
      transcript: rec.session,
    });
    const built = screenSchedulePrompt(prompt);
    if (built) return { error: `refusing to run: ${built}` };
  }

  // The argv is built by the allowlist and then screened by the allowlist: two
  // independent gates that must agree before a worker exists.
  const passthrough = schedulePassthrough(rec);
  const argvVerdict = screenScheduleArgv(passthrough);
  if (!argvVerdict.ok) return { error: `refusing to run: ${argvVerdict.reason}` };

  return startWorker({
    prompt,
    cwd: rec.cwd,
    passthrough,
    bot: rec.bot,
    model: rec.model,
    scheduleId: rec.id,
    scheduleTrigger: trigger,
  });
}

function startScheduleEngine() {
  if (scheduleTimer) return;
  const policy = readPolicy();
  if (!policy.optedIn) {
    appendLog('schedule engine idle — no opt-in recorded; `ox schedule opt-in` to let the daemon dispatch anything');
  }
  scheduleTimer = setInterval(() => {
    try {
      tickSchedules();
    } catch (err) {
      appendLog(`!! the schedule tick threw: ${err?.stack ?? err}`);
    }
  }, SCHEDULE_TICK_MS);
  if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
  // One tick at boot, so a schedule that came due while the daemon was stopped is
  // classified (dispatched or recorded as a miss) at startup rather than a tick
  // later.
  try {
    tickSchedules();
  } catch (err) {
    appendLog(`!! the first schedule tick threw: ${err?.stack ?? err}`);
  }
}

function stopScheduleEngine() {
  if (!scheduleTimer) return;
  clearInterval(scheduleTimer);
  scheduleTimer = null;
  try {
    noteShutdown(dueSchedules({ policy: readPolicy() }).length);
  } catch {}
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

// A worker is stopped when its exit has been OBSERVED, not when a signal has been
// sent. `w.pid` is cleared in exactly one place — handleExit, on the child's exit
// event — so "no worker still holds a pid" is the only trustworthy statement that
// a worker is gone. A signal is a request; on a loaded machine, or against a
// process wedged in a native call, it may not have been delivered yet.
//
// This returns as soon as the last pid clears, so a cooperative worker costs one
// poll interval and not the whole window.
async function waitForWorkersGone(limitMs) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (![...workers.values()].some((w) => w.pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

async function stopAllWorkers({ force = false } = {}) {
  const targets = [...workers.values()].filter((w) => w.pid);
  for (const w of targets) w.stopRequested = true;
  for (const w of targets) {
    try { process.kill(w.pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  // Phase 1 is the wind-down window, and only a cooperative pass gets one:
  // --force asks for the escalation immediately. Phase 2's confirmation is NOT
  // optional in either mode — that is the whole difference between stopping a
  // worker and merely having asked it to stop.
  let escalated = [];
  if (force) {
    escalated = [...workers.values()].filter((w) => w.pid);
    if (escalated.length) {
      appendLog(`!! --force: SIGKILLing ${escalated.length} worker(s) with no grace period`);
    }
  } else {
    await waitForWorkersGone(STOP_GRACE_MS);
    escalated = [...workers.values()].filter((w) => w.pid);
    if (escalated.length) {
      appendLog(`!! ${escalated.length} worker(s) ignored SIGTERM after ${STOP_GRACE_MS}ms; sending SIGKILL`);
    }
  }
  for (const w of escalated) {
    try { process.kill(w.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // Phase 2: CONFIRM. Without this the supervisor exited while a SIGKILLed
  // worker was still running — and because workers are detached, that worker
  // outlived its supervisor as an orphan nothing was left able to find. The
  // 'exit' listeners stay armed on purpose: handleExit is what records the death
  // and logs it, and that log line is the evidence the ordering contract rests on.
  const confirmed = await waitForWorkersGone(STOP_KILL_GRACE_MS);
  const stragglers = [...workers.values()].filter((w) => w.pid);
  if (stragglers.length) {
    appendLog(
      `!! ${stragglers.length} worker(s) STILL ALIVE ${STOP_KILL_GRACE_MS}ms after SIGKILL ` +
      `(${stragglers.map((w) => `${w.id}:${w.pid}`).join(', ')}); recording them as unconfirmed, ` +
      `because erasing their pid here is what makes an orphan unfindable`
    );
  }

  for (const w of workers.values()) {
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  }
  return { stopped: targets.length, killed: escalated.length, unconfirmed: stragglers.length, confirmed };
}

function closeSocketSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  // The pidfile is instance-scoped: a supervisor that is shutting down must not
  // delete the identity of a DIFFERENT daemon that has since taken over.
  try {
    const rec = JSON.parse(fs.readFileSync(pidFilePath(), 'utf8'));
    if (rec?.instanceId === instanceId) fs.unlinkSync(pidFilePath());
  } catch { /* absent, unreadable, or already someone else's */ }
  try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  try { server?.close(); } catch { /* already closing */ }
}

let shutdownPromise = null;
function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    appendLog(`supervisor ${instanceId.slice(0, 8)} (pid ${process.pid}) shutting down: ${reason}`);
    // The timer stops BEFORE the workers: a tick firing into a half-torn-down
    // supervisor is the one interleaving that could claim a schedule it never
    // gets to dispatch.
    stopScheduleEngine();
    const res = await stopAllWorkers({ force: reason === 'forced' });
    for (const w of workers.values()) {
      // A worker whose exit was NOT observed keeps its pid and is recorded as
      // orphaned. Claiming `exited` with a null pid for a process that is still
      // running would destroy the only handle to it: the supervisor is going
      // away, so nothing would be left able to find, report, or reap it.
      if (w.pid) {
        w.state = 'orphaned';
        w.endedAt = null;
        w.giveUpReason = `still alive when the supervisor exited (pid ${w.pid})`;
      } else {
        w.state = 'exited';
        w.endedAt = Date.now();
      }
      w.child = null;
      persist(w);
    }
    cleanupRemnants(instanceId);
    const tail = res.unconfirmed ? `, ${res.unconfirmed} UNCONFIRMED` : '';
    appendLog(`supervisor ${instanceId.slice(0, 8)} stopped cleanly (${res.stopped} worker(s) stopped, ${res.killed} killed${tail})`);
    closeSocketSync();
    process.exit(0);
  })();
  return shutdownPromise;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  ensureDaemonDir();

  // Idempotence, before anything is created: a second `daemon start` (or a
  // supervisor racing one that is still binding) finds the live daemon here and
  // leaves without touching the socket, the pidfile, or any worker.
  const existing = await probeControl({ timeoutMs: 800 });
  if (existing.reachable) {
    process.stdout.write(
      `ox daemon already running (pid ${existing.pid}, instance ${String(existing.instanceId).slice(0, 8)}…)\n`
    );
    process.exit(0);
  }

  // A socket we do not own, in a directory we do not own, is never touched.
  const verdict = screenSocketPath(socketPath);
  if (!verdict.ok) {
    appendLog(`!! refusing to start: ${verdict.reason}`);
    process.stderr.write(`ox: refusing to start the daemon: ${verdict.reason}\n`);
    process.exit(4);
  }
  if (verdict.foreign) {
    appendLog(`!! ${controlSocketPath()} is owned by another user; refusing to touch it`);
    process.stderr.write(`ox: ${controlSocketPath()} is owned by another user — remove it yourself, this process will not\n`);
    process.exit(4);
  }

  server = createIpcServer({
    socketPath,
    sessionId: 'daemon',
    // socketOwnerUid is explicit rather than derived: the reference uid IS the
    // boundary, and stating it here means the check cannot be widened by moving
    // the directory.
    socketOwnerUid: currentUid(),
    meta: { role: 'daemon', instanceId, version: 1, cwd: process.cwd() },
    onRequest: handleControl,
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    // EIPCINUSE means a peer owns the socket. If it is an ox daemon, this
    // process is a redundant twin and exits 0; anything else is a hard failure,
    // because silently taking the socket would orphan a live server.
    if (err?.code === 'EIPCINUSE') {
      const peer = await probeControl({ timeoutMs: 800 });
      if (peer.reachable) {
        process.stdout.write(
          `ox daemon already running (pid ${peer.pid}, instance ${String(peer.instanceId).slice(0, 8)}…)\n`
        );
        process.exit(0);
      }
      const why = `${socketPath} is in use by another program that does not speak the ox daemon protocol`;
      appendLog(`!! cannot start: ${why}`);
      process.stderr.write(`ox: cannot start the daemon: ${why}\n`);
      process.exit(4);
    }
    appendLog(`!! cannot start: ${err?.message ?? err}`);
    process.stderr.write(`ox: cannot start the daemon: ${err?.message ?? err}\n`);
    process.exit(4);
    return;
  }

  // Close the 0755 window immediately after the bind.
  hardenSocket(socketPath);

  // The pidfile last: until this line there is no pid on disk to be recycled,
  // misread, or raced against.
  writePidFile({
    pid: process.pid,
    instanceId,
    startedAt,
    socketPath,
    version: 1,
    home: os.homedir(),
    cwd: process.cwd(),
  });

  appendLog(`supervisor ${instanceId.slice(0, 8)} (pid ${process.pid}) started; control socket ${socketPath}`);
  process.stdout.write(
    JSON.stringify({ type: 'daemon-ready', instanceId, pid: process.pid, socketPath, startedAt }) + '\n'
  );

  // Started LAST: every path above can still exit, and an engine that dispatched
  // against a pidfile that does not exist yet would be reporting under a daemon
  // nobody can find.
  startScheduleEngine();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { shutdown(sig); });
  }
  process.on('exit', closeSocketSync);
  process.on('uncaughtException', (err) => {
    appendLog(`!! uncaught exception in the supervisor: ${err?.stack ?? err}`);
    shutdown('uncaught exception');
  });
  process.on('unhandledRejection', (err) => {
    appendLog(`!! unhandled rejection in the supervisor: ${err?.stack ?? err}`);
    shutdown('unhandled rejection');
  });
}

// The server keeps the event loop alive for the daemon's whole life, which is
// exactly the lifetime we want: no work to do, no exit.
main().catch((err) => {
  appendLog(`!! the supervisor failed to start: ${err?.stack ?? err}`);
  try { closeSocketSync(); } catch {}
  process.stderr.write(`ox: daemon failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});

export { handleControl, spawnWorker, handleExit, instanceId as _instanceId, MAX_WORKERS as _maxWorkers };
