// Click and type on this Mac, for the island's requests ("open WhatsApp and
// write to Anna that I'm late"): see the controls of an app's window, click
// one (by its name or at a point), type text where the cursor is, press a
// navigation key. Done by ox-hands (desktop/island/Sources/OxHands), ox's own
// native helper over macOS Accessibility and CoreGraphics: no AppleScript, no
// paid service. It stays running, so a press takes ~10-30 ms and reading a
// window ~50-250 ms. The app ox runs in needs Accessibility once.
//
// What ox never does here (owner rule: ox drafts and finds, never sends or
// pays): press Return or Enter, or click a control named Send, Pay, Buy,
// Delete, Submit, Confirm… The text is left in the box; the owner sends it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RISKY = /\b(send|pay|payment|buy|purchase|order|checkout|check out|delete|remove|erase|trash|submit|confirm|transfer|post|publish|tweet|reply all|sign out|log out|logout|unsubscribe|accept|agree|install|uninstall|empty|call|facetime)\b/i;

// A control whose name, description or help reads like an irreversible act.
export function isRisky(el) {
  if (!el) return false;
  return [el.name, el.description, el.help].some((s) => s && RISKY.test(String(s)));
}

const KEY_CODES = { tab: 48, escape: 53, esc: 53, space: 49, delete: 51, backspace: 51, forwarddelete: 117, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121 };
// Shortcuts that find, select, edit or open a blank thing; never quit, close, send or print.
const SHORTCUT_LETTERS = new Set(['a', 'c', 'f', 'k', 'l', 'n', 't', 'v', 'x', 'z']);
const MODS = { cmd: 'command down', command: 'command down', shift: 'shift down', option: 'option down', alt: 'option down', ctrl: 'control down', control: 'control down' };

// "tab", "shift+tab", "cmd+f", "down" → what to press, or why not.
export function parseKey(spec) {
  const parts = String(spec ?? '').toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (!parts.length) return { error: 'no key given' };
  const key = parts.pop();
  const mods = [];
  for (const m of parts) {
    if (!MODS[m]) return { error: `unknown modifier "${m}"` };
    if (!mods.includes(MODS[m])) mods.push(MODS[m]);
  }
  if (/^(return|enter|kpenter)$/.test(key)) return { error: 'ox never presses Return or Enter: that can send. The text is in the box; press Return yourself.' };
  if (KEY_CODES[key] !== undefined) return { code: KEY_CODES[key], mods };
  if (/^[a-z]$/.test(key)) {
    if (!mods.includes('command down')) return { error: 'to type letters use type_text' };
    if (!SHORTCUT_LETTERS.has(key)) return { error: `⌘${key.toUpperCase()} is not one ox presses (only ⌘A C F K L N T V X Z)` };
    return { char: key, mods };
  }
  return { error: `unknown key "${key}" (tab, escape, space, delete, arrows, home, end, page up/down, or ⌘ with A C F K L N T V X Z)` };
}

// The smallest listed control whose frame holds the point.
export function elementAt(elements, x, y) {
  let best = null;
  for (const e of elements) {
    if (!e.frame) continue;
    const [ex, ey, w, h] = e.frame;
    if (x >= ex && x <= ex + w && y >= ey && y <= ey + h && (!best || w * h < best.frame[2] * best.frame[3])) best = e;
  }
  return best;
}

// A control by what the owner or model calls it: exact name first, then a
// name that contains it; a role narrows it ("button", "text field").
export function findElement(elements, query, role) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  const r = role ? String(role).toLowerCase().replace(/\s+/g, '') : '';
  const pool = r ? elements.filter((e) => e.role.toLowerCase().replace(/^ax/, '').includes(r.replace(/^ax/, ''))) : elements;
  const label = (e) => [e.name, e.description, e.value, e.identifier].filter(Boolean).map((s) => String(s).toLowerCase());
  return pool.find((e) => label(e).some((s) => s === q)) ?? pool.find((e) => label(e).some((s) => s.includes(q))) ?? null;
}

// "tab" → 48, "cmd+f" → 3 with cmd: what ox-hands presses.
const LETTER_CODES = { a: 0, c: 8, f: 3, k: 40, l: 37, n: 45, t: 17, v: 9, x: 7, z: 6 };
const MOD_NAMES = { 'command down': 'cmd', 'shift down': 'shift', 'option down': 'option', 'control down': 'ctrl' };
export function keyArgs(k) {
  return [String(k.code ?? LETTER_CODES[k.char]), ...(k.mods.length ? ['--mods', k.mods.map((m) => MOD_NAMES[m]).join(',')] : [])];
}

// --- ox-hands, kept warm ------------------------------------------------------
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'island');

