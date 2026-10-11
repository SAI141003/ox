// Cross-session procedural memory: captures patterns of what worked and what
// didn't from past sessions, organized by task type. When a new session
// starts, the most relevant patterns are surfaced as context for the model.
//
// This is the playbook's "Level 1: Better Memory" — episodic recall with
// procedural extraction. Storage: .agent/procedural.md (plain markdown, ~1KB).
//
// Format:
//   # Procedural memory
//
//   ## code (12 successful, 3 failed)
//
//   - ✓ [2026-09-04] When fixing test failures, read the test FIRST
//   - ✗ [2026-09-03] Don't use `await` in for-loops for sequential file ops
//
// The function never throws; bad input returns safe defaults.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// Same persistence screen as .agent/MEMORY.md, imported rather than copied: the
// pattern tables stay the single source of truth in src/memory.js. This module
// is a whole parallel memory store with its own file, and formatProceduralContext
// feeds it into the system prompt (src/system-prompt.js), so it leaks exactly
// like the main index did. There is no import cycle -- src/memory.js only pulls in
// node builtins plus src/audit.js, which never reaches this file.
// persistArchived lives in memory.js because it runs screenPersistText on the
// archived bytes -- an archive is still a persistence surface, and the same
// pattern tables must judge it. Importing it here (rather than duplicating the
// screen) keeps one source of truth; there is no import cycle, since memory.js
// never reaches this file.
import {
  screenPersistText,
  screenReadLines,
  shortWithheldNotice,
  persistArchived,
  lossNotice,
  lossLedgerPath,
} from './memory.js';

const PROCEDURAL_FILE = 'procedural.md';
const PROCEDURAL_STORE = `.agent/${PROCEDURAL_FILE}`;
// Exported so the loss tests can assert against the real cap rather than a copy
// of the number: if this moves, the proofs must move with it.
export const MAX_PATTERNS_PER_TYPE = 20;
const RECENCY_BOOST = { week: 2.0, month: 1.5, old: 1.0 };

function err(reason) {
  return { recorded: false, reason };
}

