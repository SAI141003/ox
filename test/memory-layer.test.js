// The memory layer's sleep pass, lessons and snapshot, in a temporary HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remember, load, memoryFile, memoryPromptBlock } from '../src/memory-graph.js';
import { sleep, recordLesson, verifyLesson, layerSnapshot, retention } from '../src/memory-layer.js';
import { readMemoryEvents, noteMemoryEvent } from '../src/memory-events.js';

const DAY = 86_400_000;
// Each test gets its own home and memory folder (the suite runner points
// OX_MEMORY_HOME somewhere else; memory and its events follow that variable).
const fresh = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mlayer-'));
  process.env.OX_MEMORY_HOME = path.join(home, '.ox', 'memory');
  return { home, file: memoryFile('user', { home }) };
};
const byId = (file, id) => load(file).find((m) => m.id === id);

test('writes and reads are logged with ids and counts, never the memory text', () => {
  const { home, file } = fresh();
  const r = remember('I prefer pnpm over npm', { file });
  const block = memoryPromptBlock({ home, cwd: home, task: 'install deps' });
  assert.match(block, /pnpm/);
  const ev = readMemoryEvents({ home });
  assert.deepEqual(ev.map((e) => e.type), ['write', 'read']);
  assert.equal(ev[0].op, 'add');
  assert.equal(ev[0].id, r.memory.id);
  assert.ok(ev[1].ids.includes(r.memory.id));
  assert.ok(ev[1].tokens > 0);
  assert.doesNotMatch(fs.readFileSync(path.join(process.env.OX_MEMORY_HOME, 'layer-events.jsonl'), 'utf8'), /pnpm/, 'no memory text in the log');
  // Free text handed to the logger is reduced to a short token.
  const row = noteMemoryEvent('write', { op: 'add; rm -rf / and my secret' }, { home });
  assert.equal(row.op, 'addrm-rfandmysecret', 'one short token: no spaces, slashes or semicolons');
});

test('sleep reinforces recalled memories, expires past events, merges duplicates', () => {
  const { home, file } = fresh();
  const t0 = Date.now() - 20 * DAY;
  const pref = remember('I prefer dark mode in every editor', { file, ref: t0 }).memory;
  const event = remember('dentist appointment tomorrow', { file, ref: t0 }).memory;
  const a = remember('The staging database runs on Postgres 16 in Frankfurt', { file, ref: t0 }).memory;
  // An older duplicate the write path would now catch: written straight to the file.
  const b = { ...a, id: 'dup0000001', text: 'staging database runs on Postgres 16 in Frankfurt', createdAt: t0 + 1000, lastSeen: t0 + 1000 };
  fs.appendFileSync(file, `${JSON.stringify(b)}\n`);
  const did = sleep({ file, home, recalls: new Map([[pref.id, 3]]) });
  assert.equal(did.reinforced, 1);
  assert.ok(byId(file, pref.id).strength > pref.strength, 'recalled memory got stronger');
  assert.equal(byId(file, event.id).state, 'expired');
  assert.equal(did.merged, 1);
  assert.equal(byId(file, b.id).state, 'merged');
  assert.equal(byId(file, b.id).mergedInto, a.id);
  assert.equal(byId(file, a.id).strength, 2);
  assert.equal(layerSnapshot({ home, cwd: home }).sleep.last.merged, 1);
});

test('unused facts go dormant, preferences never fade, nothing is deleted', () => {
  const { home, file } = fresh();
  const old = Date.now() - 900 * DAY;
  const fact = remember('The old build server was called hal9000', { file, ref: old, importance: 2 }).memory;
  const pref = remember('I prefer tabs over spaces', { file, ref: old }).memory;
  assert.ok(retention(fact) < 0.6);
  const before = load(file).length;
  sleep({ file, home, recalls: new Map() });
  assert.equal(byId(file, fact.id).state, 'dormant');
  assert.equal(byId(file, pref.id).state, 'active');
  assert.equal(load(file).length, before, 'records only change state');
});

test('a lesson becomes a procedure only after it is verified twice', () => {
  const { home, file } = fresh();
  const l = recordLesson('When npm install fails with EACCES, use a user prefix instead of sudo', { file });
  assert.equal(recordLesson('When npm install fails with EACCES, use a user prefix instead of sudo', { file }).id, l.id, 'no duplicate lesson');
  verifyLesson(l.id, { file });
  sleep({ file, home, recalls: new Map() });
  assert.equal(byId(file, l.id).kind, 'lesson');
  verifyLesson(l.id, { file });
  const did = sleep({ file, home, recalls: new Map() });
  assert.equal(did.promoted, 1);
  assert.equal(byId(file, l.id).kind, 'procedure');
});

test('the snapshot counts every plane from the files', () => {
  const { home, file } = fresh();
  remember('I work at Acme', { file });
  remember('I work at Globex', { file });
  memoryPromptBlock({ home, cwd: home, task: 'where do I work' });
  sleep({ file, home });
  const s = layerSnapshot({ home, cwd: home });
  assert.equal(s.store.user.live, 1);
  assert.equal(s.store.user.superseded, 1, 'the old job is kept as history');
  assert.equal(s.write.ops.update, 1);
  assert.equal(s.read.runs, 1);
  assert.equal(s.sleep.runs, 1);
  assert.equal(s.profile.stable[0].text, 'I work at Globex');
});
