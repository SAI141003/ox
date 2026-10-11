// "Never forgets": every silent memory-destruction path in the memory
// subsystem must either ARCHIVE (recoverable) or emit a VISIBLE notice.
//
// One test per confirmed path, in the order the audit listed them:
//   1. writeEpisode past the .agent/ size cap     -> archive, caller can tell
//   2. the 21st checkpoint                          -> archive, not rmSync
//   3. the 21st pattern of a type                  -> archive, not splice
//   4. two episodes, same date + same slug         -> two files, both intact
//   5. pruneSessions past the age threshold        -> archive, not unlink
//   6. the loss ledger records each event and NEVER carries file content
//   7. a clean run writes nothing at all            -> empty ledger, no churn
//
// Everything runs against a temp HOME, so the real ~/.ox/audit.jsonl and the
// real ~/.ox/memory-loss.jsonl are never touched. HOME is set BEFORE the
// dynamic imports because config.js captures os.homedir() at module load.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-loss-'));
process.env.HOME = HOME_SANDBOX;

const { writeEpisode, writeSessionNote, archiveFile, loadMemoryBlock } = await import('../src/memory.js');
const { recordPattern, proceduralStats } = await import('../src/procedural-memory.js');
const { pruneSessions, createSession, appendEvent } = await import('../src/session.js');
const {
  recordLoss,
  lossLedgerPath,
  readLossLedger,
  lossStats,
  resetLossStats,
  projectKeyFor,
} = await import('../src/memory-loss.js');
const { MAX_AGENT_DIR_BYTES, MAX_CHECKPOINTS, MAX_INDEX_LINES } = await import('../src/memory.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

const LEDGER = lossLedgerPath();

// Distinctive strings planted in every artefact, so test 6 can prove the ledger
// never carries CONTENT -- only paths, reasons and counts.
const M = {
  overflow: 'ZEBRAFISHMARKEROVERFLOW',
  ckpt1: 'QUOKKAMARKERCHECKPOINT01',
  ckpt2: 'WOMBATMARKERCHECKPOINT02',
  pattern: 'NARWHALMARKERPATTERN',
  collide: 'PANGOLINMARKERCOLLIDE',
  session: 'AXOLOTLMARKERSESSION',
  secretish: 'SEXTANTMARKERSECRETISH',
};

function sandbox(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Each test owns the ledger: a fresh file and a fresh in-process tally, so the
// tests do not depend on each other's order.
function freshLedger() {
  fs.rmSync(LEDGER, { force: true });
  resetLossStats();
  return LEDGER;
}

function rows() {
  return readLossLedger({ limit: 1000 });
}

// Every file under `dir`, as paths relative to `dir`, for before/after
// comparisons. A missing directory is an empty list, not a throw.
function listFilesRecursive(dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(next);
      else out.push(next);
    }
  };
  walk('');
  return out.sort();
}

function rowsFor(event) {
  return rows().filter((r) => r.event === event);
}

