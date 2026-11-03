// Learned shortcuts (Atticus's idea): plain actions done right replay with no
// model, in any word order or for another app; nothing risky, nothing that says
// "this", nothing that failed; your "when I say" phrases are yours to keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-shortcuts-'));
const env = { ...process.env, OX_HOME: path.join(dir, '.ox') };
delete env.OX_LEARN;
const S = await import('../src/shortcuts.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const ran = (calls) => calls.map(([name, args, ok = true]) => ({ name, args, ok }));

test('plain actions are learned and replayed for the same words in another order, and for another app', async () => {
  assert.equal(S.learnShortcut('hey can you open notes', ran([['ui_elements', {}], ['open_app', { name: 'notes' }]]), { env }), true);
  assert.equal(S.learnShortcut('open notes', ran([['open_app', { name: 'notes' }]]), { env }), false, 'known already');
  assert.ok(S.findShortcut('please open notes', { env }));
  const other = S.findShortcut('open safari', { env });
  assert.deepEqual(other.steps, [{ tool: 'open_app', args: { name: 'safari' } }]);
  const calls = [];
  const r = await S.replayShortcut(other, async (name, args) => { calls.push([name, args]); return { content: `opened ${args.name}` }; }, { env });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [['open_app', { name: 'safari' }]]);
});

test('never learned: a risky click, typing, Return, a run that failed, or words that depend on the moment', () => {
  assert.equal(S.learnShortcut('send the email', ran([['click', { element: 'Send' }]]), { env }), null);
  assert.equal(S.learnShortcut('write hello', ran([['type_text', { text: 'hello' }]]), { env }), null);
  assert.equal(S.learnShortcut('press enter', ran([['press_key', { key: 'return' }]]), { env }), null);
  assert.equal(S.learnShortcut('open finder', ran([['open_app', { name: 'finder' }, false]]), { env }), null);
  assert.equal(S.learnShortcut('close this', ran([['press_key', { key: 'cmd+w' }]]), { env }), null);
  assert.equal(S.learnShortcut('open finder', ran([['open_app', { name: 'finder' }]]), { env, reply: "I couldn't find it" }), null);
});

test('a step that fails on replay hands the request back', async () => {
  const sc = S.findShortcut('open notes', { env });
  const r = await S.replayShortcut(sc, async () => ({ isError: true, content: 'no such app' }), { env });
  assert.equal(r.ok, false);
});

test('"when I say focus mode, …" is parsed and kept as yours; forget removes it', () => {
  assert.deepEqual(S.parseNamed('When I say focus mode, close Slack and open Things'), { phrase: 'focus mode', then: 'close Slack and open Things' });
  assert.equal(S.parseNamed('open notes'), null);
  S.saveNamed('focus mode', 'close Slack and open Things', { env });
  const sc = S.findShortcut('Focus mode', { env });
  assert.equal(sc.alias, 'close Slack and open Things');
  assert.equal(sc.mine, true);
  assert.equal(S.forgetShortcut('focus mode', { env }), true);
  assert.equal(S.findShortcut('focus mode', { env }), null);
});

test('learned ones unused for 30 days go; yours stay', () => {
  const now = Date.now();
  S.learnShortcut('open mail', ran([['open_app', { name: 'mail' }]]), { env, now: now - 40 * 86_400_000 });
  S.saveNamed('night mode', 'open music', { env, now: now - 40 * 86_400_000 });
  S.learnShortcut('open maps', ran([['open_app', { name: 'maps' }]]), { env, now });
  const said = Object.values(S.readShortcuts(env)).map((v) => v.said);
  assert.ok(!said.includes('open mail'), 'the stale one went');
  assert.ok(said.includes('night mode') && said.includes('open maps'));
});
