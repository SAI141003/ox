// The parallel-reads clause.
//
// groupCalls + executeReadOnlyTool + Promise.all in src/agent.js already run a
// batch of read-only calls concurrently. A measured 17-call run emitted exactly
// one call per assistant turn, so the capability was offered and unused. The fix
// is one sentence of prompt, and its cost is the number this file pins: a clause
// that grows becomes a clause that gets ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, PARALLEL_READS_CLAUSE } from '../src/system-prompt.js';

test('TOOL RULES carries the parallel-batching clause, and it is exactly one sentence', async () => {
  const prompt = await buildSystemPrompt({ cwd: process.cwd(), contextParts: {} });

  const rules = prompt.slice(prompt.indexOf('# TOOL RULES'), prompt.indexOf('# MEMORY'));
  const hits = rules.split('\n').filter((l) => l.includes('read_file, grep, glob, list_dir'));
  assert.equal(hits.length, 1, `exactly one clause line, found ${hits.length}`);
  assert.equal(hits[0].trim(), PARALLEL_READS_CLAUSE);

  assert.equal(
    (PARALLEL_READS_CLAUSE.match(/\./g) ?? []).length,
    1,
    'one sentence means exactly one sentence-ending period'
  );
  assert.equal(
    (PARALLEL_READS_CLAUSE.match(/[.!?]\s+[a-z]/g) ?? []).length,
    0,
    'no second sentence hiding behind the first'
  );

  // It has to name the read-only tools, or the model cannot act on it, and it
  // has to say the calls actually run in parallel, or there is no reason to try.
  for (const tool of ['read_file', 'grep', 'glob', 'list_dir']) {
    assert.ok(PARALLEL_READS_CLAUSE.includes(tool), `clause names ${tool}`);
  }
  assert.match(PARALLEL_READS_CLAUSE, /parallel/i);
  assert.match(PARALLEL_READS_CLAUSE, /one turn/i);

  // The whole point is zero risk: nothing that constrains a mutating tool moves.
  // (The path line no longer constrains one — a relative path is resolved
  // against the cwd, and every guard still runs on the resolved absolute path.)
  assert.match(rules, /- File tool paths may be relative to cwd; ~ is not expanded\./);
  assert.match(rules, /Prefer targeted edit_file over whole-file write_file rewrites\./);
});

test('the clause costs a fixed, small number of tokens on every single turn', () => {
  assert.equal(PARALLEL_READS_CLAUSE.length, 120, '120 chars including the leading "- "');
  // A typical English-to-token ratio is ~4 chars/token; at 3 it is 40 tokens.
  // Pinned so "make it a paragraph" fails loudly instead of silently tripling
  // every request's cost.
  assert.ok(PARALLEL_READS_CLAUSE.length / 3 <= 42, 'clause stays under ~42 tokens even at 3 chars/token');
});
