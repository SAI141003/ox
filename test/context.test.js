import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, buildContext, parseGitignore, pureCompact, staleToolOutputTrim, treeBudgetTokens } from '../src/context.js';

let repo;

const write = (rel, content) => {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctx-repo-'));
  write('AGENTS.md', 'ROOT-INSTRUCTIONS-MARKER\n');
  write('sub/AGENTS.md', 'SUB-INSTRUCTIONS-MARKER\n');
  write('.gitignore', '*.log\n!special.log\nsecret/\n');
  write('a.log', '');
  write('b.log', '');
  write('special.log', '');
  write('keep.txt', '');
  write('secret/inner.txt', '');
  write('src/code.js', 'export const x = 1;\n');
  for (let i = 0; i < 40; i++) write(`many/f${String(i).padStart(12, '0')}.txt`, '');
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

test('estimateTokens is chars/4 rounded up', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abc'), 1);
});

test('buildContext accumulates layered rule files root-first (deeper wins later)', () => {
  const atRoot = buildContext({ cwd: repo, budgetTokens: 8000 });
  assert.ok(atRoot.memoryFiles.includes(path.join(repo, 'AGENTS.md')));
  assert.ok(atRoot.memoryFiles.includes('ROOT-INSTRUCTIONS-MARKER'));
  // Wave5b J: collection walks cwd→root, so sub/ (a DESCENDANT of the cwd)
  // is not part of the chain when standing at the root...
  assert.ok(!atRoot.memoryFiles.includes('SUB-INSTRUCTIONS-MARKER'));

  // ...but standing at sub/, BOTH ancestor layers accumulate, root-first,
  // so the deeper instruction appears LATER and wins conflicts.
  const atSub = buildContext({ cwd: path.join(repo, 'sub'), budgetTokens: 8000 });
  assert.ok(atSub.memoryFiles.includes(path.join(repo, 'sub', 'AGENTS.md')));
  assert.ok(atSub.memoryFiles.includes('SUB-INSTRUCTIONS-MARKER'));
  assert.ok(atSub.memoryFiles.includes('ROOT-INSTRUCTIONS-MARKER'));
  assert.ok(atSub.memoryFiles.includes(path.join(repo, 'AGENTS.md')));
  const rootIdx = atSub.memoryFiles.indexOf('ROOT-INSTRUCTIONS-MARKER');
  const subIdx = atSub.memoryFiles.indexOf('SUB-INSTRUCTIONS-MARKER');
  assert.ok(rootIdx < subIdx, 'nested instruction concatenates after the root one');

  assert.equal(atSub.tokenCount, estimateTokens(atSub.memoryFiles + '\n' + atSub.tree));
  assert.ok(atSub.tokenCount > 0);
});

test('buildContext respects .gitignore including ! negation', () => {
  const ctx = buildContext({ cwd: repo, budgetTokens: 8000 });
  assert.ok(ctx.tree.includes('special.log'), '! negation must keep special.log');
  assert.ok(ctx.tree.includes('keep.txt'));
  assert.ok(ctx.tree.includes('src/'));
  assert.ok(ctx.tree.includes('code.js'));
  assert.ok(!ctx.tree.includes('a.log'));
  assert.ok(!ctx.tree.includes('b.log'));
  assert.ok(!ctx.tree.includes('secret/'));
});

test('tree is capped by token budget and says how much it dropped', () => {
  const full = buildContext({ cwd: repo, budgetTokens: 8000 });
  assert.ok(!full.tree.includes('[truncated'));
  assert.ok(!full.tree.includes('more entries'));
  const capped = buildContext({ cwd: repo, budgetTokens: 60 });
  // Root-only tree plus the elision line. This replaces the old
  // '[truncated: token budget reached]' string: the marker now tells the model
  // HOW MANY entries are missing and what to call instead.
  assert.match(capped.tree, /^ox-ctx-repo-[^/]+\/\n\.\.\. \d+ more entries \(use list_dir or glob to explore\)$/);
  assert.ok(capped.tree.split('\n').length < full.tree.split('\n').length);
});

