// benchmark.js — comprehensive agent benchmarking framework for ox.
// Implements state-of-the-art evaluation methodologies: AgentBench-style
// multi-dimensional eval, MM-tau-p2 / MULTIVOX / OmniGAIA / MMTB multimodal
// metrics, UTBoost-style test augmentation, SWE-rebench decontamination,
// standardized ReAct scaffolding, Terminal-Bench-style failure taxonomy,
// LLM-as-judge, and statistical reporting. Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { runAgent, runAgentCollect } from '../agent.js';
import { estimateTokens } from '../context.js';
import { startRecording, saveRecording, TaskRecorder } from '../task-record.js';

const BENCH_DIR = process.env.OX_BENCHMARK_DIR || path.join(process.cwd(), '.agent', 'benchmarks');
const JUDGE_MODEL = process.env.OX_JUDGE_MODEL || null;
const MAX_PARALLEL = Number(process.env.OX_BENCHMARK_MAX_PARALLEL || 2);

// ---------------------------------------------------------------------------
// 1. Multi-dimensional agent evaluation (AgentBench-style)
// ---------------------------------------------------------------------------

export const AGENT_BENCHMARKS = [
  {
    id: 'swe-coding',
    name: 'SWE-Coding',
    category: 'coding',
    description: 'SWE-bench-style: resolve GitHub issues from a repo snapshot with a gold test patch.',
    taskCount: 0,
    environment: 'repo',
    evalFn: async (task, agentConfig) => evaluateSWETask(task, agentConfig),
  },
  {
    id: 'terminal-bench',
    name: 'Terminal-Bench',
    category: 'terminal',
    description: 'Terminal-Bench-style: command-line tasks in a sandboxed shell environment.',
    taskCount: 0,
    environment: 'shell',
    evalFn: async (task, agentConfig) => evaluateTerminalTask(task, agentConfig),
  },
  {
    id: 'voice-mm',
    name: 'Voice-Multimodal',
    category: 'multimodal',
    description: 'Voice/video/audio task completion measured by MM-tau-p2 style goal metrics.',
    taskCount: 0,
    environment: 'voice',
    evalFn: async (task, agentConfig) => evaluateMultimodal({ agent: agentConfig, tasks: [task], modality: 'voice' }),
  },
  {
    id: 'tool-use',
    name: 'Tool-Use',
    category: 'tool-use',
    description: 'Tool-use proficiency: correct tool selection, argument validity, chaining.',
    taskCount: 0,
    environment: 'tools',
    evalFn: async (task, agentConfig) => evaluateToolUseTask(task, agentConfig),
  },
  {
    id: 'web-agents',
    name: 'Web-Agents',
    category: 'web-agents',
    description: 'Web navigation / form-filling / information extraction tasks.',
    taskCount: 0,
    environment: 'browser',
    evalFn: async (task, agentConfig) => evaluateWebTask(task, agentConfig),
  },
  {
    id: 'database',
    name: 'Database',
    category: 'database',
    description: 'Schema design, query optimization, and migration tasks.',
    taskCount: 0,
    environment: 'db',
    evalFn: async (task, agentConfig) => evaluateDatabaseTask(task, agentConfig),
  },
  {
    id: 'os-interaction',
    name: 'OS-Interaction',
    category: 'os-interaction',
    description: 'Multi-step OS-level workflows: file systems, processes, config.',
    taskCount: 0,
    environment: 'os',
    evalFn: async (task, agentConfig) => evaluateOSTask(task, agentConfig),
  },
];

const BENCHMARK_BY_ID = new Map(AGENT_BENCHMARKS.map((b) => [b.id, b]));

export function listBenchmarks() {
  return AGENT_BENCHMARKS.map((b) => ({ id: b.id, name: b.name, category: b.category, description: b.description }));
}

export async function runBenchmark(benchmarkId, agentConfig, options = {}) {
  const bench = BENCHMARK_BY_ID.get(benchmarkId);
  if (!bench) throw new Error(`Unknown benchmark: ${benchmarkId}`);
  const tasks = await loadTasks(benchmarkId, options.tasks);
  const results = [];
  for (const task of tasks) {
    const result = await runWithTimeout(bench.evalFn(task, agentConfig), options.timeoutMs || 120_000, `benchmark:${benchmarkId}:${task.id}`);
    results.push({ task: task.id, ...result });
  }
  return { benchmarkId, name: bench.name, category: bench.category, results, stats: computeStats({ trials: results.map((r) => r.pass ? 1 : 0) }) };
}

export async function evaluateAgent(agentConfig, benchmarkIds = AGENT_BENCHMARKS.map((b) => b.id), options = {}) {
  const out = {};
  for (const id of benchmarkIds) {
    try {
      out[id] = await runBenchmark(id, agentConfig, options);
    } catch (err) {
      out[id] = { benchmarkId: id, error: String(err), results: [] };
    }
  }
  return { agent: agentConfig, benchmarks: out, overall: computeStats({ trials: Object.values(out).flatMap((b) => (b.results || []).map((r) => (r.pass ? 1 : 0))) }) };
}
