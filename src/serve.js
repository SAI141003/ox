// ox serve — the OpenAI-compatible HTTP surface.
//
// Five routes, and every one of them speaks the OpenAI wire shape a real
// client already knows how to parse:
//
//   GET  /health              liveness probe (bearer-gated once auth is on)
//   GET  /v1/models           the bot registry, with availability state
//   GET  /v1/models/:id       one entry; 404 model_not_found otherwise
//   POST /v1/chat/completions chat completions — streaming and blocking
//   POST /v1/responses        the Responses API — streaming and blocking
//
// `/v1/models` is generated from `BOTS` in src/bots.js — the same registry
// `--bot` resolves against — so an id this server advertises is an id ox can
// actually route to. It is not a hand-typed catalogue, and nothing appears in
// `data` that is not a real bot. Bots that cannot be listed as a model at all
// are reported in `ox.withheld` rather than dropped silently.
//
// Every error body is `{"error":{message,type,param,code}}`, which is the shape
// an OpenAI SDK deserializes; an ad-hoc `{"error":"..."}` string is not.
//
// Auth: `OX_SERVE_API_KEY` turns on `Authorization: Bearer <key>`, compared in
// constant time. With it unset the server is unauthenticated, so startServer
// refuses a non-loopback bind rather than hand the network an endpoint that
// executes code on this machine. See authExposure() for the rule, the messages,
// and the explicit opt-in escape hatch.

import { createServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { runAgent } from './agent.js';
import { BOTS, KEY_ENV, resolveBot, defaultBotSpec } from './bots.js';

import { readFile } from 'fs/promises';
import { join, resolve, extname, dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { spawn } from 'node:child_process';
import { createReadStream } from 'fs';
import { stat, unlink } from 'fs/promises';
import { resolveTurnMode } from './modes.js';
import { listAgents, loadAgent, agentBotSpec, agentPersonaBlock } from './agents.js';
import { readConfigDoc } from './config.js';
import * as UI_LANG from './ui-lang.js';
import { classifyTurn, warmSystem1 } from './system1.js';

// Read at request time, not at module load: a supervisor (or a test) that sets
// the key after this module is imported must not silently get the old answer.
function apiKey() {
  return process.env.OX_SERVE_API_KEY || '';
}
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendSSEDone(res) {
  res.write('data: [DONE]\n\n');
}

// The one error body shape. `param` names the request field at fault and `code`
// is the machine-readable reason; both are null when they do not apply, which is
// what OpenAI sends rather than omitting the keys.
function sendError(res, status, message, type = 'invalid_request_error', code = null, param = null) {
  sendJson(res, status, { error: { message, type, param, code } });
}

function sendInvalidJson(res) {
  sendError(res, 400, 'Request body is not valid JSON.', 'invalid_request_error', 'invalid_json', null);
}

// Hash both sides so the comparison is length-independent: timingSafeEqual
// throws on a length mismatch, and the length of a submitted token is not the
// secret, but a thrown exception at a different instant still is a signal.
function constantTimeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function unauthorized(res) {
  const key = apiKey();
  sendError(
    res,
    401,
    key
      ? 'Missing or invalid credentials. Send `Authorization: Bearer $OX_SERVE_API_KEY`.'
      : 'Authentication is not configured on this server.',
    'authentication_error',
    'invalid_api_key',
    null
  );
}

function authorized(req) {
  const key = apiKey();
  if (!key) return true;
  const header = String(req.headers.authorization || '').trim();
  const m = /^Bearer\s+(.*)$/i.exec(header);
  if (!m) return false;
  return constantTimeEqual(m[1], key);
}

// ---------------------------------------------------------------------------
// Bind-address / auth policy.
//
// An unauthenticated ox endpoint is arbitrary code execution with a filesystem:
// one /v1/chat/completions request runs a full agent turn with ox's tool set.
// "Auth is off unless you ask for it" is the exact default this project keeps
// treating as a defect elsewhere, so it is not the default here. The rule:
//
//   key set, any bind          → fine, bearer required
//   no key, loopback           → open, and it says so loudly
//   no key, non-loopback       → REFUSE to listen
//   no key, non-loopback, and
//     OX_SERVE_ALLOW_UNAUTHENTICATED=1 → open, and it says so even louder
//
// The escape hatch is deliberate and is NOT a default: an operator who wants a
// wide-open network endpoint has to type that variable name, which is the
// difference between a decision and an oversight.
// ---------------------------------------------------------------------------
export function isLoopbackHost(host) {
  if (host === undefined || host === null) return false;
  const h = String(host).trim().toLowerCase();
  if (!h) return false;
  // '::1' bare, or '[::1]' bracketed — Node accepts either as a host.
  if (h === '::1') return true;
  if (h.startsWith('[')) return h === '[::1]';
  if (h === 'localhost') return true;
  // The whole 127/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function authExposure({ host, key = apiKey(), allowUnauthenticated = process.env.OX_SERVE_ALLOW_UNAUTHENTICATED === '1' } = {}) {
  if (key) return { level: 'ok', host, lines: [] };
  if (isLoopbackHost(host)) {
    return {
      level: 'warn',
      host,
      lines: [
        'OX_SERVE_API_KEY is NOT set — every request to this server is accepted with NO credentials.',
        'The bind address is loopback, so only this machine can reach it. Anyone who can',
        'run code here can use it. Set OX_SERVE_API_KEY before binding a wider address.',
      ],
    };
  }
  if (allowUnauthenticated) {
    return {
      level: 'warn',
      host,
      lines: [
        'OX_SERVE_ALLOW_UNAUTHENTICATED=1 and OX_SERVE_API_KEY is unset: this server is',
        `reachable on ${host} and will run code for ANY caller that can reach it.`,
        'This is an explicit opt-in and it is not the default. Unset that variable, or set',
        'OX_SERVE_API_KEY, or bind 127.0.0.1.',
      ],
    };
  }
  return {
    level: 'refuse',
    host,
    lines: [
      `refusing to bind ${host} with authentication OFF.`,
      'ox serve runs a full agent turn per request — bash, file writes, network — so an',
      `unauthenticated endpoint on ${host} lets anyone who can reach this machine run code`,
      'as this user. Fix it one of three ways:',
      '  1. set OX_SERVE_API_KEY=<a secret>            (recommended)',
      '  2. bind loopback: ox serve --host 127.0.0.1   (reachable from this machine only)',
      '  3. set OX_SERVE_ALLOW_UNAUTHENTICATED=1       (explicit, unsupported, dangerous)',
    ],
  };
}

function reportExposure(exposure) {
  if (!exposure.lines.length) return;
  const bar = '='.repeat(78);
  process.stderr.write(`\n${bar}\n`);
  for (const line of exposure.lines) process.stderr.write(`ox serve: ${line}\n`);
  process.stderr.write(`${bar}\n\n`);
}

// ---------------------------------------------------------------------------
// /v1/models — generated from the real registry.
// ---------------------------------------------------------------------------

// ox does not record when each bot was added, so `created` is when this process
// started. A plausible-looking per-model registration date would be a nicer
// number and a lie.
const MODELS_CREATED = Math.floor(Date.now() / 1000);

// Plans you already pay for (Claude, ChatGPT, Cursor… through their own CLIs).
// Checking them runs each CLI, so it happens in a separate process, in the
// background, and the result is kept for ten minutes: the model list itself
// never waits on it.
let planCache = { at: 0, list: [], running: null };
export function refreshPlans() {
  if (planCache.running) return planCache.running;
  planCache.running = new Promise((resolve) => {
    const code = "import('" + new URL('./app-api.js', import.meta.url).href + "').then(async (m) => process.stdout.write(JSON.stringify(await m.accountsView())))";
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      try { planCache.list = JSON.parse(out); } catch {}
      planCache.at = Date.now();
      planCache.running = null;
      resolve(planCache.list);
    });
    child.on('error', () => { planCache.running = null; resolve(planCache.list); });
  });
  return planCache.running;
}
export const workingPlans = () => planCache.list.filter((p) => p.works && !expiredPlansNow().has(p.id));
let expiredRef = null;
import('./subscriptions.js').then((m) => { expiredRef = m.expiredPlans; }).catch(() => {});
const expiredPlansNow = () => expiredRef ?? new Set();

