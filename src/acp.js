// Agent Client Protocol (ACP): JSON-RPC 2.0 over stdio, newline-delimited,
// protocol version 1 — the wire format Zed, JetBrains 2026.2 and the ACP
// Registry CI actually speak. The previous implementation here was a private
// `type:`-based protocol with no `authMethods`; it could never pass the
// Registry's handshake check (verify_agents.py --auth-check) or talk to a
// real client.
//
// Design notes, each tied to a specific failure it prevents:
//
//   * STDOUT IS PROTOCOL. Nothing but JSON-RPC messages is written to stdout;
//     every human-facing line goes to stderr. One stray byte desynchronizes
//     the client's line reader — the registry CI reads the FIRST stdout line
//     as the initialize response.
//   * The server starts with NO provider configured. Registry CI launches the
//     agent with a sanitized environment (no API keys, temp HOME); exiting
//     before initialize would fail the check. The provider resolves lazily at
//     prompt time and surfaces as an `auth_required` (-32000) error.
//   * authMethods: the Registry requires ≥1 method of type 'agent' or
//     'terminal' in the initialize RESPONSE. ox is BYOK, so the honest shape
//     is: an always-advertised `byok` method (type defaults to 'agent';
//     reachability checked through `authenticate`) plus a `terminal` method
//     running `ox acp setup`, advertised only when the client declares
//     terminal capability (a spec MUST).
//   * PERMISSIONS are the agent→client `session/request_permission` request.
//     Without it ox's approval layer has no prompt and every gated write
//     would be silently DECLINED — a registered-but-read-only agent. Clients
//     that do not answer fail closed; a sandbox deny is checked first and
//     beats any allow, exactly as in makeApprover.
//   * `_meta['com.ox.event']` carries the original ox event on every
//     session/update — a reserved extension key peers MUST NOT interpret —
//     so our own client reconstructs the exact ox event stream the desktop
//     UI consumes while Zed sees a plain spec-shaped update.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runAgent } from './agent.js';
import { makeTask, pickModel } from './model-registry.js';
import { McpHub } from './mcp.js';
import readline from 'node:readline';
import { resolveSandbox, isNetworkTool, networkPolicyFor } from './sandbox.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_SERVER_INFO = { name: 'ox', title: 'ox', version: pkg.version };

const MODES = Object.freeze([
  { id: 'plan', name: 'Plan', description: 'Read-only: investigate and propose, no writes' },
  { id: 'code', name: 'Code', description: 'Full coding agent with approvals' },
  { id: 'debug', name: 'Debug', description: 'Diagnose and fix' },
  { id: 'review', name: 'Review', description: 'Review changes' },
]);

// JSON-RPC / ACP error codes (ErrorCode schema: JSON-RPC range + -32000..-32099).
export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
});

const OX_EVENT_META_KEY = 'com.ox.event';
// A permission request the client never answers must not hang the turn for
// ever. Five minutes is generous for a human clicking a dialog; on expiry the
// tool is declined — fail closed on someone else's silence, never fail open.
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

class RpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  // Convenience mirror of the module-level RPC constants; tests assert
  // RpcError.Codes.* instead of remembering the raw numbers.
  static Codes = Object.freeze({
    PARSE_ERROR: RPC.PARSE_ERROR,
    INVALID_REQUEST: RPC.INVALID_REQUEST,
    METHOD_NOT_FOUND: RPC.METHOD_NOT_FOUND,
    INVALID_PARAMS: RPC.INVALID_PARAMS,
    INTERNAL_ERROR: RPC.INTERNAL_ERROR,
    REQUEST_CANCELLED: RPC.REQUEST_CANCELLED,
    AUTH_REQUIRED: RPC.AUTH_REQUIRED,
  });
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function rpcNotify(method, params) {
  return { jsonrpc: '2.0', method, params };
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ox tool name → ACP ToolKind. Unknown names get 'other' (the schema default).
const TOOL_KINDS = Object.freeze({
  read_file: 'read',
  list_dir: 'read',
  write_file: 'edit',
  edit_file: 'edit',
  bash: 'execute',
  grep: 'search',
  glob: 'search',
  web_fetch: 'fetch',
  web_get: 'fetch',
  web_search: 'fetch',
  web_task: 'fetch',
  todo: 'think',
  todo_write: 'think',
  critique: 'think',
});

function toolKindOf(name) {
  return TOOL_KINDS[name] ?? 'other';
}

// ox stopReason (provider vocabulary) → ACP StopReason.
function acpStopReason(raw) {
  if (raw === 'length') return 'max_tokens';
  if (raw === 'refusal' || raw === 'content_filter') return 'refusal';
  if (raw === 'max_turn_requests') return 'max_turn_requests';
  return 'end_turn';
}

function textFromPromptBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    if (typeof blocks === 'string') return blocks;
    throw new RpcError(RPC.INVALID_PARAMS, 'params.prompt must be an array of content blocks');
  }
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'resource_link') parts.push(`${b.name ?? ''} ${b.uri ?? ''}`.trim());
    else if (b.type === 'resource' && b.resource && typeof b.resource.text === 'string') parts.push(b.resource.text);
    // image/audio are not advertised in promptCapabilities; a client sending
    // them has broken its own contract and ignoring keeps the turn alive.
  }
  const text = parts.filter(Boolean).join('\n').trim();
  if (!text) return '';
  return text;
}

