// ox's long-term memory: a temporal graph of facts, kept on this machine.
//
// What it does, and where each idea comes from:
//
//   * Updates, not piles. A new fact about the same thing ("works at Stripe")
//     supersedes the old one ("works at Google"): the old one keeps its history
//     but stops being "latest". Supermemory's updates / extends / derives
//     relations; Mem0's ADD / UPDATE / NOOP write decision.
//   * Two clocks. Every fact records when ox learned it (createdAt) and when it
//     held in the world (validFrom / validTo), so "where did I work in March?"
//     still has an answer after the update. Zep / Graphiti's bi-temporal edges
//     (arXiv 2501.13956): a contradicting fact closes the old one's validity
//     at the new one's start instead of deleting it.
//   * Real dates. "tomorrow", "next Friday", "in 3 days" are resolved against
//     the moment they were said (Graphiti's reference timestamp), so they
//     still mean the right day next week.
//   * Forgetting on purpose. Things that only matter until a moment ("exam
//     tomorrow") expire after it; preferences grow stronger each time they are
//     repeated; one-off episodes fade with time unless they were important.
//   * Recall that ranks. Lexical BM25 over the text, one hop over shared
//     entities (Graphiti's BFS), recency and importance (the recency /
//     importance / relevance score of Park et al., "Generative Agents", 2023),
//     fused with reciprocal-rank fusion so no one signal's scale dominates.
//   * A profile. A short "always true" part and a "lately" part, put in front
//     of every run so ox starts each task already knowing you.
//
// Nothing here deletes. Expired and superseded facts stay on disk with their
// state; `forget` marks a fact forgotten and keeps it out of every prompt.
// Every write goes through the same credential / injection screen as
// .agent/MEMORY.md, because these facts are replayed into future prompts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { screenPersistText } from './memory.js';
import { noteMemoryEvent } from './memory-events.js';

// The events log lives beside the user graph; a project graph logs there too.
// A project graph's events go to the real home only outside the test runner, so
// tests never write the owner's files.
const homeOf = (file) => {
  const dir = path.dirname(file);
  if (path.basename(dir) === 'memory' && path.basename(path.dirname(dir)) === '.ox') return path.dirname(path.dirname(dir));
  return process.env.NODE_TEST_CONTEXT && !process.env.OX_MEMORY_HOME ? null : undefined;
};
function logEvent(file, type, data) {
  const home = homeOf(file);
  if (home !== null) noteMemoryEvent(type, { ...data, scope: file.includes(`${path.sep}.agent${path.sep}`) ? 'project' : 'user' }, { home });
}

export const KINDS = Object.freeze(['fact', 'preference', 'event', 'lesson', 'procedure', 'derived']);
const DAY = 86_400_000;

export function memoryFile(scope = 'user', { cwd = process.cwd(), home = os.homedir() } = {}) {
  return scope === 'project'
    ? path.join(cwd, '.agent', 'memory-graph.jsonl')
    : path.join(process.env.OX_MEMORY_HOME || path.join(home, '.ox', 'memory'), 'graph.jsonl');
}

// ---- storage: one JSON object per line, last line for an id wins ----------

export function load(file) {
  const byId = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m.id === 'string') byId.set(m.id, m);
    } catch {}
  }
  return [...byId.values()];
}

function append(file, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
}

// Rewrite without the superseded lines once the log is mostly history.
export function compact(file) {
  const all = load(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return all.length;
}

// ---- text: tokens, entities, slots ----------------------------------------

const STOP = new Set('a an the and or but of to in on at for with by from is are was were be been am i me my you your it its this that these those we our they them their he she his her do does did not no so as if then than there here what which who whom when where why how all any some can could should would will just also very really about into over under up down out off again more most such only own same too s t don now'.split(' '));

export function tokens(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}._/@-]+/gu, ' ').split(/\s+/)
    .map((t) => stem(t.replace(/^[._/-]+|[._/-]+$/g, '')))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Light stemming so "tests" finds "test" and "deploying" finds "deploy".
