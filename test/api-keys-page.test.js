import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-keys-home-'));
process.env.HOME = home;
process.env.OX_HOME = path.join(home, '.ox');
const { providersView, testProviderKey, PROVIDER_CATALOG } = await import('../src/app-api.js');
const { KEY_ENV, resolveBot } = await import('../src/bots.js');
const { PROVIDERS } = await import('../src/providers/index.js');

test('every provider ox can run with a key is on the page, grouped, with where to get a key', () => {
  const view = providersView({});
  const ids = view.map((k) => k.id);
  for (const p of Object.keys(KEY_ENV).filter((p) => KEY_ENV[p])) assert.ok(ids.includes(p), `${p} missing from the page`);
  for (const p of ['perplexity', 'huggingface', 'nvidia', 'github', 'dashscope', 'tavily', 'brave', 'serper', 'fal']) assert.ok(ids.includes(p), p);
  assert.deepEqual([...new Set(view.map((k) => k.group))], ['models', 'search', 'media'], 'models first, then search, then media');
  for (const k of view.filter((k) => k.id !== 'custom')) assert.match(String(k.url), /^https:\/\//, `${k.id} has a key page`);
});

test('a new model provider is runnable, not just stored: it resolves and has an endpoint', () => {
  for (const p of ['perplexity', 'cohere', 'huggingface', 'nvidia', 'dashscope', 'deepinfra', 'sambanova', 'nebius', 'novita', 'github', 'venice', 'chutes']) {
    assert.ok(PROVIDERS[p]?.baseUrl?.startsWith('https://'), `${p} endpoint`);
    assert.equal(resolveBot(`${p}:some-model`).provider, p);
    assert.ok(PROVIDER_CATALOG[p], `${p} on the page`);
  }
});

test('NVIDIA NIM is described as prototype access, not an unconditional free tier', () => {
  const nvidia = providersView({}).find((p) => p.id === 'nvidia');
  assert.equal(nvidia.free, false);
  assert.match(nvidia.blurb, /free for prototyping/i);
  assert.match(nvidia.blurb, /Enterprise license for production/i);
});

test('search keys are the names the web_search tool reads', () => {
  const web = fs.readFileSync(new URL('../src/tools/web.js', import.meta.url), 'utf8');
  for (const k of providersView({}).filter((x) => x.group === 'search')) assert.ok(web.includes(k.env), `${k.env} is read by web.js`);
});

test('Test validates credentials, not just a public model catalog', async () => {
  const calls = [];
  const fake = async (url, opts) => { calls.push([url, opts.headers]); return url.endsWith('/key') ? { ok: true, status: 200, json: async () => ({ data: { label: 'secret-label', usage: 99, limit: 100 } }) } : url.includes('bad') ? { ok: false, status: 401 } : { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }) }; };
  const ok = await testProviderKey('openrouter', 'sk-or-v1-x', {}, { fetchImpl: fake });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, ['m1', 'm2']);
  assert.equal(ok.count, 2);
  assert.equal(calls[0][0], 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0][1].authorization, 'Bearer sk-or-v1-x');
  assert.equal(calls[1][0], 'https://openrouter.ai/api/v1/models');
  assert.doesNotMatch(JSON.stringify(ok), /secret-label|usage|limit|99|100/, 'key metadata is never returned');
  const anth = await testProviderKey('anthropic', 'k', {}, { fetchImpl: fake });
  assert.equal(anth.ok, true);
  assert.equal(calls[2][1]['x-api-key'], 'k', 'Anthropic uses its own header');
  let publicCatalogRequested = false;
  const refused = await testProviderKey('openrouter', 'k', {}, { fetchImpl: async (url) => {
    if (url.endsWith('/models')) publicCatalogRequested = true;
    return url.endsWith('/key') ? { ok: false, status: 401 } : { ok: true, status: 200, json: async () => ({ data: [{ id: 'public-model' }] }) };
  } });
  assert.match(refused.error, /refused this key/);
  assert.equal(publicCatalogRequested, false, 'a public model list cannot make a bad key look valid');
  assert.match((await testProviderKey('perplexity', null, {})).error, /no key/);
  assert.equal((await testProviderKey('tavily', 'x', {})).ok, false, 'search keys are not tested by spending a query');
});

test('Use saves the model as a named model and makes it the default', async () => {
  const { useProviderModel } = await import('../src/app-api.js');
  const r = await useProviderModel('openrouter', 'poolside/laguna-s-2.1:free');
  assert.equal(r.name, 'openrouter-laguna-s-2.1-free');
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.equal(doc.defaultBot, r.name);
  assert.deepEqual(doc.bots[r.name], { provider: 'openrouter', model: 'poolside/laguna-s-2.1:free', desc: 'OpenRouter · poolside/laguna-s-2.1:free' });
  await assert.rejects(useProviderModel('tavily', 'x'), /not a model provider/);
  await assert.rejects(useProviderModel('openrouter', 'has space'), /choose a model/);
});

test('the page: rows hide when filtered (CSS cannot override it), and search reaches providers', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /\.keyrow\[hidden\], \.kgroup\[hidden\] \{ display: none; \}/);
  assert.match(html, /data-prov=/, 'Settings search lists providers');
  assert.match(html, /Not listed\? Any OpenAI-compatible service works/);
});
