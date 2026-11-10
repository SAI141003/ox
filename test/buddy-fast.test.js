// The screen buddy answers sooner: questions about the screen reach it, the picture is sent as
// a JPEG, and the first sentence is handed over while the rest is written. And ox watches a
// video the way a person skims one: a sheet of frames in order, plus the words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { firstSentence, isScreenQuestion, SAYS_CANNOT_SEE } = await import('../src/serve.js');
const { jpegShot } = await import('../src/buddy.js');
const { sheetPlan, understand } = await import('../src/video-edit.js');

test('questions about what is on screen are sent to the screen', () => {
  for (const t of [
    'can you see any blue colour on my current page where it says screen recording something',
    'what am I looking at',
    'where do I click to export this',
    'point at the Apple menu',
    'is there anything red in front of me',
    'what is on my current tab',
  ]) assert.equal(isScreenQuestion(t), true, t);
  for (const t of ['what is the capital of France', 'tell me a joke', 'play Billie Jean', 'how do I page through results in SQL']) assert.equal(isScreenQuestion(t), false, t);
});

test('a quick answer that says it cannot see is recognised, so a look replaces it', () => {
  for (const t of [
    "I don't have access to your screen. If you can tell me the app or share a screenshot, I can help.",
    'I cannot see your display.',
    'I can’t view what you’re looking at on your page',
    'Please share a screenshot.',
  ]) assert.equal(SAYS_CANNOT_SEE.test(t), true, t);
  for (const t of ['Paris is the capital of France.', "I don't know that song.", 'You can share the file by email.']) assert.equal(SAYS_CANNOT_SEE.test(t), false, t);
});

test('the first sentence is given as soon as it is whole, and only then', () => {
  assert.equal(firstSentence('You are looking at Finder'), null);
  assert.equal(firstSentence('You are looking at the Finder window.'), null, 'nothing follows yet: it may be the whole reply');
  assert.equal(firstSentence('You are looking at the Finder window. It shows'), 'You are looking at the Finder window.');
  assert.equal(firstSentence('Short. But then more words come here. And'), 'Short. But then more words come here.', 'a very short start waits for the next sentence');
  assert.equal(firstSentence('Version 3.5 of the app is e.g. open here now. Next'), 'Version 3.5 of the app is e.g. open here now.');
  assert.equal(firstSentence('The Apple menu is at the top left. [POINT:24,17:Apple menu]'), null, 'a tag is never spoken early');
  assert.equal(firstSentence('**Finder** is open on the Downloads folder. The list'), 'Finder is open on the Downloads folder.');
  assert.equal(firstSentence(''), null);
});

