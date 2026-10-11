import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, readConfigDoc, saveConfigDoc } from './config.js';

export const LOCAL_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Local model discovery
//
// THE DETECTION CONTRACT. A candidate endpoint is IDENTIFIED only when all
// three of these hold:
//
//   1. an HTTP response arrives inside the timeout (so it is not a dead port),
//   2. the status is 2xx, and
//   3. the JSON body matches that protocol's fingerprint -- a REQUIRED field,
//      not merely "the socket answered".
//
// A socket that answers 404, 500, HTML, or `{}` is NOT identified as anything.
// This contract exists because the previous detector was
// `execSync('curl -s http://localhost:8080/api/tags')`: curl exits 0 on HTTP
// 404 and 500 alike, so ANY process listening on 11434/8080/8000/1234 was
// reported as a working local model server. The `ollama --version` check was no
// better -- it proved a binary was on PATH, never that a daemon was listening.
//
// WHAT POSITIVE IDENTIFICATION DOES NOT DO. It raises the bar from "a socket
// answered" to "the process speaks this protocol". A malicious program that
// deliberately returns a well-formed `/api/version` still identifies as Ollama.
// Loopback discovery cannot cryptographically prove who is answering. See
// APPROVAL below and the residual-risk note in the module docs.
//
// THE BOUNDS, in three layers, all short:
//   * DEFAULT_PROBE_TIMEOUT_MS bounds ONE request (the AbortSignal covers the
//     body read too, so a server that sends headers then trickles bytes is cut
//     off at the same deadline),
//   * every origin in a scan is probed CONCURRENTLY, so four dead ports cost one
//     timeout rather than four, and
//   * DEFAULT_SCAN_DEADLINE_MS bounds the scan as a whole. A deadline overrun
//     returns the endpoints positively identified SO FAR -- it never pads the
//     result with a guess.
// ---------------------------------------------------------------------------

export const DEFAULT_PROBE_TIMEOUT_MS = 700;
export const DEFAULT_SCAN_DEADLINE_MS = 2500;
export const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

// How long an in-process probe MEMO stays usable by a synchronous caller. The
// memo exists so `isReachable` can prefer a fact it verified over an assertion
// the user typed, without doing network I/O in a sync routing path. It is
// deliberately short: a daemon started 40s ago is a different world.
export const PROBE_MEMO_TTL_MS = 30_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// Port conventions, not guarantees. We report the PROTOCOL we positively
// identified and the display name conventionally associated with that port; if
// something else answers in Ollama's shape we say "Ollama-compatible" and keep
// the version it reported, so a later scan can detect it changed.
export const LOCAL_ORIGINS = Object.freeze([
  { origin: 'http://localhost:11434', conventional: 'Ollama' },
  { origin: 'http://localhost:8080', conventional: 'llama.cpp' },
  { origin: 'http://localhost:8000', conventional: 'vLLM' },
  { origin: 'http://localhost:1234', conventional: 'LM Studio' },
]);

