// ox graph: a project as a graph you query instead of grepping.
//
// The idea is graphify's (github.com/Graphify-Labs/graphify, Apache-2.0):
// parse the code without a model into files, functions and classes joined by
// imports, calls and definitions; tag every edge with how it was found
// (EXTRACTED: written in the source; INFERRED: resolved by ox); find the most
// connected nodes and the subsystems; then answer "how does A reach B" and
// "what is X connected to" from the graph. This is ox's own implementation,
// written from graphify's documentation, with no dependencies: a light parser
// per language instead of tree-sitter, so it is less exact than a full AST and
// says so (INFERRED) where it guesses.
//
// Output (.agent/graph/, gitignored): graph.json, GRAPH_REPORT.md, graph.html.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GRAPH_SCHEMA_VERSION = 1;
export const GRAPH_DIR = path.join('.agent', 'graph');

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.agent', '.ox', 'out', '.build', 'DerivedData', 'Pods', '.cache']);
const MAX_FILE = 1_000_000;

// ---------------------------------------------------------------- languages
const LANG = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
  py: ['.py'],
  go: ['.go'],
  swift: ['.swift'],
  rb: ['.rb'],
  java: ['.java', '.kt'],
  rs: ['.rs'],
};
const SHARED_NAMESPACE = new Set(['go', 'swift', 'rb', 'java']);
const EXT_LANG = new Map(Object.entries(LANG).flatMap(([l, exts]) => exts.map((e) => [e, l])));
export const langOf = (f) => EXT_LANG.get(path.extname(f).toLowerCase()) ?? null;

// Words that look like calls and are not: keywords and constructs.
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'super', 'import', 'require', 'elif', 'print', 'def', 'class', 'with', 'except', 'lambda', 'and', 'or', 'not', 'in', 'is', 'func', 'guard', 'defer', 'go', 'select', 'case', 'when', 'unless', 'until', 'fn', 'match', 'loop', 'sizeof', 'assert', 'del', 'yield', 'raise', 'try', 'do', 'else', 'let', 'var', 'const', 'self', 'this', 'init', 'constructor']);

// Names a callback parameter usually has: a bare call to one is the parameter,
// not the project function that happens to share the name.
const CALLBACK_NAMES = new Set(['resolve', 'reject', 'next', 'done', 'cb', 'callback', 'fn']);

// One declaration form per line, per language: [regex, kind]. Group 1 = name.
const DECLS = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
    [/^\s+(?:static\s+|async\s+|get\s+|set\s+|public\s+|private\s+|protected\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/, 'method'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/, 'function'],
    [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'class'],
  ],
  swift: [
    [/^\s*(?:@\w+\s+)*(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+|static\s+|final\s+|override\s+|mutating\s+|@MainActor\s+)*func\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*(?:@\w+\s+)*(?:public\s+|private\s+|fileprivate\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol|actor|extension)\s+([A-Za-z_]\w*)/, 'class'],
  ],
  rb: [
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'function'],
    [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'class'],
  ],
  java: [
    [/^\s*(?:public|private|protected|internal|open|data|abstract|final|sealed|\s)*(?:class|interface|enum|object)\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:public|private|protected|static|final|synchronized|abstract|override|suspend|\s)+[\w<>[\],\s]*?\b([a-z_]\w*)\s*\([^)]*\)\s*(?:throws [\w, ]+)?\s*\{?\s*$/, 'method'],
    [/^\s*(?:private\s+|override\s+|suspend\s+)*fun\s+([A-Za-z_]\w*)/, 'function'],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, 'class'],
  ],
};

// Imports: { spec, names: [local names bound] } per line.
function importsOf(lang, line) {
  let m;
  if (lang === 'js') {
    if ((m = /^\s*import\s+(?:type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/.exec(line))) return [{ spec: m[2], names: bindNames(m[1]) }];
    if ((m = /^\s*import\s*['"]([^'"]+)['"]/.exec(line))) return [{ spec: m[1], names: [] }];
    if ((m = /^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/.exec(line))) return [{ spec: m[1], names: [] }];
    const out = [];
    const re = /(?:(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*)?(?:require|await\s+import|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = re.exec(line))) out.push({ spec: m[2], names: m[1] ? bindNames(m[1]) : [] });
    return out;
  }
  if (lang === 'py') {
    if ((m = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line))) return [{ spec: m[1], names: m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter((s) => /^\w+$/.test(s)) }];
    if ((m = /^\s*import\s+([\w., ]+)$/.exec(line))) return m[1].split(',').map((s) => ({ spec: s.trim().split(/\s+as\s+/)[0], names: [] }));
    return [];
  }
  if (lang === 'go' && (m = /^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/.exec(line))) return [{ spec: m[1], names: [] }];
  if (lang === 'swift' && (m = /^\s*import\s+(\w+)/.exec(line))) return [{ spec: m[1], names: [] }];
  if (lang === 'rb' && (m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(line))) return [{ spec: m[1], names: [], relative: /require_relative/.test(line) }];
  if (lang === 'rs' && (m = /^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/.exec(line))) return [{ spec: m[1], names: [] }];
  if (lang === 'java' && (m = /^\s*import\s+(?:static\s+)?([\w.]+)/.exec(line))) return [{ spec: m[1], names: [m[1].split('.').pop()] }];
  return [];
}

function bindNames(clause) {
  const out = [];
  const s = String(clause).trim();
  const brace = /\{([^}]*)\}/.exec(s);
  if (brace) for (const part of brace[1].split(',')) { const n = part.trim().split(/\s+as\s+|\s*:\s*/).pop()?.trim(); if (n && /^[A-Za-z_$][\w$]*$/.test(n)) out.push(n); }
  const head = s.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+/, '').split(',')[0].trim();
  if (head && /^[A-Za-z_$][\w$]*$/.test(head)) out.push(head);
  return out;
}

