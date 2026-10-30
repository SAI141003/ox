// Your voice on the Mac's keyboard and buttons, with no model in between:
// "open Claude and type create an army image and press send", "type hello",
// "click New Note", "press tab". The words are parsed here; ox-hands
// (desktop/island/Sources/OxHands) types, presses and clicks through macOS
// Accessibility, so it is instant and works offline.
//
// Sending: ox's model never presses Return or a Send button (src/mac-control.js).
// Here the person said it themselves ("press send", "hit enter", "send it"),
// in the same command, so that one press is theirs and is done. Pay, Buy,
// Delete-like buttons are still never pressed.
import { spawnSync } from 'node:child_process';
import { handsPath, findElement, isRisky, parseKey, keyArgs } from './mac-control.js';

const SEND_WORDS = /^(?:(?:press|hit|click|tap|choose|select|push)\s+(?:on\s+)?(?:the\s+)?(?:send|enter|return|submit)(?:\s+(?:button|key))?|send(?:\s+(?:it|that|this|the message))?)$/i;
const KEY_WORDS = /^(?:press|hit)\s+(?:the\s+)?(tab|escape|esc|space|delete|backspace|up|down|left|right|(?:cmd|command|shift|option|ctrl)\s*\+?\s*[a-z]+)(?:\s+key)?$/i;
const CLICK_WORDS = /^(?:click|tap|press|choose|select)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button)?$/i;
const TYPE_WORDS = /^(?:type|type in|enter text)\s+["“']?(.+?)["”']?$/i;

/** One control step from words, or null. */
export function parseControl(text) {
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '');
  let m;
  if (SEND_WORDS.test(t)) return { intent: 'send' };
  if ((m = KEY_WORDS.exec(t))) return { intent: 'key', key: m[1].toLowerCase().replace(/\s+/g, '').replace(/^command/, 'cmd') };
  if ((m = TYPE_WORDS.exec(t))) return { intent: 'type', text: m[1].trim() };
  if ((m = CLICK_WORDS.exec(t)) && m[1].length <= 40) return { intent: 'click', name: m[1].trim() };
  return null;
}

