// The knowledge graph: graphify's idea (Graphify-Labs/graphify, Apache-2.0)
// for what is not code, ox's own build with no model and no dependency.
//
// Nodes: the sections of the project's markdown docs (split at headings), the
// facts ox remembers about you, the notes in your brain, what your coworkers
// remember; and the entities they share (a name, a tool, a place). Edges say
// how they were found: EXTRACTED (a link or heading written in the text, an
// entity the memory recorded) or INFERRED (a name ox found mentioned).
//
// A question is answered with the part of the graph it is about, up to a token
// budget (graphify's `query --budget`): the best-matching pieces first, then
// what they share entities with, each cut short, each with where it came from.
// That is the token saving: ox sends a few hundred tokens of the right lines
// instead of whole documents or every memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokensOf } from './agent.js';
import { detectCommunities } from './code-graph.js';

const tok = (t) => tokensOf([{ role: 'user', content: String(t ?? '') }]);
const SKIP_DIRS = new Set(['node_modules', '.git', '.agent', 'graphify-out', 'dist', 'build', '.next', '.ox-build', '.ox-backups', 'vendor', 'coverage']);
const STOP = new Set('the a an and or of to in on for with is are was were be by it this that from as at how what why when where which who does do did can will about into your you our my we i'.split(' '));
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9_$-]+/).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w);
const COMMON_CAPS = new Set(['The', 'This', 'That', 'These', 'When', 'What', 'How', 'Why', 'Each', 'Every', 'With', 'From', 'For', 'And', 'But', 'Not', 'Use', 'Run', 'See', 'Note', 'Yes', 'No', 'If', 'It', 'In', 'On', 'At', 'To', 'A', 'An', 'Or', 'Ox', 'You', 'Your', 'We', 'Our', 'They', 'There', 'Here', 'One', 'Two', 'All', 'Any', 'Some', 'Then', 'Also', 'TODO', 'NOTE', 'API', 'URL', 'MIT']);

/** The markdown files of a project (README, docs/…), at most `max`. */
export function docFiles(root, { max = 1500 } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= max || depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); }
      else if (/\.(md|mdx|markdown)$/i.test(e.name) && out.length < max) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** A document's sections: split at headings, each with its heading path and text. */
export function sections(text) {
  const out = [];
  let cur = { heading: '', level: 0, lines: [] };
  const trail = [];
  let fence = null;   // inside ``` or ~~~, a "# comment" is code, not a heading
  for (const line of String(text).split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; cur.lines.push(line); continue; }
    const h = fence ? null : /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      if (cur.lines.join('').trim() || cur.heading) out.push(cur);
      const level = h[1].length;
      while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
      trail.push({ level, title: h[2] });
      cur = { heading: trail.map((t) => t.title).join(' › '), level, lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim() || cur.heading) out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s) => s.text || s.heading);
}

