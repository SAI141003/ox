// Fewer handshakes. Node's fetch keeps a connection open only ~4 s after a
// request, and an agent's tool calls usually take longer than that between two
// model requests, so each turn paid a new TCP + TLS setup (50-200 ms). ox keeps
// connections to a provider open for a minute instead, with no extra package:
// the pool Node's fetch already uses, rebuilt with a longer keep-alive.
// `prewarm` opens the connection to the provider while you are still typing.

const KEY = Symbol.for('undici.globalDispatcher.1');
let tuned = false;

/** Keep fetch connections open longer. Safe to call more than once; a no-op where Node does not allow it. */
export async function tuneFetch({ keepAliveTimeout = 60_000, keepAliveMaxTimeout = 300_000 } = {}) {
  if (tuned || process.env.OX_NET_TUNE === '0') return tuned;
  try {
    let d = globalThis[KEY];
    if (!d) {
      // The pool exists after the first fetch; make one that never leaves the machine.
      await fetch('data:,').catch(() => {});
      d = globalThis[KEY];
    }
    const Agent = d?.constructor;
    if (typeof Agent !== 'function' || Agent.name !== 'Agent') return false;
    globalThis[KEY] = new Agent({ keepAliveTimeout, keepAliveMaxTimeout, connections: 16 });
    tuned = true;
  } catch {}
  return tuned;
}

const warmed = new Map();
/** Open the TCP + TLS connection to `url`'s host now (a HEAD request, answer ignored), at most once a minute. */
export function prewarm(url, { now = Date.now() } = {}) {
  let origin;
  try { origin = new URL(url).origin; } catch { return false; }
  if (!/^https:/.test(origin) || (warmed.get(origin) ?? 0) > now - 60_000) return false;
  warmed.set(origin, now);
  fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => {});
  return true;
}

/** The API host a bot talks to, for prewarm (null for local models and plans run through a CLI). */
export function originOf(target) {
  if (!target || target.provider === 'subscription') return null;
  if (target.baseUrl) return target.baseUrl;
  const known = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com', openrouter: 'https://openrouter.ai', gemini: 'https://generativelanguage.googleapis.com', xai: 'https://api.x.ai', groq: 'https://api.groq.com', deepseek: 'https://api.deepseek.com', mistral: 'https://api.mistral.ai' };
  return known[target.provider] ?? null;
}
