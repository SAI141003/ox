// ---- the loss ledger -------------------------------------------------------
//
// The audit that motivated this file: three distinct destruction paths in the
// memory subsystem (the .agent size cap, the checkpoint cap, the per-type
// pattern cap) destroyed data with NO file, NO warning, NO counter and NO audit
// row. A caller could not tell success from failure, and nobody could tell
// afterwards that anything had been lost at all.
//
// So every path that moves, evicts or refuses now writes one row here. The row
// is the ONLY record; the archive file is the payload the row points at.
//
// Design constraints, all deliberate:
//
//   1. APPEND-ONLY, capped JSONL, via audit.js's shared appendJsonlCapped --
//      the same idiom the decision ledger and the sandbox-events ledger use, so
//      there is one place to look and one cap to reason about.
//
//   2. THE ROW SHAPE CANNOT HOLD CONTENT. This is enforced structurally, not by
//      convention: every field is either a short machine token, a count, or a
//      filesystem path, and each is validated before the row is serialised. A
//      free-text field simply does not exist, so there is nothing to leak and
//      nothing to remember to strip. `detail` is the only string that could in
//      principle carry prose, so it is capped at 120 chars, whitespace-
//      collapsed to a single line, and callers only ever put a *pattern class*
//      there (e.g. "a provider API key"), never the matched text.
//
//   3. NEVER THROWS. Auditing must not break the memory subsystem, and a
//      half-written ledger row must never be the reason an episode is lost.
//      Every failure path here returns a value; none of them propagate.
//
//   4. NO IMPORT CYCLE. This module depends only on node builtins plus
//      audit.js/config.js. The ARCHIVE primitives (which must run the
//      credential screen from src/memory.js) deliberately live in memory.js
//      instead and call recordLoss() from here. That is why the split runs this
//      way round and not the other one.
//
// Note the difference from the read-side screen's `memory-screen` rows in
// audit.jsonl: withholding leaves data on disk and hides it from the model,
// which is a visibility decision, not destruction. This ledger records data
// that MOVED or was REFUSED. Neither this file nor the ledger changes what the
// screen does -- its withholding behaviour is untouched and deliberate.

import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlCapped, auditEnabled } from './audit.js';
import { CONFIG_DIR } from './config.js';

export const LOSS_LEDGER_FILE = 'memory-loss.jsonl';

// 5MB is ~40k rows. The ledger is the only evidence that anything was ever
// moved, so it gets a much smaller cap than audit.jsonl: if it is being
// appended to at all, something is already wrong upstream, and 5MB of rows is
// far past the point where a human reads it.
const LEDGER_CAP_BYTES = 5 * 1024 * 1024;

// Every out-of-tree archive root the memory subsystem writes to. One place to
// look. Archives that belong INSIDE a project tree (checkpoints, procedural
// patterns) stay in that tree instead -- see ARCHIVE_NOTE in memory.js.
export const ARCHIVE_ROOT = path.join(CONFIG_DIR, 'archive');

// Machine tokens: no spaces. Anything else is replaced rather than recorded,
// because an unexpected string in these fields is either a bug or an attempt to
// smuggle content into the ledger.
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DETAIL_MAX = 120;
const PATH_MAX = 1024;

const counter = { events: 0, archived: 0, kept: 0, refused: 0, deleted: 0, uniquified: 0 };

export function lossLedgerPath() {
  return path.join(CONFIG_DIR, LOSS_LEDGER_FILE);
}

// In-process tally, for callers that want a number without reading the file.
// Mirrors memoryScreenStats(): a counter AND a ledger row, never one alone.
export function lossStats() {
  return { ...counter };
}

export function resetLossStats() {
  for (const k of Object.keys(counter)) counter[k] = 0;
}

function token(value, fallback = 'unknown') {
  const s = String(value ?? '');
  return TOKEN_RE.test(s) ? s : fallback;
}

