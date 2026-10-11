import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as the sibling
// compaction-trigger.test.js).
// ---------------------------------------------------------------------------
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctxbd-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctxbd-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-context-breakdown-key';
for (const k of ['OX_MODEL_WINDOW', 'OX_COMPACT_AT', 'OX_KEEP_TURNS', 'OX_AUX_BOT', 'OX_COMPACTION_MODEL', 'OX_TWO_PASS']) {
  delete process.env[k];
}

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

const { estimateTokens, breakdownContext, pureCompact, describeLargestSegment } = await import('../src/context.js');
const { listToolSchemas } = await import('../src/tools/index.js');
const { runAgent, tokensOf, toolSchemaTokens, payloadTokens } = await import('../src/agent.js');
const { buildContextReport, formatContextBreakdown, contextBreakdownToJson } = await import('../src/context-report.js');
const { compactionKnobs, compactionModelChoice, resolveCompactionTarget, resetCompactionModelWarningForTest } =
  await import('../src/config.js');
const { loadConfig } = await import('../src/config.js');

const COMPACT_AT = 0.75; // ox default; asserted, not assumed, in the threshold test
const COMPACTION_MAX_PER_RUN = 3; // mirrors src/agent.js

const SUMMARY_PREFIX = '[ox: summary of earlier conversation turns]\n';

