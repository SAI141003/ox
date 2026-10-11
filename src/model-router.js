// Model Router: intelligent model routing that balances quality, cost, latency,
// and local-vs-cloud across the registered model catalog.
//
// Integrates model-registry.js (picking) and router.js (ranking alternatives).
// Local-vs-cloud is decided from the catalog record itself -- isLocalModel()
// reads provider/baseUrl/type off each entry -- so there is no separate
// local-inference dependency to load lazily, and no probe that can fail.

import { pickModel, listCandidates, isReachable, makeTask, pickForRole, MODEL_CATALOG } from './model-registry.js';
import { rankCandidates, Router, ROUTER_CONFIG } from './router.js';

export const MODEL_ROUTER_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function isAsyncFunction(fn) {
  return !!fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
}

function estimateCost(model, tokens = 4000) {
  const pricing = model?.pricing;
  if (!pricing) return 0;
  const inP = Number(pricing.in) || 0;
  const outP = Number(pricing.out) || 0;
  return ((inP + outP) * 0.5 * tokens) / 1000;
}

function estimateLatency(model) {
  if (!model) return 2000;
  if (model.provider === 'ollama' || model.baseUrl) return 800;
  if (model.tier === 'fast') return 600;
  if (model.tier === 'flagship') return 1500;
  return 1200;
}

function isLocalModel(model) {
  if (!model) return false;
  return model.provider === 'ollama' || !!model.baseUrl || model.type === 'local';
}

function modelToCandidate(model, index = 0) {
  return {
    id: model?.model || model?.id || `model-${index}`,
    source: isLocalModel(model) ? 'local' : 'primary',
    type: isLocalModel(model) ? 'local' : 'cloud',
    capabilities: model?.capabilities ?? 0.7,
    complexity: model?.complexity ?? 0.5,
    costPerToken: model?.pricing?.in ?? 0.002,
    avgLatencyMs: estimateLatency(model),
    privacyLevel: isLocalModel(model) ? 1.0 : 0.3,
    health: model?.healthy ?? 0.9,
    contextWindow: model?.contextWindow ?? model?.window ?? 128000,
    preferenceScore: 0.5,
    provider: model?.provider,
    model: model?.model,
    tier: model?.tier,
    pricing: model?.pricing,
  };
}

function buildCandidates(models, task, context) {
  const list = [];
  for (const m of models || []) {
    list.push(modelToCandidate(m));
  }
  return list;
}

function buildReasoning(primary, alternatives, task, localFirst) {
  const parts = [];
  if (primary) {
    parts.push(`Selected ${primary.model || primary.id} (${primary.provider || 'unknown'})`);
  }
  if (localFirst) {
    parts.push('local-first preference applied');
  }
  if (task?.complexity != null) {
    parts.push(`complexity=${Number(task.complexity).toFixed(2)}`);
  }
  if (alternatives && alternatives.length) {
    parts.push(`${alternatives.length} alternatives ranked`);
  }
  return parts.join('; ');
}

function computeConfidence(primary, alternatives, task) {
  if (!primary) return 0;
  let c = 0.5;
  if (primary.score != null) c += clamp01(primary.score) * 0.3;
  if (alternatives && alternatives.length) {
    const gap = (primary.score ?? 1) - (alternatives[0].score ?? 0);
    c += clamp01(gap) * 0.2;
  }
  if (isLocalModel(primary)) c += 0.1;
  return Math.min(1, c);
}
function asTask(task) {
  if (typeof task === 'string') return makeTask({ kind: task });
  return makeTask(task || {});
}

function normalizeModel(model) {
  if (typeof model === 'string') {
    return { id: model, model, name: model, provider: 'registry' };
  }
  const id = model?.id || model?.model || model?.name;
  if (!id) return null;
  return { ...model, id, model: model.model || id, name: model.name || id };
}

function candidateToModel(models, candidate) {
  const registered = models.get(candidate.id);
  if (registered) return registered;
  return { ...candidate, id: candidate.id, model: candidate.model || candidate.id };
}

function routerTask(task, context) {
  return {
    ...task,
    prompt: task.prompt ?? task.text ?? task.kind ?? '',
    skillRequirement: task.skillRequirement ?? task.complexity ?? 0.5,
    budgetTokens: task.budgetTokens ?? task.budget ?? 8000,
    maxLatencyMs: task.maxLatencyMs ?? task.latencyHint ?? 5000,
    preferredModel: task.preferredModel ?? context?.preferredModel,
    privacyLevel: task.privacyLevel ?? context?.privacyLevel,
    triedModels: context?.triedModels,
    blockedProviders: context?.blockedProviders,
    contextWindow: context?.contextWindow,
    showInterstitials: context?.showInterstitials,
  };
}

