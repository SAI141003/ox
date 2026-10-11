// REGRESSION GUARDS for four fixes claimed by the schedule migration.
//
// Each test below names the bug, describes the exact mechanism, and then asserts
// the property that the mechanism protects. Every one of them FAILS if its bug is
// reintroduced — that is the point of the file. If a guard here ever needs
// weakening, the honest move is to decide whether the property is still true, not
// to relax the assertion.
//
// The sandbox is load-bearing, exactly as in test/schedule.test.js: HOME and
// OX_DAEMON_DIR both move under a SHORT temp root, so the developer's real ~/.ox
// is never read or written and no socket path can exceed sun_path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  addSchedule,
  claimSchedule,
  dueSchedules,
  getSchedule,
  listSchedules,
  loadSchedules,
  parseNaturalCadence,
  readPolicy,
  schedulePassthrough,
  writePolicy,
  MIN_INTERVAL_MS,
} from '../src/schedule.js';
import { scheduleEventsPath } from '../src/daemon.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(REPO, 'bin', 'ox.js');

const SHORT_TMP = fs.existsSync('/tmp') && fs.statSync('/tmp').isDirectory() ? '/tmp' : os.tmpdir();

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
];

function sandbox(t, tag) {
  const root = fs.mkdtempSync(path.join(SHORT_TMP, `oxreg-${tag}-`));
  const home = path.join(root, 'home');
  const daemon = path.join(root, 'd');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, NO_COLOR: '1', OX_NO_BANNER: '1', HOME: home, OX_DAEMON_DIR: daemon };
  for (const k of SCRUB) delete env[k];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, daemon, env };
}

// In-process store access needs this process pointed at the sandbox too:
// src/daemon.js resolves every schedule path lazily from homedir()/OX_DAEMON_DIR.
function here(t, tag) {
  const sb = sandbox(t, tag);
  const saved = { HOME: process.env.HOME, OX_DAEMON_DIR: process.env.OX_DAEMON_DIR };
  process.env.HOME = sb.home;
  process.env.OX_DAEMON_DIR = sb.daemon;
  t.after(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.OX_DAEMON_DIR === undefined) delete process.env.OX_DAEMON_DIR;
    else process.env.OX_DAEMON_DIR = saved.OX_DAEMON_DIR;
  });
  return sb;
}

// Append a hand-written event, the way a corrupted log or a future writer would.
function rawEvent(obj) {
  fs.mkdirSync(path.dirname(scheduleEventsPath()), { recursive: true });
  fs.appendFileSync(scheduleEventsPath(), JSON.stringify({ v: 1, ...obj }) + '\n', { mode: 0o600 });
}

const INTERVAL = (ms) => ({ kind: 'interval', everyMs: ms });

// ---------------------------------------------------------------------------
// FIX 1 — Number(null) === 0 turned an ABSENT nextRunAt into 1 Jan 1970
// ---------------------------------------------------------------------------
//
// The mechanism: `Number(null)` is 0, so a normalizer written as
//
//     nextRunAt: Number.isFinite(Number(raw.nextRunAt)) ? Number(raw.nextRunAt) : null
//
// maps a missing field to 0 rather than to null. 0 is always <= now, so every row
// that omitted the field was PERMANENTLY DUE from the moment it loaded. With the
// daemon opted in, the first tick dispatched all of them at once: the "silent
// unattended execution" outcome the whole two-gate design exists to prevent.
//
// The guard is the property, not the implementation: an absent field must read as
// "no next run", and a schedule with no next run must never be in `dueSchedules`
// even when the daemon is fully opted in and the row is enabled.

