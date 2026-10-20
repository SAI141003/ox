// ox brain: memory as a folder of markdown notes that opens in Obsidian, with a
// small search index beside it.
//
// Agents use files well and graph-database tools badly: plain files searched
// with ordinary tools beat a graph memory on LoCoMo (Letta, 74.0 vs 68.5), and
// fetching a little beats sending everything (Zep: 1.6k tokens beat 115k). So:
//   - the notes are the truth: ~/.ox/brain/*.md (or OX_BRAIN_DIR, e.g. your
//     Obsidian vault), YAML front matter, [[wikilinks]];
//   - .brain.db (SQLite, built into Node) is derived and can always be rebuilt:
//     full-text search (BM25), links, and vectors when a local embedding model
//     is there (Ollama); the two rankings are fused (reciprocal rank fusion);
//   - results grow one hop along links and stop at ~1,500 tokens;
//   - a fact is never deleted when it changes: the new note `supersedes` the old,
//     which gets `valid_to`; search prefers what is current;
//   - INDEX.md (at most 200 lines) lists every current note, for the prompt;
//   - consolidate() merges duplicates and closes superseded notes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const brainDir = () => process.env.OX_BRAIN_DIR || path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'brain');
const DB_NAME = '.brain.db';
const today = () => new Date().toISOString().slice(0, 10);

let sqlite = null;
async function sql() {
  if (sqlite !== null) return sqlite;
  try {
    // node:sqlite (Node 22.5+) prints an "experimental" warning once; keep it off the user's screen.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
    try { sqlite = (await import('node:sqlite')).DatabaseSync; } finally { process.emitWarning = emit; }
  } catch { sqlite = false; }
  return sqlite;
}

// ---------------------------------------------------------------- notes
export const slugOf = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'note';

