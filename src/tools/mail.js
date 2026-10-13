// Email through the Mail app, built so it cannot go out from the wrong account.
//
// A Mac often has several accounts signed in to Mail. The rules:
//   - `from` is required and must be exactly one of the addresses Mail has;
//     there is no default and no guessing, however many accounts there are.
//   - The default is a draft: a visible compose window, nothing sent.
//   - Sending always asks the person, even under -y, showing from/to/subject
//     and attachments; a run with no one to ask makes a draft instead.
//   - After Mail builds the message, the sender it actually chose is read back
//     and compared; on any mismatch the message is not sent.
// Text reaches AppleScript as argv only (see operator.js for why).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const err = (content) => ({ content, isError: true });
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const ACCOUNTS_SCRIPT = [
  'tell application "Mail"',
  'set out to ""',
  'repeat with a in every account',
  'if enabled of a then',
  'repeat with e in (email addresses of a)',
  'set out to out & (name of a) & tab & e & linefeed',
  'end repeat',
  'end if',
  'end repeat',
  'return out',
  'end tell',
];

const COMPOSE_SCRIPT = [
  'on run argv',
  'set fromAddr to item 1 of argv',
  'set subj to item 2 of argv',
  'set bodyText to item 3 of argv',
  'set doSend to item 4 of argv',
  'tell application "Mail"',
  'set msg to make new outgoing message with properties {sender:fromAddr, subject:subj, content:bodyText & return & return, visible:true}',
  'tell msg',
  'repeat with i from 5 to count of argv',
  'set a to item i of argv',
  'if a starts with "to:" then make new to recipient at end of to recipients with properties {address:(text 4 thru -1 of a)}',
  'if a starts with "cc:" then make new cc recipient at end of cc recipients with properties {address:(text 4 thru -1 of a)}',
  'if a starts with "att:" then make new attachment with properties {file name:(POSIX file (text 5 thru -1 of a))} at after the last paragraph',
  'end repeat',
  'end tell',
  'set actual to sender of msg',
  'if actual does not contain fromAddr then return "MISMATCH" & tab & actual',
  'if doSend is "send" then',
  'delay 1',
  'send msg',
  'return "SENT" & tab & actual',
  'end if',
  'return "DRAFT" & tab & actual',
  'end tell',
  'end run',
];

function osa(lines, args = [], runner) {
  if (runner) return runner(lines, args);
  return new Promise((resolve) => {
    const argv = lines.flatMap((l) => ['-e', l]);
    const child = spawn('osascript', [...argv, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let out = '';
    let e = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (e += d));
    child.on('error', (x) => resolve({ ok: false, out: '', err: x.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: e.trim() }));
  });
}

export function parseAccounts(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length === 2 && p[1].trim())
    .map(([account, address]) => ({ account: account.trim(), address: address.trim() }));
}

async function readAccounts(ctx) {
  if (os.platform() !== 'darwin' && !ctx?._osa) return { error: 'email via the Mail app needs macOS' };
  const r = await osa(ACCOUNTS_SCRIPT, [], ctx?._osa);
  if (!r.ok) return { error: `could not read Mail accounts: ${r.err || 'osascript failed'} (allow ox to control Mail in System Settings › Privacy & Security › Automation)` };
  return { accounts: parseAccounts(r.out) };
}

const listText = (accounts) => accounts.map((a) => `  ${a.address}  (${a.account})`).join('\n');
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((s) => String(s).trim()).filter(Boolean);

export async function mail_accounts(_args = {}, ctx = {}) {
  const { accounts, error } = await readAccounts(ctx);
  if (error) return err(`mail_accounts: ${error}`);
  if (!accounts.length) return { content: 'Mail has no enabled accounts with an address. Add one in Mail › Settings › Accounts.' };
  return { content: `Mail can send from:\n${listText(accounts)}\nPass one of these exactly as "from".` };
}

