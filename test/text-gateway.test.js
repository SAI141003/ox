// iMessage, Signal and WhatsApp as ox channels: pairing, numbered approvals, and nothing older
// than the start or from anyone else ever runs. Fake commands stand in for the real apps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-text-'));
process.env.OX_HOME = home;
const G = await import('../src/text-gateway.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a text channel pairs, then runs only its owner, and a numbered reply answers the approval', async () => {
  const sent = [], asked = [];
  const source = { name: 'signal', send: async (chat, text) => { sent.push([chat, text]); } };
  const state = { owner: '+1555' };
  const fakeCore = (opts) => ({ onMessage: async (c, t) => asked.push(['msg', c, t]), onButton: async (c, d) => asked.push(['btn', c, d]), stop() {}, adapter: opts.adapter });
  const ch = G.createTextChannel(source, { state, persist() {}, makeCore: fakeCore, cwd: home });
  await ch.core.adapter.send('+1555', 'ox wants to run bash', [{ label: 'Allow', data: 'ap:r:a:allow' }, { label: 'Deny', data: 'ap:r:a:deny' }]);
  assert.match(sent[0][1], /Reply 1 to allow, 2 to deny\./);
  await ch.handle({ chat: '+1999', text: '1' });
  assert.deepEqual(asked.at(-1), ['msg', '+1999', '1'], 'a stranger\'s 1 answers nothing');
  await ch.handle({ chat: '+1555', text: '2' });
  assert.deepEqual(asked.at(-1), ['btn', '+1555', 'ap:r:a:deny']);
  await ch.handle({ chat: '+1555', text: '2' });
  assert.deepEqual(asked.at(-1), ['msg', '+1555', '2'], 'answered once');
  await ch.handle({ chat: '+1555', text: 'Status' });
  assert.deepEqual(asked.at(-1), ['msg', '+1555', '/status']);
  await ch.core.adapter.edit('+1555', 1, '⏳ bash ls');
  assert.equal(sent.length, 1, 'progress does not spam a phone');
  await ch.core.adapter.edit('+1555', 1, '✗ stopped');
  assert.equal(sent.at(-1)[1], '✗ stopped');
});

test('the real pairing core: a stranger gets nothing, the right code pairs', async () => {
  const sent = [];
  const state = {};
  const ch = G.createTextChannel({ name: 'imessage', send: async (c, t) => { sent.push([c, t]); } }, { state, persist() {}, cwd: home, log() {} });
  await ch.handle({ chat: 'a@x', text: 'rm everything' });
  assert.equal(state.owner, undefined);
  await ch.handle({ chat: 'a@x', text: 'pair 000000' });
  assert.equal(state.owner, undefined);
  await ch.handle({ chat: 'me@x', text: `Pair ${state.pairCode}` });
  assert.equal(state.owner, 'me@x');
  ch.core.stop();
});

test('iMessage: reads a real sqlite file from now on, words from text or attributedBody', async (t) => {
  if (spawnSync('sqlite3', ['--version']).status !== 0) { t.skip('no sqlite3'); return; }
  const db = path.join(home, 'chat.db');
  const body = Buffer.concat([Buffer.from('xxNSString'), Buffer.from([1, 148, 132, 1, 43]), Buffer.from([5]), Buffer.from('hello'), Buffer.from('tail')]);
  const sql = (s) => spawnSync('sqlite3', [db, s]);
  sql(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT); CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INT, text TEXT, attributedBody BLOB, is_from_me INT);
       INSERT INTO handle VALUES (1, 'me@x'); INSERT INTO message VALUES (1, 1, 'old message', NULL, 0);`);
  const state = {};
  const s = G.imessageSource({ db, state });
  await s.check();
  assert.deepEqual(await s.receive(), [], 'nothing from before the start');
  sql(`INSERT INTO message VALUES (2, 1, 'new one', NULL, 0); INSERT INTO message VALUES (3, 1, 'mine', NULL, 1); INSERT INTO message VALUES (4, 1, NULL, X'${body.toString('hex')}', 0);`);
  assert.deepEqual(await s.receive(), [{ chat: 'me@x', text: 'new one' }, { chat: 'me@x', text: 'hello' }]);
  assert.deepEqual(await s.receive(), [], 'each message once');
  await assert.rejects(G.imessageSource({ db: path.join(home, 'nope', 'x.db'), state: {} }).check(), /Full Disk Access/);
});

test('Signal: direct messages only, and a bad number or missing program says what to do', async () => {
  assert.throws(() => G.signalSource({ number: '555' }), /country code/);
  const calls = [];
  const runner = async (bin, args) => { calls.push(args); return args.includes('receive') ? { ok: true, stdout: `${JSON.stringify({ envelope: { sourceNumber: '+1555', dataMessage: { message: 'hi' } } })}\n${JSON.stringify({ envelope: { sourceNumber: '+1999', dataMessage: { message: 'from a group', groupInfo: { groupId: 'g' } } } })}\nnot json\n` } : { ok: true, stdout: '' }; };
  const s = G.signalSource({ number: '+14155550100', runner });
  assert.deepEqual(await s.receive(), [{ chat: '+1555', text: 'hi' }]);
  await s.send('+1555', 'done');
  assert.deepEqual(calls.at(-1), ['-u', '+14155550100', 'send', '-m', 'done', '+1555']);
  await assert.rejects(G.signalSource({ number: '+14155550100', runner: async () => ({ ok: false, stderr: '' }) }).check(), /signal-cli is not installed/);
});

test('WhatsApp: only messages after the start, once each; missing keys say which', async () => {
  const { whatsappInboxFile } = await import('../src/tools/whatsapp.js');
  const h = path.join(home, 'wa');
  const file = whatsappInboxFile(h);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([{ id: 'old', from: '1', type: 'text', text: 'old' }]));
  const env = { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p', WHATSAPP_APP_SECRET: 's' };
  const posted = [];
  const state = {};
  const s = G.whatsappSource({ env, state, home: h, fetchImpl: async (u, o) => { posted.push([u, JSON.parse(o.body)]); return { ok: true }; } });
  await s.check();
  assert.deepEqual(await s.receive(), []);
  fs.writeFileSync(file, JSON.stringify([{ id: 'n2', from: '1', type: 'image', text: '[image]' }, { id: 'n1', from: '1', type: 'text', text: 'new' }, { id: 'old', from: '1', type: 'text', text: 'old' }]));
  assert.deepEqual(await s.receive(), [{ chat: '1', text: 'new' }]);
  assert.deepEqual(await s.receive(), []);
  await s.send('1', 'hey');
  assert.equal(posted[0][1].text.body, 'hey');
  await assert.rejects(G.whatsappSource({ env: {}, state: {}, home: h }).check(), /WHATSAPP_ACCESS_TOKEN/);
});