// Paths are allowed through with slashes and spaces (they are paths), but they
// are length-bounded and free of newlines and NULs, because a path is the only
// field that legitimately contains structure.
function safePath(value) {
  if (value == null) return null;
  const s = String(value);
  if (!s || s.length > PATH_MAX || /[\r\n\0]/.test(s)) return null;
  return s;
}

function safeDetail(value) {
  if (value == null) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
  return s || undefined;
}

// The single writer. `row` is filtered down to the documented shape; anything
// extra the caller passes is DROPPED, not stored. Returns true when a row was
// appended.
export function recordLoss(row = {}) {
  try {
    if (!auditEnabled()) return false;
    const out = {
      ts: new Date().toISOString(),
      t: 'memory-loss',
      store: token(row.store),
      event: token(row.event),
      action: token(row.action),
      reason: token(row.reason),
      artifact: safePath(row.artifact),
      archive: safePath(row.archive),
    };
    const bytes = Number(row.bytes);
    if (Number.isFinite(bytes) && bytes >= 0) out.bytes = Math.round(bytes);
    const count = Number(row.count);
    if (Number.isFinite(count) && count > 0) out.count = Math.round(count);
    const detail = safeDetail(row.detail);
    if (detail) out.detail = detail;

    counter.events += 1;
    if (out.action === 'archived') counter.archived += 1;
    else if (out.action === 'kept') counter.kept += 1;
    else if (out.action === 'refused') counter.refused += 1;
    else if (out.action === 'deleted') counter.deleted += 1;
    else if (out.action === 'uniquified') counter.uniquified += 1;

    return appendJsonlCapped(lossLedgerPath(), out, LEDGER_CAP_BYTES);
  } catch {
    return false;
  }
}

// Read side. Newest rows last. Malformed lines are skipped rather than thrown:
// a torn tail must not make the whole ledger unreadable.
export function readLossLedger({ limit = 200, file = lossLedgerPath() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && row.t === 'memory-loss') rows.push(row);
    } catch {}
  }
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? rows.slice(-Math.floor(n)) : rows;
}

// Human-readable rendering. There is no CLI surface for this yet (src/cli.js
// belongs to another workstream), so it is exported and exercised by the tests;
// wiring `/memory-loss` is a one-line follow-up on the caller.
export function formatLossReport({ limit = 20, file = lossLedgerPath() } = {}) {
  const rows = readLossLedger({ limit, file });
  if (!rows.length) {
    return (
      `no recorded memory loss (ledger: ${file})\n` +
      'nothing has been archived, evicted or refused by the memory subsystem.'
    );
  }
  const lines = [`memory loss ledger (most recent ${rows.length} rows) -- ${file}`, ''];
  for (const r of rows) {
    const what = r.artifact ? ` ${r.artifact}` : '';
    const where = r.archive ? ` -> ${r.archive}` : '';
    const size = Number.isFinite(r.bytes) ? ` (${r.bytes} bytes)` : '';
    lines.push(`${r.ts}  ${r.store}/${r.event} [${r.action}: ${r.reason}]${what}${where}${size}`);
  }
  return lines.join('\n');
}

// Where an episode goes when .agent/ is already over its size cap. Keyed by the
// project so two repositories never interleave their overflow, and OUTSIDE
// .agent/ so it does not count against the very cap that routed it here.
export function agentOverflowDir(projectKey, kind = 'episodes') {
  return path.join(ARCHIVE_ROOT, 'agent-overflow', token(projectKey), kind);
}

// Stable, short, filesystem-safe identity for a project directory. Derived from
// the RESOLVED path so ../x and ./x land in the same overflow dir.
export function projectKeyFor(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  let hash = 0;
  for (let i = 0; i < resolved.length; i++) {
    hash = (hash * 31 + resolved.charCodeAt(i)) >>> 0;
  }
  return `p${hash.toString(36)}`;
}
