// Default subagent routing ('auto'): switch to a cheaper model only when the
// saving is provable; otherwise every agent stays on the main model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSubagentTarget } from '../src/subagent.js';

const env = { ...process.env, XAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' };
const opus = { provider: 'anthropic', model: 'claude-opus-5', keyEnv: 'ANTHROPIC_API_KEY', pricing: { in: 5, out: 25 } };

function withEnv(fn) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('a cheaper priced model is picked, with the saving in the note', () => withEnv(() => {
  const r = autoSubagentTarget({ config: {}, mainTarget: opus, pick: { bot: 'ox-grok-fast' } });
  assert.equal(r.target.model, 'grok-build-0.1');
  assert.match(r.why, /\$3\/Mtok vs \$30\/Mtok/);
}));

test('a local keyless model replaces a paid main model', () => withEnv(() => {
  const r = autoSubagentTarget({ config: {}, mainTarget: opus, pick: { provider: 'ollama', model: 'qwen2.5-coder:7b' } });
  assert.equal(r.target.provider, 'ollama');
  assert.equal(r.why, 'local and free');
}));

test('never routes to a model whose key is missing, or while OX_BASE_URL pins the endpoint', () => withEnv(() => {
  // Regression: with only an Anthropic key, auto once picked Gemini Flash and every subagent failed.
  const noGemini = { ...process.env };
  delete noGemini.GEMINI_API_KEY;
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: opus, pick: { bot: 'ox-flash' }, env: noGemini }), null, 'missing key');
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: opus, pick: { bot: 'ox-grok-fast' }, env: { ...process.env, OX_BASE_URL: 'http://127.0.0.1:9/v1' } }), null, 'pinned endpoint');
}));

test('never switches to a pricier model, the same model, or away from an unpriced/local main', () => withEnv(() => {
  const haiku = { provider: 'anthropic', model: 'claude-haiku-4-5', keyEnv: 'ANTHROPIC_API_KEY', pricing: { in: 1, out: 5 } };
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: haiku, pick: { bot: 'ox-opus' } }), null, 'pricier');
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: opus, pick: { bot: 'ox-opus' } }), null, 'same model');
  const custom = { provider: 'custom', model: 'my-model', keyEnv: 'OX_API_KEY', pricing: null };
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: custom, pick: { bot: 'ox-grok-fast' } }), null, 'unpriced main');
  const local = { provider: 'ollama', model: 'qwen', keyEnv: null, pricing: null };
  assert.equal(autoSubagentTarget({ config: {}, mainTarget: local, pick: { bot: 'ox-grok-fast' } }), null, 'already free');
}));
