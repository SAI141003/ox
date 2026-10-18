// The company: who works here, who they report to, what each may spend, and
// how they pick up work. Paperclip's (MIT) model of a team of agents, on top
// of ox's own task board (src/tasks.js: atomic checkout, blockers, goals,
// review gates, activity):
//
//   - Org chart. Each agent has a title, a role, and reportsTo (another agent
//     or "you"). `chart` draws it.
//   - Hiring with governance. You hire directly; an agent that hires (a lead
//     building its team) only proposes, and the hire waits for your approval.
//   - Pause, resume, terminate. A paused or terminated agent is never woken.
//   - Budgets per agent, per calendar month: a warning at warnAt (80 %), a hard
//     stop at the budget that pauses the agent with the reason.
//   - Heartbeats. `beat` wakes an agent: it takes its next ready task (assigned
//     to it), runs it through its runtime, records the result and the cost.
//     `beatDue` wakes everyone whose interval has passed (the daemon or
//     `ox org beat --due` from a schedule).
//   - Runtimes: any ox bot (`ox` = your default model, `claude-plan` runs
//     Claude Code, `chatgpt-plan` Codex, `gemini-plan`, any provider model).
//     The run is `ox -p --bot <runtime>`, so sign-in, approvals and usage are
//     ox's own; cost is read back from ~/.ox/usage.jsonl for that run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readyTasks, claimTask, completeTask, taskBrief, addSpend } from './tasks.js';
import { readUsage } from './usage-log.js';

const OX_HOME = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
export const ORG_FILE = () => path.join(OX_HOME(), 'org.json');
export const AGENT_STATES = ['active', 'proposed', 'paused', 'terminated'];

const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const fileOf = (o) => o?.file ?? ORG_FILE();

export function readOrg(opts = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(opts), 'utf8'));
    return { agents: d.agents ?? {}, log: d.log ?? [], runs: d.runs ?? {} };
  } catch { return { agents: {}, log: [], runs: {} }; }
}

