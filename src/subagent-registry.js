// The LIVE subagent registry.
//
// A descriptor on disk says a subagent WAS running. It does not say one is
// running NOW: the process that wrote it may have been killed mid-run, and
// `status: 'running'` is exactly what a crash, a SIGKILL, or a closed laptop
// leaves behind. This module is the only authority that can tell the two apart,
// and it is deliberately IN-PROCESS: an id is live if and only if THIS process
// holds a record for it. Nothing is inferred from timestamps, because a
// descriptor written thirty seconds ago by a process that is still streaming
// looks identical to one written thirty seconds ago by a process that is gone,
// and guessing "probably still running" is how a dashboard ends up lying to an
// operator about work that stopped.
//
// Three surfaces read this and nothing else, so they cannot disagree:
//   src/cli.js         /agents        (the REPL agent tree)
//   src/ipc-watch.js   the live dashboard's per-agent rows
//   any IPC client     agentSnapshot()
//
// Scope: this is VISIBILITY plus the accounting a concurrent scheduler needs.
// The SCHEDULER lives in src/agent.js (runSubagentBatch) and the CONFIGURED CAP
// in src/resource-class.js (resolveSubagentConcurrency) -- deliberately not
// here, because this file's job is to report the truth, not to decide what is
// allowed. What it does own now: the per-agent sequence number that makes
// interleaved events checkable, the batch bookkeeping (cap, admitted, deferred,
// peak) that makes a fan-out legible, and the per-agent cost ceiling, which is
// the first per-agent SPEND number this module has ever carried.

import { listSubagents } from './subagent.js';
// The dependency points ONE way on purpose. src/subagent.js imports this file,
// and this file must not import that one back; a cancel therefore reports itself
// here through `subscribeSubagentCancel` instead of the control module reaching
// into the live map. See the comment at the bottom of this file for why it
// matters that EVERY cancel goes through the hook rather than through each
// call site remembering to call us.
import {
  SUBAGENT_STATUS_CANCELLED, subscribeSubagentCancel, noteSubagentCancelled,
  subagentCancelStats,
} from './subagent-control.js';

// Re-exported so a consumer that already imports the registry (the REPL, the
// dashboard, the IPC handler) has one module to reach for, and so the STATUS
// WORD itself is declared once.
export { SUBAGENT_STATUS_CANCELLED };

// The three terminal states, named once so no surface invents a fourth
// spelling. `cancelled` is a peer of `done` and `failed`, not a sub-case of
// either: an operator stopping an agent is not the agent failing, and folding
// the two together is how a deliberate human decision ends up counted in the
// self-heal failure budget.
export const SUBAGENT_TERMINAL_STATUSES = Object.freeze(['done', 'failed', SUBAGENT_STATUS_CANCELLED]);

// ---- bounds -----------------------------------------------------------------
//
// Every limit here is a statement about the same thing: a long-running or
// pathological subagent must not be able to grow the operator's process or
// flood the event stream. `live` is a Map, so it cannot be fed unbounded ids;
// the progress cap and the tool ledger are what stop one chatty agent from
// turning into thousands of rows or frames.

export const MAX_PROGRESS_EVENTS = 40;
export const MAX_TRACKED_TOOLS = 12;
export const MAX_ARG_PREVIEW = 120;
export const MAX_SUMMARY = 2000;

// Non-enumerable so it survives being queued but never reaches the wire or a
// `--json` line: `{...ev}` and JSON.stringify() both copy only own ENUMERABLE
// properties, and a symbol key is skipped by the first even if enumerable.
export const LIVE_BROADCAST = Symbol.for('ox.subagent.liveBroadcast');

export function markLiveBroadcast(ev) {
  try {
    Object.defineProperty(ev, LIVE_BROADCAST, { value: true, enumerable: false, configurable: true });
  } catch {
    /* a frozen event is still a usable event; only the dedupe is lost */
  }
  return ev;
}

export function alreadyLiveBroadcast(ev) {
  return Boolean(ev && ev[LIVE_BROADCAST]);
}

