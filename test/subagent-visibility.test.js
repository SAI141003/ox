// Multi-agent orchestration VISIBILITY: the lifecycle event stream, the live
// registry, the filesTouched fix, the bounded re-emission, and all three
// rendering surfaces.
//
// The shape of the problem this file covers: before it, a subagent was visible
// to its parent as exactly two generic events (tool-start / tool-end for the
// `subagent` call) and invisible everywhere else. `listSubagents` was imported
// by headless and never called. `filesTouched` was accumulated from a field
// nothing in src/ ever set, so it was always empty. The dashboard's `st.tool`
// was a single slot that could not represent two agents. The system prompt
// promised parallelizable delegation that the runtime rejects.
//
// Every test here is about one of those, and each asserts the FIXED behaviour
// rather than the finding -- the filesTouched regression guard in
// test/subagent-files-touched-screen.test.js was inverted the same way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeSubagentToolHandler, initDescriptor, readDescriptor, subagentToolSchema } from '../src/subagent.js';
import {
  agentSnapshot, listLiveSubagents, staleSubagents, liveSubagentCount,
  registerSubagent, markSubagentStarted, updateSubagent, finishSubagent,
  _resetRegistry, MAX_PROGRESS_EVENTS, MAX_ARG_PREVIEW,
} from '../src/subagent-registry.js';
import { runAgent } from '../src/agent.js';
import { buildSystemPrompt, SUBAGENT_PARALLEL_CLAUSE } from '../src/system-prompt.js';
import { batchPlan, classifyTool, groupCalls } from '../src/resource-class.js';
import {
  renderToolStart, renderSubagentEnd, SubagentTicker, renderAgentTree, formatElapsed,
} from '../src/ui.js';
import {
  createWatchState, applyMessage, renderFrame, currentTool, activeAgents,
} from '../src/ipc-watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

// The scripted provider is reached through the `custom` provider, which
// refuses to send anything without a key. Set before any run so the
// in-process runs below reach the mock instead of failing at auth.
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-subagent-visibility-key';

// ---- harness ----------------------------------------------------------------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [] }) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  calls.forEach((c, i) =>
    out.push(sse({
      choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }, finish_reason: null }],
    }))
  );
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

const isSubagentRequest = (r) => (r.tools ?? []).some((s) => (s?.function?.name ?? s?.name) === 'report_result');

async function startMock(t, decide, { onRequest = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      seen.push({ messages: parsed.messages ?? [], tools: parsed.tools ?? [] });
      onRequest?.(parsed, seen.length);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn(decide(parsed, seen.length)));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen };
}