function writeOrg(org, opts = {}) {
  const f = fileOf(opts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  const runs = Object.fromEntries(Object.entries(org.runs ?? {}).map(([k, v]) => [k, v.slice(-50)]));
  fs.writeFileSync(tmp, JSON.stringify({ agents: org.agents, log: org.log.slice(-500), runs }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return org;
}

function note(org, by, action, agent, extra = {}) {
  org.log.push({ at: new Date().toISOString(), by, action, agent, ...extra });
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * Hire an agent. `by` is "you" (or unset) for a direct hire; anything else is
 * an agent proposing one, which waits for approveHire.
 */
export function hire(spec = {}, opts = {}) {
  const org = readOrg(opts);
  const name = String(spec.name ?? '').trim();
  if (!name) throw new Error('an agent needs a name');
  const id = spec.id ? slug(spec.id) : slug(name);
  if (!id) throw new Error('an agent needs a name with letters or digits');
  if (org.agents[id] && org.agents[id].status !== 'terminated') throw new Error(`${id} already works here`);
  const reportsTo = spec.reportsTo ? (spec.reportsTo === 'you' ? 'you' : slug(spec.reportsTo)) : 'you';
  if (reportsTo !== 'you' && !org.agents[reportsTo]) throw new Error(`no agent ${reportsTo} to report to`);
  if (reportsTo !== 'you' && chainUp(org, reportsTo).includes(id)) throw new Error('that would make a reporting loop');
  const by = opts.by ?? 'you';
  const agent = {
    id, name, title: String(spec.title ?? spec.role ?? 'Agent'), role: String(spec.role ?? spec.title ?? ''),
    reportsTo, runtime: String(spec.runtime ?? 'ox'),
    budgetUsd: spec.budgetUsd == null ? null : Math.max(0, Number(spec.budgetUsd)),
    warnAt: spec.warnAt == null ? 0.8 : Math.min(1, Math.max(0, Number(spec.warnAt))),
    heartbeatMin: spec.heartbeatMin == null ? null : Math.max(1, Number(spec.heartbeatMin)),
    instructions: spec.instructions ? String(spec.instructions) : '',
    // What the agent may do unattended: read (look only), edits (change files
    // in its folder; commands are declined), all (everything, no approvals).
    approval: ['read', 'edits', 'all'].includes(spec.approval) ? spec.approval : 'edits',
    cwd: spec.cwd ? path.resolve(String(spec.cwd)) : null,
    status: by === 'you' ? 'active' : 'proposed',
    spend: {}, lastBeat: null, hiredBy: by, hiredAt: new Date().toISOString(),
  };
  org.agents[id] = agent;
  note(org, by, by === 'you' ? 'hired' : 'proposed hire', id);
  writeOrg(org, opts);
  return agent;
}

function chainUp(org, id) {
  const out = [];
  let cur = org.agents[id];
  while (cur && !out.includes(cur.id)) { out.push(cur.id); cur = org.agents[cur.reportsTo]; }
  return out;
}

function change(id, fn, action, opts = {}) {
  const org = readOrg(opts);
  const a = org.agents[slug(id)];
  if (!a) throw new Error(`no agent ${id}`);
  const why = fn(a);
  note(org, opts.by ?? 'you', action, a.id, why ? { why } : {});
  writeOrg(org, opts);
  return a;
}

/** Only you approve a hire; an agent cannot approve its own team. */
export function approveHire(id, opts = {}) {
  if ((opts.by ?? 'you') !== 'you') throw new Error('only you can approve a hire');
  return change(id, (a) => { if (a.status !== 'proposed') throw new Error(`${a.id} is ${a.status}, not waiting for approval`); a.status = 'active'; }, 'approved hire', opts);
}
export function rejectHire(id, opts = {}) {
  if ((opts.by ?? 'you') !== 'you') throw new Error('only you can reject a hire');
  return change(id, (a) => { if (a.status !== 'proposed') throw new Error(`${a.id} is ${a.status}`); a.status = 'terminated'; }, 'rejected hire', opts);
}
export const pause = (id, opts = {}) => change(id, (a) => { if (a.status === 'terminated') throw new Error(`${a.id} is terminated`); a.status = 'paused'; a.pausedWhy = opts.why ?? 'paused by you'; return a.pausedWhy; }, 'paused', opts);
export const resume = (id, opts = {}) => change(id, (a) => {
  if (a.status !== 'paused') throw new Error(`${a.id} is ${a.status}`);
  if (overBudget(a)) throw new Error(`${a.id} is over this month's budget ($${spentThisMonth(a).toFixed(2)} of $${a.budgetUsd}); raise it first`);
  a.status = 'active'; delete a.pausedWhy;
}, 'resumed', opts);
export const terminate = (id, opts = {}) => change(id, (a) => { a.status = 'terminated'; }, 'terminated', opts);
export function update(id, patch = {}, opts = {}) {
  return change(id, (a) => {
    for (const k of ['title', 'role', 'runtime', 'instructions']) if (patch[k] != null) a[k] = String(patch[k]);
    if (patch.approval != null) { if (!['read', 'edits', 'all'].includes(patch.approval)) throw new Error('approval is read, edits or all'); a.approval = patch.approval; }
    if (patch.budgetUsd !== undefined) a.budgetUsd = patch.budgetUsd == null ? null : Math.max(0, Number(patch.budgetUsd));
    if (patch.heartbeatMin !== undefined) a.heartbeatMin = patch.heartbeatMin == null ? null : Math.max(1, Number(patch.heartbeatMin));
    if (patch.warnAt != null) a.warnAt = Math.min(1, Math.max(0, Number(patch.warnAt)));
    if (patch.reportsTo != null) {
      const org = readOrg(opts);
      const to = patch.reportsTo === 'you' ? 'you' : slug(patch.reportsTo);
      if (to !== 'you' && (!org.agents[to] || chainUp(org, to).includes(a.id))) throw new Error(`cannot report to ${patch.reportsTo}`);
      a.reportsTo = to;
    }
  }, 'updated', opts);
}

export const spentThisMonth = (a, t = Date.now()) => Number(a.spend?.[month(t)] ?? 0);
export const overBudget = (a, t = Date.now()) => a.budgetUsd != null && spentThisMonth(a, t) >= a.budgetUsd;

/** Charge an agent. Returns { warned, stopped }: a warning past warnAt, a pause at the budget. */
export function chargeAgent(id, usd, opts = {}) {
  const org = readOrg(opts);
  const a = org.agents[slug(id)];
  if (!a || !(Number(usd) > 0)) return { warned: false, stopped: false };
  const m = month(opts.now);
  const before = spentThisMonth(a, opts.now);
  a.spend = { ...a.spend, [m]: Math.round((before + Number(usd)) * 1e6) / 1e6 };
  const after = a.spend[m];
  let warned = false, stopped = false;
  if (a.budgetUsd != null) {
    if (before < a.budgetUsd * a.warnAt && after >= a.budgetUsd * a.warnAt && after < a.budgetUsd) { warned = true; note(org, 'ox', 'budget warning', a.id, { spent: after, budget: a.budgetUsd }); }
    if (after >= a.budgetUsd && a.status === 'active') { stopped = true; a.status = 'paused'; a.pausedWhy = `budget reached: $${after.toFixed(2)} of $${a.budgetUsd} this month`; note(org, 'ox', 'budget stop', a.id, { spent: after }); }
  }
  writeOrg(org, opts);
  return { warned, stopped, spent: after };
}

/** The org chart as lines: you at the top, each agent under its manager. */
export function chart(opts = {}) {
  const org = readOrg(opts);
  const all = Object.values(org.agents).filter((a) => a.status !== 'terminated' || opts.all);
  const kids = (boss) => all.filter((a) => a.reportsTo === boss).sort((x, y) => x.name.localeCompare(y.name));
  const lines = ['you'];
  const draw = (boss, pre, seen) => {
    const list = kids(boss);
    list.forEach((a, i) => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      const last = i === list.length - 1;
      const may = a.approval && a.approval !== 'edits' ? ` · ${a.approval === 'all' ? 'no approvals' : 'read only'}` : '';
      const money = a.budgetUsd != null ? ` · $${spentThisMonth(a).toFixed(2)}/$${a.budgetUsd}` : '';
      const state = a.status === 'active' ? '' : ` · ${a.status}${a.pausedWhy ? ` (${a.pausedWhy})` : ''}`;
      lines.push(`${pre}${last ? '└─ ' : '├─ '}${a.name} — ${a.title} [${a.runtime}]${money}${may}${state}`);
      draw(a.id, `${pre}${last ? '   ' : '│  '}`, seen);
    });
  };
  draw('you', '', new Set());
  return lines;
}

/** Ready tasks assigned to this agent, oldest first (claimable now). */
export function readyFor(id, opts = {}) {
  return readyTasks(opts.tasks ?? {}).filter((t) => t.assignee === slug(id));
}

function briefFor(agent, task, opts) {
  const org = readOrg(opts);
  const boss = agent.reportsTo === 'you' ? 'the owner' : `${org.agents[agent.reportsTo]?.name ?? agent.reportsTo} (${org.agents[agent.reportsTo]?.title ?? ''})`;
  return [
    `You are ${agent.name}, ${agent.title}${agent.role && agent.role !== agent.title ? ` (${agent.role})` : ''}. You report to ${boss}.`,
    agent.instructions,
    agent.budgetUsd != null ? `Budget left this month: $${Math.max(0, agent.budgetUsd - spentThisMonth(agent)).toFixed(2)}.` : '',
    taskBrief(task.id, opts.tasks ?? {}),
    'Do the task. End with a short report of what you did and what is left.',
  ].filter(Boolean).join('\n\n');
}

/** Run one task through `ox -p --bot <runtime>`; resolves { ok, output, error }. */
export function runThroughOx(agent, task, prompt, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const bin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');
    const approval = agent.approval === 'all' ? ['--dangerously-skip-approvals'] : agent.approval === 'read' ? ['--mode', 'ask'] : ['--yes-edits'];
    const args = [bin, '-p', prompt, ...approval, ...(agent.runtime && agent.runtime !== 'ox' ? ['--bot', agent.runtime] : [])];
    const child = spawn(process.execPath, args, {
      cwd: agent.cwd ?? process.cwd(),
      env: { ...process.env, OX_TASK_ID: task.id, OX_AGENT_NAME: agent.id, OX_ORG_AGENT: agent.id, OX_SURFACE: 'org' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20_000) err = err.slice(-10_000); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out, error: code === 0 ? null : (err.trim().split('\n').pop() || `exit ${code}`) }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: out, error: e.message }); });
  });
}

