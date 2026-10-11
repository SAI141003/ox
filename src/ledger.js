// Per-agent token and cost ledger. Fed from the event stream a run already
// emits (no new instrumentation): the main loop's `usage-total` and each
// subagent's `subagent-end`. Answers "which agent spent what, on which model".

export function createLedger() {
  const rows = new Map(); // id -> { id, label, model, inputTokens, outputTokens, costUsd, runs }
  const names = new Map(); // subagent id -> task description (only start events carry it)

  const bump = (id, label, model, i, o, cost) => {
    const r = rows.get(id) ?? { id, label, model: model ?? null, inputTokens: 0, outputTokens: 0, costUsd: null, runs: 0 };
    r.model = model ?? r.model;
    r.inputTokens += Number(i) || 0;
    r.outputTokens += Number(o) || 0;
    if (typeof cost === 'number' && Number.isFinite(cost)) r.costUsd = (r.costUsd ?? 0) + cost;
    r.runs += 1;
    rows.set(id, r);
  };

  return {
    feed(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'usage-total') {
        bump('main', 'main agent', ev.model, ev.inputTokens, ev.outputTokens, typeof ev.costUsd === 'number' && typeof ev.auxCostUsd === 'number' ? ev.costUsd - ev.auxCostUsd : ev.costUsd);
        if ((ev.auxInputTokens ?? 0) + (ev.auxOutputTokens ?? 0) > 0) {
          bump('aux', 'helper (compaction/titles)', ev.auxModel ?? null, ev.auxInputTokens, ev.auxOutputTokens, ev.auxCostUsd);
        }
      } else if (ev.type === 'subagent-start' || ev.type === 'subagent-spawn') {
        const d = ev.description ?? ev.task;
        if (d && ev.id) names.set(ev.id, String(d).replace(/\s+/g, ' ').slice(0, 30));
      } else if (ev.type === 'subagent-end') {
        const label = names.get(ev.id) ?? String(ev.description ?? ev.id ?? 'subagent').slice(0, 30);
        // A subagent reports 0 when its model has no price; that is "unpriced", not "$0".
        const cost = typeof ev.costUsd === 'number' && ev.costUsd > 0 ? ev.costUsd : null;
        bump(`sub:${ev.id}`, `↳ ${label}`, ev.model, ev.inputTokens, ev.outputTokens, cost);
      }
    },
    rows() {
      return [...rows.values()];
    },
    totals() {
      const all = [...rows.values()];
      const priced = all.filter((r) => typeof r.costUsd === 'number');
      return {
        inputTokens: all.reduce((n, r) => n + r.inputTokens, 0),
        outputTokens: all.reduce((n, r) => n + r.outputTokens, 0),
        costUsd: priced.length ? priced.reduce((n, r) => n + r.costUsd, 0) : null,
      };
    },
    hasSubagents() {
      return [...rows.keys()].some((k) => k.startsWith('sub:'));
    },
  };
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const fmtCost = (c) => (c == null ? 'free/unpriced' : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`);

/** Plain-text table; share = this agent's slice of all tokens. */
export function renderLedger(ledger, { dim = (s) => s, bold = (s) => s } = {}) {
  const rows = ledger.rows();
  if (!rows.length) return '';
  const t = ledger.totals();
  const all = t.inputTokens + t.outputTokens || 1;
  const lines = [bold('cost by agent')];
  for (const r of rows.sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))) {
    const tok = r.inputTokens + r.outputTokens;
    const share = Math.round((tok / all) * 100);
    lines.push(
      `  ${r.label.padEnd(30)} ${String(r.model ?? '?').slice(0, 26).padEnd(26)} ` +
      `${fmtTok(r.inputTokens).padStart(7)} in ${fmtTok(r.outputTokens).padStart(7)} out  ${fmtCost(r.costUsd).padStart(13)}  ${dim(`${share}%`)}`,
    );
  }
  lines.push(dim(`  ${'total'.padEnd(57)} ${fmtTok(t.inputTokens).padStart(7)} in ${fmtTok(t.outputTokens).padStart(7)} out  ${fmtCost(t.costUsd).padStart(13)}`));
  return lines.join('\n');
}
