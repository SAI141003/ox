// DAEMON CONTINUITY — the supervisor library.
//
// ox already had every primitive a daemon needs: a unix-socket transport with an
// out-of-band approval bridge (src/ipc.js), append-only JSONL transcripts
// (src/session.js), and the `-p` run path (src/headless.js). What it did NOT
// have was anything that outlives a terminal. A `-p` run dies with its
// terminal; a REPL dies with its terminal; there was no way to say "keep going
// and I will come back" because there was no process whose job is to keep going.
//
// This file is the library half of that. The model, unchanged from Prime
// Agent's daemon and for the same reason it is the right model here:
//
//   THE DAEMON IS A SUPERVISOR, NOT A HOST. It spawns one worker PROCESS per
//   active session instead of hosting sessions in-process. Workers are
//   supervised, restarted with backoff, and every session's durable record is
//   the append-only JSONL on disk — so reattaching works even when the
//   supervisor itself is the thing that died and restarted.
//
// Three properties decide whether that model is honest, and they are what this
// file is actually about:
//
//   1. A PIDFILE IS NOT PROOF OF LIFE. PIDs are recycled. A pidfile from a
//      crashed daemon names a pid that will eventually belong to something else,
//      and "is the pid alive" cannot tell the two apart. So every claim of
//      liveness here is `pid alive AND the control socket answers AND the
//      instance id the socket reports is the one in the pidfile`. Signal() is
//      only ever sent to a process that passed all three. A recycled pid is
//      therefore reported as a stale remnant, not adopted and never signalled.
//
//   2. THE CONTROL SOCKET IS A PRIVILEGE BOUNDARY. It can start agents that
//      execute code with the supervisor's environment. So it lives in a 0700
//      directory, is chmod 0600 the instant it is bound, and every path found
//      there is ownership-screened before it is trusted: right directory, right
//      owner, no group/other bits. An entry owned by another uid is refused,
//      not probed and not unlinked (both are acts on someone else's resource).
//
//   3. A DESCRIPTOR IS AN INTENT; A LIVE MAP IS A FACT. This is the rule
//      src/subagent-registry.js already established for in-process subagents,
//      applied to processes. A worker record on disk says a run was started; it
//      does not say one is running now. `ox agents` reads liveness from the
//      supervisor's live map, cross-checked against the OS, and labels
//      everything else idle or stale rather than letting a dead run look busy.
//
// Nothing here weakens an approval or a sandbox. The worker runs the ordinary
// `-p` path; its socket is the existing ipc.js bridge, so the approval path is
// literally the same fail-closed one `ox --ipc` already runs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectIpcClient } from './ipc.js';
import { listSessions } from './session.js';

export const DAEMON_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUPERVISOR_ENTRY = path.join(HERE, 'daemon-supervisor.js');
export const WORKER_ENTRY = path.join(HERE, 'daemon-worker.js');
export const OX_BIN = path.resolve(HERE, '..', 'bin', 'ox.js');

// macOS caps a unix socket path at 104 bytes (sun_path). Long paths fail with a
// baffling bind error, so the limit is named here instead of discovered.
export const SUN_PATH_MAX = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long a poller waits for one answer. Short on purpose: see inspectDaemon.
const POLL_PROBE_TIMEOUT_MS = 400;

// ---------------------------------------------------------------------------
// Paths. Resolved lazily, never cached at import time: the supervisor, the CLI
// and the test harness must all agree, and a cached value computed at import
// time would be computed against whatever HOME existed when the module loaded.
// OX_DAEMON_DIR exists for the same reason the tests need a short socket path:
// a sandboxed HOME under a long TMPDIR can push a socket past sun_path.
// ---------------------------------------------------------------------------

export function daemonDir() {
  const override = process.env.OX_DAEMON_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.ox', 'daemon');
}

export const controlSocketPath = () => path.join(daemonDir(), 'c.sock');
export const pidFilePath = () => path.join(daemonDir(), 'daemon.json');
export const daemonLogPath = () => path.join(daemonDir(), 'daemon.log');
export const startLockPath = () => path.join(daemonDir(), 'start.lock');
export const workerLogDir = () => path.join(daemonDir(), 'logs');
export const workerLogPath = (id) => path.join(workerLogDir(), `${safeId(id)}.log`);

export function workerRecordPath(id) {
  return path.join(daemonDir(), `${safeId(id)}.json`);
}

// ---------------------------------------------------------------------------
// Schedules and heartbeats live INSIDE the daemon directory, not in a system
// crontab. Three reasons, all of them load-bearing:
//
//   1. The supervisor is already the privilege boundary for unattended execution
//      (0700 dir, 0600 socket, an ownership screen on every path). A schedule
//      that re-enters a session must go through that boundary; a crontab entry
//      bypasses it completely and runs with whatever environment the OS hands
//      it, with nothing to screen and nothing to cap.
//   2. It is cross-platform. `crontab` does not exist on macOS without extra
//      packages, and launchd plists are macOS-only. One code path, both systems.
//   3. It is visible. A crontab entry is invisible state that outlives ox being
//      uninstalled. An entry in this directory is listed by `ox schedule list`,
//      removed by `ox schedule remove`, and gone with `ox schedule remove-all`.
//
// So these paths are the whole schedule store, and they are deliberately a
// subdirectory of the daemon dir rather than a sibling: a schedule is daemon
// state, and it inherits the directory's 0700 mode rather than needing its own
// ownership screen.
// ---------------------------------------------------------------------------

export const scheduleDir = () => path.join(daemonDir(), 'schedules');
// Append-only event log, one JSON object per line. Compacted into a `snapshot`
// event set once it outgrows SCHEDULE_COMPACT_AT lines.
export const scheduleEventsPath = () => path.join(scheduleDir(), 'events.jsonl');
// The daemon-wide opt-in stamp. Absent file == NOT opted in, so a fresh install
// cannot run anything unattended no matter what is in the event log.
export const schedulePolicyPath = () => path.join(scheduleDir(), 'policy.json');

export function ensureScheduleDir({ mode = 0o700 } = {}) {
  ensureDaemonDir({ mode });
  const dir = scheduleDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  try {
    fs.chmodSync(dir, mode);
  } catch (err) {
    if (err?.code !== 'EPERM' && err?.code !== 'ENOENT') throw err;
  }
  return dir;
}

// Worker ids land in file names, socket paths and log paths. Sanitize rather
// than trust: an id is generated here, but it also arrives from the wire.
export function safeId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  if (!s || s === '.' || s === '..') throw new Error('ox: invalid daemon id');
  return s;
}

