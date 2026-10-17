// Small tasks with no AI and no internet: the rules parser, the arithmetic, and
// the honest "not a small task" for everything else. Dry runs only, so the
// suite never opens apps or plays with the volume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIntent, calc, doOffline, mailtoUrl, resolveApp } from '../src/offline.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('arithmetic without eval', () => {
  assert.equal(calc('2 + 3 * 4'), 14);
  assert.equal(calc('(2 + 3) * 4'), 20);
  assert.equal(calc('2 ^ 10'), 1024);
  assert.equal(calc('18% of 240'), 43.2);
  assert.equal(calc('12 times 7'), 84);
  assert.equal(calc('-3 + 5'), 2);
  assert.equal(calc('1,000 / 8'), 125);
  assert.equal(calc('process.exit()'), null, 'only numbers and operators');
  assert.equal(calc('2 +'), null);
  assert.equal(calc('1/0'), null, 'no Infinity');
});

test('requests become one intent, or none', () => {
  const p = (t) => parseIntent(t);
  // The app's real name on a Mac ("Notes"); elsewhere the words as said.
  assert.equal(p('open notes').intent, 'app');
  assert.equal(p('open notes').name.toLowerCase(), 'notes');
  assert.deepEqual(p('Hey ox, open Safari.'), { intent: 'app', name: 'Safari' });
  assert.deepEqual(p('open github.com'), { intent: 'url', url: 'https://github.com' });
  assert.deepEqual(p('search best ramen near me'), { intent: 'search', query: 'best ramen near me' });
  assert.deepEqual(p('timer 25 minutes'), { intent: 'timer', secs: 1500, label: 'timer' });
  assert.deepEqual(p('remind me in 10 minutes to stretch'), { intent: 'timer', secs: 600, label: 'stretch' });
  assert.deepEqual(p('note buy milk and eggs'), { intent: 'note', text: 'buy milk and eggs' });
  assert.deepEqual(p('take a screenshot'), { intent: 'screenshot' });
  assert.deepEqual(p('volume 30'), { intent: 'volume', level: 30 });
  assert.deepEqual(p('mute'), { intent: 'mute', on: true });
  assert.equal(p('what is 18% of 240').value, 43.2);
  assert.equal(p('what time is it').intent, 'time');
  assert.equal(p('refactor the auth module to use sessions'), null, 'big asks are not guessed at');
  assert.equal(p('what is love'), null);
});

test('doOffline answers math for real and says plainly when a task is too big', () => {
  assert.deepEqual(doOffline('what is 12 * 12'), { handled: true, intent: { intent: 'calc', expr: '12 * 12', value: 144 }, ok: true, message: '12 * 12 = 144' });
  assert.equal(doOffline('write me a business plan').handled, false);
  assert.equal(doOffline('open notes', { dryRun: true }).message, 'would app');
});

test('ox do works with no key, no network, and a non-zero exit for "not mine"', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { OX_ISLAND: '0', NO_COLOR: '1' });
  const ok = spawnSync(process.execPath, [OX, 'do', 'what is 2^8'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2\^8 = 256/);
  const no = spawnSync(process.execPath, [OX, 'do', '--json', 'design a database'], { env, encoding: 'utf8' });
  assert.equal(no.status, 2);
  assert.equal(JSON.parse(no.stdout).handled, false);
});

test('everyday tasks without AI: email drafts, unread mail, to-dos, notes, music', () => {
  assert.deepEqual(parseIntent('email anna@example.com about lunch saying see you at 1pm'), { intent: 'email', to: 'anna@example.com', subject: 'lunch', body: 'see you at 1pm' });
  assert.equal(mailtoUrl({ to: 'anna@example.com', subject: 'lunch', body: 'see you at 1pm' }), 'mailto:anna@example.com?subject=lunch&body=see%20you%20at%201pm');
  for (const t of ['check my email', 'any unread emails?', 'how many emails do I have']) assert.equal(parseIntent(t)?.intent, 'unread', t);
  assert.deepEqual(parseIntent('add call mum to my to-do list'), { intent: 'task', text: 'call mum' });
  assert.deepEqual(parseIntent('remind me to pay rent'), { intent: 'task', text: 'pay rent' });
  assert.equal(parseIntent('remind me in 10 minutes to stretch').intent, 'timer');
  assert.deepEqual(parseIntent('write down the wifi password is on the fridge'), { intent: 'note', text: 'the wifi password is on the fridge' });
  assert.deepEqual(parseIntent('next song'), { intent: 'music', command: 'next track' });
  assert.equal(parseIntent('stop'), null);
  assert.equal(parseIntent('stop using tabs in the code'), null);
  assert.equal(doOffline('email anna@example.com', { dryRun: true }).message, 'would email');
});

