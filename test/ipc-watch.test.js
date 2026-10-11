// Tests for `ox ipc watch`.
//
// The dashboard is split so the two halves can be graded without a terminal:
// createWatchState/applyMessage are a pure fold, renderFrame is a pure
// state -> string renderer, and only runWatch touches a socket. Everything
// asserted here is therefore a plain string or a plain object — no pty, no
// ANSI, no timing luck — except the ONE integration test at the bottom, which
// runs the real createIpcServer + connectIpcClient and answers a real approval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createIpcServer } from '../src/ipc.js';
import { createWatchState, applyMessage, renderFrame, runWatch, currentTool, activeAgents } from '../src/ipc-watch.js';

const T = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(emitter, event, timeoutMs = T) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, h); reject(new Error(`timed out on '${event}'`)); }, timeoutMs);
    const h = (...a) => { clearTimeout(timer); resolve(a); };
    emitter.once(event, h);
  });
}

async function waitFor(fn, { timeoutMs = T, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-watch-test-')); }

const hello = (over = {}) => ({
  type: 'hello', sessionId: 'sess-9f3', pid: 4242, cwd: '/Users/dev/work/proj',
  bot: 'ox-openrouter', model: 'openai/gpt-4o-mini', version: 1, ...over,
});
const event = (ev, at = 2000) => ({ type: 'event', event: ev, at });

// ---------------------------------------------------------------------------
// applyMessage: the fold, one message type at a time
// ---------------------------------------------------------------------------

test('applyMessage: hello carries session identity and starts the clock', () => {
  const s0 = createWatchState();
  const s1 = applyMessage(s0, hello(), { now: 1000 });

  assert.equal(s1.sessionId, 'sess-9f3');
  assert.equal(s1.bot, 'ox-openrouter');
  assert.equal(s1.model, 'openai/gpt-4o-mini');
  assert.equal(s1.cwd, '/Users/dev/work/proj');
  assert.equal(s1.pid, 4242);
  assert.equal(s1.version, '1');
  assert.equal(s1.connected, true);
  assert.equal(s1.phase, 'idle');
  assert.equal(s1.startedAt, 1000); // injected clock, not Date.now()
  assert.equal(s1.lastEventAt, 1000);

  // The input state is never mutated: this is a fold, not an accumulator.
  assert.equal(s0.connected, false);
  assert.equal(s0.sessionId, null);
  assert.deepEqual(s0, createWatchState());
});

test('applyMessage: hello with no clock leaves startedAt unknown rather than guessing', () => {
  const s1 = applyMessage(createWatchState(), hello());
  assert.equal(s1.startedAt, null);
  assert.equal(s1.lastEventAt, null);
  assert.equal(renderFrame(s1).includes('elapsed --'), true);
});

test('applyMessage: tool-start / tool-end track the current tool and count calls', () => {
  // The state is a KEYED MAP now (`st.tools`), not a single `st.tool` slot: a
  // slot cannot represent two things running at once, and subagent lifecycle
  // events make two-at-once the normal case rather than the hypothetical one.
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'tool-start', id: 'c1', name: 'edit_file', argsPreview: '{"file_path":"lib.js"}' }, 1100), { now: 1100 });
  assert.equal(currentTool(s).name, 'edit_file');
  assert.equal(currentTool(s).id, 'c1');
  assert.equal(Object.keys(s.tools).length, 1);
  assert.equal(s.phase, 'working');
  assert.equal(s.toolsTotal, 1);
  assert.deepEqual(s.toolCounts, { edit_file: 1 });

  s = applyMessage(s, event({ type: 'tool-end', id: 'c1', name: 'edit_file', ok: true, ms: 12 }, 1150), { now: 1150 });
  assert.equal(currentTool(s), null);
  assert.deepEqual(s.tools, {});
  assert.equal(s.phase, 'idle');
  assert.equal(s.errors, 0);
  assert.equal(s.toolsTotal, 1); // a tool-end never double-counts the call

  s = applyMessage(s, event({ type: 'tool-end', id: 'c2', name: 'bash', ok: false, isError: true, ms: 3 }, 1200), { now: 1200 });
  assert.equal(s.errors, 1);
  assert.equal(s.lastError, 'bash failed');
  assert.deepEqual(s.toolCounts, { edit_file: 1 });

  const frame = renderFrame(s, { color: false, now: 1200 });
  assert.match(frame, /tools 1/);
  assert.match(frame, /errors 1/);
});

