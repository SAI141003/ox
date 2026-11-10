// What a session's earlier requests looked like, so the next one repeats them
// byte for byte. A provider's prompt cache is a prefix match: one changed
// character in an old message and everything after it is paid for again.
//
// Two things used to change old messages between a session's turns:
//   * the memory note. It rode on the newest message only, so the message it
//     was on last turn no longer had it, and the cache missed from there on,
//     every turn, for anyone ox remembers something about.
//   * hidden tool output. What was hidden was worked out afresh from the whole
//     conversation each turn, so the set drifted.
// Both are now remembered per session and put back the same way. Nothing here
// is written to disk: after a restart a session pays for one cache write.
import { createHash } from 'node:crypto';

const SESSIONS = new Map();
const MAX_SESSIONS = 200;
const MAX_NOTES = 400;
// The shortest cache any provider keeps (Anthropic's default; OpenAI's in-memory one is 5-10 minutes).
export const CACHE_TTL_MS = 5 * 60_000;

const blank = () => ({ notes: new Map(), hidden: new Map(), lastAt: 0 });

/** The session's state (made on first use); without an id, a state for this run only. */
export function sessionCache(sid) {
  if (!sid) return blank();
  let s = SESSIONS.get(sid);
  SESSIONS.delete(sid);
  if (!s) s = blank();
  SESSIONS.set(sid, s);
  if (SESSIONS.size > MAX_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  return s;
}
export const forgetSessionCache = (sid) => SESSIONS.delete(sid);

/** True when the last request was long enough ago that the provider has dropped the conversation. */
export function cacheIsCold(state, now = Date.now(), ttlMs = CACHE_TTL_MS) {
  return !!state?.lastAt && now - state.lastAt > ttlMs;
}

const textOf = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '');
const keyOf = (n, m) => `${n}:${createHash('sha1').update(textOf(m)).digest('hex').slice(0, 16)}`;
const prepend = (m, note) => (Array.isArray(m.content)
  ? { ...m, content: [{ type: 'text', text: note }, ...m.content] }
  : { ...m, content: note + String(m.content ?? '') });
const isBullet = (l) => /^\s*[-*] /.test(l);

/**
 * The part of a memory block the conversation has not been shown yet. The
 * profile is the same on every message; said once, it is not sent again, and a
 * later message carries only what is new for it (often nothing).
 */
export function freshPart(recalled, seen = '') {
  const r = String(recalled ?? '').trim();
  if (!r || !seen) return r;
  return r.split(/\n{2,}/).map((par) => {
    if (seen.includes(par)) return '';
    const lines = par.split('\n');
    if (!lines.some(isBullet)) return par;
    const keep = lines.filter((l) => !isBullet(l) || !seen.includes(`${l.trim()}\n`));
    return keep.some(isBullet) ? keep.join('\n') : '';
  }).filter(Boolean).join('\n\n');
}

/**
 * history → history with each user message carrying the memory note it carried
 * before, and the newest one carrying what is new. `state` is sessionCache(id).
 */
export function withMemoryNotes(history, recalled, state = null) {
  const out = history.slice();
  const users = [];
  out.forEach((m, i) => { if (m?.role === 'user') users.push(i); });
  if (!users.length) return out;
  const newest = users.at(-1);
  let seen = '';
  users.forEach((i, n) => {
    const m = out[i];
    const raw = textOf(m);
    if (raw.includes('<recalled-memory>')) { seen += `${raw}\n`; return; } // the client kept it
    const key = keyOf(n, m);
    let note = state?.notes.get(key);
    if (note === undefined && i === newest) {
      const fresh = freshPart(recalled, seen);
      note = fresh ? `<recalled-memory>\n${fresh}\n</recalled-memory>\n\n` : '';
      if (state) {
        state.notes.set(key, note);
        if (state.notes.size > MAX_NOTES) state.notes.delete(state.notes.keys().next().value);
      }
    }
    if (note) { out[i] = prepend(m, note); seen += note; }
    seen += `${raw}\n`;
  });
  return out;
}
