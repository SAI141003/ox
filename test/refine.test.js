// /refine: evidence-backed harness refinement, snapshots, rollback, and the
// structural refusal to touch the immutable base system prompt.
//
// The thing this file is really about is the FAILURE MODE. A "continual
// harness" feature that can edit its own operating instructions is the most
// dangerous capability an agent can be handed, so every claim here is pinned by
// a test that tampers with a proposal and asserts the refusal -- not by a
// comment saying "we don't do that".
//
// Nothing here touches the real ~/.ox: HOME is redirected before the modules
// are imported, and every artifact lands in a per-test tmpdir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-refine-'));
process.env.HOME = HOME_SANDBOX;

const { episodePromotionQualifies, promoteEpisode, writeEpisode } = await import('../src/memory.js');
const {
  REFINE_GATE,
  REFINE_CATEGORIES,
  IMMUTABLE_TARGETS,
  SUPPLEMENTAL_FILE,
  REFINE_BLOCK_BEGIN,
  applyProposals,
  checkSmallness,
  loadTrajectory,
  listRefineSnapshots,
  proposeRefinements,
  refineHistory,
  refineUndo,
  renderTrajectory,
  resolveTarget,
  verifyEvidence,
} = await import('../src/refine.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

// The base system prompt is hashed at module load and re-checked at the end of
// the suite: if any code path in refine.js could write it, this moves.
const BASE_PROMPT = path.resolve(import.meta.dirname, '..', 'src', 'system-prompt.js');
const BASE_PROMPT_SHA = crypto.createHash('sha256').update(fs.readFileSync(BASE_PROMPT)).digest('hex');

function sandbox(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function home(t) {
  return sandbox(t, 'ox-refine-home-');
}

// A transcript with one real failure, so evidence quotes have something true to
// point at.
const EVENTS = [
  { t: 'user', text: 'deploy the api' },
  { t: 'tool-result', name: 'bash', isError: true, content: 'EACCES: permission denied, open /etc/ox.conf' },
  { t: 'assistant', text: 'trying again' },
  { t: 'tool-result', name: 'bash', isError: true, content: 'EACCES: permission denied, open /etc/ox.conf' },
];
const TRAJ = { file: '/tmp/session.jsonl', events: EVENTS, text: renderTrajectory(EVENTS) };
const QUOTE = 'EACCES: permission denied, open /etc/ox.conf';

function proposal(over = {}) {
  return {
    category: 'supplemental-prompt',
    target: 'tool-failures',
    text: 'When bash fails, check approval and the path before retrying',
    score: 8,
    evidence: { quote: QUOTE, event: 1 },
    ...over,
  };
}

function readOr(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 1. a proposal WITH transcript evidence and a passing gate is applied
// ---------------------------------------------------------------------------
test('1. an evidence-backed proposal that passes the gate is applied', (t) => {
  const cwd = sandbox(t, 'ox-refine-apply-');
  const res = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ });

  assert.equal(res.ok, true);
  assert.equal(res.kind, 'applied');
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].gate, REFINE_GATE, 'the verdict must name the gate that was consulted');
  assert.equal(res.applied[0].evidence.quote, QUOTE);

  const guidance = readOr(path.join(cwd, SUPPLEMENTAL_FILE), '');
  assert.match(guidance, /check approval and the path before retrying/);
  assert.match(guidance, /ox:refine:begin/, 'guidance lands inside a marked, revertible block');
  // the guidance file is an instruction file context.js already injects
  assert.ok(fs.existsSync(res.snapshot.path), 'a snapshot is written before the first change');
});

// ---------------------------------------------------------------------------
// 2. a proposal WITHOUT evidence is rejected
// ---------------------------------------------------------------------------
test('2. a proposal with no evidence is rejected', (t) => {
  const cwd = sandbox(t, 'ox-refine-noev-');
  for (const bad of [proposal({ evidence: undefined }), proposal({ evidence: '' }), proposal({ evidence: { quote: 'no' } })]) {
    const res = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [bad], trajectory: TRAJ });
    assert.equal(res.ok, false);
    assert.equal(res.applied.length, 0);
    assert.equal(res.rejected[0].kind, 'no-evidence');
    assert.match(res.rejected[0].reason, /evidence/i);
  }
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), null, 'nothing was written');
});

