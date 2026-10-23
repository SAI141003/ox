// The capability layer: ordered backend chains, selected by REAL probe.
//
// Adopted from the architecture of Panniantong/agent-reach (MIT) and
// implemented natively here. agent-reach's own framing is the part worth
// keeping, and the part worth refusing:
//
//   KEEP   "a capability layer, not another tool" -- 选型/安装/体检/路由
//          (select / install / health-check / route). ox already HAS the tools
//          (webFetchTool, webSearchTool); what it lacked is the layer that
//          decides which backend serves a call and says so when none can.
//   KEEP   "every platform = an ordered list of preferred + fallback backends;
//          changing the access route = reordering the list, not rewriting code."
//          That is exactly what the chain registry below is: addCapability(),
//          setBackendOrder() and nothing else. Reordering is data.
//   KEEP   "each channel really PROBES its candidate backends in order, not
//          just checks that the command exists; the first fully-usable one wins
//          and the broken ones come back with a prescription."
//   REFUSE the transport. agent-reach routes through yt-dlp, feedparser, the gh
//          CLI, browser-session reuse and mcporter. ox is zero-dependency Node:
//          there is no yt-dlp to reuse and no pip to install, so the whole layer
//          is the global fetch plus what src/mcp.js already speaks. The
//          channels that survive that constraint are named honestly in web.js;
//          the ones that need a binary are not simulated here.
//
// THE BUG THIS MODULE EXISTS TO PREVENT. src/local-inference.js already shipped
// the same shape twice: probeOrigin() once returned its *memo* record where
// callers were promised a *verdict*, so a negative came back as a truthy
// { identified:false } and `models` arrived as a number to code that called
// .map on it. A capability layer that hands back the wrong shape is worse than
// no layer, because the agent trusts it. So the two records here are
// structurally different values with different field names, they live under
// different cache key namespaces, and every cached value carries the literal
// `kind` tag that both the writer and the reader check. A reader that asks for
// the wrong kind gets null, never the other record.
//
// A VERDICT (probeCapability) answers "which backend serves this capability
// right now": it owns `live` (a scalar name) and `chain` (an ARRAY of probe
// records). A PROBE RECORD (probeBackend) answers "did this one backend just
// work": it owns `ok` (a boolean) and `code` (a scalar). Neither is ever
// substituted for the other.

// ---- bounds (all hard, all short) -------------------------------------------
// One request. The signal covers the body read too, so a server that sends
// headers and then trickles bytes is cut off at the same deadline.
export const PROBE_TIMEOUT_MS = 2_500;
// The whole ordered chain, so N dead backends cost one deadline rather than N
// timeouts.
export const CHAIN_DEADLINE_MS = 8_000;
// How long a chain verdict stays usable. Deliberately short: a network path that
// worked five minutes ago is evidence, not a fact.
export const VERDICT_TTL_MS = 300_000;
// A single backend's record outlives the verdict only slightly, so a backend
// that was skipped early in the walk is re-checked on the next walk.
export const PROBE_RECORD_TTL_MS = 120_000;

const PROBE_CACHE_MAX = 64;
const VERDICT_CACHE_MAX = 32;

// ---- the false-positive guard -----------------------------------------------
// A backend that answers 200 with a challenge page is NOT usable, and
// 200-with-HTML is the easiest way for a scraper to be fooled. These are the
// markers measured against the real endpoints ox tries (DuckDuckGo's anomaly
// modal, searx.be's browser interstitial, Cloudflare/Akamai interstitials, and
// the generic "enable javascript" shells). ONE list, used by every probe and by
// the scrapers themselves, so a backend cannot pass its own probe by checking
// less strictly than the layer does.
export const CHALLENGE_MARKERS = Object.freeze([
  /anomaly-modal/i,
  /anomaly\.js/i,
  /challenge-form/i,
  /challenge-platform/i,
  /cf-browser-verification/i,
  /just a moment/i,
  /verifying your browser/i,
  /enable javascript and cookies/i,
  /__cf_chl/i,
  /attention required!/i,
  /<title>\s*(access denied|forbidden|blocked)/i,
]);

export function looksLikeChallenge(text, { contentType = '' } = {}) {
  const body = String(text ?? '');
  if (!body) return false;
  // A JSON body cannot be a browser interstitial, and scanning it would only
  // produce false alarms on a result legitimately titled "Just a Moment".
  if (/json/i.test(contentType)) return false;
  return CHALLENGE_MARKERS.some((re) => re.test(body.slice(0, 8192)));
}

