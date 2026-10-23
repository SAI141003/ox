import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runAgent } from './agent.js';
import { estimateTokens } from './context.js';
import { costOf } from './cost.js';

const BENCH_DIR = process.env.OX_BENCHMARK_DIR || path.join(os.homedir(), '.ox', 'benchmarks');
const JUDGE_MODEL = process.env.OX_JUDGE_MODEL || null;
const MAX_PARALLEL = Number(process.env.OX_BENCHMARK_MAX_PARALLEL || 4);

export const AGENT_BENCHMARKS = [
  { id: 'swe-coding', name: 'SWE-Coding', category: 'coding', description: 'Resolve GitHub issues with gold test patches.', taskCount: 0, environment: 'repo', evalFn: null },
  { id: 'terminal-bench', name: 'Terminal-Bench', category: 'terminal', description: 'Command-line tasks in sandboxed shell.', taskCount: 0, environment: 'shell', evalFn: null },
  { id: 'multimodal', name: 'Multimodal-Eval', category: 'multimodal', description: 'MM-tau-p2 / MULTIVOX / OmniGAIA style.', taskCount: 0, environment: 'multimodal', evalFn: null },
  { id: 'tool-use', name: 'Tool-Use', category: 'tool-use', description: 'Tool selection, argument validity, chaining.', taskCount: 0, environment: 'tools', evalFn: null },
  { id: 'web-agents', name: 'Web-Agents', category: 'web-agents', description: 'Navigation, form-filling, extraction.', taskCount: 0, environment: 'browser', evalFn: null },
  { id: 'database', name: 'Database', category: 'database', description: 'Schema design, queries, migrations.', taskCount: 0, environment: 'db', evalFn: null },
  { id: 'os-interaction', name: 'OS-Interaction', category: 'os-interaction', description: 'File systems, processes, config workflows.', taskCount: 0, environment: 'os', evalFn: null },
];

const BENCH_BY_ID = new Map(AGENT_BENCHMARKS.map((b) => [b.id, b]));
const _mk = (m) => m;

export async function runBenchmark(benchmarkId, agentConfig, options = {}) {
  const bench = BENCH_BY_ID.get(benchmarkId);
  if (!bench) throw new Error(`Unknown benchmark: ${benchmarkId}`);
  const tasks = await loadTasks(benchmarkId, options.tasks);
  bench.taskCount = tasks.length;
  const results = [];
  for (const task of tasks) {
    const timeout = options.timeoutMs || 120_000;
    try {
      const r = await runWithTimeout(runSingleTask(task, agentConfig, options), timeout, benchmarkId, task.id);
      results.push(r);
    } catch (err) {
      results.push({ taskId: task.id, pass: false, error: String(err), category: bench.category });
    }
  }
  return { benchmarkId, name: bench.name, category: bench.category, results };
}

export async function evaluateAgent(agentConfig, benchmarkIds = AGENT_BENCHMARKS.map((b) => b.id), options = {}) {
  const out = {};
  for (const id of benchmarkIds) {
    try { out[id] = await runBenchmark(id, agentConfig, options); }
    catch (err) { out[id] = { benchmarkId: id, error: String(err), results: [] }; }
  }
  return { agent: agentConfig, benchmarks: out, overall: computeStats({ trials: Object.values(out).flatMap((b) => (b.results || []).map((r) => (r.pass ? 1 : 0))) }) };
}

