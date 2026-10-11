import {
  makeOpenAICompat,
  createOpenAICompatParser,
} from './openai-compat.js';
import { makeAnthropic, createAnthropicParser } from './anthropic.js';
import { makeGemini, createGeminiParser } from './gemini.js';
import { currentCostBudget } from '../cost.js';

export const PROVIDERS = {
  xai: { kind: 'openai-compat', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY' },
  openai: { kind: 'openai-compat', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  groq: { kind: 'openai-compat', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  openrouter: {
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  deepseek: { kind: 'openai-compat', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  ollama: { kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1', keyEnv: null },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
  gemini: {
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
  },
  backboard: { kind: 'openai-compat', baseUrl: 'https://api.backboard.io/v1', keyEnv: 'BACKBOARD_API_KEY' },
  mistral: { kind: 'openai-compat', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY' },
  together: { kind: 'openai-compat', baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY' },
  fireworks: { kind: 'openai-compat', baseUrl: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
  cerebras: { kind: 'openai-compat', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY' },
  zhipu: { kind: 'openai-compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY' },
  moonshot: { kind: 'openai-compat', baseUrl: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY' },
  baichuan: { kind: 'openai-compat', baseUrl: 'https://api.baichuan-ai.com/v1', keyEnv: 'BAICHUAN_API_KEY' },
  minimax: { kind: 'openai-compat', baseUrl: 'https://api.minimax.chat/v1', keyEnv: 'MINIMAX_API_KEY' },
  yi: { kind: 'openai-compat', baseUrl: 'https://api.lingyiwanwu.com/v1', keyEnv: 'YI_API_KEY' },
  stepfun: { kind: 'openai-compat', baseUrl: 'https://api.stepfun.com/v1', keyEnv: 'STEPFUN_API_KEY' },
  // Local OpenAI-compatible servers: no key, no bill. Ports are each tool's default.
  lmstudio: { kind: 'openai-compat', baseUrl: 'http://localhost:1234/v1', keyEnv: null },
  llamacpp: { kind: 'openai-compat', baseUrl: 'http://localhost:8080/v1', keyEnv: null },
  vllm: { kind: 'openai-compat', baseUrl: 'http://localhost:8000/v1', keyEnv: null },
  custom: { kind: 'openai-compat', baseUrl: null, keyEnv: 'OX_API_KEY' },
};

const ADAPTERS = new Map();

function adapterFor(name, cfg) {
  let a = ADAPTERS.get(name);
  if (!a) {
    a =
      cfg.kind === 'anthropic'
        ? makeAnthropic()
        : cfg.kind === 'gemini'
          ? makeGemini()
          : makeOpenAICompat({ name });
    ADAPTERS.set(name, a);
  }
  return a;
}

export function getProvider(name) {
  const cfg = PROVIDERS[name];
  if (!cfg) {
    throw new Error(`ox: unknown provider '${name}' (known providers: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  return { name, ...cfg, streamChat: adapterFor(name, cfg) };
}

// One lookup per endpoint per process: a local server's loaded model does not
// change mid-run, and re-asking every turn would add a round trip to each call.
const LOCAL_MODEL_CACHE = new Map();

export async function discoverLocalModel(baseUrl, signal) {
  const key = String(baseUrl).replace(/\/+$/, '');
  if (LOCAL_MODEL_CACHE.has(key)) return LOCAL_MODEL_CACHE.get(key);
  let ids = [];
  try {
    const res = await fetch(`${key}/models`, { signal });
    if (res.ok) ids = ((await res.json())?.data ?? []).map((m) => m?.id).filter(Boolean);
  } catch (err) {
    throw new Error(`ox: no model named and the local server at ${key} did not answer /models (${err?.message ?? err}) — is it running?`);
  }
  if (!ids.length) {
    throw new Error(`ox: no model named and the local server at ${key} reports no loaded models — load one or pass --model <provider>:<model>`);
  }
  // An agent needs tool calling. Ollama publishes per-model capabilities on
  // /api/tags; prefer a tools-capable model when the server says which are.
  let pick = ids[0];
  try {
    const origin = key.replace(/\/v1$/, '');
    const res = await fetch(`${origin}/api/tags`, { signal });
    if (res.ok) {
      const tagged = ((await res.json())?.models ?? []).filter((m) => Array.isArray(m?.capabilities));
      const capable = tagged.find((m) => m.capabilities.includes('tools') && ids.includes(m.name ?? m.model));
      if (capable) pick = capable.name ?? capable.model;
    }
  } catch { /* not Ollama, or no capability data: keep the first model */ }
  LOCAL_MODEL_CACHE.set(key, pick);
  return pick;
}

export async function* streamVia(target, opts = {}) {
  const pname = target?.provider;
  const cfg = pname ? PROVIDERS[pname] : undefined;
  if (!cfg) {
    throw new Error(
      `ox: unknown provider '${pname ?? ''}' (known providers: ${Object.keys(PROVIDERS).join(', ')})`
    );
  }
  const baseUrl = target.baseUrl ?? cfg.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `ox: provider '${pname}' has no base URL — set OX_BASE_URL or a baseUrl on the bot definition`
    );
  }
  const keyEnv = target.keyEnv ?? cfg.keyEnv;
  const apiKey = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !apiKey) {
    throw new Error(`Missing API key for ${pname}: set ${keyEnv} (no silent fallback)`);
  }
  const streamChat = adapterFor(pname, cfg);
  const budget = currentCostBudget();
  let model = opts.model ?? target.model;
  // Keyless local server with no model named (or 'auto'): ask it what is loaded.
  if (keyEnv === null && (!model || model === 'auto')) {
    model = await discoverLocalModel(baseUrl, opts.signal);
    opts = { ...opts, model };
  }
  // keyEnv null means there is no key and no bill: ollama and friends can never
  // charge. A --max-cost cap is not a meaningful guard against a model that
  // cannot spend, so it is skipped for this target instead of failing the whole
  // run closed on an unpriceable model. A billable endpoint (keyEnv set) is
  // untouched: an unpriced model there still stops the run.
  if (keyEnv === null) budget?.free(model);
  budget?.assert(model);
  let sawUsage = false;
  let sawOutput = false;
  let completed = false;
  try {
    for await (const ev of streamChat({ model: target.model, ...opts, apiKey, baseUrl })) {
      if (ev?.type === 'usage') {
        sawUsage = true;
        budget?.record(model, ev);
      } else if (ev?.type === 'text-delta' || ev?.type === 'tool-call') {
        sawOutput = true;
      } else if (ev?.type === 'done') {
        completed = true;
      }
      yield ev;
    }
  } finally {
    if (!sawUsage && (sawOutput || completed)) budget?.unknown(model);
  }
  budget?.assert();
}

export const testHooks = {
  createOpenAICompatParser,
  createAnthropicParser,
  createGeminiParser,
};