// ---- the usability policy, per capability kind ------------------------------
// This is the whole meaning of "the first FULLY usable backend wins": a
// response that parses, is the right shape, and carries real data. Not "it
// answered", not "the key is set", not "the binary exists".
const ASSESS = {
  search: (payload, { contentType = '' } = {}) => {
    // A backend that scrapes HTML hands back the body it got. The challenge check
    // lives HERE rather than only inside each scraper, because the failure this
    // guards against is precisely a scraper that believes its own success.
    if (typeof payload === 'string') {
      if (looksLikeChallenge(payload, { contentType })) {
        return { ok: false, code: 'challenge', detail: 'the response body is an anti-bot challenge page, not results' };
      }
      return {
        ok: false,
        code: 'no-results',
        detail: `answered with ${payload.length} bytes of unparsed text, which is not a result list`,
      };
    }
    const rows = Array.isArray(payload) ? payload : [];
    if (!rows.length) {
      return { ok: false, code: 'no-results', detail: 'answered, but the response carried zero result rows' };
    }
    const real = rows.filter((r) => /^https?:\/\//i.test(String(r?.url ?? '')));
    if (!real.length) {
      return { ok: false, code: 'no-results', detail: 'answered with rows that carry no http(s) URL' };
    }
    return { ok: true, code: 'ok', detail: `returned ${real.length} usable result row(s)` };
  },
  fetch: (payload) => {
    const doc = payload && typeof payload === 'object' ? payload : null;
    if (!doc || doc.ok !== true) {
      return {
        ok: false,
        code: doc?.kind === 'timeout' ? 'timeout' : doc?.kind === 'network' ? 'network' : 'http-error',
        detail: String(doc?.message ?? 'no document'),
      };
    }
    const body = String(doc.body ?? '');
    if (!body.trim()) {
      return { ok: false, code: 'empty', detail: `HTTP ${doc.status} with an empty body` };
    }
    if (looksLikeChallenge(body, { contentType: doc.contentType })) {
      return {
        ok: false,
        code: 'challenge',
        detail: `HTTP ${doc.status} but the body is an anti-bot challenge page, not the document`,
      };
    }
    return { ok: true, code: 'ok', detail: `HTTP ${doc.status}, ${doc.bytes} bytes of text` };
  },
};

// ---- capability registry -----------------------------------------------------
// A capability is a name, a kind (which usability policy applies) and an ORDERED
// list of backend names. Order is the whole configuration surface: preferring a
// different route is setBackendOrder(), never a code change.
const capabilities = new Map();

export function addCapability({ name, kind, description = '', order = [], backends = [] }) {
  if (!name || typeof name !== 'string') throw new Error('addCapability: name (string) is required');
  if (!ASSESS[kind]) throw new Error(`addCapability: unknown kind "${kind}"`);
  const previous = capabilities.get(name) ?? null;
  const names = new Set(previous ? previous.order : order);
  for (const b of backends) {
    if (b && typeof b.name === 'string' && b.name) names.add(b.name);
  }
  const merged = [...(previous ? previous.order : order), ...order].filter(
    (n, i, arr) => typeof n === 'string' && n && arr.indexOf(n) === i
  );
  // A backend registered after the order was frozen is appended rather than
  // ignored, so a new route is probed once instead of being invisible.
  for (const n of names) if (!merged.includes(n)) merged.push(n);
  capabilities.set(name, {
    name,
    kind,
    description,
    order: Object.freeze(merged),
  });
  return name;
}

export function getCapability(name) {
  return capabilities.get(String(name ?? '')) ?? null;
}

export function listCapabilities() {
  return [...capabilities.values()].map((c) => ({ ...c, order: [...c.order] }));
}

// "换接入方式 = 调整列表顺序" -- reordering is the supported way to change routes.
// A name that is not registered yet is still recorded, so an order can be staged
// before its backend exists; the walk filters unknowns out.
export function setBackendOrder(capability, order) {
  const cap = capabilities.get(String(capability ?? ''));
  if (!cap) return null;
  const wanted = (Array.isArray(order) ? order : []).map(String).filter(Boolean);
  cap.order = Object.freeze([...wanted, ...cap.order].filter((n, i, arr) => arr.indexOf(n) === i));
  return [...cap.order];
}

// ---- backend registry -------------------------------------------------------
// Backends are supplied by the owning module (web.js) through a source callback
// rather than imported, so the engine depends on no tool at all and a test can
// inject loopback backends without disturbing the real ones.
const backendRegistry = new Map();
let backendSource = null;

export function setBackendSource(fn) {
  backendSource = typeof fn === 'function' ? fn : null;
  return backendSource;
}

function allBackends() {
  const fromSource = backendSource ? backendSource() : [];
  const out = new Map();
  for (const b of Array.isArray(fromSource) ? fromSource : []) {
    if (b && typeof b.name === 'string' && b.name) out.set(b.name, b);
  }
  for (const [name, b] of backendRegistry) out.set(name, b);
  return out;
}

// Backends for ONE capability. The kind filter is load-bearing, not tidiness:
// web_search and web_fetch share one backend registry, and without it a fetch
// route is probed as though it were a search route -- which is how the first
// version of this file ended up asking r.jina.ai to return result rows.
function backendsForKind(kind) {
  const all = allBackends();
  if (!kind) return all;
  const out = new Map();
  for (const [name, b] of all) if ((b.kind ?? 'search') === kind) out.set(name, b);
  return out;
}

export function registerBackend(backend) {
  if (!backend || typeof backend !== 'object' || typeof backend.name !== 'string' || !backend.name) {
    throw new Error('registerBackend: backend.name (string) is required');
  }
  if (typeof backend.probe !== 'function') {
    throw new Error('registerBackend: backend.probe(opts) must be a function');
  }
  backendRegistry.set(backend.name, backend);
  return backend.name;
}

export function unregisterBackend(name) {
  return backendRegistry.delete(String(name ?? ''));
}

// Drop every INJECTED backend. The backend SOURCE (web.js's real backends) is
// untouched, so this is what a test needs to make a chain hermetic without
// touching the shipped registry -- and what a caller needs to undo a plugin
// registration wholesale.
export function clearBackends() {
  const n = backendRegistry.size;
  backendRegistry.clear();
  return n;
}

export function getBackend(name) {
  return allBackends().get(String(name ?? '')) ?? null;
}

export function listBackends({ capability } = {}) {
  if (!capability) return [...allBackends().values()];
  return orderedBackends(capability);
}

// ---- the cache: two namespaces, two kinds, one guard -------------------------
const probeCache = new Map();
const verdictCache = new Map();

export function recordProbeRecord(capability, backend, record) {
  const key = `probe:${capability}:${backend}`;
  probeCache.delete(key);
  probeCache.set(key, { kind: 'probe-record', at: Date.now(), record });
  while (probeCache.size > PROBE_CACHE_MAX) probeCache.delete(probeCache.keys().next().value);
  return record;
}

// Returns a PROBE RECORD or null. A kind mismatch is treated as absent AND
// evicted, so no caller can read a record through the wrong accessor.
export function cachedProbeRecord(capability, backend, { ttlMs = PROBE_RECORD_TTL_MS, now = Date.now() } = {}) {
  const key = `probe:${capability}:${backend}`;
  const hit = probeCache.get(key);
  if (!hit) return null;
  if (hit.kind !== 'probe-record' || now - hit.at > ttlMs) {
    probeCache.delete(key);
    return null;
  }
  return { ...hit.record, ageMs: now - hit.at };
}

export function recordVerdict(capability, verdict) {
  const key = String(capability ?? '');
  verdictCache.delete(key);
  verdictCache.set(key, { kind: 'capability-verdict', at: Date.now(), verdict });
  while (verdictCache.size > VERDICT_CACHE_MAX) verdictCache.delete(verdictCache.keys().next().value);
  return verdict;
}

// Returns a VERDICT or null, and only a verdict. This is the accessor a
// selection path uses, so a hit means "a real probe already confirmed this
// backend" -- never "a key is present", never a bare probe record.
export function cachedVerdict(capability, { ttlMs = VERDICT_TTL_MS, now = Date.now() } = {}) {
  const key = String(capability ?? '');
  const hit = verdictCache.get(key);
  if (!hit) return null;
  if (hit.kind !== 'capability-verdict' || now - hit.at > ttlMs) {
    verdictCache.delete(key);
    return null;
  }
  return { ...hit.verdict, ageMs: now - hit.at };
}

export function clearCapabilityCache() {
  probeCache.clear();
  verdictCache.clear();
}

// ---- fix lines ---------------------------------------------------------------
// A failure with no prescription is a dead end for the user, so every failure
// mode gets one. The prescription is a COMMAND or a REASON, never a guess: a 401
// means the key is wrong (a different fix from "no key"), and a challenge page
// means the route is script-hostile (a third fix).
function fixFor({ backend, envVar: recordEnvVar, capability, code, detail, configState }) {
  const envVar = recordEnvVar ?? (backend && typeof backend === 'object' ? backend.envVar ?? null : null);
  switch (code) {
    case 'not-configured':
      return `set ${envVar} to a valid key (export ${envVar}=...), or reorder the chain with setBackendOrder('${capability ?? ''}', [...])`;
    case 'unauthorized':
      return envVar
        ? `${envVar} is set but rejected with 401 — the key is invalid or out of quota: replace it`
        : 'the route answered 401 without a credential — it needs one; configure a keyed backend';
    case 'forbidden':
      return envVar
        ? `${envVar} is set but rejected with 403 — the key is not permitted to use this endpoint: replace it`
        : 'the route answered 403 to a credential-free request — it refuses scripts; configure a keyed backend';
    case 'challenge':
      return 'this route is hostile to scripts (anti-bot challenge) and cannot be used as an automated backend — use a keyed backend';
    case 'timeout':
      return 'the route did not answer within the probe budget — check connectivity, or move it later in the chain';
    case 'network':
      return 'no route to the host (DNS/TLS/offline) — fix connectivity, or move it later in the chain';
    case 'no-results':
      return 'the route answered but carried nothing usable — its index may not cover this query; move it later in the chain';
    case 'mcp-unavailable':
      return 'no MCP search tool is reachable — add one with `ox mcp add` and start a new session';
    case 'deadline':
      return 'the chain deadline passed before this backend was probed — raise CHAIN_DEADLINE_MS, or reorder so a working backend comes first';
    case 'aborted':
      return 'the probe was cancelled by the caller';
    default:
      return configState === 'keyless'
        ? 'keyless route that is not currently usable — configure a keyed backend'
        : `${envVar ?? 'its credential'} is set but the route failed (${String(detail ?? code).slice(0, 120)}) — check the key and the plan quota`;
  }
}

// ---- one real probe ----------------------------------------------------------
// configState is what makes "configured but broken" distinguishable from "never
// configured", the distinction the report is required to draw:
//   'keyless'        - needs no credential
//   'configured'     - its credential is present, so it MUST really be probed
//   'not-configured' - its credential is absent
// A missing credential is the ONE case where no request is issued, and only
// because the call could not be authenticated, so a request would buy latency
// and no information. Everything else is really probed: a backend with a key
// present, a keyless backend, and a PINNED backend all go on the wire. Selection
// never rests on a key merely being set.
export async function probeBackend(backend, {
  capability,
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal = null,
  force = false,
  now = Date.now(),
} = {}) {
  const name = String(backend?.name ?? '');
  const cap = getCapability(capability);
  const envVar = backend?.envVar ?? null;
  const configState = configStateFor(backend, env);

  if (!force) {
    const cached = cachedProbeRecord(capability, name, { now });
    if (cached) return cached;
  }

  const started = Date.now();
  const finish = (ok, code, detail, extra = {}) => {
    const record = {
      kind: 'probe-record',
      capability: String(capability ?? cap?.name ?? ''),
      backend: name,
      ok,
      code,
      detail: String(detail ?? '').slice(0, 300),
      configState,
      envVar,
      latencyMs: Date.now() - started,
      at: Date.now(),
      pinned: Boolean(backend?.pinned),
      ...extra,
    };
    // A prescription belongs only to an unsuccessful probe. Previously a
    // successful keyless route inherited failure text, making `ox doctor` say
    // "configure a keyed backend" beside a backend it had just proved usable.
    record.fix = ok ? null : fixFor(record);
    recordProbeRecord(capability ?? cap?.name ?? '', name, record);
    return record;
  };

  if (configState === 'not-configured' && backend?.requiresCredential !== false) {
    return finish(false, 'not-configured', `${envVar} is not set`, { skipped: 'no-credential' });
  }
  if (typeof backend.probe !== 'function') {
    return finish(false, 'unsupported', 'backend declares no probe function', { skipped: 'no-probe' });
  }

  const budget = Math.max(1, Number(timeoutMs) || PROBE_TIMEOUT_MS);
  const timer = AbortSignal.timeout(budget);
  const combined = signal ? combineSignals(signal, timer) : timer;
  let outcome;
  try {
    outcome = await backend.probe({ env, timeoutMs: budget, signal: combined, capability, backend, cap });
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (timer.aborted) return finish(false, 'timeout', `no usable response within ${budget}ms`, { status: 0 });
    return finish(false, classifyError(msg), msg, { status: 0 });
  }
  if (signal?.aborted) return finish(false, 'aborted', 'probe aborted by the caller', { status: 0 });
  if (!outcome || typeof outcome !== 'object') {
    return finish(false, 'unsupported', 'probe returned no result object', { status: 0 });
  }

  // The backend reports what happened; the capability's policy decides whether
  // that is USABLE. A backend cannot mark itself usable.
  const assessed = ASSESS[cap?.kind ?? backend.kind ?? 'search'](outcome.payload, {
    contentType: outcome.contentType ?? '',
  });
  const status = Number.isFinite(Number(outcome.status)) ? Number(outcome.status) : 0;
  if (assessed.ok) return finish(true, 'ok', assessed.detail, { status });
  // An HTTP status explains a failure better than a complaint about the body: a
  // 401 with zero rows is a REJECTED CREDENTIAL, not an index with no coverage,
  // and the two have different fixes. So the status is consulted first.
  if (assessed.code === 'challenge') return finish(false, 'challenge', assessed.detail, { status });
  if (status === 401) return finish(false, 'unauthorized', `HTTP 401: ${assessed.detail}`, { status });
  if (status === 403) return finish(false, 'forbidden', `HTTP 403: ${assessed.detail}`, { status });
  if (status >= 500) return finish(false, 'http-error', `HTTP ${status}: ${assessed.detail}`, { status });
  return finish(false, assessed.code, assessed.detail, { status });
}

function classifyError(msg) {
  const m = String(msg);
  // Challenge markers FIRST. A challenge page routinely arrives with 403 or 202,
  // and reporting that as a rejected credential sends the user to rotate a key
  // that was never the problem.
  if (/challenge|anomaly|verifying your browser|interstitial|cf-browser/i.test(m)) return 'challenge';
  const status = /\bHTTP (\d{3})\b/.exec(m);
  if (status) {
    if (status[1] === '401') return 'unauthorized';
    if (status[1] === '403') return 'forbidden';
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate|network error|fetch failed/i.test(m)) return 'network';
  if (/HTTP 4\d\d|HTTP 5\d\d/.test(m)) return 'http-error';
  return 'error';
}

function combineSignals(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const controller = new AbortController();
  const forward = (signal) => () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };
  for (const s of [a, b]) {
    if (s.aborted) {
      forward(s)();
      break;
    }
    s.addEventListener('abort', forward(s), { once: true });
  }
  return controller.signal;
}

