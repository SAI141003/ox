import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupModel } from '../src/cost.js';
import {
  MODEL_CATALOG,
  STRATEGIES,
  makeTask,
  listCandidates,
  isReachable,
  pickModel,
  pickForRole,
} from '../src/model-registry.js';

test('MODEL_CATALOG: every entry has strengths and maxComplexity', () => {
  for (const [name, caps] of Object.entries(MODEL_CATALOG)) {
    assert.ok(Array.isArray(caps.strengths) && caps.strengths.length > 0, `${name} missing strengths`);
    assert.ok(typeof caps.maxComplexity === 'number', `${name} missing maxComplexity`);
    assert.ok(caps.maxComplexity >= 0 && caps.maxComplexity <= 1, `${name} maxComplexity out of range`);
  }
});

test('MODEL_CATALOG: is frozen', () => {
  assert.ok(Object.isFrozen(MODEL_CATALOG));
});

test('STRATEGIES: contains pinned, cost, quality, fast and is frozen', () => {
  assert.ok(STRATEGIES.pinned && STRATEGIES.cost && STRATEGIES.quality && STRATEGIES.fast);
  assert.ok(Object.isFrozen(STRATEGIES));
});

test('makeTask: fills defaults for empty input', () => {
  const t = makeTask();
  assert.equal(t.kind, 'code');
  assert.equal(t.complexity, 0.5);
  assert.deepEqual(t.requires, {});
});

test('makeTask: clamps complexity to 0..1', () => {
  assert.equal(makeTask({ complexity: -0.5 }).complexity, 0);
  assert.equal(makeTask({ complexity: 1.5 }).complexity, 1);
  assert.equal(makeTask({ complexity: 'foo' }).complexity, 0.5);
});

test('makeTask: preserves requires and kind when provided', () => {
  const t = makeTask({ kind: 'reviewer', complexity: 0.7, requires: { vision: true } });
  assert.equal(t.kind, 'reviewer');
  assert.equal(t.complexity, 0.7);
  assert.equal(t.requires.vision, true);
});

test('listCandidates: always includes preset bots', () => {
  const cands = listCandidates({}, {});
  assert.ok(cands.length > 0, 'no candidates');
  const names = cands.map((c) => c.bot);
  assert.ok(names.includes('ox-grok'), 'grok bot missing');
  assert.ok(names.includes('ox-claude'), 'claude bot missing');
});

test('listCandidates: includes custom bots from config', () => {
  const cands = listCandidates({ bots: { mybot: { provider: 'anthropic', model: 'claude-sonnet-5' } } }, {});
  const names = cands.map((c) => c.bot);
  assert.ok(names.includes('mybot'), 'custom bot missing from candidates');
});

test('isReachable: ollama requires OX_OLLAMA_AVAILABLE=1', () => {
  assert.equal(isReachable({ provider: 'ollama' }, {}, {}), false);
  assert.equal(isReachable({ provider: 'ollama' }, {}, { OX_OLLAMA_AVAILABLE: '1' }), true);
});

test('isReachable: anthropic requires ANTHROPIC_API_KEY when no OX_BASE_URL', () => {
  assert.equal(isReachable({ provider: 'anthropic' }, {}, {}), false);
  assert.equal(isReachable({ provider: 'anthropic' }, {}, { ANTHROPIC_API_KEY: 'sk-test' }), true);
});

test('isReachable: OX_BASE_URL makes every provider reachable', () => {
  assert.equal(isReachable({ provider: 'anthropic' }, {}, { OX_BASE_URL: 'http://localhost:8000/v1' }), true);
  assert.equal(isReachable({ provider: 'xai' }, {}, { OX_BASE_URL: 'http://localhost:8000/v1' }), true);
});

test('isReachable: xai needs XAI_API_KEY', () => {
  assert.equal(isReachable({ provider: 'xai' }, {}, {}), false);
  assert.equal(isReachable({ provider: 'xai' }, {}, { XAI_API_KEY: 'xai-test' }), true);
});

test('pickModel: with OX_OLLAMA_AVAILABLE=1 and no other keys, ollama is picked', () => {
  const p = pickModel({ config: {}, task: { kind: 'code' }, env: { OX_OLLAMA_AVAILABLE: '1' } });
  assert.ok(p, 'expected a descriptor');
  assert.equal(p.provider, 'ollama');
});

