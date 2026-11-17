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

const SEND_WORDS = /^(?:(?:press|hit|click|tap|choose|select|push)\s+(?:on\s+)?(?:the\s+)?(?:send|enter|return|submit)(?:\s+(?:button|key))?|send(?:\s+(?:it|that|this|the message))?|enter|return|submit(?:\s+(?:it|that|this))?)$/i;
const KEY_WORDS = /^(?:press|hit|push)\s+(?:the\s+)?(.+)$/i;
// What follows the typed words when more is asked in the same breath ("type hello and press send").
const AFTER_TYPED = /\s*,?\s+(?:and\s+(?:then\s+)?|then\s+)(?:press|hit|click|tap|choose|select|push|send)\b/i;
const MOD_WORD = { command: 'cmd', cmd: 'cmd', '⌘': 'cmd', control: 'ctrl', ctrl: 'ctrl', option: 'option', alt: 'option', shift: 'shift' };
const KEY_NAME = { tab: 'tab', escape: 'escape', esc: 'escape', space: 'space', spacebar: 'space', delete: 'delete', backspace: 'backspace', up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', return: 'return', enter: 'return' };

/**
 * A key as it is said ("command shift t", "shift tab", "cmd+n", "the escape key",
 * "page down") → "cmd+shift+t", or null when the words are not a key (a button's name).
 */
export function spokenKey(words) {
  const tokens = String(words ?? '').toLowerCase().replace(/\b(?:arrow|keys?|bar)\b/g, ' ').replace(/\bpage\s+(up|down)\b/g, 'page$1').split(/[\s+]+|-(?=[a-z])/).filter(Boolean);
  const mods = [];
  while (tokens.length > 1 && MOD_WORD[tokens[0]]) { const m = MOD_WORD[tokens.shift()]; if (!mods.includes(m)) mods.push(m); }
  if (tokens.length !== 1) return null;
  const k = tokens[0];
  if (KEY_NAME[k]) return k === 'return' || k === 'enter' ? (mods.length ? [...mods, 'return'].join('+') : null) : [...mods, KEY_NAME[k]].join('+');
  // A letter or digit is a key only with a modifier ("command s"); alone it is typing.
  if (mods.length && /^[a-z0-9]$/.test(k)) return [...mods, k].join('+');
  return null;
}

// Editing as it is said, each one a shortcut ox may press with nobody asked.
const EDIT_WORDS = [
  [/^select (?:all|everything)$/i, 'cmd+a'],
  [/^copy(?: (?:that|this|it|the selection))?$/i, 'cmd+c'],
  [/^paste(?: (?:that|this|it|here))?$/i, 'cmd+v'],
  [/^cut(?: (?:that|this|it|the selection))?$/i, 'cmd+x'],
  [/^undo(?: (?:that|this|it))?$/i, 'cmd+z'],
  [/^(?:scroll|page) down$/i, 'pagedown'],
  [/^(?:scroll|page) up$/i, 'pageup'],
  [/^(?:scroll|go) to (?:the )?top$/i, 'home'],
  [/^(?:scroll|go) to (?:the )?(?:bottom|end)$/i, 'end'],
  [/^(?:open |make )?(?:a )?new (?:window|document|file)$/i, 'cmd+n'],
  [/^(?:delete|erase)(?: (?:that|this|it|the selection))?$/i, 'delete'],
  [/^scratch that$/i, 'cmd+z'],
];

// Moving around an app, as it is said: "new chat", "close tab", "go back",
// "refresh". Each is one shortcut, pressed because the person said it, the same
// way "press send" is theirs. They are named here, one by one, and kept apart
// from the keys a model may press (src/mac-control.js: ⌘ with A C F K L N T V X Z
// only). Nothing in this list quits an app, logs out or deletes a file.
const WINDOW_WORDS = [
  [/^(?:(?:start|open|make|create|begin)\s+)?(?:a\s+)?new\s+(?:chat|conversation|session|thread|prompt)$/i, 'new-chat'],
  [/^close (?:this |the |that )?tab$/i, 'close-tab'],
  [/^close (?:this |the |that )?window$/i, 'close-window'],
  [/^next tab$/i, 'next-tab'],
  [/^(?:previous|prev|last) tab$/i, 'prev-tab'],
  [/^(?:go )?back$/i, 'back'],
  [/^(?:go )?forward$/i, 'forward'],
  [/^(?:refresh|reload)(?: (?:the |this )?page)?$/i, 'reload'],
  [/^zoom in$/i, 'zoom-in'],
  [/^zoom out$/i, 'zoom-out'],
  [/^(?:new|next) line$/i, 'new-line'],
  [/^minimi[sz]e(?: (?:this|the|that))?(?: window)?$/i, 'minimize'],
  [/^(?:(?:enter|go|toggle|exit|leave) )?full ?screen$/i, 'fullscreen'],
  [/^hide(?: (?:this|the|that))?(?: (?:app|window))?$/i, 'hide'],
  [/^(?:switch|change) (?:apps?|windows?)$|^(?:last|previous) app$/i, 'switch-app'],
  [/^save(?: (?:it|this|that|the file|the document))?$/i, 'save'],
  [/^clear(?: (?:it|that|this|the text|the box|the field|everything|all))?$|^(?:delete|erase) (?:everything|all|it all|the text)$/i, 'clear'],
];
// action → the keys: [virtual key code, modifiers]. Two entries are pressed one after the other.
const WINDOW_KEYS = {
  'new-chat': [[45, 'cmd']], 'close-tab': [[13, 'cmd']], 'close-window': [[13, 'cmd']],
  'next-tab': [[48, 'ctrl']], 'prev-tab': [[48, 'ctrl,shift']],
  back: [[33, 'cmd']], forward: [[30, 'cmd']], reload: [[15, 'cmd']],
  'zoom-in': [[24, 'cmd']], 'zoom-out': [[27, 'cmd']], 'new-line': [[36, 'shift']],
  minimize: [[46, 'cmd']], fullscreen: [[3, 'cmd,ctrl']], hide: [[4, 'cmd']], 'switch-app': [[48, 'cmd']],
  save: [[1, 'cmd']], clear: [[0, 'cmd'], [51, '']],
};
const WINDOW_SAID = {
  'new-chat': 'started a new chat', 'close-tab': 'closed the tab', 'close-window': 'closed the window', 'next-tab': 'next tab', 'prev-tab': 'previous tab',
  back: 'went back', forward: 'went forward', reload: 'reloaded', 'zoom-in': 'zoomed in', 'zoom-out': 'zoomed out', 'new-line': 'new line',
  minimize: 'minimized', fullscreen: 'full screen', hide: 'hidden', 'switch-app': 'switched app', save: 'saved', clear: 'cleared',
};
// A name with "and" or "then" in it is two steps ("select all and delete"), not one button.
const CLICK_WORDS = /^(?:click|tap|press|choose|select)\s+(?:on\s+)?(?:the\s+)?((?:(?!\s(?:and|then)\s).)+?)(?:\s+button)?$/i;
const TYPE_WORDS = /^(?:type|type in|enter text)[,:]?\s+["“']?(.+?)["”']?$/i;

/** One control step from words, or null. */
export function parseControl(text) {
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '');
  let m;
  if (SEND_WORDS.test(t)) return { intent: 'send' };
  if ((m = KEY_WORDS.exec(t))) { const key = spokenKey(m[1]); if (key) return { intent: 'key', key }; }
  for (const [re, key] of EDIT_WORDS) if (re.test(t)) return { intent: 'key', key };
  for (const [re, action] of WINDOW_WORDS) if (re.test(t)) return { intent: 'window', action };
  // "type hello and press send" is two steps: left to the chain, which keeps the words apart.
  // Voice control hands over a sentence that is no command as "dictate …": typed where
  // the cursor already is, and nowhere else (ox does not go looking for a box to put it in).
  if ((m = /^dictate[,:]?\s+(.+)$/i.exec(t))) return { intent: 'type', text: m[1].trim(), focusedOnly: true };
  if ((m = TYPE_WORDS.exec(t))) return AFTER_TYPED.test(m[1]) ? null : { intent: 'type', text: m[1].trim() };
  if ((m = CLICK_WORDS.exec(t)) && m[1].length <= 40) return { intent: 'click', name: m[1].trim() };
  return null;
}

// In "open notes and type buy milk and eggs and press send" the words after
// "type" are the text, up to the next control step: they are set aside before
// the request is split on "and" / "then", and put back after.
const TYPED_SPAN = /\b(type(?: in)?|enter text)[,:]?\s+(.+?)(?=\s*,?\s+(?:and\s+(?:then\s+)?|then\s+)(?:press|hit|click|tap|choose|select|push|send)\b|$)/i;
const SEARCH_SPAN = /\b(search(?: the web| google| online)?(?: for)?|google|look up)\s+(.+)$/i;
export function protectTyped(text, { search = false } = {}) {
  const m = TYPED_SPAN.exec(text) ?? (search ? SEARCH_SPAN.exec(text) : null);
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
    if (a.already) { wait(120); const b = hands(['activate', app]); if (b.already) return { ok: true, app: a.app }; }
    wait(150);
  }
  return { ok: true };
}

