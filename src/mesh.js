// ox mesh: one person's machines as one ox (docs/MESH_DESIGN.md).
//
// Every machine runs the same node. Pairing is a one-time code; after it, the
// machines know each other by key only. Every connection is a signed X25519
// exchange followed by AES-256-GCM frames. Each machine decides what the
// others may ask of it (status, infer, tasks). The controller pulls health
// every few seconds, keeps a φ-accrual liveness score per machine, and turns
// overload and low credits into alerts with choices; nothing acts by itself.
// A model call can run on another machine: `mesh:<machine>/<model>` reaches
// it through a local endpoint here, and the other machine answers from its
// local model or its own key (which never leaves it).
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const PORT = 47870;          // node listener (TCP)
export const BEACON_PORT = 47871;   // LAN discovery (UDP broadcast)
export const PROXY_PORT = 47872;    // this machine's local endpoint for mesh model calls
const HEARTBEAT_MS = 5000;
const INVITE_MS = 10 * 60_000;
const VERSION = 1;

const home = (o) => o?.home ?? process.env.OX_HOME ?? path.join(os.homedir(), '.ox');
const dir = (o) => path.join(home(o), 'mesh');
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s ?? ''), 'base64');

// ---------------------------------------------------------------- identity

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A machine's id: the first 16 base32 characters of SHA-256(its public key). */
export const idOf = (pubRaw) => base32(crypto.createHash('sha256').update(pubRaw).digest()).slice(0, 16);

function rawPub(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32);
}
function pubFromRaw(raw) {
  // Ed25519 SPKI prefix + 32 raw bytes.
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

/** This machine's key pair, made once (~/.ox/mesh/identity.json, 0600). */
export function identity(o = {}) {
  const f = path.join(dir(o), 'identity.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const priv = crypto.createPrivateKey(j.priv);
    const pub = unb64(j.pub);
    return { id: idOf(pub), pub, priv, name: j.name || os.hostname().replace(/\.local$/, ''), file: f };
  } catch {}
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = rawPub(publicKey);
  const j = { pub: b64(pub), priv: privateKey.export({ format: 'pem', type: 'pkcs8' }), name: os.hostname().replace(/\.local$/, ''), created: new Date().toISOString() };
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  return { id: idOf(pub), pub, priv: privateKey, name: j.name, file: f };
}

/** Whether this machine has joined the mesh at all (status never creates a key). */
export const hasIdentity = (o = {}) => fs.existsSync(path.join(dir(o), 'identity.json'));

export function setName(name, o = {}) {
  const me = identity(o);
  const j = JSON.parse(fs.readFileSync(me.file, 'utf8'));
  j.name = String(name).trim().slice(0, 40) || j.name;
  fs.writeFileSync(me.file, JSON.stringify(j, null, 2), { mode: 0o600 });
  return j.name;
}

// ---------------------------------------------------------------- paired machines

const DEFAULT_GRANTS = { status: true, infer: false, tasks: false, files: false, agents: false, dev: false, screen: false, control: false };
export const GRANTS = Object.keys(DEFAULT_GRANTS);
// Presets for `ox mesh allow <machine> <preset>`.
// Screen and control are deliberately not part of `full`: the controlled Mac's
// owner must opt in to each, or use the explicit desktop preset.
export const PRESETS = Object.freeze({ viewer: ['status'], helper: ['status', 'infer', 'tasks'], full: ['status', 'infer', 'tasks', 'files', 'agents', 'dev'], desktop: ['status', 'screen', 'control'] });

export function readPeers(o = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(o), 'peers.json'), 'utf8')).peers ?? {}; } catch { return {}; }
}
function writePeers(peers, o = {}) {
  const f = path.join(dir(o), 'peers.json');
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ peers }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function pin(peer, o = {}) {
  const peers = readPeers(o);
  const old = peers[peer.id];
  peers[peer.id] = { grants: { ...DEFAULT_GRANTS }, ...old, ...peer, pairedAt: old?.pairedAt ?? new Date().toISOString() };
  writePeers(peers, o);
  return peers[peer.id];
}

/** A paired machine by id, id prefix or name (case-insensitive). */
export function findPeer(ref, o = {}) {
  const peers = Object.values(readPeers(o));
  const r = String(ref ?? '').trim().toLowerCase();
  return peers.find((p) => p.id.toLowerCase() === r) ?? peers.find((p) => (p.name ?? '').toLowerCase() === r)
    ?? peers.find((p) => p.id.toLowerCase().startsWith(r) && r.length >= 4) ?? null;
}

/** What this machine lets a paired machine do (set on this machine). */
export function setGrant(ref, grant, on, o = {}) {
  const preset = PRESETS[grant];
  if (!GRANTS.includes(grant) && !preset) throw new Error(`a grant is one of ${GRANTS.join(', ')}, or a preset: ${Object.keys(PRESETS).join(', ')}`);
  const p = findPeer(ref, o);
  if (!p) throw new Error(`no paired machine ${ref}`);
  const peers = readPeers(o);
  const g = { ...DEFAULT_GRANTS, ...peers[p.id].grants };
  if (preset) { for (const k of GRANTS) g[k] = on ? preset.includes(k) : (k === 'status' ? g.status : false); }
  else g[grant] = !!on;
  peers[p.id].grants = g;
  writePeers(peers, o);
  return peers[p.id];
}

