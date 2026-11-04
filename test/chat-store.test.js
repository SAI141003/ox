// Chats and settings outlive a new port: they are in a file, the old ones come
// back once, and a blank page cannot wipe them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as C from '../src/chat-store.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-chats-'));
const chat = (id, n, extra = {}) => ({ id, messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` })), ...extra });

test('the longer copy of a chat wins, and incognito never lands', () => {
  const out = C.mergeChats([chat('c1', 1), chat('c2', 3)], [chat('c1', 4), chat('c3', 1, { incognito: true })]);
  assert.deepEqual(out.map((c) => [c.id, c.messages.length]).sort(), [['c1', 4], ['c2', 3]]);
});

test('saving keeps a deletion deleted, and settings stay beside the chats', () => {
  const h = home();
  C.saveStore({ chats: [chat('c1', 1), chat('c2', 1)] }, { home: h });
  C.saveStore({ chats: [chat('c2', 1)] }, { home: h });
  C.saveStore({ prefs: { theme: 'dark' } }, { home: h });
  const s = C.readStore({ home: h });
  assert.deepEqual(s.chats.map((c) => c.id), ['c2']);
  assert.deepEqual(s.prefs, { theme: 'dark' });
  if (process.platform !== 'win32') assert.equal((fs.statSync(C.chatsFile(h)).mode & 0o777).toString(8), '600');
});

test('chats left at old addresses come back once, and a deleted one stays gone after that', () => {
  const h = home();
  C.saveStore({ chats: [chat('here', 1)] }, { home: h });
  const stores = { a: [chat('old1', 2)], b: [chat('old1', 5), chat('old2', 1)] };
  const reader = (f, k) => (k === 'ox.convos' ? stores[f] : k === 'ox.prefs' && f === 'a' ? { theme: 'paper' } : null);
  assert.equal(C.recoverStranded({ home: h, files: ['a', 'b'], reader }), 2);
  const s = C.readStore({ home: h });
  assert.equal(s.chats.find((c) => c.id === 'old1').messages.length, 5);
  assert.deepEqual(s.prefs, { theme: 'paper' });
  C.saveStore({ chats: s.chats.filter((c) => c.id !== 'old2') }, { home: h });
  assert.equal(C.recoverStranded({ home: h, files: ['a', 'b'], reader }), 0, 'only once');
  assert.equal(C.readStore({ home: h }).chats.some((c) => c.id === 'old2'), false);
});

test('reads a real browser storage file (UTF-16 in sqlite), and leaves it as it was', { skip: process.platform !== 'darwin' }, () => {
  const f = path.join(home(), 'localstorage.sqlite3');
  const hex = Buffer.from(JSON.stringify([chat('real', 2)]), 'utf16le').toString('hex');
  assert.equal(spawnSync('/usr/bin/sqlite3', [f, `create table ItemTable(key text, value blob); insert into ItemTable values('ox.convos', x'${hex}');`]).status, 0);
  const before = fs.readFileSync(f);
  assert.equal(C.readStranded(f, 'ox.convos')[0].id, 'real');
  assert.equal(C.readStranded(f, 'ox.prefs'), null);
  assert.ok(before.equals(fs.readFileSync(f)));
});

test('the page cannot save before it has loaded what is on disk', () => {
  const page = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(page, /if \(!chatsLoaded\) return;/);
  assert.match(page, /getJson\('\/ox\/chats'\)/);
});
