import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MEMORY_SCHEMA_VERSION = '1.0.0';
const MEMORY_TYPES = new Set(['fact', 'preference', 'pattern', 'skill', 'conversation']);

function memoryFile() {
  return join(homedir(), '.ox', 'memory', 'memory.jsonl');
}

// Sibling of memory.jsonl, holding only bookkeeping about the store itself.
// It exists because `/mem` (src/cli.js:4853) prints `stats.lastConsolidated`,
// a field that has never existed on this store's stats shape -- the command
// printed the literal string "undefined". Rather than edit cli.js (owned by
// another workstream) the fact is recorded here, where consolidation happens,
// so the printed value becomes real instead of fabricated.
function metaFile() {
  return join(homedir(), '.ox', 'memory', 'memory.meta.json');
}

function readMeta(file = metaFile()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMeta(patch, file = metaFile()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const next = { ...readMeta(file), ...patch };
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temp, file);
    return next;
  } catch {
    return null;
  }
}

function words(value) {
  return String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function readEntries(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return MEMORY_TYPES.has(entry.type) && entry.content ? [entry] : [];
    } catch {
      return [];
    }
  });
}

function writeEntries(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  renameSync(temp, file);
}

function normalizeEntry(entry = {}) {
  if (!MEMORY_TYPES.has(entry.type)) throw new Error(`Unsupported memory type: ${entry.type}`);
  if (!String(entry.content ?? '').trim()) throw new Error('Memory content is required');
  const confidence = Math.max(0, Math.min(1, Number(entry.confidence ?? 0.5)));
  return {
    id: entry.id || randomUUID(),
    type: entry.type,
    content: String(entry.content).trim(),
    timestamp: Number(entry.timestamp) || Date.now(),
    source: String(entry.source || 'manual'),
    confidence: Number(confidence.toFixed(4)),
  };
}

function similarity(left, right) {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / (a.size + b.size - intersection);
}

function fitTokens(value, maxTokens) {
  const tokens = String(value).trim().split(/\s+/).filter(Boolean);
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0));
  return limit && tokens.length > limit ? `${tokens.slice(0, limit).join(' ')}…` : tokens.join(' ');
}

// Stable flag name callers pass to createModelRouter().route(task, context)
// alongside a memoryStore to enable the memory→routing bridge.
createMemoryStore.preferredBotFromMemory = 'preferredBotFromMemory';
export function createMemoryStore(cwd = process.cwd()) {
  const file = memoryFile();
  const store = {
    cwd,
    file,
    entries: [],
    add(entry) {
      const normalized = normalizeEntry(entry);
      const index = store.entries.findIndex((item) => item.id === normalized.id);
      if (index === -1) store.entries.push(normalized);
      else store.entries[index] = normalized;
      return { ...normalized };
    },
    search(query) {
      return searchMemory(store, query);
    },
    consolidate() {
      return consolidateMemory(store);
    },
    summarize(maxTokens = 500) {
      return summarizeMemory(store, maxTokens);
    },
    save() {
      writeEntries(file, store.entries);
      return stats(store, file);
    },
    load() {
      store.entries = readEntries(file);
      return store.entries.length;
    },
    stats() {
      return stats(store, file);
    },
  };
  store.load();
  return store;
}

createMemoryStore.preferredBotFromMemory = 'preferredBotFromMemory';

