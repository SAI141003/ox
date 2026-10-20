// OX on your iPhone (Coucou's lock-screen approvals): the phone app reads the
// approvals waiting on this Mac and answers them, over your own network.
//
// Pairing: `ox phone pair` makes a random 256-bit key for one phone and shows
// it once, in a link you open on the phone (oxphone://host:port/<id>#<key>).
// The key never travels over the network. Every request and every reply is
// sealed with AES-256-GCM under that key, carries a time and a fresh nonce
// (a replayed or stale message is refused), and a sender that keeps failing is
// shut out for a while. The phone can do two things: read what is waiting
// (approvals, sessions) and answer an approval. Nothing else is reachable.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const PORT = 47890;
const SKEW_MS = 120_000;

const file = (home) => path.join(home ?? process.env.OX_HOME ?? path.join(os.homedir(), '.ox'), 'phone.json');
const b64u = (b) => Buffer.from(b).toString('base64url');

export function readDevices({ home } = {}) {
  try { return JSON.parse(fs.readFileSync(file(home), 'utf8')).devices ?? []; } catch { return []; }
}
function writeDevices(devices, { home } = {}) {
  const f = file(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}

/** This Mac's address on the local network (the first non-internal IPv4). */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

/** A new phone: its id, its key (shown once) and the link to open on it. */
export function pairDevice(name = 'iPhone', { home, host = lanAddress(), port = PORT } = {}) {
  const id = b64u(crypto.randomBytes(6));
  const key = crypto.randomBytes(32);
  const devices = readDevices({ home }).concat({ id, name: String(name).slice(0, 40), key: key.toString('base64'), added: new Date().toISOString() });
  writeDevices(devices, { home });
  return { id, name, link: `oxphone://${host}:${port}/${id}#${b64u(key)}` };
}

export function forgetDevice(id, { home } = {}) {
  const all = readDevices({ home });
  const left = all.filter((d) => d.id !== id && d.name.toLowerCase() !== String(id).toLowerCase());
  writeDevices(left, { home });
  return all.length - left.length;
}

/** AES-256-GCM: { n: nonce, c: ciphertext + tag } (CryptoKit's combined box is n + c). */
export function seal(key, obj) {
  const n = crypto.randomBytes(12);
  const ci = crypto.createCipheriv('aes-256-gcm', key, n);
  const body = Buffer.concat([ci.update(JSON.stringify(obj), 'utf8'), ci.final(), ci.getAuthTag()]);
  return { n: n.toString('base64'), c: body.toString('base64') };
}
export function open(key, { n, c }) {
  const raw = Buffer.from(String(c), 'base64');
  if (raw.length < 17) throw new Error('short');
  const de = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(n), 'base64'));
  de.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([de.update(raw.subarray(0, raw.length - 16)), de.final()]).toString('utf8'));
}

/**
 * The phone's endpoint. `watcher` is the run watcher (src/island-web.js): what
 * the island sees, and the way to answer. → { server, port, close }
 */
export async function startPhoneBridge({ port = PORT, host = '0.0.0.0', home, watcher = null, now = () => Date.now() } = {}) {
  const W = watcher ?? (await import('./island-web.js')).createRunWatcher();
  const seen = new Map(); // nonce -> time (replays)
  const strikes = new Map(); // address -> { n, until }
  const scanTimer = setInterval(() => { try { W.scan(); } catch {} }, 1500);
  scanTimer.unref?.();
  try { W.scan(); } catch {}

  const handle = async (req, res) => {
    const addr = req.socket.remoteAddress ?? '?';
    const strike = strikes.get(addr);
    if (strike && strike.until > now()) { res.writeHead(429).end(); return; }
    const fail = (code = 403) => {
      const s = strikes.get(addr) ?? { n: 0, until: 0 };
      s.n += 1; if (s.n >= 20) { s.until = now() + 10 * 60_000; s.n = 0; }
      strikes.set(addr, s);
      res.writeHead(code).end();
    };
    if (req.method !== 'POST' || req.url !== '/v1') { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const d of req) { raw += d; if (raw.length > 64 * 1024) { fail(413); return; } }
    let env;
    try { env = JSON.parse(raw); } catch { fail(400); return; }
    const dev = readDevices({ home }).find((d) => d.id === env.id);
    if (!dev) { fail(); return; }
    const key = Buffer.from(dev.key, 'base64');
    let msg;
    try { msg = open(key, env); } catch { fail(); return; }
    if (typeof msg.ts !== 'number' || Math.abs(now() - msg.ts) > SKEW_MS) { fail(); return; }
    if (seen.has(env.n)) { fail(); return; }
    seen.set(env.n, now());
    if (seen.size > 5000) for (const [k, t] of seen) if (now() - t > SKEW_MS * 2) seen.delete(k);
    strikes.delete(addr);
    let out;
    if (msg.op === 'state') {
      const runs = W.snapshot();
      out = {
        mac: os.hostname().replace(/\.local$/, ''),
        approvals: runs.flatMap((r) => r.approvals.map((a) => ({ socket: r.socket, id: a.id, tool: a.tool, preview: a.preview, project: r.project }))),
        sessions: runs.map((r) => ({ project: r.project, activity: r.activity, phase: r.phase })),
      };
    } else if (msg.op === 'answer') {
      const decision = String(msg.args?.decision ?? '');
      if (!['allow', 'deny', 'always'].includes(decision)) { out = { ok: false, error: 'allow, deny or always' }; }
      else out = { ok: !!W.answer(String(msg.args?.socket ?? ''), String(msg.args?.id ?? ''), decision) };
    } else out = { ok: false, error: 'unknown request' };
    const body = JSON.stringify(seal(key, { ts: now(), ...out }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  };

  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch {} }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    server,
    port: server.address().port,
    close: () => new Promise((r) => { clearInterval(scanTimer); try { W.close?.(); } catch {} server.close(() => r()); }),
  };
}
