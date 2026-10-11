import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

let root;
let tempDir;
let home;
let originalEnv;
let originalCwd;
let createMemoryStore;
let autoCreateSkill;
let discoverSkills;
let readSkillBody;
let createModelRouter;
let createVerifier;
let createSelfImproveLoop;
let createDriftGuard;

before(async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'HOME isolation must run in a node:test worker');
  originalEnv = { ...process.env };
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'ox-integration-'));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: originalEnv.PATH || '',
    HOME: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT,
  });
  assert.equal(homedir(), root);
  process.chdir(root);
  ({ createMemoryStore, autoCreateSkill } = await import('../src/memory-learn.js'));
  ({ discoverSkills, readSkillBody } = await import('../src/skills.js'));
  ({ createModelRouter } = await import('../src/model-router.js'));
  ({ createVerifier } = await import('../src/verify-loop.js'));
  ({ createSelfImproveLoop } = await import('../src/self-improve-loop.js'));
  ({ createDriftGuard } = await import('../src/spec-drift.js'));
});

beforeEach(() => {
  tempDir = mkdtempSync(join(root, 'case-'));
  home = join(tempDir, 'home');
  mkdirSync(home);
  process.env.HOME = home;
  process.chdir(tempDir);
  assert.equal(homedir(), home);
});

afterEach(() => {
  process.chdir(root);
  process.env.HOME = root;
  rmSync(tempDir, { recursive: true, force: true });
});

after(() => {
  if (originalCwd) process.chdir(originalCwd);
  if (originalEnv) {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function verifyFixture(operator) {
  const solution = `module.exports = (a, b) => a ${operator} b;\n`;
  writeFileSync(join(tempDir, 'solution.cjs'), solution);
  writeFileSync(join(tempDir, 'check.cjs'), [
    "const assert = require('node:assert/strict');",
    "const add = require('./solution.cjs');",
    'const actual = add(2, 3);',
    'assert.equal(actual, 5);',
    "process.stdout.write(`verified: 2 + 3 = ${actual}\\n`);",
  ].join('\n'));
  const verifier = createVerifier(tempDir, {
    ctx: {
      requestApproval: async (tool, args, command) => {
        assert.equal(tool, 'bash');
        assert.equal(args.command, command);
        assert.match(command, /check\.cjs$/);
        return true;
      },
    },
  });
  const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  const criteria = {
    tests: false,
    lint: false,
    build: false,
    security: false,
    deploy: false,
    custom: [{ name: 'addition fixture', cmd: `${executable} check.cjs` }],
  };
  const report = await verifier.verify('add two numbers', solution, criteria);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].name, 'addition fixture');
  assert.deepEqual(verifier.getReport(), [report]);
  return { verifier, report, criteria };
}

function promoteVerifiedFixture(store, report, promote) {
  if (!report.passed) return null;
  return promote(store, report.task, `${report.result}\n${report.checks.map(check => check.output.trim()).join('\n')}`, { verified: true });
}

describe('Explicit test composition: persisted memory preference → router target (not automatic runtime wiring)', () => {
  test('retrieved preferredBot changes the selected target under the supported pinned strategy', () => {
    const store = createMemoryStore(tempDir);
    assert.equal(store.file, join(home, '.ox', 'memory', 'memory.jsonl'));
    const saved = store.add({
      type: 'preference',
      content: JSON.stringify({ preferredBot: 'fixture-preferred' }),
      source: 'user',
      confidence: 0.9,
    });
    store.save();

    const reloaded = createMemoryStore(tempDir);
    const matches = reloaded.search('preferredBot');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, saved.id);
    const preference = JSON.parse(matches[0].content);
    const config = {
      routingStrategy: 'pinned',
      defaultBot: 'fixture-default',
      localFirst: false,
      bots: {
        'fixture-default': { provider: 'ollama', model: 'fixture-default-model' },
        'fixture-preferred': { provider: 'ollama', model: 'fixture-preferred-model' },
      },
    };
    const router = createModelRouter(config);
    const task = { kind: 'code', complexity: 0.7 };
    const baseline = router.route(task, { env: {} });
    const route = router.route(task, { env: {}, preferredBot: preference.preferredBot });
    const target = route.model;

    assert.equal(baseline.model.bot, config.defaultBot);
    assert.notEqual(target.model, baseline.model.model);
    assert.equal(target.bot, preference.preferredBot);
    assert.equal(target.model, config.bots[preference.preferredBot].model);
    assert.equal(target.provider, 'ollama');
    assert.equal(target.baseUrl, 'http://localhost:11434/v1');
    assert.equal(target.keyEnv, null);
    assert.ok(target.window > 0);
    assert.equal(router.getStats().modelUsage[target.model], 1);
  });

  test('memory retrieval → routing via preferredBotFromMemory opt-in', () => {
    const store = createMemoryStore(tempDir);
    store.add({
      type: 'preference',
      content: JSON.stringify({ preferredBot: 'fixture-preferred' }),
      source: 'user',
      confidence: 0.9,
    });
    store.save();

    const reloadedStore = createMemoryStore(tempDir);
    const config = {
      routingStrategy: 'pinned',
      defaultBot: 'fixture-default',
      localFirst: false,
      bots: {
        'fixture-default': { provider: 'ollama', model: 'fixture-default-model' },
        'fixture-preferred': { provider: 'ollama', model: 'fixture-preferred-model' },
      },
    };
    const router = createModelRouter(config);
    const task = { kind: 'code', complexity: 0.7 };
    
    const baseline = router.route(task, { env: {} });
    const route = router.route(task, { 
      env: {}, 
      [createMemoryStore.preferredBotFromMemory]: true,
      memoryStore: reloadedStore 
    });
    const target = route.model;

    assert.equal(baseline.model.bot, config.defaultBot);
    assert.equal(target.bot, 'fixture-preferred');
    assert.equal(target.model, config.bots['fixture-preferred'].model);
  });

  test('route target → generated plan via injectable offline planner (no runAgent)', async () => {
    const { buildPlan } = await import('../src/orchestrator.js');
    let called = false;
    const planner = (prompt) => {
      called = true;
      assert.match(prompt, /JSON object/);
      assert.match(prompt, /build a login form/);
      return JSON.stringify({
        goal: 'build a login form',
        steps: [
          { agent: 'coder', task: 'create login.jsx', verify: 'file exists' },
          { agent: 'tester', task: 'test login flow', verify: 'tests pass' },
        ],
      });
    };

    const plan = await buildPlan({
      task: 'build a login form',
      config: {},
      planner,
    });

    assert.equal(called, true, 'offline planner must be invoked');
    assert.equal(plan.goal, 'build a login form');
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.steps[0].agent, 'coder');
    assert.equal(plan.steps[0].task, 'create login.jsx');
    assert.equal(plan.steps[0].verify, 'file exists');
    assert.equal(plan.steps[1].agent, 'tester');
    assert.equal(plan.steps[1].task, 'test login flow');
    assert.equal(plan.steps[1].verify, 'tests pass');
    assert.match(plan.raw, /"goal"s*:s*"build a login form"/);
  });
});

