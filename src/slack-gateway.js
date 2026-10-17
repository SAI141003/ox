// Your ox from Slack: DM the app and ox works in your project, with Allow /
// Deny buttons for approvals. Same core as Telegram and Discord (src/remote-core.js).
//
//   ox gateway slack --app-token xapp-… --bot-token xoxb-… [--cwd <project>]
//
// Socket Mode: ox opens the connection out to Slack, so nothing needs a public
// URL, and it uses the WebSocket built into Node 22+; nothing is installed.
// Direct messages only (channel_type "im"); pairing happens there.
//
// Slack app setup (api.slack.com/apps): turn on Socket Mode (that gives the
// xapp- token, scope connections:write); Bot scopes chat:write and im:history;
// Event Subscriptions: message.im; Interactivity on; App Home: allow messages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteCore } from './remote-core.js';

export const STATE_FILE = () => path.join(os.homedir(), '.ox', 'gateway', 'slack.json');

export function loadState(file = STATE_FILE()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
export function saveState(st, file = STATE_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** Slack Web API: POST <base>/<method> with a token; throws on { ok:false }. */
export function slackApi(token, { base = process.env.OX_SLACK_API || 'https://slack.com/api', fetchImpl = globalThis.fetch } = {}) {
  return async function call(method, body = {}) {
    const r = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? r.status}`);
    return j;
  };
}

// Slack keeps "/…" for its own slash commands, so here a message that is
// exactly one of ox's commands works without the slash ("pair 123456",
// "status"); "stop using tabs" is still an ordinary request.
export function slashless(text) {
  const t = String(text ?? '').trim();
  return /^(pair\s+\d{6}|help|start|where|new|status|stop|mode(\s+[a-z]+)?)$/i.test(t) ? `/${t.toLowerCase()}` : t;
}

export async function runSlackGateway({
  appToken,
  botToken,
  cwd = process.cwd(),
  agent = null,
  mode = null,
  stateFile = STATE_FILE(),
  env = process.env,
  log = console.log,
  signal = null,
  app = slackApi(appToken),
  bot = slackApi(botToken),
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  socketDir = undefined,
} = {}) {
  if (!appToken || !String(appToken).startsWith('xapp-')) throw new Error('an app-level token (xapp-…) is needed: api.slack.com/apps › your app › Socket Mode › generate one with connections:write');
  if (!botToken || !String(botToken).startsWith('xoxb-')) throw new Error('a bot token (xoxb-…) is needed: api.slack.com/apps › your app › OAuth & Permissions › Bot User OAuth Token (scopes chat:write, im:history)');
  if (typeof WebSocketImpl !== 'function') throw new Error('the Slack gateway needs Node 22 or newer (built-in WebSocket)');
  const state = { ...loadState(stateFile), cwd };
  if (mode) state.mode = mode;
  const persist = () => saveState({ ...state, appToken, botToken }, stateFile);

  const blocks = (text, buttons) => (buttons?.length
    ? [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
       { type: 'actions', elements: buttons.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, value: b.data, action_id: `ox_${b.data}`.slice(0, 250), ...(b.danger ? { style: 'danger' } : { style: 'primary' }) })) }]
    : undefined);
  // ox's replies name its commands as "/pair", "/status"…; on Slack they are typed without the slash.
  const local = (t) => String(t ?? '').replace(/(^|[\s(])\/(pair|help|start|where|new|mode|status|stop)\b/g, '$1$2');
  const adapter = {
    async send(chat, text, buttons) {
      const m = await bot('chat.postMessage', { channel: chat, text: local(text), ...(buttons?.length ? { blocks: blocks(local(text), buttons) } : {}) });
      return { id: m.ts };
    },
    edit: (chat, id, text) => bot('chat.update', { channel: chat, ts: id, text: local(text), blocks: [] }),
    async ack(ref, text, newText) {
      // Replace the button message, or answer only the person who pressed.
      if (newText) await bot('chat.update', { channel: ref.channel, ts: ref.ts, text: newText, blocks: [] });
      else if (ref.responseUrl) await fetchImpl(ref.responseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: text ?? 'Not yours.' }) });
    },
  };
  const core = createRemoteCore({ adapter, state, persist, cwd, agent, env, log, socketDir, channel: 'sl' });

  let stopped = false;
  let announced = false;
  signal?.addEventListener?.('abort', () => { stopped = true; core.stop(); });

  const connectOnce = async () => {
    const { url } = await app('apps.connections.open');
    await new Promise((resolve) => {
      const ws = new WebSocketImpl(url);
      const ackEnv = (id) => { try { ws.send(JSON.stringify({ envelope_id: id })); } catch {} };
      signal?.addEventListener?.('abort', () => { try { ws.close(); } catch {} }, { once: true });
      ws.addEventListener('message', async (e) => {
        let p;
        try { p = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')); } catch { return; }
        // Every envelope is acknowledged at once (Slack retries otherwise).
        if (p.envelope_id) ackEnv(p.envelope_id);
        try {
          if (p.type === 'hello') {
            if (!announced) {
              announced = true;
              log(`ox is on Slack — working in ${cwd}`);
              if (!state.owner) log(`pair: send the app a direct message:   pair ${state.pairCode}`);
              else log(`paired with ${state.owner}`);
            }
          } else if (p.type === 'disconnect') {
            try { ws.close(); } catch {}
          } else if (p.type === 'events_api') {
            const ev = p.payload?.event;
            if (ev?.type === 'message' && ev.channel_type === 'im' && !ev.bot_id && !ev.subtype && typeof ev.text === 'string') {
              await core.onMessage(ev.channel, slashless(ev.text));
            }
          } else if (p.type === 'interactive' && p.payload?.type === 'block_actions') {
            const pl = p.payload;
            const action = pl.actions?.[0];
            if (action?.value) {
              await core.onButton(pl.channel?.id, action.value, { channel: pl.channel?.id, ts: pl.message?.ts, responseUrl: pl.response_url }, pl.message?.text ?? null);
            }
          }
        } catch (err) {
          log(`slack: ${err.message}`);
        }
      });
      ws.addEventListener('close', () => resolve());
      ws.addEventListener('error', () => { try { ws.close(); } catch {} });
    });
  };

  while (!stopped && !signal?.aborted) {
    try { await connectOnce(); }
    catch (err) { log(`slack: ${err.message}`); if (/invalid_auth|not_authed|token_revoked|not_allowed_token_type/.test(err.message)) throw err; }
    if (stopped || signal?.aborted) break;
    log('slack: connection closed — reconnecting in 3s');
    await new Promise((r) => setTimeout(r, 3000));
  }
}
