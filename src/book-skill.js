// Book to skill (after virgiliojr94/book-to-skill): a book, a PDF or a folder
// of docs becomes a skill. SKILL.md holds a short index (one line per chapter
// and the words it covers); each chapter is its own file the agent reads only
// when a question needs it. Pasting the whole book costs every token of it on
// every turn; the index costs a few hundred, and one chapter when used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEXT = /\.(md|markdown|txt|rst|adoc|html?)$/i;
const words = (s) => (String(s).match(/\S+/g) ?? []).length;
/** Rough tokens: ~0.75 words per token for English prose. */
export const tokensOf = (s) => Math.ceil(words(s) / 0.75);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'part';

/** The source as [{ title, text }] files: a PDF, one text file, or a folder of them. */
export function readSource(src) {
  const p = path.resolve(src);
  if (!fs.existsSync(p)) throw new Error(`${src} does not exist`);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (TEXT.test(e.name)) out.push({ title: e.name.replace(/\.[^.]+$/, '').replace(/^\d+[-_ .]*/, '').replace(/[-_]/g, ' '), text: clean(fs.readFileSync(f, 'utf8'), e.name) });
        else if (/\.pdf$/i.test(e.name)) out.push({ title: e.name.replace(/\.pdf$/i, ''), text: pdf(f) });
      }
    };
    walk(p);
    return { title: path.basename(p), parts: out.filter((x) => x.text.trim()) };
  }
  if (/\.pdf$/i.test(p)) return { title: path.basename(p, path.extname(p)), parts: [{ title: null, text: pdf(p) }] };
  if (TEXT.test(p)) return { title: path.basename(p, path.extname(p)), parts: [{ title: null, text: clean(fs.readFileSync(p, 'utf8'), p) }] };
  throw new Error(`${src}: a PDF, a text/Markdown/HTML file, or a folder of them`);
}

function pdf(file) {
  const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error?.code === 'ENOENT') throw new Error('reading a PDF needs pdftotext: brew install poppler');
  if (r.status !== 0) throw new Error(`pdftotext could not read ${path.basename(file)}`);
  // Page footers and running heads repeat on every page: drop lines seen on many pages.
  const pages = r.stdout.split('\f');
  const seen = new Map();
  for (const pg of pages) for (const l of new Set(pg.split('\n').map((x) => x.trim()).filter((x) => x && x.length < 80))) seen.set(l.replace(/\d+/g, '#'), (seen.get(l.replace(/\d+/g, '#')) ?? 0) + 1);
  const limit = Math.max(4, pages.length * 0.3);
  return pages.map((pg) => pg.split('\n').filter((l) => (seen.get(l.trim().replace(/\d+/g, '#')) ?? 0) < limit).join('\n')).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function clean(text, name) {
  if (/\.html?$/i.test(name)) return text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<h([1-3])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return text;
}

const HEADING = [
  /^#{1,2}\s+(.+)$/,                                              // Markdown # / ##
  /^(?:chapter|part|section|lesson|module)\s+([0-9ivxlc]+[.:]?\s*.*)$/i, // Chapter 3: …
  /^(\d{1,2})\.?\s+([A-Z][^.!?]{2,70})$/,                          // 3 The Title  /  3. The Title
];

