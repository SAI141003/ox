import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as gaps1).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctrig-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctrig-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-compaction-trigger-key';
for (const k of ['OX_MODEL_WINDOW', 'OX_COMPACT_AT', 'OX_KEEP_TURNS', 'OX_AUX_BOT']) delete process.env[k];

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

const { estimateTokens } = await import('../src/context.js');
const { listToolSchemas } = await import('../src/tools/index.js');
const { runAgent, tokensOf, toolSchemaTokens, payloadTokens } = await import('../src/agent.js');

const COMPACT_AT = 0.75; // config.js default; unchanged by this fix
const COMPACTION_MAX_PER_RUN = 3; // mirrors src/agent.js

// ---------- mock provider plumbing (OpenAI-compatible SSE over loopback) ------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } } = {}) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  calls.forEach((call, index) => {
    out.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
  });
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function startServer(t, handler) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      bodies.push(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(handler(parsed, bodies.length - 1));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies }))
  );
}

const mkTarget = (port, model = 'mock-model') => ({
  provider: 'custom',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model,
});

const isSummaryBody = (b) => JSON.stringify(b.messages ?? []).includes('Summarize the following coding-agent');

async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}

const tmpDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
};

// ---------- fixtures ----------

// A synthetic MCP-scale tool offer: ~1.5k tokens, the same order as the real
// 13-tool / 8.3 KB block that made this a correctness bug. Sized so that
// pruneToolSchemas is a NO-OP at every small window used below (its cap is
// max(8000, window) * 0.25 = 2000 tokens) — the offer really does ship.
const bigSchemas = () =>
  Array.from({ length: 8 }, (_, i) => ({
    name: `filler_tool_${i}`,
    description: 'd'.repeat(400),
    input_schema: {
      type: 'object',
      properties: { field_0: { type: 'string', description: 'p'.repeat(200) } },
      required: ['field_0'],
    },
  }));

// What the agent actually holds: the offer, strict-ified (additionalProperties
// is forced on any window under 32k, which is every small window in this file).
const OFFER_TOKENS = estimateTokens(JSON.stringify(listToolSchemas({ allTools: bigSchemas() }, true)));

// Six tiny turns: pureCompact(history, keepTurns=4) hands 2 of them to the
// summarizer, but nowhere near the trigger on its own.
const tinyHistory = () => [
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' },
  { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' },
  { role: 'assistant', content: 'a3' },
];

const msg = (role, chars) => ({ role, content: 'z'.repeat(chars) });
// 4 old fat messages (summarized away) + 4 recent ones (kept by keepTurns=4).
const mixedHistory = (oldChars, recentChars) => [
  msg('user', oldChars),
  msg('assistant', oldChars),
  msg('user', oldChars),
  msg('assistant', oldChars),
  msg('user', recentChars),
  msg('assistant', recentChars),
  msg('user', recentChars),
  msg('assistant', recentChars),
];

// ===========================================================================
// The regression guard: the trigger must measure history PLUS tool schemas.
// ===========================================================================

test('a tool offer too heavy for a small window is pruned to fit, so schema weight alone no longer forces a compaction', async (t) => {
  const cwd = tmpDir(t, 'ox-ctrig-schemas-');
  const window = 1800; // 0.75 * 1800 = 1350 < OFFER_TOKENS
  assert.ok(OFFER_TOKENS > window * COMPACT_AT, 'fixture must put the offer over the threshold');
  assert.ok(OFFER_TOKENS <= Math.max(8000, window) * 0.25, 'fixture must survive schema pruning untouched');

  // Probe run: identical history and offer, but a window so wide that nothing
  // fires, so we can read the UNCOMPACTED payload estimate off the agent.
  const probeSrv = await startServer(t, () => turn({ text: 'PROBE_DONE' }));
  const probeEvents = await collectEvents({
    target: mkTarget(probeSrv.port),
    messages: tinyHistory(),
    ctx: { cwd, allTools: bigSchemas(), modelWindow: 128_000 },
    config: { strictSchemas: true, tools: { narrow: false } },
    auxTarget: null,
  });
  const probe = probeEvents.find((e) => e.type === 'context-estimate');
  assert.equal(probe.schemaTokens, OFFER_TOKENS, 'probe counted the same offer');
  assert.ok(
    probe.historyTokens < window * COMPACT_AT,
    `tokensOf(history) alone (${probe.historyTokens}) stays under the ${window * COMPACT_AT}-token threshold`
  );
  assert.ok(
    probe.historyTokens + probe.schemaTokens > window * COMPACT_AT,
    `the payload actually sent (${probe.historyTokens}+${probe.schemaTokens}) is over it — the old trigger never saw this`
  );

  // Same inputs, real window. Since 429becc a small window caps the tool offer
  // at a quarter of the window, so schema weight alone can no longer cross the
  // compaction line: the offer is pruned to fit instead, and the estimate the
  // trigger reads is still the whole payload (history + the schemas sent).
  const srv = await startServer(t, (b) =>
    isSummaryBody(b) ? turn({ text: 'SCHEMA_WEIGHT_SUMMARY kept decisions' }) : turn({ text: 'SCHEMA_WEIGHT_DONE' })
  );
  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: tinyHistory(),
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window },
    config: { tools: { narrow: false } },
    auxTarget: null,
  });
  const est = events.find((e) => e.type === 'context-estimate');
  assert.ok(est.schemaTokens < probe.schemaTokens, `the heavy offer was pruned to fit (${est.schemaTokens} < ${probe.schemaTokens})`);
  assert.equal(est.tokens, est.historyTokens + est.schemaTokens, 'the trigger reads the payload, schemas included');
  assert.ok(est.tokens < window * COMPACT_AT, `the pruned payload fits under the line (${est.tokens} < ${window * COMPACT_AT})`);
  assert.equal(events.filter((e) => e.type === 'compaction').length, 0, 'nothing to compact once the offer fits');
  assert.ok(!srv.bodies.some(isSummaryBody), 'no summarizer call was spent');
  assert.ok(events.some((e) => e.type === 'final'), 'run completes');
});

