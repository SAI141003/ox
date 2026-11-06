// Who may use your screen: apps one by one, powerful apps flagged, send and delete asked each
// time, paying never, unattended runs never, one run at a time, and a stop from anywhere.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-computer-'));
process.env.OX_HOME = home;
const C = await import('../src/computer-control.js');
const { makeApprover } = await import('../src/approval.js');
const { parseKey } = await import('../src/mac-control.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const asking = (answer, seen = []) => Object.assign(async (tool, args, detail, opts) => { seen.push({ tool, detail, opts }); if (answer === 'always') { opts.onAlways?.(); return true; } return answer; }, { honorsForce: true });

test('an app is asked once, and "always" remembers that app only', async () => {
  const seen = [];
  const ctx = { requestApproval: asking('always', seen) };
  assert.equal((await C.gate(ctx, { tool: 'click', app: 'Notes', what: 'Click New' })).ok, true);
  assert.deepEqual(C.allowedApps(), ['Notes']);
  const none = { requestApproval: async () => { throw new Error('should not ask'); } };
  assert.equal((await C.gate(none, { tool: 'click', app: 'notes', what: 'Click New' })).ok, true, 'Notes is not asked again, whatever the case');
  assert.equal((await C.gate({ requestApproval: asking(false) }, { tool: 'click', app: 'Pages', what: 'Click New' })).ok, false, 'another app still asks');
  assert.equal(C.denyApp('Notes'), true);
  assert.deepEqual(C.allowedApps(), []);
});

test('terminals, Finder and System Settings carry a warning and cannot be always-allowed', async () => {
  for (const [app, re] of [['Terminal', /shell/], ['iTerm2', /shell/], ['Visual Studio Code', /shell/], ['Finder', /files/], ['System Settings', /settings/]]) {
    assert.match(C.appWarning(app), re);
    assert.throws(() => C.allowApp(app), /cannot be always-allowed/);
  }
  assert.equal(C.appWarning('Notes'), null);
  const seen = [];
  await C.gate({ requestApproval: asking(true, seen) }, { tool: 'click', app: 'Terminal', what: 'Click' });
  assert.match(seen[0].detail, /Warning: Terminal is as good as a shell/);
  assert.equal(seen[0].opts.onAlways, undefined, 'no "always" is offered');
});

test('send and delete ask every time: an always-allowed app and -y do not skip it', async () => {
  C.allowApp('Mail');
  const seen = [];
  assert.equal((await C.gate({ yolo: true, requestApproval: asking(true, seen) }, { tool: 'click', app: 'Mail', force: true, what: 'Press Send' })).ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.force, true);
  assert.equal((await C.gate({ yolo: true }, { tool: 'click', app: 'Mail', force: true, what: 'Press Send' })).ok, false, 'nobody to ask');
  assert.equal((await C.gate({ yolo: true, requestApproval: async () => true }, { tool: 'click', app: 'Mail', force: true, what: 'Press Send' })).ok, false, 'an approver that would say yes unread');
  C.denyApp('Mail');
});

test('the terminal approver: force ignores -y and an earlier always, with no one there it declines', async () => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const yolo = makeApprover({ yolo: true });
    assert.equal(yolo.honorsForce, true);
    assert.equal(await yolo('click', {}, 'x'), true, 'plain -y still allows');
    assert.equal(await yolo('click', {}, 'x', { force: true }), false, 'no terminal here, no client: no');
    const gui = makeApprover({ yolo: true, external: { hasClient: () => true, ask: async () => ({ decision: 'always' }) } });
    let saved = 0;
    assert.equal(await gui('click', {}, 'x', { force: true }), true, 'a person said yes');
    assert.equal(await gui('click', {}, 'x', { onAlways: () => { saved++; }, force: false }), true);
    const app = makeApprover({ external: { hasClient: () => true, ask: async () => ({ decision: 'always' }) } });
    assert.equal(await app('click', {}, 'x', { onAlways: () => { saved++; } }), true);
    assert.equal(saved, 1, '"always" remembered the app');
    let asked = 0;
    const after = makeApprover({ external: { hasClient: () => true, ask: async () => { asked++; return { decision: 'deny' }; } } });
    assert.equal(await after('click', {}, 'x', {}), false);
    assert.equal(asked, 1, 'and it did not turn into allow-everything');
  } finally { process.stdout.write = write; }
});

