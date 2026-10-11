import { lookupModel, resolveModelWindow } from './cost.js';

export const KEY_ENV = Object.freeze({
  zhipu: 'ZHIPU_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  baichuan: 'BAICHUAN_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  yi: 'YI_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
  xai: 'XAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  ollama: null,
  custom: 'OX_API_KEY',
  backboard: 'BACKBOARD_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  lmstudio: null,
  llamacpp: null,
  vllm: null,
});

export const PROVIDERS = Object.freeze(Object.keys(KEY_ENV));

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export const BOTS = {
  'ox-grok': { provider: 'xai', model: 'grok-4.6', desc: 'xAI Grok flagship' },
  'ox-grok-fast': { provider: 'xai', model: 'grok-build-0.1', desc: 'xAI fast build model' },
  'ox-claude': { provider: 'anthropic', model: 'claude-sonnet-5', desc: 'Anthropic Sonnet' },
  'ox-opus': { provider: 'anthropic', model: 'claude-opus-5', desc: 'Anthropic Opus' },
  'ox-haiku': { provider: 'anthropic', model: 'claude-haiku-4-5', desc: 'Anthropic Haiku' },
  'ox-gpt': { provider: 'openai', model: 'gpt-5.6-sol', desc: 'OpenAI GPT-5.6 Sol' },
  'ox-gemini': { provider: 'gemini', model: 'gemini-3.1-pro-preview', desc: 'Google Gemini Pro preview' },
  'ox-flash': { provider: 'gemini', model: 'gemini-3.7-flash', desc: 'Google Gemini Flash' },
  'ox-groq': { provider: 'groq', model: 'moonshotai/kimi-k2-instruct-0905', desc: 'Groq-hosted Kimi K2' },
  'ox-deepseek': { provider: 'deepseek', model: 'deepseek-v4-pro', desc: 'DeepSeek V4 Pro' },
  'ox-ollama': { provider: 'ollama', model: 'qwen2.5:0.5b', desc: 'local Ollama (no key needed)' },
  'ox-openrouter': { provider: 'openrouter', model: null, desc: 'any OpenRouter model; explicit model required' },
  'ox-lmstudio': { provider: 'lmstudio', model: 'auto', desc: 'local LM Studio server (no key; uses the loaded model)' },
  'ox-llamacpp': { provider: 'llamacpp', model: 'auto', desc: 'local llama.cpp server (no key; uses the loaded model)' },
  'ox-vllm': { provider: 'vllm', model: 'auto', desc: 'local vLLM server (no key; uses the served model)' },
  'ox-mistral': { provider: 'mistral', model: 'mistral-large-latest', desc: 'Mistral Large (latest alias)' },
  'ox-backboard': { provider: 'backboard', model: 'backboard-routing', baseUrl: 'https://api.backboard.io/v1', desc: 'Backboard.io model routing + memory' },
  'ox-glm': { provider: 'zhipu', model: 'glm-4.5', desc: 'Zhipu GLM-4.5' },
  'ox-glm-turbo': { provider: 'zhipu', model: 'glm-4.5-turbo', desc: 'Zhipu GLM-4.5 Turbo' },
  'ox-kimi': { provider: 'moonshot', model: 'kimi-k2-0711-preview', desc: 'Moonshot Kimi K2' },
  'ox-baichuan': { provider: 'baichuan', model: 'baichuan-4', desc: 'Baichuan 4' },
  'ox-minimax': { provider: 'minimax', model: 'minimax-01', desc: 'MiniMax-01' },
  'ox-yi': { provider: 'yi', model: 'yi-34b-chat', desc: '01.AI Yi-34B' },
  'ox-stepfun': { provider: 'stepfun', model: 'step-2', desc: 'StepFun Step-2' },
};

