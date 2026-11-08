// The app on a phone, through a key-checked door: nothing passes without the key.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pw-'));
const W = await import('../src/phone-web.js');
let app, web, base, key;
const seen = [];
before(async () => {
  app = http.createServer((q, r) => {
    let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
      seen.push({ method: q.method, url: q.url, host: q.headers.host, origin: q.headers.origin, cookie: q.headers.cookie, body: b });
      if (q.url === '/stream') { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write('data: one\n\n'); setTimeout(() => { r.write('data: two\n\n'); r.end(); }, 30); return; }
      r.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'app' }); r.end('hello from the app');
    });
  });
  await new Promise((res) => app.listen(0, '127.0.0.1', res));
  key = W.phoneKey({ env: { OX_HOME: home } });
  web = await W.startPhoneWeb({ key, target: { host: '127.0.0.1', port: app.address().port }, port: 0, host: '127.0.0.1', maxStrikes: 3 });
  base = `http://127.0.0.1:${web.port}`;
});
after(async () => { await web.close(); app.closeAllConnections?.(); app.close(); fs.rmSync(home, { recursive: true, force: true }); });
const cookie = () => `ox_phone=${key}`;

test('the key is long, kept private, and replaced on request', () => {
  assert.ok(key.length >= 40);
  assert.equal(W.phoneKey({ env: { OX_HOME: home } }), key);
  assert.equal(fs.statSync(path.join(home, 'phone-web.json')).mode & 0o077, 0);
});

test('with the key: the link sets a private cookie, and the app is reached with its own Host and no cookie', async () => {
  const r = await fetch(`${base}/pair?key=${key}`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  const ok = await fetch(`${base}/ox/x`, { headers: { cookie: cookie() } });
  assert.equal(await ok.text(), 'hello from the app');
  assert.equal(ok.headers.get('x-from'), 'app');
  const last = seen.at(-1);
  assert.equal(last.host, `127.0.0.1:${app.address().port}`);
  assert.equal(last.cookie, undefined);
  const post = await fetch(`${base}/ox/y`, { method: 'POST', headers: { cookie: cookie(), origin: base, 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.equal(post.status, 200);
  assert.equal(seen.at(-1).body, '{"a":1}');
  assert.equal(seen.at(-1).origin, undefined);
});

test('answers that stream arrive as they come', async () => {
  const r = await fetch(`${base}/stream`, { headers: { cookie: cookie() } });
  assert.equal(await r.text(), 'data: one\n\ndata: two\n\n');
});

test('without the key nothing reaches the app; another site is refused; wrong tries lock out', async () => {
  const n = seen.length;
  assert.equal((await fetch(`${base}/ox/x`, { headers: { cookie: `ox_phone=${key}x` } })).status, 401);
  assert.equal((await fetch(`${base}/ox/x`)).status, 401);
  assert.equal((await fetch(`${base}/ox/y`, { method: 'POST', headers: { cookie: cookie(), origin: 'https://evil.example' } })).status, 403);
  assert.equal(seen.length, n, 'the app saw none of that');
  assert.equal((await fetch(`${base}/pair?key=nope`)).status, 403, 'the third wrong try');
  assert.equal((await fetch(`${base}/ox/x`, { headers: { cookie: cookie() } })).status, 429);
});

test('finds the app only if it is alive; lists Wi-Fi before Tailscale', () => {
  const h = path.join(home, 't');
  fs.mkdirSync(h);
  assert.equal(W.appTarget({ env: { OX_HOME: h } }), null);
  fs.writeFileSync(path.join(h, 'app.json'), JSON.stringify({ pid: 99999999, port: 1 }));
  assert.equal(W.appTarget({ env: { OX_HOME: h } }), null);
  fs.writeFileSync(path.join(h, 'app.json'), JSON.stringify({ pid: process.pid, port: 123 }));
  assert.deepEqual(W.appTarget({ env: { OX_HOME: h } }), { host: '127.0.0.1', port: 123 });
  assert.deepEqual(W.phoneAddresses({ a: [{ family: 'IPv4', address: '100.70.0.1', internal: false }], b: [{ family: 'IPv4', address: '192.168.1.5', internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), ['192.168.1.5', '100.70.0.1']);
});
