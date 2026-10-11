// HEARTBEATS AND SCHEDULES — unattended work that runs INSIDE the daemon.
//
// Prime Agent's shape: `/heartbeat`, `rlm_heartbeat`, and `prime-agent schedule`
// re-enter a session periodically or at a time. This module is where that lives,
// and every one of its decisions is made here rather than in the supervisor, the
// CLI, or the worker, so `ox schedule list`, `/schedule list` and the daemon's own
// log can never disagree about the same instant.
//
// ---------------------------------------------------------------------------
// What this replaces, and why the replacement was necessary.
// ---------------------------------------------------------------------------
// `src/cron-scheduler.js` (the old `createScheduler`) parsed natural language
// into a cron expression, stored the row in `~/.ox/cron/jobs.json`, and armed an
// in-process `setTimeout`. That timer was `unref()`d, and — this is the part that
// matters — the only thing the timer ever called was `job.handlers?.run?.(job)`,
// and NOTHING IN THE REPOSITORY EVER SET `job.handlers`. So every "scheduled"
// job in ox updated its own `lastRun`/`nextRun`/history and then did nothing at
// all. It was a counter that ticked, not a job that ran. It could not execute
// anything, because it had no execution path to execute.
//
// The old `ox schedule` command was a different problem: it PRINTED a crontab
// block (and a launchd plist) for a human to install by hand, and `--install`
// appended it to the real system crontab. That is the surface this file removes.
//
// ---------------------------------------------------------------------------
// The four rules that make this safe enough to leave running.
// ---------------------------------------------------------------------------
//
//   1. OFF BY DEFAULT, TWICE. A schedule fires only if the daemon-wide policy
//      says opted-in AND the schedule itself is enabled. Both default false. A
//      fresh install cannot run anything unattended, and `--enable` on one
//      schedule still does nothing until the user opts the daemon in.
//
//   2. A SCHEDULE CANNOT ESCALATE. `schedulePassthrough` builds a worker argv
//      from a three-item allowlist (`--max-cost`, `--bot`, `--model`). The
//      foreground detach path (`detachPassthrough` in cli.js) forwards fourteen
//      flags including `--trust`, `--sandbox`, `--yes-edits`, `-y` and
//      `--side-effects-ok`; none of those, and no way to set an env var, is
//      reachable from here. `screenScheduleFlags` refuses the escalation keys at
//      creation time so the refusal is visible rather than silently dropped.
//
//   3. ALWAYS CAPPED. A schedule with no cost cap is a money leak on a timer, so
//      a cap is mandatory: the explicit `--max-cost`, else the configured/env
//      cap, else DEFAULT_SCHEDULE_MAX_COST_USD. The cap reaches the run as
//      `--max-cost=<n>` in the worker argv, which is the SAME flag the foreground
//      path parses, so headless builds the same cost budget and stops the same
//      way. `costCapSource` records which of the three it was.
//
//   4. SCREENED TWICE. The credential/injection screen (memory.js
//      `screenPersistText`, the one goals and memories use) runs on the prompt
//      BEFORE the schedule is persisted and again immediately before it is
//      dispatched. The first pass means no secret ever reaches disk; the second
//      means a hand-edited event log cannot smuggle one in.
//
// The store is append-only JSONL under the daemon directory, for the same reason
// session transcripts are (src/session.js): a torn write loses the LAST event,
// not the whole file, and recovery is a fold with no separate index that can
// disagree with the log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenPersistText } from './memory.js';
import { appendLog, ensureScheduleDir, scheduleDir, scheduleEventsPath, schedulePolicyPath } from './daemon.js';

export const SCHEDULE_SCHEMA_VERSION = 1;

// A schedule below one second is not a schedule, it is a fork bomb wearing a
// timer. The floor is enforced at parse time so no path can route around it.
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 366 * 24 * 60 * 60 * 1000;

// The cap that applies when the user gave none and config has none. Deliberately
// small: it is a backstop, not a budget. A real unattended schedule names its own.
export const DEFAULT_SCHEDULE_MAX_COST_USD = 0.25;

export const HEARTBEAT_DEFAULT_MAX_RUNS = 3;
export const MAX_HEARTBEAT_RUNS = 100;

const MAX_PROMPT_CHARS = 4000;
const MAX_NOTE_CHARS = 300;
const MAX_HISTORY = 20;

// Compact once the log passes this many lines. The log is append-only between
// compactions; a compaction rewrites it as one snapshot event per live row.
const COMPACT_AT = 2000;

const SCHEDULE_STORE = 'the ox schedule store';

// ---------------------------------------------------------------------------
// The privilege screen.
//
// A schedule is unattended code execution. The only flags a schedule may carry
// onto its worker are the three that cannot widen what the run is allowed to do.
// Everything else — trust level, sandbox profile, approval policy, credentials —
// is refused AT CREATION, so the user sees the refusal instead of discovering
// later that their nightly job has been running yolo.
// ---------------------------------------------------------------------------

// Normalized (lowercased, alphanumeric-only) names that are refused outright.
const PRIVILEGE_NAMES = new Set([
  'sandbox', 'sandboxprofile', 'trust', 'trustlevel', 'approval', 'approvals',
  'approvalpolicy', 'yolo', 'yes', 'yesedits', 'assumeYes'.toLowerCase(),
  'fullauto', 'sideeffectsok', 'strictapprovals', 'unrestricted', 'root', 'uid',
  'auth', 'permissions', 'permissionmode', 'bypassapprovals', 'dangerouslyskipperms',
]);

// Substrings, for the shapes an exact match cannot catch: `OX_API_KEY` does not
// normalize to `apikey`, but it contains it. Scanned over KEY names only, never
// over values, so a prompt that legitimately mentions a token is unaffected.
const PRIVILEGE_SUBSTRINGS = [
  'apikey', 'secret', 'token', 'password', 'passwd', 'credential', 'privatekey',
  'keyenv', 'authorization', 'trust', 'sandbox', 'yolo', 'approv', 'permission',
];

// The exact argv shapes a schedule is permitted to put on a worker. SPACE form,
// not `--flag=value`: ox's parser matches `--max-cost` as a bare case and takes
// the NEXT argv element as its value, and does not split on `=`. (Verified:
// `ox --max-cost=0.05 -p hi` is "unknown flag", while `ox --max-cost 0.05 -p hi`
// parses. `detachPassthrough` in cli.js emits the `=` form and is therefore
// broken for every flag it forwards — a separate pre-existing bug, deliberately
// not touched here.)
const ALLOWED_SCHEDULE_FLAGS = Object.freeze(['--max-cost', '--bot', '--model']);