export function searchMemory(store, query = '') {
  const queryTerms = [...new Set(words(query))];
  if (!queryTerms.length) return [];
  const documentFrequency = new Map();
  for (const entry of store.entries) {
    const found = new Set(words(`${entry.content} ${entry.source}`));
    for (const term of found) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  return store.entries
    .map((entry) => {
      const text = `${entry.type} ${entry.content} ${entry.source}`.toLowerCase();
      let score = entry.confidence * 0.15;
      for (const term of queryTerms) {
        const count = words(text).filter((word) => word === term).length;
        if (!count) continue;
        const idf = Math.log(1 + store.entries.length / (1 + (documentFrequency.get(term) ?? 0)));
        score += (1 + Math.log(count)) * idf;
      }
      return score > entry.confidence * 0.15 ? { ...entry, score: Number(score.toFixed(6)) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
}

export function consolidateMemory(store) {
  const kept = [];
  let merged = 0;
  for (const incoming of store.entries) {
    const match = kept.find((entry) => entry.type === incoming.type && (
      similarity(entry.content, incoming.content) >= 0.62 ||
      entry.content.includes(incoming.content) ||
      incoming.content.includes(entry.content)
    ));
    if (!match) {
      kept.push({ ...incoming });
      continue;
    }
    merged += 1;
    match.content = match.content.includes(incoming.content)
      ? match.content
      : incoming.content.includes(match.content)
        ? incoming.content
        : `${match.content} ${incoming.content}`;
    match.timestamp = Math.max(match.timestamp, incoming.timestamp);
    match.confidence = Math.min(1, Number((Math.max(match.confidence, incoming.confidence) + 0.05).toFixed(4)));
  }
  let decayed = 0;
  const now = Date.now();
  for (const entry of kept) {
    const ageDays = Math.max(0, (now - entry.timestamp) / 86400000);
    if (ageDays > 30 && entry.confidence < 0.75) {
      const reduction = Math.min(0.25, ageDays / 365);
      entry.confidence = Number(Math.max(0, entry.confidence - reduction).toFixed(4));
      decayed += 1;
    }
  }
  store.entries = kept;
  store.save();
  // Stamped so `/mem` can report a real "last consolidated" instead of
  // undefined. Written AFTER save() so a failed save cannot claim a
  // consolidation that did not land.
  const lastConsolidatedAt = new Date().toISOString();
  writeMeta({ lastConsolidatedAt });
  return { merged, decayed, kept: kept.length, lastConsolidatedAt };
}

export function summarizeMemory(store, maxTokens = 500) {
  const groups = new Map();
  for (const entry of [...store.entries].sort((a, b) => b.confidence - a.confidence || b.timestamp - a.timestamp)) {
    const lines = groups.get(entry.type) ?? [];
    lines.push(entry.content);
    groups.set(entry.type, lines.slice(0, 5));
  }
  const summary = [...groups].map(([type, lines]) => `${type}: ${lines.join(' | ')}`).join('\n');
  return fitTokens(summary, maxTokens);
}

export function autoCreateSkill(store, task, solution, opts = {}) {
  if (opts.verified !== true) {
    throw new Error('autoCreateSkill requires an explicit verified=true option; unverified solutions must not be promoted');
  }
  if (!String(task ?? '').trim() || !String(solution ?? '').trim()) throw new Error('Task and solution are required');
  const name = String(task).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'skill';
  const directory = join(homedir(), '.agents', 'skills', name);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'SKILL.md');
  const description = `Reusable procedure for ${name}`;
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${task}\n\n## Reusable procedure\n\n${solution}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
  const entry = store.add({ type: 'skill', content: `${task}: ${solution}`, source: file, confidence: 0.8 });
  store.save();
  return { name, file, entry };
}

function stats(store, file = store.file) {
  const byType = Object.fromEntries([...MEMORY_TYPES].map((type) => [type, 0]));
  let confidence = 0;
  for (const entry of store.entries) {
    byType[entry.type] += 1;
    confidence += entry.confidence;
  }
  const base = {
    totalEntries: store.entries.length,
    byType,
    averageConfidence: store.entries.length ? confidence / store.entries.length : 0,
    indexSize: existsSync(file) ? statSync(file).size : 0,
  };
  // The two keys `/mem` actually reads (src/cli.js:4851 and :4853). Both were
  // missing from this shape, so the command printed "undefined" twice:
  //   stats.entries            -> an alias of totalEntries
  //   stats.lastConsolidated   -> the stamp consolidateMemory() now writes,
  //                               or null, which `/mem` renders as "never"
  // Fields are ADDED, not renamed, so every existing caller of stats() (src/
  // platform.js:626, test/integration.test.js) is byte-identical.
  return {
    ...base,
    entries: base.totalEntries,
    lastConsolidated: readMeta().lastConsolidatedAt ?? null,
  };
}
