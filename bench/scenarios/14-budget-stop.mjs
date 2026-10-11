import { turn, countExecuted } from '../harness.mjs';

// --max-cost 0.000001 with usage-bearing turns: after the first usage event the
// accumulated cost (~$0.09 on grok-4.6) exceeds the cap → budget-stop.
export default {
  name: '14-budget-stop',
  description: 'cost cap aborts the run with a budget-stop event',
  category: 'safety',
  prompt: 'Read settings.txt and summarize it.',
  extraArgs: ['--max-cost', '0.000001'],
  tokensPerTurn: { in: 20000, out: 8000 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'settings.txt', 'mode = deterministic\n');
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'read_file')) {
      return turn({ calls: [{ id: 'call_rd', name: 'read_file', args: { path: `${ws}/settings.txt` } }], usage: { in: 20000, out: 8000 } });
    }
    // Should never get here: budget must abort after the first usage event.
    state.flags.secondTurnServed = true;
    return turn({ text: 'done' });
  },

  async check(r) {
    const stop = r.events.find((e) => e.t === 'budget-stop');
    if (!stop) return { pass: false, detail: `no budget-stop event; events: ${r.events.map((e) => e.t).join(',').slice(0, 200)}` };
    if (!(stop.costUsd > stop.maxCostUsd)) return { pass: false, detail: `budget-stop payload odd: ${JSON.stringify(stop)}` };
    if (r.flags.secondTurnServed) return { pass: false, detail: 'mock served a second turn — abort happened too late' };
    // src/headless.js: `failed ? 1 : budgetStopped ? 2 : denialCount > 0 ? 2 : 0`.
    // A budget-stopped run is a truncated run and must not report success, so it
    // exits 2 — see the breaking-change section in README.md.
    if (r.exitCode !== 2) return { pass: false, detail: `expected exit 2 per headless.js budget-stop path, got ${r.exitCode}` };
    // 2 alone is ambiguous: it is also what an approval denial returns (scenario 07
    // asserts that same code), so bind the code to structured evidence rather than
    // letting an unrelated denial satisfy it. `auto-summary.status` is the
    // `ox auto` signal and does not exist on the `-p` path, so the `budget-stop`
    // event is what this scenario must key on.
    const stops = r.events.filter((e) => e.t === 'budget-stop');
    if (stops.length !== 1) return { pass: false, detail: `expected exactly 1 budget-stop event, got ${stops.length}` };
    if (stop.reason !== 'cost-cap') return { pass: false, detail: `expected budget-stop reason 'cost-cap', got ${JSON.stringify(stop.reason)}` };
    const declined = r.requests.some((b) => (b.messages ?? []).some((m) => m.role === 'tool' && /declin/i.test(String(m.content ?? ''))));
    if (declined) return { pass: false, detail: 'a tool result was declined — exit 2 came from a denial, not the cost cap' };
    if (r.events.some((e) => e.t === 'final')) return { pass: false, detail: 'final event present — the run was not truncated' };
    if (!r.events.some((e) => e.t === 'usage')) return { pass: false, detail: 'no usage event before abort' };
    return { pass: true, detail: `aborted at $${stop.costUsd} > $${stop.maxCostUsd}; exit 2 via budget-stop (reason=${stop.reason})` };
  },
};
