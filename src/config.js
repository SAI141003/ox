import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveBot, defaultBotSpec, autoDefaultBot } from './bots.js';
import { pickForRole, STRATEGIES } from './model-registry.js';
import { resolveMaxCostUsd } from './cost.js';
import { pluginMcpServers } from './plugins.js';

export const CONFIG_DIR = path.join(os.homedir(), '.ox');

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`ox: cannot read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`ox: malformed JSON in ${file}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The one general config write path.
//
// ~/.ox/config.json is written by several independent features (MCP add/remove,
// skill pins, local-endpoint trust records) and by hand. Every writer must
// preserve keys it does not understand, or a new feature silently destroys a
// user's unrelated settings. So this is the single place that does the
// read-merge-write, using the same idiom the hand-rolled writers use: read the
// existing document, spread it forward, keep unknown keys, re-serialize with
// two-space indent and a trailing newline.
//
// `mutate(doc)` receives the live document. Mutate it in place and return
// nothing, or return a replacement document; returning `undefined` keeps `doc`.
// Throws on malformed JSON rather than clobbering a file it cannot parse -- an
// unreadable config is a user problem to report, not to overwrite.
//
// The three older writers (CLI mcp add, mcp remove, skill pin) are deliberately
// left as they are: they write two different files and each owns its own
// error-to-exit-code mapping, so folding them in here would change behavior
// across a hot path for no gain. New writers come here.
// ---------------------------------------------------------------------------
export function readConfigDoc({ dir = CONFIG_DIR } = {}) {
  return readJsonFile(path.join(dir, 'config.json')) || {};
}

export function saveConfigDoc(mutate, { dir = CONFIG_DIR } = {}) {
  const file = path.join(dir, 'config.json');
  const doc = readJsonFile(file) || {};
  const next = mutate(doc) ?? doc;
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    throw new Error(`ox: config merge produced a non-object document for ${file}`);
  }
  ensureDir(dir);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function expandVars(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name, def) => {
        const v = env[name];
        if (v !== undefined && v !== '') return v;
        if (def !== undefined) return def;
        return '';
      }
    );
  }
  if (Array.isArray(value)) return value.map((v) => expandVars(v, env));
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = expandVars(v, env);
    }
    return out;
  }
  return value;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Cost-honest routing: how much a provider bounce is allowed to cost.
export const FALLBACK_COST_POLICIES = Object.freeze(['free_only', 'allow_paid']);

const API_KEY_ENV_VARS = [
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
];

// v3b MCP policy engine inputs. Project .ox.json (strict JSON, same loader
// care as .mcp.json) carries { "mcpPolicy": { "<server>": "allow"|"ask"|"deny" } }
// and merges over ~/.ox/config.json's mcpPolicy (project wins per server).
function sanitizePolicyMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k ?? '').trim();
    const val = String(v ?? '').trim().toLowerCase();
    if (!name || name.startsWith('__')) continue;
    if (val === 'allow' || val === 'ask' || val === 'deny') out[name] = val;
  }
  return out;
}

export function readMcpPolicyDocs(cwd = process.cwd()) {
  const homeDoc = readJsonFile(path.join(CONFIG_DIR, 'config.json')) || {};
  const projDoc = readJsonFile(path.join(cwd, '.ox.json')) || {};
  const homePolicy = sanitizePolicyMap(homeDoc.mcpPolicy);
  const projPolicy = sanitizePolicyMap(projDoc.mcpPolicy);
  const origins = {};
  for (const k of Object.keys(homePolicy)) origins[k] = 'global';
  for (const k of Object.keys(projPolicy)) origins[k] = 'project';
  const globalServers = new Set([...Object.keys(obj(homeDoc.mcpServers)), ...Object.keys(homePolicy)]);
  return { policy: { ...homePolicy, ...projPolicy }, origins, globalServers };
}

export function loadMcpPolicy(cwd = process.cwd()) {
  return readMcpPolicyDocs(cwd).policy;
}

// G1 auxiliary-model routing: resolve the configured aux bot (cheap model for
// compaction, goal-verification and max-mode calls). Unresolvable specs warn
// exactly once and yield null — never throw.
let auxWarned = false;
export function resetAuxWarningForTest() {
  auxWarned = false;
}

