// ox from Slack, end to end against a stand-in Slack (Web API + a Socket Mode
// WebSocket written here) and a stand-in model: pairing in a DM, strangers,
// channels and bots ignored, a run, its approval as a button.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runSlackGateway, slackApi, slashless } from '../src/slack-gateway.js';

const skip = typeof globalThis.WebSocket !== 'function' ? 'needs Node 22+ (built-in WebSocket)' : false;

const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((j.messages ?? []).some((m) => m.role === 'tool')) res.end(sse({ choices: [{ index: 0, delta: { content: 'Wrote sl.txt.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    else res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'sl.txt', content: 'from slack' }) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
});

const sent = [];
const acks = [];
let ts = 1;
let ws = null;
const frame = (obj) => {
  const data = Buffer.from(JSON.stringify(obj));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
};
let envN = 0;
const push = (type, payload) => ws.write(frame({ type, envelope_id: `e${++envN}`, payload }));
const slack = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    sent.push({ url: req.url, body, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/apps.connections.open') return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${slack.address().port}/socket` }));
    res.end(JSON.stringify({ ok: true, ts: `${ts++}.000`, channel: body?.channel }));
  });
});
slack.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  ws = socket;
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { socket.end(); return; }
      try { acks.push(JSON.parse(payload.toString('utf8')).envelope_id); } catch {}
    }
  });
  socket.on('error', () => {});
  socket.write(frame({ type: 'hello' }));
});

await new Promise((r) => model.listen(0, '127.0.0.1', r));
await new Promise((r) => slack.listen(0, '127.0.0.1', r));
after(() => { model.close(); slack.close(); ws?.destroy(); });

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}\n${JSON.stringify(sent, null, 1).slice(0, 2500)}`);
}
const posted = (channel, re) => sent.find((s) => s.url === '/api/chat.postMessage' && s.body?.channel === channel && re.test(s.body?.text ?? ''));
const dm = (channel, text, extra = {}) => push('events_api', { event: { type: 'message', channel_type: 'im', channel, user: 'U1', text, ...extra } });

test('commands work without the slash Slack keeps for itself', () => {
  assert.equal(slashless('pair 123456'), '/pair 123456');
  assert.equal(slashless('status'), '/status');
  assert.equal(slashless('stop using tabs'), 'stop using tabs');
  assert.equal(slashless('/pair 123456'), '/pair 123456');
});

test('pair in a DM, ignore others, run from a message, approve with a button', { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sl-home-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sl-proj-')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_NO_AWAKE: '1', OX_LEARN: '0', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x', OX_MODEL: 'm' });
  const logs = [];
  const ac = new AbortController();
  const base = `http://127.0.0.1:${slack.address().port}/api`;
  const done = runSlackGateway({
    appToken: 'xapp-1', botToken: 'xoxb-1', cwd, env, signal: ac.signal, log: (s) => logs.push(s),
    stateFile: path.join(home, '.ox', 'gateway', 'slack.json'),
    app: slackApi('xapp-1', { base }), bot: slackApi('xoxb-1', { base }),
    socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sl-sock-')),
  });

  const code = (await until(() => logs.find((l) => /pair \d{6}/.test(l)), 'the pairing code')).match(/pair (\d{6})/)[1];
  assert.equal(sent.find((s) => s.url === '/api/apps.connections.open').auth, 'Bearer xapp-1');

  dm('D1', 'hello');
  const notPaired = await until(() => posted('D1', /not paired/), 'the not-paired reply');
  assert.doesNotMatch(notPaired.body.text, /\/pair/, 'Slack users are told to type pair without the slash');
  dm('D2', `pair ${code}`);
  await until(() => posted('D2', /^Paired/), 'pairing');
  assert.equal(sent.find((s) => s.url === '/api/chat.postMessage' && s.body.channel === 'D2').auth, 'Bearer xoxb-1');

  const before = sent.length;
  dm('D1', 'write it');
  push('events_api', { event: { type: 'message', channel_type: 'channel', channel: 'C9', user: 'U2', text: 'write it' } });
  dm('D2', 'from a bot', { bot_id: 'B1' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, before, 'a stranger, a channel and a bot get nothing');

  dm('D2', 'write sl.txt');
  const ask = await until(() => posted('D2', /ox wants to run write_file/), 'the approval buttons');
  const buttons = ask.body.blocks.find((b) => b.type === 'actions').elements;
  const allow = buttons.find((b) => b.text.text === 'Allow');
  assert.equal(allow.style, 'primary');
  assert.equal(buttons.find((b) => b.text.text === 'Deny').style, 'danger');
  assert.ok(!fs.existsSync(path.join(cwd, 'sl.txt')));
  push('interactive', { type: 'block_actions', actions: [{ value: allow.value, action_id: allow.action_id }], channel: { id: 'D2' }, message: { ts: '99.000', text: ask.body.text }, response_url: 'http://127.0.0.1:1/unused' });

  await until(() => posted('D2', /Wrote sl\.txt\./), 'the answer');
  assert.equal(fs.readFileSync(path.join(cwd, 'sl.txt'), 'utf8'), 'from slack');
  const upd = sent.find((s) => s.url === '/api/chat.update' && s.body.ts === '99.000');
  assert.match(upd.body.text, /→ allowed$/);
  assert.ok(sent.find((s) => s.url === '/api/chat.update' && /^✓ done in \d+s$/.test(s.body?.text ?? '')));
  assert.ok(acks.length >= 5, 'every envelope is acknowledged');
  ac.abort();
  ws.destroy();
  await done;
});
