import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, renderLedger } from '../src/ledger.js';

test('ledger attributes tokens and cost to the main agent and each subagent', () => {
  const l = createLedger();
  l.feed({ type: 'subagent-start', id: 's1', description: 'audit the auth module' });
  l.feed({ type: 'subagent-start', id: 's2', task: 'map routes' });
  l.feed({ type: 'subagent-end', id: 's1', model: 'qwen2.5-coder:7b', inputTokens: 1000, outputTokens: 200, costUsd: 0 });
  l.feed({ type: 'subagent-end', id: 's2', model: 'grok-4.6', inputTokens: 3000, outputTokens: 500, costUsd: 0.009 });
  l.feed({ type: 'usage-total', model: 'grok-4.6', inputTokens: 5000, outputTokens: 800, costUsd: 0.0148, auxCostUsd: null });

  const rows = Object.fromEntries(l.rows().map((r) => [r.id, r]));
  assert.equal(rows['sub:s1'].label, '↳ audit the auth module', 'labels come from the start event');
  assert.equal(rows['sub:s1'].costUsd, null, 'a local model is unpriced, not $0');
  assert.equal(rows['sub:s2'].costUsd, 0.009);
  assert.equal(rows.main.inputTokens, 5000);
  assert.equal(l.hasSubagents(), true);

  const t = l.totals();
  assert.equal(t.inputTokens, 9000);
  assert.equal(t.outputTokens, 1500);
  assert.ok(Math.abs(t.costUsd - 0.0238) < 1e-9);

  const text = renderLedger(l);
  assert.match(text, /cost by agent/);
  assert.match(text, /audit the auth module/);
  assert.match(text, /free\/unpriced/);
});

test('aux (compaction/title) spend gets its own row and is not double counted in main', () => {
  const l = createLedger();
  l.feed({ type: 'usage-total', model: 'm', inputTokens: 100, outputTokens: 10, costUsd: 0.5, auxModel: 'small', auxInputTokens: 50, auxOutputTokens: 5, auxCostUsd: 0.1 });
  const rows = Object.fromEntries(l.rows().map((r) => [r.id, r]));
  assert.ok(Math.abs(rows.main.costUsd - 0.4) < 1e-9);
  assert.equal(rows.aux.costUsd, 0.1);
  assert.equal(l.hasSubagents(), false);
});
