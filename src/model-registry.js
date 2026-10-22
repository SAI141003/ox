// Model Registry: auto-routes tasks to the best available model across providers.
//
// Plays to Differentiator 1 ("Universal Model Support Done Right") from the
// playbook. Rather than treating model selection as a static default, the
// registry scores each candidate on the axes that matter for the current call
// — reasoning depth, code specialization, cost ceiling, latency tolerance —
// and returns the best fit the environment can afford.
//
// Scoring inputs:
//   1. Task signals:    { kind, complexity, requires, budget, latencyHint }
//      kind ∈ 'code' | 'reasoning' | 'summarizer' | 'reviewer' | 'planner' | 'title'
//      complexity ∈ 0..1 (1 = needs the flagship; 0 = trivially small)
//      requires ∈ { tools, vision, longContext }
//   2. Candidate model descriptors (registry entries)
//   3. Hard gates: API key present, provider enabled, maxCostUsd, modelWindow
//
// Usage:
//   const pick = pickModel({ config, kind: 'code', complexity: 0.6, requires: { tools: true } });
//   if (pick) console.log(pick.bot, pick.model);  // → 'claude' 'claude-sonnet-5'
//
// The registry is pure data; resolution never mutates config or reads network.
// Picking returns a fully-built bot descriptor (same shape as resolveBot), so
// callers can plug it into streamVia unchanged.

import { resolveBot, BOTS } from './bots.js';
import { lookupModel } from './cost.js';
import { isEndpointApproved, normalizeEndpointUrl as normalizeOllamaKey, readTrustRecords, OLLAMA_PRESET_MODEL } from './local-inference.js';

// ---------------------------------------------------------------------------
// Per-model capabilities + strengths. Pricing/window pulled from cost.js so
// tables stay in sync; strengths/weaknesses are stable per model family.
// ---------------------------------------------------------------------------

export const MODEL_CATALOG = Object.freeze({
  'grok-4.6':               { tier: 'flagship',  strengths: ['code','reasoning','longContext'],     maxComplexity: 1.0, vision: false },
  'grok-build-0.1':         { tier: 'fast',      strengths: ['code','summarizer'],                  maxComplexity: 0.6, vision: false },
  'claude-fable-5-1':       { tier: 'flagship',  strengths: ['reasoning','code','reviewer'],         maxComplexity: 1.0, vision: true },
  'claude-opus-5-5':        { tier: 'flagship',  strengths: ['reasoning','code','reviewer'],         maxComplexity: 1.0, vision: true },
  'claude-sonnet-5-5':      { tier: 'flagship',  strengths: ['code','reasoning','reviewer'],         maxComplexity: 0.95, vision: true },
  'claude-haiku-5-5':       { tier: 'fast',      strengths: ['code','summarizer','title','reviewer'],       maxComplexity: 0.55, vision: true },
  'claude-sonnet-5':        { tier: 'flagship',  strengths: ['code','reasoning','reviewer'],         maxComplexity: 0.95, vision: true },
  'claude-opus-5':          { tier: 'flagship',  strengths: ['reasoning','code','reviewer'],         maxComplexity: 1.0, vision: true },
  'claude-haiku-4-5':       { tier: 'fast',      strengths: ['code','summarizer','title','reviewer'],       maxComplexity: 0.5, vision: true },
  'gpt-5.6-sol':            { tier: 'flagship',  strengths: ['code','reasoning'],                    maxComplexity: 0.95, vision: true },
  'gpt-6-luna':             { tier: 'fast',      strengths: ['code','summarizer','title','reasoning'], maxComplexity: 0.7, vision: true },
  'gpt-6.1-sol':            { tier: 'flagship',  strengths: ['code','reasoning','reviewer'],           maxComplexity: 0.95, vision: true },
  'gpt-6-astra':            { tier: 'flagship',  strengths: ['code','reasoning','reviewer'],           maxComplexity: 1.0, vision: true },
  'gemini-3.1-pro-preview': { tier: 'flagship',  strengths: ['longContext','reasoning','code'],      maxComplexity: 0.9,  vision: true },
  'gemini-3.8-flash':       { tier: 'fast',      strengths: ['code','summarizer','title'],           maxComplexity: 0.5,  vision: true },
  'moonshotai/kimi-k2-instruct-0905': { tier: 'fast', strengths: ['code','title'],                maxComplexity: 0.5,  vision: false },
  'deepseek-v4-pro':        { tier: 'flagship',  strengths: ['code','reasoning'],                    maxComplexity: 0.85, vision: false },
});