// ---- the live map -----------------------------------------------------------

// id -> record. Keyed by subagent id, not by an index, so a stale entry from a
// crashed run can never be "taken over" by an unrelated spawn that happens to
// reuse the number.
const live = new Map();

// Per-agent event counters, deliberately NOT stored on the live record.
//
// `subagent-end` is emitted AFTER finishSubagent() has already removed the
// record -- that ordering is load-bearing (a failure to broadcast must not
// strand an agent on screen as working) -- so a counter living on the record
// would leave the final event of every run unsequenced, which is exactly the
// event whose position a consumer most needs to check. Counters here are
// monotonic per agent id and survive the run; a resumed agent continues its own
// sequence rather than restarting it, so a gap between two runs is visible as a
// gap instead of being papered over by a reset.
const seqCounters = new Map();

function nowMs() {
  return Date.now();
}

function clip(value, max) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Called the moment a subagent is created, BEFORE its loop starts. Registering
// at spawn rather than at start is deliberate: a subagent that dies between the
// two is a real run that went nowhere, and an operator watching the tree should
// see it appear and then see it end, not see it never exist.
export function registerSubagent({
  id,
  task = '',
  description = '',
  depth = 0,
  parentId = null,
  cwd = null,
  resumed = false,
  // Batch provenance. With a concurrent fan-out two agents share a spawn
  // instant, a task list and a cost division, and "which of these is mine"
  // stops being answerable from the id alone. `batchId` groups the turn,
  // `batchIndex`/`batchSize` say where in it this agent sits, and
  // `deferredMs` is the wait this agent actually paid at the concurrency cap
  // -- the difference between "slow" and "queued", which an operator watching
  // N identical progress lines cannot otherwise see.
  batchId = null,
  batchIndex = null,
  batchSize = null,
  costCeilingUsd = null,
} = {}) {
  const at = nowMs();
  const record = {
    id: String(id ?? ''),
    task: String(task ?? ''),
    description: String(description ?? task ?? ''),
    depth: Number(depth) || 0,
    parentId: parentId == null ? null : String(parentId),
    cwd: cwd ? String(cwd) : null,
    resumed: Boolean(resumed),
    // The phase names are the vocabulary of the `subagent-progress` event, so a
    // consumer reading the event and a consumer reading this map see the same
    // word for the same state.
    phase: 'spawned',
    status: 'running',
    currentTool: null,
    currentToolArgsPreview: '',
    iterations: 0,
    progressEvents: 0,
    progressSuppressed: 0,
    toolCounts: {},
    toolNamesDropped: 0,
    textChars: 0,
    filesTouched: 0,
    lessonsCount: 0,
    batchId: batchId == null ? null : String(batchId),
    batchIndex: Number.isFinite(Number(batchIndex)) ? Number(batchIndex) : null,
    batchSize: Number.isFinite(Number(batchSize)) ? Number(batchSize) : null,
    deferredMs: 0,
    costCeilingUsd: Number.isFinite(Number(costCeilingUsd)) ? Number(costCeilingUsd) : null,
    costUsd: 0,
    // CANCEL BOOKKEEPING. `phase: 'cancelling'` is the interval between "the
    // operator asked" and "the agent stopped working", and it is a real state
    // rather than a cosmetic one: an agent mid-`bash` can take a while to come
    // back, and a dashboard that showed it as plain `running` for that window
    // would be telling the operator their cancel had done nothing. The rest is
    // who asked and when, which is what makes a cancel auditable after the fact.
    cancelRequested: false,
    cancelRequestedAt: null,
    cancelBy: null,
    cancelReason: null,
    // Per-agent event sequence. Under serial dispatch the wire order WAS the
    // order; under concurrency two agents' progress interleave in completion
    // order, so a consumer needs a number per agent to detect a gap or a
    // reordering instead of assuming one.
    seq: 0,
    pid: process.pid,
    spawnedAt: at,
    startedAt: null,
    lastAt: at,
    endedAt: null,
  };
  live.set(record.id, record);
  // The peak is recorded HERE, at the instant an agent becomes live, and read
  // off `live.size` -- the same number /agents, the dashboard and
  // agentSnapshot report. Recorded anywhere else (before dispatch, after the
  // run) it would either miss the first agent or claim a concurrency no surface
  // ever saw.
  if (live.size > batchStats.peakConcurrent) batchStats.peakConcurrent = live.size;
  return record;
}