export function handsPath(env = process.env) {
  const places = [env.OX_HANDS, path.join(os.homedir(), '.ox', 'island', 'OX Island.app', 'Contents', 'MacOS', 'OxHands'), path.join(PKG, '.build', 'release', 'OxHands')];
  // The newest build wins: the island's copy lags until the island is reinstalled.
  if (env.OX_HANDS && fs.existsSync(env.OX_HANDS)) return env.OX_HANDS;
  const found = places.slice(1).filter((p) => fs.existsSync(p));
  return found.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0] ?? null;
}

let child = null, buf = '', waiting = [];
function helper() {
  if (child && child.exitCode === null && !child.killed) return child;
  let bin = handsPath();
  if (!bin && process.platform === 'darwin') {
    // Not built yet (a fresh checkout): build it once, ~10 s.
    spawnSync('swift', ['build', '-c', 'release', '--product', 'OxHands'], { cwd: PKG, stdio: 'ignore', timeout: 300000 });
    bin = handsPath();
  }
  if (!bin) return null;
  child = spawn(bin, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
  buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const w = waiting.shift();
      if (!w) continue;
      clearTimeout(w.timer);
      try { w.resolve(JSON.parse(line)); } catch { w.resolve({ error: 'ox-hands said something unreadable' }); }
    }
  });
  child.on('exit', () => { for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.resolve({ error: 'ox-hands stopped' }); } child = null; });
  child.on('error', () => {});
  // A run that is otherwise done may exit: the helper never keeps ox alive.
  child.unref(); child.stdin.unref?.(); child.stdout.unref?.();
  return child;
}

// One request to ox-hands: its arguments, one JSON reply.
export function hands(args, { timeout = 8000 } = {}) {
  if (process.platform !== 'darwin') return Promise.resolve({ error: `click and type work on macOS only (this is ${process.platform})` });
  const c = helper();
  if (!c) return Promise.resolve({ error: 'ox-hands is not built: run `ox island build` (needs the Swift tools: xcode-select --install)' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { const i = waiting.findIndex((w) => w.timer === timer); if (i >= 0) waiting.splice(i, 1); resolve({ error: `the app took over ${timeout / 1000} s to answer` }); try { c.kill(); } catch {} }, timeout);
    waiting.push({ resolve, timer });
    c.stdin.write(`${JSON.stringify(args.map(String))}\n`);
  });
}

export function stopHands() { try { child?.kill(); } catch {} child = null; }

// --- what the tools do ----------------------------------------------------------
// The last read of each app's window, reused for 3 s by a click by name; a
// press of a cached control is checked against its label first (--expect).
const lastList = new Map();
export async function listElements(app, { max = 300, cached = false } = {}) {
  const key = String(app ?? '').toLowerCase();
  const hit = cached && key && lastList.get(key);
  if (hit && Date.now() - hit.at < 3000) return { ...hit.list, cached: true };
  const r = await hands(['list', ...(app ? ['--app', app] : []), '--max', max]);
  if (r.error) return { error: r.app ? `${r.app}: ${r.error}` : r.error };
  r.elements.forEach((e, i) => { e.id = i + 1; });
  lastList.set(key || String(r.app).toLowerCase(), { at: Date.now(), list: r });
  return r;
}

// One line per control, for a model to pick from.
export function describeElements(list) {
  const lines = list.elements.map((e) => {
    const label = [e.name, e.description].filter(Boolean).join(' — ') || e.identifier || (e.value ? `"${e.value.slice(0, 60)}"` : '(no name)');
    const at = e.frame ? ` at ${Math.round(e.frame[0] + e.frame[2] / 2)},${Math.round(e.frame[1] + e.frame[3] / 2)}` : '';
    return `${e.id}. ${e.role.replace(/^AX/, '')}: ${label}${e.value && (e.name || e.description) ? ` = "${e.value.slice(0, 60)}"` : ''}${at}${e.disabled ? ' (dimmed)' : ''}${isRisky(e) ? ' (ox will not press this)' : ''}`;
  });
  return `${list.app}${list.window ? ` · ${list.window}` : ''}: ${list.elements.length} controls (${list.ms} ms)\n${lines.join('\n')}`;
}

const named = (e) => `${e.role.replace(/^AX/, '')} "${e.name || e.description || e.identifier || e.value || ''}"`;

