import { constants as fsConstants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { redactSecrets } from '../memory.js';
import { secretMatch } from '../oxignore.js';
import { recordBefore, recordAfter } from '../undo.js';

// A webpage the model just wrote is only visible to the user when something
// opens it. We open .html files in the user's default browser after a
// successful write_file inside the workspace. Honors the same dry-run gate as
// the operator tools so tests never touch the real machine, and OX_NO_AUTO_OPEN
// lets a session opt out.
const AUTO_OPEN_EXTS = new Set(['.html', '.htm']);

function autoOpenCmd(platform, target) {
  if (platform === 'darwin') return ['open', [target]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', target]];
  return ['xdg-open', [target]];
}

function autoOpenAllowed(ctx) {
  if (process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') return false;
  if (process.env.OX_NO_AUTO_OPEN === '1') return false;
  if (ctx?.headless === true) return false;
  return true;
}

function tryAutoOpenHtml(p, ctx) {
  try {
    if (!AUTO_OPEN_EXTS.has(path.extname(p).toLowerCase())) return null;
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd ? path.resolve(ctx.cwd) : null;
    if (!cwd || !withinDir(p, cwd)) return null;
    if (!autoOpenAllowed(ctx)) return null;
    const [cmd, args] = autoOpenCmd(process.platform, p);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return 'opened in your default browser';
  } catch { return null; }
}

const MAX_READ_CHARS = 100_000;
const MAX_LIST_ENTRIES = 500;
const MAX_GLOB_RESULTS = 1_000;
const MAX_GREP_MATCHES = 200;
const MAX_DIFF_CHARS = 8_000;
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.ox-backups']);

// ---------------------------------------------------------------------------
// G4 post-edit syntax advisory: cheap, best-effort checker for files mutated
// by write_file/edit_file. Advisory only — never flips isError.
// ---------------------------------------------------------------------------
const LINT_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.py', '.sh']);
const LINT_TIMEOUT_MS = 3_000;
const PY_AST_CHECK = 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())';

function lintDetail(out) {
  const lines = String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  const detail = lines.join(' ; ') || 'checker reported failure';
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

function execChecker(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: LINT_TIMEOUT_MS, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        resolve({ err, out: `${stdout ?? ''}${stderr ?? ''}` });
      });
    } catch (e) {
      resolve({ err: e, out: '' });
    }
  });
}

async function checkerFailure(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(await fsp.readFile(p, 'utf8'));
      return null;
    } catch (e) {
      return lintDetail(String(e?.message ?? e));
    }
  }
  let r;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') r = await execChecker(process.execPath, ['--check', p]);
  else if (ext === '.py') r = await execChecker('python3', ['-c', PY_AST_CHECK, p]);
  else r = await execChecker('bash', ['-n', p]);
  if (!r.err) return null;
  if (r.err.code === 'ENOENT') return null; // checker not installed — stay silent
  if (r.err.killed) return 'checker timed out';
  return lintDetail(r.out.trim() || String(r.err.message ?? r.err));
}

// Returns the result untouched unless the file fails its cheap syntax check,
// in which case an advisory line is appended and meta.lintFail is set.
async function withSyntaxAdvisory(result, p, ctx) {
  try {
    if (!result || result.isError) return result;
    if (process.env.OX_NO_LINT === '1') return result;
    if (!LINT_EXTS.has(path.extname(p).toLowerCase())) return result;
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd ? path.resolve(ctx.cwd) : null;
    if (!cwd || !withinDir(p, cwd)) return result;
    const failMsg = await checkerFailure(p);
    if (!failMsg) return result;
    return {
      ...result,
      content: `${result.content}\n[syntax check FAILED: ${failMsg}]`,
      meta: { ...(result.meta ?? {}), lintFail: true },
    };
  } catch {
    return result;
  }
}

function err(message) {
  return { content: message, isError: true };
}

function ok(content) {
  return { content };
}

