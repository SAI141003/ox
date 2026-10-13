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
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectIpcClient, socketPathFor } from './ipc.js';
import { createWatchState, applyMessage, currentTool } from './ipc-watch.js';
import { MODE_NAMES, normalizeMode } from './modes.js';

const OX_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
export const STATE_FILE = () => path.join(os.homedir(), '.ox', 'gateway', 'telegram.json');
const MAX_TG = 4000;

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

export function splitMessage(text, max = MAX_TG) {
  const out = [];
  let s = String(text ?? '').trim() || '(no text)';
  while (s.length > max) {
    let cut = s.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^\n/, '');
  }
  out.push(s);
  return out;
}

// What ox printed, minus its own progress lines.
export const cleanAnswer = (s) => String(s ?? '').split('\n')
  .filter((l) => !/^[·●✓✗] /.test(l) && !/^\s+~ /.test(l))
  .join('\n').replace(/\n{3,}/g, '\n\n').trim();

const HELP = [
  'ox on Telegram — send a message and ox works on it in your project.',
  '/status  what is running',
  '/stop    stop the current run',
  `/mode <name>  ${['auto', ...MODE_NAMES].join(' | ')}`,
  '/new     start a fresh conversation',
  '/where   which project ox works in',
].join('\n');

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
} = {}) {
  if (!token) throw new Error('a bot token is needed: create one with @BotFather, then ox gateway telegram --token <token>');
  const state = { mode: 'auto', fresh: true, ...loadState(stateFile), cwd };
  if (mode) state.mode = mode;
  if (!state.owner && !state.pairCode) state.pairCode = String(crypto.randomInt(100000, 1000000));
  saveState({ ...state, token }, stateFile);

  const me = await api('getMe');
  log(`ox is on Telegram as @${me.username} — working in ${cwd}`);
  if (!state.owner) log(`pair your phone: open @${me.username} and send   /pair ${state.pairCode}`);
  else log(`paired with chat ${state.owner}`);

  let offset = 0;
  let run = null; // the one active run

  const say = (chat, text, extra = {}) => api('sendMessage', { chat_id: chat, text, ...extra });

  async function startRun(chat, text) {
    const id = crypto.randomBytes(4).toString('hex');
    const sock = socketPathFor(`tg-${id}`);
    const args = [OX_CLI, '-p', text, `--ipc=${sock}`, '--mode', state.mode || 'auto', ...(agent ? ['--agent', agent] : []), ...(state.fresh ? [] : ['-c'])];
    const status = await say(chat, '⏳ working…');
    // A phone is slower to answer than a desk: approvals wait 10 minutes
    // (unless set), then decline as usual.
    const childEnv = { OX_IPC_APPROVAL_TIMEOUT_MS: '600000', ...env, OX_IPC_WAIT_CLIENT_MS: '15000', OX_ISLAND: '0', NO_COLOR: '1' };
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    run = { id, chat, child, sock, statusId: status.message_id, started: Date.now(), watch: createWatchState(), client: null, asked: new Set(), lastEdit: 0, lastShown: '' };
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    state.fresh = false;
    saveState({ ...state, token }, stateFile);
    connectWhenReady(run);
    child.on('close', async (code) => {
      const r = run;
      run = null;
      try { r.client?.close(); } catch {}
      const secs = Math.round((Date.now() - r.started) / 1000);
      const answer = cleanAnswer(out);
      try {
        await api('editMessageText', { chat_id: chat, message_id: r.statusId, text: code === 0 ? `✓ done in ${secs}s` : `✗ stopped (exit ${code}) after ${secs}s` });
      } catch {}
      for (const part of splitMessage(answer)) await say(chat, part).catch(() => {});
    });
  }

  // The run's IPC socket appears a moment after it starts.
  function connectWhenReady(r, tries = 0) {
    if (run !== r) return;
    const client = connectIpcClient({ socketPath: r.sock, clientId: `telegram-${process.pid}`, connectTimeoutMs: 500 });
    client.on('open', () => { r.client = client; });
    client.on('message', (msg) => onRunMessage(r, msg));
    client.on('close', (info) => {
      if (!info?.connected && tries < 60 && run === r) setTimeout(() => connectWhenReady(r, tries + 1), 250);
    });
  }

  async function onRunMessage(r, msg) {
    r.watch = applyMessage(r.watch, msg, { now: Date.now() });
    if (msg?.type === 'approval-request' && !r.asked.has(msg.id)) {
      r.asked.add(msg.id);
      const preview = String(msg.argsPreview ?? '').slice(0, 600);
      await say(r.chat, `ox wants to run ${msg.tool}\n\n${preview}`, {
        reply_markup: { inline_keyboard: [[
          { text: 'Allow', callback_data: `ap:${r.id}:${msg.id}:allow` },
          { text: 'Deny', callback_data: `ap:${r.id}:${msg.id}:deny` },
        ]] },
      }).catch(() => {});
      return;
    }
    // One status line, edited at most every 2s, only when it changes.
    const tool = currentTool(r.watch);
    const line = tool ? `⏳ ${tool.name}${tool.preview ? ` ${String(tool.preview).slice(0, 80)}` : ''}` : null;
    if (line && line !== r.lastShown && Date.now() - r.lastEdit > 2000) {
      r.lastShown = line;
      r.lastEdit = Date.now();
      api('editMessageText', { chat_id: r.chat, message_id: r.statusId, text: line }).catch(() => {});
    }
  }

  async function onMessage(m) {
    const chat = m.chat?.id;
    const text = String(m.text ?? '').trim();
    if (!chat || !text) return;
    if (!state.owner) {
      const code = /^\/pair\s+(\d{6})$/.exec(text)?.[1];
      if (code && code === state.pairCode) {
        state.owner = chat;
        delete state.pairCode;
        saveState({ ...state, token }, stateFile);
        log(`paired with chat ${chat}`);
        await say(chat, `Paired. I work in ${path.basename(cwd)}.\n\n${HELP}`);
      } else {
        await say(chat, 'This ox is not paired yet. Send /pair <code> — the code is shown in the terminal running ox gateway.');
      }
      return;
    }
    if (chat !== state.owner) return; // not yours: ignored, and told nothing
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '/start': case '/help': return void say(chat, HELP);
      case '/where': return void say(chat, `${cwd}\nmode: ${state.mode}${agent ? `\nagent: ${agent}` : ''}`);
      case '/new': state.fresh = true; saveState({ ...state, token }, stateFile); return void say(chat, 'Fresh conversation from the next message.');
      case '/mode': {
        const m2 = normalizeMode(rest[0]);
        if (!m2) return void say(chat, `modes: ${['auto', ...MODE_NAMES].join(', ')} (now: ${state.mode})`);
        state.mode = m2;
        saveState({ ...state, token }, stateFile);
        return void say(chat, `mode: ${m2}`);
      }
      case '/status': {
        if (!run) return void say(chat, 'Nothing running.');
        const tool = currentTool(run.watch);
        return void say(chat, `Working for ${Math.round((Date.now() - run.started) / 1000)}s — ${tool ? `${tool.name} ${tool.preview ?? ''}` : run.watch.phase}`);
      }
      case '/stop': {
        if (!run) return void say(chat, 'Nothing running.');
        run.child.kill('SIGINT');
        return void say(chat, 'Stopping.');
      }
      default:
        if (run) return void say(chat, 'Still on the last one. /status to see it, /stop to stop it.');
        return startRun(chat, text);
    }
  }

  async function onCallback(q) {
    const chat = q.message?.chat?.id;
    if (!state.owner || chat !== state.owner) return api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    const [, runId, approvalId, decision] = String(q.data ?? '').split(':');
    const ok = run && run.id === runId && run.client && ['allow', 'deny'].includes(decision)
      ? run.client.answer(approvalId, decision)
      : false;
    await api('answerCallbackQuery', { callback_query_id: q.id, text: ok ? (decision === 'allow' ? 'Allowed' : 'Denied') : 'That request has expired' }).catch(() => {});
    if (ok) {
      await api('editMessageText', { chat_id: chat, message_id: q.message.message_id, text: `${q.message.text}\n\n→ ${decision === 'allow' ? 'allowed' : 'denied'}` }).catch(() => {});
    }
  }

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
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        log(`telegram: ${e.message}`);
      }
    }
  }
  if (run) run.child.kill('SIGINT');
}
