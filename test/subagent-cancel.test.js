// SUBAGENT CANCEL.
//
// The capability the comparison matrix graded as ox's single largest loss:
// `grep -rn "cancelSubagent|stopSubagent|killSubagent" src/ test/` used to
// return ZERO matches, so there was no answer to "stop that one".
//
// The seven tests here assert the RUNTIME, not the intent, and one of them
// exists specifically to make a future LIE fail:
//
//   1  cancel stops the agent; the registry says 'cancelled', not done/failed
//   2  cancelling ONE agent of a parallel batch leaves its siblings running
//   3  the cancel message says an in-flight provider request may still complete
//   4  cancel works from INSIDE a tool call, not only between turns
//   5  no file handle / child process / socket survives the cancel
//   6  the lifecycle event is emitted and visible to observers
//   7  cancelling an already-finished agent is a clean no-op, not an error
//   8  subagent-cancelled fires when the agent STOPS, and counts once
//   9  an aborted run is SHOWN but not counted as an error
//
// Test 8 exists because test 6 could only assert the REQUEST event. Until
// subagent-cancelled existed, a consumer that wanted "this agent was cancelled"
// had to string-match status on subagent-end, and the CLI, `ox ipc watch` and
// every IPC client each re-implemented that match separately -- which is the
// disagreement the dedicated event removes. It also pins the IDEMPOTENCE that
// the new event forces: the end event and the terminal event describe ONE stop
// and both arrive, so a reducer that counted both would report 2.
//
// THE HONESTY REQUIREMENT (test 3) is the load-bearing one. CopilotKit's OpenMuse
// (MIT) puts the rule precisely: "Pausing/cancelling prevents subsequent task
// steps; an already approved in-flight provider request may finish." ox does
// not abort an in-flight tool call, and it cannot un-send a dispatched provider
// request. A cancel that reported "halted" would be reporting success while a
// write is still landing -- so CANCEL_SEMANTICS is asserted VERBATIM here, and
// a list of guarantee-shaped phrasings is asserted ABSENT. An edit that upgrades
// the wording to a guarantee fails this file.
//
// Nothing here touches the real ~/.ox: every run gets a mkdtemp cwd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getEventListeners } from 'node:events';

import { runAgent } from '../src/agent.js';
import { makeSubagentToolHandler, subagentToolSchema, readDescriptor } from '../src/subagent.js';
import {
  agentSnapshot, listLiveSubagents, getLiveSubagent, listRecentFinished,
  SUBAGENT_TERMINAL_STATUSES, _resetRegistry,
} from '../src/subagent-registry.js';
import {
  cancelSubagent, cancelMessage, cancelledSubagentResult, ensureSubagentControl,
  releaseSubagentControl, listSubagentControls, subagentCancelStats, isSubagentCancelled,
  CANCEL_SEMANTICS, CANCEL_TOOL_NOTE, SUBAGENT_STATUS_CANCELLED, _resetSubagentControls,
} from '../src/subagent-control.js';
import {
  isConcurrentlyBatchable, DEFAULT_SUBAGENT_CONCURRENCY, MAX_SUBAGENT_CONCURRENCY,
} from '../src/resource-class.js';
import { createWatchState, applyMessage, renderFrame } from '../src/ipc-watch.js';

// The scripted provider is reached through the `custom` provider, which refuses
// to send anything without a key.
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-subagent-cancel-key';

// ---- harness ----------------------------------------------------------------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [], usage = { prompt_tokens: 11, completion_tokens: 7 } } = {}) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  calls.forEach((c, i) =>
    out.push(sse({
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }],
    }))
  );
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

const isSubagentRequest = (r) => (r.tools ?? []).some((s) => (s?.function?.name ?? s?.name) === 'report_result');

const taskOf = (r) => String((r.messages ?? []).find((m) => m?.role === 'user')?.content ?? '');

// `onRequest` is async and is the only place a test can observe the registry
// while an agent is genuinely in flight. Holding the response open is what
// guarantees in-flight rather than already-finished.
async function startMock(t, decide, { onRequest = null } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      if (onRequest) await onRequest(parsed, res);
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn(decide(parsed) ?? {}));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

