#!/usr/bin/env node
// bench/runner.mjs — deterministic benchmark harness for the ox coding agent.
//   node bench/runner.mjs [--filter <regex>] [--live] [--live-model <spec>]
//                          [--json <out>] [--out-dir <dir>] [--update-baseline] [--list]
// Zero deps. Deterministic mode talks only to a local mock OpenAI-SSE server.
//
// RESULTS.md IS THE BASELINE, NOT RUN OUTPUT. scripts/regression-canary.js parses
// bench/RESULTS.md as the protected reference that the current run is diffed
// against, so an ordinary run must never rewrite it — doing so silently disarms
// the canary. Every run writes to a run-scoped directory
// (bench/results/<ISO-timestamp>/) instead; replacing the baseline requires the
// explicit --update-baseline opt-in.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costOf, formatCost } from '../src/cost.js';
import { KEY_ENV } from '../src/bots.js';
import {
  BIN_OX, createSandbox, destroySandbox, startMock, spawnOx,
  deterministicEnv, liveEnv, finalTextOf, usageTotals, timeColdStarts, parseNdjsonEvents,
} from './harness.mjs';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(BENCH_DIR, 'scenarios');
const RUNS_DIR = path.join(BENCH_DIR, 'results');
const RESULTS_MD = path.join(BENCH_DIR, 'RESULTS.md');
const DEFAULT_MODEL = 'grok-4.6';
const USAGE = '[--filter <regex>] [--live] [--live-model <spec>] [--json <out>] [--out-dir <dir>] [--update-baseline] [--list]';

function parseArgs(argv) {
  const opts = { filter: null, live: false, liveModel: null, jsonOut: null, outDir: null, updateBaseline: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') opts.filter = new RegExp(String(argv[++i] ?? ''), 'i');
    else if (a === '--live') opts.live = true;
    else if (a === '--live-model') opts.liveModel = String(argv[++i] ?? '');
    else if (a === '--json') opts.jsonOut = String(argv[++i] ?? '');
    else if (a === '--out-dir') opts.outDir = String(argv[++i] ?? '');
    else if (a === '--update-baseline') opts.updateBaseline = true;
    else if (a === '--list') opts.list = true;
    else {
      process.stderr.write(`bench: unknown arg '${a}'\nusage: node bench/runner.mjs ${USAGE}\n`);
      process.exit(3);
    }
  }
  // A subset table written over the full-suite baseline is unrecoverable data loss,
  // so the opt-in is refused for filtered runs even when explicitly requested.
  if (opts.updateBaseline && opts.filter) {
    process.stderr.write('bench: --update-baseline cannot be combined with --filter (a subset table would destroy the full-suite baseline)\n');
    process.exit(3);
  }
  return opts;
}

async function loadScenarios(filter) {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const out = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(SCENARIOS_DIR, f)).href);
    const def = mod.default;
    if (!def || typeof def !== 'object') {
      console.error(`bench: skipping ${f} — no default export object`);
      continue;
    }
    def._file = f;
    if (!def.name) def.name = f.replace(/\.mjs$/, '');
    if (!def.category) def.category = 'general';
    if (filter && !filter.test(def.name) && !filter.test(def.description ?? '') && !filter.test(def.category)) continue;
    out.push(def);
  }
  return out;
}

