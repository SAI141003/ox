#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = path.join(ROOT, 'bench');
const RUNNER = path.join(BENCH, 'runner.mjs');

const num = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).trim().replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normalize = (row) => {
  const parts = row.tokensIn === undefined ? String(row.tokens ?? '0/0').split('/') : [row.tokensIn, row.tokensOut];
  const status = String(row.status ?? row.result ?? '').trim().toLowerCase();
  return {
    pass: status === 'pass',
    status,
    duration_ms: num(row.duration_ms ?? row.ms),
    tokensIn: num(parts[0]) ?? 0,
    tokensOut: num(parts[1]) ?? 0,
    costUsd: row.costUsd === undefined ? null : num(row.costUsd),
  };
};

function parseResultsMd(text) {
  const rows = new Map();
  let table = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells[0]?.toLowerCase() === 'scenario' && cells[2]?.toLowerCase() === 'result') { table = true; continue; }
    if (!table || cells.length < 6) continue;
    const row = normalize({ status: cells[2], ms: cells[3], tokens: cells[4], costUsd: cells[5] });
    if (row.status === 'pass' || row.status === 'fail') rows.set(cells[0], row);
  }
  return rows;
}

const pct = (now, before) => now === null || before === null || before === 0 ? null : ((now - before) / before) * 100;
const diff = (now, before) => ({ absolute: now === null || before === null ? null : now - before, percent: pct(now, before) });
const signed = (value) => `${value >= 0 ? '+' : ''}${Math.round(value)}`;
const deltaText = (value, up, down) => {
  if (value.before === null || value.now === null) return '—';
  if (value.before === 0) return value.now === 0 ? '0' : `${signed(value.now)} (new)`;
  const p = pct(value.now, value.before);
  return p === null || Math.abs(p) < 0.5 ? `${signed(value.now - value.before)} (0%)` : `${signed(value.now - value.before)} (${Math.abs(p).toFixed(0)}% ${p > 0 ? up : down})`;
};
const costText = (value) => {
  if (value.before === null || value.now === null) return value.now === null ? '—' : 'new';
  if (value.before === 0) return value.now === 0 ? '$0 (0%)' : `+$${value.now.toFixed(6)} (new)`;
  const p = pct(value.now, value.before);
  return p === null || Math.abs(p) < 0.5 ? `${signed(value.absolute)} (0%)` : `${value.absolute >= 0 ? '+' : '-'}$${Math.abs(value.absolute).toFixed(6)} (${Math.abs(p).toFixed(0)}% ${p > 0 ? 'more' : 'less'})`;
};

function verdict(before, now) {
  if (!before) return { label: '🆕 new scenario', kind: 'new', regression: false };
  if (before.status === 'pass' && now.status === 'fail') return { label: '❌ REGRESSION', kind: 'regression', regression: true };
  if (before.status === 'fail' && now.status === 'fail') return { label: '⚠️ new failure (pre-existing)', kind: 'persistent-failure', regression: false };
  if (before.status === 'pass' && now.status === 'pass') return { label: '✅ passed before and now', kind: 'stable', regression: false };
  if (before.status === 'fail' && now.status === 'pass') return { label: '✅ recovered', kind: 'recovered', regression: false };
  return { label: `⚠️ status ${before.status} → ${now.status}`, kind: 'changed', regression: false };
}

// Fail-closed outcome classification for the CURRENT run itself. A canary
// that exits 0 while scenarios fail or vanish protects nothing.
export function outcomeIssues(current, baseline, machineResults) {
  const problems = [];
  for (const [name, row] of current) {
    if (!row.pass) problems.push(`failed: ${name}`);
  }
  for (const name of baseline.keys()) {
    if (!current.has(name)) problems.push(`missing from current run: ${name}`);
  }
  const counts = new Map();
  for (const r of machineResults) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (name && name !== 'undefined' && name !== 'null' && counts.get(name) > 1) problems.push(`duplicate result rows: ${name} (${counts.get(name)}x)`);
  }
  if (machineResults.length === 0) problems.push('runner returned zero results');
  return problems;
}

