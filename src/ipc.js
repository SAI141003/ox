// IPC: a self-contained Unix-socket session monitor and out-of-band approval
// bridge. Zero dependencies (node:net / node:os / node:path / node:fs /
// node:events). Modeled on "coucou"'s Claude Code hook bridge,
// adapted to ox.
//
// Wire protocol: newline-delimited JSON over AF_UNIX / SOCK_STREAM. Exactly one
// JSON object per line, always '\n' terminated. Both peers are tolerant
// readers: a line that fails to parse is dropped, never fatal.
//
//   server -> client
//     { type:'hello', sessionId, pid, cwd, bot, model, version }
//     { type:'event', event, at }
//     { type:'approval-request', id, tool, argsPreview, args, cwd, at, deadlineAt }
//     { type:'pong' }
//
//   client -> server
//     { type:'ready', clientId }
//     { type:'approval-answer', id, decision }   // 'allow'|'deny'|'ask'|'always' (allow + rest of session)
//     { type:'user-message', text, imagePaths?, voice? } // ask the run something (island voice / screen)
//     { type:'ping' }
//
// The four design rules this module exists to enforce:
//
//   1. THE CONNECTION IS THE WAIT. No polling, no PID file, no heartbeat. A
//      pending approval holds the accepted socket open; the client's blocking
//      read is the barrier. If the server dies the client sees EOF and the
//      approval died with it.
//   2. SILENCE IS THE SAFE ANSWER. Every failure path — server absent, connect
//      timeout, client crash, protocol garbage, approval timeout, superseded
//      approval — converges on the single verdict 'ask', meaning "I decline to
//      decide", which falls back to the normal terminal prompt. No failure
//      path may ever resolve to 'allow'.
//   3. STAGGERED TIMEOUTS. The client's connect attempt is bounded at 300ms so
//      fire-and-forget traffic can never stall the agent; the approval hold is
//      bounded at 115s so ox gives up before any outer layer (GUI dialog, an
//      upstream tool timeout) that should be configured longer than it.
//   4. TRUNCATE EVERYTHING. A Windows port of this design forwarded whole file
//      reads and wedged the GUI. sanitizeForWire caps string length (2000
//      chars) and deep-redacts secrets before anything reaches a socket.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

export const IPC_VERSION = 1;

export const APPROVAL_DECISIONS = Object.freeze(['allow', 'deny', 'ask', 'always']);

// The one verdict every failure path converges on. See rule 2 above.
export const DECLINE = 'ask';

export const DEFAULT_SOCKET_DIR = os.tmpdir();

// Rule 3: non-approval traffic is fire-and-forget. If nobody is listening we
// give up after this long and move on. Small enough to never stall a turn.
export const DEFAULT_CONNECT_TIMEOUT_MS = 300;

// Rule 3 (stagger), part two. 115s deliberately sits *under* the ~120s that
// GUI front-ends and upstream tool-call timeouts typically use, so the layer
// that actually owns the decision gives up first and hands control back to the
// terminal prompt instead of being killed mid-hold with the approval still
// outstanding. Configure any outer timeout longer than this.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 115000;

export const DEFAULT_MAX_STRING = 2000;

// Rule 4: no single wire frame may exceed this.
export const MAX_FRAME_BYTES = 1024 * 1024;

// Rule 3: how long to wait for a pre-existing socket to answer a liveness
// probe before treating it as the corpse of a crashed server.
export const STALE_PROBE_MS = 150;

// Rule 6 (backpressure): per-client queue caps, in messages and in bytes.
export const MAX_QUEUE_MSGS = 500;
export const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

const SAFE_METRIC_KEYS = new Set([
  'input_tokens', 'output_tokens', 'aux_input_tokens', 'aux_output_tokens',
  'tokens_in', 'tokens_out', 'token_count', 'total_tokens',
  'max_cost_usd', 'cost_usd', 'known_cost_usd', 'unknown_models',
  'model', 'provider', 'base_url', 'session_id', 'aux_bot', 'aux_model',
  'served_by', 'pid', 'cwd', 'version', 'client_id', 'at', 'sandbox',
  'iters', 'count', 'ms', 'bytes', 'ok', 'is_error', 'id', 'name',
  'decision', 'tool', 'reason', 'detail', 'status', 'phase', 'offered', 'total',
]);

// The inner multiword alternatives use [-_]?, NOT _?: the outer boundary
// class accepts - too, so an inner underscore-only separator let hyphenated
// spellings (api-key, access-token) normalise to a shape this pattern could
// not match - a real redaction leak. Single-word alternatives need no
// separator and are left alone.
const SECRET_KEY_RE =
  /(?:^|[_\-.])(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|bearer|token|secret|password|passwd|cookie)(?:$|[_\-.])/;