// ---- the ordered walk --------------------------------------------------------
// First FULLY usable backend wins. Everything considered is kept in `chain`, in
// order, with the record that decided it, so a later caller (web_search's error
// path, `ox doctor`) can explain the whole walk without re-probing.
export async function probeCapability(capability, {
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  deadlineMs = CHAIN_DEADLINE_MS,
  pin = null,
  force = false,
  now = Date.now(),
  exhaustive = false,
} = {}) {
  const cap = getCapability(capability);
  if (!cap) {
    return {
      kind: 'capability-verdict',
      capability: String(capability ?? ''),
      live: null,
      code: 'unknown-capability',
      detail: `no such capability: ${capability}`,
      chain: [],
      tried: [],
      at: Date.now(),
      ttlMs: VERDICT_TTL_MS,
      elapsedMs: 0,
    };
  }

  const all = backendsForKind(cap.kind);
  const ordered = [];
  if (pin) {
    // A PIN collapses the chain to exactly one route, fallbacks included. That is
    // this tool's long-standing contract and the only safe reading of an
    // explicit choice: a user who pinned a backend and got a different vendor's
    // results instead has been misled, so a pinned failure is REPORTED, not
    // papered over with the next entry.
    ordered.push(all.get(String(pin)) ?? null);
  } else {
    for (const name of cap.order) {
      const b = all.get(name);
      if (b) ordered.push(b);
    }
    for (const [name, b] of all) {
      if (!ordered.some((x) => x.name === name)) ordered.push(b);
    }
  }

  const budgetMs = Math.max(1, Number(deadlineMs) || CHAIN_DEADLINE_MS);
  const deadlineAt = Date.now() + budgetMs;
  const chain = [];
  let live = null;
  let source = null;

  for (const backend of ordered) {
    if (!backend) {
      chain.push({
        kind: 'probe-record',
        capability: cap.name,
        backend: String(pin),
        ok: false,
        code: 'unknown-backend',
        detail: `"${pin}" is not a registered backend`,
        configState: 'unknown',
        fix: `known backends: ${cap.order.join(', ')}`,
        at: Date.now(),
        latencyMs: 0,
      });
      continue;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      chain.push({
        kind: 'probe-record',
        capability: cap.name,
        backend: backend.name,
        ok: false,
        code: 'deadline',
        detail: `the ${budgetMs}ms chain deadline passed before this backend was probed`,
        configState: 'untested',
        fix: fixFor({ backend, envVar: backend?.envVar ?? null, capability: cap.name, code: 'deadline', configState: 'untested' }),
        at: Date.now(),
        latencyMs: 0,
      });
      continue;
    }
    const record = await probeBackend(backend, {
      capability: cap.name,
      env,
      timeoutMs: Math.min(Math.max(1, Number(timeoutMs) || PROBE_TIMEOUT_MS), remaining),
      force,
      now,
    });
    chain.push(record);
    if (record.ok) {
      if (live === null) {
        live = record.backend;
        const position = ordered.indexOf(backend) + 1;
        source = record.pinned
          ? `pinned by OX_WEB_SEARCH_BACKEND, probed usable`
          : record.configState === 'keyless'
            ? `keyless backend "${record.backend}" probed usable (position ${position})`
            : `${record.envVar} is set and backend "${record.backend}" probed usable (position ${position})`;
      }
      // Selection stops at the first usable route. A REPORT does not: the doctor
      // job is to say which of the others are broken, and it cannot say that
      // about a backend it never asked. `exhaustive` is that difference, and it
      // costs nothing at selection time because selection never sets it.
      if (!exhaustive) break;
    }
  }

  const verdict = {
    kind: 'capability-verdict',
    capability: cap.name,
    // `live` is a scalar name or null. `chain` is the ARRAY of probe records.
    // A caller asking "what happened to backend X" reads chain, never live.
    live,
    code: live ? 'ok' : chain.length ? 'none-usable' : 'no-backends',
    detail: live
      ? source
      : chain.length
        ? `no backend in the ${chain.length}-entry chain was usable`
        : 'this capability has no registered backends',
    source,
    chain,
    tried: chain.map((r) => r.backend),
    at: Date.now(),
    ttlMs: VERDICT_TTL_MS,
    elapsedMs: chain.reduce((n, r) => n + (Number(r.latencyMs) || 0), 0),
  };
  recordVerdict(cap.name, verdict);
  return verdict;
}

