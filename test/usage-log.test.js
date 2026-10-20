// Where the tokens went: one record per run, split by model and agent, summed
// by model / agent / surface / project / day; incognito and nested runs write nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordRun, summarize, withUsageLog, codeChanges } from '../src/usage-log.js';

test('runs are summed by model, agent, surface and project', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-usage-')), 'usage.jsonl');
  const now = Date.now();
  recordRun({ file, at: now, surface: 'terminal', cwd: '/w/livora', rows: [{ id: 'main', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 200, costUsd: 0.004 }, { id: 'sub:a', model: 'claude-haiku-5-5', inputTokens: 300, outputTokens: 50, costUsd: 0.0001 }] });
  recordRun({ file, at: now, surface: 'app', agent: 'reviewer', cwd: '/w/ox', rows: [{ id: 'main', model: 'qwen2.5:1.5b', inputTokens: 500, outputTokens: 100, costUsd: null }] });
  recordRun({ file, at: now - 40 * 86_400_000, rows: [{ id: 'main', model: 'old', inputTokens: 9, outputTokens: 9 }] });
  const s = summarize({ file, now, days: 30 });
  assert.equal(s.total.in, 1800);
  assert.equal(s.total.runs, 2);
  assert.deepEqual(s.byModel.map((g) => g.key), ['claude-sonnet-5-5', 'qwen2.5:1.5b', 'claude-haiku-5-5']);
  assert.equal(s.byModel.find((g) => g.key === 'qwen2.5:1.5b').cost, null, 'a local model is unpriced, not $0');
  assert.deepEqual(s.byAgent.map((g) => g.key).sort(), ['agent reviewer', 'ox', 'subagent']);
  assert.deepEqual(s.bySurface.map((g) => g.key).sort(), ['app', 'terminal']);
  assert.deepEqual(s.byProject.map((g) => g.key).sort(), ['livora', 'ox']);
});

test('the wrapper writes one record per top-level run, none for incognito or nested runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-usage-home-'));
  const saved = { OX_HOME: process.env.OX_HOME, OX_USAGE_LOG: process.env.OX_USAGE_LOG };
  process.env.OX_HOME = home; delete process.env.OX_USAGE_LOG;
  try {
    async function* run() { yield { type: 'usage-total', model: 'm', inputTokens: 10, outputTokens: 5, costUsd: null }; }
    for await (const _ of withUsageLog({ ctx: { surface: 'island' } }, run())) {}
    for await (const _ of withUsageLog({ ctx: { incognito: true } }, run())) {}
    for await (const _ of withUsageLog({ ctx: { depth: 1 } }, run())) {}
    const lines = fs.readFileSync(path.join(home, 'usage.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).surface, 'island');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('codeChanges: the share an AI wrote, from authors and Co-authored-by lines', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-aishare-'));
  fs.mkdirSync(path.join(home, 'shop', '.git'), { recursive: true });
  const file = path.join(home, 'usage.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ at: Date.now(), dir: path.join(home, 'shop'), model: 'x' })}\n`);
  const log = [
    '@a1\tSai <s@x.dev>\tClaude Opus 5.5 <noreply@anthropic.com>', '90\t5\tsrc/a.js',
    '@a2\tSai <s@x.dev>\t', '10\t0\tsrc/b.js',
    '@a3\tdevin-ai-integration[bot] <d@x>\t', '0\t3\tREADME.md',
  ].join('\n');
  const r = codeChanges({ days: 7, file, home, git: () => log });
  assert.equal(r.commits, 3);
  assert.equal(r.aiCommits, 2);
  assert.equal(r.added, 100);
  assert.equal(r.aiAdded, 90);
  assert.equal(r.aiShare, 90);
  fs.rmSync(home, { recursive: true, force: true });
});