// Comments that carry a reason: they become nodes linked to the code below.
const RATIONALE = /(?:\/\/|#|\/\*|--)\s*(NOTE|WHY|HACK|IMPORTANT|DECISION|TODO|FIXME)\b[:\s-]*(.{4,200})/;

// ---------------------------------------------------------------- one file
/**
 * Everything one file says about itself, without a model:
 * { lang, symbols: [{ name, kind, line, end, parent }], imports: [{ spec, names, line }],
 *   calls: [{ name, line, from }], notes: [{ tag, text, line, about }] }
 */
export function extractFile(rel, text) {
  const lang = langOf(rel);
  const out = { lang, symbols: [], imports: [], calls: [], notes: [] };
  if (!lang) return out;
  const lines = String(text).split('\n');
  const stack = []; // open symbols: { sym, depth } (braces) or { sym, indent } (python)
  let depth = 0;
  let inBlock = false;
  let pendingImport = null;
  const indentOf = (l) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    let line = raw;
    // Block comments (C-like): skipped, but their NOTE/WHY lines still count.
    if (lang !== 'py' && lang !== 'rb') {
      if (inBlock) { const n = RATIONALE.exec(raw.replace(/^\s*\*?/, '// ')); if (n) out.notes.push({ tag: n[1], text: n[2].trim(), line: lineNo }); if (raw.includes('*/')) inBlock = false; continue; }
      if (/^\s*\/\*/.test(raw) && !raw.includes('*/')) { inBlock = true; const n = RATIONALE.exec(raw); if (n) out.notes.push({ tag: n[1], text: n[2].trim(), line: lineNo }); continue; }
    }
    const note = RATIONALE.exec(raw);
    if (note) out.notes.push({ tag: note[1], text: note[2].trim().replace(/\*\/\s*$/, ''), line: lineNo });
    // Python: a symbol ends where the indentation falls back.
    if (lang === 'py' && line.trim() && !line.trim().startsWith('#')) {
      while (stack.length && indentOf(line) <= stack.at(-1).indent) {
        let end = lineNo - 1;
        while (end > stack.at(-1).sym.line && !lines[end - 1].trim()) end--;
        stack.pop().sym.end = end;
      }
    }
    const code = stripStringsAndComments(line, lang);
    if (!code.trim()) continue;
    // An import that spans lines (import {\n a,\n b\n} from './x.js') is read
    // whole: joined until its `from '…'`, then parsed as one statement.
    if (lang === 'js' && (pendingImport || /^\s*(?:import|export)\s+(?:type\s+)?\{[^}]*$/.test(line) || /^\s*(?:const|let|var)\s+\{[^}]*$/.test(line))) {
      if (!pendingImport) pendingImport = { text: '', line: lineNo };
      pendingImport.text += ` ${line.trim()}`;
      if (/\bfrom\s*['"][^'"]+['"]|require\(\s*['"][^'"]+['"]\s*\)|import\(\s*['"][^'"]+['"]\s*\)/.test(line)) {
        for (const im of importsOf(lang, pendingImport.text)) out.imports.push({ ...im, line: pendingImport.line });
        pendingImport = null;
      } else if (lineNo - pendingImport.line > 80 || /[;)]\s*$/.test(line.trim()) && !/,\s*$/.test(line)) pendingImport = null;
      continue;
    }
    for (const im of importsOf(lang, line)) out.imports.push({ ...im, line: lineNo });
    let declared = null;
    for (const [re, kind] of DECLS[lang]) {
      const m = re.exec(code);
      if (m && !NOT_CALLS.has(m[1])) { declared = { name: m[1], kind, line: lineNo, end: lineNo, parent: stack.at(-1)?.sym.name ?? null }; break; }
    }
    if (declared) {
      if (declared.kind === 'method' && !stack.some((s) => s.sym.kind === 'class')) declared = null;
    }
    if (declared) {
      if (declared.parent && declared.kind === 'function' && stack.some((s) => s.sym.kind === 'class')) declared.kind = 'method';
      out.symbols.push(declared);
    }
    // Calls on this line, attributed to the innermost open symbol.
    const owner = stack.at(-1)?.sym ?? null;
    // Where the declared name itself sits ("function f("), so it is not read as a call.
    const declPos = declared ? code.search(new RegExp(`(?:^|[^\\w$])${declared.name.replace(/[$]/g, '\\$')}\\s*[(=:<]`)) : -1;
    const re = /(?:^|[^\w$.]|\.\.\.)([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(code))) {
      const name = m[1] ?? m[3];
      if (NOT_CALLS.has(name) || CALLBACK_NAMES.has(name) || (declared && name === declared.name && m.index <= declPos)) continue;
      // `x.name()`: only `this.` / `self.` (the same class) can be resolved
      // with any confidence; `path.resolve()` is not this project's `resolve`.
      const receiver = m[2] ?? null;
      out.calls.push({ name, line: lineNo, from: owner ? owner.name : null, fromLine: owner ? owner.line : null, member: !!m[3], self: receiver === 'this' || receiver === 'self', ...(m[3] && receiver !== 'this' && receiver !== 'self' ? { receiver } : {}) });
      if (m[3]) re.lastIndex = m.index + m[0].length - 1;
    }
    // Scope bookkeeping.
    if (lang === 'py' || lang === 'rb') {
      if (declared && lang === 'py') stack.push({ sym: declared, indent: indentOf(line) });
      if (lang === 'rb') {
        if (declared) stack.push({ sym: declared, depth });
        if (/^\s*end\b/.test(code) && stack.length) stack.pop().sym.end = lineNo;
      }
      continue;
    }
    const opens = (code.match(/\{/g) ?? []).length;
    const closes = (code.match(/\}/g) ?? []).length;
    if (declared && (opens > closes || /\{\s*$/.test(code) || (opens === 0 && lang !== 'go'))) {
      // A declaration whose body starts on this line (or the next one).
      stack.push({ sym: declared, depth: depth + (opens > closes ? 1 : opens === 0 ? 1 : 0), pendingOpen: opens === 0 });
    }
    depth += opens - closes;
    while (stack.length) {
      const top = stack.at(-1);
      if (top.pendingOpen && opens > 0) { top.pendingOpen = false; }
      if (!top.pendingOpen && depth < top.depth) { stack.pop().sym.end = lineNo; continue; }
      // One-line arrow functions / bodies that never opened a brace.
      if (top.pendingOpen && i > top.sym.line && opens === 0) { stack.pop(); continue; }
      break;
    }
  }
  let last = lines.length;
  while (last > 1 && !lines[last - 1].trim()) last--;
  for (const s of stack) s.sym.end = Math.max(s.sym.line, last);
  // A note is about the next declaration within 3 lines, else about the
  // symbol it sits inside, else the file.
  for (const n of out.notes) {
    const next = out.symbols.find((s) => s.line > n.line && s.line - n.line <= 3);
    const inside = out.symbols.filter((s) => s.line <= n.line && s.end >= n.line).at(-1);
    n.about = (next ?? inside)?.name ?? null;
    n.aboutLine = (next ?? inside)?.line ?? null;
  }
  return out;
}