// ---------------------------------------------------------------- hire from a sentence

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const num = (w) => (NUM[String(w).toLowerCase()] ?? Number(w));

/**
 * What a plain sentence says about an agent (after HKUDS/AutoAgent): the
 * schedule, budget, runtime, approval level, folder and manager are read from
 * the words; a model, when one answers, adds the name, title and instructions.
 * Nothing is hired here: the caller shows the draft, and hiring stays a step.
 */
export function parseHire(sentence) {
  const s = String(sentence ?? '').trim();
  const low = s.toLowerCase();
  const out = { instructions: s };
  const name = /(?:called|named)\s+["“']?([A-Z][\w-]{1,30}(?:\s[A-Z][\w-]{1,30})?)["”']?/.exec(s) ?? /["“]([^"”]{2,30})["”]/.exec(s);
  if (name) out.name = name[1].trim();
  let m;
  if ((m = /every\s+(\d+|\w+)\s*(minutes?|mins?|hours?|hrs?|days?)/i.exec(low))) out.heartbeatMin = num(m[1]) * (/^h/.test(m[2]) ? 60 : /^d/.test(m[2]) ? 1440 : 1);
  else if (/\bhourly\b|every hour/.test(low)) out.heartbeatMin = 60;
  else if (/\bdaily\b|every (day|morning|evening|night)|each (day|morning)/.test(low)) out.heartbeatMin = 1440;
  else if (/\bweekly\b|every week/.test(low)) out.heartbeatMin = 10080;
  if ((m = /\$\s?(\d+(?:\.\d+)?)\s*(?:a|per|\/)?\s*(?:month|mo)?/.exec(s)) || (m = /budget (?:of )?(\d+(?:\.\d+)?)/i.exec(s))) out.budgetUsd = Number(m[1]);
  if (/\b(claude code|on claude|with claude|using claude)\b/.test(low)) out.runtime = 'claude-plan';
  else if (/\b(codex|chatgpt)\b/.test(low)) out.runtime = 'chatgpt-plan';
  else if (/\b(local model|locally|offline|ollama)\b/.test(low)) out.runtime = 'ox-ollama';
  if (/\b(read[- ]only|only (read|look|watch)|never (change|edit)|just (report|watch|look))\b/.test(low)) out.approval = 'read';
  else if (/\b(run commands|full access|anything it needs|no approvals)\b/.test(low)) out.approval = 'all';
  if ((m = /(?:in|on|for)\s+(~\/[\w./-]+|\/[\w./-]{2,})/.exec(s))) out.cwd = m[1].replace(/^~(?=\/)/, os.homedir()).replace(/[.,]$/, '');
  if ((m = /reports? to\s+([\w-]+)/i.exec(s))) out.reportsTo = m[1];
  // A title from the job's main verb when no model names it ("reviews PRs" → Reviewer).
  const roles = [[/\breview/, 'Reviewer'], [/\btest|\bqa\b/, 'QA engineer'], [/\bwrite|docs|blog|copy/, 'Writer'], [/\bresearch|scout|find/, 'Researcher'], [/\bfix|bug|debug/, 'Engineer'], [/\bdeploy|release|ci\b/, 'Release engineer'], [/\bsecurity|audit|vulnerab/, 'Security reviewer'], [/\bdesign|ui\b/, 'Designer'], [/\bsupport|reply|inbox|email/, 'Support'], [/\bmarket|social|post/, 'Marketer'], [/\bdata|report|metric|analy/, 'Analyst']];
  out.title = roles.find(([re]) => re.test(low))?.[1] ?? 'Agent';
  return out;
}

/** The draft: parsed facts, plus name / title / role / instructions from a model when one answers. */
export async function draftHire(sentence, { ask = null } = {}) {
  const base = parseHire(sentence);
  let extra = {};
  if (ask) {
    try {
      const text = await ask({
        system: 'You turn one sentence into an AI agent job description. Answer with JSON only: {"name": a short first name (one word), "title": a job title (2-4 words), "role": one line, "instructions": 3-6 short imperative lines joined by newlines, specific to the job}. Do not invent tools, schedules or budgets.',
        user: sentence,
      });
      const raw = String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1);
      // Models often break lines inside a JSON string: read it either way.
      let j; try { j = JSON.parse(raw); } catch { j = JSON.parse(raw.replace(/\r?\n/g, '\\n')); }
      for (const k of ['name', 'title', 'role', 'instructions']) if (typeof j[k] === 'string' && j[k].trim()) extra[k] = j[k].trim().slice(0, k === 'instructions' ? 2000 : 60);
    } catch {}
  }
  const draft = { ...base, ...extra, ...(base.name ? { name: base.name } : {}) };
  if (!draft.name) draft.name = draft.title.split(' ')[0];
  draft.instructions = `${draft.instructions}${extra.instructions && !extra.instructions.includes(sentence) ? `\n\n(Asked as: ${sentence})` : ''}`;
  draft.fromModel = Object.keys(extra).length > 0;
  return draft;
}