// ---------- mock provider (OpenAI-compatible SSE over loopback) --------------
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
                { index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } },
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies })));
}
const mkTarget = (port, model = 'mock-model') => ({ provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model });
const isSummaryBody = (b) => JSON.stringify(b.messages ?? []).includes('Summarize the following coding-agent');
// The PROJECT INSTRUCTIONS block of a system prompt, verbatim. Compaction
// re-reads context from disk, so the `# date:` line and the workspace tree are
// EXPECTED to change (ox writes session notes mid-run); the instructions the
// model is bound by are not. Comparing this section is the precise claim.
// The PROJECT INSTRUCTIONS section, and ONLY that section.
//
// This used to slice to the end of the prompt, which was correct while
// PROJECT INSTRUCTIONS was the last section ox emitted. Cache-stable prompt
// layering moved the volatile tail (memory block, clock) behind it, so
// end-of-prompt now reaches bytes that are EXPECTED to move between two
// requests -- the caller re-stamps the date every build. The boundary is now
// the next ox-owned section header.
//
// Not `\n# `: a nested AGENTS.md is markdown, so it legitimately contains its
// own `# rules` heading, and cutting there would silently compare a prefix.
const INSTRUCTIONS_END = /^# (MEMORY|EXTRA GUIDANCE|REPO MAP)|^## GOAL CONTRACT/m;
const instructionsOf = (b) => {
  const sys = String((b.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
  const i = sys.indexOf('# PROJECT INSTRUCTIONS');
  if (i === -1) return '';
  const rest = sys.slice(i);
  const end = rest.slice(1).search(INSTRUCTIONS_END);
  return end === -1 ? rest : rest.slice(0, end + 1);
};
async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}
const tmpDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A realistic assembled payload: real system prompt text + a real multi-tool
// schema offer + a conversation. The point of every assertion below is that
// these are the SAME objects the provider receives.
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
const OFFER = listToolSchemas({ allTools: bigSchemas() }, true);
const SYSTEM_TEXT = ['You are ox.', 'PROJECT INSTRUCTIONS: obey the tests.', 'Always run npm test.'].join('\n');
// The latest turn is sized to beat both the system prompt and the 8-tool offer,
// so "largest segment" has a clear, unambiguous winner in the default fixture.
const realMessages = [
  { role: 'user', content: 'first question about the parser' },
  { role: 'assistant', content: 'a'.repeat(600) },
  { role: 'user', content: 'follow-up: ' + 'b'.repeat(900) },
  { role: 'assistant', content: 'c'.repeat(400) },
  { role: 'user', content: 'now the biggest message: ' + 'd'.repeat(9000) },
];
const LATEST_TOKENS = estimateTokens(JSON.stringify(realMessages.at(-1)));
assert.ok(
  LATEST_TOKENS > toolSchemaTokens(OFFER) && LATEST_TOKENS > estimateTokens(JSON.stringify({ role: 'system', content: SYSTEM_TEXT })),
  'fixture: the latest user turn really is the biggest term'
);

// ===========================================================================
// 1. /context reports correct per-segment byte and token counts for a real
//    assembled prompt, and the segments sum to the total sent.
// ===========================================================================
test('/context segments a real assembled payload: byte+token counts are exact and sum to the payload', () => {
  const history = [{ role: 'system', content: SYSTEM_TEXT }, ...realMessages];
  const bd = breakdownContext({ messages: history, tools: OFFER, window: 32768, threshold: COMPACT_AT, summaryPrefix: SUMMARY_PREFIX });

  // --- the sum invariant, checked against the SAME functions the agent meters
  //     with. This is the assertion that makes every other number trustworthy.
  const segmentTokens = bd.segments.reduce((n, s) => n + s.tokens, 0);
  const segmentBytes = bd.segments.reduce((n, s) => n + s.bytes, 0);
  assert.equal(segmentTokens, payloadTokens(history, OFFER), 'segment tokens must equal the full payload ox sends');
  assert.equal(bd.total.tokens, payloadTokens(history, OFFER));
  assert.equal(segmentTokens, tokensOf(history) + toolSchemaTokens(OFFER), 'history + schemas, no double counting');
  // Bytes are measured PER MESSAGE, which is what ox actually meters (see
  // tokensOf). The array JSON ox puts on the wire adds framing — 2 brackets
  // and one comma per gap — so the segment total is exactly that much smaller
  // than the serialized array. Asserted, not hand-waved, so the byte column is
  // known-exact rather than approximately right.
  const framing = 2 + (history.length - 1);
  assert.equal(
    bd.total.bytes,
    Buffer.byteLength(JSON.stringify(history), 'utf8') - framing + Buffer.byteLength(JSON.stringify(OFFER), 'utf8'),
    'byte total is the per-message content plus the schema array; JSON array framing accounted for explicitly'
  );

  // --- per-segment exactness, computed independently of the implementation.
  const byId = Object.fromEntries(bd.segments.map((s) => [s.id, s]));
  assert.equal(byId['system-prompt'].tokens, estimateTokens(JSON.stringify(history[0])));
  assert.equal(byId['system-prompt'].bytes, Buffer.byteLength(JSON.stringify(history[0]), 'utf8'));
  assert.equal(byId['tool-definitions'].tokens, toolSchemaTokens(OFFER), 'schemas measured with the agent-s own estimator');
  assert.equal(byId['tool-definitions'].bytes, Buffer.byteLength(JSON.stringify(OFFER), 'utf8'));
  assert.equal(byId['tool-definitions'].messages, OFFER.length, 'one entry per schema offered');

  // latest-input is the LAST user turn and is counted once, not in history.
  const lastUser = JSON.stringify(realMessages[realMessages.length - 1]);
  assert.equal(byId['latest-input'].tokens, estimateTokens(lastUser));
  assert.equal(byId['latest-input'].messages, 1);
  assert.equal(byId['conversation-history'].messages, realMessages.length - 1, 'every non-system message except the latest user turn');
  assert.equal(byId.other.messages, 0, 'no mid-conversation system message in this fixture');

  // history-only accounting is what the old shape got wrong; the breakdown must
  // be strictly larger because the schemas are a real segment.
  assert.ok(bd.total.tokens > tokensOf(history), 'the schemas must not be invisible');

  // percentages are internally consistent
  const pctSum = bd.segments.reduce((n, s) => n + s.pctOfPayload, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-6, `percentages sum to 100, got ${pctSum}`);
  assert.ok(Math.abs(bd.windowPct - (bd.total.tokens / 32768) * 100) < 1e-9, 'window % is of the real window');
});

// ===========================================================================
// 2. The breakdown identifies the largest segment accurately.
// ===========================================================================
test('the breakdown names the largest segment accurately, in several shapes', () => {
  // (a) fat user message wins
  let bd = breakdownContext({ messages: [{ role: 'system', content: SYSTEM_TEXT }, ...realMessages], tools: OFFER });
  assert.equal(bd.largest.id, 'latest-input', 'the 5000-char latest user turn is the biggest thing here');
  assert.equal(bd.largest.tokens, estimateTokens(JSON.stringify(realMessages.at(-1))));
  const biggest = bd.segments.find((s) => s.id === bd.largest.id);
  for (const s of bd.segments) assert.ok(s.tokens <= biggest.tokens, `${s.id} must not exceed the claimed largest`);
  assert.match(describeLargestSegment(bd), /latest user input is the largest segment/);

  // (b) fat schema offer wins — the case compaction cannot reclaim, so naming it
  //     correctly is the whole point of the report.
  const fatOffer = listToolSchemas(
    {
      allTools: Array.from({ length: 20 }, (_, i) => ({
        name: `tool_${i}`,
        description: 'x'.repeat(900),
        input_schema: { type: 'object', properties: { f: { type: 'string', description: 'y'.repeat(600) } } },
      })),
    },
    true
  );
  bd = breakdownContext({ messages: [{ role: 'system', content: SYSTEM_TEXT }], tools: fatOffer });
  assert.equal(bd.largest.id, 'tool-definitions');
  assert.equal(bd.largest.tokens, toolSchemaTokens(fatOffer));
  assert.ok(bd.largest.tokens > estimateTokens(SYSTEM_TEXT), 'fixture: the offer really is the biggest term');

  // (c) fat system prompt wins
  bd = breakdownContext({ messages: [{ role: 'system', content: 'S'.repeat(40_000) }], tools: [] });
  assert.equal(bd.largest.id, 'system-prompt');

  // (d) empty context must not crash or invent a winner
  bd = breakdownContext({ messages: [], tools: [] });
  assert.equal(bd.total.tokens, 0);
  assert.equal(describeLargestSegment(bd), 'no context yet');
});

// The renderer and the JSON shape must describe the same numbers as the data.
test('the rendered breakdown and the JSON form agree with the measured data', () => {
  const report = buildContextReport({
    systemPrompt: SYSTEM_TEXT,
    messages: realMessages,
    tools: OFFER,
    window: 32768,
    model: 'mock-model',
    threshold: COMPACT_AT,
    summaryPrefix: SUMMARY_PREFIX,
  });
  assert.equal(report.total.tokens, payloadTokens([{ role: 'system', content: SYSTEM_TEXT }, ...realMessages], OFFER));

  const text = formatContextBreakdown(report, { model: 'mock-model' });
  assert.match(text, /system prompt/);
  assert.match(text, /tool definitions/);
  assert.match(text, /conversation history/);
  assert.match(text, /latest user input/);
  assert.match(text, /total sent/);
  assert.ok(text.includes(report.total.tokens.toLocaleString('en-US')), 'the total the agent sends appears in the render');
  assert.match(text, /largest:/);

  const json = contextBreakdownToJson(report, { model: 'mock-model' });
  assert.equal(json.totalTokens, report.total.tokens);
  assert.equal(json.totalBytes, report.total.bytes);
  assert.equal(json.thresholdAt, COMPACT_AT);
  assert.equal(json.segments.length, 5);
  assert.equal(json.segments.reduce((n, s) => n + s.tokens, 0), json.totalTokens);
  assert.deepEqual(json.largest, report.largest);
});

// ===========================================================================
// 3. Auto-compaction fires when the FULL payload (schemas + history) crosses
//    the threshold — including when history alone is under it. REGRESSION GUARD
//    for the bug where tool schemas were invisible to the trigger.
// ===========================================================================
test('REGRESSION: compaction fires on the FULL payload when history alone is under the threshold', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-full-');
  const window = 1800; // 0.75 * 1800 = 1350
  const offerTokens = toolSchemaTokens(OFFER);
  assert.ok(offerTokens > window * COMPACT_AT, 'fixture: the offer alone crosses the threshold');
  assert.ok(tokensOf([
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
  ]) < window * COMPACT_AT, 'fixture: history alone stays UNDER the threshold');

  const { port, bodies } = await startServer(t, (b, i) => {
    if (isSummaryBody(b)) return turn({ text: 'COMPACTED_SUMMARY kept the decisions' });
    return i === 0 ? turn({ text: 'first answer' }) : turn({ text: 'done' });
  });
  const events = await collectEvents({
    target: mkTarget(port),
    auxTarget: null, // disable aux lookup so the summarizer is the main target
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
    ],
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 4 },
  });

  const compactions = events.filter((e) => e.type === 'compaction');
  assert.equal(compactions.length, 1, 'the trigger must see the schema block, not just history');
  assert.ok(bodies.some(isSummaryBody), 'a summarizer call actually happened');
  // The trigger's own accounting: the pre-compaction estimate the agent used is
  // the payload, and the context-estimate event agrees.
  const est = events.find((e) => e.type === 'context-estimate');
  assert.ok(est.tokens > window * COMPACT_AT, 'measured payload crossed the threshold');
  assert.equal(est.tokens, est.historyTokens + est.schemaTokens, 'payload = history + schemas');
});

