// Memory that learns what the rules miss: the user's own words kept as notes at
// once, the background pass extracting lasting facts (a change replaces the old
// one), and a match on generic words alone ("called") never counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-memlearn-'));
process.env.OX_MEMORY_HOME = path.join(home, '.ox', 'memory');
delete process.env.OX_LEARN; // the suite runner switches learning off; this file tests it
const M = await import('../src/memory-graph.js');
const X = await import('../src/memory-extract.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const file = M.memoryFile('user', { home });
const T0 = Date.parse('2026-09-01T10:00:00Z'), DAY = 86_400_000;

test('a statement the rules miss is kept word for word at once, queued for extraction, and never in the profile', () => {
  M.learnFromMessages([{ role: 'user', content: 'I teach chemistry at a high school in Calgary. Can you fix my slides?' }], { home, ref: T0 });
  const notes = M.load(file).filter((m) => m.kind === 'note');
  assert.deepEqual(notes.map((m) => m.text), ['I teach chemistry at a high school in Calgary.']);
  assert.deepEqual(X.readInbox({ home }).map((x) => x.text), ['I teach chemistry at a high school in Calgary.'], 'a request is not queued');
  assert.equal(M.profile({ file, now: T0 }).stable.some((m) => m.kind === 'note'), false);
  assert.ok(M.recall('What subject do I teach?', { file, now: T0 }).some((m) => /chemistry/.test(m.text)));
});

test('the background pass learns lasting facts with their evidence; a later change replaces the earlier one', async () => {
  M.learnFromMessages([{ role: 'user', content: 'heads up, I moved to Edmonton last month.' }], { home, ref: T0 + 10 * DAY });
  const r = await X.extractInbox({ home, ask: async ({ user }) => {
    assert.match(user, /1\. \(2026-09-01\) I teach chemistry/);
    return '[{"n": 1, "fact": "I live in Calgary"}, {"n": 2, "fact": "I live in Edmonton"}]';
  } });
  // The first links to the note it shares Calgary with (extend); the second replaces it (update).
  assert.ok(['add', 'extend'].includes(r.learned[0].op));
  assert.equal(r.learned[1].op, 'update');
  const now = M.recall('Which city am I based in?', { file, now: T0 + 11 * DAY });
  assert.match(now[0].text, /Edmonton/);
  assert.ok(!now.some((m) => m.text === 'I live in Calgary'), 'the old city is no longer current');
  const fact = M.load(file).find((m) => m.text === 'I live in Edmonton' && m.latest !== false);
  assert.match(fact.source.evidence, /moved to Edmonton/);
  assert.equal(X.readInbox({ home }).length, 0, 'what was read leaves the inbox');
});

test('a fact said with a date it started is lasting, not an event that expires', () => {
  const r = M.remember('I work at Anthropic now, started this week', { file, ref: T0 });
  assert.notEqual(r.memory.kind, 'event');
  assert.equal(r.memory.expiresAt, null);
  assert.ok(M.recall('Where do I work?', { file, now: T0 + 60 * DAY }).some((m) => /Anthropic/.test(m.text)));
});

test('other words for the same thing match; generic words alone do not', () => {
  M.remember('my dog is called Biscuit', { file, ref: T0 });
  M.remember('I am allergic to peanuts', { file, ref: T0 });
  assert.ok(M.recall('Which company am I employed by?', { file, now: T0 + DAY }).some((m) => /Anthropic/.test(m.text)));
  assert.ok(M.recall('What food can I not eat?', { file, now: T0 + DAY }).some((m) => /peanut/.test(m.text)));
  assert.deepEqual(M.recall('What is my wife called?', { file, now: T0 + DAY }), []);
});

test('the extraction answer is read leniently and never trusted for numbers it was not given', () => {
  assert.deepEqual(X.parseFacts('Sure! [{"n":1,"fact":"I use pnpm"},{"n":9,"fact":"made up"}]', 2), [{ n: 1, fact: 'I use pnpm' }]);
  assert.deepEqual(X.parseFacts('nothing here', 2), []);
  assert.equal(X.worthKeeping('Can you fix the header?'), false);
  assert.equal(X.worthKeeping('Please refactor the header component.'), false);
  assert.equal(X.worthKeeping('our team ships every Thursday afternoon.'), true);
});
