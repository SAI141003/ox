// Learned shortcuts: something ox did once with a model is done the next time
// with none (instant, free). From Atticus (SaarthurR/atticus-mac, its Windows
// port FindlayHi/atticus-windows; MIT): an action the model got right is saved
// as the exact steps it took; the same words later replay them, even said in
// another order or about another app ("put Notes on the left" learned, "put
// Safari on the left" replays it for Safari).
//
// Only plain actions are ever learned or replayed: open an app, a site or a
// file, bring a window forward, a navigation key, a click on a control by its
// name. Never a click that sends, pays or deletes, never typing, never a
// request that says "this" or "that" (it depends on the moment), never a run
// that failed. A step that fails on replay hands the request back to the
// model. Unused for 30 days, a learned one goes; ones you made stay.
//
// "When I say focus mode, close Slack and open Things": saved as your own
// shortcut. Done now, and every time you say "focus mode".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'shortcuts.json');
const DAY = 86_400_000;

// Tools whose calls can be replayed with no model, and what each replay keeps.
export const REPLAYABLE = Object.freeze({
  open_app: ['name'],
  open_url: ['url'],
  open_path: ['path'],
  open_window: ['name'],
  press_key: ['key', 'app', 'times'],
  click: ['element', 'app', 'role', 'double'],
});
const RISKY = /\b(send|pay|payment|buy|purchase|order|checkout|delete|remove|erase|trash|submit|confirm|transfer|post|publish|sign out|log ?out|unsubscribe|install|uninstall|empty)\b/i;
const DEICTIC = /\b(this|that|these|those|it|here|there|them|him|her)\b/i;
const STOP = new Set('a an the to of in on for with and or please can could would you me my i hey ox just now then also quickly quick um uh like'.split(' '));

/** The words that matter, in any order: "hey, can you open the Notes app?" ≈ "open notes app". */
export function gist(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}.\s'-]/gu, ' ').split(/\s+/)
    .map((w) => ({ create: 'make', start: 'make', launch: 'open' })[w] ?? w)
    .filter((w) => w && !STOP.has(w));
}
const keyOf = (text) => gist(text).slice().sort().join(' ');