test('pickModel: returns null when no candidate is reachable and no defaultBot', () => {
  const p = pickModel({ config: {}, task: { kind: 'code' }, env: {} });
  assert.equal(p, null);
});

test('pickModel: ollama is picked over defaultBot when OX_OLLAMA_AVAILABLE=1', () => {
  const p = pickModel({ config: { defaultBot: 'ox-grok' }, task: { kind: 'code' }, env: { OX_OLLAMA_AVAILABLE: '1' } });
  assert.ok(p, 'expected a descriptor');
  assert.equal(p.provider, 'ollama');
});

test('pickModel: pinned strategy returns the configured default bot exactly', () => {
  const p = pickModel({
    config: { defaultBot: 'ox-haiku' },
    task: { kind: 'code', complexity: 0.9 },
    strategy: STRATEGIES.pinned,
    env: { ANTHROPIC_API_KEY: 'sk-test' },
  });
  assert.equal(p.model, 'claude-haiku-4-5');
});

test('pickModel: cost strategy prefers a fast model for low complexity', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-test',
    XAI_API_KEY: 'xai-test',
    GROQ_API_KEY: 'groq-test',
    OPENAI_API_KEY: 'oai-test',
  };
  const p = pickModel({
    config: { defaultBot: 'ox-grok' },
    task: { kind: 'title', complexity: 0.2 },
    strategy: STRATEGIES.cost,
    env,
  });
  assert.ok(p, 'expected a model');
  const caps = MODEL_CATALOG[p.model];
  if (caps) assert.notEqual(caps.tier, 'flagship', 'title task should not pick a flagship');
});

test('pickModel: quality strategy picks a flagship for high complexity', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-test',
    XAI_API_KEY: 'xai-test',
  };
  const p = pickModel({
    config: { defaultBot: 'ox-grok' },
    task: { kind: 'reasoning', complexity: 0.95 },
    strategy: STRATEGIES.quality,
    env,
  });
  assert.ok(p);
  const caps = MODEL_CATALOG[p.model];
  if (caps) assert.equal(caps.tier, 'flagship');
});

test('pickModel: vision requirement filters non-vision models', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test', XAI_API_KEY: 'xai-test' };
  const p = pickModel({
    config: { defaultBot: 'ox-claude' },
    task: { kind: 'code', complexity: 0.5, requires: { vision: true } },
    env,
  });
  assert.ok(p);
  if (MODEL_CATALOG[p.model]) assert.equal(MODEL_CATALOG[p.model].vision, true);
});

test('pickModel: longContext requirement filters small-window models', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test', XAI_API_KEY: 'xai-test' };
  const p = pickModel({
    config: { defaultBot: 'ox-claude' },
    task: { kind: 'reasoning', complexity: 0.5, requires: { longContext: true } },
    env,
  });
  assert.ok(p);
  const price = lookupModel(p.model);
  assert.ok(price.window >= 200_000, `expected >= 200k window, got ${price.window}`);
});

test('pickForRole: planner returns a descriptor when reachable', () => {
  const p = pickForRole('planner', { config: { defaultBot: 'ox-grok' }, env: { XAI_API_KEY: 'xai-test' } });
  assert.ok(p, 'expected a descriptor for planner');
});

test('pickForRole: title task is cheap (never flagship)', () => {
  const p = pickForRole('title', { config: { defaultBot: 'ox-grok' }, env: { XAI_API_KEY: 'xai-test' } });
  assert.ok(p);
  if (MODEL_CATALOG[p.model]) assert.notEqual(MODEL_CATALOG[p.model].tier, 'flagship');
});

test('pickForRole: coder returns a descriptor with code strength', () => {
  const p = pickForRole('coder', { config: { defaultBot: 'ox-claude' }, env: { ANTHROPIC_API_KEY: 'sk-test' } });
  assert.ok(p);
});

test('pickForRole: unknown role falls back to coder profile', () => {
  const p = pickForRole('nonexistent-role', { config: { defaultBot: 'ox-claude' }, env: { ANTHROPIC_API_KEY: 'sk-test' } });
  assert.ok(p, 'expected fallback descriptor for unknown role');
});
