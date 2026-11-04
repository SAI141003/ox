// Three short next steps, under an answer (Grok's "↳" rows). One small
// call with no tools: the last question and the start of the answer only, a
// hard output cap, and a plain list back. Off with OX_FOLLOWUPS=0.
import { quickText } from './quick-text.js';

const PROMPT = 'Suggest exactly 3 short next steps the user could send next, written as their own words, each under 9 words and specific to this answer: the thing to do first, then useful questions. One per line, no numbering, no quotes, nothing else.';

export function parseFollowups(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•↳]|\d+[.)])\s*/, '').replace(/^["“]|["”]$/g, '').trim())
    // Questions or short asks only: never code, markup or an echo of the answer.
    .filter((l) => l.length >= 3 && l.length <= 90 && !/^(here are|sure|suggest)/i.test(l) && !/[`{}\[\]<>=;]|^\w+\s*\(/.test(l))
    .slice(0, 3);
}

/** What the suggestions are made from. */
export function answerStart(answer) {
  const raw = String(answer ?? '');
  return (raw.replace(/```[\s\S]*?```/g, ' ').trim() || raw).slice(0, 900);
}

export async function followups({ target, question, answer, signal } = {}) {
  if (process.env.OX_FOLLOWUPS === '0') return { items: [], usage: null };
  const q = String(question ?? '').slice(0, 600);
  // Prose first. An answer that is only a drawn card has none: its block says what it offers.
  const a = answerStart(answer);
  if (!q.trim() || !a.trim()) return { items: [], usage: null };
  const { text, usage } = await quickText(target, { system: PROMPT, user: `Question: ${q}\n\nAnswer (start): ${a}`, maxTokens: 200, signal });
  return { items: parseFollowups(text), usage };
}
