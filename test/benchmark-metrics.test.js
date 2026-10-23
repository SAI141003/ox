import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrajectoryMetrics } from '../src/benchmark.js';

test('benchmark metrics prefer authoritative usage-total and expose latency/tool counts', () => {
  const m = summarizeTrajectoryMetrics([
    { type: 'text-delta', text: 'first' },
    { type: 'tool-start', name: 'read_file' },
    // A per-request usage event must not be double-counted when the run total
    // is present.
    { type: 'usage', inputTokens: 900, outputTokens: 90 },
    { type: 'turn-end' },
    { type: 'usage-total', inputTokens: 120, outputTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 2 },
  ], { estimatedInputTokens: 77, startedAt: Date.now() - 1000, firstOutputAt: Date.now() - 500, model: 'gpt-6-luna' });

  assert.equal(m.usageMeasured, true);
  assert.equal(m.inputTokens, 120);
  assert.equal(m.outputTokens, 12);
  assert.equal(m.totalTokens, 132);
  assert.equal(m.cacheReadTokens, 4);
  assert.equal(m.cacheWriteTokens, 2);
  assert.equal(m.estimatedInputTokens, 77);
  assert.equal(m.turns, 1);
  assert.equal(m.toolCalls, 1);
  assert.ok(m.latencyMs >= 900);
  assert.ok(m.timeToFirstOutputMs >= 400);
  assert.equal(typeof m.costUsd, 'number');
});

test('benchmark metrics fail closed when a provider reports no usage or price', () => {
  const m = summarizeTrajectoryMetrics([{ type: 'final', message: { content: 'done' } }], { estimatedInputTokens: 31, model: 'unpriced-model' });
  assert.equal(m.usageMeasured, false);
  assert.equal(m.inputTokens, null);
  assert.equal(m.outputTokens, null);
  assert.equal(m.totalTokens, null);
  assert.equal(m.costUsd, null);
  assert.equal(m.estimatedInputTokens, 31);
});
