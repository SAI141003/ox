// The chat box's + menu and wand, server side: photos are checked before they
// reach a model, "think harder" never goes to the quick pick, and the wand's
// reply is cleaned to the prompt alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OX_NO_KEYSTORE = '1';
process.env.OX_NO_PLAN_CHECK = '1';
const { cleanImages, autoModel, RESEARCH_BRIEF, LEARN_BRIEF } = await import('../src/serve.js');
const { cleanOptimized } = await import('../src/prompt-optimizer.js');

test('only real photos, at most 4, reach a model', () => {
  const ok = { mediaType: 'image/jpeg', data: 'QUJD' };
  assert.deepEqual(cleanImages([ok, { mediaType: 'text/html', data: 'QUJD' }, { mediaType: 'image/png', data: '<script>' }, null]), [ok]);
  assert.equal(cleanImages(Array(6).fill(ok)).length, 4);
  assert.deepEqual(cleanImages('nope'), []);
  assert.deepEqual(cleanImages([{ ...ok, extra: 'x' }]), [ok]);
});

test('think harder and photos skip the quick pick', () => {
  const env = { XAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' };
  const quick = autoModel([{ role: 'user', content: 'hi' }], env);
  const hard = autoModel([{ role: 'user', content: 'hi' }], env, { think: true });
  const photo = autoModel([{ role: 'user', content: 'what is this?', images: [{ mediaType: 'image/png', data: 'QQ==' }] }], env);
  assert.match(hard.why, /think harder/);
  assert.match(photo.why, /photo/);
  assert.notEqual(quick.why, hard.why);
  assert.match(RESEARCH_BRIEF, /\[1\]/);
  assert.match(LEARN_BRIEF, /one step at a time/);
});

test('models under 1B parameters are spotted by name', async () => {
  const { tinyModel } = await import('../src/serve.js');
  for (const n of ['hf.co/unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M', 'qwen2.5:0.5b', 'SmolLM2-360M']) assert.equal(tinyModel(n), true, n);
  for (const n of ['qwen2.5:3b', 'qwen2.5:1.5b', 'llama3.2:1b', 'gpt-6-luna', 'grok-4.6', 'Q4_K_M', 'chatgpt-plan']) assert.equal(tinyModel(n), false, n);
});

test('the wand keeps the prompt only', () => {
  assert.equal(cleanOptimized('Here is the rewritten prompt: "Fix the login bug in [which file?]"', 'fix login'), 'Fix the login bug in [which file?]');
  assert.equal(cleanOptimized('```\nWrite an email to [landlord]\n```', 'email landlord'), 'Write an email to [landlord]');
  assert.equal(cleanOptimized('', 'x'), '');
  assert.equal(cleanOptimized('x'.repeat(5000), 'short'), '');
});
