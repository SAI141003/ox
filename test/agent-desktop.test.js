// agent-desktop as ox's desktop hand: ox's tools read and act through it when
// it is installed, and ox's own rules (never Send/Pay/Delete, never Return) stay
// on top. A fake agent-desktop answers here; no real app is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-agent-desktop-'));
const log = path.join(dir, 'calls.log');
const bin = path.join(dir, process.platform === 'win32' ? 'agent-desktop.cmd' : 'agent-desktop');
const fake = path.join(dir, 'fake.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const ok = (data) => console.log(JSON.stringify({ version: '2.6', ok: true, command: a[0], data }));
const tree = { role: 'window', name: 'Mail', children: [
  { role: 'textfield', name: 'Subject', ref_id: '@s1:e1', available_actions: ['SetValue', 'TypeText'], bounds: { x: 10, y: 20, width: 300, height: 24 } },
  { role: 'button', name: 'Save draft', ref_id: '@s1:e2', available_actions: ['Click'], bounds: { x: 10, y: 60, width: 90, height: 28 } },
  { role: 'button', name: 'Send', ref_id: '@s1:e3', available_actions: ['Click'] },
] };
if (a[0] === 'snapshot') ok({ app: 'Mail', window: { title: 'New Message' }, snapshot_id: 's1', tree });
else ok({});
`);
if (process.platform === 'win32') fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
else { fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(bin, 0o755); }
process.env.OX_AGENT_DESKTOP = bin;
process.env.OX_OPERATOR_DRY = '0';
const T = await import('../src/tools/operator.js');
const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const yes = { yolo: false, requestApproval: async () => true };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('ui_elements lists the window through agent-desktop, numbered, Send marked as one ox will not press', async () => {
  const r = await T.ui_elements({ app: 'Mail' });
  assert.equal(r.isError, undefined, r.content);
  assert.match(r.content, /Mail · New Message: 3 controls/);
  assert.match(r.content, /2\. button: Save draft/);
  assert.match(r.content, /3\. button: Send.*ox will not press this/);
  assert.deepEqual(calls().at(-1), ['snapshot', '--app', 'Mail', '-i', '--compact', '--include-bounds']);
});

test('click presses the ref without moving the pointer; Send is refused before anything is pressed', async () => {
  const r = await T.click({ app: 'Mail', element: 'Save draft' }, yes);
  assert.match(r.content, /clicked button "Save draft" in Mail .*pointer did not move/);
  assert.deepEqual(calls().at(-1), ['click', '@s1:e2']);
  const n = calls().length;
  const send = await T.click({ app: 'Mail', element: 'Send' }, yes);
  assert.equal(send.isError, true);
  assert.match(send.content, /does not press "Send"/);
  assert.ok(!calls().slice(n).some((c) => c[0] === 'click'), 'nothing was pressed');
});

test('type_text into a field types into its ref and sends nothing; press_key never presses Return', async () => {
  const r = await T.type_text({ app: 'Mail', into: 'Subject', text: 'Hello' }, yes);
  assert.match(r.content, /typed 5 characters into textfield "Subject"/);
  assert.deepEqual(calls().at(-1), ['type', '@s1:e1', 'Hello']);
  const ret = await T.press_key({ key: 'return' }, yes);
  assert.equal(ret.isError, true);
  const k = await T.press_key({ key: 'cmd+f', app: 'Mail' }, yes);
  assert.match(k.content, /pressed cmd\+f in Mail/);
  assert.deepEqual(calls().at(-1), ['press', 'cmd+f', '--app', 'Mail']);
});

test('ox swarm --app reviews a desktop app read-only: a nameless or tiny button is found, Send is only read', async () => {
  const { runDesktopSwarmReview } = await import('../src/swarm-review.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-swarm-desktop-'));
  try {
    const n = calls().length;
    const r = await runDesktopSwarmReview('Mail', { agents: 2, out });
    assert.equal(r.total, 3);
    assert.ok(!calls().slice(n).some((c) => ['click', 'type', 'press', 'set-value'].includes(c[0])), 'a review never acts');
    assert.ok(fs.existsSync(r.reportFile));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('map and drill read as short lines with refs, and teach ox what each ref is', async () => {
  const { describeTree } = await import('../src/tools/desktop.js');
  const text = describeTree({ role: 'window', name: 'Mail', children: [{ role: 'group', ref_id: '@s1:e5', name: 'Sidebar', children_count: 12 }, { role: 'button', name: 'Send', ref_id: '@s1:e3' }] });
  assert.match(text, /@s1:e5 group "Sidebar" \(12 inside\)/);
  assert.match(text, /@s1:e3 button "Send"/);
});

test('a ref gets no way around the rules: Send stays refused, unknown refs too, and no Return in text', async () => {
  const { desktop, describeTree } = await import('../src/tools/desktop.js');
  describeTree({ role: 'window', children: [{ role: 'button', name: 'Send', ref_id: '@s1:e3' }, { role: 'textfield', name: 'Subject', ref_id: '@s1:e1' }] });
  const yes = { requestApproval: async () => true };
  assert.match((await desktop({ action: 'click', element: '@s1:e3' }, yes)).content, /does not touch "Send"/);
  assert.match((await desktop({ action: 'click', element: '@s9:e9' }, yes)).content, /not from a map or drill/);
  assert.match((await desktop({ action: 'type', element: '@s1:e1', text: 'hi\nthere' }, yes)).content, /never presses Return/);
  assert.match((await desktop({ action: 'notification_action', index: 1, value: 'Delete' }, yes)).content, /does not press "Delete"/);
  const typed = await desktop({ action: 'type', element: '@s1:e1', text: 'hi' }, yes);
  assert.equal(typed.isError, undefined, typed.content);
});

test('each agent acts under its own id in one session', async () => {
  const A = await import('../src/agent-desktop.js');
  assert.equal(A.agentIdOf({ agentName: 'Lead dev!' }), 'Lead-dev-');
  assert.equal(A.agentIdOf({}, {}), 'ox');
  assert.match(A.agentIdOf({ depth: 2 }, {}), /^helper-\d+-2$/);
});

test('the installer refuses a file that does not match the pinned checksum', async () => {
  const A = await import('../src/agent-desktop.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ad-'));
  const bad = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('not the file').buffer });
  await assert.rejects(A.installAgentDesktop({ env: { OX_HOME: home }, platform: 'darwin', arch: 'arm64', fetchImpl: bad }), /does not match its published checksum/);
  assert.equal(fs.existsSync(path.join(home, 'vendor', 'agent-desktop')), false);
  assert.equal(Object.keys(A.AGENT_DESKTOP_FILES).length, 6);
});
