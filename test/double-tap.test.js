// Double Tap: a reply drafted in the user's voice from the conversation on
// screen, never sent. Fake screen, fake model, a home with no Messages access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-doubletap-'));
process.env.OX_HOME = path.join(dir, '.ox');
const bin = path.join(dir, 'agent-desktop');
const fake = path.join(dir, 'fake.mjs');
fs.writeFileSync(fake, `console.log(JSON.stringify({ ok: true, command: 'snapshot', data: { tree: { role: 'window', name: 'Messages', children: [
  { role: 'statictext', value: 'Priya: are we still on for dinner Friday?' },
  { role: 'statictext', value: 'Priya: I can book the Thai place at 7' },
  { role: 'textfield', name: 'iMessage', ref_id: '@s:e1' } ] } } }));`);
fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(bin, 0o755);
process.env.OX_AGENT_DESKTOP = bin;
const D = await import('../src/double-tap.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the writing-style file is made once (a template when Messages cannot be read) and never overwritten', () => {
  const a = D.ensureStyle({ home: dir });
  assert.equal(a.created, true);
  assert.match(fs.readFileSync(a.file, 'utf8'), /# How I write/);
  fs.writeFileSync(a.file, '# How I write\n- hey! sounds good :)\n');
  const b = D.ensureStyle({ home: dir });
  assert.equal(b.created, false);
  assert.match(fs.readFileSync(a.file, 'utf8'), /sounds good :\)/, 'your edits stay');
});

test('a draft reads the conversation on screen and your style, and comes back as the message alone', { skip: process.platform === 'win32' && 'the fake agent-desktop is a shell script' }, async () => {
  let seen;
  const r = await D.draftReply({ app: 'Messages', ask: async ({ system, user }) => { seen = { system, user }; return 'Here\'s a draft: "yes! 7 works, book it 🙌"'; } });
  assert.match(seen.user, /Thai place at 7/);
  assert.match(seen.user, /sounds good :\)/, 'the writing examples are in the prompt');
  assert.match(seen.system, /never invent facts/);
  assert.equal(r.draft, 'yes! 7 works, book it 🙌');
});

test('the prompt carries what the reply should do, and the screen is optional', () => {
  const p = D.replyPrompt({ conversation: '', instruction: 'say no politely' });
  assert.match(p, /say no politely/);
  assert.match(p, /nothing could be read/);
});