export function newWorkerId() {
  return `w-${crypto.randomBytes(4).toString('hex')}`;
}

export function workerSocketPath(id) {
  return path.join(daemonDir(), `${safeId(id)}.sock`);
}

// ---------------------------------------------------------------------------
// The directory and the socket: ownership and permission screen.
//
// A socket file is a capability. Binding one with the default umask leaves it
// 0755, i.e. every local user can connect and — on this daemon — start an agent
// that runs code. So the directory is 0700 and the socket is chmod 0600 the
// moment the bind completes (and the supervisor additionally drops its umask
// before binding, so there is no window where the wrong mode exists).
// ---------------------------------------------------------------------------

export function currentUid() {
  try {
    return os.userInfo().uid;
  } catch {
    return -1;
  }
}

// Create the daemon dir with 0700 and verify it afterwards. `mode` is the
// desired mode; anything group- or other-readable is a finding, not a detail.
export function ensureDaemonDir({ mode = 0o700, create = true } = {}) {
  const dir = daemonDir();
  if (create) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    // mkdirSync's mode is masked by umask, and an existing dir keeps whatever it
    // had. chmod is the only way to actually land the mode.
    try {
      fs.chmodSync(dir, mode);
    } catch (err) {
      if (err?.code !== 'EPERM' && err?.code !== 'ENOENT') throw err;
    }
  }
  return inspectDir(dir);
}

export function inspectDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    return { exists: false, path: dir, problem: err?.code === 'ENOENT' ? 'absent' : 'unreadable', detail: String(err?.code ?? err) };
  }
  if (!st.isDirectory()) return { exists: true, path: dir, problem: 'not-a-directory', mode: st.mode & 0o777, uid: st.uid };
  const mode = st.mode & 0o777;
  const uid = currentUid();
  const foreign = uid >= 0 && st.uid !== uid;
  return {
    exists: true,
    path: dir,
    dir: true,
    mode,
    uid: st.uid,
    foreign,
    // A group- or other-accessible directory means the socket inside it is not
    // the boundary it pretends to be.
    tooOpen: (mode & 0o077) !== 0,
    problem: foreign ? 'foreign-owner' : (mode & 0o077) !== 0 ? 'too-open' : null,
  };
}

// The screen every socket path passes before it is connected to or removed.
// Fail-closed by construction: an entry we do not own, or one inside a
// directory we do not own exclusively, is refused with a reason.
export function screenSocketPath(socketPath, { mustExist = false } = {}) {
  // Length first: a path past sun_path can never bind, and "too long" is the
  // actionable answer. Asking the filesystem about it first would answer
  // "directory absent", which is true and useless.
  if (String(socketPath).length > SUN_PATH_MAX) {
    return { ok: false, reason: `socket path is ${String(socketPath).length} bytes, over the ${SUN_PATH_MAX}-byte unix socket limit` };
  }
  const dir = inspectDir(path.dirname(path.resolve(String(socketPath))));
  if (!dir.exists) return { ok: false, reason: `directory ${dir.path} is ${dir.problem}` };
  if (dir.problem === 'not-a-directory') return { ok: false, reason: `${dir.path} is not a directory` };
  if (dir.foreign) return { ok: false, reason: `${dir.path} is owned by uid ${dir.uid}, not ${currentUid()}` };
  if (dir.tooOpen) return { ok: false, reason: `${dir.path} is mode ${dir.mode.toString(8).padStart(4, '0')} (group/other accessible)` };
  let st = null;
  try {
    st = fs.lstatSync(socketPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return mustExist ? { ok: false, reason: `${socketPath} does not exist` } : { ok: true, exists: false, stat: null };
    }
    return { ok: false, reason: `${socketPath} is unreadable (${err?.code ?? err})` };
  }
  const uid = currentUid();
  if (uid >= 0 && st.uid !== uid) {
    return { ok: false, reason: `${socketPath} is owned by uid ${st.uid}, not ${uid}`, foreign: true, stat: st };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: `${socketPath} is a symlink`, foreign: true, stat: st };
  const mode = st.mode & 0o777;
  const tooOpen = (mode & 0o077) !== 0;
  return { ok: true, exists: true, stat: st, socket: st.isSocket(), mode, tooOpen, dir };
}

// Tighten a bound socket. Called the moment 'listening' fires, so the window in
// which a 0755 inode exists is a single tick rather than the daemon's lifetime.
export function hardenSocket(socketPath) {
  try {
    fs.chmodSync(socketPath, 0o600);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The pidfile, and the identity that makes it mean something.
// ---------------------------------------------------------------------------

export function newInstanceId() {
  return crypto.randomBytes(16).toString('hex');
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to somebody else: alive, and
    // emphatically not ours to signal.
    return err?.code === 'EPERM';
  }
}

export function readPidFile() {
  const file = pidFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { present: false, valid: false, record: null, problem: err?.code === 'ENOENT' ? 'absent' : 'unreadable', detail: String(err?.code ?? err) };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { present: true, valid: false, record: null, problem: 'corrupt', detail: 'pidfile is not JSON' };
  }
  if (!record || typeof record !== 'object' || !Number.isInteger(Number(record.pid)) || !record.instanceId) {
    return { present: true, valid: false, record: null, problem: 'incomplete', detail: 'pidfile has no usable pid + instanceId' };
  }
  return { present: true, valid: true, record, problem: null, detail: null };
}

// Written temp-then-rename so a reader never observes a half-written record: a
// truncated pidfile is a daemon that cannot be found, which is a much worse
// failure than a pidfile that is briefly one rename old.
export function writePidFile(record) {
  ensureDaemonDir();
  const file = pidFilePath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...record, version: DAEMON_VERSION }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}

// Clearing is instance-scoped on purpose. A `stop` must never delete a pidfile
// belonging to a DIFFERENT daemon than the one it just talked to — that is how a
// second supervisor's identity gets erased by a first one's cleanup.
export function clearPidFile({ expectInstanceId = null } = {}) {
  const file = pidFilePath();
  const read = readPidFile();
  if (!read.present) return { cleared: false, reason: 'absent' };
  if (expectInstanceId && read.record?.instanceId !== expectInstanceId) {
    return { cleared: false, reason: 'instance-mismatch', record: read.record };
  }
  try {
    fs.unlinkSync(file);
    return { cleared: true };
  } catch (err) {
    return { cleared: false, reason: String(err?.code ?? err) };
  }
}