// Live provider selection.
//
// Provider discovery reuses KEY_ENV from src/bots.js instead of a parallel
// hardcoded list, so any provider ox supports is selectable here and cannot drift
// out of sync. Precedence is KEY_ENV declaration order, except that `ollama` — the
// only keyless provider — is last and is only selected when its endpoint actually
// answers, so a machine without Ollama running skips live scenarios instead of
// failing every one of them on connection-refused.
//
// The model chosen per provider is chosen for RELIABLE TOOL CALLING, not for
// general quality or price: live scenarios assert on tool dispatch, so an
// instruct-tuned model with a weak tool-call mix produces noise, not signal.
//   xai        grok-4.6                    — native function calling, ox flagship
//   anthropic  claude-sonnet-5             — most reliable structured tool use
//   openai     gpt-5.6-sol                 — first-class tool-call API
//   gemini     gemini-3.1-pro-preview      — pro tier; flash degrades on multi-step calls
//   groq       moonshotai/kimi-k2-instruct-0905 — Kimi K2 is tool-trained
//   openrouter moonshotai/kimi-k2-instruct-0905 — REPLACES meta-llama/llama-3.3-70b-instruct,
//                                              an instruct model that is unreliable at tool calls
//   deepseek   deepseek-v4-pro             — tool-call capable
//   ollama     qwen2.5:7b                  — smallest generally-available Qwen2.5 that
//                                              emits well-formed tool arguments
//   backboard  backboard-routing           — routing service, model chosen server-side
//   custom     none                        — an unknown endpoint has no safe default;
//                                              supply the model via --live-model/OX_MODEL
const LIVE_MODELS = Object.freeze({
  xai: 'grok-4.6',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  gemini: 'gemini-3.1-pro-preview',
  groq: 'moonshotai/kimi-k2-instruct-0905',
  openrouter: 'moonshotai/kimi-k2-instruct-0905',
  deepseek: 'deepseek-v4-pro',
  ollama: 'qwen2.5:7b',
  backboard: 'backboard-routing',
  custom: null,
});
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1:11434';

function liveChoice(provider, model, keyEnv, source) {
  const m = model ?? LIVE_MODELS[provider] ?? null;
  return { provider, model: m, spec: m ? `${provider}:${m}` : provider, key: keyEnv ?? KEY_ENV[provider] ?? null, source };
}

// `--live-model <provider:model>` (or OX_BENCH_LIVE_MODEL) forces the choice. A
// bare `--live-model <model>` overrides the model only, keeping auto-detected
// provider selection. Returns null when there is nothing to override.
function parseLiveModel(raw) {
  const spec = String(raw ?? '').trim();
  if (!spec) return null;
  const colon = spec.indexOf(':');
  if (colon <= 0) return { provider: null, model: spec };
  const provider = spec.slice(0, colon);
  if (KEY_ENV[provider] === undefined) return null;
  return { provider, model: spec.slice(colon + 1).trim() || null };
}

