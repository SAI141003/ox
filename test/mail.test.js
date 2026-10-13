// Email can never go out from the wrong account, and never without the person.
// Mail itself is replaced by a recorder, so nothing is really sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mail_accounts, mail_compose, checkMail, parseAccounts } from '../src/tools/mail.js';

const ACCOUNTS = 'Work\tsai@company.com\nPersonal\tsai.home@gmail.com\n';
// A stand-in for osascript: answers the accounts script, and for the compose
// script reports the sender Mail "chose" (normally the requested one).
function fakeMail({ chooses } = {}) {
  const calls = [];
  const run = async (lines, argv) => {
    if (!argv.length) return { ok: true, out: ACCOUNTS.trim(), err: '' };
    calls.push(argv);
    const [from, , , doSend] = argv;
    const actual = chooses ?? from;
    if (!actual.includes(from)) return { ok: true, out: `MISMATCH\t${actual}`, err: '' };
    return { ok: true, out: `${doSend === 'send' ? 'SENT' : 'DRAFT'}\t${actual}`, err: '' };
  };
  return { run, calls };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mail-'));
const pdf = path.join(dir, 'invoice.pdf');
fs.writeFileSync(pdf, '%PDF-1.4\n');

test('accounts parse from Mail', () => {
  assert.deepEqual(parseAccounts(ACCOUNTS), [
    { account: 'Work', address: 'sai@company.com' },
    { account: 'Personal', address: 'sai.home@gmail.com' },
  ]);
});

test('no from, or a from Mail does not have: refused, with the real choices', () => {
  const accts = parseAccounts(ACCOUNTS);
  assert.match(checkMail({ to: ['a@b.co'] }, accts).error, /"from" is required[^]*sai@company\.com[^]*sai\.home@gmail\.com/);
  assert.match(checkMail({ from: 'sai@company.co', to: ['a@b.co'] }, accts).error, /not an account in Mail/);
  assert.match(checkMail({ from: 'sai@company.com', to: ['nope'] }, accts).error, /not an email address: nope/);
  assert.match(checkMail({ from: 'sai@company.com', to: ['a@b.co'], attachments: ['missing.pdf'] }, accts, dir).error, /attachment not found/);
  const ok = checkMail({ from: 'SAI@company.com', to: 'a@b.co, c@d.co', attachments: ['invoice.pdf'] }, accts, dir);
  assert.equal(ok.from, 'sai@company.com');
  assert.deepEqual(ok.to, ['a@b.co', 'c@d.co']);
  assert.deepEqual(ok.attachments, [pdf]);
});

test('the default is a draft: nothing is sent', async () => {
  const m = fakeMail();
  const r = await mail_compose({ from: 'sai.home@gmail.com', to: ['x@y.co'], subject: 'hi', attachments: [pdf] }, { _osa: m.run, cwd: dir });
  assert.match(r.content, /Draft open in Mail, not sent/);
  assert.equal(m.calls[0][3], 'draft');
  assert.ok(m.calls[0].includes(`att:${pdf}`));
});

test('send asks the person even under -y, and shows the from address', async () => {
  const m = fakeMail();
  let asked = null;
  const ctx = { _osa: m.run, cwd: dir, yolo: true, requestApproval: async (_n, _a, msg) => { asked = msg; return false; } };
  const r = await mail_compose({ from: 'sai@company.com', to: ['x@y.co'], subject: 'Q3', send: true }, ctx);
  assert.match(asked, /From:\s+sai@company\.com \(Work\)/);
  assert.match(r.content, /not sent \(sending was declined\)/);
  assert.equal(m.calls[0][3], 'draft');
  const yes = await mail_compose({ from: 'sai@company.com', to: ['x@y.co'], send: true }, { ...ctx, requestApproval: async () => true });
  assert.match(yes.content, /^Sent\./);
});

test('with no one to ask, send becomes a draft', async () => {
  const m = fakeMail();
  const r = await mail_compose({ from: 'sai@company.com', to: ['x@y.co'], send: true }, { _osa: m.run, cwd: dir, yolo: true });
  assert.match(r.content, /no one here to approve sending/);
  assert.equal(m.calls[0][3], 'draft');
});

test('if Mail picks a different sender, it is not sent', async () => {
  const m = fakeMail({ chooses: 'Sai <sai.home@gmail.com>' });
  const r = await mail_compose({ from: 'sai@company.com', to: ['x@y.co'], send: true }, { _osa: m.run, cwd: dir, requestApproval: async () => true });
  assert.equal(r.isError, true);
  assert.match(r.content, /NOT sent/);
});

test('mail_accounts lists the addresses to choose from', async () => {
  const r = await mail_accounts({}, { _osa: fakeMail().run });
  assert.match(r.content, /sai@company\.com\s+\(Work\)/);
});