// In "open notes and type buy milk and eggs and press send" the words after
// "type" are the text, up to the next control step: they are set aside before
// the request is split on "and" / "then", and put back after.
const TYPED_SPAN = /\b(type(?: in)?|enter text)\s+(.+?)(?=\s*,?\s+(?:and\s+(?:then\s+)?|then\s+)(?:press|hit|click|tap|choose|select|push|send)\b|$)/i;
export function protectTyped(text) {
  const m = TYPED_SPAN.exec(text);
  if (!m) return { text, restore: (s) => s };
  const token = '\u0001typed\u0001';
  return { text: text.slice(0, m.index) + `${m[1]} ${token}` + text.slice(m.index + m[0].length), restore: (s) => s.replace(token, m[2].replace(/^["“']|["”']$/g, '')) };
}

// ---- doing it ----------------------------------------------------------------

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function hands(args, timeout = 8000) {
  const bin = handsPath();
  if (process.platform !== 'darwin') return { error: `typing and clicking work on macOS only (this is ${process.platform})` };
  if (!bin) return { error: 'ox-hands is not built: run `ox island build`' };
  const r = spawnSync(bin, args.map(String), { encoding: 'utf8', timeout });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { error: (r.stderr || 'ox-hands did not answer').trim() } }
}

/** Bring the app forward and wait until it is (an app just opened takes a moment). */
function front(app) {
  if (!app) return { ok: true };
  for (let i = 0; i < 20; i++) {
    const a = hands(['activate', app]);
    if (a.error && /not an app/.test(a.error)) { wait(250); continue; }
    if (a.error) return { error: a.error };
    if (a.already) return { ok: true, app: a.app };
    wait(150);
  }
  return { ok: true };
}

const NEW_PAGE = /^(notes|textedit|stickies)$/i;
const role = (e, r) => String(e.role ?? '').toLowerCase().includes(r);
const label = (e) => e.name || e.description || e.identifier || '';

/** The app's controls; an Electron app builds its tree on the first ask, so an empty answer is asked again. */
function readControls(app) {
  let list = hands(['list', ...(app ? ['--app', app] : []), '--max', '400']);
  for (let i = 0; i < 3 && !list.error && !(list.elements ?? []).length; i++) { wait(400); list = hands(['list', ...(app ? ['--app', app] : []), '--max', '400']); }
  return list;
}

/** Run one control step. `app` is the app named earlier in the same request, if any. */
export function performControl(it, { app = null, dryRun = false } = {}) {
  const where = app ? ` in ${app}` : '';
  if (dryRun || process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') {
    const what = it.intent === 'type' ? `type "${it.text}"` : it.intent === 'send' ? 'press send' : it.intent === 'key' ? `press ${it.key}` : `click "${it.name}"`;
    return { ok: true, message: `dry run: would ${what}${where}` };
  }
  const f = front(app);
  if (f.error) return { ok: false, message: f.error };
  if (it.intent === 'type') {
    // An app just opened: give its text box a moment, and put the cursor in it.
    // Notes and TextEdit get a new page first, so nothing is typed into an old one.
    wait(it.fresh ? 600 : 100);
    if (it.fresh && NEW_PAGE.test(app ?? '')) { hands(['key', '45', '--mods', 'cmd', '--app', app]); wait(500); }
    // Put the cursor in the text box, unless it is already in one.
    const now = hands(['focused', ...(app ? ['--app', app] : [])]);
    if (!/textarea|textfield|combobox|searchfield/i.test(now.role ?? '')) {
      const list = readControls(app);
      const boxes = (list.elements ?? []).filter((e) => role(e, 'textarea') || role(e, 'textfield') || role(e, 'combobox'));
      const box = boxes.find((e) => /prompt|message|reply|chat|ask|type|search|note/i.test(`${e.name} ${e.description}`)) ?? boxes.sort((a, b) => (b.frame?.[2] ?? 0) * (b.frame?.[3] ?? 0) - (a.frame?.[2] ?? 0) * (a.frame?.[3] ?? 0))[0];
      if (box) { hands(['press', '--app', list.app, '--path', box.path]); wait(150); }
    }
    const before = hands(['focused', ...(app ? ['--app', app] : [])]).value ?? '';
    const r = hands(['type', it.text, '--keys', ...(app ? ['--app', app] : [])], 30_000);
    if (r.error) return { ok: false, message: r.error };
    // Said done only when the words are really there.
    wait(150);
    const after = hands(['focused', ...(app ? ['--app', app] : [])]);
    const landed = String(after.value ?? '').includes(it.text) && String(after.value ?? '') !== before;
    if (!landed && after.role) return { ok: false, message: `typed, but the words did not land in a text box${where}: click where they should go and say it again` };
    return { ok: true, message: `typed "${it.text}"${where}` };
  }
  if (it.intent === 'key') {
    const k = parseKey(it.key);
    if (k.error) return { ok: false, message: k.error };
    const r = hands(['key', ...keyArgs(k), ...(app ? ['--app', app] : [])]);
    return r.error ? { ok: false, message: r.error } : { ok: true, message: `pressed ${it.key}${where}` };
  }
  const list = readControls(app);
  if (list.error) return { ok: false, message: list.error };
  const els = list.elements ?? [];
  if (it.intent === 'send') {
    // The app's own Send button if it has one, else Return (what Send is bound to in a chat box).
    const btn = els.find((e) => role(e, 'button') && /^(send|send message|send prompt|submit|send now)$/i.test(label(e).trim()));
    const r = btn ? hands(['press', '--app', list.app, '--path', btn.path]) : hands(['key', '36', ...(app ? ['--app', app] : [])]);
    return r.error ? { ok: false, message: r.error } : { ok: true, message: `sent${where}` };
  }
  const target = findElement(els, it.name);
  if (!target) return { ok: false, message: `no "${it.name}" in ${list.app}` };
  if (isRisky(target) && !/^(send|send message|submit)$/i.test(label(target))) return { ok: false, message: `ox does not press "${label(target)}": that pays or deletes. It is left for you.` };
  const r = hands(['press', '--app', list.app, '--path', target.path]);
  return r.error ? { ok: false, message: r.error } : { ok: true, message: `clicked "${label(target)}" in ${list.app}` };
}