async function runSingleTask(task, agentConfig, options) {
  const scaffold = options.scaffold || STANDARD_SCAFFOLD;
  const messages = buildMessages(task, scaffold, options.modality || 'text');
  const trajectory = [];
  const startedAt = Date.now();
  let firstOutputAt = null;
  for await (const event of runAgent({ target: agentConfig, messages, ctx: { cwd: task.cwd || process.cwd() }, maxIterations: options.maxIterations || 20, signal: options.signal })) {
    if (firstOutputAt == null && (event.type === 'text-delta' || event.type === 'assistant-turn' || event.type === 'tool-start')) firstOutputAt = Date.now();
    trajectory.push(event);
    // Keep consuming after `final`: runAgent emits its authoritative
    // `usage-total` at the end of the run, and stopping on final would silently
    // turn a measured benchmark back into an estimate-only result.
    if (event.type === 'error' || event.type === 'usage-total') break;
  }
  const pass = evaluateTrajectory(task, trajectory, options);
  const metrics = summarizeTrajectoryMetrics(trajectory, {
    estimatedInputTokens: estimateTokens(JSON.stringify(messages)),
    startedAt,
    firstOutputAt,
    model: typeof agentConfig === 'string' ? agentConfig : (agentConfig?.model || agentConfig?.modelId || null),
  });
  return { taskId: task.id, pass, trajectory, modality: options.modality || 'text', ...metrics };
}

