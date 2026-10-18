// A project wiki from its code graph (Devin's Wiki, made here with no model):
// an index of the subsystems ox graph finds, and one page per subsystem with
// its files (and what each says it does, from its opening comment), its most
// connected functions, and what it uses and is used by. Written to
// .agent/wiki/ (gitignored like the graph) or wherever you say.
import fs from 'node:fs';
import path from 'node:path';
import { buildGraph, godNodes } from './code-graph.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'part';

/** What a file says about itself: its opening comment, first paragraph. */
export function fileSummary(root, rel) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 6000); } catch { return ''; }
  const lines = text.split('\n');
  const out = [];
  let started = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!started && (l === '' || l.startsWith('#!') || l.startsWith('import ') || l === "'use strict';")) { if (l.startsWith('import ')) break; continue; }
    const m = /^(?:\/\/+|#+(?!!)|\*|\/\*\*?|--)\s?(.*)$/.exec(l);
    if (!m) break;
    started = true;
    const body = m[1].replace(/\*\/$/, '').trim();
    if (!body && out.length) break;
    if (body) out.push(body);
    if (out.join(' ').length > 400) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the wiki. → { dir, pages, subsystems }
 * opts: { out, top }
 */
export function buildWiki(root = process.cwd(), { out = path.join(root, '.agent', 'wiki'), top = 30 } = {}) {
  const g = buildGraph(root);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // Files that belong to each subsystem (the graph's own count includes files its members touch).
  const fileCount = new Map();
  for (const n of g.nodes) if (n.kind === 'file') fileCount.set(n.community, (fileCount.get(n.community) ?? 0) + 1);
  const comms = [...(g.communities ?? [])].map((c) => ({ ...c, files: fileCount.get(c.id) ?? 0 })).filter((c) => c.files >= 1).sort((a, b) => b.files - a.files || b.size - a.size).slice(0, top);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const page = (c) => `${String(c.id).padStart(3, '0')}-${slug(c.label)}.md`;
  const commOf = (id) => byId.get(id)?.community;
  const pages = [];
  for (const c of comms) {
    const members = g.nodes.filter((n) => n.community === c.id);
    const files = members.filter((n) => n.kind === 'file').sort((a, b) => b.degree - a.degree);
    const fns = members.filter((n) => n.kind !== 'file').sort((a, b) => b.degree - a.degree).slice(0, 12);
    const ids = new Set(members.map((n) => n.id));
    const usesC = new Map(), usedByC = new Map();
    for (const e of g.edges) {
      const fi = ids.has(e.from), ti = ids.has(e.to);
      if (fi && !ti && commOf(e.to) != null) usesC.set(commOf(e.to), (usesC.get(commOf(e.to)) ?? 0) + 1);
      if (!fi && ti && commOf(e.from) != null) usedByC.set(commOf(e.from), (usedByC.get(commOf(e.from)) ?? 0) + 1);
    }
    const link = (cid) => { const o = comms.find((x) => x.id === cid); return o ? `[${o.label}](${page(o)})` : null; };
    const rel = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([cid]) => link(cid)).filter(Boolean).slice(0, 8);
    const md = [
      `# ${c.label}`,
      '',
      `${files.length} file${files.length === 1 ? '' : 's'}, ${members.length - files.length} functions and classes. Centre: \`${c.top}\`.`,
      '',
      '## Files',
      '',
      ...files.slice(0, 40).map((f) => { const s = fileSummary(root, f.file); return `- **${f.file}** (${f.lines ?? '?'} lines)${s ? `: ${s}` : ''}`; }),
      '',
      '## Most connected',
      '',
      ...fns.map((n) => `- \`${n.name}\` (${n.kind}) in ${n.file}:${n.line}, ${n.degree} links`),
      '',
      ...(rel(usesC).length ? ['## Uses', '', ...rel(usesC).map((x) => `- ${x}`), ''] : []),
      ...(rel(usedByC).length ? ['## Used by', '', ...rel(usedByC).map((x) => `- ${x}`), ''] : []),
      `[Back to the index](index.md)`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(out, page(c)), md);
    pages.push(page(c));
  }
  const langs = {};
  for (const n of g.nodes) if (n.kind === 'file' && n.lang) langs[n.lang] = (langs[n.lang] ?? 0) + 1;
  const index = [
    `# ${path.basename(path.resolve(root))}: the wiki`,
    '',
    `Made from the code by \`ox wiki\` (${new Date().toISOString().slice(0, 10)}): ${g.stats?.files ?? g.nodes.filter((n) => n.kind === 'file').length} files, ${g.nodes.length} nodes, ${g.edges.length} links. Languages: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}.`,
    '',
    '## Subsystems',
    '',
    ...comms.map((c) => `- [${c.label}](${page(c)}): ${c.files} files, centre \`${c.top}\``),
    '',
    '## The most connected parts',
    '',
    ...godNodes(g, 12).map((n) => `- \`${n.name}\` in ${n.file}${n.line ? `:${n.line}` : ''} (${n.degree} links)`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'index.md'), index);
  return { dir: out, pages: pages.length + 1, subsystems: comms.length };
}