/** The folders a paired machine may browse and copy from (default: this machine's home). */
export function setRoots(ref, roots, o = {}) {
  const p = findPeer(ref, o);
  if (!p) throw new Error(`no paired machine ${ref}`);
  const peers = readPeers(o);
  peers[p.id].roots = roots.map((r) => path.resolve(String(r).replace(/^~(?=$|\/)/, os.homedir())));
  writePeers(peers, o);
  return peers[p.id];
}

/** Every paired machine back to status only, at once. */
export function lockdown(o = {}) {
  const peers = readPeers(o);
  for (const id of Object.keys(peers)) peers[id].grants = { ...DEFAULT_GRANTS };
  writePeers(peers, o);
  return Object.keys(peers).length;
}

export function forget(ref, o = {}) {
  const p = findPeer(ref, o);
  if (!p) throw new Error(`no paired machine ${ref}`);
  const peers = readPeers(o);
  delete peers[p.id];
  writePeers(peers, o);
  return p;
}

// ---------------------------------------------------------------- invite codes

/** "OX-K7P3-Q9XA-2MWD": 60 random bits, one use. */
export function newCode() {
  const s = base32(crypto.randomBytes(8)).slice(0, 12);
  return `OX-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
// The 12 code characters, however it was typed ("OX-K7P3-…", "k7p3 q9xa …").
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '').slice(-12);

// ---------------------------------------------------------------- the channel

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));

function transcript(a, b) {
  // Order-independent: both sides hash the same bytes.
  const [x, y] = [a, b].sort((p, q) => (p.id < q.id ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify([VERSION, x.id, x.pub, x.eph, y.id, y.pub, y.eph])).digest();
}

/** A framed, sealed connection over a socket (after the handshake). */
class Sealed {
  constructor(sock, sendKey, recvKey) {
    this.sock = sock; this.sendKey = sendKey; this.recvKey = recvKey;
    this.sendN = 0n; this.recvN = 0n;
    this.handlers = new Set();
  }
  nonce(n) { const b = Buffer.alloc(12); b.writeBigUInt64BE(n, 4); return b; }
  send(obj) {
    const iv = this.nonce(this.sendN++);
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    this.sock.write(`${b64(Buffer.concat([ct, c.getAuthTag()]))}\n`);
  }
  open(line) {
    const buf = unb64(line);
    const iv = this.nonce(this.recvN++);
    const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, iv);
    d.setAuthTag(buf.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString('utf8'));
  }
}

function lines(sock, onLine) {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > 32 * 1024 * 1024) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
}

function sessionKeys(sharedSecret, me, other, iAmClient) {
  const salt = Buffer.from([me.id, other.id].sort().join(':'));
  const c2s = hkdf(sharedSecret, salt, 'ox-mesh v1 c2s');
  const s2c = hkdf(sharedSecret, salt, 'ox-mesh v1 s2c');
  return iAmClient ? [c2s, s2c] : [s2c, c2s];
}

/**
 * Client side of a connection. mode 'auth' (paired) or 'pair' (with a code).
 * Resolves { ch: Sealed, peer } or rejects with the reason.
 */
export function connect({ host, port = PORT, me, mode = 'auth', code = null, expect = null, myName = null, myPort = PORT, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const eph = crypto.generateKeyPairSync('x25519');
    const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const mine = { id: me.id, pub: b64(me.pub), eph: b64(ephRaw) };
    const fail = (e) => { sock.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    const t = setTimeout(() => fail('no answer from that machine'), timeoutMs);
    let theirs = null, ch = null, stage = 'hello';
    sock.on('error', (e) => { clearTimeout(t); fail(e.message); });
    lines(sock, (line) => {
      try {
        if (stage === 'hello') {
          const m = JSON.parse(line);
          if (m.t === 'refused') return fail(m.why ?? 'refused');
          if (m.t !== 'hello' || m.v !== VERSION) return fail('not an ox mesh node');
          const pub = unb64(m.pub);
          if (idOf(pub) !== m.id) return fail('its id does not match its key');
          if (expect && expect.pub !== m.pub) return fail('that machine\'s key changed: it is not the machine you paired (forget and pair it again if it was reinstalled)');
          theirs = { id: m.id, pub: m.pub, eph: m.eph, name: m.name };
          const T = transcript(mine, theirs);
          if (!crypto.verify(null, T, pubFromRaw(pub), unb64(m.sig))) return fail('its signature does not check');
          const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), unb64(m.eph)]), format: 'der', type: 'spki' }) });
          const [sk, rk] = sessionKeys(shared, me, theirs, true);
          ch = new Sealed(sock, sk, rk);
          const sig = b64(crypto.sign(null, T, me.priv));
          const mac = mode === 'pair' ? b64(crypto.createHmac('sha256', normCode(code)).update('C').update(T).digest()) : null;
          ch.send({ t: 'auth', sig, mac, name: myName ?? me.name });
          stage = 'auth';
          ch.T = T;
          return;
        }
        let m;
        if (stage === 'open') {
          try { m = ch.open(line); } catch { sock.destroy(); return; }
          for (const h of ch.handlers) h(m);
          return;
        }
        m = ch.open(line);
        if (stage === 'auth') {
          if (m.t === 'refused') return fail(m.why ?? 'refused');
          if (m.t !== 'welcome') return fail('unexpected answer');
          if (mode === 'pair') {
            const want = crypto.createHmac('sha256', normCode(code)).update('S').update(ch.T).digest();
            if (!crypto.timingSafeEqual(want, unb64(m.mac))) return fail('the other machine could not prove the code');
          }
          clearTimeout(t);
          stage = 'open';
          resolve({ ch, peer: { id: theirs.id, pub: theirs.pub, name: m.name ?? theirs.name } });
        }
      } catch (e) { fail(e.message); }
    });
    sock.on('connect', () => {
      // The hello carries no signature yet: the server answers first, then each signs the transcript.
      sock.write(`${JSON.stringify({ t: 'hello', v: VERSION, mode, id: mine.id, pub: mine.pub, eph: mine.eph, name: myName ?? me.name, port: myPort })}\n`);
    });
  });
}

// ---------------------------------------------------------------- health

/** This machine, now: load, memory, heat, battery, disk, models, keys, plans. */
export async function stats({ ollamaUrl = process.env.OX_OLLAMA_URL ?? 'http://127.0.0.1:11434', runs = 0, plans = null } = {}) {
  const cores = os.cpus().length || 1;
  const load = os.loadavg()[0] / cores;
  const memUsed = 1 - os.freemem() / os.totalmem();
  let memPressure = null, thermal = null, battery = null, charging = null, diskFreeGb = null;
  if (process.platform === 'darwin') {
    // macOS keeps free memory low on purpose: its own pressure level is the honest signal.
    const mp = spawnSync('memory_pressure', ['-Q'], { encoding: 'utf8', timeout: 2000 });
    const m = /free percentage:\s*(\d+)%/i.exec(mp.stdout ?? '');
    if (m) memPressure = 1 - Number(m[1]) / 100;
    const th = spawnSync('pmset', ['-g', 'therm'], { encoding: 'utf8', timeout: 2000 });
    thermal = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(th.stdout ?? '') ? (Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(th.stdout)[1]) < 100 ? 'throttled' : 'nominal') : 'nominal';
    const bt = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2000 });
    const b = /(\d+)%;\s*(\w+)/.exec(bt.stdout ?? '');
    if (b) { battery = Number(b[1]) / 100; charging = !/discharging/i.test(b[2]); }
  }
  try { const s = fs.statfsSync(os.homedir()); diskFreeGb = Math.round((s.bavail * s.bsize) / 1e9 * 10) / 10; } catch {}
  let models = [];
  try {
    const r = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (r.ok) models = ((await r.json()).models ?? []).map((m) => ({ name: m.name, size: m.size ?? null }));
  } catch {}
  return {
    at: Date.now(), os: `${os.type()} ${os.release()}`, arch: os.arch(), cores, memGb: Math.round(os.totalmem() / 1e9),
    load: Math.round(load * 100) / 100, mem: Math.round((memPressure ?? memUsed) * 100) / 100,
    thermal, battery, charging, diskFreeGb, models, providers: keyedProviders(), runs, plans: plans ?? [],
  };
}

/** Which providers this machine has a key for (names only, never the keys). */
function keyedProviders() {
  const names = new Set();
  try { for (const k of Object.keys(JSON.parse(fs.readFileSync(path.join(home(), 'keys.json'), 'utf8')))) names.add(k.replace(/_API_KEY$/, '').toLowerCase()); } catch {}
  for (const k of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY']) if (process.env[k]) names.add(k.replace(/_API_KEY$/, '').toLowerCase());
  return [...names];
}

// ---------------------------------------------------------------- φ accrual liveness

/** Hayashibara et al.'s φ accrual failure detector over heartbeat arrivals. */
export class Phi {
  constructor({ window = 100, minStd = 500, firstInterval = HEARTBEAT_MS } = {}) {
    this.window = window; this.minStd = minStd; this.intervals = [firstInterval]; this.last = null;
  }
  beat(t = Date.now()) {
    if (this.last != null) { this.intervals.push(t - this.last); if (this.intervals.length > this.window) this.intervals.shift(); }
    this.last = t;
  }
  phi(t = Date.now()) {
    if (this.last == null) return 0;
    const n = this.intervals.length;
    const mean = this.intervals.reduce((a, b) => a + b, 0) / n;
    const std = Math.max(this.minStd, Math.sqrt(this.intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / n));
    const y = (t - this.last - mean) / std;
    // Logistic approximation of the normal CDF's upper tail (as Akka uses).
    const e = Math.exp(-y * (1.5976 + 0.070566 * y * y));
    const pLater = t - this.last > mean ? e / (1 + e) : 1 - 1 / (1 + e);
    return -Math.log10(Math.max(pLater, 1e-300));
  }
}

// ---------------------------------------------------------------- the watchdog

const LIMITS = { load: 0.9, mem: 0.9, battery: 0.15, diskGb: 5, plan: 85, phiSuspect: 8, phiDown: 12, sustainMs: 60_000 };

/**
 * Alerts with choices from what the machines report. `machines`: [{ id, name,
 * stats, phi, overSince: { signal: t } }]. Never acts: it only says and offers.
 */
export function watchdog(machines, { now = Date.now(), limits = LIMITS } = {}) {
  const alerts = [];
  const idle = machines.filter((m) => m.stats && m.phi < limits.phiSuspect && m.stats.load < 0.5 && m.stats.mem < 0.8);
  const helpers = (m) => idle.filter((x) => x.id !== m.id);
  for (const m of machines) {
    const s = m.stats;
    if (m.phi >= limits.phiDown) { alerts.push({ id: `${m.id}:down`, machine: m.name, kind: 'down', text: `${m.name} is not answering.`, options: [{ label: 'Wait for it', action: 'wait' }, { label: 'Move its work to another machine', action: 'move' }] }); continue; }
    if (m.phi >= limits.phiSuspect) { alerts.push({ id: `${m.id}:slow`, machine: m.name, kind: 'slow', text: `${m.name} is answering late (it may be asleep or on a weak network).`, options: [{ label: 'Wait', action: 'wait' }] }); continue; }
    if (!s) continue;
    const over = [];
    const sustained = (k, bad) => {
      m.overSince ??= {};
      if (!bad) { delete m.overSince[k]; return false; }
      m.overSince[k] ??= now;
      return now - m.overSince[k] >= limits.sustainMs;
    };
    if (sustained('load', s.load >= limits.load)) over.push(`CPU ${Math.round(s.load * 100)} %`);
    if (sustained('mem', s.mem >= limits.mem)) over.push(`memory ${Math.round(s.mem * 100)} %`);
    if (s.thermal && s.thermal !== 'nominal') over.push('running hot');
    if (s.battery != null && s.battery <= limits.battery && s.charging === false) over.push(`battery ${Math.round(s.battery * 100)} %`);
    if (s.diskFreeGb != null && s.diskFreeGb < limits.diskGb) over.push(`${s.diskFreeGb} GB disk free`);
    if (over.length) {
      const opts = helpers(m).slice(0, 2).map((h) => ({ label: `Move its ox work to ${h.name}`, action: 'move', to: h.id }));
      alerts.push({ id: `${m.id}:load`, machine: m.name, kind: 'overloaded', text: `${m.name} is under heavy load (${over.join(', ')}).`,
        options: [...opts, { label: 'Use a smaller model there', action: 'smaller' }, { label: 'Pause its ox tasks', action: 'pause' }, { label: 'Check again in 5 minutes', action: 'snooze' }] });
    }
    // Credits: before the plan stops replying, not after.
    for (const p of s.plans ?? []) {
      if ((p.percent ?? 0) < limits.plan) continue;
      const opts = [];
      for (const h of helpers(m).concat(machines.filter((x) => x.id !== m.id && x.stats && !idle.includes(x)))) {
        const local = (h.stats.models ?? [])[0];
        if (local && opts.length < 3) opts.push({ label: `Finish with ${h.name}'s local ${local.name}`, action: 'use-model', model: `mesh:${h.name}/${local.name}` });
        for (const prov of h.stats.providers ?? []) if (opts.length < 3) opts.push({ label: `Use the ${prov} key on ${h.name}`, action: 'use-model', model: `mesh:${h.name}/${prov}` });
      }
      opts.push({ label: `Keep going on ${p.label} (it may stop at the limit)`, action: 'keep' });
      alerts.push({ id: `${m.id}:plan:${p.id ?? p.label}`, machine: m.name, kind: 'credits', text: `${m.name}'s ${p.label} plan is at ${Math.round(p.percent)} % of its ${p.window ?? ''} window.`.replace(/\s+window/, ' window'), options: opts });
    }
  }
  return alerts;
}