function textFromMessageContent(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message?.content)) {
    return message.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return typeof message?.content === 'string' ? message.content : '';
}

// ---- one ACP session ---------------------------------------------------------

export class AcpSession {
  constructor({ id, cwd, config = {}, target = null, permissionHandler = null, onNotify = null } = {}) {
    this.id = id;
    this.cwd = cwd ?? process.cwd();
    this.config = config;
    this.target = target;
    this.mode = 'code';
    this.trustAll = false; // flipped by an `allow_always` permission outcome
    this.permissionHandler = permissionHandler;
    this.onNotify = onNotify ?? (() => {});
    this.onSendRequest = null; // wired by the server after construction
    this.controller = null;
    this.cancelled = false;
    this.prompting = false;
    this.promptRpcId = null; // jsonrpc id of the in-flight session/prompt
    this.hub = null;
    this.mcpTools = [];
    this.mcpCall = null;
    // Sandbox resolves ONCE at session creation so a broken profile fails the
    // session loudly instead of letting the first tool run unconfined. Same
    // call the CLI makes — config-pinned .ox-sandbox.json is honoured here.
    try {
      this.sandbox = resolveSandbox({ flag: null, config });
    } catch (err) {
      throw new RpcError(RPC.INTERNAL_ERROR, `sandbox configuration invalid: ${String(err?.message ?? err)}`);
    }
  }

