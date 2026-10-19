import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRisky, parseKey, elementAt, findElement } from '../src/mac-control.js';
import { MAC_TOOLS, callMacTool } from '../src/mac-mcp.js';
import { claudeMacMcpArgs } from '../src/subscriptions.js';

const els = [
  { id: 1, role: 'AXTextField', name: '', description: 'Search', value: '', frame: [10, 10, 200, 30] },
  { id: 2, role: 'AXRow', name: 'Anna Smith', description: '', value: '', frame: [0, 50, 300, 60] },
  { id: 3, role: 'AXStaticText', name: 'Anna', description: '', value: 'Anna', frame: [20, 60, 60, 20] },
  { id: 4, role: 'AXButton', name: 'Send', description: '', value: '', frame: [400, 500, 40, 40] },
  { id: 5, role: 'AXTextArea', name: '', description: 'Message', value: '', frame: [0, 500, 390, 40] },
];

test('mac-control: Send, Pay, Delete and the like are risky; ordinary controls are not', () => {
  for (const name of ['Send', 'Pay now', 'Buy', 'Delete chat', 'Submit', 'Confirm transfer', 'Place order', 'Log out']) assert.equal(isRisky({ name }), true, name);
  for (const name of ['Search', 'Anna Smith', 'New chat', 'Attach', 'Emoji', 'Sender settings']) assert.equal(isRisky({ name }), false, name);
  assert.equal(isRisky({ name: '', description: 'Send message' }), true);
});

test('mac-control: Return and Enter are never pressed; navigation and safe shortcuts are', () => {
  assert.match(parseKey('return').error, /never presses Return/);
  assert.match(parseKey('cmd+enter').error, /never presses Return/);
  assert.equal(parseKey('tab').code, 48);
  assert.deepEqual(parseKey('shift+tab').mods, ['shift down']);
  assert.equal(parseKey('cmd+f').char, 'f');
  assert.ok(parseKey('cmd+q').error, 'quit is not pressed');
  assert.ok(parseKey('cmd+w').error, 'close is not pressed');
  assert.ok(parseKey('a').error, 'letters go through type_text');
  assert.ok(parseKey('hyper+x').error);
});

test('mac-control: a click point maps to the smallest control under it', () => {
  assert.equal(elementAt(els, 30, 65).id, 3);
  assert.equal(elementAt(els, 200, 70).id, 2);
  assert.equal(elementAt(els, 420, 520).name, 'Send');
  assert.equal(elementAt(els, 900, 900), null);
});

test('mac-control: controls are found by name, exact before partial, narrowed by role', () => {
  assert.equal(findElement(els, 'anna').id, 3);
  assert.equal(findElement(els, 'anna', 'row').id, 2);
  assert.equal(findElement(els, 'message', 'text area').id, 5);
  assert.equal(findElement(els, 'search').id, 1);
  assert.equal(findElement(els, 'nobody'), null);
});

test('mac-mcp: click and type tools are offered, and Claude Code may use them', () => {
  const names = MAC_TOOLS.map((t) => t.name);
  for (const n of ['ui_elements', 'click', 'type_text', 'press_key']) assert.ok(names.includes(n), n);
  const args = claudeMacMcpArgs({});
  const allowed = args[args.indexOf('--allowedTools') + 1];
  for (const n of ['ui_elements', 'click', 'type_text', 'press_key']) assert.ok(allowed.includes(`mcp__ox__${n}`), n);
});

test('mac-mcp: Return is refused before anything is pressed; a dry type says what it would do', async () => {
  const r = await callMacTool('press_key', { key: 'return' }, { dryRun: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /never presses Return/);
  const t = await callMacTool('type_text', { text: 'on my way 🐂\nsee you' }, { dryRun: true });
  assert.match(t.text, /would type 19 characters/);
  assert.equal((await callMacTool('type_text', { text: '' }, { dryRun: true })).isError, true);
});