function stripStringsAndComments(line, lang) {
  let s = line;
  s = s.replace(/\\./g, '__');
  // A template's ${…} parts are code (`${truncate(x)}` calls truncate); the rest is text.
  s = s.replace(/`[^`]*`/g, (t) => ` ${[...t.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ; ')} `);
  s = s.replace(/"[^"\n]*"/g, '""').replace(/'[^'\n]*'/g, "''");
  if (lang === 'py' || lang === 'rb') s = s.replace(/#.*$/, '');
  else s = s.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  return s;
}

// ---------------------------------------------------------------- the graph
function walk(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const go = (dir) => {
    if (out.length >= maxFiles) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) go(full);
      else if (langOf(e.name) && out.length < maxFiles) out.push(full);
    }
  };
  go(root);
  return out;
}

const fileId = (rel) => `file:${rel}`;
const symId = (rel, s) => `${rel}#${s.parent && s.kind === 'method' ? `${s.parent}.` : ''}${s.name}`;

// Resolve an import spec to a file in the project, or null (a library).
function resolveImport(fromRel, spec, lang, files) {
  const dir = path.posix.dirname(fromRel);
  const tryPaths = [];
  if (lang === 'js' && spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    tryPaths.push(base, ...LANG.js.map((e) => base + e), ...LANG.js.map((e) => `${base}/index${e}`));
    if (/\.js$/.test(base)) tryPaths.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  } else if (lang === 'py') {
    const lead = /^\.+/.exec(spec)?.[0].length ?? 0;
    const mod = spec.slice(lead).replace(/\./g, '/');
    const bases = lead ? [path.posix.join(dir, ...Array(lead - 1).fill('..'), mod)] : [mod, path.posix.join(dir, mod)];
    for (const b of bases) tryPaths.push(`${b}.py`, `${b}/__init__.py`);
  } else if (lang === 'rb') {
    const b = path.posix.normalize(path.posix.join(dir, spec));
    tryPaths.push(`${b}.rb`, b);
  } else if (lang === 'go') {
    // A package path inside this module: any file in that folder.
    const tail = spec.split('/').slice(-2).join('/');
    const hit = [...files].find((f) => f.endsWith('.go') && path.posix.dirname(f).endsWith(tail));
    if (hit) return hit;
  }
  for (const p of tryPaths) if (files.has(p)) return p;
  return null;
}

function hash(text) { return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16); }

/**
 * Build the graph of `root`. With `previous` (an earlier graph.json), files
 * whose content did not change reuse their extraction: `ox graph update`.
 * Returns { nodes, edges, communities, stats, ... }.
 */