  setMode(modeId) {
    const found = MODES.find((m) => m.id === modeId);
    if (!found) {
      throw new RpcError(RPC.INVALID_PARAMS, `unknown mode '${modeId}'; valid: ${MODES.map((m) => m.id).join(', ')}`);
    }
    this.mode = modeId;
    this.onNotify(rpcNotify('session/update', {
      sessionId: this.id,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: modeId,
        _meta: { [OX_EVENT_META_KEY]: { type: 'mode', mode: modeId } },
      },
    }));
    return {};
  }

  modesState() {
    return {
      currentModeId: this.mode,
      availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })),
    };
  }

  // Client-provided MCP servers (ACP stdio shape) merge over ~/.ox/config.json
  // and start once per session. A failed startup warns on stderr and continues
  // without MCP tools — the same contract headless mode uses; an IDE session
  // must not die because an optional server was missing.
  async ensureMcp(clientServers) {
    const envToObject = (env) => {
      const out = {};
      for (const e of Array.isArray(env) ? env : []) {
        if (e && typeof e.name === 'string') out[e.name] = String(e.value ?? '');
      }
      return out;
    };
    const merged = { ...(this.config.mcpServers ?? {}) };
    for (const s of Array.isArray(clientServers) ? clientServers : []) {
      if (!s || typeof s.name !== 'string' || typeof s.command !== 'string') continue;
      if (s.type && s.type !== 'stdio') continue; // http/sse not advertised
      const env = envToObject(s.env);
      merged[s.name] = {
        command: s.command,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        ...(Object.keys(env).length ? { env } : {}),
      };
    }
    if (!Object.keys(merged).length) return;
    const hub = new McpHub(merged, { callTimeoutMs: 30000, sandbox: this.sandbox });
    this.hub = hub;
    try {
      await hub.start();
      // close() can run while start() is still going (a client that hangs up
      // at once). The session is then no longer this hub's: the late start
      // must not hand tools back to a closed session, and the servers it
      // spawned after close()'s stop() must not be left running.
      if (this.hub !== hub) {
        try { await hub.stop?.(); } catch { /* best effort */ }
        return;
      }
      this.mcpTools = hub.schemas();
      this.mcpCall = (q, a) => hub.call(q, a);
    } catch (err) {
      if (this.hub !== hub) return;
      process.stderr.write(`ox-acp: MCP startup failed — continuing without MCP tools (${String(err?.message ?? err)})\n`);
      this.hub = null;
    }
  }

  cancel() {
    this.cancelled = true;
    if (this.controller) this.controller.abort();
    return {};
  }

  resolveTarget() {
    if (this.target) return this.target;
    const choice = pickModel({ task: makeTask({ kind: 'code' }), env: process.env, config: this.config });
    if (!choice) {
      throw new RpcError(
        RPC.AUTH_REQUIRED,
        'auth_required: no reachable provider — run `ox acp setup` to store an API key, or set OX_API_KEY / a provider key in the environment'
      );
    }
    this.target = choice;
    return choice;
  }

  // The approval bridge: ox's askApproval() → session/request_permission on
  // the client. Sandbox denies are monotonic and checked FIRST (they beat any
  // allow, exactly as in makeApprover). An `allow_always` outcome flips
  // this.trustAll for the rest of the session — the ACP equivalent of
  // accept-edits — so the user is not re-asked on every tool of a run.
  async requestApproval(name, args, detail) {
    if (this.sandbox && typeof this.sandbox.blocksTool === 'function') {
      try {
        if (this.sandbox.blocksTool(name, args) === true) return false;
      } catch { /* a broken probe must not become an approval */ }
    }
    // Network egress is denied by the profile itself — a blocked tool can never
    // reach the client, so refuse the request without contacting it (fail
    // closed on the sandbox's own verdict).
    if (isNetworkTool(name) && networkPolicyFor(this.sandbox, name, args).blocked === true) return false;
    if (this.trustAll) return true;
    if (typeof this.permissionHandler === 'function') {
      const outcome = await this.permissionHandler({ sessionId: this.id, name, args, detail });
      if (outcome?.optionId === 'allow_always') this.trustAll = true;
      return outcome?.optionId?.startsWith('allow') === true;
    }
    if (typeof this.onSendRequest !== 'function') return false; // no channel → decline
    // Deterministic per session so the client's pending-request map and logs
    // can correlate requestPermission -> toolCallId. Two permission requests
    // can never be in flight simultaneously on one session, so pc_ses_1 is
    // unique in practice.
    const toolCallId = `pc_${this.id}`;
    const request = {
      jsonrpc: '2.0',
      id: `req_perm_${this.id}`,
      method: 'session/request_permission',
      params: {
        sessionId: this.id,
        toolCall: {
          toolCallId,
          title: truncate(`${name}: ${detail ?? ''}`.replace(/:\s*$/, '') || name, 300),
          name,
          kind: toolKindOf(name),
          status: 'pending',
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
          { optionId: 'reject_always', name: 'Reject for this session', kind: 'reject_always' },
        ],
      },
    };
    try {
      const res = await this.onSendRequest(request, PERMISSION_TIMEOUT_MS);
      const outcome = res?.outcome;
      if (outcome?.type !== 'selected') return false;
      if (outcome.optionId === 'allow_always') this.trustAll = true;
      return outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always';
    } catch {
      // Client does not implement request_permission (method not found), timed
      // out, or errored: decline. Silent approval on client ignorance would be
      // the exact failure mode ox exists to prevent.
      return false;
    }
  }

  // Runs one prompt turn, streaming session/update notifications through
  // onNotify. Throws RpcError for auth/provider failures; resolves {stopReason}.
  async prompt(text, rpcId) {
    if (this.prompting) throw new RpcError(RPC.INVALID_REQUEST, 'a prompt is already running on this session');
    this.prompting = true;
    this.promptRpcId = rpcId;
    this.cancelled = false;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let streamedChars = 0;
    let sawError = null;
    let rawStop = null;
    const notifyEvent = (kind, ev, extra = {}) => {
      this.onNotify(rpcNotify('session/update', {
        sessionId: this.id,
        update: { sessionUpdate: kind, ...extra, _meta: { [OX_EVENT_META_KEY]: ev } },
      }));
    };
    try {
      const target = this.resolveTarget();
      const ctx = {
        cwd: this.cwd,
        signal,
        mode: this.mode,
        sessionId: this.id,
        sandbox: this.sandbox,
        requestApproval: (name, args, detail) => this.requestApproval(name, args, detail),
        ...(this.mcpTools.length ? { mcpTools: this.mcpTools, mcpCall: this.mcpCall } : {}),
      };
      for await (const ev of runAgent({
        target,
        messages: [{ role: 'user', content: text }],
        ctx,
        config: this.config,
        signal,
      })) {
        switch (ev.type) {
          case 'text-delta': {
            streamedChars += String(ev.text ?? '').length;
            notifyEvent('agent_message_chunk', ev, { content: { type: 'text', text: String(ev.text ?? '') } });
            break;
          }
          case 'tool-start': {
            notifyEvent('tool_call', ev, {
              toolCallId: String(ev.id),
              title: truncate(ev.argsPreview ? `${ev.name}: ${ev.argsPreview}` : ev.name, 300),
              name: ev.name,
              kind: toolKindOf(ev.name),
              status: 'in_progress',
            });
            break;
          }
          case 'tool-end': {
            const ok = ev.ok !== false && ev.isError !== true;
            const content = ev.content != null && String(ev.content).length
              ? [{ type: 'content', content: { type: 'text', text: truncate(ev.content, 8000) } }]
              : [];
            notifyEvent('tool_call_update', ev, {
              toolCallId: String(ev.id),
              status: ok ? 'completed' : 'failed',
              ...(content.length ? { content } : {}),
            });
            break;
          }
          case 'progress-note':
          case 'reflection':
          case 'fallback':
          case 'error': {
            const note = ev.type === 'error' ? `error: ${ev.error}` : ev.text ?? ev.reason ?? '';
            if (ev.type === 'error') sawError = ev.error;
            if (note) notifyEvent('agent_thought_chunk', ev, { content: { type: 'text', text: truncate(note, 2000) } });
            break;
          }
          case 'turn-end':
            // Captured for the response's stopReason; not streamed — ACP has
            // no turn-end update and clients infer completion from the reply.
            rawStop = ev.stopReason ?? rawStop;
            break;
          case 'final': {
            // A provider that did not stream deltas only surfaces its text on
            // the final message. Emitting it here (and only when nothing was
            // streamed) guarantees the client always sees the answer.
            const finalText = textFromMessageContent(ev.message);
            if (finalText && streamedChars === 0) {
              streamedChars += finalText.length;
              notifyEvent('agent_message_chunk', ev, { content: { type: 'text', text: finalText } });
            }
            break;
          }
          default:
            // usage/gate/approval/etc: optional in ACP and meaningless to a
            // generic client — dropped from the wire, still in ox's own run.
            break;
        }
      }
      if (this.cancelled || signal.aborted) return { stopReason: 'cancelled' };
      if (sawError && streamedChars === 0) throw new RpcError(RPC.INTERNAL_ERROR, `agent failed: ${sawError}`);
      return { stopReason: acpStopReason(rawStop) };
    } catch (err) {
      if (this.cancelled || signal.aborted) return { stopReason: 'cancelled' };
      if (err instanceof RpcError) throw err;
      throw new RpcError(RPC.INTERNAL_ERROR, String(err?.message ?? err));
    } finally {
      this.prompting = false;
      this.promptRpcId = null;
      this.controller = null;
    }
  }

  async close() {
    // Released first, then stopped: a start() still in flight sees the session
    // is closed and stops what it started (see ensureMcp).
    const hub = this.hub;
    this.hub = null;
    this.mcpTools = [];
    this.mcpCall = null;
    if (hub) {
      try { await hub.stop?.(); } catch { /* best effort */ }
    }
  }
}