// Chat models Ollama has on this machine, biggest first (refreshed in the background).
let ollamaCache = { at: 0, models: [] };
export async function refreshOllama(base = process.env.OLLAMA_HOST ? `http://${String(process.env.OLLAMA_HOST).replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434') {
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    ollamaCache.models = (j.models ?? [])
      .filter((m) => !/embed|bge|nomic|minilm/i.test(m.name))
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
      .map((m) => m.name);
  } catch { ollamaCache.models = []; }
  ollamaCache.at = Date.now();
  return ollamaCache.models;
}
export const localOllama = () => ollamaCache.models;
// The first auto pick waits for the one quick look at Ollama (1.5 s at most),
// so it never falls back to a model that is not installed.
async function warmLocal() { if (!ollamaCache.at && process.env.OX_NO_KEYSTORE !== '1') await refreshOllama(); }

// Could this bot answer right now? A plan must be signed in, a keyed provider
// needs its key; local servers and your own endpoints carry no key to check.
export function runnable(spec, env = process.env) {
  try {
    const t = resolveBot(String(spec), { bots: readConfigDoc().bots ?? {} }, env);
    if (t.subscription) return workingPlans().some((p) => p.bot === `${t.subscription}-plan`);
    return !t.keyEnv || !!env[t.keyEnv];
  } catch { return false; }
}

// Auto model, per message. Small talk and plain questions go to the quickest,
// cheapest model that can answer (a model on your machine costs nothing);
// anything about code, files, tools or several steps goes to the strongest you
// have connected. Only models that can answer right now are considered.
const FAST_BOTS = ['ox-haiku', 'ox-flash', 'ox-grok-fast', 'ox-groq'];
const STRONG_BOTS = ['claude-plan', 'chatgpt-plan', 'ox-opus', 'ox-claude', 'ox-gpt', 'ox-gemini', 'ox-grok', 'ox-deepseek', 'cursor-plan'];
// Under 1B parameters, read from the name ("SmolLM2-135M", "qwen2.5:0.5b").
export function tinyModel(name) {
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*([mb])(?![a-z0-9])/i.exec(String(name));
  if (!m) return false;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'm' ? n < 1000 : n < 1;
}

export function autoModel(messages = [], env = process.env, { think = false, s1 = null } = {}) {
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  const said = typeof last?.content === 'string' ? last.content : '';
  const seeing = Array.isArray(last?.images) && last.images.length > 0;
  // System 1 (src/system1.js) reads the message in any language; the word lists
  // are the fallback when it is not installed or not ready.
  const light = !think && !seeing && (s1
    ? ['chat', 'question', 'current'].includes(s1.kind) && !(s1.plan > 0.5) && !TOUCHES_CODE.test(said)
    : SMALL_TALK.test(said) || (!TOUCHES_CODE.test(said) && !NEEDS_TOOLS.test(said) && said.length < 400));
  let local = [];
  try { local = Object.entries(readConfigDoc().bots ?? {}).filter(([, d]) => d?.provider === 'custom' && d.model).map(([id]) => id); } catch {}
  if (Date.now() - ollamaCache.at > 5 * 60_000 && process.env.OX_NO_KEYSTORE !== '1') refreshOllama();
  // Ollama's biggest chat model counts as local too (it needs no key).
  if (localOllama()[0]) local.push(`ox-ollama:${localOllama()[0]}`);
  const can = (id) => runnable(id, env);
  if (light) {
    const id = local.find(can) ?? FAST_BOTS.find(can) ?? STRONG_BOTS.find(can);
    if (id) return { id, why: local.includes(id) ? 'a quick answer, on your machine' : FAST_BOTS.includes(id) ? 'a quick answer, the fastest model connected' : 'a quick answer (no small model is connected)' };
  }
  const id = STRONG_BOTS.find(can) ?? FAST_BOTS.find(can) ?? local.find(can);
  if (!id) return { id: pickWorkingDefault(env), why: 'nothing else can answer here' };
  const strong = STRONG_BOTS.includes(id);
  if (think || seeing) return { id, why: strong ? `${think ? 'think harder' : 'a photo to look at'}: the strongest model connected` : `${think ? 'think harder' : 'a photo to look at'}: the best model connected (connect a stronger one in Settings)` };
  return { id, why: light ? 'the only model that can answer' : strong ? 'work with code or tools, the strongest model connected' : 'work with code or tools; the only model that can answer (connect a stronger one in Settings)' };
}

// The model a chat uses when none is picked: your default if it can run, then a
// signed-in plan, then a local model, then any provider whose key is set.
export function pickWorkingDefault(env = process.env) {
  let configured = null;
  try { configured = readConfigDoc().defaultBot ?? null; } catch {}
  if (configured && runnable(configured, env)) return configured;
  const plan = workingPlans()[0];
  if (plan) return plan.bot;
  for (const [id, def] of Object.entries(readConfigDoc().bots ?? {})) if (def?.provider === 'custom' && def.model) return id;
  for (const [id, def] of Object.entries(BOTS)) {
    const k = KEY_ENV[def.provider];
    if (def.model && k && env[k]) return id;
  }
  if (localOllama()[0]) return `ox-ollama:${localOllama()[0]}`;
  return configured ?? 'ox-ollama';
}

export function serveModelCatalog(env = process.env) {
  const data = [];
  const withheld = [];
  // Tests (OX_NO_KEYSTORE=1) never run the user's real CLIs.
  if (Date.now() - planCache.at > 10 * 60_000 && process.env.OX_NO_PLAN_CHECK !== '1' && process.env.OX_NO_KEYSTORE !== '1') refreshPlans();
  for (const p of workingPlans()) {
    data.push({ id: p.bot, object: 'model', created: MODELS_CREATED, owned_by: p.id, ox: { provider: p.id, plan: true, available: true, availability: 'signed-in', desc: `${p.label}${p.version ? ` · ${p.version}` : ''}` } });
  }
  for (const [id, def] of Object.entries(BOTS)) {
    const keyEnv = KEY_ENV[def.provider] ?? null;
    // `available` answers the honest question — "could this serve right now,
    // from this environment" — rather than the flattering one: a provider that
    // reads a key needs it present, and a bot with no default model needs the
    // caller to name one.
    const available = !!def.model && (!keyEnv || !!env[keyEnv]);
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
    data.push({
      id,
      object: 'model',
      created: MODELS_CREATED,
      owned_by: def.provider,
      ox: {
        provider: def.provider,
        model: def.model,
        available,
        // Precisely what 'available' means: every credential this provider reads is
        // present. It is NOT a liveness probe — ox-ollama reports available:true with
        // no Ollama listening, because a GET /v1/models that dials every provider is a
        // side effect this route should not have. A request that cannot connect fails
        // loudly instead (see agentErrorShape). 
        availability: 'credentials-only',
        requires_key: keyEnv,
        desc: def.desc,
      },
    });
  }
  // Your own endpoints (Settings › Custom endpoints), by the name you gave them.
  let configBots = {};
  try { configBots = readConfigDoc().bots ?? {}; } catch {}
  for (const [id, def] of Object.entries(configBots)) {
    // A model picked from a provider in Settings › API keys ("Use"): listed
    // while its provider's key is set.
    if (def && def.provider && def.provider !== 'custom' && def.model && !BOTS[id] && KEY_ENV[def.provider] !== undefined) {
      const keyEnv = KEY_ENV[def.provider];
      data.push({ id, object: 'model', created: MODELS_CREATED, owned_by: def.provider, ox: { provider: def.provider, model: def.model, available: !keyEnv || !!env[keyEnv], availability: 'credentials-only', requires_key: keyEnv, desc: def.desc ?? '' } });
      continue;
    }
    if (!def || def.provider !== 'custom' || !def.baseUrl || BOTS[id]) continue;
    data.push({ id, object: 'model', created: MODELS_CREATED, owned_by: 'you', ox: { provider: 'custom', model: def.model ?? null, available: !!def.model, endpoint: true, baseUrl: def.baseUrl, desc: def.desc ?? '' } });
  }
  // Your agents (`ox agent new`), as `agent:<name>`: picking one in a chat
  // runs it with its bot, mode, instructions and tool grant.
  for (const name of listAgents()) {
    const a = loadAgent(name);
    if (!a) continue;
    data.push({
      id: `agent:${name}`,
      object: 'model',
      created: MODELS_CREATED,
      owned_by: 'you',
      ox: { agent: true, bot: agentBotSpec(a), mode: a.mode ?? 'code', tools: Array.isArray(a.tools) ? a.tools : null, desc: a.description || '' },
    });
  }
  return { data, withheld };
}

function modelById(id, env = process.env) {
  const { data, withheld } = serveModelCatalog(env);
  return { entry: data.find(m => m.id === id) || null, withheld };
}

async function handleModels(req, res) {
  if (!authorized(req)) return unauthorized(res);
  const { data, withheld } = serveModelCatalog();
  sendJson(res, 200, {
    object: 'list',
    data,
    ox: {
      server: 'ox',
      registry: 'src/bots.js BOTS',
      total: data.length,
      servable_now: data.filter(m => m.ox.available).length,
      // Not an OpenAI field. ox's models are the bot registry, and a bot with no
      // default model is not a model — saying so here beats listing an id that
      // cannot answer a request.
      withheld,
    },
  });
}

async function handleModel(req, res, id) {
  if (!authorized(req)) return unauthorized(res);
  const { entry, withheld } = modelById(id);
  if (!entry) {
    // A withheld id IS a real bot, so "does not exist" would be false for it. Name
    // the reason it is not a model instead of answering as if it were a typo.
    const w = withheld.find(x => x.id === id);
    sendError(
      res,
      404,
      w
        ? `'${id}' is a bot in the registry but not a servable model: ${w.reason}. ${w.detail}`
        : `The model '${id}' does not exist. GET /v1/models lists every id this server serves.`,
      'invalid_request_error',
      'model_not_found',
      'model'
    );
    return;
  }
  sendJson(res, 200, entry);
}

function createChatCompletionResponse(model, content, usage = {}) {
  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: usage.inputTokens || 0,
      completion_tokens: usage.outputTokens || 0,
      total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0)
    }
  };
}

function createChatCompletionChunk(model, content, isLast = false, usage = {}) {
  return {
    id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: isLast ? {} : { content },
      finish_reason: isLast ? 'stop' : null
    }],
    usage: isLast ? {
      prompt_tokens: usage.inputTokens || 0,
      completion_tokens: usage.outputTokens || 0,
      total_tokens: (usage.inputTokens || 0) + (usage.outputTokens || 0)
    } : undefined
  };
}

// runAgent yields an `error` event rather than throwing when the provider
// stream dies after its retries, so a caller that only reads `text` events sees
// a successful empty answer. These helpers name that instead of passing it on.
function usageTally() {
  return { inputTokens: 0, outputTokens: 0 };
}

function tallyUsage(total, event) {
  // The usage event spreads the provider's counters onto the event itself
  // (`{type:'usage', ...ev.usage, costUsd, model}`), so reading `event.usage`
  // finds nothing and every completion reported 0 tokens for work that was
  // billed. Read both shapes.
  const u = event.usage && typeof event.usage === 'object' ? event.usage : event;
  total.inputTokens += u.inputTokens || 0;
  total.outputTokens += u.outputTokens || 0;
}

// agent.js emits `text-delta` for each streamed chunk of assistant text and
// `final` for the completed message. It never emitted a `type: 'text'` event
// carrying `content`, so a handler waiting for one matched nothing and every
// completion came back as an empty string inside a 200 that looked like an
// answer. These two read the events that actually exist.
// Only names and a short preview leave the server: never tool output.
function oxToolEvent(event) {
  return event.type === 'tool-start'
    ? { type: 'tool-start', id: event.id ?? null, name: String(event.name ?? 'tool'), preview: String(event.argsPreview ?? '').slice(0, 120), ...(Array.isArray(event.plan) ? { plan: event.plan } : {}) }
    : { type: 'tool-end', id: event.id ?? null, name: String(event.name ?? 'tool'), isError: event.isError === true, ...(event.meta?.canvas?.tree ? { canvas: event.meta.canvas.tree } : {}) };
}

function textDelta(event) {
  if (event.type === 'text-delta' && typeof event.text === 'string' && event.text) return event.text;
  return '';
}

// Only used when no delta arrived, so a provider that reports its text once at
// the end is not lost and a stream that did stream is not double-counted.
export function finalText(event, alreadyHave) {
  if (alreadyHave) return '';
  if (event.type !== 'final') return '';
  // The agent reports `final` as a message ({ role, content }); older paths as a string.
  if (typeof event.message === 'string') return event.message;
  const c = event.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : '')).join('');
  return '';
}

/**
 * An interactive answer that does not load cleanly gets one more try: the
 * engine's own errors go back to the model, which answers with the corrected
 * block. Returns the mended answer (prose kept, block swapped) or null when the
 * first one was fine or the retry was no better. A small local model draws far
 * more often with one round of its own errors than without.
 */
export async function repairLiveUi({ text, target, messages, ctx, config, run = runAgent, usage = null }) {
  const first = UI_LANG.checkUi(text);
  if (first.ok) return null;
  const errs = first.errors.slice(0, 6).map((e) => `line ${e.line}: ${e.msg}`).join('\n');
  const ask = first.blocks
    ? `That \`\`\`openui block did not load:\n${errs || first.why}\nReply with only the corrected \`\`\`openui block: every line \`name = Expression\`, positional arguments, ending with \`root = …\`.`
    : 'Draw that as an ```openui block, as described in your instructions. Reply with only the block.';
  let fixed = '';
  try {
    for await (const ev of run({ target, messages: [...messages, { role: 'assistant', content: text }, { role: 'user', content: ask }], ctx: { ...ctx, noTools: true, onlyTools: undefined, allowedTools: undefined }, config, maxIterations: 1 })) {
      fixed += textDelta(ev) || finalText(ev, fixed);
      if (ev.type === 'usage' && usage) tallyUsage(usage, ev);
    }
  } catch { return null; }
  const second = UI_LANG.checkUi(fixed);
  const better = second.ok || (second.root && (!first.root || second.errors.length < first.errors.length));
  if (!better) return null;
  const block = `\`\`\`openui\n${UI_LANG.uiBlocks(fixed).join('\n').trim()}\n\`\`\``;
  const re = /(?<=^|\n)[ \t]*```[ \t]*(openui|open-ui|openui-lang|ox-?canvas)[^\n]*\n[\s\S]*?(?:```|$)/gi;
  if (!first.blocks) return `${text.trim()}\n\n${block}`;
  let placed = false;
  return text.replace(re, () => (placed ? '' : ((placed = true), block))).replace(/\n{3,}/g, '\n\n').trim();
}

function agentErrorShape(message) {
  // A missing provider key is an authentication failure, not a bug; a 500 would
  // send the caller looking in the wrong place.
  if (/Missing API key/i.test(message)) {
    return { status: 401, type: 'authentication_error', code: 'invalid_api_key', param: null };
  }
  return { status: 500, type: 'server_error', code: null, param: null };
}

// What ox's own app can draw (src/web/chat.html renderUi): answers as interface,
// described in JSON so even a small local model gets it right and no model-written
// code runs. Kept short; the example is the format, copied as is.
const NEEDS_WEB = /\b(price|prices|cost of|latest|today|this week|news|current|rate today|search|look up|website|https?:\/\/)/i;
// Asks that need a tool even without naming a file: the web, the machine, mail, memory, other agents.
const NEEDS_TOOLS = /\b(search|look up|google|browse|latest|today|news|price|weather|open|run|install|email|mail|send|remember|forget|schedule|remind|screenshot|download|fetch|https?:\/\/|www\.|agent|subagent)\b/i;
// Asking for something to be made or changed: that needs tools.
const BUILDS = /\b(build|create|make|write|generate|scaffold|implement|code|script|website|app|deploy|install|edit|change|update|delete|rename|fix|refactor|add|remove|run|test)\b/i;
const SMALL_TALK = /^\s*(hi|hey|hello|yo|thanks|thank you|ok|okay|cool|nice|great|good (morning|night|evening)|how are you|who are you|what can you do)[\s!.?]*$/i;
const TOUCHES_CODE = /\b(file|files|repo|repository|project|codebase|function|class|module|component|test|tests|bug|fix|refactor|commit|branch|src|readme)\b|[\w-]+\.(js|ts|tsx|jsx|py|go|rs|java|rb|css|html|json|md)\b/i;
const WANTS_UI = /\b(calculat\w*|convert\w*|compar\w*|table|chart|graph|plot|slider|interactive|estimat\w*|budget|breakdown|checklist|options|pros and cons|form)\b/i;
// OpenUI Lang (thesysdev/openui), the way OpenUI does it: the prompt is built
// from the component library itself, so what the model is told and what the
// page can draw never drift apart.
// The interactive-answer guide. Small models copy what they see, so it shows
// complete, correct programs (each checked by the parser in a test) and plain
// rules, never the grammar's placeholders: `name = Expression` written as
// grammar came back as code ("$name = Expression"), and 0 of 10 answers drew
// on qwen2.5:3b (bench/openui).
export const LIVE_UI_GUIDE = [
  'This chat draws interface with OpenUI Lang. When a calculator, form, table, comparison, dashboard, step list, chart or set of next choices answers better than prose, write it in a block fenced with ```openui on its own line. Keep prose short, outside the block.',
  'Rules: one statement per line, `something = value`. The last line is `root = ...`. State the user can change is `$name = default` (always give the default). Arguments are positional: write Input("Amount", $amount, "number"), never type="number". Strings in double quotes. A negative number is 0 - x. Use only the components and @functions listed; no other words.',
  `Components: ${Object.keys(UI_LANG.LIBRARY).map(UI_LANG.signature).join(' ')}`,
  'Functions: @Pow(b, e) @Sqrt(x) @Abs(x) @Round(n, digits) @Format(n, "currency") @Format(n, "percent") @Sum(list) @Avg(list) @Min(list) @Max(list) @Count(list) @Clamp(n, lo, hi) @Range(0, n) @Each(rows, "r", Text(r.name)). Buttons: Button("Label", @Set($v, 1)).',
  'Example, a calculator:',
  '```openui',
  '$amount = 300000',
  '$rate = 6',
  '$years = 30',
  'r = $rate / 1200',
  'n = $years * 12',
  'pay = $amount * r / (1 - @Pow(1 + r, 0 - n))',
  'root = Card("Loan payment", [Input("Loan amount", $amount, "number"), Slider("Interest % a year", $rate, 0, 20, 0.1), Slider("Years", $years, 1, 40, 1), Stat("Monthly payment", @Format(pay, "currency"))])',
  '```',
  'Example, a chart:',
  '```openui',
  'labels = ["India", "China", "USA"]',
  'values = [1441, 1425, 340]',
  'root = Card("Population, millions", [Chart("bar", labels, values, "Population")])',
  '```',
  'Example, a table and a checkbox:',
  '```openui',
  '$bought = false',
  'root = Card("Phones", [Table([Col("Phone", ["iPhone", "Pixel"]), Col("Price", [999, 799])]), Checkbox("Bought one", $bought)])',
  '```',
  'Write one block like these, filled with what the user asked for, then at most one short sentence.',
  'Every $var a line reads must be declared. Use 0 - x for a negative number. For anything the components cannot show, a block fenced with ```html-live holds one self-contained HTML snippet (inline style and script, no network).',
].join('\n');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((im) => im && IMAGE_TYPES.has(im.mediaType) && typeof im.data === 'string' && im.data.length < 7_000_000 && /^[A-Za-z0-9+/=]+$/.test(im.data.slice(0, 200)))
    .slice(0, 4).map((im) => ({ mediaType: im.mediaType, data: im.data }));
}
export const RESEARCH_BRIEF = 'Deep research. Search several times from different angles, open and read the best sources (not just the result snippets), compare what they say, and note where they disagree. Then answer with a short summary first, the details after, and each claim followed by its source number, like [1]. End with the numbered list of sources and their links.';
export const LEARN_BRIEF = 'Guided learning. Teach rather than tell: find out what the user already knows, explain one step at a time in plain words with a small example, then ask one short question to check they followed before moving on. Never dump the whole answer at once.';