// A quote that is not in the transcript is the same failure wearing a costume.
test('2b. evidence that does not appear in the transcript is rejected', (t) => {
  const cwd = sandbox(t, 'ox-refine-fakeev-');
  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [proposal({ evidence: { quote: 'the deploy worked perfectly first try' } })],
    trajectory: TRAJ,
  });
  assert.equal(res.rejected[0].kind, 'unverified-evidence');
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), null);
});

// A quote attributed to the wrong event does not pass either.
test('2c. evidence scoped to an event that does not contain it is rejected', (t) => {
  const cwd = sandbox(t, 'ox-refine-evscope-');
  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [proposal({ evidence: { quote: QUOTE, event: 0 } })],
    trajectory: TRAJ,
  });
  assert.equal(res.rejected[0].kind, 'unverified-evidence');
  assert.match(res.rejected[0].reason, /not inside that event/);
});

// ---------------------------------------------------------------------------
// 3. the existing gate rejects a weak proposal -- through the SAME gate
// ---------------------------------------------------------------------------
test('3. a proposal that fails the existing gate is rejected, via the same predicate', async (t) => {
  const cwd = sandbox(t, 'ox-refine-gate-');
  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [proposal({ score: 3 }), proposal({ score: null, verified: false }), proposal({ verified: true })],
    trajectory: TRAJ,
  });

  assert.equal(res.ok, true);
  assert.equal(res.applied.length, 1, 'only the verified proposal clears the bar');
  assert.equal(res.applied[0].text, 'When bash fails, check approval and the path before retrying');
  assert.equal(res.applied[0].verified, true);
  for (const r of res.rejected) {
    assert.equal(r.kind, 'unqualified');
    assert.match(r.reason, /score >= 6 OR verified/, 'the refusal quotes the one gate, by name');
  }
  // The gate is memory.js's, not refine.js's: the wording below is the exact
  // string promoteEpisode would have produced for the same episode.
  assert.match(
    promoteEpisodeMessage(cwd, 'weak-one', { score: 3 }),
    /score is 3 \(< 6\) and it is not verified/
  );
  assert.match(promoteEpisodeMessage(cwd, 'weak-two', { score: 1 }), /score is 1 \(< 6\)/);
});

function promoteEpisodeMessage(cwd, goal, meta) {
  writeEpisode(cwd, { goal, outcome: 'done', lessons: ['a lesson'], meta });
  const files = fs.readdirSync(path.join(cwd, '.agent', 'episodes'));
  const file = files.find((f) => f.includes(goal.split(' ')[0]));
  return promoteEpisode(cwd, file, { home: HOME_SANDBOX }).message;
}

// The differential that makes "same gate" a fact rather than a claim: for every
// (lesson count, score, verified) combination, promoteEpisode and refine reach
// the identical verdict.
test('3b. promoteEpisode and /refine agree on every gate combination', (t) => {
  const homeDir = home(t);
  const cwd = sandbox(t, 'ox-refine-diff-');
  for (const [lessons, score, verified] of [
    [0, 9, true],
    [1, 9, false],
    [1, 6, false],
    [1, 5.9, false],
    [1, null, false],
    [1, 2, true],
    [2, 1, false],
  ]) {
    const expected = episodePromotionQualifies({ lessons: Array(lessons).fill('x'), score, verified });

    // refine's own proposals always carry exactly one lesson (they are lessons),
    // so a lessons=0 combination is not expressible on that side; those rows
    // only assert the predicate and promoteEpisode agree with each other.
    const refinable = lessons >= 1;

    // ...through `ox episode promote`, the pre-existing gate.
    const dir = sandbox(t, 'ox-refine-diff-w-');
    const lessonText = lessons ? 'read the file before editing it' : undefined;
    writeEpisode(dir, { goal: `gate case ${lessons} ${score} ${verified}`, outcome: 'done', lessons: lessonText ? [lessonText] : [], meta: { score, verified } });
    const epFile = fs.readdirSync(path.join(dir, '.agent', 'episodes'))[0];
    const promoted = promoteEpisode(dir, epFile, { home: homeDir });
    assert.equal(promoted.ok, expected, `promoteEpisode disagrees at lessons=${lessons} score=${score} verified=${verified}`);

    // ...and through refine, on a fresh workspace each time.
    if (!refinable) continue;
    const wd = sandbox(t, 'ox-refine-diff-r-');
    const res = applyProposals({
      cwd: wd,
      home: homeDir,
      proposals: [proposal({ score, verified })],
      trajectory: TRAJ,
    });
    const refined = res.applied.length > 0;
    assert.equal(refined, expected, `refine disagrees at score=${score} verified=${verified}`);
    if (!refined) {
      assert.equal(res.rejected[0].kind, 'unqualified');
      assert.ok(res.rejected[0].reason.includes('score >= 6 OR verified'), 'the refusal quotes the one gate');
    }
  }
});

