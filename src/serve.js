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
import { join, resolve, extname } from 'path';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { resolveTurnMode } from './modes.js';
import { listAgents, loadAgent, agentBotSpec, agentPersonaBlock } from './agents.js';

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

export function serveModelCatalog(env = process.env) {
  const data = [];
  const withheld = [];
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
    ? { type: 'tool-start', id: event.id ?? null, name: String(event.name ?? 'tool'), preview: String(event.argsPreview ?? '').slice(0, 120) }
    : { type: 'tool-end', id: event.id ?? null, name: String(event.name ?? 'tool'), isError: event.isError === true };
}

function textDelta(event) {
  if (event.type === 'text-delta' && typeof event.text === 'string' && event.text) return event.text;
  return '';
}

// Only used when no delta arrived, so a provider that reports its text once at
// the end is not lost and a stream that did stream is not double-counted.
function finalText(event, alreadyHave) {
  if (alreadyHave) return '';
  if (event.type === 'final' && typeof event.message === 'string') return event.message;
  return '';
}

function agentErrorShape(message) {
  // A missing provider key is an authentication failure, not a bug; a 500 would
  // send the caller looking in the wrong place.
  if (/Missing API key/i.test(message)) {
    return { status: 401, type: 'authentication_error', code: 'invalid_api_key', param: null };
  }
  return { status: 500, type: 'server_error', code: null, param: null };
}

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

  const { model, messages, stream, max_tokens, temperature } = body;

  if (!messages || !Array.isArray(messages)) {
    sendError(res, 400, "'messages' is required and must be an array.", 'invalid_request_error', 'missing_required_parameter', 'messages');
    return;
  }

  const targetModel = model || 'gpt-4o';
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
    sendError(res, 404, `No agent '${String(targetModel).slice(6)}'. Make one with: ox agent new <name>`, 'invalid_request_error', 'model_not_found', 'model');
    return;
  }
  let target;
  try {
    target = resolveBot(agentDef ? (agentBotSpec(agentDef) ?? defaultBotSpec({}, process.env) ?? 'ox-grok') : String(targetModel));
    target.temperature = temperature0;
  } catch {
    target = { model: targetModel, temperature: temperature0 };
  }
  // `ox_mode` is an ox extension (other OpenAI clients never send it): the
  // mode is enforced at the tool gate, and auto's pick is reported back. An
  // agent's own mode applies unless a specific mode was picked.
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const pickedMode = body.ox_mode && body.ox_mode !== 'auto' ? body.ox_mode : (agentDef?.mode ?? body.ox_mode ?? 'code');
  const turnMode = resolveTurnMode(pickedMode, typeof lastUser?.content === 'string' ? lastUser.content : '');
  const ctx = {
    cwd: process.cwd(),
    mode: turnMode.mode,
    ...(agentDef ? { personaBlock: agentPersonaBlock(agentDef), agentName: agentDef.name } : {}),
    ...(Array.isArray(agentDef?.tools) ? { allowedTools: agentDef.tools } : {}),
  };
  const config = { maxTokens: max_tokens };

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let fullContent = '';
    const totalUsage = usageTally();
    if (body.ox_mode) sendSSE(res, { ...createChatCompletionChunk(targetModel, ''), ox: { type: 'mode', mode: turnMode.mode, routed: turnMode.routed, reason: turnMode.reason } });

    try {
      for await (const event of runAgent({ target, messages, ctx, config, maxIterations: 40 })) {
        const delta = textDelta(event);
        const last = delta || finalText(event, fullContent);
        if (last) {
          fullContent += last;
          sendSSE(res, createChatCompletionChunk(targetModel, last));
        } else if (event.type === 'usage') {
          tallyUsage(totalUsage, event);
        } else if (event.type === 'tool-start' || event.type === 'tool-end') {
          // What the agent is doing, as an `ox` extension on an empty chunk:
          // OpenAI clients ignore the unknown field, the web chat draws it.
          sendSSE(res, { ...createChatCompletionChunk(targetModel, ''), ox: oxToolEvent(event) });
        }
      }
      sendSSE(res, createChatCompletionChunk(targetModel, '', true, totalUsage));
      sendSSEDone(res);
      res.end();
    } catch (error) {
      sendSSE(res, { error: { message: error.message, type: 'server_error' } });
      sendSSEDone(res);
      res.end();
    }
  } else {
    let fullContent = '';
    const totalUsage = usageTally();

    try {
      for await (const event of runAgent({ target, messages, ctx, config, maxIterations: 40 })) {
        const last = textDelta(event) || finalText(event, fullContent);
        if (last) {
          fullContent += last;
        } else if (event.type === 'usage') {
          tallyUsage(totalUsage, event);
        }
      }
      sendJson(res, 200, createChatCompletionResponse(targetModel, fullContent, totalUsage));
    } catch (error) {
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
    target = resolveBot(model.trim());
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
  return {
    island: { enabled: islandEnabled(), running: islandRunning({ env: {} }), platform: process.platform },
    model: { defaultBot: config.defaultBot, source: config.defaultBotSource ?? 'config', bots },
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
  if (typeof body.defaultBot === 'string') {
    try {
      resolveBot(body.defaultBot);
    } catch (e) {
      sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'invalid_bot', 'defaultBot');
      return;
    }
    saveConfigDoc((doc) => { doc.defaultBot = body.defaultBot; });
  }
  if (typeof body.awake === 'boolean') saveConfigDoc((doc) => { doc.awake = body.awake; });
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
      const out = await fn(body ?? {}, m);
      if (out == null) sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found', null);
      else sendJson(res, 200, out);
    } catch (e) {
      sendError(res, 400, String(e?.message ?? e), 'invalid_request_error', 'bad_request', null);
    }
  };
}
const appApi = () => import('./app-api.js');