// Identifiers, paths and handles are left exactly as written.
function stem(t) {
  if (t.length < 5 || /[._/@\d-]/.test(t)) return t;
  if (t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

// Names worth linking on: Capitalised words, code identifiers, paths, @handles.
export function entities(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/(?:^|[\s(])((?:[A-Z][\p{L}\p{N}]+)(?:\s+[A-Z][\p{L}\p{N}]+)*)/gu)) {
    const e = m[1].trim();
    if (!/^(I|The|A|An|It|This|That|We|You|He|She|They|My|Our|Use|Always|Never|Prefer|Do|Don't|Please|When|If)$/.test(e)) out.add(e.toLowerCase());
  }
  for (const m of s.matchAll(/(?:@[\w.-]+|[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:js|ts|tsx|py|go|rs|json|md|toml|yml|yaml)\b|\b[a-z]+[A-Z]\w+\b)/g)) out.add(m[0].toLowerCase());
  return [...out].slice(0, 12);
}

// The "slot" a statement fills: who/what it is about and the relation, so a
// second statement about the same slot is an update, not a new fact.
const RELATIONS = [
  ['works-at', /\b(?:works?|working|employed|job)\s+(?:at|for)\b|\bjoined\b|\bstarted at\b/i],
  ['lives-in', /\b(?:lives?|living|based|moved)\s+(?:in|to)\b/i],
  ['prefers', /\b(?:prefers?|likes?|loves?|wants?|favou?rite|rather|always use|use\s+\S+\s+instead)\b/i],
  ['avoids', /\b(?:hates?|dislikes?|never|avoid|don'?t (?:use|like|want)|no longer|stopped)\b/i],
  ['uses', /\b(?:uses?|using|switched to|on|runs?)\b/i],
  ['is', /\b(?:is|are|am|'s|'re|'m)\b/i],
  ['has', /\b(?:has|have|owns?)\b/i],
  ['name', /\b(?:called|named|name is|call me)\b/i],
];

export function slotOf(text, ents = entities(text)) {
  const s = String(text ?? '');
  const lower = s.toLowerCase();
  let rel = null;
  let at = Infinity;
  for (const [name, re] of RELATIONS) {
    const m = re.exec(s);
    if (m && m.index < at) { rel = name; at = m.index; }
  }
  if (!rel) return null;
  // "avoids" and "prefers" fill the same slot: a new opinion replaces the old one.
  const relKey = rel === 'avoids' ? 'prefers' : rel;
  const before = lower.slice(0, at);
  let subject = tokens(before).slice(-3).join(' ');
  if (!subject || /^(user|i|me|my)$/.test(subject) || /\b(i|user|me)$/.test(before.trim())) subject = 'user';
  // A topic for preference slots: "prefers tabs over spaces" / "uses pnpm" are
  // about package managers, indentation… we approximate with the first object
  // noun phrase's head entity, falling back to the first content token.
  const after = s.slice(at);
  const object = (entities(after)[0] ?? tokens(after).filter((t) => !/^(prefers?|likes?|uses?|using|is|are|am|has|have|always|never|instead|use)$/.test(t))[0] ?? '');
  const topic = relKey === 'prefers' || relKey === 'uses' ? TOPIC_OF[object] ?? object : '';
  return { subject, relation: relKey, topic, object, polarity: rel === 'avoids' ? -1 : 1, ents };
}

// Things that compete for the same choice: a new one replaces the old one.
const TOPIC_OF = Object.fromEntries([
  ...['npm', 'pnpm', 'yarn', 'bun'].map((k) => [k, 'package-manager']),
  ...['tabs', 'spaces'].map((k) => [k, 'indentation']),
  ...['vim', 'neovim', 'emacs', 'vscode', 'cursor', 'zed', 'xcode'].map((k) => [k, 'editor']),
  ...['jest', 'vitest', 'mocha', 'pytest'].map((k) => [k, 'test-runner']),
  ...['dark', 'light'].map((k) => [k, 'theme']),
  ...['zsh', 'bash', 'fish', 'powershell'].map((k) => [k, 'shell']),
  ...['mac', 'macos', 'windows', 'linux', 'ubuntu'].map((k) => [k, 'os']),
]);

// ---- time: resolve what people say into dates -------------------------------

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Returns { at, until } in ms when the text names a moment, else null.
export function resolveWhen(text, ref = Date.now()) {
  const s = String(text ?? '').toLowerCase();
  const day0 = startOfDay(ref);
  let m;
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening))\b/.test(s)) return { at: day0, until: day0 + DAY };
  if (/\btomorrow\b/.test(s)) return { at: day0 + DAY, until: day0 + 2 * DAY };
  if (/\byesterday\b/.test(s)) return { at: day0 - DAY, until: day0 };
  if ((m = /\bin (\d{1,3}) (day|week|month)s?\b/.exec(s))) {
    const n = Number(m[1]) * (m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30);
    return { at: day0 + n * DAY, until: day0 + (n + 1) * DAY };
  }
  if ((m = /\b(\d{1,3}) (day|week|month)s? ago\b/.exec(s))) {
    const n = Number(m[1]) * (m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30);
    return { at: day0 - n * DAY, until: day0 - (n - 1) * DAY };
  }
  if (/\bnext week\b/.test(s)) { const d = new Date(day0); const toMon = ((8 - d.getDay()) % 7) || 7; return { at: day0 + toMon * DAY, until: day0 + (toMon + 7) * DAY }; }
  if (/\bthis week\b/.test(s)) { const d = new Date(day0); const toMon = ((8 - d.getDay()) % 7) || 7; return { at: day0, until: day0 + toMon * DAY }; }
  if ((m = /\b(next |this |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(s))) {
    const want = WEEKDAYS.indexOf(m[2]);
    const now = new Date(day0).getDay();
    let diff = (want - now + 7) % 7;
    if (diff === 0 || m[1] === 'next ') diff = diff === 0 ? 7 : diff;
    return { at: day0 + diff * DAY, until: day0 + (diff + 1) * DAY };
  }
  if ((m = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(s))) {
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return { at, until: at + DAY };
  }
  return null;
}

// ---- writing ---------------------------------------------------------------

function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

const isLive = (m, now = Date.now()) => m.state === 'active' && m.latest !== false && !(m.expiresAt && m.expiresAt < now);

function guessKind(text) {
  const s = String(text).toLowerCase();
  if (/\b(prefers?|likes?|loves?|hates?|dislikes?|always|never|rather|favou?rite|don'?t (?:like|want|use)|call me)\b/.test(s)) return 'preference';
  if (resolveWhen(s)) return 'event';
  if (/\b(lesson|gotcha|learned|turns out|remember that)\b/.test(s)) return 'lesson';
  return 'fact';
}

// Remember one statement. Returns { op: 'add'|'update'|'extend'|'noop'|'refused', memory, previous? }.
export function remember(text, {
  scope = 'user', cwd = process.cwd(), home = os.homedir(), kind = null, source = null,
  importance = null, ref = Date.now(), file = memoryFile(scope, { cwd, home }), slot: slotOverride = null,
} = {}) {
  const statement = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!statement) return { op: 'refused', reason: 'nothing to remember' };
  if (statement.length > 1000) return { op: 'refused', reason: 'too long to be one memory (1000 characters at most)' };
  const refusal = screenPersistText(statement, 'memory', 'ox memory');
  if (refusal) return { op: 'refused', reason: refusal };
  const k = KINDS.includes(kind) ? kind : guessKind(statement);
  const ents = entities(statement);
  const slot = slotOf(statement, ents);
  const when = resolveWhen(statement, ref);
  const all = load(file);
  const live = all.filter((m) => isLive(m, ref));

  // NOOP: said again. Repetition makes a preference stronger, not a duplicate.
  const same = live.find((m) => similarity(m.text, statement) >= 0.9 && Math.abs(m.text.length - statement.length) < 40);
  if (same) {
    const bumped = { ...same, strength: (same.strength ?? 1) + 1, lastSeen: ref };
    append(file, [bumped]);
    logEvent(file, 'write', { op: 'noop', kind: bumped.kind, id: bumped.id });
    return { op: 'noop', memory: bumped };
  }

  const memory = {
    id: crypto.randomBytes(5).toString('hex'),
    text: statement, kind: k, scope,
    entities: ents, slot: slotOverride ?? (slot ? `${slot.subject}|${slot.relation}${slot.topic ? `|${slot.topic}` : ''}` : null),
    importance: Number.isFinite(importance) ? Math.max(1, Math.min(10, importance)) : (k === 'preference' ? 6 : k === 'lesson' ? 7 : k === 'event' ? 4 : 5),
    strength: 1, createdAt: ref, lastSeen: ref, validFrom: when?.at ?? ref, validTo: null,
    expiresAt: k === 'event' && when ? when.until + DAY : null,
    state: 'active', latest: true, updates: null, extends: [], source,
  };

  // UPDATE: the same slot with a different value closes the old fact's validity.
  const changed = [];
  let previous = null;
  if (memory.slot && (slotOverride || /\|(works-at|lives-in|prefers|uses|name|is)/.test(memory.slot))) {
    previous = live.find((m) => m.slot === memory.slot && m.id !== memory.id);
    if (previous) {
      memory.updates = previous.id;
      changed.push({ ...previous, latest: false, validTo: memory.validFrom, supersededBy: memory.id });
    }
  }
  // EXTEND: shares what it is about, adds to it without replacing anything.
  if (!previous && ents.length) {
    memory.extends = live.filter((m) => m.entities?.some((e) => ents.includes(e))).slice(0, 5).map((m) => m.id);
  }
  append(file, [...changed, memory]);
  const op = previous ? 'update' : memory.extends.length ? 'extend' : 'add';
  logEvent(file, 'write', { op, kind: memory.kind, id: memory.id, ...(previous ? { replaced: previous.id } : {}) });
  return { op, memory, previous };
}

export function forget(id, { file }) {
  const m = load(file).find((x) => x.id === id);
  if (!m) return null;
  const gone = { ...m, state: 'forgotten', forgottenAt: Date.now() };
  append(file, [gone]);
  logEvent(file, 'write', { op: 'forget', kind: m.kind, id });
  return gone;
}

// The version chain for one fact, oldest first.
export function history(id, { file }) {
  const all = load(file);
  const byId = new Map(all.map((m) => [m.id, m]));
  let cur = byId.get(id);
  if (!cur) return [];
  while (cur.supersededBy && byId.get(cur.supersededBy)) cur = byId.get(cur.supersededBy);
  const chain = [cur];
  while (cur.updates && byId.get(cur.updates)) { cur = byId.get(cur.updates); chain.unshift(cur); }
  return chain;
}

// ---- recall ----------------------------------------------------------------

function bm25(docs, query) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return docs.map(() => 0);
  const toks = docs.map((d) => tokens(`${d.text} ${(d.entities ?? []).join(' ')} ${String(d.slot ?? '').replace(/[|-]/g, ' ')}`));
  const avg = toks.reduce((a, t) => a + t.length, 0) / Math.max(1, toks.length) || 1;
  const df = new Map(q.map((t) => [t, toks.filter((d) => d.includes(t)).length]));
  const N = docs.length;
  return toks.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t || (t.length > 3 && x.startsWith(t))).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg)));
    }
    return s;
  });
}

