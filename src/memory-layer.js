// The memory layer's background half and its picture. memory-graph.js is the
// store and the read/write paths; this file is the "sleep" pass the research
// calls for (Letta sleep-time agents, Mem0 Dream Synthesis) and the snapshot the
// Memory page draws. Consolidation runs off the request path, never deletes,
// and only changes state the way the rest of the graph already does:
//
//   merge      near-duplicates of the same kind fold into the older memory
//              (strength adds up); the copy is kept as state 'merged'.
//   expire     events whose day has passed leave every prompt (state 'expired').
//   reinforce  each time a memory was put in front of a run since the last
//              sleep, it gets stronger and its clock restarts (MemoryBank).
//   dormant    facts and events whose decayed score fell below a floor stop
//              being recalled (state 'dormant'); preferences, lessons and
//              procedures never fade on their own.
//   promote    a lesson verified twice becomes a procedure: Voyager's
//              verify-then-commit, so only what worked is replayed as how-to.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { load, memoryFile, profile, tokens, KINDS } from './memory-graph.js';
import { memoryHome, noteMemoryEvent, readMemoryEvents } from './memory-events.js';

const DAY = 86_400_000;
export const HALF_LIFE_DAYS = { event: 7, fact: 120, preference: 365, lesson: 180, procedure: 180, derived: 60 };
const NEVER_FADES = new Set(['preference', 'lesson', 'procedure']);
const DORMANT_BELOW = 0.6;
const MERGE_AT = 0.85;
const PROMOTE_AT = 2;

function metaFile(home) { return path.join(memoryHome({ home }), 'layer-meta.json'); }
export function readLayerMeta({ home } = {}) {
  try { return JSON.parse(fs.readFileSync(metaFile(home), 'utf8')) ?? {}; } catch { return {}; }
}
function writeLayerMeta(meta, { home } = {}) {
  const f = metaFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

function overlap(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.max(A.size, B.size);
}

/** How much of a memory is left: importance × strength, halved every half-life since last seen. */
export function retention(m, now = Date.now()) {
  const days = (now - (m.lastSeen ?? m.createdAt ?? now)) / DAY;
  return (m.importance ?? 5) * (1 + Math.log(m.strength ?? 1)) * Math.pow(0.5, days / (HALF_LIFE_DAYS[m.kind] ?? 90));
}

const live = (m) => m.state === 'active' && m.latest !== false;

/** One consolidation pass over a graph file. Returns what it did. */
export function sleep({ file, home, now = Date.now(), recalls = null, dry = false, record = true } = {}) {
  const all = load(file);
  const changed = new Map();
  const put = (m) => changed.set(m.id, { ...(changed.get(m.id) ?? {}), ...m });
  const cur = (m) => changed.get(m.id) ?? m;
  const did = { merged: 0, expired: 0, reinforced: 0, dormant: 0, promoted: 0 };

  // Reinforce what the read path used since the last sleep.
  const since = readLayerMeta({ home }).lastSleep ?? 0;
  const counts = recalls ?? (() => {
    const c = new Map();
    for (const e of readMemoryEvents({ home, since })) if (e.type === 'read') for (const id of e.ids ?? []) c.set(id, (c.get(id) ?? 0) + 1);
    return c;
  })();
  for (const m of all) {
    const n = counts.get(m.id);
    if (!n || !live(m)) continue;
    put({ ...m, strength: (m.strength ?? 1) + Math.min(1, n * 0.25), lastSeen: now, recalled: (m.recalled ?? 0) + n });
    did.reinforced++;
  }

  // Expire events whose day is over.
  for (const m of all) {
    const c = cur(m);
    if (live(c) && c.expiresAt && c.expiresAt < now) { put({ ...c, state: 'expired', expiredAt: now }); did.expired++; }
  }

  // Merge near-duplicates (same kind), oldest keeps the id.
  const pool = all.map(cur).filter(live).sort((a, b) => a.createdAt - b.createdAt);
  const gone = new Set();
  for (let i = 0; i < pool.length; i++) {
    if (gone.has(pool[i].id)) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const a = cur(pool[i]), b = pool[j];
      if (gone.has(b.id) || a.kind !== b.kind || (a.slot && b.slot && a.slot !== b.slot)) continue;
      if (overlap(a.text, b.text) < MERGE_AT) continue;
      put({ ...a, strength: (a.strength ?? 1) + (b.strength ?? 1), lastSeen: Math.max(a.lastSeen ?? 0, b.lastSeen ?? 0), importance: Math.max(a.importance ?? 5, b.importance ?? 5) });
      put({ ...b, state: 'merged', mergedInto: a.id, mergedAt: now });
      gone.add(b.id);
      did.merged++;
    }
  }

  // Promote verified lessons; let unused facts and events go dormant.
  for (const m of all) {
    const c = cur(m);
    if (!live(c)) continue;
    if (c.kind === 'lesson' && (c.verified ?? 0) >= PROMOTE_AT) { put({ ...c, kind: 'procedure', promotedAt: now }); did.promoted++; continue; }
    if (!NEVER_FADES.has(c.kind) && retention(c, now) < DORMANT_BELOW) { put({ ...c, state: 'dormant', dormantAt: now }); did.dormant++; }
  }

  if (!dry && changed.size) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, [...changed.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  }
  if (!dry && record) {
    const after = load(file).filter(live).length;
    writeLayerMeta({ ...readLayerMeta({ home }), lastSleep: now, lastResult: { ...did, live: after } }, { home });
    noteMemoryEvent('sleep', { ...did, live: after }, { home, at: now });
  }
  return did;
}