// ---- selection ---------------------------------------------------------------
// The one function a tool calls. It consults the cached VERDICT first, so a
// working turn does not re-probe, and walks the chain only on a miss or a stale
// verdict. Honouring a cached verdict is safe precisely because a verdict is a
// real probe's result.
export async function selectBackend(capability, opts = {}) {
  const { env = process.env, ttlMs = VERDICT_TTL_MS, force = false, now = Date.now() } = opts;
  if (!force) {
    const hit = cachedVerdict(capability, { ttlMs, now });
    if (hit && hit.live) {
      const backend = getBackend(hit.live);
      if (backend) {
        return {
          ok: true,
          backend,
          live: hit.live,
          source: `${hit.source} (cached, verified ${hit.ageMs}ms ago)`,
          verdict: hit,
          cached: true,
        };
      }
    }
  }
  const verdict = await probeCapability(capability, { ...opts, env });
  if (!verdict.live) return { ok: false, verdict };
  const backend = getBackend(verdict.live);
  if (!backend) return { ok: false, verdict };
  return { ok: true, backend, live: verdict.live, source: verdict.source, verdict, cached: false };
}

// ---- the failure message -----------------------------------------------------
// "no search backend configured" is not an acceptable answer when four were
// tried. Every backend the walk considered is named, with the state that decided
// it, why it failed, and what to do about it.
export function explainChain(verdict, { header = null, trailer = null } = {}) {
  const cap = getCapability(verdict?.capability);
  const chain = Array.isArray(verdict?.chain) ? verdict.chain : [];
  const head = header ?? `${cap?.name ?? verdict?.capability}: no backend could serve this call.`;
  const lines = [`${head} ${chain.length} backend(s) considered, in chain order:`];
  let i = 0;
  for (const r of chain) {
    i += 1;
    const state = r.configState === 'configured'
      ? 'CONFIGURED-BROKEN'
      : r.configState === 'not-configured'
        ? 'NOT-CONFIGURED'
        : r.configState === 'keyless'
          ? 'KEYLESS-UNUSABLE'
          : String(r.configState ?? 'UNTESTED').toUpperCase();
    lines.push(`  ${i}. ${r.backend} [${state}] ${r.detail}`);
    if (r.fix) lines.push(`     fix: ${r.fix}`);
  }
  if (trailer) lines.push(trailer);
  return lines.join('\n');
}

