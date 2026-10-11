// Rendering for the context breakdown. Kept out of cli.js so the REPL, the
// non-interactive `--context` form and the JSON stream all describe the same
// numbers the same way, and so the numbers live next to the prose that
// interprets them.
import { breakdownContext, describeLargestSegment } from './context.js';

const num = (n) => Number(n ?? 0).toLocaleString('en-US');

function pad(s, w, left = true) {
  const str = String(s ?? '');
  return left ? str.padEnd(w) : str.padStart(w);
}

function pct(n) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(1)}%`;
}

/**
 * Assemble a breakdown from the same pieces the agent sends.
 *
 * `systemPrompt` is the assembled prompt text and `messages` is the
 * conversation WITHOUT a leading system message — the caller adds the system
 * message itself so the system segment measures the real prompt object
 * (`{ role: 'system', content }`), not a bare string.
 */
export function buildContextReport({
  systemPrompt = '',
  messages = [],
  tools = [],
  window = 0,
  model = null,
  threshold = null,
  summaryPrefix = '',
} = {}) {
  const history = [
    ...(String(systemPrompt).length > 0 ? [{ role: 'system', content: String(systemPrompt) }] : []),
    ...(Array.isArray(messages) ? messages : []),
  ];
  return breakdownContext({
    messages: history,
    tools,
    window,
    threshold,
    summaryPrefix,
  });
}

export function formatContextBreakdown(
  breakdown,
  { model = null, compactionModel = null, note = null } = {}
) {
  if (!breakdown) return 'no context measured yet — send a message first';
  const { segments, total, window, windowPct, threshold, largest } = breakdown;
  const lines = [];
  const head = [
    `context breakdown${model ? ` · ${model}` : ''}${window ? ` · window ${num(window)}` : ''}`,
  ];
  lines.push(head[0], '');
  lines.push(
    `  ${pad('segment', 22)}${pad('bytes', 10, false)}  ${pad('tokens', 9, false)}  ${pad('% payload', 10, false)}  ${pad('% window', 9, false)}  ${pad('msgs', 5, false)}`
  );
  for (const s of segments) {
    const wPct = window > 0 && s.tokens > 0 ? (s.tokens / window) * 100 : null;
    lines.push(
      `  ${pad(s.label, 22)}${pad(num(s.bytes), 10, false)}  ${pad(num(s.tokens), 9, false)}  ${pad(pct(s.pctOfPayload), 10, false)}  ${pad(pct(wPct), 9, false)}  ${pad(String(s.messages), 5, false)}`
    );
  }
  lines.push(`  ${'─'.repeat(58)}`);
  lines.push(
    `  ${pad('total sent', 22)}${pad(num(total.bytes), 10, false)}  ${pad(num(total.tokens), 9, false)}  ${pad('100.0%', 10, false)}  ${pad(pct(windowPct), 9, false)}  ${pad(String(breakdown.messageCount), 5, false)}`
  );
  lines.push('');

  // The honest verdict: name the biggest segment, and say what it means.
  const biggest = segments.find((s) => s.id === largest?.id);
  lines.push(`  largest: ${describeLargestSegment(breakdown)}`);
  if (biggest?.id === 'tool-definitions' && biggest.tokens > 0) {
    lines.push(
      `  → the tool schemas are the bill here, and compaction cannot reclaim them — they are re-sent every turn.`
    );
    lines.push(`    ${num(total.tokens - biggest.tokens)} tokens are everything else combined.`);
  } else if (biggest?.id === 'system-prompt') {
    lines.push(`  → the system prompt dominates; a bigger context block (AGENTS.md, repo map) is the lever.`);
  } else if (biggest?.id === 'conversation-history') {
    lines.push(`  → conversation history dominates; /compact or a lower compact_at is the lever.`);
  } else if (biggest?.id === 'latest-input') {
    lines.push(`  → the latest user input dominates; shortening the prompt is the lever.`);
  }
  const summaries = segments.find((s) => s.id === 'conversation-history')?.summaries ?? 0;
  if (summaries > 0) {
    lines.push(`  → ${summaries} message(s) here are compaction summaries, not live turns.`);
  }
  lines.push('');

  if (threshold?.at != null && window > 0) {
    const t = threshold.tokens;
    const headroom = threshold.headroomTokens;
    const state = threshold.crossed
      ? `OVER — compaction fires on the next turn`
      : `${num(headroom)} tokens of headroom`;
    lines.push(`  auto-compaction: ${pct(threshold.at * 100)} of the window (${num(t)} tokens) — ${state}`);
  }
  if (compactionModel?.model) {
    lines.push(
      `  compaction model: ${compactionModel.model}${compactionModel.source === 'compaction_model' ? ' (dedicated)' : compactionModel.source === 'aux_bot' ? ' (aux bot)' : ' (main)'}` +
        (compactionModel.separateFromMain ? ` — cheaper than ${model ?? 'the main model'}` : '')
    );
  }
  if (note) lines.push(`  ${note}`);
  return lines.join('\n');
}

// JSON shape: the flat numbers a script wants, plus the segments verbatim.
// `thresholdAt` is echoed at the top level so a consumer does not have to reach
// into `threshold` to know whether compaction is about to fire.
export function contextBreakdownToJson(breakdown, extra = {}) {
  return {
    ...extra,
    totalBytes: breakdown.total.bytes,
    totalTokens: breakdown.total.tokens,
    window: breakdown.window,
    windowPct: breakdown.windowPct,
    largest: breakdown.largest,
    thresholdAt: breakdown.threshold.at,
    thresholdTokens: breakdown.threshold.tokens,
    thresholdCrossed: breakdown.threshold.crossed,
    headroomTokens: breakdown.threshold.headroomTokens,
    messageCount: breakdown.messageCount,
    segments: breakdown.segments,
  };
}
