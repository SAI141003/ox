// Phase 1 of docs/MESH_RADIO_ARCHITECTURE.md, the pieces on their own:
// bundles (CBOR, signed, sealed, classes, replay), the store-and-forward
// queue, and CRDT state that merges the same in any order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const B = await import('../src/mesh-bundle.js');
const Q = await import('../src/mesh-outbox.js');
const C = await import('../src/mesh-crdt.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh1-'));
function machine(id) {
  const dir = tmp();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const box = B.boxKey(dir);
  return { id, dir, pub: B.rawPub(publicKey), priv: privateKey, box };
}

test('CBOR round-trips what bundles carry, and rejects junk', () => {
  const v = { a: 1, b: -5, big: 2 ** 40, s: 'héllo', buf: Buffer.from([1, 2, 3]), arr: [true, false, null, 1.5], nested: { x: [] } };
  const back = B.cborDecode(B.cborEncode(v));
  assert.deepEqual({ ...back, buf: [...back.buf] }, { ...v, buf: [1, 2, 3] });
  assert.throws(() => B.cborDecode(Buffer.from([0x5f])), /unsupported|truncated/);
  assert.throws(() => B.cborDecode(Buffer.concat([B.cborEncode(1), Buffer.from([0])])), /trailing/);
});

test('classes by size: tiny fits sound, control fits one small packet', () => {
  assert.equal(B.classFor(10), 'tiny');
  assert.equal(B.classFor(150), 'control');
  assert.equal(B.classFor(5000), 'interactive');
  assert.equal(B.classFor(1e6), 'bulk');
});

test('seal → peek (carrier sees no content) → open; tampering, wrong machine, unpaired sender, expiry all refused', () => {
  const a = machine('AAAA'), b = machine('BBBB'), c = machine('CCCC');
  const bytes = B.seal({ me: a, to: { id: b.id, box: b.box.pub }, body: { kind: 'note', text: 'stop' }, seq: 1 });
  const h = B.peek(bytes);
  assert.equal(h.to, 'BBBB');
  assert.equal(h.cls, 'tiny');
  assert.ok(!bytes.includes(Buffer.from('stop')), 'the text is not readable on the wire');
  const keys = { AAAA: a.pub };
  const got = B.open(bytes, { me: { id: b.id, box: b.box }, senderKey: (id) => keys[id] });
  assert.deepEqual(got.body, { kind: 'note', text: 'stop' });
  assert.equal(got.from, 'AAAA');
  assert.throws(() => B.open(bytes, { me: { id: c.id, box: c.box }, senderKey: (id) => keys[id] }), /for another machine/);
  assert.throws(() => B.open(bytes, { me: { id: b.id, box: b.box }, senderKey: () => null }), /not paired/);
  const o = B.cborDecode(bytes); o.ct[5] ^= 1;
  assert.throws(() => B.open(B.cborEncode(o), { me: { id: b.id, box: b.box }, senderKey: (id) => keys[id] }), /changed/);
  assert.throws(() => B.open(bytes, { me: { id: b.id, box: b.box }, senderKey: (id) => keys[id], now: Date.now() + 86_400_000 }), /expired/);
  // A forged signature: sealed correctly to B, signed by C, claiming to be A.
  const forged = B.seal({ me: { id: 'AAAA', priv: c.priv }, to: { id: b.id, box: b.box.pub }, body: 'x', seq: 2 });
  assert.throws(() => B.open(forged, { me: { id: b.id, box: b.box }, senderKey: (id) => keys[id] }), /signature/);
});

test('replay window: each sequence number once, old ones refused', () => {
  const d = tmp();
  assert.equal(B.firstTime(d, 'A', 1), true);
  assert.equal(B.firstTime(d, 'A', 1), false);
  assert.equal(B.firstTime(d, 'A', 3), true);
  assert.equal(B.firstTime(d, 'A', 2), true, 'late but inside the window');
  assert.equal(B.firstTime(d, 'A', 2), false);
  assert.equal(B.firstTime(d, 'A', 200), true);
  assert.equal(B.firstTime(d, 'A', 100), false, 'older than the window');
  assert.equal(B.nextSeq(d, 'B'), 1);
  assert.equal(B.nextSeq(d, 'B'), 2);
});

