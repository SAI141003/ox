import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// archiveFile (src/memory.js) copies-then-removes through the same credential
// screen every other persistence surface uses, and records the move in the loss
// ledger. Importing it here is the whole reason session transcripts stopped
// being unlink()ed into oblivion. No cycle: memory.js never imports session.js.
import { archiveFile, recordLoss, lossNotice, lossLedgerPath } from './memory.js';
// The persistent goal is an EVENT in this same append-only transcript, not a
// side file, so the goal and the messages are recovered by the SAME read. That
// is the whole point: a parallel store could disagree with the transcript about
// what the session was doing. goal.js imports memory.js only, so this adds no
// cycle.
import { goalFromEvents } from './goal.js';

const sessionsDir = () => path.join(os.homedir(), '.ox', 'sessions');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Incognito (`ox --incognito`, OX_INCOGNITO=1): the transcript lives in a
// private temp folder for this process only and is deleted when ox exits, so
// /rewind and the rest still work while nothing is kept.
let incognitoDir = null;
export function isIncognito(ctx = null) {
  return ctx?.incognito === true || process.env.OX_INCOGNITO === '1';
}
function privateSessionsDir() {
  if (incognitoDir) return incognitoDir;
  incognitoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-incognito-'));
  try { fs.chmodSync(incognitoDir, 0o700); } catch {}
  process.once('exit', () => { try { fs.rmSync(incognitoDir, { recursive: true, force: true }); } catch {} });
  return incognitoDir;
}

export function createSession(cwd, meta = {}) {
  const dir = isIncognito() ? privateSessionsDir() : sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  let id;
  let file;
  let tries = 0;
  do {
    id = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
    file = path.join(dir, `${timestamp()}-${id}.jsonl`);
  } while (fs.existsSync(file) && ++tries < 50);
  const session = { file, id };
  appendEvent(session, { t: 'meta', created: new Date().toISOString(), cwd, ...meta });
  return session;
}

export function appendEvent(session, event) {
  if (!session || typeof session.file !== 'string') {
    throw new Error('ox: appendEvent needs a session object with a file path');
  }
  if (!session._dirEnsured) {
    fs.mkdirSync(path.dirname(session.file), { recursive: true });
    session._dirEnsured = true;
  }
  fs.appendFileSync(session.file, JSON.stringify(event) + '\n');
  return session;
}

// Detailed parse: never throws, reports the first unreadable line instead so
// the caller can choose between degrading loudly (status 'unavailable') and
// aborting (OX_STRICT_READ=1). The stderr warning is byte-identical to the
// one parseLines used to emit.
function parseLinesDetailed(text, file) {
  const lines = text.split('\n');
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      const isTail = i >= lines.length - 2 && !lines.slice(i + 1).some((l) => l.trim());
      process.stderr.write(
        `ox: warning: torn session line in ${file}${isTail ? ' (truncated tail)' : ''}\n`
      );
      return { events, failure: { line: i + 1, isTail, reason: 'unparseable JSON' } };
    }
    if (!ev || typeof ev !== 'object') {
      return { events, failure: { line: i + 1, isTail: false, reason: 'line is not an event object' } };
    }
    events.push(ev);
  }
  return { events, failure: null };
}

function parseLines(text, file) {
  const { events, failure } = parseLinesDetailed(text, file);
  if (!failure) return events;
  if (failure.isTail) return events;
  throw new Error(`ox: corrupt session line ${failure.line} in ${file}`);
}

// Wave5a D: rewind support. Events AFTER the last {t:'rewind'} marker are
// inactive: the marker names a rewind-point id, and the active view ends at
// that rewind-point event. The file itself stays append-only.
function activeEventsOnly(events) {
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.t === 'rewind') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return events;
  const to = events[idx].to;
  let cut = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.t === 'rewind-point' && String(e.id) === String(to)) {
      cut = i;
      break;
    }
  }
  return cut === -1 ? events.slice(0, idx) : events.slice(0, cut + 1);
}

export function loadSession(file) {
  const text = fs.readFileSync(file, 'utf8');
  return activeEventsOnly(parseLines(text, file));
}

// ---- history-load honesty ---------------------------------------------------
// A transcript read can fail: unreadable file, permission denied, malformed
// JSON that is not a simple torn tail, corrupt index. When that happens the
// agent must be able to tell "I have no prior history" apart from "my history
// is unavailable" - otherwise it invents a reason for the gap. So every load
// reports a status next to the events.

export const HISTORY_STATUS = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable',
});