export function buildGraph(root = process.cwd(), { previous = null, maxFiles = 20000 } = {}) {
  const started = Date.now();
  const abs = walk(root, { maxFiles });
  const rels = abs.map((f) => path.relative(root, f).split(path.sep).join('/'));
  const files = new Set(rels);
  const cache = previous?.extractions ?? {};
  const extractions = {};
  let reused = 0;
  for (let i = 0; i < abs.length; i++) {
    let text = '';
    try { if (fs.statSync(abs[i]).size > MAX_FILE) continue; text = fs.readFileSync(abs[i], 'utf8'); } catch { continue; }
    const h = hash(text);
    if (cache[rels[i]]?.hash === h) { extractions[rels[i]] = cache[rels[i]]; reused++; continue; }
    extractions[rels[i]] = { hash: h, lines: text.split('\n').length, ...extractFile(rels[i], text) };
  }
  const nodes = new Map();
  const edges = [];
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return nodes.get(n.id); };
  const edgeKeys = new Set();
  const addEdge = (from, to, relation, confidence, line) => {
    if (from === to) return;
    const k = `${from}\u0000${to}\u0000${relation}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to, relation, confidence, ...(line ? { line } : {}) });
  };
  // Files and their symbols.
  const byName = new Map(); // symbol name -> [ids]
  const symAt = new Map(); // `${rel}:${line}` -> id
  for (const [rel, x] of Object.entries(extractions)) {
    addNode({ id: fileId(rel), kind: 'file', name: path.posix.basename(rel), file: rel, line: 1, lang: x.lang, lines: x.lines });
    for (const s of x.symbols) {
      const id = symId(rel, s);
      addNode({ id, kind: s.kind, name: s.parent && s.kind === 'method' ? `${s.parent}.${s.name}` : s.name, short: s.name, file: rel, line: s.line, end: s.end });
      symAt.set(`${rel}:${s.line}`, id);
      addEdge(s.parent && s.kind === 'method' ? symId(rel, { name: s.parent, kind: 'class' }) : fileId(rel), id, s.kind === 'method' ? 'method' : 'defines', 'EXTRACTED', s.line);
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(id);
    }
  }
  // Imports: file -> file, and which names each file brought in from where.
  const libs = new Map();
  for (const [rel, x] of Object.entries(extractions)) {
    const bound = new Map(); // local name -> resolved file
    for (const im of x.imports) {
      const target = resolveImport(rel, im.spec, x.lang, files);
      if (target) {
        addEdge(fileId(rel), fileId(target), 'imports', 'EXTRACTED', im.line);
        for (const n of im.names) bound.set(n, target);
      } else if (!im.spec.startsWith('.')) {
        const lib = im.spec.replace(/^node:/, '').split('/').slice(0, im.spec.startsWith('@') ? 2 : 1).join('/');
        libs.set(lib, (libs.get(lib) ?? 0) + 1);
      }
    }
    x._bound = bound;
  }
  // Calls: the caller is the enclosing symbol (or the file); the callee is
  //   EXTRACTED when the name was imported from a file that defines it, or is
  //            defined in the same file;
  //   INFERRED when exactly one symbol in the project has that name.
  // A name defined many times and not imported is left out rather than guessed.
  for (const [rel, x] of Object.entries(extractions)) {
    for (const c of x.calls) {
      const from = c.fromLine ? symAt.get(`${rel}:${c.fromLine}`) ?? fileId(rel) : fileId(rel);
      const cands = byName.get(c.name);
      if (!cands?.length) continue;
      let to = null, conf = null;
      const local = cands.filter((id) => id.startsWith(`${rel}#`));
      const imported = x._bound.get(c.name);
      // ns.name() where ns is an imported module (import * as ns, const ns =
      // require(…) / await import(…)): the name is that file's, exactly.
      if (c.member && c.receiver && x._bound.has(c.receiver)) {
        const target = x._bound.get(c.receiver);
        const hit = cands.find((id) => id.startsWith(`${target}#`) && !id.slice(target.length + 1).includes('.'));
        if (hit) addEdge(from, hit, 'calls', 'EXTRACTED', c.line);
        continue;
      }
      if (c.member && !c.self) continue; // obj.name(): the receiver's type is unknown here
      if (!c.member && imported) { to = cands.find((id) => id.startsWith(`${imported}#`)) ?? null; conf = 'EXTRACTED'; }
      if (!to && !c.member && local.length === 1) { to = local[0]; conf = 'EXTRACTED'; }
      if (!to && c.self && local.length === 1) { to = local[0]; conf = 'INFERRED'; }
      // The only symbol with that name anywhere: a fair guess where a package or
      // module shares one namespace (Go, Swift, Ruby, Java/Kotlin). In JS and
      // Python a bare call cannot reach another file without an import, so
      // there it would be a guess at a name that is really a local or a parameter.
      if (!to && !c.member && cands.length === 1 && SHARED_NAMESPACE.has(x.lang)) { to = cands[0]; conf = 'INFERRED'; }
      if (to) addEdge(from, to, 'calls', conf, c.line);
    }
    delete x._bound;
  }
  // Rationale comments.
  for (const [rel, x] of Object.entries(extractions)) {
    for (const n of x.notes) {
      const id = `note:${rel}:${n.line}`;
      addNode({ id, kind: 'note', name: `${n.tag}: ${n.text.slice(0, 80)}`, file: rel, line: n.line, tag: n.tag, text: n.text });
      const about = n.aboutLine ? symAt.get(`${rel}:${n.aboutLine}`) : null;
      addEdge(id, about ?? fileId(rel), 'explains', 'EXTRACTED', n.line);
    }
  }
  const nodeList = [...nodes.values()];
  const degree = new Map(nodeList.map((n) => [n.id, 0]));
  for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  for (const n of nodeList) n.degree = degree.get(n.id) ?? 0;
  const communities = detectCommunities(nodeList, edges);
  for (const n of nodeList) n.community = communities.of.get(n.id) ?? null;
  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    tool: 'ox graph',
    root: path.resolve(root),
    builtAt: new Date().toISOString(),
    nodes: nodeList,
    edges,
    communities: communities.list,
    libraries: [...libs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, uses]) => ({ name, uses })),
    stats: {
      files: Object.keys(extractions).length,
      symbols: nodeList.filter((n) => n.kind !== 'file' && n.kind !== 'note').length,
      notes: nodeList.filter((n) => n.kind === 'note').length,
      edges: edges.length,
      extracted: edges.filter((e) => e.confidence === 'EXTRACTED').length,
      inferred: edges.filter((e) => e.confidence === 'INFERRED').length,
      reused,
      ms: Date.now() - started,
    },
    extractions,
  };
}

