import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CODEBASE_INDEX_SCHEMA_VERSION = '1.0.0';

const EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.md', '.json', '.yaml', '.yml']);
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'this', 'that', 'these', 'those', 'it', 'its', 'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'just', 'about', 'above', 'after', 'again', 'all', 'also', 'as', 'because', 'before', 'below', 'between', 'both', 'each', 'few', 'more', 'most', 'other', 'our', 'out', 'over', 'own', 'same', 'some', 'such', 'up', 'when', 'where', 'which', 'while', 'who', 'whom', 'why']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'vendor', '.venv']);

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function computeTf(tokens) {
  const freq = {};
  const total = tokens.length || 1;
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  for (const t in freq) freq[t] /= total;
  return freq;
}

function computeIdf(termDocs, docCount) {
  const result = {};
  for (const [term, docs] of Object.entries(termDocs)) {
    result[term] = Math.log((docCount + 1) / (Object.keys(docs).length + 1)) + 1;
  }
  return result;
}

function makeSnippet(content, terms, context = 80) {
  const lower = content.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t);
    if (p >= 0 && (pos < 0 || p < pos)) { pos = p; break; }
  }
  if (pos < 0) return content.slice(0, 200).replace(/\s+/g, ' ');
  const start = Math.max(0, pos - context);
  const end = Math.min(content.length, pos + context * 2);
  return (start > 0 ? '...' : '') + content.slice(start, end).replace(/\s+/g, ' ') + (end < content.length ? '...' : '');
}

export function createCodebaseIndex(cwd) {
  const indexPath = path.join(os.homedir(), '.ox', 'codebase-index.json');
  const index = { files: {}, terms: {}, docCount: 0 };
  let dirty = false;

  function indexFile(filePath, content) {
    if (!EXTENSIONS.has(path.extname(filePath))) return;
    const tokens = tokenize(content);
    if (tokens.length === 0) return;
    const freqs = computeTf(tokens);
    index.files[filePath] = { content, terms: freqs, lineCount: content.split('\n').length };
    for (const term of Object.keys(freqs)) {
      if (!index.terms[term]) index.terms[term] = {};
      index.terms[term][filePath] = freqs[term];
    }
    index.docCount = Object.keys(index.files).length;
    dirty = true;
  }

  function indexDirectory(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        indexDirectory(full);
      } else if (stat.isFile() && EXTENSIONS.has(path.extname(entry))) {
        try { indexFile(full, fs.readFileSync(full, 'utf8')); } catch { /* skip */ }
      }
    }
  }

  function search(query, limit = 10) {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const idfMap = computeIdf(index.terms, index.docCount);
    const results = [];
    for (const [fp, fileData] of Object.entries(index.files)) {
      let score = 0;
      const matched = [];
      for (const t of terms) {
        if (fileData.terms[t]) {
          score += fileData.terms[t] * (idfMap[t] || 0);
          matched.push(t);
        }
      }
      if (score > 0) results.push({ path: fp, score, snippet: makeSnippet(fileData.content, matched), lines: fileData.lineCount });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  function getIndexStats() {
    return { files: index.docCount, terms: Object.keys(index.terms).length, schemaVersion: CODEBASE_INDEX_SCHEMA_VERSION };
  }

  function save() {
    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    dirty = false;
  }

  function load() {
    if (!fs.existsSync(indexPath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      Object.assign(index, data);
      dirty = false;
      return true;
    } catch { return false; }
  }

  function clear() {
    index.files = {};
    index.terms = {};
    index.docCount = 0;
    dirty = true;
  }

  return { indexFile, indexDirectory, search, getIndexStats, save, load, clear };
}

export function tfIdfSearch(index, query) {
  const terms = tokenize(query);
  if (terms.length === 0 || !index.files || Object.keys(index.files).length === 0) return [];
  const idfMap = computeIdf(index.terms || {}, index.docCount || 1);
  const results = [];
  for (const [fp, fileData] of Object.entries(index.files)) {
    let score = 0;
    const matched = [];
    for (const t of terms) {
      if (fileData.terms && fileData.terms[t]) {
        score += fileData.terms[t] * (idfMap[t] || 0);
        matched.push(t);
      }
    }
    if (score > 0) results.push({ path: fp, score, snippet: makeSnippet(fileData.content, matched), lines: fileData.lineCount });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

export function formatSearchResults(results) {
  if (!results.length) return 'No results.';
  const lines = [`${results.length} result(s):`, ''];
  for (const r of results) {
    lines.push(`  ${r.path}  (score: ${r.score.toFixed(4)}, lines: ${r.lines})`);
    lines.push(`    ${r.snippet}`);
  }
  return lines.join('\n');
}