// ---------------------------------------------------------------------------
// 4. /refine undo restores the exact prior state (byte-compare)
// ---------------------------------------------------------------------------
test('4. undo restores the previous state byte-for-byte, after something else breaks it', (t) => {
  const cwd = sandbox(t, 'ox-refine-undo-');
  const guidance = path.join(cwd, SUPPLEMENTAL_FILE);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(guidance, '# project rules\n\n- existing rule\n');
  const before = fs.readFileSync(guidance);

  const applied = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ });
  assert.equal(applied.ok, true);
  assert.notEqual(fs.readFileSync(guidance, 'utf8'), before.toString());

  // break it the way a bad session would: garbage appended after the fact
  fs.appendFileSync(guidance, '- a rule nobody reviewed\n');

  const undone = refineUndo({ cwd, id: applied.snapshot.id });
  assert.equal(undone.ok, true);
  assert.equal(undone.restored.length, 1);
  assert.deepEqual(fs.readFileSync(guidance), before, 'undo is byte-exact, not merely similar');
});

test('4b. undo also removes a file refine created', (t) => {
  const cwd = sandbox(t, 'ox-refine-undo-new-');
  const guidance = path.join(cwd, SUPPLEMENTAL_FILE);
  assert.equal(readOr(guidance), null);
  const applied = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ });
  assert.equal(applied.ok, true);
  assert.ok(fs.existsSync(guidance));
  refineUndo({ cwd, id: applied.snapshot.id });
  assert.equal(readOr(guidance), null, 'a file that did not exist before is removed, not left empty');
});

test('4c. a refinement round-trips through undo twice with no drift', (t) => {
  const cwd = sandbox(t, 'ox-refine-rt-');
  const first = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ });
  const afterFirst = readOr(path.join(cwd, SUPPLEMENTAL_FILE));
  refineUndo({ cwd, id: first.snapshot.id });
  const second = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ });
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), afterFirst, 're-applying reproduces the same bytes');
  refineUndo({ cwd, id: second.snapshot.id });
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), null);
  assert.equal(listRefineSnapshots({ cwd }).length, 2);
});

// ---------------------------------------------------------------------------
// 5. a refinement containing a credential is not persisted
// ---------------------------------------------------------------------------
test('5. a refinement carrying a credential is refused and never lands on disk', (t) => {
  const cwd = sandbox(t, 'ox-refine-secret-');
  const KEY = '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';

  for (const [category, target, text] of [
    ['supplemental-prompt', 'tool-failures', `use the OpenAI key ${KEY} for calls`],
    ['memory', 'lesson/gotchas', `the vault key is ${KEY}`],
    ['subagent-spec', 'reviewer', `auth with ${KEY}`],
  ]) {
    const res = applyProposals({
      cwd,
      home: HOME_SANDBOX,
      proposals: [proposal({ category, target, text })],
      trajectory: TRAJ,
    });
    assert.equal(res.applied.length, 0, `${category} must not persist a credential`);
    assert.ok(
      res.rejected.some((r) => r.kind === 'screen-refused'),
      `${category} should be screen-refused, got ${res.rejected.map((r) => r.kind).join(',')}`
    );
    for (const file of [SUPPLEMENTAL_FILE, path.join('.agent', 'MEMORY.md')]) {
      const body = readOr(path.join(cwd, file), '');
      assert.ok(!body.includes('sk-or-v1-'), `${file} must not contain the key`);
    }
  }

  // and nothing anywhere under the workspace holds it
  const blobs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else blobs.push(readOr(p, ''));
    }
  };
  walk(cwd);
  assert.ok(!blobs.join('\n').includes('sk-or-v1-'), 'the key is nowhere in the workspace');
});

