// Compaction integrity. src/agent.js computes the window from
// lookupModel(model)?.window or ctx.modelWindow — there is NO env hook
// (OX_MODEL_WINDOW is not read anywhere in src/), so we drive history past the
// natural threshold: est > window * 0.75 with the real 128k window.
const FACT = 'BENCH-COMPACTION-FACT-8821';
const FILLER = 'filler '.repeat(6400); // ~45k chars ≈ 11k estimated tokens per turn

export default {
  name: '08-compaction-integrity',
  description: 'history crosses compaction threshold; summary preserves turn-1 fact',
  category: 'agentic-loop',
  prompt: `Remember this durable fact for later: ${FACT}. Keep reading probe.txt each turn while I feed you filler context.`,
  timeoutMs: 35_000,
  tokensPerTurn: { in: 1200, out: 300 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'probe.txt', 'probe-ok\n');
  },

  async script(body, ws, state) {
    const msgs = body.messages ?? [];
    const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
    // Summary request from summarizeMessages(): single user message, no tools.
    const isSummary = !body.tools && msgs.length === 1 && String(msgs[0].content ?? '').includes('Summarize the following');
    if (isSummary) {
      const transcript = String(msgs[0].content ?? '');
      state.flags.summaryRequested = true;
      state.flags.summaryHadFact = transcript.includes(FACT);
      return [
        { choices: [{ index: 0, delta: { content: `Summary: the user established fact ${FACT} at the start.` }, finish_reason: null }] },
        { usage: { prompt_tokens: 900, completion_tokens: 60 } },
      ];
    }
    // Post-compaction main loop: the summary lands as a '[ox: summary…]' user msg.
    const postCompaction = msgs.some((m) => m.role === 'user' && String(m.content ?? '').startsWith('[ox: summary'));
    if (postCompaction) {
      state.flags.postCompactionSeen = true;
      return [
        { choices: [{ index: 0, delta: { content: `The remembered fact is ${FACT}.` }, finish_reason: null }] },
        { usage: { prompt_tokens: 1200, out: 40, completion_tokens: 40 } },
      ];
    }
    if (!sys.includes('ox, a featherweight coding agent')) throw new Error('mock: unexpected system prompt');
    // Filler turn: big text + a cheap read to keep the loop alive.
    return [
      { choices: [{ index: 0, delta: { content: FILLER }, finish_reason: null }] },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: `call_fill_${state.requests.length}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `${ws}/probe.txt` }) } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 1200, completion_tokens: 300 } },
    ];
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    const compactions = r.events.filter((e) => e.t === 'compaction');
    if (!compactions.length) return { pass: false, detail: `no compaction event after ${r.requests.length} turns (est never crossed window*0.75)` };
    if (!r.flags.summaryHadFact) return { pass: false, detail: 'compaction ran but the summarized transcript lost the turn-1 fact' };
    const final = r.events.find((e) => e.t === 'final');
    const text = String(final?.message?.content ?? '');
    if (!text.includes(FACT)) return { pass: false, detail: `final answer missing fact: "${text.slice(0, 140)}"` };
    return { pass: true, detail: `compacted ${compactions[0].from}→${compactions[0].to} tok; fact survived via summary` };
  },
};