// ---- the report `ox doctor` renders ------------------------------------------
// One row per capability naming the LIVE backend, with the failure classes kept
// apart on purpose: a backend whose credential is present and whose route is
// broken is a different problem from one nobody ever configured, and their fix
// lines differ. The classes are derived from the same `chain` the walk produced,
// so there is no second source of truth to drift.
export function capabilityReport({
  capabilities: wanted = null,
  env = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
  deadlineMs = CHAIN_DEADLINE_MS,
  force = false,
  now = Date.now(),
  probe = true,
  exhaustive = true,
} = {}) {
  const names = Array.isArray(wanted) && wanted.length ? wanted : [...capabilities.keys()];
  return Promise.all(
    names.map(async (name) => {
      const cap = getCapability(name);
      const verdict = probe ? await probeCapability(name, { env, timeoutMs, deadlineMs, force, now, exhaustive }) : null;
      return {
        capability: name,
        kind: cap?.kind ?? 'unknown',
        description: cap?.description ?? '',
        order: cap ? [...cap.order] : [],
        live: verdict?.live ?? null,
        source: verdict?.source ?? null,
        code: verdict?.code ?? 'not-probed',
        detail: verdict?.detail ?? null,
        chain: verdict?.chain ?? [],
        configuredBroken: (verdict?.chain ?? [])
          .filter((r) => r.configState === 'configured' && !r.ok)
          .map(({ backend, detail, code, fix }) => ({ backend, detail, code, fix })),
        neverConfigured: (verdict?.chain ?? [])
          .filter((r) => r.configState === 'not-configured')
          .map(({ backend, envVar, fix }) => ({ backend, envVar, fix })),
        keylessUnusable: (verdict?.chain ?? [])
          .filter((r) => r.configState === 'keyless' && !r.ok)
          .map(({ backend, detail, code, fix }) => ({ backend, detail, code, fix })),
        fix: verdictFix(verdict),
      };
    })
  );
}

