// PARALLEL SUBAGENTS.
//
// The blocker this file exists to close, in one sentence: `subagent` was
// classified `approval_gated` (src/resource-class.js) and src/agent.js refused
// the ENTIRE turn whenever a batch carried one, so a model that emitted two
// subagent calls got "approval-gated tools must run solo (batch rejected)" and
// lost the turn -- and src/system-prompt.js said so in as many words.
//
// Every test here asserts the runtime, not the intent:
//   1  two subagent calls in ONE turn are accepted and both run
//   2  the concurrency cap is enforced and the deferral is VISIBLE
//   3  both agents are in the live registry at once, with independent state
//   4  an event for agent A never appears in agent B's stream
//   5  a worker that died is STALE, never "running"
//   6  the approval gate is explicit, all-or-nothing, and not weaker than before
//   7  the aggregate cost cap is enforced across a fan-out, and the division is
//      visible
//   8  empty / absent tool sets do not break
//   9  the prompt clause matches the runtime, clause by clause, and a
//      canary that fails if it ever reverts to claiming delegation is serial
//
// Nothing here touches the real ~/.ox: every run is given a mkdtemp cwd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { runAgent, resolveBatchCostDivision } from '../src/agent.js';
import { initDescriptor, readDescriptor, subagentToolSchema, makeSubagentToolHandler } from '../src/subagent.js';
import {
  agentSnapshot, listLiveSubagents, liveSubagentCount, staleSubagents,
  registerSubagent, finishSubagent, agentEventStreams, subagentBatchStats,
  _resetRegistry,
} from '../src/subagent-registry.js';
import {
  batchPlan, classifyTool, resolveSubagentConcurrency, isConcurrentlyBatchable,
  DEFAULT_SUBAGENT_CONCURRENCY, MAX_SUBAGENT_CONCURRENCY, RESOURCE_CLASSES,
  BATCH_REJECT_APPROVAL,
} from '../src/resource-class.js';
import { createCostBudget } from '../src/cost.js';
import { buildSystemPrompt, SUBAGENT_PARALLEL_CLAUSE } from '../src/system-prompt.js';
import { renderAgentTree } from '../src/ui.js';

// The scripted provider is reached through the `custom` provider, which refuses
// to send anything without a key.
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-parallel-subagents-key';

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

// The task is the USER message of a subagent's own conversation; messages[0] is
// the system prompt, so reading it as the task asserts against the prompt.
const subagentTask = (r) => String(
  (r.messages ?? []).find((m) => m?.role === 'user')?.content ?? '',
).slice(0, 200);

// `onRequest` is async on purpose: it is the only place a test can observe the
// registry while BOTH agents are genuinely in flight, and holding the response
// open for a moment is what guarantees they are.
async function startMock(t, decide, { onRequest = null, usage } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      if (onRequest) await onRequest(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const decision = decide(parsed) ?? {};
      res.end(turn(usage ? { ...decision, usage } : decision));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port };
}

function sandbox(t, prefix = 'ox-par-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const schema = (name, properties = {}, required = []) => ({
  name,
  description: name,
  input_schema: { type: 'object', properties, required, additionalProperties: false },
});

// The parent loop drains `_subagentEvents` itself, so a top-level ctx must NOT
// pre-seed the queue: handing one in makes runAgentLoop believe it is NESTED.
function baseCtx(cwd, extra = {}) {
  return {
    cwd,
    depth: 0,
    maxDepth: 2,
    sessionId: 'sess-parent',
    enableSubagents: true,
    allTools: [
      subagentToolSchema(),
      schema('read_file', { path: { type: 'string' } }, ['path']),
      schema('glob', { pattern: { type: 'string' } }, ['pattern']),
      schema('write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    ],
    ...extra,
  };
}

// In the real CLI ctx.requestApproval is ALWAYS present (src/cli.js and
// src/headless.js both install makeApprover), and `--yolo` makes it answer true.
// A test that omits it is modelling a run with NO approver at all, which is the
// serial-fallback case -- so a test that wants the concurrent path has to supply
// one, exactly as the product does.
const yoloApprover = async () => true;
const yoloCtx = (cwd, extra = {}) => baseCtx(cwd, { yolo: true, approval: 'yolo', requestApproval: yoloApprover, ...extra });

async function runBatch(t, { cwd, port, ctx, config = {}, maxIterations = 6, budget = null, budgetPrime = null, messages = [{ role: 'user', content: 'delegate' }] }) {
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'claude-haiku-4-5' };
  const finalCtx = {
    ...ctx,
    subagentHandler: makeSubagentToolHandler({
      config: { subagent: { maxDepth: 2, maxIterations: 8 }, ...(config.subagent ?? {}) },
      target,
      auxTarget: null,
    }),
  };
  const events = [];
  const consume = async () => {
    for await (const ev of runAgent({
      target,
      messages,
      ctx: finalCtx,
      config: { cwd, ...config },
      maxIterations,
    })) events.push(ev);
  };
  // A budget-stop PROPAGATES out of the run by design (src/cost.js throws it and
  // the CLI reports it), so a test that deliberately crosses the cap has to
  // expect it rather than be surprised by it. Anything else still throws.
  if (budget) {
    await budget.run(async () => {
      budgetPrime?.(budget);
      try { await consume(); } catch (err) { if (err?.code !== 'OX_BUDGET_STOP') throw err; }
    });
  } else await consume();
  return events;
}

const ofType = (evs, t) => evs.filter((e) => e.type === t);
const notes = (evs) => ofType(evs, 'progress-note').map((e) => String(e.text ?? ''));
// A fan-out is "really" concurrent only if the registry held N records at the
// same moment. peakConcurrent is read off the live map the surfaces read, so it
// cannot claim a concurrency nothing else saw.
const peak = () => subagentBatchStats().peakConcurrent;

// ---------------------------------------------------------------------------
// 1. the blocker is gone: two subagent calls in ONE turn both execute
// ---------------------------------------------------------------------------

test('two subagent calls in ONE turn are accepted and both execute', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const asked = [];
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      if (asked.length < 2) {
        asked.push('turn');
        return asked.length === 1
          ? {
            calls: [
              { id: 's1', name: 'subagent', args: { task: 'ALPHA task', description: 'alpha', id: 'sa_p1' } },
              { id: 's2', name: 'subagent', args: { task: 'BETA task', description: 'beta', id: 'sa_p2' } },
            ],
          }
          : { text: 'both done' };
      }
      return { text: 'both done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: `finished ${subagentTask(r)}` } }] };
  });
  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, { cwd, port, ctx });

  // THE BLOCKER. Before this change the turn was refused wholesale and nothing
  // below would exist.
  const rejected = ofType(events, 'error').filter((e) => /must run solo/.test(String(e.error ?? '')));
  assert.deepEqual(rejected, [], 'the turn was still refused as an approval-gated batch');

  const ends = ofType(events, 'subagent-end');
  assert.equal(ends.length, 2, `expected two subagent runs, saw ${ends.length}`);
  assert.deepEqual(ends.map((e) => e.id).sort(), ['sa_p1', 'sa_p2']);
  for (const end of ends) {
    assert.equal(end.status, 'done', `${end.id} did not finish: ${end.error}`);
    assert.match(end.summary, /finished (ALPHA|BETA) task/, `summary was ${JSON.stringify(end.summary)}`);
  }

  // Both tool results came back, one per tool_call id, and neither is an error.
  const results = ofType(events, 'tool-end').filter((e) => e.name === 'subagent');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((e) => e.ok), [true, true]);

  // Two descriptors, two memory namespaces, two runs -- not one run described
  // twice.
  for (const id of ['sa_p1', 'sa_p2']) {
    assert.equal(readDescriptor(cwd, id).status, 'done', `${id} has no descriptor`);
    assert.ok(fs.existsSync(path.join(cwd, '.agent', '_sub', id, 'state.json')), `${id} has no descriptor file`);
    assert.equal(readDescriptor(cwd, id).result.includes('task'), true, `${id} stored no result`);
    // Two distinct descriptors, not one described twice.
    assert.notEqual(readDescriptor(cwd, 'sa_p1').result, readDescriptor(cwd, 'sa_p2').result);
  }
  assert.equal(liveSubagentCount(), 0, 'a finished agent was left in the live registry');
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 2. the cap is enforced, and the deferral is VISIBLE
// ---------------------------------------------------------------------------