const NEW_PAGE = /^(notes|textedit|stickies|pages|microsoft word)$/i;
const role = (e, r) => String(e.role ?? '').toLowerCase().includes(r);
const label = (e) => e.name || e.description || e.identifier || '';

/** The app's controls; an Electron app builds its tree on the first ask, so an empty answer is asked again. */
function readControls(app) {
  let list = hands(['list', ...(app ? ['--app', app] : []), '--max', '400']);
  for (let i = 0; i < 3 && !list.error && !(list.elements ?? []).length; i++) { wait(400); list = hands(['list', ...(app ? ['--app', app] : []), '--max', '400']); }
  return list;
}

/** The browser in front (or the one named): a new tab when asked, the address bar, the words, Return. */
function browserStep(it, app) {
  const BROWSER = /chrome|safari|arc|firefox|brave|edge|opera/i;
  const inFront = hands(['focused']).app;
  // The browser named, else the one in front, else Chrome.
  const target = app ?? (inFront && BROWSER.test(inFront) ? inFront : 'Google Chrome');
  const f = front(target);
  if (f.error) return { ok: false, message: f.error };
  wait(250);
  if (it.newTab) { const t = hands(['key', '17', '--mods', 'cmd', '--app', target]); if (t.error) return { ok: false, message: t.error }; wait(350); }
  if (!it.query) return { ok: true, message: `opened a new tab in ${target}` };
  // The address bar: pointed at and clicked when it can be found (you see where it goes), else ⌘L.
  const list = readControls(target);
  const bar = (list.elements ?? []).find((e) => (role(e, 'textfield') || role(e, 'combobox')) && /address|search|url/i.test(`${e.name} ${e.description}`));
  if (bar) hands(['press', '--app', list.app, '--path', bar.path]); else hands(['key', '37', '--mods', 'cmd', '--app', target]);
  wait(150);
  // Typed, then checked: a browser that was just opened can still be raising its
  // window and take the focus away, so the words are put in again if they are not there.
  let typedOk = false;
  for (let attempt = 0; attempt < 3 && !typedOk; attempt++) {
    if (attempt) { front(target); wait(300); hands(['key', '37', '--mods', 'cmd', '--app', target]); wait(150); }
    hands(['key', '0', '--mods', 'cmd', '--app', target]);
    const r = hands(['type', it.query, '--keys', '--app', target], 30_000);
    if (r.error) return { ok: false, message: r.error };
    wait(150);
    const now = hands(['focused', '--app', target]);
    typedOk = String(now.value ?? '').includes(it.query.slice(0, 40));
  }
  if (!typedOk) return { ok: false, message: `${target} did not take the words in its address bar` };
  // Return in the address bar runs the search (it sends nothing to anyone).
  const go = hands(['key', '36', '--app', target]);
  return go.error ? { ok: false, message: go.error } : { ok: true, message: `searched "${it.query}" in ${target}` };
}