const OLLAMA_ORIGIN = 'http://localhost:11434';
export const OLLAMA_PRESET_MODEL = 'qwen2.5:0.5b';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Canonical key for a local endpoint. Loopback aliases collapse to one key so
// that an approval given for `127.0.0.1:11434` also covers `localhost:11434`:
// those names bind the same socket, and two separate trust records for one port
// would be confusing at best and misleading at worst. A path (`/v1`) and a
// trailing slash are stripped, because we key on origin, not on a request path.
export function normalizeEndpointUrl(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  // A bare all-digits authority is a PORT, not a host: WHATWG URL parsing would
  // turn `http://11434` into the numeric-IPv4 address 0.0.44.170, which both
  // looks plausible and silently fails to match the real record. Read it as
  // `localhost:11434`, which is what a user typing a port means.
  if (/^\d+$/.test(raw)) return `http://localhost:${raw}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  // Same trap after scheme stripping, e.g. `11434/v1`.
  if (/^\d+(\/.*)?$/.test(raw.replace(/^http:\/\//, ''))) {
    const port = raw.replace(/^http:\/\//, '').split('/')[0];
    return `http://localhost:${port}`;
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) ? 'localhost' : u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${host}:${port}`;
}

export function formatModelSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// One bounded GET. Returns the parsed JSON body, or null for every failure mode
// (connection refused, timeout, non-2xx, unparseable). Callers must treat null
// as "not identified" -- never as "empty result".
async function getJson(url, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// The probe memo -- the one place a live answer outlives the call that made it.
//
// probeOrigin() knows the truth. isReachable(), one layer up in
// model-registry.js, is SYNCHRONOUS and cannot ask. Without a memo it has to
// choose between "reachability" and "the user exported a variable", and the old
// code chose the variable -- an assertion about a fact nothing had checked.
//
// So every probe deposits its verdict here, keyed by canonical origin, and the
// sync caller reads it back. Read-only for consumers: only probeOrigin writes.
// A memo older than PROBE_MEMO_TTL_MS is dropped rather than trusted, and a
// NEGATIVE memo is remembered too -- "I looked at 11434 and it was not there"
// is exactly the evidence that outranks a stale OX_OLLAMA_AVAILABLE=1.
// ---------------------------------------------------------------------------

const PROBE_MEMO_MAX_ENTRIES = 32;
const probeMemo = new Map();

export function recordProbeMemo(baseUrl, verdict) {
  const key = normalizeEndpointUrl(baseUrl);
  if (!key) return null;
  // Refresh insertion order so the oldest key is also the first evicted.
  probeMemo.delete(key);
  probeMemo.set(key, {
    baseUrl: key,
    at: Date.now(),
    identified: Boolean(verdict),
    protocol: verdict?.protocol ?? null,
    version: verdict?.version ?? null,
    models: Array.isArray(verdict?.models) ? verdict.models.length : 0,
  });
  while (probeMemo.size > PROBE_MEMO_MAX_ENTRIES) {
    probeMemo.delete(probeMemo.keys().next().value);
  }
  return probeMemo.get(key);
}

// The fresh memo for one origin, or null (unknown / stale). Never invents a
// verdict: absence of a memo is not evidence of anything.
export function getProbeMemo(baseUrl, { ttlMs = PROBE_MEMO_TTL_MS, now = Date.now() } = {}) {
  const key = normalizeEndpointUrl(baseUrl);
  if (!key) return null;
  const hit = probeMemo.get(key);
  if (!hit) return null;
  if (now - hit.at > ttlMs) {
    probeMemo.delete(key);
    return null;
  }
  return { ...hit, ageMs: now - hit.at };
}

// ---------------------------------------------------------------------------
// Model-list parsing. Pure and defensive: these receive whatever a local process
// decided to send, so every field is optional-checked and a malformed body
// yields [] rather than a throw or a phantom model.
// ---------------------------------------------------------------------------

// Ollama GET /api/tags -> { models: [{ name, model, size, details }] }
export function parseOllamaTags(body) {
  if (!isObject(body) || !Array.isArray(body.models)) return [];
  const out = [];
  for (const m of body.models) {
    if (!isObject(m)) continue;
    const name = String(m.name ?? m.model ?? '').trim();
    if (!name) continue;
    const sizeBytes = Number.isFinite(Number(m.size)) ? Number(m.size) : null;
    out.push({
      name,
      sizeBytes,
      size: formatModelSize(sizeBytes),
      family: isObject(m.details) ? (m.details.family ?? null) : null,
      parameterSize: isObject(m.details) ? (m.details.parameter_size ?? null) : null,
      quantization: isObject(m.details) ? (m.details.quantization_level ?? null) : null,
    });
  }
  return out;
}

// OpenAI-compatible GET /v1/models -> { object: 'list', data: [{ id, ... }] }
export function parseOpenAIModels(body) {
  if (!isObject(body) || !Array.isArray(body.data)) return [];
  const out = [];
  for (const m of body.data) {
    if (!isObject(m)) continue;
    const name = String(m.id ?? m.name ?? '').trim();
    if (!name) continue;
    const sizeBytes = Number.isFinite(Number(m.size)) ? Number(m.size) : null;
    out.push({ name, sizeBytes, size: formatModelSize(sizeBytes) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function normalizeProbeTarget(target) {
  if (isObject(target)) {
    return {
      origin: normalizeEndpointUrl(target.baseUrl ?? target.base_url ?? target.origin),
      protocol: target.protocol ?? null,
    };
  }
  return { origin: normalizeEndpointUrl(target), protocol: null };
}

// Real model listing against a live endpoint. `target` is either an origin
// string ("localhost:11434") or a discovered record. Never throws.
export async function listModels(target, { timeoutMs = 2000 } = {}) {
  const { origin, protocol } = normalizeProbeTarget(target);
  if (!origin) return [];
  // Ollama is asked its native endpoint; anything else is asked the
  // OpenAI-compatible one, which is the only list surface they all share.
  const ollama = protocol === 'ollama';
  const url = `${origin}${ollama ? '/api/tags' : '/v1/models'}`;
  const body = await getJson(url, { timeoutMs });
  if (!body) return [];
  return ollama ? parseOllamaTags(body) : parseOpenAIModels(body);
}

// Probe one origin for a positive identification. Tries the Ollama fingerprint
// first (it is the more specific one, and Ollama also answers /v1/models, so
// checking the generic one first would mislabel every Ollama install as
// "openai-compatible").
export async function probeOrigin(origin, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, withModels = true } = {}) {
  const base = normalizeEndpointUrl(origin);
  if (!base) return null;

  const versionBody = await getJson(`${base}/api/version`, { timeoutMs });
  const version = isObject(versionBody) && typeof versionBody.version === 'string' && versionBody.version.trim()
    ? versionBody.version.trim()
    : null;
  // The verdict and the memo are DIFFERENT records and must never be conflated.
  // The verdict is the full discovery result: displayName/runtime/port, and
  // `models` as an ARRAY, because callers iterate it (cli.js `f.models.map(...)`).
  // The memo is the compact synchronous snapshot getProbeMemo() hands to
  // isReachable(), where `models` is a COUNT on purpose -- a sync reader wants
  // "how many", not the model objects.
  //
  // Returning recordProbeMemo()'s memo record here leaked the compact shape into
  // every caller: a negative came back as a truthy { identified:false } object
  // where the contract promises null (so scanLocalEndpoints() reported
  // unidentified sockets as findings and backend detect() called every backend
  // live), and a positive lost displayName/runtime and carried `models` as a
  // number, crashing cli.js on f.models.map. Record the memo; return the verdict.
  if (version) {
    const verdict = {
      identified: true,
      protocol: 'ollama',
      runtime: 'ollama',
      displayName: 'Ollama',
      baseUrl: base,
      port: Number(new URL(base).port || 0),
      version,
      models: withModels ? await listModels({ baseUrl: base, protocol: 'ollama' }, { timeoutMs: Math.max(timeoutMs, 2000) }) : [],
    };
    recordProbeMemo(base, verdict);
    return verdict;
  }

  const modelsBody = await getJson(`${base}/v1/models`, { timeoutMs });
  if (isObject(modelsBody) && Array.isArray(modelsBody.data)) {
    const conv = LOCAL_ORIGINS.find(o => o.origin === base);
    const verdict = {
      identified: true,
      protocol: 'openai-compat',
      runtime: 'openai-compat',
      displayName: conv ? conv.conventional : 'OpenAI-compatible server',
      baseUrl: base,
      port: Number(new URL(base).port || 0),
      version: typeof modelsBody.version === 'string' ? modelsBody.version : null,
      models: withModels ? parseOpenAIModels(modelsBody) : [],
    };
    recordProbeMemo(base, verdict);
    return verdict;
  }

  // A socket answered but nothing identified it. Deliberately recorded as NOT
  // identified rather than guessed at -- that guess is the bug this module
  // replaces -- and the negative is memoized, because a checked negative is
  // worth more to a later synchronous caller than a hopeful env var. The memo
  // is evidence ABOUT the probe; it is not a finding. The return value still
  // honours the contract: null, which is what lets scanLocalEndpoints() filter
  // this origin out instead of reporting it.
  recordProbeMemo(base, null);
  return null;
}

// Probe every known origin CONCURRENTLY. One slow port cannot delay the others,
// and every request carries its own timeout, so a dead port costs one timeout
// rather than a hang.
export async function scanLocalEndpoints({
  origins = LOCAL_ORIGINS.map(o => o.origin),
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  deadlineMs = DEFAULT_SCAN_DEADLINE_MS,
  withModels = true,
} = {}) {
  const list = (Array.isArray(origins) ? origins : []).map(normalizeEndpointUrl).filter(Boolean);
  const budget = Number.isFinite(Number(deadlineMs)) ? Math.max(0, Number(deadlineMs)) : DEFAULT_SCAN_DEADLINE_MS;
  const deadlineAt = Date.now() + budget;
  // Every origin starts at once and is handed whatever time is left, so the
  // scan cannot take N x timeout: one shared wall clock, N parallel probes.
  const results = new Array(list.length).fill(null);
  const work = list.map((o, i) => {
    const remaining = Math.max(1, deadlineAt - Date.now());
    return probeOrigin(o, { timeoutMs: Math.min(timeoutMs, remaining), withModels })
      .then(r => { results[i] = r; return r; })
      .catch(() => null);
  });
  let timer = null;
  await Promise.race([
    Promise.all(work),
    new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now())); }),
  ]);
  if (timer) clearTimeout(timer);
  // A deadline overrun yields exactly what was positively identified so far.
  const found = results.filter(Boolean);
  // One endpoint, one record: if two origins normalize to the same key keep the
  // first (they are the same endpoint).
  const seen = new Set();
  return found.filter(f => {
    if (seen.has(f.baseUrl)) return false;
    seen.add(f.baseUrl);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Trust records -- "the user agreed to send prompts here".
//
// A discovered endpoint is NEVER used until the user approves it. Approval is
// persisted so it is asked ONCE, not on every launch. This is the mechanism
// that makes local inference fail closed: without a record, a discovered
// endpoint is reported and then ignored.
//
// RESIDUAL RISK, stated plainly. A malicious process listening on 11434 can
// impersonate Ollama and receive every prompt. Positive identification only
// proves the process speaks the protocol. Mitigations actually implemented:
//   * the exact URL, protocol and model list are printed BEFORE the question,
//   * nothing is ever auto-approved, including on first run and during install,
//   * the runtime's self-reported version is recorded so a later scan can
//     detect that whatever is answering changed,
//   * approval can be revoked with `ox local forget`.
// Not implemented, and therefore not claimed: authentication of the local
// process, sandboxing of it, or any cryptographic binding. Those are not
// available for a loopback server that answers plain HTTP.
// ---------------------------------------------------------------------------

export const TRUST_CONFIG_KEY = 'local_endpoints';

function trustMap(doc) {
  const raw = doc?.[TRUST_CONFIG_KEY];
  return isObject(raw) ? raw : {};
}

// Read the persisted trust records. A malformed/unreadable config yields NO
// records -- fail closed, never fail open.
export function readTrustRecords({ dir = CONFIG_DIR } = {}) {
  let doc;
  try {
    doc = readConfigDoc({ dir });
  } catch {
    return [];
  }
  const out = [];
  for (const [key, rec] of Object.entries(trustMap(doc))) {
    if (!isObject(rec)) continue;
    const baseUrl = normalizeEndpointUrl(rec.base_url ?? key) ?? key;
    out.push({
      key,
      baseUrl,
      runtime: rec.runtime ?? null,
      protocol: rec.protocol ?? null,
      version: rec.runtime_version ?? null,
      models: Array.isArray(rec.models) ? rec.models : [],
      approvedAt: rec.approved_at ?? null,
    });
  }
  return out;
}

export function listApprovedEndpoints(opts = {}) {
  return readTrustRecords(opts);
}

export function isEndpointApproved(baseUrl, { dir = CONFIG_DIR } = {}) {
  const key = normalizeEndpointUrl(baseUrl);
  if (!key) return false;
  return readTrustRecords({ dir }).some(r => r.baseUrl === key);
}

// Persist one approval. Returns the record that was written.
export function approveEndpoint(found, { dir = CONFIG_DIR, now = new Date() } = {}) {
  const key = normalizeEndpointUrl(found?.baseUrl);
  if (!key) throw new Error('ox local: refusing to approve an endpoint without a valid base URL');
  const record = {
    runtime: found.protocol ?? found.runtime ?? 'unknown',
    protocol: found.protocol ?? null,
    base_url: key,
    discovered_url: found.baseUrl ?? key,
    runtime_version: found.version ?? null,
    models: Array.isArray(found.models)
      ? found.models.map(m => ({ name: m.name, size: m.size ?? null, size_bytes: m.sizeBytes ?? null }))
      : [],
    approved_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  saveConfigDoc(
    doc => {
      doc[TRUST_CONFIG_KEY] = { ...trustMap(doc), [key]: record };
    },
    { dir }
  );
  return record;
}

// Revoke one approval. Reads first so a no-op revoke does not rewrite the file.
// Tolerates a full URL, a host:port, or a bare port.
export function forgetEndpoint(ref, { dir = CONFIG_DIR } = {}) {
  const raw = String(ref ?? '').trim();
  if (!raw) return { removed: false, key: null, reason: 'empty-endpoint' };
  let doc;
  try {
    doc = readConfigDoc({ dir });
  } catch {
    return { removed: false, key: null, reason: 'config-unreadable' };
  }
  const map = trustMap(doc);
  let key = normalizeEndpointUrl(raw);
  if (!key || !Object.prototype.hasOwnProperty.call(map, key)) {
    const port = /^\d+$/.test(raw) ? raw : null;
    const hit = readTrustRecords({ dir }).find(
      r => (port && r.baseUrl.endsWith(`:${port}`)) || r.key.includes(raw) || (key && r.baseUrl.includes(key))
    );
    if (!hit) return { removed: false, key, reason: 'not-approved' };
    key = hit.baseUrl;
  }
  saveConfigDoc(
    d => {
      const m = trustMap(d);
      delete m[key];
      d[TRUST_CONFIG_KEY] = m;
    },
    { dir }
  );
  return { removed: true, key };
}

// ---------------------------------------------------------------------------
// Approval prompt
// ---------------------------------------------------------------------------

export function formatModelListForPrompt(models, { max = 6 } = {}) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return '(none reported)';
  const shown = list.slice(0, max).map(m => `${m.name}${m.size ? ` (${m.size})` : ''}`);
  const extra = list.length - shown.length;
  return shown.join(', ') + (extra > 0 ? `, +${extra} more` : '');
}

// The exact text of the approval question. Exported (rather than inlined at the
// call site) so it can be asserted in tests -- a blind "y/N" that does not name
// the endpoint and its models would fail closed on the tests.
export function approvalQuestion(found, { configPath = '~/.ox/config.json' } = {}) {
  const models = formatModelListForPrompt(found?.models);
  const url = found?.baseUrl ?? '(unknown)';
  const name = found?.displayName ?? found?.runtime ?? 'local server';
  const version = found?.version ? ` ${found.version}` : ' (version not reported)';
  return [
    `ox found a local model server: ${name}${version}`,
    `  endpoint:  ${url}`,
    `  protocol:  ${found?.protocol ?? 'unknown'}   models: ${models}`,
    '',
    `Approving means ox will send your prompts, code and tool output to`,
    `${url} on this machine. Anything listening on that port receives all of it.`,
    '',
    `The choice is remembered in ${configPath}, so you are asked once.`,
    `Revoke it with:  ox local forget ${url}`,
    '',
    'Connect ox to this local endpoint?',
  ].join('\n');
}

// Prompt only when a human is actually there. Non-interactive never prompts.
export function canPrompt(io = process) {
  return Boolean(io?.stdin?.isTTY && io?.stdout?.isTTY);
}

// ---------------------------------------------------------------------------
// Preset-model surfacing
//
// The `ox-ollama` preset hardcodes qwen2.5:0.5b, which is NOT in LOCAL_MODELS
// and may simply not exist on a given machine. We never silently switch the
// preset -- a silent substitution would change which model answers every
// request. We surface it instead, with the exact `--bot ox-ollama:<model>` form
// that does work.
// ---------------------------------------------------------------------------
export function presetModelWarning(found) {
  if (!found || found.protocol !== 'ollama') return null;
  const names = (found.models ?? []).map(m => m.name);
  if (!names.length) return null;
  if (names.includes(OLLAMA_PRESET_MODEL)) return null;
  const suggested = names[0];
  return {
    preset: 'ox-ollama',
    expected: OLLAMA_PRESET_MODEL,
    available: names,
    suggestion: suggested,
    message:
      `the ox-ollama preset is hardcoded to '${OLLAMA_PRESET_MODEL}', which this machine does not have. ` +
      `ox will NOT silently switch models — use one of these explicitly: ` +
      names.map(n => `ox --bot ox-ollama:${n}`).join('  |  '),
  };
}

// ---------------------------------------------------------------------------
// Ollama reachability (sync, no network) -- see model-registry.js isReachable.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Back-compat backend table. detect() is now HONEST (async, positive
// identification) instead of `curl -s`, and listModels() returns real records.
// ---------------------------------------------------------------------------

async function chatCompletion(endpoint, model, messages, opts = {}) {
  try {
    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...opts }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}

// THE ENDPOINT TABLE, exported because it is the whole contract of this module
// and because a wrong entry here is the bug this module exists to kill.
//
// `models` is the path the model list is read from, and it belongs to the
// runtime named here. The old table listed `http://localhost:8080/api/tags` for
// llama.cpp: /api/tags is OLLAMA's endpoint, so the llama.cpp entry could only
// ever have succeeded against an Ollama -- it could not detect llama.cpp at all.
// llama.cpp (llama-server) speaks the OpenAI-compatible surface, so its model
// list is /v1/models; Ollama is asked /api/tags because that is the only shape
// carrying `models[].name` + `size`.
//
// There is deliberately NO `health` entry. llama.cpp's /health returns
// {"status":"ok"} with no runtime identity whatsoever, so probing it is exactly
// the "a socket answered" bug wearing a different hat: it cannot tell llama.cpp
// from a web server that happens to be on 8080.
export const LOCAL_BACKEND_SPECS = Object.freeze({
  ollama: Object.freeze({ name: 'Ollama', origin: OLLAMA_ORIGIN, protocol: 'ollama', models: '/api/tags', identify: '/api/version' }),
  llamaCpp: Object.freeze({ name: 'llama.cpp', origin: 'http://localhost:8080', protocol: 'openai-compat', models: '/v1/models', identify: '/v1/models' }),
  vllm: Object.freeze({ name: 'vLLM', origin: 'http://localhost:8000', protocol: 'openai-compat', models: '/v1/models', identify: '/v1/models' }),
  lmStudio: Object.freeze({ name: 'LM Studio', origin: 'http://localhost:1234', protocol: 'openai-compat', models: '/v1/models', identify: '/v1/models' }),
});

