import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { screenReadLines, shortWithheldNotice } from './memory.js';
import { gitToplevel } from './git-fast.js';

// ONE cap for every project-instruction source, nested or not. Every layer
// draws from this single accumulator, so a nested file can never bypass it.
const MEMORY_CAP_CHARS = 48_000;
const TREE_MAX_DEPTH = 6;
const TREE_MAX_ENTRIES = 800;
// What the ranker may LOOK at. The entry cap is what ships; this is only a work
// ceiling, so ranking has real candidates to choose between instead of the first
// 800 names the walk happened to meet.
const TREE_SCAN_CAP = 4000;
const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.ox', '.ox-backups']);

// The tree is ORIENTATION, not content: the model has list_dir/glob to go
// deeper. So it gets a fixed SHARE of the context budget rather than all of it --
// holding it to the whole budget let the tree crowd out the project
// instructions that actually tell the model what to do (docs/research.md 3.2
// designs for a ~1k-token git-aware tree for exactly this reason). One constant
// to change if the trade-off should move.
const TREE_BUDGET_SHARE = 0.125;

// Ranking, best first. Lower rank survives a tight budget longer.
//   0 source code   1 config / docs / tests / ordinary directories
//   2 loose assets  3 vendored trees and generated output
// Within a rank, shallower wins, so the skeleton near cwd survives before the
// deep tail. Compare shape: each tree line is 4 chars of gutter per level plus
// the 4-char branch, which is what the char accounting below assumes.
const VENDOR_RE = /(?:^|[./_-])(?:vendor|vendored|third[._-]?party|thirdparty|external|generated)(?:$|[./_-])/i;
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|pyi|rb|go|rs|java|kt|kts|swift|php|c|h|cc|cpp|cxx|hpp|cs|scala|sh|bash|zsh|fish|vue|svelte|astro)$/i;
const DOC_FILE_RE = /\.(?:md|mdx|rst|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|lock)$/i;
const SOURCE_DIRS = new Set(['src', 'lib', 'app', 'pkg', 'cmd', 'internal', 'core', 'server', 'client']);

// Precedence, LOWEST first: a later file wins a conflict. AGENTS.md / CLAUDE.md
// / GEMINI.md are the filenames the competing agents read, so switching tools
// keeps the same behaviour; .ox.md is ox-native and therefore outranks them.
export const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.ox.md'];
const INSTRUCTION_SUBDIRS = ['rules', path.join('.ox', 'rules')];

// A directory holding any of these bounds the upward walk when there is no git
// root, so /Users/me/AGENTS.md is not silently applied to /Users/me/ox/src.
const ROOT_MARKERS = [
  ...INSTRUCTION_FILENAMES,
  '.git',
  '.gitignore',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
];

export const INSTRUCTION_CAP_CHARS = MEMORY_CAP_CHARS;

export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

// The tree's slice of the context budget. No floor: a project whose instructions
// legitimately fill the budget gets a shorter map rather than a budget overrun,
// and a tiny caller budget still yields a tiny (root-only) tree.
export function treeBudgetTokens(budgetTokens = 8000, instructionsBlock = '') {
  const total = Number(budgetTokens) > 0 ? Number(budgetTokens) : 0;
  return Math.max(0, Math.floor(total * TREE_BUDGET_SHARE) - estimateTokens(instructionsBlock));
}

export function buildContext({ cwd, budgetTokens = 8000, scopedPaths = [] } = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  const instructions = collectMemoryFiles(root, scopedPaths);
  // Instructions are charged FIRST: they are the actual directives, the tree is
  // a map of where they apply. Whatever the directives leave is the tree's.
  const tree = buildTree(root, treeBudgetTokens(budgetTokens, instructions.block));
  return {
    root,
    memoryFiles: instructions.block,
    tree,
    tokenCount: estimateTokens(instructions.block + '\n' + tree),
    instructionRoot: instructions.root,
    instructions: instructions.stats,
  };
}

// ---- project instruction discovery ------------------------------------------

// The instruction root. `git rev-parse --show-toplevel` when cwd is in a repo,
// else the OUTERMOST ancestor that carries a project marker, else cwd itself.
// The walk never goes above this, so instructions are project-scoped rather
// than inherited from every directory on the way to /.
// A repo's toplevel does not move while ox runs, so the one subprocess per
// distinct cwd is paid once instead of on every turn (same process-lifetime
// caching _repoMapCache already uses in system-prompt.js).
const _rootCache = new Map();

function findInstructionRoot(cwd) {
  if (_rootCache.has(cwd)) return _rootCache.get(cwd);
  const found = resolveInstructionRoot(cwd);
  _rootCache.set(cwd, found);
  return found;
}