async function handleChatCompletions(req, res) {
  if (!authorized(req)) {
    unauthorized(res);
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch {
    sendInvalidJson(res);
    return;
  }

  const { model, stream, max_tokens, temperature } = body;
  let { messages } = body;

  if (!messages || !Array.isArray(messages)) {
    sendError(res, 400, "'messages' is required and must be an array.", 'invalid_request_error', 'missing_required_parameter', 'messages');
    return;
  }

  // Photos from the app's + menu ride on a user message as `images`; anything
  // else in that field is dropped, and at most 4 photos of 5 MB each are kept.
  messages = messages.map((m) => (m && 'images' in m ? { ...m, images: cleanImages(m.images) } : m));
  // The app's + menu: web search, deep research, think harder, guided learning,
  // interactive answer, and memory off for this chat.
  const tool = {
    web: body.ox_web === true, research: body.ox_research === true, think: body.ox_think === true,
    learn: body.ox_learn === true, canvas: body.ox_canvas === true, noMemory: body.ox_memory === false,
  };
  // System 1: what kind of message this is, in one fast pass (null when Laya is
  // not installed, still loading, or slower than its limit).
  const lastUserMsg = [...messages].reverse().find((m) => m?.role === 'user');
  const s1 = typeof lastUserMsg?.content === 'string' ? await classifyTurn(lastUserMsg.content, { timeoutMs: 1200 }) : null;
  // "auto": a model per message, from what can answer here (see autoModel).
  if (model === 'auto') await warmLocal();
  const autoPick = model === 'auto' ? autoModel(messages, process.env, { think: tool.think || tool.research, s1 }) : null;
  const targetModel = autoPick?.id ?? (model || pickWorkingDefault());
  const temperature0 = temperature ?? 0.7;
  // Resolve a name the registry knows (every id in /v1/models) through the same
  // resolver, so a client that lists models can actually use them here. A name
  // the registry does not know falls back to the old pass-through target rather
  // than being rejected: this endpoint has always accepted any string here, and
  // turning that into a 400 would break existing callers. The fallback is the
  // pre-existing behaviour and it is why an unresolvable model on THIS endpoint
  // can still come back as an empty 200 — /v1/responses does not have that gap.
  // `agent:<name>` is one of your agents: its bot, mode, instructions, tools.
  const agentDef = String(targetModel).startsWith('agent:') ? loadAgent(String(targetModel).slice(6)) : null;
  if (String(targetModel).startsWith('agent:') && !agentDef) {
    sendError(res, 404, `There is no bot called ${String(targetModel).slice(6)} on this ox: it was deleted, or this chat came from another computer. Make it again in Bots, or pick another model.`, 'invalid_request_error', 'model_not_found', 'model');
    return;
  }
  let target;
  try {
    target = resolveBot(agentDef ? (agentBotSpec(agentDef) ?? defaultBotSpec({}, process.env) ?? 'ox-grok') : String(targetModel), { bots: readConfigDoc().bots ?? {} });
    target.temperature = temperature0;
  } catch {
    target = { model: targetModel, temperature: temperature0 };
  }
  // `ox_mode` is an ox extension (other OpenAI clients never send it): the
  // mode is enforced at the tool gate, and auto's pick is reported back. An
  // agent's own mode applies unless a specific mode was picked.
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const pickedMode = body.ox_mode && body.ox_mode !== 'auto' ? body.ox_mode : (agentDef?.mode ?? body.ox_mode ?? 'code');
  // Routing reads what you typed: the app appends attached files after it
  // ("\n\n`name`:\n```…```"), and a question with a video attached is still a
  // question (it was routed to Code because it no longer ended with "?").
  const typedText = (typeof lastUser?.content === 'string' ? lastUser.content : '').replace(/\n\n`[^`\n]+`:\n```[\s\S]*?```/g, '').trim();
  let turnMode = resolveTurnMode(pickedMode, typedText);
  // In ox's own app, "make a loan calculator" asks for something to look at and
  // use here, not a change to the project: auto keeps it an answer (ask), unless
  // the message points at code or files.
  const said = typedText;
  const wantsUi = WANTS_UI.test(said) || s1?.kind === 'interactive';
  const needsWeb = NEEDS_WEB.test(said) || s1?.kind === 'current';
  const by = s1 ? ` (System 1, ${s1.ms} ms)` : '';
  // Choosing "Interactive answer" (ox_canvas) means exactly that: an answer to
  // use here, drawn, with no tools to wander off with (a 3B model offered tools
  // made to-do lists instead of drawing).
  // (An "ask" guess counts too: "Compare iPhone, Pixel and Galaxy in a table"
  // was guessed ask, kept every tool, and the model stopped at an approval.)
  if ((turnMode.routed || tool.canvas) && !turnMode.answerOnly && body.ox_ui === 'live'
    && (wantsUi || tool.canvas) && !TOUCHES_CODE.test(said)) {
    turnMode = { mode: 'ask', routed: true, reason: 'an answer to use here, not a change to your files', answerOnly: true };
  }
  // A model under 1B parameters cannot write an interactive answer (SmolLM2-135M
  // returned noise and no block): for that one answer the best model connected
  // takes over, and the answer says which and why.
  let uiSwap = null;
  const pickedName = String(target?.model ?? targetModel);
  if (body.ox_ui === 'live' && (wantsUi || tool.canvas) && !agentDef && tinyModel(pickedName)) {
    await warmLocal();
    const better = autoModel(messages, process.env, { think: true });
    if (better?.id && better.id !== 'ox-ollama' && !tinyModel(better.id) && runnable(better.id)) {
      try { target = resolveBot(better.id, { bots: readConfigDoc().bots ?? {} }); target.temperature = temperature0; uiSwap = { from: pickedName, to: better.id }; } catch {}
    }
  }
  // Tokens are time on a local model (it reads the whole prompt first) and money
  // on a paid one. A message that needs nothing but an answer (hi, a question
  // about the world) is sent without tool definitions, about 1,600 tokens.
  // Measured on qwen2.5:3b: "hi" 2,740 tokens / 17 s before this.
  // A short message that names no file or code, needs no tool and asks to build
  // nothing is a question, whatever the mode guesser read into its first word
  // ("Name the capital of Australia" was routed as a change: 2,115 tokens).
  if (s1 && turnMode.routed && !turnMode.answerOnly && !TOUCHES_CODE.test(said)) {
    // System 1's reading wins over the word lists; a named file or code still
    // keeps the tools whatever it says.
    if (['chat', 'question', 'current'].includes(s1.kind) && !(s1.plan > 0.5)) {
      turnMode = { mode: 'ask', routed: true, reason: `${s1.kind === 'chat' ? 'small talk' : s1.kind === 'current' ? 'needs current information' : 'a question'}${by}`, answerOnly: true };
    } else if (turnMode.reason) turnMode = { ...turnMode, reason: `${turnMode.reason}${by}` };
  } else if (turnMode.routed && !turnMode.answerOnly && !TOUCHES_CODE.test(said) && !NEEDS_TOOLS.test(said) && (turnMode.mode === 'ask' || SMALL_TALK.test(said) || (!BUILDS.test(said) && said.length < 400))) {
    turnMode = { mode: 'ask', routed: true, reason: turnMode.mode === 'ask' ? turnMode.reason : SMALL_TALK.test(said) ? 'small talk' : 'a question', answerOnly: true };
  }
  if (tool.web || tool.research) turnMode = { mode: 'ask', routed: true, reason: tool.research ? 'deep research' : 'web search', answerOnly: true };
  // The same memory a terminal run starts with: the project's MEMORY.md, what ox
  // remembers about the user, and what bears on this message.
  const lastText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  // `ox_incognito: true` (the app's Incognito chat): no memory about the user in,
  // nothing learned, no usage record, memory writes refused.
  const incognito = body.ox_incognito === true || process.env.OX_INCOGNITO === '1';
  let memoryBlock = '';
  if (!tool.noMemory) 
  try {
    const { loadMemoryBlock } = await import('./memory.js');
    const { memoryPromptBlock } = await import('./memory-graph.js');
    memoryBlock = [loadMemoryBlock(process.cwd()), process.env.OX_MEMORY === '0' || incognito ? '' : memoryPromptBlock({ cwd: process.cwd(), task: lastText })].filter(Boolean).join('\n\n');
  } catch {}
  // `ox_ui: 'live'` is sent by ox's own app, which can run interactive answers.
  // About 600 tokens: sent only when the message asks for something to use.
  const liveUi = body.ox_ui === 'live' && (tool.canvas || wantsUi) ? LIVE_UI_GUIDE : '';
  const howTo = [
    tool.research ? RESEARCH_BRIEF : tool.web ? 'Search the web for this and answer from what you find, naming each source.' : '',
    tool.think ? 'Think this through carefully before answering: weigh the alternatives, check your working, then give the answer.' : '',
    tool.learn ? LEARN_BRIEF : '',
  ].filter(Boolean).join('\n\n');
  // Small models follow what sits next to the question, not a guide far up in
  // the system prompt: when the message plainly asks for something to work
  // with, the reminder rides along with it (the stored chat is unchanged).
  if (liveUi) {
    const i = messages.lastIndexOf(lastUser);
    if (i >= 0) messages = [...messages.slice(0, i), { ...lastUser, content: `${lastText}\n\n(Answer with an \`\`\`openui block as described in your instructions.)` }, ...messages.slice(i + 1)];
  }
  const ctx = {
    cwd: process.cwd(),
    mode: turnMode.mode,
    surface: 'app',
    memoryBlock,
    ...(incognito ? { incognito: true } : {}),
    ...(agentDef || liveUi || howTo ? { personaBlock: [agentDef ? agentPersonaBlock(agentDef) : '', liveUi, howTo].filter(Boolean).join('\n\n') } : {}),
    ...(agentDef ? { agentName: agentDef.name } : {}),
    ...(Array.isArray(agentDef?.tools) ? { allowedTools: agentDef.tools }
      // A drawn answer searches only when web search is switched on: "price" in
      // "compare phones in a table" sent a 3B model off to the YouTube tool.
      : turnMode.answerOnly ? (tool.web || tool.research || (needsWeb && !liveUi) || /youtube\.com|youtu\.be/i.test(lastText) ? { onlyTools: /youtube\.com|youtu\.be/i.test(lastText) ? ['web_search', 'web_fetch', 'youtube_transcript'] : ['web_search', 'web_fetch'] } : { noTools: true })
      // A question about the project in ask mode: only the four readers.
      : turnMode.mode === 'ask' && TOUCHES_CODE.test(lastText) && !NEEDS_TOOLS.test(lastText) ? { onlyTools: ['read_file', 'list_dir', 'glob', 'grep'] }
      : {}),
  };
  // The Office: this run, and any helper it starts, is shown at a desk.
  const board = await import('./live-board.js');
  const runId = board.startRun({ who: agentDef?.name ?? autoPick?.id ?? String(targetModel), title: incognito ? 'Incognito chat' : lastText || '(no text)', model: target?.model ?? null });
  ctx.ipcBroadcast = board.boardBroadcaster(runId);
  // Preferences the user states here are kept, as in the terminal.
  if (process.env.OX_LEARN !== '0' && lastText && !incognito && !tool.noMemory) {
    try { (await import('./memory-graph.js')).learnFromMessages([{ role: 'user', content: lastText }], { source: 'app' }); } catch {}
  }
  const config = { maxTokens: max_tokens };
  // The backup model (Settings > General): app chats fall back the way
  // terminal runs do (src/headless.js), to models that can run here and are
  // not the chat's own. A plan's turn runs inside its CLI and is not bounced.
  try {
    const fdoc = readConfigDoc() ?? {};
    const specs = fdoc.fallback_bots ?? fdoc.fallbackBots ?? [];
    ctx.fallbackTargets = (Array.isArray(specs) ? specs : [])
      .filter((sp) => runnable(sp))
      .map((sp) => { try { return resolveBot(sp, { bots: fdoc.bots ?? {} }); } catch { return null; } })
      .filter((t) => t && t.provider !== 'subscription' && !(t.provider === target?.provider && t.model === target?.model));
  } catch {}
  // Delegation in the app, as in the terminal (src/headless.js): the subagent
  // tool was offered here with nothing behind it ("not configured"), and agents
  // could not see or message each other. Now a helper really runs, shows up in
  // the Office, and agent_status / agent_message reach the other agents.
  if (!ctx.noTools) {
    const { makeSubagentToolHandler } = await import('./subagent.js');
    const { makeAgentTeamsHandler } = await import('./agent-teams.js');
    let doc = {};
    try { doc = readConfigDoc() ?? {}; } catch {}
    ctx.subagentHandler = makeSubagentToolHandler({ config: { ...doc, cwd: ctx.cwd }, target, auxTarget: null });
    ctx.agentTeamsHandler = makeAgentTeamsHandler(ctx.cwd);
    ctx.enableSubagents = true;
    ctx.depth = 0;
    ctx.maxDepth = doc?.subagent?.maxDepth ?? 2;
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let fullContent = '';
    const totalUsage = usageTally();
    // route: what the turn was given (an answer only, web tools, the interactive guide, or the tools).
    const route = liveUi && turnMode.answerOnly ? 'ui' : turnMode.answerOnly ? (ctx.onlyTools?.includes('web_search') ? 'web' : 'answer') : 'tools';
    if (body.ox_mode || autoPick || uiSwap) sendSSE(res, { ...createChatCompletionChunk(targetModel, ''), ox: { type: 'mode', mode: turnMode.mode, routed: turnMode.routed, reason: turnMode.reason, route,
      ...(uiSwap ? { model: uiSwap.to, modelWhy: `${uiSwap.from} is too small to draw an interactive answer, so ${uiSwap.to} drew this one` } : autoPick ? { model: autoPick.id, modelWhy: autoPick.why } : {}) } });

    try {
      for await (const event of runAgent({ target, messages, ctx, config, maxIterations: 40 })) {
        const delta = textDelta(event);
        const last = delta || finalText(event, fullContent);
        if (last) {
          fullContent += last;
          sendSSE(res, createChatCompletionChunk(targetModel, last));
        } else if (event.type === 'usage') {
          tallyUsage(totalUsage, event);
        } else if (event.type === 'error') {
          // A run that stops (missing key, provider refusal, budget) says why,
          // instead of ending as an empty reply.
          sendSSE(res, { error: { message: String(event.error), type: 'server_error' } });
        } else if (event.type === 'tool-start' || event.type === 'tool-end') {
          // What the agent is doing, as an `ox` extension on an empty chunk:
          // OpenAI clients ignore the unknown field, the web chat draws it.
          sendSSE(res, { ...createChatCompletionChunk(targetModel, ''), ox: oxToolEvent(event) });
        }
      }
      if (route === 'ui' && fullContent) {
        const mended = await repairLiveUi({ text: fullContent, target, messages, ctx, config, usage: totalUsage });
        if (mended) { fullContent = mended; sendSSE(res, { ...createChatCompletionChunk(targetModel, ''), ox: { type: 'replace', content: mended, why: 'the first drawing did not load, so it was redrawn' } }); }
      }
      sendSSE(res, createChatCompletionChunk(targetModel, '', true, totalUsage));
      sendSSEDone(res);
      res.end();
      board.endRun(runId);
    } catch (error) {
      board.endRun(runId, { failed: true });
      sendSSE(res, { error: { message: error.message, type: 'server_error' } });
      sendSSEDone(res);
      res.end();
    }
  } else {
    let fullContent = '';
    const totalUsage = usageTally();

    try {
      let runError = null;
      for await (const event of runAgent({ target, messages, ctx, config, maxIterations: 40 })) {
        const last = textDelta(event) || finalText(event, fullContent);
        if (last) {
          fullContent += last;
        } else if (event.type === 'usage') {
          tallyUsage(totalUsage, event);
        } else if (event.type === 'error') {
          runError = String(event.error);
        }
      }
      if (liveUi && turnMode.answerOnly && fullContent) fullContent = (await repairLiveUi({ text: fullContent, target, messages, ctx, config, usage: totalUsage })) ?? fullContent;
      board.endRun(runId);
      // The lenient contract stays (200, empty content, see the surface test),
      // but a run that stopped (rate limit, missing key) says why in an extra
      // field OpenAI clients ignore.
      sendJson(res, 200, { ...createChatCompletionResponse(targetModel, fullContent, totalUsage), ...(!fullContent && runError ? { ox_error: runError } : {}) });
    } catch (error) {
      board.endRun(runId, { failed: true });
      const shape = agentErrorShape(error.message);
      sendError(res, shape.status, error.message, shape.type, shape.code, shape.param);
    }
  }
}