// Loopback-only reachability probe for the keyless ollama provider.
function probeTcp(hostPort, timeoutMs = 300) {
  const [host, port] = String(hostPort).split(':');
  return new Promise((resolve) => {
    const socket = net.connect({ host: host || '127.0.0.1', port: Number(port) || 11434 });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function pickLiveProvider(opts = {}) {
  const forced = parseLiveModel(opts.liveModel ?? process.env.OX_BENCH_LIVE_MODEL);
  if (forced?.provider) return liveChoice(forced.provider, forced.model, KEY_ENV[forced.provider], 'override');
  let detected = null;
  for (const [provider, keyEnv] of Object.entries(KEY_ENV)) {
    if (!keyEnv) continue; // ollama: handled by the probe below
    if (!process.env[keyEnv]) continue;
    detected = liveChoice(provider, null, keyEnv, 'auto');
    break;
  }
  if (forced?.model && detected) return liveChoice(detected.provider, forced.model, detected.key, 'override-model');
  if (detected) return detected;
  if (await probeTcp(OLLAMA_HOST)) return liveChoice('ollama', null, null, 'probe');
  return null;
}

// Default pipeline: sandbox → mock server → setup → spawn ox -p --json → check inputs.
async function runDeterministic(scn) {
  const sb = createSandbox(scn.name.replace(/[^a-z0-9]+/gi, '-'));
  let server = null;
  const started = Date.now();
  try {
    if (typeof scn.setup === 'function') await scn.setup(sb);
    const model = scn.model ?? DEFAULT_MODEL;
    server = await startMock({
      script: async (body, _ws, state) => (typeof scn.script === "function" ? scn.script(body, sb.ws, state) : []),
      ws: sb.ws,
      tokensPerTurn: scn.tokensPerTurn ?? { in: 600, out: 120 },
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

// Scenario-supplied multi-phase run (e.g. resume/memory two-process flows).
async function runCustom(scn) {
  const sb = createSandbox(scn.name.replace(/[^a-z0-9]+/gi, '-'));
  const started = Date.now();
  try {
    if (typeof scn.setup === 'function') await scn.setup(sb);
    const result = await scn.run({ sb, spawnOx, startMock, deterministicEnv });
    const ms = Date.now() - started;
    const merged = {
      ...(result ?? {}),
      ws: sb.ws, home: sb.home, ms,
      events: result.events ?? [],
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      requests: result.requests ?? [],
      flags: result.flags ?? {},
      errors: result.errors ?? [],
      model: result.model ?? scn.model ?? DEFAULT_MODEL,
      extra: result,
    };
    if (merged.errors.length) return { ...merged, status: 'FAIL', detail: `mock script errors: ${merged.errors[0]}` };
    const verdict = await scn.check(merged);
    return { ...merged, status: verdict?.pass ? 'PASS' : 'FAIL', detail: String(verdict?.detail ?? '') };
  } catch (err) {
    return { status: 'FAIL', detail: `harness error: ${err?.stack ?? err}`, events: [], exitCode: null, ms: Date.now() - started, requests: [], flags: {}, model: scn.model ?? DEFAULT_MODEL };
  } finally {
    destroySandbox(sb);
  }
}

async function runLive(scn, provider) {
  if (!scn.livePrompt) {
    return { status: 'SKIP', detail: 'deterministic-only', events: [], ms: 0, requests: [], model: provider.model };
  }
  const sb = createSandbox(`live-${scn.name.replace(/[^a-z0-9]+/gi, '-')}`);
  const started = Date.now();
  try {
    if (typeof scn.setup === 'function') await scn.setup(sb);
    const prompt = typeof scn.livePrompt === 'function' ? await scn.livePrompt(sb) : String(scn.livePrompt);
    const env = liveEnv({ home: sb.home, extra: scn.env ?? {} });
    const args = ['-p', prompt, '--json', '--model', provider.spec, ...(scn.liveArgs ?? scn.extraArgs ?? [])];
    const run = await spawnOx({ args, env, cwd: sb.ws, timeoutMs: scn.timeoutMs ?? 120_000 });
    const ms = Date.now() - started;
    const events = parseNdjsonEvents(run.stdout);
    const result = { events, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, ws: sb.ws, ms, requests: [], flags: {}, model: provider.model };
    const verdict = typeof scn.liveCheck === 'function'
      ? await scn.liveCheck(result)
      : { pass: run.exitCode === 0 && finalTextOf(events).trim().length > 0, detail: `exit=${run.exitCode}` };
    return { ...result, status: verdict?.pass ? 'PASS' : 'FAIL', detail: String(verdict?.detail ?? '') };
  } catch (err) {
    return { status: 'FAIL', detail: `harness error: ${err?.stack ?? err}`, events: [], ms: Date.now() - started, model: provider.model };
  } finally {
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
  const mode = opts.live ? 'live' : 'deterministic';
  const provider = mode === 'live' ? await pickLiveProvider(opts) : null;
  if (mode === 'live' && !provider) {
    const keys = [...new Set(Object.values(KEY_ENV).filter(Boolean))].join(' / ');
    console.log(`live mode: no provider key found (${keys}) — all live scenarios will be skipped`);
  }
  console.log(`ox bench · mode=${mode}${provider ? ` · provider=${provider.spec} · key=${provider.key ?? 'n/a (local)'} · selected-by=${provider.source}` : ''} · node ${process.versions.node} · ${process.platform}`);
  console.log('');
  if (opts.list) {
    for (const s of scenarios) console.log(`${fmtCell(s.name, 26)} ${fmtCell(s.category, 14)} ${s.description ?? ''}`);
    return;
  }

  const rows = [];
  const suiteStart = Date.now();
  for (const scn of scenarios) {
    let row;
    if (mode === 'live') {
      row = provider ? await runLive(scn, provider) : { status: 'SKIP', detail: 'no provider key', ms: 0, events: [], model: provider?.model };
    } else if (typeof scn.run === 'function') {
      row = await runCustom(scn);
    } else if (typeof scn.check === 'function' && (typeof scn.script === 'function')) {
      row = await runDeterministic(scn);
    } else {
      row = { status: 'SKIP', detail: 'no runnable script/check contract', ms: 0, events: [] };
    }
    const usage = usageTotals(row.events ?? []);
    const costUsd = costOf(row.model ?? DEFAULT_MODEL, usage);
    row.tokensIn = usage.inputTokens;
    row.tokensOut = usage.outputTokens;
    row.costUsd = costUsd;
    rows.push({ scn, row });
    const mark = row.status === 'PASS' ? '✓' : row.status === 'SKIP' ? '·' : '✗';
    console.log(`${mark} ${fmtCell(scn.name, 24)} ${fmtCell(row.status, 5)} ${String(Math.round(row.ms ?? 0)).padStart(6)}ms  ${(row.tokensIn ?? 0)}in/${row.tokensOut ?? 0}out  ${costUsd != null ? formatCost(costUsd) : '—'}${row.detail ? `  — ${row.detail.slice(0, 160).replace(/\n/g, ' ')}` : ''}`);
  }
  const suiteMs = Date.now() - suiteStart;

  // Totals
  const pass = rows.filter((r) => r.row.status === 'PASS').length;
  const fail = rows.filter((r) => r.row.status === 'FAIL').length;
  const skip = rows.filter((r) => r.row.status === 'SKIP').length;
  const total = rows.length;
  const totalTokIn = rows.reduce((a, r) => a + (r.row.tokensIn ?? 0), 0);
  const totalTokOut = rows.reduce((a, r) => a + (r.row.tokensOut ?? 0), 0);
  const totalCost = rows.reduce((a, r) => a + (r.row.costUsd ?? 0), 0);
  const rate = total ? ((pass / total) * 100).toFixed(1) : '0.0';

  // Console table
  console.log('');
  const W = { name: 24, cat: 12, status: 5, ms: 7, tok: 13, cost: 9 };
  const header = `${fmtCell('SCENARIO', W.name)}  ${fmtCell('CATEGORY', W.cat)}  ${fmtCell('RESULT', W.status)}  ${fmtCell('MS', W.ms)}  ${fmtCell('TOKENS IN/OUT', W.tok)}  ${fmtCell('COST', W.cost)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const { scn, row } of rows) {
    console.log(
      `${fmtCell(scn.name, W.name)}  ${fmtCell(scn.category, W.cat)}  ${fmtCell(row.status, W.status)}  ${fmtCell(String(Math.round(row.ms ?? 0)), W.ms)}  ${fmtCell(`${row.tokensIn ?? 0}/${row.tokensOut ?? 0}`, W.tok)}  ${fmtCell(row.costUsd != null ? formatCost(row.costUsd) : '—', W.cost)}`
    );
  }
  console.log('-'.repeat(header.length));
  console.log(
    `${fmtCell('TOTALS', W.name)}  ${fmtCell('', W.cat)}  ${fmtCell(`${pass}/${total}`, W.status)}  ${fmtCell(String(suiteMs), W.ms)}  ${fmtCell(`${totalTokIn}/${totalTokOut}`, W.tok)}  ${fmtCell(formatCost(totalCost), W.cost)}`
  );
  console.log(`PASS RATE: ${pass}/${total} = ${rate}%${skip ? ` (${skip} skipped)` : ''}`);

  // Machine-readable output
  const machine = {
    mode,
    date: new Date().toISOString(),
    env: { node: process.versions.node, platform: process.platform, arch: process.arch, cwd: REPO_ROOT_SAFE() },
    provider: provider?.spec ?? null,
    suiteMs,
    results: rows.map(({ scn, row }) => ({
      name: scn.name, category: scn.category, description: scn.description ?? '', file: scn._file,
      status: row.status, detail: row.detail ?? '', ms: Math.round(row.ms ?? 0),
      tokensIn: row.tokensIn ?? 0, tokensOut: row.tokensOut ?? 0,
      costUsd: row.costUsd ?? null, model: row.model ?? DEFAULT_MODEL,
      exitCode: row.exitCode ?? null,
    })),
    totals: { pass, fail, skip, total, passRate: Number(rate), suiteMs, tokensIn: totalTokIn, tokensOut: totalTokOut, costUsd: totalCost },
  };
  if (opts.jsonOut) {
    fs.writeFileSync(opts.jsonOut, `${JSON.stringify(machine, null, 2)}\n`);
    console.log(`wrote ${opts.jsonOut}`);
  }

  // A run NEVER rewrites bench/RESULTS.md by default: that file is the protected
  // baseline scripts/regression-canary.js diffs against, so clobbering it on an
  // ordinary run silently disarms the canary. Artifacts land in a run-scoped
  // directory; --update-baseline is the explicit opt-in that replaces the baseline.
  const outDir = opts.outDir ? path.resolve(opts.outDir) : uniqueRunStamp(machine.date);
  fs.mkdirSync(outDir, { recursive: true });
  const runResults = path.join(outDir, 'RESULTS.md');
  fs.writeFileSync(runResults, renderResultsMd(machine, rows));
  console.log(`wrote ${runResults}`);
  const runCanary = path.join(outDir, 'canary.json');
  fs.writeFileSync(runCanary, `${JSON.stringify(machine, null, 2)}\n`);
  console.log(`wrote ${runCanary}`);
  if (opts.updateBaseline) {
    fs.writeFileSync(RESULTS_MD, renderResultsMd(machine, rows));
    console.log(`baseline REPLACED: ${RESULTS_MD}`);
  } else {
    console.log(`bench: baseline left untouched at ${RESULTS_MD} (pass --update-baseline to replace it)`);
  }
}

function REPO_ROOT_SAFE() {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
}

// ISO timestamp with ':'/'.' removed so the directory name is portable, plus a
// collision suffix so two runs in the same millisecond cannot overwrite each other.
function uniqueRunStamp(iso) {
  const base = String(iso ?? '').replace(/[:.]/g, '-') || 'run';
  let dir = path.join(RUNS_DIR, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(RUNS_DIR, `${base}-${n}`);
  return dir;
}

function renderResultsMd(machine, rows) {
  const L = [];
  L.push('# ox bench results');
  L.push('');
  L.push('| field | value |');
  L.push('|---|---|');
  L.push(`| date | ${machine.date} |`);
  L.push(`| node | ${machine.env.node} |`);
  L.push(`| platform | ${machine.env.platform}/${machine.env.arch} |`);
  L.push(`| mode | ${machine.mode}${machine.provider ? ` (${machine.provider})` : ''} |`);
  L.push('');
  L.push('| scenario | category | result | ms | tokens in/out | cost | detail |');
  L.push('|---|---|---|---|---|---|---|');
  for (const { scn, row } of rows) {
    const detail = String(row.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    L.push(
      `| ${scn.name} | ${scn.category} | ${row.status} | ${Math.round(row.ms ?? 0)} | ${row.tokensIn ?? 0}/${row.tokensOut ?? 0} | ${row.costUsd != null ? formatCost(row.costUsd) : '—'} | ${detail.slice(0, 220)} |`
    );
  }
  L.push('');
  L.push(`**Totals:** ${machine.totals.pass}/${machine.totals.total} passed (**${machine.totals.passRate}%**) · ${machine.totals.fail} failed · ${machine.totals.skip} skipped · suite wall time ${machine.totals.suiteMs}ms · tokens ${machine.totals.tokensIn}/${machine.totals.tokensOut} · ${formatCost(machine.totals.costUsd)}`);
  L.push('');
  return L.join('\n');
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