// The path a mutating tool ACTUALLY wrote, in the shape both the tool-end event
// and the subagent's filesTouched accumulator read.
//
// It is attached on SUCCESS PATHS ONLY. A declined approval, a hook denial, and
// a failed write all touch nothing, and a `filesTouched` that lists a file the
// tree does not reflect is worse than an empty one: it is replayed into the
// resume prompt by filesTouchedBlock and reported to the parent as work done.
// The path is displayPath()'d (workspace-relative) so a subagent that wrote
// src/a.js and one that wrote /abs/src/a.js produce the same list.
//
// This is the whole fix for the documented empty-accumulator defect: the field
// was read in subagent.js and written by nothing. `bash` is deliberately NOT
// guessed at here -- a shell command can touch anything, and the honest source
// for that is a tree diff, not the tool call's arguments.
function touched(result, p, ctx) {
  // The run's list of files it changed: the security check reads it (agent.js).
  try { ctx?.writtenFiles?.add?.(p); } catch {}
  recordAfter(p, ctx); // what the turn left, so /undo notices later edits (src/undo.js)
  return { ...result, filesTouched: [displayPath(p, ctx)] };
}

function withinDir(child, ancestor) {
  const rel = path.relative(path.resolve(ancestor).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOrNull(p) {
  return fsp.realpath(p).catch(() => null);
}

// ---------------------------------------------------------------------------
// Path DISPLAY for tool output only.
//
// Every tool result used to lead with the absolute realpath of the workspace.
// Those characters land in the conversation history and are re-sent on every
// later turn, so a 99-char prefix times 11 grep matches times 18 re-sends is
// thousands of tokens of a path the model already knows: cwd is in the
// ENVIRONMENT block of its system prompt.
//
// Rules, in order:
//   INSIDE  the cwd  -> relative (".", or "src/a.js"). Same information, fewer
//                       bytes, no ambiguity.
//   OUTSIDE the cwd  -> absolute. Here the relative form ("../..") would be
//                       genuinely LESS information than the path itself.
//   no cwd in ctx    -> absolute. Nothing to be relative to; the tools are also
//                       used headless with no workspace at all.
//
// CALL SITES now take the same relative form back in — see resolvePathArg().
// The two halves are deliberately consistent: the model is shown `src/cart.js`
// and may hand exactly that string straight back without a failed turn.
// ---------------------------------------------------------------------------
export function displayPath(p, ctx) {
  const abs = String(p ?? '');
  const cwd = typeof ctx?.cwd === 'string' && ctx.cwd ? path.resolve(ctx.cwd) : null;
  if (!cwd || !abs) return abs;
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  return rel.split(path.sep).join('/');
}

async function deepestExistingReal(p) {
  let cur = path.resolve(p);
  for (;;) {
    const real = await realpathOrNull(cur);
    if (real) return real;
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

const SENSITIVE_ROOTS = () => {
  const home = os.homedir();
  return [path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.ox', 'sessions')];
};

function sensitiveHits(p) {
  if (process.env.OX_ALLOW_SENSITIVE_READS === '1') return null;
  const resolved = path.resolve(p);
  for (const root of SENSITIVE_ROOTS()) {
    if (withinDir(resolved, root)) return root;
  }
  return null;
}

function sensitiveReadError(p, root, tool) {
  return err(
    `${tool}: refusing to access '${p}' — it falls under the sensitive directory ${root}. Set OX_ALLOW_SENSITIVE_READS=1 to override.`
  );
}

// Project secrets (src/oxignore.js): .env, keys, credential files and whatever
// the project's .oxignore names. Contents are never read, written or searched.
function secretError(p, ctx, tool) {
  const hit = secretMatch(p, ctx?.cwd);
  if (!hit) return null;
  return err(`${tool}: '${displayPath(p, ctx)}' looks like a secret (matches "${hit}"), so ox keeps out of it. To allow it, add "!${path.basename(p)}" to .oxignore in the project, or set OX_ALLOW_SECRET_READS=1 for one run.`);
}

function walkSkipsSensitive(absDir) {
  if (process.env.OX_ALLOW_SENSITIVE_READS === '1') return false;
  return SENSITIVE_ROOTS().some((root) => withinDir(absDir, root));
}

function backupStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

export function backupsRootFor(ctx, filePath) {
  const base = typeof ctx?.cwd === 'string' && ctx.cwd ? path.resolve(ctx.cwd) : path.dirname(path.resolve(filePath));
  return path.join(base, '.ox-backups');
}

async function backupTreeSize(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await backupTreeSize(full);
      else if (e.isFile()) total += (await fsp.stat(full)).size;
    } catch {}
  }
  return total;
}

// Keep .ox-backups under maxBytes by deleting oldest timestamp dirs first.
export async function pruneBackups(cwd, maxBytes = MAX_BACKUP_BYTES) {
  const root = path.join(path.resolve(cwd ?? process.cwd()), '.ox-backups');
  let names;
  try {
    names = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return 0;
  }
  const sized = [];
  let total = 0;
  for (const name of names.sort()) {
    const full = path.join(root, name);
    const size = await backupTreeSize(full);
    total += size;
    sized.push({ name, full, size });
  }
  let deleted = 0;
  for (const entry of sized) {
    if (total <= maxBytes) break;
    try {
      await fsp.rm(entry.full, { recursive: true, force: true });
      total -= entry.size;
      deleted++;
    } catch {}
  }
  return deleted;
}

// Copy an existing file into <cwd>/.ox-backups/<yyyymmdd-HHMMSS>/<rel> before
// it is mutated. Silent best-effort: returns the dest path or null.
async function backupExistingFile(p, ctx) {
  if (process.env.OX_NO_BACKUPS === '1') return null;
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const root = backupsRootFor(ctx, p);
  let rel = path.relative(path.dirname(root), p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(p);
  for (let attempt = 0; attempt < 10; attempt++) {
    const stamp = attempt === 0 ? backupStamp() : `${backupStamp()}-${attempt + 1}`;
    const dest = path.join(root, stamp, rel);
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(p, dest, fsConstants.COPYFILE_EXCL);
      await pruneBackups(path.dirname(root));
      return dest;
    } catch (e) {
      if (e?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool INPUT path resolution.
//
// Tool OUTPUT already relativizes inside the workspace (see displayPath), so
// the model was being *shown* `src/cart.js` and then *rejected* when it sent the
// same string back — a pure internal inconsistency that burned a whole turn of
// re-sent context and bought no safety.
//
// This is a resolution step, not a relaxation. A relative argument is resolved
// against the workspace cwd FIRST, producing an absolute path, and EVERY
// existing guard then runs on that resolved absolute path exactly as it does for
// an absolute argument — so a relative path and its absolute twin always get the
// same verdict:
//
//   src/cart.js      -> <cwd>/src/cart.js    (ordinary read/write/edit)
//   .git/config      -> <cwd>/.git/config    (write_file/edit_file refuse it via
//                                             gitCheck. read_file does NOT — its
//                                             only gates are ~/.ssh, ~/.aws and
//                                             ~/.ox/sessions)
//   src/../.git/x    -> <cwd>/.git/x          (same as the line above)
//   ../../etc/passwd -> /etc/passwd           (same verdict as '/etc/passwd')
//   ~/x              -> rejected              ('~' is still never expanded)
//
// There is deliberately no "it looked relative, so it is probably inside"
// branch. A path that resolves outside the cwd is handled exactly as the
// absolute path outside the cwd always was, and displayPath still prints those
// absolute.
// ---------------------------------------------------------------------------
function resolvePathArg(raw, tool, ctx) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: err(`${tool}: 'path' is required.`) };
  }
  // A leading '~' is the one shape we refuse to guess at. Expanding it here would
  // turn `~/x` into a literal <cwd>/~/x directory, and `~root/x` into a literal
  // <cwd>/~root/x — a silent write to somewhere the caller did not name. Every
  // leading-~ form was already refused before (it was not absolute), so this
  // keeps the old outcome rather than adding a new allowance. Leading './' noise
  // is stripped first so './~/x' is judged as '~/x' and not as an ordinary
  // relative path.
  if (raw.replace(/^(?:\.[\\/])+/, '').startsWith('~')) {
    return {
      error: err(
        `${tool}: '${raw}' is not expanded — pass the full path starting with '/'.`
      ),
    };
  }
  // Same fallback the rest of the codebase uses (subagent.js, checkTrust):
  // ctx.cwd when the caller supplied a workspace, else the process cwd.
  const base = typeof ctx?.cwd === 'string' && ctx.cwd ? path.resolve(ctx.cwd) : process.cwd();
  return { path: path.resolve(base, raw) };
}

function gitCheck(p, tool) {
  const resolved = path.resolve(p);
  if (resolved.split(path.sep).map((seg) => seg.toLowerCase()).includes('.git')) {
    return err(`${tool}: refusing to touch '${p}' — paths inside .git/ are off-limits.`);
  }
  return null;
}

function findAll(haystack, needle) {
  if (!needle) return [];
  const hits = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    hits.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return hits;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}

function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function normalizeMapped(text) {
  const chars = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\r' && text[i + 1] === '\n') {
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      let j = i;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      const next = text[j];
      if (next !== '\n' && next !== '\r' && next !== undefined) {
        chars.push(' ');
        map.push([i, j]);
      }
      i = j;
      continue;
    }
    chars.push(c);
    map.push([i, i + 1]);
    i++;
  }
  return map.length === chars.length ? { norm: chars.join(''), map } : { norm: chars.join(''), map: null };
}

function normalizePlain(text) {
  return normalizeMapped(text).norm;
}

export async function readFileTool(args = {}, ctx = {}) {
  const { path: p, error: badPath } = resolvePathArg(args.path, 'read_file', ctx);
  if (badPath) return badPath;
  // Sensitive-dir guard runs on the RESOLVED path: sensitiveHits() resolves
  // against process.cwd(), which is not necessarily the workspace cwd, so
  // handing it the raw argument could let a relative path miss the check.
  const sens = sensitiveHits(p);
  if (sens) return sensitiveReadError(p, sens, 'read_file');
  const secret = secretError(p, ctx, 'read_file');
  if (secret) return secret;
  let raw;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (e) {
    return err(`read_file: cannot read ${p} — ${e?.code === 'ENOENT' ? 'file not found' : e?.message ?? e}`);
  }
  const allLines = splitLines(raw);
  const totalLines = allLines.length;
  const offset = Math.max(1, Math.trunc(Number(args.offset)) || 1);
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : totalLines;
  const slice = allLines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join('\n');
  let head = `${displayPath(p, ctx)} · totalLines=${totalLines}`;
  if (offset > 1 || slice.length < totalLines) {
    head += ` · showing lines ${offset}-${offset - 1 + slice.length}`;
  }
  head += '\n';
  if (body.length > MAX_READ_CHARS) {
    body = body.slice(0, MAX_READ_CHARS) + '\n[truncated] — output capped at 100,000 characters';
  } else if (head.length + body.length > MAX_READ_CHARS) {
    body = body.slice(0, MAX_READ_CHARS - head.length) + '\n[truncated] — output capped at 100,000 characters';
  }
  // Credentials are replaced by [REDACTED: ...] so a key in .env never reaches the model.
  const red = redactSecrets(body);
  if (red.count) body = `${red.text}\n[ox: ${red.count} credential(s) redacted; the file on disk is unchanged]`;
  return ok(head + body);
}

function diffLinesOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 1_200_000) {
    const ops = [];
    for (const l of a) ops.push({ t: '-', l });
    for (const l of b) ops.push({ t: '+', l });
    return ops;
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', l: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: '-', l: a[i] });
      i++;
    } else {
      ops.push({ t: '+', l: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', l: a[i++] });
  while (j < m) ops.push({ t: '+', l: b[j++] });
  return ops;
}

function unifiedDiff(oldText, newText, label) {
  if (oldText === newText) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLinesOps(a, b);
  const C = 3;
  const changed = [];
  ops.forEach((op, i) => {
    if (op.t !== ' ') changed.push(i);
  });
  if (!changed.length) return '';
  const ranges = [];
  let s = changed[0];
  let prev = changed[0];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - prev <= 2 * C) {
      prev = changed[k];
    } else {
      ranges.push([s, prev]);
      s = prev = changed[k];
    }
  }
  ranges.push([s, prev]);
  const aNo = new Array(ops.length);
  const bNo = new Array(ops.length);
  let ai = 1;
  let bi = 1;
  for (let k = 0; k < ops.length; k++) {
    aNo[k] = ai;
    bNo[k] = bi;
    if (ops[k].t !== '+') ai++;
    if (ops[k].t !== '-') bi++;
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  let size = out.join('\n').length;
  let truncated = false;
  for (const [cs, ce] of ranges) {
    const start = Math.max(0, cs - C);
    const end = Math.min(ops.length - 1, ce + C);
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k].t !== '+') aCount++;
      if (ops[k].t !== '-') bCount++;
    }
    out.push(`@@ -${aNo[start]},${aCount} +${bNo[start]},${bCount} @@`);
    size += 2;
    for (let k = start; k <= end; k++) {
      const line = ops[k].t + ops[k].l;
      if (size > MAX_DIFF_CHARS) {
        truncated = true;
        break;
      }
      out.push(line);
      size += line.length + 1;
    }
    if (truncated) break;
  }
  let text = out.join('\n');
  if (truncated) text += `\n[diff truncated at ${MAX_DIFF_CHARS} characters]`;
  return text;
}

