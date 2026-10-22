#!/usr/bin/env node
// bench/real/runner.mjs - the REAL agent benchmark runner.
//
//   node bench/real/runner.mjs --model ox-ollama:qwen2.5:0.5b --task debug-and-fix
//   node bench/real/runner.mjs --model <spec> --all --repeats 3 --json out.json
//   node bench/real/runner.mjs --list
//
// --model is REQUIRED. There is no default and no silent fallback: a benchmark that
// picks a model for you is a benchmark whose results you cannot interpret.
//
// What makes this different from bench/runner.mjs: there is no mock provider and no
// `script()` hook. ox is spawned for real, a real model picks which tools to call,
// and pass/fail comes from executing code against the workspace the agent left
// behind. Zero deps beyond node built-ins.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REAL_TASKS, TASK_IDS } from './tasks.mjs';
import {
  EVENTS_FILE, TIMINGS_FILE, agentEnv, createSandbox, destroySandbox, oneLine, parseNdjsonEvents, spawnOx,
  summarizeEvents, writeEventsFile, writeTimingsFile,
} from './lib.mjs';

// Only read-only project config is imported. Nothing under src/ is modified.
import { resolveBot } from '../../src/bots.js';
import { loadConfig } from '../../src/config.js';
import { costOf, formatCost } from '../../src/cost.js';
import { loadKeysIntoEnv } from '../../src/keystore.js';

const USAGE = [
  'usage: node bench/real/runner.mjs --model <provider:model> [options]',
  '',
  '  --model <spec>      REQUIRED. e.g. ox-ollama:qwen2.5:0.5b',
  '                       or ox-openrouter:meta-llama/llama-3.3-70b-instruct',
  '  --task <id>         run exactly one task (see --list)',
  '  --filter <regex>    run every task whose id/name/category matches',
  '  --all               run every task (default when neither --task nor --filter)',
  '  --repeats <n>       independent repeats per task, fresh sandbox each time (default 1)',
  '  --json <path>       write machine-readable results',
  '  --keep              leave sandboxes on disk and print their paths',
  '  --timeout <ms>      override every task timeout',
  '  --list              list tasks and exit',
  '  -h, --help          this text',
].join('\n');

function parseArgs(argv) {
  const opts = {
    model: process.env.OX_REALBENCH_MODEL ?? null,
    task: null,
    filter: null,
    all: false,
    repeats: 1,
    jsonOut: null,
    keep: false,
    timeoutMs: null,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`bench/real: ${a} needs a value\n${USAGE}\n`);
        process.exit(3);
      }
      return String(v);
    };
    switch (a) {
      case '--model': opts.model = next(); break;
      case '--task': opts.task = next(); break;
      case '--filter': opts.filter = new RegExp(next(), 'i'); break;
      case '--all': opts.all = true; break;
      case '--repeats': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) {
          process.stderr.write('bench/real: --repeats must be a positive integer\n');
          process.exit(3);
        }
        opts.repeats = n;
        break;
      }
      case '--json': opts.jsonOut = next(); break;
      case '--keep': opts.keep = true; break;
      case '--timeout': opts.timeoutMs = Number(next()); break;
      case '--list': opts.list = true; break;
      case '-h': case '--help': console.log(USAGE); return null;
      default:
        process.stderr.write(`bench/real: unknown arg '${a}'\n${USAGE}\n`);
        process.exit(3);
    }
  }
  if (opts.timeoutMs != null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000)) {
    process.stderr.write('bench/real: --timeout must be at least 1000ms\n');
    process.exit(3);
  }
  return opts;
}