export function normaliseKey(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function isSecretKey(key) {
  const raw = String(key);
  const norm = normaliseKey(raw);
  if (SAFE_METRIC_KEYS.has(raw.toLowerCase()) || SAFE_METRIC_KEYS.has(norm)) return false;
  return SECRET_KEY_RE.test(norm);
}
const REDACTED = '[redacted]';
const TRUNCATED_SUFFIX = '...[truncated]';

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

// Deterministic per-session path so any process can recompute the socket
// without a discovery file. sessionId is sanitized so it can never escape the
// socket dir or smuggle in a path separator.
export function socketPathFor(sessionId, dir = DEFAULT_SOCKET_DIR, platform = process.platform) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96) || 'default';
  // Windows has no unix socket files for Node: local IPC is a named pipe, and
  // a pipe must live in the \\.\pipe\ namespace or listen() fails outright.
  if (platform === 'win32' && dir === DEFAULT_SOCKET_DIR) return `\\\\.\\pipe\\ox-ipc-${safe}`;
  return path.join(dir, `ox-ipc-${safe}.sock`);
}

// Every live run's socket, found the same way on each OS: socket files in the
// temp dir, or named pipes on Windows. Used by islands that watch all runs.
export function listIpcSockets(dir = DEFAULT_SOCKET_DIR, platform = process.platform) {
  if (platform === 'win32' && dir === DEFAULT_SOCKET_DIR) {
    try {
      return fs.readdirSync('\\\\.\\pipe\\').filter((n) => n.startsWith('ox-ipc-')).map((n) => `\\\\.\\pipe\\${n}`);
    } catch {
      return [];
    }
  }
  try {
    return fs.readdirSync(dir).filter((n) => /^ox-ipc-.+\.sock$/.test(n)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// sanitizeForWire
// ---------------------------------------------------------------------------

function truncateString(value, max) {
  if (value.length <= max) return value;
  return value.slice(0, max) + TRUNCATED_SUFFIX;
}

// Compact one-line preview used for approval-request.argsPreview.
function previewOf(args, max = 400) {
  let text;
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  } catch {
    text = String(args ?? '');
  }
  if (typeof text !== 'string') text = String(text);
  return truncateString(text, max);
}

// Deep, cycle-safe redaction + truncation:
//   - keys for which isSecretKey() is true are masked to '[redacted]' at any depth
//     (metrics like inputTokens/outputTokens are allowlisted and never masked)
//   - strings longer than maxString are truncated
//   - Buffers collapse to a size marker (rule 4: never forward file contents)
//   - arrays are capped at maxArray; cycles become '[Circular]'
//   - depth and key count are capped so nothing can blow the stack
export function sanitizeForWire(value, opts = {}) {
  const maxString = Number.isFinite(opts.maxString) ? opts.maxString : DEFAULT_MAX_STRING;
  const maxArray = Number.isFinite(opts.maxArray) ? opts.maxArray : 200;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 12;
  const maxKeys = Number.isFinite(opts.maxKeys) ? opts.maxKeys : 200;

  const seen = new WeakSet();

  const walk = (v, depth) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return truncateString(v, maxString);
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'boolean') return v;
    if (t === 'undefined') return undefined;
    if (t === 'bigint') return `${v}n`;
    if (t === 'symbol') return v.toString();
    if (t === 'function') return `[function ${v.name || 'anonymous'}]`;

    if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
    if (v instanceof Error) return `${v.name}: ${truncateString(v.message ?? '', maxString)}`;
    if (Buffer.isBuffer(v)) return `[buffer ${v.length} bytes]`;

    if (depth > maxDepth) return '[depth-limit]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);

    if (Array.isArray(v)) {
      const out = [];
      for (const item of v.slice(0, maxArray)) {
        const r = walk(item, depth + 1);
        if (r !== undefined) out.push(r);
      }
      if (v.length > maxArray) out.push(`[+${v.length - maxArray} more]`);
      return out;
    }

    const out = {};
    let n = 0;
    for (const key of Object.keys(v)) {
      if (n >= maxKeys) {
        out['[truncated-keys]'] = Object.keys(v).length - n;
        break;
      }
      if (isSecretKey(key)) {
        out[key] = REDACTED;
        n += 1;
        continue;
      }
      let raw;
      try {
        raw = v[key];
      } catch {
        continue; // a throwing getter must not take down the emitter
      }
      const r = walk(raw, depth + 1);
      if (r === undefined) continue;
      out[key] = r;
      n += 1;
    }
    return out;
  };

  return walk(value, 0);
}

// ---------------------------------------------------------------------------
// Line framing (both peers)
// ---------------------------------------------------------------------------

