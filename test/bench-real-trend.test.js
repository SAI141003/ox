// The release-to-release comparison: same model, same tasks, what changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trend, regressions, render, pointOf } from '../bench/real/trend.mjs';
import { oxBuild, costFor } from '../bench/real/runner.mjs';

const art = (date, oxVersion, tasks) => ({ file: `${oxVersion}.json`, value: {
  suite: 'bench/real', provider: 'anthropic', modelId: 'claude-sonnet-5-5', date, oxVersion,
  results: Object.entries(tasks).map(([id, runs]) => ({ id, runs })),
} });
const run = (pass, tokensIn, tokensCached, costUsd) => ({ availability: 'ran', pass, tokensIn, tokensOut: 100, tokensCached, costUsd, turns: 3, agentMs: 1000 });

test('a release that reads more from the cache shows as cheaper, and nothing is flagged', () => {
  const models = trend([
    art('2026-11-09T10:00:00Z', '0.1.34', { a: [run(true, 100_000, 10_000, 0.30)], b: [run(true, 50_000, 0, 0.15)] }),
    art('2026-11-09T20:00:00Z', '0.1.35', { a: [run(true, 100_000, 80_000, 0.10)], b: [run(true, 50_000, 40_000, 0.05)], c: [run(false, 9_000, 0, 0.02)] }),
  ]);
  assert.equal(models.length, 1);
  const [was, now] = models[0].rows;
  assert.equal(was.cachedPercent, 6.7);
  assert.equal(now.oxVersion, '0.1.35');
  assert.equal(now.tasks, 3);
  // Only the two tasks both runs measured are compared: the new failing task is not a regression.
  assert.deepEqual(now.since, { sharedTasks: 2, passed: 0, tokensInPercent: 0, costPercent: -66.7, cachedPoints: 73.3, lost: [], won: [] });
  assert.deepEqual(regressions(models), []);
  assert.ok(render(models).some((l) => l.includes('0.1.35') && l.includes('cost -66.7%')));
});

test('losing a task or costing a quarter more is flagged, by name', () => {
  const lost = trend([
    art('2026-11-01', '0.1.30', { a: [run(true, 10, 0, 0.01)], b: [run(true, 10, 0, 0.01)] }),
    art('2026-11-02', '0.1.31', { a: [run(false, 10, 0, 0.01)], b: [run(true, 10, 0, 0.01)] }),
  ]);
  assert.deepEqual(regressions(lost), [{ model: 'anthropic:claude-sonnet-5-5', what: 'passes 1 fewer of the same 2 tasks', tasks: ['a'] }]);
  const dearer = trend([
    art('2026-11-01', '0.1.30', { a: [run(true, 1000, 0, 0.10)] }),
    art('2026-11-02', '0.1.31', { a: [run(true, 1400, 0, 0.14)] }),
  ]);
  assert.match(regressions(dearer)[0].what, /costs 40% more/);
  // Cost unknown (a local model): input tokens stand in for it.
  const local = trend([
    art('2026-11-01', '0.1.30', { a: [run(true, 1000, 0, null)] }),
    art('2026-11-02', '0.1.31', { a: [run(true, 1500, 0, null)] }),
  ]);
  assert.match(regressions(local)[0].what, /50% more input tokens/);
});

test('a run the provider never started, and an artifact without cache figures, are not counted as zero', () => {
  const p = pointOf({ results: [
    { id: 'a', runs: [{ availability: 'unavailable', pass: false, tokensIn: 0, tokensOut: 0 }, { availability: 'ran', pass: true, tokensIn: 500, tokensOut: 5, costUsd: null }] },
    { id: 'b', runs: [{ availability: 'unavailable', pass: false }] },
  ] });
  assert.deepEqual(Object.keys(p.tasks), ['a']);
  assert.equal(p.tasks.a.pass, 1);
  assert.equal(p.tasks.a.tokensCached, null);
  const models = trend([{ file: 'old.json', value: { suite: 'bench/real', provider: 'x', modelId: 'm', date: '2026-10-01', results: [{ id: 'a', runs: [{ availability: 'ran', pass: true, tokensIn: 500, tokensOut: 5 }] }] } }]);
  assert.equal(models[0].rows[0].cachedPercent, null);
  assert.deepEqual(trend([{ file: 'x', value: { suite: 'something else', results: [] } }]), []);
});

test('results say which ox made them, and cost counts cached tokens at their price', () => {
  const b = oxBuild();
  assert.match(b.oxVersion, /^\d+\.\d+\.\d+/);
  const full = costFor('claude-sonnet-5-5', { inputTokens: 100_000, outputTokens: 0 });
  const cached = costFor('claude-sonnet-5-5', { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 90_000 });
  assert.ok(cached < full, `a mostly cached prompt costs less: ${cached} < ${full}`);
});