// Collects the stderr notices the memory modules emit alongside each ledger row.
function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk, enc, cb) => {
    chunks.push(String(chunk));
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done) done();
    return true;
  };
  try {
    return { result: fn(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

// isoStamp() has millisecond resolution, so back-to-back writes with the same
// goal slug can land on the same name. Distinct goals keep the filenames apart
// regardless; this just removes timing from the equation entirely.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ===========================================================================
// 1. the .agent/ size cap must ARCHIVE, never drop
// ===========================================================================

test('1. past the .agent size cap the episode is ARCHIVED and the caller is told', (t) => {
  const dir = sandbox(t, 'ox-loss-cap-');
  const adir = path.join(dir, '.agent');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'blob.bin'), Buffer.alloc(MAX_AGENT_DIR_BYTES + 100 * 1024));

  const { result, stderr } = captureStderr(() =>
    writeEpisode(dir, { goal: `overflow goal ${M.overflow}`, outcome: 'kept out of the cap' })
  );

  // (a) the caller can distinguish written / archived / refused-with-reason
  assert.equal(result.ok, true);
  assert.equal(result.status, 'archived');
  assert.match(result.reason, /^agent-dir-over-500KB$/);
  assert.equal(typeof result.path, 'string');
  assert.match(result.message, /archived/i);

  // (b) the archive is a REAL, DISCOVERABLE path outside the capped directory
  const expectedRoot = path.join(os.homedir(), '.ox', 'archive', 'agent-overflow', projectKeyFor(dir));
  assert.equal(result.path.startsWith(expectedRoot), true, `not under ${expectedRoot}: ${result.path}`);
  assert.equal(result.path.startsWith(adir), false, 'archived back inside the capped dir');
  assert.equal(fs.existsSync(path.dirname(result.path)), true, 'the archive directory does not exist');

  // (c) the CONTENT is recoverable, in full
  const body = fs.readFileSync(result.path, 'utf8');
  assert.match(body, new RegExp(M.overflow));
  assert.match(body, /- outcome: kept out of the cap/);
  assert.match(body, /# Episode \d{4}-\d{2}-\d{2}/);

  // (d) a notice was emitted, not just a return value
  assert.match(stderr, /ox: memory-loss: episode ARCHIVED, not dropped/, stderr);
  assert.match(stderr, /ox: memory-loss/, stderr);

  // (e) and it is in the ledger with the archive path
  const evs = rowsFor('agent-dir-overflow');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].archive, result.path);
  assert.equal(lossStats().archived, 1);
});

test('1b. an episode under the cap is still WRITTEN in place, with no churn', (t) => {
  const dir = sandbox(t, 'ox-loss-under-');
  freshLedger();
  const res = writeEpisode(dir, { goal: 'a small ordinary episode', outcome: 'fine' });
  assert.equal(res.status, 'written');
  assert.equal(res.path.startsWith(path.join(dir, '.agent', 'episodes')), true);
  assert.deepEqual(rows(), [], 'a clean write produced ledger churn');
  assert.equal(lossStats().events, 0);
});

// ===========================================================================
// 2. the 21st checkpoint must ARCHIVE, not rmSync
// ===========================================================================

test('2. writing checkpoint 21 archives the oldest; 20 remain AND the archive is readable', (t) => {
  const dir = sandbox(t, 'ox-loss-ckpt-');
  freshLedger();

  const goals = [];
  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    goals.push(`checkpoint ${String(i).padStart(2, '0')} marker-${i}`);
    sleepSync(2);
    const { result } = captureStderr(() =>
      writeSessionNote(dir, { phase: 'prune-test', goal: goals[i - 1], status: 'ok', model: 'm' })
    );
    assert.equal(result, true, `note ${i} was not written`);
  }

  const notesDir = path.join(dir, '.agent', 'notes');
  const archiveDir = path.join(notesDir, 'archive');
  const live = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort();
  const archived = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((f) => f.endsWith('.md')).sort() : [];

  assert.equal(live.length, MAX_CHECKPOINTS, `expected ${MAX_CHECKPOINTS} live notes: ${live.join(', ')}`);
  assert.equal(archived.length, 1, `expected exactly 1 archived note: ${archived.join(', ')}`);

  // The oldest is the one that was archived. Whole-token matching, not
  // substring: `marker-1` is a prefix of `marker-10`..`marker-19`, which are
  // all still live, so the old `includes('marker-1')` test could only ever
  // fail -- it was not checking that anything had been archived at all.
  assert.match(archived[0], /marker-1(?!\d)/, archived[0]);
  assert.equal(live.some((f) => /marker-1(?!\d)/.test(f)), false, 'the oldest note is still in the live dir');
  assert.ok(live.some((f) => /marker-21(?!\d)/.test(f)), `the newest note is missing: ${live.join(', ')}`);
  assert.ok(live.some((f) => /marker-20(?!\d)/.test(f)), `newest should be kept: ${live.join(', ')}`);

  // ...and the live set is exactly markers 2..21: only the oldest was moved.
  const liveMarkers = live
    .map((f) => Number(/marker-(\d+)(?!\d)/.exec(f)?.[1]))
    .sort((a, b) => a - b);
  assert.deepEqual(liveMarkers, Array.from({ length: MAX_CHECKPOINTS }, (_, i) => i + 2), live.join(', '));

  // RECOVERABLE: the archived note still has its full body
  const archivedBody = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8');
  assert.match(archivedBody, /# Checkpoint prune-test/);
  assert.match(archivedBody, /- Goal: checkpoint 01 marker-1/);
  assert.match(archivedBody, /- Status: ok/);
  assert.match(archivedBody, /## Next steps/);

  // all 20 survivors are still readable too
  for (const f of live) {
    assert.ok(fs.readFileSync(path.join(notesDir, f), 'utf8').includes('# Checkpoint prune-test'), f);
  }

  // notice + ledger + counter
  const evs = rowsFor('checkpoint-evicted');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'checkpoints');
  assert.equal(fs.existsSync(evs[0].artifact), false, 'the victim was deleted rather than moved');
  assert.equal(fs.readFileSync(evs[0].archive, 'utf8').includes('marker-1'), true);
  assert.equal(lossStats().archived, 1);
});