// onDrop(reason, detail) reports a frame that was discarded rather than
// delivered, so an over-cap frame is visible instead of silently vanishing.
function attachFraming(socket, onLine, onDrop = null) {
  const drop = (reason, detail) => { if (onDrop) onDrop(reason, detail); };
  let buf = '';
  // After an oversize partial is discarded, the rest of that frame is still
  // on its way: skip to its newline instead of parsing the tail as a frame.
  // (Small pipe reads on Windows make this the common case, not the rare one.)
  let skipping = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (skipping) {
      const end = chunk.indexOf('\n');
      if (end === -1) return;
      skipping = false;
      chunk = chunk.slice(end + 1);
    }
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > MAX_FRAME_BYTES) {
        drop('oversize-frame', line.length);
        continue;
      }
      onLine(line);
    }
    // An unterminated frame that outgrows the cap is discarded rather than
    // buffered forever — a truncated "forever" is still a memory leak.
    if (buf.length > MAX_FRAME_BYTES) {
      drop('oversize-partial', buf.length);
      buf = '';
      skipping = true;
    }
  });
}

function encodeLine(obj) {
  return `${JSON.stringify(obj)}\n`;
}

// The uid carried out of the ownership screen, for the error message.
function st_uid(detail) {
  return Number.isInteger(detail) ? detail : 'another';
}

