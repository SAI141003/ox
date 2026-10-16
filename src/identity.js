// The name you gave ox. One setting (~/.ox/config.json `name`) that every
// surface uses: the prompt (it calls itself that and knows you mean it when you
// say it mid-sentence — "Nova, what's left on this branch?"), the app, the
// terminal and the island. OX_NAME overrides it for one run.
import { readConfigDoc, saveConfigDoc } from './config.js';

export const DEFAULT_NAME = 'ox';
// Letters in any script, digits, spaces, dots, dashes, apostrophes; 1–24 chars.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,23}$/u;

export function cleanName(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return NAME_RE.test(s) ? s : null;
}

export function assistantName(env = process.env) {
  const fromEnv = cleanName(env.OX_NAME);
  if (fromEnv) return fromEnv;
  try { return cleanName(readConfigDoc().name) ?? DEFAULT_NAME; } catch { return DEFAULT_NAME; }
}

export function setAssistantName(raw) {
  const reset = raw == null || String(raw).trim() === '' || String(raw).trim().toLowerCase() === DEFAULT_NAME;
  const name = reset ? null : cleanName(raw);
  if (!reset && !name) throw new Error('a name is 1–24 letters, digits, spaces, dots, dashes or apostrophes, starting with a letter or digit');
  saveConfigDoc((doc) => { if (name) doc.name = name; else delete doc.name; });
  return name ?? DEFAULT_NAME;
}

// The first line of every system prompt.
export function identityLine(name = DEFAULT_NAME) {
  if (!name || name === DEFAULT_NAME) return 'You are ox, a featherweight coding agent.';
  return `You are ${name}, a featherweight coding agent (the software is ox; the user named you ${name}). ${name} is your name: when the user says it — at the start, in the middle or at the end of a message — they are talking to you, so answer as ${name}, and call yourself ${name}, never ox.`;
}
