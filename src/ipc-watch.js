// `ox ipc watch` — the terminal companion to the IPC bridge.
//
// A connected ox run streams its events over a unix socket (see src/ipc.js) and
// parks on an approval request while a client holds the connection open. A GUI
// is the obvious client. This module is the other one: a full-screen,
// zero-dependency dashboard that redraws in place and takes approval answers
// from the keyboard. It adds no protocol of its own — it speaks exactly the wire
// format src/ipc.js already defines, and the only values it can put on the wire
// are the three APPROVAL_DECISIONS allows. Silence stays the default: quitting
// the dashboard mid-hold makes the server resolve 'ask', the safe verdict.
//
// The module is split so the interesting half is testable without a pty:
//
//   createWatchState() / applyMessage()  a pure fold from wire messages to a
//       view state. No I/O, no timers, no clock (the caller's `now` is
//       injected), no process access, and the input state is never mutated.
//   renderFrame(state, opts)            a pure state -> string renderer. Also no
//       I/O and no process access: colour and terminal width are parameters.
//   runWatch(opts)                      the only impure part. Owns the socket,
//       the 10fps redraw timer, raw-mode keypresses, and the teardown.
//
// Two rendering modes. On a TTY the dashboard owns a region at the bottom of the
// screen: it redraws by moving the cursor back up over exactly the lines it
// drew last time and erasing each to end-of-line, so it never scrolls the
// terminal and never touches scrollback above it. Off a TTY (a pipe, a log
// file, CI) it degrades to a line-oriented event log — `ox ipc watch > run.log`
// is genuinely useful, and refusing outright would not be. Keyboard answering
// needs a TTY on both ends; there is no way to answer a keypress from a file.
// NO_COLOR disables colour in both modes.

import os from 'node:os';
import path from 'node:path';
import { connectIpcClient, socketPathFor } from './ipc.js';
import { c, truncate, formatElapsed } from './ui.js';
import { banner } from './logo.js';

// 10fps is fast enough that a spinner reads as motion and a counter never looks
// stuck, slow enough that a frame is a few KB and the CPU cost is noise.
export const WATCH_DEFAULT_FPS = 10;

// The initial connect gets a longer budget than ipc.js's 300ms fire-and-forget
// default: here a human is waiting on the command, and a bridge that is still
// coming up should not be reported as absent. Nothing after this is bounded by
// it — the dashboard runs until the bridge closes or the human quits.
const CONNECT_TIMEOUT_MS = 1500;

// Bounds on retained view state. All of them are "the dashboard is a window, not
// a log": a long run must not grow the process.
const TAIL_CHARS = 1600;
const MAX_NOTES = 3;
// Generous relative to the other caps because it exists only to make one
// increment idempotent per cancelled agent, and a run that cancels more than
// this many agents has long since left the window where an operator would
// still be comparing these counts by hand.
const MAX_CANCEL_ACKS = 256;
const MAX_APPROVALS = 32;
const MAX_PREVIEW = 160;
const PANEL_ARG_ROWS = 6;

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LABEL_W = 8;
const KEY_DECISION = Object.freeze({ a: 'allow', d: 'deny', s: 'ask' });
// `x` is CANCEL, and it is deliberately NOT in KEY_DECISION: that map is the
// only thing allowed to put a value on the wire, and an approval decision and a
// cancel request are different messages with different failure modes. A cancel
// that got through as `deny` would deny an approval nobody was asked about.
const CANCEL_KEY = 'x';
// One cancel per press. The first row that has not already been cancelled is the
// target -- oldest first, which is `activeAgents`' own order, so `x` twice stops
// the two oldest rather than the same one twice.
const CANCEL_FRAME_TYPE = 'subagent-cancel';