/** What one agent's runs cost since `since`, from the usage log (null when unpriced). */
export function costSince(agentId, since, file) {
  const rows = readUsage({ since, ...(file ? { file } : {}) }).filter((r) => r.agent === agentId && typeof r.cost === 'number');
  return rows.length ? rows.reduce((s, r) => s + r.cost, 0) : null;
}

/**
 * Wake one agent: take its next ready task, run it, record result and cost.
 * Returns { agent, state: 'idle'|'ran'|'skipped', task?, ok?, why? }.
 */
export async function beat(id, opts = {}) {
  const org = readOrg(opts);
  const a = org.agents[slug(id)];
  if (!a) throw new Error(`no agent ${id}`);
  const stamp = () => { const o = readOrg(opts); if (o.agents[a.id]) { o.agents[a.id].lastBeat = new Date(opts.now ?? Date.now()).toISOString(); writeOrg(o, opts); } };
  if (a.status !== 'active') return { agent: a.id, state: 'skipped', why: `${a.status}${a.pausedWhy ? `: ${a.pausedWhy}` : ''}` };
  if (overBudget(a, opts.now)) { pause(a.id, { ...opts, by: 'ox', why: `budget reached: $${spentThisMonth(a, opts.now).toFixed(2)} of $${a.budgetUsd} this month` }); return { agent: a.id, state: 'skipped', why: 'over budget' }; }
  const tasksOpts = opts.tasks ?? {};
  let task = null;
  for (const t of readyFor(a.id, opts)) {
    const r = claimTask(t.id, { ...tasksOpts, owner: a.id });
    if (r.ok) { task = r.task; break; }
  }
  if (!task) { stamp(); return { agent: a.id, state: 'idle' }; }
  const started = Date.now();
  const run = opts.run ?? runThroughOx;
  const r = await run(a, task, briefFor(a, task, opts));
  const cost = r.costUsd ?? costSince(a.id, started, opts.usageFile);
  if (cost != null) addSpend(task.id, cost, tasksOpts);
  completeTask(task.id, { ...tasksOpts, owner: a.id, failed: !r.ok, result: String(r.output ?? '').slice(-2000), note: r.ok ? null : String(r.error ?? 'failed').slice(0, 300) });
  const charged = cost != null ? chargeAgent(a.id, cost, opts) : { warned: false, stopped: false };
  // The agent's thread (GitBot): every run, what it was asked and what it said, to reopen later.
  { const o = readOrg(opts); (o.runs[a.id] ??= []).push({ at: new Date().toISOString(), task: task.id, title: task.title, asked: task.description ?? '', ok: r.ok, said: String(r.output ?? '').trim().slice(-1500), why: r.ok ? null : String(r.error ?? '').slice(0, 300), costUsd: cost }); note(o, a.id, r.ok ? 'finished' : 'failed', a.id, { task: task.id, why: task.title }); writeOrg(o, opts); }
  stamp();
  return { agent: a.id, state: 'ran', task: task.id, ok: r.ok, costUsd: cost, ...charged, ...(r.ok ? {} : { why: r.error }) };
}