// Resolved per-backend so listModels() asks the path this backend owns rather
// than re-deriving it from a protocol guess at the call site.
export const LOCAL_BACKENDS = Object.fromEntries(
  Object.entries(LOCAL_BACKEND_SPECS).map(([id, spec]) => [
    id,
    {
      name: spec.name,
      endpoint: spec.origin,
      protocol: spec.protocol,
      // The path this backend's model list is read from. Exposed so the table
      // is assertable rather than implied.
      modelsPath: spec.models,
      async probe(opts = {}) {
        return await probeOrigin(spec.origin, opts);
      },
      async detect(opts = {}) {
        return Boolean(await probeOrigin(spec.origin, { ...opts, withModels: false }));
      },
      async listModels(opts = {}) {
        return await listModels({ baseUrl: spec.origin, protocol: spec.protocol }, opts);
      },
      // Ollama is the only backend with a `pull`. The other three have no such
      // subcommand, and the old shared implementation ran `ollama pull` for all
      // four -- so asking llama.cpp to pull silently pulled into Ollama, or
      // failed on a binary that is not there. Model names are also validated:
      // the argument reached a shell, and a name containing a space or a `;` is
      // not a model name.
      canPull: id === 'ollama',
      async pull(model) {
        if (id !== 'ollama') return false;
        const name = String(model ?? '').trim();
        if (!/^[A-Za-z0-9._:@/-]{1,200}$/.test(name)) return false;
        try { execSync('ollama', ['pull', name], { stdio: 'inherit' }); return true; } catch { return false; }
      },
      async generate(model, prompt, opts = {}) {
        return await this.chat(model, [{ role: 'user', content: prompt }], opts);
      },
      async chat(model, messages, opts = {}) {
        return await chatCompletion(spec.origin, model, messages, opts);
      },
    },
  ])
);

