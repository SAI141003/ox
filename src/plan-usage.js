// How much of each plan you pay for is used (Coucou's plan-usage gauges).
//
//   Codex (ChatGPT plan): the CLI writes its rate limits into each session log
//   (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, "rate_limits"); the newest
//   one is read. Nothing is asked of OpenAI.
//   Claude (Pro / Max): Claude Code hands its limits only to a status-line
//   command, so a relay has to be installed in ~/.claude/settings.json; ox
//   reads ~/.ox/plan-usage/claude.json when that relay writes it, and says so
//   plainly when it is not installed (it never edits that file on its own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = () => process.env.HOME || os.homedir();

function newestFiles(dir, depth = 3) {
  const out = [];
  const walk = (d, left) => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) { try { out.push({ p, m: fs.statSync(p).mtimeMs }); } catch {} }
    }
  };
  walk(dir, depth);
  return out.sort((a, b) => b.m - a.m).map((x) => x.p);
}

// The last "rate_limits" object in a log's text.
export function lastRateLimits(text) {
  const s = String(text ?? '');
  let i = s.lastIndexOf('"rate_limits":');
  while (i >= 0) {
    const start = s.indexOf('{', i);
    let depth = 0;
    for (let j = start; j >= 0 && j < s.length && j < start + 20000; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) {
        try { return JSON.parse(s.slice(start, j + 1)); } catch { break; }
      }
    }
    i = i > 0 ? s.lastIndexOf('"rate_limits":', i - 1) : -1;
  }
  return null;
}

export const windowName = (mins) => (!mins ? 'window' : mins <= 300 ? `${Math.round(mins / 60)}-hour` : mins <= 10080 ? 'weekly' : mins <= 46000 ? 'monthly' : `${Math.round(mins / 1440)}-day`);

export function codexUsage({ home = HOME(), now = Date.now() } = {}) {
  const files = newestFiles(path.join(home, '.codex', 'sessions')).slice(0, 8);
  for (const f of files) {
    let text = '';
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(st.size, 2_000_000);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, st.size - len);
      fs.closeSync(fd);
      text = b.toString('utf8');
    } catch { continue; }
    const rl = lastRateLimits(text);
    if (!rl) continue;
    const windows = ['primary', 'secondary'].map((k) => rl[k]).filter(Boolean).map((w) => {
      const resetsAt = w.resets_at ? w.resets_at * 1000 : w.resets_in_seconds != null ? now + w.resets_in_seconds * 1000 : null;
      const used = resetsAt && resetsAt < now ? 0 : Math.max(0, Math.min(100, Number(w.used_percent) || 0));
      return { name: windowName(w.window_minutes), usedPercent: used, resetsAt };
    });
    let at = null; try { at = fs.statSync(f).mtimeMs; } catch {}
    return { id: 'codex', label: 'ChatGPT (Codex)', plan: rl.plan_type ?? null, windows, at, reached: rl.rate_limit_reached_type ?? null };
  }
  return { id: 'codex', label: 'ChatGPT (Codex)', windows: [], missing: 'no Codex session with limits yet: they appear after you use the ChatGPT plan once' };
}

export const CLAUDE_FILE = () => path.join(HOME(), '.ox', 'plan-usage', 'claude.json');

export function claudeUsage({ now = Date.now() } = {}) {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CLAUDE_FILE(), 'utf8')); } catch {}
  if (!doc?.rate_limits) return { id: 'claude', label: 'Claude (Pro / Max)', windows: [], missing: 'not connected: Claude Code shares its limits only with a status-line relay in ~/.claude/settings.json (ox asks before changing it)' };
  const names = { five_hour: '5-hour', seven_day: 'weekly' };
  const windows = Object.entries(doc.rate_limits).filter(([, w]) => w && typeof w === 'object').map(([k, w]) => {
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
    const p = Number(w.used_percentage);
    return { name: names[k] ?? k, usedPercent: resetsAt && resetsAt < now ? 0 : p >= 0 && p <= 100 ? p : null, resetsAt };
  }).filter((w) => w.usedPercent !== null);
  return { id: 'claude', label: 'Claude (Pro / Max)', windows, at: doc.at ?? null };
}

export function planUsage(opts = {}) {
  return [codexUsage(opts), claudeUsage(opts)];
}

// Claudex's warning: say so BEFORE a plan limit is hit, not when a run stops
// with "usage limit reached". Each window warns once at 80 % and once at 95 %
// per reset period (the reset time identifies the period), remembered in
// ~/.ox/plan-usage/alerts.json so a restart does not repeat it.
export const ALERT_LEVELS = Object.freeze([80, 95]);
export function limitAlerts(plans = [], { now = Date.now(), file = path.join(HOME(), '.ox', 'plan-usage', 'alerts.json') } = {}) {
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch {}
  const out = [];
  for (const p of plans) {
    for (const w of p?.windows ?? []) {
      if (!Number.isFinite(w?.usedPercent) || !w.resetsAt || w.resetsAt <= now) continue;
      const level = [...ALERT_LEVELS].reverse().find((l) => w.usedPercent >= l);
      if (!level) continue;
      const key = `${p.id}:${w.name}:${w.resetsAt}`;
      if ((seen[key] ?? 0) >= level) continue;
      seen[key] = level;
      const mins = Math.max(1, Math.round((w.resetsAt - now) / 60000));
      const left = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
      out.push({ plan: p.id, window: w.name, level, text: `${p.id === 'codex' ? 'ChatGPT' : 'Claude'} ${w.name} limit at ${Math.round(w.usedPercent)}%: resets in ${left}` });
    }
  }
  // Forget periods that have ended.
  for (const k of Object.keys(seen)) { const t = Number(k.split(':').pop()); if (!(t > now)) delete seen[k]; }
  if (out.length) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(seen)); } catch {} }
  return out;
}