async function handleHealth(req, res) {
  if (!authorized(req)) return unauthorized(res);
  sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// /v1/responses — the newer Responses API.
//
// Scope, stated up front because a partial thing dressed as a whole thing is the
// defect this project keeps removing: this implements the CORE shape — text
// input, text output, streaming and blocking, usage, the standard error body —
// and it REJECTS, rather than ignores, every field that would imply server-side
// state ox does not have. Nothing accepted here is silently dropped.
//
// Not implemented, by design: response storage / `previous_response_id` /
// `store: true`, Conversations, `background: true`, client-supplied function
// tools, non-text input parts, and the get/list/delete response endpoints. Each
// is a 400 with the field named, not a 200 with the work skipped.
// ---------------------------------------------------------------------------

const RESPONSES_REJECTED = {
  previous_response_id: 'ox serve keeps no response store, so there is no earlier response to continue',
  conversation: 'ox serve implements no Conversations API',
  background: 'ox serve runs a response inside the request; there is no background mode',
  store: 'ox serve does not persist responses; pass store:false',
};

function rejectedResponsesField(body) {
  for (const [field, why] of Object.entries(RESPONSES_REJECTED)) {
    const v = body[field];
    if (v === undefined || v === null || v === false) continue;
    return { field, why, value: v };
  }
  return null;
}

const RESPONSES_ROLES = new Set(['user', 'assistant', 'system', 'developer']);

function responsesInputToMessages(input) {
  if (typeof input === 'string') {
    if (!input.trim()) {
      return { error: { message: "'input' must not be empty.", param: 'input', code: 'invalid_value' } };
    }
    return { messages: [{ role: 'user', content: input }] };
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { error: { message: "'input' must be a non-empty string or a non-empty array of input items.", param: 'input', code: 'invalid_type' } };
  }
  const messages = [];
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') {
      return { error: { message: 'every item in `input` must be a string or an object.', param: 'input', code: 'invalid_type' } };
    }
    if (item.type && item.type !== 'message') {
      return { error: { message: `unsupported \`input\` item type '${item.type}'. ox serve accepts message items only: a bare string, or {role, content}.`, param: 'input', code: 'unsupported_value' } };
    }
    const role = item.role ?? 'user';
    if (!RESPONSES_ROLES.has(role)) {
      return { error: { message: `unsupported role '${role}' in \`input\` (expected one of ${[...RESPONSES_ROLES].join(', ')}).`, param: 'input', code: 'invalid_value' } };
    }
    let content = item.content;
    if (Array.isArray(content)) {
      const texts = [];
      for (const part of content) {
        if (typeof part === 'string') { texts.push(part); continue; }
        const type = part?.type;
        if (type === 'input_text' || type === 'output_text' || type === 'text') {
          if (typeof part.text !== 'string') {
            return { error: { message: `content part of type '${type}' needs a string \`text\`.`, param: 'input', code: 'invalid_type' } };
          }
          texts.push(part.text);
          continue;
        }
        // Returning prose for an image part would be a lie about what the model
        // saw, so a non-text part is refused instead.
        return { error: { message: `unsupported content part type '${type}'. ox serve is text-only on this endpoint.`, param: 'input', code: 'unsupported_value' } };
      }
      content = texts.join('\n');
    }
    if (typeof content !== 'string') {
      return { error: { message: 'every item in `input` needs string `content` or an array of content parts.', param: 'input', code: 'invalid_type' } };
    }
    messages.push({ role, content });
  }
  return { messages };
}