test('the schema term is the offer that really ships, measured in token units', async (t) => {
  const cwd = tmpDir(t, 'ox-ctrig-units-');
  const srv = await startServer(t, () => turn({ text: 'UNITS_DONE' }));
  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: tinyHistory(),
    // strictSchemas forced so the offer is byte-for-byte the fixture offer
    ctx: { cwd, allTools: bigSchemas(), modelWindow: 128_000 },
    config: { strictSchemas: true, tools: { narrow: false } },
    auxTarget: null,
  });
  const est = events.find((e) => e.type === 'context-estimate');
  assert.equal(est.schemaTokens, OFFER_TOKENS, 'schemaTokens === estimateTokens(JSON.stringify(the sent offer))');
  assert.equal(est.historyTokens, tokensOf(srv.bodies.at(-1).messages), 'historyTokens measures the wire history');
  assert.equal(est.tokens, est.historyTokens + est.schemaTokens, 'est is the sum of both terms');
  assert.ok((srv.bodies.at(-1).tools ?? []).length > 0, 'tools are shipped alongside messages');
});

// ===========================================================================
// No false positives.
// ===========================================================================

test('small schemas and a small history do NOT fire compaction', async (t) => {
  const cwd = tmpDir(t, 'ox-ctrig-nofire-');
  const srv = await startServer(t, () => turn({ text: 'NOFIRE_DONE' }));
  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: tinyHistory(),
    ctx: { cwd, modelWindow: 128_000 }, // real default offer, wide window
    auxTarget: null,
  });
  const est = events.find((e) => e.type === 'context-estimate');
  assert.ok(est.schemaTokens > 0, 'the real offer is still counted');
  assert.ok(est.tokens < 128_000 * COMPACT_AT, 'payload is far below the threshold');
  assert.equal(events.some((e) => e.type === 'compaction'), false, 'no compaction');
  assert.equal(events.some((e) => e.type === 'final'), true, 'single turn completes');
});

// ===========================================================================
// A payload over the real window must never reach the provider uncompacted.
// ===========================================================================

test('a payload (history + schemas) over the window is compacted before the request goes out', async (t) => {
  const cwd = tmpDir(t, 'ox-ctrig-overwin-');
  const window = 4000; // 0.75*4000 = 3000 trigger, pruning cap 2000 -> offer untouched
  const srv = await startServer(t, (b) =>
    isSummaryBody(b) ? turn({ text: 'OVERWIN_SUMMARY kept decisions' }) : turn({ text: 'OVERWIN_DONE' })
  );

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: mixedHistory(1100, 1100), // 4 old fat + 4 recent (keepTurns keeps 4)
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window },
    config: { tools: { narrow: false } },
    auxTarget: null,
  });

  // Probe the same history uncompacted to prove the pre-compaction payload.
  const probeSrv = await startServer(t, () => turn({ text: 'PROBE2_DONE' }));
  const probeEvents = (
    await collectEvents({
      target: mkTarget(probeSrv.port),
      messages: mixedHistory(1100, 1100),
      ctx: { cwd, allTools: bigSchemas(), modelWindow: 128_000 },
      config: { strictSchemas: true, tools: { narrow: false } },
      auxTarget: null,
    })
  );
  const probe = probeEvents.find((e) => e.type === 'context-estimate');
  // The distinguishing shape: history alone stays UNDER the trigger, yet the
  // payload that goes on the wire is OVER the real window. The old
  // history-only trigger saw 2600 < 3000 and sailed straight past this.
  assert.ok(
    probe.historyTokens < window * COMPACT_AT,
    `history alone (${probe.historyTokens}) stays under the ${window * COMPACT_AT}-token trigger`
  );
  assert.ok(
    probe.tokens > window,
    `but the payload really sent (${probe.tokens}) exceeds the ${window}-token window`
  );

  assert.equal(events.filter((e) => e.type === 'compaction').length, 1, 'compaction ran');

  const mainBodies = srv.bodies.filter((b) => !isSummaryBody(b));
  assert.ok(mainBodies.length >= 1, 'at least one main request reached the provider');
  for (const b of mainBodies) {
    const sent = estimateTokens(JSON.stringify(b.messages ?? [])) + estimateTokens(JSON.stringify(b.tools ?? []));
    assert.ok(sent <= window, `every request actually sent fits the window (${sent} <= ${window})`);
  }
  assert.ok(events.some((e) => e.type === 'final'), 'run completes');
});

