import { estimateTokens } from './context.js';
import { runAgent } from './agent.js';

export const SLIDING_WINDOW_SIZE = 5;

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export async function compressReasoningSteps({ reasoning, context, target }) {
  const steps = Array.isArray(reasoning) ? reasoning : [];
  if (steps.length === 0) return null;

  const stepRange = `${steps[0]?.id ?? 'start'}–${steps[steps.length - 1]?.id ?? 'end'}`;
  const combined = steps
    .map((s) => `[${s.id ?? 'step'}] ${s.text ?? s.content ?? JSON.stringify(s)}`)
    .join('\n');

  const keyDecisions = steps
    .filter((s) => s.type === 'decision' || s.type === 'conclusion' || s.isKey)
    .map((s) => s.text ?? s.content ?? '')
    .filter(Boolean)
    .slice(0, 3);

  let summary = '';
  if (target && typeof target === 'object' && target.provider) {
    try {
      const prompt = [
        'Compress the following reasoning steps into a concise digest (max 150 words).',
        'Preserve: key decisions, discoveries, unresolved questions, and next steps.',
        'Output only the digest text.',
        '',
        `CONTEXT: ${context ?? 'general reasoning'}`,
        '',
        combined,
      ].join('\n');

      const parts = [];
      for await (const ev of runAgent({
        target,
        messages: [{ role: 'user', content: prompt }],
        ctx: { allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 },
        maxIterations: 2,
      })) {
        if (ev?.type === 'final') parts.push(ev.message?.content || '');
        else if (ev?.type === 'text-delta') parts.push(ev.text || '');
      }
      summary = parts.join('\n').trim();
    } catch {}
  }

  if (!summary) {
    summary = combined.slice(0, 600);
  }

  return {
    id: generateId(),
    stepRange,
    summary,
    keyDecisions,
    timestamp: nowIso(),
  };
}

export function buildDynamicContext({ fullHistory, digests, windowSize = SLIDING_WINDOW_SIZE }) {
  const history = Array.isArray(fullHistory) ? fullHistory : [];
  const digestList = Array.isArray(digests) ? digests : [];

  const recent = history.slice(-windowSize);
  const digestText = digestList
    .map((d) => `[DIGEST ${d.id.slice(-6)}] ${d.summary}${d.keyDecisions?.length ? ` | Decisions: ${d.keyDecisions.join('; ')}` : ''}`)
    .join('\n');

  const recentText = recent
    .map((s) => `[${s.id ?? 'step'}] ${s.text ?? s.content ?? JSON.stringify(s)}`)
    .join('\n');

  const parts = [];
  if (digestText) parts.push('=== REASONING DIGESTS ===\n' + digestText);
  if (recentText) parts.push('=== RECENT REASONING ===\n' + recentText);

  const text = parts.join('\n\n');
  return {
    text,
    tokenCount: estimateTokens(text),
    digestCount: digestList.length,
    recentCount: recent.length,
  };
}

export function shouldCompress({ tokenCount, maxTokens, threshold = 0.7 }) {
  return tokenCount >= maxTokens * threshold;
}

export class ReasoningDigest {
  constructor({ maxTokens = 8000, windowSize = SLIDING_WINDOW_SIZE, target = null } = {}) {
    this.history = [];
    this.digests = [];
    this.maxTokens = maxTokens;
    this.windowSize = windowSize;
    this.target = target;
    this.maxDigests = 20;
  }

  addReasoning(step) {
    const entry = {
      id: generateId(),
      text: String(step ?? '').trim(),
      type: step?.type ?? 'reasoning',
      isKey: step?.isKey ?? false,
      timestamp: nowIso(),
    };
    this.history.push(entry);
    if (this.history.length > this.windowSize * 4) {
      this.compress().catch(() => {});
    }
    return entry;
  }

  async compress() {
    if (this.history.length <= this.windowSize) return;

    const toCompress = this.history.slice(0, -this.windowSize);
    if (toCompress.length === 0) return;

    const digest = await compressReasoningSteps({
      reasoning: toCompress,
      context: 'agent reasoning trajectory',
      target: this.target,
    });

    if (digest) {
      this.digests.push(digest);
      if (this.digests.length > this.maxDigests) {
        this.digests = this.digests.slice(-this.maxDigests);
      }
      this.history = this.history.slice(-this.windowSize);
    }
    return digest;
  }

  getContext() {
    return buildDynamicContext({
      fullHistory: this.history,
      digests: this.digests,
      windowSize: this.windowSize,
    });
  }

  getDigests() {
    return [...this.digests];
  }

  getHistory() {
    return [...this.history];
  }

  reset() {
    this.history = [];
    this.digests = [];
  }

  getTokenEstimate() {
    const { tokenCount } = this.getContext();
    return tokenCount;
  }

  shouldTriggerCompression() {
    return shouldCompress({ tokenCount: this.getTokenEstimate(), maxTokens: this.maxTokens });
  }
}

export function createReasoningDigest(opts) {
  return new ReasoningDigest(opts);
}