function resolveInstructionRoot(cwd) {
  // The repo root, read from the filesystem: no `git` subprocess at startup.
  const top = gitToplevel(cwd);
  if (top) return top;
  let best = path.resolve(cwd);
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) best = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
  }
  return best;
}

function realPathOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Containment check on RESOLVED paths. This is what stops a symlink from
// pulling a file from outside the project into every prompt: an escaping
// symlink resolves outside the root and is refused.
function realInside(root, target) {
  const rel = path.relative(realPathOf(root), realPathOf(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Read one candidate instruction file. lstat first so a symlink is recognised
// as one, then a realpath containment check, then read. A symlink that stays
// inside the project is fine; one that leaves it is skipped.
function readInstructionFile(abs, root) {
  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!lst.isFile() && !lst.isSymbolicLink()) return null;
  if (!realInside(root, abs)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// ---- frontmatter: the supported set, and nothing more ------------------------
//
//   ---
//   alwaysApply: true          # always included (wins over globs)
//   globs: src/**, *.md        # comma-separated, or a "- item" YAML list
//   description: <free text>   # informational
//   ---
//
// Absent or UNPARSEABLE frontmatter degrades to alwaysApply: true -- never to
// exclusion. A rule file ox cannot understand is still the user's instruction;
// silently dropping it because of a typo is the dangerous failure mode.
export function parseInstructionFrontmatter(text) {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  const fallback = {
    globs: [],
    alwaysApply: true,
    description: '',
    scoped: false,
    degraded: true,
    body: raw,
  };
  if ((lines[0] ?? '').trim() !== '---') return { ...fallback };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  // Unterminated fence: the whole file is body, so the instruction still lands.
  if (close === -1) return { ...fallback };
  const fm = lines.slice(1, close);
  const globs = [];
  let alwaysApply = null;
  let description = '';
  let malformed = false;
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) continue; // an unrecognised line is ignored, not fatal
    const key = m[1].toLowerCase();
    const val = stripQuotes(m[2].trim());
    if (val === '') {
      const items = [];
      while (i + 1 < fm.length && /^[ \t]*-[ \t]+/.test(fm[i + 1])) {
        items.push(stripQuotes(fm[i + 1].replace(/^[ \t]*-[ \t]+/, '').trim()));
        i++;
      }
      if (key === 'globs') globs.push(...items);
      else if (key === 'alwaysapply' && items.length) {
        const t = truthy(items[0]);
        if (t === null) malformed = true;
        else alwaysApply = t;
      } else if (key === 'description' && items.length) description = items.join(' ');
      continue;
    }
    if (key === 'globs') globs.push(...splitList(val));
    else if (key === 'alwaysapply') {
      const t = truthy(val);
      if (t === null) malformed = true;
      else alwaysApply = t;
    } else if (key === 'description') description = val;
  }
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '');
  const clean = globs.map((g) => g.trim()).filter(Boolean);
  // A glob whose character class does not close means the frontmatter is not
  // understood, and "not understood" must degrade to always-on -- never to
  // silently-dropped instructions. Same for a non-boolean alwaysApply value.
  if (malformed || clean.some((g) => !balancedBrackets(g))) {
    return { globs: [], alwaysApply: true, description, scoped: false, degraded: true, body };
  }
  // alwaysApply:true wins over globs (Cursor's rule); explicit false with no
  // globs means "not auto-applied"; globs alone mean path-scoped; anything else
  // (frontmatter present but neither key) behaves like no frontmatter at all.
  const scoped = alwaysApply !== true && (clean.length > 0 || alwaysApply === false);
  return { globs: clean, alwaysApply: !scoped, description, scoped, degraded: false, body };
}

// An unclosed `[...]` is a typo, not a pattern. Detected here so the file
// degrades to always-apply rather than silently never matching.
function balancedBrackets(s) {
  let depth = 0;
  for (const ch of String(s ?? '')) {
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function stripQuotes(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitList(v) {
  return String(v ?? '')
    .split(',')
    .map((s) => stripQuotes(s))
    .filter(Boolean);
}

function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'on' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === 'off' || s === '0') return false;
  return null;
}

// Paths are compared workspace-relative and POSIX-separated so a glob written
// the way a human writes it (`src/**/*.ts`) matches regardless of platform.
function normRel(p, root) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  if (!s) return '';
  if (path.isAbsolute(s)) {
    const rel = path.relative(root, path.resolve(s));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return s.replace(/^\/+/, '');
    s = rel;
  }
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

// Unlike globToRegExp (which backs .gitignore), a rule glob follows globby /
// Cursor semantics: `src/**\/*.ts` must also match `src/a.ts`, i.e. a
// globstar spans ZERO OR MORE path segments. A leading `**\/` is likewise
// optional, so `*.ts` covers `src/deep/a.ts`.
function instructionGlobToRegExp(glob) {
  const g = String(glob).replace(/^\/+/, '');
  let re = '';
  let i = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
          while (g[i] === '*') i++;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function globHits(glob, candidate) {
  const g = String(glob).replace(/^\/+/, '');
  for (const re of [instructionGlobToRegExp(g), instructionGlobToRegExp(`**/${g}`)]) {
    if (re.test(candidate)) return true;
  }
  // A bare directory pattern governs everything beneath it.
  if (!/[?*]/.test(g) && (candidate === g || candidate.startsWith(`${g}/`))) return true;
  return false;
}

// True when any candidate path the agent is about to touch matches any glob.
export function matchInstructionGlobs(globs, paths, root = process.cwd()) {
  const list = (Array.isArray(globs) ? globs : [globs]).map((g) => String(g ?? '').trim()).filter(Boolean);
  if (!list.length) return false;
  const cands = (Array.isArray(paths) ? paths : []).map((p) => normRel(p, root)).filter(Boolean);
  for (const c of cands) for (const g of list) if (globHits(g, c)) return true;
  return false;
}

// Cheap, honest guess at which files a turn is about: the @path refs the user
// typed. ox has no reliable "about to touch" signal before the model speaks,
// so this is the real answer rather than a guess dressed as one.
export function instructionScopesFromText(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(?:^|[\s("'`])@([^\s"'`,)]+)/g)) {
    const v = m[1].replace(/[.,;:!?]+$/, '');
    if (v && v !== 'git.diff' && !out.includes(v)) out.push(v);
  }
  return out;
}

// ---- collection -------------------------------------------------------------

// Deeper-wins layered instructions: walk the project root down to cwd and
// collect, at every level, INSTRUCTION_FILENAMES plus <dir>/rules/*.md and
// <dir>/.ox/rules/*.md. Root-first ordering means DEEPER files concatenate
// LATER, so a nested instruction overrides its parent for the same key --
// Cursor's parent-child merge model. Gitignore-aware via the same rule engine
// the tree walker uses. Content is screened line-by-line through the shared
// read screen: an instruction file is untrusted INPUT that is re-injected into
// every prompt, the same class as skill frontmatter.
function collectMemoryFiles(cwd, scopedPaths = []) {
  const root = findInstructionRoot(cwd);
  const chain = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    chain.push(dir);
    if (dir === root) break;
    const up = path.dirname(dir);
    if (up === dir) break;
  }
  chain.reverse();

  let giRules = [];
  try {
    giRules = parseGitignore(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'));
  } catch {}
  const visibleRel = (rel) => {
    if (!rel) return true;
    const segs = rel.split(path.sep);
    for (let i = 0; i < segs.length; i++) {
      const sub = segs.slice(0, i + 1).join('/');
      if (ignoredByRules(giRules, sub, segs[i], i < segs.length - 1)) return false;
    }
    return true;
  };

  const found = [];
  const consider = (p) => {
    const rel = path.relative(cwd, p);
    if (!visibleRel(rel)) return;
    const raw = readInstructionFile(p, root);
    if (raw == null) return;
    found.push({ p, raw });
  };
  for (const dir of chain) {
    for (const name of INSTRUCTION_FILENAMES) consider(path.join(dir, name));
    for (const sub of INSTRUCTION_SUBDIRS) {
      const rd = path.join(dir, sub);
      let ents;
      try {
        ents = fs.readdirSync(rd, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents
        .filter((x) => x.isFile())
        .map((x) => x.name)
        .sort()) {
        consider(path.join(rd, e));
      }
    }
  }

  let out = '';
  let withheld = 0;
  let included = 0;
  let scopedIn = 0;
  let truncated = false;
  const candidates = (Array.isArray(scopedPaths) ? scopedPaths : []).map((p) => normRel(p, cwd));
  for (const f of found) {
    const meta = parseInstructionFrontmatter(f.raw);
    if (meta.scoped && !matchInstructionGlobs(meta.globs, candidates, cwd)) continue;
    const rel = path.relative(cwd, f.p) || path.basename(f.p);
    const screen = screenReadLines(String(meta.body).split('\n'), `ox:${rel}`, 'project instructions');
    withheld += screen.withheld;
    const tag = meta.scoped ? ` (path-scoped: ${meta.globs.join(', ')})` : '';
    const block = `\n<!-- ox: project instructions from ${f.p}${tag} -->\n${screen.kept.join('\n')}\n`;
    if (out.length + block.length > MEMORY_CAP_CHARS) {
      out += block.slice(0, Math.max(0, MEMORY_CAP_CHARS - out.length));
      out += `\n<!-- ox: project instructions truncated at ${MEMORY_CAP_CHARS} chars -->\n`;
      truncated = true;
      break;
    }
    out += block;
    included++;
    if (meta.scoped) scopedIn++;
  }
  if (withheld) out += `\n${shortWithheldNotice(withheld, 'instruction line')}\n`;
  return {
    root,
    block: out,
    stats: {
      root,
      files: found.length,
      included,
      scoped: scopedIn,
      withheld,
      truncated,
      chars: out.length,
      cap: MEMORY_CAP_CHARS,
      scopedPaths: candidates,
    },
  };
}

export function parseGitignore(text) {
  const rules = [];
  for (const raw of String(text).split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) continue;
    rules.push({ negate, dirOnly, anchored, re: globToRegExp(line) });
  }
  return rules;
}

export function globToRegExp(glob) {
  if (glob.startsWith('**/')) {
    return new RegExp(`^(?:.*/)?${globBodyToRe(glob.slice(3))}$`);
  }
  return new RegExp(`^${globBodyToRe(glob)}$`);
}

function globBodyToRe(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        while (glob[i] === '*') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return re;
}

function ignoredByRules(rules, relPath, basename, isDir) {
  let decision = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const target = rule.anchored ? relPath : basename;
    if (target && rule.re.test(target)) decision = !rule.negate;
  }
  return decision;
}

function treeRank(name, isDir) {
  if (VENDOR_RE.test(name)) return 3;
  if (isDir) return SOURCE_DIRS.has(name) ? 0 : 1;
  if (SOURCE_FILE_RE.test(name)) return 0;
  if (DOC_FILE_RE.test(name)) return 1;
  return 2;
}

// Render the kept entries back into the same box-drawing shape the unbounded
// walk produced. Branch glyphs are recomputed from the kept siblings, so a
// partially-kept directory reads as a real tree rather than a broken one.
// Top-level entries are the children of the -1 pseudo-parent. `elided` holds
// the per-directory marker (elisionMarker), so a directory that lost children
// says so on its own line instead of reading as empty.
function renderTree(rootLabel, cands, kept, elided = new Map()) {
  const lines = [rootLabel];
  const byParent = new Map();
  // Iterate candidates in WALK order (not `kept` order) so siblings keep the
  // dirs-first / name-sorted placement the unbounded walk gave them; `kept`
  // only decides WHICH siblings appear, never their order.
  for (let i = 0; i < cands.length; i++) {
    if (!kept.has(i)) continue;
    const p = cands[i].parent;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(i);
  }
  const emit = (parent, prefix) => {
    const kids = byParent.get(parent) || [];
    kids.forEach((idx, k) => {
      const c = cands[idx];
      const last = k === kids.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${c.label}${elided.get(idx) ?? ''}`);
      if (c.isDir) emit(idx, prefix + (last ? '    ' : '│   '));
    });
  };
  emit(-1, '');
  return lines;
}

// How many of a directory's OWN children were seen and then not kept. Zero
// means the directory is either FULLY RETAINED or GENUINELY EMPTY -- both must
// render unmarked, so no false "(+0)" can ever land on a real empty directory.
//
// `floor` means the walk was cut off by TREE_SCAN_CAP somewhere in this
// directory's subtree, so the count is a lower bound rather than a total -- the
// same `+` convention the global elision line already uses.
function elisionCounts(cands, kept, cutAbove, unknownElided) {
  const out = new Map();
  for (let i = 0; i < cands.length; i++) {
    if (kept.has(i)) continue;
    const p = cands[i].parent;
    // Only a RENDERED parent can carry a marker: a dropped directory takes its
    // own children with it, and nothing below a missing parent is drawn.
    if (p === -1 || !kept.has(p)) continue;
    const floor = cutAbove.has(p) || cutAbove.has(i);
    const cur = out.get(p);
    if (cur) {
      cur.n++;
      cur.floor = cur.floor || floor;
    } else out.set(p, { n: 1, floor });
  }
  // A listing cut off mid-walk has an unseen tail. The collected children still
  // count, and `floor` says the real number is higher. If the walk was cut
  // before it collected anything here, the tail count is genuinely unknown and
  // is reported as unknown rather than as a number nobody counted.
  for (const i of cutAbove) {
    if (!kept.has(i)) continue;
    const cur = out.get(i);
    if (cur) cur.floor = true;
    else out.set(i, { n: unknownElided ? -1 : 0, floor: true });
  }
  return out;
}

// A directory rendered childless reads to the model as "this directory is
// empty" -- a lie whenever children were elided, and the same silent-
// truncation dishonesty the global line exists to prevent, just relocated to
// the place the model actually reads.
//
// The COMPACT form is deliberate. The long form `  (+4 elided)` costs 14 chars
// per marked directory; measured on a repo of 120 directories it came to 1651
// chars, ~19% of the whole 1000-token tree share, enough to push 43 real
// entries out of the map to make room for the annotation. The global line at
// the foot of the tree already supplies the vocabulary ("more entries", "use
// list_dir or glob to explore"), so the per-line marker only has to say "this
// directory is short by N" -- 7 chars, half the price, still visually distinct
// from the entry name because of the parentheses.
//
// -1 means "the walk was cut before it counted anything here": an unknown count
// is stated as unknown, never as 0, because 0 would read as "nothing elided".
function elisionMarker(entry) {
  if (entry.n < 0) return '  (+?)';
  return `  (+${entry.n}${entry.floor ? '+' : ''})`;
}

function buildTree(root, budgetTokens) {
  let rules = [];
  const giPath = path.join(root, '.gitignore');
  try {
    rules = parseGitignore(fs.readFileSync(giPath, 'utf8'));
  } catch {}
  const rootLabel = `${path.basename(root) || root}/`;
  // estimateTokens is ceil(chars/4), so a char ceiling of 4x the token budget is
  // the exact same inequality -- no second, disagreeing estimator.
  const charBudget = Math.max(0, budgetTokens) * 4;

  // One flat pass collects every visible entry with the metadata ranking needs.
  // SKIP_DIRS (ALWAYS_SKIP) and .gitignore filtering are unchanged; only the
  // ORDER in which entries compete for the budget is new.
  const cands = [];
  let scanCut = false;
  // Directories whose own listing was cut short by TREE_SCAN_CAP. Anything at or
  // below one of them has an unseen tail, so its elision count is a floor.
  const cutDirs = new Set();
  const walk = (dir, depth, parent) => {
    if (scanCut || depth > TREE_MAX_DEPTH) return;
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const relOf = (name) => (parent === -1 ? name : `${cands[parent].rel}/${name}`);
    const visible = dirents
      .filter((d) => !ALWAYS_SKIP.has(d.name))
      .filter((d) => !ignoredByRules(rules, relOf(d.name), d.name, d.isDirectory()))
      .sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
    for (const d of visible) {
      if (cands.length >= TREE_SCAN_CAP) {
        scanCut = true;
        cutDirs.add(parent);
        return;
      }
      const isDir = d.isDirectory();
      const idx = cands.length;
      const label = `${d.name}${isDir ? '/' : ''}`;
      cands.push({
        label,
        rel: relOf(d.name),
        isDir,
        depth,
        parent,
        rank: treeRank(d.name, isDir),
        // 4 gutter chars per level + the 4-char branch + label + newline.
        chars: (depth + 1) * 4 + 4 + label.length + 1,
      });
      if (isDir) walk(path.join(dir, d.name), depth + 1, idx);
    }
  };
  walk(root, 0, -1);

  const all = new Set(cands.map((_, i) => i));
  const fullChars = cands.reduce((n, c) => n + c.chars, rootLabel.length + 1);
  // Already within budget and complete: return it untouched, byte for byte.
  if (!scanCut && cands.length <= TREE_MAX_ENTRIES && fullChars <= charBudget) {
    return renderTree(rootLabel, cands, all).join('\n');
  }

  // Over budget. Spend it in rank order: shallower first inside each rank, walk
  // order as the tie-break so equal entries keep their alphabetical placement.
  const order = cands.map((_, i) => i);
  order.sort((a, b) => cands[a].depth - cands[b].depth || cands[a].rank - cands[b].rank || a - b);
  const kept = new Set();
  let chars = rootLabel.length + 1;
  for (const i of order) {
    if (kept.size >= TREE_MAX_ENTRIES) break;
    const c = cands[i];
    // An entry is only renderable if every directory above it survived, so a
    // kept file can never appear without the path that locates it.
    let anc = c.parent;
    let reachable = true;
    while (anc !== -1) {
      if (!kept.has(anc)) {
        reachable = false;
        break;
      }
      anc = cands[anc].parent;
    }
    if (!reachable) continue;
    // Keep going past an entry that does not fit: shorter names still do.
    if (chars + c.chars > charBudget) continue;
    kept.add(i);
    chars += c.chars;
  }

  // A cut listing makes every ancestor's elision count a floor, not a total.
  const cutAbove = new Set();
  for (const idx of cutDirs) {
    for (let a = idx; a !== -1 && !cutAbove.has(a); a = cands[a].parent) cutAbove.add(a);
  }

  // The global line counts everything dropped anywhere in the tree; the
  // per-directory marker counts what THIS directory is hiding. Same fact at two
  // scales: the global one is the summary, the per-directory one sits next to
  // the directory it applies to, which is the only place the model actually
  // looks. Both count only what was actually seen: `+` when the scan cap cut
  // the walk off early.
  const globalLine = () =>
    `... ${cands.length - kept.size}${scanCut ? '+' : ''} more entries (use list_dir or glob to explore)`;

  // The markers are part of the payload, so they are charged against the same
  // budget as the entries -- and the ceiling is checked on the RENDERED string,
  // not on an estimate of it, because estimateTokens is ceil(chars/4) and an
  // unaccounted few dozen chars would be a real overrun on every single turn.
  // Every drop is counted first, so the one case with an uncountable tail -- a
  // listing the scan cap cut before it collected anything -- only ever applies
  // on the first render. The "+?" form is a safety valve, not a routine cost.
  const firstDrop = cands.length - kept.size;
  const unknownElided = scanCut && cutAbove.size > 0 && firstDrop === 0;
  let dropPtr = order.length - 1;
  let out = '';
  const render = () => {
    const elided = new Map();
    for (const [idx, e] of elisionCounts(cands, kept, cutAbove, unknownElided)) {
      if (idx === -1 || !kept.has(idx)) continue;
      elided.set(idx, elisionMarker(e));
    }
    // The root label is deliberately NOT marked: its own losses are quantified
    // by the global line that follows it on the very next line.
    out = `${renderTree(rootLabel, cands, kept, elided).join('\n')}\n${globalLine()}`;
  };
  render();
  // Over budget once the markers are on the line: give back the least-preferred
  // entries -- the tail of the same order they were chosen in -- until it fits.
  // Entries are only ever removed, so one descending pointer walks `order` once.
  while (out.length > charBudget && kept.size > 0) {
    while (dropPtr >= 0 && !kept.has(order[dropPtr])) dropPtr--;
    if (dropPtr < 0) break;
    kept.delete(order[dropPtr]);
    dropPtr--;
    render();
  }
  return out;
}
export function pureCompact(messages, keepTurns = 4) {
  const msgs = Array.isArray(messages) ? messages : [];
  let h = 0;
  while (h < msgs.length && msgs[h]?.role === 'system') h++;
  const head = msgs.slice(0, h);
  const rest = msgs.slice(h);
  const k = Math.max(0, Math.floor(keepTurns ?? 4));
  let cut = k === 0 ? rest.length : Math.max(0, rest.length - k);
  while (cut > 0 && rest[cut]?.role === 'tool') cut--;
  return {
    head,
    toSummarize: rest.slice(0, cut),
    tail: rest.slice(cut),
  };
}

// ---- context breakdown (Warp-style per-segment accounting) -----------------
//
// The point of this is to answer "why did the bill go up" from REAL data, not
// from a guess. Two rules make the numbers trustworthy:
//
//   1. EXACT PARTITION. Every message lands in exactly one segment and the
//      per-message serialization here is byte-identical to the one the agent
//      meters with (`tokensOf` in agent.js sums `estimateTokens(JSON.stringify(m
//      ?? {}))` per message; the schema block is `estimateTokens(JSON.stringify(
//      tools.filter(Boolean)))`). So the segments sum to the payload by
//      construction rather than by coincidence, and a test can assert the sum
//      against `payloadTokens()` from agent.js to prove the two agree.
//   2. THE SCHEMAS ARE A SEGMENT, NOT A FOOTNOTE. The tool-schema array rides
//      alongside `messages` to the provider and is invisible to `history`, so
//      measuring history alone under-reports every request by the whole schema
//      block. It is measured here with the same estimator.

export const CONTEXT_SEGMENT_IDS = Object.freeze([
  'system-prompt',
  'tool-definitions',
  'conversation-history',
  'latest-input',
  'other',
]);

const SEGMENT_LABELS = Object.freeze({
  'system-prompt': 'system prompt',
  'tool-definitions': 'tool definitions',
  'conversation-history': 'conversation history',
  'latest-input': 'latest user input',
  other: 'other',
});

function segmentAcc(id) {
  return { id, label: SEGMENT_LABELS[id] ?? id, bytes: 0, tokens: 0, messages: 0, summaries: 0 };
}

// Byte/token measure of ONE message exactly as the agent meters it.
function measureMessage(m) {
  const json = JSON.stringify(m ?? {});
  return { bytes: Buffer.byteLength(json, 'utf8'), tokens: estimateTokens(json) };
}

function finishSegments(list) {
  const totalTokens = list.reduce((n, s) => n + s.tokens, 0);
  const totalBytes = list.reduce((n, s) => n + s.bytes, 0);
  return list.map((s) => ({
    ...s,
    pctOfPayload: totalTokens > 0 ? (s.tokens / totalTokens) * 100 : 0,
    pctOfBytes: totalBytes > 0 ? (s.bytes / totalBytes) * 100 : 0,
  }));
}

// `summaryPrefix` lets a caller spot the placeholder message compaction leaves
// behind so the breakdown can say "of this, N tokens are a summary, not real
// turns" instead of passing the synthetic message off as conversation.
function isSummaryMessage(m, summaryPrefix) {
  return typeof m?.content === 'string' && summaryPrefix.length > 0 && m.content.startsWith(summaryPrefix);
}

/**
 * Segment the payload ox is about to send to the provider.
 *
 * @param {object}  input
 * @param {Array}   input.messages  the FULL assembled history, system message first
 * @param {Array}   [input.tools]   the tool-schema array (sent SEPARATELY from messages)
 * @param {number}  [input.window]  the model's context window, for % of window
 * @param {number}  [input.threshold] the auto-compaction fraction (e.g. 0.75)
 * @param {string}  [input.summaryPrefix] prefix of a compaction summary placeholder
 */
export function breakdownContext({
  messages = [],
  tools = [],
  window = 0,
  threshold = null,
  summaryPrefix = '',
} = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const acc = Object.fromEntries(CONTEXT_SEGMENT_IDS.map((id) => [id, segmentAcc(id)]));

  // Leading system messages are the system prompt proper (pureCompact treats
  // every leading system message as `head`, so this matches how compaction
  // preserves them). A system message anywhere else is not the prompt.
  let i = 0;
  while (i < msgs.length && msgs[i]?.role === 'system') {
    const m = measureMessage(msgs[i]);
    acc['system-prompt'].bytes += m.bytes;
    acc['system-prompt'].tokens += m.tokens;
    acc['system-prompt'].messages++;
    i++;
  }

  // The latest user turn is the single biggest honest lever the USER controls,
  // so it gets its own segment rather than being buried in history.
  let lastUser = -1;
  for (let k = msgs.length - 1; k >= i; k--) {
    if (msgs[k]?.role === 'user') {
      lastUser = k;
      break;
    }
  }

  for (let k = i; k < msgs.length; k++) {
    const msg = msgs[k];
    const m = measureMessage(msg);
    let id;
    if (k === lastUser) id = 'latest-input';
    else if (msg?.role === 'system') id = 'other';
    else id = 'conversation-history';
    acc[id].bytes += m.bytes;
    acc[id].tokens += m.tokens;
    acc[id].messages++;
    if (id === 'conversation-history' && isSummaryMessage(msg, summaryPrefix)) acc[id].summaries++;
  }

  // Measured on the filtered+serialized list so the term is identical to the
  // one streamVia actually ships; an empty (no-tools) offer is exactly 0.
  const schemaList = (Array.isArray(tools) ? tools : []).filter(Boolean);
  const schemaJson = JSON.stringify(schemaList);
  acc['tool-definitions'].bytes = schemaList.length ? Buffer.byteLength(schemaJson, 'utf8') : 0;
  acc['tool-definitions'].tokens = schemaList.length ? estimateTokens(schemaJson) : 0;
  acc['tool-definitions'].messages = schemaList.length;

  const segments = finishSegments(CONTEXT_SEGMENT_IDS.map((id) => acc[id]));
  const totalTokens = segments.reduce((n, s) => n + s.tokens, 0);
  const totalBytes = segments.reduce((n, s) => n + s.bytes, 0);
  const win = Number(window) > 0 ? Number(window) : 0;

  // The biggest lever, honestly: largest by TOKENS, since tokens are what the
  // provider bills and what the window is denominated in. Strict `>` so ties
  // break toward the earlier segment and the answer is deterministic.
  let largest = segments[0];
  for (const s of segments) if (s.tokens > largest.tokens) largest = s;

  const at = Number.isFinite(Number(threshold)) ? Number(threshold) : null;
  const triggerTokens = at != null && win > 0 ? win * at : null;

  return {
    segments,
    total: { bytes: totalBytes, tokens: totalTokens },
    window: win,
    // What fraction of the window the payload occupies. THIS is the number that
    // decides whether the next turn compacts.
    windowPct: win > 0 ? (totalTokens / win) * 100 : null,
    largest: largest ? { id: largest.id, label: largest.label, tokens: largest.tokens } : null,
    threshold: {
      at,
      tokens: triggerTokens,
      crossed: triggerTokens != null ? totalTokens > triggerTokens : null,
      headroomTokens: triggerTokens != null ? triggerTokens - totalTokens : null,
    },
    messageCount: msgs.length,
    summaryPrefix,
  };
}

// Single-line human summary, kept next to the data so the CLI renderer and any
// other consumer cannot drift apart on what a segment means.
export function describeLargestSegment(breakdown) {
  const l = breakdown?.largest;
  if (!l || (breakdown?.total?.tokens ?? 0) <= 0) return 'no context yet';
  const pct = breakdown.total.tokens > 0 ? (l.tokens / breakdown.total.tokens) * 100 : 0;
  return `${l.label} is the largest segment — ${l.tokens} of ${breakdown.total.tokens} tokens (${pct.toFixed(1)}%)`;
}

export function staleToolOutputTrim(messages, capChars = 25_000) {
  const msgs = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  let lastTool = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === 'tool') lastTool = i;
  }
  return msgs.map((m, i) => {
    if (m?.role !== 'tool' || i === lastTool) return m;
    if (typeof m.content === 'string' && m.content.length > capChars) {
      return { ...m, content: `[output truncated, ${m.content.length} chars]` };
    }
    return m;
  });
}

// ---- F4 @ context references ------------------------------------------------

const REF_TOKEN_RE = /@[^\s]+/g;
const FILE_REF_CAP = 2_000;
const DIR_TREE_ENTRIES = 40;
const DIR_TREE_CAP = 1_000;
const GIT_DIFF_CAP = 4_096;
const REFS_COMBINED_CAP = 8 * 1024;

let unknownRefNoted = false;

function dimNote(msg) {
  const text = process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${msg}\x1b[22m\n` : `${msg}\n`;
  process.stderr.write(text);
}

function dirTreeOf(absDir, label) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : ''));
  } catch {
    return null;
  }
  entries.sort();
  let body = entries.slice(0, DIR_TREE_ENTRIES).join('\n');
  if (entries.length > DIR_TREE_ENTRIES) body += `\n[truncated: ${entries.length} entries]`;
  if (body.length > DIR_TREE_CAP) body = body.slice(0, DIR_TREE_CAP);
  return `\n[begin @${label}]\n${body}\n[end]`;
}

function fileRefBlock(absFile, label) {
  let content;
  try {
    content = fs.readFileSync(absFile, 'utf8');
  } catch {
    return null;
  }
  if (content.length > FILE_REF_CAP) content = content.slice(0, FILE_REF_CAP);
  return `\n[begin @${label}]\n${content}\n[end]`;
}

function gitDiffBlock(cwd) {
  try {
    const diff = execSync('git diff', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    if (!diff.trim()) return null;
    return `\n[begin @git.diff]\n${diff.slice(0, GIT_DIFF_CAP)}\n[end]`;
  } catch {
    return null;
  }
}

// F4 input preprocessing: replace @<existing-file>, @<existing-dir>/ and
// @git.diff tokens with inline [begin]/[end] blocks. Unknown tokens stay
// literal with a once-per-process stderr note. Total inserted content is
// capped at REFS_COMBINED_CAP chars.
export function expandContextRefs(text, cwd = process.cwd()) {
  const root = path.resolve(cwd ?? process.cwd());
  let budget = REFS_COMBINED_CAP;
  return String(text ?? '').replace(REF_TOKEN_RE, (token) => {
    if (budget <= 0) return token;
    const label = token.slice(1);
    let block = null;
    if (label === 'git.diff') {
      block = gitDiffBlock(root);
      if (!block) {
        if (!unknownRefNoted) {
          unknownRefNoted = true;
          dimNote(`ox: @git.diff unavailable here (not a repo or empty diff) — left literal`);
        }
        return token;
      }
    } else if (label.startsWith('llms:')) {
      return token; // expanded by src/llms-txt.js
    } else if (label) {
      const abs = path.resolve(root, label.replace(/\/+$/, '') || '/');
      let st = null;
      try {
        st = fs.statSync(abs);
      } catch {}
      if (st?.isFile()) block = fileRefBlock(abs, label);
      else if (st?.isDirectory()) block = dirTreeOf(abs, label);
      if (!block && !unknownRefNoted) {
        unknownRefNoted = true;
        dimNote(`ox: @ref '${token}' not found — left literal`);
      }
    }
    if (!block) return token;
    if (block.length > budget) return token;
    budget -= block.length;
    return token + block;
  });
}
