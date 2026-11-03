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
