// Your ox from Discord: DM the bot and ox works in your project, with Allow /
// Deny buttons for approvals. Same core as Telegram (src/remote-core.js).
//
//   ox gateway discord --token <bot token> [--cwd <project>]
//
// Direct messages only: a DM's text reaches a bot without Discord's
// privileged "message content" intent, and pairing happens there. Uses the
// WebSocket built into Node 22+; nothing is installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteCore } from './remote-core.js';

export const STATE_FILE = () => path.join(os.homedir(), '.ox', 'gateway', 'discord.json');
const DIRECT_MESSAGES = 1 << 12;

export function loadState(file = STATE_FILE()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export function saveState(st, file = STATE_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function discordRest(token, { base = process.env.OX_DISCORD_API || 'https://discord.com/api/v10', fetchImpl = globalThis.fetch } = {}) {
  return async function call(method, route, body) {
    const r = await fetchImpl(`${base}${route}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (ox, 0.1)' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    const j = text ? JSON.parse(text) : null;
    if (!r.ok) throw new Error(`discord ${method} ${route}: ${j?.message ?? r.status}`);
    return j;
  };
}

export async function runDiscordGateway({
  token,
  cwd = process.cwd(),
  agent = null,
  mode = null,
  stateFile = STATE_FILE(),
  env = process.env,
  log = console.log,
  signal = null,
  rest = discordRest(token),
  gatewayUrl = process.env.OX_DISCORD_GATEWAY || null,
  WebSocketImpl = globalThis.WebSocket,
  socketDir = undefined,
} = {}) {
  if (!token) throw new Error('a bot token is needed: create an application at discord.com/developers, add a bot, copy its token, then ox gateway discord --token <token>');
  if (typeof WebSocketImpl !== 'function') throw new Error('the Discord gateway needs Node 22 or newer (built-in WebSocket)');
  const state = { ...loadState(stateFile), cwd };
  if (mode) state.mode = mode;
  const persist = () => saveState({ ...state, token }, stateFile);

  const rows = (buttons) => (buttons?.length
    ? [{ type: 1, components: buttons.map((b) => ({ type: 2, style: b.danger ? 4 : 3, label: b.label, custom_id: b.data })) }]
    : []);
  const adapter = {
    async send(chat, text, buttons) {
      const m = await rest('POST', `/channels/${chat}/messages`, { content: text, components: rows(buttons) });
      return { id: m.id };
    },
    edit: (chat, id, text) => rest('PATCH', `/channels/${chat}/messages/${id}`, { content: text }),
    async ack(ref, text, newText) {
      // Update the button message in place, or answer only the presser.
      const body = newText
        ? { type: 7, data: { content: newText, components: [] } }
        : { type: 4, data: { content: text ?? 'Not yours.', flags: 64 } };
      await rest('POST', `/interactions/${ref.id}/${ref.token}/callback`, body);
    },
  };
  const core = createRemoteCore({ adapter, state, persist, cwd, agent, env, log, socketDir, channel: 'dc' });

  const url = gatewayUrl ?? `${(await rest('GET', '/gateway/bot')).url}/?v=10&encoding=json`;
  let seq = null;
  let stopped = false;
  signal?.addEventListener?.('abort', () => { stopped = true; core.stop(); });

  const connectOnce = () => new Promise((resolve) => {
    const ws = new WebSocketImpl(url);
    let beat = null;
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const closeAll = () => { if (beat) clearInterval(beat); resolve(); };
    signal?.addEventListener?.('abort', () => { try { ws.close(); } catch {} }, { once: true });
    ws.addEventListener('message', async (e) => {
      let p;
      try { p = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')); } catch { return; }
      if (p.s != null) seq = p.s;
      if (p.op === 10) {
        beat = setInterval(() => send({ op: 1, d: seq }), p.d?.heartbeat_interval ?? 41250);
        send({ op: 2, d: { token, intents: DIRECT_MESSAGES, properties: { os: process.platform, browser: 'ox', device: 'ox' } } });
      } else if (p.op === 1) {
        send({ op: 1, d: seq });
      } else if (p.op === 7 || p.op === 9) {
        try { ws.close(); } catch {}
      } else if (p.op === 0) {
        try {
          if (p.t === 'READY') {
            const me = p.d?.user?.username ?? 'your bot';
            log(`ox is on Discord as ${me} — working in ${cwd}`);
            if (!state.owner) log(`pair: send ${me} a direct message:   /pair ${state.pairCode}`);
            else log(`paired with channel ${state.owner}`);
          } else if (p.t === 'MESSAGE_CREATE' && !p.d?.author?.bot && !p.d?.guild_id) {
            await core.onMessage(p.d.channel_id, p.d.content);
          } else if (p.t === 'INTERACTION_CREATE' && p.d?.type === 3) {
            const d = p.d;
            await core.onButton(d.channel_id, d.data?.custom_id, { id: d.id, token: d.token }, d.message?.content ?? null);
          }
        } catch (err) {
          log(`discord: ${err.message}`);
        }
      }
    });
    ws.addEventListener('close', closeAll);
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  });

  while (!stopped && !signal?.aborted) {
    await connectOnce();
    if (stopped || signal?.aborted) break;
    log('discord: connection closed — reconnecting in 3s');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
