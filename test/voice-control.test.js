// Typing, pressing and clicking by voice: the words, parsed (nothing is pressed under test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, parseChain, doOffline, resolveApp } from '../src/offline.js';
import { parseControl } from '../src/voice-control.js';

test('the owner\'s example: open an app, type, press send', (t) => {
  // Opening an app needs it installed: a fresh build machine has no Claude app.
  if (process.platform === 'darwin' && !resolveApp('claude code')) { t.skip('the Claude app is not installed here'); return; }
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

test('keys as they are said', async () => {
  const { spokenKey } = await import('../src/voice-control.js');
  assert.equal(spokenKey('command a'), 'cmd+a');
  assert.equal(spokenKey('command shift t'), 'cmd+shift+t');
  assert.equal(spokenKey('cmd+shift+t'), 'cmd+shift+t');
  assert.equal(spokenKey('shift tab'), 'shift+tab');
  assert.equal(spokenKey('the escape key'.replace(/^the /, '')), 'escape');
  assert.equal(spokenKey('down arrow'), 'down');
  assert.equal(spokenKey('page down'), 'pagedown');
  assert.equal(spokenKey('New Note'), null, 'a button name is not a key');
  assert.equal(spokenKey('a'), null, 'a letter alone is typing');
  assert.equal(spokenKey('enter'), null, 'plain Enter is "send", handled before');
  assert.deepEqual(parseControl('press command a'), { intent: 'key', key: 'cmd+a' });
  assert.deepEqual(parseControl('press shift tab'), { intent: 'key', key: 'shift+tab' });
  assert.deepEqual(parseControl('hit the escape key'), { intent: 'key', key: 'escape' });
  assert.deepEqual(parseControl('press New Note'), { intent: 'click', name: 'New Note' });
});

test('editing words are shortcuts, not clicks', () => {
  for (const [said, key] of [['select all', 'cmd+a'], ['copy that', 'cmd+c'], ['paste', 'cmd+v'], ['undo', 'cmd+z'], ['scroll down', 'pagedown'], ['new window', 'cmd+n']]) assert.deepEqual(parseIntent(said), { intent: 'key', key }, said);
  assert.deepEqual(parseIntent('new tab'), { intent: 'tab' });
});

test('typing followed by another step is two steps', () => {
  assert.equal(parseControl('type hello and press send'), null);
  assert.deepEqual(parseChain('type hello and then press return'), [{ intent: 'type', text: 'hello' }, { intent: 'send' }]);
  assert.deepEqual(parseIntent('Type, hello world'), { intent: 'type', text: 'hello world' }, 'dictation puts a comma after the verb');
  assert.equal(parseIntent('type buy milk please').text, 'buy milk please', 'words after "type" are the text, politeness included');
});

test('filler and politeness around a request', () => {
  if (process.platform !== 'darwin') return;
  for (const s of ['can you open notes please', 'um open notes', 'open notes for me', 'Open Notes, thanks.', 'switch to notes']) assert.deepEqual(parseIntent(s), { intent: 'app', name: 'Notes' }, s);
});

test('a key ox will not press is refused before anything happens, dry run included', () => {
  for (const s of ['press command q', 'press command w', 'press command enter']) {
    const r = doOffline(s, { dryRun: true });
    assert.equal(r.handled, true, s);
    assert.equal(r.ok, false, s);
  }
  const chain = doOffline('type hello and press command q', { dryRun: true });
  assert.equal(chain.ok, false, 'nothing of the chain is done when one step is refused');
});