export function appendLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    ensureDaemonDir();
    const file = daemonLogPath();
    // Bounded by rotation, not by truncation: the previous generation is kept so
    // a crash that spammed the log still leaves its earliest lines readable.
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
  return line;
}

export function readLog(lines = 40) {
  let text = '';
  try {
    text = fs.readFileSync(daemonLogPath(), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim()).slice(-lines);
}

// ---------------------------------------------------------------------------
// The control protocol.
//
// One request shape, one reply shape, on the existing ipc.js framing:
//   -> { type:'control', id, op, args }
//   <- { type:'control-reply', id, ok, result } | { ..., ok:false, error }
// The instance id lives in the server's `hello` frame, so it is available before
// any request is answered — which is what makes the identity check possible on a
// pidfile whose pid happens to be alive.
// ---------------------------------------------------------------------------

// `schedule-run` is here, and not on a side channel, so that EVERY worker the
// supervisor starts goes through `handleControl` — including one a schedule or a
// `run-now` asked for. A control op is the only way to make a worker exist, which
// means there is exactly one place where the screens in src/schedule.js are
// applied and exactly one audit trail.
export const CONTROL_OPS = Object.freeze([
  'ping', 'status', 'list', 'start', 'stop-worker', 'session-info', 'worker-ready', 'worker-status', 'schedule-run', 'shutdown',
]);

const DEFAULT_CONTROL_TIMEOUT_MS = 4000;

// One request/response round trip. Never rejects for a transport problem: the
// caller gets { ok:false, error } and decides, because "the daemon is not there"
// is an ordinary answer here, not an exception.
export function controlRequest(op, args = {}, { timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS, clientId = null, screen = true } = {}) {
  const socketPath = controlSocketPath();
  if (screen) {
    const verdict = screenSocketPath(socketPath, { mustExist: true });
    if (!verdict.ok) return Promise.resolve({ ok: false, error: verdict.reason, unreachable: true, screened: true });
  }
  return new Promise((resolve) => {
    const client = connectIpcClient({
      socketPath,
      clientId: clientId ?? `ox-cli-${process.pid}`,
      // The daemon is a local process; a request that has not been answered in a
      // few hundred ms will not be answered at all, and every caller of this
      // function is on a user-visible code path.
      connectTimeoutMs: Math.min(timeoutMs, 750),
    });
    let settled = false;
    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `control '${op}' timed out after ${timeoutMs}ms`, unreachable: true }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    client.on('message', (msg) => {
      if (msg?.type !== 'control-reply' || msg.id !== id) return;
      finish(msg);
    });
    client.on('error', (err) => finish({ ok: false, error: String(err?.message ?? err), unreachable: true }));
    client.on('close', ({ reason }) => finish({ ok: false, error: `control socket closed (${reason})`, unreachable: true }));
    client.on('open', () => {
      if (!client.send({ type: 'control', id, op, args })) {
        finish({ ok: false, error: 'could not write the control request' });
      }
    });
  });
}

// The liveness probe. Returns what the socket says about itself, and nothing is
// inferred: if the socket does not answer, the answer is "not reachable" no
// matter how alive the pid in the pidfile is.
//
// WHY it did not answer matters as much as the fact. A missing socket or a
// refused connection is PROOF the daemon is gone; a timeout is only an absence
// of evidence, and on a loaded machine a perfectly healthy supervisor can miss a
// short deadline. `kind` separates the two, because the difference decides
// whether `doctor --fix` is allowed to delete a pidfile — deleting the paperwork
// of a daemon that is still running is how a live supervisor becomes
// unreachable for ever.
export async function probeControl({ timeoutMs = 3000 } = {}) {
  const socketPath = controlSocketPath();
  const verdict = screenSocketPath(socketPath);
  if (!verdict.ok) return { reachable: false, instanceId: null, pid: null, reason: verdict.reason, kind: 'screened' };
  if (!verdict.exists) return { reachable: false, instanceId: null, pid: null, reason: 'no control socket', kind: 'absent' };
  if (verdict.tooOpen) {
    return {
      reachable: false,
      instanceId: null,
      pid: null,
      reason: `control socket is mode ${verdict.mode.toString(8).padStart(4, '0')} (group/other accessible)`,
      kind: 'screened',
    };
  }
  // The connect budget is generous on purpose: it is a local socket, so the only
  // way to miss it is a machine too busy to run a supervisor's event loop.
  const res = await controlRequest('status', {}, { timeoutMs });
  if (res.ok) return { reachable: true, instanceId: res.result?.instanceId ?? null, pid: res.result?.pid ?? null, info: res.result, kind: 'ok' };
  // Why it failed, precisely. A refused connection is PROOF there is no listener:
  // a live supervisor holds this socket open for its whole life, so a refusal is
  // the kernel telling us the inode is a crash remnant. A timeout is only an
  // absence of evidence, and a refusal must never be lumped in with it — that
  // lumping is what stops `doctor --fix` from cleaning up after a crash.
  const why = String(res.error ?? '');
  const kind = /timed out|timeout/i.test(why)
    ? 'timeout'
    : /refused|enoent|no such file/i.test(why)
      ? 'refused'
      : 'error';
  return { reachable: false, instanceId: null, pid: null, reason: why, kind };
}

// 'certain' means the evidence PROVES there is no daemon (its socket is gone or
// refuses connections). Anything else is an absence of evidence, and destructive
// cleanup must not act on it.
export function probeConfidence(probe) {
  return probe?.kind === 'absent' || probe?.kind === 'refused' || probe?.kind === 'screened'
    ? 'certain'
    : 'uncertain';
}

// ---------------------------------------------------------------------------
// inspectDaemon — the ONE liveness decision every surface reads.
//
// The ORDER OF EVIDENCE is the whole design, so it is worth stating plainly:
//
//   THE SOCKET IS THE AUTHORITY; THE PIDFILE IS DISCOVERY.
//
// The control socket carries the instance id in its hello frame and the live pid
// in every reply, and it is reachable only through a 0600 inode in a 0700
// directory that we own. The pidfile is a file that can be lost, truncated,
// deleted by a stray `rm`, or pointed at the wrong pid by anything that can write
// to our own home directory. So a daemon that ANSWERS is alive, full stop — and
// a pidfile that disagrees with it is a broken pidfile, not a phantom daemon.
//
// Three states, because collapsing them is what produces both halves of the
// classic bug:
//
//   running   the socket answers and the pidfile agrees with it.
//   degraded  the socket answers and the pidfile is missing, unusable, or names
//             a different instance / a dead pid. The daemon is LIVE and is
//             reachable and stoppable; what is broken is the file. `doctor --fix`
//             rewrites it from the daemon's own report.
//   stopped   the socket does not answer. Here — and only here — the pidfile is
//             consulted, and it can never establish liveness on its own:
//               * pid gone          -> it crashed or was killed
//               * pid alive, no
//                 socket answering -> a RECYCLED PID. Never signalled, never
//                                      adopted. This is the case the whole
//                                      instance-id scheme exists for.
//
// Note what `degraded` must NOT collapse into `stopped`: reporting a live,
// serving supervisor as stopped leaves it unkillable and its workers
// unsupervised for ever, and `shutdown --force` would clean up the pidfile and
// socket out from under it — leaving a process nothing can ever reach again.
// ---------------------------------------------------------------------------

