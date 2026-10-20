import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';

const CAP_BYTES = 20 * 1024 * 1024;
let seq = 0;
const permsEnsured = new Set();

export function auditEnabled() {
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
export function appendJsonlCapped(file, row, capBytes = CAP_BYTES, { mode = 0o600 } = {}) {
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
    ...(error ? { error: String(error).slice(0, 200) } : {}),
  };
  appendJsonlCapped(auditFilePath(), row, CAP_BYTES);
  return row.ts;
}
