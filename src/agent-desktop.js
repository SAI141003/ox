// agent-desktop (vercel-labs/agent-desktop, Apache-2.0) as ox's desktop hand
// when it is installed (`npm install -g agent-desktop`): it reads and operates
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
import { spawn } from 'node:child_process';

export function agentDesktopBin(env = process.env) {
  if (env.OX_AGENT_DESKTOP) return fs.existsSync(env.OX_AGENT_DESKTOP) ? env.OX_AGENT_DESKTOP : null;
  // Tests use a fake one (OX_AGENT_DESKTOP); they never drive this Mac's apps.
  if (env.NODE_TEST_CONTEXT || env.OX_NO_AGENT_DESKTOP === '1') return null;
  const win = process.platform === 'win32';
  const names = win ? ['agent-desktop.cmd', 'agent-desktop.exe'] : ['agent-desktop'];
  const dirs = [...String(env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...(win && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])];
  for (const d of dirs) for (const n of names) { const p = d && path.join(d, n); if (p && fs.existsSync(p)) return p; }
  return null;
}

export const available = (env = process.env) => !!agentDesktopBin(env);

/** One agent-desktop command → its envelope ({ ok, data } or { ok: false, error }). */
export function run(args, { env = process.env, timeoutMs = 15_000 } = {}) {
  const bin = agentDesktopBin(env);
  if (!bin) return Promise.resolve({ ok: false, error: { code: 'NOT_INSTALLED', message: 'agent-desktop is not installed (npm install -g agent-desktop)' } });
  return new Promise((resolve) => {
    // A .cmd shim on Windows needs a shell; everything else runs directly.
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, shell: /\.cmd$/i.test(bin), windowsHide: true });
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

const why = (r) => [r?.error?.message, r?.error?.suggestion].filter(Boolean).join(' ') || 'agent-desktop failed';

/**
 * The interactive controls of an app's window, in the shape ox's rules read:
 * { app, window, elements: [{ id, role, name, value, frame, ref, actions }], ms }.
 */
export async function listElements(app, { env = process.env, max = 300 } = {}) {
  const t0 = Date.now();
  const r = await run(['snapshot', ...(app ? ['--app', app] : []), '-i', '--compact', '--include-bounds'], { env });
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

/** A key combo, already checked by ox's parseKey (never Return). */
export async function pressKey(combo, { env = process.env, app = null } = {}) {
  const r = await run(['press', combo, ...(app ? ['--app', app] : [])], { env });
  return r.ok ? { ok: true } : { error: why(r) };
}
