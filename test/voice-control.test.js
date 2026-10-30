// Typing, pressing and clicking by voice: the words, parsed (nothing is pressed under test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, parseChain, doOffline } from '../src/offline.js';
import { parseControl } from '../src/voice-control.js';

test('the owner\'s example: open an app, type, press send', () => {
  const c = parseChain('open claude code and type create an army image and press send');
  assert.deepEqual(c.map((x) => x.intent), ['app', 'type', 'send']);
  assert.equal(c[1].text, 'create an army image');
  assert.equal(c[1].fresh, true, 'the first typing after opening waits for the window');
  assert.equal(c[1].app, c[0].name, 'typed into the app just opened');
  assert.equal(c[2].app, c[0].name);
  if (process.platform === 'darwin') assert.equal(c[0].name, 'Claude', '"Claude Code" is the Claude app');
});

test('typed words keep their "and"s', () => {
  const c = parseChain('open notes and type buy milk and eggs');
  assert.equal(c?.at(-1).text, 'buy milk and eggs');
  const d = parseChain('open Notes, type hello world, then hit enter');
  assert.deepEqual(d?.slice(1).map((x) => x.intent), ['type', 'send']);
});

test('single steps', () => {
  assert.deepEqual(parseControl('type hello there'), { intent: 'type', text: 'hello there' });
  for (const s of ['press send', 'hit enter', 'send it', 'click the send button', 'choose send']) assert.deepEqual(parseControl(s), { intent: 'send' }, s);
  assert.deepEqual(parseControl('press tab'), { intent: 'key', key: 'tab' });
  assert.deepEqual(parseControl('press command+n'), { intent: 'key', key: 'cmd+n' });
  assert.deepEqual(parseControl('click New Note'), { intent: 'click', name: 'New Note' });
  assert.equal(parseIntent('play billie jean').intent, 'play', 'music still plays');
  assert.equal(parseIntent('write to Anna that I am late'), null, 'messages are not typing');
});

test('under test nothing is pressed', () => {
  const r = doOffline('type hello');
  assert.equal(r.handled, true);
  assert.match(r.message, /dry run: would type "hello"/);
});

test('the owner\'s Chrome requests, as spoken', () => {
  const a = parseChain('Hey, I want you to open Chrome and search for any new movies that are interesting and you know that they explain more about other movies');
  assert.deepEqual(a.map((x) => x.intent), ['app', 'search']);
  assert.equal(a[1].app, a[0].name, 'searched in the browser just opened');
  assert.match(a[1].query, /^new movies that are interesting and that they explain more about other movies$/);
  const b = parseIntent('Now open a new tab and search for new movies');
  assert.deepEqual(b, { intent: 'search', query: 'new movies', newTab: true });
  assert.deepEqual(parseIntent('open a new tab'), { intent: 'tab' });
  assert.equal(parseIntent('can you search for ramen near me').query, 'ramen near me');
});
