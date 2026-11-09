// agent-desktop (vercel-labs/agent-desktop, Apache-2.0) as ox's desktop hand
// when it is installed (`ox desktop install`): it reads and operates
// apps through the accessibility tree on macOS, Windows and Linux, headless by
// default (no pointer moved, no focus taken), so ox can work in an app while you
// keep using the Mac, and several agents can act at once.
//
// ox keeps its own rules on top (src/mac-control.js): a Send / Pay / Delete-like
// control is never pressed, Return is never pressed, every act asks first. This
// module only turns its JSON envelopes into the element list those rules read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// The release ox installs by itself (ox desktop install). Pinned: a new version comes
// with a new ox, and each file must match the digest GitHub published for it.
export const AGENT_DESKTOP_VERSION = '1.1.0';
export const AGENT_DESKTOP_FILES = Object.freeze({
  'darwin-arm64': ['aarch64-apple-darwin', '3048e00aa0741bf25ffe0326f78c966408be4490ce13513f3f94ecf2a0b5270d'],
  'darwin-x64': ['x86_64-apple-darwin', 'b6352ac66aa49e0280c6f690de791dc03c827623a838950856b20ddbebcdc382'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '252c17e271a444352a5ba1e9f8fcbace89fa7b6b0bfcc4abebad2b35eb1f7a4d'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'efbdcf4caf10132e4fe915db1ec643184c947c65e0511845aeb4839445d7ea43'],
  'win32-arm64': ['aarch64-pc-windows-msvc', '20e2a2a029bc7e86aaacf2003afa78708d66e4cb51f3c216597e1f5d79d496bf'],
  'win32-x64': ['x86_64-pc-windows-msvc', '5c13b932add079c141da18631d65b1680d1b9bcb73942f2f99146c9ee13877f6'],
});
const oxHome = (env) => env.OX_HOME || path.join(os.homedir(), '.ox');
const vendorDir = (env) => path.join(oxHome(env), 'vendor', 'agent-desktop', AGENT_DESKTOP_VERSION);
function vendoredBin(env) {
  const walk = (d, depth) => {
    let rows = [];
    try { rows = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of rows) if (e.isFile() && /^agent-desktop(\.exe)?$/.test(e.name)) return path.join(d, e.name);
    if (depth < 3) for (const e of rows) if (e.isDirectory()) { const f = walk(path.join(d, e.name), depth + 1); if (f) return f; }
    return null;
  };
  return walk(vendorDir(env), 0);
}

/**
 * Download this machine's release from vercel-labs/agent-desktop, refuse it unless
 * its SHA-256 is the pinned one, and unpack it into ~/.ox/vendor. It runs nothing.
 * The OS then asks for Accessibility the first time it is used. → { bin, version }
 */
export async function installAgentDesktop({ env = process.env, platform = process.platform, arch = process.arch, fetchImpl = fetch, unpack = null } = {}) {
  const pick = AGENT_DESKTOP_FILES[`${platform}-${arch}`];
  if (!pick) throw new Error(`no agent-desktop release for ${platform} ${arch}`);
  const name = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${pick[0]}.tar.gz`;
  const r = await fetchImpl(`https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${name}`, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!r.ok) throw new Error(`download failed (${r.status}) for ${name}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== pick[1]) throw new Error(`${name} does not match its published checksum; nothing was installed`);
  const dest = vendorDir(env);
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(dest, name);
  fs.writeFileSync(file, bytes);
  const done = (unpack ?? ((f, d) => spawnSync('tar', ['-xzf', f, '-C', d], { encoding: 'utf8' })))(file, dest);
  fs.rmSync(file, { force: true });
  if (done?.status && done.status !== 0) throw new Error('could not unpack agent-desktop');
  const bin = vendoredBin(env);
  if (!bin) throw new Error('agent-desktop was unpacked but its program was not found');
  if (platform !== 'win32') fs.chmodSync(bin, 0o755);
  return { bin, version: AGENT_DESKTOP_VERSION };
}

export function agentDesktopBin(env = process.env) {
  if (env.OX_AGENT_DESKTOP) return fs.existsSync(env.OX_AGENT_DESKTOP) ? env.OX_AGENT_DESKTOP : null;
  // Tests use a fake one (OX_AGENT_DESKTOP); they never drive this Mac's apps.
  if (env.NODE_TEST_CONTEXT || env.OX_NO_AGENT_DESKTOP === '1') return null;
  const win = process.platform === 'win32';
  const names = win ? ['agent-desktop.cmd', 'agent-desktop.exe'] : ['agent-desktop'];
  const own = vendoredBin(env);
  if (own) return own;
  const dirs = [...String(env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(win && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])];
  for (const d of dirs) for (const n of names) { const p = d && path.join(d, n); if (p && fs.existsSync(p)) return p; }
  return null;
}

export const available = (env = process.env) => !!agentDesktopBin(env);