function normalizeKey(k) {
  return String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function screenScheduleFlags(raw) {
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === false) continue;
    const name = normalizeKey(key);
    if (!name) continue;
    if (PRIVILEGE_NAMES.has(name)) {
      return {
        ok: false,
        key,
        reason:
          `refusing: a schedule cannot set '${key}'. A schedule runs unattended, so it may not ` +
          'change its own trust level, sandbox profile, approval policy, or credentials — that is ' +
          'the whole difference between a supervised run and a timer. Start the worker yourself ' +
          'with the flag you want, or set it in your ox config where it applies to every run.',
      };
    }
    const hit = PRIVILEGE_SUBSTRINGS.find((frag) => name.includes(frag));
    if (hit) {
      return {
        ok: false,
        key,
        reason:
          `refusing: '${key}' looks like a privilege or credential setting (matched '${hit}'). ` +
          'A schedule may only carry a prompt, a cadence, a working directory, and the three ' +
          'non-escalating flags --max-cost / --bot / --model.',
      };
    }
  }
  return { ok: true };
}

// Second gate, on the argv itself rather than on the caller's key names. The
// passthrough builder and this screen are written together; if one is ever
// widened without the other, the worker is not started.
export function screenScheduleArgv(argv) {
  const list = (Array.isArray(argv) ? argv : []).map(String);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (ALLOWED_SCHEDULE_FLAGS.includes(item)) continue; // a flag name we allow
    if (item.startsWith('-')) {
      return { ok: false, reason: `refusing: '${item}' is not an allowlisted schedule flag` };
    }
    // A bare value is acceptable only as the argument of an allowlisted flag. This
    // is what stops `--trust yolo` reaching a worker even if someone edits the
    // passthrough builder: the value would have to follow `--max-cost`, and then
    // the flag itself would have had to pass the check above.
    if (i === 0 || !ALLOWED_SCHEDULE_FLAGS.includes(list[i - 1])) {
      return { ok: false, reason: `refusing: '${item}' is not an allowlisted schedule flag value` };
    }
  }
  return { ok: true };
}

// The ONLY argv a schedule can produce. Three flags, all of which narrow or
// merely select a target — none of which can widen the run's authority.
// Deliberately a strict subset of `detachPassthrough` in cli.js: that function
// forwards `--trust`, `--sandbox`, `--yes-edits`, `-y` and `--side-effects-ok`,
// which is right for a run a human just asked for and catastrophic for a timer.
export function schedulePassthrough(rec = {}) {
  const out = [];
  // `!= null` first: Number(null) is 0, so a bare isFinite check would emit
  // `--max-cost 0` for a schedule that has no cap at all — which reads as "spend
  // nothing" rather than "no cap was ever set". Every schedule already carries a
  // cap (resolveScheduleCostCap), so this is belt-and-braces, not the mechanism.
  const cap = rec.maxCostUsd;
  if (cap !== undefined && cap !== null && Number.isFinite(Number(cap)) && Number(cap) >= 0) {
    out.push('--max-cost', String(Number(cap)));
  }
  if (rec.bot) out.push('--bot', String(rec.bot).slice(0, 64));
  if (rec.model) out.push('--model', String(rec.model).slice(0, 120));
  return out;
}

// ---------------------------------------------------------------------------
// The prompt screen. Same function goals and memories use, so the pattern tables
// stay the single source of truth and no schedule re-derives the wording.
// ---------------------------------------------------------------------------

