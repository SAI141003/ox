// --keep must keep the EVIDENCE, not just the filesystem.
//
// The gap this suite closes: bench/real consumed the child's NDJSON stdout to
// compute the summary and then dropped it on the floor. With --keep the sandbox
// survived but the event stream did not, so the most expensive task in the suite
// had zero token provenance and every number had to be reconstructed by hand.
//
// A canned NDJSON child stands in for a real model: the subject here is the
// runner's persistence and reporting, not the model. Keeping it mocked is what
// makes the test fast enough to run in the normal suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { benchmarkExecutionEnv, benchmarkExecutionSpec, costFor, costStats, renderUsageLines, resolveBenchmarkTarget, runOnce, unavailableReason } from '../bench/real/runner.mjs';
import { EVENTS_FILE, TIMINGS_FILE, summarizeEvents, writeTimingsFile } from '../bench/real/lib.mjs';

const CANNED_NDJSON = [
  { t: 'session-start' },
  { t: 'assistant-turn', index: 1 },
  { t: 'tool-start', id: 'c1', name: 'list_dir', argsPreview: '{"path":"/sandbox/ws"}' },
  { t: 'tool-end', id: 'c1', name: 'list_dir', isError: false },
  { t: 'usage', inputTokens: 1200, outputTokens: 40 },
  { t: 'assistant-turn', index: 2 },
  { t: 'usage', inputTokens: 2100, outputTokens: 55 },
  { t: 'usage', aux: true, inputTokens: 300, outputTokens: 20 },
  { t: 'text-delta', text: 'done' },
  { t: 'final', message: { content: 'done' } },
].map((e) => `${JSON.stringify(e)}\n`).join('');

function cannedChild() {
  return {
    exitCode: 0, stdout: CANNED_NDJSON, stderr: '', ms: 90, timedOut: false,
    eventTimings: [
      { t: 'tool-start', id: 'c1', name: 'list_dir', atMs: 12 },
      { t: 'tool-end', id: 'c1', name: 'list_dir', atMs: 42 },
      { t: 'text-delta', atMs: 60 },
    ],
  };
}

const task = {
  id: 'keep-events-fixture',
  category: 'fixture',
  name: 'keep-events fixture',
  prompt: 'noop',
  timeoutMs: 5_000,
  async setup(ws) {
    fs.writeFileSync(path.join(ws, 'seed.txt'), 'seed\n');
  },
  async verify() {
    return { pass: true, detail: 'fixture', checks: [] };
  },
};

function readEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return { lines, parsed: lines.map((l) => JSON.parse(l)) };
}

test('--keep persists the raw NDJSON event stream into the sandbox as events.ndjson', async () => {
  const run = await runOnce(task, 'ox-fixture:model', { keep: true, timeoutMs: 5_000 }, { spawn: cannedChild });

  assert.ok(run.sandbox, '--keep reports a sandbox path');
  assert.ok(fs.existsSync(run.sandbox), 'the kept sandbox is on disk');

  const expected = path.join(run.sandbox, EVENTS_FILE);
  assert.equal(run.eventsFile, expected, 'the runner reports where the stream landed');
  assert.ok(fs.existsSync(expected), 'events.ndjson exists in the kept sandbox');

  const { lines, parsed } = readEvents(expected);
  assert.equal(lines.length, 10, 'every event survived the round trip');
  assert.equal(parsed.length, lines.length, 'every line is one complete JSON value');
  assert.equal(parsed[0].t, 'session-start', 'stream order is preserved');
  assert.equal(parsed.at(-1).t, 'final');
  assert.ok(parsed.some((e) => e.t === 'tool-start'), 'tool events are in the file');
  assert.equal(run.eventsKept, parsed.length, 'the runner counted what it wrote');
  assert.ok(fs.existsSync(run.timingsFile), 'arrival timing evidence is kept separately');
  const timingEvidence = JSON.parse(fs.readFileSync(run.timingsFile, 'utf8'));
  assert.equal(path.basename(run.timingsFile), TIMINGS_FILE);
  assert.equal(timingEvidence.clock, 'child-stdout-arrival-ms-from-spawn');
  assert.equal(timingEvidence.events.find((e) => e.t === 'text-delta').atMs, 60);
  assert.ok(!JSON.stringify(timingEvidence).includes('done'), 'timing evidence omits model output');

  assert.equal(run.pass, true, 'the fixture verifier still graded the run');
  assert.equal(run.toolCalls, 1, 'the mocked tool call was summarised');
  assert.equal(run.tokensIn, 3300, 'token totals still come from the stream');
  assert.equal(run.auxTokensIn, 300, 'aux usage is separated from main usage');
  assert.equal(run.agentMs, 90, 'agent wall time is reported independently from harness time');
  assert.equal(run.firstTextMs, 60, 'first generated text latency comes from child event arrival timing');
  assert.equal(run.firstToolMs, 12, 'first tool start latency comes from child event arrival timing');
  assert.equal(run.toolDurationMs, 30, 'tool duration is paired by call id');
  assert.equal(run.timedTools, 1);

  fs.rmSync(run.sandbox, { recursive: true, force: true });
});

