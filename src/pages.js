// Pages (Agently's "a finished document with its sources at the bottom"): what
// an agent or a routine hands you is not a chat reply but a page you can read,
// open in a browser, send or print: a report, a brief, a handoff, a weekly
// update. Each page lists where every fact came from.
//
//   ~/.ox/pages/<date>-<slug>.md     the page: front matter + markdown body
//   ox pages                         the list;  ox pages open <id>  in the browser
//   /ox/pages, /ox/pages/<id>        the same in the app (HTML, sources at the bottom)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const pagesDir = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'pages');
const slug = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]{1,60}$/;

/** A source as written by an agent: a link, a file, or a plain description; { title?, url?, note? } also works. */
function normSource(s) {
  if (s && typeof s === 'object') return { title: String(s.title ?? s.url ?? '').slice(0, 200), url: s.url ? String(s.url) : null, note: s.note ? String(s.note).slice(0, 200) : null };
  const t = String(s ?? '').trim();
  return /^https?:\/\//.test(t) ? { title: t, url: t, note: null } : { title: t.slice(0, 200), url: null, note: null };
}

export function savePage({ title, body, sources = [], kind = 'report', by = 'ox' }, { env = process.env, now = new Date() } = {}) {
  if (!String(title ?? '').trim()) throw new Error('a page needs a title');
  if (!String(body ?? '').trim()) throw new Error('a page needs a body');
  const src = (Array.isArray(sources) ? sources : [sources]).map(normSource).filter((s) => s.title);
  const dir = pagesDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  let id = `${day}-${slug(title)}`;
  for (let i = 2; fs.existsSync(path.join(dir, `${id}.md`)); i++) id = `${day}-${slug(title)}-${i}`.slice(0, 71);
  const meta = { title: String(title).trim(), kind, by, at: now.toISOString(), sources: src };
  fs.writeFileSync(path.join(dir, `${id}.md`), `---\n${JSON.stringify(meta)}\n---\n${String(body).trim()}\n`);
  return { id, path: path.join(dir, `${id}.md`), sources: src.length };
}

export function readPage(id, { env = process.env } = {}) {
  if (!ID.test(String(id))) throw new Error('no such page');
  const f = path.join(pagesDir(env), `${id}.md`);
  if (!fs.existsSync(f)) throw new Error('no such page');
  const text = fs.readFileSync(f, 'utf8');
  const m = /^---\n(.*)\n---\n([\s\S]*)$/.exec(text);
  const meta = m ? JSON.parse(m[1]) : { title: id, sources: [] };
  return { id, ...meta, body: m ? m[2] : text, path: f };
}

export function listPages({ env = process.env, limit = 100 } = {}) {
  let names = [];
  try { names = fs.readdirSync(pagesDir(env)).filter((n) => n.endsWith('.md')); } catch {}
  return names.sort().reverse().slice(0, limit).map((n) => {
    try { const p = readPage(n.slice(0, -3), { env }); return { id: p.id, title: p.title, kind: p.kind, by: p.by, at: p.at, sources: (p.sources ?? []).length }; } catch { return null; }
  }).filter(Boolean);
}

// Enough markdown for a report: headings, lists, bold, italics, code, links, tables, paragraphs.
function inline(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/\[(\d+)\]/g, '<sup><a href="#s$1">[$1]</a></sup>');
}
export function markdownToHtml(md) {
  const out = [];
  const lines = String(md).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) { const code = []; for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]); out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^\s*[-*]\s+/.test(l)) { const items = []; for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i--; out.push(`<ul>${items.join('')}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(l)) { const items = []; for (; i < lines.length && /^\s*\d+\.\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`); i--; out.push(`<ol>${items.join('')}</ol>`); continue; }
    if (/^\|.*\|\s*$/.test(l)) {
      const rows = []; for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]); i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
      out.push(`<table>${body.map((r, n) => `<tr>${cells(r).map((c) => (n === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if (l.trim()) { const para = [l]; for (i++; i < lines.length && lines[i].trim() && !/^(#|\s*[-*]\s|\s*\d+\.\s|```|\|)/.test(lines[i]); i++) para.push(lines[i]); i--; out.push(`<p>${inline(para.join(' '))}</p>`); }
  }
  return out.join('\n');
}

/** A page as a standalone HTML document: readable, printable, with its sources at the bottom. */
export function pageHtml(p) {
  const src = (p.sources ?? []).map((s, n) => `<li id="s${n + 1}">${s.url ? `<a href="${esc(s.url)}">${esc(s.title)}</a>` : esc(s.title)}${s.note ? ` <span class="m">· ${esc(s.note)}</span>` : ''}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title)}</title><style>
:root{--bg:#fff;--fg:#1d1d1f;--m:#6e6e73;--l:#e5e5ea;--a:#0a63d6}@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececf0;--m:#9a9aa3;--l:#2a2a2e;--a:#6aa8ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:0 auto;padding:40px 20px 60px}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}.by{color:var(--m);font-size:13px;margin-bottom:28px}h2{font-size:20px;margin:28px 0 8px}h3{font-size:17px}a{color:var(--a)}
code{font:13px ui-monospace,Menlo,monospace;background:var(--l);padding:1px 4px;border-radius:4px}pre{background:var(--l);padding:12px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--l);padding:6px 8px;text-align:left}
footer{margin-top:40px;border-top:1px solid var(--l);padding-top:14px;font-size:14px}footer h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--m);margin:0 0 6px}.m{color:var(--m)}
@media print{a{color:inherit}}</style></head><body><main><h1>${esc(p.title)}</h1><div class="by">${esc(p.kind ?? 'page')} · ${esc(p.by ?? 'ox')} · ${esc(new Date(p.at).toLocaleString())}</div>
${markdownToHtml(p.body)}
<footer><h2>Sources</h2>${src ? `<ol>${src}</ol>` : '<p class="m">No sources were given for this page.</p>'}</footer></main></body></html>`;
}
