// PersonaPlex as ox's full-duplex voice: the server link and voice are kept,
// the persona is written from what ox knows (or yours, word for word), and a
// server counts as up only when it sends its handshake byte after loading it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as P from '../src/personaplex.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pp-'));
const env = { OX_HOME: home };
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('the server link and voice are saved; a bad link or voice is refused', () => {
  assert.equal(P.readConfig({ env }).url, null);
  const c = P.saveConfig({ url: 'https://gpu-box:8998/', voice: 'NATM1.pt' }, { env });
  assert.equal(c.url, 'https://gpu-box:8998');
  assert.equal(c.voice, 'NATM1.pt');
  assert.throws(() => P.saveConfig({ url: 'gpu-box' }, { env }), /starts with https/);
  assert.throws(() => P.saveConfig({ voice: 'ROBOT.pt' }, { env }), /unknown voice/);
  assert.equal(P.VOICES.length, 18);
});

test('the persona: from memory, a few lines; yours word for word when you set one', async () => {
  const p = await P.personaPrompt({ memory: '## What you know about the user\n- Lives in Vancouver\n- Prefers short answers' });
  assert.match(p, /^You are ox/);
  assert.match(p, /Lives in Vancouver; Prefers short answers/);
  assert.equal(await P.personaPrompt({ custom: 'You are Mira, a pirate.' }), 'You are Mira, a pirate.');
  const url = P.chatUrl({ url: 'https://gpu-box:8998', voice: 'NATF2.pt' }, 'hi there');
  assert.match(url, /text_prompt=hi\+there/);
  assert.match(url, /voice_prompt=NATF2\.pt/);
});

/** A WebSocket stand-in that behaves like PersonaPlex's /api/chat. */
const fakeWs = (behaviour) => class {
  constructor(url) { this.url = url; setTimeout(() => behaviour(this), 5); }
  close() {}
};

test('a server is up only when its handshake arrives (after it loaded the persona)', async () => {
  const cfg = { url: 'https://gpu-box:8998', voice: 'NATF2.pt' };
  let seen = null;
  const ok = await P.probe(cfg, { prompt: 'be kind', WebSocketImpl: fakeWs((ws) => { seen = ws.url; ws.onmessage({ data: new Uint8Array([0]).buffer }); }) });
  assert.equal(ok.ok, true);
  assert.match(seen, /^wss:\/\/gpu-box:8998\/api\/chat\?text_prompt=be\+kind&voice_prompt=NATF2\.pt$/);
  const closed = await P.probe(cfg, { WebSocketImpl: fakeWs((ws) => ws.onclose()) });
  assert.equal(closed.ok, false);
  const silent = await P.probe(cfg, { timeoutMs: 50, WebSocketImpl: fakeWs(() => {}) });
  assert.match(silent.error, /no handshake/);
  assert.match((await P.probe({ url: null })).error, /ox personaplex url/);
});