test('the concurrency cap defers the overflow and says so, in words, on the stream', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const size = 5;
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: Array.from({ length: size }, (_, i) => ({ id: `s${i}`, name: 'subagent', args: { task: `task ${i}`, id: `sa_c${i}` } })) }
        : { text: 'fan-out done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, { cwd, port, ctx, config: { subagent: { maxParallel: 2 } } });

  // All FIVE ran. A cap that silently dropped the overflow would leave the model
  // with three answers for five questions.
  const ends = ofType(events, 'subagent-end');
  assert.equal(ends.length, size, `the cap dropped work: only ${ends.length} of ${size} ran`);

  // ... and no more than `cap` at once.
  assert.ok(peak() <= 2, `peak concurrency was ${peak()}, cap was 2`);

  // The deferral is VISIBLE, three ways, because "the cap held" is not
  // something an operator should have to take on trust:
  const stats = subagentBatchStats();
  assert.equal(stats.deferredTotal, size - 2);
  const said = notes(events);
  assert.ok(said.some((t2) => /2 of 5 running concurrently \(cap 2\)/.test(t2)), `no batch summary note:\n${said.join('\n')}`);
  assert.ok(said.some((t2) => /3 deferred to the next free slot/.test(t2)), `the deferral was not announced:\n${said.join('\n')}`);
  assert.ok(said.some((t2) => /waited \d+ms for a free slot/.test(t2)), `no per-call wait was announced:\n${said.join('\n')}`);
  // And on the wire, per agent, for anything consuming --json.
  const deferredSpawns = ofType(events, 'subagent-spawn').filter((e) => e.deferred === true);
  assert.equal(deferredSpawns.length, size - 2);
  for (const d of deferredSpawns) assert.ok(d.deferredMs > 0);
  // ... and in the parent's own context, which is the only place a model can
  // learn to fan out less.
  const results = ofType(events, 'tool-end').filter((e) => e.name === 'subagent');
  assert.equal(results.filter((r) => /waited \d+ms for a free slot/.test(String(r.content ?? ''))).length, size - 2);

  // The cap is configuration, and it is clamped: unbounded is not reachable.
  assert.equal(DEFAULT_SUBAGENT_CONCURRENCY, 3);
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 1 } }), 1);
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 99 } }), MAX_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 'nonsense' } }), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency(null), DEFAULT_SUBAGENT_CONCURRENCY);
  _resetRegistry();
});

test('the cap holds even under --yolo, which answers tools and not budgets', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const size = 4;
  let parentTurns = 0;
  const approvals = [];
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: Array.from({ length: size }, (_, i) => ({ id: `s${i}`, name: 'subagent', args: { task: `y${i}`, id: `sa_y${i}` } })) }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  const ctx = baseCtx(cwd, {
    yolo: true,
    approval: 'yolo',
    requestApproval: async (name, args) => { approvals.push(args); return true; },
  });
  const events = await runBatch(t, { cwd, port, ctx, config: { subagent: { maxParallel: 2 } } });
  assert.equal(ofType(events, 'subagent-end').length, size);
  assert.ok(peak() <= 2, `--yolo raised the resource ceiling: peak ${peak()}`);
  assert.equal(approvals.length, 1, 'yolo must not have produced a prompt, and the batch produced exactly one decision');
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 3. the live registry shows N agents at once, with independent state
// ---------------------------------------------------------------------------