let responseCounter = 0;
function nextResponseId() {
  responseCounter += 1;
  return `resp_${Date.now().toString(36)}${responseCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createResponseObject({ id, model, content, usage = {}, status = 'completed', instructions = null, temperature = null, error = null }) {
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const messageId = `${id}_msg`;
  const inProgress = status === 'in_progress';
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    // No function tools were registered through this API, so `tools` is empty.
    // That is not the same as "the model has no tools" — see `ox.agent_tools`.
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    // The assistant turn in the Responses shape: an output item of type message
    // wrapping one output_text content part.
    // A response that never produced output carries none — not an empty message.
    output: (inProgress || error) ? [] : [{
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content ?? '', annotations: [] }],
    }],
    output_text: content ?? '',
    error,
    incomplete_details: null,
    instructions,
    max_output_tokens: null,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature,
    text: { format: { type: 'text' } },
    top_p: null,
    truncation: 'disabled',
    usage: inProgress || error ? null : {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
    metadata: {},
    // Not an OpenAI field. ox's own tools (bash, file writes, network) are
    // always available to the turn and are not OpenAI function tools, so they
    // cannot be represented in `tools`; saying so is cheaper than leaving a
    // client to assume the model is running with nothing to call.
    ox: {
      agent_tools: 'always enabled (ox tool set), not OpenAI function tools',
      response_api: 'core text shape only — no store, no conversations, no client tools, text input only',
    },
  };
}

function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
}

async function handleResponses(req, res) {
  if (!authorized(req)) return unauthorized(res);

  let body;
  try {
    body = await parseBody(req);
  } catch {
    sendInvalidJson(res);
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, 'Request body must be a JSON object.', 'invalid_request_error', 'invalid_type', null);
    return;
  }

  const rejected = rejectedResponsesField(body);
  if (rejected) {
    sendError(res, 400, `${rejected.why} (received \`${rejected.field}\`: ${JSON.stringify(rejected.value)}).`, 'invalid_request_error', 'unsupported_parameter', rejected.field);
    return;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sendError(res, 400, "ox serve does not accept client-supplied function tools — the turn always runs with ox's own tool set. Send an empty `tools` array.", 'invalid_request_error', 'unsupported_parameter', 'tools');
    return;
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== 'auto') {
    sendError(res, 400, `ox serve only supports \`tool_choice: "auto"\` (received ${JSON.stringify(body.tool_choice)}).`, 'invalid_request_error', 'unsupported_parameter', 'tool_choice');
    return;
  }
  if (Array.isArray(body.include) && body.include.length > 0) {
    sendError(res, 400, `ox serve implements no \`include\` values (received ${JSON.stringify(body.include)}).`, 'invalid_request_error', 'unsupported_parameter', 'include');
    return;
  }

  const model = body.model;
  if (typeof model !== 'string' || !model.trim()) {
    sendError(res, 400, "'model' is required.", 'invalid_request_error', 'missing_required_parameter', 'model');
    return;
  }
  if (body.input === undefined || body.input === null) {
    sendError(res, 400, "'input' is required.", 'invalid_request_error', 'missing_required_parameter', 'input');
    return;
  }

  const { messages, error: inputError } = responsesInputToMessages(body.input);
  if (inputError) {
    sendError(res, 400, inputError.message, 'invalid_request_error', inputError.code, inputError.param);
    return;
  }
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
    sendError(res, 400, "'instructions' must be a string.", 'invalid_request_error', 'invalid_type', 'instructions');
    return;
  }
  if (body.instructions) messages.unshift({ role: 'system', content: body.instructions });

  // Resolve the model through the real registry, so an id from /v1/models is an
  // id this endpoint can actually route to, and a typo is a 404 that names the
  // reason instead of a 200 carrying an empty string.
  let target;
  try {
    target = resolveBot(model.trim(), { bots: readConfigDoc().bots ?? {} });
  } catch (err) {
    sendError(res, 404, `The model '${model}' does not exist or cannot be resolved: ${err.message}`, 'invalid_request_error', 'model_not_found', 'model');
    return;
  }
  if (target.keyEnv && !process.env[target.keyEnv]) {
    sendError(res, 401, `Missing API key for ${target.provider}: set ${target.keyEnv} (no silent fallback)`, 'authentication_error', 'invalid_api_key', null);
    return;
  }

  const temperature = typeof body.temperature === 'number' ? body.temperature : null;
  const maxOutputTokens = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : null;
  const ctx = { cwd: process.cwd() };
  const config = { maxTokens: maxOutputTokens ?? undefined };
  const id = nextResponseId();
  const instructions = body.instructions ?? null;
  const run = { target, messages, ctx, config, maxIterations: 40 };

  if (body.stream) {
    openSSE(res);
    let seq = 0;
    const emit = (type, payload) => {
      seq += 1;
      sendSSE(res, { type, sequence_number: seq, ...payload });
    };
    let fullContent = '';
    const usage = usageTally();
    let failure = null;

    const inProgress = () => createResponseObject({ id, model, content: null, status: 'in_progress', instructions, temperature });
    emit('response.created', { response: inProgress() });
    emit('response.in_progress', { response: inProgress() });

    const itemId = `${id}_msg`;
    emit('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });

    let partOpen = false;
    try {
      for await (const event of runAgent(run)) {
        const last = textDelta(event) || finalText(event, fullContent);
        if (last) {
          fullContent += last;
          if (!partOpen) {
            partOpen = true;
            emit('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          }
          emit('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: last });
        } else if (event.type === 'usage') {
          tallyUsage(usage, event);
        } else if (event.type === 'error' && !failure) {
          failure = String(event.error || 'the agent turn failed');
        }
      }
    } catch (err) {
      failure = String(err?.message ?? err);
    }

    if (failure && !fullContent) {
      const shape = agentErrorShape(failure);
      emit('response.failed', {
        response: createResponseObject({ id, model, content: null, status: 'failed', instructions, temperature, error: { code: shape.code, message: failure } }),
      });
      emit('error', { code: shape.code ?? 'server_error', message: failure, param: shape.param });
      sendSSEDone(res);
      res.end();
      return;
    }

    emit('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: fullContent });
    emit('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullContent, annotations: [] } });
    emit('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullContent, annotations: [] }] } });
    emit('response.completed', { response: createResponseObject({ id, model, content: fullContent, usage, instructions, temperature }) });
    sendSSEDone(res);
    res.end();
    return;
  }

  // Non-streaming: the loop is drained to completion before a single byte is
  // written, so the caller gets one finished object or an error — never a
  // half-built one.
  let fullContent = '';
  const usage = usageTally();
  let failure = null;
  try {
    for await (const event of runAgent(run)) {
      const last = textDelta(event) || finalText(event, fullContent);
      if (last) {
        fullContent += last;
      } else if (event.type === 'usage') {
        tallyUsage(usage, event);
      } else if (event.type === 'error' && !failure) {
        failure = String(event.error || 'the agent turn failed');
      }
    }
  } catch (err) {
    failure = String(err?.message ?? err);
  }

  if (failure && !fullContent) {
    const shape = agentErrorShape(failure);
    sendError(res, shape.status, failure, shape.type, shape.code, shape.param);
    return;
  }
  sendJson(res, 200, createResponseObject({ id, model, content: fullContent, usage, instructions, temperature }));
}

// ---------------------------------------------------------------------------
// Routing.
//
// A table, so the whole surface is readable in one place and a known path with
// the wrong verb answers 405 instead of pretending the path does not exist.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /ox/settings — the app's settings: the island, the default model, keep-awake.
// Same guard as everything else (loopback host, own-page origin, bearer token
// when the server runs with --api-key).
// ---------------------------------------------------------------------------

async function settingsView() {
  const { islandEnabled, islandRunning } = await import('./island.js');
  const { readConfigDoc, loadConfig } = await import('./config.js');
  const doc = readConfigDoc();
  const config = loadConfig();
  const bots = Object.entries(BOTS).filter(([, d]) => d.model).map(([id, d]) => {
    const keyEnv = KEY_ENV[d.provider] ?? null;
    return { id, provider: d.provider, desc: d.desc, ready: !keyEnv || !!process.env[keyEnv], key: keyEnv };
  });
  // Your own endpoints (Settings › Custom endpoints) are choices here too.
  // And models picked in Settings › API keys ("Use").
  for (const [id, d] of Object.entries(doc.bots ?? {}).filter(([, d]) => d?.provider && d.model && (d.provider !== 'custom' || d.baseUrl))) {
    if (bots.some((b) => b.id === id)) continue;
    try { const t = resolveBot(id, { bots: doc.bots }); bots.unshift({ id, provider: d.provider, desc: t.desc, ready: !t.keyEnv || !!process.env[t.keyEnv], key: t.keyEnv }); } catch {}
  }
  const { assistantName } = await import('./identity.js');
  return {
    name: assistantName(),
    island: { enabled: islandEnabled(), running: islandRunning({ env: {} }), platform: process.platform },
    // What a new chat actually uses: the configured default if it can run, else the best that can.
    model: { defaultBot: pickWorkingDefault(), configured: config.defaultBot ?? null, source: runnable(config.defaultBot ?? '') ? (config.defaultBotSource ?? 'config') : 'auto: the configured model cannot run here', bots, fallback: (doc.fallback_bots ?? doc.fallbackBots ?? [])[0] ?? null },
    awake: { on: doc.awake !== false && process.env.OX_NO_AWAKE !== '1' },
  };
}

async function handleSettingsGet(req, res) {
  if (!authorized(req)) { unauthorized(res); return; }
  sendJson(res, 200, await settingsView());
}

async function handleSettingsPost(req, res) {
  if (!authorized(req)) { unauthorized(res); return; }
  let body;
  try { body = await parseBody(req); } catch { sendInvalidJson(res); return; }
  const { saveConfigDoc } = await import('./config.js');
  if (typeof body.island === 'boolean') {
    const { cmdIsland } = await import('./island.js');
    await cmdIsland([body.island ? 'on' : 'off'], { log: () => {}, err: () => {} });
  }
  // Restart: stop, rebuild (macOS) and start, so a new version of the island loads.
  if (body.islandRestart === true && !process.env.NODE_TEST_CONTEXT) {
    const { cmdIsland } = await import('./island.js');
    await cmdIsland(['restart'], { log: () => {}, err: () => {} });
  }
  if (typeof body.defaultBot === 'string') {
    try {
      resolveBot(body.defaultBot, { bots: readConfigDoc().bots ?? {} });
    } catch (e) {
      sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'invalid_bot', 'defaultBot');
      return;
    }
    saveConfigDoc((doc) => { doc.defaultBot = body.defaultBot; });
  }
  // The backup model: what a chat moves to when its own model fails (a key
  // revoked, a provider down, a rate limit). '' clears it.
  if (typeof body.fallbackBot === 'string') {
    if (body.fallbackBot) {
      try { resolveBot(body.fallbackBot, { bots: readConfigDoc().bots ?? {} }); } catch (e) { sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'invalid_bot', 'fallbackBot'); return; }
    }
    saveConfigDoc((doc) => { delete doc.fallbackBots; if (body.fallbackBot) doc.fallback_bots = [body.fallbackBot]; else delete doc.fallback_bots; });
  }
  if (typeof body.awake === 'boolean') saveConfigDoc((doc) => { doc.awake = body.awake; });
  if (typeof body.name === 'string') {
    try {
      (await import('./identity.js')).setAssistantName(body.name);
    } catch (e) {
      sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'invalid_name', 'name');
      return;
    }
  }
  sendJson(res, 200, await settingsView());
}

// The app's other screens (src/app-api.js): providers and keys, accounts,
// local models, capabilities, messaging, scheduled runs, terminal sessions.
function appRoute(fn) {
  return async (req, res, m) => {
    if (!authorized(req)) { unauthorized(res); return; }
    let body = null;
    if (req.method === 'POST') {
      try { body = await parseBody(req); } catch { sendInvalidJson(res); return; }
    }
    try {
      const out = await fn(body ?? {}, m, req);
      if (out == null) sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', null);
      else sendJson(res, 200, out);
    } catch (e) {
      sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'bad_request', null);
    }
  };
}
const appApi = () => import('./app-api.js');

// The AI tools on this Mac, for the island (Coucou's agent pills): plans and
// agent CLIs with their real state, local models, Hermes. From the cached
// checks, so this answers at once; the cache refreshes in the background.
async function connectedRoute() {
  if (Date.now() - planCache.at > 10 * 60_000 && process.env.OX_NO_PLAN_CHECK !== '1' && process.env.OX_NO_KEYSTORE !== '1') refreshPlans();
  if (Date.now() - ollamaCache.at > 5 * 60_000 && process.env.OX_NO_KEYSTORE !== '1') refreshOllama();
  const tools = planCache.list.filter((p) => p.installed).map((p) => ({
    id: p.id, name: p.label.replace(/\s*\(.*?\)/g, '').replace(/ via .*/, ''), via: (p.label.match(/via (.+)$/) ?? [])[1] ?? p.bin,
    state: p.works ? 'ready' : 'sign-in', fix: p.works ? null : p.fix ?? p.problem ?? null,
  }));
  const local = localOllama();
  if (local.length) tools.push({ id: 'ollama', name: 'Ollama', via: `${local.length} model${local.length === 1 ? '' : 's'} on this Mac`, state: 'ready', fix: null });
  if (existsSync(join(homedir(), '.hermes'))) tools.push({ id: 'hermes', name: 'Hermes', via: 'installed', state: 'ready', fix: null });
  return { tools, checkedAt: planCache.at || null };
}

// ox Flows (src/flows.js): list with recent runs, save / remove / run / draft.
async function flowsRoute(b) {
  const F = await import('./flows.js');
  switch (b.action) {
    case 'save': return { flow: F.saveFlow(b.flow ?? {}) };
    case 'remove': return { removed: F.removeFlow(String(b.id ?? '')) };
    case 'run': return { run: await F.runFlow(String(b.id ?? ''), { input: b.input ?? null, trigger: 'manual' }) };
    case 'draft': {
      if (!String(b.text ?? '').trim()) throw new Error('Describe what the automation should do.');
      const flow = await F.draftFlow(String(b.text));
      return { flow, problems: await F.checkFlow(flow) };
    }
    case 'check': return { problems: [...F.validateFlow(b.flow ?? {}), ...(F.validateFlow(b.flow ?? {}).length ? [] : await F.checkFlow(b.flow))] };
    case 'enable': {
      const f = F.loadFlow(String(b.id ?? ''));
      if (!f) return null;
      return { flow: F.saveFlow({ ...f, enabled: b.enabled !== false }) };
    }
    default: throw new Error('action must be save, remove, run, draft or enable');
  }
}

// OX Island's voice (Coucou's shape): what you said, answered by the ox that is
// already running instead of a new process per request (on a busy Mac starting
// Node alone took 1.9 s, and a question went through a whole agent run: 41 s).
// Small tasks are done here with no AI; a question or small talk gets one short
// spoken answer from the quickest model that can answer; anything that has to
// act (open, send, play, write…) comes back as a task for an agent run.
const VOICE_SYSTEM = (name) => `You are ${name}, a voice assistant in the notch of the user's Mac: quick, warm, a little playful. Everything you write is read aloud: one or two short sentences, no markdown, no lists, no emojis, no links. Never invent the user's own data; if you would need to act on the Mac or look something up, say so in a few words. Today is ${new Date().toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
// Questions about what is on screen need a look at it: the island attaches a screenshot.
const SCREEN = /\b(my screen|on (?:the|my) screen|what am i looking at|what(?:'s| is) (?:this|that) (?:on|in)|this (?:page|window|screen|tab|error|message)|read (?:this|it|my screen)|look at (?:this|my|the screen)|see (?:this|my screen)|what do you see)\b/i;
const ACTS = /\b(open|launch|close|quit|send|message|text|whatsapp|email|mail|play|pause|create|make|write|draft|delete|remove|move|rename|book|order|buy|schedule|remind|call|download|install|draw|annotate|search|look up|find|fix|build|run|deploy|commit|push|edit|change|update|turn (?:on|off)|set)\b/i;
export async function voiceTurn(body) {
  const started = Date.now();
  const text = String(body?.text ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('nothing was said');
  const { doOffline } = await import('./offline.js');
  const done = doOffline(text, { dryRun: body?.dryRun === true });
  if (done.handled) return { route: 'offline', handled: true, ok: done.ok !== false, say: done.message, ms: Date.now() - started };
  // The island asks this first while a coding run is open: an errand ("play
  // Billie Jean", "volume down") is done here and never sent into that run.
  if (body?.offlineOnly === true) return { route: 'live', handled: false, why: 'not a small task', ms: Date.now() - started };
  if (SCREEN.test(text) && !body?.image) return { route: 'screen', handled: false, why: 'it needs a look at your screen', ms: Date.now() - started };
  const { assistantName } = await import('./identity.js');
  // Small talk and questions: one short answer. Anything that acts: an agent.
  await warmLocal();
  const pick = autoModel([{ role: 'user', content: text }]);
  const light = /^a quick answer/.test(pick.why) && !ACTS.test(text);
  if (!light) return { route: 'agent', handled: false, why: 'this needs ox to act', ms: Date.now() - started };
  let target;
  try { target = resolveBot(pick.id, { bots: readConfigDoc().bots ?? {} }); } catch (e) { return { route: 'agent', handled: false, why: e.message, ms: Date.now() - started }; }
  const { quickText } = await import('./quick-text.js');
  try {
    const r = await quickText(target, { system: VOICE_SYSTEM(assistantName()), user: text, maxTokens: 160 });
    const say = String(r.text ?? '').replace(/[*_`#>]+/g, '').trim();
    if (!say) return { route: 'agent', handled: false, why: `${pick.id} said nothing`, ms: Date.now() - started };
    return { route: 'answer', handled: true, ok: true, say, model: pick.id, ms: Date.now() - started };
  } catch (e) {
    return { route: 'agent', handled: false, why: String(e?.message ?? e).slice(0, 200), ms: Date.now() - started };
  }
}

// While OX Island is running, the local model the voice answers with stays
// loaded: a cold start took 24 s on this Mac, a warm answer 7 s. Ollama only,
// on this machine, nothing sent anywhere.
export async function warmVoiceModel() {
  try {
    if (!existsSync(join(homedir(), '.ox', 'island.json'))) return false;
    await warmLocal();
    const model = localOllama()[0];
    if (!model) return false;
    const base = (process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434');
    const r = await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: '30m' }), signal: AbortSignal.timeout(60_000) });
    return r.ok;
  } catch { return false; }
}

// The task board (src/tasks.js, Paperclip's model): every task with whether
// it is ready, who holds it, and the activity log; add / move / run / review.
const prCache = new Map();
export async function tasksView() {
  const T = await import('./tasks.js');
  const ready = new Set(T.readyTasks().map((t) => t.id));
  const tasks = T.listTasks().map((t) => ({ ...t, ready: ready.has(t.id), owner: T.taskOwner(t.id)?.owner ?? null, prState: t.branch ? prCache.get(t.branch)?.v ?? null : null }));
  // PR and CI state on the board (agent-orchestrator), refreshed in the background, at most once a minute per branch.
  for (const t of tasks) if (t.branch && !(Date.now() - (prCache.get(t.branch)?.at ?? 0) < 60_000)) {
    prCache.set(t.branch, { at: Date.now(), v: prCache.get(t.branch)?.v ?? null });
    import('./dev-flow.js').then((D) => prCache.set(t.branch, { at: Date.now(), v: D.prForBranch(process.cwd(), t.branch) })).catch(() => {});
  }
  return { tasks, activity: T.taskActivity({ limit: 40 }).reverse(), statuses: T.STATUSES };
}
async function tasksRoute(b) {
  const T = await import('./tasks.js');
  const id = String(b.id ?? '');
  const by = { actor: 'you (app)' };
  switch (b.action) {
    case 'add': {
      const title = String(b.title ?? '').trim();
      if (!title) throw new Error('a task needs a title');
      const budget = b.budgetUsd === '' || b.budgetUsd == null ? null : Number(b.budgetUsd);
      return { task: T.addTask({ title: title.slice(0, 200), description: String(b.description ?? '').slice(0, 4000), review: b.review === true, budgetUsd: Number.isFinite(budget) ? budget : null, blockedBy: Array.isArray(b.blockedBy) ? b.blockedBy : [], parentId: b.parentId || null }, by) };
    }
    case 'move': {
      if (!T.STATUSES.includes(b.status)) throw new Error(`status is one of ${T.STATUSES.join(', ')}`);
      return { task: T.updateTask(id, { status: b.status }, by) };
    }
    case 'approve': return T.approveTask(id, by);
    case 'reject': return T.rejectTask(id, { ...by, reason: String(b.reason ?? 'sent back from the app') });
    case 'release': return T.releaseTask(id, by);
    case 'delete': return { ok: T.deleteTask(id, by) };
    case 'run': {
      // An ox run claims it and works on it; the board shows it as it goes.
      if (!T.getTask(id)) throw new Error('no such task');
      T.runTask(id, { owner: 'ox (app)' }).catch(() => {});
      return { started: true };
    }
    default: throw new Error('action is add, move, approve, reject, release, delete or run');
  }
}

// A flow's webhook: POST /ox/flows/hook/<id>?secret=<its secret>; the JSON body is {{input}}.
async function flowHook(req, res, m) {
  const F = await import('./flows.js');
  const f = F.loadFlow(m[1]);
  const given = new URL(req.url, 'http://x').searchParams.get('secret') ?? req.headers['x-ox-secret'] ?? '';
  if (!f || f.trigger?.type !== 'webhook' || !f.trigger.secret || !constantTimeEqual(String(given), f.trigger.secret)) {
    sendError(res, 404, 'No such flow, or the secret is wrong.', 'invalid_request_error', 'not_found', null);
    return;
  }
  let input = null;
  try { input = await parseBody(req); } catch { input = null; }
  try { sendJson(res, 200, { run: await F.runFlow(f, { input, trigger: 'webhook' }) }); }
  catch (e) { sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'bad_request', null); }
}

