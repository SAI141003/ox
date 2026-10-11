import { turn } from '../harness.mjs';

// --max-mode 3: three tool-less planning calls (PLAN-ALPHA/BETA/GAMMA), then a
// tool-less judge picks best=2, then the main run proceeds WITH tools and its
// system content must carry [SELECTED PLAN] PLAN-BETA.
export default {
  name: '18-max-mode-planning',
  description: '--max-mode 3 plans, judges to plan 2, injects it into the main run',
  category: 'planning',
  prompt: 'Refactor the deploy pipeline for reliability.',
  extraArgs: ['--max-mode', '3'],

  PLANS: [
    'PLAN-ALPHA: rewrite the pipeline in one pass, then test at the end.',
    'PLAN-BETA: add a staging stage, gate deploys on checks, roll back on failure, then document.',
    'PLAN-GAMMA: delete and re-create the pipeline from scratch each release.',
  ],

  async script(body, ws, state) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools) {
      const n = state.flags.toollessRequests ?? 0;
      state.flags.toollessRequests = n + 1;
      if (n < 3) {
        return turn({ text: this.PLANS[n % 3], usage: { in: 600, out: 150 } });
      }
      if (n === 3) {
        // Judge turn: must have seen all candidate plans.
        const blob = JSON.stringify(body.messages ?? []);
        state.flags.judgeSawPlans = this.PLANS.every((p) => p.includes(' ') && blob.includes(p.split(':')[0]));
        state.flags.judgeSawFullPlans = this.PLANS.every((p) => blob.includes(p));
        return turn({ text: '{"best":2,"reason":"PLAN-BETA is the most concrete and reversible"}', usage: { in: 400, out: 30 } });
      }
      state.flags.tooManyToolless = true;
      return turn({ text: '{}' });
    }
    state.flags.mainRequests = (state.flags.mainRequests ?? 0) + 1;
    const sys = (body.messages ?? []).find((m) => m?.role === 'system')?.content ?? '';
    state.flags.systemHasSelectedPlanHeader = sys.includes('[SELECTED PLAN]');
    state.flags.systemHasPlanBeta = sys.includes('PLAN-BETA');
    state.flags.systemLacksOtherPlans = !sys.includes('PLAN-ALPHA') && !sys.includes('PLAN-GAMMA');
    return turn({ text: 'Executing PLAN-BETA: staging stage added, deploy gated on checks.' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 160)}` };
    if ((r.flags.toollessRequests ?? 0) !== 4) {
      return { pass: false, detail: `expected exactly 4 tool-less requests (3 plans + judge), got ${r.flags.toollessRequests}` };
    }
    if (r.flags.tooManyToolless) return { pass: false, detail: 'mock served more tool-less turns than max-mode requires' };
    if (!r.flags.judgeSawPlans || !r.flags.judgeSawFullPlans) return { pass: false, detail: 'judge request did not carry all three candidate plans' };
    const mm = r.events.find((e) => e.t === 'max-mode');
    if (!mm) return { pass: false, detail: `no max-mode event; events: ${r.events.map((e) => e.t).join(',').slice(0, 200)}` };
    if (mm.candidates !== 3 || mm.chosen !== 2) return { pass: false, detail: `max-mode event wrong: ${JSON.stringify(mm)}` };
    if (!(mm.costUsd > 0)) return { pass: false, detail: `max-mode costUsd not > 0: ${mm.costUsd}` };
    if ((r.flags.mainRequests ?? 0) < 1) return { pass: false, detail: 'main run with tools never started' };
    if (!r.flags.systemHasSelectedPlanHeader || !r.flags.systemHasPlanBeta) {
      return { pass: false, detail: 'tools-bearing request system lacks [SELECTED PLAN] PLAN-BETA' };
    }
    if (!r.flags.systemLacksOtherPlans) return { pass: false, detail: 'rejected plans leaked into main-run system prompt' };
    const finalText = [...r.events].reverse().find((e) => e.t === 'final')?.message?.content ?? '';
    if (!String(finalText).includes('PLAN-BETA')) return { pass: false, detail: `final answer does not reference chosen plan: '${String(finalText).slice(0, 80)}'` };
    const total = [...r.events].reverse().find((e) => e.t === 'usage-total');
    if (!total || !(total.costUsd > 0)) return { pass: false, detail: 'usage-total missing or costUsd <= 0' };
    return { pass: true, detail: `3 plans judged → chosen=2; main system carries PLAN-BETA; costUsd=$${mm.costUsd}` };
  },
};
