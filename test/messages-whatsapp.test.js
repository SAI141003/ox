import test from 'node:test';
import assert from 'node:assert/strict';
import { messages_send } from '../src/tools/messages.js';
import { whatsapp_health, whatsapp_send } from '../src/tools/whatsapp.js';

test('messages send is approval gated and passes target/body without interpolation', async () => {
  let asked = 0;
  const r = await messages_send({ to: '+1 604 555 0100', body: 'hello' }, { _osa: async (_lines, args) => { assert.deepEqual(args, ['+1 604 555 0100', 'hello']); return { ok: true, out: 'SENT' }; }, requestApproval: async () => { asked++; return true; } });
  assert.equal(asked, 1);
  assert.match(r.content, /Sent via Messages/);
});

test('messages send never sends without approval', async () => {
  let called = false;
  const r = await messages_send({ to: '+16045550100', body: 'nope' }, { _osa: async () => { called = true; return { ok: true, out: 'SENT' }; }, requestApproval: async () => false });
  assert.equal(called, false);
  assert.match(r.content, /declined/);
});

test('WhatsApp health is explicit when credentials are absent', async () => {
  assert.deepEqual(await whatsapp_health({ env: {} }), { configured: false, reachable: false, inboundReady: false, reason: 'Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.' });
});

test('WhatsApp send posts to the official Cloud API after approval', async () => {
  let request;
  const fetchImpl = async (url, init) => { request = { url, init }; return { ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) }; };
  const r = await whatsapp_send({ to: '+16045550100', body: 'hello' }, { env: { WHATSAPP_ACCESS_TOKEN: 'secret', WHATSAPP_PHONE_NUMBER_ID: '123' }, fetchImpl, requestApproval: async () => true });
  assert.match(r.content, /accepted/);
  assert.match(request.url, /123\/messages$/);
  assert.equal(JSON.parse(request.init.body).text.body, 'hello');
});