const CTRL_C = '\u0003';
const ESC = '\u001b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ERASE_EOL = `${ESC}[K`;
const ERASE_DOWN = `${ESC}[J`;
const UP = (n) => (n > 0 ? `${ESC}[${n}A` : '');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v, fallback, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function padTo(text, n) {
  const s = String(text ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// Not toLocaleString: the grouping of a live counter must not depend on whether
// this Node was built with full ICU.
function withCommas(n) {
  const v = Math.round(Number(n) || 0);
  const sign = v < 0 ? '-' : '';
  const digits = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

function money(costUsd) {
  return `$${(Number(costUsd) || 0).toFixed(4)}`;
}

// One duration formatter for every surface. The terminal and the dashboard
// showing "3m 07s" and "3m 6s" for the same run is a small thing that makes an
// operator doubt both of them.
const formatDuration = formatElapsed;

// A tool argument is a human decision surface, not a JSON blob: a multi-line
// edit collapses to one line so the approval card stays card-sized.
function oneLine(value, max = MAX_PREVIEW) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ~/work/proj: the deepest part of a home directory is the least informative
// part of a path.
function shortPath(p, home = os.homedir()) {
  const s = String(p ?? '');
  if (!s) return '';
  const h = String(home ?? '');
  const rel = h && s === h ? '~' : h && s.startsWith(h + path.sep) ? `~${s.slice(h.length)}` : s;
  const parts = rel.split(path.sep).filter((x) => x !== '');
  return parts.length <= 3 ? rel : `…/${parts.slice(-2).join('/')}`;
}

// The first argument key that names something a human would recognise as "the
// thing being touched". Ordered, so a command beats a trailing generic name.
// `task` leads for the same reason it leads in ui.js renderToolStart: the
// subagent tool is the only schema with one, and it is the only field on a
// `subagent` call that says what is being worked on.
const TARGET_KEYS = [
  'task', 'file_path', 'path', 'file', 'filename', 'command', 'url', 'pattern',
  'dir', 'directory', 'query', 'name', 'old_string', 'new_string',
];

function argsObject(args, preview) {
  if (isPlainObject(args)) return args;
  if (typeof preview === 'string' && preview.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(preview);
      if (isPlainObject(parsed)) return parsed;
    } catch { /* a truncated preview is not a reason to fail the frame */ }
  }
  return null;
}

function toolTarget(args, preview) {
  const obj = argsObject(args, preview);
  if (obj) {
    for (const key of TARGET_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim() !== '') return oneLine(v, 60);
    }
  }
  // An unparseable preview is almost always a truncated one. Showing 60
  // characters of half a JSON blob on the status line is noise, not
  // information, so it is left for the approval card to carry.
  if (typeof preview === 'string' && preview.trim() !== '') {
    const raw = oneLine(preview, 60);
    return raw.length <= 40 ? raw : '';
  }
  return '';
}

// Colour is a parameter, never an ambient read, so a rendered frame is a plain
// string that can be asserted on. The enabled branch reuses the repo palette;
// the disabled branch is a pass-through, not a second set of escapes.
function palette(on) {
  if (on) return c;
  const id = (s) => String(s ?? '');
  return { dim: id, s: id, green: id, yellow: id, red: id, cyan: id, bold: id, magenta: id };
}

const L = (label) => `  ${padTo(label, LABEL_W)}`;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

// The whole view, in one object. Nothing in it is derived from a global, so a
// frame can be rebuilt from a state that was folded an hour ago.
export function createWatchState() {
  return {
    phase: 'connecting', // connecting | working | idle | waiting | done | error | disconnected
    connected: false,
    sessionId: null,
    bot: null,
    model: null,
    provider: null,
    cwd: null,
    pid: null,
    version: null,
    startedAt: null,
    lastEventAt: null,
    lastPongAt: null,
    pongs: 0,
    // Keyed by tool-call id, NOT a single slot. A single slot cannot represent
    // two things running at once, and with subagent lifecycle events on the
    // wire that is no longer a hypothetical: a parent tool call and a subagent
    // that is mid-run are both legitimately open at the same instant.
    tools: {}, // callId -> { id, name, preview, args, at, agent }
    toolCounts: {},
    toolsTotal: 0,
    // Subagent lifecycle, folded from subagent-spawn/start/progress/end. This
    // is the map that lets the dashboard show FOUR concurrent agents rather
    // than the one the old `tool` slot could hold.
    agents: {}, // subagentId -> { id, task, phase, currentTool, at, startedAt, depth }
    agentsActive: 0,
    agentsSeen: 0,
    agentsFinished: 0,
    // Cancels are counted twice on purpose: `agentsCancelled` is requests made
    // (a button pressed), `agentsCancelledDone` is agents that actually reached
    // `subagent-end` with status 'cancelled' (a button that worked). The gap
    // between them is requests whose agent never reported an end -- which is
    // exactly the case an operator needs to notice, so it is not smoothed over.
    agentsCancelled: 0,
    agentsCancelledDone: 0,
    // subagentId -> when its terminal cancel was counted. Makes the
    // requests-vs-worked accounting IDEMPOTENT: 'subagent-end' with status
    // 'cancelled' and the dedicated 'subagent-cancelled' event describe the SAME
    // stop, and both arrive on a healthy run. Counting both would inflate
    // agentsCancelledDone to 2 for one cancelled agent and make the very gap
    // this counter exists to expose read as noise. Capped like the other
    // bounded collections here.
    cancelledAck: {}, // subagentId -> at
    agentsFailed: 0,
    turns: 0,
    lastStopReason: null,
    tokensIn: 0,
    tokensOut: 0,
    auxIn: 0,
    auxOut: 0,
    costUsd: 0,
    costKnown: false,
    sawTotal: false,
    tokensUnknown: false,
    declaredModel: null,
    servedModel: null,
    errors: 0,
    lastError: null,
    approvals: [], // { id, tool, args, argsPreview, at, holdMs, arrivedAt, state, decision, decidedAt }
    lastAnswer: null,
    tail: '',
    notes: [],
    unknownEvents: 0,
  };
}

function cloneState(s) {
  const tools = {};
  for (const [k, v] of Object.entries(s?.tools ?? {})) tools[k] = { ...v };
  const agents = {};
  for (const [k, v] of Object.entries(s?.agents ?? {})) agents[k] = { ...v };
  return {
    ...s,
    toolCounts: { ...(s?.toolCounts ?? {}) },
    tools,
    agents,
    // Copied, not shared: a snapshot handed to a renderer must not be able to
    // mark a cancel as already-counted and silence the real increment.
    cancelledAck: { ...(s?.cancelledAck ?? {}) },
    approvals: (Array.isArray(s?.approvals) ? s.approvals : []).map((a) => ({ ...a })),
    notes: (Array.isArray(s?.notes) ? s.notes : []).map((n) => ({ ...n })),
    lastAnswer: s?.lastAnswer ? { ...s.lastAnswer } : null,
  };
}

// The most recently started tool that has not ended -- the dashboard's
// "what is happening right now" line, derived from the map rather than stored,
// so it cannot disagree with the rows underneath it.
export function currentTool(st) {
  let best = null;
  for (const t of Object.values(st?.tools ?? {})) {
    if (!best || (t.at ?? 0) > (best.at ?? 0)) best = t;
  }
  return best;
}

export function activeAgents(st) {
  return Object.values(st?.agents ?? {}).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

function pushNote(st, text, tone = 'info') {
  if (!text) return;
  st.notes = [...st.notes, { text: oneLine(text, 96), tone }].slice(-MAX_NOTES);
}

export function pendingApprovals(state) {
  return (Array.isArray(state?.approvals) ? state.approvals : []).filter((a) => a.state === 'pending');
}

function trimApprovals(st) {
  if (st.approvals.length <= MAX_APPROVALS) return;
  // Only ever discard settled ones: a pending request is a live hold on the
  // server, and forgetting it would strand a human decision.
  let overflow = st.approvals.length - MAX_APPROVALS;
  st.approvals = st.approvals.filter((a) => {
    if (overflow > 0 && a.state !== 'pending') { overflow -= 1; return false; }
    return true;
  });
}

// Token counts arrive REDACTED from a real bridge: sanitizeForWire masks any
// key matching /token/i (src/ipc.js), so `inputTokens` crosses the socket as the
// string '[redacted]'. A dashboard that reported that as 0 tokens would be
// confidently wrong, so a non-numeric count is recorded as unknown and the frame
// says so — a missing number is not the same as a zero.
function isRedacted(value) {
  return value != null && !Number.isFinite(Number(value));
}

// The run's own usage events name the model that actually served the turn,
// which is not the configured bot when `--bot`/`--model` overrides it. Record
// the disagreement once instead of rendering a bot:model pair that never ran.
function noteServedModel(st, model) {
  const next = String(model ?? '');
  if (!next) return;
  if (st.declaredModel && st.declaredModel !== next) {
    pushNote(st, `served by ${next}, not ${st.declaredModel}`, 'info');
  }
  st.servedModel = next;
  st.model = next;
}

function countOf(value) {
  if (value == null) return null;
  const n = num(value);
  return n === null ? 0 : n;
}

// usage is a DELTA (one model call): add it.
function foldUsage(st, ev, at) {
  const inTok = countOf(ev.inputTokens);
  const outTok = countOf(ev.outputTokens);
  st.tokensIn += inTok;
  st.tokensOut += outTok;
  if (isRedacted(ev.inputTokens) || isRedacted(ev.outputTokens)) st.tokensUnknown = true;
  if (ev.aux === true) { st.auxIn += inTok; st.auxOut += outTok; }
  const cost = num(ev.costUsd);
  if (cost !== null) { st.costUsd += cost; st.costKnown = true; }
  noteServedModel(st, ev.model);
  st.lastEventAt = at;
  return st;
}

// usage-total is a CUMULATIVE SNAPSHOT of the same counters the per-call `usage`
// events increment, so it must never be added on top of them — only allowed to
// raise the running value. max() is exactly that, and it is free when the two
// agree: fold in 100/10 twice and then a total of 200/20, and the view reads
// 200/20, not 400/40.
function foldUsageTotal(st, ev, at) {
  if (isRedacted(ev.inputTokens) || isRedacted(ev.outputTokens)) st.tokensUnknown = true;
  const inTok = isRedacted(ev.inputTokens) ? null : num(ev.inputTokens);
  const outTok = isRedacted(ev.outputTokens) ? null : num(ev.outputTokens);
  if (inTok !== null) st.tokensIn = Math.max(st.tokensIn, inTok);
  if (outTok !== null) st.tokensOut = Math.max(st.tokensOut, outTok);
  const auxIn = num(ev.auxInputTokens);
  const auxOut = num(ev.auxOutputTokens);
  if (auxIn !== null) st.auxIn = Math.max(st.auxIn, auxIn);
  if (auxOut !== null) st.auxOut = Math.max(st.auxOut, auxOut);
  const cost = num(ev.costUsd);
  if (cost !== null) { st.costUsd = Math.max(st.costUsd, cost); st.costKnown = true; }
  noteServedModel(st, ev.model);
  st.sawTotal = true;
  st.lastEventAt = at;
  return st;
}

// A call id is the only stable key a tool-start carries. Some providers send
// none, so a synthetic name+ordinal key stands in: it is still unique per call
// within this run, which is all the map needs.
function toolKey(ev, ordinal) {
  return ev?.id == null ? `~${String(ev?.name ?? 'unknown')}#${ordinal}` : String(ev.id);
}

function foldToolStart(st, ev, at) {
  const name = String(ev.name ?? 'unknown');
  st.tools[toolKey(ev, st.toolsTotal)] = {
    id: ev.id == null ? null : String(ev.id),
    name,
    preview: ev.argsPreview == null ? '' : String(ev.argsPreview),
    args: isPlainObject(ev.args) ? ev.args : null,
    at,
    // Which agent opened it, when the event says. A subagent's inner tools are
    // not on this wire as their own tool-start (they are folded into
    // subagent-progress), but a parent call made ON a subagent's behalf carries
    // the id, and the agent rows are the only place that association is drawn.
    agent: ev.agentId == null ? null : String(ev.agentId),
  };
  st.toolCounts[name] = (st.toolCounts[name] ?? 0) + 1;
  st.toolsTotal += 1;
  st.phase = 'working';
  st.lastEventAt = at;
  return st;
}

function foldToolEnd(st, ev, at) {
  const name = String(ev.name ?? 'unknown');
  // Batches start several tools before any of them ends, so the map is the
  // point: the call that finished is removed by KEY and every other open call
  // is left alone. The old single slot could only ever clear itself.
  if (ev.id != null) delete st.tools[String(ev.id)];
  else {
    for (const [k, v] of Object.entries(st.tools)) {
      if (v.name === name && v.id == null) delete st.tools[k];
    }
  }
  if (ev.isError === true || ev.ok === false) {
    st.errors += 1;
    st.lastError = `${name} failed`;
    pushNote(st, `✗ ${name} failed`, 'err');
  } else {
    pushNote(st, `✓ ${name}${num(ev.ms) != null ? ` (${ev.ms}ms)` : ''}`, 'ok');
  }
  st.phase = 'idle';
  st.lastEventAt = at;
  return st;
}

// ---- subagent lifecycle -----------------------------------------------------
//
// Four events, folded into a keyed map of live agents. Every branch is written
// so that replaying an event twice is a no-op: the wire can legitimately
// deliver a progress event that was already seen (it is throttled on the send
// side and re-sent on the queue drain), and a dashboard that double-counts
// agents is worse than one that is briefly late.

function foldSubagentSpawn(st, ev, at) {
  const id = String(ev.id ?? '?');
  if (!st.agents[id]) st.agentsActive += 1;
  st.agents[id] = {
    id,
    task: String(ev.task ?? ev.description ?? ''),
    description: String(ev.description ?? ev.task ?? ''),
    depth: Number(ev.depth) || 0,
    parentId: ev.parentId == null ? null : String(ev.parentId),
    resumed: ev.resumed === true,
    phase: 'spawned',
    currentTool: null,
    currentToolArgsPreview: '',
    iterations: 0,
    at,
    startedAt: at,
  };
  st.agentsSeen += 1;
  pushNote(st, `agent ${id} spawned`, 'info');
  st.phase = 'working';
  st.lastEventAt = at;
  return st;
}

function foldSubagentStart(st, ev, at) {
  const id = String(ev.id ?? '?');
  const rec = st.agents[id];
  if (!rec) {
    // A start with no spawn means the spawn was folded out (a reconnecting
    // client, a truncated log). Synthesising the row is better than dropping
    // the agent: an operator must never be shown a running count that is
    // missing an agent the wire says is running.
    foldSubagentSpawn(st, ev, at);
    st.agentsSeen = Math.max(0, st.agentsSeen - 1);
  }
  const r = st.agents[id];
  r.phase = 'running';
  r.startedAt = at;
  r.at = at;
  st.lastEventAt = at;
  return st;
}

function foldSubagentProgress(st, ev, at) {
  const id = String(ev.id ?? '?');
  const rec = st.agents[id];
  if (!rec) {
    foldSubagentSpawn(st, { id, task: ev.task ?? '' }, at);
    st.agentsSeen = Math.max(0, st.agentsSeen - 1);
  }
  const r = st.agents[id];
  r.phase = String(ev.phase ?? r.phase);
  r.currentTool = ev.currentTool == null ? null : String(ev.currentTool);
  r.currentToolArgsPreview = ev.currentToolArgsPreview == null ? '' : String(ev.currentToolArgsPreview);
  r.iterations = Number(ev.iterations) || r.iterations;
  r.at = at;
  st.phase = 'working';
  st.lastEventAt = at;
  return st;
}

// A cancel REQUEST, not a cancel COMPLETION. Folded as its own thing rather than
// folded into a progress event because the two mean opposite things to an
// operator: `cancelling` says "your request registered, the agent is still
// unwinding", and claiming otherwise would be the exact lie this dashboard exists
// to avoid -- an operator who sees a working agent and no cancel will press cancel
// again, and an operator who sees a cancelled agent that is still writing will
// stop watching for the write.
//
// The row is NOT removed here. `subagent-end` removes it, and until that arrives
// the agent is genuinely still accounted for in `agentsActive`.
function foldSubagentCancel(st, ev, at) {
  const id = String(ev.id ?? '?');
  const rec = st.agents[id];
  if (!rec) {
    // A cancel for an agent this client never saw spawned (it connected late, or
    // the log was truncated). Synthesising the row is better than dropping it: an
    // operator has to be able to see what they just cancelled.
    foldSubagentSpawn(st, ev, at);
    st.agentsSeen = Math.max(0, st.agentsSeen - 1);
  }
  const r = st.agents[id];
  r.cancelRequested = true;
  r.cancelBy = ev.by == null ? null : String(ev.by);
  r.cancelReason = ev.reason == null ? null : String(ev.reason);
  r.semantics = ev.semantics == null ? r.semantics : String(ev.semantics);
  r.steerPending = Number(ev.steerPending) || 0;
  r.phase = 'cancelling';
  r.at = at;
  st.agentsCancelled += 1;
  pushNote(st, `⚠ cancel requested for ${id}${ev.by ? ` by ${ev.by}` : ''} — ${r.semantics ?? 'no further steps will start'}`, 'warn');
  st.lastEventAt = at;
  return st;
}

// Exactly one increment per cancelled agent, whichever of the two events
// describing that stop arrives first -- and a count even when ONLY this event
// arrives, which is the late-joining-client case: a client that attaches after
// `subagent-end` was written has a cancel it can see and no end to infer it
// from. Dropping it would under-report, and under-reporting a stop is the one
// direction this dashboard must never be wrong in.
function noteCancelledTerminal(st, ev, at) {
  const id = String(ev.id ?? '?');
  if (st.cancelledAck[id] != null) return false;
  st.cancelledAck[id] = at;
  const keys = Object.keys(st.cancelledAck);
  if (keys.length > MAX_CANCEL_ACKS) {
    for (const k of keys.slice(0, keys.length - MAX_CANCEL_ACKS)) delete st.cancelledAck[k];
  }
  st.agentsCancelledDone += 1;
  return true;
}

function foldSubagentCancelled(st, ev, at) {
  const id = String(ev.id ?? '?');
  // Defensive: on a healthy run 'subagent-end' already retired the row. If a
  // row is somehow still live it is a client that saw the cancel and not the
  // end, so retiring it here is what keeps the active count honest rather than
  // leaving an agent running on screen forever.
  if (st.agents[id]) {
    st.agentsActive = Math.max(0, st.agentsActive - 1);
    delete st.agents[id];
  }
  const fresh = noteCancelledTerminal(st, ev, at);
  if (fresh) {
    const sem = ev.cancelSemantics == null ? '' : String(ev.cancelSemantics);
    pushNote(
      st,
      `⚠ agent ${id} cancelled${ev.by ? ` by ${ev.by}` : ''} · ${formatDuration(num(ev.elapsedMs) ?? NaN)}${sem ? ` — ${sem}` : ''}`,
      'warn',
    );
  }
  if (st.agentsActive === 0 && st.phase === 'working') st.phase = 'idle';
  st.lastEventAt = at;
  return st;
}

function foldSubagentEnd(st, ev, at) {
  const id = String(ev.id ?? '?');
  const rec = st.agents[id];
  if (rec) {
    st.agentsActive = Math.max(0, st.agentsActive - 1);
    delete st.agents[id];
  }
  st.agentsFinished += 1;
  const failed = ev.status === 'failed';
  const cancelled = ev.status === 'cancelled' || ev.cancelled === true;
  if (failed) st.agentsFailed += 1;
  if (cancelled) noteCancelledTerminal(st, ev, at);
  const bits = [`agent ${id} ${String(ev.status ?? 'done')}`, formatDuration(num(ev.elapsedMs) ?? NaN)];
  const files = Array.isArray(ev.filesTouched) ? ev.filesTouched.filter(Boolean) : [];
  if (files.length) bits.push(`${files.length} file${files.length === 1 ? '' : 's'}`);
  // A cancelled agent gets its OWN marker. It is neither the ✓ of a finished run
  // nor the ✗ of a broken one, and the tone follows that: an operator scanning
  // for failures must not find cancelled agents filed under failures.
  if (!cancelled) {
    pushNote(st, `${failed ? '✗' : '✓'} ${bits.join(' · ')}`, failed ? 'err' : 'ok');
  }
  // Only now, with nothing left running, is 'idle' a true statement. While an
  // agent is live the phase stays 'working', because a parent loop blocked on a
  // subagent IS working and the old 'idle' between the parent's tool events
  // read as a stall.
  if (st.agentsActive === 0 && st.phase === 'working') st.phase = 'idle';
  st.lastEventAt = at;
  return st;
}

function foldEvent(st, ev, at) {
  if (!isPlainObject(ev)) return st;
  switch (ev.type) {
    case 'text-delta': {
      const text = String(ev.text ?? '');
      if (text) st.tail = `${st.tail}${text}`.slice(-TAIL_CHARS);
      if (st.phase !== 'waiting') st.phase = 'working';
      st.lastEventAt = at;
      return st;
    }
    case 'tool-start':
      foldToolStart(st, ev, at);
      return st;
    case 'tool-end':
      foldToolEnd(st, ev, at);
      return st;
    case 'subagent-spawn':
      return foldSubagentSpawn(st, ev, at);
    case 'subagent-start':
      return foldSubagentStart(st, ev, at);
    case 'subagent-progress':
      return foldSubagentProgress(st, ev, at);
    case 'subagent-cancel':
      return foldSubagentCancel(st, ev, at);
    case 'subagent-cancelled':
      return foldSubagentCancelled(st, ev, at);
    case 'subagent-end':
      return foldSubagentEnd(st, ev, at);
    case 'usage':
      foldUsage(st, ev, at);
      return st;
    case 'usage-total':
      foldUsageTotal(st, ev, at);
      return st;
    case 'turn-end': {
      st.turns += 1;
      st.lastStopReason = ev.stopReason == null ? null : String(ev.stopReason);
      st.tools = {};
      st.phase = /^(stop|end|done|complete|max)/i.test(st.lastStopReason ?? '') ? 'done' : 'idle';
      pushNote(st, `turn ${st.turns} · ${st.lastStopReason ?? 'end'}`, 'info');
      st.lastEventAt = at;
      return st;
    }
    case 'error': {
      // An abort is a STOP, not a break. src/agent.js yields {type:'error',
      // error:'aborted'} when a run signal fires, which is what a per-agent
      // cancel does and what a run-wide Ctrl-C does -- in both cases nothing
      // failed, and counting it put a red error badge and an 'errors 1' on a
      // dashboard whose agentsCancelledDone said 0, i.e. the cancel reported
      // itself as a failure on one surface and as a clean stop on another.
      //
      // It is still SHOWN, as a dim note rather than a red one: the run really
      // did stop, and hiding it would be its own dishonesty. What it must not
      // do is inflate the failure tally an operator scans for broken runs.
      const text = String(ev.error ?? ev.message ?? 'error');
      const aborted = /^aborted(?![a-z0-9])/i.test(text.trim());
      if (aborted) {
        pushNote(st, `— ${oneLine(text, 120)}`, 'info');
        if (!st.agentsActive) st.phase = 'idle';
      } else {
        st.errors += 1;
        st.lastError = oneLine(text, 120);
        st.phase = 'error';
        pushNote(st, `✗ ${st.lastError}`, 'err');
      }
      st.lastEventAt = at;
      return st;
    }
    case 'approval': {
      const decision = String(ev.decision ?? '?');
      pushNote(st, `${String(ev.name ?? 'tool')} ${decision}${ev.mode ? ` (${ev.mode})` : ''}`, decision === 'deny' ? 'err' : 'info');
      st.lastEventAt = at;
      return st;
    }
    case 'compaction':
      // Keep the one-line summary but carry the audit facts into the note, so
      // a client that only shows notes still shows WHY it compacted and with
      // what. Drop/saved fields are guarded because the agent may be older.
      {
        const bits = [`compacted ${ev.from} → ${ev.to} tokens`];
        if (Number.isFinite(ev?.savedTokens)) bits.push(`saved ${ev.savedTokens}`);
        if (Number.isFinite(ev?.messagesSummarized)) bits.push(`${ev.messagesSummarized} summarized`);
        if (ev?.compactionModel || ev?.model) bits.push(`via ${ev.compactionModel ?? ev.model}`);
        pushNote(st, bits.join(' · '), 'info');
      }
      st.lastEventAt = at;
      return st;
    case 'verification':
      pushNote(st, ev.complete === true ? 'verification passed' : `verification: ${oneLine(ev.gaps ?? 'gaps', 60)}`, ev.complete === true ? 'ok' : 'err');
      st.lastEventAt = at;
      return st;
    case 'assistant-turn':
      if (st.phase !== 'waiting') st.phase = 'working';
      st.lastEventAt = at;
      return st;
    case 'final':
      st.tools = {};
      st.phase = 'done';
      pushNote(st, 'final answer', 'ok');
      st.lastEventAt = at;
      return st;
    case 'fallback':
      // Endpoint honesty, from the run's own mouth: which provider actually
      // served the turn when the pinned one bounced.
      pushNote(st, `fallback ${ev.from} → ${ev.to}${ev.reason ? ` (${ev.reason})` : ''}`, 'info');
      st.lastEventAt = at;
      return st;
    case 'warning':
      pushNote(st, `!${' '} ${oneLine(ev.text ?? ev.warning ?? 'warning', 88)}`, 'err');
      st.lastEventAt = at;
      return st;
    case 'progress-note':
      pushNote(st, oneLine(ev.text ?? '', 88), 'info');
      st.lastEventAt = at;
      return st;
    case 'tool-narrowing':
      pushNote(st, `tools ${ev.offered}/${ev.total} offered`, 'info');
      st.lastEventAt = at;
      return st;
    case 'continuation-retry':
      pushNote(st, `retry ${ev.attempt}: ${oneLine(ev.reason ?? '', 60)}`, 'err');
      st.lastEventAt = at;
      return st;
    case 'doom-loop':
      pushNote(st, `repeated tool call blocked (x${ev.count})`, 'err');
      st.lastEventAt = at;
      return st;
    case 'gate-exhausted':
      pushNote(st, `quality gates exhausted: ${oneLine((ev.pending ?? []).join(', '), 60)}`, 'err');
      st.lastEventAt = at;
      return st;
    case 'continued':
      pushNote(st, `continuing (round ${ev.round ?? '?'})`, 'info');
      st.lastEventAt = at;
      return st;
    case 'reflection':
      pushNote(st, `reflect: ${oneLine(ev.text ?? '', 70)}`, 'info');
      st.lastEventAt = at;
      return st;
    case 'history':
      // Deliberately folded to nothing: it is the largest frame a run produces
      // and a dashboard has no use for a transcript.
      return st;
    default: {
      // Protocol drift is a fact about the run, and a human staring at a
      // dashboard is the only one positioned to notice it.
      st.unknownEvents += 1;
      pushNote(st, `? unhandled event '${String(ev.type ?? '?')}'`, 'info');
      st.lastEventAt = at;
      return st;
    }
  }
}

// applyMessage(state, msg, { now }) -> state
//
// Folds ONE wire message into the view state. Purity is the point: the input
// state is never mutated, a fresh state object always comes back, and the only
// time source is the injected `now` (falling back to the server's own `at`), so
// a test can assert a hand-computed state exactly.
//
// An unrecognised top-level frame is a no-op: state comes back equal, not
// thrown. The socket is a shared, untrusted boundary and the view must not be
// the thing that falls over on it.
export function applyMessage(state, msg, opts = {}) {
  const st = cloneState(state ?? createWatchState());
  if (!isPlainObject(msg)) return st;
  const now = num(opts.now);
  const at = num(msg.at) ?? now;
  const type = typeof msg.type === 'string' ? msg.type : '';

  switch (type) {
    case 'hello': {
      st.connected = true;
      st.phase = 'idle';
      if (msg.sessionId != null) st.sessionId = String(msg.sessionId);
      if (msg.bot != null) st.bot = String(msg.bot);
      if (msg.model != null) { st.model = String(msg.model); st.declaredModel = String(msg.model); }
      if (msg.provider != null) st.provider = String(msg.provider);
      if (msg.cwd != null) st.cwd = String(msg.cwd);
      if (num(msg.pid) !== null) st.pid = num(msg.pid);
      if (msg.version != null) st.version = String(msg.version);
      if (at !== null) st.startedAt = at;
      st.lastEventAt = at;
      return st;
    }
    case 'event':
      return foldEvent(st, msg.event, at);
    case 'approval-request': {
      // Mirror the server's own rule 4: at most one hold may be live, so a new
      // request supersedes whatever is pending rather than queueing behind it.
      for (const a of st.approvals) {
        if (a.state === 'pending') {
          a.state = 'superseded';
          pushNote(st, `superseded ${a.id} (${a.tool})`, 'info');
        }
      }
      st.approvals = [...st.approvals, {
        id: String(msg.id ?? ''),
        tool: String(msg.tool ?? 'unknown'),
        args: isPlainObject(msg.args) ? msg.args : null,
        argsPreview: msg.argsPreview == null ? '' : String(msg.argsPreview),
        cwd: msg.cwd == null ? '' : String(msg.cwd),
        at,
        // Remaining time is measured against the ARRIVAL clock, never by
        // subtracting the server's clock from the watcher's.
        holdMs: num(msg.deadlineAt) !== null && at !== null ? Math.max(0, num(msg.deadlineAt) - at) : null,
        arrivedAt: at,
        state: 'pending',
        decision: null,
        decidedAt: null,
      }];
      trimApprovals(st);
      st.phase = 'waiting';
      st.lastEventAt = at;
      return st;
    }
    case 'approval-answer': {
      const id = String(msg.id ?? '');
      const decision = String(msg.decision ?? '');
      const match = st.approvals.find((a) => a.id === id);
      if (match && match.state === 'pending') {
        match.state = 'answered';
        match.decision = decision;
        match.decidedAt = at;
      }
      st.lastAnswer = { id, decision, at };
      pushNote(st, `${id || 'answer'} ${decision}`, decision === 'allow' ? 'ok' : decision === 'deny' ? 'err' : 'info');
      if (st.phase === 'waiting' && pendingApprovals(st).length === 0) st.phase = 'idle';
      st.lastEventAt = at;
      return st;
    }
    case 'pong': {
      st.pongs += 1;
      st.lastPongAt = at;
      return st;
    }
    default:
      // Garbage in, unchanged state out.
      return st;
  }
}

// Every line is assembled as [text, painter] segments so the PLAIN width is known
// before a single escape exists. A frame that overruns the terminal width wraps,
// and a wrapped dashboard eats its own redraw region on the next tick — so an
// over-long row is trimmed to width here, dropping colour first, rather than
// being trusted to be short.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

// Width is measured on the VISIBLE text: a painted segment carries escape bytes
// that occupy no columns, and counting them would make every coloured row look
// wider than the terminal is.
const visibleLen = (value) => [...String(value ?? '').replace(ANSI_RE, '')].length;

function rowOf(segments, width) {
  const painted = segments.map(([text, f]) => (f ?? String)(text));
  const shown = painted.reduce((n, piece) => n + visibleLen(piece), 0);
  // An over-long row cannot be trimmed safely once escapes are in it, so the
  // plain text is used instead: colour is the right thing to drop first.
  if (shown <= width) return painted.join('');
  return [...segments.map(([text]) => String(text ?? '')).join('')].slice(0, width).join('');
}

const fitRow = (plain, inner) => (plain.length > inner ? plain.slice(0, inner) : plain);

// A box row is a row of segments like any other, except that it is padded to
// the panel's interior width so the border columns line up whatever the escapes
// in the middle are doing. Segments are trimmed BEFORE they are painted, so a
// row longer than a narrow panel's interior is cut rather than left to overrun
// the box and wrap the frame.
function boxRow(p, inner, segments) {
  const room = Math.max(0, inner - 1);
  const plain = segments.map(([text]) => String(text ?? '')).join('');
  const body = fitRow(plain, room);
  const kept = [];
  let used = 0;
  for (const [text, f] of segments) {
    const piece = String(text ?? '').slice(0, Math.max(0, body.length - used));
    if (piece) kept.push([piece, f]);
    used += piece.length;
    if (used >= body.length) break;
  }
  const painted = kept.map(([text, f]) => (f ?? String)(text)).join('');
  return `${p.dim('│')} ${painted}${' '.repeat(Math.max(0, room - used))}${p.dim('│')}`;
}

function statusLabel(st, pending) {
  if (!st.connected) return st.phase === 'disconnected' ? 'disconnected' : 'connecting';
  if (pending.length) return 'awaiting approval';
  switch (st.phase) {
    case 'working': return st.agentsActive > 0 ? `working · ${st.agentsActive} agent${st.agentsActive === 1 ? '' : 's'}` : 'working';
    case 'error': return 'error';
    case 'done': return 'finished';
    case 'waiting': return 'waiting';
    case 'idle': return st.toolsTotal > 0 ? 'idle' : 'ready';
    default: return String(st.phase);
  }
}

function notePainter(p, tone) {
  if (tone === 'err') return p.red;
  if (tone === 'ok') return p.green;
  // 'warn' is its own tone rather than a dimmed 'err': a cancelled agent is the
  // one row an operator must be able to find by colour alone, because "did my
  // cancel land?" is asked by scanning, not by reading.
  if (tone === 'warn') return p.yellow;
  return p.dim;
}

function argRows(approval, max, width) {
  const obj = argsObject(approval.args, approval.argsPreview);
  if (!obj) {
    const preview = oneLine(approval.argsPreview, width);
    return preview ? [{ text: preview, tone: 'info' }] : [];
  }
  const rows = [];
  let hidden = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (rows.length >= max) { hidden += 1; continue; }
    const flat = typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ').trim() : oneLine(JSON.stringify(value) ?? String(value));
    // The two halves of an edit are the whole point of the card, so they get the
    // diff's own -/+ vocabulary instead of being buried as object keys.
    let text;
    let tone = 'info';
    if (key === 'old_string') { text = `- ${key}: ${JSON.stringify(flat)}`; tone = 'err'; }
    else if (key === 'new_string') { text = `+ ${key}: ${JSON.stringify(flat)}`; tone = 'ok'; }
    else text = `${key}: ${flat}`;
    rows.push({ text: truncate(text, width), tone });
  }
  if (hidden) rows.push({ text: `… ${hidden} more argument${hidden === 1 ? '' : 's'}`, tone: 'info' });
  return rows;
}

function approvalPanel(st, p, width, now) {
  const pending = pendingApprovals(st);
  const approval = pending[0];
  const inner = Math.max(28, width - 4);
  const body = Math.max(12, inner - 1);

  // Remaining hold, from the arrival clock. With no clock (a test, a log replay)
  // the panel still renders; it just does not count down.
  let tail = `${approval.id || 'approval'} · ${approval.tool}`;
  if (Number.isFinite(now) && Number.isFinite(approval.holdMs) && Number.isFinite(approval.arrivedAt)) {
    const left = approval.holdMs - (now - approval.arrivedAt);
    tail += left <= 0 ? ' · hold expired' : ` · ${formatDuration(left)} left`;
  }
  if (pending.length > 1) tail += ` · ${pending.length} pending`;

  const head = fitRow(`─ APPROVAL NEEDED  ${tail}`, inner);
  const lines = [p.dim('┌') + p.yellow(head) + p.dim(`${'─'.repeat(Math.max(0, inner - head.length))}┐`)];

  const target = toolTarget(approval.args, approval.argsPreview);
  lines.push(boxRow(p, inner, [
    [approval.tool, p.bold],
    [target ? `   ${target}` : '', p.dim],
  ]));
  for (const r of argRows(approval, PANEL_ARG_ROWS, body)) {
    lines.push(boxRow(p, inner, [[r.text, notePainter(p, r.tone)]]));
  }
  lines.push(p.dim(`├${'─'.repeat(inner)}┤`));
  lines.push(boxRow(p, inner, [
    ['[a]llow', p.green], ['   ', null], ['[d]eny', p.red], ['   ', null],
    ['[s]kip (ask again)', p.dim], ['   ', null], ['[q]uit', p.dim],
  ]));
  lines.push(p.dim(`└${'─'.repeat(inner)}┘`));
  return lines;
}

// renderFrame(state, opts) -> string
//
// Pure: state in, one frame out. opts is the entire environment:
//   color  boolean, default false (a rendered frame must never depend on the
//          ambient TTY state of whoever called it)
//   width  target column count, default 72, clamped 40..120
//   now    ms, injected; drives elapsed and the approval countdown
//   frame  integer, drives the spinner glyph
export function renderFrame(state, opts = {}) {
  const st = state ?? createWatchState();
  const p = palette(opts.color === true);
  const width = clampInt(opts.width, 72, 40, 120);
  const now = num(opts.now);
  const frameNo = Math.trunc(Number(opts.frame) || 0);
  const spin = SPIN[Math.abs(frameNo) % SPIN.length];
  const pending = pendingApprovals(st);
  const lines = [];

  // Header. The model and the path are the two elastic parts, so they give way
  // first on a narrow terminal.
  // A bot:model pair is only honest when the model that served the turn is the
  // one the bridge announced; otherwise the bot alone would imply a pairing that
  // never happened.
  const model = st.servedModel && st.declaredModel && st.servedModel !== st.declaredModel
    ? st.servedModel
    : ((st.bot && st.model) ? `${st.bot}:${st.model}` : (st.model ?? st.bot)) || 'unknown model';
  const cwd = shortPath(st.cwd);
  const head = 'ox · live session  ·  ';
  const sep = '   ·   ';
  const room = Math.max(12, width - head.length);
  const avail = Math.max(6, room - sep.length);
  let modelPart = model;
  let cwdPart = cwd;
  if (modelPart.length + cwdPart.length > avail) {
    const half = Math.max(3, Math.floor(avail / 2));
    modelPart = truncate(modelPart, half);
    cwdPart = truncate(cwdPart, avail - half);
  }
  lines.push(rowOf([
    [p.bold(p.cyan('ox')), null],
    [' · live session  ·  ', p.dim],
    [modelPart, p.cyan],
    [sep, p.dim],
    [cwdPart, p.dim],
  ], width));
  lines.push('');
  lines.push(rowOf([
    [L('session'), p.dim],
    [`${st.sessionId ?? '—'}${st.pid != null ? ` · pid ${st.pid}` : ''}${st.version != null ? ` · v${st.version}` : ''}`, p.dim],
  ], width));

  const label = statusLabel(st, pending);
  const busy = st.connected && (pending.length > 0 || st.phase === 'working');
  const glyph = busy ? spin : '·';
  const elapsed = `elapsed ${formatDuration(now != null && st.startedAt != null ? now - st.startedAt : NaN)}`;
  // Pad on PLAIN length so the right-aligned column survives the escape codes.
  const gap = Math.max(1, width - (L('status').length + glyph.length + 1 + label.length) - elapsed.length);
  lines.push(rowOf([
    [L('status'), p.dim],
    [`${glyph} ${label}`, p.dim],
    [' '.repeat(gap), null],
    [elapsed, p.dim],
  ], width));

  const live = currentTool(st);
  const target = live ? toolTarget(live.args, live.preview) : '';
  lines.push(rowOf([
    [L('tool'), p.dim],
    live ? [live.name, p.cyan] : ['—', p.dim],
    ...(live && target ? [[`  ${target}`, p.dim]] : []),
    ...(Object.keys(st.tools).length > 1 ? [[`  (+${Object.keys(st.tools).length - 1} open)`, p.dim]] : []),
  ], width));

  lines.push(rowOf([
    [L('turns'), p.dim],
    [withCommas(st.turns), p.dim],
    ['     tools ', p.dim],
    [withCommas(st.toolsTotal), p.dim],
    ['     ', null],
    [st.errors ? `errors ${withCommas(st.errors)}` : 'errors 0', st.errors ? p.red : p.dim],
  ], width));

  lines.push(rowOf([
    [L('tokens'), p.dim],
    ['in ', p.dim],
    [st.tokensUnknown && !st.tokensIn ? '?' : withCommas(st.tokensIn), p.bold],
    ...(st.auxIn > 0 ? [[` (${withCommas(st.auxIn)} aux)`, p.dim]] : []),
    ['   out ', p.dim],
    [st.tokensUnknown && !st.tokensOut ? '?' : withCommas(st.tokensOut), p.bold],
    ['   est. ', p.dim],
    [st.costKnown ? money(st.costUsd) : 'n/a', p.dim],
  ], width));
  if (st.tokensUnknown) {
    lines.push(rowOf([[`${L('')}(token counts arrive redacted: src/ipc.js masks any key matching /token/i)`, p.dim]], width));
  }

  // The agent block. Present only while agents are live, so its appearance and
  // disappearance is itself the signal -- the same rule the terminal's count
  // line follows. One row per agent, indented by depth, keyed by id so a parent
  // and its child are distinguishable and two siblings are not confusable.
  const agents = activeAgents(st);
  if (agents.length) {
    lines.push('');
    lines.push(rowOf([
      [L('agents'), p.dim],
      [st.agentsActive === 1 ? c.bold('1 active') : c.bold(`${st.agentsActive} active`), p.cyan],
      ...(st.agentsFinished ? [[`     finished ${withCommas(st.agentsFinished)}`, p.dim]] : []),
      ...(st.agentsFailed ? [[`     failed ${withCommas(st.agentsFailed)}`, p.red]] : []),
      ...(st.agentsCancelledDone ? [[`     cancelled ${withCommas(st.agentsCancelledDone)}`, p.yellow]] : []),
    ], width));
    const room2 = Math.max(8, width - LABEL_W - 2);
    for (const a of agents) {
      const indent = '  '.repeat(Math.max(0, a.depth || 0));
      const tool = a.currentTool ? ` → ${a.currentTool}` : '';
      const args = a.currentToolArgsPreview ? ` ${oneLine(a.currentToolArgsPreview, 48)}` : '';
      const elapsed = formatDuration(now != null && a.startedAt != null ? now - a.startedAt : NaN);
      // The marker distinguishes a cancelling agent from a working one. This is
      // the single most load-bearing character in the panel: the whole reason an
      // operator can tell that a press of `x` did something is that the row
      // changed before the agent went away.
      const cancelling = a.cancelRequested === true || a.phase === 'cancelling';
      const label = `${cancelling ? '◐' : '●'} ${indent}${a.id}`;
      const task = oneLine(a.task || a.description || '', Math.max(8, room2 - 26));
      lines.push(rowOf([
        [L(''), p.dim],
        [label, cancelling ? p.yellow : p.cyan],
        [`  ${task}`, p.dim],
      ], width));
      const steer = a.steerPending ? ` · ${a.steerPending} steer queued` : '';
      lines.push(rowOf([
        [L(''), p.dim],
        [c.dim(`    ${elapsed} · ${a.phase}${tool}${args}${steer}`), null],
      ], width));
      // The qualification, under a cancelling row and only there. It is the same
      // sentence the operator was given at `/agents cancel`, reproduced rather
      // than re-worded, because this is where they will actually be watching.
      if (cancelling) {
        lines.push(rowOf([
          [L(''), p.dim],
          [c.yellow(`    ${a.semantics ?? 'no further steps will start'}${a.cancelBy ? ` (requested by ${a.cancelBy})` : ''}`), null],
        ], width));
      }
    }
  }

  if (st.notes.length) {
    lines.push('');
    lines.push(rowOf([[L('recent'), p.dim]], width));
    const room2 = Math.max(8, width - LABEL_W - 1);
    for (const n of st.notes) {
      const text = truncate(n.text, room2);
      lines.push(rowOf([[L(''), p.dim], [text, notePainter(p, n.tone)]], width));
    }
  }

  lines.push('');
  if (pending.length) {
    lines.push(...approvalPanel(st, p, width, now));
  } else if (!st.connected) {
    const note = st.phase === 'disconnected' ? 'bridge closed · press q to quit' : 'waiting for a bridge … press q to quit';
    lines.push(rowOf([['  ', null], [note, p.dim]], width));
  } else {
    if (st.lastAnswer) {
      lines.push(rowOf([['  ', null], [`last answer  ${st.lastAnswer.decision} ${st.lastAnswer.id ?? ''}`, p.dim]], width));
    }
    // The cancel hint names the key and says what it does, in the idle state where
    // there is room for it. An operator should never have to read the source to
    // find out the dashboard can stop an agent.
    const cancellable = activeAgents(st).filter((a) => a.cancelRequested !== true);
    lines.push(rowOf([
      ['  ', null],
      [cancellable.length
        ? `no approvals pending · press x to cancel ${cancellable[0].id}${cancellable.length > 1 ? ` (${cancellable.length} agents)` : ''} · q to quit`
        : 'no approvals pending · q to quit', p.dim],
    ], width));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// live log fallback (non-TTY)
// ---------------------------------------------------------------------------

// Off a TTY there is no dashboard to redraw, so each notable wire frame becomes
// one line. Everything else is dropped: a log of four thousand text deltas is
// not a log.
function logLineFor(st, msg, at) {
  const stamp = `[${formatDuration(st.startedAt != null && at != null ? at - st.startedAt : NaN).padStart(7, ' ')}]`;
  const ev = isPlainObject(msg?.event) ? msg.event : null;
  switch (msg?.type) {
    case 'hello':
      return `${stamp} connected  ${st.sessionId ?? '—'}${st.bot ? ` · ${st.bot}` : ''}`;
    case 'event':
      switch (ev?.type) {
        case 'tool-start': return `${stamp} tool       ${ev.name}  ${toolTarget(null, ev.argsPreview)}`;
        case 'tool-end': return `${stamp} tool ${ev.isError ? 'err ' : 'ok  '}   ${ev.name}${num(ev.ms) != null ? ` (${ev.ms}ms)` : ''}`;
        case 'turn-end': return `${stamp} turn       #${st.turns} end (${ev.stopReason ?? 'stop'})`;
        case 'subagent-spawn': return `${stamp} agent     spawn   ${ev.id}  ${oneLine(ev.task ?? ev.description ?? '', 60)}`;
        case 'subagent-start': return `${stamp} agent     start   ${ev.id}`;
        case 'subagent-progress': {
          const tool = ev.currentTool ? ` → ${ev.currentTool}` : '';
          const args = ev.currentToolArgsPreview ? ` ${oneLine(ev.currentToolArgsPreview, 40)}` : '';
          return `${stamp} agent     ${String(ev.phase ?? '?').padEnd(9)}${ev.id}${tool}${args}`;
        }
        case 'subagent-cancel': return `${stamp} agent     CANCEL   ${ev.id}${ev.by ? ` by ${ev.by}` : ''} — ${ev.semantics ?? 'no further steps will start'}`;
        case 'subagent-cancelled': return `${stamp} agent     STOPPED  ${ev.id}${ev.by ? ` (by ${ev.by})` : ''} cancelled — no longer running${ev.cancelSemantics ? `; ${ev.cancelSemantics}` : ''}`;
        case 'subagent-end': {
          const tag = ev.status === 'cancelled' || ev.cancelled === true ? 'cancel ' : (ev.isError === true || ev.status === 'failed' ? 'failed ' : 'end    ');
          return `${stamp} agent     ${tag}     ${ev.id}  (${num(ev.elapsedMs) != null ? formatDuration(ev.elapsedMs) : '--'}, ${(ev.filesTouched ?? []).length} file(s))`;
        }
        case 'error': return `${stamp} error      ${oneLine(ev.error ?? '', 80)}`;
        case 'approval': return `${stamp} approval   ${ev.name} ${ev.decision}${ev.mode ? ` (${ev.mode})` : ''}`;
        case 'compaction': return `${stamp} compacted  ${ev.from} → ${ev.to}`;
        case 'verification': return `${stamp} verify     ${ev.complete === true ? 'passed' : 'gaps'}`;
        default: return null;
      }
    case 'approval-request':
      return `${stamp} APPROVAL  ${msg.id}  ${msg.tool}  ${toolTarget(msg.args, msg.argsPreview)}`;
    case 'approval-answer':
      return `${stamp} answer     ${msg.decision} ${msg.id ?? ''}`;
    default:
      return null;
  }
}

function paintLogLine(line) {
  if (line.includes(' APPROVAL ')) return c.yellow(line);
  if (line.includes(' error ') || line.includes(' err ')) return c.red(line);
  // Checked BEFORE the ' ok ' branch: a cancelled agent is neither.
  if (line.includes(' CANCEL ') || line.includes(' cancel ')) return c.yellow(line);
  if (line.includes(' ok ')) return c.green(line);
  return line;
}

// Redraw without scrolling: move back up over exactly the lines the last frame
// occupied, rewrite them, erase each to end-of-line, then erase the rest of the
// region below. Lines above the dashboard — the shell prompt, the scrollback —
// are never touched.
function composeFrame(frame, prevLines) {
  const lines = String(frame ?? '').split('\n');
  const body = (lines.length ? lines : ['']).map((line) => `${line}${ERASE_EOL}`).join('\n');
  return `${UP(prevLines)}\r${body}${ERASE_DOWN}`;
}

const clearRegion = (prevLines) => `${UP(prevLines)}\r${ERASE_DOWN}`;

// runWatch({ socketPath, client, fps, color, width, output, input, plain,
//            clientId, connectTimeoutMs, disconnectLingerMs })
//
// Connects to an ox bridge and watches it until the bridge closes, the human
// quits, or the process is interrupted. Rejects — rather than hanging — when
// there is no bridge to talk to, so a caller can exit non-zero instead of
// spinning.
//
// Answers go out through the client's own `answer(id, decision)`, the only path
// to the socket and the only one that validates the decision against
// APPROVAL_DECISIONS. Nothing here can put a value on the wire that the protocol
// does not already define.
export async function runWatch(opts = {}) {
  const output = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;
  const socketPath = opts.socketPath ?? socketPathFor('default');
  const color = opts.color ?? (Boolean(output.isTTY) && !process.env.NO_COLOR);
  const width = clampInt(opts.width ?? output.columns, 72, 40, 120);
  const fps = clampInt(opts.fps ?? WATCH_DEFAULT_FPS, WATCH_DEFAULT_FPS, 1, 60);
  const linger = clampInt(opts.disconnectLingerMs, 1200, 0, 60000);
  // A dashboard needs a TTY on both ends: stdout to draw into, stdin for keys.
  const live = opts.plain !== true && Boolean(output.isTTY) && Boolean(input.isTTY);

  const ownClient = !opts.client;
  const client = opts.client ?? connectIpcClient({
    socketPath,
    clientId: opts.clientId ?? `watch-${process.pid}`,
    connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  });

  // Prove there is someone home before drawing anything. connectIpcClient never
  // rejects and never hangs, so 'open' is the only success signal there is.
  try {
    await new Promise((resolve, reject) => {
      if (client.open) { resolve(); return; }
      const cleanup = () => {
        client.off('open', onOpen);
        client.off('error', fail);
        client.off('close', fail);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const fail = (err) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); };
      client.once('open', onOpen);
      client.once('error', fail);
      client.once('close', fail);
    });
  } catch (err) {
    if (ownClient) { try { client.close(); } catch { /* already gone */ } }
    throw new Error(
      `no ox ipc bridge is listening at ${socketPath} (${err?.message ?? err}) — start one with ` +
      `\`ox ipc serve --socket ${socketPath}\` or run ox with --ipc=${socketPath}`
    );
  }

  let state = createWatchState();
  let prevLines = 0;
  let frameNo = 0;
  let timer = null;
  let lingerTimer = null;
  let setRaw = false;
  let onKey = null;
  let onSigint = null;
  let finished = false;
  // The one agent this dashboard has a cancel in flight for. Held by id, not by
  // a boolean, so a refused reply can be un-marked for the row it was about and
  // for no other: without it, a refusal would clear the flag on whichever row
  // happened to be marked, including a genuinely cancelling one.
  let pendingCancelId = null;

  const write = (s) => { try { output.write(s); } catch { /* closed pipe: nothing to do */ } };
  const draw = () => {
    const frame = renderFrame(state, { color, width, now: Date.now(), frame: frameNo++ });
    write(composeFrame(frame, prevLines));
    prevLines = frame.split('\n').length;
  };

  if (live) write(HIDE_CURSOR);

  if (!live) {
    // One-off header, then one line per notable frame.
    write(`${banner({ small: true, color }).split('\n').pop()}\n`);
    write(`watching ${socketPath} · log mode (stdout is not a terminal; answering needs a TTY)\n\n`);
  }

  const onMessage = (msg) => {
    const at = Date.now();
    state = applyMessage(state, msg, { now: at });
    // The control reply. A `subagent-cancel` that came back `ok:false` -- an id
    // that is not running, or a bridge with no such control -- must be VISIBLE.
    // The optimistic fold above already marked the row, so without this the
    // dashboard would keep showing `cancelling` for an agent nothing happened to,
    // which is the one state an operator cannot recover from by looking harder.
    if (msg?.type === 'control-reply') {
      const ok = msg.ok === true;
      state = applyMessage(
        state,
        { type: 'event', event: { type: ok ? 'warning' : 'error', text: `cancel reply: ${ok ? (msg.result?.message ?? 'ok') : String(msg.error ?? 'refused')}` } },
        { now: Date.now() }
      );
      if (!ok && pendingCancelId) {
        // Undo the optimistic mark for the row this reply was about. The row is
        // still live and still counts towards `agentsActive`; only the cancelled
        // flag comes off, so the dashboard stops claiming something is unwinding
        // when nothing is. An `ok:false` here is what "already finished, nothing
        // to cancel" looks like from this side.
        for (const a of activeAgents(state)) {
          if (a.id !== pendingCancelId) continue;
          a.cancelRequested = false;
          a.phase = a.phase === 'cancelling' ? 'running' : a.phase;
        }
        pendingCancelId = null;
      }
    }
    if (!live) {
      const line = logLineFor(state, msg, at);
      if (line) write(`${paintLogLine(line)}\n`);
    }
  };
  client.on('message', onMessage);

  const answer = (decision) => {
    const target = pendingApprovals(state)[0];
    if (!target) return false;
    if (!client.answer(target.id, decision)) {
      // Nothing left to answer to. Rule 2 of the protocol does the rest: the
      // server sees silence and declines, so a lost answer is a declined edit
      // and never a silently allowed one. The reason goes into the view rather
      // than to the terminal, where the next redraw would bury it.
      state = applyMessage(state, { type: 'event', event: { type: 'error', error: `answer not sent (${decision}): the bridge is gone` } }, { now: Date.now() });
      state = applyMessage(state, { type: 'approval-answer', id: target.id, decision: 'ask' }, { now: Date.now() });
      if (live) draw();
      return false;
    }
    state = applyMessage(state, { type: 'approval-answer', id: target.id, decision }, { now: Date.now() });
    if (live) draw();
    return true;
  };

  // The cancel control. It sends a control frame on the SAME socket the events
  // arrive on, which is what makes it reach the run: `client.send` is the only
  // write path this module has, and `subagent-cancel` is answered by the bridge's
  // `onRequest` hook (src/cli.js subagentControlRequest). No new protocol, no new
  // socket, no polling of a file.
  //
  // It targets the OLDEST agent that has not already been cancelled. Not "the
  // selected one": there is no selection, and adding one for a single-key control
  // would be a navigation model invented next to a feature that does not need it.
  // Oldest-first is also the honest default, because the oldest agent is the one
  // most likely to be the runaway.
  const cancelOldest = () => {
    const target = activeAgents(state).find((a) => a.cancelRequested !== true);
    if (!target) {
      state = applyMessage(state, { type: 'event', event: { type: 'warning', text: 'nothing to cancel: no live subagent is running' } }, { now: Date.now() });
      if (live) draw();
      return false;
    }
    // `id` is the protocol's REQUEST-CORRELATION id; the subagent goes in
    // `subagentId`. Conflating them is the same mistake a client-side cancel
    // would make, and it would silently target nothing.
    const sent = client.send({ type: CANCEL_FRAME_TYPE, id: `watch-cancel-${Date.now().toString(36)}`, subagentId: target.id });
    pendingCancelId = sent ? target.id : null;
    if (!sent) {
      state = applyMessage(state, { type: 'event', event: { type: 'error', error: `cancel not sent for ${target.id}: the bridge is gone` } }, { now: Date.now() });
    } else {
      // Optimistic local fold so the keypress is not ignored between the press
      // and the round trip. The authoritative `subagent-cancel` event arrives
      // moments later and folds the same row; `foldSubagentEnd` is what finally
      // decrements `agentsActive`, so the optimistic copy cannot leave the row
      // counted twice.
      state = applyMessage(state, { type: 'event', event: { type: 'subagent-cancel', id: target.id, requested: true, by: 'dashboard' } }, { now: Date.now() });
    }
    if (live) draw();
    return sent;
  };

  return await new Promise((resolve) => {
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
      if (onKey && input.removeListener) input.removeListener('data', onKey);
      if (onSigint) process.removeListener('SIGINT', onSigint);
      if (setRaw) {
        try { input.setRawMode?.(false); } catch { /* not a tty after all */ }
        try { input.pause?.(); } catch { /* already paused */ }
      }
      client.off('message', onMessage);
      try { client.close(); } catch { /* already gone */ }
      if (live) {
        write(clearRegion(prevLines));
        write(SHOW_CURSOR);
      }
    };

    const finish = (reason) => {
      cleanup();
      resolve({ reason, state, answered: state.lastAnswer?.decision ?? null, frames: frameNo });
    };

    client.once('close', () => {
      state = { ...state, phase: 'disconnected', connected: false };
      if (live) {
        draw();
        // Linger so the final state is readable before the region is erased.
        lingerTimer = setTimeout(() => finish('bridge-closed'), linger);
      } else {
        write('bridge closed\n');
        finish('bridge-closed');
      }
    });

    onSigint = () => finish('sigint');
    process.on('SIGINT', onSigint);

    if (live) {
      try { input.setRawMode?.(true); setRaw = true; } catch { setRaw = false; }
      try { input.resume?.(); } catch { /* no stdin to read */ }
      onKey = (chunk) => {
        for (const ch of String(chunk ?? '')) {
          if (ch === CTRL_C || ch === ESC || ch === '\r' || ch === '\n') { finish('interrupt'); return; }
          const lower = ch.toLowerCase();
          if (lower === 'q') { finish('quit'); return; }
          // Checked BEFORE the approval map, because 'x' must never be able to
          // reach an approval decision: `KEY_DECISION` is the protocol's allowlist
          // and this key is deliberately not in it.
          if (lower === CANCEL_KEY) { cancelOldest(); continue; }
          const decision = KEY_DECISION[lower];
          if (decision) answer(decision);
        }
      };
      if (input.on) input.on('data', onKey);
      timer = setInterval(draw, Math.max(20, Math.round(1000 / fps)));
      draw();
    }
  });
}