test('applyMessage: usage is a delta, usage-total is a snapshot — no double counting', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'usage', inputTokens: 20000, outputTokens: 1000, costUsd: 0.005 }, 1100), { now: 1100 });
  s = applyMessage(s, event({ type: 'usage', inputTokens: 1860, outputTokens: 204, costUsd: 0.0011 }, 1200), { now: 1200 });

  // Hand-computed: the two deltas sum.
  assert.equal(s.tokensIn, 21860);
  assert.equal(s.tokensOut, 1204);
  assert.equal(s.costUsd, 0.0061);
  assert.equal(s.costKnown, true);

  // usage-total repeats the same figures cumulatively. It must RAISE the running
  // value at most, never add on top of it: 21860/1204, not 43720/2408.
  s = applyMessage(s, event({ type: 'usage-total', inputTokens: 21860, outputTokens: 1204, costUsd: 0.0061, auxInputTokens: 300, auxOutputTokens: 40, model: 'openai/gpt-4o-mini' }, 1300), { now: 1300 });
  assert.equal(s.tokensIn, 21860);
  assert.equal(s.tokensOut, 1204);
  assert.equal(s.costUsd, 0.0061);
  assert.equal(s.auxIn, 300);
  assert.equal(s.auxOut, 40);
  assert.equal(s.sawTotal, true);

  // A total that is genuinely larger (a call whose usage event never arrived)
  // still wins.
  s = applyMessage(s, event({ type: 'usage-total', inputTokens: 30000, outputTokens: 1500, costUsd: 0.01 }, 1400), { now: 1400 });
  assert.equal(s.tokensIn, 30000);
  assert.equal(s.tokensOut, 1500);
  assert.equal(s.costUsd, 0.01);

  const frame = renderFrame(s, { color: false, now: 1400 });
  assert.match(frame, /in 30,000/);
  assert.match(frame, /out 1,500/);
  assert.match(frame, /est\. \$0\.0100/);
});

test('applyMessage: aux usage counts toward the totals and is broken out', () => {
  let s = createWatchState();
  s = applyMessage(s, event({ type: 'usage', inputTokens: 100, outputTokens: 10, costUsd: 0.001, aux: true }, 100));
  assert.equal(s.tokensIn, 100);
  assert.equal(s.auxIn, 100);
  assert.equal(s.auxOut, 10);
});

test('applyMessage: a redacted token count is unknown, never zero', () => {
  // This is what a REAL bridge sends: sanitizeForWire masks any key matching
  // /token/i, so the counters arrive as the string '[redacted]'.
  let s = applyMessage(createWatchState(), event({
    type: 'usage', inputTokens: '[redacted]', outputTokens: '[redacted]', costUsd: 0.0061,
  }, 2000), { now: 2000 });
  assert.equal(s.tokensUnknown, true);
  assert.equal(s.tokensIn, 0);
  assert.equal(s.costUsd, 0.0061);

  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /in \?\s+out \?/);
  assert.match(frame, /est\. \$0\.0061/);
  assert.match(frame, /redacted/);
  assert.doesNotMatch(frame, /in 0\s+out 0/);

  // A later frame that DOES carry numbers clears the question mark.
  // A later frame that DOES carry real numbers wins: the caveat stays on screen
  // because the totals may be short, but the numbers are shown.
  s = applyMessage(s, event({ type: 'usage-total', inputTokens: 21860, outputTokens: 1204, costUsd: 0.0062 }, 3000), { now: 3000 });
  assert.equal(s.tokensIn, 21860);
  assert.equal(s.tokensOut, 1204);
  const healed = rendered(s, { now: 3000 });
  assert.match(healed, /in 21,860\s+out 1,204/);
  assert.match(healed, /redacted/, 'the caveat must survive the numbers arriving');
});

