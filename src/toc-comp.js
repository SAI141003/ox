import { estimateTokens } from './context.js';
import { runAgent } from './agent.js';

export const TOC_COMP_DEFAULTS = { maxTokens: 4000, summaryBudget: 1500, keySentenceBudget: 500, minCompressionRatio: 2.0 };

function redactSecrets(text) {
  return String(text)
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b[^\n]{0,120}/gi, '[REDACTED]');
}

export async function phase1Summarize({ content, target, budget }) {
  const safe = redactSecrets(String(content ?? ''));
  const prompt = [
    target ? `Task: ${String(target?.task || target?.bot || target?.model || 'general')}` : '',
    `Produce a concise summary within approximately ${budget} tokens.`,
    safe,
  ].filter(Boolean).join('\n');
  const parts = [];
  for await (const ev of runAgent({
    target,
    messages: [{ role: 'user', content: prompt }],
    ctx: { allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 },
    maxIterations: 3,
  })) {
    if (ev?.type === 'final') parts.push(ev.message?.content || '');
    else if (ev?.type === 'text-delta') parts.push(ev.text || '');
  }
  let summary = parts.join('\n').trim();
  if (!summary) summary = safe.slice(0, budget * 4);
  return summary;
}

export function phase2ExtractKeySentences({ summary, task, budget }) {
  const sentences = String(summary ?? '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (!sentences.length) return '';
  const kws = String(task || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = sentences.map((s) => {
    let score = 0;
    const low = s.toLowerCase();
    for (const kw of kws) if (low.includes(kw)) score += 3;
    if (!score) score = low.split(/\s+/).filter(w => w.length > 4).length;
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  const out = [];
  for (const { s } of scored) {
    const trial = out.length ? out.join(' ').length + 1 + s.length : s.length;
    if (trial > budget && out.length > 0) break;
    out.push(s);
  }
  return out.join(' ');
}

export function shouldCompress({ tokenCount, maxTokens }) {
  return Number(tokenCount) > Number(maxTokens);
}

export async function tocComp({ content, target, opts = {} }) {
  const d = { ...TOC_COMP_DEFAULTS, ...opts };
  const text = String(content ?? '');
  const originalTokens = estimateTokens(text);
  if (!target || !shouldCompress({ tokenCount: originalTokens, maxTokens: d.maxTokens })) {
    return { compressed: text, originalTokens, compressedTokens: originalTokens, ratio: 1, summary: '', keySentences: '' };
  }
  const summary = await phase1Summarize({ content, target, budget: d.summaryBudget });
  const keySentences = phase2ExtractKeySentences({ summary, task: String(target?.task || target?.bot || target?.model || ''), budget: d.keySentenceBudget });
  const compressed = keySentences || summary;
  const compressedTokens = estimateTokens(compressed);
  const ratio = originalTokens / Math.max(1, compressedTokens);
  return { compressed, originalTokens, compressedTokens, ratio, summary, keySentences };
}

export class TocComp {
  constructor(opts = {}) {
    this.opts = { ...TOC_COMP_DEFAULTS, ...opts };
    this._stats = null;
  }

  async compress(content, target) {
    this._stats = await tocComp({ content, target, opts: this.opts });
    return this._stats;
  }

  getStats() {
    return this._stats ?? { compressed: '', originalTokens: 0, compressedTokens: 0, ratio: 1, summary: '', keySentences: '' };
  }

  reset() {
    this._stats = null;
  }
}
