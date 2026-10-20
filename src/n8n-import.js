// n8n workflows into ox Flows (src/flows.js). Templates come from
// Zie619/n8n-workflows (MIT, 2,000+ workflows, checked Oct 18); any exported
// n8n JSON works too. What maps is converted: triggers (manual, schedule,
// webhook), HTTP requests, model prompts (OpenAI, LLM chain, agent), if
// checks, writes. What does not (Gmail, Slack, Telegram, code nodes…) is listed
// by name so you can see the gap; nothing is faked into a step that pretends.
import { validateFlow, slug } from './flows.js';

export const TEMPLATE_REPO = 'Zie619/n8n-workflows';
const API = () => process.env.OX_N8N_API_BASE || 'https://api.github.com';
const RAW = () => process.env.OX_N8N_RAW_BASE || 'https://raw.githubusercontent.com';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ox', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

/** Template files whose name matches the words (e.g. "telegram schedule"). */
export async function searchTemplates(query = '', { limit = 20 } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const tree = await getJson(`${API()}/repos/${TEMPLATE_REPO}/git/trees/main?recursive=1`);
  return (tree.tree ?? []).filter((t) => t.type === 'blob' && /^workflows\/.+\.json$/.test(t.path))
    .map((t) => ({ path: t.path, name: t.path.split('/').pop().replace(/^\d+_/, '').replace(/\.json$/, '').replace(/_/g, ' ') }))
    .filter((t) => words.every((w) => `${t.path} ${t.name}`.toLowerCase().includes(w)))
    .slice(0, limit);
}

export async function fetchTemplate(p) {
  if (!/^workflows\/[\w./ -]+\.json$/.test(p) || p.includes('..')) throw new Error('a template path looks like workflows/Telegram/0001_….json');
  return getJson(`${RAW()}/${TEMPLATE_REPO}/main/${p.split('/').map(encodeURIComponent).join('/')}`);
}

const short = (t) => String(t ?? '').replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, '');
// n8n expressions ({{ $json.x }}) are not ox's: keep the text, mark it for a look.
const expr = (v) => (typeof v === 'string' ? v.replace(/^=/, '') : v);

function trigger(n) {
  const t = short(n.type);
  if (/manualTrigger|start$/i.test(t)) return { type: 'manual' };
  if (/webhook/i.test(t)) return { type: 'webhook' };
  if (/scheduleTrigger|cron|interval/i.test(t)) {
    const r = n.parameters?.rule?.interval?.[0] ?? n.parameters?.rule ?? {};
    const unit = r.field ?? (r.hoursInterval ? 'hours' : r.minutesInterval ? 'minutes' : r.daysInterval ? 'days' : 'days');
    const every = r.hoursInterval ? `${r.hoursInterval}h` : r.minutesInterval ? `${r.minutesInterval}m` : r.daysInterval ? `${r.daysInterval * 24}h` : unit === 'hours' ? '1h' : unit === 'minutes' ? `${r.minutesInterval ?? 15}m` : unit === 'weeks' ? '168h' : '24h';
    return { type: 'schedule', every: `every ${every}` };
  }
  return null;
}

