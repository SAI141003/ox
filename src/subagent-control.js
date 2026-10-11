// SUBAGENT CANCEL AND STEER.
//
// The capability the comparison matrix graded as the single largest gap: a
// scheduler could RETIRE an agent (`finishSubagent` is the only exit and it is
// idempotent) but it could never REDIRECT one. `grep -rn
// "cancelSubagent|stopSubagent|killSubagent" src/ test/` returned nothing, so
// there was no answer to "stop that one" and no answer at all to "send it a new
// instruction".
//
// Two decisions carry this whole file, and both are about honesty rather than
// mechanics. Adapted from CopilotKit's OpenMuse (MIT), whose rule is worth
// keeping in its exact sense:
//
//   "Pausing/cancelling prevents subsequent task steps; an already approved
//    in-flight provider request may finish."
//
// 1. CANCEL = ABORT THIS AGENT'S OWN SIGNAL, AND SAY SO PRECISELY.
//
//    `ctx.signal` today is the RUN's signal: one AbortController shared by every
//    agent in a fan-out (src/agent.js builds `toolCtx = { ...ctx, signal }` once
//    and src/subagent.js hands `ctx.signal` straight to `runAgent`). Aborting it
//    would kill all N agents of a batch, which is the opposite of what an
//    operator asking to stop ONE agent means. So each subagent gets its OWN
//    AbortController, parent-linked: a run-wide abort still cancels every child
//    (the behaviour that existed before), and a per-agent cancel touches exactly
//    one.
//
//    What aborting actually stops is bounded by where ox checks the signal:
//
//      src/agent.js  streamVia(activeTarget, { ..., signal })  -> the provider
//          request itself aborts mid-stream if it is still open.
//      src/agent.js  top of `outer: while` -> the next turn never starts.
//      src/agent.js  `if (signal?.aborted)` before dispatchTool -> a tool call
//          that has not STARTED never starts.
//      src/tools/exec.js  ctx.signal -> killGroup(child, 'SIGTERM'): an
//          in-flight `bash` child process is killed.
//
//    What aborting does NOT stop, and which this module refuses to claim:
//
//      * a tool call ALREADY RUNNING that ox cannot interrupt -- a `write_file`
//        that has already truncated the file it is rewriting, an MCP call
//        already dispatched, a `web_fetch` whose transport ignores the signal.
//        The write lands. That is the failure mode this file exists to avoid
//        reporting around.
//      * a provider request the transport had already handed off: undici cannot
//        un-send bytes, so a response may still arrive and be discarded.
//
//    Hence `CANCEL_SEMANTICS` below, which every cancel report is required to
//    carry verbatim, and `cancelSubagent`'s refusal to answer with anything that
//    reads like "guaranteed halt".
//
// 2. STEER = A MAILBOX NOTE DRAINED AT THE NEXT TURN BOUNDARY, NOT AN INTERRUPT.
//
//    Chosen over AbortSignal-based interrupt-and-restart because of what a
//    half-written file is: an agent mid-`edit_file` has a half-written file on
//    disk and no way to know it. Aborting there to deliver a new instruction
//    converts a steer into data loss. A drained note cannot do that -- the loop
//    finishes the tool call it is in, appends the note to its own context, and
//    only then issues another provider request.
//
//    Precisely when it takes effect: at the top of the subagent's next iteration
//    of `outer: while` in src/agent.js -- that is, AFTER the in-flight tool call
//    has returned and BEFORE the next provider request is dispatched. A steer
//    issued mid-tool-call is therefore never seen mid-tool-call, and a steer
//    issued while the agent is waiting on the provider is picked up one turn
//    later. It never interrupts; it queues.
//
//    Transport is the EXISTING mailbox (src/agent-teams.js), not a second
//    channel: same teams.json, same `screenPersistText` write screen, same
//    at-most-once durable cursor, same persistence and replay. A steering note
//    that survives a crash survives as ordinary mail, because it is ordinary
//    mail with a flag on it.
//
//    The consequence worth stating plainly, because it contradicts a comment
//    that is now stale: because ox drains the mailbox ITSELF at the turn
//    boundary, a steering note steers an agent that never thinks to call
//    `agent_observe`. src/resource-class.js:29-30 says "A note left in a mailbox
//    steers nobody" -- that was true while delivery was the model's decision and
//    is now false. It needs correcting (reported, not edited here). What remains
//    true is the next clause: `agent_observe` is still how a steer reaches a
//    lead that is not a subagent loop.
//
// Nothing here imports src/subagent.js or src/subagent-registry.js. That is
// deliberate: both of those import THIS module, so a reverse import would be a
// cycle. What the registry needs to learn about a cancel arrives through
// `subscribeSubagentCancel` (wired at the bottom of src/subagent-registry.js),
// which keeps the dependency pointing one way.