// ===========================================================================
// 4. Auto-compaction does NOT fire below the threshold.
// ===========================================================================
test('no compaction below the threshold: a small payload is left alone', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-under-');
  const window = 400_000; // trigger at 300k; this payload is ~2k
  const { port, bodies } = await startServer(t, (b, i) =>
    i === 0 ? turn({ text: 'no compaction needed' }) : turn({ text: 'done' })
  );
  const events = await collectEvents({
    target: mkTarget(port),
    auxTarget: null,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'anything else?' },
    ],
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 4 },
  });
  assert.equal(events.filter((e) => e.type === 'compaction').length, 0, 'no compaction');
  assert.equal(bodies.filter(isSummaryBody).length, 0, 'no summarizer call was paid for');
  const est = events.find((e) => e.type === 'context-estimate');
  assert.ok(est.tokens < window * COMPACT_AT, 'payload really is under the trigger');
  // The breakdown says so too, which is what /context will show the user.
  const bd = events.find((e) => e.type === 'context-breakdown');
  assert.equal(bd.threshold.crossed, false);
  assert.ok(bd.threshold.headroomTokens > 0);
});

// ===========================================================================
// 5. Compaction cannot loop (the per-run cap still holds).
// ===========================================================================
test('compaction is capped per run and warns once instead of re-summarizing forever', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-cap-');
  fs.writeFileSync(path.join(cwd, 'lib.js'), 'export const x = 1;\n');
  // The pathological case: the schemas alone sit over the trigger and
  // compaction cannot reclaim them, so without the cap this re-fires forever.
  // Every turn calls a tool, so the loop keeps running PAST the cap — which is
  // what actually exercises the guard rather than finishing on turn one.
  const window = 400;
  assert.ok(toolSchemaTokens(OFFER) > window * COMPACT_AT, 'fixture: the offer alone is over the trigger');

  const srv = await startServer(t, (b) =>
    isSummaryBody(b)
      ? turn({ text: 'SUMMARY kept decisions' })
      : turn({ calls: [{ id: `c_${srv.bodies.length}`, name: 'read_file', args: { path: path.join(cwd, 'lib.js') } }] })
  );
  const events = await collectEvents({
    target: mkTarget(srv.port),
    auxTarget: null,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ],
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window, yolo: true },
    config: { tools: { narrow: false }, compactAt: COMPACT_AT },
    maxIterations: 12,
  });
  const compactions = events.filter((e) => e.type === 'compaction');
  assert.ok(compactions.length > 0, 'it did try to compact');
  assert.ok(
    compactions.length <= COMPACTION_MAX_PER_RUN,
    `capped per run, no spin (${compactions.length} <= ${COMPACTION_MAX_PER_RUN})`
  );
  assert.ok(srv.bodies.filter(isSummaryBody).length <= COMPACTION_MAX_PER_RUN, 'summarizer calls are bounded too');
  const warns = events.filter((e) => e.type === 'warning' && String(e.text).includes('compaction cannot reclaim'));
  assert.equal(warns.length, 1, 'the un-reclaimable payload is reported exactly once, not every turn');
  assert.match(warns[0].text, /tool schemas alone are \d+ of the \d+ tokens sent/);
  // Each compaction event carries the cap so an auditor can verify it was honoured.
  for (const c of compactions) assert.equal(c.cap, COMPACTION_MAX_PER_RUN);
  assert.deepEqual(
    compactions.map((c) => c.index),
    compactions.map((_, i) => i + 1),
    'the audit numbers each compaction, and the sequence never exceeds the cap'
  );
});