test('tree holds its share of the budget on a large synthetic tree', () => {
  // A source tree big enough to blow the budget several times over, with the
  // entry-count cap and the token budget both in play.
  const big = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctx-big-'));
  try {
    for (let d = 0; d < 6; d++) {
      for (let f = 0; f < 60; f++) {
        const dir = path.join(big, `mod${d}`, `pkg${f % 10}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `file${String(f).padStart(3, '0')}.ts`), '');
        fs.writeFileSync(path.join(dir, `notes${String(f).padStart(3, '0')}.md`), '');
      }
    }
    fs.writeFileSync(path.join(big, '.gitignore'), 'ignored-dir/\n');
    fs.mkdirSync(path.join(big, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(big, 'ignored-dir', 'leak.ts'), '');

    const budget = 8000;
    const ctx = buildContext({ cwd: big, budgetTokens: budget });
    const treeTok = estimateTokens(ctx.tree);
    // The tree gets its share, and the instructions are charged before it.
    assert.ok(treeTok <= treeBudgetTokens(budget, ctx.memoryFiles), `tree ${treeTok} tok exceeds its share`);
    assert.ok(estimateTokens(ctx.memoryFiles + '\n' + ctx.tree) <= budget, 'instructions + tree stay inside the budget');
    // A dropped tree says so, and never claims a partial tree is complete.
    const m = ctx.tree.match(/^\.\.\. (\d+)([+]?) more entries \(use list_dir or glob to explore\)$/m);
    assert.ok(m, `elision marker missing from:\n${ctx.tree.slice(-200)}`);
    assert.ok(Number(m[1]) > 0);
    // Ranking: source survives, .gitignore'd paths never appear.
    assert.ok(ctx.tree.includes('mod0/'));
    assert.ok(ctx.tree.includes('.ts'));
    assert.ok(!ctx.tree.includes('ignored-dir'), '.gitignore still honoured after ranking');
  } finally {
    fs.rmSync(big, { recursive: true, force: true });
  }
});

test('a small tree is byte-identical whether or not a budget was passed', () => {
  const small = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ctx-small-'));
  try {
    fs.writeFileSync(path.join(small, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(small, 'src'));
    fs.writeFileSync(path.join(small, 'src', 'index.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(small, 'README.md'), '# hi\n');
    const ctx = buildContext({ cwd: small });
    // Exact expected shape: dirs first, then files, name order, box drawing
    // intact. A tree already inside its budget must not lose a single byte.
    const expected = [
      `${path.basename(small)}/`,
      '├── src/',
      '│   └── index.js',
      '├── package.json',
      '└── README.md',
    ].join('\n');
    assert.equal(ctx.tree, expected);
    assert.ok(!ctx.tree.includes('more entries'));
    // Generous budget renders the same bytes as the default: the cap only ever
    // removes, never rewrites.
    assert.equal(buildContext({ cwd: small, budgetTokens: 8000 }).tree, expected);
    assert.equal(buildContext({ cwd: small, budgetTokens: 1_000_000 }).tree, expected);
  } finally {
    fs.rmSync(small, { recursive: true, force: true });
  }
});

test('parseGitignore handles negation and dir-only rules', () => {
  const rules = parseGitignore('*.log\n!special.log\nsecret/\n');
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[1], { negate: true, dirOnly: false, anchored: false, re: /^special\.log$/ });
});

test('pureCompact never splits assistant(tool_calls) from its tool results at the k-boundary', () => {
  const sys = { role: 'system', content: 'sys' };
  const user = { role: 'user', content: 'hi' };
  const a1 = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
  const t1 = { role: 'tool', tool_call_id: 'c1', content: 'r1' };
  const a2 = { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] };
  const t2 = { role: 'tool', tool_call_id: 'c2', content: 'r2' };
  const msgs = [sys, user, a1, t1, a2, t2];

  // boundary falls between a1 and t1 → cut must back up to the owning assistant
  let r = pureCompact(msgs, 3);
  assert.deepEqual(r.head, [sys]);
  assert.deepEqual(r.toSummarize, [user]);
  assert.equal(r.tail[0], a1);
  assert.deepEqual(r.tail, [a1, t1, a2, t2]);
  assert.deepEqual([...r.head, ...r.toSummarize, ...r.tail], msgs);

  // boundary lands exactly on a2 → its tool result must stay with it
  r = pureCompact(msgs, 2);
  assert.deepEqual(r.toSummarize, [user, a1, t1]);
  assert.deepEqual(r.tail, [a2, t2]);

  // boundary falls between a2 and t2 → backs up to a2
  r = pureCompact(msgs, 1);
  assert.deepEqual(r.tail, [a2, t2]);

  // keepTurns 0 summarizes everything, keeps nothing
  r = pureCompact(msgs, 0);
  assert.deepEqual(r.toSummarize, msgs.slice(1));
  assert.deepEqual(r.tail, []);
});

test('staleToolOutputTrim replaces only old oversized tool outputs and never mutates input', () => {
  const big1 = { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(120) };
  const small = { role: 'tool', tool_call_id: 'c2', content: 'short' };
  const bigLast = { role: 'tool', tool_call_id: 'c3', content: 'y'.repeat(130) };
  const input = [{ role: 'user', content: 'q' }, big1, small, bigLast];
  const snapshot = JSON.stringify(input);

  const out = staleToolOutputTrim(input, 100);
  assert.notEqual(out, input);
  assert.equal(out[1].content, '[output truncated, 120 chars]');
  assert.equal(out[2].content, 'short');
  assert.equal(out[3].content, bigLast.content, 'most recent tool output stays intact');
  assert.equal(out[0].content, 'q');

  assert.equal(JSON.stringify(input), snapshot, 'input array untouched');
});