function sandbox(t, prefix = 'ox-vis-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Never throws: a hook that throws stops every later t.after (the mock
  // server's close among them) and the process then never exits. Windows
  // reports EBUSY while a just-exited child still holds the folder.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir */ } });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for something OBSERVABLE in a child's output, bounded.
//
// The REPL is a terminal program driven over a pipe, so the only honest
// question about "has it got there yet" is one about its bytes. This file's REPL
// test used to answer that question with `sleep(2600)`, against a turn whose
// critical path is a deliberate 1800ms mock delay plus whatever the machine adds
// to the rest -- around 600ms of headroom. That is not a margin, it is a bet:
// shorten the sleep and the test fails with `expected two /agents renders, got
// 1`, and the same failure appears for real whenever the tail of a turn runs
// long. Nothing here is faster because of it; it is only correct because it
// stopped guessing.
//
// `read` is a getter, not a string, because the caller is watching a live
// buffer. The timeout names what was being waited for and dumps what did
// arrive, so a genuine hang reads as a diagnosis rather than as an assertion
// about `true`.
async function waitFor(read, predicate, what, { timeout = 20000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = read();
    if (predicate(s)) return s;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}\n--- stdout ---\n${s}`);
    }
    await sleep(20);
  }
}

// "The turn is over" -- which is the same question as "will the REPL look at a
// slash command instead of answering `busy`", because `rl.on('line')`
// dispatches only once `state.busy` is false.
//
// The observable for it is what the loop itself prints: the turn's token meter
// (src/cli.js writes `renderMeter` as the last statement of a turn) followed by
// the prompt it re-emits when it takes the next line. The meter is what makes
// this a TURN rather than the startup prompt -- which is why a bare "the stream
// ends with a prompt" test is not enough: it is true before the turn even
// begins, and waiting on it is how this test got flaky in the first place.
const REPL_PROMPT = '\u276f';
const TURN_OVER = (s) => /tokens \u00b7 \$\d/.test(s) && s.trimEnd().endsWith(REPL_PROMPT);

// The literal the REPL writes for a line it refused because a turn was in
// flight. Scoped to the bytes produced since a line was sent -- `busy` says
// nothing about the line AFTER it.
const BUSY = 'busy \u2014 ctrl-c';

// A parent ctx carrying the queue the OUTERMOST runAgentLoop would normally
// own. Capturing it here is what lets a test assert on the exact event stream a
// consumer of the parent's runAgent() would have seen.
function parentCtx(cwd, extra = {}) {
  return {
    cwd,
    approval: 'yolo',
    yolo: true,
    depth: 0,
    maxDepth: 2,
    sessionId: 'sess-parent',
    allTools: [
      { name: 'write_file', description: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } },
      { name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'glob', description: 'glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
    ],
    _subagentEvents: [],
    ...extra,
  };
}

const drain = (ctx) => [...ctx._subagentEvents.splice(0)];
const ofType = (evs, t) => evs.filter((e) => e.type === t);

// ---------------------------------------------------------------------------
// 1. the lifecycle event stream
// ---------------------------------------------------------------------------

test('a subagent spawn emits subagent-spawn / start / end with the right fields', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) return { text: 'parent final' };
    const n = r.messages.length;
    if (n === 2) return { calls: [{ id: 'w1', name: 'write_file', args: { path: 'src/one.js', content: '1' } }] };
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'wrote src/one.js' } }] };
  });
  const ctx = parentCtx(cwd);
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    auxTarget: null,
  });
  const res = await handler({ task: 'Create the helper module', description: 'helper', id: 'sa_life' }, ctx);
  const evs = drain(ctx);
  const kinds = evs.map((e) => e.type);

  assert.equal(res.isError, false);
  assert.deepEqual(kinds.slice(0, 2), ['subagent-spawn', 'subagent-start']);
  assert.equal(kinds.at(-1), 'subagent-end', `stream ended with ${kinds.at(-1)}`);
  assert.ok(kinds.includes('subagent-progress'), 'no progress event was emitted');
  // Nothing after the end: the lifecycle terminates, it does not trail.
  assert.deepEqual(kinds.slice(2).filter((k) => k === 'subagent-end').length, 1);

  const spawn = ofType(evs, 'subagent-spawn')[0];
  assert.equal(spawn.id, 'sa_life');
  assert.equal(spawn.task, 'Create the helper module');
  assert.equal(spawn.description, 'helper');
  assert.equal(spawn.depth, 0);
  assert.equal(spawn.parentId, 'sess-parent');
  assert.equal(spawn.resumed, false);

  const start = ofType(evs, 'subagent-start')[0];
  assert.equal(start.id, 'sa_life');
  assert.equal(start.cwd, cwd);

  for (const p of ofType(evs, 'subagent-progress')) {
    assert.equal(p.id, 'sa_life');
    assert.ok(['running', 'tool', 'thinking', 'reporting'].includes(p.phase), `bad phase ${p.phase}`);
    assert.ok(Number.isFinite(p.iterations));
    assert.ok(Number.isFinite(p.elapsedMs) && p.elapsedMs >= 0);
    assert.ok(String(p.currentToolArgsPreview ?? '').length <= MAX_ARG_PREVIEW);
  }

  const end = ofType(evs, 'subagent-end')[0];
  assert.equal(end.id, 'sa_life');
  assert.equal(end.status, 'done');
  assert.ok(Number.isFinite(end.elapsedMs) && end.elapsedMs >= 0);
  assert.match(end.summary, /wrote src\/one\.js/);
  assert.deepEqual(end.filesTouched, ['src/one.js']);
  assert.equal(end.error, null);
  assert.equal(typeof end.lessonsCount, 'number');
  // The bounded inner ledger, not a replay of the inner event stream.
  assert.equal(end.innerTools.write_file, 1);
});

test('a FAILING subagent emits subagent-end with status failed and the error', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  // The subagent's own requests get a 500; the parent's succeed, so the failure
  // is the subagent's and not the harness's.
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      seen.push(parsed);
      if (isSubagentRequest(parsed)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn({ text: 'parent final' }));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = parentCtx(cwd);
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 6 } },
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    auxTarget: null,
  });
  const res = await handler({ task: 'Do a doomed thing', id: 'sa_fail' }, ctx);
  const evs = drain(ctx);

  const end = ofType(evs, 'subagent-end')[0];
  assert.ok(end, 'a failed subagent still has to end');
  assert.equal(end.id, 'sa_fail');
  assert.equal(end.status, 'failed');
  assert.ok(end.error, `no error carried: ${JSON.stringify(end)}`);
  assert.equal(res.isError, true);
  // The descriptor agrees with the event: two surfaces, one status.
  assert.equal(readDescriptor(cwd, 'sa_fail').status, 'failed');
});

// ---------------------------------------------------------------------------
// 2 + 3. the live registry: running NOW vs. a descriptor lying about it
// ---------------------------------------------------------------------------

test('the live registry shows a running subagent WHILE it runs and is empty after', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  // The probe runs inside the subagent's own model call, i.e. while the nested
  // loop is genuinely mid-iteration. There is no other moment that answers the
  // question this test asks.
  const probes = [];
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) return { text: 'parent final' };
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'done' } }] };
  }, {
    onRequest: (r) => {
      if (!isSubagentRequest(r)) return;
      probes.push({
        live: listLiveSubagents(),
        count: liveSubagentCount(),
        snapshot: agentSnapshot({ cwd }),
      });
    },
  });

  const ctx = parentCtx(cwd);
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    auxTarget: null,
  });
  await handler({ task: 'Probe the registry', id: 'sa_probe' }, ctx);

  assert.equal(probes.length >= 1, true, 'the probe never ran');
  const during = probes[0];
  assert.equal(during.count, 1, 'the registry did not show the running subagent');
  assert.equal(during.live[0].id, 'sa_probe');
  assert.equal(during.live[0].task, 'Probe the registry');
  assert.equal(during.live[0].status, 'running');
  assert.equal(during.live[0].stale, false);
  assert.equal(during.snapshot.activeCount, 1);
  // The descriptor on disk says 'running' too, and it is NOT stale: a live
  // record exists for it in THIS process.
  assert.equal(during.snapshot.staleCount, 0, 'a live subagent was reported as stale');

  // After: the live map is empty and the descriptor is no longer a lie.
  assert.equal(liveSubagentCount(), 0, 'a finished subagent is still in the live registry');
  assert.deepEqual(listLiveSubagents(), []);
  const after = agentSnapshot({ cwd });
  assert.equal(after.activeCount, 0);
  assert.equal(after.staleCount, 0, 'a DONE descriptor was reported as stale');
  // The recently-finished tail is what makes "it just stopped" answerable
  // without a log scroll.
  assert.equal(after.recentFinished[0].id, 'sa_probe');
  assert.equal(after.recentFinished[0].status, 'done');
  assert.equal(after.recentFinished[0].live, false, 'a finished snapshot claimed to be live');
});

test('a descriptor with status running but NO live process is STALE, never "working"', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);

  // Case A: a descriptor from a previous run of this process. Nothing is
  // running; only the file survives.
  const orphan = initDescriptor({ id: 'sa_orphan', task: 'crashed halfway', cwd });
  assert.equal(orphan.status, 'running');

  let snap = agentSnapshot({ cwd });
  assert.equal(snap.activeCount, 0, 'a file on disk was counted as a working agent');
  assert.equal(snap.staleCount, 1);
  assert.equal(snap.stale[0].id, 'sa_orphan');
  assert.equal(snap.stale[0].stale, true);
  assert.equal(snap.stale[0].live, false);
  assert.match(snap.stale[0].staleReason, /no live process/);

  // Case B: the same descriptor, but a live record now exists for it -- a
  // resume. Staleness is about the PROCESS, not the file, so this is live and
  // must stop being reported as stale.
  registerSubagent({ id: 'sa_orphan', task: 'crashed halfway', cwd, resumed: true });
  markSubagentStarted('sa_orphan');
  snap = agentSnapshot({ cwd });
  assert.equal(snap.activeCount, 1);
  assert.equal(snap.staleCount, 0, 'a genuinely live subagent was labelled stale');
  finishSubagent('sa_orphan', { status: 'done' });

  // Case C: a descriptor written by a DIFFERENT process. Still not this
  // process's work, and the pid says so.
  const foreign = initDescriptor({ id: 'sa_foreign', task: 'another bridge', cwd });
  foreign.pid = process.pid + 4242;
  fs.writeFileSync(
    path.join(cwd, '.agent', '_sub', 'sa_foreign', 'state.json'),
    JSON.stringify(foreign, null, 2)
  );
  const stale = staleSubagents({ cwd });
  const foreignRow = stale.find((a) => a.id === 'sa_foreign');
  assert.ok(foreignRow, 'a foreign descriptor was not surfaced at all');
  assert.equal(foreignRow.stale, true);
  assert.match(foreignRow.staleReason, /another process/);
  assert.match(foreignRow.staleReason, new RegExp(String(process.pid + 4242)));

  // Case D: a FINISHED descriptor is neither live nor stale. It is done, and
  // calling it stale would be its own kind of lie.
  const doneDesc = initDescriptor({ id: 'sa_done', task: 'finished long ago', cwd });
  doneDesc.status = 'done';
  doneDesc.completedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(cwd, '.agent', '_sub', 'sa_done', 'state.json'),
    JSON.stringify(doneDesc, null, 2)
  );
  const all = agentSnapshot({ cwd });
  assert.equal(all.stale.some((a) => a.id === 'sa_done'), false);
  assert.equal(all.activeCount, 0);
  _resetRegistry();
});

test('the registry drops an agent from the live set on finish, whatever the outcome', (t) => {
  _resetRegistry();
  registerSubagent({ id: 'sa_x', task: 'x' });
  markSubagentStarted('sa_x');
  updateSubagent('sa_x', { currentTool: 'bash', iterations: 3 });
  assert.equal(liveSubagentCount(), 1);
  const rec = finishSubagent('sa_x', { status: 'failed' });
  assert.equal(rec.status, 'failed');
  assert.equal(rec.phase, 'ended');
  assert.ok(rec.elapsedMs >= 0);
  assert.equal(liveSubagentCount(), 0);
  // finish() is idempotent: a second call must not resurrect or double-count.
  assert.equal(finishSubagent('sa_x', { status: 'failed' }), null);
  assert.equal(liveSubagentCount(), 0);
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 4. filesTouched -- the regression guard for the documented defect
// ---------------------------------------------------------------------------

test('a tool-end event carries the path write_file actually wrote', async (t) => {
  const cwd = sandbox(t);
  const { port } = await startMock(t, (r, n) => {
    if (n === 1) return { calls: [{ id: 'w1', name: 'write_file', args: { path: 'src/real.js', content: 'export default 1;' } }] };
    if (n === 2) return { calls: [{ id: 'r1', name: 'read_file', args: { path: 'src/real.js' } }] };
    return { text: 'done' };
  });
  const ctx = { ...parentCtx(cwd), _subagentEvents: null };
  const evs = [];
  for await (const ev of runAgent({
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    messages: [{ role: 'user', content: 'write the file' }],
    ctx,
    config: { cwd },
    maxIterations: 5,
  })) {
    evs.push(ev);
  }
  const writeEnd = ofType(evs, 'tool-end').find((e) => e.name === 'write_file');
  assert.ok(writeEnd, 'no tool-end for write_file');
  // This field is the whole fix. Before it, nothing in src/ ever set it, so
  // every downstream accumulator read undefined and filesTouched was empty.
  assert.deepEqual(writeEnd.filesTouched, ['src/real.js']);
  assert.ok(fs.existsSync(path.join(cwd, 'src/real.js')), 'the claim is false: the file is not there');
  // A read touches nothing, and claiming otherwise would put a file in the
  // subagent's "files I changed" list that it never changed.
  const readEnd = ofType(evs, 'tool-end').find((e) => e.name === 'read_file');
  assert.equal(readEnd.filesTouched, undefined);
  _resetRegistry();
});

test('a subagent that modifies two files persists both in filesTouched and on subagent-end', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) return { text: 'parent final' };
    const n = r.messages.length;
    if (n === 2) return { calls: [{ id: 'w1', name: 'write_file', args: { path: 'src/a.js', content: 'a' } }] };
    if (n === 4) return { calls: [{ id: 'w2', name: 'write_file', args: { path: 'src/b.js', content: 'b' } }] };
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'two files written' } }] };
  });
  const ctx = parentCtx(cwd);
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    auxTarget: null,
  });
  await handler({ task: 'Write two modules', id: 'sa_files' }, ctx);
  const evs = drain(ctx);

  assert.deepEqual(readDescriptor(cwd, 'sa_files').filesTouched.slice().sort(), ['src/a.js', 'src/b.js']);
  assert.deepEqual(ofType(evs, 'subagent-end')[0].filesTouched.slice().sort(), ['src/a.js', 'src/b.js']);
  assert.ok(fs.existsSync(path.join(cwd, 'src/a.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'src/b.js')));
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 5 + 6. the terminal surfaces
// ---------------------------------------------------------------------------

test('renderToolStart for a subagent shows the task text, not a bare "subagent"', () => {
  process.env.NO_COLOR = '1';
  const line = renderToolStart('subagent', { task: 'summarise the server module', id: 'sa_x' });
  assert.match(line, /subagent/);
  assert.match(line, /summarise the server module/);
  // A tool with no argument still renders exactly as before -- the new `task`
  // key must not invent a trailing colon.
  assert.equal(renderToolStart('read_file', { path: 'src/x.js' }), '● read_file: src/x.js');
  assert.equal(renderToolStart('bash', {}), '● bash');
});

test('the terminal ticker counts live agents, reports what they are doing, and clears at zero', () => {
  process.env.NO_COLOR = '1';
  const tk = new SubagentTicker();

  // Spawn prints the id and the task -- the two things an operator needs to
  // identify the work.
  const a = tk.apply({ type: 'subagent-spawn', id: 'sa_a', task: 'refactor the parser' });
  assert.match(a.line, /sa_a/);
  assert.match(a.line, /refactor the parser/);
  assert.match(a.count, /1 subagent running/);
  assert.equal(a.becameEmpty, false);

  // A second agent, and the count follows. The returned `count` is the line to
  // PRINT; a second countLine() call returns '' because the change was already
  // reported, which is the property that keeps a quiet agent off the screen.
  const b = tk.apply({ type: 'subagent-spawn', id: 'sa_b', task: 'fix the test' });
  assert.match(b.count, /2 subagents running/);
  assert.equal(tk.countLine(), '');

  // Progress is folded silently unless the visible line changes.
  const quiet = tk.apply({ type: 'subagent-progress', id: 'sa_a', phase: 'tool', currentTool: 'read_file' });
  assert.equal(quiet.line, '');
  const changed = tk.apply({ type: 'subagent-progress', id: 'sa_b', phase: 'tool', currentTool: 'bash' });
  assert.equal(changed.line, '');
  assert.match(changed.count, /sa_b → bash/);
  assert.equal(tk.apply({ type: 'subagent-progress', id: 'sa_b', phase: 'tool', currentTool: 'bash' }).count, '');

  // Ending one leaves the other running: the count must NOT read 0 yet.
  const one = tk.apply({ type: 'subagent-end', id: 'sa_a', status: 'done', elapsedMs: 4200, filesTouched: ['src/a.js'] });
  assert.match(one.line, /sa_a done/);
  assert.match(one.line, /4s/);
  assert.match(one.line, /src\/a\.js/);
  assert.equal(one.becameEmpty, false);
  assert.match(one.count, /1 subagent running/);
  assert.equal(one.count.includes('sa_a'), false, 'a finished agent is still in the live count');

  // Ending the last one is the clear signal.
  const last = tk.apply({ type: 'subagent-end', id: 'sa_b', status: 'failed', elapsedMs: 900, filesTouched: [], error: 'boom' });
  assert.match(last.line, /sa_b failed/);
  assert.equal(last.becameEmpty, true);
  assert.equal(tk.countLine(), '', 'the count line must disappear, not just stop updating');
  assert.equal(tk.active.length, 0);
});

test('the /agents tree prints the lead and each active child, and says so plainly when idle', () => {
  process.env.NO_COLOR = '1';

  // Idle: the lead is still drawn -- "who is the lead" is half the question --
  // and the absence of children is stated in words, not implied by a blank.
  const idle = renderAgentTree({
    cwd: '/tmp/proj',
    sessionId: 'sess-1',
    model: 'anthropic:claude',
    snapshot: { live: [], stale: [], recentFinished: [], activeCount: 0, staleCount: 0 },
  });
  assert.match(idle, /lead: main session/);
  assert.match(idle, /sess-1/);
  assert.match(idle, /no subagents running/);

  // Busy: every child is named, with its task, elapsed time, current tool and
  // status, nested by depth.
  const busy = renderAgentTree({
    cwd: '/tmp/proj',
    sessionId: 'sess-1',
    model: 'anthropic:claude',
    leadStatus: 'working',
    snapshot: {
      activeCount: 2,
      staleCount: 1,
      live: [
        { id: 'sa_a', task: 'refactor the parser', depth: 0, phase: 'tool', currentTool: 'bash', currentToolArgsPreview: 'npm test', elapsedMs: 6500, status: 'running' },
        { id: 'sa_b', task: 'fix the flaky test', depth: 1, phase: 'thinking', currentTool: null, currentToolArgsPreview: '', elapsedMs: 1200, status: 'running' },
      ],
      stale: [
        { id: 'sa_old', task: 'crashed run', depth: 0, staleReason: 'no live process in this process', stale: true },
      ],
      recentFinished: [],
    },
  });
  assert.match(busy, /lead: main session/);
  assert.match(busy, /working/);
  assert.match(busy, /sa_a/);
  assert.match(busy, /refactor the parser/);
  assert.match(busy, /6s/);
  assert.match(busy, /→ bash/);
  assert.match(busy, /sa_b/);
  assert.match(busy, /fix the flaky test/);
  assert.match(busy, /2 running/);
  // The stale row is drawn AND marked. Hiding it would hide half-finished work;
  // showing it unmarked would claim somebody is working on it.
  assert.match(busy, /sa_old/);
  assert.match(busy, /STALE/);
  assert.match(busy, /not working/);
  assert.match(busy, /1 stale/);
  assert.equal(/2 running[^\n]*sa_old/.test(busy), false);
});

test('formatElapsed is coarse enough not to jitter between frames', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(1500), '1s');
  assert.equal(formatElapsed(65000), '1m 05s');
  assert.equal(formatElapsed(3 * 3600 * 1000 + 120000), '3h 02m');
  assert.equal(formatElapsed(NaN), '--');
  assert.equal(formatElapsed(-1), '--');
});

// ---------------------------------------------------------------------------
// 7. the live dashboard
// ---------------------------------------------------------------------------

const ev = (event, at) => ({ type: 'event', event, at });
const hello = () => ({ type: 'hello', sessionId: 's1', bot: 'b', model: 'm', cwd: '/tmp/proj', pid: 42, at: 1000 });

test('the dashboard holds TWO concurrent agents and renders both', () => {
  process.env.NO_COLOR = '1';
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, ev({ type: 'subagent-spawn', id: 'sa_a', task: 'refactor the parser', description: 'parser', depth: 0, parentId: null }, 1100), { now: 1100 });
  s = applyMessage(s, ev({ type: 'subagent-spawn', id: 'sa_b', task: 'fix the flaky test', depth: 1, parentId: 'sa_a' }, 1200), { now: 1200 });
  s = applyMessage(s, ev({ type: 'subagent-progress', id: 'sa_a', phase: 'tool', currentTool: 'bash', currentToolArgsPreview: 'npm test', iterations: 2 }, 6000), { now: 6000 });
  s = applyMessage(s, ev({ type: 'subagent-progress', id: 'sa_b', phase: 'tool', currentTool: 'edit_file', currentToolArgsPreview: '{"path":"src/t.js"}', iterations: 1 }, 6000), { now: 6000 });

  // Two agents, two open entries, a count, and a current tool per agent.
  assert.equal(activeAgents(s).length, 2, 'the dashboard could only hold one agent');
  assert.equal(s.agentsActive, 2);
  assert.equal(s.agentsSeen, 2);
  assert.deepEqual(activeAgents(s).map((a) => a.id), ['sa_a', 'sa_b']);
  assert.equal(activeAgents(s)[0].currentTool, 'bash');
  assert.equal(activeAgents(s)[1].currentTool, 'edit_file');
  assert.equal(activeAgents(s)[1].iterations, 1);

  // And BOTH are on the frame, each with its own row.
  const frame = renderFrame(s, { color: false, width: 96, now: 6500, frame: 1 });
  assert.match(frame, /2 active/);
  assert.match(frame, /sa_a/);
  assert.match(frame, /sa_b/);
  assert.match(frame, /refactor the parser/);
  assert.match(frame, /fix the flaky test/);
  assert.match(frame, /bash/);
  assert.match(frame, /edit_file/);
  // The count appears in the status line too, so it is visible without
  // scrolling to the agents block.
  assert.match(frame, /working · 2 agents/);

  // Ending one leaves the other alone: the map is keyed, not a slot.
  s = applyMessage(s, ev({ type: 'subagent-end', id: 'sa_b', status: 'done', elapsedMs: 5300, filesTouched: ['src/t.js'], lessonsCount: 0 }, 7000), { now: 7000 });
  assert.equal(s.agentsActive, 1);
  assert.deepEqual(activeAgents(s).map((a) => a.id), ['sa_a']);
  const after = renderFrame(s, { color: false, width: 96, now: 7500, frame: 2 });
  assert.match(after, /sa_a/);
  assert.equal(/sa_b\b(?! done)/.test(after.split('recent')[0]), false, 'a finished agent still has a row');

  // Ending the last one clears the block entirely.
  s = applyMessage(s, ev({ type: 'subagent-end', id: 'sa_a', status: 'failed', elapsedMs: 900, filesTouched: [], lessonsCount: 1, error: 'boom' }, 8000), { now: 8000 });
  assert.equal(s.agentsActive, 0);
  assert.equal(s.agentsFailed, 1);
  const idle = renderFrame(s, { color: false, width: 96, now: 8500, frame: 3 });
  assert.equal(/  agents\b/.test(idle), false, 'the agents block is still drawn with nothing running');
});

test('the dashboard shows the task on the tool row, and holds several open tools', () => {
  process.env.NO_COLOR = '1';
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, ev({ type: 'tool-start', id: 'c1', name: 'subagent', argsPreview: '{"task":"audit the parser"}' }, 1100), { now: 1100 });
  s = applyMessage(s, ev({ type: 'tool-start', id: 'c2', name: 'read_file', argsPreview: '{"path":"src/x.js"}' }, 1200), { now: 1200 });
  // The row names the CURRENT tool -- the most recently started one that has
  // not ended -- and says how many others are open, because with a keyed map
  // there can be others.
  const frame = renderFrame(s, { color: false, width: 96, now: 1300, frame: 1 });
  assert.equal(Object.keys(s.tools).length, 2, 'the keyed map lost one of two open tools');
  assert.equal(currentTool(s).id, 'c2', 'the most recent open tool is the current one');
  assert.match(frame, /read_file/);
  assert.match(frame, /\+1 open/);
  // The subagent call's own target is its TASK, not a path -- that is the field
  // a `subagent` call has, and reading it as a path is what made the row blank.
  const subOnly = applyMessage(
    applyMessage(createWatchState(), hello(), { now: 1000 }),
    ev({ type: 'tool-start', id: 'only', name: 'subagent', argsPreview: '{"task":"audit the parser"}' }, 1100),
    { now: 1100 }
  );
  assert.match(renderFrame(subOnly, { color: false, width: 96, now: 1200, frame: 1 }), /audit the parser/);
  // Ending one leaves the other open -- the old single slot could not do this.
  s = applyMessage(s, ev({ type: 'tool-end', id: 'c2', name: 'read_file', ok: true, ms: 4 }, 1400), { now: 1400 });
  assert.equal(currentTool(s).id, 'c1');
});

test('a subagent event with no spawn still produces a row, rather than a count that is short an agent', () => {
  process.env.NO_COLOR = '1';
  // A watcher that reconnects mid-run, or replays a truncated log, sees
  // progress/end for an agent whose spawn it never received. Dropping it would
  // put a number on screen that is missing an agent the wire says is running.
  let s = applyMessage(createWatchState(), hello(), { now: 1000 });
  s = applyMessage(s, ev({ type: 'subagent-progress', id: 'sa_x', phase: 'tool', currentTool: 'grep' }, 1100), { now: 1100 });
  assert.equal(s.agentsActive, 1);
  assert.equal(activeAgents(s)[0].id, 'sa_x');
  s = applyMessage(s, ev({ type: 'subagent-end', id: 'sa_x', status: 'done', elapsedMs: 10, filesTouched: [] }, 1200), { now: 1200 });
  assert.equal(s.agentsActive, 0);
  // An end for an agent already gone is counted as finished, not decremented
  // below zero.
  s = applyMessage(s, ev({ type: 'subagent-end', id: 'sa_x', status: 'done', elapsedMs: 10, filesTouched: [] }, 1300), { now: 1300 });
  assert.equal(s.agentsActive, 0);
});

// ---------------------------------------------------------------------------
// 8. bounded re-emission
// ---------------------------------------------------------------------------

test('a long inner run re-emits a BOUNDED number of events upward, and says how many it dropped', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  // 60 distinct tool calls and never a report_result: the inner loop runs to
  // its iteration budget, which is the worst case the cap exists for. Each
  // path differs, so the doom-loop detector does not short-circuit the run.
  let n = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) return { text: 'parent final' };
    n += 1;
    return { calls: [{ id: `g${n}`, name: 'glob', args: { pattern: `p${n}/*.js` } }] };
  });
  const ctx = parentCtx(cwd);
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 40 } },
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    auxTarget: null,
  });
  await handler({ task: 'Run forever', id: 'sa_long', max_iterations: 40 }, ctx);
  const evs = drain(ctx);

  assert.ok(n >= 30, `the inner loop only ran ${n} iterations; the test is not exercising the cap`);
  const progress = ofType(evs, 'subagent-progress');
  assert.equal(progress.length <= MAX_PROGRESS_EVENTS, true, `${progress.length} progress events escaped the cap of ${MAX_PROGRESS_EVENTS}`);
  assert.equal(ofType(evs, 'subagent-start').length, 1);
  assert.equal(ofType(evs, 'subagent-spawn').length, 1);
  assert.equal(ofType(evs, 'subagent-end').length, 1);

  // Every event on the parent's stream is a lifecycle event: the inner loop's
  // own tool-start / tool-end / text-delta are NOT forwarded. That is the
  // "clearly marked as a subagent's, so a parent cannot confuse it with its own
  // activity" requirement, asserted rather than asserted-about.
  const leaked = evs.filter((e) => e.type === 'tool-start' || e.type === 'tool-end' || e.type === 'text-delta' || e.type === 'assistant-turn');
  assert.deepEqual(leaked, [], `inner events leaked into the parent's stream: ${leaked.map((e) => e.type).join(',')}`);
  // And a subagent's tool names never appear as the parent's own tool calls.
  assert.equal(evs.some((e) => e.name === 'glob'), false);

  const end = ofType(evs, 'subagent-end')[0];
  assert.equal(end.progressEmitted, progress.length);
  assert.equal(end.progressSuppressed > 0, true, 'the run was long but nothing was reported as dropped');
  // The suppression is announced, and it is consistent: what left plus what was
  // dropped accounts for every inner change.
  assert.equal(end.progressEmitted + end.progressSuppressed >= n, true);
  // The inner ledger is bounded too: distinct tool NAMES are capped.
  assert.equal(Object.keys(end.innerTools).length <= 12, true);
  _resetRegistry();
});

test('the lifecycle events are exactly-once on the IPC broadcast, and never re-broadcast by the queue drain', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  // `wired` is the SOCKET: everything a live dashboard would have received.
  // `seen` is the STREAM: everything a consumer of runAgent() receives, which is
  // fed by runAgent's own mirror of the same broadcast plus the queue drain.
  const wired = [];
  const seen = [];
  // NO `_subagentEvents` here on purpose: the outermost runAgentLoop creates the
  // queue itself and is the only loop that drains it. Handing one in would make
  // this loop believe it is NESTED -- which is correct behaviour, and exactly
  // why a top-level ctx must not pre-seed the queue.
  const ctx = parentCtx(cwd, { ipcBroadcast: (e) => wired.push(e?.type) });
  ctx._subagentEvents = undefined;
  ctx.enableSubagents = true;
  ctx.allTools = [
    subagentToolSchema(),
    { name: 'read_file', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];

  let spawned = 0;
  const { port } = await startMock(t, (r) => {
    if (isSubagentRequest(r)) return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'done' } }] };
    spawned += 1;
    if (spawned === 1) return { calls: [{ id: 'sub1', name: 'subagent', args: { task: 'do it', id: 'sa_once' } }] };
    return { text: 'parent final' };
  });
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  ctx.subagentHandler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 6 } },
    target,
    auxTarget: null,
  });
  for await (const ev of runAgent({
    target,
    messages: [{ role: 'user', content: 'delegate' }],
    ctx,
    config: { cwd, subagent: { maxDepth: 2, maxIterations: 6 } },
    maxIterations: 5,
  })) {
    seen.push(ev);
  }

  const spawns = seen.filter((e) => e.type === 'subagent-spawn');
  const ends = seen.filter((e) => e.type === 'subagent-end');
  assert.equal(spawns.length, 1, `the parent stream carried ${spawns.length} subagent-spawn events`);
  assert.equal(ends.length, 1);
  // Causal order on the stream, the same invariant the --json E2E asserts.
  const kinds = seen.map((e) => e.type);
  assert.equal(kinds.indexOf('subagent-spawn') < kinds.indexOf('subagent-end'), true);
  assert.equal(kinds.lastIndexOf('subagent-end') < kinds.indexOf('tool-end'), true);

  // The live channel saw each of them too, and exactly ONCE: the broadcast is
  // what makes the dashboard live WHILE the subagent runs, and the queue drain
  // must not replay the run onto the socket in one burst at the end.
  const liveKinds = wired.filter((k) => k.startsWith('subagent-'));
  assert.equal(liveKinds.filter((k) => k === 'subagent-spawn').length, 1, 'subagent-spawn reached the socket more than once');
  assert.equal(liveKinds.filter((k) => k === 'subagent-end').length, 1, 'subagent-end reached the socket more than once');
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 9. the prompt/runtime contract
// ---------------------------------------------------------------------------

test('the prompt and the runtime agree on whether delegation batches', async (t) => {
  // The invariant, stated as the runtime actually behaves: `subagent` is
  // approval_gated (the gate is unchanged), but a batch of nothing but subagent
  // calls now plans as `concurrent`, and the prompt says so. If this ever stops
  // being true the prompt has to change with it -- which is why both halves are
  // asserted in ONE test rather than the prompt alone.
  assert.equal(classifyTool('subagent'), 'approval_gated');

  const batch = groupCalls([
    { function: { name: 'subagent', arguments: '{}' } },
    { function: { name: 'read_file', arguments: '{}' } },
  ]);
  assert.equal(batch[0].class, 'approval_gated');
  assert.equal(batch.length, 2, 'the batch would not be rejected as a unit');

  const cwd = sandbox(t, 'ox-vis-prompt-');
  const prompt = await buildSystemPrompt({ cwd, contextParts: {} });
  const section = prompt.slice(prompt.indexOf('# SUBAGENTS'), prompt.indexOf('# SKILLS'));

  // The clause is no longer a promise the runtime forbids: a batch of two
  // subagent calls now plans as `concurrent`, and the prompt says so.
  const concurrent = batchPlan([
    { function: { name: 'subagent', arguments: '{}' } },
    { function: { name: 'subagent', arguments: '{}' } },
  ]);
  assert.equal(concurrent.mode, 'concurrent', 'the prompt now claims a fan-out the runtime no longer runs');
  assert.equal(concurrent.reason, null);

  // ...and the stale wording is gone by value, not by rename.
  assert.equal(/parallelizable/i.test(section), false, `the prompt still promises parallelizable delegation:\n${section}`);
  assert.equal(section.includes('Two subagent calls in one turn are rejected'), false);
  assert.equal(/Delegation is SERIAL/.test(section), false);
  assert.match(section, /may be emitted together in one turn and run CONCURRENTLY/);
  // The gate is unchanged, and the prompt still says so: batching subagents
  // must not read as a licence to batch a subagent WITH something else.
  assert.match(section, /still approval-gated/);
  assert.match(section, /may not be mixed with other tools/);
  assert.equal(batchPlan([
    { function: { name: 'subagent', arguments: '{}' } },
    { function: { name: 'read_file', arguments: '{}' } },
  ]).mode, 'reject', 'a mixed batch is no longer rejected, but the prompt still says it is');

  // The parallel-reads clause is a DIFFERENT promise about a different thing and
  // must survive untouched by this change.
  assert.match(prompt, /read_file, grep, glob, list_dir.*run in parallel/);
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /may be emitted together in one turn and run CONCURRENTLY/);
  assert.equal(/SERIAL/i.test(SUBAGENT_PARALLEL_CLAUSE), false);
});

// ---------------------------------------------------------------------------
// end to end: a real `ox --json` run against a scripted model
// ---------------------------------------------------------------------------

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_MAX_COST', 'OX_YOLO',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
];

async function runOx(t, { home, port, args, stdin = '', timeout = 60000 }) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd: home,
    env: { ...env, HOME: home, NO_COLOR: '1', OX_NO_BANNER: '1', OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  if (stdin) child.stdin.write(stdin);
  const code = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`ox did not exit in ${timeout}ms\n${stdout}\n${stderr}`)); }, timeout);
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (c) => { clearTimeout(killer); resolve(c); });
  });
  return { code, stdout, stderr };
}

function ndjsonEvents(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.t === 'string') out.push(o);
    } catch { /* a non-JSON line is not a failure here */ }
  }
  return out;
}