function ok(count, extra = {}) {
  return { recorded: true, count, evicted: 0, archive: null, ...extra };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function memoryPath(cwd) {
  return path.join(cwd || process.cwd(), '.agent', PROCEDURAL_FILE);
}

function readFile(cwd) {
  try {
    const p = memoryPath(cwd);
    if (!fs.existsSync(p)) return { exists: false, lines: [] };
    return { exists: true, lines: fs.readFileSync(p, 'utf8').split('\n') };
  } catch {
    return { exists: false, lines: [] };
  }
}

function writeFile(cwd, content) {
  try {
    const dir = path.join(cwd || process.cwd(), '.agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryPath(cwd), content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Parse the markdown into a structure: { [taskType]: { success: N, failed: N, patterns: [...] } }
function parseProcedural(content) {
  const result = {};
  const lines = content.split('\n');
  let currentType = null;
  let currentStats = null;
  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(\S+)\s+\((\d+)\s+successful,\s+(\d+)\s+failed\)/);
    if (headerMatch) {
      currentType = headerMatch[1];
      const success = parseInt(headerMatch[2], 10);
      const failed = parseInt(headerMatch[3], 10);
      currentStats = { success, failed };
      result[currentType] = { success, failed, patterns: [] };
      continue;
    }
    if (!currentType) continue;
    const patternMatch = line.match(/^-\s+([✓✗])\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/);
    if (patternMatch) {
      result[currentType].patterns.push({
        success: patternMatch[1] === '✓',
        date: patternMatch[2],
        text: patternMatch[3].trim(),
      });
    }
  }
  return result;
}

// Serialize the structure back to markdown.
function serializeProcedural(data) {
  const lines = ['# Procedural memory', ''];
  const types = Object.keys(data).sort();
  for (const t of types) {
    const { success, failed, patterns } = data[t];
    lines.push(`## ${t} (${success} successful, ${failed} failed)`);
    lines.push('');
    // Sort by date desc (most recent first)
    const sorted = [...patterns].sort((a, b) => b.date.localeCompare(a.date));
    for (const p of sorted) {
      const mark = p.success ? '✓' : '✗';
      lines.push(`- ${mark} [${p.date}] ${p.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Record a pattern. Deduplicates by exact text within the same task type.
export function recordPattern({ cwd, taskType, pattern, success }) {
  if (typeof taskType !== 'string' || !taskType.trim()) return err('taskType required');
  if (typeof pattern !== 'string' || !pattern.trim()) return err('pattern required');
  const data = parseProcedural(readFile(cwd).lines.join('\n'));
  if (!data[taskType]) {
    data[taskType] = { success: 0, failed: 0, patterns: [] };
  }
  const entry = data[taskType];
  const text = pattern.trim();
  // Write screen, same one .agent/MEMORY.md runs. These patterns are extracted by
  // reflect() (src/self-improve.js) from a model pass over a past session's
  // transcript, and every stored pattern is replayed into the system prompt on
  // every later turn by formatProceduralContext -- so a credential that appeared
  // in that transcript would be captured and then re-injected forever. Refused
  // before parse/serialize, so nothing is written and the file is untouched.
  const blocked = screenPersistText(text, 'pattern', PROCEDURAL_STORE);
  if (blocked) return err(blocked);
  // Deduplicate: if exact text already exists, skip
  if (entry.patterns.some((p) => p.text === text)) {
    return ok(entry.success + entry.failed);
  }
  if (success) entry.success++;
  else entry.failed++;
  entry.patterns.push({ success: !!success, date: today(), text });

  // ---- cap patterns per type: ARCHIVE, never silently evict ---------------
  // This used to splice the oldest MAX_PATTERNS_PER_TYPE straight out of the
  // array and decrement the counters, with no warning, no archive and no
  // counter anywhere: a 21st pattern made the first one unrecoverable, and
  // nothing recorded that it had happened.
  //
  // Now the overflow is written to .agent/archive/procedural/<taskType>.md
  // FIRST, and only actually dropped if that write succeeded. If the archive
  // write is refused -- most plausibly because the stored text has credential
  // shape, which the screen will not let reach a second path -- the patterns
  // are KEPT and the file simply keeps more than MAX_PATTERNS_PER_TYPE lines.
  // The cap is a prompt-token budget, not a retention decision, so keeping the
  // data is always the right failure mode. The over-cap store is still bounded
  // by how many patterns a user records, not by a silent discard.
  const evicted = [];
  const overflow = entry.patterns.length - MAX_PATTERNS_PER_TYPE;
  let archive = null;
  if (overflow > 0) {
    const stale = entry.patterns.slice(0, overflow);
    const body = [
      `# Archived procedural patterns (${taskType})`,
      '',
      `- archived: ${new Date().toISOString()}`,
      `- reason: more than ${MAX_PATTERNS_PER_TYPE} patterns recorded for task type '${taskType}'`,
      '',
      ...stale.map((d) => `- ${d.success ? '\u2713' : '\u2717'} [${d.date}] ${d.text}`),
      '',
    ].join('\n');
    const res = persistArchived(body, {
      destDir: path.join(cwd || process.cwd(), '.agent', 'archive', 'procedural'),
      name: `${safeName(taskType)}.md`,
      label: 'archived procedural pattern',
      screenStore: PROCEDURAL_STORE,
      store: 'procedural',
      event: 'pattern-evicted',
      reason: `over-${MAX_PATTERNS_PER_TYPE}-per-type`,
      detail: `taskType=${taskType}`,
    });
    if (res.archived) {
      archive = res.path;
      evicted.push(...stale);
      entry.patterns.splice(0, stale.length);
      for (const d of stale) {
        if (d.success) entry.success--;
        else entry.failed--;
      }
    } else {
      lossNotice(
        `kept ${stale.length} pattern(s) for '${taskType}' in place instead of archiving them (${res.reason}); ` +
          `procedural.md now exceeds the ${MAX_PATTERNS_PER_TYPE}-per-type cap and nothing was evicted.`
      );
    }
  }
  if (evicted.length) {
    lossNotice(
      `archived ${evicted.length} pattern(s) past the ${MAX_PATTERNS_PER_TYPE}-per-type cap -> ${archive} ` +
        `(nothing destroyed). Ledger: ${lossLedgerPath()}`
    );
  }
  const written = writeFile(cwd, serializeProcedural(data));
  if (!written) return err('write failed');
  return ok(entry.success + entry.failed, { evicted: evicted.length, archive });
}

// A taskType is caller-supplied and becomes a FILENAME, so it gets the same
// treatment an episode goal gets: never a path separator, never a dotfile.
function safeName(value) {
  const s = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60);
  return s || 'task-type';
}

// Recall patterns relevant to a task. Returns scored and sorted patterns.
export function recallPatterns({ cwd, taskType, limit = 5 } = {}) {
  const data = parseProcedural(readFile(cwd).lines.join('\n'));
  const now = new Date();
  const ms = {
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };
  const score = (p) => {
    const age = now - new Date(p.date);
    if (age <= ms.week) return RECENCY_BOOST.week;
    if (age <= ms.month) return RECENCY_BOOST.month;
    return RECENCY_BOOST.old;
  };
  const all = [];
  for (const [t, entry] of Object.entries(data)) {
    if (taskType && t !== taskType) continue;
    for (const p of entry.patterns) {
      all.push({ type: p.success ? 'success' : 'failure', text: p.text, date: p.date, taskType: t, weight: score(p) });
    }
  }
  // Sort by weight desc, then date desc
  all.sort((a, b) => b.weight - a.weight || b.date.localeCompare(a.date));
  return all.slice(0, limit);
}

// Format patterns as a context block for the system prompt.
//
// READ-SIDE screen, same contract as loadMemoryBlock(): the write screen only
// protects patterns recorded after it shipped, and .agent/procedural.md is a
// plain markdown file a user (or an older build) can edit by hand. A failing
// pattern is withheld from the block, never echoed, and the file on disk is NOT
// rewritten. The notice is the SHORT variant because this block is appended to
// the system prompt on every turn.
//
// recallPatterns over-fetches (REFILL_FACTOR) and the visible list is truncated
// back to maxLines AFTER screening, so a withheld pattern does not shrink the
// block. For a clean store the over-fetch + truncate is identical to the old
// single limit, so the rendered prompt stays byte-identical.
const REFILL_FACTOR = 3;

export function formatProceduralContext({ cwd, taskType, maxLines = 10 } = {}) {
  const data = parseProcedural(readFile(cwd).lines.join('\n'));
  if (!Object.keys(data).length) return '';
  const candidates = recallPatterns({ cwd, taskType, limit: maxLines * REFILL_FACTOR });
  if (!candidates.length) return '';
  const { kept, withheld } = screenReadLines(
    candidates.map((p) => p.text),
    PROCEDURAL_STORE,
    'procedural context block'
  );
  // Every recalled pattern failed. Returning '' would make system-prompt.js skip
  // the block entirely, which is exactly the silent drop the screen forbids.
  if (!kept.length) return withheld ? shortWithheldNotice(withheld) : '';
  const patterns = candidates.filter((p) => kept.includes(p.text)).slice(0, maxLines);
  const lines = [`[procedural memory — ${patterns.length} pattern(s) from past sessions]`];
  // Group by taskType for readability
  const byType = {};
  for (const p of patterns) {
    if (!byType[p.taskType]) byType[p.taskType] = [];
    byType[p.taskType].push(p);
  }
  for (const [t, list] of Object.entries(byType)) {
    // The per-type success/failed tallies are HISTORICAL counters for the task
    // type, not a count of what is on screen, so they are read from the store and
    // never recomputed from the visible list (recomputing would change clean
    // output, because the tallies cover patterns outside the top-N selection).
    const entry = data[t];
    const total = entry.success + entry.failed;
    lines.push(`${t}: ${entry.success} successful, ${entry.failed} failed (${total} total)`);
    for (const p of list) {
      const mark = p.type === 'success' ? '✓' : '✗';
      lines.push(`  ${mark} ${p.text}`);
    }
  }
  if (withheld) lines.push(shortWithheldNotice(withheld));
  return lines.join('\n');
}

// Get statistics.
export function proceduralStats({ cwd } = {}) {
  const data = parseProcedural(readFile(cwd).lines.join('\n'));
  const stats = { types: {}, totalPatterns: 0 };
  for (const [t, entry] of Object.entries(data)) {
    stats.types[t] = { success: entry.success, failed: entry.failed };
    stats.totalPatterns += entry.patterns.length;
  }
  return stats;
}

// Auto-detect task type from tool usage in the session.
// Returns the most common tool category.
export function detectTaskType(toolNames = []) {
  const counts = {};
  for (const name of toolNames) {
    if (name === 'read_file' || name === 'grep' || name === 'glob' || name === 'list_dir') {
      counts.research = (counts.research || 0) + 1;
    } else if (name === 'edit_file' || name === 'write_file') {
      counts.code = (counts.code || 0) + 1;
    } else if (name === 'bash') {
      counts.bash = (counts.bash || 0) + 1;
    } else if (name === 'todo_write') {
      counts.planning = (counts.planning || 0) + 1;
    }
  }
  let best = 'general';
  let bestCount = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}
