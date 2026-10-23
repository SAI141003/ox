#!/usr/bin/env node
// Aggregate retained bench/real JSON artifacts without making unavailable or
// unpriced providers look successful. This is deliberately offline: it never
// sends a model request and never reads API keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'results');

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else if (name.endsWith('.json')) out.push(full);
  }
  return out;
}

function p95(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? xs[Math.ceil(xs.length * 0.95) - 1] : null;
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function isUnavailable(run) {
  if (run?.availability === 'unavailable') return true;
  // Older artifacts predate the availability field. Preserve their meaning:
  // a zero-token, zero-tool, failed run is an adapter/readiness failure, not a
  // model-quality observation.
  return run?.availability == null && !run?.pass &&
    Number(run?.tokensIn ?? 0) === 0 && Number(run?.tokensOut ?? 0) === 0 &&
    Number(run?.toolCalls ?? 0) === 0;
}

function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.suite === 'bench/real' ? { file, value } : null;
  } catch {
    return null;
  }
}

function aggregate(records) {
  const groups = new Map();
  for (const { file, value } of records) {
    const key = `${value.provider ?? 'unknown'}:${value.modelId ?? value.model ?? 'unknown'}`;
    const group = groups.get(key) ?? {
      provider: value.provider ?? 'unknown', model: value.modelId ?? value.model ?? 'unknown',
      artifacts: 0, runs: 0, measured: 0, unavailable: 0, passed: 0,
      tokensIn: 0, tokensOut: 0, costs: [], costMissing: 0, agentMs: [], wallMs: [], files: [],
    };
    groups.set(key, group);
    group.artifacts++;
    group.files.push(file);
    for (const task of value.results ?? []) for (const run of task.runs ?? []) {
      group.runs++;
      if (isUnavailable(run)) { group.unavailable++; continue; }
      group.measured++;
      if (run.pass) group.passed++;
      if (Number.isFinite(run.tokensIn)) group.tokensIn += run.tokensIn;
      if (Number.isFinite(run.tokensOut)) group.tokensOut += run.tokensOut;
      if (Number.isFinite(run.agentMs)) group.agentMs.push(run.agentMs);
      if (Number.isFinite(run.ms)) group.wallMs.push(run.ms);
      if (Number.isFinite(run.costUsd) && run.costUsd > 0) group.costs.push(run.costUsd);
      else group.costMissing++;
    }
  }
  return [...groups.values()].map((g) => ({
    provider: g.provider, model: g.model, artifacts: g.artifacts, runs: g.runs,
    measured: g.measured, unavailable: g.unavailable, passed: g.passed,
    passRate: g.measured ? g.passed / g.measured : null,
    tokensIn: g.tokensIn, tokensOut: g.tokensOut,
    costUsd: g.costs.length ? g.costs.reduce((a, b) => a + b, 0) : null,
    costKnown: g.measured > 0 && g.costMissing === 0 && g.unavailable === 0,
    agentMsMean: mean(g.agentMs), agentMsP95: p95(g.agentMs),
    wallMsMean: mean(g.wallMs), wallMsP95: p95(g.wallMs), files: g.files,
  }));
}

function fmt(value, digits = 0) {
  return value == null ? '—' : Number(value).toFixed(digits);
}

function main(argv) {
  const paths = [];
  let jsonOut = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') jsonOut = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node bench/real/compare.mjs [artifact.json ...] [--json out.json]');
      return;
    } else paths.push(argv[i]);
  }
  const candidates = paths.length ? paths.flatMap((p) => {
    const full = path.resolve(p); return fs.existsSync(full) && fs.statSync(full).isDirectory() ? filesUnder(full) : [full];
  }) : filesUnder(root);
  const records = candidates.map(load).filter(Boolean);
  const rows = aggregate(records);
  rows.sort((a, b) => (b.passRate ?? -1) - (a.passRate ?? -1) || (a.agentMsP95 ?? Infinity) - (b.agentMsP95 ?? Infinity));
  const output = { generatedAt: new Date().toISOString(), artifacts: records.length, providers: rows };
  if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(output, null, 2)}\n`); }
  console.log('| Provider | Model | Pass | Runs | Tokens in/out | Cost | Agent mean / p95 | Wall mean / p95 |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.provider} | ${r.model} | ${r.passed}/${r.runs} | ${r.runs} | ${r.tokensIn}/${r.tokensOut} | ${r.costKnown ? `$${fmt(r.costUsd, 6)}` : 'unknown'} | ${fmt(r.agentMsMean)}/${fmt(r.agentMsP95)} ms | ${fmt(r.wallMsMean)}/${fmt(r.wallMsP95)} ms |`);
  if (!rows.length) {
    console.error('No bench/real artifacts found. Run a real benchmark first.');
    process.exitCode = 2;
  }
}

export { aggregate, load };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