test('concurrent agents are both in the live registry, each with its own state', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const probes = [];
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? {
          calls: [
            { id: 's1', name: 'subagent', args: { task: 'ALPHA work', description: 'alpha', id: 'sa_r1' } },
            { id: 's2', name: 'subagent', args: { task: 'BETA work', description: 'beta', id: 'sa_r2' } },
          ],
        }
        : { text: 'done' };
    }
    // ALPHA writes a file, BETA globs: two ledgers that cannot be one ledger.
    const task = subagentTask(r);
    const round = r.messages.length;
    if (round === 2) {
      return task.startsWith('ALPHA')
        ? { calls: [{ id: 'w1', name: 'write_file', args: { path: 'src/alpha.js', content: 'export default 1;' } }] }
        : { calls: [{ id: 'g1', name: 'glob', args: { pattern: 'src/*.js' } }] };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: `${task} complete` } }] };
  }, {
    // Held open briefly so BOTH lanes are past registerSubagent and inside
    // their own model call -- the only window in which "N at once" is a fact
    // rather than a hope.
    onRequest: async (r) => {
      if (!isSubagentRequest(r)) return;
      await sleep(140);
      probes.push({
        ids: listLiveSubagents().map((a) => a.id).sort(),
        snapshot: agentSnapshot({ cwd }),
        live: listLiveSubagents(),
      });
    },
  });
  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, { cwd, port, ctx });
  const ends = ofType(events, 'subagent-end');
  assert.equal(ends.length, 2);
  // Independent ledgers: one record's tool counts cannot be the other's.
  const byId = Object.fromEntries(ends.map((e) => [e.id, e.innerTools]));
  assert.equal(byId.sa_r1.write_file, 1, `sa_r1 ledger was ${JSON.stringify(byId.sa_r1)}`);
  assert.equal(byId.sa_r2.write_file, undefined, 'a write from sa_r1 landed on sa_r2');
  assert.equal(byId.sa_r2.glob, 1, `sa_r2 ledger was ${JSON.stringify(byId.sa_r2)}`);
  assert.equal(byId.sa_r1.glob, undefined, 'a glob from sa_r2 landed on sa_r1');

  assert.ok(probes.length >= 2, 'both agents must have reached the model');
  const both = probes.filter((p) => p.ids.length === 2);
  assert.ok(both.length >= 1, `the registry never held two agents; saw ${JSON.stringify(probes.map((p) => p.ids))}`);
  const during = both.at(-1);
  assert.deepEqual(during.ids, ['sa_r1', 'sa_r2']);
  assert.equal(during.snapshot.activeCount, 2, '/agents would report 1 while two agents ran');
  assert.equal(during.snapshot.staleCount, 0, 'a genuinely live agent was reported as stale');
  assert.ok(peak() >= 2, `peak concurrency was ${peak()}`);

  // Independent state: different tasks and different descriptions on the two
  // live records, and -- the part a single shared slot could not represent --
  // two different tool ledgers at the end. ALPHA wrote a file, BETA globbed.
  const [a, b] = during.live;
  assert.notEqual(a.task, b.task);
  assert.notEqual(a.description, b.description);
  assert.notEqual(a.id, b.id);

  // The /agents render is the operator surface, so assert the STRING: this is
  // what "N running, not 1" actually looks like on screen.
  const tree = renderAgentTree({
    cwd,
    sessionId: 'sess-parent',
    model: 'claude-haiku-4-5',
    snapshot: during.snapshot,
  });
  assert.match(tree, /2 running/);
  assert.match(tree, /sa_r1/);
  assert.match(tree, /sa_r2/);
  assert.match(tree, /ALPHA work/);
  assert.match(tree, /BETA work/);

  assert.equal(readDescriptor(cwd, 'sa_r1').filesTouched.join(','), 'src/alpha.js');
  assert.deepEqual(readDescriptor(cwd, 'sa_r2').filesTouched, []);
  assert.equal(liveSubagentCount(), 0);
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 4. per-agent event isolation and ordering
// ---------------------------------------------------------------------------

test('an event for agent A never appears in agent B\'s stream', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? {
          calls: [
            { id: 's1', name: 'subagent', args: { task: 'ALPHA stream', id: 'sa_e1' } },
            { id: 's2', name: 'subagent', args: { task: 'BETA stream', id: 'sa_e2' } },
          ],
        }
        : { text: 'done' };
    }
    // A long, chatty inner run for one agent and a short one for the other, so
    // the two streams are genuinely different in length.
    const task = subagentTask(r);
    const round = r.messages.length;
    if (task.startsWith('ALPHA') && round < 8) {
      return { calls: [{ id: `g${round}`, name: 'glob', args: { pattern: `p${round}/*.js` } }] };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: `${task} done` } }] };
  });
  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, { cwd, port, ctx });
  const lifecycle = events.filter((e) => String(e.type ?? '').startsWith('subagent-'));
  assert.ok(lifecycle.length >= 6, `only ${lifecycle.length} lifecycle events reached the parent`);

  const streams = agentEventStreams(lifecycle);
  assert.deepEqual([...streams.keys()].sort(), ['sa_e1', 'sa_e2']);
  for (const [id, list] of streams) {
    // ISOLATION: every event in an agent's stream belongs to that agent.
    assert.ok(list.every((e) => e.id === id), `agent ${id}'s stream carries another agent's events: ${list.map((e) => e.id).join(',')}`);
    assert.ok(list.length >= 3, `agent ${id} only reported ${list.length} events`);
    // ORDERING: this agent's own sequence is monotonic and starts at 1.
    const seqs = list.map((e) => e.seq);
    assert.ok(seqs.every((n) => Number.isInteger(n) && n >= 1), `agent ${id} has unsequenced events: ${JSON.stringify(seqs)}`);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `agent ${id}'s stream is out of order: ${seqs.join(',')}`);
    assert.equal(seqs[0], 1);
    // And its lifecycle is well-formed: spawn, start, ..., end -- exactly one end.
    assert.equal(list[0].type, 'subagent-spawn');
    assert.equal(list[1].type, 'subagent-start');
    assert.equal(ofType(list, 'subagent-end').length, 1);
    assert.equal(list.at(-1).type, 'subagent-end');
  }
  // The two streams differ, so the split is doing something.
  assert.notEqual(streams.get('sa_e1').length, streams.get('sa_e2').length);

  // No cross-talk on the wire either: a parent's own tool events are never
  // attributed to a subagent, and a subagent's inner events are never replayed.
  assert.equal(lifecycle.some((e) => e.type === 'tool-start' || e.type === 'tool-end'), false);
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 5. stale detection under concurrency
// ---------------------------------------------------------------------------