test('2b. the checkpoint eviction is ANNOUNCED on stderr', (t) => {
  const dir = sandbox(t, 'ox-loss-ckpt2-');
  freshLedger();
  let stderr = '';
  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    sleepSync(2);
    const cap = captureStderr(() =>
      writeSessionNote(dir, { phase: 'p', goal: `notice check ${i}`, status: 'ok', model: 'm' })
    );
    stderr += cap.stderr;
  }
  assert.match(stderr, /ox: memory-loss: archived 1 checkpoint\(s\)/, stderr);
  assert.match(stderr, /nothing deleted|\(nothing deleted\)/, stderr);
  assert.match(stderr, /\.agent|notes\/archive/, stderr);
});

// ===========================================================================
// 3. the 21st pattern of a type must ARCHIVE, not splice
// ===========================================================================

test('3. exceeding 20 patterns of a type archives the evicted ones', (t) => {
  const dir = sandbox(t, 'ox-loss-pat-');
  freshLedger();

  let last;
  const evictions = [];
  for (let i = 0; i < 25; i++) {
    last = recordPattern({ cwd: dir, taskType: 'code', pattern: `pattern ${i} ${M.pattern}`, success: true });
    evictions.push(last.evicted);
  }
  assert.equal(last.recorded, true);
  // `evicted` is a PER-CALL count: every call past the cap trims exactly one
  // pattern to get back under it. 25 records against a cap of 20 overflow on
  // calls 21..25, so five calls evict one each -- not one call evicting five.
  assert.equal(
    evictions.filter((n) => n === 1).length,
    5,
    `expected 5 overflowing calls, got per-call: ${evictions.join(',')}`
  );
  assert.equal(evictions.slice(0, 20).every((n) => n === 0), true, 'a call under the cap evicted something');
  assert.equal(last.evicted, 1, `expected the last call to evict 1, got ${last.evicted}`);
  assert.equal(evictions.reduce((a, b) => a + b, 0), 5, 'expected 5 evictions in total');
  assert.equal(typeof last.archive, 'string', 'the eviction was not reported with an archive path');

  // the live store still holds exactly the cap
  const body = fs.readFileSync(path.join(dir, '.agent', 'procedural.md'), 'utf8');
  assert.equal((body.match(/^-\s+/gm) ?? []).length, 20);
  assert.match(body, /\(20 successful/);
  assert.equal(body.includes(`pattern 0 ${M.pattern}`), false, 'the oldest pattern is still live');

  // RECOVERABLE: every evicted pattern is on disk, in full. Each overflowing
  // call archives under its own timestamp, so the five evicted patterns live
  // in five archive files, one per call.
  const archiveDir = path.join(dir, '.agent', 'archive', 'procedural');
  const archiveFiles = fs.readdirSync(archiveDir).sort();
  assert.equal(archiveFiles.length, 5, `expected 5 archive files, got ${archiveFiles.join(', ')}`);
  const archived = archiveFiles.map((f) => fs.readFileSync(path.join(archiveDir, f), 'utf8')).join('\n');
  assert.match(archived, /# Archived procedural patterns \(code\)/);
  for (let i = 0; i < 5; i++) {
    assert.match(archived, new RegExp(`pattern ${i} ${M.pattern}`), `pattern ${i} missing from the archive`);
  }

  // notice + ledger
  const evs = rowsFor('pattern-evicted');
  assert.equal(evs.length, 5, JSON.stringify(rows()));
  for (const e of evs) {
    assert.equal(e.store, 'procedural');
    assert.equal(e.action, 'archived');
  }
  assert.ok(evs.some((e) => e.archive === last.archive), 'the last eviction is not in the ledger');
  assert.equal(lossStats().archived, 5, JSON.stringify(lossStats()));
  assert.equal(proceduralStats({ cwd: dir }).totalPatterns, 20);
});

test('3b. under the pattern cap nothing is archived and nothing is evicted', (t) => {
  const dir = sandbox(t, 'ox-loss-pat-under-');
  freshLedger();
  const r = recordPattern({ cwd: dir, taskType: 'code', pattern: 'only one pattern', success: true });
  assert.equal(r.evicted, 0);
  assert.equal(r.archive, null);
  assert.deepEqual(rows(), []);
  assert.equal(fs.existsSync(path.join(dir, '.agent', 'archive')), false, 'an archive dir was created spuriously');
});

// ===========================================================================
// 4. same date + same slug must never collide
// ===========================================================================

test('4. two episodes with the same date and slug both survive, in full', (t) => {
  const dir = sandbox(t, 'ox-loss-collide-');
  freshLedger();
  const epDir = path.join(dir, '.agent', 'episodes');

  const a = writeEpisode(dir, {
    goal: `identical goal ${M.collide}`,
    outcome: `first outcome ${M.collide}`,
    lessons: [`first lesson ${M.collide}`],
  });
  const b = writeEpisode(dir, {
    goal: `identical goal ${M.collide}`,
    outcome: `second outcome ${M.collide}`,
    lessons: [`second lesson ${M.collide}`],
  });
  assert.equal(a.status, 'written', a.message);
  assert.equal(b.status, 'written', b.message);
  assert.notEqual(a.path, b.path, 'both episodes landed on the same file');

  const files = fs.readdirSync(epDir).filter((f) => f.endsWith('.md')).sort();
  assert.equal(files.length, 2, `both episodes on disk: ${files.join(', ')}`);

  // both bodies, in full, with NOTHING trimmed
  const bodies = files.map((f) => fs.readFileSync(path.join(epDir, f), 'utf8'));
  assert.equal(bodies.filter((x) => x.includes(`first outcome ${M.collide}`)).length, 1);
  assert.equal(bodies.filter((x) => x.includes(`second outcome ${M.collide}`)).length, 1);
  assert.equal(bodies.filter((x) => x.includes(`first lesson ${M.collide}`)).length, 1);
  assert.equal(bodies.filter((x) => x.includes(`second lesson ${M.collide}`)).length, 1);
  for (const body of bodies) {
    assert.equal(body.includes('[earlier episodes trimmed]'), false, 'an episode was trimmed');
    assert.equal(body.includes(`## Files touched`), true);
    assert.equal(body.includes(`## Lessons`), true);
    assert.ok(body.split('\n').length <= 40, 'an episode exceeded the 40-line cap');
  }

  // the split is recorded, so the collision is visible rather than silent
  const evs = rowsFor('episode-name-taken');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'uniquified');
  assert.equal(lossStats().uniquified, 1);
});

test('4b. three same-slug episodes on one date all survive', (t) => {
  const dir = sandbox(t, 'ox-loss-collide3-');
  freshLedger();
  for (const outcome of ['alpha', 'beta', 'gamma']) {
    writeEpisode(dir, { goal: 'triple collision goal', outcome });
    sleepSync(1);
  }
  const epDir = path.join(dir, '.agent', 'episodes');
  const bodies = fs
    .readdirSync(epDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => fs.readFileSync(path.join(epDir, f), 'utf8'));
  assert.equal(bodies.length, 3);
  for (const outcome of ['alpha', 'beta', 'gamma']) {
    assert.equal(bodies.filter((b) => b.includes(`- outcome: ${outcome}`)).length, 1, `${outcome} was lost`);
  }
});

// ===========================================================================
// 5. pruneSessions must ARCHIVE, not unlink
// ===========================================================================

test('5. pruning sessions older than the threshold archives them, and they are recoverable', (t) => {
  freshLedger();
  const dir = sandbox(t, 'ox-loss-sess-');
  const sessionsDir = path.join(os.homedir(), '.ox', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  const old = createSession(dir, { label: 'old' });
  appendEvent(old, { t: 'user', content: `historic transcript ${M.session}` });
  const fresh = createSession(dir, { label: 'fresh' });
  appendEvent(fresh, { t: 'user', content: 'today transcript' });

  const ninetyDaysAgo = Date.now() - 120 * 86_400_000;
  fs.utimesSync(old.file, ninetyDaysAgo / 1000, ninetyDaysAgo / 1000);

  const res = pruneSessions({ olderThanDays: 90 });

  assert.equal(res.mode, 'archive', 'delete must not be the default');
  assert.equal(res.archived.length, 1, JSON.stringify(res));
  assert.equal(res.kept.length, 0);
  assert.equal(fs.existsSync(old.file), false, 'the aged transcript was removed from the active dir');
  assert.equal(fs.existsSync(fresh.file), true, 'a recent transcript was touched');

  // RECOVERABLE: the bytes are on disk, intact, inside the sessions tree
  const archiveDir = path.join(sessionsDir, 'archive');
  const archived = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(archived.length, 1, archived.join(', '));
  assert.match(archived[0], /^\d{4}-\d{2}-\d{2}T/, 'the archive name is not timestamped');
  const text = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8');
  assert.match(text, new RegExp(M.session), 'the transcript content did not survive');
  assert.equal(fs.existsSync(res.archived[0]), false);

  // ledger + counter
  const evs = rowsFor('transcript-aged');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'sessions');
  assert.equal(fs.readFileSync(evs[0].archive, 'utf8').includes(M.session), true);
  assert.equal(lossStats().archived, 1);
});

test('5b. pruneSessions announces the ARCHIVE, and dry-run moves nothing', (t) => {
  freshLedger();
  const dir = sandbox(t, 'ox-loss-sess2-');
  const sessionsDir = path.join(os.homedir(), '.ox', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  const old = createSession(dir, {});
  appendEvent(old, { t: 'user', content: 'dry run marker' });
  const ninetyDaysAgo = Date.now() - 120 * 86_400_000;
  fs.utimesSync(old.file, ninetyDaysAgo / 1000, ninetyDaysAgo / 1000);

  const dry = pruneSessions({ olderThanDays: 90, dryRun: true });
  assert.equal(dry.deleted.length, 1);
  assert.deepEqual(dry.archived, [], 'a dry run claimed to archive something');
  assert.equal(fs.existsSync(old.file), true, 'a dry run moved a file');

  const { result, stderr } = captureStderr(() => pruneSessions({ olderThanDays: 90 }));
  assert.equal(result.archived.length, 1);
  // ...and it is ANNOUNCED, as the test name claims. The lost line was this
  // assertion: assert.match() was handed a number and threw before it ran.
  assert.match(stderr, /ox: memory-loss: ARCHIVED 1 session transcript\(s\)/, stderr);
  assert.match(stderr, /nothing deleted/, stderr);
});

test('5c. permanent deletion exists only as an explicit opt-in, and is recorded', (t) => {
  freshLedger();
  const dir = sandbox(t, 'ox-loss-sess3-');
  const sessionsDir = path.join(os.homedir(), '.ox', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  const old = createSession(dir, {});
  appendEvent(old, { t: 'user', content: 'delete me' });
  const ninetyDaysAgo = Date.now() - 120 * 86_400_000;
  fs.utimesSync(old.file, ninetyDaysAgo / 1000, ninetyDaysAgo / 1000);

  const { result, stderr } = captureStderr(() => pruneSessions({ olderThanDays: 90, mode: 'delete' }));
  assert.equal(result.mode, 'delete');
  assert.equal(fs.existsSync(old.file), false);
  // even the opt-in is never silent
  assert.match(stderr, /ox: memory-loss: DELETED/, stderr);
  const evs = rowsFor('transcript-deleted');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'deleted');
});

// ===========================================================================
// 6. the ledger: queryable, and structurally unable to carry content
// ===========================================================================

test('6. every event above is in the ledger, and the ledger NEVER contains file content', async (t) => {
  const dir = sandbox(t, 'ox-loss-ledger-');
  freshLedger();

  // --- episode cap -------------------------------------------------------
  const adir = path.join(dir, '.agent');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'blob.bin'), Buffer.alloc(MAX_AGENT_DIR_BYTES + 64 * 1024));
  const capRes = captureStderr(() =>
    writeEpisode(dir, { goal: `ledger overflow ${M.overflow}`, outcome: 'archived' })
  );

  // --- checkpoint cap ----------------------------------------------------
  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    sleepSync(2);
    writeSessionNote(dir, { phase: 'p', goal: `ledger checkpoint ${i} ${i === 1 ? M.ckpt1 : M.ckpt2}`, status: 'ok', model: 'm' });
  }

  // --- pattern cap -------------------------------------------------------
  for (let i = 0; i < 21; i++) recordPattern({ cwd: dir, taskType: 'code', pattern: `ledger pattern ${i} ${M.pattern}`, success: true });

  // --- episode collision -------------------------------------------------
  // NOT in `dir`: that tree is deliberately over the .agent/ size cap, so
  // writeEpisode routes to the overflow archive and returns before the naming
  // code ever runs -- which is why the episode-name-taken row was missing.
  // The naming path needs a tree UNDER the cap plus two writes that slugify to
  // the same name on the same date.
  const collideDir = sandbox(t, 'ox-loss-ledger-collide-');
  const collide1 = writeEpisode(collideDir, { goal: 'ledger collide', outcome: 'a' });
  sleepSync(1);
  const collide2 = writeEpisode(collideDir, { goal: 'ledger collide', outcome: 'b' });
  assert.equal(collide1.status, 'written', collide1.message);
  assert.equal(collide2.status, 'written', collide2.message);
  assert.notEqual(collide1.path, collide2.path, 'the collision was not uniquified');
  const collideFiles = fs.readdirSync(path.join(collideDir, '.agent', 'episodes')).filter((f) => f.endsWith('.md'));
  assert.equal(collideFiles.length, 2, `both colliding episodes on disk: ${collideFiles.join(', ')}`);

  const all = rows();
  const events = all.map((r) => r.event);
  for (const e of ['agent-dir-overflow', 'checkpoint-evicted', 'pattern-evicted', 'episode-name-taken']) {
    assert.ok(events.includes(e), `missing ledger row for ${e}: ${events.join(', ')}`);
  }

  // queryable, and every row is the documented shape
  for (const r of all) {
    assert.equal(r.t, 'memory-loss');
    assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T/);
    for (const k of ['store', 'event', 'action', 'reason']) {
      assert.match(r[k], /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, `field ${k} is not a machine token: ${r[k]}`);
    }
  }

  // THE CONTENT ASSERTION -- same shape as the existing audit-row test in
  // memory.test.js, extended to every artefact written above.
  const raw = fs.readFileSync(LEDGER, 'utf8');
  for (const [label, marker] of Object.entries(M)) {
    assert.equal(raw.includes(marker), false, `the ledger carried ${label} content:\n${raw}`);
  }
  assert.equal(raw.includes('# Episode'), false, raw);
  assert.equal(raw.includes('# Checkpoint'), false, raw);
  assert.equal(raw.includes('- goal:'), false, raw);
  assert.equal(raw.includes('Archived procedural patterns'), false, raw);

  // ...but it DOES carry the paths and the reasons, which is the point
  assert.equal(raw.includes(capRes.result.path), true, 'the archive path is missing');
  assert.equal(raw.includes('agent-dir-over-500KB'), true, 'the reason is missing');

  // A hostile caller cannot smuggle content in through an unexpected key: the
  // row shape is built field by field, so a key the shape does not have simply
  // does not exist in the output.
  //
  // The probe values below are deliberately marker-free. `detail` is the one
  // documented prose-capable field, and `store` accepts any short opaque token,
  // so writing a file-content marker into either and then asserting the marker
  // is absent would assert something the contract does not promise. The
  // "ledger never carries content" claim is asserted above, against rows the
  // real code paths produced.
  const probeDetail = `detail-probe ${'z'.repeat(400)}`;
  recordLoss({ store: 'evil', event: 'evil', action: 'evil', reason: 'evil', note: `secret ${M.overflow}` });
  // a token field takes a short opaque token, never prose: a value that is not
  // one is replaced with 'unknown' rather than recorded verbatim
  recordLoss({ store: 'two words and a / slash', event: 'x', action: 'archived', reason: 'y' });
  recordLoss({ store: 'ok', event: 'ok', action: 'archived', reason: 'ok', detail: probeDetail });
  const after = fs.readFileSync(LEDGER, 'utf8');
  assert.equal(after.includes(M.overflow), false, `an unexpected field leaked content:\n${after}`);
  assert.equal(after.includes('"note"'), false, `an unexpected key reached the ledger:\n${after}`);
  assert.equal(after.includes('two words and a / slash'), false, `an invalid token was recorded verbatim:\n${after}`);
  // readLossLedger returns the last N rows in FILE order, so index 0 is the
  // oldest of the three and index 2 is the newest.
  const last3 = readLossLedger({ limit: 3 });
  assert.equal(last3.length, 3);
  assert.equal(last3[0].note, undefined, 'an unexpected field was stored');
  assert.equal(last3[1].store, 'unknown', 'a bad token was recorded verbatim');
  assert.equal(last3[2].store, 'ok');
  assert.equal(last3[2].detail.length, 120, 'detail was not capped');
  assert.equal(last3[2].detail, probeDetail.slice(0, 120), 'detail was not truncated at exactly 120 chars');
});

