// Auto model: quick messages to the fastest model that can answer, work with
// code or tools to the strongest; never a model that cannot answer here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-auto-'));
const { autoModel } = await import('../src/serve.js');
test.after(() => { fs.rmSync(process.env.HOME, { recursive: true, force: true }); process.env.HOME = realHome; });
const say = (t) => [{ role: 'user', content: t }];

test('with an Anthropic key: hi goes to the small model, a code fix to the strong one', () => {
  const env = { ANTHROPIC_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
  assert.equal(autoModel(say('hi'), env).id, 'ox-haiku');
  assert.equal(autoModel(say('What is a mortgage?'), env).id, 'ox-haiku');
  assert.equal(autoModel(say('Fix the failing test in src/serve.js'), env).id, 'ox-opus');
});

test('only models that can answer are picked', () => {
  const env = { GROQ_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
  assert.equal(autoModel(say('hi'), env).id, 'ox-groq');
  assert.equal(autoModel(say('refactor src/a.js'), env).id, 'ox-groq');
  assert.match(autoModel(say('refactor src/a.js'), env).why, /only model/);
});

test('Auto never picks the Claude plan on its own; your default model leads real work', () => {
  const ox = path.join(process.env.HOME, '.ox');
  fs.mkdirSync(ox, { recursive: true });
  const cfg = path.join(ox, 'config.json');
  const src = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.doesNotMatch(/const STRONG_BOTS = \[[^\]]*\]/.exec(src)[0], /claude-plan/);
  fs.writeFileSync(cfg, JSON.stringify({ defaultBot: 'ox-groq' }));
  try {
    const env = { GROQ_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
    assert.equal(autoModel(say('Fix the failing test in src/serve.js'), env).id, 'ox-groq');
    assert.match(autoModel(say('Fix the failing test in src/serve.js'), env).why, /your default/);
    assert.equal(autoModel(say('hi'), env).id, 'ox-haiku', 'small talk still goes to the quickest');
  } finally {
    fs.rmSync(cfg, { force: true });
  }
});

test('"do it yourself" and other go-aheads keep their tools: they are requests to act, not questions', async () => {
  const M = await import('../src/modes.js');
  for (const t of ['do it yourself', 'u do it', 'go ahead', 'you do it, use the terminal', 'fix it for me']) {
    assert.equal(M.isPlainQuestion(t), false, t);
    assert.ok(M.DO_IT.test(t), t);
  }
  assert.equal(M.isPlainQuestion('do you know what a mortgage is?'), true, 'a real question still is one');
});

test('a quick answer uses your default model with a key, not a plan and its 13,000 tokens', () => {
  const ox = path.join(process.env.HOME, '.ox');
  fs.mkdirSync(ox, { recursive: true });
  const cfg = path.join(ox, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ defaultBot: 'my-model', bots: { 'my-model': { provider: 'nvidia', model: 'vendor/m' } } }));
  try {
    const env = { NVIDIA_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
    const r = autoModel(say('What is a mortgage?'), env);
    assert.equal(r.id, 'my-model');
    assert.match(r.why, /quick answer, your default model/);
  } finally {
    fs.rmSync(cfg, { force: true });
  }
});