test('an agent whose worker died is STALE, never "running"', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);

  // Case A: a descriptor from a worker this process does not have. Nobody is
  // working on it; the file is all that survived.
  initDescriptor({ id: 'sa_dead', task: 'crashed mid-fan-out', cwd });
  const snap = agentSnapshot({ cwd });
  assert.equal(snap.activeCount, 0, 'a file on disk was counted as a working agent');
  assert.equal(snap.staleCount, 1);
  assert.equal(snap.stale[0].id, 'sa_dead');
  assert.equal(snap.stale[0].stale, true);
  assert.equal(snap.stale[0].live, false);
  assert.match(snap.stale[0].staleReason, /no live process/);

  // Case B: a descriptor from a DIFFERENT process. Same verdict, and the pid is
  // what says so -- which is the provenance field concurrency made load-bearing.
  const foreign = initDescriptor({ id: 'sa_dead2', task: 'another bridge', cwd });
  foreign.pid = process.pid + 9999;
  fs.writeFileSync(
    path.join(cwd, '.agent', '_sub', 'sa_dead2', 'state.json'),
    JSON.stringify(foreign, null, 2),
  );
  const f = staleSubagents({ cwd }).find((a) => a.id === 'sa_dead2');
  assert.equal(f.stale, true);
  assert.match(f.staleReason, /another process/);

  // Case C: a real fan-out whose worker was killed mid-run. The registry must
  // not keep reporting it, and its descriptor must not be left claiming
  // 'running' with nothing behind it.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) ?? {}; } catch {}
      if (isSubagentRequest(parsed)) {
        // The worker's transport dies: a socket reset mid-run is exactly the
        // shape of "the worker is gone".
        res.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn({ calls: [{ id: 's1', name: 'subagent', args: { task: 'dies', id: 'sa_kill' } }] }));
    });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, { cwd, port, ctx });
  assert.equal(liveSubagentCount(), 0, 'a killed worker is still in the live registry');
  const after = agentSnapshot({ cwd });
  const row = after.live.find((a) => a.id === 'sa_kill');
  assert.equal(row, undefined, 'the killed agent is still on the /agents list');
  const dead = after.stale.find((a) => a.id === 'sa_kill') ?? null;
  if (dead) assert.equal(dead.stale, true);
  // A run that failed is `failed`, and the recently-finished tail says so.
  assert.equal(readDescriptor(cwd, 'sa_kill').status, 'failed');
  assert.ok(ofType(events, 'subagent-end').some((e) => e.id === 'sa_kill' && e.status === 'failed'));
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 6. the approval gate
// ---------------------------------------------------------------------------

// A scripted parent that delegates `n` tasks in ONE turn and then finishes, and
// a scripted subagent that reports straight away. Fresh per call: the parent's
// turn counter is per-server state, so a second run needs a second server.
function scriptedFanOutOf(n, ids = ['sa_a']) {
  let parentTurns = 0;
  const TASKS = ['audit the parser', 'fix the flaky test', 'document the API'];
  return (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? {
          calls: Array.from({ length: n }, (_, i) => ({
            id: `s${i}`,
            name: 'subagent',
            args: { task: TASKS[i], description: `desc ${i}`, id: `${ids[0]}_${i + 1}` },
          })),
        }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  };
}

test('a parallel batch takes ONE approval that shows the whole batch, and a refusal kills all of it', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const { port } = await startMock(t, scriptedFanOutOf(3));

  // --- granted -------------------------------------------------------------
  const granted = [];
  const okCtx = baseCtx(cwd, {
    requestApproval: async (name, args, detail) => {
      granted.push({ name, args, detail });
      return true;
    },
  });
  const okEvents = await runBatch(t, { cwd, port, ctx: okCtx });

  assert.equal(granted.length, 1, `the batch asked ${granted.length} times; it must ask ONCE for the whole batch`);
  assert.equal(granted[0].name, 'subagent');
  // The prompt must SHOW the batch, not just count it. A confirmation that says
  // "3 subagents?" and hides what they are authorises a number, not the work.
  const promptText = `${granted[0].detail}\n${JSON.stringify(granted[0].args)}`;
  for (const task of ['audit the parser', 'fix the flaky test', 'document the API']) {
    assert.ok(promptText.includes(task), `the approval prompt hid the task "${task}":\n${promptText}`);
  }
  assert.equal(granted[0].args.count, 3);
  assert.equal(granted[0].args.batch.split('\n').length, 4, 'the readable batch block must name every call on its own line');
  // And the readable text is what the terminal approver actually renders
  // (renderDetail -> JSON.stringify(args) truncated), so it has to lead.
  assert.ok(String(granted[0].args.batch).startsWith('3 subagents'));
  assert.ok(peak() >= 2, 'an approved batch did not actually run concurrently');
  assert.equal(ofType(okEvents, 'subagent-end').length, 3);

  // --- refused -------------------------------------------------------------
  _resetRegistry();
  const cwd2 = sandbox(t, 'ox-par-refuse-');
  const asked = [];
  const noCtx = baseCtx(cwd2, {
    requestApproval: async (name, args, detail) => { asked.push(detail); return false; },
  });
  // A FRESH scripted parent: the first one has already spent its "first turn"
  // emitting the batch, and reusing it would hand this run a model that has
  // nothing left to delegate.
  const refusalPort = (await startMock(t, scriptedFanOutOf(3))).port;
  const noEvents = await runBatch(t, { cwd: cwd2, port: refusalPort, ctx: noCtx });

  assert.equal(asked.length, 1, `the refusal was asked ${asked.length} times`);
  assert.ok(String(asked[0]).includes('audit the parser'), `the refusal prompt did not show what it refused: ${asked[0]}`);
  // ALL-OR-NOTHING. The old rule authorised nothing; this one authorises
  // everything or nothing, so a "no" cannot leave three half-authorised runs.
  assert.equal(ofType(noEvents, 'subagent-end').length, 0, 'a refused batch still ran an agent');
  assert.equal(liveSubagentCount(), 0, 'a refused batch left an agent in the live registry');
  assert.equal(subagentBatchStats().lastBatch.admitted, 0);
  assert.equal(subagentBatchStats().rejectedTotal, 3);
  const refusedResults = ofType(noEvents, 'tool-end').filter((e) => e.name === 'subagent');
  assert.equal(refusedResults.length, 3, 'every refused call still owes the model a tool result');
  for (const r of refusedResults) {
    assert.equal(r.isError, true);
    assert.match(String(r.content), /user-declined-batch/);
  }
  // No descriptor: a refused agent must not leave an `orphan on disk that the
  // next /agents reports as a stale run.
  for (const i of [1, 2, 3]) {
    assert.equal(fs.existsSync(path.join(cwd2, '.agent', '_sub', `sa_a_${i}`, 'state.json')), false,
      `a refused agent (sa_a_${i}) left an orphan descriptor that /agents would call a stale run`);
  }
  _resetRegistry();
});