// ---------------------------------------------------------------- communities
// Subsystems by label propagation over the undirected graph of code nodes
// (notes left out), deterministic: nodes visited in id order, ties to the
// smallest label. Each community is named after its most connected member
// and the folder most of it lives in, with no model.
export function detectCommunities(nodes, edges, { rounds = 20 } = {}) {
  const code = nodes.filter((n) => n.kind !== 'note');
  const ids = code.map((n) => n.id).sort();
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    const w = e.relation === 'calls' ? 1 : e.relation === 'imports' ? 0.5 : 2;
    adj.get(e.from).push([e.to, w]);
    adj.get(e.to).push([e.from, w]);
  }
  const label = new Map(ids.map((id, i) => [id, i]));
  for (let r = 0; r < rounds; r++) {
    let changed = 0;
    for (const id of ids) {
      const nb = adj.get(id);
      if (!nb.length) continue;
      const score = new Map();
      for (const [o, w] of nb) score.set(label.get(o), (score.get(label.get(o)) ?? 0) + w);
      let best = label.get(id), bestW = -1;
      for (const [l, w] of [...score.entries()].sort((a, b) => a[0] - b[0])) if (w > bestW) { best = l; bestW = w; }
      if (best !== label.get(id)) { label.set(id, best); changed++; }
    }
    if (!changed) break;
  }
  const groups = new Map();
  for (const id of ids) { const l = label.get(id); if (!groups.has(l)) groups.set(l, []); groups.get(l).push(id); }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const list = [...groups.values()].filter((g) => g.length >= 3).sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  const of = new Map();
  const out = list.map((members, i) => {
    const ms = members.map((m) => byId.get(m));
    const top = ms.filter((n) => n.kind !== 'file').sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))[0] ?? ms[0];
    const dirs = new Map();
    for (const n of ms) { const d = path.posix.dirname(n.file); dirs.set(d, (dirs.get(d) ?? 0) + 1); }
    const dir = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const m of members) of.set(m, i);
    return { id: i, label: `${top.name} (${dir === '.' ? 'root' : dir})`, size: members.length, top: top.id, files: [...new Set(ms.map((n) => n.file))].length };
  });
  return { list: out, of };
}

// ---------------------------------------------------------------- reading it
function index(g) {
  if (g._idx) return g._idx;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map(), inn = new Map();
  for (const e of g.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inn.has(e.to)) inn.set(e.to, []);
    out.get(e.from).push(e);
    inn.get(e.to).push(e);
  }
  Object.defineProperty(g, '_idx', { value: { byId, out, inn }, enumerable: false });
  return g._idx;
}

/** Nodes matching a name: exact name, then short name, then substring; most connected first. */
export function findNodes(g, q, { limit = 10 } = {}) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return [];
  const score = (n) => {
    const name = n.name.toLowerCase(), short = (n.short ?? n.name).toLowerCase(), id = n.id.toLowerCase();
    if (name === s || short === s || id === s || n.file?.toLowerCase() === s) return 3;
    if (name.endsWith(`.${s}`) || id.endsWith(`#${s}`) || n.file?.toLowerCase().endsWith(`/${s}`)) return 2;
    if (name.includes(s) || n.file?.toLowerCase().includes(s)) return 1;
    return 0;
  };
  return g.nodes.map((n) => [n, score(n)]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1] || (a[0].kind === 'note') - (b[0].kind === 'note') || b[0].degree - a[0].degree).slice(0, limit).map(([n]) => n);
}

const where = (n) => `${n.file}${n.line ? `:${n.line}` : ''}`;
const label = (n) => (n.kind === 'file' ? n.file : n.name);

/** What a node is and what it is connected to. */
export function explainNode(g, q, { all = false } = {}) {
  const n = findNodes(g, q, { limit: 1 })[0];
  if (!n) return { found: false, text: `nothing in the graph is called "${q}" (ox graph query "${q}" searches more widely)` };
  const { byId, out, inn } = index(g);
  const links = [
    ...(out.get(n.id) ?? []).map((e) => ({ dir: '-->', e, other: byId.get(e.to) })),
    ...(inn.get(n.id) ?? []).map((e) => ({ dir: '<--', e, other: byId.get(e.from) })),
  ].filter((l) => l.other).sort((a, b) => b.other.degree - a.other.degree);
  const shown = all ? links : links.slice(0, 20);
  const comm = g.communities?.[n.community];
  const lines = [
    `${label(n)}  (${n.kind}, ${where(n)}${n.end && n.end > n.line ? `-${n.end}` : ''})`,
    `  community: ${comm ? comm.label : 'none'} · ${n.degree} connection${n.degree === 1 ? '' : 's'}`,
    ...(n.kind === 'note' ? [`  ${n.text}`] : []),
    ...shown.map((l) => `  ${l.dir} ${label(l.other)} [${l.e.relation}] [${l.e.confidence}]  ${where(l.other)}`),
    ...(links.length > shown.length ? [`  …and ${links.length - shown.length} more (--all)`] : []),
  ];
  return { found: true, node: n, links, text: lines.join('\n') };
}

/**
 * Shortest path between two things. How code reaches code is first sought
 * through calls alone; only when there is none does it go through files
 * (imports, definitions). Edges are followed either way unless directed.
 */