import { setMaxListeners } from 'node:events';

import { createAgentTeams, mailboxTeamId, sanitizeMailboxId } from './agent-teams.js';

// ---- the vocabulary ---------------------------------------------------------

// A third terminal state, not a flavour of the other two. `done` means the task
// was completed; `failed` means it broke. A cancelled agent did neither: an
// operator stopped it. Reporting a cancel as `failed` puts it in the self-heal
// failure counter (src/agent.js failureKey -> 3 -> budget exhausted) and reports
// a deliberate human decision as a model error, which is how a cancel turns
// into the parent deciding it has had enough of subagents.
export const SUBAGENT_STATUS_CANCELLED = 'cancelled';

// The sentence every cancel report must carry, verbatim. It is exported rather
// than inlined at each of the four report sites (tool result, CLI, IPC reply,
// control report) precisely so the four cannot drift into four different claims
// about the same event -- and so a test can assert the wording exists, which is
// what makes a future "cancel guarantees halt" edit fail loudly.
export const CANCEL_SEMANTICS =
  'cancelled prevents subsequent steps; an in-flight provider request that was already dispatched may still complete';

export const CANCEL_TOOL_NOTE =
  'a tool call that had already started was allowed to finish (a file it had already begun writing may still land)';

// ---- per-agent control ------------------------------------------------------

// id -> record. Same in-process doctrine as src/subagent-registry.js: an id is
// controllable if and only if THIS process holds a record for it. A separate
// `ox agents cancel` in another process reaches these records over the IPC
// bridge's control frames, never by reading a file -- there is no shared memory
// to read, and a file would be a guess.
const controls = new Map();

const cancelObservers = new Set();

function nowMs() {
  return Date.now();
}

// The SAME `sanitizeSubagentId` shape the subagent directory uses
// (src/subagent.js), because a control id arrives from a CLI argument and from
// an IPC frame. Declared here rather than imported so this module keeps its
// no-reverse-dependency property.
const CONTROL_ID_RE = /^[\w-]{4,128}$/;

function controlId(id) {
  const s = String(id ?? '').trim();
  return CONTROL_ID_RE.test(s) ? s : null;
}

// Idempotent by design. The tool handler registers a control BEFORE the run
// starts (so an agent that is spawned but not yet started is still cancellable,
// which is the window an operator is most likely to act in), and runSubagent
// asks for the same one. Two callers, one record, no window in between where a
// cancel would find nothing.
export function ensureSubagentControl({
  id,
  cwd = null,
  team = null,
  agent = null,
  parentSignal = null,
  emit = null,
} = {}) {
  const key = controlId(id);
  if (!key) return null;
  const existing = controls.get(key);
  if (existing) {
    // Late enrichment, not replacement: a context the handler did not know yet
    // (the mailbox team, resolved from ctx) must be able to attach without
    // throwing away a controller that is already linked and already abortable.
    if (!existing.cwd && cwd) existing.cwd = cwd;
    if (!existing.team && team) existing.team = team;
    if (!existing.agent && agent) existing.agent = agent;
    if (!existing.emit && emit) existing.emit = emit;
    if (!existing.linked && parentSignal && typeof parentSignal === 'object' && 'aborted' in parentSignal) {
      linkParent(existing, parentSignal);
    }
    return existing;
  }
  const controller = new AbortController();
  const rec = {
    id: key,
    controller,
    signal: controller.signal,
    linked: false,
    detachParent: null,
    cwd: cwd ? String(cwd) : null,
    team: team ? String(team) : null,
    agent: agent ? String(agent) : null,
    emit: typeof emit === 'function' ? emit : null,
    cancelRequested: false,
    cancelRequestedAt: null,
    cancelReason: null,
    cancelBy: null,
    steerInboxInstalled: false,
    steerPending: 0,
    createdAt: nowMs(),
  };
  if (parentSignal && typeof parentSignal === 'object' && 'aborted' in parentSignal) linkParent(rec, parentSignal);
  controls.set(key, rec);
  return rec;
}