// The reply shape shared by the onRequest hook's failure paths, so a hook that
// throws and a hook that rejects are indistinguishable to the caller — both are
// a `control-reply` carrying the same id with ok:false.
export function controlReply(msg, { ok = true, result = undefined, error = null } = {}) {
  const frame = { type: 'control-reply', id: String(msg?.id ?? ''), ok: Boolean(ok) };
  if (ok) frame.result = result ?? null;
  else frame.error = String(error ?? 'error');
  return frame;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// createIpcServer({ socketPath, sessionId, meta, approvalTimeoutMs })
//
// Events:
//   'listening'          ({ socketPath })
//   'client-connected'   ({ client, clientId })
//   'client-disconnected'({ client, clientId })
//   'event'              (event)   — one per broadcast()
//   'approval-request'   ({ id, tool, args, resolve })  see rules 1 and 2
//   'approval-resolved'  ({ id, tool, decision, reason })
//   'dropped'            ({ client, count, total })    see rule 6
//   'protocol-warning'   ({ reason, detail })          see rule 5
//   'error'              (err)
//   'close'              ()
//
// `onRequest(msg, client, server)` is the extension point for a protocol that
// is NOT a run's GUI bridge: the daemon supervisor rides the same framing to
// carry control requests over the same socket. It is consulted only for a
// `type` the built-in switch does not own, and a returned value (or a promise
// for one) is written straight back to that client. With no hook installed the
// behaviour of an unknown type is byte-identical to what it always was: a
// protocol warning and no reply.
export function createIpcServer(opts = {}) {
  const {
    socketPath = socketPathFor(opts.sessionId ?? 'default'),
    sessionId = 'default',
    meta = {},
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    logger = null,
    onRequest = null,
  } = opts;

  const emitter = new EventEmitter();
  // Approvals resolve to a decision, so the emitter carries no error contract;
  // an unhandled 'error' throw here would be a process-level crash.
  emitter.on('error', () => {});
  emitter.setMaxListeners(0);

  const clients = new Set();

  // Rule 4: exactly one approval may be outstanding. The pending record owns
  // its client socket so hold and transport are released together.
  let pending = null;
  let approvalSeq = 0;
  let droppedTotal = 0;
  let closed = false;

  const log = (msg) => {
    if (typeof logger === 'function') {
      try { logger(msg); } catch { /* logging must never break the bridge */ }
    }
  };

  function resolvePending(decision, reason = 'resolved') {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    // Last line of defense for rules 2 and 5: whatever reached this point, a
    // decision outside the allowed set becomes the safe verdict.
    const verdict = APPROVAL_DECISIONS.includes(decision) ? decision : DECLINE;
    try { p.resolve(verdict, reason); } catch { /* consumer threw: still cleared */ }
    emitter.emit('approval-resolved', { id: p.id, tool: p.tool, decision: verdict, reason });
    // Tell ready clients the request is gone, so a GUI never shows a stale
    // Allow button for a decision the terminal (or a timeout) already made.
    for (const cl of clients) {
      if (!cl.ready) continue;
      try { cl.send({ type: 'approval-resolved', id: p.id, decision: verdict, reason }); } catch { /* best effort */ }
    }
  }

  // Withdraw the pending request without a client answer (e.g. the human
  // answered at the terminal first). Resolves 'ask', never 'allow'.
  function cancelApproval(reason = 'cancelled') {
    resolvePending(DECLINE, reason);
  }

  function requestApproval({ tool, args = {}, cwd = process.cwd(), preview } = {}) {
    // Rule 4: a second approval supersedes the first. Resolve the old one as
    // 'ask' BEFORE installing the new one, so the stale request can never be
    // left blocking and the newest intent always wins.
    resolvePending(DECLINE, 'superseded');

    approvalSeq += 1;
    const id = `ap-${approvalSeq}`;
    const at = Date.now();
    const deadlineAt = at + approvalTimeoutMs;
    const safeArgs = sanitizeForWire(args ?? {});
    const toolName = String(tool ?? 'unknown');

    // Only a client that announced itself with 'ready' can hold an approval: an
    // unidentified socket (a probe, a stray connect) must never be treated as
    // the decision-maker. If there is none, nobody can answer and the hold
    // never starts.
    const client = [...clients].find((c) => c.ready) || null;
    if (!client) {
      log('ipc: approval requested with no connected client -> ask');
      return Promise.resolve(DECLINE);
    }

    const frame = {
      type: 'approval-request',
      id,
      tool: toolName,
      argsPreview: preview ?? previewOf(safeArgs),
      args: safeArgs,
      cwd: String(cwd ?? ''),
      at,
      deadlineAt,
    };

    return new Promise((resolve) => {
      // Rule 1: the connection IS the wait. This timer is the only thing that
      // can end the hold besides an answer or a disconnect.
      const timer = setTimeout(() => resolvePending(DECLINE, 'timeout'), approvalTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      pending = { id, tool: toolName, client, resolve, timer, args: safeArgs, deadlineAt };

      // False means the frame could not be queued at all (unserializable or
      // past the frame cap): the answer can never arrive, so converge on 'ask'.
      if (client.send(frame) === false) resolvePending(DECLINE, 'send-failed');

      emitter.emit('approval-request', {
        id,
        tool: toolName,
        args: safeArgs,
        deadlineAt,
        resolve: (decision) => resolvePending(decision, 'resolved'),
      });
    });
  }

  function broadcast(event) {
    const frame = { type: 'event', event: sanitizeForWire(event), at: Date.now() };
    for (const client of clients) client.send(frame);
    emitter.emit('event', event);
    return frame;
  }

  function countDrop(client) {
    client.dropped += 1;
    droppedTotal += 1;
    emitter.emit('dropped', { client, count: client.dropped, total: droppedTotal });
  }

  // Rule 6: peer is not draining. Cap the queue by dropping the OLDEST queued
  // message (fresh events matter more than stale ones) and count the drop
  // rather than growing memory without bound. The message just enqueued is
  // never dropped, so a live approval frame always survives.
  function enqueue(client, line) {
    client.queue.push(line);
    client.queueBytes += line.length;
    while (client.queue.length > 1 && (client.queue.length > MAX_QUEUE_MSGS || client.queueBytes > MAX_QUEUE_BYTES)) {
      const dropped = client.queue.shift();
      client.queueBytes -= dropped.length;
      countDrop(client);
    }
    client.pump();
  }

  // net.Socket is a Duplex stream, so it emits 'drain' once its internal
  // buffer empties after write() returned false. That alone is not enough: on
  // a Windows named pipe every write completes asynchronously, so a small
  // write returns true yet leaves writableLength > 0, and no 'drain' follows.
  // Each write therefore re-runs the pump when it completes, or the queue
  // would sit until the next send happened to come along.
  function makePump(client) {
    return () => {
      while (client.queue.length) {
        if (client.socket.destroyed || !client.socket.writable) return;
        if (client.socket.writableLength > 0) return; // still congested
        const line = client.queue.shift();
        client.queueBytes -= line.length;
        client.socket.write(line, client.repump);
      }
      client.queueBytes = 0;
    };
  }

  function makeSend(client) {
    return (frame) => {
      let line;
      try {
        line = encodeLine(frame);
      } catch {
        return false; // unserializable frame: refuse rather than crash
      }
      if (line.length > MAX_FRAME_BYTES) return false;
      if (client.queue.length === 0 && client.socket.writable && client.socket.writableLength === 0) {
        // write() returning false still means "accepted and buffered", so this
        // counts as delivered, not as backpressure.
        client.socket.write(line, client.repump);
        return true;
      }
      enqueue(client, line);
      return true;
    };
  }

  function handleMessage(client, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      // Rule 5: malformed JSON is ignored, never fatal.
      emitter.emit('protocol-warning', { reason: 'malformed-json', detail: String(raw).slice(0, 120) });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      emitter.emit('protocol-warning', { reason: 'non-object-message', detail: typeof msg });
      return;
    }

    switch (msg.type) {
      case 'probe': {
        // Liveness probe from another server starting up: never a real client.
        client.teardown();
        try { client.socket.destroy(); } catch { /* already gone */ }
        return;
      }
      case 'ready': {
        client.clientId = String(msg.clientId ?? 'anonymous');
        client.ready = true;
        emitter.emit('client-connected', { client, clientId: client.clientId });
        return;
      }
      case 'ping': {
        client.send({ type: 'pong' });
        return;
      }
      case 'approval-answer': {
        const decision = String(msg.decision ?? '');
        if (!APPROVAL_DECISIONS.includes(decision)) {
          // Rule 5: an invalid decision is IGNORED and logged, never coerced
          // into a vote. The approval simply stays pending.
          const detail = `decision=${JSON.stringify(decision)}`;
          emitter.emit('protocol-warning', { reason: 'invalid-decision', detail });
          log(`ipc: ignoring approval-answer with invalid ${detail}`);
          return;
        }
        if (!pending || msg.id !== pending.id) {
          emitter.emit('protocol-warning', { reason: 'unknown-id', detail: String(msg.id ?? '') });
          return;
        }
        resolvePending(decision, 'client-answer');
        return;
      }
      case 'user-message': {
        // The island's voice / "ask about my screen" input. Text is capped like
        // every other frame; screenshots travel as paths (a PNG outgrows the
        // 1 MB frame cap) and only image files in the temp dir are accepted, so
        // a client cannot make ox read and upload an arbitrary file.
        const text = String(msg.text ?? '').slice(0, 4000).trim();
        if (!text) {
          emitter.emit('protocol-warning', { reason: 'empty-user-message', detail: '' });
          return;
        }
        const tmp = path.resolve(os.tmpdir());
        const imagePaths = (Array.isArray(msg.imagePaths) ? msg.imagePaths : [])
          .slice(0, 2)
          .map((p) => path.resolve(String(p)))
          .filter((p) => (p.startsWith(`${tmp}${path.sep}`) || p.startsWith('/private/tmp/') || p.startsWith('/tmp/')) && /\.(png|jpe?g)$/i.test(p));
        // The spoken question's recording, for whisper (src/dictation.js): same temp-dir rule.
        const audio = msg.audioPath ? path.resolve(String(msg.audioPath)) : null;
        const audioPath = audio && (audio.startsWith(`${tmp}${path.sep}`) || audio.startsWith('/private/tmp/') || audio.startsWith('/tmp/'))
          && /\.(caf|wav|m4a)$/i.test(audio) ? audio : null;
        emitter.emit('user-message', { client, text, imagePaths, audioPath, voice: msg.voice === true });
        return;
      }
      default: {
        // Rule 5 still holds for an unknown type with no hook: it is a warning,
        // never a crash. With a hook the frame is the caller's own protocol.
        if (typeof onRequest !== 'function') {
          emitter.emit('protocol-warning', { reason: 'unknown-type', detail: String(msg.type ?? '') });
          return;
        }
        let answer;
        try {
          answer = onRequest(msg, client, emitter);
        } catch (err) {
          client.send(controlReply(msg, { ok: false, error: String(err?.message ?? err) }));
          return;
        }
        if (answer === undefined) {
          emitter.emit('protocol-warning', { reason: 'unknown-type', detail: String(msg.type ?? '') });
          return;
        }
        // Async handlers are allowed, but a rejection must still be an answer:
        // a caller waiting on a control reply with no reply waits forever.
        Promise.resolve(answer).then(
          (value) => { if (value !== undefined) client.send(value); },
          (err) => { client.send(controlReply(msg, { ok: false, error: String(err?.message ?? err) })); }
        );
        return;
      }
    }
  }

  function attachClient(socket) {
    const client = {
      socket,
      ready: false,
      clientId: null,
      queue: [],
      queueBytes: 0,
      dropped: 0,
    };
    client.pump = makePump(client);
    client.repump = () => { if (client.queue.length) client.pump(); };
    client.send = makeSend(client);
    clients.add(client);

    attachFraming(
      socket,
      (line) => handleMessage(client, line),
      (reason, detail) => emitter.emit('protocol-warning', { reason, detail: String(detail) }),
    );
    socket.on('drain', client.pump);

    // The hello frame goes out immediately on accept, before any 'ready' is
    // required, so a client always learns session identity and the negotiated
    // protocol version. meta may add extras (bot, model, ...); the protocol
    // fields above stay authoritative and rule 4 truncation applies.
    client.send({
      ...sanitizeForWire(meta ?? {}),
      type: 'hello',
      sessionId,
      version: IPC_VERSION,
      pid: process.pid,
      cwd: sanitizeForWire(meta?.cwd ?? process.cwd()),
    });

    socket.on('error', (err) => {
      emitter.emit('protocol-warning', { reason: 'socket-error', detail: String(err?.message ?? err) });
    });

    // Rule 2: a client that vanishes mid-approval resolves 'ask'. Losing the
    // socket is silence, and silence must never mean allow.
    client.teardown = () => {
      if (!clients.delete(client)) return;
      if (pending && pending.client === client) resolvePending(DECLINE, 'client-disconnected');
      if (client.ready) emitter.emit('client-disconnected', { client, clientId: client.clientId });
    };

    socket.on('close', client.teardown);
    socket.on('end', () => {
      try { socket.end(); } catch { /* peer already half-closed */ }
    });
  }

  const server = net.createServer((socket) => attachClient(socket));
  server.on('error', (err) => emitter.emit('error', err));

  // Rule 3 (stale socket file): a crashed server leaves the inode behind and
  // bind() would fail with EADDRINUSE forever. Probe the existing path before
  // binding — the probe is asynchronous, so listen() must wait for its verdict
  // (binding first and unlinking after would always lose the race).
  //   'absent' -> bind normally
  //   'stale'  -> unlink, then bind
  //   'live'   -> do NOT steal another server's socket; surface an error
  //   'foreign' -> do NOT probe, do NOT unlink: the entry belongs to another
  //                user, and both touching it (a probe is a connection attempt
  //                they can see, an unlink is a denial of service) are acts on
  //                someone else's resource. Surface an error instead.
  function clearStaleSocket(target, done) {
    let settled = false;
    let probeTimer = null;
    let probe = null;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      if (probeTimer) clearTimeout(probeTimer);
      try { probe?.destroy(); } catch { /* noop */ }
      done(status, detail);
    };
    const unlink = () => {
      try { fs.unlinkSync(target); } catch { /* someone else cleaned it up */ }
    };
    let st;
    try {
      st = fs.lstatSync(target);
    } catch {
      return finish('absent'); // nothing there: normal first-boot case
    }
    // OWNERSHIP BEFORE PROBING. lstat, never stat: a symlink's lstat is the
    // symlink itself, so a symlink planted by another user to point at a socket
    // we own is refused here rather than followed. The reference uid defaults
    // to the owner of the directory holding the socket, which is the right
    // answer for every existing caller (their own dir, or the shared tmpdir they
    // already chose) and makes a cross-user path a hard failure by default.
    // uid < 0 (Windows) disables the check rather than failing every bind.
    if (expectedUid >= 0 && st.uid !== expectedUid) {
      return finish('foreign', st.uid);
    }
    // A probe that never answers is treated as stale: a live peer answers on
    // a unix socket immediately.
    probeTimer = setTimeout(() => { unlink(); finish('stale'); }, STALE_PROBE_MS);
    if (typeof probeTimer.unref === 'function') probeTimer.unref();
    probe = net.connect({ path: target });
    probe.on('connect', () => {
      // Identify the probe so a live ox server drops it instead of keeping a
      // phantom client on its roster.
      try { probe.write(encodeLine({ type: 'probe' })); } catch { /* raced */ }
      finish('live');
    });
    probe.on('error', () => { unlink(); finish('stale'); });
  }

  // The owner of the socket's directory is the owner the socket itself must
  // have. Resolved once, at bind time, and only from OUR OWN path.
  const expectedUid = (() => {
    const explicit = Number(opts.socketOwnerUid);
    if (Number.isInteger(explicit) && explicit >= 0) return explicit;
    try {
      const uid = fs.statSync(path.dirname(path.resolve(socketPath))).uid;
      return Number.isInteger(uid) ? uid : -1;
    } catch {
      return -1;
    }
  })();

  clearStaleSocket(socketPath, (status) => {
    if (status === 'foreign') {
      queueMicrotask(() => emitter.emit('error', Object.assign(
        new Error(
          `ipc: refusing to touch ${socketPath} — it is owned by uid ${st_uid(status)} ` +
            'and this process may only bind sockets it owns (pass socketOwnerUid to widen deliberately)'
        ),
        { code: 'EIPCINSEC' }
      )));
      return;
    }
    if (status === 'live') {
      queueMicrotask(() => emitter.emit('error', Object.assign(
        new Error(`ipc: socket already in use at ${socketPath}`),
        { code: 'EIPCINUSE' },
      )));
      return;
    }
    try {
      server.listen(socketPath);
    } catch (err) {
      queueMicrotask(() => emitter.emit('error', err));
    }
  });

  server.on('listening', () => emitter.emit('listening', { socketPath: server.address()?.path ?? socketPath }));

  function close(cb) {
    if (closed) {
      if (typeof cb === 'function') queueMicrotask(cb);
      return;
    }
    closed = true;
    // Any hold is a hold nobody can answer any more.
    resolvePending(DECLINE, 'server-closing');
    for (const client of [...clients]) {
      client.pump();
      client.teardown();
      try { client.socket.destroy(); } catch { /* already gone */ }
    }
    clients.clear();
    server.close(() => {
      // Rule 3 (cleanup): remove our own socket file on a clean close.
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      emitter.emit('close');
      if (typeof cb === 'function') cb();
    });
  }

  Object.assign(emitter, {
    socketPath,
    sessionId,
    approvalTimeoutMs,
    meta,
    clients,
    requestApproval,
    cancelApproval,
    broadcast,
    close,
    server,
  });

  // Defined as accessors, not object-literal getters: Object.assign() would
  // evaluate a getter once and copy a frozen snapshot.
  Object.defineProperties(emitter, {
    pendingApproval: {
      enumerable: true,
      get: () => (pending ? { id: pending.id, tool: pending.tool, args: pending.args, deadlineAt: pending.deadlineAt } : null),
    },
    droppedCount: { enumerable: true, get: () => droppedTotal },
    address: { enumerable: true, get: () => server.address() },
  });

  return emitter;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// connectIpcClient({ socketPath, clientId, connectTimeoutMs })
//
// Events: 'open', 'message' (parsed object), 'error', 'close'.
// Never rejects, never hangs: the connect attempt is hard-bounded at
// connectTimeoutMs (default 300ms) and every failure path ends in 'error' +
// 'close'. The caller must treat either as "no GUI present" — which for an
// approval means falling back to the terminal prompt.
export function connectIpcClient(opts = {}) {
  const {
    socketPath,
    clientId = `client-${process.pid}`,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  } = opts;

  const emitter = new EventEmitter();
  emitter.on('error', () => {});
  emitter.setMaxListeners(0);

  let isOpen = false;
  let connected = false;
  let ended = false;

  const socket = net.connect({ path: socketPath });

  // Rule 3 (stagger): bound the connect attempt itself. Deliberately not
  // unref'd — this timer is the guarantee that we never hang, so it must be
  // able to fire even if nothing else holds the event loop open.
  const connectTimer = setTimeout(() => {
    if (connected || ended) return;
    try { socket.destroy(); } catch { /* noop */ }
    finish(new Error(`ipc: connect timeout after ${connectTimeoutMs}ms`), 'connect-timeout');
  }, connectTimeoutMs);

  function finish(err, reason) {
    if (ended) return;
    ended = true;
    clearTimeout(connectTimer);
    isOpen = false;
    if (err) emitter.emit('error', err);
    emitter.emit('close', { reason, connected });
  }

  socket.on('connect', () => {
    connected = true;
    clearTimeout(connectTimer);
    if (ended) return;
    isOpen = true;
    // Announce ourselves so the server can pick a known-connected client as the
    // approval holder.
    try {
      socket.write(encodeLine({ type: 'ready', clientId }));
    } catch { /* socket raced to closed */ }
    emitter.emit('open', { clientId, socketPath });
  });

  attachFraming(socket, (line) => {
    if (ended) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      emitter.emit('error', new Error('ipc: malformed frame from server'));
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    emitter.emit('message', msg);
  }, (reason, detail) => {
    if (ended) return;
    emitter.emit('error', new Error(`ipc: ${reason} (${detail} bytes)`));
  });

  socket.on('error', (err) => {
    finish(err instanceof Error ? err : new Error(String(err?.message ?? err)), 'error');
  });

  socket.on('close', () => {
    finish(null, connected ? 'closed' : 'closed-unconnected');
  });

  function send(obj) {
    if (!isOpen || ended) return false;
    try {
      socket.write(encodeLine(obj));
    } catch {
      return false;
    }
    return true;
  }

  Object.assign(emitter, {
    socket,
    clientId,
    send,
    ping() { return send({ type: 'ping' }); },
    answer(id, decision) {
      // Rule 5 mirrored client-side: never put an invalid decision on the wire
      // at all, so a buggy UI cannot imply consent.
      if (!APPROVAL_DECISIONS.includes(decision)) {
        emitter.emit('error', new Error(`ipc: invalid decision ${JSON.stringify(decision)}`));
        return false;
      }
      return send({ type: 'approval-answer', id: String(id), decision });
    },
    close() {
      if (ended) return;
      ended = true;
      clearTimeout(connectTimer);
      isOpen = false;
      try { socket.destroy(); } catch { /* already gone */ }
      emitter.emit('close', { reason: 'client-closed', connected });
    },
  });

  Object.defineProperties(emitter, {
    connected: { enumerable: true, get: () => connected && !ended },
    open: { enumerable: true, get: () => isOpen && !ended },
    closed: { enumerable: true, get: () => ended },
  });

  return emitter;
}

// ---------------------------------------------------------------------------
// Wiring adapters
//
// The two seams the agent loop consumes. They live here so that neither
// src/agent.js nor src/approval.js has to know anything about sockets, framing,
// or the ready-handshake: the approver receives a plain object with two methods
// and the event fan-out receives a single function, exactly like any other
// injected dependency. Both return null for a missing server, so every caller
// site can pass the result straight through and a `null &&` check fails closed.
// ---------------------------------------------------------------------------

// A live approver for makeApprover()'s `external` parameter:
//   hasClient() -> boolean   is a client actually connected AND ready?
//   ask(req)     -> Promise<{ decision, clientId, reason }>
// decision is always one of APPROVAL_DECISIONS; the ipc server itself already
// converges every failure path on DECLINE ('ask'), so the consumer's job is
// only to treat anything other than 'allow' as "not answered".
export function createIpcApprover(server) {
  if (!server || typeof server.requestApproval !== 'function') return null;
  // Last known ready client, so a refusal can still name who refused even if
  // the socket closed between the answer and the message being written.
  let lastClientId = null;
  server.on?.('client-connected', ({ clientId }) => { lastClientId = clientId; });
  server.on?.('client-disconnected', () => { lastClientId = null; });
  // Only a client that announced itself with 'ready' may decide, so the gate
  // consults the same roster the server consults when it picks a holder.
  const readyClient = () => [...(server.clients ?? [])].find((c) => c?.ready) ?? null;
  return {
    kind: 'ipc',
    hasClient: () => readyClient() !== null,
    ask: async ({ tool, args = {}, detail = '', cwd } = {}) => {
      const decision = await server.requestApproval({
        tool,
        args,
        cwd: cwd ?? server.meta?.cwd ?? process.cwd(),
        preview: detail,
      });
      return { decision, clientId: readyClient()?.clientId ?? lastClientId ?? null, reason: 'ipc' };
    },
    cancel: (reason) => {
      try { server.cancelApproval?.(reason); } catch { /* nothing pending */ }
    },
  };
}

// Rule 3 applied to telemetry: a connected client may be slow, and the run
// must not wait on it. Coalescing window for streamed text.
export const DEFAULT_TEXT_FLUSH_MS = 150;

// Live event fan-out for the agent loop: a throttled, non-throwing forwarder
// around server.broadcast().
//
// WHY text-delta IS COALESCED: one model turn can emit thousands of chunks.
// Forwarding each verbatim saturates the client's socket buffer, and when a
// peer stops draining, ipc.js sheds backpressure by dropping the OLDEST queued
// frame — i.e. the tool/error events a live view most needs, not the noise.
// So streamed text accumulates and leaves as at most one frame per
// textFlushMs, with a forced flush immediately before any non-text event (to
// keep the client's ordering honest) and one when the loop ends. Every other
// event — tool-start, tool-end, error, approval, usage, turn-end, compaction —
// is forwarded immediately and unthrottled, because those are the events a
// human has to react to. The terminal still renders every delta: this changes
// what crosses the socket, not what the user sees.
export function createEventBroadcaster(server, { textFlushMs = DEFAULT_TEXT_FLUSH_MS } = {}) {
  if (!server || typeof server.broadcast !== 'function') return null;
  let pendingText = '';
  let timer = null;

  const send = (event) => {
    try {
      // Rule 4: nothing reaches the wire un-sanitized. broadcast() sanitizes
      // again on its own side; doing it here keeps the guarantee owned by the
      // adapter instead of trusting a downstream implementation detail, and it
      // is idempotent (already-truncated strings pass through unchanged). This
      // is also what bounds the `history` event, whose message array would
      // otherwise be the largest frame a run ever produces.
      server.broadcast(sanitizeForWire(event));
    } catch { /* a dead socket must never break the agent loop */ }
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pendingText) return;
    const text = pendingText;
    pendingText = '';
    send({ type: 'text-delta', text });
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, textFlushMs);
    // Never holds the process open: a run that ends mid-window must still exit.
    if (typeof timer.unref === 'function') timer.unref();
  };

  const forward = (event) => {
    try {
      if (event?.type === 'text-delta') {
        pendingText += String(event.text ?? '');
        schedule();
        return;
      }
      flush(); // ordering: buffered text belongs before this event
      send(event);
    } catch { /* telemetry is never allowed to break the loop */ }
  };

  forward.flush = flush;
  return forward;
}
