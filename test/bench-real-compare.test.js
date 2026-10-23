import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregate } from '../bench/real/compare.mjs';

test('real benchmark comparison aggregates pass, tokens, latency and unknown cost honestly', () => {
  const rows = aggregate([{
    file: 'fixture.json',
    value: {
      suite: 'bench/real', provider: 'ollama', modelId: 'qwen2.5:1.5b',
      results: [{ runs: [
        { availability: 'ran', pass: true, tokensIn: 10, tokensOut: 2, agentMs: 100, ms: 120, costUsd: null },
        { availability: 'unavailable', pass: false, tokensIn: 0, tokensOut: 0, agentMs: 4, ms: 5, costUsd: null },
      ] }],
    },
  }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    provider: 'ollama', model: 'qwen2.5:1.5b', artifacts: 1, runs: 2,
    measured: 1, unavailable: 1, passed: 1, passRate: 1,
    tokensIn: 10, tokensOut: 2, costUsd: null, costKnown: false,
    agentMsMean: 100, agentMsP95: 100, wallMsMean: 120, wallMsP95: 120,
    files: ['fixture.json'],
  });
});

test('comparison recognizes legacy zero-token readiness failures as unavailable', () => {
  const [row] = aggregate([{
    file: 'legacy.json',
    value: { suite: 'bench/real', provider: 'subscription', modelId: 'claude-plan', results: [{ runs: [{ pass: false, tokensIn: 0, tokensOut: 0, toolCalls: 0 }] }] },
  }]);
  assert.equal(row.measured, 0);
  assert.equal(row.unavailable, 1);
  assert.equal(row.passRate, null);
});

test('comparison reclassifies retained pre-availability auth failures', () => {
  const [row] = aggregate([{
    file: 'old-auth.json',
    value: { suite: 'bench/real', provider: 'openrouter', modelId: 'free-model', results: [{ runs: [{ availability: 'ran', pass: false, tokensIn: 0, tokensOut: 0, toolCalls: 0, agentMs: 500, ms: 520, diagnostics: ['provider auth failure: HTTP 401 Unauthorized: User not found'] }] }] },
  }]);
  assert.equal(row.measured, 0);
  assert.equal(row.unavailable, 1);
  assert.equal(row.agentMsMean, null);
  assert.equal(row.wallMsP95, null);
});

test('empty comparison fails closed instead of exiting green', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-compare-empty-'));
  const result = spawnSync(process.execPath, ['bench/real/compare.mjs', dir], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /No bench\/real artifacts found/);
});
