// A Claude plan run started from the app asks before it writes: Claude Code
// runs with --permission-prompt-tool stdio, each permission comes out as a
// control_request, and ox answers it from ctx.requestApproval (the app's
// Allow / Deny). The stand-in CLI below speaks that protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runSubscriptionTurn, planApprovalDetail } from '../src/subscriptions.js';
import { appApprover, answerAppApproval } from '../src/serve.js';

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-planap-bin-'));
const argsLog = path.join(bin, 'args.json');
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('claude 9.9.9'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(a));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const file = path.join(process.cwd(), 'tmp-check.txt');
if (!a.includes('stdio')) {
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'The write to tmp-check.txt is pending your approval.' }] } });
  say({ type: 'result', subtype: 'success', result: 'pending' });
  process.exit(0);
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type === 'user') {
      say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: file, content: 'hi' } }] } });
      say({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: file, content: 'hi' } } });
    } else if (m.type === 'control_response') {
      const ok = m.response.request_id === 'r1' && m.response.response.behavior === 'allow';
      if (ok) fs.writeFileSync(file, m.response.response.updatedInput.content);
      say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: ok ? 'written' : m.response.response.message, is_error: !ok }] } });
      say({ type: 'assistant', message: { content: [{ type: 'text', text: ok ? 'Created tmp-check.txt.' : 'You declined the write.' }] } });
      say({ type: 'result', subtype: 'success', result: 'done' });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`);
fs.chmodSync(path.join(bin, 'claude'), 0o755);
const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-planap-home-')), OX_MAC_MCP: '0' };
const target = { subscription: 'claude', bot: 'claude-plan', provider: 'subscription' };

async function run(requestApproval) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-planap-proj-')));
  const asked = [];
  const ctx = { cwd, env, ...(requestApproval ? { planApprovals: true, requestApproval: async (...a) => { asked.push(a); return requestApproval(...a); } } : {}) };
  let text = '';
  for await (const ev of runSubscriptionTurn({ target, messages: [{ role: 'user', content: 'create tmp-check.txt in the project root' }], ctx })) {
    if (ev.type === 'text-delta') text += ev.text;
    if (ev.type === 'final') text = text || ev.message.content;
  }
  return { cwd, asked, text, written: fs.existsSync(path.join(cwd, 'tmp-check.txt')), args: JSON.parse(fs.readFileSync(argsLog, 'utf8')) };
}

test('Allow: the plan asks through requestApproval and the file is written', async () => {
  const r = await run(async () => true);
  assert.ok(r.args.includes('--permission-prompt-tool') && r.args.includes('stdio'));
  assert.ok(r.args.includes('--input-format'));
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0][0], 'Write');
  assert.match(r.asked[0][2], /Write: .*tmp-check\.txt$/);
  assert.equal(r.written, true);
  assert.match(r.text, /Created tmp-check\.txt/);
});

test('Deny (or anything but a yes) refuses the write', async () => {
  for (const answer of [async () => false, async () => 'allow', async () => { throw new Error('gone'); }]) {
    const r = await run(answer);
    assert.equal(r.asked.length, 1);
    assert.equal(r.written, false);
    assert.match(r.text, /declined/);
  }
});

test('with nobody to ask, the plan runs as before (prompt as an argument)', async () => {
  const r = await run(null);
  assert.ok(!r.args.includes('stdio'));
  assert.ok(r.args.includes('create tmp-check.txt in the project root'));
  assert.equal(r.written, false);
});

test('approval details name the file or the command', () => {
  assert.equal(planApprovalDetail('Write', { file_path: '/p/a.txt' }), 'Write: /p/a.txt');
  assert.equal(planApprovalDetail('Bash', { command: 'rm -rf build' }), '$ rm -rf build');
});

function fakeRes() {
  const res = new EventEmitter();
  res.frames = [];
  res.write = (s) => { res.frames.push(JSON.parse(String(s).replace(/^data: /, '').trim())); return true; };
  return res;
}

test('app approvals: an approval chunk goes out, POST /ox/approval answers it', async () => {
  const res = fakeRes();
  const ask = appApprover(res, 'claude-plan');
  const yes = ask('Write', { file_path: 'a' }, 'Write: a');
  const sent = res.frames.at(-1).ox;
  assert.equal(sent.type, 'approval');
  assert.equal(sent.tool, 'Write');
  assert.equal(sent.preview, 'Write: a');
  assert.equal(answerAppApproval(sent.id, 'allow'), true);
  assert.equal(await yes, true);
  assert.deepEqual(res.frames.at(-1).ox, { type: 'approval-resolved', id: sent.id, decision: 'allow' });
  assert.equal(answerAppApproval(sent.id, 'allow'), false, 'answered once only');

  const no = ask('Bash', {}, '$ ls');
  answerAppApproval(res.frames.at(-1).ox.id, 'deny');
  assert.equal(await no, false);

  // The chat closed while it waited: refused.
  const gone = ask('Write', {}, 'Write: b');
  res.emit('close');
  assert.equal(await gone, false);

  // Nobody answered in time: refused.
  const hold = setTimeout(() => {}, 1000);   // the server keeps the loop alive in real use
  const late = appApprover(fakeRes(), 'm', { timeoutMs: 20 })('Write', {}, '');
  assert.equal(await late, false);
  clearTimeout(hold);
});