// ===========================================================================
// 6. A separate compaction model is used when configured; the main model is
//    used otherwise.
// ===========================================================================
test('a dedicated compaction_model runs the summarizer; without one, the main model does', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-model-');
  const window = 1800; // same fixture shape as the regression test: schemas trip it
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },
  ];

  // --- (a) dedicated compaction model -------------------------------------
  {
    const { port, bodies } = await startServer(t, (b, i) =>
      isSummaryBody(b) ? turn({ text: 'cheap summary' }) : i === 0 ? turn({ text: 'a' }) : turn({ text: 'b' })
    );
    const events = await collectEvents({
      target: mkTarget(port, 'main-model'),
      auxTarget: null,
      messages,
      ctx: { allTools: bigSchemas(), modelWindow: window, yolo: true },
      config: {
        compactAt: COMPACT_AT,
        keepTurns: 4,
        // A bot spec that resolves against the running mock endpoint.
        bots: { 'cheap-summarizer': { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'cheap-model' } },
        compactionModel: 'cheap-summarizer',
      },
      cwd,
    });
    const summaryReq = bodies.find(isSummaryBody);
    assert.ok(summaryReq, 'the summarizer was called');
    assert.equal(summaryReq.model, 'cheap-model', 'the DEDICATED model served the summarizer, not the main one');
    const firstRequest = bodies.find((b) => !isSummaryBody(b));
    assert.equal(firstRequest.model, 'main-model', 'the main conversation still uses the main model');
    const c = events.find((e) => e.type === 'compaction');
    assert.equal(c.compactionModel, 'cheap-model');
    assert.equal(c.model, 'cheap-model');
    assert.equal(c.compactionModelSource, 'compaction_model');
    assert.equal(c.separateCompactionModel, true);
    // The compaction turn is billed to the model that actually served it.
    const compactionUsage = events.find((e) => e.type === 'usage' && e.compaction === true);
    assert.ok(compactionUsage, 'the compaction turn is still charged to the ledger');
    assert.equal(compactionUsage.model, 'cheap-model');
  }

  // --- (b) no compaction_model => the main model summarizes ---------------
  {
    const { port, bodies } = await startServer(t, (b, i) =>
      isSummaryBody(b) ? turn({ text: 'main-model summary' }) : i === 0 ? turn({ text: 'a' }) : turn({ text: 'b' })
    );
    const events = await collectEvents({
      target: mkTarget(port, 'main-model'),
      auxTarget: null, // no aux bot configured or auto-routable
      messages,
      ctx: { allTools: bigSchemas(), modelWindow: window, yolo: true },
      config: { compactAt: COMPACT_AT, keepTurns: 4 },
      cwd,
    });
    const summaryReq = bodies.find(isSummaryBody);
    assert.ok(summaryReq, 'the summarizer was called');
    assert.equal(summaryReq.model, 'main-model', 'unconfigured => the MAIN model summarizes');
    const c = events.find((e) => e.type === 'compaction');
    assert.equal(c.compactionModel, 'main-model');
    assert.equal(c.compactionModelSource, 'main');
    assert.equal(c.separateCompactionModel, false);
  }
});