// Cheap-only auto-routes: the registry never suggests a flagship for these.
const CHEAP_ONLY = new Set(['title', 'summarizer']);

// ---------------------------------------------------------------------------
// Model selection strategy
// ---------------------------------------------------------------------------

export const STRATEGIES = Object.freeze({
  // Always use the configured default bot. No auto-routing.
  pinned: 'pinned',
  // Cost-optimized: prefer fast/cheap models unless complexity is very high.
  cost: 'cost',
  // Quality-first: prefer the best model the env can pay for.
  quality: 'quality',
  // Latency-first: prefer fast models; only escalate on very high complexity.
  fast: 'fast',
});

function normalizeStrategy(s) {
  if (!s) return STRATEGIES.cost;
  const v = String(s).toLowerCase().trim();
  if (Object.values(STRATEGIES).includes(v)) return v;
  return STRATEGIES.cost;
}

// Map a bot preset name (e.g. "claude", "haiku") to its model id for lookup.
function botNameToModel(botName) {
  if (!botName) return null;
  const preset = BOTS[botName];
  if (preset && preset.model) return preset.model;
  if (MODEL_CATALOG[botName]) return botName;
  return null;
}

// Score one model against the task profile. Higher is better.
function scoreModel(modelId, task, strategy) {
  const caps = MODEL_CATALOG[modelId];
  const price = lookupModel(modelId);
  const window = price.window || 128_000;
  const inCost = price.priced ? price.in : null;

  // Hard gates
  if (caps) {
    if (caps.maxComplexity < task.complexity) return -Infinity;
    if (task.requires?.longContext && window < 200_000) return -Infinity;
  }
  if (task.requires?.vision && !caps?.vision) return -Infinity;
  if (task.requires?.tools && !caps?.strengths.includes('code')) return -Infinity;
  if (task.kind && CHEAP_ONLY.has(task.kind) && caps?.tier === 'flagship') return -Infinity;

  // Soft scoring
  let score = 0;
  if (caps?.strengths.includes(task.kind)) score += 3.0;
  else if (caps?.strengths.includes('code') && task.kind === 'reviewer') score += 1.5;
  else if (caps?.strengths.includes('reasoning')) score += 0.5;

  // Tier alignment with strategy
  if (strategy === STRATEGIES.cost) {
    score += caps?.tier === 'fast' ? 2.0 : 0;
    score -= caps?.tier === 'flagship' ? 1.0 : 0;
  } else if (strategy === STRATEGIES.quality) {
    score += caps?.tier === 'flagship' ? 2.0 : 0;
    score -= caps?.tier === 'fast' ? 1.0 : 0;
  } else if (strategy === STRATEGIES.fast) {
    score += caps?.tier === 'fast' ? 3.0 : 0;
  }

  // Complexity fit: pick the model that just covers it (no over-provisioning).
  if (caps) {
    const headroom = caps.maxComplexity - task.complexity;
    if (headroom >= 0 && headroom < 0.3) score += 0.5;
  }

  // Cost factor
  if (inCost != null) {
    const costScore = strategy === STRATEGIES.cost ? (10 - inCost) : 0;
    score += costScore;
  }

  return score;
}