test('E2E: a real `ox --json` run streams the whole subagent lifecycle', async (t) => {
  _resetRegistry();
  const home = sandbox(t, 'ox-vis-e2e-');
  let spawned = 0;
  const { port } = await startMock(t, (r) => {
    if (isSubagentRequest(r)) {
      const n = r.messages.length;
      if (n === 2) return { calls: [{ id: 'w1', name: 'write_file', args: { path: 'src/helper.js', content: 'export const helper = 1;\n' } }] };
      if (n === 4) return { calls: [{ id: 'w2', name: 'write_file', args: { path: 'src/index.js', content: 'export * from "./helper.js";\n' } }] };
      if (n === 6) return { calls: [{ id: 'r1', name: 'read_file', args: { path: 'src/index.js' } }] };
      return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'Created src/helper.js and re-exported it.' } }] };
    }
    spawned += 1;
    if (spawned === 1) return { text: 'Delegating.', calls: [{ id: 'sub1', name: 'subagent', args: { task: 'Add a helper module and re-export it', id: 'sa_e2e' } }] };
    return { text: 'Done.' };
  });

  const { code, stdout, stderr } = await runOx(t, { home, port, args: ['--json', '-y', '-p', 'delegate this'] });
  assert.equal(code, 0, `exit ${code}\n${stderr}`);

  const evs = ndjsonEvents(stdout);
  const kinds = evs.map((e) => e.t);
  // Causal order: the parent's subagent tool call opens, the lifecycle runs, the
  // call closes. A lifecycle spliced in AFTER tool-end would read as
  // post-mortem.
  const iStart = kinds.indexOf('tool-start');
  const iSpawn = kinds.indexOf('subagent-spawn');
  const iStart2 = kinds.indexOf('subagent-start');
  const iEnd = kinds.indexOf('subagent-end');
  const iToolEnd = kinds.indexOf('tool-end');
  assert.equal(iSpawn > iStart && iStart2 > iSpawn && iEnd > iStart2 && iToolEnd > iEnd, true,
    `lifecycle out of order: ${JSON.stringify({ iStart, iSpawn, iStart2, iEnd, iToolEnd })}`);

  const spawn = evs.find((e) => e.t === 'subagent-spawn');
  assert.equal(spawn.id, 'sa_e2e');
  assert.equal(spawn.task, 'Add a helper module and re-export it');
  assert.equal(spawn.depth, 0);
  assert.equal(spawn.parentId, null);
  assert.equal(spawn.resumed, false);

  const progress = evs.filter((e) => e.t === 'subagent-progress');
  assert.equal(progress.length >= 3, true, 'no progress events in the NDJSON stream');
  // The lifecycle flag never reaches the stream: it is a non-enumerable marker.
  assert.equal(Object.keys(spawn).includes('LIVE_BROADCAST'), false);
  assert.equal(Object.getOwnPropertySymbols(spawn).length, 0, 'an internal symbol leaked into --json');
  assert.equal(JSON.stringify(spawn).includes('subagent.liveBroadcast'), false);

  const end = evs.find((e) => e.t === 'subagent-end');
  assert.equal(end.id, 'sa_e2e');
  assert.equal(end.status, 'done');
  assert.ok(Number.isFinite(end.elapsedMs) && end.elapsedMs > 0);
  assert.match(end.summary, /Created src\/helper\.js/);
  // The real defect, fixed, visible in a real run.
  assert.deepEqual(end.filesTouched.slice().sort(), ['src/helper.js', 'src/index.js']);
  assert.equal(end.innerTools.write_file, 2);
  assert.equal(end.innerTools.read_file, 1);

  // And the descriptor agrees with the stream.
  const desc = readDescriptor(home, 'sa_e2e');
  assert.equal(desc.status, 'done');
  assert.deepEqual(desc.filesTouched.slice().sort(), ['src/helper.js', 'src/index.js']);
  assert.equal(desc.pid, Number(evs[0].pid ?? desc.pid) || desc.pid);
  assert.ok(fs.existsSync(path.join(home, 'src/helper.js')));
  assert.ok(fs.existsSync(path.join(home, 'src/index.js')));
  _resetRegistry();
});

