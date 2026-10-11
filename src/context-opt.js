import { runAgent } from './agent.js';
import { generateCritique } from './self-improve.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const COMPRESS_OBSERVATION = 'Compress the following observation into essential facts. Preserve: actions taken, results, errors, next steps. Remove: filler, redundancy, intermediate steps.';
export const COMPRESS_HISTORY = 'Summarize this interaction history into key decisions, active context, and pending items. Preserve facts, remove pleasantries and repeated content.';

const SENSITIVE = [/-----begin/i, /\bapi[_-]?key\b/i, /\bsecret\b/i, /\bpassword\b/i, /\btoken\b/i, /\bauthorization\b/i, /process\.env/i, /home[\\/][^\\/]+/, /(\/[a-z0-9_.-]+){2,}/gi];

function sanitize(content) {
  let s = String(content ?? '');
  for (const r of SENSITIVE) s = s.replace(r, '[redacted]');
  return s.slice(0, 8000);
}

async function runCompressor(prompt, target) {
  try {
    const res = await runAgent({ target, messages: [{ role: 'user', content: prompt }], ctx: { allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 }, maxIterations: 2 });
    let text = '';
    for await (const ev of res) { if (ev.type === 'final') text = ev.message?.content || text; else if (ev.type === 'text-delta') text += ev.text; }
    return text || '';
  } catch { return ''; }
}

export async function compressObservation({ observation, guidelines, target }) {
  return runCompressor(`${sanitize(guidelines || COMPRESS_OBSERVATION)}\n\n${sanitize(observation)}`, target);
}

export async function compressHistory({ messages, guidelines, target }) {
  const text = (messages || []).map((m) => `[${m.role}] ${typeof m.content === 'string' ? sanitize(m.content) : '[data]'}`).join('\n');
  return runCompressor(`${sanitize(guidelines || COMPRESS_HISTORY)}\n\n${text}`, target);
}

export async function optimizeGuidelines({ failures, currentGuidelines, target }) {
  let feedback = '';
  for (const f of failures || []) {
    try {
      const c = await generateCritique({ failure: { tool: f.tool, error: String(f.error ?? '') }, history: [], attempts: 1, target, config: {} });
      feedback += `Failure: ${f.tool || '?'}\nCritique: ${c.critique || ''}\nApproach: ${c.suggestedApproach || ''}\n\n`;
    } catch {}
  }
  const result = await runCompressor(`Refine compression guidelines based on failure analysis.\n\nAnalysis:\n${sanitize(feedback || 'none')}\n\nCurrent:\n${sanitize(currentGuidelines)}\n\nRefined:`, target);
  return result || currentGuidelines;
}

export async function distillCompressor({ teacherGuidelines, target }) {
  return runCompressor(`Distill these guidelines into concise rules for a smaller model.\n\n${sanitize(teacherGuidelines)}\n\nDistilled:`, target);
}

// ---- F1: Cache alignment / prefix preservation ---------------------------

function msgKey(m) {
  if (!m || typeof m !== 'object') return '';
  return JSON.stringify({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '[data]',
    tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls.map((t) => t?.function?.name ?? '?') : undefined,
  });
}

export class CacheAligner {
  constructor() {
    this._prevKeys = [];
  }

  align(prevMessages, currentMessages) {
    const prev = Array.isArray(prevMessages) ? prevMessages : [];
    const curr = Array.isArray(currentMessages) ? currentMessages : [];
    const prevKeys = prev.map(msgKey);
    const currKeys = curr.map(msgKey);
    let prefixLen = 0;
    const minLen = Math.min(prevKeys.length, currKeys.length);
    while (prefixLen < minLen && prevKeys[prefixLen] === currKeys[prefixLen]) {
      prefixLen++;
    }
    return {
      frozen: curr.slice(0, prefixLen),
      live: curr.slice(prefixLen),
      frozenLen: prefixLen,
    };
  }

  snapshot(messages) {
    this._prevKeys = Array.isArray(messages) ? messages.map(msgKey) : [];
  }
}

