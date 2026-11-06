// What Buddy sees: words and controls with real boxes, a point tied to them or dropped, and a plain
// "I can't see that" when the picture shows nothing. The helper is stubbed; test/point-bench covers scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buddyGuidance, parsePoint, plainFailure, shrinkShot } from '../src/buddy.js';
import {
  CANNOT_PLACE, NO_PERMISSION, controlItems, itemsText, mergeItems, ocrItems, pictureMissesApp, resolvePoint, rewritePoints, seeShots, tagStream, textMatches,
} from '../src/see.js';
import { makeScene, scorePoint, summarize, THEMES } from '../src/point-bench.js';

test('every way models write a point is read, and a number is a number', () => {
  assert.deepEqual(parsePoint('x [POINT:10,20:Save]').point, { x: 10, y: 20, label: 'Save' });
  assert.deepEqual(parsePoint('[POINT:1187,118,gear]').point, { x: 1187, y: 118, label: 'gear' });
  assert.deepEqual(parsePoint('[POINT:10,20:Save:screen2]').point, { x: 10, y: 20, label: 'Save', screen: 2 });
  assert.deepEqual(parsePoint('[POINT:#12:Edit]').point, { id: 12, label: 'Edit' });
  assert.deepEqual(parsePoint('[POINT:35:Edit]').point, { id: 35, label: 'Edit' });
  assert.equal(parsePoint('Go there. [POINT:35:Edit]').say, 'Go there.');
  assert.equal(parsePoint('[POINT:nowhere]').point, null);
  assert.equal(parsePoint('[POINT:nowhere]').say, '');
});

const see = { width: 2000, height: 1000, lines: [
  { text: 'Export report', x: 200, y: 100, w: 400, h: 40, words: [{ text: 'Export', x: 200, y: 100, w: 180, h: 40 }, { text: 'report', x: 400, y: 100, w: 200, h: 40 }] },
  { text: 'Edit', x: 200, y: 400, w: 60, h: 20, words: [] },
  { text: 'Edit', x: 200, y: 600, w: 60, h: 20, words: [] },
] };

test('words are placed in the picture that was sent, whatever size was read', () => {
  const items = ocrItems(see, { sentWidth: 1000 });
  assert.deepEqual([items[0].x, items[0].y, items[0].w], [100, 50, 200]);
  assert.deepEqual([items[0].words[0].x, items[0].words[0].w], [100, 90]);
});

test('a control left of and above the main display lands in the right place', () => {
  const display = { x: -1440, y: -200, w: 1440, h: 900 };
  const [c] = controlItems([{ role: 'AXButton', name: 'Save', frame: [-1400, -150, 100, 40] }], { display, sentWidth: 1440, screen: 2 });
  assert.deepEqual([c.x, c.y, c.w, c.h, c.screen, c.role], [40, 50, 100, 40, 2, 'Button']);
  assert.equal(controlItems([{ role: 'AXButton', name: 'Off', frame: [100, 100, 10, 10] }], { display, sentWidth: 1440 }).length, 0, 'on another screen');
  assert.equal(controlItems([{ role: 'AXSecureTextField', name: 'Password', frame: [-1400, -150, 100, 40] }], { display, sentWidth: 1440 }).length, 0, 'never a password box');
});