export function resolveAuxTarget(config = {}) {
  const spec = config?.auxBot;
  // Explicit auxBot spec wins (preserves existing behavior)
  if (typeof spec === 'string' && spec.trim()) {
    try {
      return resolveBot(spec.trim(), config);
    } catch (err) {
      if (!auxWarned) {
        auxWarned = true;
        process.stderr.write(
          `ox: aux bot '${spec}' unusable (${String(err?.message ?? err)}) — auxiliary calls fall back to the main bot\n`
        );
      }
      return null;
    }
  }
  // No explicit auxBot: try auto-routing a cheap model for summarizer role

  // When OX_BASE_URL is set, all calls must use that custom endpoint — auto-routing
  // would return a model with a different provider and a non-mock baseUrl. Use the
  // same custom provider as the main target instead.
  if (process.env.OX_BASE_URL) {
    const spec = defaultBotSpec(config);
    try { return resolveBot(spec, config); } catch { return null; }
  }
  try {
    const picked = pickForRole('summarizer', { config, env: process.env });
    if (picked) return picked;
  } catch { /* fall through to null */ }
  return null;
}

// Compaction-model routing (Zed's `compaction_model`): let the summary pass run
// on a CHEAPER model than the main one. The summarizer only has to compress a
// transcript into a few hundred words, so the main model's quality is wasted on
// it — and because the summarizer re-reads the whole dropped transcript as
// INPUT, the saving scales with the size of the run.
//
// Resolution order is a strict superset of what existed before, so nothing
// regresses: an explicit `compaction_model` wins; otherwise the caller falls
// back to the aux bot and then the main model. An unusable spec warns once and
// degrades to that fallback rather than throwing mid-run.
let compactionModelWarned = false;
export function resetCompactionModelWarningForTest() {
  compactionModelWarned = false;
}

export function resolveCompactionTarget(config = {}, { main = null } = {}) {
  const spec = config?.compactionModel;
  if (typeof spec === 'string' && spec.trim()) {
    try {
      const resolved = resolveBot(spec.trim(), config);
      if (resolved) return { ...resolved, dedicated: true, spec: spec.trim() };
    } catch (err) {
      if (!compactionModelWarned) {
        compactionModelWarned = true;
        process.stderr.write(
          `ox: compaction_model '${spec.trim()}' unusable (${String(err?.message ?? err)}) — compaction falls back to the aux bot, then the main model\n`
        );
      }
      return null;
    }
  }
  // No dedicated model: name the main target explicitly so callers can tell
  // "unconfigured" from "configured to the same model".
  return main && typeof main === 'object' && main.model
    ? { ...main, dedicated: false, spec: null }
    : null;
}

// How the compaction model for THIS run was chosen, for the audit record. Kept
// separate from resolveCompactionTarget so the caller can describe the fallback
// chain it actually walked rather than re-deriving it.
export function compactionModelChoice(config = {}, { aux = null, main = null } = {}) {
  const dedicated = resolveCompactionTarget(config, { main });
  if (dedicated?.dedicated) {
    return {
      target: dedicated,
      model: dedicated.model,
      bot: dedicated.bot ?? null,
      provider: dedicated.provider ?? null,
      source: 'compaction_model',
      separateFromMain: !main?.model || dedicated.model !== main.model,
    };
  }
  const chosen = aux ?? main ?? null;
  return {
    target: chosen,
    model: chosen?.model ?? null,
    bot: chosen?.bot ?? null,
    provider: chosen?.provider ?? null,
    source: aux ? 'aux_bot' : 'main',
    separateFromMain: false,
  };
}

// G6 compaction knobs. config values come pre-clamped from loadConfig; env
// OX_COMPACT_AT / OX_KEEP_TURNS override everything as test hooks.
export function compactionKnobs(config = {}) {
  const env = process.env;
  const atN = Number(firstDefined(env.OX_COMPACT_AT, config?.compactAt));
  const compactAt = Number.isFinite(atN) ? Math.min(0.95, Math.max(0.5, atN)) : 0.75;
  const ktN = Math.round(Number(firstDefined(env.OX_KEEP_TURNS, config?.keepTurns)));
  const keepTurns = Number.isFinite(ktN) && ktN >= 0 ? ktN : 4;
  return { compactAt, keepTurns };
}

// Wave5b I two-pass compaction knobs: detail level maps to the summarizer
// prompt word budget; OX_TWO_PASS=1 env forces the second pass on.
export const COMPACTION_DETAIL_LEVELS = Object.freeze(['none', 'minimal', 'balanced', 'verbose']);
export const DETAIL_WORD_BUDGETS = Object.freeze({
  none: 80,
  minimal: 150,
  balanced: 300,
  verbose: 500,
});