test('with no approver attached the fan-out DEGRADES TO SERIAL rather than running unattended', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [
          { id: 's1', name: 'subagent', args: { task: 'u1', id: 'sa_u1' } },
          { id: 's2', name: 'subagent', args: { task: 'u2', id: 'sa_u2' } },
          { id: 's3', name: 'subagent', args: { task: 'u3', id: 'sa_u3' } },
        ] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  // A headless run: no requestApproval on ctx at all, which is the shape of a
  // script driving ox as a library or `ox -p` with no approver.
  const events = await runBatch(t, { cwd, port, ctx: baseCtx(cwd) });

  // The work still happened -- refusing would take a capability away from every
  // scripted run that delegates today -- but the CONCURRENCY, which is the thing
  // that needed authorising, did not.
  assert.equal(ofType(events, 'subagent-end').length, 3);
  assert.equal(peak(), 1, `an unattended fan-out ran at peak ${peak()}`);
  assert.equal(subagentBatchStats().lastBatch.mode, 'serial');
  assert.ok(notes(events).some((t2) => /no approver attached, downgraded to serial/.test(t2)),
    'the downgrade to serial was silent');
  _resetRegistry();
});

test('the batch gate is not weaker than the gate it replaced', async (t) => {
  // The single-call gate, verbatim and unchanged:
  //   * `subagent` is STILL approval_gated -- the class was not softened to make
  //     batching possible.
  assert.equal(classifyTool('subagent'), 'approval_gated');
  assert.deepEqual(RESOURCE_CLASSES, ['pure_read', 'fs_write', 'approval_gated', 'memory_write', 'terminal', 'unknown']);
  //   * a MIXED batch is still refused, before anything executes. This is the
  //     refusal the old rule produced and it must still be the whole turn.
  const mixed = batchPlan([
    { function: { name: 'subagent', arguments: '{}' } },
    { function: { name: 'read_file', arguments: '{}' } },
  ]);
  assert.equal(mixed.mode, 'reject');
  assert.equal(mixed.reason, 'approval-gated tools must run solo (batch rejected)');
  //   * two `bash` calls are not run CONCURRENTLY: concurrency is a property of
  //     having a bounded scheduler, not of the class. They run one after
  //     another, each through its own approval (test/wave5a.test.js).
  assert.equal(batchPlan([{ function: { name: 'bash' } }, { function: { name: 'bash' } }]).mode, 'serial');
  assert.equal(batchPlan([{ function: { name: 'bash' } }, { function: { name: 'mcp__x__y' } }]).mode, 'serial');
  //   * and the scheduler list is exactly one tool, deliberately.
  assert.deepEqual(
    [...['subagent', 'bash', 'write_file', 'mcp__srv__tool']].filter(isConcurrentlyBatchable),
    ['subagent'],
  );

  // The three things a weaker replacement would have done, none of which it does:
  //   (a) dropped the approval requirement for batches -> there is one, and it
  //       names the whole batch;
  //   (b) let a partial batch run after one refusal -> refusal is total;
  //   (c) let the cap be raised by --yolo -> the cap is a resource bound, not a
  //       permission, and yolo does not touch it.
  // (a) and (b) are asserted end-to-end in the test above; (c) in the yolo test.
  const t2 = batchPlan([{ function: { name: 'subagent' } }, { function: { name: 'subagent' } }]);
  assert.equal(t2.mode, 'concurrent', 'the batch path is not reachable at all');
});

// ---------------------------------------------------------------------------
// 7. the cost story
// ---------------------------------------------------------------------------