// The run-wide abort still reaches every child. This is the one behaviour that
// must not change: a Ctrl-C on `ox` has always stopped the subagents, and a
// per-agent control layer that quietly broke it would be a regression wearing a
// feature.
//
// Two leak-shaped details, both load-bearing rather than tidiness:
//
//   * `setMaxListeners(0, parentSignal)` -- every subagent of a fan-out adds a
//     listener to the SAME run signal. The default cap is 10, so a run with
//     more than a few batches would print MaxListenersExceededWarning and, worse,
//     start dropping abort delivery as if the listeners were noise.
//   * `detachParent` -- the listener's closure holds this record, so without an
//     explicit removal a finished run's controls would stay reachable from the
//     long-lived run signal for the life of the process.
function linkParent(rec, parentSignal) {
  rec.linked = true;
  const onAbort = () => {
    // `controller.abort` is idempotent, and a child whose own cancel already
    // fired simply keeps its own reason.
    if (!rec.cancelRequested) rec.cancelReason = 'parent run aborted';
    try { rec.controller.abort(new Error('subagent run aborted')); } catch { /* already aborted */ }
  };
  try { setMaxListeners(0, parentSignal); } catch { /* older runtime */ }
  try { parentSignal.addEventListener('abort', onAbort, { once: true }); } catch { /* not an EventTarget */ }
  rec.detachParent = () => {
    try { parentSignal.removeEventListener('abort', onAbort); } catch { /* already gone */ }
  };
  // A parent signal that aborted BEFORE this control existed is the same
  // situation, one instant later.
  if (parentSignal.aborted) onAbort();
}

export function getSubagentControl(id) {
  const key = controlId(id);
  return key ? (controls.get(key) ?? null) : null;
}

export function isSubagentCancelled(id) {
  const rec = getSubagentControl(id);
  return Boolean(rec && rec.cancelRequested);
}

// Detaches the parent listener and forgets the record. Called from runSubagent's
// `finally`, so it happens on every exit: clean, failed, or cancelled. The
// consequence is that `cancelSubagent` on a FINISHED id finds no control, which
// is what makes cancelling an already-finished agent a clean no-op rather than a
// write to a dead record.
export function releaseSubagentControl(id) {
  const key = controlId(id);
  if (!key) return null;
  const rec = controls.get(key) ?? null;
  if (!rec) return null;
  try { rec.detachParent?.(); } catch { /* already detached */ }
  rec.detachParent = null;
  rec.emit = null;
  rec.steerInboxInstalled = false;
  controls.delete(key);
  return rec;
}

export function listSubagentControls() {
  return [...controls.values()].map((r) => ({
    id: r.id,
    cancelRequested: r.cancelRequested,
    cancelRequestedAt: r.cancelRequestedAt,
    cancelReason: r.cancelReason,
    cancelBy: r.cancelBy,
    steerPending: r.steerPending,
    aborted: r.signal?.aborted === true,
    cwd: r.cwd,
  }));
}

// The registry's hook. See the module header: the dependency points ONE way
// (registry -> control), and every cancel from any surface reaches the registry
// through this rather than through three call sites that each have to remember.
export function subscribeSubagentCancel(fn) {
  if (typeof fn !== 'function') return () => {};
  cancelObservers.add(fn);
  return () => cancelObservers.delete(fn);
}

function notifyCancel(info) {
  for (const fn of cancelObservers) {
    try { fn(info); } catch { /* a broken observer must not stop the cancel */ }
  }
}

// ---- cancel -----------------------------------------------------------------

// A clean no-op is `{ ok: true, cancelled: false }`, never a throw and never
// `ok: false`. Two different "nothing happened" cases collapse into one answer
// because from the caller's side they ARE one thing -- this process is not
// running an agent with that id -- and distinguishing them would mean claiming
// to know something about the run we cannot see.
export const CANCEL_NOT_RUNNING = 'not-running';

