// Store, carry, forward (docs/MESH_RADIO_ARCHITECTURE.md L3): bundles wait
// here until a link to their machine appears, and bundles for a third machine
// are carried by any paired machine that meets it (they stay sealed; a
// carrier sees only who they are for, their class and when they expire).
//
//   ~/.ox/mesh/outbox/<to-id>/<bundle-id>.b   one file per bundle
//   ~/.ox/mesh/inbox.jsonl                     what arrived for this machine
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES, peek } from './mesh-bundle.js';

const MAX_TOTAL = 512 * 1024 * 1024;      // the whole queue on one machine
const MAX_CARRY = 64 * 1024 * 1024;       // bundles carried for other machines
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');

export function outboxDir(meshDir) { return path.join(meshDir, 'outbox'); }

/** Keep a bundle until it reaches its machine. carried: it is for someone else. */
export function enqueue(meshDir, bytes, { carried = false, now = Date.now() } = {}) {
  const h = peek(bytes);
  if (h.exp <= now) throw new Error('that bundle has already expired');
  const d = path.join(outboxDir(meshDir), safe(h.to));
  const f = path.join(d, `${safe(h.id)}.b`);
  if (fs.existsSync(f)) return { ...h, dup: true };
  const used = usage(meshDir);
  if (used.total + h.size > MAX_TOTAL) throw new Error('the queue is full (512 MB): older bundles must go out first');
  if (carried && used.carried + h.size > MAX_CARRY) throw new Error('carrying enough for other machines already (64 MB)');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, bytes, { mode: 0o600 });
  if (carried) fs.writeFileSync(`${f}.carried`, '');
  return h;
}

function* files(meshDir) {
  const root = outboxDir(meshDir);
  let tos = [];
  try { tos = fs.readdirSync(root); } catch { return; }
  for (const to of tos) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, to)); } catch { continue; }
    for (const n of names) if (n.endsWith('.b')) yield { to, file: path.join(root, to, n) };
  }
}

export function usage(meshDir) {
  let total = 0, carried = 0, count = 0;
  for (const { file } of files(meshDir)) {
    try { const s = fs.statSync(file).size; total += s; count++; if (fs.existsSync(`${file}.carried`)) carried += s; } catch {}
  }
  return { total, carried, count };
}

/**
 * Bundles waiting for a machine, most urgent class first, oldest first, that
 * a link can carry (maxClass: the biggest class the link takes).
 * → [{ id, to, cls, exp, size, bytes }]
 */
export function waiting(meshDir, to, { maxClass = 'bulk', now = Date.now(), limitBytes = Infinity } = {}) {
  const cap = CLASSES[maxClass].rank;
  const out = [];
  const d = path.join(outboxDir(meshDir), safe(to));
  let names = [];
  try { names = fs.readdirSync(d).filter((n) => n.endsWith('.b')); } catch { return out; }
  for (const n of names) {
    const f = path.join(d, n);
    try {
      const bytes = fs.readFileSync(f);
      const h = peek(bytes);
      if (h.exp <= now) { drop(f); continue; }
      if (CLASSES[h.cls].rank > cap) continue;
      out.push({ ...h, bytes, at: fs.statSync(f).mtimeMs });
    } catch { drop(f); }
  }
  out.sort((a, b) => CLASSES[a.cls].rank - CLASSES[b.cls].rank || a.at - b.at);
  const picked = [];
  let used = 0;
  for (const b of out) { if (used + b.size > limitBytes) break; used += b.size; picked.push(b); }
  return picked;
}

/** Bundles carried for machines other than `except` (to hand to a carrier that may meet them). */
export function carriedFor(meshDir, { except, maxClass = 'interactive', now = Date.now() } = {}) {
  const out = [];
  for (const { to, file } of files(meshDir)) {
    if (to === safe(except)) continue;
    try {
      const bytes = fs.readFileSync(file);
      const h = peek(bytes);
      if (h.exp <= now) { drop(file); continue; }
      if (CLASSES[h.cls].rank <= CLASSES[maxClass].rank) out.push({ ...h, bytes });
    } catch { drop(file); }
  }
  return out;
}

function drop(f) { try { fs.rmSync(f); } catch {} try { fs.rmSync(`${f}.carried`); } catch {} }

/** Delivered (or given up): out of the queue. */
export function remove(meshDir, to, id) { drop(path.join(outboxDir(meshDir), safe(to), `${safe(id)}.b`)); }

/** Expired bundles go. → how many */
export function sweep(meshDir, now = Date.now()) {
  let n = 0;
  for (const { file } of files(meshDir)) {
    try { if (peek(fs.readFileSync(file)).exp <= now) { drop(file); n++; } } catch { drop(file); n++; }
  }
  return n;
}

/** Everything queued, for `ox mesh outbox`. */
export function list(meshDir, now = Date.now()) {
  const out = [];
  for (const { to, file } of files(meshDir)) {
    try { const h = peek(fs.readFileSync(file)); if (h.exp > now) out.push({ ...h, carried: fs.existsSync(`${file}.carried`) }); } catch {}
  }
  return out;
}

// ------------------------------------------------------------------ inbox

export const inboxFile = (meshDir) => path.join(meshDir, 'inbox.jsonl');

export function deliver(meshDir, msg) {
  fs.mkdirSync(meshDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(inboxFile(meshDir), `${JSON.stringify({ ...msg, received: Date.now() })}\n`, { mode: 0o600 });
}

export function readInbox(meshDir, { limit = 50 } = {}) {
  try { return fs.readFileSync(inboxFile(meshDir), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)); } catch { return []; }
}