test('a PNG screenshot is sent as a JPEG beside it; anything else is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-jpeg-'));
  const png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, 'png');
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); fs.writeFileSync(args.at(-1), 'jpeg'); };
  const out = jpegShot(png, { run });
  assert.equal(out, path.join(dir, 'shot.sent.jpg'));
  assert.deepEqual(calls[0].slice(0, 6), ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions']);
  assert.equal(jpegShot(png, { run }), out, 'made once');
  assert.equal(calls.length, 1);
  assert.equal(jpegShot(path.join(dir, 'a.jpg'), { run }), path.join(dir, 'a.jpg'));
  // sips missing or failing: the PNG goes, as before.
  const other = path.join(dir, 'other.png');
  fs.writeFileSync(other, 'png');
  assert.equal(jpegShot(other, { run: () => { throw new Error('no sips'); } }), other);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a contact sheet covers the whole video: a frame a second when short, fewer when long', () => {
  assert.deepEqual(sheetPlan({ duration: 55, width: 1206, height: 2622 }), { cols: 10, rows: 3, per: 30, step: 1, count: 55, sheets: 2, tileWidth: 156 });
  const long = sheetPlan({ duration: 600, width: 1920, height: 1080 });
  assert.equal(long.step, 10);
  assert.equal(long.sheets, 2);
  assert.equal(long.cols * long.rows, 30);
  assert.equal(sheetPlan({ duration: 8, width: 1920, height: 1080 }).sheets, 1);
  assert.equal(sheetPlan({ duration: 0.4 }).count, 1);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('watching a video gives sheets of frames in order and larger frames', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-watch-'));
  const file = path.join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=30', '-pix_fmt', 'yuv420p', file]);
  assert.equal(made.status, 0, String(made.stderr));
  const u = understand(file);
  assert.equal(Math.round(u.duration), 6);
  assert.equal(u.sheets.length, 1);
  assert.equal(u.sheets[0].step, 1);
  assert.ok(fs.statSync(u.sheets[0].file).size > 1000);
  assert.ok(u.frames.length >= 4 && u.frames.every((f) => fs.existsSync(f.file)));
  assert.equal(u.text, '', 'no sound: no transcript, and no error');
  fs.rmSync(path.dirname(u.sheets[0].file), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const { hedgedLook } = await import('../src/serve.js');
const wait = (ms, signal) => new Promise((ok, no) => { const t = setTimeout(ok, ms); signal?.addEventListener('abort', () => { clearTimeout(t); no(new Error('aborted')); }); });

test('a quick first model is the only one asked', async () => {
  const asked = [];
  const r = await hedgedLook(['a', 'b'], async (id, { onText }) => { asked.push(id); onText('Hi'); return 'Hi there.'; }, { hedgeMs: 50 });
  assert.deepEqual({ id: r.id, text: r.text }, { id: 'a', text: 'Hi there.' });
  await wait(80);
  assert.deepEqual(asked, ['a']);
});

test('a model that fails hands over to the next at once, not to the slow path', async () => {
  const t0 = Date.now();
  const r = await hedgedLook(['a', 'b'], async (id) => { if (id === 'a') throw new Error('HTTP 429 Too Many Requests'); return 'From b.'; }, { hedgeMs: 5000 });
  assert.equal(r.id, 'b');
  assert.equal(r.text, 'From b.');
  assert.match(r.errors[0], /a: HTTP 429/);
  assert.ok(Date.now() - t0 < 1000, 'did not wait for the hedge timer');
});

test('a silent first model is overtaken; the one that speaks first is heard and the other stopped', async () => {
  let aStopped = false;
  const heard = [];
  const r = await hedgedLook(['slow', 'quick'], async (id, { signal, onText }) => {
    if (id === 'slow') { try { await wait(2000, signal); } catch (e) { aStopped = true; throw e; } onText('late'); return 'late'; }
    await wait(20, signal); onText('Quick'); await wait(20, signal); onText('Quick answer.'); return 'Quick answer.';
  }, { hedgeMs: 40, onText: (soFar, id) => heard.push(`${id}:${soFar}`) });
  assert.equal(r.id, 'quick');
  assert.equal(r.text, 'Quick answer.');
  assert.equal(aStopped, true);
  assert.deepEqual(heard, ['quick:Quick', 'quick:Quick answer.']);
});

test('once one model has started speaking, a later one is never mixed in', async () => {
  const heard = [];
  const r = await hedgedLook(['a', 'b'], async (id, { signal, onText }) => {
    if (id === 'a') { await wait(60, signal); onText('A one.'); await wait(60, signal); return 'A one. A two.'; }
    await wait(500, signal); onText('B'); return 'B';
  }, { hedgeMs: 30, onText: (soFar, id) => heard.push(id) });
  assert.equal(r.id, 'a');
  assert.equal(r.text, 'A one. A two.');
  assert.deepEqual(heard, ['a']);
});

test('no model answering is reported with each reason', async () => {
  const r = await hedgedLook(['a', 'b'], async (id) => { if (id === 'a') throw new Error('down'); return ''; }, { hedgeMs: 10 });
  assert.equal(r.id, null);
  assert.equal(r.text, '');
  assert.equal(r.errors.length, 2);
  assert.deepEqual(await hedgedLook([], async () => 'x'), { id: null, text: '', errors: ['no model'] });
});

test('a question that needs a place on screen is told apart from one that needs only words', async () => {
  const { wantsPlace } = await import('../src/serve.js');
  for (const t of ['point at the Apple menu', 'where is the export button', 'where do I click to rename', 'show me how to turn on dark mode', 'how do I export this', 'circle the error', 'which button saves it']) assert.equal(wantsPlace(t), true, t);
  for (const t of ['what am I looking at', 'what does this error mean', 'can you see any blue colour on my current page', 'read this to me', 'summarise this page']) assert.equal(wantsPlace(t), false, t);
});