// Loopback-only reachability probe for the keyless ollama provider, so a machine
// without Ollama gets one clear message instead of nine confusing failures.
function probeTcp(hostPort, timeoutMs = 500) {
  return new Promise((resolve) => {
    const [host, port] = String(hostPort).split(':');
    const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) || 11434 });
    const done = (ok) => { try { socket.destroy(); } catch {} resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function selectTasks(opts) {
  if (opts.task) {
    const t = REAL_TASKS.find((x) => x.id === opts.task);
    if (!t) {
      process.stderr.write(`bench/real: unknown task '${opts.task}'. known: ${TASK_IDS.join(', ')}\n`);
      process.exit(3);
    }
    return [t];
  }
  if (opts.filter) {
    return REAL_TASKS.filter((t) => opts.filter.test(t.id) || opts.filter.test(t.name) || opts.filter.test(t.category));
  }
  return REAL_TASKS;
}

export function costFor(model, summary) {
  if (summary?.costUsd != null) return summary.costUsd;
  return costOf(model, { inputTokens: summary?.inputTokens ?? 0, outputTokens: summary?.outputTokens ?? 0 });
}

// Benchmarks must resolve the same saved bot definitions as `ox` itself.  The
// runner is invoked directly with Node (rather than through the CLI bootstrap),
// so load the local key store explicitly before validating a provider.  Keys
// remain only in process memory and are inherited by the sandboxed child; they
// are never serialized into benchmark output.
export function resolveBenchmarkTarget(spec, config = {}) {
  return resolveBot(spec, config, process.env);
}

// A named bot saved by a user is unavailable inside the fresh sandbox HOME.
// Standard providers, however, are portable as provider:model and receive the
// inherited credential without copying the user's whole ~/.ox configuration.
// Keep custom endpoints and subscription adapters as their original spec:
// their endpoint/sign-in setup cannot safely be reconstructed from a model ID.
export function benchmarkExecutionSpec(spec, target, config = {}) {
  const name = String(spec).trim().split(':', 1)[0];
  const saved = config?.bots?.[name];
  if (saved && target?.provider && target.provider !== 'custom' && target.provider !== 'subscription') {
    return `${target.provider}:${target.model}`;
  }
  return spec;
}

// One agent run against one fresh sandbox, then the verifier grades the world.
// `deps.spawn` is the seam the test suite uses to hand in a canned NDJSON child
// instead of paying for a real model; production always uses spawnOx.
export async function runOnce(task, spec, opts, deps = {}) {
  const spawn = deps.spawn ?? spawnOx;
  const sb = createSandbox(`${task.id}`);
  const timeoutMs = opts.timeoutMs ?? task.timeoutMs ?? 180_000;
  const started = Date.now();
  let verification = { pass: false, detail: 'agent did not run', checks: [] };
  let summary = null;
  let agent = { exitCode: null, stdout: '', stderr: '', timedOut: false };
  let setupError = null;
  // Hoisted: the stream has to outlive the try block, because --keep persists it
  // after setup/verify have already run.
  let events = [];
  let rawStream = '';
  try {
    const cleanup = await task.setup(sb.ws);
    // -y: headless stdin is never a TTY, so without it every write and every
    // non-read-only bash call is declined and the agent cannot do the task at all.
    // The workspace is a throwaway temp dir, so auto-approval costs nothing here.
    const args = ['-p', task.prompt, '--json', '--model', deps.executionSpec ?? spec, '-y'];
    agent = await spawn({ args, cwd: sb.ws, env: agentEnv({ home: sb.home }), timeoutMs });
    rawStream = String(agent.stdout ?? '');
    events = parseNdjsonEvents(rawStream);
    summary = summarizeEvents(events, agent.eventTimings);
    try {
      verification = await task.verify({
        ws: sb.ws,
        sandbox: sb,
        task,
        events,
        summary,
        exitCode: agent.exitCode,
        timedOut: agent.timedOut,
        args,
      });
    } catch (err) {
      verification = {
        pass: false,
        detail: `verifier threw: ${err?.stack ?? err}`,
        checks: [{ name: 'verify() completed', ok: false, detail: oneLine(err?.message ?? err) }],
      };
    }
  } catch (err) {
    setupError = err?.stack ?? String(err);
    verification = { pass: false, detail: `task setup/verify harness error: ${setupError}`, checks: [] };
  }

  const pass = Boolean(verification?.pass);
  // Honesty rule: a timeout, an ox crash, or a total absence of tool calls is a FAIL
  // and says so, but the verifier's own detail is always preserved verbatim because
  // it is the only thing that makes a failure diagnosable.
  const diagnostics = [];
  if (agent.timedOut) diagnostics.push(`agent TIMED OUT after ${timeoutMs}ms (SIGKILL)`);
  if (agent.exitCode != null && agent.exitCode !== 0) diagnostics.push(`ox exited ${agent.exitCode}`);
  if (setupError) diagnostics.push(`setup error: ${oneLine(setupError, 300)}`);
  if (summary && summary.toolCalls === 0) diagnostics.push('the agent made ZERO tool calls');
  if (summary && summary.toolErrors > 0) diagnostics.push(`${summary.toolErrors} tool call(s) errored`);
  if (agent.stderr && oneLine(agent.stderr)) diagnostics.push(`stderr: ${oneLine(agent.stderr, 240)}`);
  if (summary && summary.errors.length) diagnostics.push(`agent error events: ${oneLine(summary.errors.join('; '), 240)}`);

  // `spec` can be an Ox bot alias (for example `ox-gpt`), which is not a
  // provider model ID and therefore cannot be priced. Resolve it once here so
  // a genuine priced run never gets reported as “unpriced” merely because the
  // user chose the convenient bot name.
  let resolvedModel = deps.modelId ?? spec;
  if (!deps.modelId) {
    try { resolvedModel = resolveBot(spec, {}).model ?? spec; } catch { /* fixture/custom spec: retain it */ }
  }
  const costUsd = costFor(resolvedModel, summary);
  const kept = opts.keep;
  let sandboxPath = null;
  let eventsFile = null;
  let timingsFile = null;
  let eventsKept = 0;
  if (kept) {
    sandboxPath = sb.root;
    // The stream lives only in this function's stack. Without --keep it is gone
    // the moment the summary prints; with --keep the sandbox outlives it, so the
    // events MUST land on disk first or the kept sandbox has no provenance at all.
    try {
      const written = writeEventsFile(sb, events, rawStream);
      eventsFile = written.path;
      eventsKept = written.events;
      try { timingsFile = writeTimingsFile(sb, agent.eventTimings).path; } catch (err) {
        process.stderr.write(`bench/real: could not write ${TIMINGS_FILE}: ${oneLine(err?.message ?? err, 200)}\n`);
      }
      if (written.unparsable > 0) {
        process.stderr.write(
          `bench/real: ${EVENTS_FILE}: ${written.unparsable} unparsable stream line(s) not persisted\n`
        );
      }
    } catch (err) {
      process.stderr.write(`bench/real: could not write ${EVENTS_FILE}: ${oneLine(err?.message ?? err, 200)}\n`);
      eventsFile = null;
    }
  } else {
    destroySandbox(sb);
  }

  return {
    taskId: task.id,
    category: task.category,
    pass,
    detail: verification?.detail ?? '',
    checks: Array.isArray(verification?.checks) ? verification.checks : [],
    ms: Date.now() - started,
    agentMs: agent.ms,
    firstTextMs: summary?.firstTextMs ?? null,
    firstToolMs: summary?.firstToolMs ?? null,
    toolDurationMs: summary?.toolDurationMs ?? null,
    timedTools: summary?.timedTools ?? 0,
    exitCode: agent.exitCode,
    timedOut: Boolean(agent.timedOut),
    toolCalls: summary?.toolCalls ?? 0,
    uniqueCalls: summary?.uniqueCalls ?? 0,
    redundantCalls: summary?.redundantCalls ?? 0,
    tools: summary?.tools ?? [],
    perTool: summary?.perTool ?? {},
    turns: summary?.turns ?? 0,
    errorEvents: summary?.errorEvents ?? 0,
    toolErrors: summary?.toolErrors ?? 0,
    retryEvents: summary?.retryEvents ?? 0,
    tokensIn: summary?.inputTokens ?? 0,
    tokensOut: summary?.outputTokens ?? 0,
    auxTokensIn: summary?.auxInputTokens ?? 0,
    auxTokensOut: summary?.auxOutputTokens ?? 0,
    usageTurns: summary?.usageEvents ?? [],
    eventsFile,
    timingsFile,
    eventsKept,
    costUsd,
    model: spec,
    resolvedModel,
    diagnostics,
    finalText: oneLine(summary?.finalText ?? '', 600),
    sandbox: sandboxPath,
  };
}

function fmtCell(s, w) {
  const str = String(s ?? '');
  return str.length > w ? `${str.slice(0, w - 1)}…` : str.padEnd(w);
}

// The per-request usage table, as pure lines so the reporting path is testable
// without spending a model call. Returns [] when no run produced a usage stream
// (some adapters report only a grand total), which is the "when a stream is
// available" hedge: absence of data prints as absence, not as zeroes.
export function renderUsageLines(runs, idWidth = 26) {
  const withUsage = runs.filter((r) => (r?.usageTurns ?? []).length);
  if (!withUsage.length) return [];
  const W = { turn: 10, in: 10, out: 10, aux: 14 };
  const head = `${fmtCell('TASK', idWidth)}  ${fmtCell('TURN', W.turn)}  ${fmtCell('INPUT', W.in)}  ${fmtCell('OUTPUT', W.out)}  ${fmtCell('AUX IN/OUT', W.aux)}`;
  const lines = ['', 'USAGE PER REQUEST (input tokens are re-sent every turn - the dominant cost)', head, '-'.repeat(head.length)];
  let sumIn = 0;
  let sumOut = 0;
  let sumAuxIn = 0;
  let sumAuxOut = 0;
  for (const r of withUsage) {
    for (const u of r.usageTurns) {
      if (u.aux) {
        sumAuxIn += u.inputTokens;
        sumAuxOut += u.outputTokens;
      } else {
        sumIn += u.inputTokens;
        sumOut += u.outputTokens;
      }
      // aux (summariser / verifier / planner) traffic is its own budget, so it is
      // shown in its own columns rather than being double-counted next to the
      // main run's totals.
      lines.push(
        `${fmtCell(r.taskId, idWidth)}  ${fmtCell(String(u.turn), W.turn)}  ` +
        `${fmtCell(u.aux ? '—' : String(u.inputTokens), W.in)}  ` +
        `${fmtCell(u.aux ? '—' : String(u.outputTokens), W.out)}  ` +
        `${fmtCell(u.aux ? `${u.inputTokens}/${u.outputTokens}` : '—', W.aux)}`
      );
    }
  }
  lines.push('-'.repeat(head.length));
  lines.push(
    `${fmtCell('TOTAL', idWidth)}  ${fmtCell(String(sumIn + sumAuxIn), W.turn)}  ${fmtCell(String(sumIn), W.in)}  ` +
    `${fmtCell(String(sumOut), W.out)}  ${fmtCell(sumAuxIn || sumAuxOut ? `${sumAuxIn}/${sumAuxOut}` : '—', W.aux)}`
  );
  return lines;
}

function meanStd(samples) {
  const xs = samples.filter((n) => Number.isFinite(n));
  if (!xs.length) return { mean: 0, stddev: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { mean, stddev: Math.sqrt(variance), n: xs.length };
}

// A missing price is not a zero-dollar run. In particular, local inference has
// no metered provider bill but still consumes hardware and electricity, while a
// remote model can be unpriced because the catalog has not been audited yet.
// Preserve that uncertainty in the JSON artifact rather than silently averaging
// it as 0, which would make later cost-per-task comparisons dishonest.
export function costStats(samples) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n))) {
    return { mean: null, stddev: null, n: 0, unknown: true };
  }
  return { ...meanStd(samples), unknown: false };
}