const MEDIA_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
async function serveMediaFile(req, res, m) {
  if (!authorized(req)) { unauthorized(res); return; }
  const f = await (await appApi()).mediaFile(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (!f) { sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', null); return; }
  const st = await stat(f);
  res.writeHead(200, { 'Content-Type': MEDIA_TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(f).pipe(res);
}

// The app's "Read aloud" in Kokoro's natural voice: POST { text, voice } and get
// a WAV back. The model stays loaded in one worker for every later sentence.
async function handleSpeak(req, res) {
  if (!authorized(req)) { unauthorized(res); return; }
  let body;
  try { body = await parseBody(req); } catch { sendInvalidJson(res); return; }
  const k = await import('./kokoro.js');
  if (!k.kokoroStatus().ready) { sendError(res, 409, 'Kokoro is not set up. Run: ox voice install', 'invalid_request_error', 'voice_not_installed', null); return; }
  let r;
  try { r = await k.kokoroSpeak(String(body?.text ?? ''), { voice: body?.voice || undefined, speed: Math.max(0.5, Math.min(2, Number(body?.speed) || 1)) }); }
  catch (e) { sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'speak_failed', null); return; }
  const st = await stat(r.out);
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const s = createReadStream(r.out);
  s.pipe(res);
  s.on('close', () => { unlink(r.out).catch(() => {}); });
}

// Follow-up suggestions under an answer: the chat's own model, no tools, a tiny prompt.
async function followupsRoute(b) {
  const spec = String(b.model ?? '').trim();
  let botSpec = spec;
  if (spec.startsWith('agent:')) { const a = loadAgent(spec.slice(6)); botSpec = (a && agentBotSpec(a)) || ''; }
  if (!botSpec) botSpec = defaultBotSpec({}, process.env) ?? 'ox-grok';
  const target = resolveBot(botSpec, { bots: readConfigDoc().bots ?? {} });
  const { followups } = await import('./followups.js');
  const r = await followups({ target, question: b.question, answer: b.answer });
  // Counted like every other run, as a helper call (Settings › Usage).
  if (r.usage && process.env.OX_USAGE_LOG !== '0') {
    try { (await import('./usage-log.js')).recordRun({ surface: 'app', mode: 'followups', rows: [{ id: 'aux', model: target.model, ...r.usage }] }); } catch {}
  }
  return { items: r.items };
}

// The chat box's wand: a rough message in, a clearer prompt out. "auto" uses
// the quick pick (a local or fast model), so it costs a few hundred tokens.
async function optimizeRoute(b) {
  let spec = String(b.model ?? '').trim();
  if (spec === 'auto' || !spec) { await warmLocal(); spec = autoModel([{ role: 'user', content: 'hi' }]).id; }
  if (spec.startsWith('agent:')) { const a = loadAgent(spec.slice(6)); spec = (a && agentBotSpec(a)) || ''; }
  if (!spec) spec = defaultBotSpec({}, process.env) ?? 'ox-grok';
  const target = resolveBot(spec, { bots: readConfigDoc().bots ?? {} });
  const { optimizePrompt } = await import('./prompt-optimizer.js');
  const r = await optimizePrompt({ target, text: b.text });
  if (r.usage && process.env.OX_USAGE_LOG !== '0') {
    try { (await import('./usage-log.js')).recordRun({ surface: 'app', mode: 'optimize', rows: [{ id: 'aux', model: target.model, ...r.usage }] }); } catch {}
  }
  if (!r.text) throw new Error('The model did not return a usable prompt. Try again or pick another model.');
  return { text: r.text, model: spec };
}

// A picture for an answer: GET /ox/image?q=Pena%20Palace -> the image bytes (cached).
async function handleImage(req, res) {
  if (!authorized(req)) { unauthorized(res); return; }
  const q = new URL(req.url, 'http://x').searchParams.get('q') ?? '';
  let r = null;
  try { r = await (await import('./image-search.js')).findImage(q); } catch {}
  if (!r) { sendError(res, 404, 'No picture found', 'invalid_request_error', 'not_found', null); return; }
  const st = await stat(r.file);
  res.writeHead(200, { 'Content-Type': r.type, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=604800', 'X-Content-Type-Options': 'nosniff', 'X-Ox-Credit': encodeURIComponent(r.credit) });
  createReadStream(r.file).pipe(res);
}

// The island's day strip (theaiskool's widgets, Coucou's GitHub pills): the next
// calendar event (only when Calendar is open: never launches it), the weather
// (wttr.in, no key), and your open pull requests with their CI. Cached.
const dayCache = { at: 0, v: null, pending: null };
async function dayView() {
  if (dayCache.v && Date.now() - dayCache.at < 10 * 60_000) return dayCache.v;
  if (dayCache.pending) return dayCache.pending;
  dayCache.pending = (async () => {
    const { spawnSync } = await import('node:child_process');
    const out = { event: null, weather: null, prs: null };
    if (process.platform === 'darwin') {
      const running = spawnSync('pgrep', ['-x', 'Calendar']).status === 0;
      if (running) {
        const script = 'set out to ""\ntell application "Calendar"\nset nowD to current date\nset best to missing value\nset bestT to nowD + 2 * days\nrepeat with c in calendars\ntry\nset evs to (every event of c whose start date > nowD and start date < bestT)\nrepeat with e in evs\nif start date of e < bestT then\nset bestT to start date of e\nset best to e\nend if\nend repeat\nend try\nend repeat\nif best is not missing value then set out to (summary of best) & "\t" & ((start date of best) as «class isot» as string)\nend tell\nreturn out';
        const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 8000 });
        const [title, at] = String(r.stdout ?? '').trim().split('\t');
        if (title && at) out.event = { title: title.slice(0, 80), at };
      }
    }
    try {
      const r = await fetch('https://wttr.in/?format=j1', { headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(6000) });
      if (r.ok) { const j = await r.json(); const c = j.current_condition?.[0]; if (c) out.weather = { tempC: Number(c.temp_C), feelsC: Number(c.FeelsLikeC), text: c.weatherDesc?.[0]?.value ?? '', place: j.nearest_area?.[0]?.areaName?.[0]?.value ?? null }; }
    } catch {}
    const gh = spawnSync('gh', ['api', 'graphql', '-f', 'query=query{viewer{pullRequests(states:OPEN,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{title number url repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'], { encoding: 'utf8', timeout: 15000 });
    if (gh.status === 0) {
      try {
        const nodes = JSON.parse(gh.stdout).data.viewer.pullRequests.nodes;
        const list = nodes.map((n) => ({ title: n.title, number: n.number, url: n.url, repo: n.repository.nameWithOwner, ci: n.commits.nodes[0]?.commit?.statusCheckRollup?.state ?? null }));
        out.prs = { open: list.length, failing: list.filter((x) => ['FAILURE', 'ERROR'].includes(x.ci)).length, list: list.slice(0, 6) };
      } catch {}
    }
    dayCache.v = out; dayCache.at = Date.now(); dayCache.pending = null;
    return out;
  })().catch((e) => { dayCache.pending = null; throw e; });
  return dayCache.pending;
}

// ox mesh (src/mesh.js): this machine's node, started with the server once
// the machine has a mesh identity (made by the first `ox mesh` pairing).
let meshNode = null;
let meshStarting = null;
async function meshUp() {
  if (meshNode) return meshNode;
  meshStarting ??= (async () => {
    const M = await import('./mesh.js');
    meshNode = await M.startNode({ plans: M.planHeadroom, onLog: (l) => console.log(`[mesh] ${l}`) });
    return meshNode;
  })().catch((e) => { meshStarting = null; throw e; });
  return meshStarting;
}
async function meshView() {
  if (meshNode) return { running: true, ...meshNode.status() };
  const M = await import('./mesh.js');
  // Another process (ox mesh up) may run this machine's node.
  try { return { running: true, ...(await M.control('status', { timeoutMs: 800 })) }; } catch {}
  const has = existsSync(join(process.env.OX_HOME || join(homedir(), '.ox'), 'mesh', 'identity.json'));
  return { running: false, me: has ? { id: M.identity().id, name: M.identity().name } : null, peers: Object.values(M.readPeers()).map((p) => ({ id: p.id, name: p.name, grants: p.grants, pairedAt: p.pairedAt })), alerts: [] };
}

// One small model call for a theme, with whichever model ox works with.
async function themeAsk() {
  try {
    const { loadConfig } = await import('./config.js');
    const { resolveBot } = await import('./bots.js');
    const { workingModelSpec } = await import('./working-model.js');
    const { quickText } = await import('./quick-text.js');
    const cfg = loadConfig();
    const target = resolveBot(await workingModelSpec(cfg, { say: () => {} }), cfg);
    return async ({ system, user }) => (await quickText(target, { system, user, maxTokens: 1500 })).text;
  } catch { return null; }
}

const ROUTES = [
  // Pull requests (src/dev-flow.js): Open a PR in one click, its CI and reviews, one fix round.
  { method: 'GET', pattern: /^\/ox\/pr\/?$/, handler: appRoute(async (_, __, req) => {
    const D = await import('./dev-flow.js');
    const dir = new URL(req.url, 'http://x').searchParams.get('cwd') || process.cwd();
    return { status: D.prStatus(dir), recipe: D.readRecipe(D.repoRoot(dir)) };
  }) },
  { method: 'POST', pattern: /^\/ox\/pr\/(open|fix)\/?$/, handler: appRoute(async (body, m) => {
    const D = await import('./dev-flow.js');
    const dir = String(body?.cwd || process.cwd());
    if (m[1] === 'open') return D.openPr(dir, { title: body?.title || null, body: body?.body ?? '', draft: body?.draft === true, capture: Array.isArray(body?.shots) ? { routes: body.shots } : null });
    return D.fixPr(dir, {});
  }) },
  { method: 'GET', pattern: /^\/ox\/day\/?$/, handler: appRoute(dayView) },
  // Slash commands in the app (src/slash-catalog.js): the menu, and running one of the inline-safe ones.
  { method: 'GET', pattern: /^\/ox\/commands\/?$/, handler: appRoute(async () => ({ commands: (await import('./slash-catalog.js')).COMMANDS })) },
  { method: 'POST', pattern: /^\/ox\/commands\/run\/?$/, handler: appRoute(async (body) => {
    const S = await import('./slash-catalog.js');
    const p = S.parse(String(body?.line ?? ''));
    if (!p) throw new Error('not an ox command (type / for the list)');
    if (!p.cmd.app) throw new Error(`/${p.cmd.name} runs in a session: ask ox to do it, or use the terminal`);
    const { spawn } = await import('node:child_process');
    const bin = new URL('../bin/ox.js', import.meta.url).pathname;
    const cwd = typeof body?.cwd === 'string' && body.cwd ? body.cwd : process.cwd();
    // Its own process, no shell, nothing to type into: a command that would ask stops instead.
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, p.cmd.name, ...p.args], { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const add = (d) => { if (out.length < 40_000) out += d; };
      child.stdout.on('data', add); child.stderr.on('data', add);
      const timer = setTimeout(() => { child.kill(); add('\n(stopped after the time limit)'); }, p.cmd.slow ? 300_000 : 60_000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ command: p.cmd.name, code, out: out.replace(/\x1b\[[0-9;]*m/g, '').trimEnd() }); });
    });
  }) },
  // Themes (src/ui-theme.js): the active look, and making or switching one.
  { method: 'GET', pattern: /^\/ox\/theme\/?$/, handler: appRoute(async () => { const T = await import('./ui-theme.js'); const t = T.current(); return { theme: t, css: T.css(t), themes: T.list() }; }) },
  { method: 'POST', pattern: /^\/ox\/theme\/?$/, handler: appRoute(async (body) => {
    const T = await import('./ui-theme.js');
    if (body?.reset) { T.reset(); return { theme: null }; }
    if (body?.use) return { theme: T.use(String(body.use)) };
    return { theme: await T.fromPrompt(String(body?.prompt ?? ''), { ask: await themeAsk() }) };
  }) },
  // The fast browser (src/fast-browser.js): the live run (OX Island's browser card) and starting one.
  { method: 'GET', pattern: /^\/ox\/browse\/?$/, handler: appRoute(async () => ({ live: (await import('./fast-browser.js')).readLive() })) },
  { method: 'POST', pattern: /^\/ox\/browse\/run\/?$/, handler: appRoute(async (body) => {
    const F = await import('./fast-browser.js');
    const goal = String(body?.goal ?? '').trim();
    const url = String(body?.url ?? '').trim();
    if (!goal) throw new Error('a goal is needed');
    if (url && !/^https?:\/\//.test(url)) throw new Error('the start page is an http(s) link');
    const cur = F.readLive();
    if (cur?.status === 'running' && Date.now() - (cur.at ?? 0) < 60_000) throw new Error('a browser run is already going');
    // Runs on; the island and the app follow it through GET /ox/browse. Buy/pay/send/delete clicks stop it.
    F.runGoal(goal, { url: url || 'about:blank', headless: body?.show !== true }).catch(() => {});
    return { started: true };
  }) },
  // Your reading library (src/library.js): the shelf, one item, add, highlight, ask.
  { method: 'GET', pattern: /^\/ox\/library\/?$/, handler: appRoute(async () => ({ items: (await import('./library.js')).list() })) },
  { method: 'GET', pattern: /^\/ox\/library\/([a-f0-9]{6,20})\/?$/, handler: appRoute(async (_, m) => (await import('./library.js')).load(m[1])) },
  { method: 'POST', pattern: /^\/ox\/library\/(add|ask|highlight|remove)\/?$/, handler: appRoute(async (body, m) => {
    const L = await import('./library.js');
    if (m[1] === 'add') return { item: await L.add(String(body?.ref ?? '')) };
    if (m[1] === 'highlight') return { highlights: L.highlight(String(body?.id ?? ''), body?.quote, body?.note ?? '') };
    if (m[1] === 'remove') return { removed: L.remove(String(body?.id ?? '')) };
    return L.askAbout(String(body?.id ?? ''), String(body?.question ?? ''), { quote: body?.quote ?? null, ask: async ({ system, user }) => {
      const { quickText } = await import('./quick-text.js');
      return (await quickText(resolveBot(pickWorkingDefault(), { bots: readConfigDoc().bots ?? {} }), { system, user, maxTokens: 700 })).text;
    } });
  }) },
  // Dictation styles and translation, per app (src/dictation-style.js).
  { method: 'POST', pattern: /^\/ox\/dictation\/style\/?$/, handler: appRoute(async (body) => {
    const D = await import('./dictation-style.js');
    return D.restyle(String(body?.text ?? ''), String(body?.app ?? ''), async ({ system, user }) => {
      const { quickText } = await import('./quick-text.js');
      return (await quickText(resolveBot(pickWorkingDefault(), { bots: readConfigDoc().bots ?? {} }), { system, user, maxTokens: 800 })).text;
    });
  }) },
  // Your machines (ox mesh): status, an invite code, names, grants, and your
  // choice on an alert. Grants are set here, for what this machine gives.
  { method: 'GET', pattern: /^\/ox\/mesh\/?$/, handler: appRoute(meshView) },
  { method: 'POST', pattern: /^\/ox\/mesh\/(invite|name|allow|deny|forget|choose)\/?$/, handler: appRoute(async (body, m) => {
    const M = await import('./mesh.js');
    switch (m[1]) {
      case 'invite': {
        const node = await meshUp().catch(() => null);
        if (node) return node.invite();
        return M.control('invite', { method: 'POST' });
      }
      case 'name': return { name: M.setName(String(body?.name ?? '')) };
      case 'allow': case 'deny': return { peer: M.setGrant(String(body?.machine ?? ''), String(body?.grant ?? ''), m[1] === 'allow') };
      case 'forget': return { forgot: M.forget(String(body?.machine ?? '')).name };
      default: {
        if (!meshNode) throw new Error('the mesh is not running in this app');
        const out = meshNode.choose(String(body?.alert ?? ''), body?.option ?? {});
        // Your choice of another machine's model: the next turns use it (switch back in Settings).
        if (out.model) { resolveBot(out.model, { bots: readConfigDoc().bots ?? {} }); (await import('./config.js')).saveConfigDoc((doc) => { doc.defaultBot = out.model; }); }
        return out;
      }
    }
  }) },
  // The company of agents (src/org.js, after Paperclip) for the island: who works
  // here, hires waiting for you, and wake / approve / reject from the notch.
  { method: 'GET', pattern: /^\/ox\/org\/?$/, handler: appRoute(async () => {
    const O = await import('./org.js');
    const { readyFor } = O;
    const agents = Object.values(O.readOrg().agents).filter((a) => a.status !== 'terminated').map((a) => ({
      id: a.id, name: a.name, title: a.title, runtime: a.runtime, status: a.status, why: a.pausedWhy ?? null, hiredBy: a.hiredBy,
      spent: O.spentThisMonth(a), budget: a.budgetUsd, lastBeat: a.lastBeat, every: a.heartbeatMin,
      next: (() => { try { return readyFor(a.id)[0]?.title ?? null; } catch { return null; } })(),
    }));
    return { agents, proposed: agents.filter((a) => a.status === 'proposed') };
  }) },
  { method: 'GET', pattern: /^\/ox\/org\/timeline\/?$/, handler: appRoute(async () => (await import('./org.js')).timeline({ limit: 150 })) },
  { method: 'GET', pattern: /^\/ox\/org\/thread\/([a-z0-9-]{1,40})\/?$/, handler: appRoute(async (_, m) => (await import('./org.js')).thread(m[1])) },
  { method: 'GET', pattern: /^\/ox\/org\/groups\/?$/, handler: appRoute(async () => ({ groups: (await import('./org.js')).readOrg().groups })) },
  { method: 'POST', pattern: /^\/ox\/org\/(team|say)\/?$/, handler: appRoute(async (body, m) => {
    const O = await import('./org.js');
    const ask = async ({ system, user }) => { const { quickText } = await import('./quick-text.js'); return (await quickText(resolveBot(pickWorkingDefault(), { bots: readConfigDoc().bots ?? {} }), { system, user, maxTokens: 600 })).text; };
    if (m[1] === 'say') return { replies: await O.groupSay(String(body?.group ?? ''), String(body?.text ?? ''), { ask }) };
    const draft = body?.draft && typeof body.draft === 'object' ? body.draft : await O.draftTeam(String(body?.sentence ?? ''), { ask });
    return body?.confirm ? O.hireTeam(draft) : { draft };
  }) },
  { method: 'POST', pattern: /^\/ox\/org\/(tell|hire)\/?$/, handler: appRoute(async (body, m) => {
    const O = await import('./org.js');
    if (m[1] === 'tell') { const r = await O.tell(String(body?.id ?? ''), String(body?.text ?? '')); if (body?.now) O.beat(r.agent.id).catch(() => {}); return { task: r.task }; }
    // Hire in words: drafted with the working model, shown back; hired only with confirm.
    const sentence = String(body?.sentence ?? '').trim();
    if (!sentence) throw new Error('describe the job in a sentence');
    const draft = body?.draft && typeof body.draft === 'object' ? body.draft : await O.draftHire(sentence, { ask: async ({ system, user }) => {
      const { quickText } = await import('./quick-text.js');
      return (await quickText(resolveBot(pickWorkingDefault(), { bots: readConfigDoc().bots ?? {} }), { system, user, maxTokens: 400 })).text;
    } });
    return body?.confirm ? { agent: O.hire(draft) } : { draft };
  }) },
  { method: 'POST', pattern: /^\/ox\/org\/(approve|reject|beat|pause|resume)\/?$/, handler: appRoute(async (body, m) => {
    const O = await import('./org.js');
    const id = String(body?.id ?? '');
    switch (m[1]) {
      case 'approve': return { agent: O.approveHire(id) };
      case 'reject': return { agent: O.rejectHire(id) };
      case 'pause': return { agent: O.pause(id) };
      case 'resume': return { agent: O.resume(id) };
      default: { O.beat(id).catch(() => {}); return { started: true }; }
    }
  }) },
  // Other agents' sessions (src/agents-live.js): read one, message it, open it in Terminal.
  { method: 'GET', pattern: /^\/ox\/agents\/?$/, handler: appRoute(async () => ({ sessions: (await import('./agents-live.js')).liveAgents() })) },
  { method: 'POST', pattern: /^\/ox\/agents\/session\/?$/, handler: appRoute(async (body) => { const A = await import('./agents-live.js'); const r = await A.sessionMessages(body?.id); return { ...r, queued: A.queuedFor(body?.id) }; }) },
  { method: 'POST', pattern: /^\/ox\/agents\/send\/?$/, handler: appRoute(async (body) => (await import('./agents-live.js')).sendToSession(body?.id, body?.text)) },
  { method: 'POST', pattern: /^\/ox\/agents\/open\/?$/, handler: appRoute(async (body) => (await import('./agents-live.js')).openInTerminal(body?.id)) },
  // Jump to the exact terminal tab the session runs in (Coucou); the island falls back to opening one.
  { method: 'POST', pattern: /^\/ox\/agents\/focus\/?$/, handler: appRoute(async (body) => (await import('./agents-live.js')).focusTerminal(body?.id)) },
  { method: 'GET', pattern: /^\/ox\/live\/?$/, handler: async (req, res) => { if (!authorized(req)) return unauthorized(res); sendJson(res, 200, (await import('./live-board.js')).liveBoard()); } },
  { method: 'GET', pattern: /^\/ox\/image\/?$/, handler: handleImage },
  { method: 'POST', pattern: /^\/ox\/followups\/?$/, handler: appRoute(followupsRoute) },
  { method: 'POST', pattern: /^\/ox\/optimize\/?$/, handler: appRoute(optimizeRoute) },
  // OpenUI Lang Query() lines in the app: only the read-only tools the language
  // allows, run in plan mode, so nothing an answer draws can change a file.
  { method: 'POST', pattern: /^\/ox\/canvas\/query\/?$/, handler: appRoute(async (b) => {
    const tool = String(b.tool ?? '');
    if (!UI_LANG.QUERY_TOOLS.has(tool)) throw new Error(`${tool} is not a read-only query tool`);
    const { dispatchTool } = await import('./tools/index.js');
    const r = await dispatchTool(tool, b.args && typeof b.args === 'object' ? b.args : {}, { cwd: process.cwd(), approval: 'plan', mode: 'plan' });
    return { content: String(r?.content ?? '').slice(0, 200_000), isError: !!r?.isError };
  }) },
  { method: 'POST', pattern: /^\/ox\/speak\/?$/, handler: handleSpeak },
  { method: 'GET', pattern: /^\/ox\/voice\/?$/, handler: appRoute(async () => { const k = await import('./kokoro.js'); const st = k.kokoroStatus(); return { kokoro: st.ready, install: 'ox voice install', voices: st.ready ? (await k.kokoroVoices()).map((id) => ({ id, label: k.VOICE_LABELS[id] ?? id })) : [], default: k.DEFAULT_VOICE }; }) },
  { method: 'GET', pattern: /^\/ox\/providers\/?$/, handler: appRoute(async () => (await appApi()).providersView()) },
  { method: 'POST', pattern: /^\/ox\/providers\/?$/, handler: appRoute(async (b) => { const a = await appApi(); if (b.action === 'test') return a.testProviderKey(String(b.provider ?? ''), typeof b.key === 'string' ? b.key : null); if (b.action === 'use') return a.useProviderModel(String(b.provider ?? ''), String(b.model ?? '')); return a.saveProviderKey(String(b.provider ?? ''), b.key ?? null); }) },
  // Any file from the app (videos, PDFs, audio, anything over 200 KB): saved,
  // then described for the model (src/uploads.js).
  { method: 'POST', pattern: /^\/ox\/upload\/?$/, handler: async (req, res) => {
    if (!authorized(req)) { unauthorized(res); return; }
    const U = await import('./uploads.js');
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-ox-filename'] ?? 'file')); } catch {}
    try {
      const { file, size } = await U.saveUpload(req, name);
      sendJson(res, 200, U.describeUpload(file, name, String(req.headers['content-type'] ?? ''), size));
    } catch (e) { sendError(res, 413, `upload refused: ${e?.message ?? e}`, 'invalid_request_error', 'upload_failed', null); }
  } },
  { method: 'GET', pattern: /^\/ox\/instructions\/?$/, handler: appRoute(async () => (await appApi()).instructionsView()) },
  { method: 'POST', pattern: /^\/ox\/instructions\/?$/, handler: appRoute(async (b) => (await appApi()).saveInstructions(b.text ?? '')) },
  { method: 'GET', pattern: /^\/ox\/connectors\/?$/, handler: appRoute(async () => (await appApi()).connectorsView()) },
  { method: 'POST', pattern: /^\/ox\/connectors\/?$/, handler: appRoute(async (b) => (await appApi()).saveConnector(b)) },
  { method: 'GET', pattern: /^\/ox\/update\/?$/, handler: appRoute(async () => (await appApi()).updateView()) },
  { method: 'GET', pattern: /^\/ox\/accounts\/?$/, handler: appRoute(async () => (await appApi()).accountsView()) },
  { method: 'GET', pattern: /^\/ox\/local\/?$/, handler: appRoute(async () => (await appApi()).localView()) },
  { method: 'GET', pattern: /^\/ox\/capabilities\/?$/, handler: appRoute(async () => (await appApi()).capabilitiesView()) },
  { method: 'GET', pattern: /^\/ox\/skills\/([^/]+)$/, handler: appRoute(async (_, m) => (await appApi()).skillBody(decodeURIComponent(m[1]))) },
  { method: 'GET', pattern: /^\/ox\/messaging\/?$/, handler: appRoute(async () => (await appApi()).messagingView()) },
  { method: 'GET', pattern: /^\/ox\/flows\/?$/, handler: appRoute(async () => { const F = await import('./flows.js'); return { flows: F.listFlows(), runs: F.flowRuns({ limit: 40 }), steps: F.FLOW_STEP_TYPES, triggers: F.FLOW_TRIGGERS }; }) },
  { method: 'POST', pattern: /^\/ox\/flows\/?$/, handler: appRoute(flowsRoute) },
  { method: 'GET', pattern: /^\/ox\/connected\/?$/, handler: appRoute(connectedRoute) },
  { method: 'GET', pattern: /^\/ox\/plan-usage\/?$/, handler: appRoute(async () => {
    const P = await import('./plan-usage.js');
    const plans = P.planUsage();
    // A notification before a limit is reached (once per level and reset period).
    const alerts = process.env.NODE_TEST_CONTEXT ? [] : P.limitAlerts(plans);
    if (alerts.length) { try { const { osCmd } = await import('./tools/operator.js'); const { spawnSync: run } = await import('node:child_process'); for (const a of alerts) { const c = osCmd('notify', a.text); if (c) run(c[0], c.slice(1), { timeout: 5000 }); } } catch {} }
    return { plans, alerts };
  }) },
  { method: 'POST', pattern: /^\/ox\/flows\/hook\/([a-z0-9-]{1,40})\/?$/, handler: flowHook },
  { method: 'POST', pattern: /^\/ox\/voice\/?$/, handler: appRoute(voiceTurn) },
  // The island's own recording, when live recognition heard nothing: whisper on this Mac.
  { method: 'POST', pattern: /^\/ox\/voice\/transcribe\/?$/, handler: appRoute(async (body) => {
    const { realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    let f = '';
    try { f = realpathSync(String(body?.path ?? '')); } catch { throw new Error('no recording there'); }
    // Only the island's voice recordings in the temp folder.
    if (!f.startsWith(realpathSync(tmpdir())) || !/\/ox-voice-[\w.-]+$/.test(f)) throw new Error('only the island\'s own recordings');
    const V = await import('./video-edit.js');
    const tr = V.transcribe(f);
    return { text: tr.segments.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim() };
  }) },
  { method: 'GET', pattern: /^\/ox\/tasks\/?$/, handler: appRoute(tasksView) },
  { method: 'POST', pattern: /^\/ox\/tasks\/?$/, handler: appRoute(tasksRoute) },
  { method: 'GET', pattern: /^\/ox\/scheduled\/?$/, handler: appRoute(async () => (await appApi()).scheduledView()) },
  { method: 'POST', pattern: /^\/ox\/scheduled\/?$/, handler: appRoute(async (b) => { const a = await appApi(); return b.action === 'add' ? a.scheduleAdd({ prompt: b.prompt, when: b.when, enabled: true }) : a.setScheduleEnabled(String(b.id ?? ''), b.enabled); }) },
  { method: 'GET', pattern: /^\/ox\/sessions\/?$/, handler: appRoute(async () => (await appApi()).sessionsView()) },
  { method: 'GET', pattern: /^\/ox\/sessions\/([^/]+)$/, handler: appRoute(async (_, m) => (await appApi()).sessionView(decodeURIComponent(m[1]))) },
  { method: 'GET', pattern: /^\/ox\/memory\/?$/, handler: appRoute(async () => (await appApi()).memoryView()) },
  { method: 'POST', pattern: /^\/ox\/memory\/?$/, handler: appRoute(async (b) => (await appApi()).memoryAction(b)) },
  { method: 'GET', pattern: /^\/ox\/market\/?$/, handler: appRoute(async (_, __, req) => (await import('./market.js')).search(new URL(req.url, 'http://x').searchParams.get('q') ?? '')) },
  { method: 'POST', pattern: /^\/ox\/market\/install\/?$/, handler: appRoute(async (b) => (await import('./market.js')).install({ name: b.name, catalog: b.catalog, repo: b.repo })) },
  { method: 'POST', pattern: /^\/ox\/market\/catalogs\/?$/, handler: appRoute(async (b) => ({ catalogs: await (await import('./market.js')).addCatalog(String(b.repo ?? '')) })) },
  { method: 'GET', pattern: /^\/ox\/studio\/?$/, handler: appRoute(async () => (await appApi()).studioView()) },
  { method: 'POST', pattern: /^\/ox\/studio\/create\/?$/, handler: appRoute(async (b) => (await appApi()).studioCreate(b)) },
  { method: 'POST', pattern: /^\/ox\/studio\/?$/, handler: appRoute(async (b) => (await appApi()).studioAction(b)) },
  { method: 'GET', pattern: /^\/ox\/media\/([^/]+)\/([^/]+)$/, handler: serveMediaFile },
  { method: 'GET', pattern: /^\/ox\/usage\/?$/, handler: appRoute(async (_, __, req) => (await import('./usage-log.js')).summarize({ days: Math.max(1, Math.min(365, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 30)) })) },
  { method: 'GET', pattern: /^\/ox\/map\/?$/, handler: appRoute(async () => (await import('./project-map.js')).projectMap(process.cwd())) },
  { method: 'GET', pattern: /^\/ox\/hf\/search\/?$/, handler: appRoute(async (_, __, req) => (await import('./hf-models.js')).searchModels(new URL(req.url, 'http://x').searchParams.get('q') ?? '')) },
  { method: 'GET', pattern: /^\/ox\/hf\/files\/?$/, handler: appRoute(async (_, __, req) => (await import('./hf-models.js')).modelFiles(new URL(req.url, 'http://x').searchParams.get('repo') ?? '')) },
  { method: 'POST', pattern: /^\/ox\/hf\/pull\/?$/, handler: appRoute(async (b) => (await import('./hf-models.js')).startPull(String(b.repo ?? ''), b.quant ? String(b.quant) : null)) },
  { method: 'GET', pattern: /^\/ox\/hf\/pulls\/?$/, handler: appRoute(async () => (await import('./hf-models.js')).pullJobs()) },
  { method: 'GET', pattern: /^\/ox\/bots\/?$/, handler: appRoute(async () => (await appApi()).botsView()) },
  { method: 'POST', pattern: /^\/ox\/bots\/?$/, handler: appRoute(async (b) => { const a = await appApi(); return b.action === 'delete' ? a.botDelete(String(b.name ?? '')) : a.botSave(b); }) },
  { method: 'POST', pattern: /^\/ox\/agents\/rename\/?$/, handler: appRoute(async (b) => { const { renameAgent } = await import('./agents.js'); const { saveConfigDoc } = await import('./config.js'); const a = renameAgent(String(b.from ?? ''), String(b.to ?? ''), { saveConfig: saveConfigDoc }); return { name: a.name }; }) },
  { method: 'GET', pattern: /^\/ox\/endpoints\/?$/, handler: appRoute(async () => (await import('./endpoints.js')).listEndpoints()) },
  { method: 'POST', pattern: /^\/ox\/endpoints\/?$/, handler: appRoute(async (b) => { const e = await import('./endpoints.js'); return b.action === 'remove' ? e.removeEndpoint(String(b.name ?? '')) : b.action === 'test' ? e.testEndpoint({ baseUrl: b.baseUrl, key: b.key ?? null, name: b.name ?? null }) : e.saveEndpoint({ name: b.name, baseUrl: b.baseUrl, model: b.model || null, key: b.key || null, desc: b.desc || '' }); }) },
  { method: 'GET', pattern: /^\/ox\/about\/?$/, handler: appRoute(async () => (await appApi()).aboutView()) },
  { method: 'GET', pattern: /^\/ox\/settings\/?$/, handler: handleSettingsGet },
  { method: 'POST', pattern: /^\/ox\/settings\/?$/, handler: handleSettingsPost },
  { method: 'GET', pattern: /^\/health\/?$/, handler: handleHealth },
  { method: 'GET', pattern: /^\/v1\/models\/?$/, handler: handleModels },
  { method: 'GET', pattern: /^\/v1\/models\/(.+)$/, handler: (req, res, m) => handleModel(req, res, decodeURIComponent(m[1])) },
  { method: 'POST', pattern: /^\/v1\/chat\/completions\/?$/, handler: handleChatCompletions },
  { method: 'POST', pattern: /^\/v1\/responses\/?$/, handler: handleResponses },
];

export function routeTable() {
  return ROUTES.map(r => `${r.method} ${r.pattern.source}`);
}

async function serveStaticFile(req, res, platformRoot) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return false;
  }
  let pathname = url.pathname;
  if (!pathname.startsWith('/platform/')) return false;
  const relativePath = pathname.slice('/platform'.length) || '/index.html';
  let filePath = resolve(platformRoot, relativePath.slice(1));
  if (!filePath.startsWith(resolve(platformRoot))) {
    sendError(res, 403, 'Forbidden', 'invalid_request_error', 'path_traversal', null);
    return true;
  }
  try {
    let stats = await stat(filePath);
    if (stats.isDirectory()) {
      const indexPath = join(filePath, 'index.html');
      try {
        stats = await stat(indexPath);
        filePath = indexPath;
      } catch (e) {
        sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', null);
        return true;
      }
    }
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const ims = req.headers['if-modified-since'];
    if (ims) {
      const imsDate = new Date(ims);
      if (!isNaN(imsDate.getTime()) && stats.mtime <= imsDate) {
        res.writeHead(304);
        res.end();
        return true;
      }
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Last-Modified': stats.mtime.toUTCString(),
      'Cache-Control': 'public, max-age=3600',
    });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', null);
    } else {
      sendError(res, 500, 'Internal server error', 'server_error', 'internal', null);
    }
    return true;
  }
}