// ---------------------------------------------------------------------------
// 6. a proposal targeting the base system prompt is refused
// ---------------------------------------------------------------------------
test('6. a proposal targeting the base system prompt is refused', (t) => {
  const cwd = sandbox(t, 'ox-refine-base-');
  const before = fs.readFileSync(BASE_PROMPT);

  const attempts = [
    proposal({ target: 'src/system-prompt.js' }),
    proposal({ target: '../ox/src/system-prompt.js' }),
    proposal({ target: BASE_PROMPT }),
    proposal({ target: '/Users/saiyaganti/ox/src/system-prompt.js' }),
    proposal({ target: 'system-prompt.js' }),
    // and as a category, in case the target field is the thing being tampered
    proposal({ category: 'system-prompt', target: 'core' }),
    proposal({ category: 'base-system-prompt', target: 'core' }),
  ];
  for (const p of attempts) {
    const res = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [p], trajectory: TRAJ });
    assert.equal(res.applied.length, 0, `${JSON.stringify(p.target)} must not be applied`);
    assert.ok(
      res.rejected.every((r) => r.kind === 'immutable'),
      `expected an immutable refusal for ${p.category}/${p.target}, got ${res.rejected.map((r) => r.kind).join(',')}`
    );
    assert.ok(res.rejected[0].reason.includes('refus'), 'the refusal says so in words');
    assert.equal(res.rejected[0].immutable.id, 'base-system-prompt', `${p.category} is named as the base system prompt`);
  }
  assert.deepEqual(fs.readFileSync(BASE_PROMPT), before, 'src/system-prompt.js is untouched');
  assert.equal(
    resolveTarget({ cwd, category: 'supplemental-prompt', target: 'src/system-prompt.js' }).ok,
    false
  );
});

// ---------------------------------------------------------------------------
// 7. sandbox / trust / approval / cost cap / API key are each refused
// ---------------------------------------------------------------------------
test('7. sandbox, trust, approval, cost-cap and credential targets are each refused', (t) => {
  const cwd = sandbox(t, 'ox-refine-immutable-');
  const targets = [
    ['sandbox-profile', 'src/sandbox.js'],
    ['sandbox-profile', 'sandbox-profiles/strict.json'],
    ['sandbox-profile', '~/.ox/sandbox'],
    ['trust-level', 'src/trust.js'],
    ['trust-level', 'src/trust-gate.js'],
    ['trust-level', '.ox/trust-levels.json'],
    ['approval-policy', 'src/approval.js'],
    ['approval-policy', '.ox/approval-policy.json'],
    ['cost-cap', 'src/cost.js'],
    ['cost-cap', 'cost-caps/daily.json'],
    ['api-key', '.env'],
    ['api-key', '~/.ox/auth.json'],
    ['api-key', 'api-keys.json'],
    ['api-key', 'credentials.yaml'],
  ];
  assert.deepEqual(
    IMMUTABLE_TARGETS.map((t2) => t2.id).sort(),
    ['api-key', 'approval-policy', 'base-system-prompt', 'cost-cap', 'harness-source', 'sandbox-profile', 'trust-level'].sort()
  );

  for (const [wantId, target] of targets) {
    const res = applyProposals({
      cwd,
      home: HOME_SANDBOX,
      proposals: [proposal({ target })],
      trajectory: TRAJ,
    });
    assert.equal(res.applied.length, 0, `${target} must not be applied`);
    const hit = res.rejected[0];
    assert.equal(hit.kind, 'immutable', `${target} should be refused as immutable, got ${hit.kind}`);
    assert.equal(hit.immutable.id, wantId, `${target} should be refused as ${wantId}, got ${hit.immutable?.id}`);
  }
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), null, 'no tampered proposal wrote anything at all');
});