// `config.endpoints` overrides a backend's origin, so the runner can be pointed
// at a loopback STUB instead of a real daemon. That is what makes the runner
// testable at all: before this, every test of the runner had to stand up a real
// Ollama, so detect() shipped untested and its old `curl -s` behaviour survived
// to production. Keys are backend ids; values are origin strings.
export function createLocalRunner(config = {}) {
  const backends = config.backends || Object.keys(LOCAL_BACKENDS);
  const overrides = config.endpoints && typeof config.endpoints === 'object' ? config.endpoints : {};
  const backend = id => {
    const base = LOCAL_BACKENDS[id];
    if (!base) return null;
    const override = overrides[id] ? normalizeEndpointUrl(overrides[id]) : null;
    return override ? { ...base, endpoint: override } : base;
  };
  return {
    async detect(opts = {}) {
      // Concurrent, each with its own timeout: a dead port costs one timeout,
      // not one timeout per backend.
      const out = await Promise.all(
        backends.map(async b => ((await backend(b)?.detect(opts)) ? b : null).catch(() => null))
      );
      return out.filter(Boolean);
    },
    async scan(opts = {}) {
      const overrideOrigins = Object.values(overrides).map(normalizeEndpointUrl).filter(Boolean);
      return await scanLocalEndpoints({
        ...opts,
        ...(overrideOrigins.length ? { origins: overrideOrigins } : {}),
      });
    },
    // The identified endpoint decides WHICH list endpoint to read: Ollama gets
    // /api/tags, everything else /v1/models. The old version re-listed
    // sequentially per found endpoint, which both wasted a round trip and
    // ignored the protocol the probe had already established.
    async listModels(opts = {}) {
      const found = await this.scan({ withModels: false, ...opts });
      const lists = await Promise.all(found.map(f => listModels(f, { timeoutMs: 2000 })));
      return lists.find(l => l.length) ?? [];
    },
    async pull(model) {
      for (const b of backends) {
        if (await backend(b).pull(model)) return true;
      }
      return false;
    },
    async generate(model, prompt, opts) {
      for (const b of backends) {
        const r = await backend(b).generate(model, prompt, opts);
        if (r) return r;
      }
      return '';
    },
    async chat(model, messages, opts) {
      for (const b of backends) {
        const r = await backend(b).chat(model, messages, opts);
        if (r) return r;
      }
      return '';
    },
    async getStats() {
      return { backends, available: await this.detect() };
    },
  };
}