test('applyMessage: turn-end counts a turn, error counts an error', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'turn-end', stopReason: 'stop', iters: 5 }, 2000), { now: 2000 });
  assert.equal(s.turns, 1);
  assert.equal(s.lastStopReason, 'stop');
  assert.equal(s.phase, 'done');

  s = applyMessage(s, event({ type: 'error', error: 'provider ollama failure: refused' }, 2100), { now: 2100 });
  assert.equal(s.errors, 1);
  assert.equal(s.lastError, 'provider ollama failure: refused');
  assert.equal(s.phase, 'error');
  assert.match(renderFrame(s, { color: false }), /errors 1/);
});

test('applyMessage: text-delta keeps a bounded tail and never grows the state', () => {
  let s = createWatchState();
  for (let i = 0; i < 2000; i++) s = applyMessage(s, event({ type: 'text-delta', text: 'abc' }, 1000 + i), { now: 1000 + i });
  assert.ok(s.tail.length <= 1600, `tail grew to ${s.tail.length}`);
  assert.equal(s.phase, 'working');
  assert.equal(s.tokensIn, 0);
});

test('applyMessage: approval-request queues a pending approval with a hold window', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, {
    type: 'approval-request', id: 'ap-1', tool: 'edit_file',
    args: { file_path: 'lib.js', old_string: 'return 41', new_string: 'return 42' },
    argsPreview: '{"file_path":"lib.js"}', cwd: '/work/proj',
    at: 2000, deadlineAt: 115000 + 2000,
  }, { now: 2000 });

  assert.equal(s.approvals.length, 1);
  const a = s.approvals[0];
  assert.equal(a.id, 'ap-1');
  assert.equal(a.tool, 'edit_file');
  assert.equal(a.state, 'pending');
  assert.equal(a.holdMs, 115000);
  assert.equal(a.arrivedAt, 2000);
  assert.equal(s.phase, 'waiting');
});

test('applyMessage: a new approval supersedes the pending one, mirroring the server', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  const req = (id, at) => ({ type: 'approval-request', id, tool: 'bash', args: { command: 'ls' }, at, deadlineAt: at + 1000 });
  s = applyMessage(s, req('ap-1', 2000), { now: 2000 });
  s = applyMessage(s, req('ap-2', 3000), { now: 3000 });

  assert.equal(s.approvals.length, 2);
  assert.equal(s.approvals[0].state, 'superseded');
  assert.equal(s.approvals[1].state, 'pending');
});

test('applyMessage: approval-answer settles the matching request and is remembered', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, { type: 'approval-request', id: 'ap-1', tool: 'edit_file', args: {}, at: 2000, deadlineAt: 3000 }, { now: 2000 });
  s = applyMessage(s, { type: 'approval-answer', id: 'ap-1', decision: 'allow', at: 2500 }, { now: 2500 });

  assert.equal(s.approvals[0].state, 'answered');
  assert.equal(s.approvals[0].decision, 'allow');
  assert.deepEqual(s.lastAnswer, { id: 'ap-1', decision: 'allow', at: 2500 });
  assert.equal(s.phase, 'idle');

  // An answer for an id nobody is holding is recorded, not thrown.
  s = applyMessage(s, { type: 'approval-answer', id: 'nope', decision: 'deny', at: 2600 }, { now: 2600 });
  assert.equal(s.lastAnswer.decision, 'deny');
});

test('applyMessage: pong counts liveness without disturbing the view', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'usage', inputTokens: 5, outputTokens: 1 }, 2000), { now: 2000 });
  s = applyMessage(s, { type: 'pong', at: 2100 }, { now: 2100 });
  assert.equal(s.pongs, 1);
  assert.equal(s.lastPongAt, 2100);
  assert.equal(s.tokensIn, 5);
});