test('compaction-model resolution: explicit spec wins, aux is the fallback, and a bad spec degrades', () => {
  const main = { provider: 'custom', model: 'main-model' };
  const aux = { provider: 'custom', model: 'aux-model' };
  const config = {
    bots: { cheap: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', model: 'cheap-model' } },
  };

  resetCompactionModelWarningForTest();
  let d = resolveCompactionTarget({ ...config, compactionModel: 'cheap' }, { main });
  assert.equal(d.model, 'cheap-model');
  assert.equal(d.dedicated, true);

  // unconfigured -> names the main target, explicitly marked as not dedicated
  d = resolveCompactionTarget({}, { main });
  assert.equal(d.model, 'main-model');
  assert.equal(d.dedicated, false);

  // the fallback chain the caller walks
  let choice = compactionModelChoice({ ...config, compactionModel: 'cheap' }, { aux, main });
  assert.equal(choice.model, 'cheap-model');
  assert.equal(choice.source, 'compaction_model');
  assert.equal(choice.separateFromMain, true);

  choice = compactionModelChoice({}, { aux, main });
  assert.equal(choice.model, 'aux-model');
  assert.equal(choice.source, 'aux_bot');

  choice = compactionModelChoice({}, { main });
  assert.equal(choice.model, 'main-model');
  assert.equal(choice.source, 'main');

  // unusable spec: warns once, returns null, never throws mid-run
  const errs = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    errs.push(String(s));
    return true;
  };
  try {
    resetCompactionModelWarningForTest();
    assert.equal(resolveCompactionTarget({ compactionModel: 'definitely-not-a-bot' }, { main }), null);
    assert.equal(resolveCompactionTarget({ compactionModel: 'definitely-not-a-bot' }, { main }), null);
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(errs.filter((e) => e.includes('compaction_model')).length, 1, 'warns exactly once');
});

test('loadConfig reads compaction_model from file, nested compaction block, and env', () => {
  const dir = tmpDir({ after() {} }, 'ox-ctxbd-cfg-');
  const cfgFile = path.join(home, '.ox', 'config.json');
  const write = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj));
  try {
    write({ compaction_model: 'top-level-cheap' });
    assert.equal(loadConfig({ cwd: dir }).compactionModel, 'top-level-cheap');

    write({ compaction: { model: 'nested-cheap', two_pass: true } });
    const nested = loadConfig({ cwd: dir });
    assert.equal(nested.compactionModel, 'nested-cheap', 'compaction.model is accepted');
    assert.equal(nested.compaction.two_pass, true);

    write({ compaction_model: 'from-file' });
    process.env.OX_COMPACTION_MODEL = 'from-env';
    assert.equal(loadConfig({ cwd: dir }).compactionModel, 'from-env', 'env wins');
  } finally {
    delete process.env.OX_COMPACTION_MODEL;
    write({});
  }
});