export const LOCAL_MODELS = [
  { id: 'qwen2.5-coder-32b', name: 'Qwen2.5-Coder 32B', size: '20GB', minRAM: 24, bestFor: 'Deep refactors, multi-file edits', quantization: 'Q4_K_M', ollamaName: 'qwen2.5-coder:32b' },
  { id: 'qwen2.5-coder-7b', name: 'Qwen2.5-Coder 7B', size: '5GB', minRAM: 8, bestFor: 'Quick edits, single-file tasks', quantization: 'Q4_K_M', ollamaName: 'qwen2.5-coder:7b' },
  { id: 'devstral-small-24b', name: 'Devstral Small 24B', size: '14GB', minRAM: 16, bestFor: 'Code generation, debugging', quantization: 'Q4_K_M', ollamaName: 'devstral-small-24b' },
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B', size: '9GB', minRAM: 12, bestFor: 'Quick edits, minimum viable', quantization: 'Q8_0', ollamaName: 'llama3.1:8b' },
  { id: 'deepseek-coder-v2-16b', name: 'DeepSeek-Coder-V2 16B', size: '10GB', minRAM: 16, bestFor: 'Code generation, reasoning', quantization: 'Q4_K_M', ollamaName: 'deepseek-coder-v2-16b' },
  { id: 'gemma4-12b', name: 'Gemma 4 12B', size: '10GB', minRAM: 16, bestFor: 'General coding, skill writing', quantization: 'Q6_K', ollamaName: 'gemma4:12b' },
  { id: 'qwen3-coder-80b-a3b', name: 'Qwen3-Coder-80B-A3B', size: '48GB', minRAM: 64, bestFor: 'Frontier coding (MoE)', quantization: 'Q4_K_M', ollamaName: 'qwen3-coder-80b-a3b' },
  { id: 'mixtral-8x22b', name: 'Mixtral 8x22B', size: '26GB', minRAM: 32, bestFor: 'Multilingual, general purpose', quantization: 'Q4_K_M', ollamaName: 'mixtral-8x22b' },
];