function verdictFix(verdict) {
  if (!verdict) return 'not probed yet — run `ox doctor`';
  if (verdict.live) return null;
  // Broken-with-a-key is the first thing to fix: the user believes this route
  // works, and it does not.
  const broken = (verdict.chain ?? []).find((r) => r.configState === 'configured' && !r.ok);
  if (broken) return broken.fix;
  const missing = (verdict.chain ?? []).find((r) => r.configState === 'not-configured');
  if (missing) return missing.fix;
  const keyless = (verdict.chain ?? []).find((r) => r.configState === 'keyless' && !r.ok);
  if (keyless) return keyless.fix;
  return 'no backend is registered for this capability';
}
// ---- what selection and runtime fallback both need --------------------------
// Shared so the chain walk and a runtime failure describe a backend identically.
// A runtime failure record is the same shape as a probe record on purpose: one
// explainer renders both, so "the probe said X" and "the call said X" cannot be
// formatted two different ways.
// Whether a route NEEDS a credential. An optional credential does not make a
// route configured-or-not: marginalia carries MARGINALIA_API_KEY but works on
// its shared demo key, so calling it NOT-CONFIGURED both hid a keyless fallback
// and told the user to set a variable it did not need.
export function isKeylessRoute(backend) {
  return !backend?.envVar || backend?.requiresCredential === false;
}

