import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const origHome = process.env.HOME;
let tmpHome;
let session;
let cwdA;
let cwdB;

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-session-home-'));
  process.env.HOME = tmpHome;
  session = await import('../src/session.js');
  cwdA = path.join(tmpHome, 'proj-a');
  cwdB = path.join(tmpHome, 'proj-b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
});

after(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('createSession+appendEvent+loadSession round-trips with full fidelity incl unicode', () => {
  const s = session.createSession(cwdA, { label: 'roundtrip' });
  assert.ok(fs.existsSync(s.file));
  const events = [
    { t: 'user', content: 'héllo 世界 🎉 — unicode ✔' },
    { t: 'assistant', content: 'réponse ✓', usage: { inTokens: 3, outTokens: 7 } },
    { t: 'tool', name: 'fs', output: { files: ['a.txt', 'b.txt'], n: 2 } },
    { t: 'user', content: 'multi\nline\ntext' },
  ];
  for (const e of events) session.appendEvent(s, e);
  const loaded = session.loadSession(s.file);
  assert.equal(loaded.length, events.length + 1);
  assert.equal(loaded[0].t, 'meta');
  assert.equal(loaded[0].cwd, cwdA);
  assert.deepEqual(loaded.slice(1), events);
});

test('forkSession copies all events into a new file with fork metadata', () => {
  const orig = session.createSession(cwdA);
  session.appendEvent(orig, { t: 'user', content: 'before fork' });
  const originalEvents = session.loadSession(orig.file);

  const forked = session.forkSession(orig.file);
  assert.notEqual(forked.file, orig.file);

  const parentId = path.basename(orig.file).match(/-([0-9a-f]{6})\.jsonl$/)[1];
  const loaded = session.loadSession(forked.file);
  assert.equal(loaded.length, originalEvents.length + 2);
  assert.equal(loaded[0].t, 'meta');
  assert.equal(loaded[0].cwd, cwdA);
  assert.equal(loaded[0].forkOf, parentId);
  assert.equal(loaded[1].t, 'fork');
  assert.equal(loaded[1].parent, parentId);
  assert.equal(loaded[1].source, path.resolve(orig.file));
  assert.deepEqual(loaded.slice(2), originalEvents);
});

test('latestSessionFile returns newest by mtime', () => {
  const older = session.createSession(cwdA);
  const oldT = new Date(Date.now() - 120_000);
  fs.utimesSync(older.file, oldT, oldT);
  const newer = session.createSession(cwdB);
  assert.equal(session.latestSessionFile(), newer.file);

  const evenNewer = session.createSession(cwdA);
  assert.equal(session.latestSessionFile(), evenNewer.file);
});

test('latestSessionFile(filterCwd) only considers sessions whose meta.cwd matches', () => {
  const inA = session.createSession(cwdA);
  const inB = session.createSession(cwdB);
  session.appendEvent(inA, { t: 'user', content: 'in A' });
  session.appendEvent(inB, { t: 'user', content: 'in B' });

  const tA = new Date(Date.now() + 1000);
  const tB = new Date(Date.now() + 2000);
  fs.utimesSync(inA.file, tA, tA);
  fs.utimesSync(inB.file, tB, tB);

  assert.equal(session.latestSessionFile(), inB.file);
  assert.equal(session.latestSessionFile(cwdA), inA.file);
  assert.equal(session.latestSessionFile(cwdB), inB.file);
  assert.equal(session.latestSessionFile(path.join(tmpHome, 'proj-zzz')), null);
});

test('torn final line warns and truncates instead of throwing', () => {
  const s = session.createSession(cwdA);
  session.appendEvent(s, { t: 'user', content: 'complete one' });
  session.appendEvent(s, { t: 'user', content: 'complete two' });
  fs.appendFileSync(s.file, '{"t":"user","cont');

  let warned = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    warned += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  let loaded;
  try {
    loaded = session.loadSession(s.file);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(loaded.length, 3);
  assert.match(warned, /torn session line/);
  assert.match(warned, /truncated tail/);
});

test('corrupt mid-file line throws loudly', () => {
  const s = session.createSession(cwdA);
  session.appendEvent(s, { t: 'user', content: 'one' });
  fs.appendFileSync(s.file, 'NOT_JSON{{\n');
  session.appendEvent(s, { t: 'user', content: 'three' });

  assert.throws(() => session.loadSession(s.file), /corrupt session line 3/);
});

test('listSessions returns metadata including cwd, newest first', () => {
  const rows = session.listSessions(50);
  assert.ok(Array.isArray(rows) && rows.length >= 5);
  for (const r of rows) {
    assert.equal(typeof r.file, 'string');
    assert.match(r.id, /^[0-9a-f]{6}$/);
    assert.ok(!Number.isNaN(Date.parse(r.mtime)));
  }
  const mtimes = rows.map((r) => r.mtime);
  assert.deepEqual(mtimes, [...mtimes].sort().reverse());

  const mine = rows.find((r) => r.cwd === cwdB);
  assert.ok(mine, 'expected a session row for cwdB');
  assert.equal(mine.cwd, cwdB);

  const torn = rows.find((r) => r.firstUserPrompt === 'complete one');
  assert.ok(torn, 'first user prompt surfaced in metadata');
});