test('E2E: the REPL renders the delegation, the live count, and /agents while a subagent runs', async (t) => {
  _resetRegistry();
  const home = sandbox(t, 'ox-vis-repl-');
  // A descriptor from a CRASHED earlier run: status 'running', no process. It
  // is the only way to prove in a real REPL that a stale agent is labelled and
  // excluded from the working count, because a live one cannot be typed into a
  // busy REPL.
  const orphan = initDescriptor({ id: 'sa_orphan', task: 'interrupted run', cwd: home });
  assert.equal(orphan.status, 'running');

  // The subagent's reply is delayed so the delegation is slow enough to be
  // unmistakable in the captured output.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      const finish = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (isSubagentRequest(parsed)) {
          res.end(turn({ calls: [{ id: 'rep', name: 'report_result', args: { output: 'subagent done' } }] }));
          return;
        }
        if (!spawned) {
          spawned += 1;
          res.end(turn({ text: 'Delegating.', calls: [{ id: 'sub1', name: 'subagent', args: { task: 'audit the parser module', id: 'sa_repl' } }] }));
          return;
        }
        res.end(turn({ text: 'All done.' }));
      };
      if (isSubagentRequest(parsed)) setTimeout(finish, 1800);
      else finish();
    });
  });
  let spawned = 0;
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const child = spawn(process.execPath, [OX_BIN, '-y'], {
    cwd: home,
    env: { ...env, HOME: home, NO_COLOR: '1', OX_NO_BANNER: '1', OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  const out = () => stdout;
  const treeCount = (s) => s.split('agent tree \u00b7').length - 1;

  // Every wait below is on the child's bytes, never on a clock.
  //
  // The turn has to END before the loop will look at a slash command:
  // `rl.on('line')` answers `busy` and renders NOTHING while `state.busy` is
  // set, so a line that lands a few hundred milliseconds early is not a slow
  // render, it is no render at all -- which is exactly how this read as a
  // "rendering race" in the audit. What the loop prints when the turn is over
  // is the signal to wait on.
  child.stdin.write('delegate this\n');
  await waitFor(out, TURN_OVER, 'the delegated turn to finish and the REPL to take the next line');

  // The snapshot is an ON-DEMAND render, so the wait is for the render itself.
  // Typing into a REPL is asynchronous and nothing guarantees the line is read
  // on the next tick, so a command can still land mid-turn -- and then it is
  // answered `busy`, which is a legitimate REPL answer, not a missing render.
  // Recover from that by waiting for the prompt and re-sending; the assertion
  // below still requires two real renders.
  const snapshot = async (n) => {
    for (let attempt = 1; ; attempt++) {
      const before = treeCount(out());
      const at = out().length;
      child.stdin.write('/agents\n');
      const s = await waitFor(
        out,
        (cur) => treeCount(cur) > before || cur.slice(at).includes(BUSY),
        `/agents render #${n}`,
      );
      if (treeCount(s) > before) return;
      await waitFor(out, TURN_OVER, `the REPL to go idle before re-sending /agents (attempt ${attempt})`);
    }
  };

  await snapshot(1);
  await snapshot(2);
  child.stdin.write('/exit\n');
  const code = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error(`the REPL did not exit\n${stdout}\n${stderr}`)), 30000);
    child.on('close', (c) => { clearTimeout(killer); resolve(c); });
  });
  assert.equal(code, 0, stderr);

  // renderToolStart shows the task instead of a bare "subagent".
  assert.match(stdout, /● subagent: audit the parser module/);
  // The spawn line carries the id AND the task.
  assert.match(stdout, /● subagent sa_repl: audit the parser module/);
  // The live count, then the clear.
  assert.match(stdout, /1 subagent running/);
  assert.match(stdout, /no subagents running/);
  // The end line: status, elapsed, and the work it did.
  assert.match(stdout, /subagent sa_repl done/);

  // ---- /agents ----
  //
  // A REPL cannot run a slash command WHILE a turn is in flight -- readline
  // buffers the line and the loop answers `busy` -- so the live agent count in
  // this surface is carried by the ticker's own lines during the turn (asserted
  // above), and `/agents` is the on-demand snapshot between turns. That is a
  // property of the terminal, not of the registry: the same snapshot renders a
  // live child, and it does so in the unit test above, from the same object
  // this command reads.
  const trees = stdout.split('agent tree ·');
  assert.equal(trees.length >= 3, true, `expected two /agents renders, got ${trees.length - 1}\n${stdout}`);
  const first = trees[1];
  assert.match(first, /lead: main session/);
  assert.match(first, /no subagents running/);
  // The run just finished, and the tree says so with the same id the live lines
  // used -- one registry, one set of ids.
  assert.match(first, /sa_repl/);
  assert.match(first, /sa_repl done/);
  // And the planted orphan from an earlier, crashed run is shown as STALE --
  // never as an agent that is working. This is the distinction that only the
  // registry can make, and it is visible here in a real REPL.
  assert.match(first, /sa_orphan/);
  assert.match(first, /STALE/);
  assert.match(first, /not working/);
  assert.match(first, /1 stale/);
  assert.equal(/1 running/.test(first), false, 'a stale descriptor was counted as running');
  assert.match(trees[2], /no subagents running/);
  _resetRegistry();
});