function summariseRepeats(runs) {
  const passCount = runs.filter((r) => r.pass).length;
  const rate = passCount / runs.length;
  return {
    repeats: runs.length,
    passCount,
    passRate: rate,
    ms: meanStd(runs.map((r) => r.ms)),
    agentMs: meanStd(runs.map((r) => r.agentMs)),
    firstTextMs: meanStd(runs.map((r) => r.firstTextMs)),
    firstToolMs: meanStd(runs.map((r) => r.firstToolMs)),
    toolDurationMs: meanStd(runs.map((r) => r.toolDurationMs)),
    toolCalls: meanStd(runs.map((r) => r.toolCalls)),
    turns: meanStd(runs.map((r) => r.turns)),
    tokensIn: meanStd(runs.map((r) => r.tokensIn)),
    tokensOut: meanStd(runs.map((r) => r.tokensOut)),
    redundantCalls: meanStd(runs.map((r) => r.redundantCalls)),
    costUsd: costStats(runs.map((r) => r.costUsd)),
    runs,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts) return;

  if (opts.list) {
    for (const t of REAL_TASKS) console.log(`${fmtCell(t.id, 26)} ${fmtCell(t.category, 11)} ${t.name}`);
    console.log(`\n${REAL_TASKS.length} tasks. Run one with --model <provider:model> --task <id>`);
    return;
  }

  if (!opts.model) {
    process.stderr.write(
      'bench/real: --model is REQUIRED.\n' +
      'This suite measures a MODEL. There is no default and no fallback, because a run\n' +
      'whose model you did not choose is a run you cannot interpret.\n' +
      `Examples:\n  --model ox-ollama:qwen2.5:0.5b\n  --model ox-openrouter:meta-llama/llama-3.3-70b-instruct\n  --model ox-claude\n${USAGE}\n`
    );
    process.exit(3);
  }

  // Match the CLI's key/config bootstrap. Without this, `bench/real` could not
  // run a bot a user selected in the app even though normal Ox runs could.
  loadKeysIntoEnv(process.env);
  const config = loadConfig();
  const spec = String(opts.model).trim();
  let target;
  try {
    target = resolveBenchmarkTarget(spec, config);
  } catch (err) {
    process.stderr.write(`bench/real: ${err?.message ?? err}\n`);
    process.exit(3);
  }
  if (target.keyEnv && !process.env[target.keyEnv]) {
    process.stderr.write(`bench/real: provider '${target.provider}' needs ${target.keyEnv}, which is not set\n`);
    process.exit(3);
  }
  if (target.provider === 'ollama') {
    const host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
    if (!(await probeTcp(host))) {
      process.stderr.write(`bench/real: ollama is not answering on ${host} - start it or pick another --model\n`);
      process.exit(3);
    }
  }

  const tasks = selectTasks(opts);
  if (!tasks.length) {
    process.stderr.write('bench/real: no tasks matched\n');
    process.exit(3);
  }

  const priced = costOf(target.model, { inputTokens: 0, outputTokens: 0 }) != null;
  console.log(`ox REAL bench · model=${spec} (provider=${target.provider}${priced ? '' : ', unpriced'}) · repeats=${opts.repeats} · node ${process.versions.node} · ${process.platform}`);
  console.log('grading = executed code against the workspace the agent left behind. no scripted tool calls.');

  const startedAt = Date.now();
  const rows = [];
  for (const task of tasks) {
    const runs = [];
    for (let i = 0; i < opts.repeats; i++) {
      const run1 = await runOnce(task, spec, opts, {
        modelId: target.model,
        executionSpec: benchmarkExecutionSpec(spec, target, config),
      });
      runs.push(run1);
      const mark = run1.pass ? 'PASS' : 'FAIL';
      console.log(
        `  ${mark}  ${task.id}${opts.repeats > 1 ? ` [${i + 1}/${opts.repeats}]` : ''}  ` +
        `${Math.round(run1.agentMs)}ms agent  first-text=${run1.firstTextMs == null ? 'n/a' : `${Math.round(run1.firstTextMs)}ms`} ` +
        `tools=${run1.toolCalls} turns=${run1.turns} ` +
        `${run1.tokensIn}/${run1.tokensOut} tok  redundant=${run1.redundantCalls}`
      );
      if (run1.sandbox) console.log(`        sandbox kept: ${run1.sandbox}`);
      if (run1.eventsFile) console.log(`        events kept: ${run1.eventsFile} (${run1.eventsKept} event(s))`);
      if (run1.timingsFile) console.log(`        timings kept: ${run1.timingsFile}`);
    }
    rows.push({ task, runs, stats: summariseRepeats(runs) });
  }
  const suiteMs = Date.now() - startedAt;

  // --- table -----------------------------------------------------------------
  const W = { id: 26, cat: 11, res: 6, ms: 8, ttft: 12, toolMs: 12, tools: 6, turns: 6, tok: 13, cost: 8, red: 4 };
  const header = `${fmtCell('TASK', W.id)}  ${fmtCell('CATEGORY', W.cat)}  ${fmtCell('RESULT', W.res)}  ${fmtCell('AGENT_MS', W.ms)}  ${fmtCell('FIRST_TEXT', W.ttft)}  ${fmtCell('TOOL_AVG', W.toolMs)}  ${fmtCell('TOOLS', W.tools)}  ${fmtCell('TURNS', W.turns)}  ${fmtCell('TOK IN/OUT', W.tok)}  ${fmtCell('COST', W.cost)}  ${fmtCell('REDUN', W.red)}`;
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const { task, stats } of rows) {
    const label = opts.repeats > 1 ? `${stats.passCount}/${stats.repeats}` : (stats.passCount ? 'PASS' : 'FAIL');
    const cost = priced && !stats.costUsd.unknown ? formatCost(stats.costUsd.mean) : '—';
    console.log(
      `${fmtCell(task.id, W.id)}  ${fmtCell(task.category, W.cat)}  ${fmtCell(label, W.res)}  ` +
      `${fmtCell(String(Math.round(stats.agentMs.mean)), W.ms)}  ` +
      `${fmtCell(stats.firstTextMs.n ? `${Math.round(stats.firstTextMs.mean)}ms` : 'n/a', W.ttft)}  ` +
      `${fmtCell(stats.toolDurationMs.n ? `${Math.round(stats.toolDurationMs.mean)}ms` : 'n/a', W.toolMs)}  ` +
      `${fmtCell(stats.toolCalls.mean.toFixed(1), W.tools)}  ` +
      `${fmtCell(stats.turns.mean.toFixed(1), W.turns)}  ${fmtCell(`${Math.round(stats.tokensIn.mean)}/${Math.round(stats.tokensOut.mean)}`, W.tok)}  ` +
      `${fmtCell(cost, W.cost)}  ${fmtCell(stats.redundantCalls.mean.toFixed(1), W.red)}`
    );
  }
  console.log('-'.repeat(header.length));

  const totalRuns = rows.reduce((a, r) => a + r.stats.repeats, 0);
  const totalPass = rows.reduce((a, r) => a + r.stats.passCount, 0);
  const rate = totalRuns ? ((totalPass / totalRuns) * 100) : 0;
  console.log(`PASS RATE: ${totalPass}/${totalRuns} = ${rate.toFixed(1)}%   wall ${(suiteMs / 1000).toFixed(1)}s   model ${spec}`);
  console.log('Latency note: FIRST_TEXT is child-process time to first generated-text event; TOOL_AVG is mean tool-start→tool-end time. Neither is provider-internal model latency.');

  // Per-turn token provenance. The table above reports means, and a mean cannot
  // show you WHICH request cost the run - which is exactly the number anyone
  // needs when arguing about token spend. Independent of --keep: the raw stream
  // in <sandbox>/events.ndjson is the durable copy, this is the readable one.
  for (const line of renderUsageLines(rows.flatMap(({ task, stats }) =>
    stats.runs.map((r) => ({ ...r, taskId: task.id }))
  ), W.id)) {
    console.log(line);
  }

  if (opts.repeats > 1) {
    console.log('');
    console.log('VARIANCE (sample stddev across independent repeats)');
    console.log(`${fmtCell('TASK', W.id)}  ${fmtCell('PASS', 6)}  ${fmtCell('AGENT_MS', 18)}  ${fmtCell('TOOLS', 16)}  ${fmtCell('TURNS', 14)}`);
    for (const { task, stats } of rows) {
      console.log(
        `${fmtCell(task.id, W.id)}  ${fmtCell(`${stats.passCount}/${stats.repeats}`, 6)}  ` +
        `${fmtCell(`${stats.agentMs.mean.toFixed(0)} ± ${stats.agentMs.stddev.toFixed(0)}`, 18)}  ` +
        `${fmtCell(`${stats.toolCalls.mean.toFixed(1)} ± ${stats.toolCalls.stddev.toFixed(1)}`, 16)}  ` +
        `${fmtCell(`${stats.turns.mean.toFixed(1)} ± ${stats.turns.stddev.toFixed(1)}`, 14)}`
      );
    }
  }

  // --- honest failure reporting ------------------------------------------------
  const failures = rows.flatMap(({ task, stats }) => stats.runs.filter((r) => !r.pass).map((r) => ({ task, r })));
  if (failures.length) {
    console.log('');
    console.log(`FAILURES (${failures.length}) - verifier output, unedited`);
    console.log('='.repeat(80));
    for (const { task, r } of failures) {
      console.log(`\n${task.id}  [${task.category}]  exit=${r.exitCode}  ms=${r.ms}  tools=${r.toolCalls}  turns=${r.turns}  tokens=${r.tokensIn}/${r.tokensOut}`);
      for (const d of r.diagnostics) console.log(`  diag: ${d}`);
      console.log(`  detail: ${r.detail || '(empty detail)'}`);
      for (const c of r.checks.filter((c) => !c.ok)) console.log(`    x ${c.name}${c.detail ? ` :: ${c.detail}` : ''}`);
      console.log(`  agent said: ${r.finalText || '(no final text)'}`);
      if (r.sandbox) console.log(`  sandbox: ${r.sandbox}`);
    }
    console.log('='.repeat(80));
  }

  const machine = {
    suite: 'bench/real',
    date: new Date().toISOString(),
    model: spec,
    provider: target.provider,
    modelId: target.model,
    priced,
    repeats: opts.repeats,
    env: { node: process.versions.node, platform: process.platform, arch: process.arch },
    suiteMs,
    results: rows.map(({ task, stats, runs }) => ({
      id: task.id,
      name: task.name,
      category: task.category,
      prompt: task.prompt,
      passCount: stats.passCount,
      repeats: stats.repeats,
      passRate: stats.passRate,
      ms: stats.ms,
      agentMs: stats.agentMs,
      firstTextMs: stats.firstTextMs,
      firstToolMs: stats.firstToolMs,
      toolDurationMs: stats.toolDurationMs,
      toolCalls: stats.toolCalls,
      turns: stats.turns,
      tokensIn: stats.tokensIn,
      tokensOut: stats.tokensOut,
      redundantCalls: stats.redundantCalls,
      costUsd: stats.costUsd,
      runs: runs.map((r) => ({
        pass: r.pass, detail: r.detail, checks: r.checks, ms: r.ms, agentMs: r.agentMs,
        firstTextMs: r.firstTextMs, firstToolMs: r.firstToolMs, toolDurationMs: r.toolDurationMs, timedTools: r.timedTools,
        exitCode: r.exitCode, timedOut: r.timedOut,
        toolCalls: r.toolCalls, uniqueCalls: r.uniqueCalls, redundantCalls: r.redundantCalls,
        tools: r.tools, perTool: r.perTool, turns: r.turns,
        errorEvents: r.errorEvents, toolErrors: r.toolErrors, retryEvents: r.retryEvents,
        tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd,
        usageTurns: r.usageTurns, eventsFile: r.eventsFile, timingsFile: r.timingsFile, eventsKept: r.eventsKept,
        diagnostics: r.diagnostics, finalText: r.finalText, sandbox: r.sandbox,
      })),
    })),
    totals: { totalRuns, totalPass, passRatePercent: Number(rate.toFixed(1)), suiteMs },
  };
  if (opts.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(opts.jsonOut)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.jsonOut), `${JSON.stringify(machine, null, 2)}\n`);
    console.log(`\nwrote ${path.resolve(opts.jsonOut)}`);
  }

  const keptPaths = rows.flatMap((r) => r.runs.map((x) => x.sandbox).filter(Boolean));
  if (keptPaths.length) {
    const eventPaths = rows.flatMap((r) => r.runs.map((x) => x.eventsFile).filter(Boolean));
    console.log(`sandboxes kept (--keep):\n  ${keptPaths.join('\n  ')}`);
    if (eventPaths.length) {
      console.log(`raw NDJSON event streams (per sandbox, one JSON value per line):\n  ${eventPaths.join('\n  ')}`);
    }
  }

  process.exitCode = totalPass === totalRuns ? 0 : 1;
}

// Only drive the CLI when invoked as a program. Importing this module (the test
// suite does, to reach runOnce) must not start a benchmark run.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`bench/real: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
