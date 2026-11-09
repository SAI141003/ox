// ox over plain text channels: iMessage, Signal, WhatsApp. These have no buttons and no way to
// edit a message, so an approval comes as "reply 1 to allow, 2 to deny" and only the first and
// last status lines are sent. Pairing, approvals and modes are the same as Telegram's
// (src/remote-core.js): until a chat sends the code printed here, nobody can run anything.
//
//   ox gateway imessage              needs Full Disk Access for the terminal, to read Messages
//   ox gateway signal --number +1…   needs signal-cli, registered to that number
//   ox gateway whatsapp              needs the WhatsApp Cloud API keys and its webhook on ox serve
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteCore, slashlessReply } from './remote-core.js';

const stateFile = (name, env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'gateway', `${name}.json`);
export function loadTextState(name, env) { try { return JSON.parse(fs.readFileSync(stateFile(name, env), 'utf8')); } catch { return {}; } }
export function saveTextState(name, st, env) {
  const f = stateFile(name, env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(st, null, 2), { mode: 0o600 });
}

const run = (cmd, args, { timeout = 30_000, input = null } = {}) => new Promise((resolve) => {
  const c = execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') }));
  if (input != null) c.stdin?.end(input);
});

// ---- iMessage ----------------------------------------------------------------------

/** The words in Messages' attributedBody (where newer macOS keeps them). null if unreadable. */
export function decodeAttributedBody(hex) {
  if (!hex) return null;
  const b = Buffer.from(String(hex), 'hex');
  const at = b.indexOf('NSString');
  if (at < 0) return null;
  let i = at + 'NSString'.length + 5;   // the class header, then the length
  if (i >= b.length) return null;
  let len = b[i++];
  if (len === 0x81) { len = b.readUInt16LE(i); i += 2; } else if (len === 0x82) { len = b.readUInt32LE(i); i += 4; }
  if (i + len > b.length) return null;
  return b.subarray(i, i + len).toString('utf8');
}

export function imessageSource({ db = path.join(os.homedir(), 'Library', 'Messages', 'chat.db'), runner = run, state } = {}) {
  const query = (sql) => runner('sqlite3', ['-readonly', '-json', db, sql]);
  return {
    name: 'imessage',
    async check() {
      const r = await query('SELECT MAX(ROWID) AS max FROM message;');
      if (!r.ok) throw new Error(`could not read Messages (${r.stderr.trim().slice(0, 160)}). Give your terminal Full Disk Access in System Settings › Privacy & Security.`);
      // Only what arrives from now on: nothing older is ever run.
      if (state.cursor == null) state.cursor = Number(JSON.parse(r.stdout || '[{}]')[0]?.max ?? 0);
    },
    async receive() {
      const r = await query(`SELECT m.ROWID AS id, h.id AS chat, m.text AS text, hex(m.attributedBody) AS body FROM message m JOIN handle h ON m.handle_id = h.ROWID WHERE m.ROWID > ${Number(state.cursor) || 0} AND m.is_from_me = 0 ORDER BY m.ROWID LIMIT 20;`);
      if (!r.ok || !r.stdout.trim()) return [];
      const rows = JSON.parse(r.stdout);
      state.cursor = rows.at(-1)?.id ?? state.cursor;
      return rows.map((x) => ({ chat: x.chat, text: x.text ?? decodeAttributedBody(x.body) ?? '' })).filter((x) => x.text.trim());
    },
    async send(chat, text) {
      const script = ['on run argv', 'tell application "Messages"', 'send (item 2 of argv) to participant (item 1 of argv) of (1st account whose service type = iMessage)', 'end tell', 'end run'];
      const r = await runner('osascript', [...script.flatMap((l) => ['-e', l]), String(chat), String(text)]);
      if (!r.ok) throw new Error(r.stderr.slice(0, 200));
    },
  };
}

// ---- Signal ------------------------------------------------------------------------

export function signalSource({ number, bin = 'signal-cli', runner = run } = {}) {
  if (!/^\+\d{6,16}$/.test(String(number ?? ''))) throw new Error('--number is your Signal number with country code, like +14155550100');
  return {
    name: 'signal',
    async check() {
      const r = await runner(bin, ['--version']);
      if (!r.ok) throw new Error('signal-cli is not installed. Install it and register this number first: github.com/AsamK/signal-cli');
    },
    async receive() {
      const r = await runner(bin, ['-u', number, '--output=json', 'receive', '--timeout', '1'], { timeout: 20_000 });
      if (!r.ok) return [];
      const out = [];
      for (const line of r.stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const env = JSON.parse(line).envelope ?? {};
          const text = env.dataMessage?.message;
          // A direct message only: in a group, anyone there could reach the run.
          if (text && !env.dataMessage.groupInfo) out.push({ chat: env.sourceNumber ?? env.source, text });
        } catch {}
      }
      return out;
    },
    async send(chat, text) {
      const r = await runner(bin, ['-u', number, 'send', '-m', String(text), String(chat)]);
      if (!r.ok) throw new Error(r.stderr.slice(0, 200));
    },
  };
}