// ---------------------------------------------------------------- the node

/**
 * Run this machine's node: listener, LAN beacon, heartbeats to paired
 * machines, the local endpoint for mesh model calls. Returns a handle.
 */
export async function startNode(o = {}) {
  const me = identity(o);
  let port = o.port ?? PORT;
  let proxyPort = o.proxyPort ?? PROXY_PORT;
  const beaconPort = o.beaconPort ?? BEACON_PORT;
  const ollamaUrl = o.ollamaUrl ?? process.env.OX_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const state = { invite: null, machines: new Map(), alerts: [], log: [] };
  const note = (s) => { state.log.push({ at: Date.now(), s }); if (state.log.length > 200) state.log.shift(); o.onLog?.(s); };
  const conns = new Map(); // peer id -> { ch, pending: Map }

  // ---- serving: what this machine answers
  async function serve(ch, peer, msg) {
    const grants = { ...DEFAULT_GRANTS, ...(readPeers(o)[peer.id]?.grants ?? {}) };
    const reply = (data) => ch.send({ t: 'res', rid: msg.rid, ok: true, data });
    const refuse = (why) => ch.send({ t: 'res', rid: msg.rid, ok: false, error: why });
    if (msg.op === 'ping') return reply({ name: me.name, at: Date.now() });
    if (msg.op === 'stats') { if (!grants.status) return refuse('status is not allowed'); return reply(await stats({ ollamaUrl, runs: o.runs?.() ?? 0, plans: (await o.plans?.()) ?? null })); }
    if (msg.op === 'infer') {
      if (!grants.infer) return refuse(`${me.name} does not allow model calls from ${peer.name}: on ${me.name}, run  ox mesh allow "${peer.name}" infer`);
      return infer(ch, msg, refuse);
    }
    if (msg.op === 'run') {
      if (!grants.tasks) return refuse(`${me.name} does not allow tasks from ${peer.name}: on ${me.name}, run  ox mesh allow "${peer.name}" tasks`);
      return runTask(ch, msg, refuse);
    }
    // The machine's makeup, its agent sessions, its shared folders (src/mesh-services.js).
    const S = await import('./mesh-services.js');
    const roots = readPeers(o)[peer.id]?.roots ?? [os.homedir()];
    if (await S.serveOp({ ch, peer, msg, grants, roots, home: home(o), ollamaUrl, meName: me.name, remoteControl: o.remoteControl })) return;
    refuse(`unknown request ${msg.op}`);
  }

  // A model call on this machine: its Ollama models, or a provider it holds a key for.
  async function infer(ch, msg, refuse) {
    const body = msg.args?.body ?? {};
    const model = String(body.model ?? '');
    let url, headers = { 'content-type': 'application/json' };
    const local = await localModels(ollamaUrl);
    if (local.includes(model) || local.includes(`${model}:latest`)) {
      url = `${ollamaUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    } else {
      try {
        const { resolveBot } = await import('./bots.js');
        const { readConfigDoc } = await import('./config.js');
        const t = resolveBot(model, readConfigDoc());
        if (!t.baseUrl) return refuse(`${model} has no OpenAI-compatible endpoint on ${me.name}`);
        const key = t.keyEnv ? (process.env[t.keyEnv] ?? readKey(t.keyEnv)) : null;
        if (t.keyEnv && !key) return refuse(`${me.name} has no key for ${model}`);
        url = `${t.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        if (key) headers.authorization = `Bearer ${key}`;
        body.model = t.model;
      } catch (e) { return refuse(`${me.name} cannot run ${model}: ${e.message}`); }
    }
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60_000) });
      ch.send({ t: 'head', rid: msg.rid, status: r.status, type: r.headers.get('content-type') ?? 'application/json' });
      const reader = r.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        ch.send({ t: 'chunk', rid: msg.rid, data: b64(value) });
      }
      ch.send({ t: 'res', rid: msg.rid, ok: true, data: { done: true } });
    } catch (e) { refuse(`${me.name}: ${e.message}`); }
  }

  // A whole ox task on this machine, under its own approval settings.
  function runTask(ch, msg, refuse) {
    const cwd = msg.args?.cwd ? path.resolve(msg.args.cwd) : os.homedir();
    if (!fs.existsSync(cwd)) return refuse(`${cwd} does not exist on ${me.name}`);
    const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');
    const p = spawn(process.execPath, [bin, '-p', String(msg.args?.prompt ?? '')], { cwd, env: { ...process.env, OX_SURFACE: 'mesh' }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => ch.send({ t: 'chunk', rid: msg.rid, data: b64(d) }));
    p.stderr.on('data', (d) => ch.send({ t: 'chunk', rid: msg.rid, data: b64(d) }));
    p.on('close', (code) => ch.send({ t: 'res', rid: msg.rid, ok: code === 0, data: { code }, error: code === 0 ? null : `exit ${code}` }));
  }

  // ---- the listener
  const failures = { count: 0 };
  const incoming = new Set();
  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    incoming.add(sock);
    sock.on('close', () => incoming.delete(sock));
    let stage = 'hello', theirs = null, ch = null, mine = null, mode = 'auth';
    const eph = crypto.generateKeyPairSync('x25519');
    const ephRaw = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    // After the hello the client reads sealed frames only, so a refusal is sealed too.
    const drop = (why) => { try { if (ch) ch.send({ t: 'refused', why }); else sock.write(`${JSON.stringify({ t: 'refused', why })}\n`); } catch {} sock.end(); };
    sock.on('error', () => {});
    lines(sock, (line) => {
      try {
        if (stage === 'hello') {
          const m = JSON.parse(line);
          if (m.t !== 'hello' || m.v !== VERSION) return drop('not an ox mesh client');
          const pub = unb64(m.pub);
          if (idOf(pub) !== m.id) return drop('id does not match key');
          mode = m.mode === 'pair' ? 'pair' : 'auth';
          const known = readPeers(o)[m.id];
          if (mode === 'auth' && (!known || known.pub !== m.pub)) return drop('not a paired machine');
          if (mode === 'pair' && !(state.invite && Date.now() < state.invite.expires)) return drop('no invite is open on this machine');
          theirs = { id: m.id, pub: m.pub, eph: m.eph, name: String(m.name ?? '').slice(0, 40), port: Number(m.port) || PORT };
          mine = { id: me.id, pub: b64(me.pub), eph: b64(ephRaw) };
          const T = transcript(mine, theirs);
          const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), unb64(m.eph)]), format: 'der', type: 'spki' }) });
          const [sk, rk] = sessionKeys(shared, me, theirs, false);
          ch = new Sealed(sock, sk, rk);
          ch.T = T;
          sock.write(`${JSON.stringify({ t: 'hello', v: VERSION, id: mine.id, pub: mine.pub, eph: mine.eph, name: me.name, sig: b64(crypto.sign(null, T, me.priv)) })}\n`);
          stage = 'auth';
          return;
        }
        if (stage === 'open') {
          let msg;
          try { msg = ch.open(line); } catch { sock.destroy(); return; }
          for (const h of ch.handlers) h(msg);
          return;
        }
        const m = ch.open(line);
        if (stage === 'auth') {
          if (m.t !== 'auth' || !crypto.verify(null, ch.T, pubFromRaw(unb64(theirs.pub)), unb64(m.sig))) return drop('signature does not check');
          if (mode === 'pair') {
            const want = crypto.createHmac('sha256', state.invite.code).update('C').update(ch.T).digest();
            if (!m.mac || !crypto.timingSafeEqual(want, unb64(m.mac))) {
              state.invite.tries = (state.invite.tries ?? 0) + 1;
              if (state.invite.tries >= 3) { note('invite closed after 3 wrong codes'); state.invite = null; }
              return drop('wrong code');
            }
            const name = String(m.name ?? theirs.name ?? 'machine').slice(0, 40);
            pin({ id: theirs.id, pub: theirs.pub, name, addr: `${sock.remoteAddress?.replace(/^::ffff:/, '')}:${theirs.port}` }, o);
            const mac = b64(crypto.createHmac('sha256', state.invite.code).update('S').update(ch.T).digest());
            state.invite = null;
            note(`paired with ${name}`);
            ch.send({ t: 'welcome', name: me.name, mac });
            o.onPaired?.({ id: theirs.id, name });
          } else {
            ch.send({ t: 'welcome', name: me.name });
          }
          stage = 'open';
          const peer = { id: theirs.id, name: readPeers(o)[theirs.id]?.name ?? theirs.name };
          ch.handlers.add((msg) => { if (msg.t === 'req') serve(ch, peer, msg).catch((e) => ch.send({ t: 'res', rid: msg.rid, ok: false, error: e.message })); });
        }
      } catch (e) { drop(e.message); }
    });
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, o.host ?? '0.0.0.0', res); });
  port = server.address().port; // port 0 picks a free one (tests)

  // ---- asking a paired machine
  async function channel(peer) {
    const have = conns.get(peer.id);
    if (have && !have.ch.sock.destroyed) return have;
    const [host, p] = String(peer.addr ?? '').split(':');
    if (!host) throw new Error(`no address for ${peer.name} yet (it announces itself on the network, or pair with --at)`);
    const { ch } = await connect({ host, port: Number(p) || PORT, me, mode: 'auth', expect: peer, myPort: port });
    const entry = { ch, pending: new Map() };
    ch.handlers.add((msg) => {
      const w = entry.pending.get(msg.rid);
      if (!w) return;
      if (msg.t === 'head') w.onHead?.(msg);
      else if (msg.t === 'chunk') w.onChunk?.(unb64(msg.data));
      else if (msg.t === 'res') { entry.pending.delete(msg.rid); msg.ok ? w.resolve(msg.data) : w.reject(new Error(msg.error)); }
    });
    ch.sock.on('close', () => { conns.delete(peer.id); for (const w of entry.pending.values()) w.reject(new Error(`${peer.name} closed the connection`)); });
    conns.set(peer.id, entry);
    return entry;
  }

  async function ask(ref, op, args = {}, { onHead, onChunk, timeoutMs = 15_000 } = {}) {
    const peer = typeof ref === 'object' ? ref : findPeer(ref, o);
    if (!peer) throw new Error(`no paired machine ${ref}`);
    const e = await channel(peer);
    const rid = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const t = timeoutMs ? setTimeout(() => { e.pending.delete(rid); reject(new Error(`${peer.name} did not answer`)); }, timeoutMs) : null;
      e.pending.set(rid, { resolve: (d) => { clearTimeout(t); resolve(d); }, reject: (er) => { clearTimeout(t); reject(er); }, onHead, onChunk: (c) => { if (t) t.refresh(); onChunk?.(c); } });
      e.ch.send({ t: 'req', rid, op, args });
    });
  }

  // ---- heartbeats: pull each machine's health, keep φ
  async function heartbeat() {
    for (const peer of Object.values(readPeers(o))) {
      const m = state.machines.get(peer.id) ?? { id: peer.id, name: peer.name, detector: new Phi(), stats: null };
      m.name = peer.name;
      state.machines.set(peer.id, m);
      try { m.stats = await ask(peer, 'stats', {}, { timeoutMs: 4000 }); m.detector.beat(); m.error = null; }
      catch (e) { m.error = e.message; }
    }
    const list = [...state.machines.values()].map((m) => ({ ...m, phi: m.detector.phi() }));
    const selfStats = await stats({ ollamaUrl, runs: o.runs?.() ?? 0, plans: (await o.plans?.()) ?? null });
    state.self = selfStats;
    state.snoozed ??= {};
    state.alerts = watchdog([{ id: me.id, name: me.name, stats: selfStats, phi: 0, overSince: state.selfOver ??= {} }, ...list])
      .filter((x) => !(state.snoozed[x.id] > Date.now()));
    o.onAlerts?.(state.alerts);
  }
  const hb = o.heartbeat === false ? null : setInterval(() => { heartbeat().catch(() => {}); }, o.heartbeatMs ?? HEARTBEAT_MS);
  hb?.unref?.();

  // ---- LAN beacon: paired machines find each other's current address
  let beacon = null;
  if (o.beacon !== false) {
    beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    beacon.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        if (m.ox !== 'mesh' || m.id === me.id) return;
        state.seen ??= new Map();
        state.seen.set(m.id, { id: m.id, name: m.name, addr: `${rinfo.address}:${m.port}`, invite: !!m.invite, at: Date.now() });
        const peers = readPeers(o);
        if (peers[m.id] && peers[m.id].addr !== `${rinfo.address}:${m.port}`) { peers[m.id].addr = `${rinfo.address}:${m.port}`; writePeers(peers, o); }
      } catch {}
    });
    beacon.on('error', () => {});
    await new Promise((res) => beacon.bind(beaconPort, () => { try { beacon.setBroadcast(true); } catch {} res(); }));
    const announce = () => {
      const msg = Buffer.from(JSON.stringify({ ox: 'mesh', v: VERSION, id: me.id, name: me.name, port, invite: !!(state.invite && Date.now() < state.invite.expires) }));
      // macOS refuses 255.255.255.255 (EHOSTUNREACH): each network's own broadcast address works everywhere.
      for (const addr of broadcastAddrs()) beacon.send(msg, beaconPort, addr, () => {});
    };
    state.beaconTimer = setInterval(announce, 3000); state.beaconTimer.unref?.();
    announce();
  }

  // ---- the local endpoint: mesh:<machine>/<model> model calls from this machine's ox
  const proxy = http.createServer(async (req, res) => {
    // Loopback only, and never a web page: a page cannot set the Host to
    // 127.0.0.1 (DNS rebinding), send JSON or a custom header cross-site
    // without a preflight this server never answers.
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(req.headers.host ?? ''));
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    // A dev server on a paired machine (src/mesh-dev.js): /dev/<machine>/<port>/<path>.
    const dev = /^\/dev\/([^/]+)\/(\d{2,5})(\/.*)?$/.exec(req.url ?? '');
    if (local && dev) {
      const peer = findPeer(decodeURIComponent(dev[1]), o);
      if (!peer) return json(404, { error: { message: `no paired machine ${decodeURIComponent(dev[1])}` } });
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', async () => {
        let started = false;
        const body = chunks.length ? Buffer.concat(chunks).toString('base64') : null;
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(host|cookie|authorization)$/i.test(k)));
        try {
          await ask(peer, 'http', { port: Number(dev[2]), method: req.method, path: dev[3] || '/', headers, body }, {
            timeoutMs: 60_000,
            onHead: (h) => { started = true; let hs = {}; try { hs = JSON.parse(h.type); } catch {} delete hs['content-length']; res.writeHead(h.status, hs); },
            onChunk: (c) => { if (!started) { started = true; res.writeHead(200); } res.write(c); },
          });
          res.end();
        } catch (e) { if (!started) json(/does not allow|not a dev server/.test(e.message) ? 403 : 502, { error: { message: e.message } }); else res.end(); }
      });
      return;
    }
    if (!local || (req.method === 'POST' && !/^application\/json/i.test(String(req.headers['content-type'] ?? '')))) { res.writeHead(404).end(); return; }
    const ctl = /^\/mesh-control\/(status|invite|heartbeat)\/?$/.exec(req.url ?? '');
    if (ctl) {
      if (req.headers['x-ox-mesh'] !== '1') { res.writeHead(404).end(); return; }
      try {
        if (ctl[1] === 'invite') return json(200, handle.invite());
        if (ctl[1] === 'heartbeat') await heartbeat();
        return json(200, handle.status());
      } catch (e) { return json(500, { error: { message: e.message } }); }
    }
    const m = /^\/mesh\/([^/]+)\/v1\/(chat\/completions|models)\/?$/.exec(req.url ?? '');
    if (!m) { res.writeHead(404).end(); return; }
    const peer = findPeer(decodeURIComponent(m[1]), o);
    if (!peer) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `no paired machine ${m[1]}` } })); return; }
    if (m[2] === 'models') {
      try { const s = await ask(peer, 'stats'); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: s.models.map((x) => ({ id: x.name, object: 'model' })) })); }
      catch (e) { res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: e.message } })); }
      return;
    }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      let started = false;
      try {
        await ask(peer, 'infer', { body }, {
          timeoutMs: 120_000,
          onHead: (h) => { started = true; res.writeHead(h.status, { 'content-type': h.type }); },
          onChunk: (c) => { if (!started) { started = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); } res.write(c); },
        });
        res.end();
      } catch (e) {
        // A refusal (no grant, no key, no such model) is final: 403 so the caller does not retry it.
        if (!started) json(/does not allow|has no key|cannot run|has no OpenAI|no paired machine/.test(e.message) ? 403 : 502, { error: { message: e.message } });
        else res.end();
      }
    });
  });
  // Another node may already hold the endpoint (a second ox on this machine); calls still work through that one.
  await new Promise((res) => { proxy.once('error', () => { proxyPort = null; res(); }); proxy.listen(proxyPort, '127.0.0.1', () => { proxyPort = proxy.address().port; res(); }); });

  const handle = {
    me, get port() { return port; }, get proxyPort() { return proxyPort; }, state, ask,
    /** Everything the CLI, the app and the island show. Keys never appear here. */
    status() {
      const machines = handle.machines();
      return {
        me: { id: me.id, name: identity(o).name, port, proxyPort },
        self: state.self ?? null,
        peers: Object.values(readPeers(o)).map((p) => ({ id: p.id, name: p.name, addr: p.addr ?? null, grants: p.grants, pairedAt: p.pairedAt, live: machines.find((x) => x.id === p.id) ?? null })),
        alerts: state.alerts,
        invite: state.invite && Date.now() < state.invite.expires ? { open: true, expires: state.invite.expires } : { open: false },
        seen: [...(state.seen?.values() ?? [])].filter((x) => Date.now() - x.at < 15_000 && !readPeers(o)[x.id]),
      };
    },
    /** The owner's choice on an alert. Only this runs anything, and only what it names. */
    choose(alertId, option = {}) {
      const a = state.alerts.find((x) => x.id === alertId);
      if (!a) throw new Error('that alert is gone (the condition passed)');
      if (option.action === 'snooze' || option.action === 'wait') { state.snoozed ??= {}; state.snoozed[alertId] = Date.now() + 5 * 60_000; state.alerts = state.alerts.filter((x) => x.id !== alertId); return { done: 'checking again in 5 minutes' }; }
      if (option.action === 'use-model' || option.action === 'keep') { state.snoozed ??= {}; state.snoozed[alertId] = Date.now() + 30 * 60_000; state.alerts = state.alerts.filter((x) => x.id !== alertId); return { model: option.model ?? null, done: option.model ? `next turns use ${option.model}` : 'keeping the current model' }; }
      return { done: null, note: 'do this one yourself for now: ox does not move, pause or shrink work on its own' };
    },
    invite() { state.invite = { code: normCode(newCode()), expires: Date.now() + INVITE_MS, tries: 0 }; const c = state.invite.code; return { code: `OX-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`, expires: state.invite.expires }; },
    heartbeat,
    machines: () => [...state.machines.values()].map((m) => ({ id: m.id, name: m.name, stats: m.stats, phi: Math.round(m.detector.phi() * 10) / 10, error: m.error ?? null })),
    async close() {
      clearInterval(hb); clearInterval(state.beaconTimer);
      for (const c of conns.values()) c.ch.sock.destroy();
      // Machines connected to this one: ended too, or server.close() waits for them forever.
      for (const sk of incoming) sk.destroy();
      await Promise.all([new Promise((r) => server.close(() => r())), new Promise((r) => (proxy.listening ? proxy.close(() => r()) : r()))]);
      try { beacon?.close(); } catch {}
    },
  };
  return handle;
}

