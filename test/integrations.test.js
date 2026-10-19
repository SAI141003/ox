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

test('cal.com: the next upcoming booking, read with your key', async () => {
  const { calNext } = await import('../src/integrations.js');
  let seen;
  const now = Date.parse('2026-10-19T12:00:00Z');
  const fetchImpl = async (url, init) => { seen = { url, init }; return reply(200, { data: [
    { title: 'Design review', start: '2026-10-19T15:00:00Z', attendees: [{ name: 'Léa' }] },
    { title: 'Old', start: '2026-10-18T15:00:00Z' },
    { title: 'Intro call', start: '2026-10-19T13:30:00Z', attendees: [{ name: 'Arnaud' }] },
  ] })(); };
  const r = await calNext('cal_live_x', { fetchImpl, now });
  assert.deepEqual([r.title, r.with, r.count], ['Intro call', 'Arnaud', 2]);
  assert.match(seen.url, /\/v2\/bookings\?status=upcoming/);
  assert.equal(seen.init.method, undefined, 'a plain GET');
  assert.equal(await calNext('', { fetchImpl }), null);
});

test('n8n: workflows that failed today, from your own instance', async () => {
  const { n8nFailures } = await import('../src/integrations.js');
  const now = new Date(2026, 9, 19, 15);
  const fetchImpl = async (url, init) => { assert.match(url, /^https:\/\/n8n\.me\.dev\/api\/v1\/executions\?status=error/); assert.equal(init.headers['X-N8N-API-KEY'], 'k'); return reply(200, { data: [
    { startedAt: new Date(2026, 9, 19, 9).toISOString(), workflowData: { name: 'Invoices' } },
    { startedAt: new Date(2026, 9, 19, 11).toISOString(), workflowData: { name: 'Invoices' } },
    { startedAt: new Date(2026, 9, 18, 11).toISOString(), workflowData: { name: 'Old' } },
  ] })(); };
  const r = await n8nFailures('k', 'https://n8n.me.dev/', { fetchImpl, now });
  assert.deepEqual([r.failed, r.workflows], [2, ['Invoices']]);
  assert.equal(await n8nFailures('k', '', { fetchImpl }), null, 'no URL, no call');
});

test('pills: each service only with its own key; a refused one is left out', async () => {
  const { servicePills } = await import('../src/integrations.js');
  const fetchImpl = async (url) => (url.includes('cal.com') ? reply(401, {})() : reply(200, { deployments: [{ name: 'a', state: 'READY' }] })());
  const p = await servicePills({ VERCEL_TOKEN: 't', CALCOM_API_KEY: 'bad' }, { fetchImpl });
  assert.equal(p.vercel.state, 'READY');
  assert.equal(p.cal, undefined);
  assert.equal(p.n8n, undefined);
});
