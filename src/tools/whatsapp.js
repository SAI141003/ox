// Official WhatsApp Cloud API adapter. Personal-account scraping and
// unofficial bridges are intentionally not supported. The inbound webhook is
// deliberately local-first: Meta posts to the operator's configured callback,
// Ox verifies the signed payload, and recent messages are retained only in the
// owner's ~/.ox directory for Island/Office to render.
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const API = 'https://graph.facebook.com/v20.0';
const INBOX_LIMIT = 300;

export function whatsappConfig(env = process.env) {
  return {
    token: String(env.WHATSAPP_ACCESS_TOKEN ?? '').trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim(),
    verifyToken: String(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? '').trim(),
    appSecret: String(env.WHATSAPP_APP_SECRET ?? '').trim(),
  };
}

export function whatsappInboxFile(home = path.join(os.homedir(), '.ox')) {
  return path.join(home, 'whatsapp', 'inbox.json');
}

export function readWhatsappInbox({ home } = {}) {
  try {
    const messages = JSON.parse(fs.readFileSync(whatsappInboxFile(home), 'utf8'));
    return Array.isArray(messages) ? messages.slice(0, INBOX_LIMIT) : [];
  } catch { return []; }
}

function writeWhatsappInbox(messages, { home } = {}) {
  const file = whatsappInboxFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(next, JSON.stringify(messages.slice(0, INBOX_LIMIT), null, 2), { mode: 0o600 });
  fs.renameSync(next, file);
}

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta's one-time GET challenge. It never creates state. */
export function whatsappWebhookChallenge(query = {}, { env = process.env } = {}) {
  const c = whatsappConfig(env);
  if (!c.verifyToken) return { ok: false, status: 503, error: 'WhatsApp webhook setup is incomplete: set WHATSAPP_WEBHOOK_VERIFY_TOKEN.' };
  if (String(query['hub.mode'] ?? '') !== 'subscribe' || !same(query['hub.verify_token'] ?? '', c.verifyToken)) {
    return { ok: false, status: 403, error: 'WhatsApp webhook verification failed.' };
  }
  return { ok: true, challenge: String(query['hub.challenge'] ?? '') };
}

/**
 * Verify a signed Cloud API callback and persist only message/contact fields
 * needed for the local inbox. Returns a count so callers never report a send
 * or a received message based on a successful HTTP request alone.
 */
export function receiveWhatsappWebhook(rawBody, signature, { env = process.env, home } = {}) {
  const c = whatsappConfig(env);
  if (!c.appSecret) return { ok: false, status: 503, error: 'WhatsApp inbound setup is incomplete: set WHATSAPP_APP_SECRET.' };
  const expected = `sha256=${createHmac('sha256', c.appSecret).update(rawBody).digest('hex')}`;
  if (!same(signature ?? '', expected)) return { ok: false, status: 401, error: 'WhatsApp webhook signature did not verify.' };
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { ok: false, status: 400, error: 'WhatsApp webhook body is not JSON.' }; }
  const prior = readWhatsappInbox({ home });
  const known = new Set(prior.map((m) => m.id));
  const added = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
    const value = change?.value ?? {};
    const contacts = new Map((Array.isArray(value.contacts) ? value.contacts : []).map((contact) => [String(contact.wa_id ?? ''), String(contact.profile?.name ?? '')]));
    for (const message of Array.isArray(value.messages) ? value.messages : []) {
      const id = String(message.id ?? '');
      if (!id || known.has(id)) continue;
      const from = String(message.from ?? '');
      const type = String(message.type ?? 'unknown');
      const text = type === 'text' ? String(message.text?.body ?? '') : `[${type} message]`;
      added.push({ id, from, contact: contacts.get(from) || null, type, text, timestamp: Number(message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000, receivedAt: new Date().toISOString() });
      known.add(id);
    }
  }
  if (added.length) writeWhatsappInbox([...added.reverse(), ...prior], { home });
  return { ok: true, status: 200, received: added.length };
}