test('the queue: urgent first, by what a link can carry; carried bundles; expiry; delivery removes', () => {
  const a = machine('AAAA'), b = machine('BBBB');
  const to = { id: b.id, box: b.box.pub };
  const bulk = B.seal({ me: a, to, body: { blob: 'x'.repeat(20000) }, seq: 1 });
  const tiny = B.seal({ me: a, to, body: 'stop', seq: 2 });
  const ctl = B.seal({ me: a, to, body: { text: 'y'.repeat(120) }, seq: 3 });
  for (const x of [bulk, tiny, ctl]) Q.enqueue(a.dir, x);
  assert.equal(Q.enqueue(a.dir, tiny).dup, true, 'the same bundle twice is one');
  assert.deepEqual(Q.waiting(a.dir, 'BBBB').map((x) => x.cls), ['tiny', 'control', 'bulk']);
  assert.deepEqual(Q.waiting(a.dir, 'BBBB', { maxClass: 'tiny' }).map((x) => x.cls), ['tiny'], 'sound carries tiny only');
  assert.deepEqual(Q.waiting(a.dir, 'BBBB', { maxClass: 'control' }).map((x) => x.cls), ['tiny', 'control'], 'Bluetooth-sized');
  const first = Q.waiting(a.dir, 'BBBB')[0];
  Q.remove(a.dir, 'BBBB', first.id);
  assert.equal(Q.waiting(a.dir, 'BBBB').length, 2);
  // Carried for a third machine, handed to a carrier that is not its destination.
  const c = machine('CCCC');
  Q.enqueue(b.dir, B.seal({ me: a, to: { id: c.id, box: c.box.pub }, body: 'hi C', seq: 4 }), { carried: true });
  assert.equal(Q.carriedFor(b.dir, { except: 'XXXX' }).length, 1);
  assert.equal(Q.carriedFor(b.dir, { except: 'CCCC' }).length, 0, 'not handed back to its own destination as carried');
  assert.equal(Q.usage(b.dir).carried > 0, true);
  assert.equal(Q.sweep(a.dir, Date.now() + 30 * 86_400_000), 2, 'expired bundles go');
  Q.deliver(b.dir, { from: 'AAAA', body: 'stop' });
  assert.equal(Q.readInbox(b.dir)[0].body, 'stop');
});

test('CRDT: two machines edit offline and merge to the same state, in any order, any number of times', () => {
  const a = C.empty('board'), b = C.empty('board');
  C.set(a, 'task-1', { title: 'ship', state: 'todo' }, 'A', 1000);
  C.set(b, 'task-2', { title: 'test', state: 'todo' }, 'B', 1001);
  C.set(a, 'task-2', { title: 'test', state: 'done' }, 'A', 1005);   // A's later edit wins
  C.set(b, 'task-1', { title: 'ship', state: 'doing' }, 'B', 1003);
  C.del(b, 'task-1', 'B', 1004);                                       // B deletes after its own edit
  const ab = C.merge(JSON.parse(JSON.stringify(a)), b);
  const ba = C.merge(JSON.parse(JSON.stringify(b)), a);
  assert.deepEqual(C.value(ab), C.value(ba), 'same result either way');
  assert.deepEqual(C.value(ab), { 'task-2': { title: 'test', state: 'done' } });
  assert.deepEqual(C.value(C.merge(ab, ab)), C.value(ba), 'merging twice changes nothing');
  // Same wall time: the counter and machine id still give one order.
  const x = C.empty('s'), y = C.empty('s');
  C.set(x, 'k', 'from x', 'X', 5000); C.set(y, 'k', 'from y', 'Y', 5000);
  assert.equal(C.get(C.merge(JSON.parse(JSON.stringify(x)), y), 'k'), C.get(C.merge(JSON.parse(JSON.stringify(y)), x), 'k'));
  // Only what changed after a clock.
  const before = a.clock;
  C.set(a, 'task-3', 'new', 'A', 2000);
  assert.deepEqual(Object.keys(C.since(a, before).entries), ['task-3']);
  // A log keeps every entry, in order, after merging.
  const la = C.empty('audit'), lb = C.empty('audit');
  C.append(la, 'a1', 'A', 10); C.append(lb, 'b1', 'B', 11); C.append(la, 'a2', 'A', 12);
  assert.deepEqual(C.log(C.merge(la, lb)), ['a1', 'b1', 'a2']);
  const d = tmp();
  C.save(d, ab);
  assert.deepEqual(C.value(C.load(d, 'board')), C.value(ab));
  assert.deepEqual(C.names(d), ['board']);
});