test('a fan-out cannot spend past the aggregate cap: it divides what is left and the run still stops', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  const { port } = await startMock(t, scriptedFanOutOf(2, ['sa_m']));
  const budget = createCostBudget({ maxCostUsd: 2 });
  const ctx = yoloCtx(cwd);
  // $1.99 of a $2.00 cap already spent, then two agents run. Whatever they cost
  // is charged to the SAME budget, so the sum is bounded by what was left --
  // which is the whole point, and is asserted below rather than assumed.
  const events = await runBatch(t, {
    cwd, port, ctx, budget,
    budgetPrime: (b) => b.record('claude-haiku-4-5', { inputTokens: 1_990_000, outputTokens: 0 }),
  });

  const last = subagentBatchStats().lastBatch;
  assert.equal(last.mode, 'concurrent');
  assert.equal(last.sessionCostCapUsd, 2);
  // The shares are what is left, divided. $0.01 left across two agents.
  assert.ok(last.perAgentCostCeilingUsd > 0 && last.perAgentCostCeilingUsd <= 0.005,
    `the division was ${last.perAgentCostCeilingUsd}`);
  assert.ok(last.perAgentCostCeilingUsd * last.admitted <= 2 - 1.99 + 1e-9,
    'the shares do not sum to at most the remaining budget');

  // Every agent was told its share, on the wire, on its spawn event and in the
  // parent's own tool result -- three surfaces, because a cap nobody can read is
  // not a cap.
  const ends = ofType(events, 'subagent-end');
  assert.equal(ends.length, 2);
  for (const end of ends) {
    assert.equal(end.costCeilingUsd, last.perAgentCostCeilingUsd);
    assert.ok(end.costUsd <= end.costCeilingUsd, `${end.id} spent $${end.costUsd} over its $${end.costCeilingUsd} share`);
    assert.equal(end.status, 'done', `${end.id} failed: ${end.error}`);
  }
  const results = ofType(events, 'tool-end').filter((e) => e.name === 'subagent');
  for (const r of results) assert.match(String(r.content), /Cost: \$/);

  // The aggregate held: two agents plus the parent, all charged to one budget,
  // and it never crossed the cap. This is the "fan-out multiplies spend"
  // property stated as a number rather than a promise.
  assert.ok(budget.snapshot().knownCostUsd < 2, `spend crossed the cap: ${budget.snapshot().knownCostUsd}`);
  _resetRegistry();
});

test('the batch admission guard refuses outright when the cap has no headroom left', () => {
  // The unit half of the guard above. runAgentLoop's own assertCostBudget() runs
  // after every model call, so in an ordinary run the cap is already spent
  // before a batch is ever admitted and this branch is defence in depth -- a
  // subagent driven straight through the tool handler, a budget mutated between
  // a turn's assert and its tools. It is tested directly because it is the only
  // way to reach it without contriving one of those.
  const budget = createCostBudget({ maxCostUsd: 2 });
  const config = { subagent: {} };
  budget.run(() => {
    const headroom = resolveBatchCostDivision(3, config);
    assert.equal(headroom.blocked, null);
    assert.ok(Math.abs(headroom.perAgentUsd - 2 / 3) < 1e-12, 'an untouched cap must divide evenly');
    assert.equal(headroom.sessionCapUsd, 2);

    // A DECLARED per-agent cap only ever LOWERS a share -- the property that
    // makes it safe to offer.
    const lowered = resolveBatchCostDivision(3, { subagent: { maxCostUsd: 0.25 } });
    assert.equal(lowered.perAgentUsd, 0.25);
    const stillLower = resolveBatchCostDivision(100, { subagent: { maxCostUsd: 5 } });
    assert.equal(stillLower.perAgentUsd, 0.02, 'a per-agent cap above the share must not raise it');

    // Spent to the cap: refuse, with a reason that names the numbers.
    budget.record('claude-haiku-4-5', { inputTokens: 2_000_000, outputTokens: 0 });
    const spent = resolveBatchCostDivision(2, config);
    assert.ok(spent.blocked, 'a spent cap admitted a batch anyway');
    assert.match(spent.blocked, /session cost cap of 2 USD is already/);
    assert.equal(spent.perAgentUsd, null);
  });

  // No cap in force at all: no division, no ceiling, nothing invented.
  const free = createCostBudget({});
  free.run(() => {
    const none = resolveBatchCostDivision(4, config);
    assert.equal(none.blocked, null);
    assert.equal(none.perAgentUsd, null);
    assert.equal(none.sessionCapUsd, null);
  });
});

test('the cap visibly DIVIDES, and each agent is held to its share', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  // A model call worth ~$0.30 at the haiku price row (300k in, 0 out), which is
  // comfortably over the tiny per-agent cap below and comfortably under the
  // session cap.
  const bigUsage = { prompt_tokens: 300_000, completion_tokens: 0 };
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [
          { id: 's1', name: 'subagent', args: { task: 'budget a', id: 'sa_b1' } },
          { id: 's2', name: 'subagent', args: { task: 'budget b', id: 'sa_b2' } },
        ] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  }, { usage: bigUsage });

  const budget = createCostBudget({ maxCostUsd: 10 });
  const ctx = yoloCtx(cwd);
  const events = await runBatch(t, {
    cwd,
    port,
    ctx,
    budget,
    // A DECLARED per-agent cap only ever lowers the division, which is the
    // property that makes it safe to offer.
    config: { subagent: { maxCostUsd: 0.0001 } },
  });

  // The division is stated, on the stream and on every agent's spawn event.
  assert.equal(subagentBatchStats().lastBatch.perAgentCostCeilingUsd, 0.0001);
  assert.equal(subagentBatchStats().lastBatch.sessionCostCapUsd, 10);
  const said = notes(events);
  assert.ok(said.some((t2) => /per-agent cost ceiling \$0\.0001 each of \$10 session cap/.test(t2)),
    `the division was not announced:\n${said.join('\n')}`);
  for (const spawn of ofType(events, 'subagent-spawn')) assert.equal(spawn.costCeilingUsd, 0.0001);

  // ... and it was ENFORCED, per agent, not just declared. Both agents stop on
  // their own share instead of running to the session cap.
  const ends = ofType(events, 'subagent-end');
  assert.equal(ends.length, 2);
  for (const end of ends) {
    assert.equal(end.status, 'failed', `${end.id} ran past its ceiling: ${end.error}`);
    assert.equal(end.costCeilingTripped, true);
    assert.ok(end.costUsd >= 0.0001, `${end.id} reported $${end.costUsd}`);
    assert.match(String(end.error), /per-agent cost ceiling reached/);
  }
  // The session cap is untouched and still the second ceiling: a fan-out
  // multiplied by $0.30 twice is nowhere near $10.
  assert.ok(budget.snapshot().knownCostUsd < 10);
  // The parent's own context carries the money, so the model can decide to fan
  // out less next time.
  const results = ofType(events, 'tool-end').filter((e) => e.name === 'subagent');
  assert.equal(results.filter((r) => /CEILING REACHED/.test(String(r.content ?? ''))).length, 2);
  _resetRegistry();
});