/** { meta, body } from a note's text (front matter between --- lines; lists as [a, b] or "- a"). */
export function parseNote(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text));
  if (!m) return { meta: {}, body: String(text) };
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      meta[key] = v.startsWith('[') ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : v === '' ? [] : v.replace(/^["']|["']$/g, '');
    } else if (key && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(meta[key])) meta[key] = [];
      meta[key].push(line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { meta, body: String(text).slice(m[0].length) };
}

export function noteText(meta, body) {
  const v = (x) => (Array.isArray(x) ? `[${x.map((s) => (/[,\]]/.test(s) ? `"${s}"` : s)).join(', ')}]` : /[:#]/.test(String(x)) ? `"${String(x).replace(/"/g, "'")}"` : String(x));
  const lines = Object.entries(meta).filter(([, x]) => x != null && x !== '' && !(Array.isArray(x) && !x.length)).map(([k, x]) => `${k}: ${v(x)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

export const linksIn = (body) => [...new Set([...String(body).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim()))];

function walk(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md') && e.name !== 'INDEX.md') out.push(p);
  }
  return out;
}

/**
 * Write a note. `supersedes`: titles of notes this one replaces; they get
 * valid_to today and a link to this one (never deleted). → { path, title }
 */
export function remember({ title, body, tags = [], type = 'note', source = null, supersedes = [], project = null, folder = '' }, { dir = brainDir() } = {}) {
  if (!String(title ?? '').trim()) throw new Error('a note needs a title');
  const d = path.join(dir, folder);
  fs.mkdirSync(d, { recursive: true });
  let file = path.join(d, `${slugOf(title)}.md`);
  // Same title, different note: keep both.
  for (let i = 2; fs.existsSync(file) && parseNote(fs.readFileSync(file, 'utf8')).meta.title !== title; i++) file = path.join(d, `${slugOf(title)}-${i}.md`);
  const meta = { title, type, tags, project, source, valid_from: today(), supersedes: supersedes.length ? supersedes : null };
  let text = String(body ?? '').trim();
  if (supersedes.length) text += `\n\nReplaces ${supersedes.map((s) => `[[${s}]]`).join(', ')}.`;
  fs.writeFileSync(file, noteText(meta, text));
  for (const old of supersedes) close(old, title, { dir });
  return { path: file, title };
}

/** Mark a note no longer current (valid_to today), pointing to what replaced it. */
export function close(title, by, { dir = brainDir() } = {}) {
  for (const f of walk(dir)) {
    const text = fs.readFileSync(f, 'utf8');
    const { meta, body } = parseNote(text);
    if ((meta.title ?? path.basename(f, '.md')) !== title || meta.valid_to) continue;
    fs.writeFileSync(f, noteText({ ...meta, valid_to: today(), superseded_by: by }, `${body.trim()}\n\nReplaced by [[${by}]].`));
    return f;
  }
  return null;
}

// ---------------------------------------------------------------- the index
async function open(dir) {
  const Db = await sql();
  if (!Db) return null;
  fs.mkdirSync(dir, { recursive: true });
  const db = new Db(path.join(dir, DB_NAME));
  db.exec(`create table if not exists notes (path text primary key, title text, mtime real, valid_to text, project text, tokens int);
    create virtual table if not exists fts using fts5(path unindexed, title, body, tags);
    create table if not exists links (src text, dst text);
    create table if not exists vecs (path text primary key, model text, v blob);
    create index if not exists links_dst on links(dst);`);
  return db;
}

// ---------------------------------------------------------------- your other words
// Read-only sources searched with the notes (ShogunAI's "Ask": one question over
// your notes, meetings and reading, each answer saying where it came from):
// the call notes and other files in ~/ox-notes, and what you saved to the library.
// Indexed under "@notes/…" and "@library/…"; never written to, never in INDEX.md.
export function defaultSources(home = os.homedir()) {
  if (process.env.OX_BRAIN_SOURCES === '0') return [];
  return [{ kind: 'notes', dir: path.join(home, 'ox-notes') }, { kind: 'library', dir: path.join(process.env.OX_HOME || path.join(home, '.ox'), 'library') }];
}
function sourceEntries(sources) {
  const out = [];
  for (const s of sources) {
    if (s.kind === 'notes') for (const f of walk(s.dir)) out.push({ rel: `@notes/${f}`, mtime: () => fs.statSync(f).mtimeMs, load: () => ({ meta: { title: path.basename(f, '.md'), source: f, project: '@notes' }, body: fs.readFileSync(f, 'utf8') }) });
    if (s.kind === 'library') {
      let names = [];
      try { names = fs.readdirSync(s.dir).filter((n) => n.endsWith('.json')); } catch {}
      for (const n of names) {
        const f = path.join(s.dir, n);
        out.push({ rel: `@library/${n.replace(/\.json$/, '')}`, mtime: () => fs.statSync(f).mtimeMs, load: () => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return { meta: { title: j.title || n, source: j.source || f, project: '@library' }, body: String(j.text ?? '') }; } });
      }
    }
  }
  return out;
}
function loadEntry(dir, rel, sources) {
  if (!rel.startsWith('@')) return parseNote(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const e = sourceEntries(sources).find((x) => x.rel === rel);
  return e ? e.load() : null;
}

/** Bring brain.db up to date with the notes (only changed files are read). → { indexed, removed, total } */
export async function index({ dir = brainDir(), embed = null, sources = dir === brainDir() ? defaultSources() : [] } = {}) {
  const db = await open(dir);
  if (!db) return { indexed: 0, removed: 0, total: walk(dir).length, noIndex: 'this Node has no built-in SQLite (Node 22.5+); search reads the files directly' };
  const entries = [
    ...walk(dir).map((f) => ({ rel: path.relative(dir, f), mtime: () => fs.statSync(f).mtimeMs, load: () => parseNote(fs.readFileSync(f, 'utf8')) })),
    ...sourceEntries(sources),
  ];
  const known = new Map(db.prepare('select path, mtime from notes').all().map((r) => [r.path, r.mtime]));
  let indexed = 0;
  db.exec('begin');
  try {
    for (const e of entries) {
      const rel = e.rel;
      let mtime;
      try { mtime = e.mtime(); } catch { continue; }
      if (known.get(rel) === mtime) { known.delete(rel); continue; }
      known.delete(rel);
      let loaded;
      try { loaded = e.load(); } catch { continue; }
      const { meta, body } = loaded;
      const title = meta.title || path.basename(rel, '.md');
      db.prepare('delete from fts where path = ?').run(rel);
      db.prepare('delete from links where src = ?').run(rel);
      db.prepare('insert or replace into notes values (?, ?, ?, ?, ?, ?)').run(rel, title, mtime, meta.valid_to || null, meta.project || null, Math.ceil(body.length / 4));
      db.prepare('insert into fts (path, title, body, tags) values (?, ?, ?, ?)').run(rel, title, body, [].concat(meta.tags ?? []).join(' '));
      for (const l of linksIn(body)) db.prepare('insert into links values (?, ?)').run(rel, l);
      if (embed) { try { const v = await embed(`${title}\n${body}`.slice(0, 4000)); if (v?.length) db.prepare('insert or replace into vecs values (?, ?, ?)').run(rel, embed.model ?? '', Buffer.from(new Float32Array(v).buffer)); } catch {} }
      indexed++;
    }
    for (const gone of known.keys()) { for (const t of ['notes', 'fts', 'vecs']) db.prepare(`delete from ${t} where path = ?`).run(gone); db.prepare('delete from links where src = ?').run(gone); }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  writeIndexFile(dir, db);
  const total = db.prepare('select count(*) n from notes').get().n;
  db.close();
  return { indexed, removed: known.size, total };
}

/** INDEX.md: the current notes, one line each, at most 200 lines (what the prompt loads). */
function writeIndexFile(dir, db) {
  const rows = db.prepare("select n.path, n.title, n.project, (select count(*) from links l where l.dst = n.title) inbound from notes n where n.valid_to is null and n.path not like '@%' order by inbound desc, n.title").all();
  const lines = rows.slice(0, 199).map((r) => `- [[${r.title}]]${r.project ? ` (${r.project})` : ''}`);
  if (rows.length > 199) lines.push(`- … and ${rows.length - 199} more (ox brain search)`);
  fs.writeFileSync(path.join(dir, 'INDEX.md'), `# ox brain\n\n${lines.join('\n')}\n`);
}

/** An embedder from a local Ollama embedding model, or null when there is none (nothing is downloaded). */
export async function localEmbedder({ base = process.env.OLLAMA_HOST ? `http://${String(process.env.OLLAMA_HOST).replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434' } = {}) {
  try {
    const tags = await (await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) })).json();
    const model = (tags.models ?? []).map((m) => m.name).find((n) => /embed|minilm|bge|e5|gte|nomic/i.test(n));
    if (!model) return null;
    const f = async (text) => (await (await fetch(`${base}/api/embed`, { method: 'POST', body: JSON.stringify({ model, input: text }), signal: AbortSignal.timeout(30_000) })).json()).embeddings?.[0];
    f.model = model;
    return f;
  } catch { return null; }
}

const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

/**
 * Search: BM25 (and vectors when an embedder is given), fused by reciprocal
 * rank, current notes first, one hop along links, capped at `tokens`.
 * → [{ title, path, current, why, text }]
 */
export async function search(query, { dir = brainDir(), limit = 6, tokens = 1500, embed = null, includeOld = false, sources = dir === brainDir() ? defaultSources() : [] } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const db = await open(dir);
  const ranks = new Map();
  const addRank = (list, why) => list.forEach((p, i) => { const r = ranks.get(p) ?? { score: 0, why: [] }; r.score += 1 / (60 + i + 1); r.why.push(why); ranks.set(p, r); });
  if (db) {
    if (db.prepare('select count(*) n from notes').get().n === 0) { db.close(); const r = await index({ dir, sources }); if (!r.total) return []; return search(query, { dir, limit, tokens, embed, includeOld, sources }); }
    const terms = q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    if (terms.length) {
      const match = terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
      try { addRank(db.prepare('select path from fts where fts match ? order by bm25(fts, 0, 5, 1, 2) limit 30').all(match).map((r) => r.path), 'words'); } catch {}
    }
    if (embed) {
      try {
        const qv = await embed(q);
        const all = db.prepare('select path, v from vecs').all().map((r) => ({ path: r.path, s: cosine(qv, new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4)) }));
        addRank(all.sort((a, b) => b.s - a.s).slice(0, 30).map((r) => r.path), 'meaning');
      } catch {}
    }
  } else {
    // No SQLite: a plain scan of the files, by how many query words each holds.
    const terms = q.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const scored = walk(dir).map((f) => { const t = fs.readFileSync(f, 'utf8').toLowerCase(); return { p: path.relative(dir, f), n: terms.filter((w) => t.includes(w)).length }; }).filter((x) => x.n).sort((a, b) => b.n - a.n);
    addRank(scored.slice(0, 30).map((x) => x.p), 'words');
  }
  const read = (rel) => { try { return loadEntry(dir, rel, sources); } catch { return null; } };
  let hits = [...ranks.entries()].map(([p, r]) => { const n = read(p); return n && { path: p, title: n.meta.title || path.basename(p, '.md'), current: !n.meta.valid_to, score: r.score * (n.meta.valid_to ? 0.35 : 1), why: r.why, body: n.body, meta: n.meta }; }).filter(Boolean);
  if (!includeOld) hits = hits.filter((h) => h.current || !hits.some((o) => o.current && o.title === h.meta.superseded_by));
  hits.sort((a, b) => b.score - a.score);
  // One hop along links from the best hits.
  const top = hits.slice(0, limit);
  if (db) {
    const seen = new Set(top.map((h) => h.path));
    for (const h of top.slice(0, 3)) {
      const out = linksIn(h.body);
      const inbound = db.prepare('select src from links where dst = ?').all(h.title).map((r) => r.src);
      const titles = db.prepare(`select path, title from notes where title in (${out.map(() => '?').join(',') || "''"})`).all(...out).map((r) => r.path);
      for (const p of [...titles, ...inbound]) {
        if (seen.has(p) || top.length >= limit + 3) continue;
        const n = read(p);
        if (!n || n.meta.valid_to) continue;
        seen.add(p);
        top.push({ path: p, title: n.meta.title || path.basename(p, '.md'), current: true, score: 0, why: [`linked from ${h.title}`], body: n.body, meta: n.meta });
      }
    }
    db.close();
  }
  // Capped at `tokens`: whole short notes, the start of long ones.
  let left = tokens * 4;
  const out = [];
  for (const h of top) {
    if (left <= 200) break;
    const text = h.body.trim().slice(0, Math.min(left, 1800));
    left -= text.length + h.title.length + 40;
    const from = h.path.startsWith('@notes/') ? 'your notes' : h.path.startsWith('@library/') ? 'your library' : 'ox brain';
    out.push({ title: h.title, path: h.path, current: h.current, why: [...new Set(h.why)].join(', '), text, from, source: h.meta?.source ?? null });
  }
  return out;
}

/** The results as one block for a prompt or a tool answer. */
export function formatHits(hits) {
  if (!hits.length) return 'Nothing in the brain matches.';
  return hits.map((h) => `## ${h.title}${h.current ? '' : ' (no longer current)'}\n(from ${h.from ?? 'ox brain'}${h.source && h.from !== 'ox brain' ? `: ${h.source}` : ''})\n${h.text}`).join('\n\n');
}

// ---------------------------------------------------------------- consolidation
/**
 * Merge duplicates (same title, or the same text) into the newest, closing the
 * others; returns what it did. Safe to run every night: nothing is deleted.
 */
export async function consolidate({ dir = brainDir() } = {}) {
  const notes = walk(dir).map((f) => { const { meta, body } = parseNote(fs.readFileSync(f, 'utf8')); return { f, meta, body, title: meta.title || path.basename(f, '.md'), mtime: fs.statSync(f).mtimeMs }; }).filter((n) => !n.meta.valid_to);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const groups = new Map();
  for (const n of notes) {
    const key = `t:${norm(n.title)}`;
    const k2 = `b:${norm(n.body).slice(0, 400)}`;
    const g = groups.get(key) ?? groups.get(k2) ?? [];
    g.push(n);
    groups.set(key, g); if (norm(n.body).length > 8) groups.set(k2, g);
  }
  const merged = [];
  for (const g of new Set(groups.values())) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.mtime - a.mtime);
    const [keep, ...rest] = g;
    for (const r of rest) {
      if (r.title === keep.title) {
        // Same title in two files: fold the older text in, once, then close it.
        if (!keep.body.includes(r.body.trim().slice(0, 200))) fs.writeFileSync(keep.f, noteText(keep.meta, `${keep.body.trim()}\n\n${r.body.trim()}`));
        fs.writeFileSync(r.f, noteText({ ...r.meta, valid_to: today(), superseded_by: keep.title }, `${r.body.trim()}\n\nMerged into [[${keep.title}]].`));
      } else close(r.title, keep.title, { dir });
      merged.push({ from: r.title, into: keep.title });
    }
  }
  const idx = await index({ dir });
  return { merged, ...idx };
}

/** Bring ox's older memories (~/.ox/memory/memory.jsonl, a project's .agent/MEMORY.md) into the brain once. */
export function importOld({ dir = brainDir(), home = os.homedir(), cwd = null } = {}) {
  let n = 0;
  const jl = path.join(process.env.OX_HOME || path.join(home, '.ox'), 'memory', 'memory.jsonl');
  try {
    for (const line of fs.readFileSync(jl, 'utf8').split('\n')) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const text = j.text ?? j.content ?? j.fact ?? j.statement;
      if (!text) continue;
      const title = String(j.title ?? text).split('\n')[0].slice(0, 70);
      if (fs.existsSync(path.join(dir, 'imported', `${slugOf(title)}.md`))) continue;
      remember({ title, body: text, tags: [].concat(j.tags ?? j.type ?? []), type: j.type ?? 'memory', folder: 'imported' }, { dir });
      n++;
    }
  } catch {}
  if (cwd) {
    try {
      const md = fs.readFileSync(path.join(cwd, '.agent', 'MEMORY.md'), 'utf8');
      const title = `${path.basename(cwd)} project memory`;
      remember({ title, body: md, type: 'project', project: path.basename(cwd), folder: 'projects' }, { dir });
      n++;
    } catch {}
  }
  return n;
}