export function shortestPath(g, a, b, { directed = false } = {}) {
  const A = findNodes(g, a, { limit: 1 })[0], B = findNodes(g, b, { limit: 1 })[0];
  if (!A || !B) return { found: false, text: `not in the graph: ${!A ? `"${a}"` : ''}${!A && !B ? ' and ' : ''}${!B ? `"${b}"` : ''}` };
  const { byId, out, inn } = index(g);
  const search = (allowed) => {
    const prev = new Map([[A.id, null]]);
    const queue = [A.id];
    while (queue.length && !prev.has(B.id)) {
      const cur = queue.shift();
      const steps = [...(out.get(cur) ?? []).map((e) => [e.to, e, '-->']), ...(directed ? [] : (inn.get(cur) ?? []).map((e) => [e.from, e, '<--']))];
      for (const [next, e, dir] of steps) {
        if (prev.has(next) || byId.get(next)?.kind === 'note' || (allowed && !allowed.has(e.relation))) continue;
        prev.set(next, { from: cur, e, dir });
        queue.push(next);
      }
    }
    return prev.has(B.id) ? prev : null;
  };
  const prev = search(new Set(['calls', 'method'])) ?? search(null);
  if (!prev) return { found: false, text: `no path from ${label(A)} to ${label(B)}${directed ? ' following edge direction (try without --directed)' : ''}` };
  const hops = [];
  for (let cur = B.id; prev.get(cur); cur = prev.get(cur).from) hops.unshift(prev.get(cur));
  let text = label(A);
  for (const h of hops) text += ` ${h.dir === '-->' ? `--${h.e.relation}-->` : `<--${h.e.relation}--`} ${label(byId.get(h.dir === '-->' ? h.e.to : h.e.from))}`;
  return { found: true, hops: hops.length, path: [A, ...hops.map((h) => byId.get(h.dir === '-->' ? h.e.to : h.e.from))], text: `Shortest path (${hops.length} hop${hops.length === 1 ? '' : 's'}):\n  ${text}` };
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'how', 'what', 'where', 'which', 'does', 'do', 'who', 'when', 'why', 'with', 'for', 'from', 'it', 'this', 'that', 'get', 'work', 'works', 'used', 'use', 'code', 'file', 'files']);

/** The part of the graph a plain-language question is about: matching nodes and their neighbours. */
export function queryGraph(g, question, { limit = 12, hops = 1 } = {}) {
  const words = String(question ?? '').toLowerCase().split(/[^a-z0-9_$.-]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const scored = new Map();
  for (const n of g.nodes) {
    if (n.kind === 'note' && !words.some((w) => n.text?.toLowerCase().includes(w))) continue;
    const hay = `${n.name} ${n.file} ${n.text ?? ''}`.toLowerCase();
    const parts = hay.split(/[^a-z0-9]+/);
    // camelCase / snake_case pieces: "runAgentLoop" answers "agent loop".
    const pieces = `${n.name} ${n.file}`.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
    let s = 0, hit = 0;
    for (const w of words) {
      const stem = w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/, '') : w;
      if (parts.includes(w) || pieces.includes(w)) { s += 3; hit++; }
      else if (pieces.some((p) => p.startsWith(stem)) || hay.includes(w)) { s += 1; hit++; }
    }
    // Matching more of the question beats matching one word often; product
    // code beats its tests and benchmarks for a question about how it works.
    if (s) scored.set(n.id, s * hit + Math.min(3, Math.log2(1 + n.degree)) - (/^(?:test|tests|bench|spec)\//.test(n.file) ? 3 : 0));
  }
  const seeds = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  const { byId, out, inn } = index(g);
  const keep = new Set(seeds);
  let frontier = seeds;
  for (let h = 0; h < hops; h++) {
    const next = [];
    for (const id of frontier) for (const e of [...(out.get(id) ?? []), ...(inn.get(id) ?? [])]) {
      const o = e.from === id ? e.to : e.from;
      if (!keep.has(o) && e.relation !== 'defines' && keep.size < limit * 4) { keep.add(o); next.push(o); }
    }
    frontier = next;
  }
  const sub = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && e.relation !== 'defines');
  const lines = [
    seeds.length ? `About "${question}": ${seeds.length} match${seeds.length === 1 ? '' : 'es'}, ${keep.size} node${keep.size === 1 ? '' : 's'} with neighbours` : `nothing in the graph matches "${question}"`,
    ...seeds.map((id) => byId.get(id)).map((n) => `  • ${label(n)} (${n.kind}, ${where(n)}, ${n.degree} links)`),
    ...(sub.length ? ['  connections:', ...sub.slice(0, 40).map((e) => `    ${label(byId.get(e.from))} --${e.relation}--> ${label(byId.get(e.to))} [${e.confidence}]`)] : []),
    ...(sub.length > 40 ? [`    …and ${sub.length - 40} more`] : []),
  ];
  return { seeds: seeds.map((id) => byId.get(id)), nodes: [...keep].map((id) => byId.get(id)), edges: sub, text: lines.join('\n') };
}

/** The most connected code (not files, not notes): what everything flows through. */
export function godNodes(g, n = 10) {
  return g.nodes.filter((x) => x.kind !== 'file' && x.kind !== 'note').sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, n);
}

/** Links between subsystems that are rare: the surprising ones worth a look. */
export function surprisingLinks(g, n = 8) {
  const { byId } = index(g);
  const pair = new Map();
  for (const e of g.edges) {
    if (e.relation !== 'calls' && e.relation !== 'imports') continue;
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b || a.community == null || b.community == null || a.community === b.community) continue;
    const k = [a.community, b.community].sort().join('-');
    if (!pair.has(k)) pair.set(k, []);
    pair.get(k).push(e);
  }
  return [...pair.values()].filter((es) => es.length === 1).map((es) => es[0]).sort((x, y) => (byId.get(y.to).degree + byId.get(y.from).degree) - (byId.get(x.to).degree + byId.get(x.from).degree)).slice(0, n);
}

