// Double Tap: the reply you meant to send, drafted where your cursor is.
//
// With the cursor in a reply box (Mail, Slack, Messages, WhatsApp, a browser),
// double-tap the right ⌘ key (OX Island) or run `ox reply`. ox reads the
// conversation on screen, what it remembers about you, and examples of how
// you write (~/.ox/writingstyle.md), and drafts the reply in your voice. It is
// pasted into the box and left UNSENT: ox never presses Return or Send.
//
// (Sentient OS's "Double Tap" is the idea; this is ox's own build.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STYLE_FILE = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'writingstyle.md');

const STYLE_TEMPLATE = `# How I write

Examples of messages I have sent, in my own words. ox copies the tone, length
and habits (greeting, sign-off, emoji, punctuation), not the content.
Edit freely; ox never rewrites this file once it exists.

## Examples
`;

/** The front app's name (macOS), or null. */
export function frontApp() {
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * The conversation on screen: the text of the front window, read through the
 * accessibility tree (agent-desktop), newest part kept. → string ('' when unreadable).
 */
export async function screenConversation(app, { maxChars = 6000 } = {}) {
  const A = await import('./agent-desktop.js');
  if (!A.available()) return '';
  const r = await A.run(['snapshot', ...(app ? ['--app', app] : []), '--compact', '--max-depth', '25'], { timeoutMs: 20_000 });
  if (!r.ok) return '';
  const seen = new Set(), lines = [];
  const walk = (n) => {
    if (!n) return;
    for (const t of [n.name, n.value, n.description]) {
      const s = String(t ?? '').replace(/\s+/g, ' ').trim();
      if (s.length >= 2 && !seen.has(s)) { seen.add(s); lines.push(s); }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(r.data?.tree);
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Your own sent messages from Messages, newest first, when ox may read them (Full Disk Access). */
export function sentMessages({ limit = 40, home = os.homedir() } = {}) {
  const db = path.join(home, 'Library', 'Messages', 'chat.db');
  if (!fs.existsSync(db)) return [];
  const q = `select text from message where is_from_me = 1 and text is not null and length(text) between 8 and 400 order by date desc limit ${Math.max(1, Math.min(200, limit))};`;
  const r = spawnSync('sqlite3', ['-readonly', db, q], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * The writing-style file: made once, from your sent messages when ox can read
 * them, else as a template for you to fill. Never overwritten after that.
 * → { file, created, examples }
 */
export function ensureStyle({ env = process.env, home = os.homedir() } = {}) {
  const file = STYLE_FILE(env);
  if (fs.existsSync(file)) return { file, created: false, examples: (fs.readFileSync(file, 'utf8').match(/^- /gm) ?? []).length };
  const sent = sentMessages({ home }).filter((t) => !/\b(code|password|pin|otp)\b.*\d{4,}/i.test(t)).slice(0, 25);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, STYLE_TEMPLATE + (sent.length ? sent.map((t) => `- ${t.replace(/\n+/g, ' ')}`).join('\n') : '- (paste a few messages you have sent, one per line, starting with "- ")') + '\n', { mode: 0o600 });
  return { file, created: true, examples: sent.length };
}

export const REPLY_SYSTEM = `You draft the next message the user will send in the conversation shown. Write as the user, in their voice: match the tone, length and habits of their writing examples (greeting, sign-off, emoji, punctuation, language).
Reply to what the other person said last. Use what you know about the user only when it answers something; never invent facts, dates, prices or commitments: where one is needed and unknown, write [ ] for the user to fill.
Output ONLY the message text: no quotes, no "Here's a draft", no explanation.`;

/** The prompt for one draft. */
export function replyPrompt({ conversation, style = '', memory = '', app = '', instruction = '' }) {
  return [
    style && `HOW THE USER WRITES:\n${style.slice(0, 4000)}`,
    memory && `WHAT YOU KNOW ABOUT THE USER:\n${memory.slice(0, 2500)}`,
    `THE CONVERSATION ON SCREEN${app ? ` (${app})` : ''}, newest at the bottom:\n${conversation || '(nothing could be read; draft a short, neutral reply asking what they need)'}`,
    instruction && `WHAT THE USER WANTS THIS REPLY TO DO: ${instruction}`,
    'Draft the user\'s reply now.',
  ].filter(Boolean).join('\n\n');
}

/** A model's answer cleaned to the message alone. */
export function cleanDraft(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^(?:here(?:'s| is) (?:a |the |your )?(?:draft|reply)[^:\n]*:\s*)/i, '');
  t = t.replace(/^["“](.*)["”]$/s, '$1').trim();
  return t;
}

/**
 * Draft a reply. ask({ system, user }) → text. Returns { draft, app, conversationChars }.
 */
export async function draftReply({ ask, app = frontApp(), instruction = '', env = process.env } = {}) {
  const conversation = await screenConversation(app);
  const { file } = ensureStyle({ env });
  const style = fs.readFileSync(file, 'utf8');
  let memory = '';
  try { memory = await (await import('./memory-graph.js')).memoryPromptBlockAsync({ task: conversation.slice(-1500) }); } catch {}
  const draft = cleanDraft(await ask({ system: REPLY_SYSTEM, user: replyPrompt({ conversation, style, memory, app, instruction }) }));
  return { draft, app, conversationChars: conversation.length };
}
