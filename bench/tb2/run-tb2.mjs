#!/usr/bin/env node
// bench/tb2/run-tb2.mjs — Terminal-Bench 2.1 compatibility runner for ox bench.
//   node bench/tb2/run-tb2.mjs [--filter <regex>] [--list] [--model <spec>]
// Zero deps. Without --model: the deterministic harness (a scripted model on
// loopback); a task with no script.mjs is SKIPPED there, since a script-less
// stand-in only echoes the prompt. With --model: a real model decides, in a
// sandbox (HOME isolated), and the task's own tests grade the workspace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BIN_OX, createSandbox, destroySandbox, startMock, spawnOx,
  deterministicEnv, finalTextOf, usageTotals, parseNdjsonEvents,
} from '../harness.mjs';
import { tb2ToScenario } from './adapter.mjs';
import { agentEnv } from '../real/lib.mjs';

const TB2_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = path.join(TB2_DIR, 'tasks');
const RESULTS_MD = path.join(TB2_DIR, 'RESULTS.md');
const DEFAULT_MODEL = 'grok-4.6';

function parseArgs(argv) {
  const opts = { filter: null, list: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') opts.filter = new RegExp(String(argv[++i] ?? ''), 'i');
    else if (a === '--list') opts.list = true;
    else if (a === '--model') opts.model = String(argv[++i] ?? '');
    else {
      process.stderr.write(`tb2: unknown arg '${a}'\nusage: node bench/tb2/run-tb2.mjs [--filter <regex>] [--list]\n`);
      process.exit(3);
    }
  }
  return opts;
}

async function loadScenarios(filter) {
  if (!fs.existsSync(TASKS_DIR)) {
    console.error(`tb2: tasks directory not found at ${TASKS_DIR}`);
    return [];
  }
  const entries = fs.readdirSync(TASKS_DIR, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskDir = path.join(TASKS_DIR, entry.name);
    try {
      const scn = await tb2ToScenario(taskDir);
      scn._file = entry.name;
      if (filter && !filter.test(scn.name) && !filter.test(scn.description ?? '') && !filter.test(scn.category)) continue;
      out.push(scn);
    } catch (err) {
      console.error(`tb2: skipping ${entry.name} — ${err?.message ?? err}`);
    }
  }
  return out;
}

// A real model, in a sandbox: no mock, the model chooses every step.
async function runLive(scn, model) {
  const sb = createSandbox(scn.name.replace(/[^a-z0-9]+/gi, '-'));
  const started = Date.now();
  try {
    if (typeof scn.setup === 'function') await scn.setup(sb);
    const env = agentEnv({ home: sb.home, extra: { OX_ISLAND: '0', OX_LEARN: '0' } });
    const args = ['-p', String(scn.prompt ?? ''), '--json', '--bot', model, '-y', ...(scn.extraArgs ?? [])];
    const run = await spawnOx({ args, env, cwd: sb.ws, timeoutMs: 300_000 });
    const events = parseNdjsonEvents(run.stdout);
    const transcript = [finalTextOf(events), run.stdout].filter(Boolean).join('\n');
    const result = { events, exitCode: run.exitCode, stdout: transcript, stderr: run.stderr, ws: sb.ws, home: sb.home, ms: Date.now() - started, model, timedOut: run.timedOut };
    if (run.timedOut) return { ...result, status: 'FAIL', detail: 'timed out after 300s' };
    const verdict = await scn.check(result);
    return { ...result, status: verdict?.pass ? 'PASS' : 'FAIL', detail: String(verdict?.detail ?? '') };
  } catch (err) {
    return { status: 'FAIL', detail: `harness error: ${err?.message ?? err}`, events: [], exitCode: null, ms: Date.now() - started, model };
  } finally {
    destroySandbox(sb);
  }
}

async function runDeterministic(scn) {
  if (!scn.hasScript) return { status: 'SKIP', detail: 'no script.mjs: run it with --model <spec> (a real model)', events: [], ms: 0 };
  const sb = createSandbox(scn.name.replace(/[^a-z0-9]+/gi, '-'));
  let server = null;
  const started = Date.now();
  try {
    if (typeof scn.setup === 'function') await scn.setup(sb);
    const model = scn.model ?? DEFAULT_MODEL;
    server = await startMock({
      script: async (body, _ws, state) => (typeof scn.script === 'function' ? scn.script(body, sb.ws, state) : []),
      ws: sb.ws,
      tokensPerTurn: scn.tokensPerTurn ?? { in: 800, out: 120 },
      model,
    });
    const env = deterministicEnv({
      home: sb.home,
      baseUrl: server.url,
      model,
      extra: { ...(scn.env ?? {}) },
    });
    const args = ['-p', String(scn.prompt ?? ''), '--json', ...(scn.extraArgs ?? [])];
    const run = await spawnOx({ args, env, cwd: sb.ws, timeoutMs: scn.timeoutMs ?? 25_000 });
    const ms = Date.now() - started;
    const events = parseNdjsonEvents(run.stdout);
    const result = {
      events,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      ws: sb.ws,
      home: sb.home,
      ms,
      requests: server.requests,
      flags: server.flags,
      errors: server.errors,
      model,
      timedOut: run.timedOut,
    };
    if (run.timedOut) return { ...result, status: 'FAIL', detail: `timed out after ${scn.timeoutMs ?? 25000}ms` };
    if (server.errors.length) return { ...result, status: 'FAIL', detail: `mock script errors: ${server.errors[0]}` };
    const verdict = await scn.check(result);
    return { ...result, status: verdict?.pass ? 'PASS' : 'FAIL', detail: String(verdict?.detail ?? '') };
  } catch (err) {
    return { status: 'FAIL', detail: `harness error: ${err?.stack ?? err}`, events: [], exitCode: null, ms: Date.now() - started, requests: [], flags: {}, errors: [], model: scn.model ?? DEFAULT_MODEL };
  } finally {
    if (server) await server.close();
    destroySandbox(sb);
  }
}