describe('Explicit test composition: real local verification → skill promotion (not automatic runtime wiring)', () => {
  test('a passing custom fixture check invokes promotion using the verified task, source and output', async (t) => {
    const store = createMemoryStore(tempDir);
    const { report } = await verifyFixture('+');
    assert.equal(report.passed, true);
    assert.equal(report.checks[0].passed, true);
    assert.equal(report.checks[0].exitCode, 0);
    assert.match(report.checks[0].output, /^exit 0/);
    assert.match(report.checks[0].output, /verified: 2 \+ 3 = 5/);
    assert.equal(report.summary, 'PASS addition fixture');
    assert.equal(existsSync(join(home, '.agents', 'skills')), false);
    assert.equal(discoverSkills({ builtin: false }).length, 0);

    const promote = t.mock.fn(autoCreateSkill);
    const skill = promoteVerifiedFixture(store, report, promote);
    assert.equal(promote.mock.callCount(), 1);
    assert.equal(skill.name, 'add-two-numbers');
    assert.equal(skill.file, join(home, '.agents', 'skills', skill.name, 'SKILL.md'));
    const solution = `${report.result}\n${report.checks[0].output.trim()}`;
    const body = `# ${report.task}\n\n## Reusable procedure\n\n${solution}`;
    assert.equal(readFileSync(skill.file, 'utf8'), `---\nname: ${skill.name}\ndescription: Reusable procedure for ${skill.name}\n---\n\n${body}\n`);
    const loaded = discoverSkills({ builtin: false });
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, skill.name);
    assert.equal(loaded[0].path, skill.file);
    assert.equal(loaded[0].description, `Reusable procedure for ${skill.name}`);
    assert.equal(readSkillBody(skill.name, loaded), body);
    assert.ok(loaded.index.includes(skill.file));
    assert.equal(existsSync(join(home, '.ox', 'skills')), false);
    const persisted = createMemoryStore(tempDir).search(report.task);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].type, 'skill');
    assert.equal(persisted[0].content, `${report.task}: ${solution}`);
    assert.equal(persisted[0].source, skill.file);
  });

  test('a failing custom fixture check does not invoke promotion or write skill memory', async (t) => {
    const store = createMemoryStore(tempDir);
    store.add({ type: 'fact', content: 'existing memory stays unchanged', source: 'fixture' });
    store.save();
    const memoryBefore = readFileSync(store.file, 'utf8');
    const { report } = await verifyFixture('-');
    assert.equal(report.passed, false);
    assert.equal(report.checks[0].passed, false);
    assert.equal(report.checks[0].exitCode, 1);
    assert.match(report.checks[0].output, /AssertionError/);
    assert.equal(report.summary, 'FAIL addition fixture');

    const promote = t.mock.fn(autoCreateSkill);
    assert.equal(promoteVerifiedFixture(store, report, promote), null);
    assert.equal(promote.mock.callCount(), 0);
    assert.equal(existsSync(join(home, '.agents', 'skills')), false);
    assert.equal(existsSync(join(home, '.ox', 'skills')), false);
    assert.equal(discoverSkills({ builtin: false }).length, 0);
    assert.equal(readFileSync(store.file, 'utf8'), memoryBefore);
    assert.equal(createMemoryStore(tempDir).stats().byType.skill, 0);
  });

  test('autoCreateSkill requires explicit verified=true option', () => {
    const store = createMemoryStore(tempDir);
    
    assert.throws(
      () => autoCreateSkill(store, 'test task', 'test solution'),
      { message: 'autoCreateSkill requires an explicit verified=true option; unverified solutions must not be promoted' }
    );
    
    for (const verified of [false, undefined, null, 0, 1, 'true', {}, []]) {
      assert.throws(
        () => autoCreateSkill(store, 'test task', 'test solution', { verified }),
        { message: 'autoCreateSkill requires an explicit verified=true option; unverified solutions must not be promoted' }
      );
    }
    assert.equal(existsSync(join(home, '.agents', 'skills')), false);
    assert.equal(existsSync(store.file), false);
    assert.deepEqual(store.entries, []);
    assert.equal(discoverSkills({ builtin: false }).length, 0);

    const result = autoCreateSkill(store, 'test task', 'test solution', { verified: true });
    assert.ok(result.name);
    assert.ok(result.file);
    assert.ok(result.entry);
    assert.equal(result.entry.type, 'skill');
  });

  test('generated metadata stays loader-compatible for Unicode, punctuation and long tasks', () => {
    const store = createMemoryStore(tempDir);
    const cases = [
      ['日本語', 'skill'],
      ['!!!', 'skill'],
      ['Fix: "quoted" # task\n---\nname: injected', 'fix-quoted-task-name-injected'],
      [`${'a'.repeat(59)} ${'b'.repeat(1100)}`, 'a'.repeat(59)],
    ];
    for (const [task, name] of cases) {
      const solution = `Procedure for ${task}`;
      const created = autoCreateSkill(store, task, solution, { verified: true });
      assert.equal(created.name, name);
      assert.equal(created.file, join(home, '.agents', 'skills', name, 'SKILL.md'));
      const loaded = discoverSkills({ builtin: false });
      assert.deepEqual(loaded.warnings, []);
      const skill = loaded.find((item) => item.name === name);
      assert.ok(skill);
      assert.equal(skill.path, created.file);
      assert.equal(skill.description, `Reusable procedure for ${name}`);
      assert.equal(readSkillBody(name, loaded), `# ${task}\n\n## Reusable procedure\n\n${solution}`);
      assert.equal(created.entry.content, `${task}: ${solution}`);
      assert.equal(created.entry.confidence, 0.8);
    }
    assert.equal(createMemoryStore(tempDir).stats().byType.skill, cases.length);
  });
});