export function cancelSubagent(id, { reason = null, by = 'operator' } = {}) {
  const key = controlId(id);
  if (!key) {
    return {
      ok: true,
      id: String(id ?? ''),
      cancelled: false,
      reason: CANCEL_NOT_RUNNING,
      message: `${String(id ?? '')} is not a valid subagent id, so nothing was cancelled.`,
    };
  }
  const rec = controls.get(key) ?? null;
  if (!rec) {
    return {
      ok: true,
      id: key,
      cancelled: false,
      reason: CANCEL_NOT_RUNNING,
      message:
        `${key} is not running in this process, so nothing was cancelled ` +
        '(it already finished, or it belongs to another process).',
    };
  }
  if (!rec.cancelRequested) {
    rec.cancelRequested = true;
    rec.cancelRequestedAt = nowMs();
    rec.cancelBy = sanitizeMailboxId(by) ?? 'operator';
    rec.cancelReason = reason ? String(reason).slice(0, 300) : null;
    // The abort IS the cancel. Everything downstream (the loop's turn
    // boundary, the pre-dispatch tool check, the provider stream, the bash
    // child's process group) reads this one signal, so there is exactly one
    // place the cancel becomes real.
    try { rec.controller.abort(new Error(rec.cancelReason || `subagent ${key} cancelled`)); } catch { /* already aborted */ }

    noteSubagentCancelled();
    notifyCancel({ id: key, at: rec.cancelRequestedAt, by: rec.cancelBy, reason: rec.cancelReason });

    // The lifecycle event goes out at REQUEST time, not at end time. An
    // operator who pressed cancel needs to see the state change now; waiting
    // for the agent to unwind would leave the dashboard showing a working agent
    // for exactly as long as the slowest tool call takes, which is the window
    // in which an operator would press cancel a second time.
    //
    // Both channels, like spawn/start/end: the parent's own stream AND the
    // immediate IPC broadcast. The event carries NO claim that the agent has
    // stopped -- `requested: true`, plus the same may-still-complete sentence,
    // because at this instant it very much may still be running.
    if (rec.emit) {
      try {
        rec.emit({
          type: 'subagent-cancel',
          id: key,
          requested: true,
          by: rec.cancelBy,
          reason: rec.cancelReason,
          semantics: CANCEL_SEMANTICS,
          ...(rec.steerPending ? { steerPending: rec.steerPending } : {}),
        });
      } catch { /* a dead socket must never break a cancel */ }
    }
  }
  return {
    ok: true,
    id: key,
    cancelled: true,
    alreadyRequested: rec.cancelRequestedAt < nowMs(),
    reason: rec.cancelReason,
    by: rec.cancelBy,
    semantics: CANCEL_SEMANTICS,
    toolNote: CANCEL_TOOL_NOTE,
    message: cancelMessage({ id: key, by: rec.cancelBy, reason: rec.cancelReason }),
  };
}

// The report line. Two sentences, and the order matters: what the operator gets
// (no further steps) BEFORE what they must not assume (an in-flight request may
// still land). The reverse order reads as a disclaimer bolted onto a promise.
export function cancelMessage({ id, by = 'operator', reason = null } = {}) {
  const because = reason ? ` (${String(reason).slice(0, 200)})` : '';
  return (
    `cancel requested for ${id} by ${by}${because}. ${CANCEL_SEMANTICS}. ${CANCEL_TOOL_NOTE}. ` +
    `Its registry status becomes '${SUBAGENT_STATUS_CANCELLED}', not done and not failed, and it appears that way on /agents, the dashboard, and to IPC clients.`
  );
}

// What the agent's OWN tool result says to its parent. Deliberately different
// from the operator's report: the parent did not ask for this and cannot undo
// it, so it needs the state plus the consequence for the work in flight.
export function cancelledSubagentResult({ id, elapsedMs = null, filesTouched = 0, innerTools = null } = {}) {
  const toolBits = [];
  if (innerTools && typeof innerTools === 'object') {
    const n = Object.values(innerTools).reduce((a, b) => a + (Number(b) || 0), 0);
    if (n) toolBits.push(`${n} tool call(s) already ran`);
  }
  if (Number(filesTouched) > 0) toolBits.push(`${filesTouched} file(s) already touched`);
  const kept = toolBits.length ? ` Work already done is kept and reported: ${toolBits.join(', ')}.` : '';
  // CANCEL_TOOL_NOTE rides here too, but ONLY when tool calls actually ran --
  // which is precisely the case where it matters and precisely the case where
  // its absence was a lie. A count of "3 tool call(s) already ran" tells the
  // parent that work happened; it does NOT tell the parent that a `write_file`
  // already past its truncate may STILL BE LANDING after this message is read.
  // A parent that believed the run was over would move on, and the file would
  // change underneath it. With no tool calls there is nothing in flight to
  // qualify, so the note is omitted rather than padding the line with a
  // hypothetical.
  const toolNote = toolBits.length ? ` ${CANCEL_TOOL_NOTE}.` : '';
  const took = Number.isFinite(Number(elapsedMs)) ? ` after ${Math.max(0, Math.round(Number(elapsedMs)))}ms` : '';
  return (
    `Subagent ${id} was CANCELLED${took} — it did not finish its task and it did not fail. ` +
    `${CANCEL_SEMANTICS}.${kept}${toolNote}`
  );
}