/** One agent-desktop command → its envelope ({ ok, data } or { ok: false, error }). */
export function run(args, { env = process.env, timeoutMs = 15_000, scope = null } = {}) {
  const bin = agentDesktopBin(env);
  if (!bin) return Promise.resolve({ ok: false, error: { code: 'NOT_INSTALLED', message: 'agent-desktop is not installed (ox desktop install or npm install -g agent-desktop)' } });
  return new Promise((resolve) => {
    // A .cmd shim on Windows needs a shell; everything else runs directly.
    const child = spawn(bin, [...(scope ?? []), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env, shell: /\.cmd$/i.test(bin), windowsHide: true });
    let out = '', errOut = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: { code: 'SPAWN', message: e.message } }); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch { resolve({ ok: false, error: { code: 'UNREADABLE', message: (errOut || out || 'no answer').trim().slice(0, 300) } }); }
    });
  });
}

// ---- several agents on one desktop, each with its own cursor -----------------
// One session for this machine's ox; each agent acts under its own id, so its cursor
// is its own. Refs belong to their session, so a run keeps to one scope throughout.
const sessionFile = (env) => path.join(oxHome(env), 'desktop-session.json');
let checkedSession = null;
const labelled = new Set();
export const agentIdOf = (ctx = {}, env = process.env) => String(ctx.agentName ?? ctx.agentId ?? env.OX_ORG_AGENT ?? (ctx.depth > 0 ? `helper-${process.pid}-${ctx.depth}` : 'ox')).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || 'ox';
/** The global flags for this agent's commands, or null to run without a session. */
export async function desktopScope(ctx = {}, env = ctx.env ?? process.env) {
  if (env.OX_DESKTOP_CURSORS === '0' || (env.NODE_TEST_CONTEXT && env.OX_DESKTOP_CURSORS !== '1')) return null;
  let id = checkedSession;
  if (!id) {
    try { id = JSON.parse(fs.readFileSync(sessionFile(env), 'utf8')).id ?? null; } catch {}
    if (id) {
      const l = await run(['session', 'list'], { env });
      if (!l.ok || !(l.data?.sessions ?? []).some((x) => x.session_id === id && !x.ended_at)) id = null;
    }
    if (!id) {
      const made = await run(['session', 'start', '--cursor', '--multi-agent', '--name', 'ox'], { env });
      if (!made.ok || !made.data?.session_id) return null;
      id = made.data.session_id;
      try { fs.mkdirSync(path.dirname(sessionFile(env)), { recursive: true }); fs.writeFileSync(sessionFile(env), JSON.stringify({ id })); } catch {}
    }
    checkedSession = id;
  }
  const scope = ['--session', id, '--agent-id', agentIdOf(ctx, env)];
  // Its name on its cursor, once per agent: with several at work you can tell them apart.
  const who = `${id}:${scope[3]}`;
  if (!labelled.has(who)) {
    labelled.add(who);
    run(['cursor-overlay', 'enable', '--label', scope[3]], { env, scope }).catch(() => {});
  }
  return scope;
}
export const forgetDesktopSession = () => { checkedSession = null; };

const why = (r) => [r?.error?.message, r?.error?.suggestion].filter(Boolean).join(' ') || 'agent-desktop failed';

/**
 * The interactive controls of an app's window, in the shape ox's rules read:
 * { app, window, elements: [{ id, role, name, value, frame, ref, actions }], ms }.
 */
export async function listElements(app, { env = process.env, max = 300, scope = null } = {}) {
  const t0 = Date.now();
  const r = await run(['snapshot', ...(app ? ['--app', app] : []), '-i', '--compact', '--include-bounds'], { env, scope });
  if (!r.ok) return { error: why(r) };
  const elements = [];
  const walk = (n) => {
    if (!n || elements.length >= max) return;
    if (n.ref_id) {
      const b = n.bounds ?? n.frame;
      elements.push({
        id: elements.length + 1,
        role: String(n.role ?? 'control'),
        name: n.name ?? '',
        description: n.description ?? '',
        value: n.value != null ? String(n.value) : '',
        frame: b ? [b.x, b.y, b.width, b.height].map((v) => Math.round(Number(v) || 0)) : null,
        disabled: n.enabled === false,
        ref: n.ref_id,
        actions: n.available_actions ?? [],
      });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(r.data?.tree);
  return { app: app || r.data?.app || 'the app in front', window: r.data?.window?.title ?? '', elements, ms: Date.now() - t0, via: 'agent-desktop' };
}

/** Press a control by its ref; a stale ref is reported so the caller reads the window again. */
export async function press(el, { env = process.env, double = false } = {}) {
  const r = await run([double ? 'double-click' : 'click', el.ref], { env });
  if (r.ok) return { ok: true };
  return { error: why(r), stale: ['STALE_REF', 'AMBIGUOUS_TARGET'].includes(r.error?.code) };
}

/** Put text into a field: typed, or set directly when the field takes a value. */
export async function typeInto(el, text, { env = process.env } = {}) {
  let r = await run(['type', el.ref, text], { env });
  if (!r.ok && (el.actions ?? []).includes('SetValue')) r = await run(['set-value', el.ref, text], { env });
  return r.ok ? { ok: true } : { error: why(r), stale: r.error?.code === 'STALE_REF' };
}

/** A key combo, already checked by ox's parseKey and the screen rules (src/computer-control.js). */
export async function pressKey(combo, { env = process.env, app = null } = {}) {
  const r = await run(['press', combo, ...(app ? ['--app', app] : [])], { env });
  return r.ok ? { ok: true } : { error: why(r) };
}
