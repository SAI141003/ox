// "Never forgets" -- independent verification of every silent
// memory-destruction path, plus the loss ledger that makes each one observable.
//
// This file is deliberately SELF-CONTAINED and order-independent: every test owns
// its project sandbox, and every assertion about "nothing else was archived" is
// scoped to paths derived from that sandbox. It shares no state with any other
// test file (node runs each file in its own process) and it never touches the
// real ~/.ox or a real project .agent/: HOME is redirected to a temp dir BEFORE
// the dynamic imports, because config.js captures os.homedir() at module load.
//
// Covered, one per confirmed path:
//   1. writeEpisode past the .agent/ size cap   -> archived outside the capped
//      dir, and the caller can tell written / archived / refused
//   2. the 21st checkpoint                      -> archived to notes/archive/,
//      not rmSync'd; the 20 survivors and the archive all read back
//   3. the 21st pattern of a type              -> archived to
//      .agent/archive/procedural/, not spliced
//   4. two episodes, same date + same slug     -> two files, both complete
//   5. pruneSessions past the age threshold    -> archived into sessions/archive/,
//      not unlink'd
//   6. the loss ledger records each event and structurally cannot carry content
//   7. a clean run over no cap                 -> zero ledger rows, zero archives
//   8. dirSizeBytes is EXACT, not approximate (it used to break early at the cap,
//      so the number that decided a destructive action was not the real size)
//
// Plus the two paths found while auditing beyond the list:
//   9. promoteEpisode --force replacing a skill -> archived, not rm -rf'd
//  10. the working-memory chunk cap            -> archived, not a bare slice()

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-lossverify-'));
process.env.HOME = HOME_SANDBOX;

const {
  writeEpisode,
  writeSessionNote,
  promoteEpisode,
  archiveFile,
  dirSizeBytes,
  MAX_AGENT_DIR_BYTES,
  MAX_CHECKPOINTS,
} = await import('../src/memory.js');
const { recordPattern, proceduralStats, MAX_PATTERNS_PER_TYPE } = await import('../src/procedural-memory.js');
const { pruneSessions, createSession, appendEvent } = await import('../src/session.js');
const { HierarchicalMemory } = await import('../src/hierarchical-memory.js');
const { lossLedgerPath, readLossLedger, lossStats, resetLossStats, projectKeyFor } = await import(
  '../src/memory-loss.js'
);

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

// Planted in every artefact, so test 6 can prove the ledger carries paths and
// reasons and never content.
const MARK = {
  overflow: 'ZEBRAFISHMARKEROVERFLOW',
  ckpt: 'QUOKKAMARKERCHECKPOINT',
  pattern: 'NARWHALMARKERPATTERN',
  collide: 'PANGOLINMARKERCOLLIDE',
  transcript: 'AXOLOTLMARKERTRANSCRIPT',
  skill: 'BANDEDMARKERSKILL',
  chunk: 'CORMORANTMARKERCHUNK',
};

