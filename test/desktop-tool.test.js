// The rest of agent-desktop as ox's desktop tool, and what seeing an app costs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandFor, describeFound, DESKTOP_ACTS } from '../src/tools/desktop.js';
import { claudeImageTokens, gpt4oImageTokens, report } from '../src/desktop-bench.js';

test('each action becomes the agent-desktop command, nothing that quits apps or moves the mouse', () => {
  assert.deepEqual(commandFor({ action: 'find', app: 'Notes', text: 'Groceries', role: 'row' }), ['find', '--app', 'Notes', '--text', 'Groceries', '--role', 'row']);
  assert.deepEqual(commandFor({ action: 'scroll', direction: 'up', amount: 999 }, '@s1:e4'), ['scroll', '@s1:e4', '--direction', 'up', '--amount', '50']);
  assert.deepEqual(commandFor({ action: 'move_window', app: 'Notes', x: -100, y: 40 }), ['move-window', '--app', 'Notes', '--x=-100', '--y=40']);
  assert.deepEqual(commandFor({ action: 'focus_window', app: 'Notes' }), ['focus-window', '--app', 'Notes']);
  assert.deepEqual(commandFor({ action: 'select', value: 'Large' }, '@s1:e2'), ['select', '@s1:e2', 'Large']);
  for (const a of DESKTOP_ACTS) assert.ok(!/close|quit|mouse|key-down|drag/.test(a), a);
  assert.equal(commandFor({ action: 'close_app' }), null);
});

test('find answers in one short line per control, not the JSON', () => {
  const t = describeFound([{ role: 'button', name: 'New Note', enabled: true }, { role: 'textfield', name: 'Search', value: 'milk' }]);
  assert.equal(t, '1. button "New Note"\n2. textfield "Search" = milk');
  assert.equal(describeFound([]), 'nothing matched');
});

test('the cost of seeing an app: images priced as the providers do, text as ox counts it', () => {
  assert.equal(claudeImageTokens(1568, 980), Math.ceil((1568 * 980 / Math.max(1, 1568 * 980 / 1_150_000)) / 750));
  assert.ok(claudeImageTokens(2880, 1800) >= 1400 && claudeImageTokens(2880, 1800) <= 1600);
  assert.equal(gpt4oImageTokens(1024, 1024), 85 + 170 * 4);
  const r = report({ width: 2880, height: 1800, controlsText: 'button "New"\n'.repeat(20), findText: '1. button "New"' });
  assert.ok(r.times > 5, `ox list ${r.times}x`);
  assert.ok(r.findTimes > r.times);
});
