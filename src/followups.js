// Three short things to ask next, under an answer (Grok's "↳" rows). One small
// call with no tools: the last question and the start of the answer only, a
// hard output cap, and a plain list back. Off with OX_FOLLOWUPS=0.
import { streamVia } from './providers/index.js';
import { normalizeStreamEvent } from './agent.js';

const PROMPT = 'Suggest exactly 3 short follow-up questions the user might ask next, each under 9 words, one per line, no numbering, no quotes, nothing else.';

export function parseFollowups(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•↳]|\d+[.)])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    // Questions or short asks only: never code, markup or an echo of the answer.
    .filter((l) => l.length >= 3 && l.length <= 90 && !/^(here are|sure|suggest)/i.test(l) && !/[`{}\[\]<>=;]|^\w+\s*\(/.test(l))
    .slice(0, 3);
}

export async function followups({ target, question, answer, signal } = {}) {
  if (process.env.OX_FOLLOWUPS === '0') return { items: [], usage: null };
  const q = String(question ?? '').slice(0, 600);
  const a = String(answer ?? '').replace(/```[\s\S]*?```/g, ' ').slice(0, 900);
  if (!q.trim() || !a.trim()) return { items: [], usage: null };
  const messages = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: `Question: ${q}\n\nAnswer (start): ${a}` },
  ];
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of streamVia(target, { model: target?.model, messages, maxTokens: 80, signal })) {
    const ev = normalizeStreamEvent(raw);
    if (!ev) continue;
    if (ev.kind === 'text') text += ev.text;
    else if (ev.kind === 'usage') { usage.inputTokens += ev.usage.inputTokens; usage.outputTokens += ev.usage.outputTokens; }
  }
  return { items: parseFollowups(text), usage };
}