test('per-turn usage is reported per request, not only as a total', async () => {
  const run = await runOnce(task, 'ox-fixture:model', { keep: false, timeoutMs: 5_000 }, { spawn: cannedChild });

  assert.deepEqual(
    run.usageTurns.map((u) => [u.turn, u.inputTokens, u.outputTokens, u.aux]),
    [
      [1, 1200, 40, false],
      [2, 2100, 55, false],
      [3, 300, 20, true],
    ],
    'one row per provider request, aux flagged separately'
  );
  // --keep is NOT set, so there is no sandbox left to write into.
  assert.equal(run.eventsFile, null);
});

test('a benchmark prices a resolved provider model, never the ox bot alias', async () => {
  const run = await runOnce(task, 'ox-gpt', { keep: false, timeoutMs: 5_000 }, { spawn: cannedChild, modelId: 'gpt-5.6-sol' });
  assert.equal(run.resolvedModel, 'gpt-5.6-sol');
  assert.ok(run.costUsd > 0, 'a priced resolved model must not become an unpriced alias');
  assert.equal(run.costUsd, costFor('gpt-5.6-sol', { inputTokens: run.tokensIn, outputTokens: run.tokensOut }));
});

test('a saved standard-provider bot resolves and executes without copying user config into the sandbox', () => {
  const config = {
    bots: {
      'my-nvidia': { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', desc: 'private test bot' },
    },
  };
  const target = resolveBenchmarkTarget('my-nvidia', config);
  assert.equal(target.provider, 'nvidia');
  assert.equal(target.model, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(benchmarkExecutionSpec('my-nvidia', target, config), 'nvidia:nvidia/nemotron-3-ultra-550b-a55b');
  assert.deepEqual(benchmarkExecutionEnv('my-nvidia', target, config), {});
});

test('a saved custom-endpoint bot carries only its resolved endpoint into the sandbox', () => {
  const config = {
    bots: {
      'my-local': { provider: 'custom', model: 'acme-code', baseUrl: 'http://127.0.0.1:9010/v1', keyEnv: 'OX_EP_ACME_KEY' },
    },
  };
  const target = resolveBenchmarkTarget('my-local', config);
  assert.equal(benchmarkExecutionSpec('my-local', target, config), 'custom:acme-code');
  assert.deepEqual(benchmarkExecutionEnv('my-local', target, config), { OX_BASE_URL: 'http://127.0.0.1:9010/v1' });
});

test('unpriced benchmark runs keep cost unknown instead of recording a false zero', () => {
  assert.deepEqual(costStats([null, null]), { mean: null, stddev: null, n: 0, unknown: true });
  assert.deepEqual(costStats([0.01, null]), { mean: null, stddev: null, n: 0, unknown: true });
  assert.deepEqual(costStats([0.01, 0.03]), { mean: 0.02, stddev: Math.sqrt(0.0002), n: 2, unknown: false });
});

test('an authentication failure before a model turn is unavailable, not a task failure', () => {
  const summary = { toolCalls: 0, inputTokens: 0, outputTokens: 0, errors: ['Not logged in. Please run /login'], finalText: '' };
  assert.match(unavailableReason({ timedOut: false, stderr: '' }, summary), /not logged in/i);
  assert.equal(unavailableReason({ timedOut: true, stderr: 'Not logged in' }, summary), null, 'timeouts remain measurable failures');
  assert.equal(unavailableReason({ timedOut: false, stderr: 'Not logged in' }, { ...summary, toolCalls: 1 }), null, 'a tool turn is a real attempt');
  assert.equal(unavailableReason({ timedOut: false, stderr: 'Not logged in' }, { ...summary, inputTokens: 1 }), null, 'a model token is a real attempt');
});

test('without --keep the sandbox is destroyed and nothing is left behind', async () => {
  let spawns = 0;
  const run = await runOnce(task, 'ox-fixture:model', { keep: false, timeoutMs: 5_000 }, {
    spawn: () => {
      spawns += 1;
      return cannedChild();
    },
  });

  assert.equal(spawns, 1, 'the child ran exactly once');
  assert.equal(run.sandbox, null, 'no sandbox path is advertised');
  assert.equal(run.eventsFile, null, 'no events file is advertised');
});

test('the printed summary shows per-request input/output when a stream is available', () => {
  const runs = [
    {
      taskId: 'read-and-report',
      usageTurns: [
        { turn: 1, aux: false, inputTokens: 1200, outputTokens: 40 },
        { turn: 2, aux: false, inputTokens: 2100, outputTokens: 55 },
        { turn: 3, aux: true, inputTokens: 300, outputTokens: 20 },
      ],
    },
    { taskId: 'adapter-without-usage', usageTurns: [] },
  ];
  const lines = renderUsageLines(runs, 26);
  const text = lines.join('\n');

  assert.ok(text.includes('USAGE PER REQUEST'), 'the table is headed');
  assert.match(text, /^read-and-report\s+1\s+1200\s+40\s+—\s*$/m, 'per-request in/out is visible');
  assert.match(text, /^read-and-report\s+2\s+2100\s+55\s+—\s*$/m);
  assert.match(text, /^read-and-report\s+3\s+—\s+—\s+300\/20\s*$/m, 'aux traffic is separated, not double-counted');
  assert.match(text, /^TOTAL\s+3600\s+3300\s+95\s+300\/20\s*$/m, 'the total row adds up');

  // A run whose adapter reports only a grand total must not print a row of
  // fabricated zeroes: absence of data prints as absence.
  assert.ok(!text.includes('adapter-without-usage'));
  assert.deepEqual(renderUsageLines([{ taskId: 'x', usageTurns: [] }], 26), []);
});

test('nested subagent token totals are attributed in the per-request table', () => {
  const summary = summarizeEvents([
    { t: 'usage', inputTokens: 3060, outputTokens: 66 },
    { t: 'usage', inputTokens: 3724, outputTokens: 102 },
    { t: 'subagent-end', id: 'sa-1', model: 'local-model', inputTokens: 12895, outputTokens: 343 },
    { t: 'usage-total', inputTokens: 19679, outputTokens: 511, costUsd: 0 },
  ]);
  assert.equal(summary.inputTokens, 19679, 'aggregate total remains authoritative');
  assert.equal(summary.auxInputTokens, 12895, 'nested usage is separately attributable');
  assert.deepEqual(summary.usageEvents.at(-1), {
    turn: 'subagent', aux: true, inputTokens: 12895, outputTokens: 343, agentId: 'sa-1', model: 'local-model',
  });
  const output = renderUsageLines([{ taskId: 'debug', usageTurns: summary.usageEvents }]).join('\n');
  assert.match(output, /subagent\s+—\s+—\s+12895\/343/);
  assert.match(output, /TOTAL\s+19679\s+6784\s+168\s+12895\/343/);
});

test('latency metrics are absent rather than fabricated when event timestamps are unavailable', () => {
  const summary = summarizeEvents([{ t: 'text-delta', text: 'hi' }]);
  assert.equal(summary.firstTextMs, null);
  assert.equal(summary.firstToolMs, null);
  assert.equal(summary.toolDurationMs, null);
  assert.equal(summary.timedTools, 0);
});

test('timing sidecar is a payload-free, sanitized event timeline', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ox-timing-test-'));
  try {
    writeTimingsFile({ root }, [
      { t: 'text-delta', atMs: 27.4, text: 'private answer text' },
      { t: 'tool-start', atMs: 31, id: 44, name: 'read_file', argsPreview: 'private path' },
      { t: 'bad-event', atMs: NaN, payload: 'discarded' },
    ]);
    const evidence = JSON.parse(fs.readFileSync(path.join(root, TIMINGS_FILE), 'utf8'));
    assert.deepEqual(evidence.events, [
      { t: 'text-delta', atMs: 27.4 },
      { t: 'tool-start', atMs: 31, id: '44', name: 'read_file' },
    ]);
    assert.doesNotMatch(JSON.stringify(evidence), /private|payload/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