export function markSubagentStarted(id) {
  const rec = live.get(String(id));
  if (!rec) return null;
  rec.phase = 'running';
  rec.startedAt = rec.startedAt ?? nowMs();
  rec.lastAt = rec.startedAt;
  return rec;
}

// patch is applied shallowly, but only for the operator-facing keys: an
// arbitrary caller must not be able to rewrite `id` or `pid` through it and
// make two records disagree about which agent they are.
const MUTABLE = new Set([
  'phase', 'currentTool', 'currentToolArgsPreview', 'iterations',
  'textChars', 'filesTouched', 'lessonsCount', 'costUsd',
]);

export function updateSubagent(id, patch = {}) {
  const rec = live.get(String(id));
  if (!rec) return null;
  for (const [k, v] of Object.entries(patch)) {
    if (!MUTABLE.has(k)) continue;
    rec[k] = v;
  }
  rec.lastAt = nowMs();
  return rec;
}

// The inner loop's tool activity, folded into a small ledger rather than
// replayed. `report_result` is excluded: it is the completion signal, not work,
// and counting it would make every finished subagent look like it did one more
// thing than it did.
export function recordInnerTool(id, name) {
  const rec = live.get(String(id));
  if (!rec) return null;
  const key = String(name ?? 'unknown');
  if (key in rec.toolCounts) {
    rec.toolCounts[key] += 1;
  } else if (Object.keys(rec.toolCounts).length < MAX_TRACKED_TOOLS) {
    rec.toolCounts[key] = 1;
  } else {
    rec.toolNamesDropped += 1;
  }
  return rec;
}

export function bumpProgress(id) {
  const rec = live.get(String(id));
  if (!rec) return null;
  rec.progressEvents += 1;
  return rec;
}

// The ONLY way cancelRequested/cancelBy/cancelReason move. Deliberately not in
// `MUTABLE`: `updateSubagent` takes a shallow patch from any caller that can
// reach the registry, and letting one of them set `cancelBy` would make the
// audit row name an operator who never pressed anything. A cancel arrives here
// through the control module's observer hook, so the recorded `by` is the one the
// caller passed to `cancelSubagent`.
export function markSubagentCancelRequested(id, { at = null, by = null, reason = null } = {}) {
  const rec = live.get(String(id));
  if (!rec) return null;
  rec.cancelRequested = true;
  rec.cancelRequestedAt = Number.isFinite(Number(at)) ? Number(at) : nowMs();
  rec.cancelBy = by == null ? null : String(by);
  rec.cancelReason = reason == null ? null : String(reason).slice(0, 300);
  // The phase change is the observable half, and it is load-bearing: the dashboard
  // row, `/agents`, and an IPC snapshot all read `phase`, so this is what makes
  // the request visible on all three at the instant it is made.
  if (rec.phase !== 'ended') rec.phase = 'cancelling';
  rec.lastAt = rec.cancelRequestedAt;
  return rec;
}

export function bumpProgressSuppressed(id) {
  const rec = live.get(String(id));
  if (!rec) return null;
  rec.progressSuppressed += 1;
  return rec;
}

// Returns the final record and REMOVES it from the live map. Removing here
// rather than at the call site is the whole contract: once finish() returns,
// `listLiveSubagents()` can no longer report a finished agent as working, so
// there is no path that leaves a completed subagent on screen.
export function finishSubagent(id, patch = {}) {
  const key = String(id);
  const rec = live.get(key);
  if (!rec) return null;
  const endAt = nowMs();
  for (const [k, v] of Object.entries(patch)) {
    if (!MUTABLE.has(k)) continue;
    rec[k] = v;
  }
  rec.status = String(patch.status ?? 'done');
  rec.phase = 'ended';
  rec.endedAt = endAt;
  rec.lastAt = endAt;
  rec.elapsedMs = Math.max(0, endAt - (rec.startedAt ?? rec.spawnedAt));
  live.delete(key);
  return rec;
}