test('without a cost cap in force the per-agent ceiling is absent and nothing changes', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [
          { id: 's1', name: 'subagent', args: { task: 'free a', id: 'sa_f1' } },
          { id: 's2', name: 'subagent', args: { task: 'free b', id: 'sa_f2' } },
        ] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  const events = await runBatch(t, { cwd, port, ctx: yoloCtx(cwd) });
  assert.equal(subagentBatchStats().lastBatch.perAgentCostCeilingUsd, null);
  assert.equal(subagentBatchStats().lastBatch.sessionCostCapUsd, null);
  for (const end of ofType(events, 'subagent-end')) {
    assert.equal(end.status, 'done');
    assert.equal('costCeilingUsd' in end, false, 'a ceiling appeared without a cap in force');
  }
  assert.equal(peak() >= 2, true);
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 8. empty / absent shapes
// ---------------------------------------------------------------------------

test('empty and absent tool sets do not break the planner or a run', async (t) => {
  assert.deepEqual(batchPlan([]).groups, []);
  assert.equal(batchPlan([]).mode, 'serial');
  assert.deepEqual(batchPlan(undefined).groups, []);
  assert.deepEqual(batchPlan(null).groups, []);
  assert.deepEqual(batchPlan('not an array').groups, []);
  // A malformed call is `unknown`, which the loop still refuses -- an unparsed
  // tool_call must never be silently dropped from a turn.
  assert.equal(batchPlan([null]).groups[0].class, 'unknown');
  assert.equal(batchPlan([{ function: { name: 'subagent' } }]).mode, 'serial');
  assert.equal(batchPlan([{ function: {} }]).groups[0].class, 'unknown');
  assert.equal(resolveSubagentConcurrency(undefined), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 0 } }), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency({ subagent: null }), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(resolveSubagentConcurrency({}, {}), DEFAULT_SUBAGENT_CONCURRENCY);

  // A parent with NO tools at all beyond the subagent primitive: the subagent
  // still gets its own report_result and still finishes.
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [
          { id: 's1', name: 'subagent', args: { task: 'bare a', id: 'sa_z1' } },
          { id: 's2', name: 'subagent', args: { task: 'bare b', id: 'sa_z2' } },
        ] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  const ctx = yoloCtx(cwd, { allTools: [subagentToolSchema()] });
  const events = await runBatch(t, { cwd, port, ctx });
  assert.equal(ofType(events, 'subagent-end').length, 2);
  assert.equal(ofType(events, 'subagent-end').every((e) => e.status === 'done'), true);
  assert.equal(liveSubagentCount(), 0);
  _resetRegistry();
});

test('a batch of ONE subagent still takes the single-call path untouched', async (t) => {
  _resetRegistry();
  const cwd = sandbox(t);
  let parentTurns = 0;
  const asked = [];
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [{ id: 's1', name: 'subagent', args: { task: 'lone', id: 'sa_l1' } }] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  });
  const ctx = baseCtx(cwd, { yolo: true, approval: 'yolo', requestApproval: async (n, a, d) => { asked.push(n); return true; } });
  const events = await runBatch(t, { cwd, port, ctx });
  assert.equal(ofType(events, 'subagent-end').length, 1);
  // A lone delegation is still the plain serial path -- it must not acquire a
  // batch prompt, a division note, or a scheduler it does not need.
  assert.deepEqual(asked, [], 'a single subagent call was routed through the batch gate');
  assert.equal(notes(events).some((t2) => /subagent batch/.test(t2)), false);
  assert.equal(ofType(events, 'subagent-spawn')[0].costCeilingUsd, undefined);
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// 9. the prompt drift canary
// ---------------------------------------------------------------------------

