// The CLI surface for daemon continuity: `ox daemon`, `ox agents`, `ox attach`,
// `ox shutdown`. Rendering only — every decision (is it running, is a worker
// live, is this pid ours) is made in src/daemon.js, and the four commands below
// exist only to print it. That split is why `ox agents`, `ox daemon status` and
// `ox attach` can never disagree about the same instant.
//
// Prime Agent's surface is the shape being matched: agents (running / idle /
// saved), attach, status, doctor --fix, shutdown --force.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c, truncate } from './ui.js';
// Only for the default socket path, which is derived the same way cli.js derives
// it (IPC_DEFAULT_SESSION === 'default'). The control frames themselves go over
// `connectIpcClient`, imported lazily inside the call so a plain `ox agents` --
// the read-only board -- never opens a socket.
import { socketPathFor } from './ipc.js';
import { attachSession } from './daemon-attach.js';
import { listSessions, latestSessionFile, loadSessionWithStatus } from './session.js';
import {
  addSchedule,
  claimSchedule,
  dueSchedules,
  formatDuration,
  getSchedule,
  listSchedules,
  readPolicy,
  removeAllSchedules,
  removeSchedule,
  scheduleResidue,
  updateSchedule,
  writePolicy,
  parseIntervalSpec,
  parseCadenceToken,
  scheduleRunStatus,
  DEFAULT_SCHEDULE_MAX_COST_USD,
  buildScheduleBlock,
  parseCadence,
  parseNaturalCadence,
  planScheduleInstall,
  OX_BIN_PATH,
} from './schedule.js';
import {
  agentsSnapshot,
  controlRequest,
  controlSocketPath,
  daemonDoctor,
  daemonLogPath,
  daemonDir,
  formatUptime,
  inspectDaemon,
  readLog,
  resolveWorkerId,
  startDaemon,
  stopDaemon,
} from './daemon.js';

const USAGE = [
  'usage:',
  '  ox daemon start                 start the supervisor (detached; idempotent)',
  '  ox daemon status                running/stopped, pid, uptime, worker count',
  '  ox daemon stop [--force]        stop the workers, then the supervisor',
  '  ox daemon doctor [--fix]        inspect the runtime state; --fix repairs it',
  '  ox daemon log [--lines <n>]     the supervisor\'s own account of what it did',
  '',
  '  ox agents [--json] [--limit <n>] running / idle / saved sessions',
  '  ox attach <id> [--no-replay]    stream a running session; detach leaves it running',
  '  ox shutdown [--force]           stop workers + supervisor (alias: ox daemon stop)',
  '',
  '  ox -p "<task>" --detach         run the session as a worker under the supervisor',
  '',
  '  ox schedule add [<30s|5m|2h|1d>|<ISO time>] "<prompt>" [--every <n>] [--at HH:MM] [--max-cost <usd>]',
  '                                  --cwd <dir> [--bot <name>] [--model <spec>] [--enable]',
  '  ox schedule list [--json]       every schedule: cadence, cap, next run, last result',
  '  ox schedule enable|disable <id>',
  '  ox schedule run-now <id>        claim it and dispatch it through the daemon NOW',
  '  ox schedule remove <id>         ox schedule remove-all leaves no residue',
  '  ox schedule opt-in|opt-out      the daemon-wide switch; OFF until you opt in',
  '  ox schedule policy              what the daemon is currently allowed to do',
  '  ox schedule print-crontab ...   PRINT a crontab block for humans; never installs it',
  '  ox schedule "<goal>" [--at HH:MM] [--max-cost <usd>] [--install]',
  '                               print a crontab + launchd block; --install appends it to the',
  '                               SYSTEM crontab and needs a TTY confirm, or --yes + OX_INSTALL_YES=1',
  '',
  '  ox cron ...                     the historical name for `ox schedule` (same store)',
  '',
  '  ox heartbeat start [<session>] [--every <5m>] [--at HH:MM] [--max-runs 3]',
  '  ox heartbeat list               heartbeats and what stopped each one',
  '  ox heartbeat stop <id>',
];

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

const has = (args, ...names) => names.some((n) => args.includes(n));

// Flags that consume the NEXT token. Needed everywhere a command reads free text:
// without it `ox schedule "morning triage" --at 07:45` yields the goal
// "morning triage 07:45", because a flag's VALUE does not start with `-` and is
// indistinguishable from a positional by shape alone.
const VALUE_FLAGS = ['--every', '--at', '--max-cost', '--cwd', '--bot', '--model', '--max-runs', '--key-env', '--log-file'];

// The positional arguments of a command, with every flag and every flag's value
// removed. `add <cadence> "<prompt>"` and `ox schedule "<goal>" --at HH:MM` are
// the same shape, so they read the same helper and cannot disagree about what the
// user actually typed.
function positionalOf(args) {
  return args.filter((a, i) => {
    if (String(a).startsWith('-')) return false;
    return !VALUE_FLAGS.includes(args[i - 1]);
  });
}

function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

// ---------------------------------------------------------------------------
// ox daemon
// ---------------------------------------------------------------------------

export async function cmdDaemon(args = []) {
  const sub = String(args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  const json = has(rest, '--json');
  switch (sub) {
    case 'start':
      return cmdDaemonStart(rest, json);
    case 'status':
    case '':
      return cmdDaemonStatus(rest, json);
    case 'stop':
    case 'shutdown':
      return cmdDaemonStop(rest, json, has(rest, '--force'));
    case 'doctor':
      return cmdDaemonDoctor(rest, json, has(rest, '--fix'));
    case 'log':
      return cmdDaemonLog(rest, json);
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE.join('\n'));
      return;
    default:
      process.stderr.write(`ox: unknown daemon subcommand '${sub}'\n\n${USAGE.join('\n')}\n`);
      process.exitCode = 3;
      return;
  }
}

async function cmdDaemonStart(args, json) {
  const before = await inspectDaemon();
  if (before.live) {
    const repaired = before.state === 'degraded';
    if (json) console.log(JSON.stringify({ t: 'daemon-start', started: false, reason: repaired ? 'repaired-pidfile' : 'already-running', daemon: before }));
    else if (repaired) {
      console.log(`${c.green('ox daemon already running')} ${c.dim(`(pid ${before.pid}) — its pidfile was wrong and has been rewritten from the daemon itself`)}`);
    } else {
      console.log(`ox daemon already running ${c.dim(`(pid ${before.pid}, up ${formatUptime(before.uptimeMs)})`)}`);
    }
    return;
  }
  const res = await startDaemon({ already: before });
  if (res.started) {
    if (json) console.log(JSON.stringify({ t: 'daemon-start', started: true, daemon: res.daemon }));
    else {
      console.log(`${c.green('ox daemon started')} ${c.dim(`pid ${res.daemon.pid} · socket ${controlSocketPath()}`)}`);
      console.log(c.dim('detach with `ox shutdown`'));
    }
    return;
  }
  process.stderr.write(`${c.red(`✗ could not start the daemon: ${res.reason}${res.daemon?.reason ? ` (${res.daemon.reason})` : ''}`)}\n`);
  process.stderr.write(c.dim('run `ox daemon doctor` for the full picture\n'));
  process.exitCode = 1;
}