function canarySection(created, exitCode, regressions) {
  const state = created ? 'baseline created from this run' : `${regressions.length} regression(s), exit ${exitCode}`;
  return `<!-- regression-canary -->
## Regression canary

The first benchmark table in this file is the recorded baseline.
\`scripts/regression-canary.js\` parses its \`scenario\`, \`result\`, \`ms\`,
\`tokens in/out\`, and \`cost\` columns before running the deterministic mock
suite, then writes the machine-readable diff to \`bench/canary.json\`.
\`bench/runner.mjs\` writes every run to \`bench/results/<ISO-timestamp>/\` and
replaces this baseline only when passed \`--update-baseline\`. Run
\`node scripts/regression-canary.js --current <run RESULTS.md>\` to diff against
an already recorded run instead of re-running the suite.

| baseline field | format |
|---|---|
| scenario | benchmark name |
| result | \`PASS\` or \`FAIL\` |
| ms | scenario wall time in milliseconds |
| tokens in/out | input and output token counts |
| cost | simulated USD cost |

Latest canary: ${state}.
<!-- /regression-canary -->`;
}

export function decideExitCode(regressions, outcomeProblems, created) {
  return regressions.length || outcomeProblems.length ? 1 : created ? 2 : 0;
}

// The runner writes each run to a run-scoped directory and never touches the
// baseline, so the canary directs it at a temp run dir and diffs that file.
function runBenchmark({ jsonPath, runDir }) {
  execFileSync(process.execPath, [RUNNER, '--json', jsonPath, '--out-dir', runDir], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return path.join(runDir, 'RESULTS.md');
}

function parseArgs(argv) {
  const opts = { currentPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current') opts.currentPath = path.resolve(String(argv[++i] ?? ''));
    else {
      process.stderr.write(`canary: unknown arg '${a}'\nusage: node scripts/regression-canary.js [--current <run RESULTS.md>]\n`);
      process.exit(3);
    }
  }
  return opts;
}

// Newest run-scoped RESULTS.md under bench/results/. Directory names are ISO
// timestamps, so lexical order is chronological order.
function newestRunResults(runsDir) {
  if (!fs.existsSync(runsDir)) return null;
  const found = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(runsDir, e.name, 'RESULTS.md'))
    .filter((p) => fs.existsSync(p))
    .sort();
  return found.length ? found[found.length - 1] : null;
}

// A recorded run RESULTS.md carries the same columns the machine JSON does, so a
// `--current` file can stand in for a fresh run without re-executing the suite.
function machineFromResultsMd(file, text) {
  const rows = parseResultsMd(text);
  return {
    mode: null,
    suiteMs: null,
    totals: null,
    results: [...rows].map(([name, row]) => ({
      name, status: row.status, ms: row.duration_ms,
      tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd,
    })),
    source: file,
  };
}

