#!/usr/bin/env node
// Release to release: did ox get better or worse at the same tasks on the same
// model? Reads retained bench/real artifacts (it never calls a model), puts the
// runs of each model in order, and compares each with the one before it.
//
//   node bench/real/trend.mjs                 every model, every retained run
//   node bench/real/trend.mjs --gate          exit 1 when the newest run of any
//                                             model got worse than the one before
//   node bench/real/trend.mjs --dir <path> --json
//
// "Worse" (the gate): fewer tasks passed, or the same tasks cost over 25% more,
// or (when cost is unknown) took over 25% more input tokens. Only tasks both
// runs measured are compared, so adding a task never looks like a regression.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIRS = [HERE, path.resolve(HERE, '..', 'results')];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// A run the provider never started says nothing about ox.
const measuredRuns = (task) => (task?.runs ?? []).filter((r) => r?.availability !== 'unavailable'
  && !(Number(r?.tokensIn ?? 0) === 0 && Number(r?.tokensOut ?? 0) === 0 && Number(r?.toolCalls ?? 0) === 0 && !r?.pass && !r?.timedOut));

/** One artifact → one point: per-task means over its measured runs. */
export function pointOf(value, file = '') {
  const tasks = {};
  for (const t of value?.results ?? []) {
    const runs = measuredRuns(t);
    if (!runs.length) continue;
    const mean = (k) => sum(runs.map((r) => Number(r?.[k] ?? 0) || 0)) / runs.length;
    const costs = runs.map((r) => r?.costUsd).filter((c) => Number.isFinite(c));
    tasks[t.id] = {
      pass: sum(runs.map((r) => (r.pass ? 1 : 0))) / runs.length,
      tokensIn: mean('tokensIn'), tokensOut: mean('tokensOut'),
      // Older artifacts did not record it: unknown, not zero.
      tokensCached: runs.every((r) => r?.tokensCached != null) ? mean('tokensCached') : null,
      costUsd: costs.length === runs.length ? sum(costs) / runs.length : null,
      turns: mean('turns'), ms: mean('agentMs'),
    };
  }
  return {
    file, model: `${value?.provider ?? '?'}:${value?.modelId ?? value?.model ?? '?'}`,
    date: value?.date ?? null, oxVersion: value?.oxVersion ?? null, commit: value?.commit ?? null, tasks,
  };
}

function totals(point, ids) {
  const ts = ids.map((id) => point.tasks[id]);
  const tokensIn = sum(ts.map((t) => t.tokensIn));
  const cachedKnown = ts.every((t) => t.tokensCached != null);
  const cached = cachedKnown ? sum(ts.map((t) => t.tokensCached)) : 0;
  const costKnown = ts.every((t) => t.costUsd != null);
  return {
    tasks: ids.length,
    passed: Number(sum(ts.map((t) => t.pass)).toFixed(2)),
    tokensIn: Math.round(tokensIn), tokensOut: Math.round(sum(ts.map((t) => t.tokensOut))),
    cachedPercent: cachedKnown && tokensIn > 0 ? Number((100 * cached / tokensIn).toFixed(1)) : null,
    costUsd: costKnown ? Number(sum(ts.map((t) => t.costUsd)).toFixed(6)) : null,
    turns: Number(sum(ts.map((t) => t.turns)).toFixed(1)),
  };
}

/** Artifacts → per model, its runs oldest first, each with what changed since the one before. */
export function trend(artifacts) {
  const byModel = new Map();
  for (const a of artifacts) {
    if (a?.value?.suite !== 'bench/real') continue;
    const p = pointOf(a.value, a.file);
    if (!Object.keys(p.tasks).length) continue;
    if (!byModel.has(p.model)) byModel.set(p.model, []);
    byModel.get(p.model).push(p);
  }
  const out = [];
  for (const [model, points] of byModel) {
    points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const rows = points.map((p, i) => {
      const row = { file: p.file, date: p.date, oxVersion: p.oxVersion, commit: p.commit, ...totals(p, Object.keys(p.tasks)) };
      const prev = points[i - 1];
      const shared = prev ? Object.keys(p.tasks).filter((id) => prev.tasks[id]) : [];
      if (shared.length) {
        const now = totals(p, shared), was = totals(prev, shared);
        const pct = (a, b) => (b > 0 ? Number((100 * (a - b) / b).toFixed(1)) : null);
        row.since = {
          sharedTasks: shared.length,
          passed: Number((now.passed - was.passed).toFixed(2)),
          tokensInPercent: pct(now.tokensIn, was.tokensIn),
          costPercent: now.costUsd != null && was.costUsd != null ? pct(now.costUsd, was.costUsd) : null,
          cachedPoints: now.cachedPercent != null && was.cachedPercent != null ? Number((now.cachedPercent - was.cachedPercent).toFixed(1)) : null,
          lost: shared.filter((id) => p.tasks[id].pass < prev.tasks[id].pass),
          won: shared.filter((id) => p.tasks[id].pass > prev.tasks[id].pass),
        };
      }
      return row;
    });
    out.push({ model, rows });
  }
  return out.sort((a, b) => a.model.localeCompare(b.model));
}