async function cmdDaemonStatus(args, json) {
  const snap = await inspectDaemon();
  const running = snap.state === 'running';
  const workers = snap.workers.length;
  if (json) {
    console.log(JSON.stringify({
      t: 'daemon-status',
      state: snap.state,
      reason: snap.reason,
      pid: snap.pid,
      instanceId: snap.instanceId,
      uptimeMs: snap.uptimeMs,
      workers: snap.workers.length,
      socketPath: snap.socketPath,
      workerList: snap.workers.map((w) => ({ id: w.id, state: w.state, pid: w.pid, currentTool: w.currentTool, restarts: w.restarts })),
    }));
    process.exitCode = running ? 0 : 1;
    return;
  }
  console.log(`socket: ${snap.socketPath}`);
  if (running || snap.live) {
    const word = snap.state === 'degraded' ? c.yellow('running (degraded)') : c.green('running');
    console.log(`state:  ${word} ${c.dim(`pid ${snap.pid} · up ${formatUptime(snap.uptimeMs)} · instance ${String(snap.instanceId).slice(0, 8)}…`)}`);
    if (snap.state === 'degraded') console.log(c.yellow(`        ${snap.reason}`));
    console.log(`workers: ${workers}`);
    for (const w of snap.workers) {
      const bits = [`${pad(w.id, 13)}`, pad(w.state, 11), `pid ${w.pid ?? '-'}`];
      if (w.currentTool) bits.push(`tool ${w.currentTool}`);
      if (w.restarts) bits.push(`${w.restarts} restart(s)`);
      console.log(`  ${bits.join('  ')}`);
    }
  } else {
    console.log(`state:  ${c.dim('stopped')}${snap.reason ? c.dim(` — ${snap.reason}`) : ''}`);
    console.log('workers: 0');
  }
  process.exitCode = running || snap.live ? 0 : 1;
}

async function cmdDaemonStop(args, json, force) {
  const res = await stopDaemon({ force });
  if (res.stopped) {
    if (json) console.log(JSON.stringify({ t: 'daemon-stop', stopped: true, reason: res.reason }));
    else console.log(`${c.green('ox daemon stopped')} ${c.dim(`(${res.reason})`)}`);
    return;
  }
  if (json) console.log(JSON.stringify({ t: 'daemon-stop', stopped: false, reason: res.reason }));
  else console.log(`${c.yellow('ox daemon is not running')} ${c.dim(`— ${res.reason}`)}`);
  // Not an error: `shutdown` on a stopped daemon is the state the caller wanted.
  process.exitCode = 0;
}

async function cmdDaemonDoctor(args, json, fix) {
  const res = await daemonDoctor({ fix });
  if (json) {
    console.log(JSON.stringify({ t: 'daemon-doctor', fix, healthy: res.healthy, errors: res.errors, warnings: res.warnings, fixed: res.fixed, findings: res.findings }));
  } else {
    console.log(c.bold(`ox daemon doctor${fix ? ' --fix' : ''}`));
    console.log(c.dim(`  dir ${daemonDir()}`));
    for (const f of res.findings) {
      const mark = f.level === 'ok' ? c.green('✓') : f.level === 'warn' ? c.yellow('!') : f.level === 'error' ? c.red('✗') : c.dim('·');
      const fixable = f.fixable && !fix ? c.dim(`  (--fix: ${f.fix})`) : '';
      const never = f.neverFix ? c.dim(`  (never auto-fixed: ${f.neverFix})`) : '';
      console.log(`${mark} ${f.detail}${fixable}${never}`);
    }
    for (const line of res.fixed) console.log(`${c.green('+')} ${line}`);
    console.log(
      res.healthy
        ? c.green('  healthy')
        : c.yellow(`  ${res.errors} error(s), ${res.warnings} warning(s)`)
    );
  }
  process.exitCode = res.healthy ? 0 : 1;
}

async function cmdDaemonLog(args, json) {
  const n = Number(flagValue(args, '--lines') ?? 40);
  const lines = readLog(Number.isFinite(n) && n > 0 ? Math.floor(n) : 40);
  if (json) {
    console.log(JSON.stringify({ t: 'daemon-log', path: daemonLogPath(), lines }));
    return;
  }
  console.log(c.dim(daemonLogPath()));
  for (const line of lines) {
    console.log(line.includes('!!') ? c.red(line) : c.dim(line));
  }
}

// ---------------------------------------------------------------------------
// ox agents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ox agents cancel / steer
// ---------------------------------------------------------------------------
//
// These two verbs reach a RUNNING subagent over the IPC bridge's control frames
// (src/cli.js `subagentControlRequest`), because the control records are
// in-process (src/subagent-control.js) and there is no shared memory between
// this CLI and the run it is being asked to stop. That is not a limitation being
// worked around -- it is the same doctrine src/subagent-registry.js states about
// liveness: a file cannot tell you what is running RIGHT NOW, only what was.
//
// So the failure is stated rather than faked: with no bridge listening, the
// answer is "nothing to cancel from here", and the operator is told where the
// cancel belongs. Exit code 3, matching every other "you asked for something
// this machine cannot do" path in this file.
const SUBAGENT_CONTROL_TIMEOUT_MS = 3000;

