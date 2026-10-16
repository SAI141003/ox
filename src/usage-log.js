// Where the tokens went, kept: one line per run in ~/.ox/usage.jsonl, split by
// model and agent (main / subagents / helper), tagged with the surface it ran
// from (terminal, app, island, phone…) and the project folder's name. Fed from
// the per-agent ledger a run already builds (src/ledger.js), so subagent
// tokens are counted once. Incognito runs leave no line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from './ledger.js';

export const USAGE_FILE = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'usage.jsonl');

export function recordRun({ surface = 'terminal', agent = null, mode = null, cwd = process.cwd(), rows = [], at = Date.now(), file = USAGE_FILE() } = {}) {
  const lines = rows
    .filter((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0)
    .map((r) => JSON.stringify({
      at, surface, agent: agent ?? null, mode: mode ?? null, project: path.basename(cwd || ''),
      who: r.id === 'main' ? 'main' : r.id === 'aux' ? 'helper' : 'subagent',
      model: r.model ?? null, in: r.inputTokens ?? 0, out: r.outputTokens ?? 0,
      cost: typeof r.costUsd === 'number' ? Number(r.costUsd.toFixed(6)) : null,
    }));
  if (!lines.length) return 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  } catch { return 0; }
  return lines.length;
}

export function readUsage({ file = USAGE_FILE(), since = 0 } = {}) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.at >= since) out.push(r); } catch {}
  }
  return out;
}

// Totals and breakdowns over a window: by model, agent, surface, project, day.
export function summarize({ days = 30, now = Date.now(), file = USAGE_FILE() } = {}) {
  const since = now - days * 86_400_000;
  const rows = readUsage({ file, since });
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r) ?? 'unknown';
      const g = m.get(k) ?? { key: k, in: 0, out: 0, cost: 0, priced: false, runs: 0 };
      g.in += r.in; g.out += r.out; g.runs += r.who === 'main' ? 1 : 0;
      if (typeof r.cost === 'number') { g.cost += r.cost; g.priced = true; }
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, cost: g.priced ? Number(g.cost.toFixed(4)) : null })).sort((a, b) => (b.in + b.out) - (a.in + a.out));
  };
  const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const total = group(() => 'all')[0] ?? { in: 0, out: 0, cost: null, runs: 0 };
  return {
    days, total,
    byModel: group((r) => r.model),
    byAgent: group((r) => (r.who === 'main' ? (r.agent ? `agent ${r.agent}` : 'ox') : r.who)),
    bySurface: group((r) => r.surface),
    byProject: group((r) => r.project),
    byDay: group((r) => day(r.at)).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

// Wraps a run's event stream: feeds the ledger, writes one record when it ends.
export async function* withUsageLog(opts, source) {
  const ctx = opts?.ctx ?? {};
  const top = !(ctx.depth > 0) && !ctx.incognito && process.env.OX_INCOGNITO !== '1' && process.env.OX_USAGE_LOG !== '0';
  if (!top) { yield* source; return; }
  const ledger = createLedger();
  try {
    for await (const ev of source) {
      try { ledger.feed(ev); } catch {}
      yield ev;
    }
  } finally {
    try {
      recordRun({ surface: ctx.surface ?? process.env.OX_SURFACE ?? 'terminal', agent: ctx.agentName ?? null, mode: ctx.mode ?? null, cwd: ctx.cwd ?? process.cwd(), rows: ledger.rows() });
    } catch {}
  }
}
