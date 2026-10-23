// Agent-facing bot creation.  The app has long had a Bot editor, but an Ox
// agent could only describe a new bot, not create one.  Keep this small and
// route it through the same validated persistence code as the editor.

export const BOT_TOOL_SCHEMAS = [
  {
    name: 'create_bot',
    description: 'Create a named OX bot with its own instructions, model choice and allowed tools. This persists a new bot in the user’s OX configuration and therefore always requires explicit approval.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1–48 letters, digits, dashes or underscores; must be unique.' },
        description: { type: 'string', description: 'What this bot is for.' },
        bot: { type: 'string', description: 'Optional installed model or plan id; omit to use the default model.' },
        mode: { type: 'string', enum: ['code', 'ask', 'plan', 'debug', 'data', 'orchestrate'], description: 'How the bot works; defaults to code.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowed tool names. Omit for the selected mode’s normal tools.' },
        instructions: { type: 'string', description: 'The bot’s persistent instructions.' },
      },
      required: ['name', 'description'],
    },
  },
];

export async function createBotTool(args = {}, ctx = {}) {
  const name = String(args.name ?? '').trim();
  const description = String(args.description ?? '').trim();
  if (!name) return { content: 'create_bot: name is required', isError: true };
  if (!description) return { content: 'create_bot: description is required', isError: true };
  try {
    const { botSave } = await import('../app-api.js');
    await botSave({
      name,
      description,
      bot: args.bot ? String(args.bot) : null,
      mode: args.mode ? String(args.mode) : 'code',
      tools: Array.isArray(args.tools) ? args.tools.map(String) : null,
      instructions: String(args.instructions ?? ''),
    }, ctx.env ?? process.env);
    return { content: `Created OX bot "${name}". It is available in Bots and as agent:${name}.` };
  } catch (e) {
    return { content: `create_bot: ${e?.message ?? e}`, isError: true };
  }
}
