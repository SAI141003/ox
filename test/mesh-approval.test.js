// The mesh, on two real homes: a request nobody allowed yet asks its owner; a
// message is "delivered" only on the other machine's receipt; the connection
// says how it is; files of any size arrive whole or not at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as M from '../src/mesh.js';
import { pushStream, pullFile } from '../src/mesh-services.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-ask-'));
const until = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };
const asks = (n) => n.status().alerts.filter((a) => a.kind === 'approval');

async function pair(bOptions = { approvals: true }) {
  const ha = home(), hb = home();
  const base = { port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1' };
  M.setName('Studio', { home: ha });
  const A = await M.startNode({ home: ha, ...base });
  const B = await M.startNode({ home: hb, ...base, ...bOptions });
  const { code } = A.invite();
  await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Laptop', o: { home: hb }, myPort: B.port });
  return { A, B, ha, hb, close: async () => { await A.close().catch(() => {}); await B.close().catch(() => {}); } };
}

test('with nobody to ask, a request is refused at once and says where to allow it', async () => {
  const { A, close } = await pair({ approvals: false });
  try { await assert.rejects(A.sendMessage('Laptop', 'hi'), /does not allow messages from Studio yet.*Manage Studio/); } finally { await close(); }
});

test('allow once: the message waits, is delivered on the answer, and the next one asks again', async () => {
  const { A, B, close } = await pair();
  try {
    const sending = A.sendMessage('Laptop', 'are you there?');
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    assert.match(ask.text, /Studio wants to send you a message: "are you there\?"/);
    assert.deepEqual(ask.options.map((o) => o.action), ['approve-once', 'approve-always', 'approve-deny']);
    B.choose(ask.id, { action: 'approve-once' });
    const sent = await sending;
    assert.equal(sent.delivered, true);
    assert.ok(sent.deliveredAt);
    assert.deepEqual(B.messages('Studio').map((m) => [m.way, m.text]), [['in', 'are you there?']]);
    assert.deepEqual(A.messages('Laptop').map((m) => [m.way, m.text]), [['out', 'are you there?']]);
    assert.equal(B.status().alerts.filter((a) => a.kind === 'message').length, 1, 'the owner is shown the message');

    const again = A.sendMessage('Laptop', 'again');
    const second = (await until(() => asks(B)[0] && asks(B)))[0];
    B.choose(second.id, { action: 'approve-always' });
    await again;
    await A.sendMessage('Laptop', 'no question now');
    assert.equal(asks(B).length, 0, 'always: not asked again');
  } finally { await close(); }
});

test('deny refuses plainly, and stays quiet for a while rather than asking again', async () => {
  const { A, B, close } = await pair();
  try {
    const sending = A.sendMessage('Laptop', 'hi');
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    B.choose(ask.id, { action: 'approve-deny' });
    await assert.rejects(sending, /does not allow message from Studio: its owner declined/);
    await assert.rejects(A.sendMessage('Laptop', 'hi'), /just declined/);
    assert.equal(asks(B).length, 0);
    assert.equal(A.messages('Laptop').length, 0, 'a message that did not arrive is not logged as sent');
  } finally { await close(); }
});

test('nobody answering is a refusal, not a hang', async () => {
  const { A, close } = await pair({ approvals: true, approvalWaitMs: 200 });
  try { await assert.rejects(A.sendMessage('Laptop', 'hi'), /nobody answered on/); } finally { await close(); }
});

test('background polling never asks, and screen and control are never offered', async () => {
  const { A, B, close } = await pair();
  try {
    await assert.rejects(A.ask('Laptop', 'agents', {}), /does not allow agents/);
    await assert.rejects(A.ask('Laptop', 'screen', {}), /does not allow screen/);
    await assert.rejects(A.ask('Laptop', 'control-click', { x: 1, y: 1 }), /does not allow control/);
    assert.equal(asks(B).length, 0);
  } finally { await close(); }
});

test('a chat allowed once stays allowed for its 30 minutes: one answer, not one per turn', async () => {
  const { A, B, close } = await pair();
  try {
    const first = A.ask('Laptop', 'infer', { body: { model: 'no-such-model', messages: [] } }, { timeoutMs: 15000 }).catch((e) => e.message);
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    assert.equal(ask.options[0].label, 'Allow for 30 minutes');
    B.choose(ask.id, { action: 'approve-once' });
    assert.doesNotMatch(String(await first), /does not allow/);
    await A.ask('Laptop', 'infer', { body: { model: 'no-such-model', messages: [] } }, { timeoutMs: 15000 }).catch(() => {});
    assert.equal(asks(B).length, 0);
  } finally { await close(); }
});

test('the connection says how it is: round trip, version, and what the other side allows', async () => {
  const { A, hb, close } = await pair();
  try {
    await A.heartbeat();
    let live = A.status().peers[0].live;
    assert.equal(live.error, null);
    assert.equal(typeof live.rttMs, 'number');
    assert.ok(live.lastSeen);
    assert.ok(live.version);
    assert.equal(live.binary, true);
    assert.equal(live.theirGrants.message, false);
    M.setGrant('Studio', 'message', true, { home: hb });
    await A.heartbeat();
    live = A.status().peers[0].live;
    assert.equal(live.theirGrants.message, true);
    const t = await A.testLink('Laptop');
    assert.equal(t.ok, true);
    assert.equal(t.binary, true);
  } finally { await close(); }
});

test('a machine that went away shows why, and leaves the list of models', async () => {
  const { A, B, close } = await pair();
  try {
    await A.heartbeat();
    await B.close();
    await A.heartbeat();
    assert.ok(A.status().peers[0].live.error);
    await assert.rejects(A.testLink('Laptop'));
  } finally { await close(); }
});

function shared(hb, n = 'Studio') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-share-'));
  M.setGrant(n, 'files', true, { home: hb });
  M.setGrant(n, 'files-write', true, { home: hb });
  M.setRoots(n, [dir], { home: hb });
  return dir;
}

