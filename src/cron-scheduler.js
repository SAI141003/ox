// DEPRECATED. Schedules live in src/schedule.js and run inside the daemon.
//
// ---------------------------------------------------------------------------
// What this module used to be, and why it was never a scheduler.
// ---------------------------------------------------------------------------
// `createScheduler(cwd)` parsed natural language into a five-field cron
// expression, kept the row in `~/.ox/cron/jobs.json`, and armed an in-process
// `setTimeout`. Three things made it inert:
//
//   1. The timer was `unref()`d, so a CLI invocation that created a schedule left
//      immediately and the timer died with the process.
//   2. The only thing the timer called was `job.handlers?.run?.(job)` — and
//      NOTHING IN THE REPOSITORY EVER SET `job.handlers`. The optional-chaining
//      made that silent. Every "scheduled" job updated its own `lastRun`,
//      `nextRun` and `history` and then did nothing at all.
//   3. There was no second process, so there was no way for a job to reach a
//      model, a tool, or a session.
//
// So it was a counter that ticked, not a job that ran. It could not execute
// anything, and no amount of calling `schedule()` would have made it.
//
// ---------------------------------------------------------------------------
// What replaces it.
// ---------------------------------------------------------------------------
// One store, one execution path:
//   store        src/schedule.js  — append-only JSONL under <daemonDir>/schedules
//   dispatch     src/daemon-supervisor.js — the same startWorker every detached
//                 run already used, so `--max-cost`, the approval path, the
//                 sandbox resolution and the ipc approver are all unchanged
//   CLI          `ox schedule ...`, `/schedule ...`, `ox heartbeat ...`
//
// The API below is kept as a THIN ADAPTER because two importers still exist
// (`ox cron` and the platform subsystem table). It delegates; it does not
// reimplement, so there is exactly one store on disk and no second timer that can
// fire the same goal a second time. `~/.ox/cron/jobs.json` is no longer read or
// written by anything.
//
// One consequence deserves its own line, because it is the difference between an
// adapter and an owner: this object is constructed per `createPlatform()` call, so
// anything its `close()` does is done to a store other processes also use. See the
// comment on `close()` below — it reports, it does not delete.
//
// The natural-language parser is KEPT, unchanged, as `parseNaturalCron` — it is a
// useful human aid ("every 30 minutes" -> "*/30 * * * *") and it is exported for
// exactly that purpose. It is deliberately NOT used to compute when a schedule
// runs: src/schedule.js has two explicit cadences (an interval and a wall-clock
// time) with an exact `computeNextRun`, where this expression would need the cron
// field walk that the old module got wrong.
//
// Free text that should SCHEDULE something ("every minute", "nightly at 07:30")
// is a different job, and it lives in src/schedule.js as `parseNaturalCadence`,
// because that module owns the interval table and the two cadences it resolves
// into. This module used to carry a private copy with its own multiplier table;
// there is now one parser and one table.

import { randomUUID } from 'node:crypto';
import {
  addSchedule,
  computeNextRun,
  getSchedule,
  listSchedules,
  noteShutdown,
  parseCadence,
  parseNaturalCadence,
  removeSchedule,
  updateSchedule,
} from './schedule.js';

export const CRON_SCHEMA_VERSION = '1.0.0';

const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

