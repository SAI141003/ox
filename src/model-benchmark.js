export const MODEL_BENCHMARK_SCHEMA_VERSION = '1.0.0';

export const MODEL_BENCHMARKS = [
  { name: 'swe-bench', description: 'Real-world GitHub issue resolution', tasks: 2294, metric: 'Pass@1 (resolved)' },
  { name: 'terminal-bench', description: 'Terminal/DevOps task completion', tasks: 289, metric: 'Success rate' },
  { name: 'agent-bench', description: 'General agent capability across environments', tasks: 80, metric: 'Average score' },
  { name: 'mm-tau-p2', description: 'Multimodal task completion', tasks: 150, metric: 'Pass rate' },
  { name: 'utboost', description: 'Utility benchmark for tool use', tasks: 100, metric: 'F1 score' },
  { name: 'swe-rebench', description: 'SWE-bench re-evaluation for regression', tasks: 400, metric: 'Pass rate' }
];

export function createModelBenchmarker(models = [], config = {}) {
  return {
    models,
    async runAll() {
      const results = [];
      for (const model of models) {
        for (const bench of MODEL_BENCHMARKS) {
          results.push(await this.runOne(model.name || model, bench.name));
        }
      }
      return results;
    },
    async runOne(modelId, benchmarkName) {
      const bench = MODEL_BENCHMARKS.find(b => b.name === benchmarkName);
      if (!bench) return { model: modelId, benchmark: benchmarkName, score: null, status: 'unmeasured', error: 'unknown benchmark' };
      // There is no runnable driver for these suites: src/bench/benchmark.js is an
      // importable library with no CLI entry point (it exports runBenchmark() and
      // references helpers it never defines), so `node src/bench/benchmark.js run …`
      // prints nothing and exits 0. Shelling out to it produced an empty stdout,
      // JSON.parse('') threw, and the old catch block substituted a catalog number —
      // i.e. it printed invented scores as if they had been measured.
      //
      // An unmeasured score is reported as null with the reason attached. It is NOT
      // backfilled from MODEL_CATALOG: a fabricated benchmark number is worse than
      // an honest blank, because every downstream reader cannot tell the two apart.
      // `config.runner`, when supplied, is the hook for a real driver — its return
      // value must contain the score it actually observed.
      if (typeof config.runner === 'function') {
        const started = Date.now();
        const measured = await config.runner({ model: modelId, benchmark: bench, cwd: config.cwd || process.cwd() });
        const score = Number(measured?.score);
        if (measured && Number.isFinite(score)) {
          return {
            model: modelId,
            benchmark: benchmarkName,
            score,
            status: 'measured',
            duration: Number.isFinite(measured.duration) ? measured.duration : Date.now() - started,
            cost: Number.isFinite(Number(measured.cost)) ? Number(measured.cost) : null,
            details: measured.details || {},
          };
        }
      }
      return {
        model: modelId,
        benchmark: benchmarkName,
        score: null,
        status: 'unmeasured',
        duration: 0,
        cost: null,
        details: {
          note: 'unmeasured — no runnable benchmark driver (src/bench/benchmark.js is a library, not a CLI); no estimated value substituted',
          reason: 'no-driver',
        },
      };
    },
    compare(results) {
      const byModel = {};
      for (const r of results) {
        if (!byModel[r.model]) byModel[r.model] = { model: r.model, benchmarks: {}, avgScore: null, measured: 0, count: 0 };
        byModel[r.model].benchmarks[r.benchmark] = r.score ?? null;
        byModel[r.model].count++;
        // null scores (unmeasured / error) must not dilute an average with a zero.
        if (r.score != null && Number.isFinite(Number(r.score))) {
          byModel[r.model].measured++;
          byModel[r.model].avgScore = (byModel[r.model].avgScore ?? 0) + Number(r.score);
        }
      }
      for (const m of Object.values(byModel)) m.avgScore = m.measured ? m.avgScore / m.measured : null;
      // Unmeasured models sort last rather than pretending to be tied at zero.
      return Object.values(byModel).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
    },
    formatReport(results) {
      const compared = this.compare(results);
      const benches = MODEL_BENCHMARKS.map(b => b.name);
      const cell = (v) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(1));
      let out = '| Model | ' + benches.join(' | ') + ' | Avg |\n';
      out += '|-------|' + benches.map(() => '---').join('|') + '|-----|\n';
      for (const m of compared) {
        out += '| ' + m.model + ' | ' + benches.map(b => cell(m.benchmarks[b])).join(' | ') + ' | ' + cell(m.avgScore) + ' |\n';
      }
      return out;
    },
    async saveReport(results, path) {
      const { writeFile } = await import('node:fs/promises');
      const report = { generated: new Date().toISOString(), benchmarks: MODEL_BENCHMARKS.map(b => b.name), results };
      await writeFile(path, JSON.stringify(report, null, 2));
      return path;
    }
  };
}