test('a file well over the old 8 MB limit goes both ways, whole', async () => {
  const { A, hb, close } = await pair();
  try {
    const dir = shared(hb);
    const bytes = crypto.randomBytes(20 * 1024 * 1024);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const seen = [];
    const out = await pushStream(A, 'Laptop', Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]), { path: path.join(dir, 'big.bin'), size: bytes.length, onProgress: (n) => seen.push(n) });
    assert.equal(out.sha256, sha);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'big.bin'))).digest('hex'), sha);
    assert.equal(seen.at(-1), bytes.length);
    assert.deepEqual(fs.readdirSync(dir), ['big.bin'], 'no upload part left behind');

    const here = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-here-')), 'copy.bin');
    const got = await pullFile(A, 'Laptop', path.join(dir, 'big.bin'), here);
    assert.equal(got.sha256, sha);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(here)).digest('hex'), sha);
    assert.deepEqual(fs.readdirSync(path.dirname(here)), ['copy.bin']);
    await assert.rejects(pullFile(A, 'Laptop', path.join(dir, 'big.bin'), here), /exists/);
  } finally { await close(); }
});

test('a short, long or corrupted upload writes nothing, and overwriting takes a choice', async () => {
  const { A, hb, close } = await pair();
  try {
    const dir = shared(hb);
    const dest = path.join(dir, 'x.bin');
    await assert.rejects(pushStream(A, 'Laptop', Readable.from([Buffer.alloc(10)]), { path: dest, size: 20 }), /did not arrive intact/);
    assert.deepEqual(fs.readdirSync(dir), []);
    await assert.rejects(pushStream(A, 'Laptop', Readable.from([Buffer.alloc(30)]), { path: dest, size: 20 }), /more bytes arrived/);
    assert.deepEqual(fs.readdirSync(dir), []);
    const open = await A.ask('Laptop', 'push-begin', { path: dest, size: 4 });
    await A.ask('Laptop', 'push-chunk', { id: open.id }, { bytes: Buffer.from('abcd') });
    await assert.rejects(A.ask('Laptop', 'push-end', { id: open.id, sha256: '0'.repeat(64) }), /did not arrive intact/);
    assert.deepEqual(fs.readdirSync(dir), []);

    await pushStream(A, 'Laptop', Readable.from([Buffer.from('one')]), { path: dest, size: 3 });
    await assert.rejects(pushStream(A, 'Laptop', Readable.from([Buffer.from('two')]), { path: dest, size: 3 }), /already exists/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'one');
    await pushStream(A, 'Laptop', Readable.from([Buffer.from('two')]), { path: dest, size: 3, overwrite: true });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'two');
    await assert.rejects(pushStream(A, 'Laptop', Readable.from([Buffer.from('x')]), { path: path.join(os.tmpdir(), 'outside-shared.bin'), size: 1 }), /inside folders/);
  } finally { await close(); }
});

