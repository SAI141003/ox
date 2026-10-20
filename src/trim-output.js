// Query-aware trimming of long tool output (after caveman-ai/trim-1, in ox's
// own code): when a command prints more than the model should read, keep the
// lines that matter for what was asked: errors and warnings with a little
// context, lines that share words with the request or the command, and the
// head and tail. Everything cut is said ("… 812 lines cut …"), never hidden.
const STOP = new Set('the a an and or of to in is it that this for on with as by be are was were at from but not have has had you your can will do does did run show me please what why how'.split(' '));
const SIGNAL = /\b(error|errors|failed|failure|fail|fatal|exception|traceback|panic|warn|warning|denied|refused|not found|cannot|can't|unable|timeout|timed out|assert|expected|undefined|null pointer|segfault|ERR!|✗|×)\b|^\s*at\s|:\d+:\d+/i;

export function terms(text) {
  return [...new Set(String(text ?? '').toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));
}

/**
 * Trim `text` to about `budget` characters for `query`.
 * → { text, trimmed, kept, total }
 */
export function trimForQuery(text, query = '', { budget = 12_000, head = 15, tail = 40, context = 2 } = {}) {
  const s = String(text ?? '');
  if (s.length <= budget) return { text: s, trimmed: false, kept: null, total: null };
  const lines = s.split('\n');
  const n = lines.length;
  const keep = new Uint8Array(n);
  const score = new Float32Array(n);
  const q = terms(query);
  for (let i = 0; i < Math.min(head, n); i++) keep[i] = 1;
  for (let i = Math.max(0, n - tail); i < n; i++) keep[i] = 1;
  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (SIGNAL.test(l)) score[i] += 3;
    if (q.length) { const low = l.toLowerCase(); for (const w of q) if (low.includes(w)) score[i] += 1; }
  }
  // Best lines first (with their context) until the budget is used.
  const order = [...score.keys()].filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a] || a - b);
  let used = 0;
  for (let i = 0; i < n; i++) if (keep[i]) used += lines[i].length + 1;
  for (const i of order) {
    if (used > budget) break;
    for (let j = Math.max(0, i - context); j <= Math.min(n - 1, i + context); j++) {
      if (keep[j]) continue;
      keep[j] = 1; used += lines[j].length + 1;
    }
  }
  const out = [];
  let gap = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      if (gap) { out.push(`… ${gap} line${gap > 1 ? 's' : ''} cut …`); gap = 0; }
      out.push(lines[i].length > 2000 ? `${lines[i].slice(0, 2000)}…` : lines[i]);
    } else gap++;
  }
  if (gap) out.push(`… ${gap} line${gap > 1 ? 's' : ''} cut …`);
  let result = out.join('\n');
  if (result.length > budget * 1.3) result = `${result.slice(0, Math.floor(budget * 0.4))}\n… cut …\n${result.slice(-Math.floor(budget * 0.8))}`;
  return { text: result, trimmed: true, kept: keep.reduce((a, b) => a + b, 0), total: n };
}