test('applyMessage: garbage leaves the state unchanged and never throws', () => {
  const base = applyMessage(createWatchState(), hello(), { now: 1000 });
  const frozen = JSON.stringify(base);

  for (const junk of [
    null, undefined, 0, '', 'hello', 42, true, [], [1, 2, 3], new Date(0),
    {}, { type: '' }, { type: 123 }, { type: 'nonsense' }, { type: 'EVENT' },
    { type: 'event' }, { type: 'event', event: null }, { type: 'event', event: 'nope' },
    { type: 'event', event: 7 }, { type: 'approval-result' }, { type: 'frame' },
  ]) {
    const next = applyMessage(base, junk, { now: 9999 });
    assert.deepEqual(next, base, `state changed for ${JSON.stringify(junk)}`);
    assert.equal(JSON.stringify(base), frozen, `input state mutated by ${JSON.stringify(junk)}`);
  }

  // A recognised frame with every field missing is still a frame: it must be
  // absorbed, not thrown, and it must not invent a session out of nothing.
  for (const partial of [{ type: 'hello' }, { type: 'pong' }, { type: 'approval-answer' }]) {
    assert.doesNotThrow(() => applyMessage(base, partial, { now: 9999 }));
  }
  assert.equal(applyMessage(base, { type: 'hello' }, { now: 9999 }).sessionId, 'sess-9f3',
    'an empty hello must not erase what the dashboard already knows');

  // An unknown inner event is a note, not a throw: protocol drift is a fact
  // about the run and the human at the dashboard is who needs to see it.
  const drifted = applyMessage(base, event({ type: 'brand-new-event', x: 1 }, 3000), { now: 3000 });
  assert.equal(drifted.unknownEvents, 1);
  assert.match(rendered(drifted), /brand-new-event/);
});

test('applyMessage: the notes window is bounded', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  for (let i = 0; i < 50; i++) s = applyMessage(s, event({ type: 'tool-end', id: `c${i}`, name: 'bash', ok: true, ms: 1 }, 2000 + i), { now: 2000 + i });
  assert.equal(s.notes.length, 3);
  assert.ok(s.notes.every((n) => typeof n.text === 'string'));
});

test('applyMessage: an approval queue is bounded but never drops a pending hold', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  for (let i = 0; i < 100; i++) {
    s = applyMessage(s, { type: 'approval-request', id: `ap-${i}`, tool: 'bash', args: {}, at: 2000 + i, deadlineAt: 3000 + i }, { now: 2000 + i });
    s = applyMessage(s, { type: 'approval-answer', id: `ap-${i}`, decision: 'deny', at: 2100 + i }, { now: 2100 + i });
  }
  assert.ok(s.approvals.length <= 32, `queue grew to ${s.approvals.length}`);
  assert.equal(s.approvals.some((a) => a.state === 'pending'), false);
});

test('applyMessage: the history frame is folded to nothing', () => {
  const base = applyMessage(createWatchState(), hello(), { now: 1000 });
  const s = applyMessage(base, event({ type: 'history', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }, 2000), { now: 2000 });
  assert.notEqual(s, base, 'the fold must still hand back a fresh object');
  assert.deepEqual(s, base, 'the transcript must not leak into the view');
});

// ---------------------------------------------------------------------------
// renderFrame
// ---------------------------------------------------------------------------

function rendered(state, opts = {}) {
  return renderFrame(state, { color: false, ...opts });
}

test('renderFrame: shows session id, model, tool, tokens and elapsed', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  for (let i = 1; i <= 5; i++) s = applyMessage(s, event({ type: 'turn-end', stopReason: 'tool_use', iters: i }, 1000 + i), { now: 1000 + i });
  s = applyMessage(s, event({ type: 'tool-start', id: 'c1', name: 'edit_file', argsPreview: '{"file_path":"lib.js"}' }, 64000), { now: 64000 });
  s = applyMessage(s, event({ type: 'usage', inputTokens: 21860, outputTokens: 1204, costUsd: 0.0061 }, 64000), { now: 64000 });

  const frame = rendered(s, { now: 1000 + 64_000, frame: 0 });
  assert.match(frame, /sess-9f3/);
  assert.match(frame, /pid 4242/);
  assert.match(frame, /ox-openrouter:openai\/gpt-4o-mini/);
  assert.match(frame, /edit_file/);
  assert.match(frame, /lib\.js/);
  assert.match(frame, /in 21,860/);
  assert.match(frame, /out 1,204/);
  assert.match(frame, /est\. \$0\.0061/);
  assert.match(frame, /elapsed 1m 04s/);
  assert.match(frame, /turns\s+5/);
  assert.match(frame, /working/);
});

