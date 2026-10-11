import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORCHESTRATOR_ROLES, buildPlan } from '../src/orchestrator.js';

test('ORCHESTRATOR_ROLES: contains the 6 team roles', () => {
  assert.deepEqual(ORCHESTRATOR_ROLES, [
    'planner', 'coder', 'reviewer', 'tester', 'researcher', 'documenter',
  ]);
});

test('buildPlan: returns a valid plan structure on parse failure', async () => {
  const plan = await buildPlan({
    task: 'add a hello world function',
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.ok(plan.goal);
  assert.ok(Array.isArray(plan.steps));
  assert.ok(plan.steps.length > 0);
  assert.equal(typeof plan.steps[0].task, 'string');
  assert.equal(typeof plan.steps[0].verify, 'string');
});

test('buildPlan: clamps step count to maxSteps', async () => {
  const plan = await buildPlan({
    task: 'big refactor',
    config: { orchestrator: { maxSteps: 3 } },
    target: null,
    cwd: process.cwd(),
  });
  assert.ok(plan.steps.length <= 3);
});

test('buildPlan: always includes at least one step', async () => {
  const plan = await buildPlan({
    task: 'anything',
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.ok(plan.steps.length >= 1);
});

test('buildPlan: step agent is one of the known roles', async () => {
  const plan = await buildPlan({
    task: 'add auth',
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  for (const step of plan.steps) {
    assert.ok(
      ORCHESTRATOR_ROLES.includes(step.agent) || step.agent === 'coder',
      `unknown role: ${step.agent}`
    );
  }
});