/** A lesson from something that went wrong. It is replayed as a lesson, and becomes a procedure once verified. */
export function recordLesson(text, { file, now = Date.now(), source = 'run' } = {}) {
  const statement = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!statement) return null;
  const existing = load(file).find((m) => live(m) && ['lesson', 'procedure'].includes(m.kind) && overlap(m.text, statement) >= MERGE_AT);
  if (existing) return existing;
  const m = {
    id: crypto.randomBytes(5).toString('hex'), text: statement, kind: 'lesson', scope: 'user', entities: [], slot: null,
    importance: 7, strength: 1, createdAt: now, lastSeen: now, validFrom: now, validTo: null, expiresAt: null,
    state: 'active', latest: true, updates: null, extends: [], source, verified: 0,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(m)}\n`, { mode: 0o600 });
  return m;
}

/** The lesson held up again (the fix worked). Two of these and the next sleep promotes it. */
export function verifyLesson(id, { file, now = Date.now() } = {}) {
  const m = load(file).find((x) => x.id === id);
  if (!m || !live(m) || !['lesson', 'procedure'].includes(m.kind)) return null;
  const next = { ...m, verified: (m.verified ?? 0) + 1, lastSeen: now };
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return next;
}

/** Everything the Memory page shows, from the files as they are now. */
export function layerSnapshot({ home = os.homedir(), cwd = process.cwd(), now = Date.now() } = {}) {
  const userFile = memoryFile('user', { home });
  const projFile = memoryFile('project', { cwd });
  const user = load(userFile), project = load(projFile);
  const count = (rows) => {
    const byState = {}, byKind = {};
    for (const m of rows) {
      byState[m.state ?? 'active'] = (byState[m.state ?? 'active'] ?? 0) + 1;
      if (live(m)) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    }
    return { total: rows.length, live: rows.filter(live).length, superseded: rows.filter((m) => m.state === 'active' && m.latest === false).length, byState, byKind };
  };
  const events = readMemoryEvents({ home, limit: 400 });
  const reads = events.filter((e) => e.type === 'read');
  const writes = events.filter((e) => e.type === 'write');
  const sleeps = events.filter((e) => e.type === 'sleep');
  const p = profile({ file: userFile, now });
  const strongest = user.filter(live).map((m) => ({ id: m.id, text: m.text, kind: m.kind, strength: m.strength ?? 1, recalled: m.recalled ?? 0, verified: m.verified ?? 0, retention: Math.round(retention(m, now) * 100) / 100, halfLife: HALF_LIFE_DAYS[m.kind] ?? 90, createdAt: m.createdAt, validFrom: m.validFrom }))
    .sort((a, b) => b.retention - a.retention).slice(0, 24);
  const legacy = (() => { try { return fs.readFileSync(path.join(memoryHome({ home }), 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const projectMd = (() => { try { return fs.statSync(path.join(cwd, '.agent', 'MEMORY.md')).size; } catch { return 0; } })();
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const opCounts = writes.reduce((o, e) => ((o[e.op] = (o[e.op] ?? 0) + 1), o), {});
  const meta = readLayerMeta({ home });
  return {
    now,
    store: { user: count(user), project: count(project), legacyRows: legacy, projectMemoryMdBytes: projectMd },
    read: { runs: reads.length, avgTokens: avg(reads.map((e) => e.tokens ?? 0)), lastTokens: reads.at(-1)?.tokens ?? 0, avgRecalled: avg(reads.map((e) => (e.relevant ?? 0))), recent: reads.slice(-12).map((e) => ({ at: e.at, tokens: e.tokens ?? 0, profile: e.profile ?? 0, relevant: e.relevant ?? 0 })) },
    write: { total: writes.length, ops: opCounts, recent: writes.slice(-16).map((e) => ({ at: e.at, op: e.op, kind: e.kind, scope: e.scope })) },
    sleep: { lastAt: meta.lastSleep ?? null, last: meta.lastResult ?? null, runs: sleeps.length, recent: sleeps.slice(-6) },
    profile: { stable: p.stable.map((m) => ({ id: m.id, text: m.text, kind: m.kind })), lately: p.lately.map((m) => ({ id: m.id, text: m.text, kind: m.kind })) },
    strongest,
    halfLives: HALF_LIFE_DAYS,
    kinds: KINDS,
    learning: process.env.OX_LEARN !== '0',
  };
}

/** Sleep the user graph (and this project's) now and every few hours, off the request path. */
export function startSleepCycle({ home = os.homedir(), cwd = process.cwd(), everyMs = 6 * 3600_000 } = {}) {
  if (process.env.NODE_TEST_CONTEXT || process.env.OX_MEMORY === '0') return () => {};
  const run = () => {
    try { sleep({ file: memoryFile('user', { home }), home }); } catch {}
    try { if (fs.existsSync(memoryFile('project', { cwd }))) sleep({ file: memoryFile('project', { cwd }), home, recalls: new Map(), record: false }); } catch {}
  };
  const first = setTimeout(run, 30_000); first.unref?.();
  const t = setInterval(run, everyMs); t.unref?.();
  return () => { clearTimeout(first); clearInterval(t); };
}
