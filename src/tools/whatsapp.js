// Official WhatsApp Cloud API adapter.  Personal-account scraping and
// unofficial bridges are intentionally not supported.
const API = 'https://graph.facebook.com/v20.0';

export function whatsappConfig(env = process.env) {
  return { token: String(env.WHATSAPP_ACCESS_TOKEN ?? '').trim(), phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim() };
}

export async function whatsapp_health({ env = process.env, fetchImpl = fetch } = {}) {
  const c = whatsappConfig(env);
  if (!c.token || !c.phoneNumberId) return { configured: false, reachable: false, reason: 'Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.' };
  try {
    const r = await fetchImpl(`${API}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(8000) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { configured: true, reachable: true, phoneNumber: data.display_phone_number ?? null, name: data.verified_name ?? null } : { configured: true, reachable: false, reason: data.error?.message ?? `HTTP ${r.status}` };
  } catch (e) { return { configured: true, reachable: false, reason: e.message }; }
}

export async function whatsapp_send(args = {}, ctx = {}) {
  const c = whatsappConfig(ctx.env ?? process.env);
  if (!c.token || !c.phoneNumberId) return { content: 'whatsapp_send: configure the official WhatsApp Cloud API first (WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID).', isError: true };
  const to = String(args.to ?? '').replace(/[^\d+]/g, '');
  const body = String(args.body ?? '').trim();
  if (!to || !body) return { content: 'whatsapp_send: both to and body are required.', isError: true };
  if (typeof ctx.requestApproval !== 'function') return { content: 'whatsapp_send: sending requires explicit approval; nothing was sent.', isError: true };
  if (!await ctx.requestApproval('whatsapp_send', { to, body }, `Send this WhatsApp message?\nTo: ${to}\n\n${body}`)) return { content: 'whatsapp_send: declined; nothing was sent.', isError: false };
  const r = await (ctx.fetchImpl ?? fetch)(`${API}/${encodeURIComponent(c.phoneNumberId)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }), signal: AbortSignal.timeout(15_000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { content: `whatsapp_send: Cloud API refused the message: ${data.error?.message ?? `HTTP ${r.status}`}`, isError: true };
  return { content: `WhatsApp message accepted for ${to}. Message id: ${data.messages?.[0]?.id ?? 'unknown'}.`, isError: false };
}

export const WHATSAPP_TOOL_SCHEMAS = [{ name: 'whatsapp_send', description: 'Send a WhatsApp message through the official Cloud API. Requires credentials and explicit approval.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } }];