// The per-agent sequence counter. Monotonic per agent, never shared, so
// filtering one agent's events out of the interleaved stream and reading the
// remaining `seq` values answers "is this agent's stream intact" exactly.
export function nextSubagentSeq(id) {
  const key = String(id);
  const n = (seqCounters.get(key) ?? 0) + 1;
  seqCounters.set(key, n);
  const rec = live.get(key);
  if (rec) rec.seq = n;
  return n;
}

// Fan-out accounting. `peak` is the high-water mark of SIMULTANEOUSLY live
// records, which is the number that proves concurrency happened rather than
// being asserted; `deferredTotal` is the running count of calls held back at the
// cap, so a cap that is quietly throttling every turn is visible on one field.
function finiteOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const batchStats = {
  peakConcurrent: 0,
  admittedTotal: 0,
  deferredTotal: 0,
  rejectedTotal: 0,
  lastBatch: null,
};

// Kept for the scheduler, which calls it at admission time so the peak is
// available before the agent's own first model call. It cannot over-report: the
// same number is re-read from `live.size` inside registerSubagent, so the two
// paths agree by construction.
export function noteSubagentLive() {
  const n = live.size;
  if (n > batchStats.peakConcurrent) batchStats.peakConcurrent = n;
  return n;
}

export function noteSubagentBatch(patch = {}) {
  const b = {
    batchId: patch.batchId == null ? null : String(patch.batchId),
    size: Number(patch.size) || 0,
    cap: Number(patch.cap) || 0,
    mode: String(patch.mode ?? 'serial'),
    gateRule: patch.gateRule == null ? null : String(patch.gateRule),
    admitted: Number(patch.admitted) || 0,
    deferred: Number(patch.deferred) || 0,
    // `Number(null)` is 0 and `Number(undefined)` is NaN, so "no ceiling in
    // force" has to be excluded BEFORE the coercion or it would be recorded as
    // a ceiling of zero dollars -- which is both false and, read by anything
    // that divides by it, catastrophic.
    perAgentCostCeilingUsd: finiteOrNull(patch.perAgentCostCeilingUsd),
    sessionCostCapUsd: finiteOrNull(patch.sessionCostCapUsd),
    at: nowMs(),
  };
  batchStats.admittedTotal += b.admitted;
  batchStats.deferredTotal += b.deferred;
  if (b.mode === 'deny' || b.mode === 'reject') batchStats.rejectedTotal += b.size;
  batchStats.lastBatch = b;
  return b;
}

export function subagentBatchStats() {
  return {
    ...batchStats,
    lastBatch: batchStats.lastBatch ? { ...batchStats.lastBatch } : null,
  };
}

// Per-agent event streams, derived from ONE interleaved stream. This is the
// contract under concurrency: an event tagged for agent A belongs to A's list
// and to nobody else's, and A's list is ordered by A's own `seq`. Interleaving
// BETWEEN lists is expected and bounded (progress is already throttled and
// capped); interleaving WITHIN one is not.
export function agentEventStreams(events) {
  const streams = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const id = String(ev?.id ?? '');
    if (!id || !String(ev?.type ?? '').startsWith('subagent-')) continue;
    if (!streams.has(id)) streams.set(id, []);
    streams.get(id).push(ev);
  }
  for (const list of streams.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return streams;
}

export function getLiveSubagent(id) {
  return live.get(String(id)) ?? null;
}

export function isLiveSubagent(id) {
  return live.has(String(id));
}

export function liveSubagentCount() {
  return live.size;
}

