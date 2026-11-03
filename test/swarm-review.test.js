// Swarm review: agents walk a page's layers and the rules find what a person
// would trip on. Runs a real (headless) Chrome when one is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSwarmReview, swarmReport } from '../src/swarm-review.js';
import { chromePath } from '../src/dev-flow.js';

const chrome = Boolean(chromePath());

test('the agents find the faint text, the missing alt, the nameless tiny button, the unlabelled field and the overflow; a good button passes', { skip: !chrome && 'no Chrome here', timeout: 120_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-swarm-'));
  try {
    const url = new URL('./fixtures/swarm-page.html', import.meta.url).href;
    const r = await runSwarmReview(url, { agents: 5, headless: true, pace: 20, out });
    const kinds = new Set(r.findings.map((f) => f.kind));
    for (const k of ['contrast', 'img-alt', 'no-name', 'tap-target', 'no-label', 'overflow']) assert.ok(kinds.has(k), `${k} not found: ${JSON.stringify(r.findings)}`);
    assert.ok(!r.findings.some((f) => /Apply filters/.test(f.where)), 'a good button is not flagged');
    assert.ok(r.total > 5 && r.findings.every((f) => f.agent >= 1 && f.agent <= 5));
    assert.ok(fs.existsSync(r.reportFile) && /Swarm review/.test(fs.readFileSync(r.reportFile, 'utf8')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the report groups problems by kind, most first', () => {
  const md = swarmReport({ url: 'https://x', agents: 3, total: 10, findings: [{ kind: 'contrast', msg: 'm', where: 'p', agent: 1, box: [0, 0, 1, 1] }, { kind: 'contrast', msg: 'm', where: 'q', agent: 2, box: [0, 0, 1, 1] }, { kind: 'img-alt', msg: 'm', where: 'img', agent: 3, box: [0, 0, 1, 1] }] });
  assert.ok(md.indexOf('Text too faint (2)') < md.indexOf('Images with no description (1)'));
  assert.match(md, /3 agents checked 10 layers and found 3 problems/);
});

