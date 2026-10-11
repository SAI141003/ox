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

import { renderUsageLines, runOnce } from '../bench/real/runner.mjs';
import { EVENTS_FILE } from '../bench/real/lib.mjs';

const CANNED_NDJSON = [
  { t: 'session-start' },
  { t: 'assistant-turn', index: 1 },
  { t: 'tool-start', id: 'c1', name: 'list_dir', argsPreview: '{"path":"/sandbox/ws"}' },
  { t: 'tool-end', id: 'c1', name: 'list_dir', isError: false },
  { t: 'usage', inputTokens: 1200, outputTokens: 40 },
  { t: 'assistant-turn', index: 2 },
  { t: 'usage', inputTokens: 2100, outputTokens: 55 },
  { t: 'usage', aux: true, inputTokens: 300, outputTokens: 20 },
  { t: 'final', message: { content: 'done' } },
].map((e) => `${JSON.stringify(e)}\n`).join('');

function cannedChild() {
  return { exitCode: 0, stdout: CANNED_NDJSON, stderr: '', ms: 3, timedOut: false };
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
  assert.equal(lines.length, 9, 'every event survived the round trip');
  assert.equal(parsed.length, lines.length, 'every line is one complete JSON value');
  assert.equal(parsed[0].t, 'session-start', 'stream order is preserved');
  assert.equal(parsed.at(-1).t, 'final');
  assert.ok(parsed.some((e) => e.t === 'tool-start'), 'tool events are in the file');
  assert.equal(run.eventsKept, parsed.length, 'the runner counted what it wrote');

  assert.equal(run.pass, true, 'the fixture verifier still graded the run');
  assert.equal(run.toolCalls, 1, 'the mocked tool call was summarised');
  assert.equal(run.tokensIn, 3300, 'token totals still come from the stream');
  assert.equal(run.auxTokensIn, 300, 'aux usage is separated from main usage');

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