/** Names worth linking on: capitalised phrases and `code` words seen in at least two places. */
function candidateEntities(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/\b([A-Z][a-zA-Z0-9]+(?:[ -][A-Z][a-zA-Z0-9]+){0,2})\b/g)) if (!COMMON_CAPS.has(m[1]) && m[1].length > 2) found.add(m[1]);
  for (const m of String(text).matchAll(/`([a-zA-Z][\w.-]{2,40})`/g)) found.add(m[1]);
  for (const m of String(text).matchAll(/\[\[([^\]|#]+)/g)) found.add(m[1].trim());
  return found;
}

/**
 * Build the graph. Sources: the project's docs (root), your memories and
 * brain notes, and coworkers' memories (home). → { nodes, edges, communities, stats }
 */
export async function buildKnowledge({ root = process.cwd(), home = process.env.OX_HOME || path.join(os.homedir(), '.ox'), memory = true, brain = true } = {}) {
  const nodes = [], edges = [];
  const add = (n) => { nodes.push({ ...n, tokens: tok(n.text) }); return n.id; };
  // Docs, by section.
  for (const f of docFiles(root)) {
    let text;
    try { if (fs.statSync(f).size > 400_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(root, f);
    const docId = `doc:${rel}`;
    add({ id: docId, kind: 'doc', name: rel, text: '', source: rel });
    for (const [i, s] of sections(text).entries()) {
      const id = `sec:${rel}#${i}`;
      add({ id, kind: 'section', name: s.heading || rel, text: s.text.slice(0, 3000), source: `${rel}${s.heading ? ` › ${s.heading}` : ''}` });
      edges.push({ from: docId, to: id, relation: 'contains', confidence: 'EXTRACTED' });
      for (const m of s.text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
        const target = path.relative(root, path.resolve(path.dirname(f), m[1]));
        edges.push({ from: id, to: `doc:${target}`, relation: 'links', confidence: 'EXTRACTED' });
      }
    }
  }
  // Memories: yours, then each coworker's.
  if (memory) {
    const M = await import('./memory-graph.js');
    const files = [path.join(home, 'memory', 'graph.jsonl')];
    try { for (const d of fs.readdirSync(path.join(home, 'org', 'home'))) files.push(path.join(home, 'org', 'home', d, 'memory.jsonl')); } catch {}
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const who = file.includes(`${path.sep}org${path.sep}home${path.sep}`) ? path.basename(path.dirname(file)) : 'you';
      for (const m of M.load(file).filter((x) => x.state === 'active' && x.latest !== false)) {
        const id = add({ id: `fact:${who}:${m.id}`, kind: 'fact', name: m.text.slice(0, 60), text: m.text, source: who === 'you' ? `memory (${m.kind})` : `${who}'s memory` });
        for (const e of m.entities ?? []) edges.push({ from: id, to: `ent:${String(e).toLowerCase()}`, relation: 'mentions', confidence: 'EXTRACTED', name: e });
      }
    }
  }
  // Brain notes and their [[links]].
  if (brain) {
    try {
      const B = await import('./brain.js');
      for (const f of B.walk(B.brainDir())) {
        const n = B.parseNote(fs.readFileSync(f, 'utf8'));
        if (n.meta.valid_to) continue;
        const title = n.meta.title || path.basename(f, '.md');
        const id = add({ id: `note:${title}`, kind: 'note', name: title, text: n.body.slice(0, 3000), source: `brain › ${title}` });
        for (const l of B.linksIn(n.body)) edges.push({ from: id, to: `note:${l}`, relation: 'links', confidence: 'EXTRACTED' });
      }
    } catch {}
  }
  // Entities: the names that tie two or more pieces together.
  const seen = new Map();
  for (const n of nodes) if (n.text) for (const e of candidateEntities(n.text)) { const k = e.toLowerCase(); if (!seen.has(k)) seen.set(k, { name: e, ids: new Set() }); seen.get(k).ids.add(n.id); }
  for (const e of edges.filter((x) => x.relation === 'mentions')) { if (!seen.has(e.to.slice(4))) seen.set(e.to.slice(4), { name: e.name, ids: new Set() }); seen.get(e.to.slice(4)).ids.add(e.from); }
  const extractedPairs = new Set(edges.filter((x) => x.relation === 'mentions').map((x) => `${x.from}|${x.to}`));
  for (const [k, v] of seen) {
    if (v.ids.size < 2 || v.ids.size > 60) continue;   // a name in one place links nothing; one everywhere links everything
    const id = add({ id: `ent:${k}`, kind: 'entity', name: v.name, text: '' });
    for (const from of v.ids) if (!extractedPairs.has(`${from}|${id}`)) edges.push({ from, to: id, relation: 'mentions', confidence: 'INFERRED' });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const kept = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const degree = new Map();
  for (const e of kept) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
  let communities = [];
  try { communities = detectCommunities(nodes.map((n) => ({ ...n, kind: n.kind === 'note' ? 'brainnote' : n.kind, file: n.source ?? n.name })), kept.map((e) => ({ ...e, relation: e.relation === 'mentions' ? 'calls' : e.relation }))); } catch {}
  return {
    nodes, edges: kept, communities,
    stats: { docs: nodes.filter((n) => n.kind === 'doc').length, sections: nodes.filter((n) => n.kind === 'section').length, facts: nodes.filter((n) => n.kind === 'fact').length, notes: nodes.filter((n) => n.kind === 'note').length, entities: nodes.filter((n) => n.kind === 'entity').length, edges: kept.length, extracted: kept.filter((e) => e.confidence === 'EXTRACTED').length, inferred: kept.filter((e) => e.confidence === 'INFERRED').length, tokens: nodes.reduce((s, n) => s + n.tokens, 0) },
  };
}

/**
 * The part of the graph a question is about, within `budget` tokens: the best
 * matches first, then what they share entities or links with. → { text, tokens, used, sources }
 */
export function queryKnowledge(g, question, { budget = 800, seeds: maxSeeds = 8 } = {}) {
  const q = [...new Set(words(question).map(stem))];
  if (!q.length) return { text: '', tokens: 0, used: [], sources: [] };
  // BM25 over three fields. Rare words decide (idf): "release" in three sections says
  // more than "ox" in all of them. How often a word appears counts, against the
  // section's length (tf, k1 and b). The section's own heading says most about
  // it; the headings above it (its document's title, its parents) say a little,
  // so a long doc's title no longer lifts every one of its sections.
  const pieces = g.nodes.filter((n) => n.kind !== 'doc' && n.kind !== 'entity');
  const counts = (ws) => { const m = new Map(); for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1); return m; };
  const bag = new Map(pieces.map((n) => {
    const trail = String(n.name ?? '').split(' › ');
    const own = words(trail.pop()).map(stem);
    const body = words(n.text).map(stem);
    return [n.id, { own: new Set(own), above: new Set(words(trail.join(' ')).map(stem)), tf: counts(body), len: body.length, seq: [...own, '|', ...body] }];
  }));
  const avgLen = pieces.reduce((a, n) => a + bag.get(n.id).len, 0) / Math.max(1, pieces.length) || 1;
  const has = (b, w) => b.own.has(w) || b.above.has(w) || b.tf.has(w);
  const df = new Map(q.map((w) => [w, pieces.filter((n) => has(bag.get(n.id), w)).length]));
  const idf = (w) => Math.log(1 + (pieces.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
  const pairs = q.length > 1 ? q.slice(1).map((w, k) => `${q[k]} ${w}`) : [];
  const K1 = 1.2, B = 0.75;
  const allWeight = q.reduce((sum, w) => sum + idf(w), 0) || 1;
  const score = (n) => {
    const b = bag.get(n.id);
    if (!b) return 0;
    let s = 0, hit = 0, weight = 0;
    for (const w of q) {
      const tf = b.tf.get(w) ?? 0;
      let ws = tf ? idf(w) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * b.len / avgLen)) : 0;
      if (b.own.has(w)) ws += 2.5 * idf(w);
      else if (b.above.has(w)) ws += 0.4 * idf(w);
      if (ws) { s += ws; hit++; weight += idf(w); }
    }
    if (!hit) return 0;
    // Two question words side by side in the text: "sandbox profiles", "prompt cache".
    if (pairs.length) { const seq = b.seq.join(' '); for (const p of pairs) if (seq.includes(p)) s += 1.5; }
    // A heading with next to nothing under it answers nothing.
    const thin = b.len < 12 ? 0.35 : 1;
    // How much of the question it covers, with its rare words counting most.
    return (s * (weight / allWeight) + (n.kind === 'fact' || n.kind === 'note' ? 0.5 : 0)) * thin;
  };
  const ranked = g.nodes.map((n) => [n, score(n)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const seeds = ranked.slice(0, maxSeeds).map(([n]) => n);
  // One hop through shared entities and links: what the seeds are connected to.
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const nbr = new Map();
  for (const e of g.edges) { (nbr.get(e.from) ?? nbr.set(e.from, []).get(e.from)).push(e.to); (nbr.get(e.to) ?? nbr.set(e.to, []).get(e.to)).push(e.from); }
  // A neighbour joins only when it is about the question too, and the best of them come first.
  const inOrder = new Set(seeds.map((n) => n.id));
  const floor = seeds.length ? score(seeds[seeds.length - 1]) * 0.25 : 0;
  const extra = new Map();
  for (const s of seeds) for (const mid of nbr.get(s.id) ?? []) {
    const via = byId.get(mid);
    const hops = via?.kind === 'entity' ? (nbr.get(mid) ?? []) : [mid];
    for (const id of hops) { const n = byId.get(id); if (n && !inOrder.has(id) && !extra.has(id) && n.kind !== 'entity' && n.kind !== 'doc') { const sc = score(n); if (sc > floor) extra.set(id, [n, sc]); } }
  }
  const order = [...seeds, ...[...extra.values()].sort((a, b) => b[1] - a[1]).map(([n]) => n)];
  const lines = [], used = [];
  let total = 0;
  for (const n of order) {
    const body = n.text.replace(/\s+/g, ' ').trim();
    const line = `• ${body.length > 420 ? `${body.slice(0, 420)}…` : body}  (${n.source ?? n.kind})`;
    const t = tok(line);
    if (total + t > budget) { if (!lines.length) { lines.push(line.slice(0, budget * 3)); used.push(n); } break; }
    lines.push(line); used.push(n); total += t;
  }
  const text = lines.length ? `What ox knows about "${question}" (${used.length} of ${ranked.length} matching pieces, within ${budget} tokens):\n${lines.join('\n')}` : '';
  return { text, tokens: tok(text), used, sources: [...new Set(used.map((n) => n.source))], matching: ranked.length };
}

/** The most connected entities and the communities, as a short report. */
export function knowledgeReport(g) {
  const ents = g.nodes.filter((n) => n.kind === 'entity').sort((a, b) => b.degree - a.degree).slice(0, 12);
  const st = g.stats;
  return [
    `${st.sections} doc sections in ${st.docs} files, ${st.facts} remembered facts, ${st.notes} brain notes, ${st.entities} shared names; ${st.edges} links (${st.extracted} EXTRACTED, ${st.inferred} INFERRED); ${st.tokens.toLocaleString('en-US')} tokens in all.`,
    ents.length ? `Most connected: ${ents.map((n) => `${n.name} (${n.degree})`).join(', ')}` : '',
    g.communities.length ? `Topics: ${g.communities.slice(0, 10).map((c) => `${c.label} (${c.size})`).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

// A cache per project, rebuilt when a source changed (graphify's --update, cheaply: by mtimes).
const cacheFile = (root, home) => path.join(home, 'knowledge', `${crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)}.json`);
function fingerprint(root, home) {
  const parts = [];
  for (const f of docFiles(root)) { try { parts.push(`${f}:${fs.statSync(f).mtimeMs}`); } catch {} }
  for (const f of [path.join(home, 'memory', 'graph.jsonl')]) { try { parts.push(`${f}:${fs.statSync(f).mtimeMs}`); } catch {} }
  try { parts.push(`brain:${fs.statSync(path.join(home, 'brain')).mtimeMs}`); } catch {}
  try { for (const d of fs.readdirSync(path.join(home, 'org', 'home'))) { try { parts.push(`${d}:${fs.statSync(path.join(home, 'org', 'home', d, 'memory.jsonl')).mtimeMs}`); } catch {} } } catch {}
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}
export async function knowledgeFor(root = process.cwd(), { home = process.env.OX_HOME || path.join(os.homedir(), '.ox'), fresh = false } = {}) {
  const file = cacheFile(root, home);
  const fp = fingerprint(root, home);
  if (!fresh) { try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.fp === fp) return c.graph; } catch {} }
  const graph = await buildKnowledge({ root, home });
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ fp, graph })); } catch {}
  return graph;
}

/** What the budgeted answer saves: its tokens against reading every document and memory it drew on, whole. */
export function savings(g, r) {
  const docs = new Set(r.used.filter((n) => n.kind === 'section').map((n) => n.id.split('#')[0].replace(/^sec:/, 'doc:')));
  const whole = [...docs].reduce((s, d) => s + g.nodes.filter((n) => n.id.startsWith(`${d.replace(/^doc:/, 'sec:')}#`)).reduce((a, n) => a + n.tokens, 0), 0)
    + g.nodes.filter((n) => n.kind === 'fact' && r.used.some((u) => u.kind === 'fact')).reduce((s, n) => s + n.tokens, 0)
    + r.used.filter((n) => n.kind === 'note').reduce((s, n) => s + n.tokens, 0);
  return { answer: r.tokens, whole, times: r.tokens ? Math.round((whole / r.tokens) * 10) / 10 : null, everything: g.stats.tokens };
}