const HALF_LIFE = { event: 7, fact: 120, preference: 365, lesson: 180, procedure: 180, derived: 60 };

// Ranked memories for a query. `at` asks what was true at that moment
// (validity, not "latest"); `includeHistory` returns superseded facts too.
export function recall(query, { file, k = 8, now = Date.now(), at = null, includeHistory = false } = {}) {
  const all = load(file).filter((m) => m.state === 'active');
  let pool;
  if (at != null) pool = all.filter((m) => m.validFrom <= at && (m.validTo == null || m.validTo > at));
  else pool = all.filter((m) => (includeHistory || m.latest !== false) && !(m.expiresAt && m.expiresAt < now));
  if (!pool.length) return [];
  const lex = bm25(pool, query);
  const qEnts = new Set([...entities(query), ...tokens(query)]);
  // One hop over shared entities: memories linked to a strong lexical hit.
  const seeds = new Set(pool.filter((_, i) => lex[i] > 0).flatMap((m) => m.entities ?? []));
  const graph = pool.map((m) => (m.entities ?? []).reduce((s, e) => s + (qEnts.has(e) ? 2 : seeds.has(e) ? 1 : 0), 0));
  const recency = pool.map((m) => Math.pow(0.5, (now - (m.lastSeen ?? m.createdAt)) / DAY / (HALF_LIFE[m.kind] ?? 90)));
  const weight = pool.map((m) => (m.importance ?? 5) * (1 + Math.log(m.strength ?? 1)));
  const rank = (arr) => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); const r = new Array(arr.length); idx.forEach(([, i], pos) => (r[i] = pos)); return r; };
  const [rl, rg, rr, rw] = [rank(lex), rank(graph), rank(recency), rank(weight)];
  const RRF = 60;
  const relevant = pool.map((_, i) => lex[i] > 0 || graph[i] > 0);
  const anyRelevant = relevant.some(Boolean);
  const scored = pool.map((m, i) => ({
    m,
    score: (lex[i] > 0 ? 1 / (RRF + rl[i]) : 0) * 2 + (graph[i] > 0 ? 1 / (RRF + rg[i]) : 0) + 1 / (RRF + rr[i]) * 0.6 + 1 / (RRF + rw[i]) * 0.6,
  }));
  // A question nothing matches gets nothing back, not the most recent noise.
  if (String(query ?? '').trim()) {
    if (!anyRelevant) return [];
    return scored.filter((_, i) => relevant[i]).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.m);
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.m);
}