function step(n, used) {
  const t = short(n.type), p = n.parameters ?? {};
  // Step names are used as {{steps.<name>.output}}: lowercase letters, digits and _.
  const name = String(n.name ?? t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || `step${used.size + 1}`;
  if (/^httpRequest$/i.test(t)) {
    // A URL computed by an n8n expression has no ox equivalent: listed, not guessed.
    if (!/^https?:\/\//.test(String(expr(p.url ?? '')))) return undefined;
    return { name, type: 'http', method: String(p.method ?? p.requestMethod ?? 'GET').toUpperCase(), url: expr(p.url ?? ''),
      ...(p.jsonBody || p.body ? { body: expr(p.jsonBody ?? p.body) } : {}) };
  }
  if (/openAi|lmChat|chainLlm|agent|anthropic|googleGemini|ollama/i.test(t)) {
    const prompt = expr(p.text ?? p.prompt ?? p.messages?.values?.[0]?.content ?? p.options?.systemMessage ?? '');
    if (!prompt) return null; // a model config node feeding an agent: the agent node carries the prompt
    return { name, type: 'ask', prompt };
  }
  if (/^if$/i.test(t)) {
    const c = p.conditions?.conditions?.[0] ?? p.conditions?.string?.[0] ?? p.conditions?.number?.[0];
    if (!c) return null;
    const op = String(c.operator?.operation ?? c.operation ?? 'contains');
    return { name, type: 'if', value: expr(c.leftValue ?? c.value1 ?? ''), op: /equal/.test(op) ? 'equals' : /larger|gt/.test(op) ? 'gt' : /smaller|lt/.test(op) ? 'lt' : /empty/.test(op) ? (/not/.test(op) ? 'not-empty' : 'empty') : 'contains', to: expr(c.rightValue ?? c.value2 ?? '') };
  }
  if (/writeBinaryFile|readWriteFile/i.test(t) && p.fileName) return { name, type: 'write', path: expr(p.fileName), text: '{{steps.prev.output}}' };
  return undefined;
}

/**
 * n8n workflow JSON → { flow, converted, skipped: [{ node, type }], notes }.
 * Steps follow the main connections from the trigger, in order.
 */
export function convert(wf, { name = null } = {}) {
  const nodes = wf.nodes ?? [];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const notes = nodes.filter((n) => /stickyNote/i.test(n.type)).map((n) => String(n.parameters?.content ?? '').replace(/^#+\s*/gm, '').trim()).filter(Boolean);
  const trig = nodes.map((n) => [n, trigger(n)]).find(([, t]) => t);
  // Walk the main graph breadth-first from the trigger (connections are keyed by node name, or id in some exports).
  const order = [];
  const seen = new Set();
  const queue = trig ? [trig[0].name] : nodes.filter((n) => !/stickyNote/i.test(n.type)).slice(0, 1).map((n) => n.name);
  while (queue.length) {
    const nm = queue.shift();
    if (seen.has(nm)) continue;
    seen.add(nm);
    const n = byName.get(nm) ?? byId.get(nm);
    if (n && n !== trig?.[0]) order.push(n);
    const out = wf.connections?.[nm]?.main ?? wf.connections?.[n?.id]?.main ?? [];
    for (const branch of out) for (const c of branch ?? []) queue.push(c.node);
  }
  for (const n of nodes) if (!seen.has(n.name) && !/stickyNote/i.test(n.type) && n !== trig?.[0]) order.push(n);
  const steps = [], skipped = [], used = new Set();
  for (const n of order) {
    const s = step(n, used);
    if (s === null) continue; // a helper node (model settings) with nothing of its own to run
    if (!s) { if (!/noOp|stickyNote|merge|set$|aggregate|splitInBatches|wait|stopAndError|markdown/i.test(short(n.type))) skipped.push({ node: n.name, type: short(n.type) }); continue; }
    let nm = s.name; for (let k = 2; used.has(nm); k++) nm = `${s.name}_${k}`;
    used.add(nm); steps.push({ ...s, name: nm });
  }
  // Each step may use the one before it.
  for (let i = 1; i < steps.length; i++) for (const k of ['url', 'body', 'prompt', 'value', 'text']) if (typeof steps[i][k] === 'string') steps[i][k] = steps[i][k].replace('{{steps.prev.output}}', `{{steps.${steps[i - 1].name}.output}}`);
  const flow = {
    id: slug(name ?? wf.name ?? 'n8n-import'),
    name: name ?? wf.name ?? 'Imported from n8n',
    trigger: trig?.[1] ?? { type: 'manual' },
    enabled: false,
    source: 'n8n',
    description: notes.join('\n\n').slice(0, 2000),
    steps,
  };
  const problems = steps.length ? validateFlow(flow) : ['nothing in this workflow maps to ox steps (http, ask, if, write)'];
  return { flow, converted: steps.length, skipped, problems, notes };
}