// The resolver itself only has four exits, all inside the workspace or the
// sandboxed home. There is no code path that produces an arbitrary path.
test('7b. the resolver can only produce paths under the workspace or the home', (t) => {
  const cwd = sandbox(t, 'ox-refine-resolve-');
  const homeDir = home(t);
  assert.deepEqual(REFINE_CATEGORIES.slice().sort(), [
    'memory',
    'skill-description',
    'subagent-spec',
    'supplemental-prompt',
  ]);
  const ok = [
    resolveTarget({ cwd, home: homeDir, category: 'supplemental-prompt', target: 'tool-failures' }),
    resolveTarget({ cwd, home: homeDir, category: 'memory', target: 'lesson/gotchas' }),
    resolveTarget({ cwd, home: homeDir, category: 'subagent-spec', target: 'reviewer' }),
  ];
  for (const r of ok) {
    assert.equal(r.ok, true);
    assert.ok(
      r.path.startsWith(path.resolve(cwd) + path.sep) || r.path.startsWith(path.resolve(homeDir) + path.sep),
      `resolver produced ${r.path}, outside both roots`
    );
  }
  // path traversal in a target name is not a name at all
  for (const bad of ['../../etc/passwd', 'a/b', 'reviewer/../../x', '..']) {
    assert.equal(resolveTarget({ cwd, home: homeDir, category: 'subagent-spec', target: bad }).ok, false);
  }
});

// ---------------------------------------------------------------------------
// 8. a wholesale rewrite is rejected as out of policy
// ---------------------------------------------------------------------------
test('8. a wholesale rewrite is rejected as out of policy', (t) => {
  const cwd = sandbox(t, 'ox-refine-wholesale-');
  const big = Array.from({ length: 12 }, (_, i) => `rule ${i}: always do the thing number ${i} exactly this way`).join('\n');

  const cases = [
    proposal({ content: big }),
    proposal({ body: big }),
    proposal({ text: big }), // over the char cap
    proposal({ text: 'line one\nline two\nline three' }), // over the line cap
    proposal({ text: 'x'.repeat(201) }), // exactly one over the supplemental cap
    proposal({ operation: 'replace-file', text: 'do things differently' }),
  ];
  for (const p of cases) {
    const res = applyProposals({ cwd, home: HOME_SANDBOX, proposals: [p], trajectory: TRAJ });
    assert.equal(res.applied.length, 0);
    assert.equal(res.rejected[0].kind, 'out-of-policy', `${JSON.stringify(p).slice(0, 80)} -> ${res.rejected[0].kind}`);
  }
  assert.equal(readOr(path.join(cwd, SUPPLEMENTAL_FILE)), null);
  assert.equal(checkSmallness({ category: 'memory', text: 'a\nb' }).kind, 'out-of-policy');
  assert.equal(checkSmallness({ category: 'memory', text: 'one line', content: 'x' }).kind, 'out-of-policy');
});

// A skill description that drops most of what was there is a rewrite too, even
// though it is technically a one-line edit.
test('8b. a skill description that replaces rather than edits is out of policy', (t) => {
  const cwd = sandbox(t, 'ox-refine-skill-');
  const homeDir = home(t);
  const dir = path.join(homeDir, '.agents', 'skills', 'deploy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy the service to staging, wait for health, then promote to production safely\n---\n\n# deploy\n'
  );
  const target = path.join(dir, 'SKILL.md');
  const before = fs.readFileSync(target, 'utf8');

  const res = applyProposals({
    cwd,
    home: homeDir,
    proposals: [proposal({ category: 'skill-description', target: 'deploy', text: 'do the thing' })],
    trajectory: TRAJ,
  });
  assert.equal(res.rejected[0].kind, 'out-of-policy');
  assert.match(res.rejected[0].reason, /wholesale rewrite/);
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'the SKILL.md is untouched');

  // A small, real edit to the same description does go through.
  const ok = applyProposals({
    cwd,
    home: homeDir,
    proposals: [
      proposal({
        category: 'skill-description',
        target: 'deploy',
        text: 'Deploy the service to staging, wait for health checks, then promote to production',
      }),
    ],
    trajectory: TRAJ,
  });
  assert.equal(ok.applied.length, 1);
  const after = fs.readFileSync(target, 'utf8');
  assert.match(after, /wait for health checks/);
  assert.equal(after.split('\n').length, before.split('\n').length, 'only the description line changed');
  refineUndo({ cwd, id: ok.snapshot.id });
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'and undo puts the description back');
});