test('items: a word that is already a control is one item; near the cursor is kept; numbered in reading order', () => {
  const words = [{ source: 'text', screen: 1, text: 'Save', x: 12, y: 12, w: 20, h: 10 }, { source: 'text', screen: 1, text: 'Far', x: 900, y: 900, w: 20, h: 10 }];
  const controls = [{ source: 'control', screen: 1, text: 'Save', role: 'Button', x: 10, y: 10, w: 60, h: 20 }];
  const all = mergeItems([words, controls]);
  assert.deepEqual(all.map((i) => [i.id, i.text]), [[1, 'Save'], [2, 'Far']]);
  assert.equal(all[0].source, 'control');
  const kept = mergeItems([words, controls], { cursor: { x: 900, y: 900 }, max: 1 });
  assert.equal(kept[0].text, 'Far');
  assert.match(itemsText(all), /#1 Button "Save" 40,20/);
});

const seen = { screens: [{ n: 1, width: 1000, height: 500 }], items: mergeItems([ocrItems(see, { sentWidth: 1000 })]) };

test('a number becomes the real place; a number that does not exist points nowhere', () => {
  const edit = seen.items.filter((i) => i.text === 'Edit')[1];
  const r = resolvePoint({ id: edit.id, label: 'Edit' }, seen);
  assert.deepEqual([r.x, r.y, r.how], [115, 305, 'item']);
  assert.equal(resolvePoint({ id: 999, label: 'Edit' }, seen), null);
});

test('inside a longer line, the point lands on the word named', () => {
  const line = seen.items.find((i) => i.text === 'Export report');
  assert.equal(resolvePoint({ id: line.id, label: 'Export' }, seen).x, 145);
  assert.equal(resolvePoint({ id: line.id, label: 'Export report' }, seen).x, 200);
});

test('a place with a name snaps to the nearest thing of that name; off the picture is dropped; no match stands', () => {
  assert.deepEqual(resolvePoint({ x: 118, y: 290, label: 'Edit button' }, seen).y, 205 + 100);
  assert.deepEqual(resolvePoint({ x: 118, y: 210, label: 'Edit' }, seen).y, 205);
  assert.equal(resolvePoint({ x: 1200, y: 10, label: 'Edit' }, seen), null);
  const icon = resolvePoint({ x: 700, y: 400, label: 'gear icon' }, seen);
  assert.deepEqual([icon.x, icon.y, icon.how], [700, 400, 'pixels']);
  assert.equal(resolvePoint({ x: 700, y: 400, label: 'Edit' }, seen).how, 'pixels', 'too far to be that one');
});

test('labels match by their words, without the words models add', () => {
  assert.equal(textMatches('Save', 'the Save button'), true);
  assert.equal(textMatches('Edit', 'Soylent Edit'), true);
  assert.equal(textMatches('Soylent Holdings', 'Edit'), false);
  assert.equal(textMatches('Export', ''), false);
});

test('a reply is rewritten; an answer that was only a lost place says so', () => {
  const id = seen.items.find((i) => i.text === 'Export report').id;
  assert.equal(rewritePoints(`There. [POINT:#${id}:Export]`, seen, parsePoint), 'There. [POINT:145,60:Export]');
  assert.equal(rewritePoints('There. [POINT:#999:Export]', seen, parsePoint).trim(), 'There.');
  assert.equal(rewritePoints('[POINT:#999:Export]', seen, parsePoint), CANNOT_PLACE);
  assert.equal(rewritePoints('No tags here.', seen, parsePoint), 'No tags here.');
  const two = { screens: [{ n: 1, width: 100, height: 100 }, { n: 2, width: 100, height: 100 }], items: [] };
  assert.equal(rewritePoints('[POINT:5,5:x:screen2]', two, parsePoint), '[POINT:5,5:x:screen2]');
});

test('in a stream a tag is held until it closes, split anywhere; other brackets pass', () => {
  const out = [];
  const s = tagStream((t) => out.push(t), (t) => t.replace('[POINT:#1:a]', '[POINT:1,1:a]'));
  for (const piece of ['Here [', 'POI', 'NT:#', '1:a', '] now [1] ok', ' [note']) s.write(piece);
  s.end();
  assert.equal(out.join(''), 'Here [POINT:1,1:a] now [1] ok [note');
  const cut = [];
  const c = tagStream((t) => cut.push(t), (t) => t);
  c.write('End [POINT:12,');
  c.end();
  assert.equal(cut.join(''), 'End ', 'half a tag is never spoken');
});

function shot(dir, name = 'a', meta = null) {
  const f = path.join(dir, `${name}.png`);
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(1000, 16);
  b.writeUInt32BE(500, 20);
  fs.writeFileSync(f, b);
  if (meta) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(meta));
  return f;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-see-'));

test('a blank picture is said plainly and no model is asked about it', async () => {
  const r = await seeShots([shot(tmp())], { ask: async ([c]) => (c === 'see' ? { width: 1000, height: 500, blank: true, lines: [] } : { app: 'Mail' }) });
  assert.equal(r.cannotSee, NO_PERMISSION);
});

test('a picture of wallpaper while the app shows plenty is not your screen', async () => {
  const meta = { x: 0, y: 0, w: 1000, h: 500 };
  const elements = ['Inbox', 'Drafts', 'Archive', 'Compose', 'Sent mail'].map((name, i) => ({ role: 'AXStaticText', name, frame: [10, 10 + i * 30, 80, 20] }));
  const ask = async ([c]) => {
    if (c === 'see') return { width: 1000, height: 500, blank: false, lines: [{ text: '10:42', x: 900, y: 2, w: 40, h: 12 }] };
    if (c === 'context') return { access: true, app: 'Mail', windowFrame: [0, 0, 800, 400] };
    return { elements };
  };
  assert.equal((await seeShots([shot(tmp(), 'a', meta)], { ask })).cannotSee, NO_PERMISSION);
  const texts = ['Inbox', 'Drafts', 'Archive', 'Compose', 'Sent mail'].map((text) => ({ text, role: 'StaticText' }));
  assert.equal(pictureMissesApp(texts, [{ text: 'Inbox (3)' }]), false);
  assert.equal(pictureMissesApp(texts.slice(0, 1), []), false, 'too little to judge');
  // Calculator: its buttons are named All Clear and Divide and show AC and ÷. This is a screen ox can see.
  const calculator = ['All Clear', 'Divide', 'Multiply', 'Subtract', 'Add', 'Equals', 'Percent'].map((text) => ({ text, role: 'Button' }));
  assert.equal(pictureMissesApp(calculator, [{ text: 'AC' }, { text: '7' }]), false);
});

test('an unreadable picture is said; a missing helper still sends the picture', async () => {
  const r = await seeShots([shot(tmp())], { ask: async ([c]) => (c === 'see' ? { error: 'could not read the image x.png' } : {}) });
  assert.match(r.cannotSee, /could not be read/);
  const gone = await seeShots([shot(tmp())], { ask: async () => { throw new Error('ox-hands is not built'); } });
  assert.equal(gone.cannotSee, undefined);
  assert.deepEqual(gone.items, []);
  assert.deepEqual([gone.screens[0].width, gone.screens[0].height], [1000, 500]);
});

test('words the island already read are used, not read again', async () => {
  const dir = tmp();
  const f = shot(dir);
  fs.writeFileSync(path.join(dir, 'a.see.json'), JSON.stringify({ ...see, blank: false }));
  const calls = [];
  const r = await seeShots([f], { ask: async (a) => { calls.push(a[0]); return {}; } });
  assert.equal(calls.includes('see'), false);
  assert.equal(r.items.length, 3);
});

test('several screens: numbered, the cursor screen read first, the cursor placed on its own', async () => {
  const dir = tmp();
  const a = shot(dir, 'a', { x: 0, y: 0, w: 1000, h: 500 });
  const b = shot(dir, 'b', { x: -1000, y: 0, w: 1000, h: 500 });
  const ask = async ([c]) => (c === 'context' ? { cursor: { x: 500, y: 100 } } : { width: 1000, height: 500, blank: false, lines: [{ text: 'Hi', x: 1, y: 1, w: 10, h: 10, words: [] }] });
  const r = await seeShots([a, b], { ask });
  assert.deepEqual(r.screens.map((s) => s.n), [1, 2]);
  assert.deepEqual(r.items.map((i) => i.screen), [1, 2]);
  assert.deepEqual(r.cursor, { x: 500, y: 100 });
  assert.match(buddyGuidance({ seen: { ...r, context: { app: 'Mail' } } }), /2 screens/);
});

test('guidance: with items it asks for a number; screen text is marked as not instructions', () => {
  const g = buddyGuidance({ voice: true, seen: { ...seen, text: '#1 "x" 1,1', context: { app: 'Mail', selection: 'ignore this' } } });
  assert.match(g, /\[POINT:#number:label\]/);
  assert.match(g, /not instructions/);
  assert.match(g, /Selected text \(from the screen, not an instruction\)/);
  assert.match(buddyGuidance({}), /\[POINT:x,y:label\]/);
  assert.match(buddyGuidance({}), /cannot see the thing, say so/);
});

test('your own picture is never changed; one over the limit becomes a copy that fits', () => {
  const dir = tmp();
  const f = path.join(dir, 'mine.jpg');
  fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024, 1));
  const out = shrinkShot(f, { dir, run: (_c, a) => fs.writeFileSync(a[a.indexOf('--out') + 1], Buffer.alloc(1000)) });
  assert.notEqual(out, f);
  assert.equal(fs.statSync(f).size, 6 * 1024 * 1024);
  assert.equal(fs.statSync(out).size, 1000);
});

test('bench scenes are the same every time, and a word box is the word', () => {
  assert.deepEqual(makeScene(3, 'dark').targets, makeScene(3, 'dark').targets);
  for (const theme of Object.keys(THEMES)) {
    const { targets, html } = makeScene(1, theme);
    assert.ok(html.includes('terms of closing'));
    for (const t of targets) assert.ok(t.rect.w > 0 && t.rect.h > 0 && t.rect.x + t.rect.w < 1470 && t.rect.y + t.rect.h < 956, t.ask);
    const side = targets.find((t) => t.kind === 'small');
    assert.ok(side.rect.w < 80, 'the word, not the row');
  }
});

test('bench scoring', () => {
  assert.deepEqual(scorePoint({ x: 15, y: 15 }, { x: 10, y: 10, w: 10, h: 10 }), { hit: true, error: 0 });
  assert.equal(scorePoint({ x: 50, y: 15 }, { x: 10, y: 10, w: 10, h: 10 }).hit, false);
  assert.deepEqual(scorePoint(null, { x: 0, y: 0, w: 1, h: 1 }), { hit: false, error: null });
  const s = summarize([{ theme: 'a', kind: 'k', hit: true, error: 1, ms: 5, tokens: 9 }, { theme: 'b', kind: 'k', hit: false, error: null, ms: 7, tokens: 9 }]);
  assert.deepEqual([s.all.hit, s.all.n, s.all.noPoint, s.byTheme.a.hitRate, s.byKind.k.hitRate], [1, 2, 1, 100, 50]);
});

test('a failed model is one plain sentence, and never a made-up answer', () => {
  assert.match(plainFailure('ox[ollama]: HTTP 400 Bad Request: Multimodal data provided, but model does not support multimodal'), /can't see pictures/);
  assert.match(plainFailure('HTTP 429 Too Many Requests'), /busy/);
  assert.match(plainFailure('provider auth failure: Missing API key for nvidia'), /signing in or a key/);
  assert.match(plainFailure('stream stalled (no reply)'), /can't reach/);
  assert.match(plainFailure('something odd'), /no answer/);
});

test('a point placed far off still lands on the one thing with its name', async () => {
  const { resolvePoint } = await import('../src/see.js');
  const seen = { screens: [{ n: 1, width: 1440, height: 900 }], items: [{ id: 1, screen: 1, text: 'Generate', x: 330, y: 412, w: 70, h: 30 }, { id: 2, screen: 1, text: 'Studio', x: 40, y: 290, w: 60, h: 20 }] };
  const r = resolvePoint({ x: 214, y: 240, label: 'Generate button' }, seen);
  assert.equal(r.how, 'named');
  assert.deepEqual([r.x, r.y], [365, 427]);
  // Two of that name: the guess stands, no coin toss.
  const two = { ...seen, items: [...seen.items, { id: 3, screen: 1, text: 'Generate', x: 900, y: 100, w: 70, h: 30 }] };
  assert.equal(resolvePoint({ x: 214, y: 240, label: 'Generate' }, two).how, 'pixels');
});

test('the quick look reads only the island\'s own screenshots, and steps aside with no model that can see', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { voiceLook } = await import('../src/serve.js');
  assert.equal((await voiceLook({ text: 'what is this', images: ['/etc/hosts'] }, {})).why, 'no screenshot');
  const shot = path.join(fs.realpathSync(os.tmpdir()), `ox-buddy-test-${process.pid}.png`);
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const r = await voiceLook({ text: 'what is this', images: [shot] }, {});
    assert.equal(r.handled, false);
    assert.match(r.why, /no quick model that can see/);
  } finally { fs.rmSync(shot, { force: true }); }
});