// A project sandbox. Nothing outside it, and never the real .agent/.
function sandbox(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

function ledgerFile() {
  return lossLedgerPath();
}

// Each test starts from an empty ledger and an empty in-process tally.
function freshLedger() {
  fs.rmSync(ledgerFile(), { force: true });
  resetLossStats();
}

function rows() {
  return readLossLedger({ limit: 1000 });
}

function rowsFor(event) {
  return rows().filter((r) => r.event === event);
}

function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk, enc, cb) => {
    chunks.push(String(chunk));
    const done = typeof enc === 'function' ? enc : cb;
    if (done) done();
    return true;
  };
  try {
    return { result: fn(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

// isoStamp() has millisecond resolution, so back-to-back writes with the same
// goal slug can otherwise land on the same filename. Distinct goals keep the
// names apart on their own; this only removes timing from the equation.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

// ===========================================================================
// 1. the .agent/ size cap must ARCHIVE, never drop
// ===========================================================================

test('1. past the .agent size cap the episode is ARCHIVED outside the capped dir, and the caller is told', (t) => {
  const dir = sandbox(t, 'ox-lv-cap-');
  freshLedger();

  // A real, exact-sized blob that puts .agent/ over the cap on its own.
  const adir = path.join(dir, '.agent');
  fs.mkdirSync(adir, { recursive: true });
  const blobBytes = MAX_AGENT_DIR_BYTES + 100 * 1024;
  fs.writeFileSync(path.join(adir, 'blob.bin'), Buffer.alloc(blobBytes));
  assert.ok(dirSizeBytes(adir) > MAX_AGENT_DIR_BYTES, 'precondition: .agent/ is over the cap');

  const { result, stderr } = captureStderr(() =>
    writeEpisode(dir, { goal: `overflow goal ${MARK.overflow}`, outcome: 'kept out of the cap', lessons: [`lesson ${MARK.overflow}`] })
  );

  // (a) the caller can distinguish written / archived / refused-with-reason
  assert.equal(result.ok, true, 'an archived episode is a success, not a silent drop');
  assert.equal(result.status, 'archived');
  assert.equal(result.reason, 'agent-dir-over-500KB');
  assert.match(result.message, /archived/i);
  assert.equal(typeof result.path, 'string');

  // (b) the archive is OUTSIDE the capped directory, so the cap does not push the
  // overflow straight back over the cap it just tripped
  const expectedRoot = path.join(os.homedir(), '.ox', 'archive', 'agent-overflow', projectKeyFor(dir));
  assert.equal(result.path.startsWith(expectedRoot), true, `${result.path} is not under ${expectedRoot}`);
  assert.equal(result.path.startsWith(adir), false, 'the overflow was archived back inside the capped dir');

  // (c) nothing was written into .agent/episodes/, and nothing was dropped
  assert.deepEqual(listMd(path.join(adir, 'episodes')), [], 'the episode was half-written into the capped dir');
  const body = fs.readFileSync(result.path, 'utf8');
  assert.match(body, new RegExp(MARK.overflow));
  assert.match(body, /- outcome: kept out of the cap/);
  assert.match(body, /# Episode \d{4}-\d{2}-\d{2}/);

  // (d) observable without reading the ledger
  assert.match(stderr, /ox: memory-loss: episode ARCHIVED, not dropped/, stderr);

  // (e) recorded in the ledger, naming the path and the reason
  const evs = rowsFor('agent-dir-overflow');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].archive, result.path);
  assert.equal(evs[0].reason, 'agent-dir-over-500KB');
  assert.equal(lossStats().archived, 1);
});

test('1b. an episode under the cap is still WRITTEN in place -- no archive, no ledger row', (t) => {
  const dir = sandbox(t, 'ox-lv-under-');
  freshLedger();

  const res = writeEpisode(dir, { goal: 'a small ordinary episode', outcome: 'fine' });

  assert.equal(res.status, 'written');
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(res.path, path.join(dir, '.agent', 'episodes', path.basename(res.path)));
  assert.equal(fs.existsSync(res.path), true);
  assert.equal(fs.readFileSync(res.path, 'utf8').includes('- outcome: fine'), true);

  // no ledger churn, and no overflow dir for THIS project was created
  assert.deepEqual(rows(), [], 'a clean write produced ledger churn');
  assert.equal(lossStats().events, 0);
  const overflowRoot = path.join(os.homedir(), '.ox', 'archive', 'agent-overflow', projectKeyFor(dir));
  assert.equal(fs.existsSync(overflowRoot), false, 'an overflow directory was created for a write that needed none');
});

// ===========================================================================
// 2. the 21st checkpoint must ARCHIVE, not rmSync
// ===========================================================================

test('2. writing checkpoint 21 archives the oldest; the 20 survivors and the archive are all readable', (t) => {
  const dir = sandbox(t, 'ox-lv-ckpt-');
  freshLedger();

  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    const { result } = captureStderr(() =>
      writeSessionNote(dir, {
        phase: 'prune-test',
        goal: `checkpoint number ${i} ${MARK.ckpt} seq${String(i).padStart(3, '0')}`,
        status: 'ok',
        model: 'm',
        decisions: [`decision ${i}`],
      })
    );
    assert.equal(result, true, `note ${i} was not written`);
    sleepSync(2);
  }

  const notesDir = path.join(dir, '.agent', 'notes');
  const archiveDir = path.join(notesDir, 'archive');
  const live = listMd(notesDir);
  const archived = listMd(archiveDir);

  assert.equal(live.length, MAX_CHECKPOINTS, `expected ${MAX_CHECKPOINTS} live notes: ${live.join(', ')}`);
  assert.equal(archived.length, 1, `expected exactly 1 archived note: ${archived.join(', ')}`);

  // seq001 is the oldest, seq021 the newest. Matched on the exact padded token:
  // 'seq001' is not a substring of any other goal in this store.
  assert.match(archived[0], /seq001/, `wrong note was archived: ${archived[0]}`);
  assert.equal(live.some((f) => f.includes('seq001')), false, 'the oldest note is still in the live dir');
  assert.ok(live.some((f) => f.includes('seq020')), `the newest survivors should be kept: ${live.join(', ')}`);
  assert.ok(live.some((f) => f.includes('seq021')), `the note just written should be live: ${live.join(', ')}`);

  // RECOVERABLE: the archived note kept its whole body, in full
  const archivedBody = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8');
  assert.match(archivedBody, /# Checkpoint prune-test/);
  assert.match(archivedBody, new RegExp(`checkpoint number 1 ${MARK.ckpt} seq001`));
  assert.match(archivedBody, /- Status: ok/);
  assert.match(archivedBody, /- decision 1/);
  assert.match(archivedBody, /## Next steps/);

  // and every survivor is readable too -- archiving one did not damage the others
  for (const f of live) {
    const raw = fs.readFileSync(path.join(notesDir, f), 'utf8');
    assert.match(raw, /# Checkpoint prune-test/, f);
    assert.match(raw, /- Model: m/, f);
  }

  // the archive is DISCOVERABLE: a sibling of the notes, named archive/
  assert.equal(path.dirname(archiveDir), notesDir);
  assert.equal(notesDir.startsWith(path.join(dir, '.agent')), true);

  // announced and recorded; the victim was MOVED, not deleted
  const evs = rowsFor('checkpoint-evicted');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'checkpoints');
  assert.equal(evs[0].reason, `over-${MAX_CHECKPOINTS}`);
  assert.equal(fs.existsSync(evs[0].artifact), false, 'the evicted note was deleted rather than moved');
  assert.equal(fs.readFileSync(evs[0].archive, 'utf8').includes('seq001'), true);
  assert.equal(lossStats().archived, 1);
});

test('2b. the checkpoint eviction is ANNOUNCED on stderr', (t) => {
  const dir = sandbox(t, 'ox-lv-ckpt2-');
  freshLedger();

  let stderr = '';
  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    const cap = captureStderr(() => writeSessionNote(dir, { phase: 'p', goal: `notice check ${i}`, status: 'ok', model: 'm' }));
    stderr += cap.stderr;
    sleepSync(2);
  }
  assert.match(stderr, /ox: memory-loss: archived 1 checkpoint\(s\)/, stderr);
  assert.match(stderr, /nothing deleted/, stderr);
  assert.match(stderr, /notes\/archive/, stderr);
});

// ===========================================================================
// 3. the 21st pattern of a type must ARCHIVE, not splice
// ===========================================================================

test('3. exceeding 20 patterns of a type archives them instead of silently evicting', (t) => {
  const dir = sandbox(t, 'ox-lv-pat-');
  freshLedger();

  const evictedPerCall = [];
  let last = null;
  for (let i = 1; i <= 25; i++) {
    last = recordPattern({ cwd: dir, taskType: 'code', pattern: `pattern number ${i} ${MARK.pattern}`, success: true });
    assert.equal(last.recorded, true, `pattern ${i} was not recorded`);
    evictedPerCall.push(last.evicted);
    if (i <= MAX_PATTERNS_PER_TYPE) assert.equal(last.evicted, 0, `nothing should be evicted at ${i}`);
    if (i > MAX_PATTERNS_PER_TYPE) {
      assert.equal(last.evicted, 1, `exactly one pattern overflows per call at ${i}`);
      assert.equal(typeof last.archive, 'string', 'the eviction did not report an archive path');
    }
  }

  // the live store holds exactly the cap
  const body = fs.readFileSync(path.join(dir, '.agent', 'procedural.md'), 'utf8');
  assert.equal((body.match(/^-\s+/gm) ?? []).length, MAX_PATTERNS_PER_TYPE);
  assert.equal(body.includes('pattern number 1 '), false, 'the oldest pattern is still live');
  assert.equal(body.includes(`pattern number ${MAX_PATTERNS_PER_TYPE} `), true, 'the newest pattern is missing');

  // RECOVERABLE: every evicted pattern is on disk, in full. Five calls overflowed,
  // so there are five archives, and the union covers all five evicted patterns.
  const procArchive = path.join(dir, '.agent', 'archive', 'procedural');
  const files = fs.readdirSync(procArchive).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 5, `expected one archive per overflowing call: ${files.join(', ')}`);
  const archivedText = files.map((f) => fs.readFileSync(path.join(procArchive, f), 'utf8')).join('\n');
  assert.match(archivedText, /# Archived procedural patterns \(code\)/);
  for (let i = 1; i <= 5; i++) {
    assert.match(archivedText, new RegExp(`pattern number ${i} ${MARK.pattern}`), `pattern ${i} is not recoverable`);
  }

  // counters were decremented for the patterns that actually left the live store
  assert.match(body, new RegExp(`\\((${MAX_PATTERNS_PER_TYPE}) successful, 0 failed\\)`));

  // announced and recorded, once per eviction
  const evs = rowsFor('pattern-evicted');
  assert.equal(evs.length, 5, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'procedural');
  assert.equal(evs[0].reason, `over-${MAX_PATTERNS_PER_TYPE}-per-type`);
  assert.equal(lossStats().archived, 5);
  assert.equal(proceduralStats({ cwd: dir }).totalPatterns, MAX_PATTERNS_PER_TYPE);
});

test('3b. under the pattern cap nothing is archived and nothing is evicted', (t) => {
  const dir = sandbox(t, 'ox-lv-pat-under-');
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
  const dir = sandbox(t, 'ox-lv-collide-');
  freshLedger();
  const epDir = path.join(dir, '.agent', 'episodes');

  const a = writeEpisode(dir, {
    goal: `identical goal ${MARK.collide}`,
    outcome: `first outcome ${MARK.collide}`,
    lessons: [`first lesson ${MARK.collide}`],
  });
  const b = writeEpisode(dir, {
    goal: `identical goal ${MARK.collide}`,
    outcome: `second outcome ${MARK.collide}`,
    lessons: [`second lesson ${MARK.collide}`],
  });

  assert.equal(a.status, 'written', a.message);
  assert.equal(b.status, 'written', b.message);
  assert.notEqual(a.path, b.path, 'both episodes landed on the same file');

  const files = listMd(epDir);
  assert.equal(files.length, 2, `both episodes should be on disk: ${files.join(', ')}`);
  // distinct FILENAMES, not one file overwritten in place
  assert.equal(new Set(files).size, 2);

  // both bodies complete, with nothing trimmed away
  const bodies = files.map((f) => fs.readFileSync(path.join(epDir, f), 'utf8'));
  for (const [label, needle] of [
    ['first outcome', `first outcome ${MARK.collide}`],
    ['second outcome', `second outcome ${MARK.collide}`],
    ['first lesson', `first lesson ${MARK.collide}`],
    ['second lesson', `second lesson ${MARK.collide}`],
  ]) {
    assert.equal(bodies.filter((b) => b.includes(needle)).length, 1, `${label} did not survive exactly once`);
  }
  for (const body of bodies) {
    assert.equal(body.includes('[earlier episodes trimmed]'), false, 'an episode was trimmed');
    assert.match(body, /## Files touched/);
    assert.match(body, /## Lessons/);
    assert.ok(body.split('\n').length <= 40, 'an episode exceeded the 40-line cap');
  }

  // the split is recorded, so the collision is visible rather than silent
  const evs = rowsFor('episode-name-taken');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'uniquified');
  assert.equal(evs[0].reason, 'same-date-same-slug');
  assert.equal(lossStats().uniquified, 1);
});

// ===========================================================================
// 5. pruneSessions must ARCHIVE, not unlink
// ===========================================================================

test('5. pruning sessions older than the threshold archives them, and the transcript is recoverable', (t) => {
  freshLedger();
  const dir = sandbox(t, 'ox-lv-sess-');
  const sessionsDir = path.join(os.homedir(), '.ox', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  const old = createSession(dir, { label: 'old' });
  appendEvent(old, { t: 'user', content: `historic transcript ${MARK.transcript}` });
  const recent = createSession(dir, { label: 'recent' });
  appendEvent(recent, { t: 'user', content: 'today transcript' });

  const old1 = Date.now() - 120 * 86_400_000;
  fs.utimesSync(old.file, old1 / 1000, old1 / 1000);

  const res = pruneSessions({ olderThanDays: 90 });

  // archive is the DEFAULT; permanent deletion is opt-in only
  assert.equal(res.mode, 'archive');
  assert.equal(res.archived.length, 1, JSON.stringify(res));
  assert.equal(res.kept.length, 0);
  assert.equal(fs.existsSync(old.file), false, 'the aged transcript was removed from the active dir');
  assert.equal(fs.existsSync(recent.file), true, 'a recent transcript was touched');

  // RECOVERABLE: the bytes are still on disk, inside the sessions tree (which
  // src/tools/fs.js treats as a SENSITIVE_ROOT, so access does not widen)
  const archiveDir = path.join(sessionsDir, 'archive');
  const archived = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(archived.length, 1, archived.join(', '));
  assert.match(archived[0], /^\d{4}-\d{2}-\d{2}T/, 'the archive name is not timestamped');
  const text = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8');
  assert.match(text, new RegExp(MARK.transcript), 'the transcript content did not survive');

  // recorded, naming the archived path
  const evs = rowsFor('transcript-aged');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'sessions');
  assert.equal(fs.readFileSync(evs[0].archive, 'utf8').includes(MARK.transcript), true);
  assert.equal(lossStats().archived, 1);
});

test('5b. permanent deletion exists only as an explicit opt-in, and even then is recorded and announced', (t) => {
  freshLedger();
  const dir = sandbox(t, 'ox-lv-sess-del-');
  const sessionsDir = path.join(os.homedir(), '.ox', 'sessions');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  const old = createSession(dir, {});
  appendEvent(old, { t: 'user', content: 'delete me' });
  const old1 = Date.now() - 120 * 86_400_000;
  fs.utimesSync(old.file, old1 / 1000, old1 / 1000);

  // dry run moves nothing at all
  const dry = pruneSessions({ olderThanDays: 90, dryRun: true });
  assert.equal(dry.deleted.length, 1);
  assert.deepEqual(dry.archived, [], 'a dry run claimed to archive something');
  assert.equal(fs.existsSync(old.file), true, 'a dry run moved a file');
  assert.deepEqual(rows(), [], 'a dry run wrote a ledger row');

  const { result, stderr } = captureStderr(() => pruneSessions({ olderThanDays: 90, mode: 'delete' }));
  assert.equal(result.mode, 'delete');
  assert.equal(fs.existsSync(old.file), false);
  assert.match(stderr, /ox: memory-loss: DELETED/, stderr);
  const evs = rowsFor('transcript-deleted');
  assert.equal(evs.length, 1, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'deleted');
  assert.equal(evs[0].detail, 'operator-opted-in');
});

// ===========================================================================
// 6. the loss ledger: observable, and structurally unable to carry content
// ===========================================================================

test('6. the ledger records every event above and contains NO file content', (t) => {
  const dir = sandbox(t, 'ox-lv-ledger-');
  freshLedger();

  // --- 1. the .agent size cap ---------------------------------------------
  const adir = path.join(dir, '.agent');
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(adir, 'blob.bin'), Buffer.alloc(MAX_AGENT_DIR_BYTES + 64 * 1024));
  const capRes = captureStderr(() =>
    writeEpisode(dir, { goal: `ledger overflow ${MARK.overflow}`, outcome: `archived ${MARK.overflow}` })
  );

  // --- 2. the checkpoint cap ----------------------------------------------
  for (let i = 1; i <= MAX_CHECKPOINTS + 1; i++) {
    writeSessionNote(dir, {
      phase: 'p',
      goal: `ledger checkpoint ${i} ${MARK.ckpt} decision ${i} ${MARK.ckpt}`,
      status: 'ok',
      model: 'm',
    });
    sleepSync(2);
  }

  // --- 3. the pattern cap -------------------------------------------------
  for (let i = 1; i <= MAX_PATTERNS_PER_TYPE + 1; i++) {
    recordPattern({ cwd: dir, taskType: 'code', pattern: `ledger pattern ${i} ${MARK.pattern}`, success: true });
  }

  // --- 4. an episode name collision ---------------------------------------
  // A SECOND sandbox: `dir` is deliberately over the size cap, and an over-cap
  // write is routed to the overflow archive before it ever reaches the naming
  // path, so the collision has to be provoked in a clean tree.
  const collideDir = sandbox(t, 'ox-lv-ledger-collide-');
  writeEpisode(collideDir, { goal: `ledger collide ${MARK.collide}`, outcome: `a ${MARK.collide}` });
  writeEpisode(collideDir, { goal: `ledger collide ${MARK.collide}`, outcome: `b ${MARK.collide}` });
  assert.equal(listMd(path.join(collideDir, '.agent', 'episodes')).length, 2, 'the collision test lost an episode');

  const all = rows();
  assert.ok(all.length > 0, 'nothing was recorded at all');
  for (const e of ['agent-dir-overflow', 'checkpoint-evicted', 'pattern-evicted', 'episode-name-taken']) {
    assert.ok(
      all.map((r) => r.event).includes(e),
      `missing ledger row for ${e}: ${all.map((r) => r.event).join(', ')}`
    );
  }

  // every row is the documented shape, and nothing else is stored
  for (const r of all) {
    assert.equal(r.t, 'memory-loss');
    assert.match(r.ts, /^\d{4}-\d{2}-\d{2}T/);
    for (const k of ['store', 'event', 'action', 'reason']) {
      assert.match(r[k], /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, `field ${k} is not a machine token: ${r[k]}`);
    }
    for (const k of Object.keys(r)) {
      assert.ok(
        ['ts', 't', 'store', 'event', 'action', 'reason', 'artifact', 'archive', 'bytes', 'count', 'detail'].includes(k),
        `unexpected ledger field: ${k}`
      );
    }
  }

  // THE CONTENT ASSERTION, in the shape the audit rows are already asserted in:
  // no marker from any artefact appears anywhere in the file.
  const raw = fs.readFileSync(ledgerFile(), 'utf8');
  for (const [label, marker] of Object.entries(MARK)) {
    assert.equal(raw.includes(marker), false, `the ledger carried ${label} content:\n${raw}`);
  }
  for (const [label, snippet] of [
    ['an episode header', '# Episode'],
    ['a checkpoint header', '# Checkpoint'],
    ['a goal line', '- goal:'],
    ['an archived-pattern header', 'Archived procedural patterns'],
    ['a decision line', 'decision 1'],
  ]) {
    assert.equal(raw.includes(snippet), false, `the ledger carried ${label}:\n${raw}`);
  }

  // ...but it DOES carry the paths and the reasons, which is the whole point
  assert.equal(raw.includes(capRes.result.path), true, 'the archive path is missing');
  assert.equal(raw.includes('agent-dir-over-500KB'), true, 'the reason is missing');
  assert.equal(raw.includes(`over-${MAX_CHECKPOINTS}`), true, 'the checkpoint reason is missing');
});

// ===========================================================================
// 7. a clean run produces NO ledger rows and NO archives
// ===========================================================================

test('7. a clean run with nothing over any cap writes no ledger rows and no archives', (t) => {
  const dir = sandbox(t, 'ox-lv-clean-');
  freshLedger();

  for (let i = 1; i <= 3; i++) {
    writeEpisode(dir, { goal: `ordinary work item ${i}`, outcome: 'done', lessons: ['nothing unusual'] });
    writeSessionNote(dir, { phase: 'p', goal: `ordinary checkpoint ${i}`, status: 'ok', model: 'm' });
    recordPattern({ cwd: dir, taskType: 'code', pattern: `ordinary pattern ${i}`, success: true });
    sleepSync(2);
  }

  const adir = path.join(dir, '.agent');
  // no archive dir anywhere under THIS project's .agent
  assert.equal(fs.existsSync(path.join(adir, 'archive')), false, '.agent/archive was created');
  assert.equal(fs.existsSync(path.join(adir, 'notes', 'archive')), false, '.agent/notes/archive was created');
  assert.equal(
    fs.existsSync(path.join(os.homedir(), '.ox', 'archive', 'agent-overflow', projectKeyFor(dir))),
    false,
    'a home overflow dir was created for a project that never went over its cap'
  );

  // no ledger row, no counter movement
  assert.deepEqual(rows(), [], 'a clean run produced ledger churn');
  assert.deepEqual(lossStats(), { events: 0, archived: 0, kept: 0, refused: 0, deleted: 0, uniquified: 0 });

  // and the ordinary results are unaffected
  assert.equal(listMd(path.join(adir, 'episodes')).length, 3);
  assert.equal(listMd(path.join(adir, 'notes')).length, 3);
  assert.equal(proceduralStats({ cwd: dir }).totalPatterns, 3);
  assert.equal(fs.existsSync(ledgerFile()), false, 'the ledger file was created by a clean run');
});

// ===========================================================================
// 8. dirSizeBytes must be EXACT
// ===========================================================================

test('8. dirSizeBytes is exact, not approximate -- it used to break early at the cap', (t) => {
  const dir = sandbox(t, 'ox-lv-size-');

  // A tree with nested subdirs, and an exact expected total computed by hand.
  const plan = [
    ['a.txt', 1000],
    ['sub/b.txt', 2000],
    ['sub/deep/c.txt', 3000],
    ['sub/deep/d.txt', 4],
    ['empty-file.txt', 0],
  ];
  let expected = 0;
  for (const [rel, bytes] of plan) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes, 0x61));
    expected += bytes;
  }
  assert.equal(dirSizeBytes(dir), expected, 'the size of a nested tree is not exact');

  // The bug: it broke out of the walk once the running total passed the cap, so
  // the number it returned depended on readdir order and could be anywhere from
  // "just over the cap" to the real size. Build a tree several times the cap and
  // require the FULL total, which an early-exit implementation cannot produce.
  const big = sandbox(t, 'ox-lv-size-big-');
  const files = [];
  let bigExpected = 0;
  for (let i = 0; i < 12; i++) {
    const bytes = 100 * 1024;
    const rel = `chunk-${String(i).padStart(2, '0')}.bin`;
    fs.writeFileSync(path.join(big, rel), Buffer.alloc(bytes, 0x62));
    files.push(rel);
    bigExpected += bytes;
  }
  assert.ok(bigExpected > MAX_AGENT_DIR_BYTES * 2, `precondition: ${bigExpected} bytes is well over the cap`);
  assert.equal(dirSizeBytes(big), bigExpected, 'the walk returned early instead of the real size');

  // every file accounted for, in one name-order-independent total
  const sumOfStats = files.reduce((n, f) => n + fs.statSync(path.join(big, f)).size, 0);
  assert.equal(dirSizeBytes(big), sumOfStats);

  // a missing directory is 0, not a throw
  assert.equal(dirSizeBytes(path.join(dir, 'does-not-exist')), 0);
});