export const HISTORY_UNAVAILABLE_MARKER = '[ox: prior transcript history unavailable]';

// The text the model reads. Deliberately blunt: state the gap, forbid the
// guess, tell it what to do instead.
export function degradedHistoryNotice(reason) {
  const why = String(reason ?? 'read failed').trim();
  return [
    `${HISTORY_UNAVAILABLE_MARKER} this is NOT a new conversation.`,
    'Prior transcript history for this session exists on disk but could NOT be loaded into your context.',
    'Say so plainly. Do NOT guess, invent, or speculate about what the missing turns said or why they are missing.',
    'If the user refers to earlier context (a file, a number, a previous decision), tell them you cannot see prior history and ask them to restate it.',
    `Load failure: ${why}`,
  ].join('\n');
}

// Last outcome of a history load in this process. buildSystemPrompt reads it so
// the notice reaches the model even though agent.js strips system-role entries
// out of the message array. Recorded, never cleared: a load that failed in this
// process is exactly the fact the next prompt needs.
let _historyLoad = null;

export function noteHistoryLoad(record) {
  _historyLoad = record;
  return record;
}

export function lastHistoryLoad() {
  return _historyLoad;
}

// Loud degradation of a load we could not complete. Non-strict: warn on stderr
// and return the events that did parse, fronted by the honesty marker.
// Strict (OX_STRICT_READ=1): abort instead of degrading.
function unavailableHistory(file, messages, reason, strict) {
  const why = String(reason ?? 'read failed').trim();
  if (strict) {
    throw new Error(`ox: session history unavailable in ${file}: ${why} (OX_STRICT_READ=1)`);
  }
  process.stderr.write(`ox: warning: session history unavailable in ${file}: ${why}\n`);
  const notice = degradedHistoryNotice(why);
  return noteHistoryLoad({
    file,
    status: HISTORY_STATUS.UNAVAILABLE,
    reason: why,
    notice,
    // A degraded read saw ZERO events, so no goal was read either. Reporting a
    // goal here would be inventing state the transcript could not confirm.
    goal: null,
    goalTerminal: null,
    messages: [
      { t: 'system', role: 'system', marker: HISTORY_UNAVAILABLE_MARKER, content: notice, degraded: true },
      ...messages,
    ],
  });
}

// Same as noteHistoryLoad but for callers outside this module (the session
// index) that can report a failure without producing events.
export function noteUnavailableHistory(file, reason) {
  return unavailableHistory(file, [], reason, false);
}

function strictHistoryRead() {
  const v = process.env.OX_STRICT_READ;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// loadSession stays array-shaped and throws, so existing callers are untouched.
// This is the status-aware twin: { messages, status, reason, notice, file }.
//   'ok'          - events parsed (same array loadSession would have returned)
//   'empty'       - nothing to replay, and nothing went wrong
//   'unavailable' - the read or parse failed; messages[0] is the honesty marker
export function loadSessionWithStatus(file, { strict = strictHistoryRead() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is a never-started session, not a failure: a fresh run has no file
    // yet, and --resume resolves the path before loading. Every other errno
    // (EACCES, EISDIR, EIO, ...) is a real failure.
    if (err?.code === 'ENOENT') {
      return noteHistoryLoad({ file, status: HISTORY_STATUS.EMPTY, reason: null, notice: '', goal: null, goalTerminal: null, messages: [] });
    }
    return unavailableHistory(file, [], `${err?.code ?? 'read failed'}: ${err?.message ?? err}`, strict);
  }

  const { events, failure } = parseLinesDetailed(text, file);
  const active = activeEventsOnly(events);
  if (!failure) {
    const goal = goalFromEvents(active);
    return noteHistoryLoad({
      file,
      status: active.length ? HISTORY_STATUS.OK : HISTORY_STATUS.EMPTY,
      reason: null,
      notice: '',
      // A goal that was completed (or cleared, or withheld by the read screen)
      // comes back as `terminal` with NO active goal, so it cannot resurrect.
      goal: goal.goal,
      goalTerminal: goal.terminal,
      messages: active,
    });
  }
  // A torn tail over at least one readable event is the documented truncation
  // case (stderr warning, history kept). Zero readable events means the file
  // parsed to nothing - reporting that as 'empty' is the exact lie we are
  // closing, so it degrades instead.
  if (failure.isTail && events.length > 0) {
    const goal = goalFromEvents(active);
    return noteHistoryLoad({
      file,
      status: HISTORY_STATUS.OK,
      reason: null,
      notice: '',
      goal: goal.goal,
      goalTerminal: goal.terminal,
      messages: active,
    });
  }
  const why = failure.isTail
    ? `torn tail at line ${failure.line} and no earlier event was readable`
    : `${failure.reason} at line ${failure.line}`;
  return unavailableHistory(file, active, why, strict);
}

function appendRawEvent(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

// Raw-scan of rewind markers: [{id,label}] in append order.
export function rewindPoints(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.t === 'rewind-point') out.push({ id: ev.id, label: String(ev.label ?? '') });
    } catch {}
  }
  return out;
}