test('6b. a refusal is recorded and nothing is destroyed', (t) => {
  const dir = sandbox(t, 'ox-loss-refuse-');
  freshLedger();
  const epDir = path.join(dir, '.agent', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });

  // A pre-screen episode: an artefact on disk from before the write screen.
  const dirty = path.join(epDir, '2020-01-01-legacy.md');
  const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  fs.writeFileSync(dirty, `# Episode 2020-01-01\n\n- goal: deploy\n- outcome: token ${KEY}\n`);

  const res = archiveFile(dirty, {
    destDir: path.join(dir, '.agent', 'archive', 'episodes'),
    label: 'archived episode',
    screenStore: 'the episode (.agent/episodes/)',
    store: 'episodes',
    event: 'agent-dir-overflow',
    reason: 'agent-dir-over-500KB',
  });

  assert.equal(res.archived, false);
  assert.equal(res.reason, 'screen-refused');
  assert.equal(res.kept, true);
  // THE POINT: refused is not destroyed. The artefact is still exactly where it was.
  assert.equal(fs.existsSync(dirty), true, 'a screened artefact was moved anyway');
  assert.match(fs.readFileSync(dirty, 'utf8'), new RegExp(KEY), 'the content changed on disk');

  // and the refusal is a ledger row naming the pattern CLASS only
  const evs = rowsFor('agent-dir-overflow');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'kept');
  assert.equal(evs[0].reason, 'screen-refused');
  assert.match(evs[0].detail, /GitHub token/i);
  const raw = fs.readFileSync(LEDGER, 'utf8');
  assert.equal(raw.includes('abcdefghijklmnopqrstuvwxyz'), false, `the ledger leaked the key:\n${raw}`);
  assert.equal(lossStats().kept, 1);
});

