// The whole app on your phone: chats, steering a running one, approvals, Studio, Office.
//
//   ox phone web     prints a link and a QR code; open it once on the phone, then bookmark it
//
// A small door in front of the app's server, which itself stays on 127.0.0.1 with no key. The
// link holds a long random key that becomes an HttpOnly cookie; nothing passes without it, and
// repeated wrong tries lock that address out. Whoever has the key can run anything ox can, so
// show the link to nobody. Traffic is plain HTTP: fine on your own Wi-Fi, encrypted over
// Tailscale, and it should not be exposed to the internet. `--new-key` revokes old links.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const PORT = 47891;
const COOKIE = 'ox_phone';
const STATE = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'phone-web.json');

export function phoneKey({ fresh = false, env = process.env } = {}) {
  if (!fresh) { try { const k = JSON.parse(fs.readFileSync(STATE(env), 'utf8')).key; if (typeof k === 'string' && k.length >= 32) return k; } catch {} }
  const key = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(STATE(env)), { recursive: true });
  fs.writeFileSync(STATE(env), JSON.stringify({ key }), { mode: 0o600 });
  try { fs.chmodSync(STATE(env), 0o600); } catch {}
  return key;
}

/** The app's own address on this machine. */
export function appTarget({ env = process.env } = {}) {
  const home = env.OX_HOME || path.join(os.homedir(), '.ox');
  for (const name of ['app.json', 'serve.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));
      try { process.kill(j.pid, 0); } catch { continue; }
      if (j.port) return { host: '127.0.0.1', port: Number(j.port) };
    } catch {}
  }
  return null;
}

/** Addresses a phone could use: Wi-Fi first, then Tailscale (100.64/10). */
export function phoneAddresses(ifaces = os.networkInterfaces()) {
  const all = Object.values(ifaces).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
  const ts = all.filter((a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a));
  return [...all.filter((a) => !ts.includes(a)), ...ts];
}

const same = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
const cookieOf = (req) => { for (const part of String(req.headers.cookie ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE) return v.join('='); } return null; };

export async function startPhoneWeb({ key, target, port = PORT, host = '0.0.0.0', now = () => Date.now(), maxStrikes = 10 } = {}) {
  const strikes = new Map();
  const blocked = (addr) => (strikes.get(addr)?.until ?? 0) > now();
  const strike = (addr) => { const s = strikes.get(addr) ?? { n: 0, until: 0 }; s.n += 1; if (s.n >= maxStrikes) { s.until = now() + 10 * 60_000; s.n = 0; } strikes.set(addr, s); };
  const deny = (res, code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text); };
  const server = http.createServer((req, res) => {
    const addr = req.socket.remoteAddress ?? '?';
    if (blocked(addr)) return deny(res, 429, 'Too many wrong tries. Wait ten minutes.');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/pair') {
      if (same(url.searchParams.get('key') ?? '', key)) {
        strikes.delete(addr);
        res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      }
      strike(addr);
      return deny(res, 403, 'That link is not valid. Make a new one on your computer: ox phone web');
    }
    const c = cookieOf(req);
    if (!c || !same(c, key)) {
      strike(addr);
      return deny(res, 401, 'Open the link from your computer first: ox phone web');
    }
    // SameSite=Strict keeps other sites' forms out; this says so for anything that slips by.
    const origin = req.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let o = null;
      try { o = new URL(origin).host; } catch {}
      if (o !== req.headers.host) return deny(res, 403, 'Requests from other sites are refused.');
    }
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    delete headers.origin;
    delete headers.cookie;
    delete headers.referer;
    const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) deny(res, 502, 'ox is not running on your computer. Open it, then reload.'); else res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    req.pipe(up);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