test('an absent nextRunAt reads as null and is never due, even opted in', (t) => {
  here(t, 'null-next');

  rawEvent({
    t: 'add',
    schedule: {
      id: 'aaaa1111',
      kind: 'schedule',
      prompt: 'written without a nextRunAt at all',
      cwd: '/tmp',
      cadence: { kind: 'interval', everyMs: MIN_INTERVAL_MS, description: 'every 1s' },
      enabled: true,
      // An EXPLICIT JSON null, which is how a store that serializes "no next run"
      // actually writes the field. This is the shape that turned into 0.
      nextRunAt: null,
      maxCostUsd: 0.25,
      costCapSource: 'default',
    },
  });
  // And the field omitted entirely, which is the shape a hand-edited or older
  // log has. Number(undefined) is NaN, so that half was always safe — the guard
  // exists for the explicit null, and both are asserted so neither can regress.
  rawEvent({
    t: 'add',
    schedule: {
      id: 'cccc3333',
      kind: 'schedule',
      prompt: 'written with the field omitted',
      cwd: '/tmp',
      cadence: { kind: 'interval', everyMs: MIN_INTERVAL_MS, description: 'every 1s' },
      enabled: true,
      maxCostUsd: 0.25,
      costCapSource: 'default',
    },
  });

  const row = getSchedule('aaaa1111');
  assert.ok(row, 'the row must load');
  assert.equal(row.nextRunAt, null, 'a null nextRunAt must read as null, never as 0');
  assert.notEqual(row.nextRunAt, 0, '0 would mean "due since 1970"');
  assert.equal(getSchedule('cccc3333').nextRunAt, null, 'an omitted nextRunAt must read as null too');

  // The daemon opted in and the row enabled: the strongest possible conditions.
  assert.equal(readPolicy().optedIn, false, 'precondition: a fresh daemon is not opted in');
  assert.deepEqual(dueSchedules({ now: Date.now() }), []);
  writePolicy({ optedIn: true });
  const due = dueSchedules({ now: Date.now() });
  assert.deepEqual(due.map((s) => s.id), [], 'a row with no next run time must never be due');
  // The clock is not the mechanism here: 0 is 55 years in the past, so the
  // mutation is caught by the null check above long before it becomes a run.

  // And the other half of the same trap: an absent cap must not read as $0.
  // "$0" is a budget of nothing; "no cap recorded" is a different statement.
  assert.equal(row.maxCostUsd, 0.25);
  rawEvent({
    t: 'add',
    schedule: {
      id: 'bbbb2222',
      kind: 'schedule',
      prompt: 'written without a cap',
      cwd: '/tmp',
      cadence: { kind: 'interval', everyMs: MIN_INTERVAL_MS, description: 'every 1s' },
      enabled: false,
    },
  });
  const uncapped = getSchedule('bbbb2222');
  assert.equal(uncapped.maxCostUsd, null, 'an absent cap must read as null, never as $0');
  assert.deepEqual(schedulePassthrough(uncapped), [], 'an uncapped schedule must not be sent --max-cost 0');
});

// ---------------------------------------------------------------------------
// FIX 2 — one Math.random() draw per id meant two schedules could share an id,
// and the second `add` silently overwrote the first
// ---------------------------------------------------------------------------
//
// The mechanism: `loadSchedules` folds the log into a Map keyed by id, so two
// rows with one id cannot both survive — the later `add` wins and the earlier
// schedule is gone with no error anywhere. The id used to be derived entirely
// from a single PRNG draw, so ANY repeat of that draw lost a schedule: a stubbed
// `Math.random`, a seeded fixture, or simply bad luck.
//
// The guard stubs the PRNG to a constant — the case that destroyed rows — and
// requires that every schedule created is still readable afterwards with its own
// prompt intact. A row that cannot be named is a row that has been lost.

test('a degenerate PRNG cannot collide two schedule ids, so no row is lost', (t) => {
  here(t, 'ids');

  const realRandom = Math.random;
  Math.random = () => 0;
  let ids;
  try {
    ids = [];
    for (let i = 0; i < 16; i++) {
      const res = addSchedule({ prompt: `stubbed-prng job ${i}`, cadence: INTERVAL(30_000) });
      assert.ok(!res.refusal, res.refusal);
      ids.push(res.schedule.id);
    }
  } finally {
    Math.random = realRandom;
  }

  assert.equal(new Set(ids).size, 16, `ids collided under a constant PRNG: ${ids.join(', ')}`);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/);

  // Re-read from disk, in a fresh fold, not from the return values.
  const rows = loadSchedules();
  assert.equal(rows.length, 16, `schedules were lost: folded ${rows.length} of 16`);
  for (let i = 0; i < 16; i++) {
    assert.ok(rows.some((r) => r.prompt === `stubbed-prng job ${i}`), `lost the prompt for job ${i}`);
  }
  // Every id must still resolve to its OWN row.
  for (let i = 0; i < 16; i++) {
    assert.equal(getSchedule(ids[i])?.prompt, `stubbed-prng job ${i}`, `id ${ids[i]} resolves to the wrong row`);
  }
});