async function sendSubagentControl(socketPath, frame) {
  const { connectIpcClient } = await import('./ipc.js');
  return new Promise((resolve) => {
    const client = connectIpcClient({
      socketPath,
      clientId: `agents-cmd-${process.pid}`,
      connectTimeoutMs: 700,
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { client.close(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'the bridge did not answer in time' }), SUBAGENT_CONTROL_TIMEOUT_MS);
    client.on('open', () => {
      client.send({ type: frame.type, id: `ox-agents-${Date.now().toString(36)}`, subagentId: frame.subagentId, ...(frame.note ? { note: frame.note } : {}) });
    });
    client.on('message', (msg) => {
      if (msg?.type !== 'control-reply') return;
      clearTimeout(timer);
      finish(msg.ok === true ? { ok: true, result: msg.result } : { ok: false, error: String(msg.error ?? 'the run refused the request') });
    });
    client.on('error', () => { clearTimeout(timer); finish({ ok: false, error: 'no bridge answered' }); });
    client.on('close', () => { clearTimeout(timer); finish({ ok: false, error: 'the bridge closed before answering' }); });
  });
}

async function cmdAgentsControl(verb, args, json) {
  const rest = args.filter((a) => !String(a).startsWith('-'));
  const subagentId = rest[0] ?? '';
  if (!subagentId) {
    const usage = `usage: ox agents ${verb} <subagent-id>${verb === 'steer' ? ' <note>' : ''}`;
    if (json) console.log(JSON.stringify({ t: 'agents-control', ok: false, error: usage }));
    else console.error(usage);
    process.exitCode = 3;
    return;
  }
  // The rest of the line is the note, not one token: guidance worth sending is
  // a sentence, and an operator who cannot send a sentence will send "stop".
  const note = verb === 'steer' ? rest.slice(1).join(' ').trim() : '';
  if (verb === 'steer' && !note) {
    const usage = 'usage: ox agents steer <subagent-id> <note>';
    if (json) console.log(JSON.stringify({ t: 'agents-control', ok: false, error: usage }));
    else console.error(usage);
    process.exitCode = 3;
    return;
  }
  // `--socket <path>` and `--socket=<path>` are both accepted because cli.js's
  // other ipc subcommands take the spaced form, and an operator copying one of
  // those invocations should not have to know that this file prefers the other.
  const eqSocket = args.find((a) => String(a).startsWith('--socket='))?.slice('--socket='.length);
  const spIdx = args.indexOf('--socket');
  const socketPath = eqSocket || (spIdx >= 0 ? args[spIdx + 1] : null) || socketPathFor('default');
  const res = await sendSubagentControl(socketPath, {
    type: verb === 'steer' ? 'subagent-steer' : 'subagent-cancel',
    subagentId,
    note,
  });
  if (json) {
    console.log(JSON.stringify({ t: verb === 'steer' ? 'agents-steer' : 'agents-cancel', ...res }));
  } else if (res.ok) {
    const r = res.result ?? {};
    const live = r.snapshot?.activeCount ?? null;
    console.log(c.yellow(`${verb === 'steer' ? '⇢' : '⚠'} ${r.message ?? (verb === 'steer' ? `steering note queued for ${subagentId}` : 'cancel requested')}`));
    if (live != null) console.log(c.dim(`  ${live} subagent(s) still running in that process`));
  } else {
    console.error(
      c.red(`✗ ${verb} ${subagentId}: ${res.error}`) +
        (verb === 'cancel' ? c.dim(' — a subagent is only cancellable from the process running it; start that run with --ipc, or cancel from its own /agents') : '')
    );
  }
  if (!res.ok) process.exitCode = 3;
}

export async function cmdAgents(args = []) {
  // The control verbs are handled BEFORE the snapshot board. `ox agents` with no
  // verb is the read-only board this file has always printed; `ox agents cancel`
  // is a different question and gets a different answer.
  const verb = String(args.find((a) => !String(a).startsWith('-')) ?? '').toLowerCase();
  if (verb === 'cancel' || verb === 'steer') {
    const idx = args.indexOf(args.find((a) => !String(a).startsWith('-')));
    return await cmdAgentsControl(verb, [...args.slice(0, idx), ...args.slice(idx + 1)], has(args, '--json'));
  }
  const json = has(args, '--json');
  const limitArg = Number(flagValue(args, '--limit'));
  const savedLimit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 15;
  const snap = await agentsSnapshot({ savedLimit });

  if (json) {
    console.log(JSON.stringify({ t: 'agents', ...snap }));
    return;
  }

  const d = snap.daemon;
  console.log(c.bold('ox agents'));
  if (d.live) {
    console.log(c.dim(`  daemon  ${d.state === 'degraded' ? 'running (degraded)' : 'running'} · pid ${d.pid} · up ${formatUptime(d.uptimeMs)} · instance ${String(d.instanceId).slice(0, 8)}…`));
  } else {
    console.log(c.dim(`  daemon  stopped${d.reason ? ` — ${d.reason}` : ''}`));
  }

  const row = (tag, r, live) => {
    const tool = live && r.currentTool ? `tool ${r.currentTool}` : live && r.turns ? `${r.turns} turn(s)` : '';
    const bits = [
      `  ${pad(r.id, 20)}`,
      pad(live ? `pid ${r.pid}` : r.pidAlive ? `pid ${r.pid} unmanaged` : 'no worker', live ? 16 : 22),
      pad(r.elapsedMs != null ? formatUptime(r.elapsedMs) : '-', 8),
    ];
    if (tool) bits.push(pad(tool, 18));
    if (r.restarts) bits.push(c.yellow(`${r.restarts} restart(s)`));
    bits.push(truncate(r.prompt || r.firstUserPrompt || r.title || '', 70));
    console.log(bits.join(' '));
  };

  console.log(c.bold(`\nrunning (${snap.running.length})`));
  if (!snap.running.length) console.log(c.dim('  (nothing is running under the daemon)'));
  for (const r of snap.running) row('running', r, true);

  console.log(c.bold(`\nidle (${snap.idle.length})`));
  if (!snap.idle.length) console.log(c.dim('  (no detected sessions without a live worker)'));
  for (const r of snap.idle) {
    row('idle', r, false);
    console.log(c.dim(`  ${' '.repeat(20)} ${r.staleReason}`));
  }

  console.log(c.bold(`\nsaved (${snap.saved.length})`));
  if (!snap.saved.length) console.log(c.dim('  (no transcripts on disk)'));
  for (const r of snap.saved) {
    console.log(
      `  ${pad(r.id, 20)} ${pad((r.mtime ?? '').replace('T', ' ').slice(0, 19), 20)} ${truncate(r.title || r.firstUserPrompt || r.file, 80)}`
    );
  }
}

// ---------------------------------------------------------------------------
// ox attach
// ---------------------------------------------------------------------------

export async function cmdAttach(args = []) {
  const ref = args.find((a) => !String(a).startsWith('-'));
  if (!ref) {
    process.stderr.write(`ox: attach needs a worker id\n\n${USAGE.join('\n')}\n`);
    process.exitCode = 3;
    return;
  }
  const res = await attachSession({
    ref,
    replay: !has(args, '--no-replay'),
    once: has(args, '--once'),
  });
  if (res.error) {
    process.stderr.write(`${c.red(`✗ ${res.error}`)}\n`);
    if (res.candidates?.length) process.stderr.write(c.dim(`  did you mean: ${res.candidates.join(', ')}\n`));
    process.exitCode = res.code ?? 3;
  }
}

// ---------------------------------------------------------------------------
// ox shutdown
// ---------------------------------------------------------------------------

export async function cmdShutdown(args = []) {
  const force = has(args, '--force', '-f');
  const json = has(args, '--json');
  const res = await stopDaemon({ force });
  if (json) console.log(JSON.stringify({ t: 'shutdown', stopped: res.stopped, reason: res.reason }));
  else if (res.stopped) console.log(`${c.green('ox shutdown')} ${c.dim(`(${res.reason})`)}`);
  else console.log(`${c.yellow('ox shutdown')} ${c.dim(`— ${res.reason}`)}`);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// ox -p "<task>" --detach
//
// Starts a worker under the supervisor and returns immediately. The supervisor
// is started automatically if it is not already up, and that is said out loud:
// a silent supervisor start would make `ox --detach` look like it lost its job.
// ---------------------------------------------------------------------------

export async function startDetachedRun({ prompt, cwd, passthrough = [], bot = null, model = null, env = process.env, json = false } = {}) {
  const before = await inspectDaemon();
  let startedDaemon = false;
  if (before.state !== 'running') {
    const started = await startDaemon({ env, already: before });
    if (!started.started) {
      return { ok: false, error: `could not start the daemon (${started.reason}${started.daemon?.reason ? `: ${started.daemon.reason}` : ''})` };
    }
    startedDaemon = true;
  }
  const { controlRequest } = await import('./daemon.js');
  const res = await controlRequest('start', { prompt, cwd, passthrough, bot, model }, { timeoutMs: 8000 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, startedDaemon, workerId: res.result.workerId, socketPath: res.result.socketPath, pid: res.result.pid };
}

export async function reportDetachedRun({ workerId, startedDaemon, json }) {
  const resolved = resolveWorkerId(workerId);
  const rec = resolved.ok ? resolved.record : null;
  if (json) {
    console.log(JSON.stringify({ t: 'detached', workerId, pid: rec?.pid ?? null, socketPath: rec?.socketPath ?? null, transcript: rec?.transcript ?? null, startedDaemon }));
    return;
  }
  if (startedDaemon) console.log(c.dim('started a supervisor for this (none was running)'));
  console.log(`${c.green('detached')} ${c.bold(workerId)}${rec?.pid ? c.dim(` · worker pid ${rec.pid}`) : ''}`);
  console.log(c.dim(`  watch it   ox agents`));
  console.log(c.dim(`  follow it  ox attach ${workerId}`));
  if (rec?.transcript) console.log(c.dim(`  transcript ${path.basename(rec.transcript)}`));
}

export { USAGE as DAEMON_USAGE };

// ---------------------------------------------------------------------------
// ox schedule
//
// Rendering plus the store calls; the daemon owns dispatch. `run-now` in
// particular does NOT spawn anything from this process: it claims the schedule
// and asks the supervisor to dispatch it, so a manual run and a timer go through
// one gate and cannot diverge.
// ---------------------------------------------------------------------------

function flagPair(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function renderScheduleRow(s, { now = Date.now() } = {}) {
  const bits = [
    `  ${pad(s.id, 12)}`,
    pad(s.kind, 10),
    pad(s.enabled ? c.green('enabled') : c.dim('disabled'), 18),
    pad(s.cadence.description, 18),
    pad(`$${s.maxCostUsd} ${s.costCapSource}`, 16),
  ];
  if (s.kind === 'heartbeat') bits.push(pad(`${s.runs}/${s.maxRuns} beats`, 14));
  // Same helper `/schedule list` uses, so the two surfaces cannot disagree about
  // one instant. A disabled schedule and an expired one-off get a sentence, not a
  // timestamp nobody will ever honour.
  const st = scheduleRunStatus(s, { now });
  const painted = st.state === 'past' || st.state === 'none' ? c.yellow(st.text) : st.state === 'disabled' ? c.dim(st.text) : c.dim(st.text);
  bits.push(painted);
  console.log(bits.join(' '));
  const last = s.lastRun;
  console.log(c.dim(`             last ${last ? `${new Date(last.at).toISOString().replace('T', ' ').slice(0, 19)} — ${last.state}${last.note ? ` — ${last.note}` : ''}` : 'never run'}${s.deferrals ? ` · ${s.deferrals} deferred` : ''}${s.misses ? ` · ${s.misses} missed` : ''}`));
}

function renderScheduleDetail(s) {
  console.log(`  ${c.bold(s.id)} ${c.dim(`(${s.kind})`)}`);
  console.log(`    prompt     ${s.prompt}`);
  console.log(`    cadence    ${s.cadence.description}`);
  console.log(`    cwd        ${s.cwd}`);
  console.log(`    cap        $${s.maxCostUsd} ${c.dim(`(${s.costCapSource} — reaches the run as --max-cost=${s.maxCostUsd})`)}`);
  if (s.bot || s.model) console.log(`    bot/model  ${s.bot ?? '-'} / ${s.model ?? '-'}`);
  if (s.session) console.log(`    session    ${s.session}`);
  if (s.kind === 'heartbeat') console.log(`    heartbeats ${s.runs} of ${s.maxRuns} fired`);
  console.log(`    state      ${s.enabled ? 'enabled' : c.dim('disabled')} · ${s.deferrals} deferred · ${s.misses} missed`);
  const last = s.lastRun;
  if (last) {
    const when = new Date(last.at).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`    last run   ${when} — ${last.state}${last.code != null ? ` (exit ${last.code})` : ''}${last.note ? c.dim(` · ${last.note}`) : ''}`);
    const hist = Array.isArray(last.history) ? last.history : [];
    if (hist.length > 1) {
      for (const h of hist.slice(-6)) console.log(c.dim(`                ${new Date(h.at).toISOString().slice(11, 19)} ${h.state}${h.trigger ? ` (${h.trigger})` : ''}`));
    }
  } else {
    console.log(`    last run   ${c.dim('never')}`);
  }
  // The gate is stated on every listing, because "it is enabled and it did not
  // run" is the single most confusing thing about a scheduler.
  const policy = readPolicy();
  if (!policy.optedIn) {
    console.log('');
    console.log(c.yellow('  schedules are OFF for this daemon — `ox schedule opt-in` lets it dispatch.'));
  }
}

async function ensureDaemonForDispatch() {
  const before = await inspectDaemon();
  if (before.state === 'running') return { ok: true, daemon: before };
  const started = await startDaemon({ already: before });
  if (!started.started) {
    return { ok: false, error: `could not start the daemon (${started.reason}${started.daemon?.reason ? `: ${started.daemon.reason}` : ''})` };
  }
  return { ok: true, startedDaemon: true, daemon: started.daemon };
}

// The dispatch path for both the tick and `run-now`. Claims first (which
// advances nextRunAt, so a crash here does not re-fire), then hands the claimed
// record to the supervisor, which applies the screens and the argv allowlist.
async function dispatchThroughDaemon(scheduleId, { trigger = 'manual', attended = false } = {}) {
  // The row is resolved BEFORE any daemon is started. This used to start the
  // supervisor first, so a mistyped id left a long-lived background process
  // behind — a failure that creates a daemon is a very poor way to report a typo.
  const rec = getSchedule(scheduleId);
  if (!rec) return { ok: false, error: `no schedule with id '${scheduleId}'` };
  const daemon = await ensureDaemonForDispatch();
  if (!daemon.ok) return { ok: false, error: daemon.error };
  const claim = claimSchedule(rec.id, { trigger, attended });
  if (claim.refusal) return { ok: false, error: claim.refusal };
  if (claim.missed) return { ok: true, missed: true, schedule: claim.schedule };
  const res = await controlRequest('schedule-run', { schedule: claim.schedule, trigger, attended }, { timeoutMs: 8000 });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, workerId: res.result?.workerId ?? null, pid: res.result?.pid ?? null, stopped: res.result?.stopped ?? false, reason: res.result?.reason ?? null, schedule: claim.schedule };
}

export async function cmdSchedule(args = []) {
  const sub = String(args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  const json = has(rest, '--json');
  const wantPrint = has(rest, '--print-crontab');

  switch (sub) {
    case 'add': {
      const positional = positionalOf(rest);
      const every = flagPair(rest, '--every');
      const at = flagPair(rest, '--at');
      // `add <cadence> "<prompt>"` — the bare form. Consulted only when no cadence
      // flag was given, and only the FIRST positional can be a cadence, so a
      // cadence-looking word later in the prompt is never stolen.
      let leading = null;
      if (!at && !every && positional.length) {
        const tok = parseCadenceToken(positional[0]);
        if (tok) leading = tok;
      }
      const prompt = positional.slice(leading ? 1 : 0).join(' ').trim();
      const cadenceInput = at ? { kind: 'at', at } : every ? (() => {
        const parsed = parseIntervalSpec(every);
        if (parsed.refusal) return { refusal: parsed.refusal };
        return { kind: 'interval', everyMs: parsed.everyMs };
      })() : leading ?? {};
      if (cadenceInput.refusal) {
        if (json) console.log(JSON.stringify({ t: 'schedule-add', ok: false, error: cadenceInput.refusal }));
        else process.stderr.write(`${c.red(`✗ ${cadenceInput.refusal}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const maxCostRaw = flagPair(rest, '--max-cost');
      const added = addSchedule({
        prompt,
        cadence: cadenceInput,
        cwd: flagPair(rest, '--cwd') ?? process.cwd(),
        maxCostUsd: maxCostRaw === null ? undefined : Number(maxCostRaw),
        bot: flagPair(rest, '--bot'),
        model: flagPair(rest, '--model'),
        enabled: has(rest, '--enable'),
        // The whole raw arg set goes through the privilege screen, so a flag ox
        // does not know about is still refused rather than quietly ignored.
        flags: Object.fromEntries(rest.filter((a) => String(a).startsWith('-')).map((a) => [a.replace(/^--?/, ''), true])),
      });
      if (added.refusal) {
        if (json) console.log(JSON.stringify({ t: 'schedule-add', ok: false, error: added.refusal }));
        else process.stderr.write(`${c.red(`✗ ${added.refusal}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const s = added.schedule;
      const policy = readPolicy();
      if (json) {
        console.log(JSON.stringify({ t: 'schedule-add', ok: true, schedule: s, optedIn: policy.optedIn }));
        return;
      }
      console.log(`${c.green('✓')} schedule ${c.bold(s.id)} — ${s.cadence.description}`);
      console.log(`  prompt  ${s.prompt}`);
      console.log(`  cap     $${s.maxCostUsd} ${c.dim(`(${s.costCapSource})`)}`);
      console.log(`  state   ${s.enabled ? c.green('enabled') : c.dim('disabled — `ox schedule enable ' + s.id + '`')}`);
      const st = scheduleRunStatus(s);
      console.log(`  next    ${st.state === 'past' ? c.yellow(st.text) : c.dim(st.text)}`);
      if (st.state === 'past') console.log(c.yellow('          it was stored, but nothing will ever dispatch it'));
      if (!policy.optedIn) console.log(c.yellow('  daemon  schedules are OFF — `ox schedule opt-in` lets it run this'));
      return;
    }

    case 'list': {
      const all = listSchedules();
      const policy = readPolicy();
      if (json) {
        console.log(JSON.stringify({ t: 'schedule-list', schedules: all, policy, residue: scheduleResidue() }));
        return;
      }
      console.log(c.bold(`schedules (${all.length})`));
      if (!all.length) console.log(c.dim('  none — ox schedule add 30m "<prompt>" --enable'));
      for (const s of all) renderScheduleRow(s);
      console.log('');
      console.log(policy.optedIn
        ? c.green(`  daemon opted in · at most ${policy.maxInFlight} scheduled run(s) in flight`)
        : c.yellow('  daemon NOT opted in — nothing will run until `ox schedule opt-in`'));
      return;
    }

    case 'enable':
    case 'disable': {
      const id = rest.find((a) => !String(a).startsWith('-'));
      if (!id) {
        process.stderr.write(`usage: ox schedule ${sub} <id>\n`);
        process.exitCode = 3;
        return;
      }
      const res = updateSchedule(id, { enabled: sub === 'enable' });
      if (res.refusal) {
        if (json) console.log(JSON.stringify({ t: `schedule-${sub}`, ok: false, error: res.refusal }));
        else process.stderr.write(`${c.red(`✗ ${res.refusal}`)}\n`);
        process.exitCode = 1;
        return;
      }
      if (json) console.log(JSON.stringify({ t: `schedule-${sub}`, ok: true, schedule: res.schedule }));
      else console.log(`${c.green('✓')} ${sub === 'enable' ? 'enabled' : 'disabled'} ${res.schedule.id}${sub === 'enable' && res.schedule.nextRunAt ? c.dim(` — next run ${new Date(res.schedule.nextRunAt).toISOString().replace('T', ' ').slice(0, 19)}`) : ''}`);
      if (sub === 'enable' && !readPolicy().optedIn) console.log(c.yellow('  note: the daemon is not opted in — `ox schedule opt-in`'));
      return;
    }

    case 'remove':
    case 'rm':
    case 'delete': {
      const id = rest.find((a) => !String(a).startsWith('-'));
      if (!id) {
        process.stderr.write('usage: ox schedule remove <id>\n');
        process.exitCode = 3;
        return;
      }
      const res = removeSchedule(id);
      if (!res.removed) {
        if (json) console.log(JSON.stringify({ t: 'schedule-remove', ok: false, error: res.reason }));
        else process.stderr.write(`${c.red(`✗ ${res.reason}`)}\n`);
        process.exitCode = 1;
        return;
      }
      const residue = scheduleResidue();
      if (json) console.log(JSON.stringify({ t: 'schedule-remove', ok: true, id: res.id, residue }));
      else console.log(`${c.green('✓')} removed ${res.id}${residue.count ? c.dim(` (${residue.count} left)`) : c.dim(' — no schedules left')}`);
      return;
    }

    case 'remove-all': {
      const res = removeAllSchedules();
      const residue = scheduleResidue();
      if (json) console.log(JSON.stringify({ t: 'schedule-remove-all', ok: true, removed: res.removed, residue }));
      else {
        console.log(`${c.green('✓')} removed ${res.removed} schedule(s)`);
        console.log(c.dim(`  residue: ${residue.live.length} live · files ${residue.files.length ? residue.files.map((f) => path.basename(f)).join(', ') : 'none'}`));
        console.log(c.dim('  no crontab entry, no launchd plist and no worker is ever created by a schedule.'));
      }
      return;
    }

    case 'run-now':
    case 'run': {
      const id = rest.find((a) => !String(a).startsWith('-'));
      if (!id) {
        process.stderr.write('usage: ox schedule run-now <id>\n');
        process.exitCode = 3;
        return;
      }
      if (has(rest, '--print-crontab')) {
        // Retained generator, now explicitly a PRINT. See cmdPrintCrontab.
        return printCrontabSnippet(rest);
      }
      // `attended`: a person typed "run this now" and is about to be shown what
      // happened. It does not relax the per-row `enabled` gate, and it does not
      // touch the timer — `dueSchedules` reads the policy and knows nothing about
      // it. It only stops "run it NOW" from refusing because the job is not due
      // until 09:00, which is what this command used to do.
      const res = await dispatchThroughDaemon(id, { trigger: 'manual', attended: true });
      if (!res.ok) {
        if (json) console.log(JSON.stringify({ t: 'schedule-run', ok: false, error: res.error }));
        else process.stderr.write(`${c.red(`✗ ${res.error}`)}\n`);
        process.exitCode = 1;
        return;
      }
      // `missed` is unreachable here: `claimSchedule` only files a miss for an
      // unattended claim, because "the daemon was not running" is not a reason
      // when the daemon was never involved. The timer path still produces it.
      if (json) console.log(JSON.stringify({ t: 'schedule-run', ok: true, workerId: res.workerId, pid: res.pid, stopped: res.stopped, reason: res.reason }));
      else if (res.stopped) console.log(c.yellow(`heartbeat ${id} did not fire: ${res.reason}`));
      else console.log(`${c.green('✓')} dispatched ${id} as worker ${c.bold(String(res.workerId))}${res.pid ? c.dim(` · pid ${res.pid}`) : ''}`);
      if (res.workerId) console.log(c.dim('  watch it   ox agents'));
      return;
    }

    case 'opt-in':
    case 'optin':
    case 'on': {
      const p = writePolicy({ optedIn: true });
      if (json) console.log(JSON.stringify({ t: 'schedule-policy', ok: true, policy: p }));
      else console.log(`${c.green('✓')} the daemon may now dispatch enabled schedules ${c.dim(`(at most ${p.maxInFlight} in flight)`)}`);
      const n = listSchedules().filter((s) => s.enabled).length;
      console.log(c.dim(`  ${n} enabled schedule(s) will fire on their cadence`));
      return;
    }
    case 'opt-out':
    case 'optout':
    case 'off': {
      const p = writePolicy({ optedIn: false });
      if (json) console.log(JSON.stringify({ t: 'schedule-policy', ok: true, policy: p }));
      else console.log(`${c.green('✓')} the daemon will dispatch nothing. Schedules are kept; re-enable with \`ox schedule opt-in\`.`);
      return;
    }

    case 'policy': {
      const p = readPolicy();
      const residue = scheduleResidue();
      if (json) console.log(JSON.stringify({ t: 'schedule-policy', ok: true, policy: p, residue }));
      else {
        console.log(c.bold('schedule policy'));
        console.log(`  opted in      ${p.optedIn ? c.green('yes') : c.yellow('no — nothing runs')}`);
        console.log(`  max in flight ${p.maxInFlight}`);
        console.log(`  miss grace    ${formatDuration(p.missGraceMs)}`);
        console.log(`  store         ${residue.dir}`);
        console.log(`  live          ${residue.count}`);
        console.log(`  due now       ${dueSchedules({ policy: p }).length}`);
      }
      return;
    }

    case 'print-crontab':
    case 'crontab':
      return printOrInstallCrontab(rest);

    case '':
    case '-h':
    case '--help':
    case 'help':
      if (wantPrint) return printOrInstallCrontab(rest);
      console.log(USAGE.join('\n'));
      return;

    default: {
      // `ox schedule "<goal>"` — the documented crontab form (README.md, the
      // command table in docs/autonomy.md). It is NOT retired, so an
      // unrecognised first token is the goal rather than a usage error. Making it
      // a usage error is how a documented command disappears: every existing
      // invocation of `ox schedule "triage the inbox" --at 09:00` would start
      // failing, and the only record of that would be this changelog.
      //
      // The guess this branch is guessing at is "subcommand typo", and the cost
      // of guessing wrong is a crontab block printed for the word the user typed.
      // A near-miss gets a hint instead of silence, because
      // `ox schedule lst` printing a cron block for "lst" helps nobody.
      // `sub` is lowercased for matching; the hint has to quote what the user
      // actually typed, so it reads `args[0]`.
      const typed = String(args[0] ?? '');
      const hint = nearSubcommand(typed);
      // `args`, not `rest`: in the legacy shape the GOAL is the first token, so
      // `rest` is flags only and the goal would read as empty.
      await printOrInstallCrontab(args);
      if (hint) console.log(c.yellow(`  did you mean \`ox schedule ${hint}\`? (that printed a crontab block for the goal "${typed}")`));
      return;
    }
  }
}

// One edit away from a real subcommand, so a typo can be named rather than
// silently treated as a goal. Exact match is excluded; that is the real branch.
const NEAR_SUBCOMMANDS = ['add', 'list', 'enable', 'disable', 'remove', 'remove-all', 'run-now', 'opt-in', 'opt-out', 'policy', 'print-crontab'];

function nearSubcommand(sub) {
  const word = String(sub ?? '').toLowerCase();
  if (!word || word.length > 12) return null;
  for (const name of NEAR_SUBCOMMANDS) {
    if (Math.abs(name.length - word.length) > 1) continue;
    if (name === word) return null;
    if (editDistanceWithinOne(name, word)) return name;
  }
  return null;
}

function editDistanceWithinOne(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) { i++; }
    j++;
  }
  if (i < short.length || j < long.length) edits++;
  return edits <= 1;
}

// ---------------------------------------------------------------------------
// The crontab generator, and the gate in front of installing one.
//
// `ox schedule "<goal>" [--at HH:MM] [--max-cost N] [--install]` is a DOCUMENTED,
// user-facing command: README.md lists it in the command table and
// docs/autonomy.md shows the generated block, the `--install` form and the
// `OX_INSTALL_YES=1 ... --yes` non-TTY escape. It is therefore not retired, and
// an unrecognised first token after `ox schedule` is a GOAL rather than a usage
// error — otherwise the command only "works" if nobody has read the release note
// that removed it.
//
// What changed is WHERE the decision is made, not WHETHER it exists:
//
//   * The block builder is pure and lives in src/schedule.js. Printing writes
//     nothing anywhere except stdout.
//   * `--install` writes to the real system crontab, and only ever behind TWO
//     independent gates: a TTY plus an interactive confirmation, or -- when
//     there is no TTY to ask -- `--yes` AND `OX_INSTALL_YES=1`. A non-TTY
//     `--install` with neither refuses with exit 4 and touches no crontab at
//     all, which is the state docs/autonomy.md promises.
//   * The installer is idempotent through `planScheduleInstall`, keyed on the
//     marker hash, so running it twice appends once.
//
// A crontab entry is still a second execution path outside ox's boundary: ox
// cannot cost-cap it, cannot list it, and cannot remove it. That is why the
// printed output says so out loud rather than treating the two as peers.
// ---------------------------------------------------------------------------

const CRONTAB_USAGE = 'usage: ox schedule "<goal>" [--at HH:MM] [--max-cost <usd>] [--cwd <dir>]\n'
  + '       ox schedule print-crontab "<goal>" ...    the same thing, named explicitly\n'
  + '       ox schedule "<goal>" --install           append to the system crontab (TTY confirm;\n'
  + '                                               non-TTY needs --yes AND OX_INSTALL_YES=1)';

function crontabBlockFromArgs(args = []) {
  const goal = positionalOf(args).join(' ').trim();
  if (!goal) return { refusal: CRONTAB_USAGE };
  // `--at` goes through the SAME parser the store uses, so `--at 25:99` is a
  // refusal rather than the silent 09:00 the builder's fallback would produce.
  // A schedule that quietly runs at the wrong time is worse than one that refuses.
  const cad = parseCadence({ kind: 'at', at: flagPair(args, '--at') ?? '09:00' });
  if (cad.refusal) return { refusal: cad.refusal };
  const maxCostRaw = flagPair(args, '--max-cost');
  let maxCostUsd = DEFAULT_SCHEDULE_MAX_COST_USD * 2;
  if (maxCostRaw !== null) {
    const n = Number(maxCostRaw);
    if (!Number.isFinite(n) || n < 0) return { refusal: `--max-cost needs a finite nonnegative number, got '${maxCostRaw}'` };
    maxCostUsd = n;
  }
  const built = buildScheduleBlock({
    goal,
    at: cad.cadence.at,
    cwd: flagPair(args, '--cwd') ?? process.cwd(),
    binPath: OX_BIN_PATH,
    logFile: flagPair(args, '--log-file') ?? path.join(os.homedir(), '.ox', 'auto.log'),
    keyEnv: flagPair(args, '--key-env') ?? 'OX_API_KEY',
    maxCostUsd,
  });
  return { built };
}

function printCrontabBlock(built, { warn }) {
  console.log(c.bold('crontab block \u2014 ox never installs anything by itself'));
  console.log('');
  console.log(built.block.trimEnd());
  console.log('');
  console.log(c.bold('launchd alternative (macOS) \u2014 PRINTED, NEVER LOADED'));
  console.log(c.dim('save it as a plist yourself if you prefer launchd to cron; ox loads nothing.'));
  console.log('');
  console.log(built.launchd.trimEnd());
  console.log('');
  console.log(c.dim(`marker hash: ${built.hash}`));
  if (warn) {
    console.log('');
    console.log(c.yellow('If you paste this in, the job is outside ox:'));
    console.log(c.dim('  it is not listed by `ox schedule list`, `ox schedule remove` cannot stop it,'));
    console.log(c.dim('  and it is not cleared by `ox schedule remove-all` \u2014 remove it with `crontab -e`.'));
    console.log(c.dim('  The daemon-backed equivalent is cost-capped and removable:'));
    console.log(c.dim('    ox schedule add "<prompt>" --at HH:MM --max-cost <usd> --enable'));
    console.log(c.dim('    ox schedule opt-in'));
  }
}

async function confirmOnTty(question) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

async function installCrontabBlock(args, built) {
  // Gate first, crontab never: this function refuses before it shells out at all,
  // so a non-TTY `--install` without both confirmations cannot touch the real
  // crontab even for the read that a plan would need.
  const interactive = Boolean(process.stdin.isTTY);
  const flagYes = has(args, '--yes');
  const envYes = String(process.env.OX_INSTALL_YES ?? '').trim() === '1';
  if (!interactive && !(flagYes && envYes)) {
    process.stderr.write(`${c.red('\u2717 refusing to write to your system crontab: this is not a terminal, and unattended installs need both confirmations.')}\n`);
    process.stderr.write('  re-run with both, if you really mean it:\n');
    process.stderr.write('    ox schedule "<goal>" --at HH:MM --install --yes      # and OX_INSTALL_YES=1\n');
    process.stderr.write('  or paste the printed block in yourself with `crontab -e`.\n');
    process.stderr.write(c.dim('  the daemon-backed equivalent is listed, cost-capped and removable by ox:\n'));
    process.stderr.write(c.dim('    ox schedule add "<prompt>" --at HH:MM --enable   &&   ox schedule opt-in\n'));
    process.exitCode = 4;
    return;
  }
  if (interactive && !flagYes) {
    const ok = await confirmOnTty(`append this ${built.hour}:${built.minute} job to your crontab? [y/N] `);
    if (!ok) {
      process.stderr.write('not installed\n');
      process.exitCode = 4;
      return;
    }
  }
  const { execFileSync } = await import('node:child_process');
  let existing = '';
  try {
    existing = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // `crontab -l` exits non-zero when the user has no crontab at all. That is an
    // empty crontab, not a failure.
    existing = '';
  }
  const plan = planScheduleInstall(existing, built.hash);
  if (plan.action === 'already-installed') {
    console.log(`${c.green('\u2713')} already installed \u2014 marker ${SCHEDULE_MARKER_PREFIX}${built.hash} is in your crontab, nothing appended`);
    console.log(c.dim('  remove it with `crontab -e` (delete the whole marked block)'));
    return;
  }
  const next = `${existing.replace(/\s*$/, '')}\n${built.block}`;
  try {
    execFileSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  } catch (err) {
    process.stderr.write(`${c.red(`\u2717 could not write your crontab: ${err?.message ?? err}`)}\n`);
    process.exitCode = 4;
    return;
  }
  console.log(`${c.green('\u2713')} installed \u2014 marker ${SCHEDULE_MARKER_PREFIX}${built.hash}, daily at ${built.hour}:${built.minute}`);
  console.log(c.dim('  this job now lives OUTSIDE ox: `ox schedule list` cannot see it and'));
  console.log(c.dim('  `ox schedule remove` cannot stop it. Remove it with `crontab -e`.'));
}

async function printOrInstallCrontab(args = []) {
  const built = crontabBlockFromArgs(args);
  if (built.refusal) {
    process.stderr.write(`${c.red(`\u2717 ${built.refusal}`)}\n`);
    process.exitCode = 3;
    return;
  }
  if (has(args, '--install')) return installCrontabBlock(args, built.built);
  printCrontabBlock(built.built, { warn: true });
}

// ---------------------------------------------------------------------------
// ox cron — the historical name, kept working.
//
// `ox cron` was a user-facing command before `ox schedule` existed, and the
// difference between the two names was never cosmetic: `ox cron` took FREE TEXT
// (`ox cron add "every minute"`) and printed `scheduled job <id>`. It is not
// documented in README.md or docs/ today, but it is not an internal name either —
// it is the spelling in scripts, and it is what test/cli-defects.test.js grades.
//
// So it is kept as a compatibility surface over the SAME store, with its own
// wording, rather than deleted or redirected to the modern surface:
//
//   ox cron add "<what to run>"    free text; the cadence is read out of it
//   ox cron list                   the same rows `ox schedule list` prints
//   ox cron run <id>               run this one now, attended
//   ox cron pause|resume <id>      the adapter's old pause/resume verbs
//   ox cron remove <id>            ox schedule remove <id>
//
// Two behaviours are deliberately NOT the modern ones, because they are what the
// old surface meant:
//
//   * `add` ARMS the row (`enabled: true`). The old scheduler had no second gate,
//     so an added job was a live job. The daemon-wide switch is still OFF and the
//     output says so on the same screen — an armed row nobody opted in for fires
//     on nothing, which is the same thing the old scheduler's unref'd timers did.
//
// `run` is attended and prints the legacy `ran job <id>`. It dispatches through
// the daemon like every other run, so there is exactly one execution path; what it
// does NOT do is pretend. The old `runNow` printed "ran job" after ticking a
// counter that called `job.handlers?.run`, a property nothing in the repository
// ever set — it never executed anything. This one starts a worker.
// ---------------------------------------------------------------------------

const CRON_USAGE = [
  'usage:',
  '  ox cron add "<what to run>"        free text — "every minute", "every 5 minutes", "nightly at 07:30"',
  '  ox cron list                      every job: cadence, cap, next run, last result',
  '  ox cron run <id>                  run this job NOW (attended; needs no opt-in)',
  '  ox cron pause <id> | resume <id>  disable / enable one job',
  '  ox cron remove <id>               ox schedule remove <id>',
  '',
  '  `ox cron` is the old name for `ox schedule` — same store, same rows, one daemon.',
  '  `ox schedule add "<prompt>" --every 30m --enable` is the explicit form.',
];

async function cronAdd(args = []) {
  const text = positionalOf(args).join(' ').trim();
  if (!text) {
    process.stderr.write('usage: ox cron add "<what to run>"\n');
    process.exitCode = 3;
    return;
  }
  const cad = parseNaturalCadence(text);
  if (cad.refusal) {
    process.stderr.write(`${c.red(`✗ ${cad.refusal}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const maxCostRaw = flagPair(args, '--max-cost');
  const added = addSchedule({
    prompt: text,
    cadence: cad.cadence,
    cwd: flagPair(args, '--cwd') ?? process.cwd(),
    maxCostUsd: maxCostRaw === null ? undefined : Number(maxCostRaw),
    bot: flagPair(args, '--bot'),
    model: flagPair(args, '--model'),
    enabled: true,
    // The whole raw arg set goes through the privilege screen, exactly as the
    // modern surface does: a legacy verb is not an exemption from the rules.
    flags: Object.fromEntries(args.filter((a) => String(a).startsWith('-')).map((a) => [a.replace(/^--?/, ''), true])),
  });
  if (added.refusal) {
    process.stderr.write(`${c.red(`✗ ${added.refusal}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const s = added.schedule;
  console.log(`${c.green('✓')} scheduled job ${c.bold(s.id)} — ${s.cadence.description}`);
  console.log(`  prompt  ${s.prompt}`);
  console.log(`  cap     $${s.maxCostUsd} ${c.dim(`(${s.costCapSource})`)}`);
  console.log(`  next    ${scheduleRunStatus(s).text}`);
  if (!readPolicy().optedIn) {
    console.log(c.yellow('  the daemon is OFF — nothing fires on a timer until `ox schedule opt-in`.'));
    console.log(c.dim(`  run this one now:  ox cron run ${s.id}`));
  }
}

async function cronRun(args = []) {
  const id = args.find((a) => !String(a).startsWith('-'));
  if (!id) {
    process.stderr.write('usage: ox cron run <id>\n');
    process.exitCode = 3;
    return;
  }
  // Resolved here, before the daemon is touched, so a mistyped id reports itself
  // instead of starting a supervisor on the way to discovering the typo.
  const job = getSchedule(id);
  if (!job) {
    process.stderr.write(`${c.red(`✗ no scheduled job with id '${id}'`)}\n`);
    process.exitCode = 1;
    return;
  }
  const res = await dispatchThroughDaemon(id, { trigger: 'manual', attended: true });
  if (!res.ok) {
    process.stderr.write(`${c.red(`✗ ${res.error}`)}\n`);
    process.exitCode = 1;
    return;
  }
  if (res.stopped) {
    console.log(c.yellow(`ran job ${id} — heartbeat did not fire: ${res.reason}`));
    return;
  }
  console.log(`${c.green('✓')} ran job ${c.bold(id)}${res.workerId ? c.dim(` as worker ${res.workerId}`) : ''}${res.pid ? c.dim(` · pid ${res.pid}`) : ''}`);
  console.log(c.dim('  dispatched through the daemon — `ox agents` to watch it'));
}

async function cronSetEnabled(args, enabled) {
  const id = args.find((a) => !String(a).startsWith('-'));
  if (!id) {
    process.stderr.write(`usage: ox cron ${enabled ? 'resume' : 'pause'} <id>\n`);
    process.exitCode = 3;
    return;
  }
  const res = updateSchedule(id, { enabled });
  if (res.refusal) {
    process.stderr.write(`${c.red(`✗ ${res.refusal}`)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`${c.green('✓')} ${enabled ? 'resumed' : 'paused'} ${c.bold(res.schedule.id)}`);
}

async function cronRemove(args = []) {
  const id = args.find((a) => !String(a).startsWith('-'));
  if (!id) {
    process.stderr.write('usage: ox cron remove <id>\n');
    process.exitCode = 3;
    return;
  }
  const res = removeSchedule(id);
  if (!res.removed) {
    process.stderr.write(`${c.red(`✗ no scheduled job with id '${id}'`)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`${c.green('✓')} removed ${res.id}${c.dim(` (${listSchedules().length} left)`)}`);
}

export async function cmdCron(args = []) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  const rest = args.slice(1);
  switch (sub) {
    case 'add':
      return cronAdd(rest);
    case 'list':
    case 'ls': {
      const all = listSchedules();
      const policy = readPolicy();
      // `--json` is honoured rather than ignored: a flag that is silently dropped
      // is how `ox cron list | jq` quietly becomes a human table.
      if (has(args, '--json')) {
        console.log(JSON.stringify({ t: 'cron-list', schedules: all, policy }));
        return;
      }
      console.log(c.bold(`scheduled jobs (${all.length})`));
      if (!all.length) console.log(c.dim('  none — ox cron add "every minute" "<what to run>"'));
      for (const s of all) renderScheduleRow(s);
      console.log('');
      console.log(policy.optedIn
        ? c.green('  daemon opted in · enabled jobs fire on their cadence')
        : c.yellow('  daemon NOT opted in — only `ox cron run <id>` will fire anything'));
      return;
    }
    case 'run':
    case 'run-now':
      return cronRun(rest);
    case 'pause':
    case 'disable':
      return cronSetEnabled(rest, false);
    case 'resume':
    case 'enable':
      return cronSetEnabled(rest, true);
    case 'remove':
    case 'rm':
    case 'delete':
      return cronRemove(rest);
    case '':
    case 'help':
    case '-h':
    case '--help':
      console.log(CRON_USAGE.join('\n'));
      return;
    default:
      process.stderr.write(`ox: unknown cron subcommand '${sub}'\n\n${CRON_USAGE.join('\n')}\n`);
      process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// ox heartbeat
//
// A heartbeat is a schedule that re-enters an EXISTING session instead of
// starting a new one. The two differences that matter are both about the goal:
// it reads the goal off that session's own transcript (through the same loader
// `--resume` uses), and it STOPS when the goal completes or is paused — because
// a timer that keeps going after its subject is finished is how unattended
// agents end up spending money at 4am on a task that was done at noon.
// ---------------------------------------------------------------------------

// The goal a heartbeat would advance, read with the SAME loader `--resume` uses,
// so `ox heartbeat start` cannot see a goal state the user's own resume would
// disagree with. A transcript that cannot be read yields null, which refuses the
// heartbeat rather than letting it run against a goal nobody can see.
function readGoalOf(file) {
  try {
    return loadSessionWithStatus(String(file))?.goal ?? null;
  } catch {
    return null;
  }
}

function goalCwdOf(file) {
  try {
    const rec = loadSessionWithStatus(String(file));
    const meta = (rec?.messages ?? []).find((e) => e?.t === 'meta');
    return meta?.cwd ?? null;
  } catch {
    return null;
  }
}

// Resolve a session reference the way `ox --resume` does: a path, a session id
// prefix, or nothing at all for the most recent session in this directory.
function resolveSessionRef(ref, { cwd = process.cwd() } = {}) {
  const text = String(ref ?? '').trim();
  if (!text || text === 'last' || text === '--last') {
    const file = latestSessionFile(cwd);
    return file ? { file, matched: 'latest' } : { error: 'no session transcript found for this directory' };
  }
  if (text.endsWith('.jsonl') && fs.existsSync(text)) return { file: path.resolve(text), matched: 'path' };
  const rows = listSessions(200);
  const hit = rows.find((r) => r.id === text) ?? rows.find((r) => r.file.includes(text)) ?? rows.find((r) => (r.title || '').includes(text));
  if (!hit) return { error: `no session matches '${text}' — try \`ox sessions\`` };
  return { file: hit.file, matched: hit.id };
}

export async function cmdHeartbeat(args = []) {
  const sub = String(args[0] ?? '').toLowerCase();
  const rest = args.slice(1);
  const json = has(rest, '--json');

  switch (sub) {
    case 'start': {
      const ref = rest.find((a) => !String(a).startsWith('-'));
      const every = flagPair(rest, '--every');
      const at = flagPair(rest, '--at');
      const cadenceInput = at ? { kind: 'at', at } : every ? (() => {
        const p = parseIntervalSpec(every);
        if (p.refusal) return { refusal: p.refusal };
        return { kind: 'interval', everyMs: p.everyMs };
      })() : { kind: 'interval', everyMs: 300000 };
      if (cadenceInput.refusal) {
        if (json) console.log(JSON.stringify({ t: 'heartbeat-start', ok: false, error: cadenceInput.refusal }));
        else process.stderr.write(`${c.red(`✗ ${cadenceInput.refusal}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const resolved = resolveSessionRef(ref);
      if (resolved.error) {
        if (json) console.log(JSON.stringify({ t: 'heartbeat-start', ok: false, error: resolved.error }));
        else process.stderr.write(`${c.red(`✗ ${resolved.error}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const goal = readGoalOf(resolved.file);
      if (!goal) {
        const msg = 'that session has no active persistent goal \\u2014 `/goal <text>` in it first. A heartbeat advances a goal; with none it would just start unrelated work.';
        if (json) console.log(JSON.stringify({ t: 'heartbeat-start', ok: false, error: msg }));
        else process.stderr.write(`${c.red(`✗ ${msg}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const maxRunsRaw = flagPair(rest, '--max-runs');
      const added = addSchedule({
        kind: 'heartbeat',
        prompt: `continue the persistent goal: ${goal.objective}`,
        cadence: cadenceInput,
        cwd: goalCwdOf(resolved.file) ?? process.cwd(),
        maxCostUsd: flagPair(rest, '--max-cost') === null ? undefined : Number(flagPair(rest, '--max-cost')),
        bot: flagPair(rest, '--bot'),
        model: flagPair(rest, '--model'),
        enabled: true,
        session: resolved.file,
        maxRuns: maxRunsRaw === null ? undefined : Number(maxRunsRaw),
        goalBound: !has(rest, '--no-goal-binding'),
      });
      if (added.refusal) {
        if (json) console.log(JSON.stringify({ t: 'heartbeat-start', ok: false, error: added.refusal }));
        else process.stderr.write(`${c.red(`✗ ${added.refusal}`)}\n`);
        process.exitCode = 3;
        return;
      }
      const hb = added.schedule;
      const policy = readPolicy();
      if (json) {
        console.log(JSON.stringify({ t: 'heartbeat-start', ok: true, heartbeat: hb, optedIn: policy.optedIn }));
        return;
      }
      console.log(`${c.green('✓')} heartbeat ${c.bold(hb.id)} on session ${c.dim(path.basename(hb.session ?? ''))}`);
      console.log(`  goal      ${goal.objective}`);
      console.log(`  cadence   ${hb.cadence.description} · at most ${hb.maxRuns} heartbeat(s) · cap $${hb.maxCostUsd} (${hb.costCapSource})`);
      console.log(`  stops     when the goal completes, when it is paused, or after ${hb.maxRuns} heartbeat(s)`);
      if (!policy.optedIn) console.log(c.yellow('  daemon    schedules are OFF — `ox schedule opt-in` lets it fire'));
      return;
    }

    case 'list':
    case 'ls': {
      const beats = listSchedules().filter((s) => s.kind === 'heartbeat');
      const policy = readPolicy();
      if (json) {
        console.log(JSON.stringify({ t: 'heartbeat-list', heartbeats: beats, policy }));
        return;
      }
      console.log(c.bold(`heartbeats (${beats.length})`));
      if (!beats.length) console.log(c.dim('  none — ox heartbeat start [--every 5m] [--max-runs 3]'));
      for (const s of beats) {
        const stopped = s.runs >= s.maxRuns ? c.yellow('budget spent') : s.enabled ? c.green('active') : c.dim('disabled');
        const why = s.lastRun?.state?.startsWith('stopped:') ? c.dim(` (${s.lastRun.state.slice(8)})`) : '';
        console.log(`  ${pad(s.id, 12)} ${pad(s.cadence.description, 16)} ${pad(`${s.runs}/${s.maxRuns}`, 8)} ${pad(stopped, 18)}${why}`);
        console.log(c.dim(`    session ${s.session ?? '-'}${s.goalBound === false ? ' · NOT goal-bound' : ''}`));
        if (s.lastRun) console.log(c.dim(`    last    ${new Date(s.lastRun.at).toISOString().replace('T', ' ').slice(0, 19)} — ${s.lastRun.state}${s.lastRun.note ? ` · ${s.lastRun.note}` : ''}`));
      }
      if (!policy.optedIn) console.log(c.yellow('  daemon NOT opted in — nothing fires until `ox schedule opt-in`'));
      return;
    }

    case 'stop':
    case 'rm':
    case 'remove': {
      const id = rest.find((a) => !String(a).startsWith('-'));
      if (!id) {
        process.stderr.write('usage: ox heartbeat stop <id>\\n');
        process.exitCode = 3;
        return;
      }
      const res = removeSchedule(id);
      if (!res.removed) {
        if (json) console.log(JSON.stringify({ t: 'heartbeat-stop', ok: false, error: res.reason }));
        else process.stderr.write(`${c.red(`✗ ${res.reason}`)}\n`);
        process.exitCode = 1;
        return;
      }
      if (json) console.log(JSON.stringify({ t: 'heartbeat-stop', ok: true, id: res.id }));
      else console.log(`${c.green('✓')} heartbeat ${res.id} removed — no timer, no worker, nothing left running`);
      return;
    }

    case '':
    case '-h':
    case '--help':
    case 'help':
      console.log([
        'usage:',
        '  ox heartbeat start [<session>] [--every <5m>] [--at HH:MM] [--max-runs 3]',
        '                           [--max-cost <usd>] [--no-goal-binding]',
        '  ox heartbeat list             heartbeats, their budget, and what stopped each one',
        '  ox heartbeat stop <id>',
        '',
        'A heartbeat re-enters an EXISTING session and advances its persistent goal.',
        'It stops when the goal completes, when it is paused, or when its budget of',
        'heartbeats is spent — so it can never loop for ever.',
      ].join('\n'));
      return;

    default:
      process.stderr.write(`ox: unknown heartbeat subcommand '${sub}' (try \`ox heartbeat help\`)\n`);
      process.exitCode = 3;
  }
}
