// What a paid tool costs. An MCP tool can declare a price per call (annotations.costUsd, or
// _meta.costUsd). The price and the chat's running total travel with the result, and over the
// chat's limit ox asks a person first, even with -y. Limit: config paidToolLimitUsd, default $5.
export const DEFAULT_PAID_LIMIT_USD = 5;
// The total belongs to the chat: the app starts a new run for every message, so a run's own
// state would reset the limit each time. Keyed by the chat's session id; a run without one
// keeps its own.
const totals = new Map();
const keyOf = (ctx) => ctx.sessionId ?? (ctx.sessionState ??= {});
const spentOf = (ctx) => totals.get(keyOf(ctx)) ?? 0;
const addSpent = (ctx, n) => { const k = keyOf(ctx); totals.set(k, (totals.get(k) ?? 0) + n); if (totals.size > 5000) totals.delete(totals.keys().next().value); return totals.get(k); };

/** The declared price of a tool from its listing, or null. */
export function declaredPrice(tool) {
  const v = Number(tool?.annotations?.costUsd ?? tool?._meta?.costUsd ?? tool?.costUsd);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const money = (n) => `$${n < 1 ? n.toFixed(n < 0.1 ? 3 : 2) : n.toFixed(2)}`;

/** Before the call. → { ok: true, price } or { ok: false, content, isError } */
export async function checkPaidCall(name, args, ctx = {}) {
  const tool = (ctx.mcpTools ?? []).find((t) => `mcp__${t.server ?? 'server'}__${t.name}` === name || t.qualified === name);
  const price = declaredPrice(tool);
  if (!price) return { ok: true, price: null };
  const spent = spentOf(ctx);
  const limit = Number(ctx.config?.paidToolLimitUsd ?? DEFAULT_PAID_LIMIT_USD);
  if (spent + price > limit) {
    const what = `${name} costs ${money(price)}. This chat has spent ${money(spent)} on paid tools, and this goes over its ${money(limit)} limit. Go ahead?`;
    const yes = ctx.requestApproval ? await ctx.requestApproval(name, args, what, { force: true }) : false;
    if (!yes) return { ok: false, content: `${what} Not run: nobody approved it.`, isError: true };
  }
  return { ok: true, price };
}

/** After a call that worked: the bill, added to the chat's total, said in the result. */
export function notePaidCall(result, price, ctx = {}) {
  if (!price || result?.isError) return result;
  const total = addSpent(ctx, price);
  return { ...result, content: `${result.content ?? ''}\n[this call cost ${money(price)}; ${money(total)} on paid tools in this chat]` };
}

/** What this chat has spent on paid tools. */
export const paidSpent = (ctx) => spentOf(ctx);
