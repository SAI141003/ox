import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import {
  buildPlan,
  formatPlan,
  interactivePlanReview,
  savePlan,
  loadPlan,
  listPlans,
} from '../src/plan-first.js';

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-'));
}
function rm(cwd) { try { fs.rmSync(cwd, { recursive: true }); } catch {} }

// ---------------------------------------------------------------------------
// buildPlan: heuristic fallback
// ---------------------------------------------------------------------------

test('buildPlan: heuristic generates a plan for a build task', async () => {
  const r = await buildPlan({ task: 'build a CLI todo app', target: null, config: {}, cwd: process.cwd() });
  assert.ok(r.plan);
  assert.ok(r.plan.goal);
  assert.ok(Array.isArray(r.plan.steps));
  assert.ok(r.plan.steps.length >= 3);
  const titles = r.plan.steps.map((s) => s.title.toLowerCase());
  assert.ok(titles.some((t) => /explore|understand/.test(t)));
});

test('buildPlan: heuristic for fix task includes reproduction', async () => {
  const r = await buildPlan({ task: 'fix the login bug', target: null, config: {}, cwd: process.cwd() });
  const titles = r.plan.steps.map((s) => s.title.toLowerCase());
  assert.ok(titles.some((t) => /reproduce|fix|debug/.test(t)));
});

test('buildPlan: heuristic for test task includes test runner detection', async () => {
  const r = await buildPlan({ task: 'add test coverage', target: null, config: {}, cwd: process.cwd() });
  const titles = r.plan.steps.map((s) => s.title.toLowerCase());
  assert.ok(titles.some((t) => /test/.test(t)));
});

test('buildPlan: heuristic for generic task produces a valid plan', async () => {
  const r = await buildPlan({ task: 'do something', target: null, config: {}, cwd: process.cwd() });
  assert.ok(r.plan.steps.length >= 2);
});

// ---------------------------------------------------------------------------
// formatPlan: pretty printing
// ---------------------------------------------------------------------------

test('formatPlan: includes goal and step titles', () => {
  const out = formatPlan({
    goal: 'Build a thing',
    steps: [{ title: 'Step 1', reasoning: 'Because', tools: ['read_file'], estimate: '~1m' }],
  });
  assert.match(out, /Build a thing/);
  assert.match(out, /Step 1/);
  assert.match(out, /Because/);
  assert.match(out, /read_file/);
});

test('formatPlan: handles empty steps gracefully', () => {
  const out = formatPlan({ goal: 'g', steps: [] });
  assert.match(out, /no steps/);
});

test('formatPlan: handles missing goal', () => {
  const out = formatPlan({ steps: [{ title: 'A' }] });
  assert.ok(out);
});

test('formatPlan: includes action prompt at end', () => {
  const out = formatPlan({ goal: 'g', steps: [{ title: 'A' }] });
  assert.match(out, /Approve|Edit|Reject|Skip/);
});

// ---------------------------------------------------------------------------
// interactivePlanReview: input handling
// ---------------------------------------------------------------------------

test('interactivePlanReview: auto-approve returns approve', async () => {
  const r = await interactivePlanReview({}, { autoApprove: true });
  assert.equal(r.action, 'approve');
});

test('interactivePlanReview: A → approve', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.write('a\n'));
  const r = await interactivePlanReview({}, { stdin, stdout });
  assert.equal(r.action, 'approve');
});

test('interactivePlanReview: E → edit', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.write('e\n'));
  const r = await interactivePlanReview({}, { stdin, stdout });
  assert.equal(r.action, 'edit');
});

test('interactivePlanReview: R → reject', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.write('r\n'));
  const r = await interactivePlanReview({}, { stdin, stdout });
  assert.equal(r.action, 'reject');
});

test('interactivePlanReview: S → skip', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.write('s\n'));
  const r = await interactivePlanReview({}, { stdin, stdout });
  assert.equal(r.action, 'skip');
});

test('interactivePlanReview: uppercase A → approve', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  setImmediate(() => stdin.write('A\n'));
  const r = await interactivePlanReview({}, { stdin, stdout });
  assert.equal(r.action, 'approve');
});

// ---------------------------------------------------------------------------
// savePlan / loadPlan / listPlans: disk persistence
// ---------------------------------------------------------------------------

test('savePlan: writes plan to .agent/plans/<slug>.json', () => {
  const cwd = tmpCwd();
  const r = savePlan({ goal: 'Build X', steps: [{ title: 'A' }] }, { cwd, id: 'build-x' });
  assert.ok(fs.existsSync(r.path));
  assert.equal(r.id, 'build-x');
  const data = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.equal(data.plan.goal, 'Build X');
  rm(cwd);
});

test('savePlan: auto-generates slug from goal', () => {
  const cwd = tmpCwd();
  const r = savePlan({ goal: 'Build a Cool Thing', steps: [] }, { cwd });
  assert.match(r.id, /build-a-cool-thing/);
  rm(cwd);
});

test('loadPlan: returns null for missing plan', () => {
  const cwd = tmpCwd();
  const r = loadPlan({ cwd, id: 'nope' });
  assert.equal(r, null);
  rm(cwd);
});

test('loadPlan: round-trips a saved plan', () => {
  const cwd = tmpCwd();
  savePlan({ goal: 'X', steps: [{ title: 'A' }] }, { cwd, id: 'x' });
  const r = loadPlan({ cwd, id: 'x' });
  assert.equal(r.plan.goal, 'X');
  assert.equal(r.plan.steps[0].title, 'A');
  rm(cwd);
});

test('listPlans: returns saved plan ids', () => {
  const cwd = tmpCwd();
  savePlan({ goal: 'A', steps: [] }, { cwd, id: 'a' });
  savePlan({ goal: 'B', steps: [] }, { cwd, id: 'b' });
  const ids = listPlans({ cwd });
  assert.deepEqual(ids.sort(), ['a', 'b']);
  rm(cwd);
});

test('listPlans: returns empty array when no plans dir', () => {
  const cwd = tmpCwd();
  const ids = listPlans({ cwd });
  assert.deepEqual(ids, []);
  rm(cwd);
});