// ---------------------------------------------------------------------------
// 9. history records applied AND rejected, with reasons
// ---------------------------------------------------------------------------
test('9. history records what was proposed, applied and rejected -- with reasons', (t) => {
  const cwd = sandbox(t, 'ox-refine-history-');
  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [
      proposal(),
      proposal({ evidence: undefined }),
      proposal({ score: 1, category: 'memory', target: 'lesson/gotchas' }),
      proposal({ target: 'src/system-prompt.js' }),
      proposal({ content: 'wholesale' }),
    ],
    trajectory: TRAJ,
  });
  assert.equal(res.applied.length, 1);
  assert.equal(res.rejected.length, 4);

  const rows = refineHistory({ cwd });
  const row = rows.at(-1);
  assert.equal(row.proposed, 5, 'the proposal count is recorded, not just the outcome');
  assert.equal(row.applied.length, 1);
  assert.equal(row.rejected.length, 4);
  assert.equal(row.snapshot, res.snapshot.id);
  for (const a of row.applied) {
    assert.ok(a.evidence?.quote, 'an applied item carries the evidence that justified it');
    assert.equal(a.gate, REFINE_GATE);
  }
  const kinds = row.rejected.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['immutable', 'no-evidence', 'out-of-policy', 'unqualified']);
  for (const r of row.rejected) {
    assert.ok(r.reason && r.reason.length > 20, `every rejection needs a reason: ${JSON.stringify(r)}`);
    assert.ok(r.category !== undefined && r.target !== undefined);
  }
  const immutableRow = row.rejected.find((r) => r.kind === 'immutable');
  assert.equal(immutableRow.immutable.id, 'base-system-prompt');

  // a dry run is recorded too: "proposed" is part of the record
  applyProposals({ cwd, home: HOME_SANDBOX, proposals: [proposal()], trajectory: TRAJ, dryRun: true });
  const rows2 = refineHistory({ cwd });
  assert.equal(rows2.length, rows.length + 1);
  assert.equal(rows2.at(-1).dryRun, true);
  assert.equal(rows2.at(-1).applied.length, 0);

  // and an undo is recorded with what it restored
  refineUndo({ cwd, id: res.snapshot.id });
  const undoRow = refineHistory({ cwd }).at(-1);
  assert.equal(undoRow.t, 'undo');
  assert.equal(undoRow.restored.length, 1);
  assert.equal(undoRow.restored[0].category, 'supplemental-prompt');
});

// ---------------------------------------------------------------------------
// 10. an interrupted apply leaves no partial state
// ---------------------------------------------------------------------------
test('10. an interrupted apply leaves no partial state', (t) => {
  // (a) a preflight failure aborts the batch BEFORE the first write
  const cwd = sandbox(t, 'ox-refine-atomic-');
  const guidance = path.join(cwd, SUPPLEMENTAL_FILE);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(guidance, '# rules\n- keep me\n');
  const before = fs.readFileSync(guidance);
  // .agent/ is a FILE, so the memory item cannot be written
  fs.writeFileSync(path.join(cwd, '.agent'), 'not a directory');

  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [proposal(), proposal({ category: 'memory', target: 'lesson/gotchas', text: 'bash denied twice' })],
    trajectory: TRAJ,
  });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'atomic-abort');
  assert.equal(res.applied.length, 0, 'the healthy item was not written either');
  assert.deepEqual(fs.readFileSync(guidance), before, 'no partial guidance line');
  assert.equal(fs.readFileSync(path.join(cwd, '.agent'), 'utf8'), 'not a directory');
  assert.equal(listRefineSnapshots({ cwd }).length, 0, 'an aborted batch leaves no snapshot to confuse undo with');
  // Note: the history row for this batch cannot be written either -- .agent/ is
  // a file here -- which is exactly why nothing partial survives: there is no
  // record claiming something was applied.
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['.agent', '.ox.md']);
});

