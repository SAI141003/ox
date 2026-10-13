import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTS, KEY_ENV, OLLAMA_BASE_URL, resolveBot, listBots } from '../src/bots.js';

test('every preset resolves to its expected provider+model', () => {
  const expected = {
    'ox-grok': ['xai', 'grok-4.6', null],
    'ox-grok-fast': ['xai', 'grok-build-0.1', null],
    'ox-claude': ['anthropic', 'claude-sonnet-5-5', null],
    'ox-opus': ['anthropic', 'claude-opus-5-5', null],
    'ox-haiku': ['anthropic', 'claude-haiku-5-5', null],
    'ox-fable': ['anthropic', 'claude-fable-5-1', null],
    'ox-gpt': ['openai', 'gpt-5.6-sol', null],
    'ox-gemini': ['gemini', 'gemini-3.1-pro-preview', null],
    'ox-flash': ['gemini', 'gemini-3.7-flash', null],
    'ox-groq': ['groq', 'moonshotai/kimi-k2-instruct-0905', null],
    'ox-deepseek': ['deepseek', 'deepseek-v4-pro', null],
    'ox-ollama': ['ollama', 'qwen2.5:0.5b', OLLAMA_BASE_URL],
    'ox-backboard': ['backboard', 'backboard-routing', 'https://api.backboard.io/v1'],
    'ox-glm': ['zhipu', 'glm-4.5', 'https://open.bigmodel.cn/api/paas/v4'],
    'ox-glm-turbo': ['zhipu', 'glm-4.5-turbo', 'https://open.bigmodel.cn/api/paas/v4'],
    'ox-kimi': ['moonshot', 'kimi-k2-0711-preview', 'https://api.moonshot.cn/v1'],
    'ox-baichuan': ['baichuan', 'baichuan-4', 'https://api.baichuan-ai.com/v1'],
    'ox-minimax': ['minimax', 'minimax-01', 'https://api.minimax.chat/v1'],
    'ox-yi': ['yi', 'yi-34b-chat', 'https://api.lingyiwanwu.com/v1'],
    'ox-stepfun': ['stepfun', 'step-2', 'https://api.stepfun.com/v1'],
    'ox-lmstudio': ['lmstudio', 'auto', null],
    'ox-llamacpp': ['llamacpp', 'auto', null],
    'ox-vllm': ['vllm', 'auto', null],
    'ox-mistral': ['mistral', 'mistral-large-latest', null],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(BOTS).filter((b) => b !== 'ox-openrouter').sort());
  for (const [name, [provider, model, baseUrl]] of Object.entries(expected)) {
    const r = resolveBot(name);
    assert.equal(r.provider, provider, name);
    assert.equal(r.model, model, name);
    assert.equal(r.bot, name, name);
    assert.equal(r.keyEnv, KEY_ENV[provider], name);
    assert.equal(r.baseUrl, baseUrl, name);
  }
});

test("'ox-ollama:llama3' overrides preset model, keeps local base URL", () => {
  const r = resolveBot('ox-ollama:llama3');
  assert.equal(r.provider, 'ollama');
  assert.equal(r.model, 'llama3');
  assert.equal(r.baseUrl, OLLAMA_BASE_URL);
  assert.equal(r.keyEnv, null);
  assert.equal(r.pricing, null);
});

test("'xai:grok-4.6' provider:model spec resolves with xai key env", () => {
  const r = resolveBot('xai:grok-4.6');
  assert.equal(r.provider, 'xai');
  assert.equal(r.model, 'grok-4.6');
  assert.equal(r.keyEnv, 'XAI_API_KEY');
  assert.deepEqual(r.pricing, { in: 2, out: 6 });
});

test('ox-openrouter without model throws with examples', () => {
  assert.throws(() => resolveBot('ox-openrouter'), (err) => {
    assert.match(err.message, /requires an explicit model/);
    assert.match(err.message, /ox-openrouter:meta-llama\/llama-3\.3-70b-instruct/);
    return true;
  });
  const ok = resolveBot('ox-openrouter:moonshotai/kimi-k2-instruct-0905');
  assert.equal(ok.provider, 'openrouter');
  assert.equal(ok.model, 'moonshotai/kimi-k2-instruct-0905');
  assert.equal(ok.keyEnv, 'OPENROUTER_API_KEY');
});

test('unknown bot throws listing available bots', () => {
  assert.throws(() => resolveBot('no-such-bot-xyz'), (err) => {
    assert.match(err.message, /unknown bot 'no-such-bot-xyz'/);
    for (const b of Object.keys(BOTS)) assert.ok(err.message.includes(b));
    return true;
  });
});

test('custom provider via OX_BASE_URL: bare model -> custom + OX_API_KEY', () => {
  const r = resolveBot('my-raw-model', { oxBaseUrl: 'http://127.0.0.1:9000/v1' });
  assert.equal(r.provider, 'custom');
  assert.equal(r.model, 'my-raw-model');
  assert.equal(r.keyEnv, 'OX_API_KEY');
  assert.equal(r.baseUrl, 'http://127.0.0.1:9000/v1');
  assert.equal(r.bot, null);
});

test('listBots exposes presets and config.bots entries', () => {
  const names = listBots({ bots: { mine: { provider: 'groq' } } }).map(([n]) => n);
  assert.ok(names.includes('ox-grok') && names.includes('mine'));
});
