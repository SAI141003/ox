// Small tasks with no AI and no internet. A plain-rules parser turns a short
// request ("open notes", "timer 10 minutes", "what is 12% of 340") into one OS
// action, so the island and `ox do` keep working on a plane, offline, or with
// no model configured. It never guesses: anything it does not recognise is
// handed back as "not a small task" for a model to take, if there is one.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { osCmd } from './tools/operator.js';

// ---- arithmetic without eval: + - * / ^ % ( ) and "x% of y" ----

export function calc(expr) {
  const src = String(expr).toLowerCase()
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/g, '($1/100*$2)')
    .replace(/\b(times|x)\b/g, '*').replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-')
    .replace(/\b(divided by|over)\b/g, '/').replace(/\b(to the power of|power)\b/g, '^')
    .replace(/,/g, '').replace(/\s+/g, '');
  if (!/^[\d.+\-*/^()%]+$/.test(src) || !/\d/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const num = () => {
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error('number expected');
    i += m[0].length;
    return Number(m[0]);
  };
  const atom = () => {
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '(') { i++; const v = sum(); if (peek() !== ')') throw new Error(') expected'); i++; return v; }
    let v = num();
    if (peek() === '%') { i++; v /= 100; }
    return v;
  };
  const pow = () => { const b = atom(); if (peek() === '^') { i++; return b ** pow(); } return b; };
  const prod = () => {
    let v = pow();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = pow(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  function sum() {
    let v = prod();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = prod(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  try {
    const v = sum();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e10) / 1e10;
  } catch {
    return null;
  }
}

function seconds(n, unit) {
  const u = String(unit ?? 'm').toLowerCase();
  const k = u.startsWith('h') ? 3600 : u.startsWith('s') ? 1 : 60;
  return Math.round(Number(n) * k);
}

const SITE = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/i;

// text -> { intent, ...args } | null. Order matters: the first rule wins.
export function parseIntent(text) {
  // `t` keeps the person's casing (app names, note text); `low` is for matching.
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '').replace(/^(?:(?:hey ox|ox|please|can you|could you)[,\s]+)+/i, '').trim();
  const low = t.toLowerCase();
  let m;
  if ((m = /^(?:set (?:a )?)?(?:timer|countdown)(?: for)? (\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b(?:\s+(?:for|to|called)\s+(.+))?$/i.exec(low))) {
    return { intent: 'timer', secs: seconds(m[1], m[2]), label: m[3] ?? 'timer' };
  }
  if ((m = /^remind me (?:in )?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+(?:to\s+)?(.+)$/i.exec(low))) {
    return { intent: 'timer', secs: seconds(m[1], m[2]), label: m[3] };
  }
  if ((m = /^(?:make|take|add|write|new)(?: a)? note(?: that| saying| to)?[:\s]+(.+)$/i.exec(t)) || (m = /^note[:\s]+(.+)$/i.exec(t)) || (m = /^(?:write|jot|note) (?:this )?down[:\s]+(.+)$/i.exec(t)) || (m = /^(?:write|jot) down (.+)$/i.exec(t))) {
    return { intent: 'note', text: m[1].trim() };
  }
  // Email, never sent from here: a draft opens in your mail app for you to send.
  if ((m = /^(?:send |write |draft )?(?:an? )?(?:e-?mail|mail)(?: to)?\s+([^\s@]+@[^\s@]+\.[a-z]{2,})(?:\s+(?:about|subject|re|regarding)[:\s]+(.+?))?(?:\s+(?:saying|that says|telling (?:him|her|them)|body|:)\s+(.+))?$/i.exec(t))) {
    return { intent: 'email', to: m[1], subject: (m[2] ?? '').trim(), body: (m[3] ?? '').trim() };
  }
  if (/^(?:check|read)?\s*(?:my )?(?:e-?mails?|mail|inbox)(?: for me)?$|^(?:do i have |any )?(?:new |unread )(?:e-?mails?|mail)\??$|^how many (?:unread |new )?(?:e-?mails?|mails?)(?: do i have)?\??$/i.test(low)) {
    return { intent: 'unread' };
  }
  // A to-do, into Apple Reminders (or ~/ox-tasks.md).
  if ((m = /^(?:add (?:a )?)?(?:task|to-?do|todo)[:\s]+(.+)$/i.exec(t)) || (m = /^add (.+?) to (?:my )?(?:to-?do(?: list)?|todos|tasks|task list|reminders|list)$/i.exec(t)) || (m = /^remind me to (.+)$/i.exec(t))) {
    return { intent: 'task', text: m[1].trim() };
  }
  // Music in Spotify or Apple Music, when one is open.
  if (/^(?:pause|stop)(?: the)?(?: music| song| spotify| playback)?$/i.test(low) && low !== 'stop') return { intent: 'music', command: 'pause' };
  if (/^(?:play|resume)(?: the)? (?:music|song|spotify)$|^resume$/i.test(low)) return { intent: 'music', command: 'play' };
  if (/^(?:next|skip)(?: the)?(?: song| track)?$/i.test(low)) return { intent: 'music', command: 'next track' };
  if (/^(?:previous|last|go back)(?: the)?(?: song| track)$/i.test(low)) return { intent: 'music', command: 'previous track' };
  if (/^(?:take (?:a )?)?screenshot$|^capture (?:the )?screen$/i.test(low)) return { intent: 'screenshot' };
  if (/^(?:what(?:'s| is) the )?time(?: is it)?(?: now)?$|^what time is it$/i.test(low)) return { intent: 'time' };
  if (/^(?:what(?:'s| is) )?(?:the |today'?s )?date(?: today)?$|^what day is it$/i.test(low)) return { intent: 'date' };
  if ((m = /^(?:volume|set volume(?: to)?)\s+(\d{1,3})%?$/i.exec(low))) return { intent: 'volume', level: Math.min(100, Number(m[1])) };
  if (/^(?:volume up|louder|turn it up)$/i.test(low)) return { intent: 'volume', delta: 10 };
  if (/^(?:volume down|quieter|turn it down)$/i.test(low)) return { intent: 'volume', delta: -10 };
  if (/^(?:mute|unmute)$/i.test(low)) return { intent: 'mute', on: low === 'mute' };
  if ((m = /^(?:search(?: the web| google)?(?: for)?|google|look up)\s+(.+)$/i.exec(t))) return { intent: 'search', query: m[1].trim() };
  if ((m = /^(?:open|go to|visit)\s+(\S+)$/i.exec(t)) && SITE.test(m[1])) {
    return { intent: 'url', url: /^https?:\/\//i.test(m[1]) ? m[1] : `https://${m[1]}` };
  }
  if ((m = /^(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?$/i.exec(t))) return { intent: 'app', name: m[1].trim() };
  if ((m = /^(?:what is|what's|calculate|calc|compute)\s+(.+)$/i.exec(low)) && calc(m[1]) !== null) return { intent: 'calc', expr: m[1], value: calc(m[1]) };
  if (calc(low) !== null && /[+\-*/^%]/.test(low)) return { intent: 'calc', expr: low, value: calc(low) };
  return null;
}

function run(cmd, env = {}) {
  if (!cmd) return { ok: false, err: `not supported on ${process.platform}` };
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env }, windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, err: (r.stderr || r.error?.message || `exit ${r.status}`).trim() };
}

// A detached timer that outlives this process and notifies when it fires.
function startTimer(secs, label) {
  const msg = `⏰ ${label}`;
  const script = `setTimeout(() => { const { spawnSync } = require('node:child_process'); const c = ${JSON.stringify(osCmd('notify', msg))}; if (c) spawnSync(c[0], c.slice(1), { env: { ...process.env, OX_NOTIFY_TEXT: ${JSON.stringify(msg)} }, windowsHide: true }); }, ${secs * 1000});`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

function addNote(text) {
  if (process.platform === 'darwin') {
    const r = run(['osascript', '-e', 'on run argv', '-e', 'tell application "Notes" to make new note with properties {body:(item 1 of argv)}', '-e', 'end run', text]);
    if (r.ok) return { ok: true, where: 'Apple Notes' };
  }
  const file = path.join(os.homedir(), 'ox-notes.md');
  fs.appendFileSync(file, `- ${new Date().toLocaleString()} — ${text}\n`);
  return { ok: true, where: file };
}

function addTask(text) {
  if (process.platform === 'darwin') {
    const r = run(['osascript', '-e', 'on run argv', '-e', 'tell application "Reminders" to make new reminder with properties {name:(item 1 of argv)}', '-e', 'end run', text]);
    if (r.ok) return { ok: true, where: 'Reminders' };
  }
  const file = path.join(os.homedir(), 'ox-tasks.md');
  fs.appendFileSync(file, `- [ ] ${text}\n`);
  return { ok: true, where: file };
}

export function mailtoUrl({ to, subject = '', body = '' }) {
  const q = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean).join('&');
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}${q ? `?${q}` : ''}`;
}

function openWith(url) {
  return run(process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]);
}

function music(command) {
  if (process.platform !== 'darwin') return { ok: false, err: 'music control is macOS only for now' };
  for (const app of ['Spotify', 'Music']) {
    const running = spawnSync('osascript', ['-e', `application "${app}" is running`], { encoding: 'utf8', timeout: 5000 });
    if (String(running.stdout).trim() === 'true') {
      const r = run(['osascript', '-e', `tell application "${app}" to ${command}`]);
      return r.ok ? { ok: true, app } : r;
    }
  }
  return { ok: false, err: 'open Spotify or Music first' };
}

function setVolume({ level, delta }) {
  if (process.platform === 'darwin') {
    if (level != null) return run(['osascript', '-e', `set volume output volume ${Number(level)}`]);
    return run(['osascript', '-e', `set volume output volume ((output volume of (get volume settings)) + ${Number(delta)})`]);
  }
  if (process.platform === 'linux') {
    return run(['pactl', 'set-sink-volume', '@DEFAULT_SINK@', level != null ? `${Number(level)}%` : `${delta > 0 ? '+' : ''}${Number(delta)}%`]);
  }
  return { ok: false, err: 'volume control is macOS and Linux only for now' };
}

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString() : String(n));

// Carry out one parsed intent. Returns { ok, message }.
export function perform(it) {
  switch (it.intent) {
    case 'calc': return { ok: true, message: `${it.expr} = ${fmt(it.value)}` };
    case 'time': return { ok: true, message: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    case 'date': return { ok: true, message: new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) };
    case 'timer': {
      startTimer(it.secs, it.label);
      const mins = it.secs >= 60 ? `${Math.round((it.secs / 60) * 10) / 10} min` : `${it.secs} s`;
      return { ok: true, message: `timer set: ${mins} — "${it.label}"` };
    }
    case 'note': { const r = addNote(it.text); return { ok: r.ok, message: `noted in ${r.where}` }; }
    case 'task': { const r = addTask(it.text); return { ok: r.ok, message: `added to ${r.where}: ${it.text}` }; }
    case 'email': {
      const r = openWith(mailtoUrl(it));
      return r.ok ? { ok: true, message: `draft to ${it.to} is open in your mail app: check it and press Send (ox never sends it)` } : { ok: false, message: r.err };
    }
    case 'unread': {
      if (process.platform !== 'darwin') return { ok: false, message: 'reading Mail is macOS only for now' };
      const r = spawnSync('osascript', ['-e', 'tell application "Mail" to get unread count of inbox'], { encoding: 'utf8', timeout: 15000 });
      const n = Number(String(r.stdout).trim());
      return r.status === 0 && Number.isFinite(n) ? { ok: true, message: n === 0 ? 'no unread email' : `${n} unread email${n === 1 ? '' : 's'} in Mail` } : { ok: false, message: (r.stderr || 'Mail did not answer').trim() };
    }
    case 'music': {
      const r = music(it.command);
      return r.ok ? { ok: true, message: `${it.command === 'pause' ? 'paused' : it.command === 'play' ? 'playing' : it.command === 'next track' ? 'next track' : 'previous track'} in ${r.app}` } : { ok: false, message: r.err };
    }
    case 'screenshot': {
      const out = path.join(os.homedir(), 'Desktop', `ox-screenshot-${Date.now()}.png`);
      const r = run(osCmd('screenshot', out));
      return r.ok ? { ok: true, message: `screenshot saved: ${out}` } : { ok: false, message: `screenshot failed: ${r.err}` };
    }
    case 'search': {
      const url = `https://www.google.com/search?q=${encodeURIComponent(it.query)}`;
      const r = run(osCmd('open_url', url));
      return r.ok ? { ok: true, message: `searching: ${it.query}` } : { ok: false, message: r.err };
    }
    case 'url': { const r = run(osCmd('open_url', it.url)); return r.ok ? { ok: true, message: `opened ${it.url}` } : { ok: false, message: r.err }; }
    case 'app': { const r = run(osCmd('open_app', it.name)); return r.ok ? { ok: true, message: `opened ${it.name}` } : { ok: false, message: `could not open "${it.name}": ${r.err}` }; }
    case 'volume': { const r = setVolume(it); return r.ok ? { ok: true, message: it.level != null ? `volume ${it.level}%` : `volume ${it.delta > 0 ? 'up' : 'down'}` } : { ok: false, message: r.err }; }
    case 'mute': {
      const r = process.platform === 'darwin' ? run(['osascript', '-e', `set volume ${it.on ? 'with' : 'without'} output muted`]) : process.platform === 'linux' ? run(['pactl', 'set-sink-mute', '@DEFAULT_SINK@', it.on ? '1' : '0']) : { ok: false, err: 'not supported here' };
      return r.ok ? { ok: true, message: it.on ? 'muted' : 'unmuted' } : { ok: false, message: r.err };
    }
    default: return { ok: false, message: 'not a small task' };
  }
}

export function doOffline(text, { dryRun = false } = {}) {
  const it = parseIntent(text);
  if (!it) return { handled: false, message: 'Not a small task I can do offline. Ask ox with a model for this one.' };
  if (dryRun) return { handled: true, intent: it, message: `would ${it.intent}` };
  return { handled: true, intent: it, ...perform(it) };
}