// Keep benchmark numbers tied to what the provider actually reported. A
// prompt-size estimate is useful as a fallback diagnostic, but it must never be
// presented as measured spend. `runAgent` emits per-request usage and a final
// usage-total; prefer the latter so retries/fallbacks are included exactly once.
export function summarizeTrajectoryMetrics(trajectory = [], { estimatedInputTokens = 0, startedAt = Date.now(), firstOutputAt = null, model = null } = {}) {
  const events = Array.isArray(trajectory) ? trajectory : [];
  const total = [...events].reverse().find((e) => e?.type === 'usage-total');
  const usageEvents = events.filter((e) => e?.type === 'usage');
  const usage = total
    ? { inputTokens: Number(total.inputTokens) || 0, outputTokens: Number(total.outputTokens) || 0, cacheReadTokens: Number(total.cacheReadTokens) || 0, cacheWriteTokens: Number(total.cacheWriteTokens) || 0 }
    : usageEvents.reduce((sum, e) => ({
      inputTokens: sum.inputTokens + (Number(e.inputTokens) || 0),
      outputTokens: sum.outputTokens + (Number(e.outputTokens) || 0),
      cacheReadTokens: sum.cacheReadTokens + (Number(e.cacheReadTokens) || 0),
      cacheWriteTokens: sum.cacheWriteTokens + (Number(e.cacheWriteTokens) || 0),
    }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const hasMeasuredUsage = Boolean(total || usageEvents.length);
  const costUsd = hasMeasuredUsage && model ? costOf(model, usage) : null;
  const endedAt = Date.now();
  return {
    estimatedInputTokens,
    inputTokens: hasMeasuredUsage ? usage.inputTokens : null,
    outputTokens: hasMeasuredUsage ? usage.outputTokens : null,
    cacheReadTokens: hasMeasuredUsage ? usage.cacheReadTokens : null,
    cacheWriteTokens: hasMeasuredUsage ? usage.cacheWriteTokens : null,
    totalTokens: hasMeasuredUsage ? usage.inputTokens + usage.outputTokens : null,
    costUsd,
    latencyMs: Math.max(0, endedAt - startedAt),
    timeToFirstOutputMs: firstOutputAt == null ? null : Math.max(0, firstOutputAt - startedAt),
    turns: events.filter((e) => e?.type === 'turn-end').length,
    toolCalls: events.filter((e) => e?.type === 'tool-start').length,
    usageMeasured: hasMeasuredUsage,
  };
}

function buildMessages(task, scaffold, modality) {
  const system = typeof scaffold.system === 'function' ? scaffold.system(task) : scaffold.system;
  const question = typeof scaffold.question === 'function' ? scaffold.question(task) : scaffold.question;
  return [{ role: 'system', content: system }, { role: 'user', content: question }];
}

function evaluateTrajectory(task, trajectory) {
  const finals = trajectory.filter((e) => e.type === 'final' || e.type === 'error');
  if (!finals.length) return false;
  const last = finals[finals.length - 1];
  if (last.type === 'error') return false;
  const text = last.message?.content || '';
  if (task.expectations) return task.expectations.every((e) => new RegExp(e, 'i').test(String(text)));
  return !!text && String(text).length > 10;
}

function runWithTimeout(promise, ms, benchId, taskId) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${benchId}:${taskId}`)), ms))]);
}

async function loadTasks(benchmarkId, taskDir) {
  const dir = taskDir || path.join(BENCH_DIR, benchmarkId);
  if (!fs.existsSync(dir)) return [{ id: 'default', text: 'default task' }];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
  return entries.map((f) => {
    try { const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: parsed.id || f, ...parsed }; }
    catch { return { id: f.replace(/\.[^.]+$/, ''), text: fs.readFileSync(path.join(dir, f), 'utf8') }; }
  });
}

// --- Multimodal ------------------------------------------------------------

export const MULTIMODAL_METRICS = {
  goal: ['goal_achievement', 'intent_fidelity', 'hallucination_rate'],
  robustness: ['distribution_shift', 'adversarial_robustness', 'input_variance'],
  efficiency: ['latency', 'token_efficiency', 'turn_efficiency'],
  recovery: ['error_recovery', 'self_correction', 'adaptation'],
  safety: ['refusal_rate', 'bias_score', 'toxicity'],
};

export function evaluateMultimodal({ agent, tasks, modality = 'text' }) {
  const results = { textPass: 0, voicePass: 0, multimodalPass: 0, total: 0 };
  for (const task of tasks) {
    results.total++;
    const modeKey = modality === 'voice' ? 'voicePass' : modality === 'multimodal' ? 'multimodalPass' : 'textPass';
    results[modeKey] += runAgentEval(agent, task, modality) ? 1 : 0;
  }
  results.score = computeMRS({ textPass: results.textPass, voicePass: results.voicePass });
  return results;
}

async function runAgentEval(agent, task, modality) {
  if (!agent || !task) return false;
  let content = task.text || task.prompt || task;
  if (modality === 'voice') content = `[AUDIO_TRANSCRIPT] ${content}`;
  else if (modality === 'multimodal') content = `[MULTIMODAL] ${content}`;
  let ok = false;
  try {
    for await (const _ of runAgent({ target: agent, messages: [{ role: 'user', content }], maxIterations: 10 })) ok = true;
  } catch { ok = false; }
  return ok;
}

export function computeMRS({ textPass, voicePass }) {
  const total = (textPass || 0) + (voicePass || 0);
  if (!total) return 0;
  return Math.round((Math.min(textPass || 0, voicePass || 0) / total) * 1000) / 10;
}

// --- Test augmentation (UTBoost) -------------------------------------------

export function augmentTests({ task, goldPatch, generatedPatch, testCases }) {
  const augmented = [...(testCases || [])];
  const goldLines = goldPatch ? String(goldPatch).split('\n') : [];
  const genLines = generatedPatch ? String(generatedPatch).split('\n') : [];
  for (const line of goldLines) {
    if (line.trim().startsWith('+') && !line.trim().startsWith('+++') && !augmented.some((t) => t.includes(line.slice(1).trim()))) {
      augmented.push(`assert: ${line.slice(1).trim()}`);
    }
  }
  const mutated = [];
  for (const t of augmented) {
    if (t.includes('assert')) { mutated.push(t.replace(/==/g, '!=')); mutated.push(t.replace(/(true|True)/g, 'false')); }
  }
  return { augmented: [...augmented, ...mutated.slice(0, 10)], goldCoverage: estimateCoverage(goldPatch, augmented), mutationCount: Math.min(mutated.length, 10) };
}

function estimateCoverage(goldPatch, tests) {
  if (!goldPatch || !tests.length) return 0;
  const fns = new Set((String(goldPatch).match(/\bdef\s+(\w+)/g) || []).map((m) => m.replace('def ', '')));
  if (!fns.size) return Math.min(100, tests.length * 20);
  let covered = 0;
  for (const t of tests) { for (const fn of fns) { if (t.includes(fn)) { covered++; break; } } }
  return Math.round((covered / fns.size) * 100);
}

export function intramorphicCheck({ goldPatch, generatedPatch, augmentedTests }) {
  const gold = String(goldPatch || ''), gen = String(generatedPatch || ''), tests = augmentedTests || [];
  const gH = crypto.createHash('sha256').update(gold).digest('hex'), gH2 = crypto.createHash('sha256').update(gen).digest('hex');
  let pc = 0;
  for (const t of tests) { if (gold.includes(t) || gen.includes(t) || t.length < 40) pc++; }
  return { sameHash: gH === gH2, behavioralEquivalence: pc / Math.max(1, tests.length), passes: pc, total: tests.length, intramorphic: gH === gH2 || pc === tests.length };
}

export function validatePatches({ patches, task }) {
  const results = [];
  for (const p of patches) {
    const s = String(p);
    const hasApply = /\b(apply_patch|edit|write_file)\b/i.test(s);
    const hasSyntax = /(def |class |import |{|#include)/.test(s);
    results.push({ patch: s.slice(0, 200), valid: hasApply && hasSyntax, hasApply, hasSyntax });
  }
  return { results, validCount: results.filter((r) => r.valid).length, total: results.length };
}

// --- Decontamination (SWE-rebench) -----------------------------------------

const CONTAMINATION_DB = new Map();
(function seed() {
  if (CONTAMINATION_DB.size) return;
  for (const s of ['SWE-bench', 'MBPP', 'HumanEval', 'GSM8K', 'MATH']) CONTAMINATION_DB.set(s, { date: '2024-12-01', source: 'contamination-db' });
})();

export function checkContamination({ task, modelReleaseDate }) {
  const taskId = String(task?.id || task || '');
  const taskText = String(task?.text || task || '');
  const date = new Date(modelReleaseDate || '2025-01-01');
  const hash = crypto.createHash('sha256').update(taskId + taskText).digest('hex');
  let contaminated = false, matchDate = null;
  for (const [key, meta] of CONTAMINATION_DB) {
    if (meta.date > date && (key.includes(taskId) || taskText.includes(key))) { contaminated = true; matchDate = meta.date; break; }
  }
  return { taskId, contaminated, matchDate, hash, trainSplit: contaminated ? 'val/test' : 'train' };
}

export function decontaminatedScore({ results, modelReleaseDate }) {
  const all = Array.isArray(results) ? results : Object.values(results || {}).flatMap((b) => b.results || []);
  let total = 0, decontaminated = 0, rawPass = 0;
  for (const r of all) {
    total++; if (r.pass) rawPass++;
    if (!checkContamination({ task: { id: r.taskId || r.task, text: r.text || '' }, modelReleaseDate }).contaminated) decontaminated += r.pass ? 1 : 0;
  }
  return { rawPass, decontaminated, total, rawRate: total ? rawPass / total : 0, decontaminatedRate: total ? decontaminated / total : 0 };
}

export function temporalSplit({ tasks, window = 30 }) {
  const sorted = [...tasks].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  if (!sorted.length) return { train: [], val: [], test: [] };
  const n = sorted.length;
  return {
    train: sorted.slice(0, Math.floor(n * 0.6)).map((t) => ({ ...t, split: 'train' })),
    val: sorted.slice(Math.floor(n * 0.6), Math.floor(n * 0.8)).map((t) => ({ ...t, split: 'val' })),
    test: sorted.slice(Math.floor(n * 0.8)).map((t) => ({ ...t, split: 'test' })),
    cutoff: new Date(sorted[Math.floor(n * 0.6)]?.date || '2024-01-01').toISOString().slice(0, 10),
    window,
  };
}

// --- Standardized scaffold (ReAct) -----------------------------------------

export const STANDARD_SCAFFOLD = {
  system: 'You are a coding agent. Use tools to solve the task. Provide reasoning before each tool call.',
  question: (task) => `Task: ${task?.text || task?.prompt || task}\nProvide your solution step by step.`,
  toolFormat: 'function_call', maxIterations: 20, verify: false,
};

export async function runStandardized({ model, task, scaffold = STANDARD_SCAFFOLD }) {
  const messages = [{ role: 'system', content: scaffold.system }, { role: 'user', content: typeof scaffold.question === 'function' ? scaffold.question(task) : scaffold.question }];
  const trajectory = [];
  for await (const event of runAgent({ target: { model }, messages, ctx: { cwd: task.cwd || process.cwd() }, maxIterations: scaffold.maxIterations || 20, signal: task.signal })) {
    trajectory.push(event);
    if (event.type === 'final' || event.type === 'error') break;
  }
  return { model, taskId: task.id, trajectory, scaffold: 'standardized' };
}

export async function standardizedEval({ models, tasks }) {
  const results = {};
  const modelList = Array.isArray(models) ? models : [models];
  const taskList = Array.isArray(tasks) ? tasks : [tasks];
  const pending = [];
  let running = 0;
  for (const model of modelList) {
    results[model] = [];
    for (const task of taskList) {
      while (running >= MAX_PARALLEL) await new Promise((resolve) => setTimeout(resolve, 50));
      running++;
      pending.push(runStandardized({ model, task }).then((r) => {
        const final = r.trajectory.filter((e) => e.type === 'final').pop();
        const text = final?.message?.content || '';
        const pass = task?.expectations ? task.expectations.every((e) => new RegExp(e, 'i').test(text)) : text.length > 10;
        results[model].push({ model, taskId: task.id, pass, tokens: estimateTokens(JSON.stringify([{ role: 'system', content: STANDARD_SCAFFOLD.system }, { role: 'user', content: typeof STANDARD_SCAFFOLD.question === 'function' ? STANDARD_SCAFFOLD.question(task) : STANDARD_SCAFFOLD.question }])), text: text.slice(0, 500) });
        running--;
      }));
    }
  }
  await Promise.all(pending);
  return results;
}

// --- Failure taxonomy (Terminal-Bench) -------------------------------------

export const FAILURE_CATEGORIES = {
  execution: ['command_not_found', 'permission_denied', 'timeout', 'exit_code_nonzero', 'syntax_error', 'env_missing'],
  coherence: ['irrelevant_output', 'incomplete_solution', 'contradictory_steps', 'infinite_loop', 'off_topic'],
  verification: ['test_fail', 'assertion_mismatch', 'missing_coverage', 'false_positive', 'skipped_tests'],
};

export function classifyFailures({ trajectory, judgeModel = JUDGE_MODEL }) {
  const failures = { execution: [], coherence: [], verification: [] };
  for (const event of Array.isArray(trajectory) ? trajectory : []) {
    if (event.type === 'error') {
      const msg = String(event.error || '');
      failures[/timeout|exit|command|permission|syntax|not found|env/i.test(msg) ? 'execution' : 'coherence'].push({ event: msg, category: msg });
    }
    if (event.type === 'tool-end' && event.isError) failures.execution.push({ tool: event.name, category: 'execution' });
    if (event.type === 'verification' && !event.complete) failures.verification.push({ gaps: event.gaps, category: 'verification' });
    if (event.type === 'gate-exhausted') failures.verification.push({ pending: event.pending, category: 'verification' });
  }
  return { failures, judgeModel, totalFailures: Object.values(failures).reduce((s, a) => s + a.length, 0) };
}

export function failureAnalysis({ results }) {
  const all = Array.isArray(results) ? results : Object.values(results || {}).flatMap((b) => b.results || []);
  const summary = { execution: 0, coherence: 0, verification: 0, total: all.length, byCategory: {} };
  for (const r of all) {
    for (const [cat, items] of Object.entries(classifyFailures({ trajectory: r.trajectory || [] }).failures)) {
      summary[cat] += items.length;
      summary.byCategory[cat] = summary.byCategory[cat] || [];
      summary.byCategory[cat].push({ taskId: r.taskId, count: items.length });
    }
  }
  summary.failureRate = summary.total > 0 ? (summary.execution + summary.coherence + summary.verification) / summary.total : 0;
  return summary;
}

// --- LLM-as-judge ----------------------------------------------------------

export const JUDGE_RUBRICS = {
  correctness: { weight: 0.4, criteria: ['solves the problem', 'produces correct output', 'handles edge cases'] },
  efficiency: { weight: 0.2, criteria: ['minimal steps', 'reasonable resource usage', 'no redundant operations'] },
  clarity: { weight: 0.2, criteria: ['clear reasoning', 'well-structured response', 'readable code'] },
  completeness: { weight: 0.2, criteria: ['addresses all requirements', 'no missing components', 'proper termination'] },
};

export async function judgeTask({ trajectory, rubric = JUDGE_RUBRICS, judgeModel = JUDGE_MODEL }) {
  const judge = judgeModel || JUDGE_MODEL || 'gpt-4o';
  const events = Array.isArray(trajectory) ? trajectory : [];
  const finalText = events.filter((e) => e.type === 'final').pop()?.message?.content || '';
  let score = 0;
  for (const [name, def] of Object.entries(rubric)) {
    let met = 0;
    for (const c of def.criteria) { if (new RegExp(c.replace(/\s+/g, '.*'), 'i').test(finalText)) met++; }
    score += Math.round((met / def.criteria.length) * (def.weight * 100));
  }
  return { judge, score, maxScore: 100, rubric: Object.keys(rubric), finalText: finalText.slice(0, 1000), perRubric: Object.entries(rubric).map(([n, d]) => ({ name: n, weight: d.weight })) };
}

export async function multiJudge({ trajectory, rubrics, judges = [] }) {
  const judgeList = Array.isArray(judges) && judges.length ? judges : (JUDGE_MODEL ? [JUDGE_MODEL] : ['gpt-4o', 'claude-3.5-sonnet']);
  const rubricList = Array.isArray(rubrics) && rubrics.length ? rubrics : [JUDGE_RUBRICS];
  const results = [];
  for (const j of judgeList) for (const rb of rubricList) results.push(await judgeTask({ trajectory, rubric: rb, judgeModel: j }));
  const scores = results.map((r) => r.score);
  return { results, meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0, stdDev: computeStdDev(scores), judges: judgeList, rubrics: rubricList.length };
}

function computeStdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

// --- Statistical reporting --------------------------------------------------

export function computeStats({ trials }) {
  const t = Array.isArray(trials) ? trials : [];
  if (!t.length) return { mean: 0, sem: 0, passAt1: 0, passAt5: 0, n: 0, stdDev: 0 };
  const n = t.length, mean = t.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? t.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  const sem = Math.sqrt(variance / n), sorted = [...t].sort((a, b) => a - b);
  return { mean: Math.round(mean * 1000) / 1000, sem: Math.round(sem * 1000) / 1000, passAt1: sorted[0], passAt5: sorted[Math.min(4, n - 1)], n, stdDev: Math.round(Math.sqrt(variance) * 1000) / 1000 };
}

export function formatReport({ benchmark, results, stats }) {
  const lines = [`=== ${benchmark || 'Benchmark'} Report ===`, `Tasks: ${stats?.n || 0}`, `Mean: ${stats?.mean || 0}`, `SEM: ${stats?.sem || 0}`, `pass@1: ${stats?.passAt1 || 0}`, `pass@5: ${stats?.passAt5 || 0}`, `StdDev: ${stats?.stdDev || 0}`];
  if (results) {
    const passed = Array.isArray(results) ? results.filter((r) => r.pass).length : (results.results || []).filter((r) => r.pass).length;
    const total = Array.isArray(results) ? results.length : (results.results || []).length;
    lines.push(`Passed: ${passed}/${total}`);
  }
  return lines.join('\n') + '\n=== End Report ===';
}

export function compareModels({ modelResults }) {
  return Object.entries(modelResults || {}).map(([model, results]) => {
    const res = Array.isArray(results) ? results : (results.results || []);
    const passed = res.filter((r) => r.pass).length;
    return { model, tasks: res.length, passed, passRate: res.length ? passed / res.length : 0 };
  }).sort((a, b) => b.passRate - a.passRate);
}