export function configStateFor(backend, env = process.env) {
  if (isKeylessRoute(backend)) return 'keyless';
  const envVar = backend?.envVar ?? null;
  return env?.[envVar] ? 'configured' : 'not-configured';
}

export function fixForBackend(backend, code, { detail = '', configState = 'keyless', env } = {}) {
  return fixFor({ backend, code, detail, configState: configState ?? configStateFor(backend, env) });
}

// The backend objects in walk order, for a caller that wants to attempt the
// routes itself (web_fetch prefers to just try the first one).
export function orderedBackends(capability, { pin = null } = {}) {
  const cap = getCapability(capability);
  if (!cap) return [];
  const all = backendsForKind(cap.kind);
  if (pin) {
    const pinned = all.get(String(pin));
    return pinned ? [{ ...pinned, pinned: true }] : [];
  }
  const out = [];
  for (const name of cap.order) {
    const b = all.get(name);
    if (b) out.push(b);
  }
  for (const [name, b] of all) {
    if (!out.some((x) => x.name === name)) out.push(b);
  }
  return out;
}

// Drop a cached verdict whose live backend has just failed for real, so the next
// call re-probes instead of trusting a verdict this process knows to be stale.
export function invalidateVerdict(capability) {
  return verdictCache.delete(String(capability ?? ''));
}