// A shallow copy per record, so a caller can hold a snapshot across a spawn
// without its view mutating underneath it.
function publicView(rec) {
  return {
    id: rec.id,
    task: rec.task,
    description: rec.description,
    depth: rec.depth,
    parentId: rec.parentId,
    cwd: rec.cwd,
    resumed: rec.resumed,
    phase: rec.phase,
    status: rec.status,
    currentTool: rec.currentTool,
    currentToolArgsPreview: rec.currentToolArgsPreview,
    iterations: rec.iterations,
    progressEvents: rec.progressEvents,
    progressSuppressed: rec.progressSuppressed,
    toolCounts: { ...rec.toolCounts },
    toolNamesDropped: rec.toolNamesDropped,
    textChars: rec.textChars,
    filesTouched: rec.filesTouched,
    lessonsCount: rec.lessonsCount,
    batchId: rec.batchId,
    batchIndex: rec.batchIndex,
    batchSize: rec.batchSize,
    deferredMs: rec.deferredMs,
    costCeilingUsd: rec.costCeilingUsd,
    costUsd: rec.costUsd,
    cancelRequested: Boolean(rec.cancelRequested),
    cancelRequestedAt: rec.cancelRequestedAt ?? null,
    cancelBy: rec.cancelBy ?? null,
    cancelReason: rec.cancelReason ?? null,
    seq: rec.seq,
    pid: rec.pid,
    spawnedAt: rec.spawnedAt,
    startedAt: rec.startedAt,
    lastAt: rec.lastAt,
    endedAt: rec.endedAt,
    elapsedMs: rec.endedAt != null ? rec.elapsedMs : Math.max(0, nowMs() - (rec.startedAt ?? rec.spawnedAt)),
    // `live` is read off the map, not off the record, so a FINISHED record that
    // is being copied into `recentFinished` cannot be handed out claiming a
    // process is still working on it.
    live: live.get(rec.id) === rec,
    stale: false,
  };
}

export function listLiveSubagents() {
  return [...live.values()].map(publicView).sort((a, b) => a.spawnedAt - b.spawnedAt);
}

// ---- stale-vs-running -------------------------------------------------------

export const STALE_NO_LIVE_PROCESS = 'no live process in this process';
export const STALE_OTHER_PROCESS = 'descriptor was written by another process';

function safeList(cwd) {
  if (!cwd) return [];
  try {
    return listSubagents(cwd);
  } catch {
    return [];
  }
}

// The merge, and the decision it makes.
//
// LIVE  -- a record exists in this process's map. The loop is running it.
// STALE -- the descriptor says status:'running' and this process has no record
//          for that id. Nobody is working on it. It is shown, because hiding a
//          half-finished run is its own lie, but it is labelled STALE and is
//          never counted as working.
//
// That second branch is the entire point of the module. A descriptor is a
// durable record of an intent; the registry is a fact about a live loop. Only
// the second can say "right now".
export function staleSubagents({ cwd = process.cwd(), descriptors = null } = {}) {
  const onDisk = Array.isArray(descriptors) ? descriptors : safeList(cwd);
  const out = [];
  for (const d of onDisk) {
    if (!d || d.status !== 'running') continue;
    if (live.has(String(d.id))) continue;
    const fromOtherProcess = d.pid != null && Number(d.pid) !== process.pid;
    out.push({
      id: d.id,
      task: d.task ?? '',
      description: d.description ?? d.task ?? '',
      depth: d.depth ?? 0,
      parentId: d.parentSession ?? null,
      cwd: d.cwd ?? cwd,
      status: 'running',
      phase: 'unknown',
      currentTool: null,
      currentToolArgsPreview: '',
      iterations: 0,
      progressEvents: 0,
      progressSuppressed: 0,
      toolCounts: {},
      toolNamesDropped: 0,
      textChars: 0,
      filesTouched: Array.isArray(d.filesTouched) ? d.filesTouched.length : 0,
      lessonsCount: Array.isArray(d.lessons) ? d.lessons.length : 0,
      pid: d.pid ?? null,
      spawnedAt: d.createdAt ?? null,
      startedAt: d.createdAt ?? null,
      lastAt: d.completedAt ?? d.createdAt ?? null,
      endedAt: null,
      elapsedMs: null,
      live: false,
      stale: true,
      staleReason: fromOtherProcess
        ? `${STALE_OTHER_PROCESS} (pid ${d.pid})`
        : STALE_NO_LIVE_PROCESS,
    });
  }
  return out.sort((a, b) => String(a.spawnedAt).localeCompare(String(b.spawnedAt)));
}