test('renderFrame: the approval panel appears only when a request is pending', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'tool-start', id: 'c1', name: 'edit_file', argsPreview: '{"file_path":"lib.js"}' }, 2000), { now: 2000 });

  assert.doesNotMatch(rendered(s, { now: 2000 }), /APPROVAL NEEDED/);

  s = applyMessage(s, {
    type: 'approval-request', id: 'ap-1', tool: 'edit_file',
    args: { file_path: 'lib.js', old_string: 'return 41', new_string: 'return 42' },
    at: 2000, deadlineAt: 2000 + 115000,
  }, { now: 2000 });

  const frame = rendered(s, { now: 2000 + 4000, frame: 2 });
  assert.match(frame, /APPROVAL NEEDED/);
  assert.match(frame, /ap-1 · edit_file/);
  assert.match(frame, /1m 51s left/); // 115s hold, 4s elapsed
  assert.match(frame, /edit_file/);
  assert.match(frame, /lib\.js/);
  assert.match(frame, /- old_string: "return 41"/);
  assert.match(frame, /\+ new_string: "return 42"/);
  assert.match(frame, /\[a\]llow\s+\[d\]eny\s+\[s\]kip \(ask again\)\s+\[q\]uit/);
  assert.match(frame, /awaiting approval/);

  // Every box row is the same width, so the panel never leaves a ragged edge.
  const box = frame.split('\n').filter((l) => /[┌│├└]/.test(l));
  assert.ok(box.length >= 4, `expected a panel, got ${box.length} box lines`);
  assert.equal(new Set(box.map((l) => [...l].length)).size, 1, 'box rows are not all the same width');

  // Answering it takes the panel down and leaves the verdict visible.
  s = applyMessage(s, { type: 'approval-answer', id: 'ap-1', decision: 'allow', at: 6000 }, { now: 6000 });
  const after = rendered(s, { now: 6000 });
  assert.doesNotMatch(after, /APPROVAL NEEDED/);
  assert.match(after, /no approvals pending/);
  assert.match(after, /last answer {2}allow ap-1/);
});

test('renderFrame: the served model wins over the announced one', () => {
  // hello describes the CONFIGURED bot; a usage event names what actually served
  // the turn. A run started with --bot must not be shown as the default bot.
  let s = applyMessage(createWatchState(), hello({ bot: 'ox-grok', model: 'grok-4.6' }), { now: 1000 });
  assert.match(rendered(s, { now: 1000 }), /ox-grok:grok-4\.6/, 'with no override, the announced pair stands');

  s = applyMessage(s, event({ type: 'usage', inputTokens: 10, outputTokens: 1, model: 'qwen2.5:0.5b' }, 2000), { now: 2000 });
  assert.equal(s.servedModel, 'qwen2.5:0.5b');
  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /qwen2\.5:0\.5b/);
  assert.doesNotMatch(frame, /ox-grok:grok-4\.6/, 'must not pair the default bot with the served model');
  assert.match(frame, /served by qwen2\.5:0\.5b, not grok-4\.6/);
});

test('renderFrame: a truncated preview never becomes the tool target', () => {
  const half = '{"new_string":"return k(this).then(function(a){ console.log(a) })';
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, event({ type: 'tool-start', id: 'c1', name: 'edit_file', argsPreview: half }, 2000), { now: 2000 });
  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /tool {4}edit_file\n/, 'the status line should not carry half a JSON blob');
  assert.doesNotMatch(frame, /then\(function/);
});

