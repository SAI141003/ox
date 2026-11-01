import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { keychainUsable } from './keychain-ok.js';
import { CONFIG_DIR } from './config.js';

const CAP_BYTES = 20 * 1024 * 1024;
let seq = 0;
const permsEnsured = new Set();

export function auditEnabled() {
  // Tests write their own sandbox's log, never your real one (it held test files' names).
  if (process.env.NODE_TEST_CONTEXT && !process.env.OX_HOME && !process.env.OX_AUDIT_FILE) return false;
  return process.env.OX_AUDIT !== '0';
}

export function auditFilePath() {
  return path.join(CONFIG_DIR, 'audit.jsonl');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function pruneOldestLines(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const keep = lines.slice(Math.ceil(lines.length / 2));
  try {
    fs.writeFileSync(file, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
  } catch {}
}

// Shared capped JSONL appender (decision ledger + sandbox-events ledger).
// Never throws: auditing must not break execution.
// ---- tamper evidence ---------------------------------------------------------
// Every audit row carries `prev` (the hash of the row before it) and `h` (its own
// hash over prev and its content), so editing, inserting or deleting any row in the
// middle breaks the chain at that row. The newest hash is also kept in the macOS
// Keychain, so cutting rows off the end is caught too. `ox doctor` checks both.
const canonical = (row) => JSON.stringify(row, Object.keys(row).filter((k) => k !== 'h').sort());
export const rowHash = (row) => sha256(`${row.prev ?? ''}|${canonical(row)}`);

function lastLineHash(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return '';
    const len = Math.min(size, 16384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) { try { const r = JSON.parse(lines[i]); return r.h ?? sha256(lines[i]); } catch {} }
    return '';
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Several ox processes write this log: a short lock keeps the chain one line long.
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + 500;
  let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true }); } catch {}
      if (Date.now() > until) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} try { fs.rmSync(lock, { force: true }); } catch {} } }
}

let anchoredAt = 0;
// One Keychain entry per log file: a second log (another home, a test) never overwrites yours.
const anchorName = (file = auditFilePath()) => `ox-audit-head-${sha256(path.resolve(file)).slice(0, 12)}`;
function anchor(h, count) {
  // The newest hash, in the Keychain, at most every 30 s (a call to `security` is ~20 ms).
  if (!keychainUsable() || Date.now() - anchoredAt < 30_000) return;
  anchoredAt = Date.now();
  try { spawnSync('security', ['add-generic-password', '-U', '-s', anchorName(), '-a', 'ox', '-w', `${h}`], { stdio: 'ignore', timeout: 3000 }); } catch {}
}

/** Walk the chain. → { ok, entries, brokenAt (1-based line), why, anchored } */
export function verifyAudit(file = auditFilePath()) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: true, entries: 0, note: 'no audit log yet' }; }
  const lines = text.split('\n').filter((l) => l.trim());
  let prev = null, chained = 0, last = '';
  for (let i = 0; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { return { ok: false, entries: lines.length, brokenAt: i + 1, why: 'a line is not readable' }; }
    if (!r.h) { prev = null; continue; }            // rows written before the chain existed
    if (prev !== null && r.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1, why: 'a row was removed or inserted before this one' };
    if (rowHash(r) !== r.h) return { ok: false, entries: lines.length, brokenAt: i + 1, why: 'this row was edited' };
    prev = r.h; last = r.h; chained++;
  }
  let anchored = null;
  if (keychainUsable() && chained) {
    const k = spawnSync('security', ['find-generic-password', '-s', anchorName(file), '-a', 'ox', '-w'], { encoding: 'utf8', timeout: 3000 });
    const head = String(k.stdout ?? '').trim();
    if (k.status === 0 && head) {
      // The Keychain may lag the file by up to 30 s of new rows; it must still be IN the chain.
      anchored = lines.some((l) => l.includes(`"h":"${head}"`));
      if (!anchored) return { ok: false, entries: lines.length, chained, why: 'rows were cut off the end of the log (its last known entry is gone)' };
    }
  }
  return { ok: true, entries: lines.length, chained, anchored, head: last };
}

export function appendJsonlCapped(file, row, capBytes = CAP_BYTES, { mode = 0o600 } = {}) {
  if (file === auditFilePath()) {
    return withLock(file, () => {
      const prev = lastLineHash(file);
      const chained = { ...row, prev };
      chained.h = rowHash(chained);
      const ok = appendRaw(file, chained, capBytes, mode);
      if (ok) anchor(chained.h);
      return ok;
    });
  }
  return appendRaw(file, row, capBytes, mode);
}

function appendRaw(file, row, capBytes, mode) {
  let line;
  try {
    line = JSON.stringify(row) + '\n';
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!permsEnsured.has(file)) {
      try {
        fs.chmodSync(file, mode);
      } catch {}
      permsEnsured.add(file);
    }
    try {
      const st = fs.statSync(file);
      if (st.size + Buffer.byteLength(line) > capBytes) pruneOldestLines(file);
    } catch {}
    fs.appendFileSync(file, line, { mode });
    return true;
  } catch {
    return false;
  }
}

// OpenBot decide→record→act: one row BEFORE execution naming the decision,
// the triggering rule (when gated), and who decided. Returns a ref used by
// recordOutcome to link the post-execution row.
export function recordDecision(entry = {}) {
  if (!auditEnabled()) return null;
  const ref = `d-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let argsSha;
  try {
    argsSha = sha256(JSON.stringify(entry.args ?? {}));
  } catch {
    argsSha = sha256(String(entry.args ?? ''));
  }
  const row = {
    ts: new Date().toISOString(),
    ref,
    session: entry.session ?? null,
    tool: String(entry.tool ?? '?'),
    argsSha256: argsSha,
    detail: String(entry.detail ?? '').slice(0, 120),
    decision: entry.decision === 'deny' ? 'deny' : 'allow',
    // Which org agent made the call (ox org's timeline), when one did.
    ...(process.env.OX_ORG_AGENT ? { agent: String(process.env.OX_ORG_AGENT).slice(0, 40) } : {}),
    ...(entry.rule ? { rule: String(entry.rule).slice(0, 120) } : {}),
    actor: ['policy', 'approval', 'sandbox', 'readonly-classifier'].includes(entry.actor)
      ? entry.actor
      : 'policy',
  };
  appendJsonlCapped(auditFilePath(), row, CAP_BYTES);
  return ref;
}

// Second row AFTER execution; error carries a short snippet only.
export function recordOutcome({ ref, ok, error } = {}) {
  if (!auditEnabled() || !ref) return null;
  const row = {
    ts: new Date().toISOString(),
    ref: String(ref),
    t: 'outcome',
    ok: ok === true,
    // Only a failure's message: a success's output (file listings, file text) is not kept here.
    ...(error && ok !== true ? { error: String(error).slice(0, 200) } : {}),
  };
  appendJsonlCapped(auditFilePath(), row, CAP_BYTES);
  return row.ts;
}