/** One agent's thread: its runs, newest last. */
export function thread(id, opts = {}) {
  const org = readOrg(opts);
  const a = org.agents[slug(id)];
  if (!a) throw new Error(`no agent ${id}`);
  return { agent: a, runs: org.runs[a.id] ?? [] };
}

/** Say something to an agent: a task assigned to it, picked up on its next beat (or now). */
export async function tell(id, text, opts = {}) {
  const org = readOrg(opts);
  const a = org.agents[slug(id)];
  if (!a) throw new Error(`no agent ${id}`);
  const msg = String(text ?? '').trim();
  if (!msg) throw new Error('say something');
  const { addTask } = await import('./tasks.js');
  const t = addTask({ title: msg.split('\n')[0].slice(0, 120), description: msg, assignee: a.id }, { ...(opts.tasks ?? {}), actor: opts.by ?? 'you' });
  note(org, opts.by ?? 'you', 'asked', a.id, { task: t.id, why: msg.slice(0, 120) });
  writeOrg(org, opts);
  return { task: t, agent: a };
}

// What cannot be taken back: sending, publishing, pushing, deleting, paying, deploying.
const IRREVERSIBLE = [
  /\bgit\s+push\b/, /\bgh\s+(pr\s+merge|release\s+create|repo\s+delete)\b/, /\b(npm|pnpm|yarn)\s+publish\b/, /\brm\s+-[a-z]*r/, /\bdrop\s+(table|database)\b/i,
  /\b(kubectl|terraform)\s+(delete|destroy|apply)\b/, /\b(vercel|netlify|fly|railway)\b.*\b(deploy|--prod)\b/, /\bcurl\b.*-X\s*(POST|DELETE|PUT)\b/i,
];
const IRREVERSIBLE_TOOLS = /^(mail_send|send_mail|send_message|post_|publish|purchase|pay|transfer|delete_)/;
export const isIrreversible = (tool, detail = '') => IRREVERSIBLE_TOOLS.test(String(tool)) || IRREVERSIBLE.some((re) => re.test(String(detail)));

