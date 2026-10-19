// Bundles: the one message format of ox mesh on every link (docs/
// MESH_RADIO_ARCHITECTURE.md, after RFC 9171). A bundle is signed by the
// machine that made it and sealed to the one machine it is for, so any
// paired machine can carry it (store, carry, forward) without reading it.
//
//   outer (visible to carriers): v, id, to, cls, exp, eph, n, ct
//   inner (sealed):              from, to, cls, at, seq, body, sig(from)
//
// Encoded as CBOR (RFC 8949, the small subset ox needs). Sealing: an
// ephemeral X25519 key with the receiver's static X25519 key, HKDF-SHA256,
// AES-256-GCM. Signing: the sender's Ed25519 identity key, pinned at pairing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- CBOR

export function cborEncode(v) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    else { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); out.push((major << 5) | 27, ...b); }
  };
  const enc = (x) => {
    if (x === null || x === undefined) out.push(0xf6);
    else if (x === false) out.push(0xf4);
    else if (x === true) out.push(0xf5);
    else if (typeof x === 'number') {
      if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER) { if (x >= 0) head(0, x); else head(1, -1 - x); }
      else { const b = Buffer.alloc(8); b.writeDoubleBE(x); out.push(0xfb, ...b); }
    } else if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); head(3, b.length); out.push(...b); }
    else if (Buffer.isBuffer(x) || x instanceof Uint8Array) { head(2, x.length); for (const c of x) out.push(c); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); }
    else if (typeof x === 'object') { const ks = Object.keys(x).filter((k) => x[k] !== undefined); head(5, ks.length); for (const k of ks) { enc(k); enc(x[k]); } }
    else throw new Error(`cannot encode ${typeof x}`);
  };
  enc(v);
  return Buffer.from(out);
}

export function cborDecode(buf) {
  const b = Buffer.from(buf);
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new Error('truncated bundle'); };
  const len = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return b[i++]; }
    if (info === 25) { need(2); const v = b.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { need(4); const v = b.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { need(8); const v = Number(b.readBigUInt64BE(i)); i += 8; return v; }
    throw new Error('unsupported CBOR length');
  };
  const dec = (depth = 0) => {
    if (depth > 32) throw new Error('bundle nested too deep');
    need(1);
    const ib = b[i++], major = ib >> 5, info = ib & 31;
    if (major === 0) return len(info);
    if (major === 1) return -1 - len(info);
    if (major === 2) { const n = len(info); need(n); const v = b.subarray(i, i + n); i += n; return Buffer.from(v); }
    if (major === 3) { const n = len(info); need(n); const v = b.toString('utf8', i, i + n); i += n; return v; }
    if (major === 4) { const n = len(info); if (n > 100_000) throw new Error('array too long'); return Array.from({ length: n }, () => dec(depth + 1)); }
    if (major === 5) { const n = len(info); if (n > 10_000) throw new Error('map too long'); const o = {}; for (let k = 0; k < n; k++) { const key = dec(depth + 1); o[String(key)] = dec(depth + 1); } return o; }
    if (major === 7) {
      if (info === 20) return false; if (info === 21) return true; if (info === 22 || info === 23) return null;
      if (info === 27) { need(8); const v = b.readDoubleBE(i); i += 8; return v; }
    }
    throw new Error('unsupported CBOR item');
  };
  const v = dec();
  if (i !== b.length) throw new Error('trailing bytes in bundle');
  return v;
}

// ------------------------------------------------------------- classes

/** What a link can carry, by payload size (the body before sealing). */
export const CLASSES = Object.freeze({
  tiny: { max: 48, rank: 0 },            // stop, approve, "are you there": fits sound
  control: { max: 200, rank: 1 },        // status, "run task 12", an alert
  interactive: { max: 16 * 1024, rank: 2 },
  bulk: { max: 64 * 1024 * 1024, rank: 3 },
});
export const DEFAULT_TTL = Object.freeze({ tiny: 10 * 60_000, control: 60 * 60_000, interactive: 6 * 3600_000, bulk: 24 * 3600_000 });

/** The smallest class a body fits in. */
export function classFor(bodyBytes) {
  for (const [k, c] of Object.entries(CLASSES)) if (bodyBytes <= c.max) return k;
  throw new Error(`too big for a bundle (${bodyBytes} bytes; bulk is up to ${CLASSES.bulk.max})`);
}

// ---------------------------------------------------------------- keys

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export const rawPub = (k) => k.export({ format: 'der', type: 'spki' }).subarray(-32);
export const x25519Pub = (raw) => crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });
export const ed25519Pub = (raw) => crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });

/** This machine's static sealing key (X25519), made once beside its identity (~/.ox/mesh/box.json, 0600). */
export function boxKey(meshDir) {
  const f = path.join(meshDir, 'box.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { pub: Buffer.from(j.pub, 'base64'), priv: crypto.createPrivateKey(j.priv) };
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = rawPub(publicKey);
  fs.mkdirSync(meshDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ pub: pub.toString('base64'), priv: privateKey.export({ format: 'pem', type: 'pkcs8' }), created: new Date().toISOString() }), { mode: 0o600 });
  return { pub, priv: privateKey };
}