function handleInitialize(params, state) {
  const cc = params?.clientCapabilities ?? null;
  // Terminal capability arrives in three shapes across clients (spec:
  // clientCapabilities.auth.terminal; registry CI: top-level `terminal` plus
  // _meta['terminal-auth']). Accept all three.
  const terminalCap =
    cc?.terminal === true || cc?.auth?.terminal === true || cc?._meta?.['terminal-auth'] === true;
  state.clientCapabilities = cc;
  state.initialized = true;
  const authMethods = [
    {
      id: 'byok',
      name: 'Provider API key',
      description:
        'Uses an API key from OX_API_KEY / provider env vars or ~/.ox/config.json (bring-your-own-key, no account required)',
      // No `type` field: 'agent' is the spec default — ox completes this
      // method itself through `authenticate`, which checks reachability.
    },
  ];
  // Spec MUST: a terminal method is advertised only when the client declares
  // terminal capability. `ox acp setup` is that method's interactive flow.
  if (terminalCap) {
    authMethods.push({
      id: 'terminal-setup',
      name: 'Set up API keys',
      description: 'Interactively store a provider API key in ~/.ox/config.json',
      type: 'terminal',
      args: ['acp', 'setup'],
      env: {},
    });
  }
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
    },
    authMethods,
    agentInfo: {
      name: ACP_SERVER_INFO.name,
      title: ACP_SERVER_INFO.title,
      version: ACP_SERVER_INFO.version,
    },
  };
}