/** "new chat", "close tab", "go back"…: one named shortcut in the app in front (or the one named). */
function windowStep(it, app) {
  const keys = WINDOW_KEYS[it.action];
  if (!keys) return { ok: false, message: `ox does not know "${it.action}"` };
  const target = app ?? hands(['focused']).app ?? null;
  const inApp = target ? ['--app', target] : [];
  const where = target ? ` in ${target}` : '';
  const browser = /chrome|safari|arc|firefox|brave|edge|opera/i.test(target ?? '');
  if (it.action === 'new-chat') {
    // The app's own "New chat" button when it shows one (a chat site in a browser has
    // no shortcut every browser agrees on); else ⌘N, which is New chat in Claude, ChatGPT and Codex.
    const list = readControls(target);
    const btn = (list.elements ?? []).find((e) => (role(e, 'button') || role(e, 'link') || role(e, 'menuitem')) && /^(?:new|start(?: a)?(?: new)?) (?:chat|conversation|session|thread|task)$/i.test(label(e).trim()));
    if (btn) { const r = hands(['press', '--app', list.app ?? target, '--path', btn.path]); return r.error ? { ok: false, message: r.error } : { ok: true, message: `started a new chat${where}` }; }
    if (browser) return { ok: false, message: `no "New chat" button on this page${where}` };
  }
  // A browser keeps its tabs in one window: closing the window there is ⌘⇧W.
  const press = it.action === 'close-window' && browser ? [[13, 'cmd,shift']] : keys;
  for (const [code, mods] of press) {
    const r = hands(['key', String(code), ...(mods ? ['--mods', mods] : []), ...inApp]);
    if (r.error) return { ok: false, message: r.error };
    if (press.length > 1) wait(80);
  }
  return { ok: true, message: `${WINDOW_SAID[it.action] ?? it.action}${where}` };
}