export function compactionPassKnobs(config = {}) {
  const raw = obj(config?.compaction);
  const detail = COMPACTION_DETAIL_LEVELS.includes(raw.detail) ? raw.detail : 'balanced';
  const twoPass = truthy(process.env.OX_TWO_PASS) || raw.two_pass === true || raw.twoPass === true;
  return { twoPass, detail, wordBudget: DETAIL_WORD_BUDGETS[detail] };
}

export function loadConfig(overrides = {}) {
  const ov = obj(overrides);
  const env = process.env;
  const file = readJsonFile(path.join(CONFIG_DIR, 'config.json')) || {};

  const cwd = firstDefined(ov.cwd) || process.cwd();

  const project = readJsonFile(path.join(cwd, '.mcp.json')) || {};
  // Plugin-contributed servers rank lowest: your own config always wins a name.
  let fromPlugins = {};
  try {
    fromPlugins = pluginMcpServers(path.dirname(CONFIG_DIR));
  } catch { /* a broken plugin registry must never break config */ }
  const mcpServers = expandVars({ ...fromPlugins, ...obj(file.mcpServers), ...obj(project.mcpServers) });

  const apiKeys = {};
  for (const key of API_KEY_ENV_VARS) {
    if (env[key]) apiKeys[key] = env[key];
  }

  const yolo =
    firstDefined(truthy(ov.yolo) ? true : undefined, truthy(env.OX_YOLO) ? true : undefined, truthy(file.yolo) ? true : undefined) === true;

  const maxCostUsd = resolveMaxCostUsd({
    maxCostUsd: ov.maxCostUsd ?? env.OX_MAX_COST ?? file.max_cost ?? file.maxCostUsd,
    env: {},
  });

  const baseUrl = firstDefined(ov.baseUrl ?? ov.oxBaseUrl, env.OX_BASE_URL, file.baseUrl ?? file.base_url) ?? null;
  const apiKey = firstDefined(ov.apiKey, env.OX_API_KEY, file.api_key ?? file.apiKey) ?? null;
  const model = firstDefined(ov.model, env.OX_MODEL, file.model) ?? null;
  // A default you chose wins; otherwise the first provider you have a key for;
  // 'ox-grok' only when nothing at all is set up (the error then says how to connect).
  const chosenBot = firstDefined(ov.defaultBot ?? ov.default_bot, file.defaultBot ?? file.default_bot);
  const autoBot = chosenBot === undefined ? autoDefaultBot(env, apiKeys) : null;
  const defaultBot = String(chosenBot ?? autoBot?.spec ?? 'ox-grok');
  const defaultBotSource = chosenBot !== undefined ? 'config' : autoBot ? `auto: ${autoBot.reason}` : 'fallback';
  const defaultVerify = truthy(file.default_verify ?? file.defaultVerify) === true;

  const maxModeRaw = firstDefined(ov.maxMode, file.max_mode ?? file.maxMode);
  let maxMode = 1;
  if (maxModeRaw !== undefined && maxModeRaw !== null) {
    const n = Math.round(Number(maxModeRaw));
    maxMode = Number.isFinite(n) ? (n <= 1 ? 1 : Math.min(5, n)) : 1;
  }

  // G1: auxiliary bot for cheap calls (compaction summarizer, goal verifier,
  // max-mode planning/judge). Flag/env/file precedence like the main model.
  const auxBot = firstDefined(ov.auxBot ?? ov.aux_bot, env.OX_AUX_BOT, file.aux_bot ?? file.auxBot) ?? null;

  // Model routing strategy (pinned | cost | quality | fast). Default: cost.
  const routingRaw = firstDefined(ov.routingStrategy ?? ov.routing_strategy, env.OX_ROUTING, file.routing_strategy ?? file.routingStrategy);
  const routingStrategy = String(routingRaw || 'cost').toLowerCase().trim();

  // G2: explicit context-window override (env OX_MODEL_WINDOW is consulted at
  // resolution time and always wins over this value).
  const modelWindowRaw = firstDefined(ov.modelWindow ?? ov.model_window, file.model_window ?? file.modelWindow);
  let modelWindow = null;
  if (modelWindowRaw !== undefined && modelWindowRaw !== null) {
    const n = Number(modelWindowRaw);
    if (Number.isFinite(n) && n > 0) modelWindow = Math.round(n);
  }

  // G6: compaction trigger + tail retention. compact_at clamps to 0.5..0.95.
  let compactAt = 0.75;
  const compactAtRaw = file.compact_at ?? file.compactAt;
  if (compactAtRaw !== undefined && compactAtRaw !== null) {
    const n = Number(compactAtRaw);
    if (Number.isFinite(n)) compactAt = Math.min(0.95, Math.max(0.5, n));
  }
  let keepTurns = 4;
  const keepTurnsRaw = file.keep_turns ?? file.keepTurns;
  if (keepTurnsRaw !== undefined && keepTurnsRaw !== null) {
    const n = Math.round(Number(keepTurnsRaw));
    if (Number.isFinite(n) && n >= 0) keepTurns = n;
  }

  // Context optimization: reversible cache (CCR) opt-in.
  const reversibleCache = truthy(process.env.OX_REVERSIBLE_CACHE) || truthy(file.reversible_cache) || truthy(file.reversibleCache);

  // Context optimization: gate for provider-call integration.
  const contextOptimize = truthy(process.env.OX_CONTEXT_OPTIMIZE) || truthy(file.contextOptimize) || truthy(file.context_optimize);

  // G5: persona files (~/.ox/soul.md then <cwd>/SOUL.md); soul:false disables.
  const soul = !(ov.soul === false || file.soul === false);

  // F1: skill-lifecycle curator knobs + pinned-skill immunity list.
  const curatorCfg = obj(file.curator);
  const posInt = (v, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const curator = {
    stale_after_days: posInt(curatorCfg.stale_after_days ?? curatorCfg.staleAfterDays, 30),
    archive_after_days: posInt(curatorCfg.archive_after_days ?? curatorCfg.archiveAfterDays, 90),
  };
  const pinsRaw = firstDefined(ov.skillPins ?? ov.skill_pins, file.skill_pins ?? file.skillPins);
  const skillPins = (Array.isArray(pinsRaw) ? pinsRaw : []).map((s) => String(s).trim()).filter(Boolean);

  // F2: ordered cross-provider fallback chain. File form is a JSON array,
  // env OX_FALLBACK_BOTS is a comma-list; env wins over file.
  const fbRaw = firstDefined(
    ov.fallbackBots ?? ov.fallback_bots,
    env.OX_FALLBACK_BOTS,
    file.fallback_bots ?? file.fallbackBots
  );
  const fallbackBots = Array.isArray(fbRaw)
    ? fbRaw.map((s) => String(s).trim()).filter(Boolean)
    : typeof fbRaw === 'string'
      ? fbRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  // Cost-honest routing: per-model pricing/window overrides for models ox does
  // not ship in PRICING (or to correct a stale row). File form is a
  // { model: { window, in, out } } map; env OX_MODEL_OVERRIDE is a single
  // `model:window:in:out` spec where every field after the model is optional
  // and blank fields are ignored. Env wins per-model over the file.
  const modelOverrides = (() => {
    const out = {};
    const numOr = (v) => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const entry = (base, spec) => {
      const win = numOr(spec.window);
      const i = numOr(spec.in);
      const o = numOr(spec.out);
      if (win !== undefined) base.window = win;
      if (i !== undefined) base.in = i;
      if (o !== undefined) base.out = o;
      return base;
    };
    const fileOverrides = firstDefined(ov.modelOverrides ?? ov.model_overrides, file.model_overrides ?? file.modelOverrides);
    for (const [k, v] of Object.entries(obj(fileOverrides))) {
      const name = String(k ?? '').trim();
      if (!name) continue;
      out[name] = entry({}, obj(v));
    }
    const envSpec = String(env.OX_MODEL_OVERRIDE ?? '').trim();
    if (envSpec) {
      // Split on the FIRST colon only: model ids may contain '/' but never ':'.
      const cut = envSpec.indexOf(':');
      const name = (cut === -1 ? envSpec : envSpec.slice(0, cut)).trim();
      const parts = cut === -1 ? [] : envSpec.slice(cut + 1).split(':');
      if (name) out[name] = entry(out[name] ?? {}, { window: parts[0], in: parts[1], out: parts[2] });
    }
    return out;
  })();

  // Cost-honest routing: whether a fallback bounce may land on a paid provider.
  // Default allow_paid keeps existing behavior; free_only fails closed instead
  // of silently spending on a provider the user never chose.
  const fbCostRaw = firstDefined(
    obj(ov.fallbackPolicy ?? ov.fallback_policy).cost,
    env.OX_FALLBACK_COST,
    obj(file.fallback_policy ?? file.fallbackPolicy).cost
  );
  let fallbackCost = 'allow_paid';
  if (fbCostRaw !== undefined && fbCostRaw !== null && fbCostRaw !== '') {
    const v = String(fbCostRaw).toLowerCase().trim();
    if (!FALLBACK_COST_POLICIES.includes(v)) {
      const err = new Error(
        `ox: fallback policy cost must be one of ${FALLBACK_COST_POLICIES.join(', ')} (got '${String(fbCostRaw)}')`
      );
      err.exitCode = 3;
      throw err;
    }
    fallbackCost = v;
  }
  const fallbackPolicy = { cost: fallbackCost };

  // Wave5a G: MCP HTTP allow list (exact host / host:port entries; validated
  // fail-closed by the hub at startup).
  const mhRaw = firstDefined(
    ov.mcpAllowedHosts ?? ov.mcp_allowed_hosts,
    env.OX_MCP_ALLOWED_HOSTS,
    file.mcp_allowed_hosts ?? file.mcpAllowedHosts
  );
  const mcpAllowedHosts = Array.isArray(mhRaw)
    ? mhRaw.map((s) => String(s).trim()).filter(Boolean)
    : typeof mhRaw === 'string'
      ? mhRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  // Wave5b I: two-pass compaction (compaction.two_pass, compaction.detail).
  const compactionCfg = obj(file.compaction);
  let compactionDetail = COMPACTION_DETAIL_LEVELS.includes(compactionCfg.detail)
    ? compactionCfg.detail
    : 'balanced';
  if (!COMPACTION_DETAIL_LEVELS.includes(compactionCfg.detail) && compactionCfg.detail != null) {
    compactionDetail = 'balanced';
  }
  const compactionTwoPass =
    truthy(env.OX_TWO_PASS) || compactionCfg.two_pass === true || compactionCfg.twoPass === true;
  // Dedicated summarizer model (Zed's `compaction_model`). Accepted at the top
  // level and nested under `compaction` so the config file has one obvious home
  // for compaction settings. Env wins over both.
  const compactionModelRaw = firstDefined(
    ov.compactionModel ?? ov.compaction_model,
    env.OX_COMPACTION_MODEL,
    file.compaction_model ?? file.compactionModel ?? file.compaction_bot ?? file.compactionBot,
    compactionCfg.model ?? compactionCfg.bot
  );
  const compactionModel =
    typeof compactionModelRaw === 'string' && compactionModelRaw.trim() ? compactionModelRaw.trim() : null;

  // Wave5b H: tool-offer narrowing and strict-schema switches.
  const toolsCfg = obj(file.tools);
  const overrideToolsCfg = obj(ov.tools);
  const toolsNarrow = !(toolsCfg.narrow === false);
  const strictSchemas = truthy(firstDefined(
    ov.strictSchemas,
    overrideToolsCfg.strictSchemas,
    file.strictSchemas,
    toolsCfg.strictSchemas,
    true
  ));
  const toolsStrictSchemas = strictSchemas;

  // Wave 6b: subagent defaults (max_depth, max_iterations).
  const subagentCfg = obj(file.subagent);
  const subagentMaxDepth = (() => {
    const n = Number(firstDefined(subagentCfg.max_depth, subagentCfg.maxDepth, env.OX_SUBAGENT_DEPTH, 2));
    return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 2;
  })();
  const subagentMaxIterations = (() => {
    const n = Number(firstDefined(subagentCfg.max_iterations, subagentCfg.maxIterations, 25));
    return Number.isFinite(n) ? Math.max(5, Math.min(40, Math.round(n))) : 25;
  })();
  // Cost routing: subagents do most of the reading, so running them on a cheap
  // or local model ("ollama:auto", "ox-flash", "groq:...") while the main agent
  // keeps the strong one is where most tokens are saved.
  const subagentBot = firstDefined(env.OX_SUBAGENT_BOT, subagentCfg.bot) || 'auto';

  return {
    cwd,
    configDir: CONFIG_DIR,
    defaultBot,
    defaultBotSource,
    bots: { ...obj(file.bots), ...obj(ov.bots) },
    baseUrl,
    oxBaseUrl: baseUrl,
    apiKey,
    model,
    yolo,
    defaultVerify,
    maxMode,
    maxCostUsd,
    auxBot,
    routingStrategy,
    modelWindow,
    compactAt,
    keepTurns,
    soul,
    curator,
    skillPins,
    fallbackBots,
    fallbackPolicy,
    modelOverrides,
    mcpAllowedHosts,
    compaction: { two_pass: compactionTwoPass, detail: compactionDetail },
    compactionModel,
    strictSchemas,
    tools: { narrow: toolsNarrow, strictSchemas: toolsStrictSchemas },
    subagent: { maxDepth: subagentMaxDepth, maxIterations: subagentMaxIterations, bot: subagentBot },
    reversibleCache,
    contextOptimize,
    apiKeys,
    mcpServers,
    raw: file,
  };
}
