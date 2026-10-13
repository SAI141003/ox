// Watch a web page and tell me when it matters: it changed, some text appeared
// or went away, a price fell below a number. Plain fetches, no model, so a
// watch costs nothing and needs no key.
//
//   ox watch add <url> [--contains "<text>" | --missing "<text>" | --price-below <n>] [--every 30m]
//   ox watch list | remove <id> | check | start | stop
//
// An alert fires once per transition (in stock -> out -> in stock is two), goes
// to a desktop notification and, if `ox gateway telegram` is paired, to your
// phone. A failing page backs off (doubling, up to 6h) instead of hammering it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { osCmd } from './tools/operator.js';
import { parseDuration } from './awake.js';

export const WATCH_FILE = () => path.join(os.homedir(), '.ox', 'watches.json');
const PID_FILE = () => path.join(os.homedir(), '.ox', 'watch.pid');
const MAX_BACKOFF_S = 6 * 3600;

export function loadWatches(file = WATCH_FILE()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).watches ?? []; } catch { return []; }
}
export function saveWatches(list, file = WATCH_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ watches: list }, null, 2));
}

export function pageText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#36;|&dollar;/g, '$')
    .replace(/\s+/g, ' ')
    .trim();
}

// The lowest price on the page ($, €, £, ¥, ₹ or USD/CAD/EUR before or after).
// "1,299.00" and "1.299,00" are the same number: a final separator followed by
// exactly two digits is the decimal point, every other separator groups.
function parseAmount(raw) {
  const s = String(raw).replace(/\s/g, '');
  const dec = /[.,](\d{2})$/.exec(s);
  const whole = (dec ? s.slice(0, -3) : s).replace(/[.,]/g, '');
  return Number(dec ? `${whole}.${dec[1]}` : whole);
}

export function lowestPrice(text) {
  const num = '(\\d[\\d.,\\s]*\\d|\\d)';
  const cur = '(?:[$€£¥₹]|\\b(?:USD|CAD|EUR|GBP|INR)\\b)';
  const re = new RegExp(`${cur}\\s?${num}|${num}\\s?${cur}`, 'g');
  let min = null;
  for (const m of String(text).matchAll(re)) {
    const n = parseAmount(m[1] ?? m[2]);
    if (Number.isFinite(n) && n > 0 && (min === null || n < min)) min = n;
  }
  return min;
}

// What the page says now, as the watch sees it: { hit, detail, fingerprint }.
export function evaluate(watch, text) {
  const fingerprint = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  switch (watch.kind) {
    case 'contains': {
      const hit = text.toLowerCase().includes(watch.value.toLowerCase());
      return { hit, detail: hit ? `"${watch.value}" is on the page` : `"${watch.value}" is not on the page`, fingerprint };
    }
    case 'missing': {
      const hit = !text.toLowerCase().includes(watch.value.toLowerCase());
      return { hit, detail: hit ? `"${watch.value}" is gone` : `"${watch.value}" is still there`, fingerprint };
    }
    case 'price-below': {
      const p = lowestPrice(text);
      return { hit: p !== null && p < watch.value, detail: p === null ? 'no price found on the page' : `lowest price ${p} (alert below ${watch.value})`, fingerprint, price: p };
    }
    default:
      return { hit: false, detail: 'checked', fingerprint };
  }
}

function notifyDesktop(message) {
  const cmd = osCmd('notify', message);
  if (!cmd) return;
  try { spawnSync(cmd[0], cmd.slice(1), { env: { ...process.env, OX_NOTIFY_TEXT: message }, timeout: 10_000, windowsHide: true }); } catch {}
}

async function notifyPhone(message) {
  try {
    const { loadState, telegramApi } = await import('./telegram-gateway.js');
    const st = loadState();
    if (!st.token || !st.owner) return false;
    await telegramApi(st.token)('sendMessage', { chat_id: st.owner, text: message });
    return true;
  } catch {
    return false;
  }
}