// ---- F2: Reversible compression (CCR) ------------------------------------

function shortHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export class ReversibleCache {
  constructor(opts = {}) {
    this._store = new Map();
    this._ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this._persistDir = opts.persistDir ?? null;
    if (this._persistDir) {
      this._load();
    }
  }

  set(id, content) {
    this._store.set(id, { content, expiresAt: Date.now() + this._ttlMs });
    this._persist();
  }

  get(id) {
    const entry = this._store.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(id);
      this._persist();
      return null;
    }
    return entry.content;
  }

  has(id) {
    return this.get(id) !== null;
  }

  compressId(content) {
    const id = shortHash(content) + '-' + Date.now().toString(36);
    this.set(id, String(content));
    return `[headroom:${id}]`;
  }

  retrieve(id) {
    return this.get(id);
  }

  _persist() {
    if (!this._persistDir) return;
    try {
      fs.mkdirSync(this._persistDir, { recursive: true });
      const data = JSON.stringify(Object.fromEntries(this._store));
      fs.writeFileSync(path.join(this._persistDir, 'cache.json'), data, 'utf8');
    } catch {}
  }

  _load() {
    if (!this._persistDir) return;
    try {
      const raw = fs.readFileSync(path.join(this._persistDir, 'cache.json'), 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          this._store.set(k, v);
        }
      }
    } catch {}
  }
}

// ---- F3: Content-type routing -------------------------------------------

function looksLikeJson(s) {
  const t = s.trim();
  if (!t) return false;
  if (t[0] === '{' || t[0] === '[') {
    try {
      JSON.parse(t);
      return true;
    } catch { return false; }
  }
  return false;
}

function looksLikeCode(s) {
  if (looksLikeJson(s)) return true;
  const lines = s.split('\n');
  let codeLines = 0;
  const codePatterns = /\b(function|const|let|var|def|class|import|export|return|if|for|while|async|await|fn|pub|struct|enum|trait|impl|package|from|as|with|yield|lambda|proc|end|do|then)\b/;
  const codeOperators = /[{}();=<>!:&|+^%~@]/;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[{}();]/.test(t) || (codeOperators.test(t) && codePatterns.test(t))) {
      codeLines++;
    }
  }
  const total = lines.length;
  if (total === 0) return false;
  return (codeLines / total) > 0.15;
}

function looksLikeLogs(s) {
  const lines = s.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return false;
  let logLike = 0;
  for (const line of lines) {
    if (/^\d{4}-\d{2}-\d{2}/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line) || /\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b/i.test(line) || /^\[[^\]]+\]/.test(line)) {
      logLike++;
    }
  }
  return (logLike / lines.length) > 0.3;
}

export function routeContent(text) {
  const s = String(text ?? '');
  if (looksLikeJson(s)) return 'json';
  if (looksLikeLogs(s)) return 'logs';
  if (looksLikeCode(s)) return 'code';
  return 'prose';
}

export function deterministicCompress(text) {
  const type = routeContent(text);
  switch (type) {
    case 'json': return compressJson(text);
    case 'code': return compressCode(text);
    case 'logs': return compressLogs(text);
    default: return null;
  }
}

function compressJson(text) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { return null; }
  if (Array.isArray(parsed)) {
    const items = parsed.filter((item) => {
      if (item && typeof item === 'object' && ('error' in item || 'Error' in item)) return true;
      return false;
    });
    if (parsed.length > 0) { items.push(parsed[0]); if (parsed.length > 1) items.push(parsed[parsed.length - 1]); }
    const summary = { __compressed: true, originalType: 'array', itemCount: parsed.length, keptItems: items };
    return JSON.stringify(summary);
  }
  if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    const out = {};
    for (const k of keys) {
      if (/error|Error|ERR|fail|Fail|exception|Exception/i.test(k)) out[k] = parsed[k];
    }
    if (keys.length > 0) { out.__first = parsed[keys[0]]; if (keys.length > 1) out.__last = parsed[keys[keys.length - 1]]; }
    out.__compressed = true;
    out.originalType = 'object';
    out.keyCount = keys.length;
    return JSON.stringify(out);
  }
  return null;
}