// A host that a third-party reader service must never be told about. The
// fallback exists for public pages; handing it a loopback address, a link-local
// one or cloud metadata would leak an internal target to an outside service.
export function isPublicFetchTarget(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return false;
  // An IANA-reserved documentation name is not a real public page either.
  if (h === 'example.com' || h.endsWith('.example') || h.endsWith('.test') || h.endsWith('.invalid')) return false;
  return true;
}

// ---- what `ox doctor` renders -----------------------------------------------
// Doctor gets its OWN, tighter bounds than a tool call. A capability probe is
// network I/O, and a diagnostic command that can hang is worse than one that
// reports less: a user reaching for doctor is already stuck, so the one thing
// they cannot do is wait. These are hard caps on both the per-request and the
// per-chain clock, so `ox doctor` returns in bounded time no matter what
// upstream is doing.
export const DOCTOR_PROBE_TIMEOUT_MS = 2_000;
export const DOCTOR_CHAIN_DEADLINE_MS = 4_000;

// Structured rows, deliberately not strings: cli.js owns the colour, and a test
// needs to assert on the data rather than on ANSI escapes. `state` is the
// distinction the report is required to draw, kept as a first-class field so it
// cannot be flattened back into "reachable: yes".
const STATE_LABEL = {
  ok: 'LIVE',
  configured: 'CONFIGURED-BROKEN',
  'not-configured': 'NOT-CONFIGURED',
  keyless: 'KEYLESS-UNUSABLE',
  untested: 'UNTESTED',
  unknown: 'UNKNOWN',
};

export function doctorCapabilityRows(reports) {
  return (Array.isArray(reports) ? reports : []).map((r) => {
    const backends = (r.chain ?? []).map((b) => ({
      name: b.backend,
      state: b.ok ? 'ok' : (b.configState ?? 'untested'),
      label: b.ok ? STATE_LABEL.ok : (STATE_LABEL[b.configState] ?? String(b.configState ?? 'UNTESTED').toUpperCase()),
      ok: Boolean(b.ok),
      code: b.code ?? null,
      detail: b.detail ?? '',
      latencyMs: Number(b.latencyMs) || 0,
      configState: b.configState ?? 'untested',
      envVar: b.envVar ?? null,
      pinned: Boolean(b.pinned),
      runtime: Boolean(b.runtime),
      fix: b.fix ?? null,
    }));
    return {
      capability: r.capability,
      ok: Boolean(r.live),
      live: r.live ?? null,
      source: r.source ?? null,
      headline: r.live
        ? `${r.capability}: live backend "${r.live}" (${r.source})`
        : `${r.capability}: NO live backend — every route in the chain failed`,
      detail: r.detail ?? null,
      fix: r.fix ?? null,
      backends,
      // Kept separate rather than merged into `backends`, because "you gave me a
      // key and it does not work" and "you never gave me a key" are different
      // problems with different fixes.
      configuredBroken: r.configuredBroken ?? [],
      neverConfigured: r.neverConfigured ?? [],
      keylessUnusable: r.keylessUnusable ?? [],
    };
  });
}

// The one-line summary a script or an agent reads first.
export function capabilityHeadline(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const live = list.filter((r) => r.ok).map((r) => r.live);
  const dead = list.filter((r) => !r.ok);
  if (!dead.length) return `capabilities: ${live.join(', ')} (${live.length}/${list.length} live)`;
  return (
    `capabilities: ${live.length}/${list.length} live (${live.join(', ') || 'none'}) — ` +
    `no live backend: ${dead.map((r) => r.capability).join(', ')}`
  );
}