export async function whatsapp_health({ env = process.env, fetchImpl = fetch } = {}) {
  const c = whatsappConfig(env);
  if (!c.token || !c.phoneNumberId) return { configured: false, reachable: false, inboundReady: false, reason: 'Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.' };
  try {
    const r = await fetchImpl(`${API}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { configured: true, reachable: true, inboundReady: !!(c.verifyToken && c.appSecret), phoneNumber: data.display_phone_number ?? null, name: data.verified_name ?? null } : { configured: true, reachable: false, inboundReady: !!(c.verifyToken && c.appSecret), reason: data.error?.message ?? `HTTP ${r.status}` };
  } catch (e) { return { configured: true, reachable: false, inboundReady: !!(c.verifyToken && c.appSecret), reason: e.message }; }
}

export async function whatsapp_send(args = {}, ctx = {}) {
  const c = whatsappConfig(ctx.env ?? process.env);
  const to = String(args.to ?? '').replace(/[^\d+]/g, '');
  const body = String(args.body ?? '').trim();
  if (!to || !body) return { content: 'whatsapp_send: both to (a phone number with country code) and body are required.', isError: true };
  if (!c.token || !c.phoneNumberId) return whatsappDesktopSend(to, body, ctx);
  if (typeof ctx.requestApproval !== 'function') return { content: 'whatsapp_send: sending requires explicit approval; nothing was sent.', isError: true };
  if (!await ctx.requestApproval('whatsapp_send', { to, body }, `Send this WhatsApp message?\nTo: ${to}\n\n${body}`)) return { content: 'whatsapp_send: declined; nothing was sent.', isError: false };
  const r = await (ctx.fetchImpl ?? fetch)(`${API}/${encodeURIComponent(c.phoneNumberId)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }), signal: AbortSignal.timeout(15_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { content: `whatsapp_send: Cloud API refused the message: ${data.error?.message ?? `HTTP ${r.status}`}`, isError: true };
  return { content: `WhatsApp message accepted for ${to}. Message id: ${data.messages?.[0]?.id ?? 'unknown'}.`, isError: false };
}

// No Cloud API: the person's own WhatsApp for Mac. The chat opens with the
// message typed in; they press Enter, so ox never sends on its own and never
// reads WhatsApp's private store.
async function whatsappDesktopSend(to, body, ctx) {
  const { detectDesktopApps, whatsappDesktopLink } = await import('../desktop-apps.js');
  const app = (ctx.detectApps ?? detectDesktopApps)().whatsapp;
  if (!app?.installed) return { content: 'whatsapp_send: WhatsApp for Mac is not installed and the Cloud API is not set up (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID). Install WhatsApp from the App Store, or set up the Cloud API.', isError: true };
  if (typeof ctx.requestApproval !== 'function') return { content: 'whatsapp_send: opening a WhatsApp message needs your approval; nothing was opened.', isError: true };
  if (!await ctx.requestApproval('whatsapp_send', { to, body }, `Open this message in WhatsApp for you to send?\nTo: ${to}\n\n${body}`)) return { content: 'whatsapp_send: declined; nothing was opened.', isError: false };
  const link = whatsappDesktopLink(to, body);
  if (process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') return { content: `WhatsApp (dry run): would open ${link}`, isError: false };
  const { spawnSync } = await import('node:child_process');
  const r = (ctx.openLink ?? ((u) => spawnSync('open', ['-b', app.bundle ?? 'net.whatsapp.WhatsApp', u], { timeout: 10_000 })))(link);
  if (r?.status !== 0) return { content: `whatsapp_send: WhatsApp did not open (${String(r?.stderr ?? '').trim() || 'open failed'}).`, isError: true };
  return { content: `Opened WhatsApp with the message to ${to} typed in. It is NOT sent yet: press Enter in WhatsApp to send it.`, isError: false };
}

export const WHATSAPP_TOOL_SCHEMAS = [{ name: 'whatsapp_send', description: 'Send a WhatsApp message. With the official Cloud API set up it sends after approval; otherwise it opens the chat in WhatsApp for Mac with the message typed in, and the person presses Enter. "to" is a phone number with country code.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } }];