export function screenSchedulePrompt(prompt, store = SCHEDULE_STORE) {
  return screenPersistText(prompt, 'schedule prompt', store);
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

// `every 5m` / `every 2h` / `45000ms` -> an interval; `at 09:30` -> a daily wall
// clock time. `parseNaturalCron` from the old module is NOT reused: it guessed an
// expression and then needed `computeNextRun` to walk a five-field cron, which
// the old implementation did with a loop that could spin a year per call. Two
// explicit cadences have no such failure mode.
export function parseCadence(input = {}) {
  const kind = String(input.kind ?? '').toLowerCase();
  if (kind === 'interval' || input.everyMs != null) {
    const ms = Number(input.everyMs);
    if (!Number.isFinite(ms) || ms <= 0) return { refusal: 'everyMs must be a positive number of milliseconds' };
    if (ms < MIN_INTERVAL_MS) return { refusal: `an interval must be at least ${MIN_INTERVAL_MS}ms — below that it is not a schedule, it is a fork bomb` };
    if (ms > MAX_INTERVAL_MS) return { refusal: `an interval may not exceed ${MAX_INTERVAL_MS}ms (a year)` };
    return { cadence: { kind: 'interval', everyMs: Math.floor(ms), description: `every ${formatDuration(ms)}` } };
  }
  if (kind === 'at' || input.at != null) {
    const raw = String(input.at ?? '').trim();
    // Two shapes share the `at` verb: a daily wall-clock time, and an absolute
    // ISO instant that fires once. The one-shot case keeps its own `atIso` so
    // `at` stays the daily HH:MM field the daemon already reads.
    if (looksLikeIsoInstant(raw)) {
      const ms = Date.parse(raw);
      if (!Number.isFinite(ms)) return { refusal: `'${raw}' is not a readable ISO time — try 2026-10-04T09:00:00Z` };
      return {
        cadence: {
          kind: 'at',
          at: raw,
          atIso: new Date(ms).toISOString(),
          oneShot: true,
          atMs: ms,
          description: `once at ${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
        },
      };
    }
    const m = raw.match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return { refusal: `at needs HH:MM in 24h time or an ISO instant like 2026-10-04T09:00:00Z, got '${raw}'` };
    const hour = Number(m[1]);
    if (hour > 23) return { refusal: `at needs HH:MM in 24h time, got '${raw}'` };
    const at = `${String(hour).padStart(2, '0')}:${m[2]}`;
    return { cadence: { kind: 'at', at, description: `daily at ${at}` } };
  }
  return { refusal: 'a schedule needs a cadence: 30s / 5m / 2h / 1d, --every <interval>, or --at HH:MM / <ISO time>' };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function looksLikeIsoInstant(text) {
  return ISO_INSTANT.test(String(text ?? '').trim());
}

// One token of `/schedule add <cadence> <prompt>`. Returns a cadence input, a
// refusal, or null when the token is simply not a cadence.
//
// A unit is REQUIRED in the positional form. Without that rule `2` in
// `/schedule add 2 days left in the sprint review notes` would be eaten as a
// cadence and silently truncate the prompt. A bare number is therefore always
// prompt text; the flag form (`--every 45000`) is where bare milliseconds live.
const CADENCE_TOKEN = /^\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i;
const ATTEMPTED_TOKEN = /^[0-9][0-9a-z.]*$/i;

export function parseCadenceToken(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (looksLikeIsoInstant(t)) {
    const cad = parseCadence({ kind: 'at', at: t });
    if (cad.refusal) return { refusal: cad.refusal };
    return { kind: 'at', at: t };
  }
  if (CADENCE_TOKEN.test(t)) {
    const p = parseIntervalSpec(t);
    if (p.refusal) return { refusal: p.refusal };
    return { kind: 'interval', everyMs: p.everyMs };
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) return null; // a bare number is prompt text
  if (ATTEMPTED_TOKEN.test(t)) {
    return { refusal: `could not read the cadence '${t}' — ${INTERVAL_HINT}, or an ISO time like 2026-10-04T09:00:00Z` };
  }
  return null;
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n >= 86400000) return `${Math.round(n / 86400000)}d`;
  if (n >= 3600000) return `${Math.round(n / 3600000)}h`;
  if (n >= 60000) return `${Math.round(n / 60000)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}s`;
  return `${n}ms`;
}

// Every unit an interval may name. A table rather than an inline literal so the
// CLI surface, `--every` and the positional form cannot drift apart.
export const INTERVAL_UNITS = Object.freeze({
  ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
});

const INTERVAL_HINT = 'try 30s, 5m, 2h, 1d or 45000';

// ---------------------------------------------------------------------------
// Natural language
//
// "every minute", "every 5 minutes", "nightly at 07:30". This exists for one
// caller — the `ox cron` compatibility surface, whose whole documented contract
// is that `ox cron add "every minute"` arms a minute job — so the free-text
// parsing lives HERE, next to the table of units and the two exact cadences it
// resolves into, rather than being re-derived per command.
//
// It is a front door, never an execution path: the result is always one of the
// two explicit cadences above, which `computeNextRun` can walk exactly. Nothing
// schedules from a cron expression.
// ---------------------------------------------------------------------------

const NATURAL_EVERY = /\bevery\s+(\d+)?\s*([a-z]+)/i;
const NATURAL_DAILY = /\b(every day|daily|nightly)\b/i;
const NATURAL_AT = /\bat\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?/i;

export function parseNaturalCadence(text = '') {
  const t = String(text ?? '').toLowerCase().trim();
  if (!t) return { refusal: 'a schedule needs something to run — `ox cron add "every minute"`' };
  if (NATURAL_DAILY.test(t)) {
    const at = t.match(NATURAL_AT);
    if (!at) return { refusal: `could not read a time out of '${text}' — say "daily at 07:30"` };
    let hour = Number(at[1]);
    const ap = (at[3] ?? '').toLowerCase();
    if (ap === 'pm' && hour !== 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    return parseCadence({ kind: 'at', at: `${String(hour).padStart(2, '0')}:${at[2] ?? '00'}` });
  }
  const every = t.match(NATURAL_EVERY);
  if (every) {
    const unit = every[2];
    // INTERVAL_UNITS is the single table of units. `mins`/`hours` are already
    // keys; the de-pluralized fallback catches a word the table spells
    // differently rather than inventing a second multiplier table here.
    const mult = INTERVAL_UNITS[unit] ?? INTERVAL_UNITS[unit.replace(/s$/, '')];
    if (!mult) {
      return { refusal: `could not read the cadence '${text}' — ${INTERVAL_HINT}, or "daily at HH:MM"` };
    }
    return parseCadence({ kind: 'interval', everyMs: (every[1] ? Number(every[1]) : 1) * mult });
  }
  return { refusal: `could not read a cadence from '${text}' — ${INTERVAL_HINT}, or "daily at HH:MM"` };
}

// Parse `--every 30s` / `every 5m` / `1d` / `45000` into milliseconds.
export function parseIntervalSpec(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/^every\s+/, '');
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/);
  if (!m) return { refusal: `could not read the interval '${text}' — ${INTERVAL_HINT}` };
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const mult = INTERVAL_UNITS[unit];
  if (!mult) return { refusal: `could not read the interval '${text}' — ${INTERVAL_HINT}` };
  return { everyMs: Math.floor(n * mult) };
}

// Next fire time at or after `from`. For `at`, the next occurrence strictly after
// `from` — minute-stepped with a 48-hour bound, which is exact and cannot
// livelock the way a field-by-field cron walk can.
export function computeNextRun(cadence, from = Date.now()) {
  const c = cadence || {};
  if (c.kind === 'interval') {
    const ms = Number(c.everyMs);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return from + ms;
  }
  if (c.kind === 'at') {
    // A one-shot fires at its instant and only at its instant. Past that instant
    // there is no next run at all, so the store says "never" instead of holding a
    // timestamp that has already gone by.
    if (c.oneShot === true) {
      const ms = Date.parse(c.atIso ?? c.at ?? '');
      if (!Number.isFinite(ms)) return null;
      return ms > from ? ms : null;
    }
    const m = String(c.at ?? '').match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    const d = new Date(from);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 48 * 60; i++) {
      if (d.getHours() === hour && d.getMinutes() === minute) return d.getTime();
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The store: append-only JSONL under <daemonDir>/schedules/.
// ---------------------------------------------------------------------------

// An id is the store's primary key: `loadSchedules` folds events into a Map keyed
// by it, so two schedules that share one do not both survive — the second
// `add` event silently overwrites the first and the earlier schedule is gone with
// no error anywhere. The old form derived the whole id from a single
// `Math.random()` draw, so ANY repeat of that draw (a stubbed PRNG, a test
// fixture, an unlucky pair) lost a schedule.
//
// Two independent sources plus a check against what is already stored: a
// process-local counter guarantees distinctness within a process even when the
// PRNG is degenerate, the PRNG keeps ids from being sequential across
// processes, and the store check makes the guarantee real rather than probable.
//
// The SHAPE is eight lowercase hex characters and nothing else. That is the id
// `ox cron` has always printed and accepted (`scheduled job 1a2b3c4d`) and what
// `newLegacyId` hands out, so ONE shape serves both surfaces. A `s-` prefix would
// force the compatibility alias to print a second form or strip one before
// matching, and a row reachable under two spellings is a row that will eventually
// be looked up under the wrong one.
let idSeq = 0;

export function newScheduleId() {
  for (let attempt = 0; attempt < 128; attempt++) {
    idSeq = (idSeq + 1) >>> 0;
    const mix = Math.floor(Math.random() * 0x100000000) >>> 0;
    const id = ((mix ^ idSeq) >>> 0).toString(16).padStart(8, '0');
    if (!getSchedule(id)) return id;
  }
  // Unreachable in practice. If it ever is, fall back to something no counter
  // can repeat within a process.
  return `${process.pid.toString(16)}${Date.now().toString(16)}`.slice(-8).padStart(8, '0');
}

function appendEvent(ev) {
  ensureScheduleDir();
  const line = JSON.stringify({ v: SCHEDULE_SCHEMA_VERSION, at: new Date().toISOString(), ...ev });
  fs.appendFileSync(scheduleEventsPath(), line + '\n', { mode: 0o600 });
  return JSON.parse(line);
}

function readEvents() {
  let text = '';
  try {
    text = fs.readFileSync(scheduleEventsPath(), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && typeof ev === 'object') out.push(ev);
    } catch {
      // A torn tail (a crash mid-append) loses only this event. Skipping is the
      // honest recovery; refusing to load would lose every earlier event too.
    }
  }
  return out;
}

function clip(s, n) {
  return String(s ?? '').slice(0, n);
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '');
  if (!id) return null;
  const cadence = raw.cadence && typeof raw.cadence === 'object' ? raw.cadence : null;
  if (!cadence || (cadence.kind !== 'interval' && cadence.kind !== 'at')) return null;
  const kind = raw.kind === 'heartbeat' ? 'heartbeat' : 'schedule';
  const rec = {
    v: SCHEDULE_SCHEMA_VERSION,
    id,
    kind,
    prompt: clip(raw.prompt, MAX_PROMPT_CHARS),
    cwd: String(raw.cwd ?? process.cwd()),
    cadence,
    enabled: raw.enabled === true, // NOT `!== false`: a schedule is off unless it says otherwise
    // `== null` BEFORE Number() on both of these. Number(null) is 0 and
    // Number(undefined) is NaN, so a plain isFinite test turned an absent
    // nextRunAt into 0 — i.e. 1 Jan 1970, permanently in the past and therefore
    // permanently DUE. An expired one-shot would have fired the instant the
    // daemon was opted in, which is the exact "silent unattended execution"
    // failure the past-cadence check exists to prevent. Same trap cli.js:5818 and
    // `scheduleRunState` below guard against.
    nextRunAt: raw.nextRunAt == null ? null : (Number.isFinite(Number(raw.nextRunAt)) ? Number(raw.nextRunAt) : null),
    lastRun: raw.lastRun && typeof raw.lastRun === 'object' ? raw.lastRun : null,
    runs: Number.isFinite(Number(raw.runs)) ? Number(raw.runs) : 0,
    deferrals: Number.isFinite(Number(raw.deferrals)) ? Number(raw.deferrals) : 0,
    misses: Number.isFinite(Number(raw.misses)) ? Number(raw.misses) : 0,
    // `== null` first for the same reason: an uncapped schedule must read as
    // "no cap recorded", never as "$0", which reads as "spend nothing".
    maxCostUsd: raw.maxCostUsd == null ? null : (Number.isFinite(Number(raw.maxCostUsd)) ? Number(raw.maxCostUsd) : null),
    costCapSource: String(raw.costCapSource ?? 'default'),
    bot: raw.bot ? clip(raw.bot, 64) : null,
    model: raw.model ? clip(raw.model, 120) : null,
    created: String(raw.created ?? new Date().toISOString()),
    updated: String(raw.updated ?? raw.created ?? new Date().toISOString()),
  };
  if (kind === 'heartbeat') {
    rec.session = raw.session ? String(raw.session) : null;
    rec.maxRuns = Math.max(1, Math.min(MAX_HEARTBEAT_RUNS, Number(raw.maxRuns) || HEARTBEAT_DEFAULT_MAX_RUNS));
    rec.goalBound = raw.goalBound !== false;
  }
  if (raw.note) rec.note = clip(raw.note, MAX_NOTE_CHARS);
  return rec;
}

// Fold the log into the live set. Last event per id wins; `remove` is a
// tombstone so a compaction cannot resurrect a deleted schedule.
export function loadSchedules() {
  const rows = new Map();
  for (const ev of readEvents()) {
    if (ev.t === 'add' && ev.schedule?.id) {
      const s = normalizeSchedule(ev.schedule);
      if (s) rows.set(s.id, s);
      continue;
    }
    if (ev.t === 'update' && ev.id) {
      const cur = rows.get(String(ev.id));
      if (!cur) continue;
      const s = normalizeSchedule({ ...cur, ...(ev.patch || {}), id: cur.id });
      if (s) rows.set(cur.id, s);
      continue;
    }
    if (ev.t === 'remove' && ev.id) rows.delete(String(ev.id));
  }
  return [...rows.values()];
}

// Rewrite the log as one snapshot event per live row. tmp+rename so a crash
// mid-compaction leaves the previous log intact rather than a half file.
function compactIfNeeded() {
  let lines = 0;
  try {
    lines = fs.readFileSync(scheduleEventsPath(), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return;
  }
  if (lines < COMPACT_AT) return;
  const live = loadSchedules();
  const tmp = `${scheduleEventsPath()}.${process.pid}.tmp`;
  const body = [
    JSON.stringify({ v: SCHEDULE_SCHEMA_VERSION, at: new Date().toISOString(), t: 'compacted', rows: live.length }),
    ...live.map((s) => JSON.stringify({ v: SCHEDULE_SCHEMA_VERSION, at: new Date().toISOString(), t: 'add', schedule: s })),
  ].join('\n');
  fs.writeFileSync(tmp, body + '\n', { mode: 0o600 });
  fs.renameSync(tmp, scheduleEventsPath());
}

export function listSchedules() {
  return loadSchedules().sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
}

// What `list` should say about a schedule's next run. One function so `/schedule
// list`, `ox schedule list` and the supervisor can never describe the same
// instant differently.
//
// A disabled schedule and an expired one-shot both get a plain sentence rather
// than a timestamp. Printing a next-run for a schedule that cannot run is the
// failure this exists to prevent: the user reads a time, believes a job is
// coming, and nobody is ever told it will not.
export function scheduleRunStatus(schedule = {}, { now = Date.now() } = {}) {
  const s = schedule || {};
  if (s.enabled !== true) return { state: 'disabled', text: 'disabled — will not run until it is enabled' };
  if (s.cadence?.oneShot === true) {
    const at = Date.parse(s.cadence.atIso ?? s.cadence.at ?? '');
    if (!Number.isFinite(at)) return { state: 'none', text: 'never — its scheduled time is unreadable' };
    if (at <= now) return { state: 'past', text: 'never — that one-off time has already passed' };
  }
  if (s.nextRunAt == null) return { state: 'none', text: 'no next run scheduled' };
  const inMs = s.nextRunAt - now;
  if (inMs <= 0) return { state: 'due', text: 'due now' };
  return { state: 'scheduled', text: `in ${formatDuration(inMs)}` };
}

export function getSchedule(id) {
  return loadSchedules().find((s) => s.id === String(id)) ?? null;
}

// ---- policy: the daemon-wide opt-in ----------------------------------------

export const SCHEDULE_POLICY_DEFAULTS = Object.freeze({
  optedIn: false,
  maxInFlight: 3,
  missGraceMs: 60000,
});

// Absent policy file == not opted in. That default is the whole safety story for
// a fresh install: there is nothing to disable because nothing was ever enabled.
export function readPolicy() {
  const base = { ...SCHEDULE_POLICY_DEFAULTS };
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(schedulePolicyPath(), 'utf8'));
  } catch {
    return base;
  }
  return {
    optedIn: raw?.optedIn === true,
    maxInFlight: Math.max(1, Number(raw?.maxInFlight) || SCHEDULE_POLICY_DEFAULTS.maxInFlight),
    missGraceMs: Math.max(1000, Number(raw?.missGraceMs) || SCHEDULE_POLICY_DEFAULTS.missGraceMs),
  };
}

export function writePolicy(patch = {}) {
  ensureScheduleDir();
  const next = { ...readPolicy(), ...patch };
  const clean = {
    optedIn: next.optedIn === true,
    maxInFlight: Math.max(1, Number(next.maxInFlight) || SCHEDULE_POLICY_DEFAULTS.maxInFlight),
    missGraceMs: Math.max(1000, Number(next.missGraceMs) || SCHEDULE_POLICY_DEFAULTS.missGraceMs),
  };
  fs.writeFileSync(schedulePolicyPath(), JSON.stringify(clean, null, 2), { mode: 0o600 });
  appendLog(`schedule policy: optedIn=${clean.optedIn} maxInFlight=${clean.maxInFlight} missGraceMs=${clean.missGraceMs}`);
  return clean;
}

// ---- create ----------------------------------------------------------------

// `resolveMaxCostUsd` is imported lazily to keep this module's import graph
// acyclic against cost.js -> providers. It is the SAME resolver the foreground
// path uses, so "configured cap" means the same thing here as it does there.
export function resolveScheduleCostCap({ explicit = undefined, env = process.env } = {}) {
  if (explicit !== undefined && explicit !== null) {
    const n = Number(explicit);
    if (!Number.isFinite(n) || n < 0) return { refusal: `--max-cost needs a finite nonnegative number, got '${explicit}'` };
    return { maxCostUsd: n, costCapSource: 'explicit' };
  }
  const configured = env.OX_MAX_COST ?? null;
  if (configured != null && String(configured).trim() !== '') {
    const n = Number(configured);
    if (!Number.isFinite(n) || n < 0) return { refusal: `OX_MAX_COST is not a finite nonnegative number: '${configured}'` };
    return { maxCostUsd: n, costCapSource: 'config' };
  }
  return { maxCostUsd: DEFAULT_SCHEDULE_MAX_COST_USD, costCapSource: 'default' };
}

export function addSchedule(input = {}) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) return { refusal: 'a schedule needs a prompt: ox schedule add "<what to do>" --every 30m' };

  // Screen BEFORE anything is created, so a refusal leaves no trace on disk.
  const promptRefusal = screenSchedulePrompt(prompt);
  if (promptRefusal) return { refusal: promptRefusal };

  // Privilege screen on whatever flag-ish object the caller handed us. `flags` is
  // the raw user input; `input` itself is the vetted field set.
  const flagged = screenScheduleFlags(input.flags);
  if (!flagged.ok) return { refusal: flagged.reason };

  // Callers nest the cadence under `cadence` (that is the record's field name);
  // a flat `{kind, everyMs}` is also accepted so parseCadence stays usable alone.
  const cad = parseCadence(input.cadence ?? input);
  if (cad.refusal) return { refusal: cad.refusal };

  const cap = resolveScheduleCostCap({ explicit: input.maxCostUsd });
  if (cap.refusal) return { refusal: cap.refusal };

  const kind = input.kind === 'heartbeat' ? 'heartbeat' : 'schedule';
  const now = Date.now();
  const rec = normalizeSchedule({
    v: SCHEDULE_SCHEMA_VERSION,
    id: newScheduleId(),
    kind,
    prompt,
    cwd: String(input.cwd ?? process.cwd()),
    cadence: cad.cadence,
    // Created DISABLED. `--enable` (or `/schedule enable <id>`) is the explicit
    // opt-in for this row, and it is separate from the daemon-wide opt-in.
    enabled: input.enabled === true,
    nextRunAt: computeNextRun(cad.cadence, now),
    lastRun: null,
    runs: 0,
    maxCostUsd: cap.maxCostUsd,
    costCapSource: cap.costCapSource,
    bot: input.bot ?? null,
    model: input.model ?? null,
    created: new Date(now).toISOString(),
    updated: new Date(now).toISOString(),
    ...(kind === 'heartbeat'
      ? { session: input.session ? String(input.session) : null, maxRuns: Number(input.maxRuns) || HEARTBEAT_DEFAULT_MAX_RUNS, goalBound: input.goalBound !== false }
      : {}),
    ...(input.note ? { note: clip(input.note, MAX_NOTE_CHARS) } : {}),
  });
  if (!rec) return { refusal: 'the schedule could not be normalized' };

  appendEvent({ t: 'add', schedule: rec });
  compactIfNeeded();
  appendLog(`schedule ${rec.id} added (${rec.cadence.description}, cap $${rec.maxCostUsd} ${rec.costCapSource}, ${rec.enabled ? 'enabled' : 'disabled'})`);
  return { schedule: rec };
}

export function updateSchedule(id, patch = {}) {
  const cur = getSchedule(id);
  if (!cur) return { refusal: `no schedule with id '${id}'` };
  // The same two screens on the way in: a hand-edited log must not be able to
  // install a privileged flag or a credential-bearing prompt either.
  if (patch.prompt != null) {
    const refusal = screenSchedulePrompt(String(patch.prompt));
    if (refusal) return { refusal };
  }
  const flagged = screenScheduleFlags(patch.flags);
  if (!flagged.ok) return { refusal: flagged.reason };
  const clean = { ...patch };
  delete clean.flags;
  delete clean.id;
  delete clean.kind;
  const next = normalizeSchedule({ ...cur, ...clean, id: cur.id, updated: new Date().toISOString() });
  if (!next) return { refusal: 'that change is not a valid schedule' };
  // A cadence or enabled-state change must recompute when it is next due.
  if (patch.cadence || patch.enabled !== undefined) {
    if (patch.enabled === true && !cur.enabled) next.nextRunAt = computeNextRun(next.cadence, Date.now());
    if (patch.enabled === false) next.nextRunAt = null;
    if (patch.cadence) next.nextRunAt = next.enabled ? computeNextRun(next.cadence, Date.now()) : null;
  }
  appendEvent({ t: 'update', id: cur.id, patch: { ...clean, nextRunAt: next.nextRunAt, updated: next.updated } });
  compactIfNeeded();
  return { schedule: next };
}

export function removeSchedule(id) {
  const cur = getSchedule(id);
  if (!cur) return { removed: false, reason: `no schedule with id '${id}'` };
  appendEvent({ t: 'remove', id: cur.id });
  compactIfNeeded();
  appendLog(`schedule ${cur.id} removed`);
  return { removed: true, id: cur.id };
}

// Tombstone every row. The log keeps the `remove` events (it is append-only), so
// the residue check is about what is LOADABLE and what is on disk — see
// scheduleResidue, which reports both.
export function removeAllSchedules() {
  const live = loadSchedules();
  for (const s of live) appendEvent({ t: 'remove', id: s.id });
  appendLog(`all ${live.length} schedule(s) removed`);
  return { removed: live.length };
}

// ---- results ---------------------------------------------------------------

function trimRun(entry) {
  const history = Array.isArray(entry.history) ? entry.history.slice(-MAX_HISTORY) : [];
  return { ...entry, history };
}

export function recordRun(id, result = {}) {
  const cur = getSchedule(id);
  if (!cur) return null;
  const at = Number.isFinite(Number(result.at)) ? Number(result.at) : Date.now();
  const entry = {
    at,
    state: String(result.state ?? 'unknown'),
    workerId: result.workerId ? String(result.workerId) : null,
    code: Number.isFinite(Number(result.code)) ? Number(result.code) : null,
    note: result.note ? clip(result.note, MAX_NOTE_CHARS) : '',
  };
  const history = [...(Array.isArray(cur.lastRun?.history) ? cur.lastRun.history : []), entry].slice(-MAX_HISTORY);
  const patch = {
    lastRun: trimRun({ ...entry, history }),
    runs: Number.isFinite(Number(result.countRuns)) && result.countRuns
      ? cur.runs + 1
      : cur.runs,
    updated: new Date(at).toISOString(),
  };
  appendEvent({ t: 'update', id: cur.id, patch });
  return { ...cur, ...patch };
}

export function recordDeferral(id, reason) {
  const cur = getSchedule(id);
  if (!cur) return null;
  const at = Date.now();
  const patch = {
    deferrals: cur.deferrals + 1,
    lastRun: trimRun({
      ...(cur.lastRun ?? {}),
      at,
      state: 'deferred',
      note: clip(reason, MAX_NOTE_CHARS),
      history: [...(Array.isArray(cur.lastRun?.history) ? cur.lastRun.history : []), { at, state: 'deferred', note: clip(reason, MAX_NOTE_CHARS) }].slice(-MAX_HISTORY),
    }),
    updated: new Date(at).toISOString(),
  };
  appendEvent({ t: 'update', id: cur.id, patch });
  return { ...cur, ...patch };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Every schedule whose nextRunAt has arrived, honouring BOTH gates. Called by the
// supervisor tick; returns the rows it would dispatch.
export function dueSchedules({ now = Date.now(), policy = readPolicy() } = {}) {
  if (!policy.optedIn) return [];
  return loadSchedules().filter((s) => s.enabled && s.nextRunAt != null && s.nextRunAt <= now);
}

// Claim a schedule for one run. The claim ADVANCES nextRunAt and records the
// attempt in the SAME append, before the caller spawns anything — so a supervisor
// that dies between the claim and the spawn comes back to a schedule that is
// already due in a full interval, not one that fires again immediately. That is
// what makes "a restart does not double-fire one that already ran" true rather
// than merely likely.
//
// `missGraceMs` bounds how stale a due time may be. A schedule that came due
// while the daemon was stopped is not run late: it is recorded as a miss and
// advanced, because a nightly job firing three days late at 4am is worse than
// not firing at all.
//
// `attended` is the one distinction this function draws, and it is about WHO IS
// WATCHING, not about privilege. An attended claim is a human standing at a
// terminal who asked for this job to run right now (`ox cron run <id>`,
// `ox schedule run-now <id>`) and who is about to be shown the outcome.
//
//   * the daemon-wide opt-in still gates the TIMER. `dueSchedules` reads the
//     policy and does not know what `attended` means, so nothing unattended can
//     fire while the daemon is opted out — the "off by default" story is intact.
//   * an attended claim does not require the row to be already due. "Run it now"
//     that refuses because the job is not due until 09:00 is not a run-now; and a
//     row whose cadence already elapsed is precisely the one a person wants.
//   * an attended claim is not filed as a MISS. The daemon being down is not why
//     this run happened — the operator is.
//
// The per-row `enabled` gate is NOT relaxed. A disabled row stays disabled: the
// user turned it off, and asking for one run of an explicitly disabled schedule is
// `ox schedule enable <id>` followed by a run, in that order.
export function claimSchedule(id, { now = Date.now(), policy = readPolicy(), trigger = 'tick', attended = false } = {}) {
  const cur = getSchedule(id);
  if (!cur) return { refusal: `no schedule with id '${id}'` };
  if (!policy.optedIn && !attended) return { refusal: 'schedules are not opted in for this daemon — `ox schedule opt-in` first' };
  if (!cur.enabled) return { refusal: `schedule ${cur.id} is disabled` };
  if (cur.nextRunAt == null) return { refusal: `schedule ${cur.id} has no next run time` };
  if (cur.nextRunAt > now && !attended) return { refusal: `schedule ${cur.id} is not due yet` };

  // The heartbeat bound is checked here, not only at dispatch, so a heartbeat
  // that has used its budget cannot be claimed by a tick, a `run-now`, or a
  // restart.
  if (cur.kind === 'heartbeat' && cur.runs >= cur.maxRuns) {
    return { refusal: `heartbeat ${cur.id} has used all ${cur.maxRuns} of its runs` };
  }

  const stale = now - cur.nextRunAt;
  const next = computeNextRun(cur.cadence, now);
  // `attended` skips miss accounting entirely (see the note above), so the only
  // caller that can produce `missed: true` is the timer.
  const patch = {
    nextRunAt: next,
    updated: new Date(now).toISOString(),
    lastRun: trimRun({
      ...(cur.lastRun ?? {}),
      at: now,
      state: 'claimed',
      trigger,
      note: '',
      history: [...(Array.isArray(cur.lastRun?.history) ? cur.lastRun.history : []), { at: now, state: 'claimed', trigger }].slice(-MAX_HISTORY),
    }),
  };
  if (!attended && stale > policy.missGraceMs) {
    patch.misses = cur.misses + 1;
    patch.lastRun = { ...patch.lastRun, state: 'missed', note: `was due ${formatDuration(stale)} ago and the daemon was not running` };
    appendEvent({ t: 'update', id: cur.id, patch });
    return { missed: true, schedule: { ...cur, ...patch }, staleMs: stale };
  }

  appendEvent({ t: 'update', id: cur.id, patch });
  return { schedule: { ...cur, ...patch } };
}

// ---------------------------------------------------------------------------
// The in-flight cap, as a decision rather than as a branch inside the tick.
//
// A due schedule past the cap is DEFERRED, never dropped: nextRunAt is left
// alone, so the row is still due on the next pass and fires as soon as a slot
// frees. That is the difference between "backed up" and "silently skipped", and
// it is why the refusal is recorded on the schedule rather than only logged.
//
// Exported so the rule can be graded without a daemon and without wall-clock.
// The supervisor calls this exact function; it is not a reimplementation of it.
// ---------------------------------------------------------------------------
export function inflightVerdict({ inflight = [], maxInFlight = 3, id = null } = {}) {
  const live = inflight instanceof Set ? inflight : new Set(inflight);
  const cap = Math.max(1, Number(maxInFlight) || 1);
  if (live.size < cap) return { allowed: true, inFlight: live.size, cap };
  const who = [...live].join(', ');
  return {
    allowed: false,
    deferred: true,
    inFlight: live.size,
    cap,
    reason: `deferred: ${live.size} scheduled run(s) already in flight (${who})`,
  };
}

// ---------------------------------------------------------------------------
// How a finished run is named on the schedule.
//
// The worker's PROCESS exit code is not the run's verdict: `runDaemonWorker`
// deliberately exits 0 for any run that concluded, and reports the run's own code
// separately as `runCode`. So a run that stopped on its cost cap arrives here as
// exit 0 + runCode 2, and reading the exit code alone would file it as `ok` —
// which is precisely the "we hit the cap and we finished" confusion the goal
// module refuses. Hence the runCode first, and hence this is a function: the
// naming is a decision with a name, not an inline ternary.
// ---------------------------------------------------------------------------
export function scheduleRunState({ code = null, signal = null, runCode = null, stopRequested = false } = {}) {
  if (stopRequested) return 'stopped';
  if (signal) return `signal ${signal}`;
  // `!= null` BEFORE Number(): Number(null) is 0 and Number('') is 0, so a plain
  // Number.isFinite check reads an ABSENT runCode as a clean zero exit and files
  // a crashed worker under `ok`. Same trap cli.js:5818 guards against.
  const toCode = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const rc = toCode(runCode);
  const ec = toCode(code);
  // 2 is headless's "declined approval or budget stop" — an outcome of the run.
  if (rc === 2 || ec === 2) return 'budget-stop';
  if (rc === 0 || ec === 0) return 'ok';
  if (rc != null) return `exit ${rc}`;
  return ec != null ? `exit ${ec}` : 'unknown';
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

export const HEARTBEAT_DECISIONS = Object.freeze({
  RUN: 'run',
  STOP: 'stop',
});

// What a heartbeat should do on its next tick. Every terminal condition is
// explicit and named, because "the heartbeat stopped for no reason" is the
// failure mode that makes people leave these on forever.
//
// A goal-bound heartbeat (the default) is bound to ONE session's persistent goal.
// If that goal is absent, done, cleared or paused it stops — it never falls back
// to its own prompt, because a timer whose subject vanished has no business
// starting something unrelated in a session a human believes is idle.
export function heartbeatDecision({ schedule = null, goal = null, policy = readPolicy() } = {}) {
  const s = normalizeSchedule(schedule);
  if (!s) return { action: HEARTBEAT_DECISIONS.STOP, reason: 'no-schedule' };
  if (s.kind !== 'heartbeat') return { action: HEARTBEAT_DECISIONS.STOP, reason: 'not-a-heartbeat' };
  if (!policy.optedIn) return { action: HEARTBEAT_DECISIONS.STOP, reason: 'not-opted-in' };
  if (!s.enabled) return { action: HEARTBEAT_DECISIONS.STOP, reason: 'disabled' };
  if (s.runs >= s.maxRuns) {
    return { action: HEARTBEAT_DECISIONS.STOP, reason: 'run-budget', fired: s.runs, budget: s.maxRuns };
  }
  if (s.goalBound !== false) {
    if (!goal) return { action: HEARTBEAT_DECISIONS.STOP, reason: 'no-active-goal' };
    const status = String(goal.status ?? '');
    if (status === 'done' || status === 'cleared') {
      return { action: HEARTBEAT_DECISIONS.STOP, reason: 'goal-complete', objective: goal.objective };
    }
    if (status === 'paused') return { action: HEARTBEAT_DECISIONS.STOP, reason: 'goal-paused', objective: goal.objective };
  }
  return { action: HEARTBEAT_DECISIONS.RUN, next: s.runs + 1, budget: s.maxRuns };
}

// The prompt for one heartbeat turn. `goalBlock` is `renderGoalBlock` from
// goal.js, injected by the caller: this module stays free of the goal lifecycle
// so it can be reasoned about (and tested) on its own.
export function buildHeartbeatPrompt({ schedule = null, goalBlock = '', next = 1, budget = HEARTBEAT_DEFAULT_MAX_RUNS, transcript = null } = {}) {
  const s = normalizeSchedule(schedule);
  const lines = [
    `## HEARTBEAT ${next} of ${budget} — unattended continuation`,
    '',
    'You are re-entering an EXISTING session. Continue the goal below. Do NOT start',
    'unrelated work, do NOT restate what you are about to do, and do NOT ask a question —',
    'nobody is here to answer one.',
  ];
  if (s?.session) lines.push('', `Session transcript: ${s.session}`);
  if (goalBlock) lines.push('', goalBlock);
  lines.push(
    '',
    `This is heartbeat ${next} of ${budget}.`,
    'Do this:',
    '- pick the highest-value item that is NOT yet proven, and work it for real;',
    '- keep the checklist current with todo_write — an item is only completed once a tool',
    '  call in the transcript demonstrates it;',
    '- report progress in a few lines: what changed, what is now evidenced, what is blocked;',
    '- if you hit a budget stop, a declined approval, or a blocked item, SAY SO and stop',
    '  there. A stop is not a completion.',
    '',
    'This heartbeat stops on its own when the goal completes, is paused, or when the',
    `budget of ${budget} heartbeats is spent. Do not try to continue past this run.`,
    '',
    s?.prompt ? `Operator note for this heartbeat: ${clip(s.prompt, 400)}` : ''
  );
  return lines.filter((l) => l !== undefined).join('\n').trim();
}

// The prompt a plain schedule dispatches. Re-screened by the caller before the
// spawn, so a hand-edited log cannot get a secret past this point.
export function buildSchedulePrompt(schedule) {
  const s = normalizeSchedule(schedule);
  if (!s) return '';
  return s.prompt;
}

// ---------------------------------------------------------------------------
// Residue
// ---------------------------------------------------------------------------

// Everything a schedule can leave behind, in one list, so "delete all schedules"
// can be graded against the filesystem instead of against a return value. The
// daemon dir may legitimately hold the pidfile, socket, logs and worker records —
// none of which belong to a schedule — so this reports schedule state only, and
// separately reports whether any worker is tagged with a schedule id.
export function scheduleResidue() {
  const dir = scheduleDir();
  const entries = [];
  let dirExists = false;
  try {
    dirExists = fs.statSync(dir).isDirectory();
  } catch {}
  if (dirExists) {
    for (const name of fs.readdirSync(dir)) {
      entries.push(path.join(dir, name));
    }
  }
  const live = loadSchedules();
  return {
    dir: scheduleDir(),
    dirExists,
    files: entries,
    live: live.map((s) => s.id),
    count: live.length,
    policyExists: fs.existsSync(schedulePolicyPath()),
  };
}

// Called by the supervisor on shutdown so a stopped daemon leaves no timers and
// no half-claimed schedule behind. Clearing the timers is enough — the store is
// append-only and needs no teardown.
export function noteShutdown(count) {
  if (count > 0) appendLog(`schedule engine stopping (${count} schedule(s) known)`);
}

export { scheduleDir, scheduleEventsPath, schedulePolicyPath };

// ---------------------------------------------------------------------------
// The crontab block generator — KEPT, and the installer that used it REMOVED.
//
// `ox schedule --install` used to `execFileSync('crontab', ...)` and append a
// block to the user's real system crontab. That is gone, and the reasoning is
// the whole point of this file:
//
//   * It is a DUPLICATE EXECUTION PATH. With the daemon dispatching, a crontab
//     entry firing the same goal is unattended code execution running twice on
//     one timer, twice the spend, from a place `ox schedule list` cannot see.
//   * A crontab entry is INVISIBLE, PERSISTENT STATE. It survives `ox` being
//     uninstalled, it is not listed anywhere in ox, and it is not removed by
//     `ox schedule remove-all`. A schedule in this store is listed, removed, and
//     bounded by a cost cap; a crontab line is none of those.
//   * It BYPASSED THE BOUNDARY. The daemon is a 0700 directory with a 0600
//     socket and an ownership screen; a crontab line runs with whatever the OS
//     environment happens to contain, unscreened, uncapped, unrecorded.
//   * It IS NOT CROSS-PLATFORM. `crontab` needs extra packages on macOS, and the
//     launchd alternative is macOS-only.
//
// What survives is the PURE BUILDER, reachable only as `ox schedule
// print-crontab`, which writes to stdout and installs nothing. A user who
// genuinely wants system cron keeps a way to get a correct block; a user who
// does not never has one installed behind their back. Nothing is left running
// by both, which is the failure mode that matters.
// ---------------------------------------------------------------------------

export const SCHEDULE_MARKER_PREFIX = '# ox-schedule ';

function shQuote(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

export function scheduleHash(text) {
  let h = 5381;
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Pure builder for the daily-run cron block. The hash is over time+goal+keyEnv,
// so printing the same block twice yields the same marker — which is what made
// the old `--install` idempotent, and is still useful for a human diffing two
// printed blocks before pasting one.
export function buildScheduleBlock({
  goal,
  at = '09:00',
  maxCostUsd = null,
  keyEnv = 'OX_API_KEY',
  cwd = process.cwd(),
  binPath,
  logFile,
} = {}) {
  const m = String(at ?? '09:00').match(/^(\d{1,2}):([0-5]\d)$/);
  const hour = m ? String(Number(m[1])) : '9';
  const minute = m ? m[2] : '00';
  const g = String(goal ?? '').replace(/\s+/g, ' ').trim();
  const hash = scheduleHash(`${hour}:${minute}|${keyEnv}|${g}`);
  const costPart = maxCostUsd != null ? ` --max-cost ${maxCostUsd}` : '';
  const cronLine =
    `${minute} ${hour} * * * cd ${shQuote(cwd)} && ${keyEnv}=${shQuote(`__SET_${keyEnv}__`)} ` +
    `${shQuote(process.execPath)} ${shQuote(binPath)} auto ${shQuote(g)}${costPart} --yes-edits ` +
    `>> ${shQuote(logFile)} 2>&1`;
  const block = [
    '# --- begin ox schedule (printed by `ox schedule "<goal>"`) ---',
    `# goal: ${g}`,
    `# key env: put the real API key in ${keyEnv}, then replace __SET_${keyEnv}__ below`,
    `# logs: ${logFile}`,
    `${SCHEDULE_MARKER_PREFIX}${hash}`,
    cronLine,
    '# --- end ox schedule ---',
    '',
  ].join('\n');
  const launchdLabel = `com.ox.auto.${hash}`;
  const launchd = [
    `# launchd alternative (macOS) — ox NEVER installs launchd jobs automatically.`,
    `# Save as ~/Library/LaunchAgents/${launchdLabel}.plist, edit the key, then:`,
    `#   launchctl load ~/Library/LaunchAgents/${launchdLabel}.plist`,
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `  <key>Label</key><string>${launchdLabel}</string>`,
    `  <key>ProgramArguments</key><array>`,
    `    <string>${process.execPath}</string><string>${binPath}</string><string>auto</string>`,
    `    <string>${g}</string>${maxCostUsd != null ? `<string>--max-cost</string><string>${maxCostUsd}</string>` : ''}`,
    `    <string>--yes-edits</string>`,
    `  </array>`,
    `  <key>EnvironmentVariables</key><dict><key>${keyEnv}</key><string>__SET_${keyEnv}__</string></dict>`,
    `  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict>`,
    `  <key>StandardOutPath</key><string>${logFile}</string>`,
    `  <key>StandardErrorPath</key><string>${logFile}</string>`,
    `</dict></plist>`,
  ].join('\n');
  return { hash, hour, minute, cronLine, block, launchd, label: launchdLabel };
}

// Retained because it is the honest statement of what the old installer decided:
// marker present means "do not append". Nothing in ox calls it any more, and the
// test that grades it still grades the same pure function.
export function planScheduleInstall(existingCrontab, hash) {
  if (String(existingCrontab ?? '').includes(`${SCHEDULE_MARKER_PREFIX}${hash}`)) {
    return { action: 'already-installed' };
  }
  return { action: 'append' };
}

export const OX_BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
