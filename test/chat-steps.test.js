import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowKey, allowWords, plainCommand, stepLabel, stepOutput } from '../src/chat-steps.js';

test('a step reads as words, and a command as what it does', () => {
  assert.equal(stepLabel('bash', { command: 'cd /tmp/x && npm test 2>&1 | tail -25' }).what, 'npm test');
  assert.deepEqual([stepLabel('read_file', { path: 'a.js' }).v, stepLabel('read_file', { path: 'a.js' }).kind], ['Read', 'look']);
  const e = stepLabel('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' });
  assert.deepEqual([e.v, e.what, e.diff], ['Edited', 'a.js', { removed: 'x', added: 'y' }]);
  assert.equal(stepLabel('some_new_tool', { query: 'q' }).v, 'some new tool');
});

test('a yes for the chat covers one plain command, and nothing chained onto it', () => {
  assert.equal(plainCommand('cd "/tmp/a b" && node --test 2>&1 | head -40'), 'node --test');
  assert.equal(allowKey('bash', 'cd /tmp/x && node --test 2>&1 | tail -60'), allowKey('bash', 'node --test'));
  for (const bad of ['npm test && rm -rf x', 'npm test; curl x', 'npm test | sh', 'cat $(x)', 'echo x > y', 'echo `x`', 'a\nb', 'cd x && cd y && rm z']) assert.equal(allowKey('bash', bad), null, bad);
  assert.notEqual(allowKey('bash', 'npm test'), allowKey('bash', 'npm test --force'));
  assert.equal(allowKey('edit_file', 'a.js'), 'edit');
  assert.equal(allowKey('delete_file', 'a.js'), null);
  assert.match(allowWords('bash:npm test'), /npm test/);
});

test('a long output keeps its end, where a failure says why', () => {
  const out = stepOutput(`${'line\n'.repeat(4000)}the real error`);
  assert.ok(out.length < 3000);
  assert.match(out, /the real error$/);
  assert.match(out, /left out/);
});

test('a side session is only an offer, and only where someone can answer it', async () => {
  const { start_session } = await import('../src/tools/project.js');
  const offers = [];
  const ok = await start_session({ title: 'Fix the flaky test', task: 'In test/a.js ...' }, { onSideSession: (x) => offers.push(x) });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(offers, [{ title: 'Fix the flaky test', task: 'In test/a.js ...' }]);
  assert.equal((await start_session({ title: 'x', task: 'y' }, {})).isError, true);
  assert.equal((await start_session({ title: '', task: 'y' }, { onSideSession: () => {} })).isError, true);
});