// `probeTimeoutMs` exists for POLLERS, not for humans. A one-shot command
// (`status`, `doctor`, `agents`) wants the generous default, because a definitive
// answer is worth waiting for. A loop that polls every 60ms wants a fast NEGATIVE
// — what it is waiting for is a supervisor that has not finished booting yet, and
// a multi-second timeout per iteration burns the loop's entire deadline answering
// "not yet" over and over.
export async function inspectDaemon({ probe = true, probeTimeoutMs = null } = {}) {
  const dir = inspectDir(daemonDir());
  const pidfile = readPidFile();
  const socket = probe
    ? await probeControl(probeTimeoutMs ? { timeoutMs: probeTimeoutMs } : {})
    : { reachable: false, instanceId: null, pid: null, reason: 'probe skipped', kind: 'skipped' };

  let state = 'stopped';
  let reason;
  if (socket.reachable) {
    const rec = pidfile.valid ? pidfile.record : null;
    if (!rec) {
      state = 'degraded';
      reason = `the daemon is serving on ${controlSocketPath()} but its pidfile is ${pidfile.present ? `${pidfile.problem}` : 'missing'}`;
    } else if (rec.instanceId !== socket.instanceId) {
      state = 'degraded';
      reason = `the daemon is serving on ${controlSocketPath()} as instance ${String(socket.instanceId).slice(0, 8)}…, but the pidfile claims instance ${String(rec.instanceId).slice(0, 8)}…`;
    } else if (!pidAlive(rec.pid)) {
      state = 'degraded';
      reason = `the daemon is serving as instance ${String(socket.instanceId).slice(0, 8)}…, but the pidfile names pid ${rec.pid}, which is gone`;
    } else {
      state = 'running';
      reason = null;
    }
  } else {
    state = 'stopped';
    if (!pidfile.present) {
      reason = 'no daemon pidfile';
    } else if (!pidfile.valid) {
      reason = `pidfile is unusable (${pidfile.problem}${pidfile.detail ? `: ${pidfile.detail}` : ''})`;
    } else if (!pidAlive(pidfile.record.pid)) {
      reason = `pid ${pidfile.record.pid} is gone (the daemon crashed or was killed)`;
    } else if (probeConfidence(socket) === 'certain') {
      // Alive, and its socket is definitively gone or refuses us. That is proof
      // this pid is not our daemon: a recycled pid, and never to be signalled.
      reason = `pid ${pidfile.record.pid} is alive but the control socket does not answer (${socket.reason}) — a recycled pid, not this daemon`;
    } else {
      // A timeout is not proof. Saying "recycled" here would be a guess, and
      // guessing wrong in this direction is expensive: the pidfile repair paths
      // read this sentence.
      reason = `pid ${pidfile.record.pid} is alive but the daemon's state could not be confirmed (${socket.reason}) — treating it as UNKNOWN, not as running and not as dead`;
    }
  }

  const info = socket.reachable ? socket.info : null;
  const live = state === 'running' || state === 'degraded';
  return {
    state,
    // `live` is the one flag a caller should branch on to mean "there is a
    // supervisor you may talk to"; `state` says whether its paperwork agrees.
    live,
    reason,
    dir,
    socketPath: controlSocketPath(),
    // The pid comes from the SOCKET whenever it answers, never from the pidfile,
    // so a signal can never be aimed at a pid the pidfile made up.
    pid: live ? (socket.pid ?? (pidfile.valid ? pidfile.record.pid : null)) : null,
    instanceId: live ? (socket.instanceId ?? (pidfile.valid ? pidfile.record.instanceId : null)) : null,
    startedAt: live ? (info?.startedAt ?? (pidfile.valid ? pidfile.record.startedAt : null)) : null,
    uptimeMs: live ? Date.now() - Number(info?.startedAt ?? pidfile.record?.startedAt ?? Date.now()) : 0,
    pidfile,
    socket: {
      path: controlSocketPath(),
      reachable: socket.reachable,
      reason: socket.reason,
      kind: socket.kind ?? null,
      // 'certain' only when the socket file is absent or refused. A probe that
      // merely timed out leaves the daemon's state UNKNOWN.
      confidence: socket.reachable ? 'certain' : probeConfidence(socket),
      instanceId: socket.instanceId,
      exists: dir.exists,
    },
    workers: Array.isArray(info?.workers) ? info.workers : [],
    version: info?.version ?? null,
  };
}

// ---------------------------------------------------------------------------
// Start / stop.
// ---------------------------------------------------------------------------

// A cross-process mutex for `daemon start`, so N concurrent invocations cause
// exactly one spawn. O_EXCL creation is atomic on every filesystem ox runs on;
// the age steal only matters if the winner died holding it, which the pidfile
// check below would catch anyway.
export function takeStartLock({ staleMs = 15000 } = {}) {
  ensureDaemonDir();
  const lock = startLockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return { held: true, path: lock };
    } catch (err) {
      if (err?.code !== 'EEXIST') return { held: false, path: lock, reason: String(err?.code ?? err) };
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {}
      if (age < staleMs) return { held: false, path: lock, reason: 'held' };
      try { fs.unlinkSync(lock); } catch {}
    }
  }
  return { held: false, path: lock, reason: 'held' };
}

export function releaseStartLock(lock) {
  if (!lock?.held) return false;
  try {
    fs.unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  }
}

function spawnSupervisor(env) {
  const child = spawn(process.execPath, [SUPERVISOR_ENTRY], {
    // detached + unref is the whole of "outlives the terminal": the supervisor
    // gets its own process group and stdio, and nothing in this process holds a
    // handle that would keep it from surviving us.
    detached: true,
    stdio: 'ignore',
    env: { ...env, OX_NO_BANNER: '1' },
  });
  child.unref();
  return child;
}