test('payment controls are recognised; ordinary ones are not', () => {
  for (const name of ['Pay now', 'Buy', 'Place order', 'Checkout', 'Transfer']) assert.equal(C.isPayment({ name }), true, name);
  for (const name of ['Send', 'Save draft', 'Payload', 'Buyer notes']) assert.equal(C.isPayment({ name }), false, name);
});

test('a run with nobody at the screen does not touch it', async () => {
  const ctx = { yolo: true, env: { OX_UNATTENDED: '1' } };
  const r = await C.gate(ctx, { tool: 'click', app: 'Notes', what: 'Click New' });
  assert.equal(r.ok, false);
  assert.match(r.content, /Nobody is at the screen/);
  assert.equal((await C.gate({ yolo: true, env: { OX_DAEMON_WORKER_ID: 'w1' } }, { tool: 'click', what: 'Click' })).ok, false, 'a daemon worker neither');
});

test('one run at a time: a live holder blocks, a dead or idle one does not', async () => {
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(C.LOCK(), JSON.stringify({ pid: other.pid, who: 'the other run', at: Date.now() }));
    const r = await C.gate({ yolo: true }, { tool: 'click', app: 'Notes', what: 'Click' });
    assert.equal(r.ok, false);
    assert.match(r.content, /the other run .* is using your computer/);
    assert.equal(C.computerStatus().inUse, true);
    fs.writeFileSync(C.LOCK(), JSON.stringify({ pid: other.pid, who: 'the other run', at: Date.now() - 11 * 60_000 }));
    assert.equal(C.holdScreen(), null, 'idle for over ten minutes');
  } finally { other.kill(); }
  fs.writeFileSync(C.LOCK(), JSON.stringify({ pid: 99999999, who: 'gone', at: Date.now() }));
  assert.equal(C.holdScreen(), null, 'a dead run holds nothing');
  assert.equal(JSON.parse(fs.readFileSync(C.LOCK(), 'utf8')).pid, process.pid);
});

test('stop from anywhere: the next action is refused, and an old stop does not catch a new run', async () => {
  fs.writeFileSync(C.STOP(), String(Date.now() - 86_400_000));
  assert.equal(C.stopRequested(), false, 'stopped yesterday');
  C.requestStop();
  assert.equal(C.stopRequested(), true);
  const r = await C.gate({ yolo: true }, { tool: 'click', app: 'Notes', what: 'Click' });
  assert.equal(r.ok, false);
  assert.match(r.content, /You stopped ox/);
  fs.rmSync(C.STOP());
});

test('keys: Return and shortcuts are possible for an agent; lock, logout, force quit and delete never', () => {
  assert.equal(parseKey('return').error !== undefined, true, 'the strict rule stays for voice and the Mac MCP');
  const ret = parseKey('return', { loose: true });
  assert.equal(ret.code, 36);
  assert.equal(ret.sends, true);
  assert.equal(parseKey('cmd+return', { loose: true }).ask, true);
  assert.equal(parseKey('cmd+f', { loose: true }).ask, false);
  assert.equal(parseKey('cmd+w', { loose: true }).ask, true, 'closing asks');
  assert.equal(parseKey('cmd+shift+s', { loose: true }).ask, true);
  assert.equal(parseKey('tab', { loose: true }).code, 48);
  for (const k of ['cmd+ctrl+q', 'cmd+shift+q', 'cmd+option+esc', 'cmd+delete', 'cmd+shift+delete']) assert.match(parseKey(k, { loose: true }).error, /does not press/, k);
  assert.match(parseKey('a', { loose: true }).error, /type_text/);
});