// ---------------------------------------------------------------------------
// FIX 3 — the slash-command verb parser took the WHOLE argument as the verb
// ---------------------------------------------------------------------------
//
// The mechanism: `/schedule add 30s test` has `rest === 'add 30s test'`. Reading
// the verb as `rest.trim().toLowerCase()` compares the verb against the WHOLE
// string, so it matched nothing and fell through to "unknown verb". Every verb
// that takes an argument was therefore unreachable, and only the bare,
// argument-less ones (`/schedule`, `/schedule list`) worked. That is also true of
// `/cron` and `/heartbeat`, which share the parser.
//
// The guard drives the real REPL over a pipe and checks the store, because a
// source-shape assertion would keep passing if the parser moved. With the bug
// present, `/schedule add 30s test` prints an unknown-verb error and creates
// nothing, so the store comes back empty.

test('/schedule add <cadence> <prompt> is reachable: the verb is the first token', (t) => {
  // `here`, not `sandbox`: the child writes to the sandbox's daemon dir and this
  // process must fold the same log, or the assertion would be reading the
  // developer's real store (which is exactly what must never happen here).
  const sb = here(t, 'verb');

  const repl = spawnSync(process.execPath, [OX_BIN], {
    cwd: sb.home,
    env: sb.env,
    input: '/schedule add 30s regression probe\n/schedule list\n/exit\n',
    encoding: 'utf8',
    timeout: 90_000,
  });
  const out = `${repl.stdout}${repl.stderr}`;

  assert.doesNotMatch(out, /unknown \/schedule verb 'add 30s test'/, 'the whole argument was taken as the verb');
  const job = listSchedules().find((s) => s.prompt === 'regression probe');
  assert.ok(job, `the row was never created — nothing in \`ox schedule add 30s "regression probe"\`:\n${out}`);
  assert.equal(job.cadence.kind, 'interval');
  assert.equal(job.cadence.everyMs, 30_000, 'the leading cadence token must be consumed as the cadence');
  assert.equal(job.enabled, false, 'a slash-command add is still created disabled');

  // The same shape through /cron, which shares the parser.
  const viaCron = spawnSync(process.execPath, [OX_BIN], {
    cwd: sb.home,
    env: sb.env,
    input: '/cron add 45s second probe\n/schedule list\n/exit\n',
    encoding: 'utf8',
    timeout: 90_000,
  });
  const out2 = `${viaCron.stdout}${viaCron.stderr}`;
  assert.doesNotMatch(out2, /unknown \/schedule verb 'add 45s second probe'/);
  const second = listSchedules().find((s) => s.prompt === 'second probe');
  assert.ok(second, `/cron add with a cadence and a prompt created nothing:\n${out2}`);
  assert.equal(second.cadence.everyMs, 45_000);
});

// ---------------------------------------------------------------------------
// FIX 4 — `ox skill curate` called `currentCrontab()`, which no longer exists
// ---------------------------------------------------------------------------
//
// The mechanism: the crontab installer was removed from the schedule module, but
// `curateSkills` was still called with `crontab: currentCrontab()` to work out
// which skills are crontab-scheduled and therefore immune to curation. The
// function was gone, so the identifier was a free variable: every
// `ox skill curate` — both the dry run and the applying path — died with a
// ReferenceError before doing anything at all.
//
// The guard is the command itself, on both paths, asserting exit 0. A curator
// that crashes has archived nothing and curated nothing, so the check is the exit
// code rather than any particular row.