// Idempotent. Two callers racing produce one supervisor: the lock serializes the
// spawn, and the second caller finds the daemon already up. The supervisor
// itself is idempotent too (it refuses to bind a socket another one owns), so
// even a stolen lock cannot produce two.
export async function startDaemon({ env = process.env, waitMs = 8000, already = null } = {}) {
  const before = already ?? (await inspectDaemon());
  if (before.live) {
    // A degraded daemon is running with broken paperwork. Repair the pidfile
    // from the daemon's OWN report rather than reporting "already running" and
    // leaving it un-repairable, and rather than trying to start a second one.
    if (before.state === 'degraded') {
      const repaired = repairPidFileFromSocket(before);
      if (repaired) return { started: false, reason: 'repaired-pidfile', daemon: before };
    }
    return { started: false, reason: 'already-running', daemon: before };
  }
  ensureDaemonDir();
  const lock = takeStartLock();
  try {
    const second = await inspectDaemon({ probeTimeoutMs: POLL_PROBE_TIMEOUT_MS });
    if (second.live) return { started: false, reason: 'already-running', daemon: second };

    if (pidfileRemnant(second) && second.socket.confidence === 'certain') await clearStaleRemnants(second);

    const child = spawnSupervisor(env);
    const deadline = Date.now() + waitMs;
    let daemon = second;
    while (Date.now() < deadline) {
      await sleep(60);
      daemon = await inspectDaemon({ probeTimeoutMs: POLL_PROBE_TIMEOUT_MS });
      // `live`, not `running`: the supervisor binds its socket a moment BEFORE
      // it writes its pidfile, so a poller that only accepts `running` sits
      // through the window and then has to time out. A socket that answers is
      // the daemon, whatever its paperwork is doing.
      if (daemon.live) break;
      if (child.exitCode !== null) break;
    }
    if (daemon.live) {
      return { started: true, reason: lock.held ? 'started' : 'started-by-peer', daemon };
    }
    return { started: false, reason: 'did-not-come-up', daemon };
  } finally {
    releaseStartLock(lock);
  }
}

// Rewrite a wrong pidfile from the live daemon's own report. The daemon is the
// authority on who it is; the pidfile is just the note we left about it.
export function repairPidFileFromSocket(snap) {
  const rec = snap?.pidfile?.record ?? null;
  if (!snap?.live || !snap.instanceId) return false;
  if (rec && rec.instanceId === snap.instanceId && pidAlive(rec.pid)) return false;
  try {
    writePidFile({
      pid: snap.pid,
      instanceId: snap.instanceId,
      startedAt: snap.startedAt ?? Date.now(),
      socketPath: snap.socketPath,
      version: snap.version ?? DAEMON_VERSION,
      home: os.homedir(),
      cwd: process.cwd(),
    });
    appendLog(`pidfile repaired from the live daemon (pid ${snap.pid}, instance ${String(snap.instanceId).slice(0, 8)}…)`);
    return true;
  } catch {
    return false;
  }
}

// A pidfile or socket left by a daemon that is provably not running. Called
// before a fresh supervisor binds, because ipc.js's stale probe would otherwise
// race two daemons for the same path.
function pidfileRemnant(snap) {
  if (snap.pidfile.present && snap.pidfile.valid) return true;
  return snap.dir.exists;
}