describe('Self-improve: verified remediation with real re-verification and spec drift guard', () => {
  test('verifyFn fails broken fixture, passes fixed one; failing proposal not verified, file unchanged', async (t) => {
    const { verifier, report, criteria } = await verifyFixture('-');
    assert.equal(report.passed, false);
    const sourceBefore = readFileSync(join(tempDir, 'solution.cjs'), 'utf8');
    
    const brain = { getFindings: t.mock.fn(() => []), getGaps: t.mock.fn(() => []) };
    const loop = createSelfImproveLoop(tempDir, brain, {
      verifyFn: async (proposal) => {
        if (proposal.action?.includes('broken')) {
          return { ok: false, detail: 'verification failed: broken code' };
        }
        if (proposal.action?.includes('fixed')) {
          return { ok: true, detail: 'verification passed: fixed code' };
        }
        return { ok: true, detail: 'default pass' };
      }
    });
    await loop.init();
    
    const cycle = loop.getCycle();
    cycle.propose([{ findings: [{ text: 'broken implementation', confidence: 0.8 }], topic: 'test' }]);
    const proposals = cycle.proposals;
    proposals[0].action = 'Implement finding: broken implementation';
    proposals[0].file = join(tempDir, 'solution.cjs');
    
    const applied = await cycle.apply(proposals);
    assert.equal(applied[0].status, 'pending-implementation');
    
    const verified = await cycle.verify(applied);
    assert.equal(verified[0].verified, false);
    assert.equal(verified[0].verification, 'failed');
    assert.equal(verified[0].detail, 'verification failed: broken code');
    
    assert.equal(readFileSync(join(tempDir, 'solution.cjs'), 'utf8'), sourceBefore);
    
    cycle.propose([{ findings: [{ text: 'fixed implementation', confidence: 0.9 }], topic: 'test' }]);
    const fixedProposals = cycle.proposals;
    fixedProposals[0].action = 'Implement finding: fixed implementation';
    fixedProposals[0].file = join(tempDir, 'solution.cjs');
    
    const appliedFixed = await cycle.apply(fixedProposals);
    const verifiedFixed = await cycle.verify(appliedFixed);
    assert.equal(verifiedFixed[0].verified, true);
    assert.equal(verifiedFixed[0].verification, 'passed');
    assert.equal(verifiedFixed[0].detail, 'verification passed: fixed code');
  });

  test('driftGuard blocks proposal modifying locked file', async (t) => {
    const driftDir = join(tempDir, '.agent', 'architecture');
    mkdirSync(driftDir, { recursive: true });
    writeFileSync(join(driftDir, 'decisions.json'), JSON.stringify([
      {
        id: 'dec-locked-file',
        title: 'Lock solution.cjs',
        decision: 'solution.cjs must not be modified',
        rationale: 'Critical fixture',
        files: ['solution.cjs'],
        locked: true
      }
    ]));
    
    writeFileSync(join(tempDir, 'solution.cjs'), 'module.exports = (a, b) => a + b;\n');
    
    const brain = { getFindings: t.mock.fn(() => []), getGaps: t.mock.fn(() => []) };
    const driftGuard = createDriftGuard(tempDir);
    const loop = createSelfImproveLoop(tempDir, brain, { driftGuard });
    await loop.init();
    
    const cycle = loop.getCycle();
    cycle.propose([{ findings: [{ text: 'modify solution', confidence: 0.8 }], topic: 'test' }]);
    const proposals = cycle.proposals;
    proposals[0].action = 'Modify solution.cjs';
    proposals[0].file = join(tempDir, 'solution.cjs');
    proposals[0].diffText = '- module.exports = (a, b) => a + b;\n+ module.exports = (a, b) => a - b;\n';
    
    const applied = await cycle.apply(proposals);
    assert.equal(applied[0].status, 'blocked-by-spec-drift');
    assert.ok(applied[0].drift);
    assert.equal(applied[0].drift.blocked, true);
    assert.ok(applied[0].drift.report);
    assert.ok(applied[0].drift.report.drifts.length > 0);
    assert.equal(applied[0].drift.report.drifts[0].severity, 'violation');
    
    assert.equal(readFileSync(join(tempDir, 'solution.cjs'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  });

  test('an empty graph produces a nominally verified config proposal without consuming the failing verifier report', async (t) => {
    const { verifier, report, criteria } = await verifyFixture('-');
    assert.equal(report.passed, false);
    const sourceBefore = readFileSync(join(tempDir, 'solution.cjs'), 'utf8');
    const filesBefore = readdirSync(tempDir).sort();
    const brain = { getFindings: t.mock.fn(() => []), getGaps: t.mock.fn(() => []) };
    const loop = createSelfImproveLoop(tempDir, brain);
    await loop.init();
    const cycle = await loop.runCycle();
    assert.deepEqual(cycle.steps, [
      { step: 'identifyGaps', count: 0 },
      { step: 'research', topics: [] },
      { step: 'propose', count: 1 },
      { step: 'apply', count: 0 },
      { step: 'verify', count: 0 },
      { step: 'record', count: 1 },
    ]);
    assert.equal(brain.getFindings.mock.callCount(), 0);
    assert.equal(brain.getGaps.mock.callCount(), 0);
    assert.equal(loop.getCycle().learnings[0].type, 'config');
    assert.equal(loop.getCycle().learnings[0].verified, false);
    assert.equal(loop.getCycle().learnings[0].verification, 'unverified');
    assert.equal(verifier.getReport().length, 1);
    assert.equal(readFileSync(join(tempDir, 'solution.cjs'), 'utf8'), sourceBefore);
    assert.deepEqual(readdirSync(tempDir).sort(), [...filesBefore, 'improve-history.json'].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(tempDir, 'improve-history.json'), 'utf8')), [cycle]);
    assert.equal(existsSync(join(home, '.ox', 'skills')), false);
    const rechecked = await verifier.verify(report.task, report.result, criteria);
    assert.equal(rechecked.passed, false);
    assert.equal(rechecked.checks[0].exitCode, 1);
    assert.equal(verifier.getReport().length, 2);
  });
});