export function readShortcuts(env = process.env) {
  try { const s = JSON.parse(fs.readFileSync(FILE(env), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function write(all, env = process.env, now = Date.now()) {
  // Learned ones unused for 30 days go; yours stay.
  const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => v.mine || now - (v.used ?? v.at ?? 0) < 30 * DAY));
  fs.mkdirSync(path.dirname(FILE(env)), { recursive: true });
  const tmp = `${FILE(env)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keep, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE(env));   // a cut-off write never empties what was learned
}

/** The replayable steps in a run's tool calls, or null when any call needs the model. */
export function replayableSteps(calls) {
  const steps = [];
  for (const c of calls ?? []) {
    if (['ui_elements', 'screenshot', 'list_dir', 'read_file', 'web_search', 'memory_search', 'todo_write'].includes(c.name)) continue; // looking around
    const keep = REPLAYABLE[c.name];
    if (!keep || c.ok === false) return null;
    const args = Object.fromEntries(keep.filter((k) => c.args?.[k] != null).map((k) => [k, c.args[k]]));
    if (c.name === 'click' && (args.element == null || RISKY.test(String(args.element)))) return null; // by name only, never Send/Pay/Delete
    if (c.name === 'press_key' && /^(return|enter)$/i.test(String(args.key))) return null;
    if (c.name === 'open_url' && !/^https?:\/\//.test(String(args.url))) return null;
    steps.push({ tool: c.name, args });
  }
  return steps.length ? steps : null;
}

/** After a run that worked: keep its steps under what was said. → true (new), false (known), null (not learned). */
export function learnShortcut(text, calls, { reply = '', ok = true, env = process.env, now = Date.now() } = {}) {
  if (env.OX_LEARN === '0' || !ok || DEICTIC.test(String(text)) || /\b(can't|cannot|couldn't|unable|failed|didn't work)\b/i.test(reply)) return null;
  const words = gist(text);
  if (!words.length || words.length > 12) return null;
  const steps = replayableSteps(calls);
  if (!steps) return null;
  const all = readShortcuts(env);
  const key = keyOf(text);
  const known = JSON.stringify(all[key]?.steps) === JSON.stringify(steps);
  all[key] = { said: String(text).slice(0, 200), steps, reply: String(reply).slice(0, 300), at: all[key]?.at ?? now, used: now, ...(all[key]?.mine ? { mine: true } : {}) };
  write(all, env, now);
  return !known;
}

/** Steps with one app swapped for another, only where the old name is a whole argument. */
function swapApp(steps, from, to) {
  let changed = false;
  const out = steps.map((s) => ({ ...s, args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => {
    if (typeof v === 'string' && v.toLowerCase() === from) { changed = true; return [k, to]; }
    return [k, v];
  })) }));
  return changed ? out : null;
}

/**
 * The shortcut for what was said: the same words in any order, or the same words
 * about another app. → { key, steps, said, swapped? } or null.
 */
export function findShortcut(text, { env = process.env } = {}) {
  const all = readShortcuts(env);
  const words = gist(text);
  const key = words.slice().sort().join(' ');
  if (all[key]) return { key, ...all[key] };
  // Another app: one word differs, and that word was an app the steps named.
  for (const [k, v] of Object.entries(all)) {
    const kw = k.split(' ');
    if (kw.length !== words.length) continue;
    const gone = kw.filter((w) => !words.includes(w)), added = words.filter((w) => !kw.includes(w));
    if (gone.length !== 1 || added.length !== 1) continue;
    const steps = swapApp(v.steps, gone[0], added[0]);
    if (steps) return { key: k, ...v, steps, swapped: [gone[0], added[0]] };
  }
  return null;
}

/** "When I say X, do Y" → { phrase, then } or null. */
export function parseNamed(text) {
  const m = /^(?:from now on,?\s+)?when(?:ever)? i say\s+["“']?([^"”',:;]{2,40}?)["”']?\s*(?:[,:;]|\s(?:do|then|you|please)\b)\s*(.{3,300})$/i.exec(String(text ?? '').trim());
  return m ? { phrase: m[1].trim(), then: m[2].trim().replace(/[.!]+$/, '') } : null;
}

/** Save "when I say X" as yours: what to do is kept as the words for it, done the usual way. */
export function saveNamed(phrase, then, { env = process.env, now = Date.now() } = {}) {
  const all = readShortcuts(env);
  all[keyOf(phrase)] = { said: phrase, alias: then, mine: true, at: now, used: now };
  write(all, env, now);
}

/** Mark a shortcut used (its 30-day clock starts again), or drop one that did the wrong thing. */
export function touchShortcut(key, { env = process.env, now = Date.now() } = {}) {
  const all = readShortcuts(env);
  if (all[key]) { all[key].used = now; write(all, env, now); }
}
export function forgetShortcut(textOrKey, { env = process.env } = {}) {
  const all = readShortcuts(env);
  const key = all[textOrKey] ? textOrKey : keyOf(textOrKey);
  if (!all[key]) return false;
  delete all[key];
  write(all, env);
  return true;
}

/**
 * Replay a shortcut's steps through ox's own tools, with no model.
 * runTool(name, args) → { content, isError }. → { ok, said } (ok false: hand it to the model).
 */
export async function replayShortcut(sc, runTool, { env = process.env } = {}) {
  const said = [];
  for (const s of sc.steps ?? []) {
    let r;
    try { r = await runTool(s.tool, s.args); } catch (e) { return { ok: false, said: String(e?.message ?? e) }; }
    if (r?.isError) return { ok: false, said: String(r.content ?? '') };
    said.push(String(r?.content ?? ''));
  }
  touchShortcut(sc.key, { env });
  return { ok: true, said: sc.reply || said.filter(Boolean).join('; ') || 'done' };
}