// ---------------------------------------------------------------- files out
export function graphReport(g) {
  const { byId } = index(g);
  const gods = godNodes(g, 10);
  const odd = surprisingLinks(g, 8);
  const notes = g.nodes.filter((n) => n.kind === 'note' && /WHY|DECISION|IMPORTANT|NOTE/.test(n.tag)).slice(0, 12);
  const st = g.stats;
  const q = [
    gods[0] && gods[1] ? `ox graph path "${gods[0].name}" "${gods[1].name}"` : null,
    gods[0] ? `ox graph explain "${gods[0].name}"` : null,
    g.communities[0] ? `ox graph query "${g.communities[0].label.split(' (')[0]}"` : null,
    odd[0] ? `ox graph explain "${label(byId.get(odd[0].to))}"` : null,
  ].filter(Boolean);
  return [
    `# Graph report: ${path.basename(g.root)}`,
    '',
    `${st.files} files, ${st.symbols} functions and classes, ${st.notes} rationale notes, ${st.edges} edges (${st.extracted} EXTRACTED: written in the source; ${st.inferred} INFERRED: resolved by ox). Built ${g.builtAt} in ${st.ms} ms, no model.`,
    '',
    '## What everything flows through',
    ...gods.map((n, i) => `${i + 1}. **${n.name}** (${n.kind}, \`${where(n)}\`): ${n.degree} connections`),
    '',
    '## Subsystems',
    ...g.communities.slice(0, 15).map((c) => `- **${c.label}**: ${c.size} nodes across ${c.files} file${c.files === 1 ? '' : 's'}`),
    ...(g.communities.length > 15 ? [`- …and ${g.communities.length - 15} smaller ones`] : []),
    '',
    '## Surprising connections',
    odd.length ? 'The only link between two subsystems: worth knowing before changing either side.' : 'None: the subsystems are either well separated or tightly joined.',
    ...odd.map((e) => `- ${label(byId.get(e.from))} --${e.relation}--> ${label(byId.get(e.to))} (\`${byId.get(e.from).file}:${e.line ?? ''}\`, ${e.confidence})`),
    '',
    ...(notes.length ? ['## Why the code is the way it is', ...notes.map((n) => `- \`${where(n)}\` ${n.tag}: ${n.text}`), ''] : []),
    ...(g.libraries.length ? ['## Libraries used', g.libraries.slice(0, 20).map((l) => `${l.name} (${l.uses})`).join(', '), ''] : []),
    '## Questions to ask it',
    ...q.map((x) => `- \`${x}\``),
    '',
  ].join('\n');
}

/** A self-contained page: force layout on a canvas, click a node to see its links, search, colour by subsystem. */
export function graphHtml(g, { maxNodes = 1500 } = {}) {
  const keep = g.nodes.filter((n) => n.kind !== 'note').sort((a, b) => b.degree - a.degree).slice(0, maxNodes);
  const ids = new Set(keep.map((n) => n.id));
  const data = {
    nodes: keep.map((n) => ({ id: n.id, n: label(n), k: n.kind, f: `${n.file}:${n.line}`, c: n.community ?? -1, d: n.degree })),
    edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => [e.from, e.to, e.relation, e.confidence === 'INFERRED' ? 1 : 0]),
    comms: g.communities.map((c) => c.label),
    title: path.basename(g.root),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.title)} · ox graph</title>
