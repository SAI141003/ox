// Superior context engine: repo map + smart retrieval + budget tracking.
// This is the most impactful feature for reducing token waste.
//
// The key insight: a model that knows the structure of a repo can answer
// questions and make changes with far fewer tokens. A repo map is the
// single highest-ROI optimization for code agents.
//
// Public API:
//   buildRepoMap({ cwd, maxDepth, include, exclude })
//     → { tree, files, exports, signatures, stats, builtAt }
//
//   renderRepoMap(map, opts)
//     → string — compact representation for the system prompt
//
//   findRelevantFiles(map, query, opts)
//     → [{ path, score, reason }] — ranked file matches
//
//   getRelevantSnippets({ cwd, map, query, maxFiles, maxCharsPerFile })
//     → [{ path, snippet, score }] — relevant code chunks
//
//   ContextBudget — tracks token usage and enforces limits

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.next', '.cache', 'target', 'out', '.venv', 'venv']);
const SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+([A-Za-z0-9_$]+)/gm;
const FUNCTION_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/gm;
const CLASS_RE = /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm;

function shouldSkip(name, isDir) {
  if (isDir) return SKIP_DIRS.has(name) || name.startsWith('.') && name !== '.github';
  return SKIP_FILES.has(name);
}

function walk(cwd, rootDepth, maxDepth, include, exclude) {
  const results = [];
  function go(dir, depth) {
    if (depth - rootDepth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (shouldSkip(e.name, e.isDirectory())) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(cwd, full);
      if (include && !include.test(rel)) continue;
      if (exclude && exclude.test(rel)) continue;
      if (e.isDirectory()) {
        go(full, depth + 1);
      } else {
        try {
          const stat = fs.statSync(full);
          if (stat.size > 1_000_000) continue; // skip files > 1MB
          results.push({ path: rel, fullPath: full, size: stat.size, mtime: stat.mtimeMs });
        } catch { /* skip */ }
      }
    }
  }
  go(cwd, 0);
  return results;
}

function countLines(content) {
  if (!content) return 0;
  return content.split('\n').length;
}

function extractFeatures(content) {
  const exp = [];
  const sig = [];
  let m;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) exp.push(`export ${m[1]}`);
  FUNCTION_RE.lastIndex = 0;
  while ((m = FUNCTION_RE.exec(content)) !== null) sig.push(`function ${m[1]}(${m[2].slice(0, 40)})`);
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(content)) !== null) sig.push(`class ${m[1]}`);
  return { exports: exp.slice(0, 50), signatures: sig.slice(0, 50) };
}

export async function buildRepoMap({ cwd, maxDepth = 5, include = null, exclude = null } = {}) {
  const start = Date.now();
  const root = cwd || process.cwd();
  const files = walk(root, 0, maxDepth, include, exclude);
  const byExt = {};
  let totalLines = 0;
  const exports = {};
  const signatures = {};
  for (const f of files) {
    const ext = path.extname(f.path);
    byExt[ext] = (byExt[ext] || 0) + 1;
    // Only parse JS/TS files for exports/signatures
    if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f.path)) {
      try {
        const content = fs.readFileSync(f.fullPath, 'utf8');
        const lines = countLines(content);
        totalLines += lines;
        const feats = extractFeatures(content);
        if (feats.exports.length) exports[f.path] = feats.exports;
        if (feats.signatures.length) signatures[f.path] = feats.signatures;
        f.lines = lines;
      } catch {
        f.lines = 0;
      }
    } else {
      f.lines = 0;
    }
    delete f.fullPath;
  }
  return {
    root,
    files,
    exports,
    signatures,
    stats: {
      totalFiles: files.length,
      totalLines,
      byExt,
      duration: Date.now() - start,
    },
    builtAt: new Date().toISOString(),
  };
}