// ===========================================================================
// 9 + 10. the two further paths found while auditing
// ===========================================================================

test('9. promoteEpisode --force archives the skill it replaces instead of rm -rf-ing it', (t) => {
  const dir = sandbox(t, 'ox-lv-promote-');
  const home = sandbox(t, 'ox-lv-promote-home-');
  freshLedger();

  // The skill name is the goal slug, so a replacement needs the same goal twice.
  // The episodes are told apart by their (uniquified) filenames.
  const GOAL = 'a replaceable skill target';
  const firstEp = writeEpisode(dir, { goal: GOAL, outcome: 'v1', lessons: [`first lesson ${MARK.skill}`], meta: { score: 9 } });
  const first = promoteEpisode(dir, path.basename(firstEp.path, '.md'), { home });
  assert.equal(first.ok, true, JSON.stringify(first));
  const skillDir = path.dirname(first.path);
  // a hand-added file beside SKILL.md, of the kind --force used to delete
  fs.writeFileSync(path.join(skillDir, 'NOTES.md'), `hand written notes ${MARK.skill}\n`);

  // the overwrite is still refused without --force
  const secondEp = writeEpisode(dir, { goal: GOAL, outcome: 'v2', lessons: [`second lesson ${MARK.skill}`], meta: { score: 9 } });
  const refSecond = path.basename(secondEp.path, '.md');
  const refused = promoteEpisode(dir, refSecond, { home });
  assert.equal(refused.kind, 'exists');
  assert.match(refused.message, /--force/);

  const { result: forced, stderr } = captureStderr(() => promoteEpisode(dir, refSecond, { home, force: true }));
  assert.equal(forced.ok, true, JSON.stringify(forced));
  // the old file is GONE from the skill dir (that is the replace), and the new
  // SKILL.md is in place -- the bytes are in the archive, checked below
  assert.equal(fs.existsSync(path.join(skillDir, 'NOTES.md')), false, 'the replaced file was copied, not moved');
  assert.match(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), /second lesson/);
  assert.match(stderr, /skill .* was replaced by --force/, stderr);

  // RECOVERABLE: both the replaced SKILL.md and the extra file are in the archive
  const archived = archivedSkillFiles();
  assert.ok(archived.length >= 2, `the replaced skill was deleted rather than archived: ${JSON.stringify(archived)}`);
  const archivedText = archived.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(archivedText, new RegExp(MARK.skill), 'the replaced skill content is not recoverable');
  assert.match(archivedText, /first lesson/, 'the v1 lesson is not recoverable');

  const evs = rowsFor('skill-replaced');
  assert.equal(evs.length, 2, `one ledger row per replaced file: ${JSON.stringify(rows())}`);
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'skills');
  assert.equal(evs[0].reason, 'promote-force');
  assert.equal(fs.readFileSync(ledgerFile(), 'utf8').includes(MARK.skill), false, 'the ledger carried skill content');
});