test('the prompt now says what the runtime does', async (t) => {
  // RUNTIME. This is the half that matters and the half that is true.
  assert.equal(classifyTool('subagent'), 'approval_gated');
  const plan = batchPlan([
    { function: { name: 'subagent', arguments: '{}' } },
    { function: { name: 'subagent', arguments: '{}' } },
  ]);
  assert.equal(plan.mode, 'concurrent');
  assert.equal(plan.reason, null);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].calls.length, 2);

  _resetRegistry();
  const cwd = sandbox(t);
  const probes = [];
  let parentTurns = 0;
  const { port } = await startMock(t, (r) => {
    if (!isSubagentRequest(r)) {
      parentTurns += 1;
      return parentTurns === 1
        ? { calls: [
          { id: 's1', name: 'subagent', args: { task: 'drift a', id: 'sa_d1' } },
          { id: 's2', name: 'subagent', args: { task: 'drift b', id: 'sa_d2' } },
        ] }
        : { text: 'done' };
    }
    return { calls: [{ id: 'rep', name: 'report_result', args: { output: 'ok' } }] };
  }, {
    onRequest: async (r) => {
      if (isSubagentRequest(r)) probes.push(liveSubagentCount());
    },
  });
  const events = await runBatch(t, { cwd, port, ctx: yoloCtx(cwd) });
  assert.equal(ofType(events, 'subagent-spawn').length, 2);
  assert.equal(Math.max(...probes), 2, 'the two subagents never overlapped: the runtime is still serial');

  // PROMPT. The clause is now INTERPOLATED from the same constants this file
  // imports, so "cap is 3" and "ceiling 8" cannot silently rot into a lie: move
  // DEFAULT_SUBAGENT_CONCURRENCY and the string moves with it, and these
  // assertions below are what make that a CONTRACT rather than a coincidence.
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /may be emitted together in one turn and run CONCURRENTLY/);
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /still approval-gated/);
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /may not be mixed with other tools/);
  // The numbers the clause states are the numbers the runtime exports.
  assert.ok(
    SUBAGENT_PARALLEL_CLAUSE.includes(`up to ${DEFAULT_SUBAGENT_CONCURRENCY} at a time`),
    `the clause does not name the real default cap ${DEFAULT_SUBAGENT_CONCURRENCY}:\n${SUBAGENT_PARALLEL_CLAUSE}`,
  );
  assert.ok(
    SUBAGENT_PARALLEL_CLAUSE.includes(`ceiling ${MAX_SUBAGENT_CONCURRENCY}`),
    `the clause does not name the real ceiling ${MAX_SUBAGENT_CONCURRENCY}:\n${SUBAGENT_PARALLEL_CLAUSE}`,
  );
  // Still the discovery routes the code actually reads (resource-class.js
  // resolveSubagentConcurrency), so the model is told where the cap really is.
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /subagent\.maxParallel/);
  assert.match(SUBAGENT_PARALLEL_CLAUSE, /OX_SUBAGENT_CONCURRENCY/);

  // The stale text is gone, by value, not by rename. Pinned as literals rather
  // than as an export name, because a canary that checks "the symbol I renamed
  // still exists" passes the moment someone renames it back.
  assert.equal(SUBAGENT_PARALLEL_CLAUSE.includes('Two subagent calls in one turn are rejected'), false);
  assert.equal(SUBAGENT_PARALLEL_CLAUSE.includes('Delegation is SERIAL'), false);
  assert.equal(/SERIAL/i.test(SUBAGENT_PARALLEL_CLAUSE), false, 'the clause must not claim delegation is serial');

  // The clause must reach the model, in the shipped prompt, in the section the
  // old one lived in -- an export nothing renders is the same defect as a stale
  // export, one layer further out.
  const clauseCwd = sandbox(t, 'ox-par-clause-');
  const built = await buildSystemPrompt({ cwd: clauseCwd, contextParts: {} });
  const section = built.slice(built.indexOf('# SUBAGENTS'), built.indexOf('# SKILLS'));
  assert.match(section, /may be emitted together in one turn and run CONCURRENTLY/);
  assert.equal(
    built.includes('Two subagent calls in one turn are rejected'),
    false,
    'the shipped prompt still tells the model two subagent calls are rejected',
  );
  assert.equal(/Delegation is SERIAL/.test(built), false, 'the shipped prompt still claims delegation is serial');
  _resetRegistry();
});

// Every SENTENCE of the clause, checked against the runtime that must back it.
// Split per assertion rather than one regex, so a future divergence names the
// claim that broke instead of failing one opaque match.
test('every factual claim in SUBAGENT_PARALLEL_CLAUSE is true of the runtime', () => {
  const subagent = (n) => ({ function: { name: 'subagent', arguments: '{}' } });
  const call = (name) => ({ function: { name, arguments: '{}' } });

  // "Independent subagent calls may be emitted together in one turn"
  assert.equal(isConcurrentlyBatchable('subagent'), true, 'the clause promises batching; the predicate denies it');
  const two = batchPlan([subagent(), subagent()]);
  assert.equal(two.mode, 'concurrent');
  assert.equal(two.reason, null);

  // "...up to 3 at a time", and 3 is the DEFAULT, not the ceiling.
  assert.equal(DEFAULT_SUBAGENT_CONCURRENCY, 3, 'the clause hardcodes the number 3');
  assert.equal(MAX_SUBAGENT_CONCURRENCY, 8);
  assert.ok(DEFAULT_SUBAGENT_CONCURRENCY < MAX_SUBAGENT_CONCURRENCY, 'the default must be under the ceiling');
  // The scheduler caps concurrency at the resolved value, resolved from the
  // config key the clause names.
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 2 } }).toString(), '2');
  assert.equal(resolveSubagentConcurrency({}).toString(), '3', 'no config must fall back to the clause default');
  assert.equal(resolveSubagentConcurrency({}, {}).toString(), '3', 'no env must fall back to the clause default');
  // ...and 3 is what runSubagentBatch actually builds lanes from.
  assert.match(
    fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8'),
    /Math\.max\(1, Math\.min\(cap, size\)\)/,
    'runSubagentBatch no longer derives its lane count from the resolved cap',
  );

  // "(config `subagent.maxParallel` or $OX_SUBAGENT_CONCURRENCY, ceiling 8)" --
  // both routes are real, and out-of-range input clamps rather than exceeding
  // the ceiling the clause states.
  assert.equal(resolveSubagentConcurrency({}, { OX_SUBAGENT_CONCURRENCY: '99' }).toString(), '8');
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 0 } }).toString(), '3');
  assert.equal(resolveSubagentConcurrency({ subagent: { maxParallel: 'nonsense' } }).toString(), '3');

  // "; calls past the cap wait for a free slot and still run this turn"
  const four = batchPlan([subagent(), subagent(), subagent(), subagent()]);
  assert.equal(four.mode, 'concurrent', 'a fan-out past the cap is refused instead of deferred');
  assert.equal(four.groups[0].calls.length, 4, 'calls past the cap are dropped, not queued');

  // "The subagent tool is still approval-gated"
  assert.equal(classifyTool('subagent'), 'approval_gated', 'the class was weakened; the gate is what authorises the fan-out');

  // "(one decision covers the whole batch)"
  const agentSrc = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  assert.equal(
    (agentSrc.match(/askApproval\(ctx, BATCH_APPROVAL_TOOL, args, detail\)/g) ?? []).length,
    1,
    'the batch gate no longer asks exactly once',
  );

  // "and still may not be mixed with other tools"
  for (const other of ['read_file', 'write_file', 'bash', 'memory_add', 'glob']) {
    const mixed = batchPlan([subagent(), call(other)]);
    assert.equal(mixed.mode, 'reject', `a subagent mixed with ${other} is no longer rejected`);
    assert.equal(mixed.reason, BATCH_REJECT_APPROVAL, `the rejection reason for ${other} changed`);
  }
});
