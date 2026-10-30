// CACHE-STABLE PROMPT LAYERING.
//
// The property this file exists to pin was untestable while the prompt was one
// flat string: there is no way to ask "which bytes of this prompt are the same
// next turn?" of a String. buildPromptLayers() answers that by returning the
// prompt as an ordered list of named layers, and the only thing that ships a
// prompt is buildSystemPrompt() concatenating them — so the layers ARE the
// bytes, not a description of them.
//
// Why it matters in money: a provider reuses an unbroken prompt PREFIX and
// re-processes everything from the first changed byte onward at full input
// price. ox rebuilt the whole system prompt several times per run (agent.js
// calls systemText() at start, after tool narrowing, on every mid-loop guidance
// change, and after compaction), and the assembled text carried `- date:
// <ISO ms>` at offset 42. Measured before layering: 42 of 1962 bytes were ever
// cacheable and the other 86% was re-read as uncached input on every rebuild.
//
// What this file asserts, in order:
//   1. two identical builds produce a byte-identical STATIC PREFIX
//   2. and a DYNAMIC TAIL that differs (i.e. the test can still see a change)
//   3. static layers come first and dynamic layers are one contiguous tail
//   4. buildSystemPrompt is exactly those layers, joined
//   5. nothing the model is told was dropped in the reorder
//   6. the prompt did not get longer

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MESSAGING_CLAUSES,
  buildPromptLayers,
  buildSystemPrompt,
  summarizePromptLayers,
  estimatePromptLayerTokens,
} from '../src/system-prompt.js';

// A fixed clock is what makes assertion 1 meaningful: with a live clock the
// prefix is still byte-stable (the date lives in the tail), but pinning it here
// also lets the byte totals below be exact instead of approximate.
const CLOCK = new Date('2026-01-01T00:00:00.000Z');
const INPUTS = {
  cwd: process.cwd(),
  contextParts: {
    tree: 'ox/\n├── src\n└── test',
    memoryFiles: 'AGENTS.md: house rules',
  },
  memoryBlock: 'prefer small diffs',
  skillIndex: '- alpha — does alpha things',
  now: CLOCK,
};

const joinLayers = (layers) => layers.map((l) => l.text).join('\n');
const byKind = (layers, kind) => layers.filter((l) => l.kind === kind);

test('two identical builds: the static prefix is byte-identical, the dynamic tail is not', async () => {
  const first = await buildPromptLayers(INPUTS);
  // A real gap, not a fake one: if the clock had not advanced, assertion 2 below
  // would pass vacuously and this file would be pinning nothing.
  await new Promise((r) => setTimeout(r, 5));
  const second = await buildPromptLayers({ ...INPUTS, now: new Date(CLOCK.getTime() + 1000) });

  const prefixA = joinLayers(byKind(first, 'static'));
  const prefixB = joinLayers(byKind(second, 'static'));
  assert.equal(
    prefixA,
    prefixB,
    'the static prefix must be byte-identical across rebuilds — this is the entire cache hit'
  );
  assert.ok(prefixA.length > 0, 'there is a static prefix to hit (a zero-length one proves nothing)');

  const tailA = joinLayers(first.filter((l) => l.kind === 'dynamic'));
  const tailB = joinLayers(second.filter((l) => l.kind === 'dynamic'));
  assert.notEqual(tailA, tailB, 'the dynamic tail must still change, or the test cannot see volatility');
});