function createModelRouter(config = {}) {
  const models = new Map();
  const scores = new Map();
  const stats = { timesRouted: 0, costSaved: 0, modelUsage: {} };
  const sourceConfig = config.config || config;

  function registerModel(model) {
    const normalized = normalizeModel(model);
    if (!normalized) throw new TypeError('registerModel(model) requires a model id');
    models.set(normalized.id, normalized);
    return normalized;
  }

  for (const [id, capabilities] of Object.entries(MODEL_CATALOG)) {
    registerModel({
      id,
      model: id,
      name: id,
      provider: 'registry',
      tier: capabilities.tier,
      capabilities: capabilities.tier === 'flagship' ? 0.95 : 0.65,
      complexity: capabilities.maxComplexity,
      strengths: capabilities.strengths,
      vision: capabilities.vision,
      contextWindow: 128000,
    });
  }
  for (const model of config.models || []) registerModel(model);

  function route(inputTask, context = {}) {
    const task = asTask(inputTask);
    // Memory→routing bridge (opt-in only). When a caller passes both
    // preferredBotFromMemory === true and a memoryStore with .search(), a
    // persisted preference record is consulted before the config default.
    // This is explicit composition, never silent auto-wiring.
    let preferredBot = context.preferredBot || sourceConfig.preferredBot;
    if (context.preferredBotFromMemory === true && context.memoryStore) {
      for (const entry of context.memoryStore.search('preferredBot') ?? []) {
        try {
          const parsed = JSON.parse(entry.content);
          if (parsed && typeof parsed.preferredBot === 'string') {
            preferredBot = preferredBot || parsed.preferredBot;
            break;
          }
        } catch { /* skip malformed preference records */ }
      }
    }
    const primary = pickModel({
      config: sourceConfig,
      task,
      env: context.env || sourceConfig.env || process.env,
      preferredBot,
    });
    const ranked = rankCandidates({
      candidates: [...models.values()].map(modelToCandidate),
      task: routerTask(task, context),
      context: context.router || context,
    });
    const primaryId = primary?.model || primary?.id;
    const alternatives = ranked.ranked
      .filter((candidate) => candidate.id !== primaryId)
      .map((candidate) => candidateToModel(models, candidate));
    const selected = primary || alternatives[0] || null;
    const localFirst = Boolean(context.localFirst ?? sourceConfig.localFirst ?? process.env.OX_LOCAL_FIRST === '1');
    const estimatedCost = estimateCost(selected);
    const estimatedLatency = estimateLatency(selected);
    const confidence = computeConfidence(selected, alternatives, task);
    const reason = buildReasoning(selected, alternatives, task, localFirst);
    const modelKey = selected?.model || selected?.id || 'unavailable';

    stats.timesRouted += 1;
    stats.modelUsage[modelKey] = (stats.modelUsage[modelKey] || 0) + 1;
    if (context.previousCost != null && estimatedCost < context.previousCost) {
      stats.costSaved += context.previousCost - estimatedCost;
    }

    return { model: selected, reason, alternatives, estimatedCost, estimatedLatency, confidence, localFirst };
  }

  function getRecommendation(task, context = {}) {
    const decision = route(task, context);
    return { ...decision, recommendation: decision.model, reasoning: decision.reason };
  }

  function updateScores(modelId, benchmark, score) {
    const id = String(modelId);
    if (!scores.has(id)) scores.set(id, {});
    scores.get(id)[String(benchmark)] = Number(score) || 0;
    const model = models.get(id);
    if (model) model.benchmarks = { ...(model.benchmarks || {}), [String(benchmark)]: Number(score) || 0 };
    return scores.get(id);
  }

  function getStats() {
    return {
      ...stats,
      modelUsage: { ...stats.modelUsage },
      registeredModels: models.size,
      scores: Object.fromEntries([...scores].map(([id, values]) => [id, { ...values }])),
    };
  }

  function formatRoutingDecision(decision) {
    const model = decision?.model?.model || decision?.model?.id || decision?.model || 'unavailable';
    const reason = decision?.reason || decision?.reasoning || '';
    const alternatives = (decision?.alternatives || []).map((item) => item.model || item.id).join(', ') || 'none';
    return `model: ${model}\nreason: ${reason}\nestimated cost: ${decision?.estimatedCost ?? 0}\nestimated latency: ${decision?.estimatedLatency ?? 0}ms\nconfidence: ${((decision?.confidence ?? 0) * 100).toFixed(0)}%\nalternatives: ${alternatives}`;
  }

  function listAvailable() {
    return [...models.values()];
  }

  return {
    route,
    registerModel,
    updateScores,
    getRecommendation,
    getStats,
    formatRoutingDecision,
    listAvailable,
  };
}

function formatModelRecommendation(rec) {
  if (!rec) return 'No model recommendation available.';
  const model = rec?.model?.model || rec?.model?.id || rec?.model || rec?.id || 'unavailable';
  const reason = rec?.reason || rec?.reasoning || rec?.desc || '';
  const confidence = rec?.confidence == null ? '' : ` · confidence ${Math.round(rec.confidence * 100)}%`;
  return `Recommended model: ${model}${reason ? ` — ${reason}` : ''}${confidence}`;
}

function routeTask(task, config = {}, env = process.env) {
  const router = createModelRouter(config);
  return router.route(asTask(task), { env });
}

export { createModelRouter, routeTask, formatModelRecommendation };
