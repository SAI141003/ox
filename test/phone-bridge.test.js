import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pairDevice, readDevices, forgetDevice, seal, open, startPhoneBridge } from '../src/phone-bridge.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-phone-'));
const keyOf = (link) => Buffer.from(link.split('#')[1], 'base64url');

function fakeWatcher() {
  const answered = [];
  return {
    answered,
    scan() {},
    snapshot: () => [{ socket: '/tmp/s1.sock', project: 'shop', activity: 'bash npm test', phase: 'waiting', approvals: [{ id: 'ap-1', tool: 'bash', preview: 'rm -rf build' }] }],
    answer: (s, id, d) => { answered.push([s, id, d]); return true; },
    close() {},
  };
}

async function ask(port, id, key, msg, { tamper = null } = {}) {
  const env = { id, ...seal(key, msg) };
  if (tamper) tamper(env);
  const r = await fetch(`http://127.0.0.1:${port}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  return { status: r.status, body: r.status === 200 ? open(key, await r.json()) : null, env };
}

test('phone: pairing makes a key shown once, stored 0600; seal and open round-trip', () => {
  const h = home();
  const p = pairDevice('Sai iPhone', { home: h, host: '192.168.1.5', port: 47890 });
  assert.match(p.link, /^oxphone:\/\/192\.168\.1\.5:47890\/[\w-]+#[\w-]{43}$/);
  assert.equal(keyOf(p.link).length, 32);
  assert.equal((fs.statSync(path.join(h, 'phone.json')).mode & 0o777).toString(8), '600');
  const k = keyOf(p.link);
  assert.deepEqual(open(k, seal(k, { a: 1 })), { a: 1 });
  assert.throws(() => open(crypto.randomBytes(32), seal(k, { a: 1 })));
  assert.equal(forgetDevice('sai iphone', { home: h }), 1);
  assert.equal(readDevices({ home: h }).length, 0);
});

test('phone: reads what is waiting and answers it; wrong key, replay and stale messages are refused', async () => {
  const h = home();
  const p = pairDevice('iPhone', { home: h });
  const key = keyOf(p.link);
  const W = fakeWatcher();
  const B = await startPhoneBridge({ port: 0, host: '127.0.0.1', home: h, watcher: W });
  try {
    const s = await ask(B.port, p.id, key, { op: 'state', ts: Date.now() });
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.approvals, [{ socket: '/tmp/s1.sock', id: 'ap-1', tool: 'bash', preview: 'rm -rf build', project: 'shop' }]);
    const a = await ask(B.port, p.id, key, { op: 'answer', ts: Date.now(), args: { socket: '/tmp/s1.sock', id: 'ap-1', decision: 'deny' } });
    assert.equal(a.body.ok, true);
    assert.deepEqual(W.answered, [['/tmp/s1.sock', 'ap-1', 'deny']]);
    assert.equal((await ask(B.port, p.id, key, { op: 'answer', ts: Date.now(), args: { socket: 's', id: 'x', decision: 'rm -rf' } })).body.ok, false, 'only allow, deny or always');
    // Someone without the key.
    assert.equal((await ask(B.port, p.id, crypto.randomBytes(32), { op: 'state', ts: Date.now() })).status, 403);
    // The same sealed message sent twice.
    const once = await ask(B.port, p.id, key, { op: 'state', ts: Date.now() });
    const again = await fetch(`http://127.0.0.1:${B.port}/v1`, { method: 'POST', body: JSON.stringify(once.env) });
    assert.equal(again.status, 403);
    // A message from ten minutes ago.
    assert.equal((await ask(B.port, p.id, key, { op: 'state', ts: Date.now() - 600_000 })).status, 403);
    // An unknown phone, a bit flipped, and anything but POST /v1.
    assert.equal((await ask(B.port, 'nope', key, { op: 'state', ts: Date.now() })).status, 403);
    assert.equal((await ask(B.port, p.id, key, { op: 'state', ts: Date.now() }, { tamper: (e) => { const b = Buffer.from(e.c, 'base64'); b[0] ^= 1; e.c = b.toString('base64'); } })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${B.port}/`)).status, 404);
  } finally { await B.close(); }
});

test('phone: a sender that keeps failing is shut out', async () => {
  const h = home();
  const p = pairDevice('iPhone', { home: h });
  const B = await startPhoneBridge({ port: 0, host: '127.0.0.1', home: h, watcher: fakeWatcher() });
  try {
    for (let i = 0; i < 20; i++) await ask(B.port, p.id, crypto.randomBytes(32), { op: 'state', ts: Date.now() });
    assert.equal((await ask(B.port, p.id, keyOf(p.link), { op: 'state', ts: Date.now() })).status, 429, 'even the right key waits out the block');
  } finally { await B.close(); }
});
