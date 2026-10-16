// One small text-only call to any model ox can reach, for the app's helpers
// (follow-ups, the prompt wand): an API model through its provider, or a plan
// you pay for (ChatGPT, Claude…) through its own CLI. No tools either way.
import os from 'node:os';
import { streamVia } from './providers/index.js';
import { normalizeStreamEvent } from './agent.js';

export async function quickText(target, { system, user, maxTokens = 200, signal } = {}) {
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (target?.provider === 'subscription') {
    const { runSubscriptionTurn } = await import('./subscriptions.js');
    let final = '';
    for await (const e of runSubscriptionTurn({ target, messages: [{ role: 'user', content: user }], ctx: { cwd: os.tmpdir(), mode: 'ask', personaBlock: system }, signal })) {
      if (e.type === 'text-delta') text += e.text;
      else if (e.type === 'final') final = typeof e.message?.content === 'string' ? e.message.content : '';
      else if (e.type === 'usage' && e.usage) { usage.inputTokens += e.usage.inputTokens ?? 0; usage.outputTokens += e.usage.outputTokens ?? 0; }
      else if (e.type === 'error') throw new Error(String(e.error));
    }
    return { text: text || final, usage };
  }
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  for await (const raw of streamVia(target, { model: target?.model, messages, maxTokens, signal })) {
    const ev = normalizeStreamEvent(raw);
    if (!ev) continue;
    if (ev.kind === 'text') text += ev.text;
    else if (ev.kind === 'usage') { usage.inputTokens += ev.usage.inputTokens; usage.outputTokens += ev.usage.outputTokens; }
  }
  return { text, usage };
}
