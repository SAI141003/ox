// The knowledge graph (graphify's idea for what is not code): doc sections,
// remembered facts and brain notes joined by the names they share; a question
// is answered within a token budget, rarest words first, with sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as K from '../src/knowledge-graph-docs.js';

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-kg-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-kg-home-'));
test.after(() => { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# Shop\n\nA shop on Stripe.\n\n## Releases\n\nTag a version, then the Release workflow publishes it. See [the runbook](docs/runbook.md).\n\n## Styling\n\nTailwind everywhere.\n');
fs.writeFileSync(path.join(proj, 'docs', 'runbook.md'), '# Runbook\n\n## Rolling back a release\n\nRevert the tag; Stripe webhooks keep working.\n');
fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'README.md'), '# not ours\nrelease release release');

test('docs become sections linked by what they share; vendored folders are left out', async () => {
  const g = await K.buildKnowledge({ root: proj, home, brain: false });
  assert.equal(g.stats.docs, 2);
  assert.ok(g.nodes.some((n) => n.kind === 'section' && /Releases/.test(n.name)));
  assert.ok(g.edges.some((e) => e.relation === 'links' && e.to === 'doc:docs/runbook.md' && e.confidence === 'EXTRACTED'));
  assert.ok(g.nodes.some((n) => n.kind === 'entity' && n.name === 'Stripe'), 'a name in two places is an entity');
  assert.ok(!g.nodes.some((n) => /not ours/.test(n.name)));
});

test('a question gets the right sections within its budget, and says where each came from', async () => {
  const g = await K.buildKnowledge({ root: proj, home, brain: false });
  const r = K.queryKnowledge(g, 'how do we release a version', { budget: 120 });
  assert.match(r.text, /Release workflow publishes it/);
  assert.match(r.text, /README\.md › Shop › Releases/);
  assert.ok(r.tokens <= 160);
  assert.ok(!/Tailwind/.test(r.text), 'what the question is not about stays out');
  assert.equal(K.queryKnowledge(g, 'the the the').text, '');
});

test('remembered facts are part of it, linked by their entities', async () => {
  const M = await import('../src/memory-graph.js');
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  M.remember('My shop invoices go through Stripe every Friday.', { file: path.join(home, 'memory', 'graph.jsonl') });
  const g = await K.knowledgeFor(proj, { home, fresh: true });
  assert.ok(g.stats.facts >= 1);
  const r = K.queryKnowledge(g, 'when do invoices go out', { budget: 200 });
  assert.match(r.text, /every Friday/);
  assert.match(r.text, /memory/);
  const again = await K.knowledgeFor(proj, { home });
  assert.equal(again.stats.facts, g.stats.facts, 'served from the cache while nothing changed');
});