test('renderFrame: a closed bridge says closed, not connecting', () => {
  assert.match(rendered(createWatchState()), /waiting for a bridge/);
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  assert.match(rendered(s), /no approvals pending/);
  s = { ...s, phase: 'disconnected', connected: false };
  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /bridge closed/);
  assert.match(frame, /disconnected/);
});

test('renderFrame: the idle/waiting state is readable with nothing pending', () => {
  const fresh = createWatchState();
  const connecting = rendered(fresh, { now: null });
  assert.match(connecting, /waiting for a bridge/);
  assert.match(connecting, /unknown model/);

  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  const ready = rendered(s, { now: 1000 });
  assert.match(ready, /ready/);
  // With nothing running there is nothing to cancel, so the footer does not
  // advertise a key that would do nothing. The cancel hint is asserted in its
  // own test below rather than being assumed here.
  assert.match(ready, /no approvals pending · q to quit/);
  assert.doesNotMatch(ready, /press x to cancel/);
  assert.doesNotMatch(ready, /APPROVAL NEEDED/);
  assert.doesNotMatch(ready, /elapsed --/);

  s = applyMessage(s, event({ type: 'text-delta', text: 'thinking' }, 2000), { now: 2000 });
  assert.match(rendered(s, { now: 2000 }), /working/);

  s = applyMessage(s, event({ type: 'error', error: 'stream died' }, 3000), { now: 3000 });
  const failed = rendered(s, { now: 3000 });
  assert.match(failed, /error/);
  assert.match(failed, /errors 1/);
  assert.match(failed, /stream died/);
});

test('renderFrame: a disconnected bridge says so', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = { ...s, phase: 'disconnected', connected: false };
  const frame = rendered(s, { now: 9000 });
  assert.match(frame, /disconnected/);
  assert.match(frame, /elapsed 8s/);
});

test('renderFrame: no ANSI when colour is disabled, colour when it is not', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, {
    type: 'approval-request', id: 'ap-1', tool: 'edit_file',
    args: { file_path: 'lib.js', old_string: 'a', new_string: 'b' },
    at: 2000, deadlineAt: 121000,
  }, { now: 2000 });

  // The disabled branch is a hard guarantee of the renderer, independent of the
  // terminal it happens to be running under.
  assert.doesNotMatch(renderFrame(s, { color: false }), /\u001b/);
  assert.doesNotMatch(renderFrame(s, {}), /\u001b/);

  // ...and the enabled branch really does paint, so the no-ANSI assertion above
  // is testing a branch and not a process that happens to be colourless.
  const wasTTY = process.stdout.isTTY;
  const hadNoColor = process.env.NO_COLOR;
  try {
    process.stdout.isTTY = true;
    delete process.env.NO_COLOR;
    const painted = renderFrame(s, { color: true });
    assert.match(painted, /\u001b\[/);
    assert.match(painted, /APPROVAL NEEDED/);

    // NO_COLOR is honoured without any flag, which is what the CLI promises.
    process.env.NO_COLOR = '1';
    assert.doesNotMatch(renderFrame(s, { color: true }), /\u001b/);
  } finally {
    if (wasTTY === undefined) delete process.stdout.isTTY;
    else process.stdout.isTTY = wasTTY;
    if (hadNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = hadNoColor;
  }
});

test('renderFrame: width is honoured and the frame never exceeds it', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, {
    type: 'approval-request', id: 'ap-1', tool: 'edit_file',
    args: { file_path: 'lib.js', old_string: 'return 41', new_string: 'return 42' },
    at: 2000, deadlineAt: 121000,
  }, { now: 2000 });
  for (const width of [40, 60, 72, 100, 120]) {
    const frame = rendered(s, { width, now: 2000 });
    for (const line of frame.split('\n')) {
      assert.ok([...line].length <= width, `width ${width} exceeded by ${[...line].length}: ${line}`);
    }
  }
});

test('renderFrame: a huge argument set is summarised, not dumped', () => {
  const args = { file_path: 'lib.js' };
  for (let i = 0; i < 40; i++) args[`k${i}`] = `v${i}`;
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, { type: 'approval-request', id: 'ap-1', tool: 'edit_file', args, at: 2000, deadlineAt: 121000 }, { now: 2000 });
  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /more arguments/);
  assert.doesNotMatch(frame, /k39/);
});