test('10. the working-memory chunk cap archives the chunks that fall off it', (t) => {
  const dir = sandbox(t, 'ox-lv-hmem-');
  freshLedger();

  const hm = new HierarchicalMemory(dir);
  hm.load();
  hm.maxChunks = 4; // the production cap is 50; lowered here so the test is fast
  for (let i = 1; i <= 4; i++) hm.addSubgoal(`subgoal ${i} ${MARK.chunk}`);
  assert.deepEqual(rows(), [], 'nothing should be archived below the cap');

  for (let i = 5; i <= 9; i++) hm.addSubgoal(`subgoal ${i} ${MARK.chunk}`);

  assert.equal(hm.getAllChunks().length, 4, 'the live working set must respect the cap');
  assert.equal(hm.getAllChunks()[0].goal, `subgoal 6 ${MARK.chunk}`, 'the wrong chunks were kept');

  // RECOVERABLE: the five that fell off are on disk, in full
  const archiveDir = path.join(dir, '.agent', 'archive', 'hierarchical-memory');
  const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 5, `one archive per trimmed chunk: ${files.join(', ')}`);
  const archived = files.map((f) => fs.readFileSync(path.join(archiveDir, f), 'utf8')).join('\n');
  for (let i = 1; i <= 5; i++) {
    assert.match(archived, new RegExp(`subgoal ${i} ${MARK.chunk}`), `subgoal ${i} is not recoverable`);
  }
  assert.equal(fs.readFileSync(ledgerFile(), 'utf8').includes(MARK.chunk), false, 'the ledger carried chunk content');

  const evs = rowsFor('chunk-trimmed');
  assert.equal(evs.length, 5, JSON.stringify(rows()));
  assert.equal(evs[0].action, 'archived');
  assert.equal(evs[0].store, 'hierarchical-memory');
});

// The archive lives under ~/.ox/archive/skills/<name>/<iso>/, deliberately OUTSIDE
// the skills tree, so a skill listing never picks it up.
function archivedSkillFiles() {
  const root = path.join(os.homedir(), '.ox', 'archive', 'skills');
  const files = [];
  const walk = (dir) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}