test('10b. a crash after the first write restores the whole batch', (t) => {
  const cwd = sandbox(t, 'ox-refine-crash-');
  const guidance = path.join(cwd, SUPPLEMENTAL_FILE);
  const homeDir = home(t);
  const skillDir = path.join(homeDir, '.agents', 'skills', 'deploy');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: deploy\ndescription: ship it to staging\n---\n');
  const skillBefore = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');

  const res = applyProposals({
    cwd,
    home: homeDir,
    trajectory: TRAJ,
    proposals: [
      proposal(),
      proposal({ category: 'skill-description', target: 'deploy', text: 'ship it to staging and then verify health' }),
    ],
    faultAfter: 1, // throw once the first item is on disk
  });

  assert.equal(res.ok, false);
  assert.equal(res.kind, 'rolled-back');
  assert.equal(res.applied.length, 0);
  assert.equal(readOr(guidance), null, 'the first write was undone');
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), skillBefore, 'the second write never happened');
  assert.match(res.rejected.at(-1).reason, /restored from snapshot/);
  assert.ok(refineHistory({ cwd }).at(-1).rejected.some((r) => r.kind === 'rolled-back'));
});

// ---------------------------------------------------------------------------
// the proposer, and the rest of the four categories
// ---------------------------------------------------------------------------
test('proposals are mined from the transcript, with the failing line as evidence', () => {
  const proposals = proposeRefinements({ trajectory: TRAJ });
  assert.ok(proposals.length >= 2);
  for (const p of proposals) {
    const check = verifyEvidence(p, TRAJ);
    assert.equal(check.ok, true, `mined proposal failed its own evidence check: ${p.text}`);
    assert.ok(TRAJ.text.includes(p.evidence.quote));
  }
  assert.ok(proposals.some((p) => p.category === 'memory'), 'a repeated failure is worth a memory');
});

test('a clean trajectory proposes nothing', () => {
  const clean = { events: [{ t: 'user', text: 'hi' }, { t: 'assistant', text: 'hello' }] };
  clean.text = renderTrajectory(clean.events);
  assert.deepEqual(proposeRefinements({ trajectory: clean }), []);
  const res = applyProposals({ cwd: HOME_SANDBOX, home: HOME_SANDBOX, proposals: [], trajectory: clean });
  assert.equal(res.kind, 'nothing-to-do');
});

test('the memory category writes through memory.js, and undo takes the topic note with it', (t) => {
  const cwd = sandbox(t, 'ox-refine-mem-');
  const res = applyProposals({
    cwd,
    home: HOME_SANDBOX,
    proposals: [proposal({ category: 'memory', target: 'lesson/gotchas', text: 'bash needs approval for /etc paths' })],
    trajectory: TRAJ,
  });
  assert.equal(res.applied.length, 1);
  const index = readOr(path.join(cwd, '.agent', 'MEMORY.md'), '');
  assert.match(index, /bash needs approval for \/etc paths/);
  const topic = readOr(path.join(cwd, '.agent', 'topics', 'gotchas.md'), '');
  assert.match(topic, /bash needs approval for \/etc paths/);

  refineUndo({ cwd, id: res.snapshot.id });
  assert.equal(readOr(path.join(cwd, '.agent', 'MEMORY.md')), null, 'the index is restored, not appended to');
  assert.equal(readOr(path.join(cwd, '.agent', 'topics', 'gotchas.md')), null, 'the topic note is restored too');
});