// ---- profile ---------------------------------------------------------------

export function profile({ file, now = Date.now(), maxStatic = 12, maxRecent = 8 } = {}) {
  const live = load(file).filter((m) => isLive(m, now));
  const stable = live.filter((m) => ['preference', 'fact', 'lesson', 'procedure', 'derived'].includes(m.kind))
    .sort((a, b) => (b.strength ?? 1) * (b.importance ?? 5) - (a.strength ?? 1) * (a.importance ?? 5))
    .slice(0, maxStatic);
  const lately = live.filter((m) => now - m.createdAt < 7 * DAY && !stable.includes(m))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, maxRecent);
  return { stable, lately, total: live.length };
}

export const fmtDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// The block put in front of a run: the profile, then what bears on this task.
export function memoryPromptBlock({ cwd = process.cwd(), home = os.homedir(), task = '', now = Date.now() } = {}) {
  if (process.env.OX_INCOGNITO === '1') return ''; // private: nothing about you goes in
  const userFile = memoryFile('user', { home });
  const projFile = memoryFile('project', { cwd });
  const p = profile({ file: userFile, now });
  const seen = new Set([...p.stable, ...p.lately].map((m) => m.id));
  const relevant = task ? [...recall(task, { file: projFile, now, k: 6 }), ...recall(task, { file: userFile, now, k: 6 })].filter((m) => !seen.has(m.id)).slice(0, 8) : [];
  const line = (m) => `- ${m.text}${m.kind === 'event' ? ` (${fmtDay(m.validFrom)})` : ''}`;
  const parts = [];
  if (p.stable.length) parts.push(`About the user (always true until they say otherwise):\n${p.stable.map(line).join('\n')}`);
  if (p.lately.length) parts.push(`Lately:\n${p.lately.map(line).join('\n')}`);
  if (relevant.length) parts.push(`Remembered and relevant to this task:\n${relevant.map(line).join('\n')}`);
  const block = parts.length ? `# WHAT OX REMEMBERS\nFacts you learned from this user in earlier sessions, newest version only. Use them; if one is wrong, they will tell you and you update it with memory_add.\n${parts.join('\n\n')}` : '';
  // The read path only reads: what it put in front of the run is logged, and
  // the sleep pass turns those recalls into stronger memories later.
  logEvent(userFile, 'read', {
    profile: p.stable.length + p.lately.length, relevant: relevant.length,
    tokens: Math.ceil(block.length / 4), ids: [...p.stable, ...p.lately, ...relevant].map((m) => m.id), total: p.total,
  });
  return block;
}