// ===========================================================================
// Safety: schemas alone over the budget must not spin.
// ===========================================================================

test('tool schemas alone over the budget never spin — the run terminates with one warning', async (t) => {
  const cwd = tmpDir(t, 'ox-ctrig-spin-');
  const window = 400; // 0.75*400 = 300 << OFFER_TOKENS; pruning cap still 2000
  assert.ok(OFFER_TOKENS > window * COMPACT_AT, 'fixture is the pathological case');

  fs.writeFileSync(path.join(cwd, 'lib.js'), 'export const x = 1;\n');

  // Every turn calls a tool, so history keeps growing and the trigger would
  // re-fire on every iteration without the per-run cap.
  const srv = await startServer(t, (b) =>
    isSummaryBody(b)
      ? turn({ text: 'SPIN_SUMMARY kept decisions' })
      : turn({
          calls: [{ id: `c_${srv.bodies.length}`, name: 'read_file', args: { path: path.join(cwd, 'lib.js') } }],
        })
  );

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: tinyHistory(),
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window },
    config: { tools: { narrow: false } },
    auxTarget: null,
    maxIterations: 12,
  });

  const compactions = events.filter((e) => e.type === 'compaction');
  assert.ok(compactions.length > 0, 'it did try to compact');
  assert.ok(
    compactions.length <= COMPACTION_MAX_PER_RUN,
    `compaction is capped per run, no spin (${compactions.length} <= ${COMPACTION_MAX_PER_RUN})`
  );
  const warns = events.filter((e) => e.type === 'warning' && String(e.text).includes('compaction cannot reclaim'));
  assert.equal(warns.length, 1, 'the un-reclaimable payload is reported exactly once');
  assert.match(warns[0].text, /tool schemas alone are \d+ of the \d+ tokens sent/);
  assert.ok(events.some((e) => e.type === 'history'), 'the run terminated and emitted its final history');
  // The summarizer must not be what burns the run.
  assert.ok(srv.bodies.filter(isSummaryBody).length <= COMPACTION_MAX_PER_RUN, 'summarizer calls are bounded');
});

// ===========================================================================
// Empty (no-tools) offers behave exactly as before the fix.
// ===========================================================================

test('an empty tool offer contributes 0 and leaves the trigger formula untouched', () => {
  const msgs = tinyHistory();
  const base = tokensOf(msgs);
  assert.equal(toolSchemaTokens([]), 0);
  assert.equal(toolSchemaTokens(undefined), 0);
  assert.equal(toolSchemaTokens(null), 0);
  assert.equal(toolSchemaTokens([null, undefined]), 0, 'filtered-out entries are not counted');
  assert.equal(payloadTokens(msgs, []), base, 'payload === history when there are no tools');
  assert.equal(payloadTokens(msgs, undefined), base);
  assert.equal(payloadTokens(msgs, null), base);
  assert.equal(payloadTokens(msgs, {}), base, 'a non-array offer is treated as no offer');
  // no division / NaN anywhere in the trigger predicate
  const window = 1800;
  const est = payloadTokens(msgs, []);
  assert.equal(Number.isFinite(est), true);
  assert.equal(est > window * COMPACT_AT, base > window * COMPACT_AT, 'identical predicate to the old formula');
});

// ===========================================================================
// Both terms come from the same estimator.
// ===========================================================================

test('est sums estimateTokens (chars/4) for history and for schemas — no mixed units', () => {
  const msgs = [
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'y'.repeat(400) },
  ];
  const tools = [
    { name: 't', description: 'z'.repeat(800), input_schema: { type: 'object', properties: {} } },
  ];

  // hand-computed, term by term, with the SAME estimator (Math.ceil(len / 4))
  const expectHistory = msgs.reduce((n, m) => n + Math.ceil(JSON.stringify(m).length / 4), 0);
  const expectSchemas = Math.ceil(JSON.stringify(tools).length / 4);
  assert.equal(estimateTokens(JSON.stringify(msgs[0])), Math.ceil(JSON.stringify(msgs[0]).length / 4));
  assert.equal(tokensOf(msgs), expectHistory, 'history term is estimateTokens per message');
  assert.equal(toolSchemaTokens(tools), expectSchemas, 'schema term is estimateTokens on the serialized offer');
  assert.equal(payloadTokens(msgs, tools), expectHistory + expectSchemas, 'est is the sum of both, same units');

  // explicitly NOT a character count for the schema term
  assert.notEqual(toolSchemaTokens(tools), JSON.stringify(tools).length);

  // the two terms are directly comparable against one window
  const window = 400;
  assert.equal(tokensOf(msgs) > window * COMPACT_AT, false, 'history alone stays under the trigger');
  assert.equal(payloadTokens(msgs, tools) > window * COMPACT_AT, true, 'the real payload crosses the same trigger');
});