function fail(msg) {
  throw new Error(`ox: ${msg}`);
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function availableBots() {
  return Object.keys(BOTS).join(', ');
}

function pricingFor(model) {
  const p = lookupModel(model);
  return p.priced ? { in: p.in, out: p.out } : null;
}

// ---------------------------------------------------------------------------
// Base URL rule — the ONE place ox decides which endpoint a target talks to.
//
//   `--bot` pins the PROVIDER: which key env var is read and which wire
//   protocol the adapter speaks. `OX_BASE_URL` sets the ENDPOINT. The two are
//   orthogonal, so the endpoint override applies to every provider, not only
//   `custom`. Someone who points ox at a proxy or a local gateway must never
//   silently end up sending their traffic — and their key — to the real
//   provider instead, which is exactly what used to happen whenever the bot was
//   named explicitly on the command line (`--bot provider:model` resolves here
//   directly, so the routing-layer override never ran).
//
//   Precedence, highest first:
//     1. a baseUrl on the bot definition — as specific as naming the bot itself,
//        so it is left alone (an aux bot pinned to its own gateway, a preset
//        that ships its own endpoint);
//     2. the environment / config base URL (OX_BASE_URL, or an explicit baseUrl
//        override handed to loadConfig). This is the whole point of the rule:
//        it beats every *provider* default, so the real provider's endpoint is
//        never used while the user has named a different one;
//     3. the provider's built-in default (Ollama's local endpoint);
//     4. null, which lets providers/index.js fall back to PROVIDERS[p].baseUrl.
//
//   With OX_BASE_URL unset the chain collapses to 1/3/4 and every provider
//   resolves exactly as it did before. For Ollama only, OX_OLLAMA_BASE_URL sits
//   immediately above the built-in default so it can move Ollama off 11434
//   without taking precedence over a bot-specific or OX_BASE_URL endpoint.
// ---------------------------------------------------------------------------
function resolveBaseUrl({ provider, baseUrlOverride, botDef, config, env }) {
  const fromDef = baseUrlOverride || botDef?.baseUrl || null;
  if (fromDef) return fromDef;
  const override = env?.OX_BASE_URL || obj(config).oxBaseUrl || obj(config).baseUrl || null;
  if (override) return override;
  // Ollama on a non-default port. Ollama honours OLLAMA_HOST, so a real install
  // does not have to be on 11434 -- and if ox can be pointed at a different
  // port, the endpoint approval is checked against (model-registry.js
  // ollamaReachability) MUST be the same one the request is actually sent to.
  // Without this the gate could approve :11434 while traffic went to :8080 (or
  // vice versa), which is precisely the confusion an approval is supposed to
  // remove. Normalized to the same origin form the trust record is keyed by.
  if (provider === 'ollama' && env?.OX_OLLAMA_BASE_URL) {
    const explicit = normalizeOllamaBaseUrl(env.OX_OLLAMA_BASE_URL);
    if (explicit) return `${explicit}/v1`;
  }
  if (provider === 'ollama') return OLLAMA_BASE_URL;
  const providerBaseUrls = {
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    moonshot: 'https://api.moonshot.cn/v1',
    baichuan: 'https://api.baichuan-ai.com/v1',
    minimax: 'https://api.minimax.chat/v1',
    yi: 'https://api.lingyiwanwu.com/v1',
    stepfun: 'https://api.stepfun.com/v1',
  };
  if (providerBaseUrls[provider]) return providerBaseUrls[provider];
  return null;
}

// Accept "8080", "localhost:8080", "http://127.0.0.1:8080" or ".../v1" and
// return the canonical origin ("http://localhost:8080"). Mirrors
// normalizeEndpointUrl in local-inference.js, kept local here so bots.js stays
// free of any dependency on the discovery module.
function normalizeOllamaBaseUrl(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return `http://localhost:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const loopback = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
  const host = loopback.has(u.hostname.toLowerCase()) ? 'localhost' : u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${host}:${port}`;
}

function build({ name, provider, model, desc, baseUrlOverride, config, botDef, env }) {
  if (!PROVIDERS.includes(provider)) {
    fail(`unknown provider '${provider}' (valid providers: ${PROVIDERS.join(', ')})`);
  }
  if (provider === 'openrouter' && !model) {
    fail(
      `bot 'openrouter' requires an explicit model, e.g. ox --bot ox-openrouter:meta-llama/llama-3.3-70b-instruct or /bot ox-openrouter:moonshotai/kimi-k2-instruct-0905`
    );
  }
  const baseUrl = resolveBaseUrl({ provider, baseUrlOverride, botDef, config, env });
  if (!baseUrl && (provider === 'custom' || provider === 'backboard')) {
    fail(`provider '${provider}' needs a base URL: set OX_BASE_URL in the environment or a baseUrl on the bot definition`);
  }
  return {
    bot: name ?? null,
    provider,
    model,
    baseUrl,
    keyEnv: KEY_ENV[provider],
    pricing: pricingFor(model),
    // Context window for metering/budgeting: env OX_MODEL_WINDOW > explicit
    // config model_window > pricing-table window > 128k default.
    window: resolveModelWindow({ model, configWindow: obj(config)?.modelWindow }),
    desc: desc ?? '',
  };
}

function customBotDef(name, def) {
  if (!def || typeof def !== 'object') fail(`custom bot '${name}' must be an object with a provider`);
  const d = obj(def);
  if (!d.provider || !PROVIDERS.includes(d.provider)) {
    fail(`custom bot '${name}' has unknown or missing provider '${d.provider}' (valid providers: ${PROVIDERS.join(', ')})`);
  }
  return d;
}

export function listBots(config = {}) {
  return [...Object.entries(BOTS), ...Object.entries(obj(config.bots))];
}

// Default bot selection: an explicit OX_BASE_URL/config baseUrl means "talk to my
// OpenAI-compatible endpoint" (custom provider), honoring OX_MODEL when present.
export function defaultBotSpec(config = {}, env = process.env) {
  const baseUrl = env?.OX_BASE_URL || config?.oxBaseUrl || config?.baseUrl;
  if (baseUrl) return config.model ? `custom:${config.model}` : 'custom';
  return config.defaultBot;
}

export function resolveBot(nameOrSpec, config = {}, env = process.env) {
  if (typeof nameOrSpec !== 'string' || !nameOrSpec.trim()) fail('no bot specified');
  const spec = nameOrSpec.trim();
  const customBots = obj(config.bots);
  const colon = spec.indexOf(':');

  if (colon > 0) {
    const left = spec.slice(0, colon);
    const right = spec.slice(colon + 1).trim();
    if (!right) return resolveBot(left, config, env);
    if (BOTS[left]) {
      const base = BOTS[left];
      return build({ name: left, provider: base.provider, model: right, desc: base.desc, baseUrlOverride: base.baseUrl, config, botDef: base, env });
    }
    if (customBots[left]) {
      const d = customBotDef(left, customBots[left]);
      return build({ name: left, provider: d.provider, model: right, desc: d.desc ?? '', baseUrlOverride: d.baseUrl, config, botDef: d, env });
    }
    if (PROVIDERS.includes(left)) {
      return build({ name: null, provider: left, model: right, desc: '', config, env });
    }
    fail(`unknown bot or provider '${left}' in '${spec}' (available bots: ${availableBots()}; providers: ${PROVIDERS.join(', ')})`);
  }

  if (BOTS[spec]) {
    const d = BOTS[spec];
    return build({ name: spec, provider: d.provider, model: d.model, desc: d.desc, baseUrlOverride: d.baseUrl, config, botDef: d, env });
  }
  if (customBots[spec]) {
    const d = customBotDef(spec, customBots[spec]);
    return build({
      name: spec,
      provider: d.provider,
      model: d.model ?? null,
      desc: d.desc ?? `custom ${d.provider} bot`,
      baseUrlOverride: d.baseUrl,
      config,
      botDef: d,
      env,
    });
  }

  // A bare provider name ("custom", "ollama", "lmstudio") means that provider
  // with the configured model -- never a model literally named "custom". For a
  // keyless local server with nothing configured, 'auto' asks it what is loaded.
  if (PROVIDERS.includes(spec)) {
    const configured = config?.model ?? env?.OX_MODEL ?? null;
    // Nothing configured: a keyless local server reports its own model; a
    // custom endpoint keeps its historical behaviour (the name is passed
    // through, which servers that serve one model simply ignore).
    const model = configured || (KEY_ENV[spec] === null ? 'auto' : spec === 'custom' ? 'custom' : null);
    if (!model) fail(`provider '${spec}' needs a model: use --bot ${spec}:<model> or set OX_MODEL`);
    return build({ name: null, provider: spec, model, desc: `${spec} (configured model)`, config, env });
  }

  const baseUrl = env?.OX_BASE_URL || config?.oxBaseUrl || config?.baseUrl || null;
  if (!baseUrl) {
    fail(
      `unknown bot '${spec}' (available bots: ${availableBots()}); to use '${spec}' as a raw model on a custom OpenAI-compatible endpoint, set OX_BASE_URL`
    );
  }
  return build({ name: null, provider: 'custom', model: spec, desc: `custom endpoint ${baseUrl}`, config, env });
}