test('ox skill curate runs on both paths: no dangling currentCrontab() reference', (t) => {
  const sb = sandbox(t, 'curate');
  const skills = path.join(sb.home, '.ox', 'skills', 'regression-probe');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '# probe\n\nA skill to curate.\n');

  const dry = spawnSync(process.execPath, [OX_BIN, 'skill', 'curate', '--dry-run'], {
    cwd: sb.home,
    env: sb.env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  const dryOut = `${dry.stdout}${dry.stderr}`;
  assert.doesNotMatch(dryOut, /currentCrontab is not defined/, 'the dangling call came back');
  assert.doesNotMatch(dryOut, /ReferenceError/);
  assert.equal(dry.status, 0, `the dry run must exit 0:\n${dryOut}`);

  const applied = spawnSync(process.execPath, [OX_BIN, 'skill', 'curate'], {
    cwd: sb.home,
    env: sb.env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  const appliedOut = `${applied.stdout}${applied.stderr}`;
  assert.doesNotMatch(appliedOut, /currentCrontab is not defined/);
  assert.doesNotMatch(appliedOut, /ReferenceError/);
  assert.equal(applied.status, 0, `the applying path must exit 0:\n${appliedOut}`);
  assert.match(applied.stdout, /skill curation pass/, 'it must actually curate, not just not crash');
});

// ---------------------------------------------------------------------------
// The natural-language cadence reader the `ox cron` surface depends on
// ---------------------------------------------------------------------------
//
// `parseNaturalCadence` used to live in src/cron-scheduler.js with its own
// multiplier table. It is now in src/schedule.js next to INTERVAL_UNITS, and it
// is the only thing that turns `ox cron add "every minute"` into a real cadence.
// Every result must be one of the two explicit cadences `computeNextRun` can walk
// exactly — never a cron expression, which is the bug the old parser's
// `computeNextRun` walk could livelock on.

test('natural-language cadence resolves to an exact interval or wall-clock time', (t) => {
  here(t, 'natural');

  const cases = [
    ['every minute', 60_000],
    ['every 5 minutes', 300_000],
    ['every 30s', 30_000],
    ['every 2h', 7_200_000],
    ['every 3 hours', 10_800_000],
  ];
  for (const [text, ms] of cases) {
    const got = parseNaturalCadence(text);
    assert.ok(!got.refusal, `"${text}" refused: ${got.refusal}`);
    assert.equal(got.cadence.kind, 'interval', `"${text}" must resolve to an interval`);
    assert.equal(got.cadence.everyMs, ms, `"${text}" resolved to ${got.cadence.everyMs}ms`);
    assert.ok(got.cadence.everyMs >= MIN_INTERVAL_MS, `"${text}" is below the floor`);
  }

  const daily = parseNaturalCadence('nightly at 07:30');
  assert.ok(!daily.refusal, daily.refusal);
  assert.equal(daily.cadence.kind, 'at');
  assert.equal(daily.cadence.at, '07:30');
  assert.equal(daily.cadence.oneShot, undefined, 'a daily time is recurring, not one-shot');

  for (const text of ['', 'whenever', 'every fortnight', 'do the thing every so often']) {
    const got = parseNaturalCadence(text);
    assert.ok(got.refusal, `"${text}" must be refused rather than guessed at`);
  }
});

// ---------------------------------------------------------------------------
// The claim gate: attended vs unattended
// ---------------------------------------------------------------------------
//
// `run-now` / `ox cron run` is a human asking for one run from a terminal.
// Unattended dispatch stays fully gated. This is the test that keeps the two
// apart, because the relaxation is the only weakening anywhere in this migration
// and it is only safe while the unattended path is untouched.

test('an attended claim runs a not-yet-due row; an unattended one still refuses', (t) => {
  here(t, 'attended');

  const added = addSchedule({ prompt: 'attended probe', cadence: INTERVAL(3_600_000), enabled: true });
  assert.ok(!added.refusal, added.refusal);
  const id = added.schedule.id;
  assert.ok(getSchedule(id).nextRunAt > Date.now(), 'precondition: the row is NOT due — its next run is an hour out');

  // Unattended (the default trigger, i.e. the timer): refused twice over — no
  // opt-in, and not due. Both refusals are real and neither is relaxed.
  const unattended = claimSchedule(id, { now: Date.now() });
  assert.ok(unattended.refusal, 'an unattended claim must not run a not-yet-due row');
  assert.match(unattended.refusal, /opt-in/, 'the daemon-wide opt-in must still gate unattended claims');

  writePolicy({ optedIn: true });
  assert.match(claimSchedule(id, { now: Date.now() }).refusal, /not due yet/, 'opted in is still not a licence to run early');

  // Attended: a person said run it. It claims, advances nextRunAt and is not
  // filed as a miss — "the daemon was not running" is not why it happened.
  const attended = claimSchedule(id, { now: Date.now(), trigger: 'manual', attended: true });
  assert.ok(!attended.refusal, `an attended claim must run: ${attended.refusal}`);
  assert.equal(attended.schedule.misses, 0, 'an attended run is not a miss');
  assert.equal(attended.schedule.lastRun.state, 'claimed');
  assert.ok(getSchedule(id).nextRunAt > Date.now(), 'the claim advanced the next run');

  // The per-row gate is NOT relaxed by `attended`: a disabled row stays off.
  const off = addSchedule({ prompt: 'deliberately off', cadence: INTERVAL(30_000), enabled: false });
  assert.ok(claimSchedule(off.schedule.id, { trigger: 'manual', attended: true }).refusal, 'a disabled row must stay disabled');
  assert.match(claimSchedule(off.schedule.id, { trigger: 'manual', attended: true }).refusal, /disabled/);

  // And with the daemon opted OUT again, the timer sees nothing at all.
  writePolicy({ optedIn: false });
  assert.deepEqual(dueSchedules({ now: Date.now() }), [], 'opted out must dispatch nothing, attended or not');
});