async function pathKind(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

async function creationOutsideWorkspaceGate(p, ctx, content) {
  const wsReal = typeof ctx.cwd === 'string' && ctx.cwd ? await realpathOrNull(ctx.cwd) : null;
  if (!wsReal) return null;
  const anchor = await deepestExistingReal(p);
  if (withinDir(anchor, wsReal)) return null;
  if (typeof ctx.requestApproval !== 'function') {
    return err(`write_file: refusing to create ${p} — it resolves outside the workspace (${anchor}).`);
  }
  let verdict = null;
  try {
    verdict = await ctx.requestApproval(
      'write_file',
      { path: p, content },
      `create ${p} — OUTSIDE the workspace (resolves through ${anchor})`
    );
  } catch {}
  if (verdict !== true) {
    return err(`write_file: creation of ${p} outside the workspace (${anchor}) was declined.`);
  }
  return null;
}

export async function writeFileTool(args = {}, ctx = {}) {
  const { path: p, error: badPath } = resolvePathArg(args.path, 'write_file', ctx);
  if (badPath) return badPath;
  const badGit = gitCheck(p, 'write_file');
  if (badGit) return badGit;
  const secret = secretError(p, ctx, 'write_file');
  if (secret) return secret;
  if (typeof args.content !== 'string') {
    return err("write_file: 'content' must be a string.");
  }
  const content = args.content;
  let existed = true;
  let previous = null;
  try {
    const kind = await pathKind(p);
    if (kind === 'dir') return err(`write_file: ${p} is a directory.`);
    previous = await fsp.readFile(p, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') existed = false;
    else return err(`write_file: cannot read existing file — ${e?.message ?? e}`);
  }
  if (!existed) {
    const gate = await creationOutsideWorkspaceGate(p, ctx, content);
    if (gate) return gate;
  }
  const diff = previous === null ? '' : unifiedDiff(previous, content, displayPath(p, ctx));
  const gated =
    existed && !ctx.yolo && ctx.approval !== 'accept-edits' && typeof ctx.requestApproval === 'function';
  if (gated) {
    const detail = diff
      ? `overwrite ${p} (+${content.length}, -${previous.length} chars)\n${diff.slice(0, 600)}`
      : `create ${p}`;
    let verdict = null;
    try {
      verdict = await ctx.requestApproval('write_file', { path: p, content }, detail);
    } catch {}
    if (verdict !== true) {
      return { content: 'User declined write.', isError: true };
    }
  }
  try {
    if (existed && previous !== null) await backupExistingFile(p, ctx);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    recordBefore(p, ctx); await fsp.writeFile(p, content, 'utf8');
  } catch (e) {
    return err(`write_file: failed to write ${p} — ${e?.message ?? e}`);
  }
  const verb = existed ? 'Wrote' : 'Created';
  const openedNote = tryAutoOpenHtml(p, ctx);
  const summaryBase = `${verb} ${displayPath(p, ctx)} (${Buffer.byteLength(content, 'utf8')} bytes)`;
  const summary = openedNote ? `${summaryBase} — ${openedNote}` : summaryBase;
  return withSyntaxAdvisory(touched(ok(diff.trim() ? `${summary}\n${diff}` : summary), p, ctx), p, ctx);
}

export async function editFileTool(args = {}, ctx = {}) {
  const { path: p, error: badPath } = resolvePathArg(args.path, 'edit_file', ctx);
  if (badPath) return badPath;
  const badGit = gitCheck(p, 'edit_file');
  if (badGit) return badGit;
  const secret = secretError(p, ctx, 'edit_file');
  if (secret) return secret;
  const oldString = args.old_string;
  const newString = args.new_string ?? '';
  if (typeof oldString !== 'string' || oldString === '') {
    return err("edit_file: 'old_string' is required and must be a non-empty string.");
  }
  if (typeof newString !== 'string') {
    return err("edit_file: 'new_string' must be a string.");
  }
  const replaceAll = args.replace_all === true;
  let src;
  try {
    src = await fsp.readFile(p, 'utf8');
  } catch (e) {
    return err(
      `edit_file: cannot read ${p} — ${e?.code === 'ENOENT' ? 'file not found' : e?.message ?? e}`
    );
  }
  let backedUp = false;
  const ensureBackup = async () => {
    if (!backedUp) {
      backedUp = true;
      await backupExistingFile(p, ctx);
    }
  };
  const exactHits = findAll(src, oldString);
  if (exactHits.length > 1 && !replaceAll) {
    const lines = exactHits.map((i) => lineOf(src, i)).join(', ');
    return err(
      `edit_file: old_string matches ${exactHits.length} times in ${p} (lines ${lines}). Add more surrounding context so it is unique, or pass replace_all:true.`
    );
  }
  if (exactHits.length >= 1) {
    const updated = exactHits.reduceRight(
      (acc, i) => acc.slice(0, i) + newString + acc.slice(i + oldString.length),
      src
    );
    try {
      await ensureBackup();
      recordBefore(p, ctx); await fsp.writeFile(p, updated, 'utf8');
    } catch (e) {
      return err(`edit_file: failed to write ${p} — ${e?.message ?? e}`);
    }
    const diff = unifiedDiff(src, updated, displayPath(p, ctx));
    return withSyntaxAdvisory(
      touched(
        ok(`Edited ${displayPath(p, ctx)}: replaced ${exactHits.length} occurrence(s) exactly.${diff.trim() ? `\n${diff}` : ''}`),
        p,
        ctx
      ),
      p,
      ctx
    );
  }
  const { norm, map } = normalizeMapped(src);
  const normOld = normalizePlain(oldString);
  if (!normOld) {
    return err('edit_file: old_string contains only whitespace and cannot be located.');
  }
  const fuzzyHits = findAll(norm, normOld);
  if (!fuzzyHits.length) {
    return err(
      `edit_file: old_string not found in ${p} (even after whitespace-normalizing). Re-read the file with read_file and retry with the exact current text.`
    );
  }
  if (fuzzyHits.length > 1 && !replaceAll) {
    const lines = fuzzyHits.map((i) => (map ? lineOf(src, map[i][0]) : '?')).join(', ');
    return err(
      `edit_file: old_string matches ${fuzzyHits.length} times in ${p} after whitespace-normalization (lines ${lines}). Add surrounding context or pass replace_all:true.`
    );
  }
  if (!map) {
    let updatedNorm = norm;
    const sorted = [...fuzzyHits].sort((x, y) => y - x);
    for (const h of sorted) {
      updatedNorm = updatedNorm.slice(0, h) + newString + updatedNorm.slice(h + normOld.length);
    }
    try {
      await ensureBackup();
      recordBefore(p, ctx); await fsp.writeFile(p, updatedNorm, 'utf8');
    } catch (e) {
      return err(`edit_file: failed to write ${p} — ${e?.message ?? e}`);
    }
    return withSyntaxAdvisory(
      touched(
        {
          content: `Edited ${displayPath(p, ctx)}: replaced ${fuzzyHits.length} occurrence(s) via fuzzy match on fully normalized text.`,
          meta: { fuzzy: true },
        },
        p,
        ctx
      ),
      p,
      ctx
    );
  }
  let updated = '';
  let last = 0;
  for (const h of fuzzyHits) {
    const start = map[h][0];
    const end = map[h + normOld.length - 1][1];
    updated += src.slice(last, start) + newString;
    last = end;
  }
  updated += src.slice(last);
  try {
    await ensureBackup();
    recordBefore(p, ctx); await fsp.writeFile(p, updated, 'utf8');
  } catch (e) {
    return err(`edit_file: failed to write ${p} — ${e?.message ?? e}`);
  }
  const diff = unifiedDiff(src, updated, displayPath(p, ctx));
  return withSyntaxAdvisory(
    touched(
      {
        content: `Edited ${displayPath(p, ctx)}: replaced ${fuzzyHits.length} occurrence(s) via whitespace-fuzzy match.${diff.trim() ? `\n${diff}` : ''}`,
        meta: { fuzzy: true },
      },
      p,
      ctx
    ),
    p,
    ctx
  );
}

async function walkEntries(root, rel, depth, maxDepth, out, cap) {
  if (depth >= maxDepth || out.length >= cap) return;
  const dirAbs = rel ? path.join(root, rel) : root;
  if (walkSkipsSensitive(dirAbs)) return;
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((x, y) => {
    if (x.isDirectory() !== y.isDirectory()) return x.isDirectory() ? -1 : 1;
    return x.name.localeCompare(y.name);
  });
  for (const e of entries) {
    if (out.length >= cap) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const childAbs = path.join(root, childRel);
      if (walkSkipsSensitive(childAbs)) continue;
    }
    out.push({ rel: childRel, dir: e.isDirectory(), depth });
    if (e.isDirectory()) {
      await walkEntries(root, childRel, depth + 1, maxDepth, out, cap);
    }
  }
}

export async function listDirTool(args = {}, ctx = {}) {
  const baseRaw = args.path ?? ctx.cwd;
  if (baseRaw == null || baseRaw === '') {
    return err("list_dir: provide a 'path' (no cwd available).");
  }
  const { path: base, error: badPath } = resolvePathArg(baseRaw, 'list_dir', ctx);
  if (badPath) return badPath;
  const baseSens = sensitiveHits(base);
  if (baseSens) return sensitiveReadError(base, baseSens, 'list_dir');
  const kind = await pathKind(base);
  if (kind === null) return err(`list_dir: ${base} does not exist.`);
  if (kind !== 'dir') return err(`list_dir: ${base} is not a directory.`);
  const depthRaw = Number(args.depth);
  const maxDepth = Number.isFinite(depthRaw) && depthRaw >= 0 ? Math.trunc(depthRaw) : 2;
  const entries = [];
  await walkEntries(base, '', 0, maxDepth, entries, MAX_LIST_ENTRIES + 1);
  const capped = entries.length > MAX_LIST_ENTRIES;
  const shown = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = [`${displayPath(base, ctx)}/`];
  for (const e of shown) {
    lines.push(`${'  '.repeat(e.depth)}${e.rel.split('/').pop()}${e.dir ? '/' : ''}`);
  }
  if (capped) {
    lines.push(`… [capped at ${MAX_LIST_ENTRIES} entries]`);
  }
  return ok(lines.join('\n'));
}

function globToRegex(glob) {
  function parse(s) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '*') {
        if (s[i + 1] === '*') {
          while (s[i + 1] === '*') i++;
          if (s[i + 1] === '/') {
            i++;
            out += '(?:[^/]*/)*';
          } else {
            out += '.*';
          }
        } else {
          out += '[^/]*';
        }
      } else if (ch === '?') {
        out += '[^/]';
      } else if (ch === '{') {
        let depth = 1;
        let j = i + 1;
        let body = '';
        while (j < s.length && depth > 0) {
          if (s[j] === '{') depth++;
          else if (s[j] === '}') {
            depth--;
            if (depth === 0) break;
          }
          body += s[j];
          j++;
        }
        if (depth !== 0) return null;
        const parts = [];
        let cur = '';
        let d = 0;
        for (const c of body) {
          if (c === '{') d++;
          else if (c === '}') d--;
          if (c === ',' && d === 0) {
            parts.push(cur);
            cur = '';
          } else {
            cur += c;
          }
        }
        parts.push(cur);
        const inner = parts.map((p) => parse(p));
        if (inner.some((x) => x === null)) return null;
        out += '(?:' + inner.join('|') + ')';
        i = j;
      } else {
        out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
      }
      i++;
    }
    return out;
  }
  const body = parse(glob);
  if (body === null) throw new Error('unbalanced {} in pattern');
  return new RegExp('^' + body + '$');
}

