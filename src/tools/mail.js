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

// Indexed loops on purpose: `repeat with x in` hands Mail lazy references it
// then refuses to turn into text (-1700), checked against the real Mail app.
export const ACCOUNTS_SCRIPT = [
  'tell application "Mail"',
  'set out to ""',
  'set accts to every account',
  'repeat with i from 1 to count of accts',
  'set a to item i of accts',
  'if enabled of a then',
  'set nm to name of a',
  'set addrs to email addresses of a',
  'repeat with j from 1 to count of addrs',
  'set out to out & nm & tab & (item j of addrs) & linefeed',
  'end repeat',
  'end if',
  'end repeat',
  'return out',
  'end tell',
];

export const COMPOSE_SCRIPT = [
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
    const child = spawn('osascript', [...argv, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let e = '';
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish({ ok: false, out: '', err: 'timed out after 8 seconds' }); }, 8_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (e += d));
    child.on('error', (x) => finish({ ok: false, out: '', err: x.message }));
    child.on('close', (code) => finish({ ok: code === 0, out: out.trim(), err: e.trim() }));
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
  let outlook = false;
  try { outlook = !!(ctx.detectApps ?? (await import('../desktop-apps.js')).detectDesktopApps)().outlook?.installed; } catch {}
  const alt = outlook ? '\nMicrosoft Outlook is also installed: mail_compose with app:"outlook" opens a draft there.' : '';
  if (error) return outlook ? { content: `The Mail app could not be read (${error}).${alt}` } : err(`mail_accounts: ${error}`);
  if (!accounts.length) return { content: `Mail has no enabled accounts with an address. Add one in Mail › Settings › Accounts.${alt}` };
  return { content: `Mail can send from:\n${listText(accounts)}\nPass one of these exactly as "from".${alt}` };
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

// Microsoft Outlook: a draft opened through mailto:, never sent by ox. The
// person sees the account Outlook chose and presses Send there.
async function outlookDraft(args, ctx) {
  const { detectDesktopApps, mailtoLink } = await import('../desktop-apps.js');
  const app = (ctx.detectApps ?? detectDesktopApps)().outlook;
  if (!app?.installed) return err('mail_compose: Microsoft Outlook is not installed on this Mac. Use the Mail app (leave app out) instead.');
  const to = list(args.to), cc = list(args.cc);
  if (!to.length) return err('mail_compose: "to" is required');
  const bad = [...to, ...cc].filter((a) => !EMAIL.test(a));
  if (bad.length) return err(`mail_compose: not an email address: ${bad.join(', ')}`);
  if (list(args.attachments).length) return err('mail_compose: Outlook drafts opened by ox cannot carry attachments. Make the draft without them and attach in Outlook, or use the Mail app.');
  const link = mailtoLink({ to, cc, subject: String(args.subject ?? ''), body: String(args.body ?? '') });
  const summary = [`To:      ${to.join(', ')}`, ...(cc.length ? [`Cc:      ${cc.join(', ')}`] : []), `Subject: ${String(args.subject ?? '') || '(none)'}`].join('\n');
  if (process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') return { content: `Draft (dry run) would open in Outlook: ${link}\n${summary}` };
  const { spawnSync } = await import('node:child_process');
  const r = (ctx.openLink ?? ((u) => spawnSync('open', ['-b', app.bundle ?? 'com.microsoft.Outlook', u], { timeout: 10_000 })))(link);
  if (r?.status !== 0) return err(`mail_compose: Outlook did not open (${String(r?.stderr ?? '').trim() || 'open failed'})`);
  return { content: `Draft open in Outlook, not sent. Check the From account there and press Send.\n${summary}` };
}

export async function mail_compose(args = {}, ctx = {}) {
  if (String(args.app ?? '').toLowerCase() === 'outlook') return outlookDraft(args, ctx);
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
    description: 'Write an email in the Mail app (macOS), with attachments. Makes a visible draft by default; send:true sends only after the person approves. "from" must be exactly one of the addresses mail_accounts lists: never guess it, ask. app:"outlook" opens the draft in Microsoft Outlook instead (no from, no attachments; the person sends it there).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sending address, exactly as listed by mail_accounts' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses' },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'File paths, e.g. a PDF' },
        send: { type: 'boolean', description: 'true to send after approval; default false (draft). Mail app only.' },
        app: { type: 'string', enum: ['mail', 'outlook'], description: 'Which app: mail (default) or outlook' },
      },
      required: ['to'],
    },
  },
];