// The web chat (src/web/chat.html): one static page, no data in it. It is not
// part of the OpenAI route table, and every API call it makes carries the same
// bearer key as any other client.
let chatPage = null;
// The page carries the OpenUI Lang parser (src/ui-lang.js, no imports) inline,
// so answers written in it render in the browser with the same parser the
// terminal and island use, and the page still loads nothing from anywhere.
export async function buildChatPage() {
  const html = String(await readFile(new URL('./web/chat.html', import.meta.url)));
  const lang = String(await readFile(new URL('./ui-lang.js', import.meta.url)))
    .replace(/^export (?=const|function|class|let)/gm, '')
    .replace(/<\/script/gi, '<\\/script');
  const names = ['Canvas', 'parseProgram', 'evaluate', 'LIBRARY', 'QUERY_TOOLS', 'languageSpec', 'signature'];
  const inline = `<script>window.OxUiLang = (() => {\n${lang}\nreturn { ${names.join(', ')} };\n})();</script>`;
  // A function, not a string: the parser's source has $ sequences replace() would expand.
  return Buffer.from(html.replace('<!--OX_UI_LANG-->', () => inline));
}
async function serveChatPage(res) {
  try {
    chatPage ??= await buildChatPage();
  } catch {
    sendError(res, 404, 'The web chat is not bundled with this install.', 'invalid_request_error', 'not_found', null);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': chatPage.length,
    'Cache-Control': 'no-cache',
    // The page talks only to this server and loads nothing else.
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(chatPage);
}

// Requests a browser could forge. A page on another site can make the browser
// send a request to 127.0.0.1 (it cannot read the reply, but the request still
// runs), and a domain that resolves to 127.0.0.1 can read replies too (DNS
// rebinding). So: the Host must be the address this server listens on, and a
// request that changes anything must come from this server's own page or from
// a client with no browser Origin at all (curl, SDKs, the island, ox itself).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
let boundHost = '127.0.0.1';

export function requestGuard(req, bound = boundHost) {
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const anyHost = bound === '0.0.0.0' || bound === '::';
  if (!anyHost && !(LOOPBACK_HOSTS.has(hostname) || hostname === String(bound).toLowerCase())) {
    return 'this server answers only to its own address';
  }
  const origin = req.headers.origin;
  if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let o;
    try { o = new URL(origin); } catch { return 'unreadable Origin'; }
    if (o.host.toLowerCase() !== host.toLowerCase()) return 'requests from other sites are refused';
  }
  return null;
}