function compressCode(text) {
  const s = String(text);
  const lines = s.split('\n');
  const imports = lines.filter((l) => /^\s*(import|from|require|include|use)\b/.test(l));
  const sigs = lines.filter((l) => /^(export\s+)?(async\s+)?function|^\s*(export\s+)?(async\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(|^\s*(export\s+)?(async\s+)?class|^\s*(export\s+)?(async\s+)?def|^\s*(pub|fn|func)\b/.test(l));
  const stats = { lines: lines.length, chars: s.length, imports: imports.length, signatures: sigs.length };
  const out = { __compressed: true, originalType: 'code', stats, imports: imports.slice(0, 20), signatures: sigs.slice(0, 30) };
  return JSON.stringify(out);
}

function compressLogs(text) {
  const s = String(text);
  const lines = s.split('\n').filter((l) => l.trim());
  const counts = {};
  for (const line of lines) {
    const m = /\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b/i.exec(line);
    if (m) {
      const lvl = m[1].toUpperCase();
      counts[lvl] = (counts[lvl] ?? 0) + 1;
    }
  }
  const sample = lines.slice(-5).join('\n');
  const out = { __compressed: true, originalType: 'logs', lineCount: lines.length, levelCounts: counts, tail: sample };
  return JSON.stringify(out);
}

// ---- headroom_retrieve tool ----------------------------------------------

export function headroomRetrieveTool() {
  return {
    name: 'headroom_retrieve',
    description: 'Retrieve the original content for a compressed headroom placeholder. Pass the id from the [headroom:...] placeholder.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The headroom compression id.' } },
      required: ['id'],
    },
  };
}

export async function headroomRetrieveHandler({ id }, reversibleCache) {
  if (!reversibleCache) return { content: 'Reversible cache not available.' };
  const original = reversibleCache.retrieve(String(id));
  if (original === null) return { content: `No cached content found for id ${id} (expired or unknown).` };
  return { content: original };
}

// ---- ContextOptimizer class extensions -----------------------------------

export class ContextOptimizer {
  constructor(guidelines) { this.guidelines = guidelines || COMPRESS_OBSERVATION; this.history = []; }
  async compress(observation, target) { const r = await compressObservation({ observation, guidelines: this.guidelines, target }); this.history.push({ type: 'observation', compressed: r }); return r; }
  async compressHistory(messages, target) { const r = await compressHistory({ messages, guidelines: this.guidelines, target }); this.history.push({ type: 'history', compressed: r }); return r; }
  async optimize(failures, target) { const r = await optimizeGuidelines({ failures, currentGuidelines: this.guidelines, target }); this.guidelines = r; return r; }
  reset() { this.history = []; this.guidelines = COMPRESS_OBSERVATION; }
}

// ---- Integration: apply context optimization before provider call ----------

export function applyContextOptimize(history, prevHistory, config = {}) {
  if (!history || !Array.isArray(history)) return history;
  const aligner = new CacheAligner();
  const ccrEnabled = config.reversibleCache === true || process.env.OX_REVERSIBLE_CACHE === '1';
  let cache = null;
  if (ccrEnabled) {
    const cacheDir = config.cwd ? path.join(config.cwd, '.agent', 'cache') : path.join(os.homedir(), '.ox', 'cache');
    cache = new ReversibleCache({ persistDir: cacheDir, ttlMs: 300000 });
  }

  const { frozen, live } = aligner.align(prevHistory, history);

  const processedLive = live.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    if (typeof msg.content === 'string') {
      const dd = deterministicCompress(msg.content);
      if (dd !== null) {
        if (cache) {
          const placeholder = cache.compressId(msg.content);
          return { ...msg, content: placeholder };
        }
        return { ...msg, content: dd };
      }
    }
    return msg;
  });

  return [...frozen, ...processedLive];
}
