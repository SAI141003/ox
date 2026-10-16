// Your own model endpoints: any OpenAI-compatible server (vLLM, llama.cpp,
// LM Studio on another machine, a company gateway, OpenRouter-style proxies).
// Each is a named bot in ~/.ox/config.json (`bots.<name>`, provider custom)
// with its own key in ~/.ox/keys.json (OX_EP_<NAME>_KEY, 0600), so it works the
// same from the terminal (`ox --bot <name>`), the app and the island.
import { readConfigDoc, saveConfigDoc } from './config.js';
import { setKey, keyStatus } from './keystore.js';
import { isPrivateUrl } from './bots.js';

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
export const keyEnvFor = (name) => `OX_EP_${String(name).toUpperCase().replace(/-/g, '_')}_KEY`;

export function listEndpoints(env = process.env) {
  const bots = readConfigDoc().bots ?? {};
  return Object.entries(bots)
    .filter(([, d]) => d && d.provider === 'custom' && d.baseUrl)
    .map(([name, d]) => ({ name, baseUrl: d.baseUrl, model: d.model ?? null, desc: d.desc ?? '', key: d.keyEnv ? keyStatus(d.keyEnv, env) : { set: false } }));
}

function checkUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { throw new Error('the endpoint URL is not a URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('the endpoint URL must be http or https');
  if (url.protocol === 'http:' && !isPrivateUrl(url.href)) throw new Error('use https for an endpoint that is not on this machine or your network');
  return url.href.replace(/\/$/, '');
}

export function saveEndpoint({ name, baseUrl, model = null, key = null, desc = '' } = {}, env = process.env) {
  if (!NAME.test(String(name))) throw new Error('a name is 2–31 lowercase letters, digits or dashes, starting with a letter');
  const base = checkUrl(baseUrl);
  const keyEnv = keyEnvFor(name);
  saveConfigDoc((doc) => {
    doc.bots = doc.bots && typeof doc.bots === 'object' ? doc.bots : {};
    const prior = doc.bots[name];
    if (prior && prior.provider !== 'custom') throw new Error(`'${name}' is already a bot of another kind`);
    doc.bots[name] = { provider: 'custom', baseUrl: base, ...(model ? { model: String(model) } : {}), keyEnv, desc: String(desc || `your endpoint at ${new URL(base).host}`).slice(0, 120) };
  });
  if (typeof key === 'string' && key.trim()) setKey(keyEnv, key.trim(), { env });
  return listEndpoints(env);
}

export function removeEndpoint(name, env = process.env) {
  let had = false;
  saveConfigDoc((doc) => {
    if (doc.bots?.[name]?.provider === 'custom') { delete doc.bots[name]; had = true; }
  });
  if (!had) throw new Error(`no endpoint '${name}'`);
  try { setKey(keyEnvFor(name), null, { env }); } catch {}
  return listEndpoints(env);
}

// Is it there, and which models does it serve? GET <base>/models.
export async function testEndpoint({ baseUrl, key = null, name = null } = {}, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = checkUrl(baseUrl);
  const k = key || (name ? env[keyEnvFor(name)] : null);
  const t0 = Date.now();
  let r;
  try {
    r = await fetchImpl(`${base}/models`, { headers: k ? { Authorization: `Bearer ${k}` } : {}, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { ok: false, error: `could not reach ${base} (${e.cause?.code ?? e.message})` };
  }
  const ms = Date.now() - t0;
  if (r.status === 401 || r.status === 403) return { ok: false, ms, error: 'it answered, but refused the key' };
  if (!r.ok) return { ok: false, ms, error: `it answered ${r.status} for /models` };
  let data = {};
  try { data = await r.json(); } catch {}
  const models = (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map((m) => m.id ?? m.name).filter(Boolean).slice(0, 200);
  return { ok: true, ms, models };
}