// Requests that do work (a chat turn, a run, an upload): the server never steps aside under one.
let busyRequests = 0;
async function handleRequest(req, res) {
  if (req.method === 'POST') { busyRequests++; res.once('close', () => { busyRequests--; }); }
  const refused = requestGuard(req);
  if (refused) {
    sendError(res, 403, refused, 'invalid_request_error', 'forbidden_origin', null);
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendError(res, 400, 'Malformed request URL.', 'invalid_request_error', 'invalid_request_url', null);
    return;
  }
  const path = url.pathname;
  const PLATFORM_ROOT = resolve(process.cwd(), 'platform');
  if (await serveStaticFile(req, res, PLATFORM_ROOT)) return;
  if (req.method === 'GET' && (path === '/' || path === '/chat')) {
    await serveChatPage(res);
    return;
  }


  let pathExists = false;
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathExists = true;
    if (route.method !== req.method) continue;
    await route.handler(req, res, match);
    return;
  }

  if (pathExists) {
    sendError(res, 405, `${req.method} is not supported on ${path}.`, 'invalid_request_error', 'method_not_allowed', null);
    return;
  }
  sendError(res, 404, `Unknown request URL: ${req.method} ${path}. GET /v1/models lists the routes this server serves.`, 'invalid_request_error', 'unknown_url', null);
}

// Where the island finds this server: ~/.ox/serve.json { port, pid } (loopback
// only, no key in it). It reads /ox/live from here to show the app's runs.
// Returns the clean-up, or null when nothing was written (tests, a key, a wide bind).
function announceServer(port, host, keyed) {
  if (process.env.NODE_TEST_CONTEXT || keyed || !['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
  const file = join(process.env.OX_HOME || join(homedir(), '.ox'), 'serve.json');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ port, pid: process.pid, at: Date.now() }));
  } catch { return null; }
  const clean = () => { try { if (JSON.parse(readFileSync(file, 'utf8')).pid === process.pid) unlinkSync(file); } catch {} };
  process.once('exit', clean);
  return clean;
}

// `host` defaults to loopback rather than 0.0.0.0: the wide bind is opt-in, and
// it is only reachable with auth configured at all.
export function startServer(port = 8080, host = '127.0.0.1', config = {}) {
  // System 1 loads its model now (seconds), so the first turns can use it.
  warmSystem1();
  // Scheduled flows run while the app is open, as they do under the daemon
  // (each is marked as started first, so the two never run one twice).
  if (!process.env.NODE_TEST_CONTEXT && process.env.OX_FLOWS !== '0') {
    setInterval(() => { import('./flows.js').then((F) => F.tickFlows()).catch(() => {}); }, 60_000).unref();
    // The island's local voice model stays loaded (renewed before its 30 min run out).
    warmVoiceModel();
    setInterval(() => { warmVoiceModel(); }, 20 * 60_000).unref();
  }
  if (!process.env.NODE_TEST_CONTEXT && process.env.OX_MESH !== '0'
    && existsSync(join(process.env.OX_HOME || join(homedir(), '.ox'), 'mesh', 'identity.json'))) {
    meshUp().catch((e) => console.log(`[mesh] not started: ${e.code === 'EADDRINUSE' ? 'another ox already runs this machine\'s node' : e.message}`));
  }
  const exposure = authExposure({ host, key: config.apiKey ?? apiKey() });
  if (exposure.level === 'refuse') {
    return Promise.reject(new Error(exposure.lines.join('\n')));
  }

  boundHost = host;
  const server = createServer(handleRequest);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, (err) => {
      if (err) {
        reject(err);
        return;
      }
      reportExposure(exposure);
      console.log(`[serve] listening on http://${host}:${port}`);
      console.log(`[serve] web chat: http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
      const announced = announceServer(server.address()?.port ?? port, host, !!(config.apiKey ?? apiKey()));
      // The app's server steps aside when ox's code changes under it (a pull, an
      // update), once nothing is being worked on; the app page notices and the
      // app starts a fresh server (src/app.js ensureServer). A plain `ox serve` stays.
      if (process.env.OX_APP === '1' && !process.env.NODE_TEST_CONTEXT) {
        const startedAt = Date.now();
        import('./code-stamp.js').then(({ codeStamp }) => {
          setInterval(() => {
            if (busyRequests > 0 || codeStamp() <= startedAt) return;
            console.log('[serve] ox was updated: stepping aside for a fresh server');
            server.close(); announced?.();
            setTimeout(() => process.exit(0), 300);
          }, 30_000).unref();
        }).catch(() => {});
      }
      resolve({
        close: () => new Promise((resolveClose) => server.close(() => { announced?.(); resolveClose(); }))
      });
    });
  });
}