/** The most-used window of each plan (as the island's gauges read it), for heartbeats. */
export async function planHeadroom() {
  try {
    const P = await import('./plan-usage.js');
    return P.planUsage().filter(Boolean).map((p) => {
      const w = (p.windows ?? []).reduce((a, b) => ((b.usedPercent ?? 0) > (a?.usedPercent ?? -1) ? b : a), null);
      return w ? { id: p.id, label: p.id === 'codex' ? 'ChatGPT' : 'Claude', percent: w.usedPercent ?? 0, window: w.name } : null;
    }).filter(Boolean);
  } catch { return []; }
}

/** A node already running on this machine (the app's or `ox mesh up`), through its loopback control. */
export async function control(what, { proxyPort = PROXY_PORT, method = 'GET', timeoutMs = 3000 } = {}) {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/mesh-control/${what}`, {
    method, headers: { 'x-ox-mesh': '1', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? `mesh control ${r.status}`);
  return j;
}

/** The broadcast address of every IPv4 network this machine is on (10.0.0.255 …), plus the limited one. */
function broadcastAddrs() {
  const out = new Set();
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal || !i.netmask) continue;
    const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
    out.add(ip.map((x, j) => (x & m[j]) | (~m[j] & 255)).join('.'));
  }
  out.add('255.255.255.255');
  return [...out];
}

async function localModels(ollamaUrl) {
  try {
    const r = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? ((await r.json()).models ?? []).map((m) => m.name) : [];
  } catch { return []; }
}

function readKey(name) {
  try { return JSON.parse(fs.readFileSync(path.join(home(), 'keys.json'), 'utf8'))[name] ?? null; } catch { return null; }
}

/** Join a machine that has an invite open: pair with its code. */
export async function join({ code, at = null, name = null, o = {}, wait = 15_000, beaconPort = BEACON_PORT, myPort = PORT }) {
  const me = identity(o);
  if (name) setName(name, o);
  let target = at;
  if (!target) {
    // Find a machine announcing an open invite on this network.
    target = await new Promise((resolve) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const done = (v) => { try { s.close(); } catch {} resolve(v); };
      const t = setTimeout(() => done(null), wait);
      s.on('message', (buf, rinfo) => {
        try { const m = JSON.parse(buf.toString('utf8')); if (m.ox === 'mesh' && m.invite && m.id !== me.id) { clearTimeout(t); done(`${rinfo.address}:${m.port}`); } } catch {}
      });
      s.on('error', () => done(null));
      s.bind(beaconPort);
    });
    if (!target) throw new Error('no machine with an open invite found on this network: run  ox mesh invite  on it, or add --at <its address:port> (for another network, its Tailscale address)');
  }
  const [host, p] = String(target).split(':');
  const { peer, ch } = await connect({ host, port: Number(p) || PORT, me: identity(o), mode: 'pair', code, myName: identity(o).name, myPort });
  ch.sock.destroy();
  pin({ ...peer, addr: `${host}:${Number(p) || PORT}` }, o);
  return peer;
}