// ---- WhatsApp (Cloud API; messages arrive through ox serve's signed webhook) -------------

export function whatsappSource({ env = process.env, fetchImpl = globalThis.fetch, state, home } = {}) {
  return {
    name: 'whatsapp',
    async check() {
      const { whatsappConfig } = await import('./tools/whatsapp.js');
      const c = whatsappConfig(env);
      if (!c.token || !c.phoneNumberId || !c.appSecret) throw new Error('set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET, and point Meta\'s webhook at ox serve (/webhooks/whatsapp)');
      if (!Array.isArray(state.seen)) {
        const { readWhatsappInbox } = await import('./tools/whatsapp.js');
        state.seen = readWhatsappInbox({ home }).map((m) => m.id);   // older messages are never run
      }
    },
    async receive() {
      const { readWhatsappInbox } = await import('./tools/whatsapp.js');
      const fresh = readWhatsappInbox({ home }).filter((m) => m.type === 'text' && !state.seen.includes(m.id)).reverse();
      for (const m of fresh) state.seen.push(m.id);
      state.seen = state.seen.slice(-500);
      return fresh.map((m) => ({ chat: m.from, text: m.text }));
    },
    async send(chat, text) {
      const { whatsappConfig } = await import('./tools/whatsapp.js');
      const c = whatsappConfig(env);
      const r = await fetchImpl(`https://graph.facebook.com/v20.0/${encodeURIComponent(c.phoneNumberId)}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: String(chat), type: 'text', text: { body: String(text).slice(0, 4000) } }),
      });
      if (!r.ok) throw new Error(`WhatsApp refused the message (HTTP ${r.status})`);
    },
  };
}

// ---- the loop ----------------------------------------------------------------------

/** Replies "1", "2", "allow" or "deny" answer the question asked last. */
export function replyToButton(text, buttons) {
  if (!buttons?.length) return null;
  const t = String(text ?? '').trim().toLowerCase();
  const byNumber = /^\d+$/.test(t) ? buttons[Number(t) - 1] : null;
  return byNumber ?? buttons.find((b) => b.label.toLowerCase() === t) ?? null;
}

export function createTextChannel(source, { state, persist, cwd, agent = null, env = process.env, log = console.log, socketDir, makeCore = createRemoteCore } = {}) {
  const pending = new Map();
  let seq = 0;
  const adapter = {
    async send(chat, text, buttons) {
      const body = buttons?.length ? `${text}\n\nReply ${buttons.map((b, i) => `${i + 1} to ${b.label.toLowerCase()}`).join(', ')}.` : text;
      await source.send(chat, body);
      if (buttons?.length) pending.set(String(chat), buttons);
      return { id: ++seq };
    },
    // These channels cannot edit. Progress stays quiet; only a failed end is worth a message.
    async edit(chat, id, text) { if (String(text).startsWith('✗')) await source.send(chat, text); },
    async ack(ref, text) { if (text) await source.send(ref.chat, text); },
  };
  const core = makeCore({ adapter, state, persist, cwd, agent, env, log, socketDir, channel: source.name.slice(0, 2) });
  return {
    core,
    async handle(m) {
      const asked = pending.get(String(m.chat));
      const b = String(m.chat) === String(state.owner) ? replyToButton(m.text, asked) : null;
      if (b) { pending.delete(String(m.chat)); return core.onButton(m.chat, b.data, { chat: m.chat }); }
      const said = slashlessReply(m.text);
      // Not paired yet: anyone can text this number, and they get no answer but the pairing itself.
      if (!state.owner && !said.startsWith('/pair')) return undefined;
      return core.onMessage(m.chat, said);
    },
  };
}

export async function runTextGateway(source, { cwd = process.cwd(), agent = null, mode = null, env = process.env, log = console.log, signal = null, pollMs = 3000, state: given = null, socketDir } = {}) {
  const state = given ?? { ...loadTextState(source.name, env), cwd };
  if (mode) state.mode = mode;
  const persist = () => saveTextState(source.name, state, env);
  await source.check();
  const channel = createTextChannel(source, { state, persist, cwd, agent, env, log, socketDir });
  persist();
  log(state.owner ? `ox is listening on ${source.name}, paired with ${state.owner}` : `ox is listening on ${source.name}. From your phone, send: /pair ${state.pairCode}`);
  let stopped = false;
  signal?.addEventListener?.('abort', () => { stopped = true; channel.core.stop(); });
  while (!stopped) {
    let got = [];
    try { got = await source.receive(); } catch (e) { log(`${source.name}: ${e.message}`); }
    persist();
    for (const m of got) await channel.handle(m).catch((e) => log(`${source.name}: ${e.message}`));
    await new Promise((r) => { const t = setTimeout(r, pollMs); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
  }
}