// Click a control: by name or number (pressed through Accessibility, the
// pointer moved to it so you see it) or at a point (what is under it is read
// first). A Send / Pay / Delete-like control is refused either way.
export async function click({ app, element, role, x, y, double = false } = {}, { dryRun = false } = {}) {
  const t0 = Date.now();
  if (element != null && String(element).trim()) {
    for (let attempt = 0; attempt < 2; attempt++) {
    const list = await listElements(app, { cached: attempt === 0 });
    if (list.error) return { isError: true, text: list.error };
    const q = String(element).trim();
    const target = /^\d+$/.test(q) && Number(q) <= list.elements.length && !findElement(list.elements, q, role) ? list.elements[Number(q) - 1] : findElement(list.elements, q, role);
    if (!target) return { isError: true, text: `no control called "${element}" in ${list.app}. ${describeElements({ ...list, elements: list.elements.slice(0, 40) })}` };
    if (isRisky(target)) return { isError: true, text: `ox does not press "${target.name || target.description}": that sends, pays or deletes. It is left for you to press.` };
    if (dryRun) return { text: `would click ${named(target)} in ${list.app}` };
    const expect = target.name || target.description || target.identifier || '';
    const r = await hands(['press', '--app', list.app, '--path', target.path, '--expect', expect, ...(double ? ['--double'] : [])]);
    if (r.changed) { lastList.delete(String(list.app).toLowerCase()); continue; }   // the window changed: read it again
    if (!r.error) lastList.delete(String(list.app).toLowerCase());                  // a press may change it
    return r.error ? { isError: true, text: r.error } : { text: `clicked ${named(target)} in ${list.app} (${Date.now() - t0} ms)` };
    }
    return { isError: true, text: `the window kept changing; "${element}" was not pressed` };
  }
  if (x === undefined || y === undefined || x === '' || y === '' || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return { isError: true, text: 'say which control (element) or where (x and y)' };
  if (app && !dryRun) { const a = await hands(['activate', app]); if (a.error) return { isError: true, text: a.error }; }
  const at = await hands(['at', x, y]);
  if (at.error) return { isError: true, text: at.error };
  if (app && at.app && !sameApp(at.app, app)) return { isError: true, text: `${app}'s window is not under ${Math.round(x)},${Math.round(y)} (${at.app} is there). Nothing was clicked.` };
  const risky = (at.chain ?? []).find(isRisky);
  if (risky) return { isError: true, text: `ox does not press "${risky.name || risky.description}": that sends, pays or deletes. It is left for you to press.` };
  const under = at.chain?.[0];
  const what = under && (under.name || under.description) ? named(under) : `the point ${Math.round(x)},${Math.round(y)}`;
  if (dryRun) return { text: `would click ${what}` };
  const r = await hands(['click', x, y, ...(double ? ['--double'] : [])]);
  return r.error ? { isError: true, text: r.error } : { text: `clicked ${what} (${Date.now() - t0} ms)` };
}

// Paste the text where the cursor is (any language and emoji; a paste never
// presses Return, so a chat box is filled, not sent). The clipboard is put back.
export async function typeText({ app, text, into } = {}, { dryRun = false } = {}) {
  const t = String(text ?? '');
  const chars = [...t].length;
  if (!t) return { isError: true, text: 'no text given' };
  if (chars > 5000) return { isError: true, text: 'that is over 5,000 characters; ox types up to 5,000 at once' };
  const t0 = Date.now();
  if (into) {
    const c = await click({ app, element: into }, { dryRun });
    if (c.isError) return c;
  }
  if (dryRun) return { text: `would type ${chars} characters${into ? ` into "${into}"` : ''}` };
  const r = await hands(['type', t, ...(app ? ['--app', app] : [])]);
  return r.error ? { isError: true, text: r.error } : { text: `typed ${chars} characters${app ? ` in ${app}` : ''}${into ? ` into "${into}"` : ''} (${Date.now() - t0} ms); nothing sent: press Return or Send yourself when it reads right` };
}

const sameApp = (a, b) => { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); return x === y || x.includes(y) || y.includes(x); };

// ---- drawing with the cursor (Vovy carving a pumpkin) ---------------------
export const SHAPES = ['circle', 'smile', 'frown', 'line', 'v', 'triangle', 'rectangle', 'star', 'zigzag'];

/**
 * The points of a shape inside a box (screen points, x right, y down). `n` is
 * how many points a curve gets. Free paths are given as `points` instead.
 */