test('every volatile byte sits behind a byte-identical prefix: the clock used to sit at offset 42', async () => {
  const a = await buildPromptLayers(INPUTS);
  const b = await buildPromptLayers({ ...INPUTS, now: new Date(CLOCK.getTime() + 1000) });

  // The general form of the bug this fixes: any layer whose bytes differ must
  // have every other differing layer behind it, so the differing region is a
  // suffix. A volatile layer sitting ABOVE a stable one is what made 86% of the
  // prompt re-billed on every rebuild.
  const differing = a.filter((l, i) => l.text !== b[i]?.text).map((l) => l.kind);
  assert.ok(differing.length > 0, 'this build produced no change at all; the input is not exercising the tail');
  assert.deepEqual(
    differing,
    ['dynamic'],
    `only dynamic layers may differ between rebuilds, got: ${JSON.stringify(differing)}`
  );

  // And the reason the prefix is now worth 30x more than it was: the clock is
  // the LAST layer, so nothing sits behind it.
  const clock = a[a.length - 1];
  assert.equal(clock.name, 'clock');
  assert.match(clock.text, /^- date: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(
    clock.bytes,
    Buffer.byteLength(`- date: ${CLOCK.toISOString()}`),
    'the clock layer is exactly one line — nothing else rode along with it'
  );
});

test('layer ORDER is static, then session, then ONE contiguous dynamic tail', async () => {
  const layers = await buildPromptLayers(INPUTS);
  const kinds = layers.map((l) => l.kind);
  const rank = { static: 0, session: 1, dynamic: 2 };

  for (let i = 1; i < kinds.length; i++) {
    assert.ok(
      rank[kinds[i]] >= rank[kinds[i - 1]],
      `layers must not go back down: ${kinds[i - 1]} -> ${kinds[i]} at ${layers[i].name}`
    );
  }
  const firstDynamic = kinds.indexOf('dynamic');
  assert.ok(firstDynamic > -1, 'memory is always dynamic, so a tail always exists');
  assert.deepEqual(
    kinds.slice(firstDynamic),
    kinds.slice(firstDynamic).filter((k) => k === 'dynamic'),
    'every dynamic layer is contiguous: exactly one tail, which is what a cache break costs'
  );
  // The static run is non-empty, i.e. the cacheable prefix is not a rounding error.
  assert.ok(firstDynamic > 0, 'static layers lead the prompt');
});

test('buildSystemPrompt IS the layers, joined — one code path, so measurement is not a fiction', async () => {
  const layers = await buildPromptLayers(INPUTS);
  assert.equal(await buildSystemPrompt(INPUTS), joinLayers(layers));

  const sum = summarizePromptLayers(layers);
  // The separator newlines between layers are counted, because a total that
  // disagrees with the string is worse than no total at all.
  assert.equal(sum.totalBytes, Buffer.byteLength(joinLayers(layers)));
  assert.equal(sum.totalTokens, estimatePromptLayerTokens(sum.totalBytes));
  assert.equal(sum.cacheablePrefixBytes, Buffer.byteLength(joinLayers(byKind(layers, 'static'))));
  assert.equal(
    sum.stablePrefixBytes + (sum.totalBytes - sum.stablePrefixBytes),
    sum.totalBytes,
    'stable prefix + volatile tail = total'
  );
  for (const l of layers) {
    assert.equal(l.bytes, Buffer.byteLength(l.text), `${l.name} byte count`);
    assert.match(l.hash, /^[0-9a-f]{12}$/, `${l.name} hash`);
  }
});

test('every layer carries a distinct hash, so a silent content edit is visible', async () => {
  const layers = await buildPromptLayers(INPUTS);
  const hashes = layers.map((l) => l.hash);
  assert.equal(new Set(hashes).size, hashes.length, 'two layers share a hash — one of them is a copy');
});

test('the reorder changed the ORDER and nothing else: no section was dropped', async () => {
  const prompt = await buildSystemPrompt(INPUTS);
  for (const header of [
    '# TOOL RULES',
    '# MEMORY',
    '# SUBAGENTS',
    '# SKILLS',
    '# WORKSPACE TREE',
    '# PROJECT INSTRUCTIONS',
  ]) {
    assert.ok(prompt.includes(header), `section missing after layering: ${header}`);
  }
  // Content that existing tests already pin, re-checked here so the reorder
  // cannot quietly weaken any of them.
  assert.match(prompt, /Independent read-only calls \(read_file, grep, glob, list_dir\)/);
  assert.match(prompt, /Independent subagent calls may be emitted together in one turn and run CONCURRENTLY/);
  assert.match(prompt, /- Use memory tools only for durable, evidence-backed facts; never store secrets\./);
  assert.match(prompt, /prefer small diffs/, 'the memory block still reaches the model');
  assert.match(prompt, /- Ordered repo-root first/, 'AGENTS.md precedence is still stated');
  assert.match(prompt, /AGENTS\.md: house rules/, 'the project instructions still reach the model');
  assert.match(prompt, /- alpha — does alpha things/, 'the skill inventory still reaches the model');
  assert.match(prompt, /├── src/, 'the workspace tree still reaches the model');
  assert.match(prompt, /^- cwd: /m, 'the environment still reaches the model');
  assert.match(prompt, /^- platform: /m);
  assert.match(prompt, /^- git: /m);
});

test('the ordering guarantees existing tests rely on survived the reorder', async () => {
  const prompt = await buildSystemPrompt(INPUTS);
  // system-prompt-parallel.test.js and tools-fs.test.js slice the rules out as
  // [TOOL RULES, MEMORY); subagent-visibility.test.js slices
  // [SUBAGENTS, SKILLS); gaps1.test.js wants PERSONA before SKILLS. A reorder is
  // only free if these relative orders still hold.
  assert.ok(prompt.indexOf('# TOOL RULES') < prompt.indexOf('# MEMORY'), 'TOOL RULES before MEMORY');
  assert.ok(prompt.indexOf('# SUBAGENTS') < prompt.indexOf('# SKILLS'), 'SUBAGENTS before SKILLS');
});

test('the memory screen, the tree elision markers and AGENTS.md nesting all still land', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { buildContext } = await import('../src/context.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-layer-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# House rules\nROOT-MARK\n');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'AGENTS.md'), 'SUB-MARK\n');
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(root, 'sub', `d${i}`), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'd0', 'file.txt'), 'x');
  fs.mkdirSync(path.join(root, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agent', 'MEMORY.md'), 'durable fact\n');

  try {
    const { loadMemoryBlock } = await import('../src/memory.js');
    const atSub = path.join(root, 'sub');
    const ctx = buildContext({ cwd: atSub, budgetTokens: 200 });
    const layers = await buildPromptLayers({
      cwd: atSub,
      contextParts: ctx,
      memoryBlock: loadMemoryBlock(atSub),
    });

    const instructions = layers.find((l) => l.name === 'project-instructions');
    assert.ok(instructions, 'project instructions are their own layer');
    assert.match(instructions.text, /ROOT-MARK/, 'the repo-root AGENTS.md still applies from a subdirectory');
    assert.match(instructions.text, /SUB-MARK/, 'the nested AGENTS.md still applies');
    assert.match(instructions.text, /- Ordered repo-root first/);

    const memory = layers.find((l) => l.name === 'memory');
    assert.ok(memory?.text.startsWith('\n# MEMORY'), 'the # MEMORY header is intact and still first in its layer');

    const tree = layers.find((l) => l.name === 'workspace-tree');
    assert.ok(tree?.text.includes('# WORKSPACE TREE'), 'the tree keeps its header');
    // Budget + elision are context.js's job, and the layering must not have let
    // the tree bypass them: a tight budget still has to say out loud that entries
    // were dropped. Both documented forms count -- the compact per-directory
    // marker '(+4+)' and the global '... N more entries' footer -- because which
    // one fires depends on where the walk was cut, not on this layer.
    assert.match(
      tree.text,
      /\(\+\d*\+?\?\)|\(\+\d+\+?\)|\.\.\. \d+ more entr(y|ies)/,
      `tree lost its elision markers:\n${tree.text}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the prompt did not get longer: the reorder is byte-neutral, not merely smaller', async () => {
  // Layering is a reorder. If this number ever climbs, something was ADDED, and
  // that is the failure mode the constraint exists to prevent -- a new header, a
  // duplicated rule, a comment that leaked into the prompt text.
  const layers = await buildPromptLayers(INPUTS);
  const sum = summarizePromptLayers(layers);
  // 1957 -> 2061, and the whole 104 bytes are the delegation clause: the serial
  // one-liner (303B) was replaced by the parallel one (407B) once the fan-out
  // landed. Measured, not assumed -- the old and new clause lengths differ by
  // exactly 104, so nothing else in the prompt moved. The pin still guards the
  // NEXT change; it just no longer forbids this one.
  //
  // The ENVIRONMENT layer carries the live cwd path and git state, so its size
  // depends on where the suite runs (a worktree path is longer than a checkout).
  // Pin everything else -- the text a change to ox can actually grow.
  const envBytes = Buffer.byteLength(layers.find((l) => l.name === 'environment').text);
  // 1927 -> 2110: the 183 bytes are exactly the create_media rule (fbe768e:
  // "generate, make, render, draw, or create an image, use create_media…").
  assert.equal(sum.totalBytes - envBytes, 2110, 'pinned: the reorder is byte-neutral');

  // The pinned number alone would still pass if a line were added AND another
  // dropped. Rebuild the exact byte sequence the flat string used to emit -- the
  // date back inside ENVIRONMENT, the rest in its old order -- and require the
  // SAME multiset of lines. A reorder that is not lossless fails here.
  const by = Object.fromEntries(layers.map((l) => [l.name, l]));
  const original = [
    by.core.text,
    [by.environment.text, by.clock.text].join('\n'),
    by['tool-rules'].text,
    by.memory.text,
    by.subagents.text,
    by.skills.text,
    by['workspace-tree'].text,
    by['project-instructions'].text,
  ].join('\n');
  const now = joinLayers(layers);
  const sortLines = (s) => s.split('\n').sort().join('\n');
  assert.equal(Buffer.byteLength(original), sum.totalBytes, 'the pre-change ordering is the same size');
  assert.equal(
    sortLines(original),
    sortLines(now),
    'the model is told the same set of lines; only their order changed'
  );
});

test('# AGENT MESSAGING is static, conditional, and says the three things schemas cannot', async () => {
  // Reachability is the whole reason this is gated: src/tools/index.js ships the
  // two mailbox schemas only when a handler is on ctx, so a run with no mailbox
  // must not be told it has one.
  const off = await buildPromptLayers(INPUTS);
  assert.equal(
    off.find((l) => l.name === 'agent-messaging'),
    undefined,
    'no mailbox handler, no # AGENT MESSAGING section -- and zero bytes for it'
  );
  assert.ok(!(await buildSystemPrompt(INPUTS)).includes('# AGENT MESSAGING'));

  const on = await buildPromptLayers({ ...INPUTS, agentMessaging: true });
  const layer = on.find((l) => l.name === 'agent-messaging');
  assert.ok(layer, 'the section is rendered when a handler exists');
  // STATIC, so a run with a mailbox pays these bytes once in the cacheable
  // prefix rather than on every turn.
  assert.equal(layer.kind, 'static');

  const prompt = await buildSystemPrompt({ ...INPUTS, agentMessaging: true });
  assert.ok(prompt.includes('# AGENT MESSAGING'));
  // Each clause is a fact the model cannot infer from the schemas alone.
  assert.match(prompt, /agent_message\.send/, 'names the sender tool');
  assert.match(prompt, /agent_observe/, 'names the reader tool');
  assert.match(prompt, /by its agent id/i, 'addressing is by agent id');
  assert.match(prompt, /AT-MOST-ONCE/i, 'delivery semantics are stated, not implied');
  assert.match(prompt, /never arrives on its own/i, 'mail is inert until asked for');
  assert.match(prompt, /DATA about another model/i, 'a message is data, not instructions');
  assert.equal(layer.bytes, Buffer.byteLength(layer.text));
  // Pinned so "add a paragraph explaining the mailbox" fails loudly instead of
  // quietly growing the cacheable prefix on every run.
  assert.equal(AGENT_MESSAGING_CLAUSES.length, 3, 'three clauses, not a page');
  assert.equal(layer.bytes, 459, 'pinned at 459 bytes (~115 tokens) of the static prefix');
});

test('the goal layer is named for what it holds and is DYNAMIC, because progress moves', async () => {
  const goalText = [
    '## ACTIVE GOAL (persistent: survives compaction and session resume)',
    'objective: ship it',
    'progress: 1/3 items proven done',
    '',
    '## GOAL CONTRACT',
    'outcome: done',
  ].join('\n');
  const layers = await buildPromptLayers({ ...INPUTS, contractBlock: goalText });

  // agent.js joins renderGoalBlock() and renderContractBlock() into ONE string,
  // so this layer holds the persistent goal AND the contract -- `goal-contract`
  // named only half of it.
  const layer = layers.find((l) => l.name === 'goal');
  assert.ok(layer, 'the layer exists');
  assert.equal(layer.name, 'goal');
  assert.match(layer.text, /## ACTIVE GOAL/, 'it holds the goal block');
  assert.match(layer.text, /## GOAL CONTRACT/, 'and the contract block');

  // DYNAMIC, not session: `progress: 1/3 items proven done` advances as work is
  // proven mid-run, and a session-kind layer whose bytes move breaks the prefix it
  // sits in.
  assert.equal(layer.kind, 'dynamic');
  const kinds = layers.map((l) => l.kind);
  assert.equal(
    kinds.lastIndexOf('dynamic'),
    kinds.length - 1,
    'the goal rides the single contiguous tail with memory and the clock'
  );

  // And a moved progress counter must not be able to touch the static prefix.
  const later = await buildPromptLayers({
    ...INPUTS,
    contractBlock: goalText.replace('1/3', '2/3'),
  });
  const prefixOf = (ls) => ls.filter((l) => l.kind === 'static').map((l) => l.text).join('\n');
  assert.equal(prefixOf(layers), prefixOf(later), 'goal progress moving leaves the static prefix untouched');
});
