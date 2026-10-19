import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vercelLatest, servicePills } from '../src/integrations.js';

const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test('vercel: no token, no call; a refused token is said plainly', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return reply(200, {})(); };
  assert.equal(await vercelLatest(undefined, { fetchImpl }), null);
  assert.equal(called, false);
  assert.match((await vercelLatest('bad', { fetchImpl: reply(403, {}) })).error, /refused/);
});

test('vercel: the newest deployment and how many failed', async () => {
  const r = await vercelLatest('t', { fetchImpl: reply(200, { deployments: [
    { name: 'shop', state: 'READY', url: 'shop-1.vercel.app', created: 3 },
    { name: 'shop', state: 'ERROR', url: 'shop-0.vercel.app', created: 2 },
  ] }) });
  assert.equal(r.state, 'READY');
  assert.equal(r.url, 'https://shop-1.vercel.app');
  assert.equal(r.failing, 1);
});

test('pills: only what has a token', async () => {
  const fetchImpl = reply(200, { deployments: [{ name: 'a', state: 'BUILDING' }] });
  assert.equal((await servicePills({ VERCEL_TOKEN: 't' }, { fetchImpl })).vercel.state, 'BUILDING');
  assert.deepEqual(await servicePills({}, { fetchImpl }), {});
});