export function nextRewindId(file) {
  const pts = rewindPoints(file);
  return pts.length ? Math.max(...pts.map((p) => Number(p.id) || 0)) + 1 : 1;
}

// Append an append-only rewind marker; conversation-only restore.
export function rewindTo(sessionFile, n) {
  const pts = rewindPoints(sessionFile);
  const hit = pts.find((p) => String(p.id) === String(n));
  if (!hit) {
    throw new Error(
      `ox: no rewind point ${n} in ${path.basename(String(sessionFile))} (available: ${pts.map((p) => p.id).join(', ') || 'none'})`
    );
  }
  appendRawEvent(sessionFile, { t: 'rewind', to: hit.id, label: hit.label, ts: new Date().toISOString() });
  return hit;
}

function peekEvents(file, maxLines = 20) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').slice(0, maxLines);
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return events;
}

export function latestSessionFile(filterCwd) {
  const dir = sessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    // Returning null here used to start a brand-new conversation with no hint
    // that the session store was unreadable - the same lie as an empty history.
    noteUnavailableHistory(dir, `session store unreadable: ${err?.code ?? 'read failed'} ${err?.message ?? err}`);
    return null;
  }
  const wantCwd = filterCwd ? path.resolve(String(filterCwd)) : null;
  let best = null;
  let bestMtime = -1;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      if (wantCwd) {
        const meta = peekEvents(full, 5).find((e) => e?.t === 'meta');
        const metaCwd = meta?.cwd != null ? path.resolve(String(meta.cwd)) : null;
        if (!metaCwd || metaCwd !== wantCwd) continue;
      }
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = full;
      }
    } catch {}
  }
  return best;
}

function firstUserPromptOf(event) {
  if (!event) return null;
  let c = event.content ?? event.message?.content ?? event.text ?? event.prompt ?? null;
  if (Array.isArray(c)) {
    c = c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  }
  return c == null ? null : String(c);
}

export function listSessions(n = 10) {
  const dir = sessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const rows = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let mtime;
    try {
      mtime = fs.statSync(file).mtime.toISOString();
    } catch {
      continue;
    }
    const events = peekEvents(file, 60);
    const meta = events.find((e) => e?.t === 'meta');
    const firstUser = events.find((e) => e?.t === 'user');
    const titleEv = events.find((e) => e?.t === 'title' && e.title);
    const m = f.match(/-([0-9a-f]{6})\.jsonl$/);
    rows.push({
      file,
      id: m ? m[1] : f.replace(/\.jsonl$/, ''),
      mtime,
      cwd: meta?.cwd ?? null,
      firstUserPrompt: firstUserPromptOf(firstUser),
      title: titleEv?.title ?? null,
    });
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return rows.slice(0, Math.max(1, n));
}

function stemId(f) {
  const m = path.basename(String(f)).match(/-([0-9a-f]{6})\.jsonl$/);
  return m ? m[1] : null;
}

export function forkSession(file) {
  const events = loadSession(file);
  const origMeta = events.find((e) => e?.t === 'meta');
  const parentId = origMeta?.id ?? stemId(file) ?? path.basename(file, '.jsonl');
  const session = createSession(origMeta?.cwd ?? process.cwd(), { forkOf: parentId });
  appendEvent(session, { t: 'fork', parent: parentId, source: path.resolve(file) });
  for (const ev of events) appendEvent(session, ev);
  return session;
}

const SEARCHABLE_EVENT_TYPES = new Set(['user', 'assistant', 'tool-result']);