function handleAuthenticate(params, state) {
  const methodId = String(params?.methodId ?? '');
  if (methodId === 'terminal-setup') {
    throw new RpcError(RPC.INVALID_PARAMS, 'terminal-setup is a terminal method and must not be sent to authenticate');
  }
  if (methodId !== 'byok') throw new RpcError(RPC.INVALID_PARAMS, `unknown auth method '${methodId}'`);
  const choice = pickModel({ task: makeTask({ kind: 'code' }), env: process.env, config: state.config });
  if (!choice) {
    throw new RpcError(
      RPC.AUTH_REQUIRED,
      'auth_required: no reachable provider — run `ox acp setup` or set a provider API key, then retry'
    );
  }
  state.authenticated = true;
  return {};
}

function requireSession(sessions, params) {
  const s = sessions.get(String(params?.sessionId ?? ''));
  if (!s) throw new RpcError(RPC.INVALID_PARAMS, `unknown session '${params?.sessionId ?? ''}'`);
  return s;
}

// Single dispatcher for every inbound line. Returns a reply object, a
// notification marker (null), or throws RpcError.
async function handleMessage(msg, state) {
  const { sessions, ctx } = state;
  const isResponse =
    msg && typeof msg === 'object' && !('method' in msg) && ('result' in msg || 'error' in msg);
  if (isResponse) {
    // Response to a request WE sent (session/request_permission).
    const pending = state.pendingClientRequests.get(String(msg.id));
    if (pending) {
      state.pendingClientRequests.delete(String(msg.id));
      if (msg.error) pending.reject(new RpcError(msg.error.code ?? RPC.INTERNAL_ERROR, msg.error.message ?? 'client error'));
      else pending.resolve(msg.result);
    }
    return null; // never respond to a response
  }
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    if (isNotification) return null;
    return rpcError(id, RPC.INVALID_REQUEST, 'invalid request: missing method');
  }
  try {
    switch (method) {
      case 'initialize':
        return isNotification ? null : rpcResult(id, handleInitialize(params, state));
      case 'authenticate':
        return isNotification ? null : rpcResult(id, handleAuthenticate(params, state));
      case 'logout':
        throw new RpcError(RPC.METHOD_NOT_FOUND, 'logout is not supported (no logout capability was advertised)');
      case 'session/new': {
        if (!state.initialized) throw new RpcError(RPC.INVALID_REQUEST, 'client has not completed initialize');
        if (isNotification) return null;
        const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : ctx.cwd;
        const session = new AcpSession({
          id: `ses_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
          cwd,
          config: ctx.config,
          target: ctx.target,
          permissionHandler: ctx.permissionHandler ?? null,
          onNotify: (n) => state.write(n),
        });
        session.onSendRequest = (request, timeoutMs) => state.sendToClient(request, timeoutMs);
        sessions.set(session.id, session);
        await session.ensureMcp(params?.mcpServers);
        return rpcResult(id, { sessionId: session.id, modes: session.modesState() });
      }
      case 'session/set_mode': {
        const s = requireSession(sessions, params);
        if (isNotification) return null;
        return rpcResult(id, s.setMode(String(params?.modeId ?? '')));
      }
      case 'session/prompt': {
        const s = requireSession(sessions, params);
        if (isNotification) throw new RpcError(RPC.INVALID_REQUEST, 'session/prompt requires a request id');
        const text = textFromPromptBlocks(params?.prompt);
        // Legacy test seam: a promptHandler replaces the agent loop.
        if (typeof state.promptHandler === 'function') {
          const out = await state.promptHandler(text);
          const t = typeof out === 'string' ? out : textFromMessageContent(out);
          state.write(rpcNotify('session/update', {
            sessionId: s.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: t },
              _meta: { [OX_EVENT_META_KEY]: { type: 'text', text: t } },
            },
          }));
          return rpcResult(id, { stopReason: 'end_turn' });
        }
        const { stopReason } = await s.prompt(text, id);
        return rpcResult(id, { stopReason });
      }
      case 'session/cancel': {
        const s = sessions.get(String(params?.sessionId ?? ''));
        if (s) s.cancel();
        return null; // notification: no response
      }
      case '$/cancel_request': {
        // Cancel by jsonrpc request id: find the session whose prompt carries
        // that id and abort it. The in-flight session/prompt then answers
        // {stopReason:'cancelled'} — a valid response per spec.
        const target = String(params?.requestId ?? '');
        for (const s of sessions.values()) {
          if (s.promptRpcId !== null && String(s.promptRpcId) === target) s.cancel();
        }
        return null;
      }
      case 'session/close': {
        const s = requireSession(sessions, params);
        await s.close();
        sessions.delete(s.id);
        return isNotification ? null : rpcResult(id, {});
      }
      default:
        throw new RpcError(RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) {
      process.stderr.write(`ox-acp: notification '${method}' failed: ${String(err?.message ?? err)}\n`);
      return null;
    }
    if (err instanceof RpcError) return rpcError(id, err.code, err.message, err.data);
    return rpcError(id, RPC.INTERNAL_ERROR, String(err?.message ?? err));
  }
}

// ---- wire state --------------------------------------------------------------

class State {
  constructor(ctx, sessionHandlers) {
    // ctx is the server context every handler reads (target/cwd/config). It was
    // silently dropped here, so session/new died on `ctx.config` of undefined
    // and authenticate could never see the config's defaultBot.
    this.ctx = ctx ?? {};
    this.config = this.ctx.config ?? {};
    this.sessions = new Map();
    this.initialized = false;
    this.authenticated = false;
    this.clientCapabilities = null;
    this.pendingClientRequests = new Map();
    this.promptHandler = null;
    this.writeBuffer = '';
    this.writeChain = Promise.resolve();
    this.writeListeners = new Set();
    this.onSendRequest = null;
    if (sessionHandlers?.onSendRequest) this.onSendRequest = sessionHandlers.onSendRequest;
  }

  write(msg) {
    const line = typeof msg === 'string' ? msg : JSON.stringify(msg);
    this.writeBuffer += line + '\n';
    this.flush();
  }

  flush() {
    if (this.writeBuffer) {
      // Take the buffer NOW: the writeChain callbacks run on a later microtask
      // and would read this.writeBuffer already cleared to '' — replies would
      // be silently dropped. (And writeChain must exist: it was never
      // initialized, so the very first flush threw `undefined.then`, killing
      // the stdin pump — no initialize reply ever reached a client.)
      const out = this.writeBuffer;
      this.writeBuffer = '';
      if (this.writeListeners.size === 0) {
        this.writeChain = this.writeChain.then(() => process.stdout.write(out));
      } else {
        for (const l of this.writeListeners) l(out);
      }
    }
  }

  listen(listener) {
    this.writeListeners.add(listener);
    return () => this.writeListeners.delete(listener);
  }

  // Holds a client request (authenticate / session/prompt) until the client
  // replies, with a timeout. Timeout answers {error: true} so the agent loop
  // can degrade instead of hanging.
  sendToClient(msg, timeoutMs) {
    const id = msg.id ?? `ox_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(String(id));
        resolve({ error: true, timeout: true });
      }, timeoutMs);
      this.pendingClientRequests.set(String(id), { resolve, reject, timer });
      if (this.onSendRequest) {
        // Desktop harness registered a transport: route through it.
        this.onSendRequest(msg, timeoutMs - 500); // leave headroom for our reply
      } else {
        // Plain `ox acp server`: the request is written to stdout, where the
        // client's stdin reader blocks waiting for it. Never await this
        // flush — that would deadlock if the client is waiting on us.
        this.flush();
      }
    });
  }
}