export function main({ outputDir = BENCH, benchmark = runBenchmark, currentPath = null } = {}) {
const RESULTS = path.join(outputDir, 'RESULTS.md');
const CANARY = path.join(outputDir, 'canary.json');
const RUNS = path.join(outputDir, 'results');
const baselineText = fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8') : null;
const baseline = baselineText ? parseResultsMd(baselineText) : new Map();
if (baselineText && baseline.size === 0) throw new Error(`${RESULTS} exists but contains no benchmark rows`);
let machine;
let currentLabel;
if (currentPath) {
  if (!fs.existsSync(currentPath)) throw new Error(`--current: no such run results file ${currentPath}`);
  machine = machineFromResultsMd(currentPath, fs.readFileSync(currentPath, 'utf8'));
  currentLabel = currentPath;
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-canary-'));
  const jsonPath = path.join(tempDir, 'results.json');
  const runDir = path.join(tempDir, 'run');
  try {
    const produced = benchmark({ jsonPath, runDir });
    machine = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    currentLabel = produced && fs.existsSync(produced) ? produced : (newestRunResults(RUNS) ?? jsonPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
if (!Array.isArray(machine?.results)) throw new Error('bench runner did not emit a results array');

const current = new Map(machine.results.map((row) => [row.name, normalize(row)]));
const created = baselineText === null;
const rows = [...new Set([...baseline.keys(), ...current.keys()])].map((name) => {
  const before = baseline.get(name) ?? null;
  const now = current.get(name) ?? { pass: false, status: 'missing', duration_ms: null, tokensIn: null, tokensOut: null, costUsd: null };
  const v = verdict(before, now);
  const beforeTokens = before ? before.tokensIn + before.tokensOut : null;
  const nowTokens = now.tokensIn + now.tokensOut;
  return {
    name,
    status: now.status,
    pass: now.pass,
    duration_ms: now.duration_ms,
    tokensIn: now.tokensIn,
    tokensOut: now.tokensOut,
    costUsd: now.costUsd,
    accuracy: { before: before?.status ?? null, now: now.status, regression: v.regression },
    baseline: before,
    current: now,
    result: v.label,
    kind: v.kind,
    regression: v.regression,
    latency: { ...diff(now.duration_ms, before?.duration_ms ?? null), before: before?.duration_ms ?? null, now: now.duration_ms },
    tokens: { ...diff(nowTokens, beforeTokens), before: beforeTokens, now: nowTokens },
    cost: { ...diff(now.costUsd, before?.costUsd ?? null), before: before?.costUsd ?? null, now: now.costUsd },
  };
});

const regressions = rows.filter((row) => row.regression).map((row) => row.name);
const newScenarios = rows.filter((row) => row.kind === 'new').map((row) => row.name);
const persistentFailures = rows.filter((row) => row.kind === 'persistent-failure').map((row) => row.name);
const passed = [...current.values()].filter((row) => row.pass).length;
const failed = [...current.values()].filter((row) => row.status === 'fail').length;
// Fail-closed exit: regressions, any current failure, or missing baseline
// scenarios must all produce a non-zero exit. Only a clean full pass (or a
// first-run baseline creation) exits 0/2.
const outcomeProblems = created ? [] : outcomeIssues(current, baseline, machine.results);
const exitCode = regressions.length || outcomeProblems.length ? 1 : created ? 2 : 0;
const summary = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  baselineCreated: created,
  baselineExists: baselineText !== null,
  exitCode,
  outcomeProblems: outcomeProblems,
  runner: { mode: machine.mode ?? 'deterministic', suiteMs: machine.suiteMs ?? null, totals: machine.totals ?? null },
  counts: { baselineScenarios: baseline.size, currentScenarios: current.size, passed, failed, regressions: regressions.length, newScenarios: newScenarios.length, persistentFailures: persistentFailures.length },
  regressions,
  newScenarios,
  persistentFailures,
  baseline: Object.fromEntries(created ? current : baseline),
  current: Object.fromEntries(current),
  scenarios: rows,
};

console.log('ox regression canary · deterministic mock suite');
console.log(`baseline: ${created ? 'created from this run' : RESULTS}`);
console.log(`current: ${currentLabel}`);
console.log('\n| scenario | accuracy | latency delta | token delta | cost delta |\n|---|---|---|---|---|');
for (const row of rows) console.log(`| ${row.name} | ${row.result} | ${deltaText(row.latency, 'slower', 'faster')} | ${deltaText(row.tokens, 'more tokens', 'fewer tokens')} | ${costText(row.cost)} |`);
if (outcomeProblems.length) {
  console.log('\nfail-closed outcomes:');
  for (const p of outcomeProblems) console.log(`  - ${p}`);
}
console.log(`\nsummary: ${passed}/${current.size} passed · ${regressions.length} regression(s) · ${newScenarios.length} new scenario(s) · ${outcomeProblems.length} outcome problem(s) · exit ${exitCode}`);

fs.writeFileSync(CANARY, `${JSON.stringify(summary, null, 2)}\n`);
  const source = baselineText ?? fs.readFileSync(RESULTS, 'utf8');
  const clean = source.replace(/\n?<!-- regression-canary -->[\s\S]*?<!-- \/regression-canary -->\n?/g, '');
  fs.writeFileSync(RESULTS, `${clean.trimEnd()}\n\n${canarySection(created, exitCode, regressions)}\n`);
  process.exitCode = exitCode;
  return { exitCode, summary, rows, regressions, outcomeProblems, created };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = main(parseArgs(process.argv.slice(2)));
  process.exit(result.exitCode);
}