// ---- steering ---------------------------------------------------------------

// The flag on a message. `true` means "an operator redirected this agent"; the
// body is screened and persisted exactly like any other mail, and it is
// delivered exactly once, by whichever reader gets there first.
export const STEER_KIND = 'steer';

export const STEER_EFFECT_NOTE =
  "A steering note takes effect at the target's next turn boundary: after the tool call it is in finishes, before its next provider request. It never interrupts.";

// The sender for a note that did not come from an agent. `sanitizeMailboxId`
// admits it, so it lands in the same addressing space as a real agent id and the
// recipient's roster shows who redirected it.
export const STEER_SENDER = 'operator';

export function steerSubagent(id, note, { by = STEER_SENDER, reason = null } = {}) {
  const key = controlId(id);
  const text = String(note ?? '').trim();
  if (!key || !text) {
    return { ok: false, reason: !key ? 'steer: that is not a valid subagent id.' : 'steer: the note text is required.' };
  }
  const rec = controls.get(key);
  const cwd = rec?.cwd ?? process.cwd();
  const team = rec?.team ?? null;
  if (!team) {
    // Refused, not silently dropped: without a mailbox team there is nowhere
    // durable to put the note, and pretending it was delivered is the one
    // outcome worse than saying no.
    return {
      ok: false,
      reason:
        `steer: ${key} has no mailbox team in this process (it is running without agent-to-agent messaging), ` +
        'so there is nowhere durable to put the note. No guidance was delivered.',
    };
  }
  const teams = createAgentTeams(cwd);
  const res = teams.sendMail({
    team,
    from: sanitizeMailboxId(by) ?? STEER_SENDER,
    to: key,
    message: text,
    steer: true,
  });
  if (!res.ok) return { ok: false, reason: `steer: ${res.reason}` };
  // The mailbox write is the delivery. The counter is only so the operator can
  // be told how many notes are queued -- the drain reads the mailbox, so it
  // cannot miss a note that this counter forgot to record.
  if (rec) rec.steerPending += 1;
  return {
    ok: true,
    id: key,
    seq: res.message?.seq ?? null,
    steerPending: rec?.steerPending ?? 1,
    takesEffect: STEER_EFFECT_NOTE,
    message: `Steering note delivered to ${key}'s mailbox (seq ${res.message?.seq ?? '?'}). ${STEER_EFFECT_NOTE}`,
  };
}

// Records that the subagent loop installed its turn-boundary drain for this id.
// The loop calls `drainSteeringFor(id)` directly at the boundary (see
// src/agent.js `_steerInbox`); this flag is what lets a surface tell "a steer is
// queued for an agent that will read it" from "a steer is queued for an agent
// with no drain, so only an explicit agent_observe would ever see it".
export function markSteerInboxInstalled(id, installed = true) {
  const rec = getSubagentControl(id);
  if (!rec) return null;
  rec.steerInboxInstalled = Boolean(installed);
  return rec;
}

export function hasSteerInbox(id) {
  return Boolean(getSubagentControl(id)?.steerInboxInstalled);
}