export async function globTool(args = {}, ctx = {}) {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern.trim()) {
    return err("glob: 'pattern' is required (supports **, *, ?, {a,b}).");
  }
  const baseRaw = args.path ?? ctx.cwd;
  if (baseRaw == null || baseRaw === '') {
    return err("glob: provide a 'path' (no cwd available).");
  }
  const { path: base, error: badPath } = resolvePathArg(baseRaw, 'glob', ctx);
  if (badPath) return badPath;
  const baseSens = sensitiveHits(base);
  if (baseSens) return sensitiveReadError(base, baseSens, 'glob');
  const kind = await pathKind(base);
  if (kind === null) return err(`glob: ${base} does not exist.`);
  let re;
  try {
    re = globToRegex(pattern);
  } catch (e) {
    return err(`glob: invalid pattern '${pattern}' — ${e?.message ?? e}`);
  }
  const results = [];
  const walk = async (rel) => {
    if (results.length > MAX_GLOB_RESULTS) return;
    const dirAbs = rel ? path.join(base, rel) : base;
    if (walkSkipsSensitive(dirAbs)) return;
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length > MAX_GLOB_RESULTS) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && walkSkipsSensitive(path.join(base, childRel))) continue;
      if (re.test(childRel)) results.push(childRel);
      if (e.isDirectory()) await walk(childRel);
    }
  };
  await walk('');
  results.sort((x, y) => x.localeCompare(y));
  const capped = results.length > MAX_GLOB_RESULTS;
  const shown = results.slice(0, MAX_GLOB_RESULTS).map((r) => displayPath(path.join(base, r), ctx));
  let text = shown.join('\n');
  if (!shown.length) text = `No matches for '${pattern}' under ${displayPath(base, ctx)}.`;
  if (capped) text += `\n… [capped at ${MAX_GLOB_RESULTS} results]`;
  return ok(text);
}