// Every check that does not need Mail, in one place so it can be tested.
export function checkMail(args = {}, accounts = [], cwd = process.cwd()) {
  const from = String(args.from ?? '').trim();
  if (!from) return { error: `"from" is required: ox never picks the sending account for you. Ask which of these to use:\n${listText(accounts)}` };
  const match = accounts.filter((a) => a.address.toLowerCase() === from.toLowerCase());
  if (!match.length) return { error: `"${from}" is not an account in Mail, so nothing was sent. Mail can send from:\n${listText(accounts)}` };
  const to = list(args.to);
  const cc = list(args.cc);
  if (!to.length) return { error: '"to" is required' };
  const bad = [...to, ...cc].filter((a) => !EMAIL.test(a));
  if (bad.length) return { error: `not an email address: ${bad.join(', ')}` };
  const attachments = [];
  for (const p of list(args.attachments)) {
    const abs = path.resolve(cwd, p.replace(/^~(?=$|\/)/, os.homedir()));
    let st = null;
    try { st = fs.statSync(abs); } catch {}
    if (!st?.isFile()) return { error: `attachment not found: ${p}` };
    attachments.push(abs);
  }
  return {
    from: match[0].address,
    account: match[0].account,
    to,
    cc,
    subject: String(args.subject ?? ''),
    body: String(args.body ?? ''),
    attachments,
    send: args.send === true || args.send === 'true',
  };
}

export async function mail_compose(args = {}, ctx = {}) {
  const { accounts, error } = await readAccounts(ctx);
  if (error) return err(`mail_compose: ${error}`);
  const m = checkMail(args, accounts, ctx?.cwd ?? process.cwd());
  if (m.error) return err(`mail_compose: ${m.error}`);
  const summary = [
    `From:    ${m.from} (${m.account})`,
    `To:      ${m.to.join(', ')}`,
    ...(m.cc.length ? [`Cc:      ${m.cc.join(', ')}`] : []),
    `Subject: ${m.subject || '(none)'}`,
    ...(m.attachments.length ? [`Attach:  ${m.attachments.map((a) => path.basename(a)).join(', ')}`] : []),
  ].join('\n');
  let send = m.send;
  if (send) {
    // Outward and irreversible: always the person's call, -y or not.
    if (typeof ctx?.requestApproval !== 'function') {
      send = false;
    } else {
      const ok = await ctx.requestApproval('mail_compose', { from: m.from, to: m.to.join(', '), subject: m.subject }, `Send this email?\n${summary}`);
      if (!ok) send = false;
    }
  }
  const argv = [m.from, m.subject, m.body, send ? 'send' : 'draft', ...m.to.map((a) => `to:${a}`), ...m.cc.map((a) => `cc:${a}`), ...m.attachments.map((a) => `att:${a}`)];
  const r = await osa(COMPOSE_SCRIPT, argv, ctx?._osa);
  if (!r.ok) return err(`mail_compose: Mail refused: ${r.err || 'osascript failed'}`);
  const [status, actual = ''] = r.out.split('\t');
  if (status === 'MISMATCH') return err(`mail_compose: Mail chose the sender "${actual}" instead of ${m.from}, so it was NOT sent. The draft is open in Mail; fix the From menu there.`);
  if (status === 'SENT') return { content: `Sent.\n${summary}` };
  const why = m.send ? (typeof ctx?.requestApproval === 'function' ? ' (sending was declined)' : ' (no one here to approve sending)') : '';
  return { content: `Draft open in Mail, not sent${why}.\n${summary}` };
}

export const MAIL_TOOL_SCHEMAS = [
  {
    name: 'mail_accounts',
    description: 'List the email addresses the Mail app can send from (macOS). Use before mail_compose when the person has not said which address to send from.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mail_compose',
    description: 'Write an email in the Mail app (macOS), with attachments. Makes a visible draft by default; send:true sends only after the person approves. "from" must be exactly one of the addresses mail_accounts lists: never guess it, ask.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sending address, exactly as listed by mail_accounts' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses' },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'File paths, e.g. a PDF' },
        send: { type: 'boolean', description: 'true to send after approval; default false (draft)' },
      },
      required: ['from', 'to'],
    },
  },
];
