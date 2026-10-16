// The wand in the chat box: turns a rough message into a clear prompt before it
// is sent. One small call with no tools and a hard output cap; the user sees the
// new text in the box and can edit or undo it, nothing is sent on its own.
import { quickText } from './quick-text.js';

const PROMPT = [
  'Rewrite the user\'s message into a clearer prompt for an AI assistant.',
  'Keep their intent, language and every fact they gave; never invent facts, names, files or numbers.',
  'Make it specific: the goal, the context they gave, constraints, and what the answer should look like.',
  'Where something needed is missing, add a short placeholder in square brackets, like [which file?].',
  'Keep it short: a sentence or two for a simple ask, a few lines for a bigger one.',
  'Reply with the rewritten prompt only: no preface, no quotes, no explanation.',
].join(' ');

export function cleanOptimized(text, original) {
  let t = String(text ?? '').trim()
    .replace(/^```\w*\n?|\n?```$/g, '')
    .replace(/^(?:here(?:'s| is) (?:the |a |your )?(?:rewritten|improved|optimi[sz]ed|clearer) prompt:?|rewritten prompt:|prompt:)\s*/i, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim();
  // A reply that answers the question instead of rewriting it is no use here.
  if (!t || t.length > Math.max(1200, String(original).length * 6)) return '';
  return t;
}

export async function optimizePrompt({ target, text, signal } = {}) {
  const original = String(text ?? '').slice(0, 4000);
  if (!original.trim()) return { text: '', usage: null };
  const { text: out, usage } = await quickText(target, { system: PROMPT, user: `Message to rewrite:\n${original}`, maxTokens: 400, signal });
  return { text: cleanOptimized(out, original), usage };
}