test('the subagent-spec category edits the spec and refuses harness config', (t) => {
  const cwd = sandbox(t, 'ox-refine-spec-');
  const homeDir = home(t);
  const dir = path.join(homeDir, '.ox', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'reviewer.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'reviewer', skills: ['audit'], systemPrompt: 'review code' }, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');

  // Harness config and unlisted operations move nothing at all.
  const refused = applyProposals({
    cwd,
    home: homeDir,
    proposals: [
      proposal({ category: 'subagent-spec', target: 'reviewer', model: 'some-other-model' }),
      proposal({ category: 'subagent-spec', target: 'reviewer', provider: 'other' }),
      proposal({ category: 'subagent-spec', target: 'reviewer', baseUrl: 'https://elsewhere' }),
      proposal({ category: 'subagent-spec', target: 'reviewer', operation: 'retune-everything' }),
      proposal({ category: 'subagent-spec', target: 'reviewer', apiKey: 'k' }),
    ],
    trajectory: TRAJ,
  });
  assert.equal(refused.applied.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused batch wrote nothing');
  for (const r of refused.rejected) assert.equal(r.kind, 'out-of-policy');

  // Two edits to the SAME spec in one batch is refused: the second would be
  // planned from the pre-batch bytes and would silently discard the first.
  const both = applyProposals({
    cwd,
    home: homeDir,
    proposals: [
      proposal({ category: 'subagent-spec', target: 'reviewer', operation: 'add-skill', skill: 'security' }),
      proposal({ category: 'subagent-spec', target: 'reviewer', text: 'check approval and the path before retrying' }),
    ],
    trajectory: TRAJ,
  });
  assert.equal(both.applied.length, 1);
  assert.equal(both.rejected[0].kind, 'duplicate-target');

  // The first of the pair already applied; the second one applies in its own
  // batch, so each snapshot holds exactly one change.
  const second = applyProposals({
    cwd,
    home: homeDir,
    proposals: [proposal({ category: 'subagent-spec', target: 'reviewer', text: 'check approval and the path before retrying' })],
    trajectory: TRAJ,
  });
  assert.equal(second.applied.length, 1);

  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(spec.skills, ['audit', 'security']);
  assert.match(spec.systemPrompt, /check approval and the path before retrying/);
  assert.equal(spec.model, undefined, 'a provider/model change is never applied');
  assert.equal(spec.name, 'reviewer', 'and no other field moved');

  // Re-applying an edit the spec already has is a no-op, not a second write.
  const again = applyProposals({
    cwd,
    home: homeDir,
    proposals: [proposal({ category: 'subagent-spec', target: 'reviewer', operation: 'add-skill', skill: 'security' })],
    trajectory: TRAJ,
  });
  assert.equal(again.applied.length, 0);
  assert.equal(again.rejected[0].kind, 'no-change');

  refineUndo({ cwd, id: second.snapshot.id });
  refineUndo({ cwd, id: both.snapshot.id });
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'undo restores the spec byte-for-byte');
});

test('loadTrajectory renders real session events, and evidence matches them', async (t) => {
  const cwd = sandbox(t, 'ox-refine-traj-');
  const homeDir = home(t);
  const sessionDir = path.join(homeDir, '.ox', 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, '20260101-000000-abc123.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ t: 'meta', cwd })}\n${JSON.stringify({ t: 'tool-result', name: 'bash', isError: true, content: 'EACCES: permission denied, open /etc/ox.conf' })}\n`
  );
  const traj = loadTrajectory({ cwd, home: homeDir, sessionFile: file });
  assert.equal(traj.events.length, 2);
  assert.match(traj.text, /EACCES: permission denied/);
  const res = applyProposals({ cwd, home: homeDir, trajectory: traj, proposals: [proposal({ evidence: { quote: 'EACCES: permission denied, open /etc/ox.conf', event: 1 } })] });
  assert.equal(res.applied.length, 1);
});

// ---------------------------------------------------------------------------
// final immutability assertion: the base prompt never moved
// ---------------------------------------------------------------------------
test('the base system prompt is byte-identical after everything above', () => {
  const now = crypto.createHash('sha256').update(fs.readFileSync(BASE_PROMPT)).digest('hex');
  assert.equal(now, BASE_PROMPT_SHA, 'src/system-prompt.js changed during the refine suite');
  assert.match(
    fs.readFileSync(BASE_PROMPT, 'utf8'),
    /You are ox, a featherweight coding agent\./,
    'the base prompt still says what it said'
  );
});
