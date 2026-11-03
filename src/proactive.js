// Proactive cards: loose ends found overnight, each with the next step
// prepared, waiting for you in the morning. Nothing is sent or done: a card
// is a suggestion you open, change and act on yourself.
//
// What ox looks at, read-only and on this Mac: Calendar (next 7 days) and
// Mail (unread or flagged, last 3 days) when those apps are open, Messages
// conversations waiting on your reply (Full Disk Access), ox tasks waiting
// on you, and upcoming dates ox remembers. A model turns them into at most a
// handful of cards. (Sentient OS's "proactive intelligence" is the idea; this
// is ox's own build.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DAY = 86_400_000;
export const CARDS_FILE = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'proactive', 'cards.json');
const running = (app) => process.platform === 'darwin' && spawnSync('pgrep', ['-x', app]).status === 0;
const osa = (script) => spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 });

/** Calendar events in the next `days` (only when Calendar is open). */
export function upcomingEvents({ days = 7 } = {}) {
  if (!running('Calendar')) return [];
  const r = osa(`set out to ""\ntell application "Calendar"\nset d0 to current date\nset d1 to d0 + ${days} * days\nrepeat with c in calendars\ntry\nrepeat with e in (every event of c whose start date >= d0 and start date < d1)\nset out to out & (summary of e) & "\t" & ((start date of e) as «class isot» as string) & "\n"\nend repeat\nend try\nend repeat\nend tell\nreturn out`);
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).slice(0, 30).map((l) => { const [title, at] = l.split('\t'); return { source: 'calendar', text: `${title} — ${at}` }; });
}

/** Unread or flagged mail from the last few days (only when Mail is open): sender and subject only. */
export function mailLooseEnds({ days = 3 } = {}) {
  if (!running('Mail')) return [];
  const r = osa(`set out to ""\ntell application "Mail"\nset cutoff to (current date) - ${days} * days\nrepeat with m in (messages of inbox whose date received > cutoff and (read status is false or flagged status is true))\nset out to out & (sender of m) & "\t" & (subject of m) & "\n"\nend repeat\nend tell\nreturn out`);
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).slice(0, 25).map((l) => { const [from, subject] = l.split('\t'); return { source: 'mail', text: `${String(from).replace(/<.*>/, '').trim()}: ${subject}` }; });
}

/** Messages conversations whose last word is theirs and a day old (needs Full Disk Access). */
export function messagesWaiting({ home = os.homedir(), olderThanHours = 20, now = Date.now() } = {}) {
  const db = path.join(home, 'Library', 'Messages', 'chat.db');
  if (!fs.existsSync(db)) return [];
  // Apple's epoch is 2001-01-01, in nanoseconds.
  const cutoff = Math.floor(((now - olderThanHours * 3600_000) / 1000 - 978307200) * 1e9);
  const recent = Math.floor(((now - 7 * DAY) / 1000 - 978307200) * 1e9);
  const q = `select coalesce(h.id, ''), m.text from message m join chat_message_join cm on cm.message_id = m.rowid
    join (select chat_id, max(message_date) d from chat_message_join group by chat_id) last on last.chat_id = cm.chat_id and last.d = cm.message_date
    left join handle h on h.rowid = m.handle_id
    where m.is_from_me = 0 and m.text is not null and m.date < ${cutoff} and m.date > ${recent} order by m.date desc limit 15;`;
  const r = spawnSync('sqlite3', ['-readonly', '-separator', '\t', db, q], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [who, text] = l.split('\t'); return { source: 'messages', text: `${who} is waiting on your reply: "${String(text).slice(0, 160)}"` }; });
}

/** Upcoming dates ox remembers (events in the memory graph within two weeks). */
export async function rememberedDates({ now = Date.now() } = {}) {
  try {
    const M = await import('./memory-graph.js');
    return M.load(M.memoryFile('user')).filter((m) => m.state === 'active' && m.latest !== false && m.kind === 'event' && m.validFrom >= now - DAY && m.validFrom <= now + 14 * DAY)
      .map((m) => ({ source: 'memory', text: `${m.text} (${M.fmtDay(m.validFrom)})` }));
  } catch { return []; }
}

/** Your ox tasks waiting on you: finished work to review, or blocked. */
export async function tasksWaiting() {
  try {
    const T = await import('./tasks.js');
    return (T.listTasks?.() ?? []).filter((t) => t.status === 'in_review' || t.status === 'blocked').slice(0, 10)
      .map((t) => ({ source: 'tasks', text: `${t.status === 'in_review' ? 'waiting for your review' : 'blocked'}: ${t.title}` }));
  } catch { return []; }
}

export async function gather(opts = {}) {
  return [...upcomingEvents(), ...mailLooseEnds(), ...messagesWaiting(opts), ...await rememberedDates(opts), ...await tasksWaiting()];
}

export const CARDS_SYSTEM = `You prepare a person's morning. From the loose ends listed (their calendar, mail, messages waiting on them, dates they mentioned, tasks waiting on them), pick at most 5 that most need them today: a reply they owe, a deadline or renewal coming, an event to prepare for.
For each, write a card: a short title, one line on why it matters now, and the prepared next step (a draft reply in a friendly first-person voice, a checklist, or what to bring). Never claim anything was sent or done. Use only what the items say; write [ ] where a detail is unknown.
Answer with JSON only: [{"title": "...", "why": "...", "prepared": "...", "source": "calendar|mail|messages|memory|tasks"}]. If nothing needs them, answer [].`;

export function parseCards(text) {
  const m = String(text ?? '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]) ?? []).filter((c) => c && c.title && c.prepared).slice(0, 5)
      .map((c) => ({ title: String(c.title).slice(0, 120), why: String(c.why ?? '').slice(0, 240), prepared: String(c.prepared).slice(0, 2000), source: String(c.source ?? '') }));
  } catch { return []; }
}

/**
 * Find loose ends and prepare the cards. ask({ system, user }) → text.
 * → { cards, items } (also saved to ~/.ox/proactive/cards.json)
 */
export async function prepareCards({ ask, items = null, env = process.env, now = Date.now() } = {}) {
  const found = items ?? await gather({ now });
  let cards = [];
  if (found.length) {
    const user = `Today is ${new Date(now).toDateString()}.\n\n${found.map((x, i) => `${i + 1}. [${x.source}] ${x.text}`).join('\n')}`;
    cards = parseCards(await ask({ system: CARDS_SYSTEM, user }));
  }
  const file = CARDS_FILE(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ at: now, cards }, null, 2), { mode: 0o600 });
  return { cards, items: found };
}

export function readCards({ env = process.env } = {}) {
  try { return JSON.parse(fs.readFileSync(CARDS_FILE(env), 'utf8')); } catch { return { at: null, cards: [] }; }
}

/** The nightly run: once a day, after 2 AM, with the model ox is set to use. → result or null. */
export async function prepareTonight({ env = process.env, now = Date.now() } = {}) {
  if (env.OX_PROACTIVE === '0' || env.NODE_TEST_CONTEXT) return null;
  const last = readCards({ env }).at ?? 0;
  const d = new Date(now);
  if (d.getHours() < 2 || now - last < 20 * 3600_000) return null;
  const { loadConfig } = await import('./config.js');
  const { resolveBot } = await import('./bots.js');
  const { quickText } = await import('./quick-text.js');
  const config = loadConfig();
  const spec = await (await import('./working-model.js')).workingModelSpec(config, { say: () => {} });
  const target = resolveBot(spec, config);
  return prepareCards({ env, now, ask: async ({ system, user }) => (await quickText(target, { system, user, maxTokens: 1500 })).text });
}