async function looksBinary(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return true;
  }
  try {
    const buf = Buffer.alloc(800);
    const { bytesRead } = await fh.read(buf, 0, 800, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await fh.close();
  }
}

async function collectFiles(root, isRootFile) {
  if (isRootFile) return [''];
  const files = [];
  const walk = async (rel) => {
    const dirAbs = rel ? path.join(root, rel) : root;
    if (walkSkipsSensitive(dirAbs)) return;
    let entries;
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (walkSkipsSensitive(path.join(root, childRel))) continue;
        await walk(childRel);
      } else files.push(childRel);
    }
  };
  await walk('');
  files.sort((x, y) => x.localeCompare(y));
  return files;
}

export async function grepTool(args = {}, ctx = {}) {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) {
    return err("grep: 'pattern' (regular expression) is required.");
  }
  let re;
  try {
    re = new RegExp(pattern, args.ignoreCase ? 'i' : '');
  } catch (e) {
    return err(`grep: invalid regular expression — ${e?.message ?? e}`);
  }
  const baseRaw = args.path ?? ctx.cwd;
  if (baseRaw == null || baseRaw === '') {
    return err("grep: provide a 'path' (no cwd available).");
  }
  const { path: base, error: badPath } = resolvePathArg(baseRaw, 'grep', ctx);
  if (badPath) return badPath;
  const baseSens = sensitiveHits(base);
  if (baseSens) return sensitiveReadError(base, baseSens, 'grep');
  const kind = await pathKind(base);
  if (kind === null) return err(`grep: ${base} does not exist.`);
  const include = typeof args.include === 'string' && args.include !== '*' ? args.include : null;
  let incRe = null;
  if (include) {
    try {
      incRe = globToRegex(include);
    } catch {
      return err(`grep: invalid include glob '${include}'.`);
    }
  }
  const files = await collectFiles(base, kind === 'file');
  const matches = [];
  let truncated = false;
  for (const rel of files) {
    if (matches.length >= MAX_GREP_MATCHES) {
      truncated = true;
      break;
    }
    const abs = rel ? path.join(base, rel) : base;
    const name = path.basename(abs);
    if (incRe) {
      const target = include.includes('/') ? rel : name;
      if (!incRe.test(target)) continue;
    }
    if (secretMatch(abs, ctx?.cwd)) continue; // secrets are never searched
    if (await looksBinary(abs)) continue;
    let text;
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push(`${displayPath(abs, ctx)}:${i + 1}:${lines[i].replace(/\r$/, '').slice(0, 200)}`);
        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true;
          break;
        }
      }
    }
  }
  if (!matches.length) return ok(`No matches for /${pattern}/ under ${displayPath(base, ctx)}.`);
  let text = matches.join('\n');
  if (truncated) text += `\n… [capped at ${MAX_GREP_MATCHES} matches — results truncated]`;
  const red = redactSecrets(text);
  return ok(red.count ? `${red.text}\n[ox: ${red.count} credential(s) redacted]` : text);
}
