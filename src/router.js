import { estimateTokens } from './context.js';

export const ROUTER_CONFIG = { capability: 0.30, cost: 0.20, latency: 0.15, privacy: 0.15, health: 0.10, context: 0.05, preference: 0.05 };
export const CANDIDATE_SOURCES = [
  { id: 'primary', name: 'Preferred Models', type: 'primary', weight: 1.0 },
  { id: 'retrieval', name: 'Capability-Matched', type: 'retrieval', weight: 0.85 },
  { id: 'community', name: 'Community/Trending', type: 'community', weight: 0.6 },
  { id: 'local', name: 'Local/Private', type: 'local', weight: 0.9 },
];
export const VISIBILITY = { ALLOW: 'allow', INTERSTITIAL: 'interstitial', DROP: 'drop' };

const envNum = (key, fallback) => {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const TOP_K = envNum('OX_ROUTER_TOP_K', 5);
const FEATURE_KEYS = ['capabilityMatch', 'costEfficiency', 'latency', 'privacy', 'health', 'contextFit', 'preferenceBoost'];
const FEATURE_WEIGHTS = {
  capabilityMatch: parseFloat(process.env.OX_ROUTER_WEIGHT_CAPABILITY ?? `${ROUTER_CONFIG.capability}`),
  costEfficiency: parseFloat(process.env.OX_ROUTER_WEIGHT_COST ?? `${ROUTER_CONFIG.cost}`),
  latency: parseFloat(process.env.OX_ROUTER_WEIGHT_LATENCY ?? `${ROUTER_CONFIG.latency}`),
  privacy: parseFloat(process.env.OX_ROUTER_WEIGHT_PRIVACY ?? `${ROUTER_CONFIG.privacy}`),
  health: parseFloat(process.env.OX_ROUTER_WEIGHT_HEALTH ?? `${ROUTER_CONFIG.health}`),
  contextFit: parseFloat(process.env.OX_ROUTER_WEIGHT_CONTEXT ?? `${ROUTER_CONFIG.context}`),
  preferenceBoost: parseFloat(process.env.OX_ROUTER_WEIGHT_PREFERENCE ?? `${ROUTER_CONFIG.preference}`),
};

function scoreCandidate(candidate, task, context) {
  const cap = Math.min(1, ((candidate.capabilities ?? 0.5) * (task?.skillRequirement ?? 0.5)) / Math.max(0.01, candidate.complexity ?? 0.5));
  const cost = Math.min(1, (task?.budgetTokens ?? 8000) / Math.max(1, (candidate.costPerToken ?? 0.01) * estimateTokens(task?.prompt ?? '')));
  const lat = Math.min(1, Math.max(0, 1 - ((candidate.avgLatencyMs ?? 1000) / Math.max(1, task?.maxLatencyMs ?? 5000))));
  const priv = candidate.privacyLevel ?? 0.5;
  const health = candidate.healthy ?? candidate.availability ?? 0.8;
  const ctxFit = Math.min(1, (context?.contextWindow ?? 8000) / Math.max(1, (candidate.contextWindow ?? 8000)));
  const pref = Math.min(1, (candidate.preferenceScore ?? task?.preferredModel === candidate.id ? 1 : 0.3));
  const features = { capabilityMatch: cap, costEfficiency: cost, latency: lat, privacy: priv, health: health, contextFit: ctxFit, preferenceBoost: pref };
  const total = FEATURE_KEYS.reduce((s, k) => s + FEATURE_WEIGHTS[k] * features[k], 0);
  return { total: Math.min(1, total), features };
}

function preScoreFilters(candidates, task, context) {
  const seen = new Set();
  const tried = new Set(context?.triedModels ?? []);
  const blocked = new Set(context?.blockedProviders ?? []);
  const kept = [];
  const dropped = [];
  const reasons = [];
  for (const c of candidates) {
    const key = `${c.id}:${c.source ?? 'unknown'}`;
    if (seen.has(key)) { dropped.push(c); reasons.push(`${c.id}: duplicate`); continue; }
    seen.add(key);
    if (tried.has(c.id)) { dropped.push(c); reasons.push(`${c.id}: already tried`); continue; }
    if (blocked.has(c.provider ?? c.id)) { dropped.push(c); reasons.push(`${c.id}: blocked provider`); continue; }
    if (task?.privacyLevel && (c.privacyLevel ?? 0) < task.privacyLevel) { dropped.push(c); reasons.push(`${c.id}: privacy violation`); continue; }
    if (c.maxCost !== undefined && task?.budgetTokens && c.maxCost > task.budgetTokens) { dropped.push(c); reasons.push(`${c.id}: budget exhausted`); continue; }
    if (task?.modality && !c.modalities?.includes(task.modality)) { dropped.push(c); reasons.push(`${c.id}: modality mismatch`); continue; }
    kept.push(c);
  }
  return { kept, dropped, reasons };
}

function postScoreFilters(candidates, task, context) {
  const costCap = task?.maxCostPerResponse ?? Infinity;
  return candidates.filter((c) => {
    const v = visibilityVerdict({ model: c, task, context });
    if (v === VISIBILITY.DROP) return false;
    if (costCap < Infinity && (c.costPerResponse ?? c.cost ?? 0) > costCap) return false;
    if (task?.safetyLevel && (c.safetyRating ?? 1) < task.safetyLevel) return false;
    return true;
  });
}

function rankCandidates({ candidates, task, context, topK = TOP_K }) {
  const { kept, dropped, reasons } = preScoreFilters(candidates, task, context);
  const scored = kept.map((c) => {
    const { total, features } = scoreCandidate(c, task, context);
    return { ...c, score: total, features, source: c.source ?? 'primary' };
  });
  const filtered = postScoreFilters(scored, task, context);
  filtered.sort((a, b) => b.score - a.score);
  const top = filtered.slice(0, topK);
  return { ranked: top, dropped, reasons, topK: top.length };
}

function blendResults({ ranked, task }) {
  const bySource = new Map();
  for (const r of ranked) {
    const s = r.source ?? 'primary';
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(r);
  }
  const groups = [...bySource.values()];
  const blended = [];
  const maxLen = Math.max(...groups.map((g) => g.length), 1);
  for (let i = 0; i < maxLen; i++) {
    for (const g of groups) {
      if (i < g.length) blended.push(g[i]);
    }
  }
  return { interleaved: blended, sources: [...bySource.keys()], strategy: 'round-robin' };
}

function recordSideEffects({ selection, task }) {
  const entry = {
    timestamp: new Date().toISOString(),
    selectedModel: selection?.id ?? null,
    score: selection?.score ?? null,
    source: selection?.source ?? null,
    taskId: task?.id ?? null,
    tokens: estimateTokens(task?.prompt ?? ''),
  };
  if (process.env.OX_ROUTER_LOG) console.error(`[router] ${JSON.stringify(entry)}`);
  return entry;
}

function visibilityVerdict({ model, task, context }) {
  const isHighPrivacy = (task?.privacyLevel ?? 0) >= 0.8;
  const isLocal = (model.type ?? model.source ?? '') === 'local';
  const hasInterstitial = context?.showInterstitials ?? false;
  if (isHighPrivacy && !isLocal && !model.allowCrossBoundary) return VISIBILITY.DROP;
  if (hasInterstitial && (model.score ?? 0) < 0.4) return VISIBILITY.INTERSTITIAL;
  if (model.healthy === false || model.blocked === true) return VISIBILITY.DROP;
  return VISIBILITY.ALLOW;
}

function route({ task, context, models }) {
  const candidates = models ?? context?.models ?? [];
  const { ranked } = rankCandidates({ candidates, task, context });
  const blended = blendResults({ ranked, task });
  const selection = blended.interleaved[0] ?? null;
  if (selection) recordSideEffects({ selection, task });
  return { selection, ranked: blended.interleaved, sources: blended.sources, topK: ranked.length };
}

class Router {
  constructor(initialWeights = {}) {
    this.weights = { ...FEATURE_WEIGHTS, ...initialWeights };
    this.stats = { requests: 0, cacheHits: 0, drops: 0, avgLatencyMs: 0 };
    this._history = [];
  }
  route(task, context) {
    const t0 = Date.now();
    const result = route({ task, context, models: context?.models ?? [] });
    this.stats.requests++;
    this.stats.avgLatencyMs = (this.stats.avgLatencyMs * (this.stats.requests - 1) + (Date.now() - t0)) / this.stats.requests;
    if (result.selection) this._history.push(result.selection.id);
    return result;
  }
  updateWeights(weights) {
    this.weights = { ...this.weights, ...weights };
    return this.weights;
  }
  getStats() {
    return { ...this.stats, totalHistory: this._history.length, recentSelections: this._history.slice(-10) };
  }
  reset() {
    this.weights = { ...FEATURE_WEIGHTS };
    this.stats = { requests: 0, cacheHits: 0, drops: 0, avgLatencyMs: 0 };
    this._history = [];
  }
}

export { Router, scoreCandidate, preScoreFilters, postScoreFilters, rankCandidates, blendResults, recordSideEffects, visibilityVerdict, route };
export default Router;