// ---- the snapshot every consumer reads --------------------------------------

// One call, one answer, so the REPL, the dashboard, and an IPC client cannot
// report different agent counts for the same instant.
//
//   activeCount  agents running RIGHT NOW in this process
//   staleCount   descriptors claiming to run with nobody behind them
//   live[]       the active ones, oldest first
//   stale[]      the orphans, labelled
//   recentFinished[]  what just ended, bounded, so an operator can see the tail
//                     of the run without scrolling a log
export const MAX_RECENT_FINISHED = 8;

const recentFinished = [];

export function noteFinishedSnapshot(rec) {
  if (!rec) return null;
  recentFinished.push(publicView(rec));
  if (recentFinished.length > MAX_RECENT_FINISHED) recentFinished.shift();
  return rec;
}

export function listRecentFinished() {
  return recentFinished.map((r) => ({ ...r, toolCounts: { ...(r.toolCounts ?? {}) } }));
}

export function agentSnapshot({ cwd = process.cwd(), descriptors = null, includeRecent = true } = {}) {
  const liveList = listLiveSubagents();
  const staleList = staleSubagents({ cwd, descriptors });
  return {
    cwd: cwd ? String(cwd) : null,
    pid: process.pid,
    at: nowMs(),
    activeCount: liveList.length,
    staleCount: staleList.length,
    // Fan-out accounting. `activeCount` is already N-true with concurrency --
    // it is the size of the live map, not a counter -- but an operator asking
    // "was that a fan-out or a queue?" needs the cap that was in force and the
    // peak that was reached, which is what these carry.
    concurrency: subagentBatchStats(),
    // How many agents THIS process actually stopped, and how many control records
    // it is still holding. The first is the question a cancelled run gets asked
    // afterwards; the second is the leak check -- it must return to zero when the
    // run ends, which is what makes "a cancelled agent holds no resources"
    // checkable rather than asserted.
    cancellation: subagentCancelStats(),
    live: liveList,
    stale: staleList,
    ...(includeRecent ? { recentFinished: listRecentFinished() } : {}),
  };
}

// Test-only: a process that runs a failing subagent in one test must not leave
// a live record behind for the next test to read.
export function _resetRegistry() {
  live.clear();
  seqCounters.clear();
  recentFinished.length = 0;
  batchStats.peakConcurrent = 0;
  batchStats.admittedTotal = 0;
  batchStats.deferredTotal = 0;
  batchStats.rejectedTotal = 0;
  batchStats.lastBatch = null;
}

// Every cancel reaches this module through ONE subscription rather than through
// each caller (the REPL, the IPC handler, a future surface) remembering to call
// `markSubagentCancelRequested` itself. A cancel that updated the controller but
// not the registry would abort the work while the operator's own `/agents` still
// showed the agent running -- the exact class of lie this file exists to prevent
// -- so the wiring is not left to call sites.
subscribeSubagentCancel((info) => { markSubagentCancelRequested(info.id, info); });

export { clip as _clip };