// ---- learning from what the user says -------------------------------------

// Statements in the user's own messages that are worth keeping: preferences,
// corrections, facts about themselves. Conservative on purpose: only first-
// person or imperative "always / never / prefer" shapes, never task text.
const LEARNABLE = [
  /\b(?:i|we)\s+(?:always|never|usually|prefer|like|love|hate|don'?t like|use|work (?:at|on|for)|live in|am|'m)\b[^.!?\n]{3,160}/i,
  // "I want you to always…" is how to work; "I want you to open Chrome…" is
  // one request, and it was stored as a fact about the user (always true).
  /\b(?:i|we)\s+want you to\s+(?:always|never|stop|keep|remember)\b[^.!?\n]{3,160}/i,
  /\b(?:please\s+)?(?:always|never|don'?t ever|stop)\s+(?:use|write|add|run|commit|push|call|reply|answer|ask)\b[^.!?\n]{2,160}/i,
  /\b(?:call me|my name is)\s+[A-Z][\p{L}-]{1,30}/iu,
  /\b(?:use|prefer)\s+\S+\s+(?:instead of|over|rather than)\s+[^.!?\n]{2,80}/i,
];

export function learnable(message) {
  const out = [];
  for (const sentence of String(message ?? '').split(/(?<=[.!?\n])\s+/)) {
    const s = sentence.trim();
    if (s.length < 8 || s.length > 240 || /```|\bhttps?:\/\//.test(s)) continue;
    // A question or a request is not a fact about the user.
    if (/\?\s*$/.test(s) || /^(?:hey|hi|ok(?:ay)?|so|now)?[,\s]*(?:can|could|would|will) you\b/i.test(s)) continue;
    if (LEARNABLE.some((re) => re.test(s))) out.push(s.replace(/[.!?]+$/, ''));
  }
  return out.slice(0, 5);
}

// Called with the user's messages after a run: remember what they told ox
// about themselves. Returns what changed, for the "· remembered …" line.
export function learnFromMessages(messages = [], { home = os.homedir(), source = null, ref = Date.now(), incognito = false } = {}) {
  if (process.env.OX_LEARN === '0' || incognito || process.env.OX_INCOGNITO === '1') return [];
  const file = memoryFile('user', { home });
  const done = [];
  for (const m of messages) {
    if (m?.role !== 'user') continue;
    for (const s of learnable(typeof m.content === 'string' ? m.content : '')) {
      const r = remember(s, { file, source, ref, scope: 'user' });
      if (r.op !== 'refused' && r.op !== 'noop') done.push(r);
    }
  }
  return done;
}

// ---- how this project is run (Devin's "save to environment") -----------------

const COMMAND_KINDS = [
  ['test', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^npx\s+(?:vitest|jest)\b|^node\s+--test\b|^(?:pytest|go test|cargo test|make test|mvn test|gradle test|swift test|deno test)\b/],
  ['lint', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|^npx\s+(?:eslint|biome|tsc\b)|^(?:ruff|flake8|golangci-lint|cargo clippy|swiftlint)\b/],
  ['build', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^(?:cargo build|go build|make|swift build|mvn package|gradle build|xcodebuild)\b/],
  ['install', /^(?:npm (?:install|ci)|pnpm install|yarn(?: install)?|bun install|pip install -r|poetry install|uv sync|go mod download|bundle install)\s*$|^(?:npm ci|pip install -r \S+)$/],
  ['start', /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b|^(?:python manage\.py runserver|rails s|cargo run|go run)\b/],
];

// A plain project command of a known kind, or null. Anything chained, piped or
// redirected is left alone: what gets remembered must be safe to suggest again.
export function commandKind(command) {
  const c = String(command ?? '').trim().replace(/^cd\s+[\w./~-]+\s*&&\s*/, '');
  if (!c || c.length > 160 || /[|;`$<>]|&&/.test(c)) return null;
  for (const [kind, re] of COMMAND_KINDS) if (re.test(c)) return { kind, command: c };
  return null;
}

// After a run: the commands that worked are how this project is tested,
// linted, built, installed and started. The newest working one replaces the old.
export function learnProjectCommands(calls = [], { cwd = process.cwd(), ref = Date.now() } = {}) {
  if (process.env.OX_LEARN === '0' || process.env.OX_INCOGNITO === '1') return [];
  const file = memoryFile('project', { cwd });
  const done = [];
  const seen = new Set();
  for (const call of calls) {
    if (call?.ok !== true || !/^(?:bash|shell|run_command)$/.test(String(call.name))) continue;
    const k = commandKind(call.args?.command ?? call.args?.cmd);
    if (!k || seen.has(k.kind)) continue;
    seen.add(k.kind);
    const what = k.kind === 'start' ? 'run it locally' : k.kind === 'install' ? 'install its dependencies' : `${k.kind} this project`;
    const r = remember(`To ${what}: \`${k.command}\``, { file, scope: 'project', kind: 'procedure', importance: 7, ref, slot: `project|command|${k.kind}`, source: 'run' });
    if (r.op === 'add' || r.op === 'update' || r.op === 'extend') done.push(r);
  }
  return done;
}