/** Run one control step. `app` is the app named earlier in the same request, if any. */
/** Open or bring forward an app through Accessibility. `open -a` on a running
 *  app with several windows re-raises them after it returns, and keys typed
 *  next were lost (Chrome's address bar stayed empty). Null when ox-hands is not here. */
export function activateApp(name) {
  if (process.platform !== 'darwin' || process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1' || !handsPath()) return null;
  const a = hands(['activate', name]);
  // Opening an app needs no Accessibility: without it (a rebuild can take it away), `open -a` does it.
  if (a.error) return /not an app/.test(a.error) || a.access === false || /Accessibility/.test(a.error) ? null : { ok: false, message: a.error };
  return { ok: true, message: `opened ${a.app ?? name}` };
}

/** Is a browser the app in front? (A search said with no browser named goes there.) */
export function browserInFront() {
  if (process.platform !== 'darwin' || process.env.NODE_TEST_CONTEXT) return false;
  return /chrome|safari|arc|firefox|brave|edge|opera/i.test(hands(['focused']).app ?? '');
}

/** Why ox will not press this key, or null. Said before anything is done, a dry run included. */
export function keyRefusal(it) {
  return it?.intent === 'key' ? parseKey(it.key).error ?? null : null;
}

export function performControl(it, { app = null, dryRun = false } = {}) {
  const where = app ? ` in ${app}` : '';
  const no = keyRefusal(it);
  if (no) return { ok: false, message: no };
  if (dryRun || process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') {
    const what = it.intent === 'type' ? `type "${it.text}"` : it.intent === 'send' ? 'press send' : it.intent === 'window' ? it.action.replace('-', ' ') : it.intent === 'key' ? `press ${it.key}` : it.intent === 'browser' ? (it.query ? `search "${it.query}" in the browser${it.newTab ? ' (new tab)' : ''}` : 'open a new tab') : `click "${it.name}"`;
    return { ok: true, message: `dry run: would ${what}${where}` };
  }
  if (it.intent === 'browser') return browserStep(it, app);
  const f = front(app);
  if (f.error) return { ok: false, message: f.error };
  if (it.intent === 'type') {
    // An app just opened: give its text box a moment, and put the cursor in it.
    // Notes and TextEdit get a new page first, so nothing is typed into an old one.
    wait(it.fresh ? 600 : 100);
    if (it.fresh && NEW_PAGE.test(app ?? '')) {
      // TextEdit (and other document apps) can open on their Open dialog: its own
      // "New Document" button, else ⌘N. Typing into the dialog lost the words.
      const panel = readControls(app);
      const newDoc = (panel.elements ?? []).find((e) => role(e, 'button') && /^new document$/i.test(String(e.name || e.description || '').trim()));
      if (newDoc) hands(['press', '--app', panel.app ?? app, '--path', newDoc.path]);
      else hands(['key', '45', '--mods', 'cmd', '--app', app]);
      wait(600);
    }
    // Put the cursor in the text box, unless it is already in one.
    const now = hands(['focused', ...(app ? ['--app', app] : [])]);
    // Claude, ChatGPT and other Electron apps do not say where their cursor is (an empty
    // role): the words are typed there. A named control that is not a text box (a button,
    // a web page with no field chosen) is refused, since keys typed at it can be shortcuts.
    if (it.focusedOnly && now.role && !/textarea|textfield|combobox|searchfield/i.test(now.role)) return { ok: false, message: 'the cursor is not in a text box: click where the words should go' };
    if (!it.focusedOnly && !/textarea|textfield|combobox|searchfield/i.test(now.role ?? '')) {
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
    // Compared loosely: apps autocorrect ("hello" → "Hello", smart quotes, spacing).
    // An app that does not show its text box's value (ChatGPT, Electron) cannot be
    // checked: then only a box whose text did not change at all counts as a miss.
    const norm = (v) => String(v ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
    const readable = after.value != null && String(after.value) !== '';
    const landed = !readable ? String(before) === '' : norm(after.value).includes(norm(it.text)) || (norm(after.value) !== norm(before) && norm(after.value).length >= norm(before).length + Math.floor(norm(it.text).length * 0.6));
    if (!landed && readable && after.role) return { ok: false, message: `typed, but the words did not land in a text box${where}: click where they should go and say it again` };
    // An AI chat app asked by voice ("open ChatGPT and send a message …"): Return asks it.
    // Only there: in a messaging app Return would send to a person, which stays yours.
    if (it.submit && /^(chatgpt|chatgpt classic|claude|perplexity|gemini|grok|kimi|copilot|deepseek|meta ai)$/i.test(app ?? '')) {
      wait(200);
      const e = hands(['key', '36', ...(app ? ['--app', app] : [])]);
      if (!e.error) return { ok: true, message: `asked ${app}: "${it.text}"` };
    }
    return { ok: true, message: `typed "${it.text}"${where}` };
  }
  if (it.intent === 'window') return windowStep(it, app);
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

/**
 * Open a WhatsApp chat by the name shown in WhatsApp (a name that is not in
 * Contacts, or is saved differently there): WhatsApp's own search, the first
 * match opened. Never types a message and never sends.
 */
export function openWhatsAppChat(name) {
  if (process.platform !== 'darwin' || process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') return { ok: true, message: `dry run: would search WhatsApp for ${name}` };
  const a = hands(['activate', 'WhatsApp']);
  if (a.error) return { ok: false, message: a.error };
  wait(900);
  // ⌘F puts the cursor in WhatsApp's chat search, the old search text is replaced.
  for (const k of ['cmd+f', 'cmd+a']) { const r = hands(['key', ...keyArgs(parseKey(k)), '--app', 'WhatsApp']); if (r.error) return { ok: false, message: r.error }; wait(250); }
  const t = hands(['type', name, '--keys', '--app', 'WhatsApp'], 15_000);
  if (t.error) return { ok: false, message: t.error };
  wait(1500);
  // The person is clicked in the results (Return is never pressed: in a chat it sends).
  // The first match below the search box, read from the screen.
  const seen = hands(['find', name, '--app', 'WhatsApp'], 15_000);
  const hits = (seen.matches ?? []).filter((m) => m.y > 0).sort((x, y) => x.y - y.y);
  const hit = hits.length > 1 ? hits[1] : hits[0];  // hits[0] is usually the search box itself
  if (!hit) return { ok: false, message: `WhatsApp found no chat called "${name}": say the name as it is saved in WhatsApp` };
  const c = hands(['click', Math.round(hit.x + hit.w / 2), Math.round(hit.y + hit.h / 2)]);
  if (c.error) return { ok: false, message: c.error };
  wait(600);
  return { ok: true, message: `opened ${hit.text}'s WhatsApp chat` };
}