// ---- what the parallel scheduler uses, and what it still owes ---------------
//
// This file was built for VISIBILITY. The agent loop used to run exactly one
// subagent at a time (`makeSubagentToolHandler` awaited `runSubagent` inline)
// and this file's notes listed what a scheduler would need. The scheduler now
// exists -- src/agent.js `runSubagentBatch`, bounded by
// `resolveSubagentConcurrency` in src/resource-class.js -- so the list is
// re-read against what is actually built.
//
//   1. A KEYED live map keyed by subagent id. DONE and load-bearing: `live.size`
//      is now the concurrent count `agentSnapshot().activeCount` reports, so
//      /agents, the dashboard and an IPC client all show N running because they
//      are reading N records, not because anything counts them twice.
//
//   2. A PROVENANCE field per record. DONE and load-bearing: `pid` was already
//      recorded and is what phrases a stale reason, and the batch fields
//      (batchId/batchIndex/batchSize/deferredMs) were added because with two
//      agents sharing a spawn instant the id alone no longer answers "which of
//      these is mine" or "is this one queued or slow". What is still missing is
//      a lease/heartbeat: cross-PROCESS concurrency cannot tell "that pid is
//      still alive" from "that pid was recycled" without one, and the answer is
//      still inferred from the in-process map plus the pid comparison.
//
//   3. EVENT ORDERING under concurrency. DONE for the part that is checkable:
//      every lifecycle event carries a per-agent `seq` (`nextSubagentSeq`), and
//      `agentEventStreams` splits one interleaved stream into per-agent streams
//      that are monotonic in that agent's own sequence. Interleaving BETWEEN
//      agents is expected and bounded by MAX_PROGRESS_EVENTS per agent; a
//      consumer still cannot assume a TOTAL order across agents, and should not
//      -- there is none, and inventing one would be the lie this module exists
//      to avoid.
//
//   4. A PER-AGENT CANCELLATION PATH. DONE (src/subagent-control.js). It is
//      per-AGENT rather than per-run, which is the part the parallel scheduler
//      needed: `ctx.signal` is one AbortController shared by every lane of a
//      fan-out, so cancelling through it would have taken down the whole batch.
//      Each subagent now holds its own parent-linked controller, `cancelled` is a
//      THIRD terminal status alongside done and failed (never a flavour of
//      failed -- that would have charged an operator's decision to the self-heal
//      failure budget), `phase: 'cancelling'` covers the window between the
//      request and the unwind, and `cancellation.cancelledTotal` in the snapshot
//      answers "how many did I actually stop".
//
//      What is still NOT claimed, and is the reason the status is accompanied by
//      a sentence rather than being self-explanatory: cancelling prevents
//      SUBSEQUENT steps. An already-dispatched provider request may still
//      complete, and a tool call that had already started was allowed to finish.
//      An operator reading `cancelled` in this map should read it as "no further
//      steps", not as "nothing is still running".
//
//   5. A BOUND ON CONCURRENCY ITSELF. DONE, and deliberately NOT here:
//      MAX_SUBAGENT_CONCURRENCY lives beside the classification, because this
//      file reports the truth and the scheduler decides what is allowed. This
//      module still bounds the COST of agents (MAX_PROGRESS_EVENTS,
//      MAX_TRACKED_TOOLS, MAX_RECENT_FINISHED); the scheduler bounds their
//      NUMBER, and the two bounds are recorded side by side in the snapshot so
//      one screen can show both.
//
//   6. A COST/TOKEN ROLLUP PER AGENT. DONE for the part a fan-out makes
//      dangerous: every record carries `costCeilingUsd` (its share of the
//      session cap, assigned at admission) and `costUsd` (what it actually
//      spent), so N agents' ceilings sum to at most the session budget and a
//      runaway agent is visible per agent rather than as one run-level total.
//      `subagentBatchStats()` carries the aggregate that used to be invisible:
//      the cap that was in force, the peak concurrency actually reached, and the
//      running count of calls the cap deferred.
//
// STILL NOT TRUE, and deliberately:
//   * MAX_PROGRESS_EVENTS is per agent, so a batch of 3 can emit 3x the
//     progress a single one did. That is the honest cost of concurrency, and
//     the per-agent bound is the one worth keeping -- a GLOBAL cap would let one
//     chatty agent silence the other N-1.
//   * Nothing here bounds the SIZE of a batch. A model may emit fifty
//     subagent calls in one turn; the scheduler admits `cap` of them and
//     defers the rest into the same turn, but the queue itself is the model's
//     to make, and the audit trail is the only place the whole shape shows up.