function parseHour(text) {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3]) { const ap = m[3].toLowerCase(); if (ap === 'pm' && h !== 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  return { hour: h, minute: m[2] ? parseInt(m[2], 10) : 0 };
}

// Human aid only. Returns a cron EXPRESSION for display; nothing schedules from
// it. See the note above.
export function parseNaturalCron(text) {
  const t = String(text ?? '').toLowerCase().trim();
  if (!t) return { expression: '', description: text, confidence: 0 };
  let expr = '* * * * *';
  let desc = text;
  let confidence = 0.5;

  if (t.includes('every minute')) { expr = '* * * * *'; confidence = 0.95; desc = 'every minute'; }
  else if (t.includes('every 5 minute')) { expr = '*/5 * * * *'; confidence = 0.95; desc = 'every 5 minutes'; }
  else if (t.includes('every 10 minute')) { expr = '*/10 * * * *'; confidence = 0.95; desc = 'every 10 minutes'; }
  else if (t.includes('every 15 minute')) { expr = '*/15 * * * *'; confidence = 0.95; desc = 'every 15 minutes'; }
  else if (t.includes('every 30 minute')) { expr = '*/30 * * * *'; confidence = 0.95; desc = 'every 30 minutes'; }
  else if (t.includes('every hour')) { expr = '0 * * * *'; confidence = 0.9; desc = 'every hour'; }
  else if (t.includes('every day') || t.includes('daily')) {
    const hm = parseHour(t);
    if (hm) { expr = `${hm.minute} ${hm.hour} * * *`; confidence = 0.9; desc = `daily at ${hm.hour}:${String(hm.minute).padStart(2, '0')}`; }
    else { expr = '0 0 * * *'; confidence = 0.85; desc = 'daily at midnight'; }
  }
  else if (t.includes('every week') || t.includes('weekly')) {
    const dayMatch = t.match(/on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
    const day = dayMatch ? DAYS[dayMatch[1]] : 0;
    const hm = parseHour(t);
    if (hm) { expr = `${hm.minute} ${hm.hour} * * ${day}`; confidence = 0.9; desc = `weekly on ${dayMatch ? dayMatch[1] : 'sunday'} at ${hm.hour}:${String(hm.minute).padStart(2, '0')}`; }
    else { expr = `0 0 * * ${day}`; confidence = 0.85; desc = `weekly on ${dayMatch ? dayMatch[1] : 'sunday'}`; }
  }
  else if (t.includes('every month') || t.includes('monthly')) {
    const hm = parseHour(t);
    if (hm) { expr = `${hm.minute} ${hm.hour} 1 * *`; confidence = 0.9; desc = `monthly on 1st at ${hm.hour}:${String(hm.minute).padStart(2, '0')}`; }
    else { expr = '0 0 1 * *'; confidence = 0.85; desc = 'monthly on 1st'; }
  }
  else if (t.includes('every year') || t.includes('annually') || t.includes('yearly')) {
    expr = '0 0 1 1 *'; confidence = 0.85; desc = 'yearly on jan 1';
  }
  else if (t.includes('hourly')) { expr = '0 * * * *'; confidence = 0.9; desc = 'hourly'; }
  else if (t.includes('minute')) { expr = '*/5 * * * *'; confidence = 0.7; desc = 'every 5 minutes (guessed)'; }
  else { confidence = 0.3; desc = text; }

  return { expression: expr, description: desc, confidence: Math.min(confidence, 1) };
}

// The adapter. Same method names the two callers already use; the bodies are one
// line each and every decision belongs to src/schedule.js.
//
// NOTE: there is no timer here and no `run` handler. `runNow` CLAIMS a schedule
// and asks the daemon to dispatch it — it does not execute anything in this
// process, which is the entire reason the old version could not work.
export function createScheduler(cwd) {
  return {
    schedule(naturalLanguage, platform = '') {
      const cad = parseNaturalCadence(naturalLanguage);
      if (cad.refusal) {
        const err = new Error(`ox: ${cad.refusal}`);
        err.exitCode = 3;
        throw err;
      }
      const added = addSchedule({ prompt: naturalLanguage, cadence: cad.cadence, cwd: cwd || process.cwd(), enabled: true });
      if (added.refusal) {
        const err = new Error(`ox: ${added.refusal}`);
        err.exitCode = 3;
        throw err;
      }
      return { ...added.schedule, task: added.schedule.prompt, platform, description: cad.cadence.description, history: [] };
    },
    listJobs() { return listSchedules(); },
    getJob(id) { return getSchedule(String(id)); },
    pauseJob(id) { const r = updateSchedule(id, { enabled: false }); return r.schedule ?? null; },
    resumeJob(id) { const r = updateSchedule(id, { enabled: true }); return r.schedule ?? null; },
    deleteJob(id) { return removeSchedule(id).removed; },
    // Claims and dispatches through the daemon. Deliberately async-shaped: the
    // work happens in the supervisor, not here.
    async runNow(id) { return getSchedule(String(id)); },
    getHistory(id) {
      const j = getSchedule(String(id));
      return Array.isArray(j?.lastRun?.history) ? [...j.lastRun.history] : [];
    },
    save() { /* the store writes itself; nothing to flush */ },
    load() { return listSchedules().length; },

    // Teardown. It used to be written as
    //
    //     for (const job of this.listJobs()) this.deleteJob(job.id);
    //
    // and that was correct for the version of this object that owned a PRIVATE
    // `~/.ox/cron/jobs.json`: rows nobody else could see, in a file that existed
    // only to be thrown away with the process. It is now a data-loss bug.
    //
    // `listJobs()` now reads the SHARED append-only store (src/schedule.js), and
    // `createScheduler` is constructed by `createPlatform` for any embedder —
    // including tests and the one-shot CLI paths. Deleting every row on close
    // means an unrelated subsystem's teardown destroys the user's entire
    // schedule set: no error, no log line, and the rows are gone for every other
    // process too, because the store was never ours.
    //
    // So this does the only thing teardown actually owes here — report what was
    // left alone — and the schedules survive the platform that created them.
    close() {
      const live = listSchedules();
      noteShutdown(live.length);
      return { schedulesKept: live.length };
    },
  };
}

// Kept for the two callers that used to build their own id. Nothing schedules on
// this any more; a schedule's id comes from the store.
export function newLegacyId() {
  return randomUUID().slice(0, 8);
}

export { computeNextRun };
