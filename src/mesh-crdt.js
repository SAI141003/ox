// Shared state that works offline (docs/MESH_RADIO_ARCHITECTURE.md L4, after
// "Local-first software", Kleppmann et al. 2019): each machine edits its own
// copy and the copies merge on contact to the same result, in any order, any
// number of times, with no server and nothing to resolve by hand.
//
// One kind of document covers the task board, settings and the org: a map of
// keys to values where the newest write wins, newest by a hybrid logical clock
// (wall time, a counter, the machine id) so clocks that disagree a little
// still give one order. Deletes are kept as tombstones. An append-only log
// (the audit trail) is the same map with unique keys that are never rewritten.
//
//   ~/.ox/mesh/state/<doc>.json
import fs from 'node:fs';
import path from 'node:path';

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '');

// ---------------------------------------------------- hybrid logical clock

/** [wallMs, counter, nodeId] compared in that order. */
export function compareClock(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? -1 : 1;
}

/** The next clock for a local write: never behind anything this document has seen. */
export function tick(doc, node, now = Date.now()) {
  const last = doc.clock ?? [0, 0, node];
  const c = now > last[0] ? [now, 0, node] : [last[0], last[1] + 1, node];
  doc.clock = c;
  return c;
}

function observe(doc, c) {
  if (!doc.clock || compareClock(c, doc.clock) > 0) doc.clock = [c[0], c[1], doc.clock?.[2] ?? c[2]];
}

// ----------------------------------------------------------------- the map

export function empty(name) { return { name, clock: null, entries: {} }; }

export function set(doc, key, value, node, now) {
  const c = tick(doc, node, now);
  doc.entries[key] = { v: value, c };
  return doc;
}

export function del(doc, key, node, now) {
  const c = tick(doc, node, now);
  doc.entries[key] = { del: true, c };
  return doc;
}

export function get(doc, key) {
  const e = doc.entries[key];
  return e && !e.del ? e.v : undefined;
}

/** The live entries as a plain object. */
export function value(doc) {
  const out = {};
  for (const [k, e] of Object.entries(doc.entries)) if (!e.del) out[k] = e.v;
  return out;
}

/** Merge another copy in. Commutative, associative, idempotent. → doc (changed in place) */
export function merge(doc, other) {
  for (const [k, e] of Object.entries(other?.entries ?? {})) {
    if (!Array.isArray(e?.c) || e.c.length !== 3) continue;
    const mine = doc.entries[k];
    if (!mine || compareClock(e.c, mine.c) > 0) doc.entries[k] = e;
    observe(doc, e.c);
  }
  return doc;
}

/** Only what changed after a clock (to send less over slow links). */
export function since(doc, clock) {
  const out = { name: doc.name, clock: doc.clock, entries: {} };
  for (const [k, e] of Object.entries(doc.entries)) if (!clock || compareClock(e.c, clock) > 0) out.entries[k] = e;
  return out;
}

/** Append to a log document: a unique key per entry, never rewritten. */
export function append(doc, entry, node, now = Date.now()) {
  const c = tick(doc, node, now);
  doc.entries[`${String(c[0]).padStart(15, '0')}-${String(c[1]).padStart(4, '0')}-${node}`] = { v: entry, c };
  return doc;
}

/** A log document's entries in order. */
export function log(doc) {
  return Object.entries(doc.entries).filter(([, e]) => !e.del).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, e]) => e.v);
}

// ---------------------------------------------------------------- on disk

export const stateDir = (meshDir) => path.join(meshDir, 'state');

export function load(meshDir, name) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir(meshDir), `${safe(name)}.json`), 'utf8'));
    return d && typeof d.entries === 'object' ? d : empty(name);
  } catch { return empty(name); }
}

export function save(meshDir, doc) {
  const d = stateDir(meshDir);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const f = path.join(d, `${safe(doc.name)}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return doc;
}

export function names(meshDir) {
  try { return fs.readdirSync(stateDir(meshDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; }
}
