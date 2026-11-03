// Pairing from the app, both sides: one computer shows a code (Settings ›
// Offline & devices › Pair another computer), the other enters it there. Before,
// the app could only make a code and said to type `ox mesh join` in a terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');

test('the app has a place to enter a pairing code, and an address for another network', () => {
  assert.match(page, /id="od-join-form"/);
  assert.match(page, /id="od-code"[^>]*aria-label="Pairing code"/);
  assert.match(page, /id="od-at"/);
  assert.match(page, /postJson\('\/ox\/mesh\/join'/);
  assert.match(page, /enter it under “Have a code”/);
});

test('the server answers /ox/mesh/join, and refuses something that is not a code', () => {
  assert.match(serve, /\/\^\\\/ox\\\/mesh\\\/\(invite\|join\|/);
  assert.match(serve, /case 'join':/);
  assert.match(serve, /enter the code the other computer shows/);
});

// A chat from a paired machine is refused until its owner allows it, and the
// app shows how: a Manage panel per machine with the two grants a chat and a task need.
const mesh = fs.readFileSync(new URL('../src/mesh.js', import.meta.url), 'utf8');

test('the Manage panel turns Answer chats and Run tasks on and off through the allow and deny routes', () => {
  assert.match(page, /data-od-grant="\$\{g\}"/);
  assert.match(page, /postJson\(`\/ox\/mesh\/\$\{on \? 'allow' : 'deny'\}`, \{ machine, grant: c\.dataset\.odGrant \}\)/);
  assert.match(page, /grantRow\('infer', 'Answer chats'/);
  assert.match(page, /grantRow\('tasks', 'Run tasks'/);
});

test('a refused chat or task says where to turn it on in the app, not only a terminal command', () => {
  assert.match(mesh, /does not allow model calls from \$\{peer\.name\} yet\. Its owner can turn on Answer chats in OX › Settings › Offline & devices › Manage/);
  assert.match(mesh, /does not allow tasks from \$\{peer\.name\} yet\. Its owner can turn on Run tasks/);
});

test('pairing tells the person what to turn on for chats', () => {
  assert.match(page, /Chats need Answer chats turned on, here and on/);
});