// The drain. Reads the mailbox through the SAME `readMailbox` the agent's own
// `agent_observe` uses, which is what makes steering delivery and mail delivery
// one mechanism instead of two that can disagree: same durable cursor, same
// at-most-once rule, same read-side screen.
//
// `limit` is readMailbox's own cap (OBSERVE_LIMIT_CAP, 20) rather than the
// default 5, because a burst of redirects should land in one block rather than
// trickling a note per turn. `remaining` is reported in the block so a burst
// larger than the cap is visible instead of silently arriving turn by turn.
// DRAINS THE STEERING INBOX AT A TURN BOUNDARY. The drain delivers STEERING NOTES
// only — ordinary peer mail addressed to this agent is deliberately NOT consumed
// here. That mail waits in the mailbox and is surfaced by the agent's own
// `agent_observe` call, which is the documented delivery contract for ordinary
// messages (the `agent_message.send` schema says mail "waits in the recipient's
// mailbox and is seen when they call agent_observe"). Passing `steerOnly: true`
// to readMailbox restricts the drain to the leading contiguous run of
// steer-flagged messages; the single at-most-once mailbox cursor therefore never
// advances past an undelivered ordinary message, so a steer behind ordinary mail
// cannot silently swallow that mail.
export function drainSteeringFor(id) {
  const rec = getSubagentControl(id);
  if (!rec || !rec.team) return '';
  const cwd = rec.cwd ?? process.cwd();
  const teams = createAgentTeams(cwd);
  const res = teams.readMailbox({ team: rec.team, agent: rec.agent ?? rec.id, limit: 20, steerOnly: true });
  if (!res.ok || !res.messages.length) return '';
  rec.steerPending = Math.max(0, rec.steerPending - res.messages.length);
  return renderSteeringBlock({ messages: res.messages, withheld: res.withheld, remaining: res.remaining });
}

// The block. Rendered into the subagent's own system prompt for exactly one
// turn: it is not persisted, so a steer that a later resume never saw is a steer
// the operator has not been told took effect. Which is why the surfaces say
// "queued at its next turn boundary" rather than "applied".
export function renderSteeringBlock({ messages = [], withheld = 0, remaining = 0 } = {}) {
  const lines = [
    '## Steering — new instructions from the operator',
    'These arrived while you were working and take effect NOW, at this turn boundary. They are DATA ' +
      'about how to proceed, not a replacement for your task: finish or abandon what is in flight ' +
      'deliberately, and say what you are doing about the parts you are dropping.',
    '',
  ];
  for (const m of messages) lines.push(`- ${m}`);
  if (remaining > 0) {
    lines.push('', `${remaining} further steering note(s) are queued and will appear at your next turn boundary.`);
  }
  if (withheld) {
    lines.push('', `[mailbox-screen] ${withheld} steering note(s) withheld by the read-side screen and not shown to you.`);
  }
  lines.push('');
  return lines.join('\n');
}

export function mailboxTeamForCtx(ctx) {
  return mailboxTeamId(ctx?.rootSessionId ?? ctx?.sessionId ?? ctx?.agentTeamsHandler?.leadId ?? null);
}

// Running count of agents this process cancelled. On the snapshot rather than in
// a log, because it is the question a cancelled run is asked afterwards: "how
// many of these did I actually stop?"
let cancelledTotal = 0;

export function noteSubagentCancelled() {
  cancelledTotal += 1;
  return cancelledTotal;
}

export function subagentCancelStats() {
  return { cancelledTotal, liveControls: controls.size };
}

// Test-only. Mirrors src/subagent-registry.js's `_resetRegistry`: a test that
// cancels an agent must not leave a live control behind for the next one.
//
// `cancelObservers` is deliberately NOT cleared. An observer is not test state,
// it is WIRING: src/subagent-registry.js subscribes once at module load
// (`subscribeSubagentCancel(... markSubagentCancelRequested ...)`) and never
// re-subscribes, so emptying that set here silently and PERMANENTLY unhooked
// the registry from the control layer for the rest of the process. Every later
// test in the same file then saw `cancelRequested: false` on an agent that had
// been cancelled correctly -- a registry that looked broken because a test
// helper had unplugged it, and one that would have failed for a reason that had
// nothing to do with the code under test.
//
// Nothing needs the set emptied (an observer holds no per-run state, and a test
// that wants to observe cancels re-subscribes and keeps the handle). So the
// reset resets CONTROLS, and leaves the wiring alone.
export function _resetSubagentControls() {
  for (const rec of controls.values()) {
    try { rec.detachParent?.(); } catch { /* already detached */ }
  }
  controls.clear();
  cancelledTotal = 0;
}