async function clearStaleRemnants(snap) {
  const out = [];
  // Nothing is removed on uncertain evidence. A probe that timed out leaves a
  // healthy daemon indistinguishable from a dead one, and deleting a live
  // daemon's pidfile and socket is unrecoverable-by-accident: the process keeps
  // running with nothing able to reach it.
  if (snap.socket.confidence !== 'certain') {
    return [{ what: 'none', cleared: false, reason: `the daemon's state is unknown (${snap.socket.reason}); nothing removed` }];
  }
  if (snap.pidfile.present && !snap.live) {
    out.push({ what: 'pidfile', ...clearPidFile() });
  }
  if (snap.dir.exists && !snap.socket.reachable) {
    try {
      fs.unlinkSync(controlSocketPath());
      out.push({ what: 'socket', cleared: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') out.push({ what: 'socket', cleared: false, reason: String(err?.code ?? err) });
    }
  }
  return out;
}

// Stop. The escalation is the point: workers first, supervisor second, and
// `--force` skips the polite pass entirely. Nothing is ever signalled unless the
// full liveness check passed, so a stop can never take down a recycled pid.
export async function stopDaemon({ force = false, timeoutMs = 6000, kill = true } = {}) {
  const snap = await inspectDaemon();
  // `live`, not `state === 'running'`: a daemon whose pidfile has gone wrong is
  // still serving, still holding workers, and must still be stoppable. Only the
  // socket establishes that.
  if (!snap.live) {
    const remnants = await clearStaleRemnants(snap);
    return { stopped: false, reason: snap.reason ?? 'not running', remnants, daemon: snap };
  }
  const instanceId = snap.instanceId;
  const pid = snap.pid;

  if (!force) {
    const res = await controlRequest('shutdown', { force: false }, { timeoutMs });
    if (res.ok) {
      const gone = await waitForExit(instanceId, pid, timeoutMs);
      if (gone) return { stopped: true, reason: 'graceful', daemon: snap };
    }
  }

  if (kill) {
    // Only ever a pid that answered as THIS instance.
    try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {}
    const gone = await waitForExit(instanceId, pid, Math.min(timeoutMs, 3000), 0);
    if (gone) {
      cleanupRemnants(instanceId);
      return { stopped: true, reason: force ? 'killed' : 'signalled', daemon: snap };
    }
    return { stopped: false, reason: 'still-running', daemon: snap };
  }
  return { stopped: false, reason: 'kill-disabled', daemon: snap };
}

async function waitForExit(instanceId, pid, timeoutMs, graceMs = 0) {
  if (graceMs) await sleep(graceMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // No probe here: the caller already established the identity, and this loop
    // is watching for the process to go away, not deciding what is running.
    const snap = await inspectDaemon({ probe: false });
    if (snap.state === 'running' && snap.instanceId === instanceId && snap.pid === pid) {
      await sleep(80);
      continue;
    }
    if (!pidAlive(pid)) return true;
    await sleep(80);
  }
  return !pidAlive(pid);
}

export function cleanupRemnants(instanceId) {
  const out = [];
  out.push({ what: 'pidfile', ...clearPidFile({ expectInstanceId: instanceId }) });
  try {
    fs.unlinkSync(controlSocketPath());
    out.push({ what: 'socket', cleared: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') out.push({ what: 'socket', cleared: false, reason: String(err?.code ?? err) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Worker records. The supervisor is the ONLY writer: one writer means no lost
// update between "spawned" and "wrote the transcript".
// ---------------------------------------------------------------------------

export function readWorkerRecord(id) {
  try {
    const rec = JSON.parse(fs.readFileSync(workerRecordPath(id), 'utf8'));
    if (!rec || typeof rec !== 'object') return null;
    return rec;
  } catch {
    return null;
  }
}

export function writeWorkerRecord(rec) {
  ensureDaemonDir();
  const file = workerRecordPath(rec.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return rec;
}

export function removeWorkerRecord(id) {
  try {
    fs.unlinkSync(workerRecordPath(id));
    return true;
  } catch {
    return false;
  }
}

export function listWorkerRecords() {
  let names;
  try {
    names = fs.readdirSync(daemonDir());
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n === 'daemon.json') continue;
    const rec = readWorkerRecord(n.replace(/\.json$/, ''));
    if (rec?.id) out.push(rec);
  }
  return out.sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0));
}

// ---------------------------------------------------------------------------
// Restart policy.
//
// A crashed worker is restarted, because a daemon that does not restart anything
// is not supervising. A hot loop is worse than no restart, so three things bound
// it: the delay grows geometrically, it is capped, and the attempt COUNT is
// capped — after which the supervisor gives up LOUDLY (log line + a record whose
// state says so) rather than retrying a doomed worker forever. Every worker also
// gets a fresh attempt budget, so one bad session cannot consume the daemon's.
// ---------------------------------------------------------------------------

export const BACKOFF_DEFAULTS = Object.freeze({ baseMs: 500, factor: 2, capMs: 15000, jitter: 0.2, maxAttempts: 5 });

export function backoffSettings(env = process.env) {
  const num = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const settings = {
    baseMs: num('OX_DAEMON_BACKOFF_BASE_MS', BACKOFF_DEFAULTS.baseMs),
    factor: num('OX_DAEMON_BACKOFF_FACTOR', BACKOFF_DEFAULTS.factor),
    capMs: num('OX_DAEMON_BACKOFF_CAP_MS', BACKOFF_DEFAULTS.capMs),
    jitter: BACKOFF_DEFAULTS.jitter,
    maxAttempts: Math.max(1, Math.floor(num('OX_DAEMON_MAX_ATTEMPTS', BACKOFF_DEFAULTS.maxAttempts))),
  };
  return settings;
}

// `attempt` is 1-based: the delay before the first restart is `baseMs`.
export function backoffDelayMs(attempt, { baseMs = BACKOFF_DEFAULTS.baseMs, factor = BACKOFF_DEFAULTS.factor, capMs = BACKOFF_DEFAULTS.capMs, jitter = BACKOFF_DEFAULTS.jitter, rand = Math.random } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = Math.min(capMs, baseMs * Math.pow(factor, n - 1));
  const spread = 1 + (Number(rand()) * 2 - 1) * jitter;
  return Math.max(0, Math.round(raw * spread));
}

// ---------------------------------------------------------------------------
// agentsSnapshot — running / idle / saved.
//
// The split mirrors Prime Agent's, and the reason for the split is the same one
// src/subagent-registry.js argues: a descriptor is a durable record of an
// INTENT, and only a live map is a fact about now.
//
//   running  a live worker: the supervisor holds it AND the OS says its pid is
//            alive. Requires a reachable supervisor; with no supervisor there
//            can be no running worker, however alive the recorded pid is.
//   idle     a worker record whose process is gone (crashed, finished, or the
//            supervisor with it). The session is resumable; nothing is working.
//   saved    a transcript on disk that no worker record claims. A conversation
//            that outlived every process that wrote it.
// ---------------------------------------------------------------------------

export async function agentsSnapshot({ cwd = process.cwd(), savedLimit = 20, includeSaved = true } = {}) {
  const daemon = await inspectDaemon();
  const records = listWorkerRecords();
  const live = new Map();
  for (const w of daemon.workers) live.set(String(w.id), w);

  const running = [];
  const idle = [];
  const claimed = new Set();

  for (const rec of records) {
    if (rec.transcript) claimed.add(path.resolve(String(rec.transcript)));
    const seen = live.get(String(rec.id)) ?? null;
    const alive = pidAlive(rec.pid);
    const known = seen ? pidAlive(seen.pid) : false;
    const base = {
      id: rec.id,
      pid: rec.pid ?? null,
      cwd: rec.cwd ?? null,
      prompt: rec.prompt ?? '',
      startedAt: rec.startedAt ?? null,
      elapsedMs: rec.startedAt ? Date.now() - Number(rec.startedAt) : null,
      attempts: rec.attempts ?? 1,
      restarts: rec.restarts ?? 0,
      lastExitCode: rec.lastExitCode ?? null,
      lastSignal: rec.lastSignal ?? null,
      giveUpReason: rec.giveUpReason ?? null,
      transcript: rec.transcript ?? null,
      sessionId: rec.sessionId ?? null,
      socketPath: rec.socketPath ?? null,
      bot: rec.bot ?? null,
      model: rec.model ?? null,
    };
    if (seen && known) {
      running.push({
        ...base,
        pid: seen.pid,
        state: seen.state,
        currentTool: seen.currentTool ?? null,
        currentToolAt: seen.currentToolAt ?? null,
        toolCalls: seen.toolCalls ?? 0,
        turns: seen.turns ?? 0,
        lastEventAt: seen.lastEventAt ?? null,
        restarts: seen.restarts ?? rec.restarts ?? 0,
        attempts: seen.attempts ?? rec.attempts ?? 1,
        instanceId: seen.instanceId ?? null,
        live: true,
      });
    } else {
      // Three genuinely different failures, and collapsing them into one word
      // would make `ox agents` lie in both directions. An UNMANAGED worker (its
      // pid is alive, but nothing supervises it) is especially not something to
      // call idle: it is still executing code, and refusing to count it as
      // running is the honest answer, not a rounding error.
      const why = !daemon.socket.reachable
        ? alive
          ? `pid ${rec.pid} is alive but nothing supervises it (the daemon is not running) — not counted as running, because nothing is watching it`
          : `the daemon is not running${rec.pid ? ` and this worker's process (pid ${rec.pid}) is gone` : " and this worker had no live process"}`
        : seen && seen.pid
          ? `worker process ${seen.pid} is gone`
          : seen
            ? `the supervisor already reaped it (state: ${seen.state})`
          : alive
            ? `pid ${rec.pid} is alive but is not a worker of this daemon (a recycled pid)`
            : rec.pid
              ? `worker process ${rec.pid} is gone`
              : 'the worker had no live process (it finished, crashed, or its supervisor died)';
      idle.push({
        ...base,
        state: rec.state ?? 'unknown',
        live: false,
        stale: true,
        pidAlive: alive,
        unmanaged: !daemon.socket.reachable && alive,
        staleReason: why,
      });
    }
  }

  let saved = [];
  if (includeSaved) {
    let rows = [];
    try {
      rows = listSessions(Math.max(1, savedLimit));
    } catch {}
    saved = rows
      .filter((s) => !claimed.has(path.resolve(String(s.file))))
      .map((s) => ({ file: s.file, id: s.id, mtime: s.mtime, cwd: s.cwd, title: s.title ?? null, firstUserPrompt: s.firstUserPrompt ?? null }));
  }

  return {
    at: Date.now(),
    cwd,
    daemon: {
      state: daemon.state,
      live: daemon.live,
      reason: daemon.reason,
      pid: daemon.pid,
      instanceId: daemon.instanceId,
      uptimeMs: daemon.uptimeMs,
      socketPath: daemon.socketPath,
    },
    running,
    idle,
    saved,
    counts: { running: running.length, idle: idle.length, saved: saved.length },
  };
}

// Resolve a worker by exact id or by unique prefix — the same affordance
// `ox sessions resume` gives a transcript. Ambiguity is an error, never a pick.
export function resolveWorkerId(ref) {
  const want = String(ref ?? '').trim();
  if (!want) return { ok: false, reason: 'empty' };
  const records = listWorkerRecords();
  const exact = records.find((r) => String(r.id) === want);
  if (exact) return { ok: true, id: exact.id, record: exact, ambiguous: false };
  const hits = records.filter((r) => String(r.id).startsWith(want));
  if (hits.length === 1) return { ok: true, id: hits[0].id, record: hits[0], ambiguous: false };
  if (hits.length > 1) return { ok: false, reason: `ambiguous prefix '${want}' matches ${hits.map((h) => h.id).join(', ')}`, candidates: hits.map((h) => h.id) };
  return { ok: false, reason: `no worker '${want}'` };
}

// ---------------------------------------------------------------------------
// doctor
//
// Every finding is one line with a code, a level, and — where it is safe to act
// — the fix it would apply. `--fix` applies only the SAFE ones, and a fix is
// never "signal the pid": a pid that belongs to somebody else is reported and
// left strictly alone, because a doctor that kills a recycled pid is a bug with
// a very bad story.
// ---------------------------------------------------------------------------

export async function daemonDoctor({ fix = false } = {}) {
  const findings = [];
  const fixed = [];
  const add = (level, code, detail, opts = {}) => findings.push({ level, code, detail, fixable: !!opts.fix, ...opts });

  const dir = inspectDir(daemonDir());
  if (!dir.exists) {
    add('warn', 'dir-missing', `${daemonDir()} does not exist (no daemon has ever started)`, { fix: 'create it with mode 0700' });
    if (fix) {
      try {
        ensureDaemonDir();
        fixed.push('created the daemon directory with mode 0700');
      } catch (err) {
        add('error', 'dir-unfixable', `could not create ${daemonDir()}: ${err?.message ?? err}`);
      }
    }
  } else if (dir.foreign) {
    add('error', 'dir-foreign-owner', `${dir.path} is owned by uid ${dir.uid}, not ${currentUid()} — refusing to use it`);
  } else if (dir.tooOpen) {
    add('error', 'dir-too-open', `${dir.path} is mode ${dir.mode.toString(8).padStart(4, '0')}; group/other access defeats the socket boundary`, { fix: 'chmod 0700' });
    if (fix) {
      try {
        fs.chmodSync(dir.path, 0o700);
        fixed.push(`chmod 0700 ${dir.path}`);
      } catch (err) {
        add('error', 'dir-unfixable', `chmod failed: ${err?.message ?? err}`);
      }
    }
  } else {
    add('ok', 'dir-secure', `${dir.path} is mode 0700, owned by uid ${dir.uid}`);
  }

  const snap = await inspectDaemon();
  if (!snap.live && snap.socket.confidence !== 'certain') {
    // The daemon's state could not be established. Every repair below that
    // REMOVES something is disabled for this run, and that is said out loud
    // rather than papered over with a guess in either direction.
    add('error', 'daemon-unverifiable', `${snap.reason} — repairs that delete the pidfile or the socket are disabled for this run`, {
      neverFix: 'an absence of evidence is not evidence of absence',
    });
  }
  const mayRemove = snap.socket.confidence === 'certain';
  if (snap.live) {
    add('ok', 'daemon-running', `daemon pid ${snap.pid} (instance ${String(snap.instanceId).slice(0, 8)}…) up ${formatUptime(snap.uptimeMs)}, ${snap.workers.length} worker(s)`);
  } else {
    add(snap.pidfile.present ? 'warn' : 'ok', 'daemon-stopped', snap.reason ?? 'no daemon is running');
  }

  // The pidfile. Every branch here names WHICH of the three liveness facts
  // failed, because "the daemon is not running" is useless to someone deciding
  // whether to run --fix.
  if (snap.state === 'degraded') {
    // The daemon is serving; its paperwork is wrong. This is repairable, and
    // leaving it unrepaired is how a live supervisor becomes unreachable.
    add('warn', 'pidfile-mismatch', `${pidFilePath()}: ${snap.reason}`, { fix: 'rewrite the pidfile from the live daemon\'s own report' });
    if (fix && repairPidFileFromSocket(snap)) {
      fixed.push(`rewrote ${pidFilePath()} from the live daemon (pid ${snap.pid})`);
    }
  } else if (snap.pidfile.present && snap.pidfile.valid) {
    const rec = snap.pidfile.record;
    if (snap.state === 'running') {
      add('ok', 'pidfile-live', `pidfile matches the live daemon (pid ${rec.pid}, instance ${String(rec.instanceId).slice(0, 8)}…)`);
    } else if (!pidAlive(rec.pid)) {
      add('warn', 'pidfile-stale', `${pidFilePath()} names pid ${rec.pid}, which is gone`, { fix: 'remove the stale pidfile' });
      if (fix) { fixed.push(`removed stale pidfile ${pidFilePath()}`); clearPidFile(); }
    } else if (!mayRemove) {
      // Not certain, not proven-dead. Calling this "recycled" would be a guess,
      // and this branch's `--fix` deletes the file, so it must stay out.
      add('warn', 'pidfile-unverified', `${pidFilePath()} names live pid ${rec.pid}, and the socket probe was inconclusive (${snap.socket.reason})`, {
        neverFix: 're-run doctor once the daemon is reachable, or once its socket file is gone',
      });
    } else {
      add('error', 'pidfile-recycled', `${pidFilePath()} names pid ${rec.pid}, which is alive but is NOT this daemon: ${snap.reason}. It will not be signalled.`, { fix: 'remove the misleading pidfile' });
      if (fix) { fixed.push(`removed recycled-pid pidfile ${pidFilePath()}`); clearPidFile(); }
    }
  } else if (snap.pidfile.present) {
    add('warn', 'pidfile-unusable', `${pidFilePath()} is ${snap.pidfile.problem}${snap.pidfile.detail ? ` (${snap.pidfile.detail})` : ''}`, { fix: 'remove it' });
    if (fix) { fixed.push(`removed unusable pidfile ${pidFilePath()}`); clearPidFile(); }
  }

  // The control socket itself.
  const sockPath = controlSocketPath();
  if (snap.dir.exists) {
    const verdict = screenSocketPath(sockPath);
    if (!verdict.exists) {
      if (snap.live) add('error', 'socket-missing', `${sockPath} is gone but the daemon claims to be running`, { fix: 're-derive the pidfile from the live socket' });
      else add('ok', 'socket-absent', 'no control socket (consistent with a stopped daemon)');
    } else if (verdict.foreign) {
      add('error', 'socket-foreign', verdict.reason, { neverFix: 'owned by another user: probing or removing it is an act on their resource' });
    } else if (verdict.tooOpen) {
      add('error', 'socket-too-open', `${sockPath} is mode ${verdict.mode.toString(8).padStart(4, '0')}; anyone on this machine can start agents through it`, { fix: 'chmod 0600' });
      if (fix && snap.live) { fixed.push(`chmod 0600 ${sockPath}`); hardenSocket(sockPath); }
    } else if (!verdict.socket) {
      add('warn', 'socket-not-a-socket', `${sockPath} exists but is not a socket (mode ${verdict.mode.toString(8).padStart(4, '0')})`, { fix: 'remove it so the daemon can bind' });
      if (fix && mayRemove && !snap.socket.reachable) { try { fs.unlinkSync(sockPath); fixed.push(`removed non-socket ${sockPath}`); } catch {} }
    } else if (snap.socket.reachable) {
      add('ok', 'socket-live', `${sockPath} is mode 0600 and answering for instance ${String(snap.socket.instanceId).slice(0, 8)}…`);
    } else {
      add('warn', 'socket-orphaned', `${sockPath} is a 0600 socket nobody answers on (crash remnant)`, { fix: 'remove it' });
      if (fix && mayRemove) { try { fs.unlinkSync(sockPath); fixed.push(`removed orphaned socket ${sockPath}`); } catch {} }
    }
  }

  // Worker records and their sockets: workers whose parent died.
  const records = listWorkerRecords();
  for (const rec of records) {
    const live = snap.workers.find((w) => String(w.id) === String(rec.id));
    if (live) continue;
    if (rec.state === 'running' || rec.state === 'starting') {
      if (!pidAlive(rec.pid)) {
        add('warn', 'worker-orphaned', `worker ${rec.id} claims to be ${rec.state} but pid ${rec.pid} is gone`, { fix: 'mark it exited' });
        if (fix) {
          writeWorkerRecord({ ...rec, state: 'exited', pid: null, endedAt: rec.endedAt ?? Date.now(), staleReason: 'supervisor died while this worker was running' });
          fixed.push(`marked worker ${rec.id} exited`);
        }
      } else if (rec.instanceId && snap.instanceId && rec.instanceId !== snap.instanceId) {
        add('warn', 'worker-foreign-instance', `worker ${rec.id} belongs to daemon instance ${String(rec.instanceId).slice(0, 8)}…, not the running one`, { fix: 'leave the pid alone; it is not ours' });
      }
    }
    const wsock = rec.socketPath ?? workerSocketPath(rec.id);
    const verdict = screenSocketPath(wsock);
    if (verdict.exists && verdict.ok && verdict.socket) {
      add('warn', 'worker-socket-orphaned', `${wsock} has no live worker behind it`, { fix: 'remove it' });
      if (fix) { try { fs.unlinkSync(wsock); fixed.push(`removed orphaned worker socket ${wsock}`); } catch {} }
    }
  }

  // Any stray socket/record files in the daemon dir that belong to nothing.
  if (snap.dir.exists) {
    let names = [];
    try { names = fs.readdirSync(daemonDir()); } catch {}
    const known = new Set([path.basename(controlSocketPath()), path.basename(pidFilePath()), path.basename(startLockPath()), path.basename(daemonLogPath())]);
    for (const rec of records) known.add(`${safeId(rec.id)}.json`);
    for (const n of names) {
      if (known.has(n) || n.endsWith('.tmp') || n.endsWith('.1')) continue;
      if (!n.endsWith('.sock')) continue;
      const full = path.join(daemonDir(), n);
      const verdict = screenSocketPath(full);
      if (verdict.ok && verdict.exists && verdict.socket) {
        add('warn', 'stray-socket', `${full} belongs to no known worker`, { fix: 'remove it' });
        if (fix) { try { fs.unlinkSync(full); fixed.push(`removed stray socket ${full}`); } catch {} }
      } else if (verdict.foreign) {
        add('error', 'stray-foreign-socket', verdict.reason, { neverFix: 'not ours' });
      }
    }
  }

  if (fix) {
    // Re-read after the repairs so the reported state is the repaired one, not
    // the one we started from.
    const after = await inspectDaemon();
    findings.push({
      level: 'info',
      code: 'after-fix',
      detail: `daemon is now ${after.state}${after.state === 'running' ? ` (pid ${after.pid})` : ` (${after.reason ?? 'not running'})`}`,
    });
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  return { findings, fixed, errors, warnings, healthy: errors === 0, daemon: snap };
}

export function formatUptime(ms) {
  const s = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function formatElapsed(ms) {
  if (ms == null) return '-';
  return formatUptime(ms);
}

export { sleep as _sleep, OX_BIN as _OX_BIN };
