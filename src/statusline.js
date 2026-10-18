// `ox statusline`: Claude Code's status-line command, so the island can show
// your Claude plan usage (5-hour and weekly, with reset times).
//
// Claude Code runs the status-line command on every refresh with a JSON
// payload on stdin; for Pro / Max plans that payload carries `rate_limits`.
// This is the only place Claude Code shares those numbers, and reading them
// here needs no login token: ox never reads or copies one. The idea is
// Coucou's plan gauge (MIT); this is ox's own code.
//
// It writes ~/.ox/plan-usage/claude.json (read by src/plan-usage.js), then
// hands the same payload to the status line you had before, printing what it
// prints, so installing ox changes nothing you see. With none, it prints a
// short line of its own. Any failure prints nothing extra and never blocks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OX_DIR = (env = process.env) => env.OX_HOME || path.join(env.HOME || os.homedir(), '.ox');
export const USAGE_FILE = (env = process.env) => path.join(OX_DIR(env), 'plan-usage', 'claude.json');
export const PREVIOUS_FILE = (env = process.env) => path.join(OX_DIR(env), 'statusline-previous.json');

/** What is kept from Claude Code's payload: the limits and where they came from. Nothing else. */
export function usageRecord(payload = {}, now = Date.now()) {
  const rl = payload?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) => {
    if (!w || typeof w !== 'object') return null;
    const used = Number(w.used_percentage ?? w.used_percent);
    const resets = Number(w.resets_at);
    if (!Number.isFinite(used) || used < 0 || used > 200) return null;
    // Seconds, not milliseconds: more than 400 days ahead means the unit is wrong.
    if (!Number.isFinite(resets) || resets <= 0 || resets > now / 1000 + 400 * 86400) return null;
    return { used_percentage: Math.min(100, used), resets_at: resets };
  };
  const rate_limits = Object.fromEntries(Object.entries(rl).map(([k, w]) => [k, win(w)]).filter(([, w]) => w));
  if (!Object.keys(rate_limits).length) return null;
  return { rate_limits, model: payload.model?.display_name ?? payload.model?.id ?? null, session_id: payload.session_id ?? null, at: now };
}

const pct = (w) => (w ? `${Math.round(w.used_percentage)}%` : '–');

export function defaultLine(payload = {}, rec = null) {
  const model = payload.model?.display_name ?? payload.model?.id ?? 'Claude';
  const dir = path.basename(payload.workspace?.current_dir ?? payload.cwd ?? '') || '';
  const lim = rec?.rate_limits ? ` · 5h ${pct(rec.rate_limits.five_hour)} · week ${pct(rec.rate_limits.seven_day)}` : '';
  return `${model}${dir ? ` · ${dir}` : ''}${lim}`;
}

/** The whole command: read stdin, record, delegate. Returns what to print. */
export function runStatusline(raw, { env = process.env, now = Date.now(), run = spawnSync } = {}) {
  let payload = {};
  try { payload = JSON.parse(String(raw ?? '')) ?? {}; } catch {}
  const rec = usageRecord(payload, now);
  if (rec) {
    try {
      fs.mkdirSync(path.dirname(USAGE_FILE(env)), { recursive: true });
      fs.writeFileSync(USAGE_FILE(env), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } catch {}
  }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(PREVIOUS_FILE(env), 'utf8'))?.command ?? null; } catch {}
  if (typeof prev === 'string' && prev.trim()) {
    try {
      const r = run('/bin/sh', ['-c', prev], { input: String(raw ?? ''), encoding: 'utf8', timeout: 5000 });
      if (typeof r.stdout === 'string' && r.stdout) return r.stdout;
    } catch {}
  }
  return `${defaultLine(payload, rec)}\n`;
}