test('another paired machine cannot write into an upload it did not open', async () => {
  const { A, B, hb, ha, close } = await pair();
  const hc = home();
  const C = await M.startNode({ home: hc, port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1' });
  try {
    const dir = shared(hb);
    const open = await A.ask('Laptop', 'push-begin', { path: path.join(dir, 'y.bin'), size: 4 });
    const { code } = B.invite();
    await M.join({ code, at: `127.0.0.1:${B.port}`, name: 'Third', o: { home: hc }, myPort: C.port });
    const laptop = Object.values(M.readPeers({ home: hc }))[0].name;
    await assert.rejects(C.ask(laptop, 'push-chunk', { id: open.id }, { bytes: Buffer.from('evil') }), /not open here/);
    await assert.rejects(C.ask(laptop, 'push-abort', { id: open.id }), /not open here/);
    await A.ask('Laptop', 'push-abort', { id: open.id });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(ha);
  } finally { await C.close().catch(() => {}); await close(); }
});

test('disconnect stops everything both ways and keeps the pairing; reconnect needs no code', async () => {
  const { A, B, hb, close } = await pair();
  try {
    M.setGrant('Studio', 'message', true, { home: hb });
    await A.heartbeat();
    assert.equal(A.status().peers[0].live.error, null);

    A.disconnect('Laptop');
    assert.equal(A.status().peers[0].paused, true);
    assert.equal(A.status().peers[0].live.error, 'you disconnected it');
    await assert.rejects(A.sendMessage('Laptop', 'hi'), /you disconnected Laptop/);
    // From the other side: refused by name, not a mystery, and not asked about.
    let heard = '';
    for (let i = 0; i < 100 && !/has disconnected/.test(heard); i++) {
      heard = await B.testLink('Studio').then(() => 'still connected', (e) => e.message);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(heard, /has disconnected from this computer/);
    await B.heartbeat();
    assert.match(B.status().peers[0].live.error, /has disconnected from this computer/);
    assert.equal(asks(A).length, 0);

    await A.reconnect('Laptop');
    assert.equal(A.status().peers[0].paused, false);
    assert.equal(A.status().peers[0].live.error, null);
    assert.equal((await A.sendMessage('Laptop', 'back')).delivered, true);
    await B.heartbeat();
    assert.equal(B.status().peers[0].live.error, null, 'the other side recovers by itself');
  } finally { await close(); }
});

test('disconnecting cuts a live connection and ends what was waiting for approval', async () => {
  const { A, B, close } = await pair();
  try {
    const sending = A.sendMessage('Laptop', 'hi');
    await until(() => asks(B)[0]);
    B.disconnect('Studio');
    await assert.rejects(sending);
    assert.equal(asks(B).length, 0);
  } finally { await close(); }
});

test('a disconnect made from another process takes effect on the next beat', async () => {
  const { A, B, hb, close } = await pair();
  try {
    await A.testLink('Laptop');
    M.setPaused('Studio', true, { home: hb });
    await B.heartbeat();
    // A may first see its old connection close; what it hears after that is the reason.
    let heard = '';
    for (let i = 0; i < 100 && !/has disconnected/.test(heard); i++) {
      heard = await A.testLink('Laptop').then(() => 'still connected', (e) => e.message);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(heard, /has disconnected from this computer/);
  } finally { await close(); }
});

test('remove forgets the machine and cuts it off; pairing again starts connected', async () => {
  const { A, B, ha, hb, close } = await pair();
  try {
    await A.testLink('Laptop');
    assert.deepEqual(B.remove('Studio'), { forgot: 'Studio' });
    assert.equal(Object.keys(M.readPeers({ home: hb })).length, 0);
    assert.equal(B.status().peers.length, 0);
    let refused = '';
    for (let i = 0; i < 100 && !/not a paired machine/.test(refused); i++) {
      refused = await A.testLink('Laptop').then(() => 'still connected', (e) => e.message);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(refused, /not a paired machine/);

    A.disconnect('Laptop');
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Laptop', o: { home: hb }, myPort: B.port });
    assert.equal(Object.values(M.readPeers({ home: ha }))[0].paused, false);
    assert.equal((await A.testLink('Laptop')).ok, true);
  } finally { await close(); }
});

test('the app offers disconnect, reconnect and remove', () => {
  const page = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(page, /p\.paused \? 'Reconnect' : 'Disconnect'/);
  assert.match(page, /\/ox\/mesh\/\$\{back \? 'reconnect' : 'disconnect'\}/);
  assert.match(page, /id="od-remove">Remove this computer/);
});

const closedPort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(`127.0.0.1:${p}`)); }); });
const placesOf = (h, addr, addrs) => {
  const f = path.join(h, 'mesh', 'peers.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const p = Object.values(j.peers)[0];
  p.addr = addr; p.addrs = addrs;
  fs.writeFileSync(f, JSON.stringify(j));
};
const nodeAt = (h) => M.startNode({ home: h, port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1' });

test('a machine that moved is found at its other addresses, and the one that works is kept', async () => {
  const { A, ha, close } = await pair();
  try {
    await A.testLink('Laptop');
    const good = Object.values(M.readPeers({ home: ha }))[0].addr;
    await A.close();
    const dead = await closedPort();
    placesOf(ha, dead, [dead, good]); // it left the Wi-Fi: this address is dead, another works
    const again = await nodeAt(ha);
    try {
      assert.equal((await again.testLink('Laptop')).ok, true);
      assert.equal(Object.values(M.readPeers({ home: ha }))[0].addr, good, 'the working address is remembered');
    } finally { await again.close(); }
  } finally { await close(); }
});

test('a machine tells the other where else it can be reached', async () => {
  const { A, ha, close } = await pair();
  try {
    await A.heartbeat();
    const p = Object.values(M.readPeers({ home: ha }))[0];
    for (const a of p.addrs ?? []) assert.match(a, /:\d+$/);
    assert.ok(A.status().peers[0].addrs.includes(p.addr));
    assert.ok(Array.isArray(A.status().me.addrs));
  } finally { await close(); }
});

test('nothing reachable says so, names what it tried, and says what would connect it', async () => {
  const { A, ha, close } = await pair();
  try {
    await A.close();
    const dead = await closedPort();
    placesOf(ha, dead, [dead]);
    const again = await nodeAt(ha);
    try { await assert.rejects(again.testLink('Laptop'), /is not reachable at 127\.0\.0\.1.*Tailscale on both computers/); } finally { await again.close(); }
  } finally { await close(); }
});

test('an address now used by another computer is refused by its key, and nothing is sent', async () => {
  const { A, ha, close } = await pair();
  const stranger = await nodeAt(home());
  try {
    await A.close();
    const there = `127.0.0.1:${stranger.port}`;
    placesOf(ha, there, [there]);
    const again = await nodeAt(ha);
    try { await assert.rejects(again.testLink('Laptop'), /not a paired machine|key changed/); } finally { await again.close(); }
  } finally { await stranger.close(); await close(); }
});

test('addresses: a plain host gets the mesh port, nonsense is refused, Tailscale is recognised', () => {
  const h = home();
  fs.mkdirSync(path.join(h, 'mesh'), { recursive: true });
  fs.writeFileSync(path.join(h, 'mesh', 'peers.json'), JSON.stringify({ peers: { X: { id: 'X', name: 'Far', grants: {} } } }));
  assert.equal(M.setAddress('Far', '100.101.102.103', { home: h }).addr, `100.101.102.103:${M.PORT}`);
  assert.throws(() => M.setAddress('Far', 'not an address!', { home: h }), /an address looks like/);
  assert.equal(M.isTailscale('100.101.102.103:47870'), true);
  assert.equal(M.isTailscale('192.168.1.20:47870'), false);
});
