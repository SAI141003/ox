// Old tool outputs, hidden. On SWE-bench Verified, replacing tool outputs older
// than the last few steps with a one-line placeholder halved the cost with no
// loss in solve rate, matching LLM summaries (arXiv 2508.21433). The agent can
// always run the call again (read the file, re-run the test) if it needs it.
//
// Cache-friendly: hiding changes earlier messages, which voids the provider's
// prompt cache from that point. So outputs are hidden in batches, only once the
// conversation is big and enough can be hidden at once, and a hidden output
// stays hidden: one cache rewrite per batch, not one per turn.

const MARK = '[hidden to save context:';

const label = (call) => {
  if (!call) return 'an earlier tool call';
  let args = {};
  try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch {}
  const what = args.path ?? args.file_path ?? args.command ?? args.pattern ?? args.query ?? args.url ?? '';
  return `${call.function?.name ?? 'tool'}${what ? `(${String(what).replace(/\s+/g, ' ').slice(0, 80)})` : ''}`;
};

/**
 * history → history with old, large tool outputs replaced (the same array when nothing changes).
 * keepRounds: the newest assistant tool-call rounds whose outputs stay in full.
 */
export function maskOldOutputs(history, { triggerChars = 120_000, batchChars = 40_000, keepRounds = 3, minChars = 800 } = {}) {
  if (!Array.isArray(history) || process.env.OX_MASK_OUTPUTS === '0') return history;
  const size = history.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length), 0);
  if (size < triggerChars) return history;
  // The boundary: outputs before the keepRounds-th newest tool-call round may be hidden.
  let rounds = 0, boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant' && Array.isArray(history[i].tool_calls) && history[i].tool_calls.length) {
      rounds++;
      if (rounds === keepRounds) { boundary = i; break; }
    }
  }
  const calls = new Map();
  for (const m of history) for (const c of (m?.role === 'assistant' && m.tool_calls) || []) calls.set(c.id, c);
  // The same output seen again later (an unchanged file read twice, a test re-run with the same result).
  const later = new Map();
  history.forEach((m, i) => { if (m?.role === 'tool' && typeof m.content === 'string' && m.content.length >= minChars) later.set(m.content, i); });
  const pick = [];
  let gain = 0;
  history.forEach((m, i) => {
    if (m?.role !== 'tool' || typeof m.content !== 'string' || m.content.startsWith(MARK) || m.content.length < minChars) return;
    if (i < boundary || later.get(m.content) > i) { pick.push(i); gain += m.content.length; }
  });
  if (gain < batchChars) return history;
  const out = history.slice();
  for (const i of pick) {
    const m = out[i];
    const dup = later.get(m.content) > i;
    out[i] = { ...m, content: `${MARK} the output of ${label(calls.get(m.tool_call_id))}, ${m.content.length.toLocaleString('en-US')} characters${dup ? ', the same as a later output' : ''}. Run the call again if you need it.]` };
  }
  return out;
}
