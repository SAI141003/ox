// One undo for files and chat: every turn's file changes are recorded before
// they happen (the previous content, or "did not exist"), so /undo puts back
// exactly what the last turn changed and the chat drops that exchange.
//
//   <project>/.ox-backups/undo/<turn>/journal.jsonl   one line per change
//   <project>/.ox-backups/undo/<turn>/<n>             the previous content
//
// A file is recorded once per turn (its state before the turn's first change),
// so several edits in one turn undo together. Undoing a file that was changed
// again after the turn (by you or another run) is refused for that file, never
// overwritten: the turn's own result is compared before anything is put back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = (cwd) => path.join(path.resolve(cwd), '.ox-backups', 'undo');
const safeTurn = (t) => String(t ?? '').replace(/[^\w.-]/g, '').slice(0, 64);
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const KEEP_TURNS = 30;

export const newTurnId = () => `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;

/** Before a tool changes `file` in turn ctx.turnId: keep what was there. */
export function recordBefore(file, ctx = {}) {
  const turn = safeTurn(ctx.turnId);
  const cwd = ctx.cwd;
  if (!turn || !cwd || process.env.OX_NO_UNDO === '1') return;
  try {
    const abs = path.resolve(file);
    const dir = path.join(DIR(cwd), turn);
    const journal = path.join(dir, 'journal.jsonl');
    const seen = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    if (seen.some((e) => e.path === abs)) return; // its state before the turn is already kept
    fs.mkdirSync(dir, { recursive: true });
    let entry;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const copy = path.join(dir, String(seen.length + 1));
      fs.copyFileSync(abs, copy);
      entry = { path: abs, existed: true, copy: path.basename(copy) };
    } else entry = { path: abs, existed: false };
    fs.appendFileSync(journal, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
    if (seen.length === 0) prune(cwd);
  } catch { /* best effort: a failed record never blocks the change */ }
}

/** After the change: what the turn left, so a later edit by someone else is noticed on undo. */
export function recordAfter(file, ctx = {}) {
  const turn = safeTurn(ctx.turnId);
  if (!turn || !ctx.cwd || process.env.OX_NO_UNDO === '1') return;
  try {
    const abs = path.resolve(file);
    const journal = path.join(DIR(ctx.cwd), turn, 'journal.jsonl');
    const lines = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const e = lines.find((x) => x.path === abs);
    if (!e) return;
    e.after = fs.existsSync(abs) ? hash(fs.readFileSync(abs)) : null;
    fs.writeFileSync(journal, `${lines.map((x) => JSON.stringify(x)).join('\n')}\n`);
  } catch {}
}

function prune(cwd) {
  try {
    const turns = fs.readdirSync(DIR(cwd)).filter((t) => !t.startsWith('.')).sort();
    for (const t of turns.slice(0, Math.max(0, turns.length - KEEP_TURNS))) fs.rmSync(path.join(DIR(cwd), t), { recursive: true, force: true });
  } catch {}
}

/** Turns that changed files and can still be undone, newest first. */
export function undoableTurns(cwd) {
  let turns = [];
  try { turns = fs.readdirSync(DIR(cwd)).filter((t) => fs.existsSync(path.join(DIR(cwd), t, 'journal.jsonl')) && !fs.existsSync(path.join(DIR(cwd), t, 'undone'))).sort().reverse(); } catch {}
  // A journal that cannot be read (a file iCloud has moved off this Mac times
  // out with ETIMEDOUT) is left out instead of failing every undo here.
  return turns.flatMap((t) => {
    try {
      const lines = fs.readFileSync(path.join(DIR(cwd), t, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return [{ turn: t, files: lines.map((e) => path.relative(path.resolve(cwd), e.path) || e.path), at: lines[0]?.at ?? 0 }];
    } catch { return []; }
  });
}

/**
 * Put back what a turn changed (default: the newest). → { turn, restored, removed, skipped }
 * skipped: files changed again since the turn (left as they are, with why).
 */
export function undoTurn(cwd, turn = null) {
  const t = turn ? safeTurn(turn) : undoableTurns(cwd)[0]?.turn;
  if (!t) return { turn: null, restored: [], removed: [], skipped: [], none: true };
  const dir = path.join(DIR(cwd), t);
  if (fs.existsSync(path.join(dir, 'undone'))) return { turn: t, restored: [], removed: [], skipped: [], already: true };
  const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rel = (p) => path.relative(path.resolve(cwd), p) || p;
  const out = { turn: t, restored: [], removed: [], skipped: [] };
  for (const e of lines.reverse()) {
    let now;
    try { now = fs.existsSync(e.path) ? hash(fs.readFileSync(e.path)) : null; }
    catch (err) { out.skipped.push({ file: rel(e.path), why: err?.code === 'ETIMEDOUT' ? 'not on this Mac right now (iCloud did not download it)' : `could not be read (${err?.code ?? err?.message})` }); continue; }
    if (e.after !== undefined && now !== e.after) { out.skipped.push({ file: rel(e.path), why: 'changed again since that turn' }); continue; }
    if (e.existed) {
      fs.mkdirSync(path.dirname(e.path), { recursive: true });
      fs.copyFileSync(path.join(dir, e.copy), e.path);
      out.restored.push(rel(e.path));
    } else if (now !== null) {
      fs.rmSync(e.path, { force: true });
      out.removed.push(rel(e.path));
    }
  }
  fs.writeFileSync(path.join(dir, 'undone'), String(Date.now()));
  return out;
}

/** One line for people: what /undo did. */
export function describe(r) {
  if (r.none) return 'nothing to undo: no turn changed files here';
  if (r.already) return 'that turn was already undone';
  const parts = [];
  if (r.restored.length) parts.push(`restored ${r.restored.join(', ')}`);
  if (r.removed.length) parts.push(`removed ${r.removed.join(', ')} (made by that turn)`);
  if (r.skipped.length) parts.push(`left ${r.skipped.map((s) => s.file).join(', ')} (changed again since)`);
  return parts.join('; ') || 'that turn changed nothing that is still there';
}
