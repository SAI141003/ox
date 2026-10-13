// ox from your phone, end to end against a stand-in Telegram Bot API and a
// stand-in model: pairing, strangers ignored, a run started by a message, its
// approval answered with a button, and the answer sent back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runTelegramGateway, telegramApi, splitMessage, cleanAnswer } from '../src/telegram-gateway.js';

test('long answers are split on line breaks; ox progress lines are dropped', () => {
  const parts = splitMessage(`${'a'.repeat(3000)}\n${'b'.repeat(3000)}`, 4000);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.equal(cleanAnswer('· tool offer narrowed\n● write_file: x\n✓ 2ms\nThe answer.'), 'The answer.');
});

// ---- the model: asks to write a file, then reports ----
const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((j.messages ?? []).some((m) => m.role === 'tool')) {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'Wrote hello.txt for you.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } else {
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'from the phone' }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    }
  });
});

// ---- Telegram: a queue of updates in, a log of what the bot sent out ----
const updates = [];
const sent = [];
let nextUpdate = 1;
let nextMsg = 100;
const tgWaiters = [];
const tg = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    const method = req.url.split('/').pop();
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (!req.url.startsWith('/botTEST-TOKEN/')) { res.writeHead(401); res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); return; }
    if (method === 'getMe') return reply({ id: 1, username: 'my_ox_bot' });
    if (method === 'getUpdates') {
      let answered = false;
      const give = () => { if (answered) return; answered = true; reply(updates.filter((u) => u.update_id >= (body.offset ?? 0))); };
      if (updates.some((u) => u.update_id >= (body.offset ?? 0))) return give();
      const t = setTimeout(give, 150);
      tgWaiters.push(() => { clearTimeout(t); give(); });
      return;
    }
    sent.push({ method, ...body });
    if (method === 'sendMessage') return reply({ message_id: nextMsg++, chat: { id: body.chat_id }, text: body.text });
    return reply(true);
  });
});
const push = (u) => { updates.push({ update_id: nextUpdate++, ...u }); tgWaiters.splice(0).forEach((w) => w()); };
const msg = (chat, text) => push({ message: { message_id: nextMsg++, chat: { id: chat }, text } });
async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}\nsent: ${JSON.stringify(sent, null, 1).slice(0, 3000)}`);
}

await new Promise((r) => model.listen(0, '127.0.0.1', r));
await new Promise((r) => tg.listen(0, '127.0.0.1', r));
after(() => { model.close(); tg.close(); });

test('pair, ignore strangers, run from a message, approve with a button, get the answer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-tg-home-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-tg-proj-')));
  const stateFile = path.join(home, '.ox', 'gateway', 'telegram.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x', OX_MODEL: 'm' });
  const logs = [];
  const ac = new AbortController();
  const api = telegramApi('TEST-TOKEN', { base: `http://127.0.0.1:${tg.address().port}` });
  const gw = runTelegramGateway({ token: 'TEST-TOKEN', cwd, stateFile, env, log: (s) => logs.push(s), signal: ac.signal, pollTimeoutSec: 1, api });

  const code = (await until(() => logs.find((l) => /\/pair \d{6}/.test(l)), 'a pairing code')).match(/\/pair (\d{6})/)[1];
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).token, 'TEST-TOKEN');
  assert.equal(fs.statSync(stateFile).mode & 0o077, 0, 'the token file is private');

  msg(555, 'delete everything');
  await until(() => sent.find((s) => s.chat_id === 555 && /not paired/.test(s.text)), 'the not-paired reply');
  msg(555, '/pair 000000');
  msg(777, `/pair ${code}`);
  await until(() => sent.find((s) => s.chat_id === 777 && /^Paired/.test(s.text)), 'pairing');

  const before = sent.length;
  msg(555, `/pair ${code}`);
  msg(555, 'write hello.txt');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!sent.slice(before).some((s) => s.chat_id === 555), 'a stranger gets nothing once paired');

  msg(777, 'write hello.txt');
  await until(() => sent.find((s) => s.chat_id === 777 && s.text === '⏳ working…'), 'the status message');
  const ask = await until(() => sent.find((s) => s.chat_id === 777 && /ox wants to run write_file/.test(s.text ?? '')), 'the approval buttons');
  const allow = ask.reply_markup.inline_keyboard[0].find((b) => b.text === 'Allow');
  assert.ok(!fs.existsSync(path.join(cwd, 'hello.txt')), 'nothing is written before the tap');
  push({ callback_query: { id: 'cb1', data: allow.callback_data, message: { message_id: 999, chat: { id: 777 }, text: ask.text } } });

  await until(() => sent.find((s) => s.chat_id === 777 && /Wrote hello\.txt for you\./.test(s.text ?? '')), 'the answer');
  assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'from the phone');
  assert.ok(sent.find((s) => s.method === 'answerCallbackQuery' && s.text === 'Allowed'));
  assert.ok(sent.find((s) => s.method === 'editMessageText' && /^✓ done in \d+s$/.test(s.text)));

  ac.abort();
  await gw;
});
