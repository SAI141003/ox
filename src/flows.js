// ox Flows: automations like n8n's, built into ox (no n8n to run or pay for).
//
// A flow is a trigger and a list of steps, kept in ~/.ox/flows/<id>.json:
//
//   { id, name, trigger: { type: 'manual' | 'schedule' | 'webhook', every?, secret? },
//     allowShell?: false, steps: [ { name, type, ...settings } ] }
//
// Step types (each one's output becomes {{steps.<name>.output}} for the next):
//   http     method, url, headers?, body?          → the response (JSON parsed when it is JSON)
//   ask      prompt, bot?                          → the model's answer (no tools: cheap and safe)
//   extract  from, path ("items.0.title")          → that field
//   if       value, op (contains|equals|matches|gt|lt|empty|not-empty), to?  → stops the flow when false
//   notify   title?, text                          → a macOS notification
//   write    path, text, append?                   → writes the file (inside the flow's folder or ~/ox-flows)
//   shell    command                               → only when the flow says allowShell: true; same guard as bash
//
// Every run is one line in ~/.ox/flows/runs.jsonl: when, how it started, each
// step's status, time and a short output. A failing step stops the run and says
// which and why; nothing is retried behind your back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseNaturalCadence } from './schedule.js';

export const FLOW_STEP_TYPES = Object.freeze(['http', 'ask', 'extract', 'if', 'notify', 'write', 'shell']);
export const FLOW_TRIGGERS = Object.freeze(['manual', 'schedule', 'webhook']);
const MAX_STEPS = 40;
const MAX_OUT = 200_000;

export const FLOWS_DIR = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'flows');
const RUNS = () => path.join(FLOWS_DIR(), 'runs.jsonl');
const fileOf = (id) => path.join(FLOWS_DIR(), `${id}.json`);

export function slug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'flow';
}

// ---- checking a flow ------------------------------------------------------------

export function validateFlow(flow) {
  const errs = [];
  if (!flow || typeof flow !== 'object') return ['a flow is an object'];
  if (!String(flow.name ?? '').trim()) errs.push('it needs a name');
  const t = flow.trigger ?? { type: 'manual' };
  if (!FLOW_TRIGGERS.includes(t.type)) errs.push(`trigger must be one of ${FLOW_TRIGGERS.join(', ')}`);
  if (t.type === 'schedule') {
    if (!String(t.every ?? '').trim()) errs.push('a schedule trigger needs "every", like "every 2h" or "daily at 9am"');
    else if (parseNaturalCadence(t.every).refusal) errs.push(`ox cannot read the schedule "${t.every}": say "every 30m", "every 2h", "every 1d" or "daily at 9am"`);
  }
  if (!Array.isArray(flow.steps) || !flow.steps.length) errs.push('it needs at least one step');
  else if (flow.steps.length > MAX_STEPS) errs.push(`at most ${MAX_STEPS} steps`);
  const names = new Set();
  for (const [i, s] of (flow.steps ?? []).entries()) {
    const at = `step ${i + 1}${s?.name ? ` (${s.name})` : ''}`;
    if (!s || typeof s !== 'object') { errs.push(`${at} is not an object`); continue; }
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(String(s.name ?? ''))) errs.push(`${at}: name must be lowercase letters, digits or _ (it is used as {{steps.name.output}})`);
    else if (names.has(s.name)) errs.push(`${at}: two steps are called ${s.name}`);
    names.add(s.name);
    if (!FLOW_STEP_TYPES.includes(s.type)) { errs.push(`${at}: type must be one of ${FLOW_STEP_TYPES.join(', ')}`); continue; }
    if (s.type === 'http' && !/^https?:\/\//.test(String(s.url ?? '').replace(/\{\{[^}]*\}\}/g, 'x'))) errs.push(`${at}: url must start with http:// or https://`);
    if (s.type === 'ask' && !String(s.prompt ?? '').trim()) errs.push(`${at}: needs a prompt`);
    if (s.type === 'extract' && !String(s.path ?? '').trim()) errs.push(`${at}: needs a path like items.0.title`);
    if (s.type === 'if' && !['contains', 'equals', 'matches', 'gt', 'lt', 'empty', 'not-empty'].includes(s.op)) errs.push(`${at}: op must be contains, equals, matches, gt, lt, empty or not-empty`);
    if (s.type === 'notify' && !String(s.text ?? '').trim()) errs.push(`${at}: needs text`);
    if (s.type === 'write' && (!String(s.path ?? '').trim() || s.text === undefined)) errs.push(`${at}: needs path and text`);
    if (s.type === 'shell' && !flow.allowShell) errs.push(`${at}: shell steps run only when the flow has "allowShell": true`);
    if (s.type === 'shell' && !String(s.command ?? '').trim()) errs.push(`${at}: needs a command`);
  }
  return errs;
}

