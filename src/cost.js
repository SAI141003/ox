import { AsyncLocalStorage } from 'node:async_hooks';

const costScope = new AsyncLocalStorage();

export function resolveMaxCostUsd({ maxCostUsd, config = {}, env = process.env } = {}) {
  const raw = maxCostUsd ?? config.maxCostUsd ?? env.OX_MAX_COST ?? null;
  if (raw == null) return null;
  const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('ox: maxCostUsd must be a finite nonnegative number');
    err.exitCode = 3;
    throw err;
  }
  return n;
}

export function currentCostBudget() {
  return costScope.getStore();
}

export function assertCostBudget(model, opts) {
  currentCostBudget()?.assert(model, opts);
}

// A budget stop has to tell the user what to DO next, not just that a number
// was unavailable. `unknown-cost` is the case people actually hit (a local or
// self-hosted model with no price row), so the remedy is named there.
export function budgetStopMessage(reason, { maxCostUsd = null, models = [] } = {}) {
  const names = models.filter(Boolean);
  const listed = names.length ? ` (${names.join(', ')})` : '';
  if (reason === 'unknown-cost') {
    const first = names[0] ?? '<model>';
    return `ox: budget-stop (unknown-cost) — no price row for${listed}, so the ${maxCostUsd} USD cap cannot be evaluated and ox refuses to spend against a cap it cannot measure. Set model_overrides for ${first} with in/out prices per million tokens, or drop the cap (omit --max-cost / maxCostUsd).`;
  }
  return `ox: budget-stop (cost-cap) — spend reached the ${maxCostUsd} USD cap, so the run was cut short. Raise the cap, or drop it (omit --max-cost / maxCostUsd).`;
}

export function createCostBudget(options = {}) {
  const maxCostUsd = resolveMaxCostUsd(options);
  // Pricing overrides come off the same `config` the caller already holds
  // (config `model_overrides` / OX_MODEL_OVERRIDE), so a user who declared a
  // price is capped against THAT price instead of against no price at all.
  const overrides = options.overrides ?? options.config?.modelOverrides ?? null;
  const buckets = new Map();
  const unknownModels = new Set();
  // Models whose endpoint can never bill (keyEnv null, e.g. ollama). They are
  // not "unpriced", they are free: a USD cap is no guard at all against a
  // model that cannot spend, so they count as $0 instead of failing closed.
  // Only the transport layer — the one place keyEnv is known — may put a model
  // here; the cost path itself never does.
  const freeModels = new Set();
  let stoppedReason = null;
  const snapshot = () => {
    let inputTokens = 0;
    let outputTokens = 0;
    let knownCostUsd = 0;
    for (const [model, usage] of buckets) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      const cost = freeModels.has(model) ? 0 : costOf(model, usage, overrides);
      if (cost == null) unknownModels.add(model);
      else knownCostUsd += cost;
    }
    return { inputTokens, outputTokens, costUsd: unknownModels.size ? null : knownCostUsd, knownCostUsd, unknownModels: [...unknownModels], maxCostUsd };
  };
  const budget = {
    maxCostUsd,
    snapshot,
    run(fn) { return costScope.run(budget, fn); },
    record(model, usage) {
      const key = String(model ?? '(unknown)');
      const bucket = buckets.get(key) ?? { inputTokens: 0, outputTokens: 0 };
      for (const field of ['inputTokens', 'outputTokens']) {
        const n = Number(usage?.[field] ?? 0);
        if (!Number.isFinite(n) || n < 0) budget.unknown(key);
        else bucket[field] += n;
      }
      buckets.set(key, bucket);
    },
    unknown(model) {
      const key = String(model ?? '(unknown)');
      if (freeModels.has(key)) return;
      unknownModels.add(key);
    },
    // A model served by an endpoint that cannot bill can never spend, so the
    // cap must not abort the run against it. Transport layer only.
    free(model) {
      const key = String(model ?? '(unknown)');
      freeModels.add(key);
      unknownModels.delete(key);
      return budget;
    },
    // Only meaningful when a cap is actually in force: that is the case where a
    // free endpoint silently costs the user the guard they asked for.
    get skippedModels() { return maxCostUsd == null ? [] : [...freeModels]; },
    get reason() {
      if (maxCostUsd == null) return null;
      const s = snapshot();
      return stoppedReason ?? (s.knownCostUsd >= maxCostUsd ? 'cost-cap' : s.unknownModels.length ? 'unknown-cost' : null);
    },
    explain() {
      const reason = budget.reason;
      return reason ? budgetStopMessage(reason, { maxCostUsd, models: snapshot().unknownModels }) : null;
    },
    assert(model, opts = {}) {
      if (maxCostUsd != null && model != null && !lookupModel(model, overrides).priced) {
        // A model already marked free stays free: free() is sticky, so the
        // transport layer marking an endpoint once is enough for every later
        // assert() against the same model.
        if (opts.free || freeModels.has(String(model))) budget.free(model);
        else unknownModels.add(String(model));
      }
      const reason = budget.reason;
      if (!reason) return;
      stoppedReason = reason;
      const err = new Error(budgetStopMessage(reason, { maxCostUsd, models: snapshot().unknownModels }));
      err.code = 'OX_BUDGET_STOP';
      err.exitCode = 2;
      throw err;
    },
  };
  return budget;
}