/**
 * Who did what (after the Grok Bot night-shift board): hires, approvals,
 * runs and every tool call an org agent made, newest first, with the number of
 * irreversible actions that went through.
 */
export function timeline({ limit = 100, since = 0, auditFile = null, ...opts } = {}) {
  const org = readOrg(opts);
  const items = org.log.filter((e) => Date.parse(e.at) >= since).map((e) => ({ at: e.at, agent: e.agent, by: e.by, kind: 'org', text: `${e.by === 'you' ? 'you' : e.by} ${e.action} ${e.agent}${e.why ? `: ${e.why}` : ''}`, irreversible: false }));
  let rows = [];
  try {
    const f = auditFile ?? path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'audit.jsonl');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-5000);
    const outcome = new Map();
    const decisions = [];
    for (const l of lines) { try { const r = JSON.parse(l); if (r.t === 'outcome') outcome.set(r.ref, r.ok); else if (r.agent) decisions.push(r); } catch {} }
    rows = decisions.filter((r) => Date.parse(r.ts) >= since).map((r) => {
      const done = r.decision === 'allow' && outcome.get(r.ref) !== false;
      return { at: r.ts, agent: r.agent, kind: 'tool', text: `${r.agent} ${r.decision === 'deny' ? 'was stopped from' : 'ran'} ${r.tool}${r.detail ? `: ${r.detail}` : ''}`, irreversible: done && isIrreversible(r.tool, r.detail), denied: r.decision === 'deny' };
    });
  } catch {}
  const all = [...items, ...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { items: all.slice(0, limit), irreversible: all.filter((x) => x.irreversible).length, denied: all.filter((x) => x.denied).length };
}

/** Agents whose heartbeat interval has passed (active, with an interval). */
export function dueAgents(opts = {}) {
  const now = opts.now ?? Date.now();
  return Object.values(readOrg(opts).agents).filter((a) => a.status === 'active' && a.heartbeatMin
    && (!a.lastBeat || now - Date.parse(a.lastBeat) >= a.heartbeatMin * 60_000));
}

/** Wake every agent that is due, one after another (a run at a time per machine). */
export async function beatDue(opts = {}) {
  const out = [];
  for (const a of dueAgents(opts)) out.push(await beat(a.id, opts));
  return out;
}
