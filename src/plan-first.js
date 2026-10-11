// Plan-First UX: present a plan before executing, let the user review/edit/approve.
// This is the most important UX differentiator for ox. It makes the agent feel
// like a careful collaborator instead of a fire-and-forget bot.
//
// Public API:
//   buildPlan({ task, ctx, config, target, cwd })
//     → { plan: { goal, steps: [{ title, reasoning, tools, estimate }] }, raw }
//
//   formatPlan(plan, opts)
//     → string — pretty-printed plan for terminal display
//
//   interactivePlanReview(plan, opts)
//     → { action: 'approve' | 'edit' | 'reject' | 'skip' }
//
//   savePlan(plan, { cwd, id })
//     → { path, id } — persists plan to .agent/plans/<slug>.json
//
//   loadPlan({ cwd, id })
//     → plan object or null

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';

const PLANS_DIR = '.agent/plans';

// Grace window for a piped answer on a non-TTY stdin before the plan gate
// gives up and declines. It bounds the wait; it never approves.
const NON_TTY_ANSWER_MS = 1000;

function ensureDir(cwd) {
  const dir = path.join(cwd, PLANS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
}

function heuristicPlan(task) {
  const steps = [];
  const lower = String(task).toLowerCase();
  if (/build|create|make|add|implement|develop/.test(lower)) steps.push({ title: 'Explore the codebase', reasoning: 'Understand the existing structure before making changes', tools: ['list_dir', 'read_file', 'grep'], estimate: '~30s' });
  if (/fix|debug|error|issue|bug/.test(lower)) steps.push({ title: 'Reproduce the issue', reasoning: 'Verify the failure mode before fixing it', tools: ['bash', 'read_file'], estimate: '~1m' });
  if (/test|spec|coverage/.test(lower)) steps.push({ title: 'Identify test runner', reasoning: 'Find the existing test framework and conventions', tools: ['grep', 'read_file'], estimate: '~30s' });
  if (steps.length === 0) steps.push({ title: 'Understand the task', reasoning: 'Read the request and identify what needs to change', tools: ['read_file', 'list_dir'], estimate: '~30s' });
  steps.push({ title: 'Make the change', reasoning: 'Apply the edit or write the new file', tools: ['edit_file', 'write_file'], estimate: '~1m' });
  if (/test|spec|coverage/.test(lower)) steps.push({ title: 'Run tests', reasoning: 'Verify the change passes existing tests', tools: ['bash'], estimate: '~1m' });
  steps.push({ title: 'Summarize', reasoning: 'Report what was done and any caveats', tools: [], estimate: '~10s' });
  return { goal: String(task).slice(0, 200), steps };
}

function parseModelPlan(text) {
  const m = text.match(/\{[\s\S]*"goal"[\s\S]*"steps"[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (parsed && parsed.goal && Array.isArray(parsed.steps)) {
      return {
        goal: String(parsed.goal),
        steps: parsed.steps.slice(0, 20).map((s) => ({
          title: String(s.title ?? s.name ?? 'Step').slice(0, 100),
          reasoning: String(s.reasoning ?? s.why ?? '').slice(0, 300),
          tools: Array.isArray(s.tools) ? s.tools.map((t) => String(t)).slice(0, 10) : [],
          estimate: String(s.estimate ?? s.time ?? '').slice(0, 30),
        })),
      };
    }
  } catch { /* fall through */ }
  return null;
}

const PLAN_PROMPT = `You are a careful software engineer. Before executing the user's task, produce a structured plan.

Task: {TASK}

Respond with JSON only (no prose outside the JSON):
{
  "goal": "<one-sentence goal>",
  "steps": [
    {
      "title": "<step title, max 60 chars>",
      "reasoning": "<why this step is needed, max 200 chars>",
      "tools": ["<tool names that will be used>"],
      "estimate": "<time estimate, e.g. ~30s>"
    }
  ]
}}

Produce 3-7 steps. Be specific. Prefer exploration before changes, verification after changes.`;

export async function buildPlan({ task, ctx = {}, config = {}, target, cwd }) {
  if (target || config?.target) {
    try {
      const t = target || config.target;
      const prompt = PLAN_PROMPT.replace('{TASK}', String(task).slice(0, 500));
      let text = '';
      for await (const ev of runAgent({
        target: t,
        messages: [{ role: 'user', content: prompt }],
        ctx: { cwd: cwd || process.cwd(), allTools: [], enableSubagents: false, depth: 0, maxDepth: 0 },
        config,
        maxIterations: 1,
        auxTarget: null,
      })) {
        if (ev.type === 'final') text = ev?.message?.content || '';
        else if (ev.type === 'text-delta' && ev.text) text += ev.text;
      }
      const parsed = parseModelPlan(text);
      if (parsed) return { plan: parsed, raw: text };
    } catch { /* fall through to heuristic */ }
  }
  return { plan: heuristicPlan(task), raw: null };
}

export function formatPlan(plan, opts = {}) {
  const width = opts.width ?? 78;
  const line = '─'.repeat(width);
  const out = [];
  out.push(line);
  out.push(`📋 Plan: ${plan?.goal || '(no goal)'}`);
  out.push(line);
  const steps = plan?.steps ?? [];
  if (steps.length === 0) {
    out.push('(no steps)');
  } else {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      out.push(`${i + 1}. ${s.title}`);
      if (s.reasoning) out.push(`   ↳ ${s.reasoning}`);
      if (Array.isArray(s.tools) && s.tools.length) out.push(`   🔧 ${s.tools.join(', ')}`);
      if (s.estimate) out.push(`   ⏱  ${s.estimate}`);
    }
  }
  out.push(line);
  out.push('Approve (A) · Edit (E) · Reject (R) · Skip (S)');
  return out.join('\n');
}

export async function interactivePlanReview(plan, opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const autoApprove = opts.autoApprove ?? false;
  if (autoApprove) return { action: 'approve' };
  // No TTY: nobody is sitting at a prompt. Plan mode exists to stop the agent
  // editing until a human says go, so the only two ways through this gate are
  // the explicit ones: --yolo (opts.autoApprove, handled above) and a real key
  // from whoever holds the pipe. Silence is a decline.
  //
  // This branch used to arm `setTimeout(() => resolve({ action: 'approve' }), 100)`,
  // which approved the gate on a timer in exactly the environment where nobody
  // is watching, and its catch-all `else` also approved on unrecognised input.
  // src/approval.js already fixes the rule for this case ("stdin is not a TTY —
  // approval prompts unavailable, declining") and this gate must never be more
  // permissive than the general approver, so the timer is now a bounded
  // fail-closed wait: it ends the wait with a decline, and it cannot approve.
  if (!stdin.isTTY) {
    const decline = (why) => {
      stdout.write(
        `\n(stdin is not a TTY — plan review has no approver, declining: ${why}. ` +
        'Re-run with --yolo (-y/--dangerously-skip-approvals) or --yes-edits to approve ' +
        'without a terminal, or run from a terminal to review the plan.)\n'
      );
      return { action: 'reject', reason: 'no-plan-approver' };
    };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        resolve(r);
      };
      const onData = (chunk) => {
        const c = chunk.toString().toLowerCase().charAt(0);
        if (c === 'a' || c === 'y') return finish({ action: 'approve', reason: 'piped-approval' });
        if (c === 'e') return finish({ action: 'edit' });
        if (c === 'r') return finish({ action: 'reject' });
        if (c === 's') return finish({ action: 'skip' });
        finish(decline('stdin carried no affirmative key'));
      };
      const onEnd = () => finish(decline('stdin closed with no answer'));
      const timer = setTimeout(
        () => finish(decline(`no answer within ${NON_TTY_ANSWER_MS}ms`)),
        NON_TTY_ANSWER_MS
      );
      stdin.once('data', onData);
      stdin.once('end', onEnd);
    });
  }
  stdout.write('\n');
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (chunk) => {
      stdin.setRawMode(false);
      stdin.pause();
      const c = chunk.toString().toLowerCase().charAt(0);
      stdout.write('\n');
      if (c === 'e') resolve({ action: 'edit' });
      else if (c === 'r') resolve({ action: 'reject' });
      else if (c === 's') resolve({ action: 'skip' });
      else resolve({ action: 'approve' });
    });
  });
}

export function savePlan(plan, { cwd, id }) {
  const dir = ensureDir(cwd || process.cwd());
  const slug = id || slugify(plan?.goal || 'plan');
  const file = path.join(dir, `${slug}.json`);
  const wrapped = { id: slug, savedAt: new Date().toISOString(), plan };
  fs.writeFileSync(file, JSON.stringify(wrapped, null, 2));
  return { path: file, id: slug };
}

export function loadPlan({ cwd, id }) {
  const dir = path.join(cwd || process.cwd(), PLANS_DIR);
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function listPlans({ cwd }) {
  const dir = path.join(cwd || process.cwd(), PLANS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