test('renderFrame: an unparseable preview degrades instead of failing', () => {
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, { type: 'approval-request', id: 'ap-1', tool: 'bash', argsPreview: '{"command":"rm -rf /tmp/x', at: 2000, deadlineAt: 121000 }, { now: 2000 });
  const frame = rendered(s, { now: 2000 });
  assert.match(frame, /APPROVAL NEEDED/);
  assert.match(frame, /rm -rf \/tmp\/x/);
});

// ---------------------------------------------------------------------------
// THE integration test: a real bridge, a real client, a real approval answered
// from the keyboard path runWatch actually uses.
// ---------------------------------------------------------------------------

test('integration: a real bridge drives the view, and the keyboard answers a real approval', async (t) => {
  const dir = mkdtemp();
  const socketPath = path.join(dir, 'w.sock');
  const server = createIpcServer({
    socketPath,
    sessionId: 'live-sess',
    approvalTimeoutMs: 3000,
    meta: { bot: 'ox-ollama', model: 'qwen2.5:0.5b', cwd: dir, version: '0.1.0' },
  });
  t.after(() => new Promise((r) => { server.close(r); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }));
  await once(server, 'listening');

  // A TTY-shaped stdout that keeps every write, so the frames are inspectable,
  // and a stdin that is a real EventEmitter so 'data' is a real keypress.
  const written = [];
  const output = new EventEmitter();
  output.isTTY = true;
  output.columns = 78;
  output.write = (s) => { written.push(String(s)); return true; };
  const input = new EventEmitter();
  input.isTTY = true;
  const rawCalls = [];
  input.setRawMode = (on) => { rawCalls.push(on); input.isRaw = on; return input; };
  input.resume = () => {};
  input.pause = () => {};

  const watching = runWatch({ socketPath, output, input, fps: 60, width: 78, color: false, disconnectLingerMs: 0 });
  const clientConnected = once(server, 'client-connected');
  await clientConnected;

  // Drive it exactly the way a run does: events through broadcast, an approval
  // through requestApproval.
  server.broadcast({ type: 'tool-start', id: 'c1', name: 'edit_file', argsPreview: '{"file_path":"lib.js"}' });
  server.broadcast({ type: 'usage', inputTokens: 21860, outputTokens: 1204, costUsd: 0.0061, model: 'qwen2.5:0.5b' });

  const held = once(server, 'approval-request');
  // NOTE: a real bridge puts the real counters on the wire. isSecretKey() in
  // src/ipc.js checks the SAFE_METRIC_KEYS allowlist — which contains
  // 'input_tokens'/'output_tokens' — BEFORE the secret-key regex ever runs, so
  // the counters are numbers here and the live view must show them. A count
  // that genuinely arrives redacted or absent still renders as '?'; that is
  // defensive behaviour covered by a unit test above, not what this bridge does.
  const verdict = server.requestApproval({
    tool: 'edit_file',
    args: { file_path: 'lib.js', old_string: 'return 41', new_string: 'return 42' },
    cwd: dir,
  });

  const request = (await held)[0];
  assert.equal(request.id, 'ap-1');
  assert.equal(request.tool, 'edit_file');

  // The dashboard is showing the hold, with the real tool and real arguments.
  await waitFor(() => lastFrame(written).includes('APPROVAL NEEDED'), { what: 'the approval panel to draw' });
  const panel = lastFrame(written);
  assert.match(panel, /live-sess/);
  assert.match(panel, /ox-ollama:qwen2\.5:0\.5b/);
  assert.match(panel, /edit_file/);
  assert.match(panel, /est\. \$0\.0061/);
  // renderFrame formats the counters through withCommas(), so a total that
  // really crossed the wire reads as grouped digits. Require the digits, and
  // forbid both '?' and the redaction caveat: a partially-broken redaction that
  // sent one counter but not the other must not pass.
  assert.match(panel, /in 21,860\s+out 1,204/, 'the allowlisted token totals must reach the live view as numbers');
  assert.doesNotMatch(panel, /in \?\s+out \?/, 'a real bridge sends real counters, so nothing renders as unknown');
  assert.doesNotMatch(panel, /token counts arrive redacted/, 'the redaction caveat must not be on screen when the numbers are there');
  assert.match(panel, /APPROVAL NEEDED/);
  assert.match(panel, /- old_string: "return 41"/);

  // Press 'a'. This is the same byte a human's keypress produces.
  input.emit('data', 'a');
  assert.equal(await verdict, 'allow');
  assert.equal(request.resolve.length >= 0, true);

  const settled = await waitFor(() => lastFrame(written).includes('last answer  allow ap-1'), { what: 'the allow to show in the frame' });
  assert.equal(settled, true);
  assert.doesNotMatch(lastFrame(written), /APPROVAL NEEDED/);

  // Let the bridge go: the dashboard must clear its region, restore the cursor,
  // and resolve rather than hang.
  const sawDisconnect = once(server, 'client-disconnected');
  input.emit('data', 'q');
  const result = await watching;
  assert.equal(result.reason, 'quit');
  assert.equal(result.answered, 'allow');
  await sawDisconnect;
  const tail = written.join('');
  assert.match(tail, /\u001b\[\?25l/, 'cursor was never hidden');
  assert.match(tail, /\u001b\[\?25h/, 'cursor was never restored');
  assert.match(tail, /\u001b\[J/, 'region was never cleared');
  assert.deepEqual(rawCalls, [true, false], 'raw mode must be entered and then given back');
});

test('integration: runWatch refuses, rather than spinning, when no bridge is listening', async () => {
  const dir = mkdtemp();
  try {
    await assert.rejects(
      () => runWatch({ socketPath: path.join(dir, 'absent.sock'), connectTimeoutMs: 300 }),
      /no ox ipc bridge is listening/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The last complete frame in the byte stream. Frames are separated by the
// cursor-up sequence, so the tail after the last one is exactly the last frame.
function lastFrame(written) {
  const all = written.join('');
  const parts = all.split(/\u001b\[\d+A/);
  return parts[parts.length - 1].replace(/\r/g, '').replace(/\u001b\[K/g, '');
}

// The cancel key has to be discoverable without reading the source, which is the
// whole point of putting it in the idle footer. It also has to DISAPPEAR once
// every live agent has already been cancelled: advertising "press x to cancel" for
// an agent that is already unwinding invites a second press, and the second press
// is a no-op that the operator would read as a broken dashboard.
test('renderFrame: the footer names the cancel key only while something is cancellable', () => {
  const foot = (st, now) => (rendered(st, { now }).match(/no approvals pending.*/) ?? [''])[0];

  const base = applyMessage(createWatchState(), hello(), { now: 1000 });
  assert.doesNotMatch(foot(base, 1000), /press x/, 'no live agent, no cancel hint');

  const one = applyMessage(base, event({ type: 'subagent-spawn', id: 'sa_a', task: 't' }, 1100), { now: 1100 });
  assert.match(foot(one, 1100), /press x to cancel sa_a/, 'the hint names the agent and the key');

  const two = applyMessage(one, event({ type: 'subagent-spawn', id: 'sa_b', task: 't' }, 1150), { now: 1150 });
  assert.match(foot(two, 1150), /2 agents/, 'with several live it says how many');

  // Once it is cancelling, the hint is gone -- the operator has nothing left to
  // do about this one.
  const cancelling = applyMessage(two, event({ type: 'subagent-cancel', id: 'sa_a', by: 'operator', semantics: 'S' }, 1200), { now: 1200 });
  assert.match(foot(cancelling, 1200), /press x to cancel sa_b/, 'the other agent is still cancellable');
  const allCancelling = applyMessage(cancelling, event({ type: 'subagent-cancel', id: 'sa_b', by: 'operator', semantics: 'S' }, 1300), { now: 1300 });
  assert.doesNotMatch(foot(allCancelling, 1300), /press x/, 'nothing left to cancel, so no hint');
});
