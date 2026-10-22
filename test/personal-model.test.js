import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addTrainingExample, evaluateAdapterPromotion, personalModelDataset,
  personalModelPaths, personalModelState, savePersonalModelState, trainingPlan,
} from '../src/personal-model.js';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-personal-model-')); }

test('personal model is off by default and cannot be armed without explicit consent', () => {
  const h = home();
  assert.equal(personalModelState({ home: h }).enabled, false);
  assert.throws(() => savePersonalModelState({ enabled: true }, { home: h }), /explicit consent/);
});

test('personal model keeps sources opt-in and accepts only individual approved examples', () => {
  const h = home();
  const state = savePersonalModelState({ enabled: true, consent: true, baseModel: 'Qwen/Qwen2.5-7B-Instruct', sources: { approved_chats: true } }, { home: h, now: new Date('2026-10-22T00:00:00Z') });
  assert.equal(state.status, 'armed');
  assert.throws(() => addTrainingExample({ source: 'approved_chats', input: 'hello', output: 'hi' }, { home: h }), /explicit approval/);
  addTrainingExample({ source: 'approved_chats', approved: true, input: 'Prefer concise answers', output: 'I will be concise.' }, { home: h });
  assert.equal(personalModelDataset({ home: h }).length, 1);
  assert.ok(fs.existsSync(personalModelPaths({ home: h }).dataset));
});

test('personal model refuses secrets in its dataset and never claims a runtime is installed', () => {
  const h = home();
  savePersonalModelState({ enabled: true, consent: true, baseModel: 'base', sources: { preferences: true } }, { home: h });
  assert.throws(() => addTrainingExample({ source: 'preferences', approved: true, input: 'key', output: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890' }, { home: h }), /refusing to store/);
  const plan = trainingPlan({ home: h, platform: 'linux', spawn: () => ({ status: 1 }) });
  assert.equal(plan.ready, false);
  assert.ok(plan.blockers.some((x) => /50 individually approved examples/.test(x)));
});

test('adapter promotion needs held-out evidence and safety, never an automatic score claim', () => {
  assert.equal(evaluateAdapterPromotion({ baseline: 0.6, candidate: 0.7, safetyPassed: true, heldOutExamples: 8 }).promotable, true);
  assert.equal(evaluateAdapterPromotion({ baseline: 0.7, candidate: 0.6, safetyPassed: true, heldOutExamples: 8 }).promotable, false);
  assert.equal(evaluateAdapterPromotion({ baseline: 0.6, candidate: 0.7, safetyPassed: false, heldOutExamples: 8 }).promotable, false);
});
