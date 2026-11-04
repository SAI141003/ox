// Learning what the rules miss, in the background (Mem0's extraction step,
// Letta's sleep-time agent), with the user's own words kept as evidence
// (Supermemory keeps the source chunk attached; arXiv 2601.00821 measured
// verbatim text beating extracted facts by 16-22 points, so extraction adds to
// the original words, never replaces them).
//
// 1. learnFromMessages (memory-graph.js) catches the plain shapes at once
//    ("remember that…", "I prefer…"). Every other first-person statement the
//    user makes ("I teach chemistry in Calgary", "we switched to MySQL") goes,
//    word for word, into ~/.ox/memory/inbox.jsonl.
// 2. Off the request path (the sleep cycle, or `ox memory learn`), a model reads
//    the inbox and returns the lasting facts in it; task requests and one-off
//    chatter are dropped. Each goes through remember(), so a change replaces
//    the old fact (moved to Edmonton closes Calgary) instead of piling up.
// 3. The sentence it came from stays on the memory as `evidence`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryFile, remember } from './memory-graph.js';
import { screenPersistText } from './memory.js';

const inboxFile = (home = os.homedir()) => path.join(path.dirname(memoryFile('user', { home })), 'inbox.jsonl');

// A statement about the user or their world, not a question or a request to do something now.
const FIRST_PERSON = /\b(i|i'm|im|i've|we|we're|we've|my|our)\b/i;
const REQUEST = /^(?:can|could|would|will) (?:you|u)\b|^(?:please\s+)?(?:clear|clean|install|update|fix|make|build|write|create|add|remove|delete|run|open|show|tell|find|check|explain|help|give|send|update|change|refactor|deploy|install)\b/i;
// Asking for something anywhere in the sentence is a request, however it starts ("In the Calculator on my screen, do it for me").
const ASKING = /\b(?:do (?:it|this|that) for me|for me[:,.]|tell me|show me|help me|work out|figure out|on my screen|in my (?:mac|computer|laptop|browser))\b/i;
export function worthKeeping(sentence) {
  const s = String(sentence ?? '').trim();
  if (s.length < 12 || s.length > 300 || /\?\s*$/.test(s)) return false;
  if (!FIRST_PERSON.test(s) || REQUEST.test(s) || ASKING.test(s)) return false;
  return !screenPersistText(s, 'memory', 'ox memory');
}

/** Put statements the rules did not catch in the inbox, word for word; → the ones kept. */
export function queueForExtraction(sentences, { home = os.homedir(), ref = Date.now() } = {}) {
  const kept = sentences.filter(worthKeeping);
  if (!kept.length) return [];
  const f = inboxFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${kept.map((text) => JSON.stringify({ text, at: ref })).join('\n')}\n`, { mode: 0o600 });
  return kept;
}

export function readInbox({ home = os.homedir() } = {}) {
  try { return fs.readFileSync(inboxFile(home), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

export const EXTRACT_SYSTEM = `You keep a person's long-term memory. From the numbered statements they made, return ONLY lasting facts worth remembering about them or their work: who they are, people and pets in their life, where they live and work, tools and stack they use, preferences and rules for how to work with them, health limits, routines, upcoming dates.
Skip: requests for a task right now, opinions about one answer, small talk, anything about a specific bug or file, secrets (passwords, keys, card numbers).
Write each fact as one short first-person statement that keeps the person's own names, numbers and dates exactly; a change ("left X, now at Y", "moved to Z") becomes the new state.
Use only what the statements say. Never add a fact they do not contain.
Answer with JSON only: [{"n": <statement number>, "fact": "..."}]. If nothing is worth keeping, answer [].`;

/** Parse the model's answer leniently: a JSON array somewhere in the text. */
export function parseFacts(text, count) {
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  return (Array.isArray(arr) ? arr : [])
    .map((x) => ({ n: Number(x?.n), fact: String(x?.fact ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.fact.length >= 6 && x.fact.length <= 300 && Number.isInteger(x.n) && x.n >= 1 && x.n <= count);
}

/**
 * Read the inbox with a model and remember what lasts. ask({ system, user }) → text.
 * → { read, learned: [{ op, text }], left }
 */
export async function extractInbox({ ask, home = os.homedir(), batch = 40, now = Date.now() } = {}) {
  const items = readInbox({ home });
  if (!items.length) return { read: 0, learned: [], left: 0 };
  const take = items.slice(0, batch);
  const user = take.map((x, i) => `${i + 1}. (${new Date(x.at).toISOString().slice(0, 10)}) ${x.text}`).join('\n');
  const answer = await ask({ system: EXTRACT_SYSTEM, user });
  const file = memoryFile('user', { home });
  const learned = [];
  // Oldest first, so a later change ("moved to Edmonton") replaces an earlier one.
  for (const { n, fact } of parseFacts(answer, take.length).sort((a, b) => take[a.n - 1].at - take[b.n - 1].at)) {
    const src = take[n - 1];
    const r = remember(fact, { file, ref: src.at, source: { type: 'extracted', evidence: src.text.slice(0, 300) } });
    if (r.op !== 'refused' && r.op !== 'noop') learned.push({ op: r.op, text: r.memory.text });
  }
  // What was read leaves the inbox (a model that failed to answer leaves it for next time).
  if (answer != null) {
    const rest = items.slice(take.length);
    fs.writeFileSync(inboxFile(home), rest.length ? `${rest.map((x) => JSON.stringify(x)).join('\n')}\n` : '', { mode: 0o600 });
  }
  return { read: take.length, learned, left: Math.max(0, items.length - take.length) };
}

/**
 * The background learning pass: the inbox read by a model, then every memory
 * given its meaning vector. A local model when Ollama has one (private, free),
 * else the model ox is set to use. → { read, learned, embedded, model } or null.
 */
export async function learnInBackground({ home = os.homedir(), env = process.env } = {}) {
  if (env.OX_MEMORY === '0' || env.OX_LEARN === '0') return null;
  let spec = null;
  try {
    const tags = await (await fetch(`${env.OLLAMA_HOST || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(1500) })).json();
    const chat = (tags.models ?? []).map((m) => m.name).filter((n) => !/embed|minilm|bge|e5|gte|nomic/i.test(n) && !/(\d{2,3})m\b/i.test(n));
    if (chat[0]) spec = `ox-ollama:${chat[0]}`;
  } catch {}
  const { loadConfig } = await import('./config.js');
  const { resolveBot } = await import('./bots.js');
  const { quickText } = await import('./quick-text.js');
  const config = loadConfig();
  // Your model only if you said so (memoryLearnBot). Running this on a plan costs thousands of
  // tokens a pass for a few facts, unasked. Without one, what you said waits in the inbox.
  if (!spec && config.memoryLearnBot) spec = String(config.memoryLearnBot);
  let out = { read: 0, learned: [], left: 0 };
  if (spec && readInbox({ home }).length) {
    const target = resolveBot(spec, config);
    out = await extractInbox({ home, ask: async ({ system, user }) => (await quickText(target, { system, user, maxTokens: 900 })).text });
  }
  let embedded = 0;
  try { embedded = await (await import('./memory-semantic.js')).embedMissing(memoryFile('user', { home })); } catch {}
  return { ...out, embedded, model: spec };
}