test('only an installed app, named on its own, is opened without a model', () => {
  const apps = new Map([['whatsapp', 'WhatsApp'], ['notes', 'Notes'], ['visual studio code', 'Visual Studio Code']]);
  assert.equal(resolveApp('whatsapp', apps), 'WhatsApp');
  assert.equal(resolveApp('the WhatsApp app', apps), 'WhatsApp');
  assert.equal(resolveApp('vs code', apps), 'Visual Studio Code');
  assert.equal(resolveApp('whatsapp and all my friends', apps), null);
  assert.equal(resolveApp('', apps), null);
});

test('the Pixie requests: a song by name, lower the music, today\'s to-dos', async () => {
  const { pickToday, speakTodos } = await import('../src/offline.js');
  assert.deepEqual(parseIntent('ox, can you play Billie Jean by Jackson'), { intent: 'play', song: 'Billie Jean', artist: 'Jackson', app: '' });
  assert.deepEqual(parseIntent('play lofi beats on spotify'), { intent: 'play', song: 'lofi beats', artist: '', app: 'Spotify' });
  assert.deepEqual(parseIntent('play the music'), { intent: 'music', command: 'play' });
  assert.deepEqual(parseIntent('lower the music'), { intent: 'volume', delta: -15 });
  assert.deepEqual(parseIntent('turn the music up'), { intent: 'volume', delta: 15 });
  for (const s of ['can you open my to-do list and tell me what I have today?', 'what do I have today', 'read my reminders']) assert.deepEqual(parseIntent(s), { intent: 'todos' }, s);
  const now = new Date(2026, 9, 17, 9, 0);
  const items = pickToday([
    { name: 'physics assignment', due: new Date(2026, 9, 17, 20, 0) },
    { name: 'submit handles', due: new Date(2026, 9, 17, 21, 0) },
    { name: 'old one', due: new Date(2026, 9, 10, 11, 0) },
    { name: 'someday', due: null },
    { name: 'next year', due: new Date(2027, 0, 1) },
  ], now);
  assert.deepEqual(items.map((x) => x.at), ['overdue', '8 PM', '9 PM']);
  assert.equal(speakTodos(items), 'today: physics assignment at 8 PM and submit handles at 9 PM. overdue: old one');
  assert.equal(speakTodos(pickToday([{ name: 'a', due: null }, { name: 'b', due: null }], now)), 'you have 2 things: a and b');
  assert.equal(speakTodos([]), 'nothing on your to-do list');
});

test('chains and sites: "open chrome and open youtube" is done without a model', async () => {
  const { parseChain } = await import('../src/offline.js');
  assert.deepEqual(parseIntent('open youtube in chrome'), { intent: 'url', url: 'https://www.youtube.com', browser: 'Google Chrome' });
  assert.equal(parseIntent('open gmail').url, 'https://mail.google.com');
  assert.equal(doOffline('open chrome and open youtube', { dryRun: true }).handled, true);
  assert.equal(doOffline('ox, open chrome and youtube', { dryRun: true }).intent.steps.at(-1).url, 'https://www.youtube.com');
  assert.deepEqual(parseChain('open gmail then pause the music').map((x) => x.intent), ['url', 'music']);
  // More than a list of small tasks goes to a model, whole.
  assert.equal(doOffline('open whatsapp and all my friends', { dryRun: true }).handled, false);
  assert.equal(parseIntent('add milk and eggs to my list').text, 'milk and eggs');
});
