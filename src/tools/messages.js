// iMessage/SMS through the macOS Messages app.
//
// Messages is a local, user-owned transport: it is available only on macOS,
// requires Automation permission, and every send is approval-gated.  We do
// not silently open a chat or claim delivery when Messages rejects the send.
import { spawn } from 'node:child_process';

const PHONE = /^[+()\-\s\d]{3,40}$/;

export const MESSAGES_SCRIPT = [
  'on run argv',
  'set target to item 1 of argv',
  'set bodyText to item 2 of argv',
  'tell application "Messages"',
  'set svc to 1st service whose service type is iMessage',
  'set buddyRef to participant target of svc',
  'send bodyText to buddyRef',
  'return "SENT"',
  'end tell',
  'end run',
];

// Kept separate so tests can provide a deterministic runner.  Real calls use
// one `osascript` process with argv, avoiding interpolation into AppleScript.
export function runMessagesScript(lines, args = [], runner) {
  if (runner) return runner(lines, args);
  return new Promise((resolve) => {
    const child = spawn('osascript', [...lines.flatMap((l) => ['-e', l]), ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    let out = ''; let error = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { error += d; });
    child.on('error', (e) => resolve({ ok: false, out: '', err: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: error.trim() }));
  });
}

export async function messages_send(args = {}, ctx = {}) {
  if (process.platform !== 'darwin' && !ctx?._osa) return { content: 'messages_send: iMessage/SMS is available through Messages on macOS only.', isError: true };
  const to = String(args.to ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!to || !PHONE.test(to)) return { content: 'messages_send: provide a phone number such as +1 604 555 0100.', isError: true };
  if (!body) return { content: 'messages_send: body is required.', isError: true };
  if (typeof ctx.requestApproval !== 'function') return { content: 'messages_send: sending requires an explicit approval; nothing was sent.', isError: true };
  const approved = await ctx.requestApproval('messages_send', { to, body }, `Send this message via Messages?\nTo: ${to}\n\n${body}`);
  if (!approved) return { content: 'messages_send: declined; nothing was sent.', isError: false };
  const r = await runMessagesScript(MESSAGES_SCRIPT, [to, body], ctx?._osa);
  if (!r.ok || r.out !== 'SENT') return { content: `messages_send: Messages did not send: ${r.err || 'Automation permission or recipient unavailable'}`, isError: true };
  return { content: `Sent via Messages to ${to}.`, isError: false };
}

export const MESSAGES_TOOL_SCHEMAS = [{
  name: 'messages_send',
  description: 'Send one SMS/iMessage through the user\'s macOS Messages app. Always asks for explicit approval; never sends silently.',
  inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
}];
