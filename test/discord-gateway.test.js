// ox from Discord, end to end against a stand-in Discord (REST + a minimal
// WebSocket gateway written here) and a stand-in model: pairing in a DM,
// strangers and server channels ignored, a run, its approval as a button.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runDiscordGateway, discordRest } from '../src/discord-gateway.js';

const skip = typeof globalThis.WebSocket !== 'function' ? 'needs Node 22+ (built-in WebSocket)' : false;

// ---- the model: asks to write a file, then reports ----
const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((j.messages ?? []).some((m) => m.role === 'tool')) res.end(sse({ choices: [{ index: 0, delta: { content: 'Wrote dc.txt.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    else res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'dc.txt', content: 'from discord' }) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
  });
});

// ---- Discord: REST log + a WebSocket gateway ----
const sent = [];
let nextId = 1;
let gw = null; // the connected gateway socket
const frame = (obj) => {
  const data = Buffer.from(JSON.stringify(obj));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
};
const dispatch = (t, d) => gw.write(frame({ op: 0, t, s: nextId++, d }));
let identify = null;
const discord = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    sent.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.method === 'POST' && /\/messages$/.test(req.url) ? { id: `m${nextId++}` } : {}));
  });
});
discord.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  gw = socket;
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
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.op === 2) { identify = msg.d; dispatch('READY', { user: { username: 'oxbot' } }); }
    }
  });
  socket.on('error', () => {});
  socket.write(frame({ op: 10, d: { heartbeat_interval: 45000 } }));
});

await new Promise((r) => model.listen(0, '127.0.0.1', r));
await new Promise((r) => discord.listen(0, '127.0.0.1', r));
after(() => { model.close(); discord.close(); gw?.destroy(); });

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}\n${JSON.stringify(sent, null, 1).slice(0, 2500)}`);
}
const posted = (channel, re) => sent.find((s) => s.method === 'POST' && s.url === `/channels/${channel}/messages` && re.test(s.body?.content ?? ''));

test('pair in a DM, ignore others, run from a message, approve with a button', { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dc-home-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dc-proj-')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_NO_AWAKE: '1', OX_LEARN: '0', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x', OX_MODEL: 'm' });
  const logs = [];
  const ac = new AbortController();
  const base = `http://127.0.0.1:${discord.address().port}`;
  const done = runDiscordGateway({
    token: 'BOT-TOKEN', cwd, env, signal: ac.signal, log: (s) => logs.push(s),
    stateFile: path.join(home, '.ox', 'gateway', 'discord.json'),
    rest: discordRest('BOT-TOKEN', { base }),
    gatewayUrl: `ws://127.0.0.1:${discord.address().port}/gw`,
    socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dc-sock-')),
  });

  const code = (await until(() => logs.find((l) => /\/pair \d{6}/.test(l)), 'the pairing code')).match(/\/pair (\d{6})/)[1];
  assert.equal(identify.intents, 1 << 12, 'direct messages only: no privileged intent needed');
  assert.equal(identify.token, 'BOT-TOKEN');

  dispatch('MESSAGE_CREATE', { channel_id: 'C1', content: 'hello', author: { id: 'u1' } });
  await until(() => posted('C1', /not paired/), 'the not-paired reply');
  dispatch('MESSAGE_CREATE', { channel_id: 'C2', content: `/pair ${code}`, author: { id: 'u2' } });
  await until(() => posted('C2', /^Paired/), 'pairing');
  assert.equal(sent.find((s) => s.url === '/channels/C2/messages').auth, 'Bot BOT-TOKEN');

  const before = sent.length;
  dispatch('MESSAGE_CREATE', { channel_id: 'C1', content: 'write it', author: { id: 'u1' } });
  dispatch('MESSAGE_CREATE', { channel_id: 'G1', guild_id: 'g', content: 'write it', author: { id: 'u2' } });
  dispatch('MESSAGE_CREATE', { channel_id: 'C2', content: 'ignored, a bot', author: { id: 'b', bot: true } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, before, 'a stranger, a server channel and a bot get nothing');

  dispatch('MESSAGE_CREATE', { channel_id: 'C2', content: 'write dc.txt', author: { id: 'u2' } });
  const ask = await until(() => posted('C2', /ox wants to run write_file/), 'the approval buttons');
  const allow = ask.body.components[0].components.find((b) => b.label === 'Allow');
  assert.equal(allow.style, 3);
  assert.equal(ask.body.components[0].components.find((b) => b.label === 'Deny').style, 4);
  assert.ok(!fs.existsSync(path.join(cwd, 'dc.txt')));
  dispatch('INTERACTION_CREATE', { type: 3, id: 'i1', token: 'tk', channel_id: 'C2', data: { custom_id: allow.custom_id }, message: { content: ask.body.content } });

  await until(() => posted('C2', /Wrote dc\.txt\./), 'the answer');
  assert.equal(fs.readFileSync(path.join(cwd, 'dc.txt'), 'utf8'), 'from discord');
  const cb = sent.find((s) => s.url === '/interactions/i1/tk/callback');
  assert.equal(cb.body.type, 7);
  assert.match(cb.body.data.content, /→ allowed$/);
  assert.ok(sent.find((s) => s.method === 'PATCH' && /^✓ done in \d+s$/.test(s.body?.content ?? '')));
  ac.abort();
  gw.destroy();
  await done;
});