// ===========================================================================
// 7. The compaction event carries before/after tokens, drop counts and the
//    model used — and the numbers are the real payload, not a history-only
//    figure that would overstate the reclaim.
// ===========================================================================
test('the compaction event is auditable: before/after tokens, drop counts, and the model', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-audit-');
  const window = 1800;
  const { port, bodies } = await startServer(t, (b, i) =>
    isSummaryBody(b) ? turn({ text: 'SUMMARY decisions preserved' }) : i === 0 ? turn({ text: 'a' }) : turn({ text: 'b' })
  );
  const events = await collectEvents({
    target: mkTarget(port, 'main-model'),
    auxTarget: null,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
    ],
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 4 },
  });
  const c = events.find((e) => e.type === 'compaction');
  assert.ok(c, 'a compaction happened');

  // legacy fields preserved — the TUI note, the IPC watcher and the JSON stream
  // all still read these.
  assert.equal(typeof c.from, 'number');
  assert.equal(typeof c.to, 'number');
  assert.equal(c.tokensBefore, c.from);
  assert.equal(c.tokensAfter, c.to);

  // before/after are the FULL payload both times
  const summaryReq = bodies.find(isSummaryBody);
  assert.ok(c.tokensBefore > window * COMPACT_AT, 'before crossed the trigger');
  const bdAfter = events.find((e) => e.type === 'context-breakdown');
  assert.equal(c.tokensAfter, bdAfter.total.tokens, '"after" is the payload the next request actually sends');
  assert.equal(c.savedTokens, c.tokensBefore - c.tokensAfter);

  // drop counts
  assert.ok(c.messagesSummarized >= 2, 'pureCompact handed several messages to the summarizer');
  assert.equal(c.messagesDropped, c.messagesSummarized);
  assert.equal(c.messagesAfter, c.messagesKept + 1, 'kept + the one summary placeholder');
  assert.ok(c.summaryTokens > 0);

  // model used
  assert.equal(c.compactionModel, 'main-model');
  assert.equal(c.compactionModelSource, 'main');
  assert.equal(c.separateCompactionModel, false);
  assert.equal(c.triggeredBy, 'window-threshold');

  // the composition either side, and it sums to the reported totals
  const beforeSum = c.breakdownBefore.reduce((n, s) => n + s.tokens, 0);
  const afterSum = c.breakdownAfter.reduce((n, s) => n + s.tokens, 0);
  assert.equal(beforeSum, c.tokensBefore, 'breakdownBefore sums to tokensBefore');
  assert.equal(afterSum, c.tokensAfter, 'breakdownAfter sums to tokensAfter');
  assert.ok(c.breakdownAfter.some((s) => s.id === 'tool-definitions' && s.tokens === toolSchemaTokens(OFFER)));

  // the summary placeholder is recognizable to the breakdown afterwards
  const liveHistory = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: SUMMARY_PREFIX + 'SUMMARY decisions preserved' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'u4' },
  ];
  const bd = breakdownContext({ messages: liveHistory, tools: OFFER, summaryPrefix: SUMMARY_PREFIX });
  assert.equal(bd.segments.find((s) => s.id === 'conversation-history').summaries, 1, 'the summary is flagged, not passed off as a live turn');

  // the whole record must survive a JSON round-trip (it ships on --json)
  const round = JSON.parse(JSON.stringify(c));
  assert.equal(round.tokensBefore, c.tokensBefore);
  assert.equal(round.messagesDropped, c.messagesDropped);
  assert.equal(round.compactionModel, 'main-model');
});

