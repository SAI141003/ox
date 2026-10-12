// OX Buddy (ask about your screen, by voice or /screen), image input on every
// provider, the island's user-message frame, and the island on/off switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { buildAnthropicBody } from '../src/providers/anthropic.js';
import { buildGeminiBody } from '../src/providers/gemini.js';
import { toWireMessages } from '../src/providers/openai-compat.js';
import { loadImage } from '../src/providers/images.js';
import { buddyTurn, parsePoint, pngSize } from '../src/buddy.js';
import { createIpcServer } from '../src/ipc.js';
import { islandEnabled, islandRunning, setIslandEnabled, cmdIsland } from '../src/island.js';

// A real 3x2 PNG, so size parsing reads an actual IHDR.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000300000002080600000040c4a8d30000001049444154789c63f8cfc0f01f0c18fe030004ff01ff5c3f8b1d0000000049454e44ae426082',
  'hex'
);
const tmpPng = () => {
  const f = path.join(os.tmpdir(), `ox-buddy-test-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
  fs.writeFileSync(f, PNG);
  return f;
};
const img = { mediaType: 'image/png', data: PNG.toString('base64') };
const convo = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'first look', images: [img] },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'and now?', images: [img] },
];

test('anthropic: only the newest screenshot is sent; older ones become a note', () => {
  const body = buildAnthropicBody({ model: 'm', messages: convo, tools: [], maxTokens: 10 });
  const [first, , last] = body.messages;
  assert.deepEqual(first.content.map((b) => b.type), ['text']);
  assert.match(first.content[0].text, /^\[1 earlier screenshot\(s\) omitted\]\nfirst look$/);
  assert.deepEqual(last.content.map((b) => b.type), ['image', 'text']);
  assert.equal(last.content[0].source.media_type, 'image/png');
});

test('gemini and openai-compatible (Ollama/LM Studio/vLLM) carry the image too', () => {
  const g = buildGeminiBody({ messages: convo, tools: [], maxTokens: 10 });
  assert.ok(g.contents.at(-1).parts[0].inlineData, 'gemini inlineData');
  const w = toWireMessages(convo);
  const last = w.at(-1);
  assert.equal(last.content[1].type, 'image_url');
  assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(typeof w[1].content, 'string', 'older image message is plain text again');
});

test('loadImage refuses non-images with a usable message', () => {
  const f = path.join(os.tmpdir(), `ox-not-image-${process.pid}.txt`);
  fs.writeFileSync(f, 'x');
  assert.throws(() => loadImage(f), /not an image ox can send/);
  assert.equal(loadImage(tmpPng()).mediaType, 'image/png');
});

test('buddy: screenshot size, spoken-reply guidance, and [POINT] parsing', () => {
  assert.deepEqual(pngSize(PNG), { width: 3, height: 2 });
  const t = buddyTurn('where is save?', { imagePaths: [tmpPng()], voice: true });
  assert.equal(t.images.length, 1);
  assert.match(t.guidance, /3x2 px/);
  assert.match(t.guidance, /spoken aloud/);
  assert.deepEqual(parsePoint('Click Save, top right. [POINT:1180,42:Save button]'), {
    say: 'Click Save, top right.',
    point: { x: 1180, y: 42, label: 'Save button' },
  });
  assert.deepEqual(parsePoint('No pointing here.'), { say: 'No pointing here.', point: null });
});

async function ipcPair(t) {
  const sock = path.join(os.tmpdir(), `ox-buddy-${process.pid}-${Date.now()}.sock`);
  const server = createIpcServer({ socketPath: sock, sessionId: 's', meta: {} });
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const client = net.createConnection(sock);
  await new Promise((r) => client.once('connect', r));
  t.after(() => client.destroy());
  return { server, send: (o) => client.write(`${JSON.stringify(o)}\n`) };
}

test('ipc user-message: text and temp-dir screenshots reach the run; other paths do not', async (t) => {
  const { server, send } = await ipcPair(t);
  const shot = tmpPng();
  const got = new Promise((r) => server.once('user-message', r));
  send({ type: 'user-message', text: 'what is this?', imagePaths: [shot, '/etc/passwd', path.join(os.homedir(), 'secret.png')], voice: true });
  const m = await got;
  assert.equal(m.text, 'what is this?');
  assert.equal(m.voice, true);
  assert.deepEqual(m.imagePaths, [fs.realpathSync.native ? path.resolve(shot) : shot]);
});

test('island off/on persists and a disabled island is never bound', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-island-home-'));
  fs.mkdirSync(path.join(home, '.ox'));
  fs.writeFileSync(path.join(home, '.ox', 'island.json'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(home, '.ox', 'config.json'), JSON.stringify({ keep: 'me' }));
  assert.equal(islandEnabled({ home }), true);
  assert.equal(islandRunning({ home, env: {} }), true, 'live pid counts as running');
  setIslandEnabled(false, { home });
  assert.equal(islandEnabled({ home }), false);
  assert.equal(islandRunning({ home, env: {} }), false, 'off means runs never bind to it');
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.deepEqual(doc, { keep: 'me', island: false }, 'other settings kept');
  setIslandEnabled(true, { home });
  assert.equal(islandRunning({ home, env: {} }), true);
  const out = [];
  assert.equal(await cmdIsland(['nope'], { log: (s) => out.push(s), err: (s) => out.push(s) }), 3);
  assert.match(out.join(''), /start, stop, on, off, status, build/);
});
