// Your ox, from your phone: an always-on Telegram channel.
//
//   ox gateway telegram --token <bot token from @BotFather> [--cwd <project>]
//
// Each message you send runs ox in the project. While it works, one status
// message updates in place with what it is doing; when it needs approval you
// get Allow / Deny buttons; when it finishes you get the answer.
//
// Safety, in this order:
//   - Pairing. Until a chat sends `/pair <code>` (the code is printed in your
//     terminal, never sent anywhere), nobody can run anything. After that only
//     the paired chat is listened to; every other chat is ignored.
//   - Approvals stay approvals. A run started from the phone is a normal ox
//     run with its normal gates; the buttons answer them over ox's IPC bridge,
//     and silence (or a timeout) is a decline.
//   - The bot token is stored in ~/.ox/gateway/telegram.json, readable by you only.
//   - Long polling: nothing listens on a port, nothing is exposed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteCore } from './remote-core.js';

export const STATE_FILE = () => path.join(os.homedir(), '.ox', 'gateway', 'telegram.json');

export function loadState(file = STATE_FILE()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function saveState(st, file = STATE_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function telegramApi(token, { base = process.env.OX_TELEGRAM_API || 'https://api.telegram.org', fetchImpl = globalThis.fetch } = {}) {
  return async function call(method, body = {}, { timeoutMs = 40_000 } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`);
      return j.result;
    } finally {
      clearTimeout(t);
    }
  };
}

export { splitMessage, cleanAnswer } from './remote-core.js';

export async function runTelegramGateway({
  token,
  cwd = process.cwd(),
  agent = null,
  mode = null,
  stateFile = STATE_FILE(),
  env = process.env,
  log = console.log,
  signal = null,
  pollTimeoutSec = 25,
  api = telegramApi(token),
  // Where run sockets go. The default temp dir is where the island looks, so
  // the island can answer a phone run's approval too; a private dir keeps a
  // run to this gateway alone.
  socketDir = undefined,
} = {}) {
  if (!token) throw new Error('a bot token is needed: create one with @BotFather, then ox gateway telegram --token <token>');
  const state = { ...loadState(stateFile), cwd };
  if (mode) state.mode = mode;
  const persist = () => saveState({ ...state, token }, stateFile);

  const adapter = {
    async send(chat, text, buttons) {
      const extra = buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] } } : {};
      const m = await api('sendMessage', { chat_id: chat, text, ...extra });
      return { id: m.message_id };
    },
    edit: (chat, id, text) => api('editMessageText', { chat_id: chat, message_id: id, text }),
    async ack(ref, text, newText) {
      await api('answerCallbackQuery', { callback_query_id: ref.id, ...(text ? { text } : {}) });
      if (newText) await api('editMessageText', { chat_id: ref.chat, message_id: ref.messageId, text: newText });
    },
  };
  const core = createRemoteCore({ adapter, state, persist, cwd, agent, env, log, socketDir, channel: 'tg' });

  const me = await api('getMe');
  log(`ox is on Telegram as @${me.username} — working in ${cwd}`);
  if (!state.owner) log(`pair your phone: open @${me.username} and send   /pair ${state.pairCode}`);
  else log(`paired with chat ${state.owner}`);

  let offset = 0;
  while (!signal?.aborted) {
    let updates = [];
    try {
      updates = await api('getUpdates', { offset, timeout: pollTimeoutSec, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (pollTimeoutSec + 10) * 1000 });
    } catch (e) {
      if (signal?.aborted) break;
      log(`telegram: ${e.message} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      try {
        if (u.message) await core.onMessage(u.message.chat?.id, u.message.text);
        else if (u.callback_query) {
          const q = u.callback_query;
          await core.onButton(q.message?.chat?.id, q.data, { id: q.id, chat: q.message?.chat?.id, messageId: q.message?.message_id }, q.message?.text ?? null);
        }
      } catch (e) {
        log(`telegram: ${e.message}`);
      }
    }
  }
  core.stop();
}
