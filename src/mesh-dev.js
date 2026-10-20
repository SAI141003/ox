// Dev servers on your other machines (Tesser's idea, on machines you own: no
// cloud bill). With the "dev" grant, a paired machine may start a project's
// OWN dev command (its saved recipe, else package.json dev/start, else a plain
// file server for a static site) in a folder it shares, and then read pages
// from the ports this module started, and only those: the mesh never becomes
// a way into anything else running on that machine.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { shellArgv } from './shell.js';

const running = new Map(); // port → { port, pid, dir, command, started, child?, server?, log }

/** A port nothing listens on (loopback). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** How this project starts: { command } from its recipe or package.json, { static } for a plain site, null when unknown. */
export async function devCommand(dir) {
  const { readRecipe, detectRecipe } = await import('./dev-flow.js');
  const start = readRecipe(dir)?.start ?? detectRecipe(dir).start;
  if (start) return { command: start };
  if (fs.existsSync(path.join(dir, 'index.html'))) return { static: true };
  return null;
}

// Most dev servers read PORT; Vite and Next want a flag. The port is told both ways when the script names them.
export function withPort(command, port, pkgScripts = {}) {
  const script = /\b(?:npm run|pnpm|yarn|bun)\s+(dev|start)\b/.exec(command)?.[1];
  const body = String(pkgScripts[script] ?? command);
  if (/\bvite\b/.test(body)) return `${command}${/^npm run/.test(command) ? ' --' : ''} --port ${port} --strictPort --host 127.0.0.1`;
  if (/\bnext\s+dev\b/.test(body)) return `${command}${/^npm run/.test(command) ? ' --' : ''} -p ${port} -H 127.0.0.1`;
  return command;
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

/** A file server for a static site, loopback only, never outside `dir`. */
function staticServer(dir, port) {
  const root = fs.realpathSync(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.resolve(root, `.${p}`);
    let real;
    try { real = fs.realpathSync(f); } catch { res.writeHead(404).end('not found'); return; }
    if (real !== root && !real.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(real).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(real).pipe(res);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}

const answers = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

/** Start the project's dev server on a free port; resolves once the port answers. */
export async function startDev(dir, { waitMs = 60_000, env = process.env } = {}) {
  const how = await devCommand(dir);
  if (!how) throw new Error(`no way to start ${path.basename(dir)}: no recipe start step, no dev or start script, no index.html`);
  for (const r of running.values()) if (r.dir === dir) return describe(r);
  const port = await freePort();
  const started = Date.now();
  if (how.static) {
    const server = await staticServer(dir, port);
    const r = { port, pid: process.pid, dir, command: 'static files', started, server, log: '' };
    running.set(port, r);
    return describe(r);
  }
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}; } catch {}
  const command = withPort(how.command, port, scripts);
  const argv = shellArgv(command);
  const child = spawn(argv[0], argv.slice(1), { cwd: dir, env: { ...env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const r = { port, pid: child.pid, dir, command, started, child, log: '' };
  const keep = (d) => { r.log = (r.log + d).slice(-4000); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  child.on('exit', () => running.delete(port));
  running.set(port, r);
  while (Date.now() - started < waitMs) {
    if (await answers(port)) return describe(r);
    if (child.exitCode !== null) throw new Error(`the dev server stopped: ${r.log.trim().split('\n').slice(-2).join(' ') || `exit ${child.exitCode}`}`);
    await new Promise((res) => setTimeout(res, 400));
  }
  stopDev(port);
  throw new Error(`the dev server did not answer on port ${port} within ${Math.round(waitMs / 1000)} s`);
}

const describe = (r) => ({ port: r.port, pid: r.pid, dir: r.dir, command: r.command, started: r.started });

export function stopDev(port) {
  const r = running.get(Number(port));
  if (!r) return false;
  running.delete(r.port);
  if (r.server) r.server.close();
  else { try { process.kill(process.platform === 'win32' ? r.pid : -r.pid, 'SIGTERM'); } catch { try { r.child.kill('SIGTERM'); } catch {} } }
  return true;
}

export const listDev = () => [...running.values()].map(describe);
export const isDevPort = (port) => running.has(Number(port));

/**
 * One HTTP request to a dev server this module started, the response streamed
 * back: onHead({ status, headers }), onChunk(Buffer). Any other port is refused.
 */
export function forward({ port, method = 'GET', path: p = '/', headers = {}, body = null }, { onHead, onChunk }) {
  if (!isDevPort(port)) return Promise.reject(new Error(`port ${port} is not a dev server started through ox`));
  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(host|connection|upgrade|proxy-|te$|trailer|transfer-encoding|keep-alive)/i.test(k)));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(port), method, path: String(p).startsWith('/') ? p : `/${p}`, headers: { ...clean, host: `127.0.0.1:${port}` } }, (res) => {
      onHead?.({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => !/^(connection|transfer-encoding|keep-alive)$/i.test(k))) });
      res.on('data', (d) => onChunk?.(d));
      res.on('end', () => resolve({ done: true }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(Buffer.from(body, 'base64'));
    req.end();
  });
}
