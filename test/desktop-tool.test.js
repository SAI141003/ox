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
  for (const a of DESKTOP_ACTS) assert.ok(!/close|quit|mouse|key-down/.test(a), a);
  // Only these two move the real pointer, because agent-desktop allows them no other way.
  const headed = DESKTOP_ACTS.filter((a) => (commandFor({ action: a, value: 'x', app: 'x', surface: 'dock', text: 'x', toRef: '@s1:e2' }, '@s1:e1') ?? []).includes('--headed'));
  assert.deepEqual(headed, ['hover', 'drag']);
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

test('no desktop hand yet: ox asks once, installs the pinned build, then carries on; a no installs nothing', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { desktop } = await import('../src/tools/desktop.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dt-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'agent-desktop.cmd' : 'agent-desktop');
  const env = { ...process.env, OX_TEST_DESKTOP_INSTALL: '1', OX_AGENT_DESKTOP: bin };
  let installs = 0;
  const installAgentDesktop = async () => {
    installs++;
    fs.writeFileSync(bin, process.platform === 'win32' ? '@echo {"ok":true,"data":[]}\r\n' : '#!/bin/sh\necho \'{"ok":true,"data":[]}\'\n', { mode: 0o755 });
  };
  const asked = [];
  const no = Object.assign(async (tool, a, what, opts) => { asked.push({ tool, what, opts }); return false; }, { honorsForce: true });
  const r1 = await desktop({ action: 'apps' }, { env, requestApproval: no, installAgentDesktop });
  assert.match(String(r1.content ?? r1.error ?? JSON.stringify(r1)), /declined/);
  assert.equal(installs, 0, 'a no installs nothing');
  assert.equal(asked[0].tool, 'desktop_install');
  assert.equal(asked[0].opts.force, true, 'asked even under -y');
  assert.match(asked[0].what, /SHA-256/);
  const unread = await desktop({ action: 'apps' }, { env, yolo: true, requestApproval: async () => true, installAgentDesktop });
  assert.equal(installs, 0, '-y with an approver that cannot ask does not download');
  assert.match(String(unread.content ?? JSON.stringify(unread)), /ox desktop install/);
  const yes = Object.assign(async () => true, { honorsForce: true });
  await desktop({ action: 'apps' }, { env, requestApproval: yes, installAgentDesktop });
  assert.equal(installs, 1, 'a yes installs it');
  assert.ok(fs.existsSync(bin));
});