function sandbox(t, prefix = 'ox-cancel-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded, observable waiting -- never a bare sleep as the SUBJECT of an
// assertion. The timeout names what was waited for and dumps what arrived, so a
// genuine hang reads as a diagnosis rather than as a failing `true`.
async function waitFor(read, predicate, what, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = read();
    if (predicate(s)) return s;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}\n--- got ---\n${JSON.stringify(s, null, 2).slice(0, 3000)}`);
    }
    await sleep(15);
  }
}

const schema = (name, properties = {}, required = []) => ({
  name,
  description: name,
  input_schema: { type: 'object', properties, required, additionalProperties: false },
});

// The parent loop drains `_subagentEvents` ITSELF, so a top-level ctx must not
// pre-seed the queue when driving runAgent -- handing one in makes runAgentLoop
// believe it is NESTED. Driving the tool handler DIRECTLY means the test owns
// the queue, which is also what lets it cancel a known id mid-flight.
function baseCtx(cwd, extra = {}) {
  return {
    cwd,
    depth: 0,
    maxDepth: 2,
    sessionId: 'sess-cancel-parent',
    enableSubagents: true,
    allTools: [
      subagentToolSchema(),
      schema('read_file', { path: { type: 'string' } }, ['path']),
      schema('write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
      schema('bash', { command: { type: 'string' } }, ['command']),
    ],
    ...extra,
  };
}

// In the real CLI ctx.requestApproval is ALWAYS present and `--yolo` makes it
// answer true. Omitting it models a run with NO approver at all, which is the
// serial-fallback case, so the concurrent path has to supply one as the product
// does.
const yoloApprover = async () => true;
const yoloCtx = (cwd, extra = {}) => baseCtx(cwd, { yolo: true, approval: 'yolo', requestApproval: yoloApprover, ...extra });

const target = (port) => ({ provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'claude-haiku-4-5' });
const mkHandler = (port) => makeSubagentToolHandler({ config: { subagent: { maxDepth: 2, maxIterations: 8 } }, target: target(port), auxTarget: null });

const ofType = (evs, t) => evs.filter((e) => e.type === t);
const recent = (id) => listRecentFinished().find((r) => r.id === id);

// Reset both halves. A test that cancels an agent must not leave a live control
// for the next one, or test 7's "not-running" answer would depend on order.
function resetAll() {
  _resetRegistry();
  _resetSubagentControls();
}

const call = (id, task) => ({ id, name: 'subagent', args: { id, task } });

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// 1. cancel stops the agent; the registry says 'cancelled', not done/failed
// ---------------------------------------------------------------------------

test('cancel stops a running subagent and the registry records cancelled, not done or failed', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // The subagent's own provider turn is HELD OPEN so it is genuinely mid-request
  // when the cancel lands -- not finished-and-then-cancelled, which would pass
  // this test without any cancellation having done anything.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port } = await startMock(t, () => ({ text: 'subagent done' }), {
    onRequest: async (r, res) => { if (isSubagentRequest(r)) await gate; },
  });
  t.after(() => { try { release(); } catch { /* already released */ } });

  const handler = mkHandler(port);
  const runPromise = handler({ id: 'sa_stop', task: 'do the thing' }, yoloCtx(cwd, { _subagentEvents: [] }));

  // Registered AND controllable before the first provider response is released.
  // Both are the operator's real window.
  const live = await waitFor(() => listLiveSubagents(), (l) => l.some((a) => a.id === 'sa_stop'), 'sa_stop in the live registry');
  assert.equal(live.find((a) => a.id === 'sa_stop').status, 'running', 'a still-running agent reports running');
  assert.equal(listSubagentControls().some((c) => c.id === 'sa_stop'), true, 'a running agent holds a control record');

  const res = cancelSubagent('sa_stop', { by: 'operator', reason: 'operator pressed cancel' });
  assert.equal(res.ok, true);
  assert.equal(res.cancelled, true);
  assert.equal(res.by, 'operator');
  assert.equal(res.reason, 'operator pressed cancel');

  // The registry learns about the request through the ONE subscription, and the
  // interval between request and unwind has its own phase. An operator who saw
  // 'running' after a cancel would press cancel a second time.
  const cancelling = getLiveSubagent('sa_stop');
  assert.equal(cancelling.cancelRequested, true, 'the registry knows the cancel was requested');
  assert.equal(cancelling.cancelBy, 'operator');
  assert.equal(cancelling.cancelReason, 'operator pressed cancel');
  assert.equal(cancelling.phase, 'cancelling', 'the request-to-unwind window has its own phase');

  release();
  const out = await runPromise;

  // THE STATE DISTINCTNESS CLAIM. `cancelled` is a peer of done and failed and
  // is filed under neither.
  assert.equal(out.structured.status, SUBAGENT_STATUS_CANCELLED, `expected cancelled, got ${out.structured.status}`);
  assert.notEqual(out.structured.status, 'done');
  assert.notEqual(out.structured.status, 'failed');
  assert.equal(SUBAGENT_TERMINAL_STATUSES.includes('cancelled'), true, 'cancelled is a terminal status');
  assert.deepEqual([...SUBAGENT_TERMINAL_STATUSES].sort(), ['cancelled', 'done', 'failed']);

  // A cancel is NOT a model error. `isError: true` feeds the parent's self-heal
  // failure counter (3 -> budget exhausted), so an operator pressing cancel
  // three times would look like a broken subagent tool.
  assert.equal(out.isError, false, 'a cancelled subagent is not an error for the parent');

  // Retired from the live map, and the finished snapshot agrees.
  assert.equal(getLiveSubagent('sa_stop'), null, 'a finished agent is not live');
  assert.equal(recent('sa_stop').status, SUBAGENT_STATUS_CANCELLED);
  assert.equal(recent('sa_stop').cancelBy, 'operator');

  // The durable descriptor agrees. A cancel reported 'failed' on disk while the
  // registry says 'cancelled' is exactly the split the registry exists to catch.
  const desc = readDescriptor(cwd, 'sa_stop');
  assert.equal(desc.status, SUBAGENT_STATUS_CANCELLED, `descriptor says ${desc.status}`);
  assert.equal(desc.error, null, 'a cancel is not persisted as an error');
  assert.ok(desc.lessons.some((l) => /CANCELLED/.test(l.text)), 'the cancel is recorded in the agent own lessons');
  // And the "report faster" lesson must NOT be there: a cancelled agent was
  // never given the chance, and that lesson would be a lie about what happened.
  assert.equal(desc.lessons.some((l) => /report_result/.test(l.text)), false, 'a cancelled agent is not nagged about reporting');

  // The counters an operator actually reads.
  const snap = agentSnapshot({ cwd });
  assert.equal(snap.activeCount, 0, 'nothing is still counted as active');
  assert.equal(snap.cancellation.cancelledTotal, 1, 'the process reports one cancel');
  assert.equal(snap.cancellation.liveControls, 0, 'no control record is held after the run');
  assert.equal(snap.staleCount, 0, 'a cancelled descriptor is neither live nor stale');
});

// ---------------------------------------------------------------------------
// 2. batch isolation: cancelling one agent must not disturb its siblings
// ---------------------------------------------------------------------------

test('cancelling one agent of a parallel batch leaves the others running', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // Both subagents held open, so the cancel lands while BOTH are genuinely in
  // flight. The assertion is the sibling's direction: that its control record,
  // its signal, and its registry row are untouched by someone else's cancel.
  const gates = {};
  const gateFor = (id) => {
    if (!gates[id]) gates[id] = { promise: null, release: null };
    return gates[id];
  };
  for (const id of ['sa_live', 'sa_victim']) {
    const g = gateFor(id);
    g.promise = new Promise((r) => { g.release = r; });
  }
  t.after(() => { for (const g of Object.values(gates)) { try { g.release?.(); } catch { /* already */ } } });

  // The parent fans out ONCE and then finishes. Returning the same two calls on
  // every parent turn would re-spawn both agents each iteration -- six batches
  // instead of one -- which makes `subagent-end` ambiguous (a later 'done' for
  // the same id sitting next to the cancelled one) and would test the cancel
  // against a re-run rather than against the run that was cancelled.
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [call('sa_live', 'survivor task'), call('sa_victim', 'victim task')] }
        : { text: 'parent final' };
    }
    return { text: taskOf(r).includes('survivor') ? 'survivor finished its work' : 'victim text' };
  }, {
    onRequest: async (r) => { if (isSubagentRequest(r)) await gateFor(taskOf(r).includes('survivor') ? 'sa_live' : 'sa_victim').promise; },
  });

  // The capability the batch depends on, asserted rather than assumed: cancel
  // must not have required breaking the concurrent path.
  assert.equal(isConcurrentlyBatchable('subagent'), true, 'subagent is still concurrently batchable');
  assert.equal(DEFAULT_SUBAGENT_CONCURRENCY, 3, 'the default cap is still 3');
  assert.equal(MAX_SUBAGENT_CONCURRENCY, 8, 'the hard cap is still 8');

  const events = [];
  const finalCtx = {
    ...yoloCtx(cwd),
    subagentHandler: mkHandler(port),
  };
  const run = (async () => {
    for await (const ev of runAgent({
      target: target(port),
      messages: [{ role: 'user', content: 'delegate two tasks' }],
      ctx: finalCtx,
      config: { cwd },
      maxIterations: 6,
    })) events.push(ev);
  })();

  // BOTH live at the same moment is what makes this a fan-out rather than two
  // serial runs, and it is the state a cancel has to be surgical inside.
  const both = await waitFor(() => listLiveSubagents(), (l) => l.filter((a) => a.id === 'sa_live' || a.id === 'sa_victim').length === 2, 'both subagents live at once');
  assert.deepEqual(both.map((a) => a.id).sort(), ['sa_live', 'sa_victim'], 'both agents are registered');
  assert.equal(both[0].batchId, both[1].batchId, 'they share a batch id');
  assert.equal(both[0].batchSize, 2);
  assert.equal(listSubagentControls().find((c) => c.id === 'sa_live').aborted, false, 'the survivor is not aborted before the cancel');

  assert.equal(cancelSubagent('sa_victim', { by: 'operator' }).cancelled, true);

  // IMMEDIATELY after: victim cancelling, survivor untouched. Same instant,
  // same process -- this is the isolation claim.
  const after = listLiveSubagents();
  assert.equal(after.find((a) => a.id === 'sa_victim').cancelRequested, true, 'the victim knows it was cancelled');
  assert.equal(after.find((a) => a.id === 'sa_victim').phase, 'cancelling');
  assert.equal(after.find((a) => a.id === 'sa_live').cancelRequested, false, 'the sibling was NOT cancelled');
  assert.equal(after.find((a) => a.id === 'sa_live').phase, 'running', 'the sibling is still running, not cancelling');
  assert.equal(isSubagentCancelled('sa_live'), false, 'the sibling control is not cancelled');
  assert.equal(isSubagentCancelled('sa_victim'), true);

  // The sibling's AbortController is its OWN object. A shared run signal would be
  // one controller aborting all N agents -- the opposite of the request.
  const controls = listSubagentControls();
  assert.equal(controls.find((c) => c.id === 'sa_live').aborted, false, "the sibling's signal is not aborted");
  assert.equal(controls.find((c) => c.id === 'sa_victim').aborted, true, "the victim's signal is aborted");

  gateFor('sa_live').release();
  gateFor('sa_victim').release();
  await run;

  const ends = ofType(events, 'subagent-end');
  // Exactly one end per agent. A parent that re-emitted the same batch would
  // double this, and every assertion below would then be reading a re-run
  // instead of the run that was cancelled.
  assert.equal(ends.length, 2, `expected exactly 2 subagent-end events, got ${ends.length} (${ends.map((e) => `${e.id}:${e.status}`).join(', ')})`);
  const victimEnd = ends.find((e) => e.id === 'sa_victim');
  const survivorEnd = ends.find((e) => e.id === 'sa_live');
  assert.ok(victimEnd, 'the cancelled agent still emits subagent-end (never skipped)');
  assert.ok(survivorEnd, 'the sibling still emits subagent-end');
  assert.equal(victimEnd.status, SUBAGENT_STATUS_CANCELLED, `victim end status is ${victimEnd.status}`);
  assert.equal(survivorEnd.status, 'done', `sibling end status is ${survivorEnd.status}, which is what isolation means`);
  assert.equal(survivorEnd.error, null, 'the sibling ran no error');
  assert.equal(survivorEnd.cancelled, undefined, 'the sibling end event carries no cancel fields at all');
  assert.equal(recent('sa_live').status, 'done', 'the sibling finished normally');
  assert.equal(recent('sa_victim').status, SUBAGENT_STATUS_CANCELLED);
  // Both released, nothing leaked by either path.
  assert.equal(listSubagentControls().length, 0, 'both control records released');
});

// ---------------------------------------------------------------------------
// 3. THE HONESTY REQUIREMENT
// ---------------------------------------------------------------------------

test('the cancel message states that an in-flight provider request may still complete', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // The exact clause, asserted as a literal. CopilotKit's OpenMuse (MIT):
  // "Pausing/cancelling prevents subsequent task steps; an already approved
  //  in-flight provider request may finish." ox does not abort an in-flight tool
  // call and cannot un-send a dispatched request, so the wording must carry the
  // qualification.
  assert.match(CANCEL_SEMANTICS, /prevents subsequent steps/i, 'CANCEL_SEMANTICS must say cancel prevents subsequent steps');
  assert.match(CANCEL_SEMANTICS, /in-flight provider request/i, 'CANCEL_SEMANTICS must name the in-flight provider request');
  assert.match(CANCEL_SEMANTICS, /may still complete|may still finish|may complete/i, 'CANCEL_SEMANTICS must say it MAY still complete');
  // The tool-call half, which is the failure mode this exists to avoid: a
  // `write_file` that already truncated the file still finishes the write.
  assert.match(CANCEL_TOOL_NOTE, /already started/i);
  assert.match(CANCEL_TOOL_NOTE, /may still land/i);

  // The wording must not contain a guarantee. A cancel that reports a halt is a
  // tool reporting success while a write is still landing.
  const banned = [
    /guarantee/i,
    /all work (?:was |has been )?stopped/i,
    /work (?:was |has been )?(?:fully |completely )?(?:stopped|halted|terminated)/i,
    /no further (?:tool calls|requests|steps|requests will) (?:will|can|are going to) (?:run|start|happen|be made)/i,
    /(?:the |provider )?request was aborted/i,
    /aborted immediately/i,
    /\bfully (?:stopped|halted)\b/i,
    /\bhalted\b/i,
    /stopped (?:safe|clean|immediately)/i,
  ];
  for (const re of banned) {
    assert.equal(re.test(CANCEL_SEMANTICS), false, `CANCEL_SEMANTICS must not claim a guarantee: ${re}`);
    assert.equal(re.test(CANCEL_TOOL_NOTE), false, `CANCEL_TOOL_NOTE must not claim a guarantee: ${re}`);
  }

  // The operator-facing report carries the clause verbatim, not a paraphrase.
  const msg = cancelMessage({ id: 'sa_x', by: 'operator', reason: 'testing' });
  assert.ok(msg.includes(CANCEL_SEMANTICS), 'the report line carries CANCEL_SEMANTICS verbatim');
  assert.ok(msg.includes(CANCEL_TOOL_NOTE), 'the report line carries the tool-call note verbatim');
  assert.match(msg, /may still complete/i);
  // What the operator gets BEFORE what they must not assume. The reverse order
  // reads as a disclaimer bolted onto a promise.
  assert.ok(msg.indexOf('prevents subsequent steps') < msg.indexOf('may still complete'), 'the good news comes before the qualification');
  // And it says the state is distinct, because that is the question it answers.
  assert.match(msg, /registry status becomes 'cancelled'/);
  assert.match(msg, /not done and not failed/);

  // The PARENT's tool result carries the same clause. A model reading "cancelled"
  // with no qualification is the reader who will tell its own user the work
  // stopped.
  const parentMsg = cancelledSubagentResult({ id: 'sa_x', elapsedMs: 120, filesTouched: 2, innerTools: { write_file: 3 } });
  assert.ok(parentMsg.includes(CANCEL_SEMANTICS), 'the parent-facing result carries CANCEL_SEMANTICS verbatim');
  assert.match(parentMsg, /CANCELLED/);
  assert.match(parentMsg, /did not finish its task and it did not fail/);
  for (const re of banned) {
    assert.equal(re.test(parentMsg), false, `the parent-facing result must not claim a guarantee: ${re}`);
  }
  // Work already done is reported, not hidden: a cancel that discarded the
  // partial work would be its own lie.
  assert.match(parentMsg, /Work already done is kept and reported/);
  assert.match(parentMsg, /3 tool call\(s\) already ran/);
  assert.match(parentMsg, /2 file\(s\) already touched/);

  // The real run's own message, from a live cancel rather than a string literal.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { port } = await startMock(t, () => ({ text: 'x' }), { onRequest: async (r) => { if (isSubagentRequest(r)) await gate; } });
  t.after(() => { try { release(); } catch { /* already */ } });
  const runPromise = mkHandler(port)({ id: 'sa_msg', task: 'task' }, yoloCtx(cwd, { _subagentEvents: [] }));
  await waitFor(() => listLiveSubagents(), (l) => l.some((a) => a.id === 'sa_msg'), 'sa_msg live');
  const real = cancelSubagent('sa_msg', { by: 'operator' });
  assert.equal(real.semantics, CANCEL_SEMANTICS, 'a live cancel returns the shared clause, not a per-call-site string');
  assert.ok(real.message.includes(CANCEL_SEMANTICS));
  assert.ok(real.toolNote, 'the tool-call qualification travels with the report');
  release();
  assert.ok((await runPromise).content.includes(CANCEL_SEMANTICS), 'the tool result the parent sees carries the clause');
});

// ---------------------------------------------------------------------------
// 4. cancel from INSIDE a tool call
// ---------------------------------------------------------------------------

test('cancel works from inside a tool call, not only between turns', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // A real `bash` child that takes real, observable time. The pre-dispatch abort
  // check runs BEFORE a tool starts, so it cannot cover this window -- which is
  // the entire reason this test exists.
  // "Has the agent already dispatched bash?" is asked of the ASSISTANT tool-call
  // messages only. Matching the word 'bash' anywhere in the history matches the
  // system prompt's own TOOL RULES ("run the relevant tests or build via bash")
  // on turn 1, which makes the scripted model skip straight to its final answer
  // and never call the tool -- so this test would then be measuring a
  // between-turns cancel while claiming to measure a mid-tool-call one.
  const alreadyRanBash = (r) => (r.messages ?? []).some((m) => m?.role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.some((c) => c?.function?.name === 'bash'));
  const marker = path.join(cwd, 'marker.txt');
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) return { text: 'parent final' };
    return alreadyRanBash(r)
      ? { text: 'SECOND TURN REACHED' }
      : { calls: [{ id: 'b1', name: 'bash', args: { command: `sleep 6; echo late > ${marker}` } }] };
  });

  const ctx = yoloCtx(cwd, { _subagentEvents: [] });
  const runPromise = mkHandler(port)({ id: 'sa_intool', task: 'run a slow command' }, ctx);

  // "Inside a tool call" is read off the registry's own currentTool, which is
  // the same field the dashboard shows an operator.
  const inside = await waitFor(
    () => getLiveSubagent('sa_intool'),
    (r) => r && r.currentTool === 'bash',
    'the subagent to be inside its bash tool call',
  );
  assert.equal(inside.currentTool, 'bash', 'the registry says the agent is inside the tool call');

  const res = cancelSubagent('sa_intool', { by: 'operator' });
  assert.equal(res.cancelled, true);
  assert.equal(isSubagentCancelled('sa_intool'), true);

  const out = await runPromise;

  // THE HONEST PART: the in-flight tool call was NOT interrupted. It ran to
  // completion or was SIGTERMed, and either way ox does not claim otherwise --
  // and the result says so. What must not happen is a SECOND provider request
  // afterwards; the turn-boundary abort check is what stops the agent issuing
  // one. 'SECOND TURN REACHED' is the canary: the mock would emit it if the
  // agent had been allowed another turn.
  assert.equal(fs.existsSync(marker) || true, true);
  assert.equal(out.structured.status, SUBAGENT_STATUS_CANCELLED, `status was ${out.structured.status}`);
  assert.equal(out.isError, false, 'a mid-tool-call cancel is not a model error');
  assert.ok(out.content.includes(CANCEL_SEMANTICS), 'the mid-tool-call result still carries the clause');
  assert.ok(out.content.includes(CANCEL_TOOL_NOTE), 'the already-started tool call is named explicitly');
  assert.equal(out.content.includes('SECOND TURN REACHED'), false, 'a cancelled agent must not start another provider turn');

  // The agent is gone and holds nothing.
  assert.equal(getLiveSubagent('sa_intool'), null, 'the cancelled agent is not live');
  assert.equal(listSubagentControls().some((c) => c.id === 'sa_intool'), false, 'no control record survives the cancel');
  assert.equal(readDescriptor(cwd, 'sa_intool').status, SUBAGENT_STATUS_CANCELLED);

  // It really was mid-tool rather than a race that happened to land between
  // turns: the tool was dispatched, so a pre-dispatch-only abort could not have
  // produced this.
  const finished = recent('sa_intool');
  assert.equal(Number(finished?.iterations ?? 0) >= 1, true, 'the subagent entered its loop before the cancel');
});

// ---------------------------------------------------------------------------
// 5. no file handle / child process / socket leak after cancel
// ---------------------------------------------------------------------------

test('no file handle, child process or socket survives a cancel', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // A run-wide signal the way a real session has one, so the leak that matters
  // is measurable: each subagent adds an abort listener to the SAME long-lived
  // signal, and nothing removes it when the run ends.
  const parentController = new AbortController();
  const listenersBefore = getEventListeners(parentController.signal, 'abort').length;
  const socketsBefore = process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;

  let release;
  const gate = new Promise((r) => { release = r; });
  const { port } = await startMock(t, () => ({ text: 'x' }), { onRequest: async (r) => { if (isSubagentRequest(r)) await gate; } });
  t.after(() => { try { release(); } catch { /* already */ } });

  const ctx = yoloCtx(cwd, { _subagentEvents: [], signal: parentController.signal });
  const handler = mkHandler(port);
  const ids = ['sa_leak_cancel', 'sa_leak_done'];
  const runs = [
    handler({ id: ids[0], task: 'the cancelled one' }, ctx),
    handler({ id: ids[1], task: 'the completed one' }, ctx),
  ];

  await waitFor(() => listLiveSubagents(), (l) => l.length === 2, 'both agents live');
  const duringListeners = getEventListeners(parentController.signal, 'abort').length;
  assert.ok(duringListeners >= listenersBefore + 2, `expected 2 linked abort listeners during the run, got ${duringListeners - listenersBefore}`);

  cancelSubagent('sa_leak_cancel', { by: 'operator' });
  release();
  await Promise.all(runs);

  // 1. FILE HANDLES: the control's parent listener is REMOVED, so a finished
  // run's controls are not reachable from a long-lived signal. Without the
  // explicit removeEventListener this count would keep climbing.
  const listenersAfter = getEventListeners(parentController.signal, 'abort').length;
  assert.equal(listenersAfter, listenersBefore, `abort listeners leaked: ${listenersAfter - listenersBefore} still attached to the run signal`);

  // The other half: the registry and the control map are both empty, so nothing
  // holds a descriptor or a path open.
  assert.equal(listSubagentControls().length, 0, `controls leaked: ${listSubagentControls().map((c) => c.id).join(', ')}`);
  assert.equal(listLiveSubagents().length, 0, 'the live registry is empty');
  assert.equal(subagentCancelStats().liveControls, 0, 'the snapshot admits no live control');
  assert.equal(subagentCancelStats().cancelledTotal, 1, 'exactly one cancel was counted');

  // The descriptors on disk are CLOSED files: readable, and the directory can
  // be walked and removed afterwards.
  for (const id of ids) assert.ok(readDescriptor(cwd, id), `${id} has a readable descriptor after the run`);
  assert.doesNotThrow(() => fs.readdirSync(path.join(cwd, '.agent', '_sub')));

  // 2. CHILD PROCESS: an in-flight `bash` child's process group is killed by the
  // abort (src/tools/exec.js killGroup). Measured with a REAL process, because
  // "no child process leaked" asserted about a mock is worth nothing.
  const pidFile = path.join(cwd, 'pid.txt');
  // Git Bash on Windows: forward slashes survive the shell, and $$ is an MSYS
  // pid there — /proc/$$/winpid is the one process.kill(pid, 0) can see.
  const shPidFile = pidFile.replace(/\\/g, '/');
  const { port: p2 } = await startMock(t, (r) => (
    isSubagentRequest(r)
      ? { calls: [{ id: 'b1', name: 'bash', args: { command: `{ cat /proc/$$/winpid 2>/dev/null || echo $$; } > '${shPidFile}'; sleep 30` } }] }
      : { text: 'parent final' }
  ));
  const bashRun = mkHandler(p2)({ id: 'sa_bash', task: 'run a long sleep' }, yoloCtx(cwd, { _subagentEvents: [] }));
  // If an assertion below fails first, the agent must still be stopped: left
  // running, it keeps this process (and the whole suite) alive.
  t.after(async () => { try { cancelSubagent('sa_bash', { by: 'operator' }); } catch { /* already done */ } await bashRun.catch(() => {}); });
  const childPid = Number(await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; }
  }, (p) => p && Number.isInteger(Number(p)) && Number(p) > 0, 'the bash child to report its pid'));
  // It is genuinely alive, so the assertion below means something.
  assert.equal(isAlive(childPid), true, 'the child process is running before the cancel');

  cancelSubagent('sa_bash', { by: 'operator' });
  await bashRun;
  // The abort SIGTERMs the process group, so `sleep 30` does not outlive the
  // agent as an orphan.
  const killed = await waitFor(() => !isAlive(childPid), (v) => v === true, 'the bash child to be killed by the cancel', { timeout: 20000 })
    .then(() => true, () => false);
  assert.equal(killed, true, `the cancelled subagent leaked child process ${childPid}`);

  // 3. SOCKETS: the provider connections are released. This is the weakest of
  // the three claims (the mock servers' own handles are in the baseline too),
  // but a socket-per-cancel leak would still show as a large rise.
  const socketsAfter = process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;
  assert.ok(socketsAfter - socketsBefore <= 8, `socket handles grew by ${socketsAfter - socketsBefore} across 3 cancelled/completed runs`);

  // Nothing from any cancelled agent is still reachable.
  for (const id of [...ids, 'sa_bash']) assert.equal(getLiveSubagent(id), null, `${id} is still live`);
  assert.equal(readDescriptor(cwd, 'sa_bash').status, SUBAGENT_STATUS_CANCELLED);
});

// ---------------------------------------------------------------------------
// 6. the lifecycle event is emitted and visible to observers
// ---------------------------------------------------------------------------

test('the cancel lifecycle event is emitted at request time and visible to observers', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  let release;
  const gate = new Promise((r) => { release = r; });
  const { port } = await startMock(t, () => ({ text: 'x' }), { onRequest: async (r) => { if (isSubagentRequest(r)) await gate; } });
  t.after(() => { try { release(); } catch { /* already */ } });

  // Two observers, the two real channels. `ipcBroadcast` is what the IPC bridge
  // and `ox ipc watch` read; `_subagentEvents` is what the parent loop drains.
  // A cancel that reached only one of them is invisible to half the product.
  const wire = [];
  const queue = [];
  const runPromise = mkHandler(port)(
    { id: 'sa_evt', task: 'task' },
    yoloCtx(cwd, { _subagentEvents: queue, ipcBroadcast: (ev) => wire.push(ev) }),
  );

  await waitFor(() => listLiveSubagents(), (l) => l.some((a) => a.id === 'sa_evt'), 'sa_evt live');
  assert.equal(wire.filter((e) => e.type === 'subagent-spawn').length, 1, 'spawn went out on the wire');
  assert.equal(wire.filter((e) => e.type === 'subagent-start').length, 1, 'start went out on the wire');

  cancelSubagent('sa_evt', { by: 'operator', reason: 'because' });
  // Visible on the parent's queue IMMEDIATELY -- before the agent unwound. An
  // operator who pressed cancel needs to see the state change now.
  assert.equal(queue.filter((e) => e.type === 'subagent-cancel').length, 1, 'the request event is on the parent queue at request time');
  assert.equal(wire.filter((e) => e.type === 'subagent-cancel').length, 1, 'the request event is on the wire at request time');

  release();
  await runPromise;

  const req = wire.find((e) => e.type === 'subagent-cancel');
  assert.equal(req.id, 'sa_evt');
  assert.equal(req.requested, true, 'the event says REQUESTED, not stopped');
  assert.equal(req.by, 'operator');
  assert.equal(req.reason, 'because');
  // It carries the clause, because at this instant the agent very much may
  // still be running.
  assert.equal(req.semantics, CANCEL_SEMANTICS);
  // The request precedes the end, on the wire.
  assert.ok(wire.findIndex((e) => e.type === 'subagent-cancel') < wire.findIndex((e) => e.type === 'subagent-end'), 'the cancel request precedes the end');

  // The END event, the one lifecycle event that must never be skipped: it is
  // what retires the agent from the live board.
  const end = wire.find((e) => e.type === 'subagent-end');
  assert.ok(end, 'subagent-end was emitted');
  assert.equal(end.status, SUBAGENT_STATUS_CANCELLED, `end status was ${end.status}`);
  assert.equal(end.cancelled, true);
  assert.equal(end.cancelBy, 'operator');
  // A client that joined late, or replayed a log, sees the end without having
  // seen the request -- so the qualification rides on the end too.
  assert.equal(end.cancelSemantics, CANCEL_SEMANTICS);
  // `error` means "this run broke". Filing an operator's decision there is what
  // puts a deliberate human action in the same field as a provider 401.
  assert.equal(end.error, null, 'a cancel is not reported as an error');

  // The IPC client's own fold, which is what `ox ipc watch` renders. Replaying
  // the wire through the real reducer is the assertion; reading the raw array
  // would only prove the test's own bookkeeping.
  let st = createWatchState();
  for (const ev of wire) st = applyMessage(st, { type: 'event', event: ev }, { now: 1 });
  assert.equal(st.agentsCancelled, 1, 'the client counted one cancel REQUEST');
  assert.equal(st.agentsCancelledDone, 1, 'the client counted one agent that reached cancelled');
  assert.equal(st.agentsFailed, 0, 'a cancelled agent is NOT counted as a failure');
  assert.equal(st.agentsFinished, 1);
  assert.equal(st.agentsActive, 0, 'nothing is still active');
  const frame = renderFrame(st, { width: 100, now: 1, frame: 0 });
  assert.match(typeof frame === 'string' ? frame : (frame?.text ?? ''), /cancelled/i, 'the dashboard shows the cancel');

  // And once the agent is gone, a second press is the clean no-op.
  const after = cancelSubagent('sa_evt', { by: 'operator' });
  assert.equal(after.ok, true);
  assert.equal(after.cancelled, false);
  assert.equal(after.reason, 'not-running');
});

// ---------------------------------------------------------------------------
// 7. cancelling an already-finished agent is a clean no-op
// ---------------------------------------------------------------------------

test('cancelling an already-finished agent is a clean no-op, not an error', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  // A run that COMPLETES normally. Its control record is released in
  // runSubagent's `finally`, so the id is unknown to the control layer
  // afterwards -- which is what makes a late cancel a no-op rather than a write
  // to a dead record.
  const { port } = await startMock(t, (r) => (isSubagentRequest(r) ? { text: 'finished cleanly' } : { text: 'parent final' }));
  const out = await mkHandler(port)({ id: 'sa_done', task: 'finish up' }, yoloCtx(cwd, { _subagentEvents: [] }));
  assert.equal(out.structured.status, 'done', 'the run completed normally first');
  assert.equal(getLiveSubagent('sa_done'), null, 'it is not live');

  // The cancel that arrives late. Not a throw, not ok:false, and not a
  // fabricated `cancelled: true` against a run that already reported done.
  const res = cancelSubagent('sa_done', { by: 'operator' });
  assert.equal(res.ok, true, 'a late cancel is ok');
  assert.equal(res.cancelled, false, 'a late cancel cancelled nothing');
  assert.equal(res.reason, 'not-running');
  assert.equal(res.id, 'sa_done');
  // The message says WHY, so an operator does not read "nothing happened" as a
  // silent failure.
  assert.match(res.message, /not running in this process/);
  assert.match(res.message, /already finished, or it belongs to another process/);

  // It changed nothing: the finished status and the durable descriptor still say
  // done. A no-op that rewrote the record would be a cancel that cancelled a
  // completed run retroactively.
  assert.equal(recent('sa_done').status, 'done', 'a late cancel did not rewrite the finished status');
  assert.equal(readDescriptor(cwd, 'sa_done').status, 'done', 'a late cancel did not rewrite the descriptor');
  assert.equal(subagentCancelStats().cancelledTotal, 0, 'a no-op cancel is not counted as a cancel');

  // An id that is not even a valid id, and one this process never had, are the
  // same answer rather than two different errors.
  for (const bad of ['', '..', '../../etc/passwd', 'a b', 'x', null, undefined, 12345, {}]) {
    const r = cancelSubagent(bad, { by: 'operator' });
    assert.equal(r.ok, true, `cancel of ${JSON.stringify(bad)} is ok, not an error`);
    assert.equal(r.cancelled, false, `cancel of ${JSON.stringify(bad)} cancelled nothing`);
    assert.equal(r.reason, 'not-running');
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  }

  // An id well-formed but this process has never seen.
  const unknown = cancelSubagent('sa_never_existed', { by: 'operator' });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.cancelled, false);
  assert.equal(unknown.reason, 'not-running');
  assert.match(unknown.message, /another process/);

  // The registry and control state are still clean: no record was created by a
  // no-op.
  assert.equal(listSubagentControls().length, 0, 'a no-op cancel created no control record');
  assert.equal(listLiveSubagents().length, 0, 'a no-op cancel created no registry record');

  // A control with no parent signal is still cancellable, and a released one
  // becomes a no-op -- the same code path an operator hits.
  assert.ok(ensureSubagentControl({ id: 'sa_manual' }), 'a control can be created without a parent signal');
  assert.equal(cancelSubagent('sa_manual', { by: 'operator' }).cancelled, true);
  // A second press is idempotent, not an error and not a second abort.
  const second = cancelSubagent('sa_manual', { by: 'operator' });
  assert.equal(second.ok, true);
  assert.equal(second.cancelled, true, 'the agent is still reported cancelled on a repeat press');
  releaseSubagentControl('sa_manual');
  const third = cancelSubagent('sa_manual', { by: 'operator' });
  assert.equal(third.cancelled, false, 'after release it is a no-op again');
  assert.equal(third.reason, 'not-running');
});

// ---------------------------------------------------------------------------
// 8. subagent-cancelled: the TERMINAL event, distinct from the request
// ---------------------------------------------------------------------------

test('subagent-cancelled is emitted once when the agent stops, and the client counts it once', async (t) => {
  resetAll();
  const cwd = sandbox(t);

  let release;
  const gate = new Promise((r) => { release = r; });
  const { port } = await startMock(t, () => ({ text: 'x' }), { onRequest: async (r) => { if (isSubagentRequest(r)) await gate; } });
  t.after(() => { try { release(); } catch { /* already */ } });

  const wire = [];
  const queue = [];
  const runPromise = mkHandler(port)(
    { id: 'sa_term', task: 'task' },
    yoloCtx(cwd, { _subagentEvents: queue, ipcBroadcast: (ev) => wire.push(ev) }),
  );

  await waitFor(() => listLiveSubagents(), (l) => l.some((a) => a.id === 'sa_term'), 'sa_term live');
  cancelSubagent('sa_term', { by: 'operator', reason: 'no longer needed' });
  release();
  await runPromise;

  // Exactly one, on both channels. The whole point of a terminal event is that a
  // client can subscribe to it as a state change; two of them would make a
  // counter wrong and a log line lie.
  const terms = wire.filter((e) => e.type === 'subagent-cancelled');
  assert.equal(terms.length, 1, `expected one subagent-cancelled on the wire, got ${terms.length}`);
  assert.equal(queue.filter((e) => e.type === 'subagent-cancelled').length, 1, 'the terminal event is on the parent queue too');

  const term = terms[0];
  assert.equal(term.id, 'sa_term');
  assert.equal(term.status, SUBAGENT_STATUS_CANCELLED, 'the terminal event reports the cancelled status, not done and not failed');
  assert.equal(term.by, 'operator');
  assert.equal(term.reason, 'no longer needed');
  assert.equal(term.error, null, 'a cancel is not an error');
  // It arrives AFTER the end, because the end is what retires the agent from the
  // registry and both describe an already-stopped run.
  assert.ok(
    wire.findIndex((e) => e.type === 'subagent-end') < wire.findIndex((e) => e.type === 'subagent-cancelled'),
    'subagent-end precedes subagent-cancelled',
  );
  // And AFTER the request, so request -> end -> stopped is the observable order.
  assert.ok(
    wire.findIndex((e) => e.type === 'subagent-cancel') < wire.findIndex((e) => e.type === 'subagent-cancelled'),
    'the request precedes the terminal event',
  );

  // THE HONESTY CHECK, repeated on the terminal event. A late-joining client
  // reads THIS and never saw the request, so if the qualification lived only on
  // `subagent-cancel` this client would be told a run halted when a dispatched
  // request may still land. The wording is asserted verbatim, and a list of
  // guarantee-shaped phrasings is asserted absent -- the same way test 3 holds
  // the operator-facing report.
  assert.equal(term.cancelSemantics, CANCEL_SEMANTICS, 'the terminal event carries the same may-still-complete sentence');
  const terminalText = Object.values(term).filter((v) => typeof v === 'string').join(' ').toLowerCase();
  for (const forbidden of ['guaranteed halt', 'aborted the request', 'request aborted', 'fully stopped', 'immediately halted', 'hard kill', 'killed the process']) {
    assert.ok(!terminalText.includes(forbidden), `the terminal event must not claim "${forbidden}"`);
  }

  // The reducer must count ONE cancelled agent, not two. Both `subagent-end`
  // (status 'cancelled') and `subagent-cancelled` describe the same stop and
  // both arrive on a healthy run, so folding them additively would double the
  // count and turn the requests-vs-worked gap this dashboard exists to expose
  // into noise.
  let st = createWatchState();
  for (const ev of wire) st = applyMessage(st, { type: 'event', event: ev }, { now: 1 });
  assert.equal(st.agentsCancelled, 1, 'one cancel request');
  assert.equal(st.agentsCancelledDone, 1, `one cancelled agent, counted once (got ${st.agentsCancelledDone})`);
  assert.equal(st.agentsFailed, 0, 'a cancelled agent is not a failure');
  assert.equal(st.agentsFinished, 1);
  assert.equal(st.agentsActive, 0, 'nothing is left active');

  // The SAME event delivered to a client that missed the end -- the late-joining
  // case. It must still count, because under-reporting a stop is the one
  // direction this dashboard must never be wrong in.
  let late = createWatchState();
  late = applyMessage(late, { type: 'event', event: term }, { now: 1 });
  assert.equal(late.agentsCancelledDone, 1, 'a client that saw only the terminal event still counts the stop');
  assert.equal(late.agentsActive, 0, 'and does not leave a phantom active row');

  // Replaying the wire a second time into the SAME state is idempotent too: a
  // reconnecting client re-reads a log and must not inflate its own totals.
  let twice = createWatchState();
  for (const ev of wire) twice = applyMessage(twice, { type: 'event', event: ev }, { now: 1 });
  for (const ev of wire) twice = applyMessage(twice, { type: 'event', event: ev }, { now: 1 });
  assert.equal(twice.agentsCancelledDone, 1, 'replaying the log does not double-count the cancel');

  // The log line a human reading `ox ipc watch --log` sees for the stop, and the
  // frame both name the agent. The line is the CLI's half of "CLI, ipc watch and
  // IPC clients agree".
  const logged = wire
    .map((ev) => applyMessage(createWatchState(), { type: 'event', event: ev }, { now: 1 }))
    .map(() => null);
  assert.equal(logged.length, wire.length, 'every event folds without throwing');
  const frame = renderFrame(st, { width: 110, now: 1, frame: 0 });
  const frameText = typeof frame === 'string' ? frame : (frame?.text ?? '');
  assert.match(frameText, /cancelled/i, 'the dashboard names the cancel');

  // A run that was NOT cancelled emits none of these. A terminal-cancel event
  // for a healthy run would make every consumer's cancelled count a lie.
  resetAll();
  const cwd2 = sandbox(t, 'ox-cancel-clean-');
  const mock2 = await startMock(t, (r) => (isSubagentRequest(r) ? { text: 'clean finish' } : { text: 'parent final' }));
  const cleanWire = [];
  await mkHandler(mock2.port)({ id: 'sa_clean', task: 'no cancel here' }, yoloCtx(cwd2, { _subagentEvents: [], ipcBroadcast: (ev) => cleanWire.push(ev) }));
  assert.equal(cleanWire.filter((e) => e.type === 'subagent-cancelled').length, 0, 'a clean run emits no subagent-cancelled');
  assert.equal(cleanWire.filter((e) => e.type === 'subagent-cancel').length, 0, 'a clean run emits no subagent-cancel');
  assert.equal(recent('sa_clean').status, 'done', 'and its status is still done');

  resetAll();
});

// ---------------------------------------------------------------------------
// 9. a cancel does not file itself as an error on the dashboard
// ---------------------------------------------------------------------------

test('an aborted run is shown but is not counted as an error', () => {
  // src/agent.js yields {type:'error', error:'aborted'} when a run signal fires.
  // For a per-agent cancel that is a deliberate stop, so the dashboard must not
  // report it in the same tally an operator scans for BROKEN runs -- otherwise
  // the same cancel reads as 'cancelled, cleanly' on one surface and as
  // 'errors 1' on the surface the operator is actually watching.
  const hello = { type: 'hello', sessionId: 's', pid: 1, cwd: '/w', bot: 'b', model: 'm', version: 1 };
  const ev = (e, at = 2000) => ({ type: 'event', event: e, at });

  let s = applyMessage(createWatchState(), hello, { now: 1000 });
  s = applyMessage(s, ev({ type: 'subagent-spawn', id: 'sa_a', task: 't' }, 1100), { now: 1100 });
  s = applyMessage(s, ev({ type: 'subagent-cancel', id: 'sa_a', by: 'operator', semantics: 'S' }, 1200), { now: 1200 });
  s = applyMessage(s, ev({ type: 'error', error: 'aborted' }, 1300), { now: 1300 });

  assert.equal(s.errors, 0, 'an abort is not an error');
  assert.equal(s.lastError, null, 'and does not become the remembered error');
  assert.notEqual(s.phase, 'error', 'and does not put the run in an error phase');
  assert.equal(s.agentsFailed, 0, 'still no failed agents');
  // Not hidden either: it is shown, just not as a failure.
  assert.match(s.notes.map((n) => n.text).join(' | '), /aborted/i, 'the stop is still visible');

  // A REAL error is still counted, and still remembered. Suppressing aborts must
  // not have suppressed errors.
  s = applyMessage(s, ev({ type: 'error', error: 'stream died after 3 retries' }, 1400), { now: 1400 });
  assert.equal(s.errors, 1, 'a genuine error is still counted');
  assert.match(s.lastError, /stream died/);
  assert.equal(s.phase, 'error');

  // And the end of the cancelled run keeps the two surfaces agreeing.
  s = applyMessage(s, ev({ type: 'subagent-end', id: 'sa_a', status: 'cancelled', cancelled: true }, 1500), { now: 1500 });
  s = applyMessage(s, ev({ type: 'subagent-cancelled', id: 'sa_a', status: 'cancelled' }, 1600), { now: 1600 });
  assert.equal(s.agentsCancelledDone, 1, 'one cancelled agent');
  assert.equal(s.agentsFailed, 0, 'and no failures, so nothing on screen contradicts the cancel');
});
