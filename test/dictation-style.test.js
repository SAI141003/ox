// Dictation styles and translation, per app (src/dictation-style.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('styles per app, translation, and a safe fallback to what was said', async () => {
  process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dict-'));
  const D = await import('../src/dictation-style.js');
  assert.deepEqual(D.styleFor('Mail'), { style: 'as-said', translate: null });
  assert.deepEqual(await D.restyle('um hi', 'Mail', async () => { throw new Error('not called'); }), { text: 'um hi', style: 'as-said', changed: false });
  D.setStyle('natural'); D.setStyle('polished', 'Mail'); D.setTranslate('French');
  assert.deepEqual(D.styleFor('Mail'), { style: 'polished', translate: 'French' });
  assert.equal(D.styleFor('Notes').style, 'natural');
  let sys = '';
  const r = await D.restyle('um so hi', 'Mail', async ({ system }) => { sys = system; return '"Bonjour."'; });
  assert.equal(r.text, 'Bonjour.');
  assert.match(sys, /well-formed writing/);
  assert.match(sys, /into French/);
  assert.match(sys, /pasted into Mail/);
  assert.equal((await D.restyle('um hi', 'Mail', async () => { throw new Error('offline'); })).text, 'um hi');
  assert.equal((await D.restyle('hi', 'Mail', async () => 'x'.repeat(5000))).text, 'hi', 'a runaway answer is not pasted');
  D.setTranslate('off');
  assert.equal(D.styleFor('Mail').translate, null);
  assert.throws(() => D.setStyle('fancy'), /a style is one of/);
});
