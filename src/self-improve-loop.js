import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const SELF_IMPROVE_SCHEMA_VERSION = '1.0.0';
const HISTORY_FILE = 'improve-history.json';

export class SelfImproveCycle {
  constructor(brain, graph, opts = {}) {
    this.brain = brain;
    this.graph = graph;
    this.gaps = [];
    this.researchResults = [];
    this.proposals = [];
    this.results = [];
    this.learnings = [];
    this.verifyFn = opts.verifyFn;
    this.driftGuard = opts.driftGuard;
  }

  identifyGaps() {
    const kgData = this.graph.serialize?.() ?? this.graph;
    const { gaps } = findGapsInline(kgData);
    this.gaps = gaps;
    return gaps;
  }

  async research(gaps) {
    const results = [];
    for (const gap of (gaps ?? this.gaps).slice(0, 3)) {
      const findings = this.brain.getFindings(gap.topic) ?? [];
      const gaps2 = this.brain.getGaps(gap.topic) ?? [];
      results.push({ topic: gap.topic, gap, findings, existingGaps: gaps2 });
    }
    this.researchResults = results;
    return results;
  }

  propose(findings) {
    const proposals = [];
    for (const item of (findings ?? this.researchResults)) {
      for (const f of item.findings ?? []) {
        proposals.push({
          id: `prop:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
          type: 'finding',
          topic: item.topic,
          action: `Implement finding: ${f.text.slice(0, 100)}`,
          confidence: f.confidence ?? 0.5,
          safe: true,
        });
      }
    }
    if (proposals.length < 2) {
      proposals.push({
        id: `prop:${Date.now()}:x1`,
        type: 'config',
        action: 'Increase research depth for uncovered topics',
        safe: true,
        confidence: 0.6,
      });
    }
    this.proposals = proposals;
    return proposals;
  }

  async apply(proposals) {
    const applied = [];
    for (const p of (proposals ?? this.proposals)) {
      if (p.safe) {
        if (p.file && (p.diffText || p.patch)) {
          const proposal = { ...p, status: 'applied', appliedAt: Date.now() };
          if (this.driftGuard && typeof this.driftGuard.check === 'function') {
            const changedFiles = [p.file].filter(Boolean);
            const diffText = p.diffText || '';
            const driftResult = this.driftGuard.check(changedFiles, diffText);
            proposal.drift = { blocked: !driftResult.safe, report: driftResult };
            if (!driftResult.safe) {
              proposal.status = 'blocked-by-spec-drift';
            }
          }
          if (proposal.status === 'applied') {
            await writeFile(p.file, p.diffText || p.patch);
          }
          applied.push(proposal);
        } else {
          applied.push({ ...p, status: 'pending-implementation', appliedAt: Date.now() });
        }
      } else {
        applied.push({ ...p, status: 'skipped', reason: 'unsafe' });
      }
    }
    this.results = applied;
    return applied;
  }

  async verify(results) {
    const input = results ?? this.results;
    if (this.verifyFn && typeof this.verifyFn === 'function') {
      const verified = [];
      for (const r of input) {
        const verification = await this.verifyFn(r);
        verified.push({
          ...r,
          verified: verification.ok,
          verification: verification.ok ? 'passed' : 'failed',
          detail: verification.detail,
          verifiedAt: Date.now(),
        });
      }
      return verified;
    }
    return input.map(r => ({
      ...r,
      verified: false,
      verification: 'unverified',
      verifiedAt: Date.now(),
    }));
  }

  async record(learnings) {
    const items = (learnings ?? this.results).map(r => ({ ...r, recordedAt: Date.now() }));
    this.learnings.push(...items);
    return items;
  }
}

function findGapsInline(graph) {
  const connections = {};
  for (const edge of graph.edges ?? []) {
    connections[edge.from] = (connections[edge.from] ?? 0) + 1;
    connections[edge.to] = (connections[edge.to] ?? 0) + 1;
  }
  const gaps = [];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    const count = connections[id] ?? 0;
    if (count === 0) gaps.push({ topic: node.name ?? id, reason: 'no connections', suggestedResearch: `Explore ${node.name ?? id}` });
    else if (node.confidence < 0.3) gaps.push({ topic: node.name ?? id, reason: 'low confidence', suggestedResearch: `Validate ${node.name ?? id}` });
  }
  return { gaps };
}

export function createSelfImproveLoop(cwd, brain, opts = {}) {
  let graph = null;
  let cycle = null;
  let timer = null;
  let history = [];
  let running = false;
  const historyPath = join(cwd, HISTORY_FILE);

  async function loadHistory() {
    try {
      const raw = await readFile(historyPath, 'utf8');
      history = JSON.parse(raw);
    } catch { history = []; }
  }

  async function saveHistory() {
    await mkdir(cwd, { recursive: true });
    await writeFile(historyPath, JSON.stringify(history, null, 2));
  }

  return {
    async init() {
      await loadHistory();
      const mod = await import('./knowledge-graph.js');
      graph = mod.createKnowledgeGraph(cwd);
      await graph.init();
      cycle = new SelfImproveCycle(brain, graph, opts);
    },

    async runCycle(opts = {}) {
      if (!cycle) await this.init();
      const result = { startedAt: Date.now(), steps: [] };
      const gaps = cycle.identifyGaps();
      result.steps.push({ step: 'identifyGaps', count: gaps.length });
      const research = await cycle.research(gaps);
      result.steps.push({ step: 'research', topics: research.map(r => r.topic) });
      const proposals = cycle.propose(research);
      result.steps.push({ step: 'propose', count: proposals.length });
      const applied = await cycle.apply(proposals);
      result.steps.push({ step: 'apply', count: applied.filter(a => a.status === 'applied').length });
      const verified = await cycle.verify(applied);
      result.steps.push({ step: 'verify', count: verified.filter(v => v.verified).length });
      const recorded = await cycle.record(verified);
      result.steps.push({ step: 'record', count: recorded.length });
      history.push(result);
      await saveHistory();
      return result;
    },

    scheduleCycle(intervalMs) {
      if (timer) clearInterval(timer);
      timer = setInterval(() => { this.runCycle().catch(() => {}); }, intervalMs);
      running = true;
      return timer;
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },

    getStatus() {
      return { running, cyclesCompleted: history.length, lastCycle: history.at(-1) ?? null, schema: SELF_IMPROVE_SCHEMA_VERSION };
    },

    getHistory() { return [...history]; },
    getCycle() { return cycle; },
    getGraph() { return graph; },
  };
}