/** Split a text into chapters by its headings; long or heading-less text by size (~3,000 words). */
export function chapters(text, { maxWords = 6000, chunkWords = 3000 } = {}) {
  const lines = text.split('\n');
  const marks = [];
  // Markdown is split by its own headings only: its numbered lists are not chapters.
  const md = lines.filter((l) => /^#{1,3}\s+\S/.test(l)).length >= 2;
  const res = md ? [/^#{1,3}\s+(.+)$/] : HEADING;
  let fence = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('```')) fence = !fence;
    if (fence || !t || t.length > 90) return;
    for (const re of res) {
      const m = re.exec(t);
      if (m) { marks.push({ i, title: t.replace(/^#+\s*/, '').replace(/\s+/g, ' ') }); break; }
    }
  });
  let out = [];
  // Headings must split the text into a sensible number of real parts.
  if (marks.length >= 2) {
    const head = lines.slice(0, marks[0].i).join('\n').trim();
    if (words(head) > 150) out.push({ title: 'Opening', text: head });
    marks.forEach((m, k) => out.push({ title: m.title, text: lines.slice(m.i + 1, marks[k + 1]?.i ?? lines.length).join('\n').trim() }));
    // Merge tiny parts (a heading with a few lines) into the next.
    const merged = [];
    for (const c of out) {
      const last = merged[merged.length - 1];
      if (last && words(last.text) < 120) { last.text = `${last.text}\n\n## ${c.title}\n${c.text}`; if (last.title.length < 70) last.title = `${last.title} · ${c.title}`; continue; }
      merged.push({ ...c });
    }
    out = merged.filter((c) => c.text.trim());
  }
  if (out.length < 2) out = [{ title: null, text }];
  // Anything still too long is cut at paragraph ends.
  const final = [];
  for (const c of out) {
    if (words(c.text) <= maxWords) { final.push(c); continue; }
    const paras = c.text.split(/\n\s*\n/);
    let buf = [], n = 0, k = 1;
    for (const p of paras) {
      buf.push(p); n += words(p);
      if (n >= chunkWords) { final.push({ title: `${c.title ?? 'Part'} (${k++})`, text: buf.join('\n\n') }); buf = []; n = 0; }
    }
    if (buf.length) final.push({ title: k > 1 ? `${c.title ?? 'Part'} (${k})` : c.title, text: buf.join('\n\n') });
  }
  return final.map((c, i) => ({ ...c, title: c.title ?? firstLine(c.text) ?? `Part ${i + 1}` }));
}

const firstLine = (t) => t.split('\n').map((l) => l.trim()).find((l) => l.length > 3 && l.length < 80) ?? null;

const STOP = new Set('the a an and or of to in is it that this for on with as by be are was were at from but not have has had which you your we our they their can will would should could into about than then there these those its also more most such only other any each may one two all some what when how where who why'.split(' '));

/** The words a chapter is about: frequent, distinctive terms (no model needed). */
export function keyTerms(text, corpusFreq, n = 8) {
  const f = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) if (!STOP.has(w)) f.set(w, (f.get(w) ?? 0) + 1);
  return [...f.entries()].map(([w, c]) => [w, c / Math.log(2 + (corpusFreq.get(w) ?? 0))]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

const summary = (text) => {
  // Prose only: tables, code and list markers make poor gists.
  const prose = String(text).split('\n').filter((l) => !/^\s*(\||```|[-*]\s*$|#)/.test(l)).join(' ').replace(/`/g, '');
  const s = prose.replace(/\s+/g, ' ').trim().match(/[^.!?]{25,}?[.!?](?=\s|$)/g) ?? [];
  return (s.slice(0, 2).join(' ') || String(text).replace(/\s+/g, ' ').slice(0, 220)).slice(0, 300).trim();
};

/**
 * Build the skill. → { name, dir, chapters, bookTokens, indexTokens, ratio }
 * opts: { name, description, home, force }
 */
export function bookToSkill(src, { name = null, description = null, home = os.homedir(), force = false } = {}) {
  const book = readSource(src);
  const parts = book.parts.length === 1 && !book.parts[0].title
    ? chapters(book.parts[0].text)
    : book.parts.flatMap((p) => { const cs = chapters(p.text); return cs.length > 1 ? cs.map((c) => ({ ...c, title: c.title, group: p.title })) : [{ title: p.title, text: p.text, group: p.title }]; });
  if (!parts.length || !parts.some((p) => words(p.text) > 20)) throw new Error(`no readable text in ${src}`);
  const skillName = slug(name ?? book.title);
  const dir = path.join(home, '.agents', 'skills', skillName);
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`a skill named ${skillName} exists at ${dir}: --force to replace it, or --name`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
  const corpus = new Map();
  for (const p of parts) for (const w of new Set(p.text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [])) corpus.set(w, (corpus.get(w) ?? 0) + 1);
  const rows = parts.map((p, i) => {
    const file = `chapters/${String(i + 1).padStart(2, '0')}-${slug(p.title)}.md`;
    fs.writeFileSync(path.join(dir, file), `# ${p.title}\n\n${p.text.trim()}\n`);
    return { n: i + 1, title: p.title, group: p.group ?? null, file, words: words(p.text), terms: keyTerms(p.text, corpus), gist: summary(p.text) };
  });
  // Many chapters: two levels, so the index stays small (parts here, chapters in index/<part>.md).
  const groups = [...new Set(rows.map((r) => r.group).filter(Boolean))];
  const twoLevel = rows.length > 40 && groups.length > 1;
  const line = (r) => `${r.n}. **${r.title}** — \`${r.file}\` (${r.words.toLocaleString('en-US')} words)\n   terms: ${r.terms.join(', ')}\n   gist: ${r.gist}`;
  const groupRows = twoLevel ? groups.map((g) => {
    const mine = rows.filter((r) => r.group === g);
    const file = `index/${slug(g)}.md`;
    fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `# ${g}\n\nChapters (paths relative to the skill folder):\n\n${mine.map(line).join('\n')}\n`);
    const text = parts.filter((p) => p.group === g).map((p) => p.text).join('\n');
    return { title: g, file, count: mine.length, terms: keyTerms(text, corpus, 10), indexTokens: tokensOf(fs.readFileSync(path.join(dir, file), 'utf8')) };
  }) : [];
  const allTerms = keyTerms(parts.map((p) => p.text).join('\n'), new Map(), 10);
  const desc = description ?? `Use when a question or task draws on "${book.title}" (${allTerms.slice(0, 6).join(', ')}). The book is split into ${rows.length} chapters; read only the ones the index points to.`;
  const index = [
    '---',
    `name: ${skillName}`,
    `description: ${desc.replace(/\n/g, ' ')}`,
    '---',
    '',
    `# ${book.title}`,
    '',
    `Made from ${path.basename(path.resolve(src))} by \`ox skill from\`. ${rows.length} chapters, ${rows.reduce((a, r) => a + r.words, 0).toLocaleString('en-US')} words.`,
    '',
    twoLevel
      ? 'How to use it: pick the part whose terms match the question, read its index file, then read only the chapters it points to (paths relative to this folder). Quote the chapter you used. Do not read every chapter.'
      : 'How to use it: find the chapters whose title, terms or gist match the question below, read those files (paths relative to this folder), and answer from them. Quote the chapter you used. Do not read every chapter.',
    '',
    '## Index',
    '',
    ...(twoLevel ? groupRows.map((g, i) => `${i + 1}. **${g.title}** — \`${g.file}\` (${g.count} chapters)\n   terms: ${g.terms.join(', ')}`) : rows.map(line)),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), index);
  const bookText = parts.map((p) => p.text).join('\n');
  const bookTokens = tokensOf(bookText), indexTokens = tokensOf(index);
  const avgChapter = Math.round(bookTokens / rows.length);
  const avgGroupIndex = groupRows.length ? Math.round(groupRows.reduce((a, g) => a + g.indexTokens, 0) / groupRows.length) : 0;
  const perQuestion = indexTokens + avgGroupIndex + avgChapter;
  return { name: skillName, dir, chapters: rows, parts: groupRows.length, bookTokens, indexTokens: indexTokens + avgGroupIndex, avgChapterTokens: avgChapter, ratio: Math.round((bookTokens / perQuestion) * 10) / 10, short: bookTokens < perQuestion * 2 };
}
