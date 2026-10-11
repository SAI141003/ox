import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { MODEL_CATALOG, isReachable, listCandidates, pickModel } from '../src/model-registry.js';
import { LOCAL_MODELS, recommendLocalModel } from '../src/local-inference.js';
import { createVideoMcpServer, ENV } from '../src/video-mcp.js';

const memory = (totalGB, freeGB = totalGB) => ({
  totalmem: () => totalGB * (1024 ** 3),
  freemem: () => freeGB * (1024 ** 3),
});

function offline(t) {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network forbidden'); });
}

test('vision-only tasks select a known vision-capable model', t => {
  offline(t);
  for (const strategy of ['cost', 'quality', 'fast', 'pinned']) {
    const selected = pickModel({
      config: { defaultBot: 'ox-grok' },
      strategy,
      task: { kind: 'code', complexity: 0.5, requires: { vision: true } },
      env: { XAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', OX_OLLAMA_AVAILABLE: '1' },
    });
    assert.ok(selected);
    assert.equal(MODEL_CATALOG[selected.model]?.vision, true);
  }
});

test('rejected scores cannot win when every vision candidate is gated out', t => {
  offline(t);
  const selected = pickModel({
    config: { defaultBot: 'ox-grok' },
    strategy: 'cost',
    task: { kind: 'title', complexity: 0.9, requires: { vision: true } },
    env: { XAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', OX_OLLAMA_AVAILABLE: '1' },
  });
  assert.equal(selected, null);
});

test('vision rejection also applies to unknown models and fallback bots', t => {
  offline(t);
  assert.equal(pickModel({
    config: { defaultBot: 'ox-ollama' },
    strategy: 'cost',
    task: { requires: { vision: true } },
    env: { OX_OLLAMA_AVAILABLE: '1' },
  }), null);
});

test('invalid explicit OX_BASE_URL is rejected even with keys or pinned fallback', t => {
  offline(t);
  for (const OX_BASE_URL of ['invalid', '', '   ', 'file:///tmp/model', 'ftp://localhost/model', 'http://']) {
    const env = { OX_BASE_URL, ANTHROPIC_API_KEY: 'test' };
    assert.equal(isReachable({ provider: 'anthropic' }, {}, env), false);
    assert.ok(listCandidates({}, env).every(c => !c.reachable && !c.verified && c.reachability === 'invalid'));
    for (const strategy of ['cost', 'pinned']) {
      assert.equal(pickModel({ config: { defaultBot: 'ox-claude' }, strategy, env }), null);
    }
  }
});

test('valid OX_BASE_URL remains custom and explicitly unverified without probing', t => {
  offline(t);
  for (const OX_BASE_URL of ['http://127.0.0.1:9999/v1', 'https://models.invalid/v1']) {
    const env = { OX_BASE_URL };
    assert.equal(isReachable({ provider: 'anthropic' }, {}, env), true);
    assert.ok(listCandidates({}, env).every(c => c.reachable && !c.verified && c.reachability === 'unverified'));
    for (const strategy of ['cost', 'pinned']) {
      const selected = pickModel({ config: { defaultBot: 'ox-claude' }, strategy, env });
      assert.ok(selected);
      assert.equal(selected.provider, 'custom');
      assert.equal(selected.baseUrl, OX_BASE_URL);
      assert.equal(selected.keyEnv, 'OX_API_KEY');
      assert.equal(selected.reachable, true);
      assert.equal(selected.verified, false);
      assert.equal(selected.reachability, 'unverified');
    }
  }
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test('4GB detected total RAM never recommends the 32GB-min model', t => {
  offline(t);
  t.mock.method(os, 'totalmem', memory(4).totalmem);
  t.mock.method(os, 'freemem', memory(4).freemem);
  assert.equal(LOCAL_MODELS.find(m => m.id === 'mixtral-8x22b').minRAM, 32);
  for (const taskType of ['general', 'deep-refactor', 'quick-edit']) {
    const selected = recommendLocalModel({ memoryGB: 128 }, taskType);
    assert.equal(selected.reason, 'insufficient-memory');
    assert.equal(selected.error, 'insufficient memory');
    assert.equal(selected.id, undefined);
    assert.equal(selected.availableMemoryGB, 3.2);
  }
});

test('free RAM and the safety margin constrain recommendations', t => {
  offline(t);
  assert.equal(recommendLocalModel({}, 'general', memory(64, 4)).reason, 'insufficient-memory');
  assert.equal(recommendLocalModel({}, 'general', memory(8)).reason, 'insufficient-memory');
  const selected = recommendLocalModel({}, 'general', memory(64, 16));
  assert.ok(LOCAL_MODELS.includes(selected));
  assert.ok(selected.minRAM <= 12.8);
  assert.equal(recommendLocalModel({}, 'deep-refactor', memory(64)).id, 'qwen2.5-coder-32b');
  assert.equal(recommendLocalModel({}, 'quick-edit', memory(64)).id, 'qwen2.5-coder-7b');
});

test('explicit hardware caps and invalid memory fail closed', t => {
  offline(t);
  for (const memoryGB of [0, 4, -1, NaN, 'invalid']) {
    assert.equal(recommendLocalModel({ memoryGB }, 'general', memory(64)).reason, 'insufficient-memory');
  }
  assert.equal(recommendLocalModel({}, 'general', memory(NaN)).reason, 'insufficient-memory');
});

test('list_models without a configured backend returns an honest empty list', async t => {
  offline(t);
  const previous = process.env.VIDEO_BACKEND;
  t.after(() => {
    if (previous === undefined) delete process.env.VIDEO_BACKEND;
    else process.env.VIDEO_BACKEND = previous;
  });
  delete process.env.VIDEO_BACKEND;
  const response = await createVideoMcpServer().call('list_models');
  assert.notEqual(response.isError, true);
  const result = JSON.parse(response.content);
  assert.deepEqual(result.models, []);
  assert.equal(result.total, 0);
  assert.equal(result.error, 'No video backend configured');
});

test('list_models honors backend filter and local-only restriction without discovery', async t => {
  offline(t);
  const previous = ENV.localOnly;
  t.after(() => { ENV.localOnly = previous; });
  ENV.localOnly = false;
  const server = createVideoMcpServer();
  const result = JSON.parse((await server.call('list_models', { backend: 'wan' })).content);
  assert.deepEqual(result.models, ['Wan2.1-T2V']);
  assert.equal(result.total, 1);
  assert.equal(result.verified, false);
  ENV.localOnly = true;
  assert.deepEqual(JSON.parse((await server.call('list_models', { backend: 'kling' })).content).models, []);
  assert.deepEqual(JSON.parse((await server.call('list_models', { backend: 'unknown' })).content).models, []);
});