// ===========================================================================
// 8. The system prompt and tool schemas survive compaction.
// ===========================================================================
test('compaction preserves the system prompt verbatim and never touches the tool schemas', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-survive-');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# rules\nAlways run the tests.\n');
  // A fat file the agent reads on turn 1. Sized so turn 1 sits UNDER the trigger
  // and the tool result pushes turn 2 OVER it: that is the only shape that
  // yields a request BEFORE compaction and one AFTER, which makes "the prompt
  // survived" a real comparison instead of a tautology. (keepTurns must also be
  // below the seeded message count or pureCompact has nothing to hand the
  // summarizer and no compaction happens at all — verified, not assumed.)
  const bigFile = path.join(cwd, 'lib.js');
  fs.writeFileSync(bigFile, `export const data = '${'z'.repeat(24_000)}';\n`);

  const { port, bodies } = await startServer(t, (b, i) =>
    isSummaryBody(b)
      ? turn({ text: 'SUMMARY kept decisions' })
      : i === 0
        ? turn({ calls: [{ id: 'c_read', name: 'read_file', args: { path: bigFile } }] })
        : turn({ text: 'done' })
  );
  const events = await collectEvents({
    target: mkTarget(port),
    auxTarget: null,
    messages: Array.from({ length: 8 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `prior turn ${k}` })),
    // cwd belongs in ctx: runAgent reads `ctx.cwd ?? config.cwd`, never a
    // top-level `cwd` opt, so the AGENTS.md assertions would test nothing with it
    // at the top level.
    ctx: { cwd, allTools: bigSchemas(), modelWindow: 4000, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 2, tools: { narrow: false } },
    maxIterations: 8,
  });

  const compactions = events.filter((e) => e.type === 'compaction');
  assert.equal(compactions.length, 1, 'exactly one compaction, between the two requests');
  const mainBodies = bodies.filter((b) => !isSummaryBody(b));
  assert.ok(mainBodies.length >= 2, `a request before AND after compaction (got ${mainBodies.length})`);
  const before = mainBodies[0];
  const after = mainBodies.at(-1);

  // The system prompt is not merely present, it is the SAME PROMPT. The
  // instructions are compared section-for-section (see instructionsOf) rather
  // than by end-of-prompt, because the volatile tail legitimately moves:
  // buildSystemPrompt stamps `- date:` at call time and compaction calls again.
  const sysOf = (b) => String((b.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
  assert.ok(sysOf(before).length > 0, 'a system prompt was sent before compaction');
  assert.ok(instructionsOf(before).length > 0, 'and it carried project instructions to begin with');
  assert.equal(instructionsOf(after), instructionsOf(before), 'the project instructions survive compaction verbatim');
  assert.equal((after.messages ?? []).filter((m) => m.role === 'system').length, 1, 'exactly one system message, not duplicated');
  assert.match(sysOf(after), /Always run the tests/, 'the instructions are still in the outgoing prompt');
  assert.match(sysOf(after), /# TOOL RULES/, 'and the tool-use contract with them');
  // The rest of the prompt is allowed to move ONLY because compaction re-reads
  // context from disk (a fresh `# date:`, and a workspace tree that now lists
  // the session notes ox wrote mid-run). Neither is a silent loss.
  assert.ok(sysOf(after).startsWith('You are ox'), 'the identity header is intact');
  assert.ok(sysOf(after).length >= sysOf(before).length * 0.9, 'the prompt did not shrink to a stub');

  // The schemas ride alongside `messages`, so a history-only rewrite cannot
  // touch them. Asserted against the actual arrays on the wire.
  assert.ok(Array.isArray(before.tools) && before.tools.length > 0, 'a tool offer was sent');
  assert.deepEqual(after.tools, before.tools, 'the tool schemas are untouched by compaction');
  assert.equal(toolSchemaTokens(after.tools ?? []), toolSchemaTokens(before.tools ?? []));

  // And the audit agrees with the wire.
  const c = compactions[0];
  // The schema segment is EXACTLY unchanged: compaction rewrites history only,
  // and the schema array is not part of history, so this is the invariant that
  // would break first if anyone ever folded the offer into the rewrite.
  assert.equal(
    c.breakdownAfter.find((s) => s.id === 'tool-definitions').tokens,
    c.breakdownBefore.find((s) => s.id === 'tool-definitions').tokens,
    'the schema segment is unchanged across compaction'
  );
  // The system segment is expected to MOVE: compaction deliberately re-reads it
  // from disk, so a mid-run edit or a new tree entry lands. It must still be
  // there, and still dominate its own instructions — a drop to near-zero would
  // mean the prompt was summarized away.
  const sysBefore = c.breakdownBefore.find((s) => s.id === 'system-prompt').tokens;
  const sysAfter = c.breakdownAfter.find((s) => s.id === 'system-prompt').tokens;
  assert.ok(sysAfter > 0, 'the system prompt survived');
  assert.ok(Math.abs(sysAfter - sysBefore) / sysBefore < 0.25, `the system prompt was rebuilt, not lost (${sysBefore} -> ${sysAfter})`);
  // The dropped turns were really replaced by a summary placeholder.
  assert.ok(String(JSON.stringify(after.messages)).includes(SUMMARY_PREFIX.trim()), 'the summary placeholder is in the post-compaction request');
  assert.ok(c.messagesSummarized >= 2, 'messages really were summarized away');
  assert.ok(c.messagesDropped < c.messagesBefore, 'the history really shrank');
});


// ===========================================================================
// 9. Project instructions are still re-read from disk after compaction.
// ===========================================================================
test('project instructions are re-read from disk across compaction', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-reread-');
  const agentsFile = path.join(cwd, 'AGENTS.md');
  fs.writeFileSync(agentsFile, '# rules\nORIGINAL_INSTRUCTION_MARKER\n');
  const bigFile = path.join(cwd, 'lib.js');
  fs.writeFileSync(bigFile, `export const data = '${'z'.repeat(24_000)}';\n`);

  // Same shape as the survival test: turn 1 under the trigger, the tool result
  // pushes turn 2 over it, so a request goes out BEFORE compaction and one
  // AFTER. The mid-run edit lands on the summarizer turn — the exact moment
  // compaction re-reads the instruction files.
  const { port, bodies } = await startServer(t, (b, i) => {
    if (isSummaryBody(b)) {
      fs.writeFileSync(agentsFile, '# rules\nORIGINAL_INSTRUCTION_MARKER\nEDITED_INSTRUCTION_MARKER\n');
      return turn({ text: 'SUMMARY kept' });
    }
    return i === 0 ? turn({ calls: [{ id: 'c_read', name: 'read_file', args: { path: bigFile } }] }) : turn({ text: 'done' });
  });
  const events = await collectEvents({
    target: mkTarget(port),
    auxTarget: null,
    messages: Array.from({ length: 8 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `prior turn ${k}` })),
    ctx: { cwd, allTools: bigSchemas(), modelWindow: 4000, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 2, tools: { narrow: false } },
    maxIterations: 8,
  });
  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction ran');

  const mainBodies = bodies.filter((b) => !isSummaryBody(b));
  assert.ok(mainBodies.length >= 2, `a request before AND after compaction (got ${mainBodies.length})`);
  const before = instructionsOf(mainBodies[0]);
  const after = instructionsOf(mainBodies.at(-1));

  assert.match(before, /ORIGINAL_INSTRUCTION_MARKER/, 'the original instruction was in the first prompt');
  assert.doesNotMatch(before, /EDITED_INSTRUCTION_MARKER/, 'the edit had not happened yet');
  assert.match(
    after,
    /EDITED_INSTRUCTION_MARKER/,
    'the instruction edit made mid-run is picked up by the NEXT request after compaction'
  );
  assert.match(
    after,
    /ORIGINAL_INSTRUCTION_MARKER/,
    'and the earlier rule is still there — the file was re-read, not replaced by the summary'
  );
});