function fmtCell(s, w) {
  const str = String(s ?? '');
  return str.length > w ? `${str.slice(0, w - 1)}…` : str.padEnd(w);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scenarios = await loadScenarios(opts.filter);
  if (opts.list) {
    for (const s of scenarios) console.log(`${fmtCell(s.name, 28)} ${fmtCell(s.category, 12)} ${s.description ?? ''}`);
    return;
  }

  console.log(`ox tb2 · node ${process.versions.node} · ${process.platform}`);
  console.log('');

  const rows = [];
  const suiteStart = Date.now();
  for (const scn of scenarios) {
    const row = opts.model ? await runLive(scn, opts.model) : await runDeterministic(scn);
    const usage = usageTotals(row.events ?? []);
    const costUsd = 0; // synthetic, no pricing needed for tb2
    row.tokensIn = usage.inputTokens;
    row.tokensOut = usage.outputTokens;
    row.costUsd = costUsd;
    rows.push({ scn, row });
    const mark = row.status === 'PASS' ? '✓' : row.status === 'SKIP' ? '·' : '✗';
    console.log(`${mark} ${fmtCell(scn.name, 26)} ${fmtCell(row.status, 5)} ${String(Math.round(row.ms ?? 0)).padStart(6)}ms  ${(row.tokensIn ?? 0)}in/${(row.tokensOut ?? 0)}out  ${row.detail ? `  — ${row.detail.slice(0, 160).replace(/\n/g, ' ')}` : ''}`);
  }
  const suiteMs = Date.now() - suiteStart;

  const pass = rows.filter((r) => r.row.status === 'PASS').length;
  const fail = rows.filter((r) => r.row.status === 'FAIL').length;
  const skip = rows.filter((r) => r.row.status === 'SKIP').length;
  const total = rows.length;
  const totalTokIn = rows.reduce((a, r) => a + (r.row.tokensIn ?? 0), 0);
  const totalTokOut = rows.reduce((a, r) => a + (r.row.tokensOut ?? 0), 0);
  const rate = total ? ((pass / total) * 100).toFixed(1) : '0.0';

  console.log('');
  const W = { name: 26, cat: 12, status: 5, ms: 7, tok: 13 };
  const header = `${fmtCell('TASK', W.name)}  ${fmtCell('CATEGORY', W.cat)}  ${fmtCell('RESULT', W.status)}  ${fmtCell('MS', W.ms)}  ${fmtCell('TOKENS IN/OUT', W.tok)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const { scn, row } of rows) {
    console.log(`${fmtCell(scn.name, W.name)}  ${fmtCell(scn.category, W.cat)}  ${fmtCell(row.status, W.status)}  ${fmtCell(String(Math.round(row.ms ?? 0)), W.ms)}  ${fmtCell(`${row.tokensIn ?? 0}/${row.tokensOut ?? 0}`, W.tok)}`);
  }
  console.log('-'.repeat(header.length));
  console.log(`${fmtCell('TOTALS', W.name)}  ${fmtCell('', W.cat)}  ${fmtCell(`${pass}/${total}`, W.status)}  ${fmtCell(String(suiteMs), W.ms)}  ${fmtCell(`${totalTokIn}/${totalTokOut}`, W.tok)}`);
  console.log(`PASS RATE: ${pass}/${total} = ${rate}%${skip ? ` (${skip} skipped)` : ''}`);

  const machine = {
    date: new Date().toISOString(),
    env: { node: process.versions.node, platform: process.platform, arch: process.arch, cwd: TB2_DIR },
    suiteMs,
    results: rows.map(({ scn, row }) => ({
      name: scn.name, category: scn.category, description: scn.description ?? '', file: scn._file,
      status: row.status, detail: row.detail ?? '', ms: Math.round(row.ms ?? 0),
      tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0,
      exitCode: row.exitCode ?? null,
    })),
    totals: { pass, fail, skip, total, passRate: Number(rate), suiteMs, tokensIn: totalTokIn, tokensOut: totalTokOut },
  };

  writeResultsMd(machine, rows);
  console.log(`wrote ${RESULTS_MD}`);
}

function writeResultsMd(machine, rows) {
  const L = [];
  L.push('# ox tb2 results');
  L.push('');
  L.push('| field | value |');
  L.push('|---|---|');
  L.push(`| date | ${machine.date} |`);
  L.push(`| node | ${machine.env.node} |`);
  L.push(`| platform | ${machine.env.platform}/${machine.env.arch} |`);
  L.push('');
  L.push('| task | category | result | ms | tokens in/out | detail |');
  L.push('|---|---|---|---|---|---|');
  for (const { scn, row } of rows) {
    const detail = String(row.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    L.push(`| ${scn.name} | ${scn.category} | ${row.status} | ${Math.round(row.ms ?? 0)} | ${row.tokensIn ?? 0}/${row.tokensOut ?? 0} | ${detail.slice(0, 220)} |`);
  }
  L.push('');
  L.push(`**Totals:** ${machine.totals.pass}/${machine.totals.total} passed (**${machine.totals.passRate}%**) · ${machine.totals.fail} failed · ${machine.totals.skip} skipped · suite wall time ${machine.totals.suiteMs}ms · tokens ${machine.totals.tokensIn}/${machine.totals.tokensOut}`);
  L.push('');
  fs.writeFileSync(RESULTS_MD, L.join('\n'));
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