// Build a candidate list from config: every bot in BOTS + custom bots.
export function listCandidates(config = {}, env = process.env) {
  const customBots = (config && typeof config.bots === 'object') ? config.bots : {};
  const out = [];
  for (const [name, def] of Object.entries(BOTS)) {
    if (def && def.model) out.push({ bot: name, model: def.model, provider: def.provider });
  }
  for (const [name, def] of Object.entries(customBots)) {
    if (def && typeof def === 'object' && def.model) {
      out.push({ bot: name, model: def.model, provider: def.provider });
    }
  }
  if (env?.OX_MODEL && MODEL_CATALOG[env.OX_MODEL] && !out.some((c) => c.model === env.OX_MODEL)) {
    out.push({ bot: null, model: env.OX_MODEL, provider: 'custom' });
  }
  if (env?.OX_BASE_URL !== undefined) {
    const reachable = isHttpUrl(env.OX_BASE_URL);
    return out.map(c => ({ ...c, reachable, verified: false, reachability: reachable ? 'unverified' : 'invalid' }));
  }
  return out;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

// Ollama reachability, and WHY.
//
// Local inference is the one provider with no API key, so "reachable" used to be
// asserted rather than verified: the old code returned true iff the user had
// manually exported OX_OLLAMA_AVAILABLE=1, a variable nothing documented and
// nothing ever set. That is an unverified claim about a fact, in the routing
// hot path. It now resolves, in order:
//
//   1. OX_OLLAMA_AVAILABLE=1  -- manual override, kept for backward
//      compatibility. STILL undocumented in the wild; now documented here. It
//      is a promise by the user, not a check by ox, so it skips approval too.
//   2. a persisted approval   -- the user ran `ox local`, saw the endpoint, its
//      models and what approving means, and said yes. Recorded in
//      ~/.ox/config.json under `local_endpoints`.
//
// There is deliberately NO live HTTP probe here. isReachable is synchronous and
// runs inside pickModel; probing the network from it would break the module's
// stated contract ("resolution never mutates config or reads network") and would
// put an unbounded socket wait in the routing path. The live probe happens one
// layer up, in scanLocalEndpoints/probeOrigin -- `ox local`, `ox doctor` and
// install-time discovery all call it -- and its durable result IS the approval
// record this function reads. So after a scan plus approval, routing is still
// synchronous and still offline.
//
// `dir` is the config directory: config.configDir when it came from loadConfig(),
// otherwise ~/.ox. Tests point it at a temp dir.
function ollamaBaseUrl(env) {
  const override = env?.OX_OLLAMA_BASE_URL;
  if (typeof override !== 'string' || !override.trim()) return 'http://localhost:11434';
  // Same canonical origin the trust record is keyed by, and the same form
  // bots.js resolveBaseUrl sends traffic to, so "approved" and "used" cannot drift.
  return normalizeOllamaKey(override) ?? 'http://localhost:11434';
}

export function ollamaReachability({ config = {}, env = process.env } = {}) {
  if (String(env?.OX_OLLAMA_AVAILABLE ?? '') === '1') {
    return { ok: true, source: 'env-override', baseUrl: ollamaBaseUrl(env) };
  }
  const dir = config?.configDir ?? undefined;
  const baseUrl = ollamaBaseUrl(env);
  const opts = dir ? { dir } : {};
  if (isEndpointApproved(baseUrl, opts)) {
    // The record is returned so callers can compare the approved version against
    // what the port reports now and detect that something else is answering.
    const record = readTrustRecords(opts).find(r => r.baseUrl === normalizeOllamaKey(baseUrl)) ?? null;
    return { ok: true, source: 'approved', baseUrl, record };
  }
  return { ok: false, source: 'not-approved', baseUrl, record: null };
}

export function isReachable(candidate, config = {}, env = process.env) {
  if (!candidate || !candidate.provider) return false;
  if (env?.OX_BASE_URL !== undefined) return isHttpUrl(env.OX_BASE_URL);
  if (candidate.provider === 'ollama') return ollamaReachability({ config, env }).ok;
  const KEYS = { xai:'XAI_API_KEY', anthropic:'ANTHROPIC_API_KEY', openai:'OPENAI_API_KEY', gemini:'GEMINI_API_KEY', groq:'GROQ_API_KEY', openrouter:'OPENROUTER_API_KEY', deepseek:'DEEPSEEK_API_KEY' };
  const key = KEYS[candidate.provider];
  if (key && env && env[key]) return true;
  return false;
}

// The `ox-ollama` preset hardcodes a model that is not in LOCAL_MODELS and may
// not exist on the user's machine. We never silently substitute: a quiet switch
// would change which model answers every request without telling anyone. We
// report the mismatch so the caller can print the exact `--bot ox-ollama:<model>`
// form that does work. Requires an approval record, so this stays offline.
export function ollamaPresetMismatch(config = {}, env = process.env) {
  const { ok, baseUrl } = ollamaReachability({ config, env });
  if (!ok) return null;
  const dir = config?.configDir ?? undefined;
  const rec = readTrustRecords(dir ? { dir } : {}).find(r => r.baseUrl === baseUrl || r.protocol === 'ollama');
  const names = (rec?.models ?? []).map(m => m.name).filter(Boolean);
  if (!names.length || names.includes(OLLAMA_PRESET_MODEL)) return null;
  return { expected: OLLAMA_PRESET_MODEL, available: names, baseUrl };
}

export function makeTask(partial = {}) {
  return {
    kind: partial.kind || 'code',
    complexity: clamp01(partial.complexity ?? 0.5),
    requires: partial.requires || {},
    budget: partial.budget ?? null,
    latencyHint: partial.latencyHint || null,
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

export function pickModel({ config = {}, task, strategy, env = process.env, preferredBot } = {}) {
  if (env?.OX_BASE_URL !== undefined && !isHttpUrl(env.OX_BASE_URL)) return null;
  // The endpoint itself is resolved in one place, bots.js resolveBaseUrl(); env is
  // handed to resolveBot so that this layer adds only the routing-specific
  // decisions (an auto-routed target over a user endpoint is a plain
  // OpenAI-compatible `custom` call, explicitly unverified) and never re-derives
  // the base URL itself.
  const finishTarget = target => env?.OX_BASE_URL ? {
    ...target,
    provider: 'custom',
    keyEnv: 'OX_API_KEY',
    reachable: true,
    verified: false,
    reachability: 'unverified',
  } : target;
  const t = makeTask(task || {});
  const strat = normalizeStrategy(strategy || config?.routingStrategy || process.env.OX_ROUTING);

  if (strat === STRATEGIES.pinned || !strat) {
    const pinnedName = preferredBot || config?.defaultBot;
    if (pinnedName) {
      try {
        const target = resolveBot(pinnedName, config, env);
        if (!t.requires.vision || MODEL_CATALOG[target.model]?.vision) return finishTarget(target);
      } catch {}
    }
  }

  const candidates = listCandidates(config, env);
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (!isReachable(c, config, env)) continue;
    const s = scoreModel(c.model, t, strat);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  if (!best) {
    const fallbackName = preferredBot || config?.defaultBot;
    if (fallbackName) {
      try {
        const target = resolveBot(fallbackName, config, env);
        if (scoreModel(target.model, t, strat) > -Infinity) return finishTarget(target);
      } catch {}
    }
    return null;
  }

  try {
    if (best.bot && BOTS[best.bot]) return finishTarget(resolveBot(best.bot, config, env));
    if (best.bot) return finishTarget(resolveBot(`${best.bot}:${best.model}`, config, env));
  } catch { /* ignore */ }
  return finishTarget({
    bot: null,
    provider: best.provider,
    model: best.model,
    baseUrl: env?.OX_BASE_URL || null,
    keyEnv: null,
    pricing: lookupModel(best.model).priced ? { in: lookupModel(best.model).in, out: lookupModel(best.model).out } : null,
    window: lookupModel(best.model).window || 128_000,
    desc: `auto-routed (${strat}) for ${t.kind}`,
  });
}

export function pickForRole(role, { config, env = process.env, complexity } = {}) {
  const profile = ROLE_PROFILES[role] || ROLE_PROFILES.coder;
  return pickModel({
    config,
    env,
    task: { ...profile, complexity: complexity ?? profile.complexity },
    strategy: config?.routingStrategy,
    preferredBot: config?.defaultBot,
  });
}

const ROLE_PROFILES = Object.freeze({
  planner:     { kind: 'planner',    complexity: 0.7, requires: {} },
  coder:       { kind: 'code',       complexity: 0.8, requires: { tools: true } },
  reviewer:    { kind: 'reviewer',   complexity: 0.7, requires: {} },
  tester:      { kind: 'code',       complexity: 0.6, requires: { tools: true } },
  summarizer:  { kind: 'summarizer', complexity: 0.3, requires: {} },
  title:       { kind: 'title',      complexity: 0.2, requires: {} },
  researcher:  { kind: 'reasoning',  complexity: 0.7, requires: {} },
  documenter:  { kind: 'code',       complexity: 0.5, requires: { tools: true } },
});