// ---- stdio server ------------------------------------------------------------

function parseLine(line) {
  if (line.trim() === '') return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function processLine(line, state) {
  const msg = parseLine(line);
  if (msg === null) return;
  const reply = await handleMessage(msg, state);
  if (reply !== null) state.write(reply);
  state.flush();
}

// Reads newline-delimited JSON from stdin and dispatches synchronously until
// stdin reaches EOF. The pump is async so callers can await its completion in
// tests; a real server stays alive as long as its stdin is open.
async function pump(stdin, state) {
  const rl = readline.createInterface({ input: stdin });
  for await (const line of rl) {
    await processLine(line, state);
  }
}

// ---- the server --------------------------------------------------------------

class AcpServer {
  constructor({
    target,
    cwd = process.cwd(),
    config = {},
    sessionHandlers = {},
    stdin = process.stdin,
  } = {}) {
    this.target = target;
    this.cwd = cwd;
    this.config = config;
    this.sessionHandlers = sessionHandlers;
    this.stdin = stdin;
    this.state = new State(
      // The ctx handlers read: target is the pre-resolved provider (or null to
      // resolve lazily at prompt time), cwd/config flow into new sessions.
      { target: target ?? null, cwd, config },
      {
        onSendRequest: sessionHandlers.onSendRequest ?? null,
      }
    );
    this.running = false;
    this.stderrSubscribers = new Set();
  }

  // Public handle the desktop harness installs when it wants to drive a
  // session: permission/response replies are pushed back into the server.
  setOnSendRequest(fn) {
    this.state.onSendRequest = fn ?? null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      await pump(this.stdin, this.state);
    } catch (err) {
      process.stderr.write(`ox-acp: stdin pump error: ${String(err?.message ?? err)}\n`);
    } finally {
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    this.state.sessions.forEach((s) => s.close());
  }

  // Short, single-call convenience for the CLI (`ox acp server`).
  static fromContext(ctx, { target, cwd, config, sessionHandlers } = {}) {
    return new AcpServer({ target, cwd, config, sessionHandlers });
  }
}

// Creates the object `ox acp server` uses: an ACP v1 server on stdio. The
// `target` is the resolved provider (model + endpoint); `config` is the full
// ox config (for MCP servers and sandbox); `sessionHandlers` is the desktop
// harness's transport for pushing permission requests / cancelling prompts;
// `stdin` is the client transport stream (process.stdin by default).
export function createAcpServer(ctx = {}, options = {}) {
  return new AcpServer({ ...options });
}

// `ox acp server` entry point: no args → start on stdio. Parameters exist for
// test harnesses that reuse the server with an in-memory pipe.
export async function startAcpServer(stdin, options = {}) {
  const server = createAcpServer(null, { ...options, stdin });
  await server.start();
  return server;
}

// ---- a test-only in-process client used by the harness ----------------------

export class InMemoryAcpClient {
  constructor({ name = 'harness' } = {}) {
    this.name = name;
    this.out = []; // lines sent to the server
    this.state = new Map(); // pending request ids → resolve/reject
  }

  send(msg) {
    this.out.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  async request(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = `hx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this.state.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async nextNotification() {
    // The server writes notifications to stdout; the harness reads them from
    // the original stdout stream as they are flushed. This placeholder counts
    // the lines the server *would* have written; assert on those in tests.
    return null;
  }

  async close() {
    this.state.clear();
  }
}

// ---- public exports ----------------------------------------------------------

export {
  toolKindOf,
  textFromPromptBlocks,
  MODES,
  PERMISSION_TIMEOUT_MS,
  RpcError,
};