function keyFor(shared, ephPub, toPub) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, toPub]), Buffer.from('ox-mesh-bundle-v1'), 32));
}

// -------------------------------------------------------- seal and open

/**
 * Make a bundle. me: { id, priv (Ed25519) }; to: { id, box (raw X25519 public) }.
 * → Buffer (the encoded outer bundle)
 */
export function seal({ me, to, body, cls = null, ttlMs = null, seq, now = Date.now() }) {
  if (!to?.box) throw new Error(`no sealing key for ${to?.name ?? to?.id ?? 'that machine'} yet: connect once so the two exchange keys`);
  const bodyBytes = cborEncode(body);
  const k = cls ?? classFor(bodyBytes.length);
  if (!CLASSES[k]) throw new Error(`classes: ${Object.keys(CLASSES).join(', ')}`);
  if (bodyBytes.length > CLASSES[k].max) throw new Error(`${bodyBytes.length} bytes is too big for ${k} (max ${CLASSES[k].max})`);
  const inner = { from: me.id, to: to.id, cls: k, at: now, seq, body: bodyBytes };
  const sig = crypto.sign(null, cborEncode(inner), me.priv);
  const plain = cborEncode({ ...inner, sig });
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = rawPub(eph.publicKey);
  const toPub = Buffer.from(to.box);
  const key = keyFor(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Pub(toPub) }), ephPub, toPub);
  const n = crypto.randomBytes(12);
  const exp = now + (ttlMs ?? DEFAULT_TTL[k]);
  const id = crypto.randomBytes(8).toString('hex');
  const c = crypto.createCipheriv('aes-256-gcm', key, n);
  c.setAAD(cborEncode({ id, to: to.id, cls: k, exp }));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return cborEncode({ v: 1, id, to: to.id, cls: k, exp, eph: ephPub, n, ct });
}

/** What a carrier may read: who it is for, its class, when it expires. No content. */
export function peek(bytes) {
  const o = cborDecode(bytes);
  if (o?.v !== 1 || typeof o.id !== 'string' || typeof o.to !== 'string' || !CLASSES[o.cls]) throw new Error('not an ox bundle');
  return { id: o.id, to: o.to, cls: o.cls, exp: o.exp, size: Buffer.byteLength(bytes) };
}

/**
 * Open a bundle meant for this machine. me: { id, box: { priv, pub } };
 * senderKey(id) → raw Ed25519 public key of a paired machine, or null.
 * → { id, from, cls, at, seq, body }
 */
export function open(bytes, { me, senderKey, now = Date.now() }) {
  const o = cborDecode(bytes);
  if (o?.v !== 1) throw new Error('not an ox bundle');
  if (o.to !== me.id) throw new Error('this bundle is for another machine');
  if (now > o.exp) throw new Error('this bundle has expired');
  const key = keyFor(crypto.diffieHellman({ privateKey: me.box.priv, publicKey: x25519Pub(o.eph) }), Buffer.from(o.eph), Buffer.from(me.box.pub));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.n));
  d.setAAD(cborEncode({ id: o.id, to: o.to, cls: o.cls, exp: o.exp }));
  const ct = Buffer.from(o.ct);
  d.setAuthTag(ct.subarray(-16));
  let plain;
  try { plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]); } catch { throw new Error('this bundle was changed or is not for this machine'); }
  const inner = cborDecode(plain);
  const { sig, ...signed } = inner;
  if (signed.to !== me.id || signed.cls !== o.cls) throw new Error('bundle header and content disagree');
  const pub = senderKey(signed.from);
  if (!pub) throw new Error(`from a machine that is not paired (${String(signed.from).slice(0, 8)})`);
  if (!crypto.verify(null, cborEncode(signed), ed25519Pub(pub), Buffer.from(sig))) throw new Error('the signature does not match the sender');
  return { id: o.id, from: signed.from, cls: signed.cls, at: signed.at, seq: signed.seq, body: cborDecode(signed.body) };
}

// --------------------------------------------- sequence numbers and replay

/** Next sequence number to a machine (~/.ox/mesh/seq.json). */
export function nextSeq(meshDir, toId) {
  const f = path.join(meshDir, 'seq.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  j[toId] = (j[toId] ?? 0) + 1;
  fs.mkdirSync(meshDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(j), { mode: 0o600 });
  return j[toId];
}

/**
 * Replay protection: each sender's highest sequence number and a 64-wide
 * window below it (as IPsec does). → true the first time, false for a repeat
 * or anything older than the window. State in ~/.ox/mesh/seen.json.
 */
export function firstTime(meshDir, fromId, seq) {
  const f = path.join(meshDir, 'seen.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const s = j[fromId] ?? { max: 0, bits: '0' };
  let bits = BigInt(s.bits);
  if (!Number.isInteger(seq) || seq < 1) return false;
  if (seq > s.max) { const shift = BigInt(seq - s.max); bits = shift >= 64n ? 1n : ((bits << shift) | 1n) & ((1n << 64n) - 1n); s.max = seq; }
  else {
    const off = BigInt(s.max - seq);
    if (off >= 64n || (bits >> off) & 1n) return false;
    bits |= 1n << off;
  }
  j[fromId] = { max: s.max, bits: bits.toString() };
  fs.mkdirSync(meshDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(j), { mode: 0o600 });
  return true;
}
