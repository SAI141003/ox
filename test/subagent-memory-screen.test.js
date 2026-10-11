// Read-side screening for the SUBAGENT-scoped memory index
// (.agent/_sub/<id>/MEMORY.md).
//
// The write screen (screenPersistText in addEntry) only protects entries stored
// after it shipped. A scoped memory file written by hand, or by an older build,
// is still re-injected into that subagent's system prompt on EVERY subagent call
// via block() -> memoryBlock. So block() has to run the SAME read-side screen
// the main .agent/MEMORY.md path runs in loadMemoryBlock().

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-sub-'));
process.env.HOME = HOME_SANDBOX;

const { createScopedMemoryApi, sanitizeSubagentId } = await import('../src/subagent.js');
const { memoryScreenStats, resetMemoryScreenStats } = await import('../src/memory.js');
const { auditFilePath, auditEnabled } = await import('../src/audit.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

// Hand-written, as if it predates the write screen.
const SECRET = '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';
const HAND_WRITTEN = [
  '[lesson] normal subagent lesson here',
  `[lesson] key is ${SECRET}`,
  '',
].join('\n');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-submem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scopedIndexPath(dir, id) {
  return path.join(dir, '.agent', '_sub', id, 'MEMORY.md');
}

// Writes the scoped index by hand, bypassing memory_add entirely.
function seed(dir, id, text) {
  const file = scopedIndexPath(dir, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('block() keeps the safe line, withholds the credential, and says so', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-1';
  seed(dir, id, HAND_WRITTEN);

  const block = createScopedMemoryApi(dir, id).block();

  assert.match(block, /## Subagent memory \(\.agent\/_sub\/sub-screen-1\/MEMORY\.md\)/, block);
  assert.match(block, /normal subagent lesson here/, block);
  assert.equal(block.includes(SECRET), false, `credential leaked:\n${block}`);
  assert.equal(block.includes('key is'), false, `credential line leaked:\n${block}`);
  // not silent: the withheld line is announced
  assert.match(block, /\[memory-screen\] withheld 1 line\b/, block);
  // short enough to sit in a per-call system prompt
  const notice = block.split('\n').pop();
  assert.ok(notice.length < 140, `notice too long (${notice.length} chars): ${notice}`);
});

test('screening the scoped read leaves the file on disk byte-identical', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-2';
  const file = seed(dir, id, HAND_WRITTEN);
  const before = sha(file);
  const sizeBefore = fs.statSync(file).size;

  createScopedMemoryApi(dir, id).block();

  assert.equal(sha(file), before, 'the read path must not rewrite the memory file');
  assert.equal(fs.statSync(file).size, sizeBefore);
  assert.equal(fs.readFileSync(file, 'utf8'), HAND_WRITTEN, 'content must survive verbatim');
});

test('a clean scoped index injects with no screen notice', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-3';
  const clean = '[2026-01-01][lesson] the parser lives in src/parse.js\n';
  seed(dir, id, clean);

  const block = createScopedMemoryApi(dir, id).block();

  assert.equal(block, `## Subagent memory (.agent/_sub/${id}/MEMORY.md)\n${clean.trimEnd()}`);
  assert.equal(/memory-screen/.test(block), false, block);
});

test('an all-bad scoped index yields header + notice only, no content', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-4';
  seed(dir, id, `[lesson] key is ${SECRET}\n[lesson] token: ghp-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n`);

  const block = createScopedMemoryApi(dir, id).block();
  const lines = block.split('\n');

  assert.equal(lines.length, 2, `expected header + one notice line:\n${block}`);
  assert.equal(lines[0], `## Subagent memory (.agent/_sub/${id}/MEMORY.md)`);
  assert.match(lines[1], /\[memory-screen\] withheld 2 lines\b/, lines[1]);
  assert.equal(block.includes('ghp-'), false, block);
  assert.equal(block.includes('key is'), false, block);
});

test('withholding is recorded in OX_AUDIT with no secret text', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-5';
  seed(dir, id, HAND_WRITTEN);

  const ledger = auditFilePath();
  fs.rmSync(ledger, { force: true });
  resetMemoryScreenStats();
  assert.deepEqual(memoryScreenStats(), { withheld: 0, reads: 0 });

  createScopedMemoryApi(dir, id).block();

  assert.equal(auditEnabled(), true, 'audit must be on for this assertion to mean anything');
  assert.equal(memoryScreenStats().withheld, 1);
  assert.equal(memoryScreenStats().reads, 1);

  const rows = fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const screened = rows.filter((r) => r.t === 'memory-screen' && r.event === 'read-withheld');
  assert.equal(screened.length, 1, JSON.stringify(rows));
  assert.equal(screened[0].count, 1);
  assert.equal(screened[0].where, 'subagent memory block');
  assert.equal(screened[0].source, `.agent/_sub/${id}/MEMORY.md`);
  assert.equal(JSON.stringify(screened).includes(SECRET), false, 'ledger must not carry the secret');
  assert.equal(JSON.stringify(screened).includes('9edd82d6dd'), false, 'ledger must not carry key material');

  resetMemoryScreenStats();
});

test('an empty or missing scoped index behaves exactly as before', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-6';
  const api = createScopedMemoryApi(dir, id);

  // missing file
  assert.equal(api.block(), '');
  assert.deepEqual(memoryScreenStats(), { withheld: 0, reads: 0 });

  // present but blank
  seed(dir, id, '\n\n   \n');
  assert.equal(api.block(), '');
  assert.equal(/memory-screen/.test(api.dispatch('memory_list').content), false);
  assert.equal(api.dispatch('memory_get').content, 'Subagent memory is empty.');
  assert.deepEqual(memoryScreenStats(), { withheld: 0, reads: 0 });
});

test('memory_list / memory_get / memory_search screen the scoped index too', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-7';
  seed(dir, id, HAND_WRITTEN);
  const api = createScopedMemoryApi(dir, id);

  const listed = api.dispatch('memory_list').content;
  assert.match(listed, /normal subagent lesson here/);
  assert.equal(listed.includes(SECRET), false, listed);
  assert.match(listed, /\[memory-screen\] withheld 1 line\b/, listed);

  const got = api.dispatch('memory_get').content;
  assert.match(got, /normal subagent lesson here/);
  assert.equal(got.includes(SECRET), false, got);
  assert.match(got, /\[memory-screen\] withheld 1 line\b/, got);

  const found = api.dispatch('memory_search', { query: 'key' }).content;
  assert.equal(found.includes(SECRET), false, found);
  assert.match(found, /withheld/, found);
});

test('the WRITE path is unchanged: memory_add still refuses a credential', (t) => {
  const dir = sandbox(t);
  const id = 'sub-screen-8';
  const api = createScopedMemoryApi(dir, id);

  const res = api.dispatch('memory_add', { statement: `key is ${SECRET}` });
  assert.equal(res.isError, true);
  assert.match(res.content, /refusing to store/);
  assert.equal(fs.existsSync(scopedIndexPath(dir, id)), false, 'nothing written');
  assert.equal(api.block(), '');
});

test('sanitizeSubagentId still gates traversal into the scoped namespace', () => {
  assert.equal(sanitizeSubagentId('../etc'), null);
  assert.equal(sanitizeSubagentId('sub-screen-1'), 'sub-screen-1');
});
