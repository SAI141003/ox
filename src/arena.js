import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const ARENA_SCHEMA_VERSION = '1.0.0';

export const ArenaConfig = {
  agentCount: 3,
  timeout: 300000,
  worktreeBase: '/tmp/ox-arena',
  autoPick: true,
  criteria: ['correctness', 'speed', 'cost', 'quality'],
};

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return { runs: {} };
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { runs: {} }; }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function calcScore(result, config) {
  const c = config || ArenaConfig;
  const weights = { correctness: 0.4, speed: 0.2, cost: 0.2, quality: 0.2 };
  let score = 0;
  for (const k of c.criteria) {
    const val = result[k] ?? 0;
    score += (val * (weights[k] || 0.1));
  }
  return score;
}

export function createArena(cwd) {
  const dataFile = path.join(cwd, 'arena.json');
  function load() { return readJSON(dataFile); }

  return {
    run(task, agents, config = {}) {
      const id = randomUUID();
      const cfg = { ...ArenaConfig, ...config };
      const results = [];
      for (const agent of agents.slice(0, cfg.agentCount)) {
        results.push({ agent, output: '', diff: null, tests: null, cost: 0, duration: 0, status: 'pending' });
      }
      const run = { id, task, agents, config: cfg, results, winner: null, runnersUp: [], cancelled: false, startedAt: Date.now() };
      const data = load();
      data.runs[id] = run;
      writeJSON(dataFile, data);
      return run;
    },
    getResults(runId) {
      const data = readJSON(dataFile);
      return data.runs[runId]?.results || [];
    },
    pickWinner(results) {
      const scored = results.map(r => ({ ...r, score: calcScore(r, r._config || ArenaConfig) }));
      scored.sort((a, b) => b.score - a.score);
      return { winner: scored[0] || null, runnersUp: scored.slice(1, 3), scored };
    },
    cancel(runId) {
      const data = readJSON(dataFile);
      const run = data.runs[runId];
      if (!run) return false;
      run.cancelled = true;
      writeJSON(dataFile, data);
      return run;
    },
    listRuns() { return Object.values(readJSON(dataFile).runs); },
  };
}