export const PRICING = {
  'grok-4.6': { in: 2, out: 6, window: 500_000 },
  'grok-build-0.1': { in: 1, out: 2, window: 256_000 },
  // The current Claude family. Haiku 5.5 is $0.10/$0.50 up to 100K-token
  // prompts ($0.50/$2.50 beyond); the table keeps the common case.
  'claude-fable-5-1': { in: 10, out: 50, window: 1_000_000 },
  'claude-opus-5-5': { in: 4, out: 20, window: 1_000_000 },
  'claude-sonnet-5-5': { in: 2, out: 10, window: 1_000_000 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, window: 1_000_000 },
  'claude-sonnet-5': { in: 2, out: 10, window: 200_000 },
  'claude-opus-5': { in: 5, out: 25, window: 200_000 },
  'claude-haiku-4-5': { in: 1, out: 5, window: 200_000 },
  'gpt-5.6-sol': { in: 4, out: 20, window: 400_000 },
  'gemini-3.1-pro-preview': { in: 2, out: 12, window: 1_000_000 },
  'gemini-3.7-flash': { in: 0.38, out: 1.88, window: 1_000_000 },
  'moonshotai/kimi-k2-instruct-0905': { in: 1, out: 3, window: 256_000 },
  'deepseek-v4-pro': { in: 1.32, out: 3.96, window: 128_000 },
};

const UNPRICED = Object.freeze({ priced: false });

// Per-model overrides (config `model_overrides` / env OX_MODEL_OVERRIDE) let a
// user declare pricing + context window for a model ox does not ship in PRICING,
// or correct a stale built-in row. Overrides are consulted only on an EXACT
// model-name match; with no override present every lookup is byte-identical to
// the built-in table.
function overrideFor(model, overrides) {
  if (!overrides || typeof overrides !== 'object') return null;
  const hit = overrides[model];
  return hit && typeof hit === 'object' && !Array.isArray(hit) ? hit : null;
}

// Number coercion that treats blank/absent fields as "unset" rather than 0.
function finiteNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function lookupModel(model, overrides = null) {
  if (typeof model !== 'string') return UNPRICED;
  const ov = overrideFor(model, overrides);
  const oIn = finiteNum(ov?.in);
  const oOut = finiteNum(ov?.out);
  const oWindow = finiteNum(ov?.window);
  // An override carrying BOTH in and out is authoritative pricing.
  if (oIn !== null && oOut !== null) {
    const window = oWindow !== null ? oWindow : PRICING[model]?.window;
    return { in: oIn, out: oOut, ...(window ? { window } : {}), priced: true };
  }
  const hit = PRICING[model];
  if (!hit) return UNPRICED;
  // Window-only override: the pricing row is untouched, only its window moves.
  return { in: hit.in, out: hit.out, window: oWindow !== null ? oWindow : hit.window, priced: true };
}

export const DEFAULT_MODEL_WINDOW = 128_000;

// Model context-window resolution. Precedence: OX_MODEL_WINDOW env
// (test/deploy hook) > explicit config override > per-model model_overrides
// window > pricing table window > 128k default.
export function resolveModelWindow({ model, configWindow, overrides, env = process.env } = {}) {
  const ov = overrideFor(model, overrides);
  for (const candidate of [env?.OX_MODEL_WINDOW, configWindow, finiteNum(ov?.window), lookupModel(model)?.window]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MODEL_WINDOW;
}

// `overrides` is the same per-model table lookupModel() already accepts, so a
// user-declared price row (config `model_overrides` / OX_MODEL_OVERRIDE) prices
// the run exactly as a built-in row would. Omitting it keeps the previous
// behaviour byte for byte: unpriced stays null, never 0.
export function costOf(model, usage = {}, overrides = null) {
  const p = lookupModel(model, overrides);
  if (!p.priced) return null;
  const inputTokens = Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.outputTokens) || 0;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

export function formatCost(usd) {
  if (!Number.isFinite(usd) || usd === 0) return '$0';
  const magnitude = Math.floor(Math.log10(Math.abs(usd)));
  const places = Math.max(0, 3 - magnitude);
  let s = usd.toFixed(places);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `$${s}`;
}