export function recommendLocalModel(hardware = {}, taskType = 'general', memory = os) {
  const totalGB = memory.totalmem() / (1024 ** 3);
  const freeGB = memory.freemem() / (1024 ** 3);
  const limitGB = hardware.memoryGB ?? totalGB;
  const detectedGB = Math.min(totalGB, freeGB, Number(limitGB));
  const mem = Number.isFinite(detectedGB) ? Math.max(0, detectedGB * 0.8) : 0;
  const candidates = LOCAL_MODELS.filter(m => m.minRAM <= mem);
  if (!candidates.length) return { error: 'insufficient memory', reason: 'insufficient-memory', availableMemoryGB: mem, minRAM: Math.min(...LOCAL_MODELS.map(m => m.minRAM)) };
  if (taskType === 'deep-refactor' || taskType === 'multi-file') return candidates.find(m => m.id.includes('32b')) || candidates[0];
  if (taskType === 'quick-edit' || taskType === 'single-file') return candidates.find(m => m.id.includes('7b')) || candidates.find(m => m.id.includes('8b')) || candidates[0];
  return candidates.sort((a, b) => b.minRAM - a.minRAM)[0];
}

export function formatLocalModelList(models) {
  return models.map(m => `${m.name} (${m.size}, ${m.minRAM}GB min) — ${m.bestFor}`).join('\n');
}