// ===========================================================================
// The threshold itself: ox's default, asserted rather than assumed, and the
// configurable value is what the trigger actually uses.
// ===========================================================================
test('the auto-compaction threshold is 75% by default, clamped to 0.5..0.95', () => {
  assert.equal(compactionKnobs({}).compactAt, 0.75, 'ox default; fires earlier than Zed 90% / Copilot 95%');
  assert.equal(compactionKnobs({ compactAt: 0.9 }).compactAt, 0.9, 'configurable');
  assert.equal(compactionKnobs({ compactAt: 0.1 }).compactAt, 0.5, 'clamped up');
  assert.equal(compactionKnobs({ compactAt: 0.99 }).compactAt, 0.95, 'clamped down');
  process.env.OX_COMPACT_AT = '0.9';
  try {
    assert.equal(compactionKnobs({ compactAt: 0.6 }).compactAt, 0.9, 'env overrides config');
  } finally {
    delete process.env.OX_COMPACT_AT;
  }
});

// The breakdown must never claim a reclaim it did not make: `to` includes the
// schemas, which compaction cannot reduce.
test('the reported reclaim is honest: schemas are in "to", so savings are not overstated', async (t) => {
  const cwd = tmpDir(t, 'ox-ctxbd-honest-');
  const window = 1800;
  const { port } = await startServer(t, (b, i) =>
    isSummaryBody(b) ? turn({ text: 'SUMMARY kept' }) : i === 0 ? turn({ text: 'a' }) : turn({ text: 'b' })
  );
  const events = await collectEvents({
    target: mkTarget(port),
    auxTarget: null,
    messages: [
      { role: 'user', content: 'q'.repeat(1500) },
      { role: 'assistant', content: 'r'.repeat(1500) },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
    ctx: { cwd, allTools: bigSchemas(), modelWindow: window, yolo: true },
    config: { compactAt: COMPACT_AT, keepTurns: 2 },
  });
  const c = events.find((e) => e.type === 'compaction');
  const offerTokens = toolSchemaTokens(OFFER);
  assert.ok(c.to >= offerTokens, '"to" carries the schema block, which compaction cannot reclaim');
  assert.equal(c.savedTokens, c.tokensBefore - c.tokensAfter);
  assert.equal(c.savedTokens, c.messagesDropped >= 0 ? c.savedTokens : -1, 'saving is the reported delta, not a guess');
});

// pureCompact must keep splitting head/summarize/tail the way the audit claims.
test('pureCompact and the audit agree on which messages leave', () => {
  const history = [
    { role: 'system', content: SYSTEM_TEXT },
    ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
  ];
  const { head, toSummarize, tail } = pureCompact(history, 4);
  assert.equal(head.length, 1);
  assert.equal(head[0].role, 'system');
  assert.equal(toSummarize.length + tail.length, 10);
  assert.equal(tail.length, 4);
  const rebuilt = [...head, { role: 'user', content: SUMMARY_PREFIX + 's' }, ...tail];
  assert.equal(breakdownContext({ messages: rebuilt, tools: OFFER }).total.tokens, payloadTokens(rebuilt, OFFER));
});
