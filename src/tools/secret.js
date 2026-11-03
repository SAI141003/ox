// request_secret: when a task needs an API key ox does not have, the agent asks
// you for it, in the chat, with a password field (Rerun's idea). What you type
// goes straight to ox's key store on this machine (~/.ox/keys.json, mode 600)
// and into the environment of this run; the model is told only that it was
// saved, never the value. Without the app it says how to add it yourself.
import { KEY_NAME, keyStatus } from '../keystore.js';

export const SECRET_TOOL_SCHEMAS = Object.freeze([{
  name: 'request_secret',
  description: 'Ask the user for an API key or token this task needs and that is not set (e.g. STRIPE_API_KEY). The user types it into a private field; it is stored on this machine and set for this run. You never see the value. Name it in UPPER_SNAKE case ending in _KEY or _TOKEN, and say in one line what it is for and where they get it.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The variable name, e.g. OPENWEATHER_API_KEY' },
      why: { type: 'string', description: 'One line: what it is for and where to get it' },
    },
    required: ['name', 'why'],
  },
}]);

export async function request_secret(args = {}, ctx = {}) {
  const name = String(args.name ?? '').trim().toUpperCase();
  if (!KEY_NAME.test(name)) return { content: `request_secret: "${name}" is not a key name: UPPER_SNAKE case ending in _KEY or _TOKEN, e.g. OPENWEATHER_API_KEY.`, isError: true };
  const st = keyStatus(name);
  if (st?.set) return { content: `${name} is already set (${st.source ?? 'on this machine'}); use it from the environment.` };
  if (typeof ctx.requestSecret !== 'function') {
    return { content: `${name} is not set and there is no app window to ask in. Tell the user to add it in the ox app (Settings, then Keys) or to export ${name} in their shell; it stays on their machine. Then run again.`, isError: true };
  }
  const saved = await ctx.requestSecret(name, String(args.why ?? '').slice(0, 300));
  return saved
    ? { content: `${name} saved on this machine and set for this run. Use it from the environment (process.env.${name} / $${name}); never print it.` }
    : { content: `The user did not give ${name}. Go on without it, or explain what it would unlock.`, isError: true };
}
