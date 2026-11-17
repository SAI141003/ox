// The live site in the build room: the real page the team is building, served from the
// agents' copies as they write it, with each agent's cursor on what its last edit touched.
//
// The cursor is not an animation: it goes to the element named by the lines that agent just
// wrote (an id, a class, a CSS selector, the words of a heading). When nothing names one, the
// agent is shown at the side with the file it is in, not pointed at something made up.
//
// The page is written by agents, so it runs sandboxed (CSP `sandbox allow-scripts`): an opaque
// origin that cannot call ox's own routes.
import fs from 'node:fs';
import path from 'node:path';

export const SITE_CSP = 'sandbox allow-scripts';
const ENTRIES = ['index.html', 'public/index.html', 'dist/index.html', 'src/index.html', 'site/index.html', 'web/index.html'];
const SKIP = /(^|\/)(\.git|node_modules)(\/|$)/;

/** A path inside the project, or null. Pure. */
export function safeRel(rel) {
  const r = String(rel ?? '').replace(/^\/+/, '');
  if (r.includes('\0') || r.split('/').some((p) => p === '..' || p === '.git') || path.isAbsolute(r) || SKIP.test(r)) return null;
  return r;
}

function fileIn(root, rel) {
  const abs = path.join(root, rel);
  try {
    // A link could point anywhere on this machine: only a real file inside the copy is served.
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return { abs, mtime: st.mtimeMs };
  } catch { return null; }
}

/** The newest copy of a file across the agents' folders and the project. → absolute path or null */
export function resolveSiteFile(roots, rel) {
  const r = safeRel(rel);
  if (r == null || r === '') return null;
  const found = roots.map((root) => fileIn(root, r)).filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0];
  return found?.abs ?? null;
}

/** Where the page starts, relative to the project, or null when no page exists yet. */
export function siteEntry(roots) {
  return ENTRIES.find((e) => resolveSiteFile(roots, e)) ?? null;
}

/** The overlay goes in as the last thing in the page, so it never changes how the page parses. Pure. */
export function injectOverlay(html, script) {
  const tag = `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? `${html}\n${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

const uniq = (list, n = 8) => [...new Set(list.filter(Boolean))].slice(0, n);
const CSS_WORD = /^[A-Za-z_][\w-]*$/;

/**
 * What the lines an agent just wrote are about. → { ids, classes, tags, texts }. Pure.
 * html: id="", class="", the words of a heading or button. css: the selectors. js: the
 * ids and selectors it looks up.
 */
export function hintsFrom(file, lines = [], changed = []) {
  const text = changed.map((i) => lines[i]).filter((l) => typeof l === 'string');
  const ids = [], classes = [], tags = [], texts = [];
  const ext = path.extname(String(file)).toLowerCase();
  if (['.css', '.scss', '.less'].includes(ext)) {
    for (const l of text) {
      const sel = /^\s*([^{}@/][^{}]*)\{/.exec(l)?.[1];
      if (!sel) continue;
      for (const m of sel.matchAll(/#([\w-]+)/g)) ids.push(m[1]);
      for (const m of sel.matchAll(/\.([\w-]+)/g)) classes.push(m[1]);
      for (const m of sel.matchAll(/(?:^|[\s,>+~])([a-z][a-z0-9]*)(?=[\s,>+~:.#[]|$)/g)) tags.push(m[1]);
    }
  } else if (['.js', '.mjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    for (const l of text) {
      for (const m of l.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]/g)) ids.push(m[1]);
      for (const m of l.matchAll(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/g)) {
        for (const k of m[1].matchAll(/#([\w-]+)/g)) ids.push(k[1]);
        for (const k of m[1].matchAll(/\.([\w-]+)/g)) classes.push(k[1]);
      }
      for (const m of l.matchAll(/className=["'`]([^"'`]+)["'`]/g)) classes.push(...m[1].split(/\s+/));
      for (const m of l.matchAll(/\bid=["'`]([\w-]+)["'`]/g)) ids.push(m[1]);
    }
  } else if (['.html', '.htm', '.svelte', '.vue'].includes(ext)) {
    for (const l of text) {
      for (const m of l.matchAll(/\bid=["']([\w-]+)["']/g)) ids.push(m[1]);
      for (const m of l.matchAll(/\bclass=["']([^"']+)["']/g)) classes.push(...m[1].split(/\s+/));
      for (const m of l.matchAll(/<(h[1-3]|button|a|p|li|figcaption)\b[^>]*>([^<]{3,60})/gi)) texts.push(m[2].trim());
    }
  }
  return { ids: uniq(ids.filter((x) => CSS_WORD.test(x))), classes: uniq(classes.filter((x) => CSS_WORD.test(x))), tags: uniq(tags), texts: uniq(texts, 4) };
}