// Raw-history fallback search across ~/.ox/sessions/*.jsonl, newest-first.
// Torn/corrupt lines are skipped silently. Matches are case-insensitive
// substring hits over the JSON of each user/assistant/tool-result event.
export function searchSessions(query, { limit = 50, cwd } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const dir = sessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const wantCwd = cwd ? path.resolve(String(cwd)) : null;
  const cap = Math.max(1, Number(limit) || 50);
  const candidates = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      candidates.push({ full, mtime: fs.statSync(full).mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const needle = q.toLowerCase();
  const rows = [];
  for (const { full, mtime } of candidates) {
    if (rows.length >= cap) break;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    let metaCwd = null;
    const pending = [];
    for (const line of text.split('\n')) {
      if (rows.length + pending.length >= cap) break;
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.t === 'meta') metaCwd = ev.cwd != null ? path.resolve(String(ev.cwd)) : null;
      if (!SEARCHABLE_EVENT_TYPES.has(ev?.t)) continue;
      let hay;
      try {
        hay = JSON.stringify(ev);
      } catch {
        hay = String(ev);
      }
      if (hay.toLowerCase().includes(needle)) pending.push(line.trim().slice(0, 160));
    }
    if (!pending.length) continue;
    if (wantCwd && metaCwd !== wantCwd) continue;
    for (const snippet of pending) {
      if (rows.length >= cap) break;
      rows.push({ file: full, date: new Date(mtime).toISOString(), cwd: metaCwd, snippet });
    }
  }
  return rows.slice(0, cap);
}

// ---- F5 export / redact / prune ---------------------------------------------

export const REDACT_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?-----/g,
  /\b(api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi,
];

export function redactSecrets(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const re of REDACT_PATTERNS) out = out.replace(re, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v);
    return out;
  }
  return value;
}

function summarizeToolCallsForMd(calls) {
  const list = Array.isArray(calls) ? calls : [];
  if (!list.length) return null;
  const parts = list.map((call) => {
    const name = String(call?.function?.name ?? '?');
    let args = '';
    try {
      args = JSON.stringify(JSON.parse(String(call?.function?.arguments ?? '{}')));
    } catch {
      args = String(call?.function?.arguments ?? '');
    }
    return `${name}(${args.slice(0, 120)})`;
  });
  return `[called tools: ${parts.join('; ')}]`;
}

export function renderSessionMarkdown(events, { id } = {}) {
  const meta = events.find((e) => e?.t === 'meta');
  const titleEv = events.find((e) => e?.t === 'title' && e.title);
  const lines = [];
  lines.push(`# ox session ${id ?? '?'}`);
  lines.push('');
  if (meta?.created) lines.push(`- created: ${meta.created}`);
  if (meta?.cwd) lines.push(`- cwd: ${meta.cwd}`);
  if (meta?.bot) lines.push(`- bot: ${meta.bot}`);
  if (titleEv) lines.push(`- title: ${titleEv.title}`);
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.t === 'meta' || ev.t === 'title' || ev.t === 'fork') {
      if (ev.t === 'fork') {
        lines.push('');
        lines.push(`> forked from session ${ev.parent ?? '?'}`);
      }
      continue;
    }
    if (ev.t === 'user') {
      lines.push('');
      lines.push('## user');
      lines.push(typeof ev.text === 'string' ? ev.text : JSON.stringify(ev.content ?? ev.text ?? ''));
      continue;
    }
    if (ev.t === 'assistant') {
      lines.push('');
      lines.push('## assistant');
      if (typeof ev.text === 'string' && ev.text.trim()) lines.push(ev.text);
      const toolsLine = summarizeToolCallsForMd(ev.tool_calls);
      if (toolsLine) lines.push(toolsLine);
      continue;
    }
    if (ev.t === 'tool-result') {
      lines.push('');
      lines.push(`## tool result → ${ev.name ?? '?'}${ev.isError ? ' (error)' : ''}`);
      lines.push(String(ev.content ?? '').slice(0, 400));
      continue;
    }
    lines.push('');
    lines.push(`## ${ev.t ?? 'event'}`);
    let body;
    try {
      body = JSON.stringify(ev);
    } catch {
      body = String(ev);
    }
    lines.push(body.slice(0, 400));
  }
  lines.push('');
  return lines.join('\n');
}

// Build the export payload for a session file. format 'md' renders a readable
// transcript; 'jsonl' re-emits verbatim events. redact applies REDACT_PATTERNS
// to every string in the payload.
export function buildSessionExport(file, { format = 'md', redact = false } = {}) {
  const events = loadSession(file);
  const id = path.basename(String(file)).replace(/\.jsonl$/, '');
  let data;
  if (format === 'jsonl') {
    data = events.map((e) => JSON.stringify(redact ? redactSecrets(e) : e)).join('\n') + '\n';
  } else {
    data = renderSessionMarkdown(events, { id });
    if (redact) data = redactSecrets(data);
  }
  return { data, id, count: events.length };
}

