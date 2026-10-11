/**
 * ox models API — one JSON surface for every UI that needs to show,
 * connect, or switch models.
 *
 * Read-only aggregator over the modules that already own the truth:
 *   - src/bots.js      → bot registry (id, provider, model, desc)
 *   - src/cost.js      → PRICING table ($/Mtok in/out + context window)
 *   - src/local-inference.js → scanLocalEndpoints / trust records
 *
 * No new state, no writes, no network beyond what scanLocalEndpoints
 * already does. UIs (desktop, platform, serve) consume this instead of
 * re-deriving availability themselves.
 */

import { BOTS, KEY_ENV, PROVIDERS } from './bots.js';
import { PRICING } from './cost.js';
import {
  LOCAL_ORIGINS,
  scanLocalEndpoints,
  listApprovedEndpoints,
  isEndpointApproved,
  readTrustRecords,
} from './local-inference.js';

/**
 * Every provider ox knows, with key status from this environment.
 * @returns {Array<{provider,keyEnv,hasKey,keyless,botCount}>}
 */
export function listProviders({ env = process.env } = {}) {
  return PROVIDERS.map((provider) => {
    const keyEnv = KEY_ENV[provider] ?? null;
    const hasKey = keyEnv == null ? true : Boolean(env[keyEnv]);
    const botCount = Object.values(BOTS).filter((b) => b.provider === provider).length;
    return { provider, keyEnv, hasKey, keyless: keyEnv == null, botCount };
  });
}

/**
 * Every bot in the registry with pricing + availability resolved.
 * Mirrors serveModelCatalog() shape but adds pricing + local flag so UIs
 * need exactly one call.
 * @returns {{models:Array, withheld:Array}}
 */
export function listModels({ env = process.env } = {}) {
  const models = [];
  const withheld = [];
  for (const [id, def] of Object.entries(BOTS)) {
    const keyEnv = KEY_ENV[def.provider] ?? null;
    const hasKey = keyEnv == null ? true : Boolean(env[keyEnv]);
    if (!def.model) {
      withheld.push({
        id,
        provider: def.provider,
        requires_key: keyEnv,
        reason: 'no_default_model',
        detail: `${def.desc} — request it as '${id}:<model>'`,
      });
      continue;
    }
    const price = PRICING[def.model] ?? null;
    models.push({
      id,
      provider: def.provider,
      model: def.model,
      desc: def.desc,
      requires_key: keyEnv,
      hasKey,
      available: hasKey,
      availability: 'credentials-only',
      keyless: keyEnv == null,
      pricing: price ? { in: price.in, out: price.out, window: price.window ?? null } : null,
      unpriced: !price,
    });
  }
  return { models, withheld };
}

/**
 * Scan loopback origins for local model servers (Ollama / llama.cpp /
 * vLLM / LM Studio) plus persisted trust records.
 * Never throws: probe failures yield an empty `found` list with the
 * error surfaced per-origin.
 */
export async function listLocalEndpoints(opts = {}) {
  let found = [];
  let error = null;
  try {
    found = await scanLocalEndpoints(opts);
  } catch (err) {
    error = String(err?.message ?? err);
    found = [];
  }
  const approved = listApprovedEndpoints();
  const records = readTrustRecords();
  const withTrust = found.map((f) => ({
    ...f,
    approved: isEndpointApproved(f.baseUrl),
  }));
  return {
    found: withTrust,
    approved,
    trustRecords: records,
    origins: LOCAL_ORIGINS.map((o) => o.origin),
    error,
  };
}

export { LOCAL_ORIGINS };