test('6c. archiveFile refuses to run without a screen', (t) => {
  const dir = sandbox(t, 'ox-loss-noscreen-');
  freshLedger();
  const src = path.join(dir, 'note.md');
  fs.writeFileSync(src, 'plain text\n');
  const res = archiveFile(src, { destDir: path.join(dir, 'archive'), store: 'x', event: 'y', reason: 'z' });
  assert.equal(res.archived, false);
  assert.equal(res.reason, 'no-screen-supplied');
  assert.equal(fs.existsSync(src), true);
  assert.deepEqual(rows(), []);
});

// ===========================================================================
// 7. a clean run produces NO ledger rows and NO archive writes
// ===========================================================================

test('7. a clean run with nothing over any cap writes nothing at all', (t) => {
  const dir = sandbox(t, 'ox-loss-clean-');
  freshLedger();

  // ~/.ox/archive is the OUT-OF-TREE archive root, and tests 1 and 6 above
  // legitimately created it. freshLedger() removes only the ledger FILE, so
  // the mere existence of the directory says nothing about this test. The
  // property that must hold is that a clean run ADDS nothing to it.
  const homeArchive = path.join(os.homedir(), '.ox', 'archive');
  const archiveBaseline = listFilesRecursive(homeArchive);

  // a modest, entirely ordinary session
  for (let i = 0; i < 3; i++) {
    writeEpisode(dir, { goal: `ordinary work item ${i}`, outcome: 'done', lessons: ['nothing unusual'] });
    sleepSync(2);
    writeSessionNote(dir, { phase: 'p', goal: `ordinary checkpoint ${i}`, status: 'ok', model: 'm' });
    recordPattern({ cwd: dir, taskType: 'code', pattern: `ordinary pattern ${i}`, success: true });
  }

  const adir = path.join(dir, '.agent');
  // no archive/ subdir anywhere under .agent
  assert.equal(fs.existsSync(path.join(adir, 'archive')), false, 'an .agent archive dir was created');
  assert.equal(fs.existsSync(path.join(adir, 'notes', 'archive')), false, 'a notes archive dir was created');
  const added = listFilesRecursive(homeArchive).filter((f) => !archiveBaseline.includes(f));
  assert.deepEqual(added, [], `a clean run wrote ${added.length} file(s) into the home archive`);
  // ...and nothing landed under THIS project's overflow key either
  assert.equal(
    fs.existsSync(path.join(homeArchive, 'agent-overflow', projectKeyFor(dir))),
    false,
    'a clean run wrote into this project\'s overflow archive'
  );

  // no ledger row, no counter movement
  assert.deepEqual(rows(), [], 'a clean run produced ledger churn');
  assert.deepEqual(lossStats(), { events: 0, archived: 0, kept: 0, refused: 0, deleted: 0, uniquified: 0 });

  // and the ordinary results are unaffected
  assert.equal(fs.readdirSync(path.join(adir, 'episodes')).length, 3);
  assert.equal(fs.readdirSync(path.join(adir, 'notes')).filter((f) => f.endsWith('.md')).length, 3);
  assert.equal(proceduralStats({ cwd: dir }).totalPatterns, 3);
});

test('7b. the MEMORY.md prompt truncation loses nothing on disk (seam documented)', (t) => {
  const dir = sandbox(t, 'ox-loss-index-');
  freshLedger();
  const adir = path.join(dir, '.agent');
  fs.mkdirSync(adir, { recursive: true });
  const lines = Array.from({ length: MAX_INDEX_LINES + 60 }, (_, i) => `line ${i + 1}`);
  const file = path.join(adir, 'MEMORY.md');
  fs.writeFileSync(file, lines.join('\n'));

  const block = loadMemoryBlock(dir);
  assert.match(block, /\[MEMORY\.md truncated/);
  // the TRUNCATION is in the injected prompt only -- the file keeps every line
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, MAX_INDEX_LINES + 60);
  // and truncation is not destruction, so it produces no ledger row
  assert.deepEqual(rows(), []);
});