// F5 retention pass over ~/.ox/sessions.
//
// THIS USED TO UNLINK. Transcripts are the substrate episodes and procedural
// reflection are extracted from: anything that only ever existed in a transcript
// died with it, permanently and silently, with no ledger row and no notice.
//
// DEFAULT IS NOW ARCHIVE, NOT DELETE. mode: 'archive' (the default) MOVES each
// aged transcript to ~/.ox/sessions/archive/<iso-stamp>-<name>.jsonl -- copy
// first, remove second, so there is no instant at which the bytes exist nowhere.
// Keeping the archive INSIDE ~/.ox/sessions/ rather than under ~/.ox/archive/ is
// deliberate: src/tools/fs.js lists ~/.ox/sessions as a SENSITIVE_ROOT and blocks
// tool reads/writes anywhere beneath it, so an archived transcript stays
// unreadable by the agent exactly as the live one was. Moving it to a
// non-sensitive path would have quietly widened access to every old session.
//
// mode: 'delete' is the opt-in that restores permanent removal, for an operator
// who genuinely needs the disk back. It is not the default and it is still
// recorded in the loss ledger and announced on stderr, so it can never be silent.
//
// dry-run still only lists.
//
// The 90-day threshold itself is unchanged. Nothing here is silent any more.
export function pruneSessions({ olderThanDays = 90, dryRun = false, now = Date.now(), mode = 'archive' } = {}) {
  const dir = sessionsDir();
  const archiveDir = path.join(dir, 'archive');
  const doDelete = mode === 'delete';
  const empty = {
    scanned: 0,
    deleted: [],
    archived: [],
    kept: [],
    freedBytes: 0,
    archiveBytes: 0,
    dryRun: !!dryRun,
    mode: doDelete ? 'delete' : 'archive',
  };
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return empty;
  }
  const days = Number(olderThanDays);
  const cutoff = now - (Number.isFinite(days) && days >= 0 ? days : 90) * 86_400_000;
  const deleted = [];
  const archived = [];
  const kept = [];
  let freedBytes = 0;
  let archiveBytes = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    if (dryRun) {
      // Kept in `deleted` so the existing CLI report keeps working unchanged;
      // a dry run must not claim anything moved.
      deleted.push(full);
      freedBytes += st.size;
      continue;
    }
    if (doDelete) {
      try {
        fs.unlinkSync(full);
      } catch {
        continue;
      }
      recordLoss({
        store: 'sessions',
        event: 'transcript-deleted',
        action: 'deleted',
        reason: `older-than-${days}d`,
        artifact: full,
        bytes: st.size,
        detail: 'operator-opted-in',
      });
      lossNotice(
        `DELETED ${full} (${st.size} bytes, older than ${days}d) because pruneSessions was called with ` +
          `mode:'delete'. This is the only path that removes a transcript, and it is opt-in. Ledger: ${lossLedgerPath()}`
      );
      deleted.push(full);
      freedBytes += st.size;
      continue;
    }
    const res = archiveFile(full, {
      destDir: archiveDir,
      label: 'archived session transcript',
      // The store is named in the screen's own words: it is the same plaintext
      // transcript, just relocated.
      screenStore: 'the session transcript (~/.ox/sessions)',
      store: 'sessions',
      event: 'transcript-aged',
      reason: `older-than-${days}d`,
    });
    // A transcript the screen refuses to move (credential shape in an old
    // session, most likely) is KEPT where it is, and said so. Deleting it would
    // have been the old behaviour; the honest alternative is to leave it alone
    // and let a human decide.
    if (!res.archived) {
      kept.push(full);
      if (res.reason !== 'unreadable-source') {
        lossNotice(
          `kept ${full} in place instead of archiving it (${res.reason}); it is older than ${days}d ` +
            'and nothing was deleted.'
        );
      }
      continue;
    }
    archived.push(full);
    archiveBytes += res.bytes || st.size;
    // Mirrored into `deleted` so the pre-existing caller (src/cli.js cmdPrune)
    // still counts and lists what it acted on. It is NOT deleted.
    deleted.push(full);
    freedBytes += st.size;
  }
  if (archived.length && !dryRun) {
    lossNotice(
      `ARCHIVED ${archived.length} session transcript(s) older than ${days}d -> ${archiveDir} ` +
        `(nothing deleted; still on disk, still recoverable). Ledger: ${lossLedgerPath()}`
    );
  }
  return {
    scanned: files.length,
    deleted,
    archived,
    kept,
    freedBytes,
    archiveBytes,
    dryRun: !!dryRun,
    mode: doDelete ? 'delete' : 'archive',
  };
}
