// load_tools: tools on demand. A turn is offered a small core set; the rest are
// named in one line of the prompt and loaded only when the model asks for them,
// so their definitions are not paid for on every request (the idea of
// Anthropic's Tool Search, which reports ~85% fewer tokens on large tool sets).
// The agent loop owns the offer, so loading goes through ctx.loadTools.

export const LOAD_TOOLS_SCHEMA = Object.freeze({
  name: 'load_tools',
  description: 'Load tools that are not offered yet, by name (the prompt lists them). Their definitions arrive for your next step.',
  input_schema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names, e.g. ["web_search", "mail_compose"]' } },
    required: ['names'],
  },
});

export async function loadToolsTool(args = {}, ctx = {}) {
  const names = Array.isArray(args.names) ? args.names.map(String).filter(Boolean).slice(0, 12) : [];
  if (!names.length) return { content: 'load_tools: give the names of the tools to load.', isError: true };
  if (typeof ctx.loadTools !== 'function') return { content: 'load_tools: every tool is already offered in this run.', isError: true };
  const { loaded, unknown } = ctx.loadTools(names);
  const parts = [];
  if (loaded.length) parts.push(`Loaded: ${loaded.join(', ')}. Use them now.`);
  if (unknown.length) parts.push(`Not available: ${unknown.join(', ')}.`);
  return { content: parts.join(' '), isError: loaded.length === 0 };
}