export function benchmarkModel(modelId, benchmarkName) {
  const benchmarker = createModelBenchmarker([modelId]);
  return benchmarker.runOne(modelId, benchmarkName);
}

export function formatBenchmarkTable(results) {
  const benchmarker = createModelBenchmarker([]);
  return benchmarker.formatReport(results);
}

// Reads the measurements a caller actually has, and nothing else. This
// function used to seed `score: 0` for every benchmark on every model, so with
// zero measurements `compare()` averaged two runs of zeros and it reported
// `winner: 'tie', margin: 0` — a comparison that looked measured but was
// invented. That is the same fabrication runOne()/compare() now refuse, so the
// seeding path is gone: a score enters only when a real result row carries it.
//
// Two call shapes are supported:
//   compareModelBenchmarks(modelIdA, modelIdB, benchmarkNames) — names only
//   compareModelBenchmarks(recordA, recordB)                  — compare() rows
// The first carries no measurements, so it always declines to pick a winner.
function measurementRows(side) {
  if (side == null || typeof side === 'string') return [];
  if (Array.isArray(side)) return side.flatMap(measurementRows);
  if (Array.isArray(side.benchmarks)) {
    return side.benchmarks.map(r => ({ model: r?.model ?? null, benchmark: r?.benchmark ?? null, score: r?.score ?? null }));
  }
  if (side.benchmarks && typeof side.benchmarks === 'object') {
    return Object.entries(side.benchmarks).map(([benchmark, score]) => ({ model: null, benchmark, score: score ?? null }));
  }
  if ('score' in side) return [{ model: side.model ?? null, benchmark: side.benchmark ?? null, score: side.score }];
  return [];
}

function modelIdOf(side) {
  if (side == null) return null;
  if (typeof side === 'string') return side;
  if (Array.isArray(side)) return modelIdOf(side.find(r => r != null));
  return side.model ?? side.modelId ?? side.name ?? null;
}

export function compareModelBenchmarks(modelA, modelB, benchmarks) {
  // `benchmarks` (names only) is retained for signature compatibility; names
  // are not measurements and are never turned into scores here.
  const benchmarker = createModelBenchmarker([modelA, modelB]);

  const results = [];
  for (const side of [modelA, modelB]) {
    const sideId = modelIdOf(side);
    for (const row of measurementRows(side)) {
      const score = row.score == null ? null : Number(row.score);
      results.push({
        model: row.model ?? sideId,
        benchmark: row.benchmark ?? 'unknown',
        score: Number.isFinite(score) ? score : null
      });
    }
  }

  const aId = modelIdOf(modelA);
  const bId = modelIdOf(modelB);
  const compared = benchmarker.compare(results);
  const a = compared.find(m => m.model === aId);
  const b = compared.find(m => m.model === bId);
  const models = [
    { model: aId ?? null, measured: a?.measured ?? 0, avgScore: a?.avgScore ?? null },
    { model: bId ?? null, measured: b?.measured ?? 0, avgScore: b?.avgScore ?? null }
  ];
  const details = { [aId ?? 'modelA']: a?.avgScore ?? null, [bId ?? 'modelB']: b?.avgScore ?? null };

  // No measured scores on either side means no verdict — never a coin-flip 'tie'
  // between two blank averages. compare() already yields avgScore: null for a
  // model with zero measured scores, so this is the single refusal point.
  if (a?.avgScore == null || b?.avgScore == null) {
    return { winner: null, margin: null, unmeasured: true, reason: 'no measured results', models, details };
  }

  const margin = a.avgScore - b.avgScore;
  return {
    winner: margin > 0 ? aId : margin < 0 ? bId : 'tie',
    margin: Math.abs(margin),
    reason: 'measured',
    models,
    details
  };
}