const ROUTES = [
  { method: 'GET', pattern: /^\/ox\/providers\/?$/, handler: appRoute(async () => (await appApi()).providersView()) },
  { method: 'POST', pattern: /^\/ox\/providers\/?$/, handler: appRoute(async (b) => (await appApi()).saveProviderKey(String(b.provider ?? ''), b.key ?? null)) },
  { method: 'GET', pattern: /^\/ox\/accounts\/?$/, handler: appRoute(async () => (await appApi()).accountsView()) },
  { method: 'GET', pattern: /^\/ox\/local\/?$/, handler: appRoute(async () => (await appApi()).localView()) },
  { method: 'GET', pattern: /^\/ox\/capabilities\/?$/, handler: appRoute(async () => (await appApi()).capabilitiesView()) },
  { method: 'GET', pattern: /^\/ox\/skills\/([^/]+)$/, handler: appRoute(async (_, m) => (await appApi()).skillBody(decodeURIComponent(m[1]))) },
  { method: 'GET', pattern: /^\/ox\/messaging\/?$/, handler: appRoute(async () => (await appApi()).messagingView()) },
  { method: 'GET', pattern: /^\/ox\/scheduled\/?$/, handler: appRoute(async () => (await appApi()).scheduledView()) },
  { method: 'POST', pattern: /^\/ox\/scheduled\/?$/, handler: appRoute(async (b) => (await appApi()).setScheduleEnabled(String(b.id ?? ''), b.enabled)) },
  { method: 'GET', pattern: /^\/ox\/sessions\/?$/, handler: appRoute(async () => (await appApi()).sessionsView()) },
  { method: 'GET', pattern: /^\/ox\/sessions\/([^/]+)$/, handler: appRoute(async (_, m) => (await appApi()).sessionView(decodeURIComponent(m[1]))) },
  { method: 'GET', pattern: /^\/ox\/memory\/?$/, handler: appRoute(async () => (await appApi()).memoryView()) },
  { method: 'POST', pattern: /^\/ox\/memory\/?$/, handler: appRoute(async (b) => (await appApi()).memoryAction(b)) },
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
async function serveChatPage(res) {
  try {
    chatPage ??= await readFile(new URL('./web/chat.html', import.meta.url));
  } catch {
    sendError(res, 404, 'The web chat is not bundled with this install.', 'invalid_request_error', 'not_found', null);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': chatPage.length,
    'Cache-Control': 'no-cache',
    // The page talks only to this server and loads nothing else.
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

async function handleRequest(req, res) {
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

// `host` defaults to loopback rather than 0.0.0.0: the wide bind is opt-in, and
// it is only reachable with auth configured at all.
export function startServer(port = 8080, host = '127.0.0.1', config = {}) {
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
      resolve({
        close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
      });
    });
  });
}