export function renderRepoMap(map, opts = {}) {
  const maxLines = opts.maxLines ?? 100;
  const groupByDir = opts.groupByDir ?? true;
  const out = [];
  out.push(`Repository: ${map.root}`);
  out.push(`Files: ${map.stats.totalFiles}, Lines: ${map.stats.totalLines}`);
  if (Object.keys(map.stats.byExt).length) {
    const extSummary = Object.entries(map.stats.byExt).map(([e, n]) => `${e}:${n}`).join(' ');
    out.push(`Extensions: ${extSummary}`);
  }
  out.push('');
  if (groupByDir) {
    const byDir = {};
    for (const f of map.files) {
      const dir = path.dirname(f.path) || '.';
      byDir[dir] = byDir[dir] || [];
      byDir[dir].push(f);
    }
    let count = 0;
    for (const [dir, fs2] of Object.entries(byDir).sort()) {
      if (count >= maxLines) { out.push(`... ${map.files.length - count} more files`); break; }
      out.push(`${dir}/`);
      for (const f of fs2.slice(0, 20)) {
        if (count >= maxLines) break;
        const marker = (map.exports[f.path]?.length ?? 0) > 0 ? '*' : ' ';
        out.push(`  ${marker} ${path.basename(f.path)}`);
        count++;
      }
      if (fs2.length > 20) { out.push(`  ... ${fs2.length - 20} more`); count += fs2.length - 20; }
    }
  } else {
    for (const f of map.files.slice(0, maxLines)) {
      const marker = (map.exports[f.path]?.length ?? 0) > 0 ? '*' : ' ';
      out.push(`  ${marker} ${f.path}`);
    }
    if (map.files.length > maxLines) out.push(`... ${map.files.length - maxLines} more`);
  }
  if (Object.keys(map.exports).length) {
    out.push('');
    out.push('Exports:');
    for (const [p, exps] of Object.entries(map.exports).slice(0, 20)) {
      out.push(`  ${p}: ${exps.slice(0, 5).join(', ')}${exps.length > 5 ? '...' : ''}`);
    }
  }
  return out.join('\n');
}

function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9_$.-]+/).filter(Boolean);
}

export function findRelevantFiles(map, query, opts = {}) {
  const limit = opts.limit ?? 10;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return [];
  const scored = [];
  for (const f of map.files) {
    let score = 0;
    const reasons = [];
    const fname = path.basename(f.path).toLowerCase();
    const fpath = f.path.toLowerCase();
    for (const qt of qTokens) {
      if (fname === qt) { score += 20; reasons.push('filename match'); }
      else if (fname.includes(qt)) { score += 10; reasons.push('filename contains'); }
      if (fpath.includes(qt)) { score += 3; reasons.push('path contains'); }
    }
    if (map.exports[f.path]) {
      for (const exp of map.exports[f.path]) {
        for (const qt of qTokens) {
          if (exp.toLowerCase().includes(qt)) { score += 5; reasons.push('export match'); break; }
        }
      }
    }
    if (score > 0) scored.push({ path: f.path, score, reason: reasons[0] || 'match' });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function chunkByParagraphs(content, maxChars) {
  const chunks = [];
  const paras = content.split(/\n\s*\n/);
  let current = '';
  for (const p of paras) {
    if (current.length + p.length > maxChars && current) {
      chunks.push(current);
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function getRelevantSnippets({ cwd, map, query, maxFiles = 3, maxCharsPerFile = 2000 } = {}) {
  const root = cwd || map?.root || process.cwd();
  const matches = findRelevantFiles(map, query, { limit: maxFiles });
  const qTokens = new Set(tokenize(query));
  const results = [];
  for (const m of matches) {
    const fullPath = path.join(root, m.path);
    let content;
    try { content = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }
    const chunks = chunkByParagraphs(content, maxCharsPerFile);
    const scored = [];
    for (const ch of chunks) {
      let s = 0;
      for (const t of qTokens) {
        const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const n = (ch.match(re) || []).length;
        s += n;
      }
      if (s > 0) scored.push({ snippet: ch.slice(0, maxCharsPerFile), score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      results.push({ path: m.path, snippet: scored[0].snippet, score: m.score + scored[0].score });
    }
  }
  return results;
}

export class ContextBudget {
  constructor({ maxTokens = 100_000, reserved = 0 } = {}) {
    this.maxTokens = maxTokens;
    this.reserved = reserved;
    this.usedTokens = 0;
  }
  estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }
  used() { return this.usedTokens; }
  remaining() { return Math.max(0, this.maxTokens - this.usedTokens - this.reserved); }
  fit(text) { return this.estimateTokens(text) <= this.remaining(); }
  add(text) { this.usedTokens += this.estimateTokens(text); return this; }
  reset() { this.usedTokens = 0; return this; }
  toString() { return `ContextBudget(${this.usedTokens}/${this.maxTokens - this.reserved} tokens)`; }
}
