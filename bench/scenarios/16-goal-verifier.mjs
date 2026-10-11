import { turn } from '../harness.mjs';

// --verify: after each final answer a tool-less judge request audits the goal.
// Round 1 final omits MARKER-X → verifier says incomplete → agent continues and
// completes it in round 2 → verifier approves. Judge usage must be folded into
// the usage-total event.
export default {
  name: '16-goal-verifier',
  description: 'goal verifier detects a missing element, forces continuation, then approves',
  category: 'verification',
  prompt: 'Reply with exactly MARKER-X and nothing else.',
  extraArgs: ['--verify'],

  serve(state, u) {
    state.flags.servedIn = (state.flags.servedIn ?? 0) + u.in;
    state.flags.servedOut = (state.flags.servedOut ?? 0) + u.out;
  },

  async script(body, ws, state) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools) {
      // Tool-less body = goal-verifier (judge) call.
      state.flags.verifierCalls = (state.flags.verifierCalls ?? 0) + 1;
      const usage = { in: 150, out: 25 };
      this.serve(state, usage);
      if (state.flags.verifierCalls === 1) {
        return turn({ text: '{"complete":false,"gaps":"missing MARKER-X"}', usage });
      }
      return turn({ text: '{"complete":true,"gaps":""}', usage });
    }
    state.flags.mainRequests = (state.flags.mainRequests ?? 0) + 1;
    if (state.flags.mainRequests === 1) {
      const usage = { in: 600, out: 120 };
      this.serve(state, usage);
      return turn({ text: 'All done here.', usage }); // deliberately missing MARKER-X
    }
    const continued = (body.messages ?? []).some(
      (m) => m?.role === 'user' && String(m.content).includes('Unmet criteria: missing MARKER-X')
    );
    if (continued) state.flags.continuationSeen = true;
    const usage = { in: 600, out: 130 };
    this.serve(state, usage);
    return turn({ text: 'MARKER-X delivered as required.', usage });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 160)}` };
    if ((r.flags.verifierCalls ?? 0) < 2) return { pass: false, detail: `expected ≥2 verifier calls, got ${r.flags.verifierCalls}` };
    if ((r.flags.mainRequests ?? 0) < 2) return { pass: false, detail: 'no continuation round — main completion happened once' };
    if (!r.flags.continuationSeen) return { pass: false, detail: 'continuation request lacked the verifier gap message' };
    const verifs = r.events.filter((e) => e.t === 'verification');
    const incomplete = verifs.find((e) => e.complete === false);
    const complete = verifs.find((e) => e.complete === true);
    if (!incomplete || incomplete.gaps !== 'missing MARKER-X') {
      return { pass: false, detail: `incomplete-verification event wrong: ${JSON.stringify(verifs).slice(0, 200)}` };
    }
    if (!complete) return { pass: false, detail: 'no complete verification event in NDJSON' };
    const finals = r.events.filter((e) => e.t === 'final');
    if (finals.length !== 1) return { pass: false, detail: `expected exactly one verified final, got ${finals.length}` };
    if (r.events.indexOf(incomplete) >= r.events.indexOf(complete) || r.events.indexOf(complete) >= r.events.indexOf(finals[0])) {
      return { pass: false, detail: 'expected incomplete verification, then complete verification, then the sole final' };
    }
    if (r.events.some((e) => e.t === 'error' || e.t === 'gate-exhausted')) {
      return { pass: false, detail: 'completion included a blocked/error outcome' };
    }
    const lastFinal = String(finals[0]?.message?.content ?? '');
    if (!lastFinal.includes('MARKER-X')) return { pass: false, detail: `final answer lacks MARKER-X: '${lastFinal.slice(0, 80)}'` };
    const total = [...r.events].reverse().find((e) => e.t === 'usage-total');
    if (!total) return { pass: false, detail: 'no usage-total event' };
    if (total.inputTokens !== r.flags.servedIn || total.outputTokens !== r.flags.servedOut) {
      return {
        pass: false,
        detail: `usage-total ${total.inputTokens}/${total.outputTokens} != served incl. judge ${r.flags.servedIn}/${r.flags.servedOut}`,
      };
    }
    return {
      pass: true,
      detail: `2 rounds, verifier incomplete→complete; totals ${total.inputTokens}in/${total.outputTokens}out include judge tokens`,
    };
  },
};
