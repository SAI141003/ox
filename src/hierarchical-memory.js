import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './context.js';
// The archive primitive lives in memory.js because an archive is still a
// persistence surface and must run the same credential/injection screen as any
// other write. No import cycle: memory.js pulls in node builtins plus audit.js
// and memory-loss.js, and never reaches this file.
import { persistArchived, lossNotice, lossLedgerPath } from './memory.js';

export const HIERARCHICAL_MEMORY_FILE = '.agent/hierarchical-memory.json';

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultChunk() {
  return {
    id: generateId(),
    goal: '',
    status: 'active',
    observations: [],
    summary: '',
    createdAt: nowIso(),
    completedAt: null,
  };
}

export function createSubgoal({ task, parentGoal }) {
  const chunk = defaultChunk();
  chunk.goal = String(task ?? '').trim();
  chunk.summary = parentGoal ? `Subgoal of: ${parentGoal}` : 'Root goal';
  return chunk;
}

export function completeSubgoal({ subgoal, observation }) {
  if (!subgoal) return null;
  const completed = { ...subgoal };
  completed.status = 'completed';
  completed.completedAt = nowIso();
  if (observation) {
    completed.observations.push({
      text: String(observation).trim(),
      timestamp: nowIso(),
    });
    completed.summary = String(observation).trim().slice(0, 500);
  }
  return completed;
}

export function getActiveSubgoals(memory) {
  if (!memory || !Array.isArray(memory.chunks)) return [];
  return memory.chunks.filter((c) => c.status === 'active');
}

export function getWorkingMemory(memory) {
  if (!memory || !Array.isArray(memory.chunks)) return { active: [], recentObservations: [] };
  const active = memory.chunks.filter((c) => c.status === 'active');
  const completed = memory.chunks
    .filter((c) => c.status === 'completed')
    .slice(-5);
  const recentObservations = completed.flatMap((c) =>
    c.observations.map((o) => ({ subgoalId: c.id, subgoalGoal: c.goal, ...o }))
  );
  return { active, recentObservations };
}

export function replaceSubgoal({ oldSubgoal, newSubgoal }) {
  if (!oldSubgoal || !newSubgoal) return oldSubgoal;
  return {
    ...oldSubgoal,
    status: 'completed',
    completedAt: nowIso(),
    summary: newSubgoal.summary || oldSubgoal.summary,
    observations: [
      ...oldSubgoal.observations,
      ...(newSubgoal.observations || []),
    ],
  };
}

export function retrieveTrajectory({ subgoalId, memory }) {
  if (!memory || !Array.isArray(memory.chunks)) return null;
  return memory.chunks.find((c) => c.id === subgoalId) ?? null;
}

export class HierarchicalMemory {
  constructor(cwd = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.filePath = path.join(this.cwd, HIERARCHICAL_MEMORY_FILE);
    this.chunks = [];
    this.maxChunks = 50;
  }

  load() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed && Array.isArray(parsed.chunks)) {
        this.chunks = parsed.chunks;
      }
    } catch {}
    return this;
  }

  save() {
    try {
      // trim() archives whatever falls off the cap, so the on-disk write below
      // can no longer be the place a chunk disappears.
      this.trim();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data = { chunks: this.chunks, updatedAt: nowIso() };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch {}
    return this;
  }

  // The cap is a working-set budget, not a retention decision. It used to be a
  // bare `slice(-this.maxChunks)` in two places: past 50 chunks the oldest ones
  // were dropped from memory and from disk with no copy, no warning and no
  // counter, and a subgoal plus its observations was unrecoverable. Now the
  // falling-off chunks are archived to .agent/archive/hierarchical-memory/ and
  // recorded in the loss ledger before they are dropped.
  trim() {
    if (this.chunks.length <= this.maxChunks) return [];
    const dropped = this.chunks.slice(0, this.chunks.length - this.maxChunks);
    this.chunks = this.chunks.slice(-this.maxChunks);
    this.archiveDropped(dropped);
    return dropped;
  }

  archiveDropped(dropped) {
    if (!dropped || !dropped.length) return null;
    const body = `${dropped.map((c) => JSON.stringify(c)).join('\n')}\n`;
    const res = persistArchived(body, {
      destDir: path.join(this.cwd, '.agent', 'archive', 'hierarchical-memory'),
      name: `${new Date().toISOString().replace(/[:.]/g, '-')}-chunks.jsonl`,
      label: 'archived working-memory chunk',
      screenStore: HIERARCHICAL_MEMORY_FILE,
      store: 'hierarchical-memory',
      event: 'chunk-trimmed',
      reason: `over-${this.maxChunks}-chunks`,
      artifact: this.filePath,
      detail: `dropped=${dropped.length}`,
    });
    // A refusal (most plausibly credential shape in a goal or an observation)
    // means the archive was not written, so the loss is only visible in the
    // ledger. Keeping the chunks would break the cap, and the cap exists to keep
    // the working set small, so the notice says plainly that they are only in
    // the ledger -- they are not recoverable.
    lossNotice(
      res.archived
        ? `archived ${dropped.length} working-memory chunk(s) past the ${this.maxChunks}-chunk cap -> ${res.path} ` +
            `(nothing destroyed). Ledger: ${lossLedgerPath()}`
        : `DROPPED ${dropped.length} working-memory chunk(s) past the ${this.maxChunks}-chunk cap and could not ` +
            `archive them (${res.reason}); they are NOT recoverable. Ledger: ${lossLedgerPath()}`
    );
    return res;
  }

  clear() {
    this.chunks = [];
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {}
    return this;
  }

  addSubgoal(goal, parentGoal) {
    const subgoal = createSubgoal({ task: goal, parentGoal });
    this.chunks.push(subgoal);
    this.trim();
    this.save();
    return subgoal;
  }

  completeSubgoal(id, observation) {
    const idx = this.chunks.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const completed = completeSubgoal({ subgoal: this.chunks[idx], observation });
    this.chunks[idx] = completed;
    this.save();
    return completed;
  }

  getWorkingContext() {
    const { active, recentObservations } = getWorkingMemory({ chunks: this.chunks });
    const contextParts = [];
    for (const a of active) {
      contextParts.push(`[ACTIVE] ${a.goal}`);
      if (a.summary) contextParts.push(`  Summary: ${a.summary}`);
    }
    for (const o of recentObservations) {
      contextParts.push(`[OBS] ${o.subgoalGoal}: ${o.text}`);
    }
    const text = contextParts.join('\n');
    return {
      text,
      tokenCount: estimateTokens(text),
      activeCount: active.length,
      observationCount: recentObservations.length,
    };
  }

  retrieve(id) {
    return this.chunks.find((c) => c.id === id) ?? null;
  }

  getAllChunks() {
    return [...this.chunks];
  }
}

export function createHierarchicalMemory(cwd) {
  return new HierarchicalMemory(cwd).load();
}