export function shapePath(shape, { x, y, w, h }, n = 48) {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const arc = (a0, a1, k = n) => Array.from({ length: k + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / k; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
  switch (String(shape).toLowerCase()) {
    case 'circle': case 'ellipse': case 'oval': case 'eye': return arc(0, 2 * Math.PI);
    // A grin: the lower half of an ellipse whose top edge is the box's top.
    case 'smile': case 'grin': return Array.from({ length: n + 1 }, (_, i) => { const a = Math.PI * 0.1 + (Math.PI * 0.8 * i) / n; return [cx + rx * Math.cos(a), y + h * Math.sin(a)]; });
    case 'frown': return Array.from({ length: n + 1 }, (_, i) => { const a = Math.PI * 1.1 + (Math.PI * 0.8 * i) / n; return [cx + rx * Math.cos(a), y + h + h * Math.sin(a)]; });
    case 'line': return [[x, y], [x + w, y + h]];
    case 'v': return [[x, y], [cx, y + h], [x + w, y]];
    case 'triangle': case 'nose': return [[cx, y], [x + w, y + h], [x, y + h], [cx, y]];
    case 'rectangle': case 'rect': case 'square': return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
    case 'star': return Array.from({ length: 11 }, (_, i) => { const r = i % 2 ? 0.4 : 1; const a = -Math.PI / 2 + (Math.PI * i) / 5; return [cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]; });
    case 'zigzag': return Array.from({ length: 7 }, (_, i) => [x + (w * i) / 6, i % 2 ? y + h : y]);
    default: return null;
  }
}

/** Points along a path every `step` points or so, so a drag is smooth and slow enough for a canvas to see. */
export function densify(points, step = 6) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 1; j <= k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  return out.map(([px, py]) => [Math.round(px * 10) / 10, Math.round(py * 10) / 10]);
}

// Draw with the cursor: a named shape in a box, or free points. What is under
// the starting point is read first, like a click: a Send / Pay / Delete-like
// control is refused. Moving the mouse yourself stops it.
export async function draw({ app, shape, x, y, w, h, points, label } = {}, { dryRun = false } = {}) {
  let pts = null;
  if (Array.isArray(points) && points.length >= 2) pts = points.map((p) => (Array.isArray(p) ? p : [p.x, p.y])).map(([a, b]) => [Number(a), Number(b)]);
  else if (shape) {
    const box = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return { isError: true, text: 'a shape needs its box: x, y (top left), w and h in screen points' };
    pts = shapePath(shape, box);
    if (!pts) return { isError: true, text: `ox draws these shapes: ${SHAPES.join(', ')}; or give points` };
  }
  if (!pts || pts.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) return { isError: true, text: 'say what to draw: a shape with its box, or points [[x, y], …]' };
  const what = label || shape || 'a path';
  if (app && !dryRun) {
    const a = await hands(['activate', app]);
    if (a.error) return { isError: true, text: a.error };
    // An app just brought forward takes a moment to take the mouse: the first
    // stroke on a fresh window came out as a dot without this.
    if (!a.already) await new Promise((r) => setTimeout(r, 350));
  }
  // A window coming back from Stage Manager slides in: wait (2 s at most) until
  // the app's own window is settled under the first point, read twice alike.
  let at = await hands(['at', pts[0][0], pts[0][1]]);
  if (app && !dryRun) {
    let seen = 0;
    for (let i = 0; i < 10 && seen < 2; i++) {
      if (at.app && sameApp(at.app, app)) seen++; else seen = 0;
      if (seen < 2) { await new Promise((r) => setTimeout(r, 200)); at = await hands(['at', pts[0][0], pts[0][1]]); }
    }
  }
  const risky = (at.chain ?? []).find(isRisky);
  if (risky) return { isError: true, text: `ox does not draw on "${risky.name || risky.description}": that sends, pays or deletes.` };
  // Never draw on the wrong thing: the app asked for must be the one under the first point.
  if (app && at.app && !sameApp(at.app, app)) return { isError: true, text: `${app}'s window is not under that point (${at.app} is there: the window may be hidden, parked by Stage Manager or covered). Nothing was drawn.` };
  const dense = densify(pts);
  if (dryRun) return { text: `would draw ${what} (${dense.length} points)` };
  const r = await hands(['path', '--points', dense.map(([a, b]) => `${a},${b}`).join(';')], { timeout: 30_000 });
  return r.error ? { isError: true, text: r.error } : { text: `drew ${what} (${dense.length} points, ${r.ms} ms)` };
}

export async function pressKey({ app, key, times = 1 } = {}, { dryRun = false } = {}) {
  const k = parseKey(key);
  if (k.error) return { isError: true, text: k.error };
  const n = Math.max(1, Math.min(20, Number(times) || 1));
  if (dryRun) return { text: `would press ${key}${n > 1 ? ` ×${n}` : ''}` };
  const r = await hands(['key', ...keyArgs(k), '--times', n, ...(app ? ['--app', app] : [])]);
  return r.error ? { isError: true, text: r.error } : { text: `pressed ${key}${n > 1 ? ` ×${n}` : ''} (${r.ms} ms)` };
}