// Check every due watch once. Returns the alerts raised.
export async function checkWatches({ file = WATCH_FILE(), now = Date.now(), fetchImpl = globalThis.fetch, notify = true, force = false } = {}) {
  const list = loadWatches(file);
  const alerts = [];
  for (const w of list) {
    if (!force && w.nextAt && now < w.nextAt) continue;
    let text;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 20_000);
      const r = await fetchImpl(w.url, { headers: { 'user-agent': 'ox-watch (+https://github.com/ox)' }, signal: ac.signal }).finally(() => clearTimeout(t));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = pageText(await r.text());
    } catch (e) {
      w.failures = (w.failures ?? 0) + 1;
      w.lastError = String(e?.message ?? e);
      w.nextAt = now + Math.min(MAX_BACKOFF_S, w.everyS * 2 ** w.failures) * 1000;
      continue;
    }
    w.failures = 0;
    delete w.lastError;
    const ev = evaluate(w, text);
    let message = null;
    if (w.kind === 'changes') {
      if (w.fingerprint && w.fingerprint !== ev.fingerprint) message = `${w.label}: the page changed`;
    } else if (ev.hit && !w.hit) {
      message = `${w.label}: ${ev.detail}`;
    }
    w.hit = ev.hit;
    w.fingerprint = ev.fingerprint;
    w.lastCheck = now;
    w.lastDetail = ev.detail;
    w.nextAt = now + w.everyS * 1000;
    if (message) {
      message += `\n${w.url}`;
      alerts.push({ id: w.id, message });
      w.lastAlert = now;
      if (notify) {
        notifyDesktop(message);
        await notifyPhone(message);
      }
    }
  }
  saveWatches(list, file);
  return alerts;
}

export function addWatch({ url, contains, missing, priceBelow, every = '30m', label, file = WATCH_FILE() }) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https pages can be watched');
  const everyS = parseDuration(every);
  if (!everyS || everyS < 60) throw new Error('--every must be at least 1m (e.g. 15m, 2h, 1d)');
  const kind = contains ? 'contains' : missing ? 'missing' : priceBelow != null ? 'price-below' : 'changes';
  const value = contains ?? missing ?? (priceBelow != null ? Number(priceBelow) : null);
  if (kind === 'price-below' && !(value > 0)) throw new Error('--price-below needs a positive number');
  const w = { id: crypto.randomBytes(3).toString('hex'), url: u.href, kind, value, everyS, label: label || u.hostname, createdAt: Date.now() };
  const list = loadWatches(file);
  list.push(w);
  saveWatches(list, file);
  return w;
}

export function describe(w) {
  const what = w.kind === 'changes' ? 'any change' : w.kind === 'price-below' ? `price below ${w.value}` : `${w.kind === 'contains' ? 'shows' : 'no longer shows'} "${w.value}"`;
  return `${w.id}  ${w.label} · ${what} · every ${Math.round(w.everyS / 60)}m${w.lastDetail ? ` · last: ${w.lastDetail}` : ''}${w.lastError ? ` · failing: ${w.lastError}` : ''}`;
}

// The background checker: one detached process, checking due watches each minute.
export function startWatcher() {
  if (watcherPid()) return { already: true, pid: watcherPid() };
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
  const child = spawn(process.execPath, [cli, 'watch', 'loop'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  fs.mkdirSync(path.dirname(PID_FILE()), { recursive: true });
  fs.writeFileSync(PID_FILE(), String(child.pid));
  return { already: false, pid: child.pid };
}

export function watcherPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function stopWatcher() {
  const pid = watcherPid();
  if (pid) { try { process.kill(pid); } catch {} }
  try { fs.unlinkSync(PID_FILE()); } catch {}
  return !!pid;
}

export async function watchLoop() {
  for (;;) {
    try { await checkWatches(); } catch {}
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
