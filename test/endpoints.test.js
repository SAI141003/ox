// Your own endpoints: saved as custom bots with their own key name, refused
// over plain http off your network, testable, and resolved to the right key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ep-home-'));
process.env.HOME = home;
process.env.OX_HOME = path.join(home, '.ox');

const { saveEndpoint, removeEndpoint, listEndpoints, testEndpoint, keyEnvFor } = await import('../src/endpoints.js');
const { readConfigDoc } = await import('../src/config.js');
const { resolveBot } = await import('../src/bots.js');

test.after(() => {
  process.env.HOME = realHome;
  delete process.env.OX_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

test('save, list, resolve with its own key, remove', () => {
  const env = {};
  const list = saveEndpoint({ name: 'my-vllm', baseUrl: 'http://127.0.0.1:8000/v1/', model: 'qwen3', key: 'sk-local-5678' }, env);
  assert.equal(list.length, 1);
  assert.equal(list[0].baseUrl, 'http://127.0.0.1:8000/v1');
  assert.deepEqual(list[0].key, { set: true, source: 'app', hint: '…5678' });
  assert.equal(keyEnvFor('my-vllm'), 'OX_EP_MY_VLLM_KEY');
  assert.equal(env.OX_EP_MY_VLLM_KEY, 'sk-local-5678');

  const bot = resolveBot('my-vllm', { bots: readConfigDoc().bots }, env);
  assert.equal(bot.keyEnv, 'OX_EP_MY_VLLM_KEY');
  assert.equal(bot.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(bot.model, 'qwen3');

  assert.deepEqual(removeEndpoint('my-vllm', env), []);
  assert.equal(env.OX_EP_MY_VLLM_KEY, undefined);
  assert.throws(() => removeEndpoint('my-vllm', env), /no endpoint/);
});

test('bad names, non-http schemes and plain http to the internet are refused', () => {
  assert.throws(() => saveEndpoint({ name: 'Bad Name', baseUrl: 'https://x.example/v1' }), /lowercase/);
  assert.throws(() => saveEndpoint({ name: 'ok', baseUrl: 'file:///etc' }), /http or https/);
  assert.throws(() => saveEndpoint({ name: 'ok', baseUrl: 'http://api.example.com/v1' }), /https/);
  assert.equal(saveEndpoint({ name: 'lan', baseUrl: 'http://192.168.1.20:1234/v1' }, {})[0].name, 'lan');
  removeEndpoint('lan', {});
});

test('a hand-written keyEnv that is not an endpoint key falls back to the provider key', () => {
  const bot = resolveBot('sneaky', { bots: { sneaky: { provider: 'custom', baseUrl: 'https://x.example/v1', model: 'm', keyEnv: 'ANTHROPIC_API_KEY' } } }, {});
  assert.equal(bot.keyEnv, 'OX_API_KEY');
});

test('with no key saved, a local endpoint runs keyless and a remote one still needs its key', () => {
  const bots = {
    lan: { provider: 'custom', baseUrl: 'http://192.168.1.20:8000/v1', model: 'm', keyEnv: 'OX_EP_LAN_KEY' },
    far: { provider: 'custom', baseUrl: 'https://gw.example.com/v1', model: 'm', keyEnv: 'OX_EP_FAR_KEY' },
  };
  assert.equal(resolveBot('lan', { bots }, {}).keyEnv, null);
  assert.equal(resolveBot('lan', { bots }, { OX_EP_LAN_KEY: 'k' }).keyEnv, 'OX_EP_LAN_KEY');
  assert.equal(resolveBot('far', { bots }, {}).keyEnv, 'OX_EP_FAR_KEY');
});

test('testEndpoint lists models, reports latency and a refused key', async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'llama-3' }, { id: 'qwen3' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const ok = await testEndpoint({ baseUrl: base, key: 'good' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, ['llama-3', 'qwen3']);
  assert.equal(typeof ok.ms, 'number');
  const bad = await testEndpoint({ baseUrl: base, key: 'wrong' });
  assert.match(bad.error, /refused the key/);
  const gone = await testEndpoint({ baseUrl: 'http://127.0.0.1:1/v1' });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /could not reach/);
});
