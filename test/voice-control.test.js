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

// From the owner's recording of a hands-free voice tool: "Open Codex", "New chat",
// "Type …", one after another, with no key held and nothing typed.
test('moving around an app by voice: a new chat, tabs, back, reload', () => {
  const win = (s) => parseControl(s);
  for (const s of ['new chat', 'New chat.', 'start a new chat', 'open a new conversation', 'new session', 'new thread']) assert.deepEqual(win(s), { intent: 'window', action: 'new-chat' }, s);
  assert.deepEqual(win('close tab'), { intent: 'window', action: 'close-tab' });
  assert.deepEqual(win('close this window'), { intent: 'window', action: 'close-window' });
  assert.deepEqual(win('next tab'), { intent: 'window', action: 'next-tab' });
  assert.deepEqual(win('previous tab'), { intent: 'window', action: 'prev-tab' });
  assert.deepEqual(win('go back'), { intent: 'window', action: 'back' });
  assert.deepEqual(win('go forward'), { intent: 'window', action: 'forward' });
  for (const s of ['refresh', 'reload the page', 'refresh this page']) assert.deepEqual(win(s), { intent: 'window', action: 'reload' }, s);
  assert.deepEqual(win('zoom in'), { intent: 'window', action: 'zoom-in' });
  assert.deepEqual(win('zoom out'), { intent: 'window', action: 'zoom-out' });
  assert.deepEqual(win('new line'), { intent: 'window', action: 'new-line' });
  for (const s of ['minimize', 'minimise this window']) assert.deepEqual(win(s), { intent: 'window', action: 'minimize' }, s);
  assert.deepEqual(win('full screen'), { intent: 'window', action: 'fullscreen' });
  assert.deepEqual(win('hide this app'), { intent: 'window', action: 'hide' });
  assert.deepEqual(win('switch app'), { intent: 'window', action: 'switch-app' });
  assert.deepEqual(win('save'), { intent: 'window', action: 'save' });
  for (const s of ['clear', 'clear the text', 'delete everything']) assert.deepEqual(win(s), { intent: 'window', action: 'clear' }, s);
});

test('said on its own: enter, submit, delete, scratch that', () => {
  for (const s of ['enter', 'Enter.', 'submit', 'return', 'send']) assert.deepEqual(parseControl(s), { intent: 'send' }, s);
  assert.deepEqual(parseControl('delete that'), { intent: 'key', key: 'delete' });
  assert.deepEqual(parseControl('scratch that'), { intent: 'key', key: 'cmd+z' });
});

test('nothing here quits an app, and typed words are never taken for a command', () => {
  for (const s of ['quit', 'quit chrome', 'force quit', 'log out', 'shut down', 'empty the trash']) assert.notEqual(parseControl(s)?.intent, 'window', s);
  assert.deepEqual(parseControl('type new chat'), { intent: 'type', text: 'new chat' });
  assert.deepEqual(parseControl('type close tab and go back'), { intent: 'type', text: 'close tab and go back' });
});

test('a chain keeps the app: open it, a new chat, type, send', (t) => {
  if (process.platform === 'darwin' && !resolveApp('claude')) { t.skip('the Claude app is not installed here'); return; }
  const c = parseChain('open claude and start a new chat and type hello there and press send');
  assert.deepEqual(c?.map((x) => x.intent), ['app', 'window', 'type', 'send']);
  assert.equal(c[1].app, c[0].name, 'the new chat is asked of the app just opened');
  assert.equal(c[2].text, 'hello there');
  const d = parseChain('select all and delete');
  assert.deepEqual(d, [{ intent: 'key', key: 'cmd+a' }, { intent: 'key', key: 'delete' }]);
  assert.match(doOffline('new chat', { dryRun: true }).message, /would window/);
});

test('dictation in voice control goes only where the cursor already is', () => {
  assert.deepEqual(parseControl('dictate hey hi can you please check my pull request'), { intent: 'type', text: 'hey hi can you please check my pull request', focusedOnly: true });
  assert.deepEqual(parseControl('dictate new chat and send it'), { intent: 'type', text: 'new chat and send it', focusedOnly: true }, 'dictated words are never read as commands');
});

test('an app said a little off, or one that lives inside another, is still found', () => {
  const apps = new Map([['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['google chrome', 'Google Chrome']]);
  assert.equal(resolveApp('Codex', apps, 'darwin'), 'ChatGPT', 'Codex is inside the ChatGPT app when it has no app of its own');
  assert.equal(resolveApp('codecs', apps, 'darwin'), 'ChatGPT');
  assert.equal(resolveApp('cloud', apps, 'darwin'), 'Claude');
  assert.equal(resolveApp('chrome', apps, 'darwin'), 'Google Chrome');
  assert.equal(resolveApp('Codex', new Map([...apps, ['codex', 'Codex']]), 'darwin'), 'Codex', 'its own app wins when it is installed');
  assert.equal(resolveApp('photoshop', apps, 'darwin'), null);
});
