// Guards that keep one run from wasting itself (ideas from Rerun's engine,
// rerun-build/rerun; written here for ox):
//
//  * Host breaker: a website that refused three times in a row (an error, a
//    timeout, 401/403/407/429/5xx) is closed for the rest of the run, for
//    web_fetch and for curl/wget in bash alike. Rerun saw a helper loop for 34
//    minutes on a source that answered 403 to every tool and user agent.
//  * Bot wall: a Cloudflare/DataDome/PerimeterX challenge page is not the page.
//    The model is told so (and where to go instead) rather than summarising
//    "Just a moment…" as if it were the content.
//  * Tool-call repair: many OpenAI-compatible models send an omitted optional
//    argument as an explicit null; dropping those keys turns the call that
//    would be refused into the call the model meant, with no round trip.

export const HOST_FAILURE_THRESHOLD = 3;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>|;&)]+/gi;
const HTTP_FAILURE_IN_OUTPUT = /\bHTTP\/[0-9.]+\s+(401|403|407|429|5\d\d)\b|\bERROR (401|403|407|429|5\d\d)\b|\bcurl: \((6|7|28|35|52|56)\)|\bstatus(?: code)?:? (401|403|407|429|5\d\d)\b/i;

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; }
}

/** The hosts a shell command reaches by URL (curl, wget, http …). */
export function hostsOf(text) {
  const hosts = new Set();
  for (const m of String(text ?? '').matchAll(URL_IN_TEXT)) { const h = hostOf(m[0]); if (h) hosts.add(h); }
  return [...hosts];
}

export class HostBreaker {
  constructor() { this.failures = new Map(); }
  record(host, ok) { const n = ok ? 0 : (this.failures.get(host) ?? 0) + 1; this.failures.set(host, n); return n; }
  isClosed(host) { return (this.failures.get(host) ?? 0) >= HOST_FAILURE_THRESHOLD; }
  closedMessage(host) {
    return `Source closed for this run: ${host} refused ${HOST_FAILURE_THRESHOLD} attempts in a row (errors, timeouts or a 4xx/5xx status). It is not tried again in this run, with any tool. Move on to another source, and say ${host} was unavailable.`;
  }
}

// One breaker per run: keyed by the run's shared state (or its abort signal).
const breakers = new WeakMap();
export function breakerFor(ctx) {
  const key = (ctx?.sessionState && typeof ctx.sessionState === 'object' && ctx.sessionState) || ctx?.signal || ctx;
  if (!key || typeof key !== 'object') return new HostBreaker();
  let b = breakers.get(key);
  if (!b) { b = new HostBreaker(); breakers.set(key, b); }
  return b;
}

// Challenge pages are short and carry their vendor's marks; real pages that
// merely embed the vendor's script are far longer, so the mark alone is not enough.
const WALLS = [
  { re: /just a moment\.\.\.|checking (if the site connection is secure|your browser)|cf-chl|challenge-platform|attention required! \| cloudflare|enable javascript and cookies to continue/i, vendor: 'Cloudflare', clears: true },
  { re: /datadome|captcha-delivery\.com/i, vendor: 'DataDome', clears: false },
  { re: /px-captcha|perimeterx|press (?:&|and) hold/i, vendor: 'PerimeterX', clears: false },
  { re: /\bverify you are (a )?human\b|are you a robot|unusual traffic from your computer|hcaptcha|g-recaptcha|turnstile/i, vendor: 'a captcha', clears: false },
  { re: /access denied[\s\S]{0,200}(reference #|errors\.edgesuite\.net)|request unsuccessful\. incapsula/i, vendor: 'Akamai/Imperva', clears: false },
];
export function botWall(text) {
  const t = String(text ?? '');
  if (t.length > 3000) return null;
  const w = WALLS.find((x) => x.re.test(t));
  return w ? { vendor: w.vendor, clearsByItself: w.clears } : null;
}
export function botWallNote(wall, host) {
  return `This is ${wall.vendor}'s bot-protection page${host ? ` on ${host}` : ''}, not the content: do not summarise it. ${wall.clearsByItself ? 'It usually clears in a real browser after a few seconds: ' : ''}open it with the browser tool (it renders like a person and waits out the check), or use another source.`;
}

/** Drop null-valued arguments the schema does not require (a model's way of saying "not given"). */
export function repairArgs(args, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const need = new Set(required);
  let out = null;
  for (const [k, v] of Object.entries(args)) {
    if (v === null && !need.has(k)) { out ??= { ...args }; delete out[k]; }
  }
  return out ?? args;
}

/**
 * Around one tool call: refuse a host already closed this run, run the tool,
 * then count its result for every host it touched and flag a bot wall.
 * run() → { content, isError }. Only web_fetch and shell commands are watched.
 */
export async function guardCall(name, args, ctx, run) {
  const hosts = name === 'web_fetch' ? [hostOf(args?.url)].filter(Boolean)
    : (name === 'bash' || name === 'run_command') && /\b(curl|wget|http|xh|lynx)\b/.test(String(args?.command ?? '')) ? hostsOf(args?.command)
    : [];
  if (!hosts.length) return run();
  const breaker = breakerFor(ctx);
  const closed = hosts.find((h) => breaker.isClosed(h));
  if (closed) return { content: breaker.closedMessage(closed), isError: true };
  const out = await run();
  const text = String(out?.content ?? '');
  const wall = name === 'web_fetch' ? botWall(text) : null;
  const failed = !!wall || (name === 'web_fetch' ? out?.isError === true : HTTP_FAILURE_IN_OUTPUT.test(text));
  const notes = [];
  if (wall) notes.push(botWallNote(wall, hosts[0]));
  for (const h of hosts) {
    const n = breaker.record(h, !failed);
    if (n >= HOST_FAILURE_THRESHOLD) notes.push(breaker.closedMessage(h));
    else if (n > 0) notes.push(`[attempt ${n}/${HOST_FAILURE_THRESHOLD} on ${h} failed in this run]`);
  }
  return notes.length ? { ...out, content: `${text}\n\n${notes.join('\n')}` } : out;
}