/** The newest run of each model against the one before it → what got worse (empty when nothing did). */
export function regressions(models, { maxRisePercent = 25 } = {}) {
  const bad = [];
  for (const m of models) {
    const s = m.rows.at(-1)?.since;
    if (!s) continue;
    if (s.passed < 0) bad.push({ model: m.model, what: `passes ${Math.abs(s.passed)} fewer of the same ${s.sharedTasks} tasks`, tasks: s.lost });
    if (s.costPercent != null && s.costPercent > maxRisePercent) bad.push({ model: m.model, what: `costs ${s.costPercent}% more on the same tasks` });
    else if (s.costPercent == null && s.tokensInPercent != null && s.tokensInPercent > maxRisePercent) bad.push({ model: m.model, what: `sends ${s.tokensInPercent}% more input tokens on the same tasks` });
  }
  return bad;
}

export function readArtifacts(dirs = DEFAULT_DIRS) {
  const out = [];
  const walk = (dir, deep) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { if (deep) walk(full, true); continue; }
      if (!name.endsWith('.json')) continue;
      try { out.push({ file: path.relative(process.cwd(), full), value: JSON.parse(fs.readFileSync(full, 'utf8')) }); } catch {}
    }
  };
  for (const d of dirs) walk(d, d !== HERE);
  return out;
}

export function render(models) {
  const lines = [];
  const signed = (n, unit = '') => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}${unit}`);
  for (const m of models) {
    lines.push(m.model);
    lines.push('  ox        date        passed    in tokens  cached   cost       since the run before');
    for (const r of m.rows) {
      const since = r.since
        ? `passed ${signed(r.since.passed)}, input ${signed(r.since.tokensInPercent, '%')}, cost ${signed(r.since.costPercent, '%')}, cached ${signed(r.since.cachedPoints, ' pts')}${r.since.lost.length ? `; lost: ${r.since.lost.join(', ')}` : ''}`
        : '';
      lines.push(`  ${String(r.oxVersion ?? '?').padEnd(9)} ${String(r.date ?? '').slice(0, 10).padEnd(11)} ${`${r.passed}/${r.tasks}`.padEnd(9)} ${String(r.tokensIn).padStart(9)}  ${String(r.cachedPercent == null ? '—' : `${r.cachedPercent}%`).padStart(6)}   ${String(r.costUsd == null ? '—' : `$${r.costUsd.toFixed(4)}`).padEnd(10)} ${since}`);
    }
    lines.push('');
  }
  return lines;
}

function main(argv) {
  const dirAt = argv.indexOf('--dir');
  const models = trend(readArtifacts(dirAt >= 0 ? [path.resolve(argv[dirAt + 1])] : DEFAULT_DIRS));
  const bad = regressions(models);
  if (argv.includes('--json')) console.log(JSON.stringify({ models, regressions: bad }, null, 2));
  else {
    if (!models.length) console.log('no bench/real results yet: run `npm run measure -- --model <provider:model> --all` first');
    for (const l of render(models)) console.log(l);
    for (const b of bad) console.log(`WORSE  ${b.model}: ${b.what}${b.tasks?.length ? ` (${b.tasks.join(', ')})` : ''}`);
    if (models.length && !bad.length) console.log('nothing got worse in the newest run of any model');
  }
  if (argv.includes('--gate') && bad.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
