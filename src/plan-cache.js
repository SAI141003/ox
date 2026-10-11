import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';

export const PLAN_CACHE_FILE = path.join(process.cwd(), '.agent', 'plan-cache.json');

const STOPWORDS = new Set(['a','an','the','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','to','of','in','for','on','with','at','by','from','as','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','and','but','or','nor','not','so','yet','both','either','neither','each','every','all','any','few','more','most','other','some','such','no','only','own','same','than','too','very','just','because','if','when','where','why','how','what','which','who','whom','this','that','these','those','it','its','he','she','they','them','their','his','her','we','our','you','your','i','me','my','myself','also','new','get','got','run','make','made','use','used','via','one','two','first','next','last','old','good','best','better','still','even','since','while','about','up','down','here','there','many','much','can','just']);

function extractKeywords(text, max = 8) {
  const words = String(text ?? '').toLowerCase().match(/[a-z]{3,}/g) || [];
  const freq = {};
  for (const w of words) {
    if (!STOPWORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

export function extractPlanTemplate({ task, plan, context }) {
  let template = String(plan ?? '');
  if (context && typeof context === 'object') {
    for (const v of Object.values(context)) {
      const s = String(v ?? '');
      if (s.length > 3) template = template.split(s).join('<context>');
    }
  }
  const taskType = String(task ?? '').split(/\s+/).filter(Boolean)[0]?.toLowerCase() || 'general';
  return { id: `p${Date.now().toString(36)}`, taskType, keywords: extractKeywords(`${task} ${template}`), template, successCount: 0, lastUsed: null, createdAt: new Date().toISOString() };
}

function scoreMatch(task, template) {
  const words = String(task ?? '').toLowerCase().match(/[a-z]{3,}/g) || [];
  let score = 0;
  for (const w of words) {
    if (template.keywords.includes(w)) score += 2;
    if (template.template.includes(w)) score += 1;
  }
  return score;
}

export function matchPlan({ task, cache }) {
  const list = Array.isArray(cache) ? cache : cache?.templates || [];
  let best = null, bestScore = 1;
  for (const t of list) {
    const s = scoreMatch(task, t);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best;
}

export async function adaptPlan({ template, context, target }) {
  const prompt = `Adapt this plan template for the new context. Keep structure, replace context-specific details.\n\nPlan: ${template.template}\n\nContext: ${JSON.stringify(context ?? {})}\n\nAdapted plan:`;
  try {
    const res = await runAgent({ target, messages: [{ role: 'user', content: prompt }], ctx: { allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 }, maxIterations: 2 });
    let text = '';
    for await (const ev of res) { if (ev.type === 'final') text = ev.message?.content || text; else if (ev.type === 'text-delta') text += ev.text; }
    return text || template.template;
  } catch { return template.template; }
}

export function savePlanTemplate({ template, keywords, taskType }) {
  const t = { ...template, keywords: keywords || extractKeywords(template.task || template.template || ''), taskType: taskType || template.taskType || 'general', lastUsed: new Date().toISOString(), successCount: (template.successCount || 0) + 1 };
  const cache = getPlanCache();
  cache.templates = cache.templates || [];
  const idx = cache.templates.findIndex((x) => x.id === t.id);
  if (idx >= 0) cache.templates[idx] = t; else cache.templates.push(t);
  fs.mkdirSync(path.dirname(PLAN_CACHE_FILE), { recursive: true });
  fs.writeFileSync(PLAN_CACHE_FILE, JSON.stringify(cache, null, 2));
  return t;
}

export function getPlanCache() {
  try { return JSON.parse(fs.readFileSync(PLAN_CACHE_FILE, 'utf8')); } catch { return { templates: [] }; }
}

export function clearPlanCache() {
  try { fs.rmSync(PLAN_CACHE_FILE, { recursive: true, force: true }); } catch {}
  return { templates: [] };
}

export class PlanCache {
  constructor() { this.templates = []; this.load(); }
  add(template) { const t = { ...template, id: template.id || `p${Date.now().toString(36)}`, createdAt: template.createdAt || new Date().toISOString(), successCount: template.successCount || 0, lastUsed: template.lastUsed || null }; this.templates.push(t); this.save(); return t; }
  match(task) { return matchPlan({ task, cache: this.templates }); }
  async adapt(task, context, target) { const t = this.match(task); if (!t) return null; return adaptPlan({ template: t, context, target }); }
  save() { fs.mkdirSync(path.dirname(PLAN_CACHE_FILE), { recursive: true }); fs.writeFileSync(PLAN_CACHE_FILE, JSON.stringify({ templates: this.templates }, null, 2)); }
  load() { try { const c = JSON.parse(fs.readFileSync(PLAN_CACHE_FILE, 'utf8')); this.templates = c.templates || []; } catch {} this.templates = this.templates.filter((t) => t && typeof t === 'object'); return this; }
  clear() { this.templates = []; this.save(); }
}