<style>:root{--bg:#fff;--fg:#111;--mut:#666;--line:rgba(0,0,0,.12);--panel:#f6f6f6}@media(prefers-color-scheme:dark){:root{--bg:#0e0e0e;--fg:#eee;--mut:#999;--line:rgba(255,255,255,.12);--panel:#1a1a1a}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.4 -apple-system,system-ui,sans-serif}canvas{display:block;width:100%;height:100%;cursor:grab}
#bar{position:fixed;top:12px;left:12px;right:12px;display:flex;gap:8px;align-items:center;pointer-events:none}#bar>*{pointer-events:auto}
input{flex:0 1 280px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg)}#t{font-weight:600}#s{color:var(--mut)}
#p{position:fixed;right:12px;top:56px;bottom:12px;width:min(360px,calc(100% - 24px));overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;display:none}
#p h3{margin:0 0 4px;font-size:14px;word-break:break-all}#p .m{color:var(--mut);margin-bottom:8px}#p li{margin:2px 0;cursor:pointer;word-break:break-all}#p li span{color:var(--mut)}</style></head><body>
<div id="bar"><span id="t"></span><input id="q" placeholder="find a function, class or file…" autocomplete="off"><span id="s"></span></div><canvas id="c"></canvas><div id="p"></div>
<script>const D=${json};
const pal=['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac','#1f77b4','#2ca02c','#d62728','#9467bd'];
const col=c=>c<0?'#888':pal[c%pal.length];const c=document.getElementById('c'),x=c.getContext('2d'),P=document.getElementById('p');
document.getElementById('t').textContent=D.title;document.getElementById('s').textContent=D.nodes.length+' nodes · '+D.edges.length+' edges';
const N=D.nodes.map((n,i)=>({...n,x:Math.cos(i)*200*Math.random()+Math.cos(n.c)*300,y:Math.sin(i)*200*Math.random()+Math.sin(n.c)*300,vx:0,vy:0})),M=new Map(N.map(n=>[n.id,n]));
const E=D.edges.map(e=>({a:M.get(e[0]),b:M.get(e[1]),r:e[2],inf:e[3]})).filter(e=>e.a&&e.b);
const adj=new Map(N.map(n=>[n.id,[]]));E.forEach(e=>{adj.get(e.a.id).push(e);adj.get(e.b.id).push(e)});
let W,H,dpr=devicePixelRatio||1,cam={x:0,y:0,z:.6},sel=null,hot=null,heat=1;
function size(){W=innerWidth;H=innerHeight;c.width=W*dpr;c.height=H*dpr}addEventListener('resize',size);size();
function step(){if(heat<.02)return;
for(let i=0;i<N.length;i++){const a=N[i];for(let j=i+1;j<N.length;j+=N.length>800?3:1){const b=N[j];const dx=a.x-b.x,dy=a.y-b.y,d2=Math.max(dx*dx+dy*dy,25);if(d2>160000)continue;const d=Math.sqrt(d2),f=700/d2;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}}
for(const e of E){const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.hypot(dx,dy)||1,f=(d-50)*.02;e.a.vx+=dx/d*f;e.a.vy+=dy/d*f;e.b.vx-=dx/d*f;e.b.vy-=dy/d*f}
for(const n of N){n.vx=(n.vx-n.x*.002)*.85;n.vy=(n.vy-n.y*.002)*.85;const v=Math.hypot(n.vx,n.vy);if(v>20){n.vx*=20/v;n.vy*=20/v}n.x+=n.vx*heat;n.y+=n.vy*heat}heat*=.99}
const sx=v=>(v-cam.x)*cam.z+W/2,sy=v=>(v-cam.y)*cam.z+H/2,rad=n=>2+Math.sqrt(n.d)*1.2;
function draw(){step();x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,W,H);const nb=sel?new Set(adj.get(sel.id).flatMap(e=>[e.a.id,e.b.id])):null;
x.lineWidth=1;for(const e of E){const on=sel&&(e.a===sel||e.b===sel);x.strokeStyle=on?(e.inf?'#e15759':'#4e79a7'):getComputedStyle(document.body).getPropertyValue('--line');x.setLineDash(e.inf?[3,3]:[]);x.beginPath();x.moveTo(sx(e.a.x),sy(e.a.y));x.lineTo(sx(e.b.x),sy(e.b.y));x.stroke()}x.setLineDash([]);
for(const n of N){const dim=nb&&!nb.has(n.id);x.globalAlpha=dim?.15:1;x.fillStyle=col(n.c);x.beginPath();const r=rad(n)*(n.k==='file'?.7:1);if(n.k==='file')x.rect(sx(n.x)-r,sy(n.y)-r,r*2,r*2);else x.arc(sx(n.x),sy(n.y),r,0,7);x.fill();
if((cam.z>1.1||n.d>40||n===sel||n===hot||(nb&&nb.has(n.id)))&&!dim){x.fillStyle=getComputedStyle(document.body).getPropertyValue('--fg');x.fillText(n.n,sx(n.x)+r+3,sy(n.y)+4)}}x.globalAlpha=1;requestAnimationFrame(draw)}
function at(px,py){let best=null,bd=1e9;for(const n of N){const d=Math.hypot(sx(n.x)-px,sy(n.y)-py);if(d<Math.max(8,rad(n)+3)&&d<bd){best=n;bd=d}}return best}
function show(n){sel=n;if(!n){P.style.display='none';return}const ls=adj.get(n.id).map(e=>({o:e.a===n?e.b:e.a,dir:e.a===n?'→':'←',e})).sort((a,b)=>b.o.d-a.o.d);
P.innerHTML='<h3></h3><div class="m"></div><ul></ul>';P.querySelector('h3').textContent=n.n;P.querySelector('.m').textContent=n.k+' · '+n.f+' · '+(D.comms[n.c]||'no subsystem')+' · '+n.d+' links';
const ul=P.querySelector('ul');for(const l of ls){const li=document.createElement('li');li.textContent=l.dir+' '+l.o.n+' ';const s=document.createElement('span');s.textContent='['+l.e.r+(l.e.inf?', inferred':'')+']';li.append(s);li.onclick=()=>{focus(l.o)};ul.append(li)}P.style.display='block'}
function focus(n){cam.x=n.x;cam.y=n.y;cam.z=Math.max(cam.z,1.2);show(n)}
let drag=null;c.onmousedown=e=>{drag={x:e.clientX,y:e.clientY,cx:cam.x,cy:cam.y,moved:false}};onmousemove=e=>{if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;cam.x=drag.cx-dx/cam.z;cam.y=drag.cy-dy/cam.z}else hot=at(e.clientX,e.clientY)};
onmouseup=e=>{if(drag&&!drag.moved)show(at(e.clientX,e.clientY));drag=null};c.onwheel=e=>{e.preventDefault();cam.z=Math.min(6,Math.max(.05,cam.z*Math.exp(-e.deltaY*.0015)))};
document.getElementById('q').oninput=e=>{const s=e.target.value.toLowerCase();if(!s)return;const n=N.filter(n=>n.n.toLowerCase().includes(s)).sort((a,b)=>b.d-a.d)[0];if(n)focus(n)};draw();</script></body></html>`;
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// ---------------------------------------------------------------- disk
export const graphPaths = (root = process.cwd()) => {
  const dir = path.join(root, GRAPH_DIR);
  return { dir, json: path.join(dir, 'graph.json'), report: path.join(dir, 'GRAPH_REPORT.md'), html: path.join(dir, 'graph.html') };
};

export function loadGraph(root = process.cwd()) {
  try { return JSON.parse(fs.readFileSync(graphPaths(root).json, 'utf8')); } catch { return null; }
}

/** Build (or update, reusing unchanged files) and write graph.json, the report and the page. */
export function writeGraph(root = process.cwd(), { update = false, html = true } = {}) {
  const previous = update ? loadGraph(root) : null;
  const g = buildGraph(root, { previous });
  const p = graphPaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.json, JSON.stringify(g));
  fs.writeFileSync(p.report, graphReport(g));
  if (html) fs.writeFileSync(p.html, graphHtml(g));
  return { graph: g, paths: p };
}

/** The graph for `root`, built once if there is none yet. */
export function ensureGraph(root = process.cwd()) {
  return loadGraph(root) ?? writeGraph(root, { html: false }).graph;
}