// ---- storing ---------------------------------------------------------------------

export function listFlows() {
  let names = [];
  try { names = fs.readdirSync(FLOWS_DIR()).filter((f) => f.endsWith('.json')); } catch {}
  return names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FLOWS_DIR(), f), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function loadFlow(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(slug(id)), 'utf8')); } catch { return null; }
}

export function saveFlow(flow) {
  const errs = validateFlow(flow);
  if (errs.length) throw new Error(`This flow cannot be saved:\n- ${errs.join('\n- ')}`);
  const id = slug(flow.id ?? flow.name);
  const prev = loadFlow(id);
  const trigger = { type: 'manual', ...(flow.trigger ?? {}) };
  if (trigger.type === 'webhook' && !trigger.secret) trigger.secret = prev?.trigger?.secret ?? crypto.randomBytes(16).toString('hex');
  const out = { ...flow, id, trigger, createdAt: prev?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.mkdirSync(FLOWS_DIR(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileOf(id), JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

export function removeFlow(id) {
  try { fs.unlinkSync(fileOf(slug(id))); return true; } catch { return false; }
}

export function flowRuns({ id = null, limit = 30 } = {}) {
  let rows = [];
  try { rows = fs.readFileSync(RUNS(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  if (id) rows = rows.filter((r) => r.flow === slug(id));
  return rows.slice(-limit).reverse();
}

// ---- templating ----------------------------------------------------------------------

export function getPath(value, p) {
  let cur = value;
  if (typeof cur === 'string') { try { cur = JSON.parse(cur); } catch { /* text stays text */ } }
  for (const key of String(p ?? '').split('.').filter(Boolean)) {
    // A path into plain text finds nothing ("output.0" is not its first letter).
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

// {{input}}, {{input.x}}, {{steps.name.output}}, {{steps.name.output.items.0.title}}, {{now}}
export function render(template, scope, empties = null) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr) => {
    const v = renderOne(expr, scope);
    if (empties && !String(v).trim()) empties.push(`{{${expr}}}`);
    return v;
  });
}

function renderOne(expr, scope) {
  {
    if (expr === 'now') return new Date().toISOString();
    const [root, ...rest] = expr.split('.');
    if (root === 'input') return asText(rest.length ? getPath(scope.input, rest.join('.')) : scope.input);
    if (root === 'steps') {
      const [name, field = 'output', ...more] = rest;
      const st = scope.steps[name];
      if (!st) return '';
      const v = st[field];
      return asText(more.length ? getPath(v, more.join('.')) : v);
    }
    return '';
  }
}

// Strict rendering for what a step sends out or writes: an empty {{…}} means an
// earlier step did not produce what this one needs, so the step fails and says
// which value was empty (it used to carry on with a blank, and "succeed").
function strict(template, scope, where) {
  const empties = [];
  const out = render(template, scope, empties);
  if (empties.length) throw new Error(`${where}: ${[...new Set(empties)].join(', ')} ${empties.length === 1 ? 'is' : 'are'} empty, so this step cannot run (look at the step that should have produced it)`);
  return out;
}

// ---- running -------------------------------------------------------------------------

function check(op, value, to) {
  const v = asText(value), t = asText(to);
  switch (op) {
    case 'contains': return v.toLowerCase().includes(t.toLowerCase());
    case 'equals': return v.trim() === t.trim();
    case 'matches': try { return new RegExp(t, 'i').test(v); } catch { return false; }
    case 'gt': return Number(v) > Number(t);
    case 'lt': return Number(v) < Number(t);
    case 'empty': return !v.trim();
    case 'not-empty': return !!v.trim();
    default: return false;
  }
}

function writeTarget(p) {
  // Relative paths land in ~/ox-flows; absolute ones must be inside your home and not a dot-folder.
  const home = os.homedir();
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.join(home, 'ox-flows', p);
  if (!abs.startsWith(home + path.sep)) throw new Error(`write: ${p} is outside your home folder`);
  if (path.relative(home, abs).split(path.sep).some((part) => part.startsWith('.'))) throw new Error(`write: ${p} is inside a hidden folder`);
  return abs;
}

async function defaultAsk(prompt, bot, { strong = false } = {}) {
  const { quickText } = await import('./quick-text.js');
  const { resolveBot } = await import('./bots.js');
  const { readConfigDoc } = await import('./config.js');
  let doc = {}; try { doc = readConfigDoc() ?? {}; } catch {}
  // A model that can answer here: your default if it can run, else a signed-in
  // plan, a local model or a keyed provider (the app's own choice).
  let spec = bot;
  if (!spec) {
    const S = await import('./serve.js');
    await S.refreshOllama().catch(() => {});
    if (process.env.OX_NO_PLAN_CHECK !== '1') await S.refreshPlans().catch(() => {});
    // Drafting a flow is worth the strongest model connected; a step's own ask uses your default.
    spec = strong ? (S.autoModel([{ role: 'user', content: prompt }], process.env, { think: true })?.id ?? S.pickWorkingDefault()) : S.pickWorkingDefault();
  }
  const target = resolveBot(spec, { bots: doc.bots ?? {} });
  const r = await quickText(target, { system: 'You are one step in an automation. Do exactly what is asked and reply with the result only.', user: prompt, maxTokens: 800 });
  return { text: r.text.trim(), usage: r.usage, model: target.model };
}

async function defaultNotify(title, text) {
  const { spawnSync } = await import('node:child_process');
  if (process.platform !== 'darwin') return 'notifications need macOS';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240);
  spawnSync('osascript', ['-e', `display notification "${esc(text)}" with title "${esc(title)}"`], { timeout: 5000 });
  return 'shown';
}

async function defaultShell(command, cwd) {
  const { dispatchTool } = await import('./tools/index.js');
  const r = await dispatchTool('bash', { command }, { cwd, approval: 'yolo', mode: 'code' });
  if (r.isError) throw new Error(String(r.content).slice(0, 500));
  return String(r.content);
}

/** Run one flow. `io` swaps the outside world in tests: fetch, ask, notify, shell. */
export async function runFlow(flowOrId, { input = null, trigger = 'manual', io = {}, record = true } = {}) {
  const flow = typeof flowOrId === 'string' ? loadFlow(flowOrId) : flowOrId;
  if (!flow) throw new Error(`no flow called ${flowOrId}: ox flow list`);
  const errs = validateFlow(flow);
  if (errs.length) throw new Error(`This flow cannot run:\n- ${errs.join('\n- ')}`);
  const fetchImpl = io.fetch ?? fetch, ask = io.ask ?? defaultAsk, notify = io.notify ?? defaultNotify, shell = io.shell ?? defaultShell;
  const scope = { input, steps: {} };
  const run = { id: `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, flow: flow.id ?? slug(flow.name), name: flow.name, trigger, at: new Date().toISOString(), steps: [], status: 'ok' };
  const t0 = Date.now();
  for (const s of flow.steps) {
    const st = { name: s.name, type: s.type, status: 'ok', ms: 0 };
    const s0 = Date.now();
    try {
      let output;
      switch (s.type) {
        case 'http': {
          const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, strict(v, scope, `header ${k}`)]));
          const method = String(s.method ?? (s.body ? 'POST' : 'GET')).toUpperCase();
          const emptyBody = s.body === undefined || s.body === null || s.body === '' || (typeof s.body === 'object' && !Object.keys(s.body).length);
          const body = emptyBody || method === 'GET' || method === 'HEAD' ? undefined : typeof s.body === 'string' ? strict(s.body, scope, 'body') : strict(JSON.stringify(s.body), scope, 'body');
          if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
          const r = await fetchImpl(strict(s.url, scope, 'url'), { method, headers, body, signal: AbortSignal.timeout(30_000) });
          const text = (await r.text()).slice(0, MAX_OUT);
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
          if (method === 'GET' && (!text.trim() || text.trim() === 'null')) throw new Error('the answer was empty (nothing at that address)');
          try { output = JSON.parse(text); } catch { output = text; }
          st.status = 'ok';
          break;
        }
        case 'ask': {
          const r = await ask(strict(s.prompt, scope, 'prompt'), s.bot);
          output = r.text;
          if (!String(output ?? '').trim()) throw new Error('the model returned nothing');
          if (r.usage) st.tokens = (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0);
          if (r.model) st.model = r.model;
          break;
        }
        case 'extract':
          output = getPath(scope.steps[render(s.from ?? '', scope)]?.output ?? render(s.from, scope), s.path);
          if (output === undefined || output === null || output === '') throw new Error(`"${s.path}" finds nothing in ${s.from}'s result`);
          break;
        case 'if': {
          const ok = check(s.op, render(s.value, scope), render(s.to ?? '', scope));
          output = ok;
          if (!ok) { st.status = 'stopped'; st.ms = Date.now() - s0; st.out = 'condition false: the flow stops here'; run.steps.push(st); run.status = 'stopped'; scope.steps[s.name] = { output }; throw Object.assign(new Error('stop'), { stop: true }); }
          break;
        }
        case 'notify': output = await notify(render(s.title ?? flow.name, scope), strict(s.text, scope, 'text')); break;
        case 'write': {
          const file = writeTarget(render(s.path, scope));
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const text = strict(s.text, scope, 'text');
          if (s.append) fs.appendFileSync(file, `${text}\n`); else fs.writeFileSync(file, text);
          output = file;
          break;
        }
        case 'shell': output = await shell(strict(s.command, scope, 'command'), path.join(os.homedir(), 'ox-flows')); break;
      }
      scope.steps[s.name] = { output };
      st.ms = Date.now() - s0;
      st.out = asText(output).slice(0, 300);
      run.steps.push(st);
    } catch (e) {
      if (e.stop) break;
      st.status = 'failed';
      st.ms = Date.now() - s0;
      st.error = String(e?.message ?? e).slice(0, 400);
      run.steps.push(st);
      run.status = 'failed';
      run.error = `${s.name}: ${st.error}`;
      break;
    }
  }
  run.ms = Date.now() - t0;
  const last = flow.steps.map((s) => scope.steps[s.name]).filter(Boolean).pop();
  run.output = asText(last?.output).slice(0, 2000);
  if (record) {
    try { fs.mkdirSync(FLOWS_DIR(), { recursive: true, mode: 0o700 }); fs.appendFileSync(RUNS(), `${JSON.stringify(run)}\n`, { mode: 0o600 }); } catch {}
  }
  return run;
}

// ---- describe it, ox drafts it ----------------------------------------------------------

export const DRAFT_PROMPT = `You turn a description of an automation into an ox flow, as JSON only (no prose, no code fence).
Shape: {"name": "...", "trigger": {"type": "manual" | "schedule" | "webhook", "every": "every 2h" or "daily at 9am"}, "steps": [ ... ]}
Step types (each has a lowercase "name" used as {{steps.<name>.output}}):
- {"name","type":"http","method":"GET","url":"https://...","headers":{},"body":{}}  — call an API
- {"name","type":"ask","prompt":"... {{steps.x.output}} ..."}                    — a model writes or decides
- {"name","type":"extract","from":"<step name>","path":"items.0.title"}           — pick a field of JSON
- {"name","type":"if","value":"{{steps.x.output}}","op":"contains|equals|matches|gt|lt|empty|not-empty","to":"..."} — stop when false
- {"name","type":"notify","title":"...","text":"..."}                             — Mac notification
- {"name","type":"write","path":"notes/today.md","text":"...","append":true}     — write a file (relative to ~/ox-flows)
Use only public, keyless URLs you are sure of; never invent API keys. Never use shell steps.`;

export function parseDraft(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model did not return a flow');
  let flow = JSON.parse(s.slice(start, end + 1));
  delete flow.allowShell;
  flow.steps = (flow.steps ?? []).filter((x) => x?.type !== 'shell');
  // Models name steps "HN_TopPosts" or "Save titles": rename to lowercase and
  // carry every {{steps.X…}} and "from" reference along, instead of failing.
  const rename = new Map();
  for (const st of flow.steps) {
    let n = String(st?.name ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1').slice(0, 31) || 'step';
    let k = n, i = 2;
    while ([...rename.values()].includes(k)) k = `${n.slice(0, 28)}_${i++}`;
    rename.set(String(st?.name ?? ''), k);
  }
  const fix = (v) => (typeof v === 'string'
    ? v.replace(/\{\{\s*steps\.([^.}\s]+)/g, (m, name) => (rename.has(name) ? `{{steps.${rename.get(name)}` : m))
    : Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, fix(b)])) : v);
  flow = { ...flow, steps: flow.steps.map((st) => ({ ...fix(st), name: rename.get(String(st.name ?? '')), ...(st.from !== undefined ? { from: rename.get(String(st.from)) ?? fix(st.from) } : {}) })) };
  const errs = validateFlow(flow);
  if (errs.length) throw new Error(`the drafted flow has problems:\n- ${errs.join('\n- ')}`);
  return flow;
}

export async function draftFlow(description, { ask = null } = {}) {
  const prompt = `${DRAFT_PROMPT}\n\nDescription: ${String(description).slice(0, 2000)}`;
  const r = await (ask ?? ((p) => defaultAsk(p, null, { strong: true })))(prompt);
  return parseDraft(r.text);
}

// ---- schedules ------------------------------------------------------------------------

/** The flows whose schedule has come round ("every 2h", "daily at 9am"). */
export function dueFlows(now = Date.now()) {
  return listFlows().filter((f) => {
    if (f.enabled === false || f.trigger?.type !== 'schedule') return false;
    const cad = parseNaturalCadence(f.trigger.every).cadence;
    if (!cad) return false;
    const last = Date.parse(f.lastRunAt ?? '') || 0;
    if (cad.kind === 'interval') return !last || now - last >= cad.everyMs;
    if (cad.kind === 'at') {
      const [h, m] = String(cad.at).split(':').map(Number);
      const today = new Date(now); today.setHours(h, m, 0, 0);
      return now >= today.getTime() && last < today.getTime();
    }
    return false;
  });
}

/** Run every due flow once. Marked as started first, so two tickers never run it twice. */
export async function tickFlows({ now = Date.now(), io = {} } = {}) {
  const runs = [];
  for (const f of dueFlows(now)) {
    const fresh = loadFlow(f.id);
    if (!fresh || (Date.parse(fresh.lastRunAt ?? '') || 0) !== (Date.parse(f.lastRunAt ?? '') || 0)) continue;
    fs.writeFileSync(fileOf(f.id), JSON.stringify({ ...fresh, lastRunAt: new Date(now).toISOString() }, null, 2), { mode: 0o600 });
    try { runs.push(await runFlow(fresh, { trigger: 'schedule', io })); }
    catch (e) { runs.push({ flow: f.id, status: 'failed', error: String(e?.message ?? e) }); }
  }
  return runs;
}

/**
 * A dry run of the parts that only read: GET requests are made and every extract
 * is checked to find something, so a drafted flow's mistakes show before it is
 * trusted. Nothing is written, asked, notified or run. Returns the problems.
 */
export async function checkFlow(flow, { io = {} } = {}) {
  const problems = [];
  const fetchImpl = io.fetch ?? fetch;
  const scope = { input: null, steps: {} };
  for (const s of flow.steps ?? []) {
    if (s.type === 'http') {
      const method = String(s.method ?? 'GET').toUpperCase();
      if (method !== 'GET') { problems.push(`${s.name}: ${method} is not tried in a check (it could change something)`); return problems; }
      try {
        const r = await fetchImpl(render(s.url, scope), { headers: Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, render(v, scope)])), signal: AbortSignal.timeout(15_000) });
        const text = (await r.text()).slice(0, MAX_OUT);
        if (!r.ok) { problems.push(`${s.name}: ${render(s.url, scope)} answered HTTP ${r.status}`); return problems; }
        let out = text; try { out = JSON.parse(text); } catch {}
        scope.steps[s.name] = { output: out };
      } catch (e) { problems.push(`${s.name}: could not reach ${render(s.url, scope)} (${e?.message ?? e})`); return problems; }
    } else if (s.type === 'extract') {
      const v = getPath(scope.steps[render(s.from ?? '', scope)]?.output ?? render(s.from, scope), s.path);
      if (v === undefined || v === null || v === '') { problems.push(`${s.name}: "${s.path}" finds nothing in ${s.from}'s result`); return problems; }
      scope.steps[s.name] = { output: v };
    } else {
      return problems; // asks, writes and notifications are not tried in a check
    }
  }
  return problems;
}
