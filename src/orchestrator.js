// Multi-agent orchestrator: coordinates a team of specialized agents to
// tackle complex tasks. From the playbook's Differentiator 3 — leap ahead
// of single-agent CLIs.
//
// Team:
//   - Planner: breaks a task into steps (no tools, structured output)
//   - Coder: executes code-writing steps
//   - Reviewer: reviews the final result for issues
//   - Tester: writes/runs tests
//   - Researcher: reads docs/code, gathers context
//   - Documenter: writes comments, READMEs
//
// Usage:
//   for await (const ev of orchestrate({ task: '...', config, target, cwd })) {
//     console.log(ev);
//   }

import { runAgent } from './agent.js';
import { pickForRole, STRATEGIES } from './model-registry.js';

export const ORCHESTRATOR_ROLES = Object.freeze([
  'planner', 'coder', 'reviewer', 'tester', 'researcher', 'documenter',
]);

const ROLE_SYSTEM_PROMPTS = {
  planner: `You are a planning agent. Given a task, produce a JSON plan with a "goal" and an array of "steps". Each step has an "agent" (planner|coder|reviewer|tester|researcher|documenter), a "task" description, and a "verify" field describing how to know the step succeeded. Keep plans under 10 steps. Do NOT execute any code or use any tools — just produce the plan as JSON.`,
  coder: `You are a coding agent. Execute the given task by writing or editing code. Use the available tools to read files, write files, and run shell commands. Be focused and concise. When the task is complete, call report_result with a summary of what you did.`,
  reviewer: `You are a code reviewer. Read the changes made by the coding step and identify bugs, style issues, security problems, and missing tests. Be specific with file:line citations. Do NOT modify any files — just produce a review.`,
  tester: `You are a testing agent. Write tests for the given code using the project's existing test framework. Run the tests to verify they pass. Use report_result when done.`,
  researcher: `You are a research agent. Read files, search the codebase, and gather information to answer the task. Do NOT modify any files. Use report_result when done with a summary of findings.`,
  documenter: `You are a documentation agent. Write or update documentation for the given code. Add JSDoc/docstrings, update READMEs, and write inline comments. Use report_result when done.`,
};

const PLANNER_OUTPUT_RE = /\{[\s\S]*"steps"[\s\S]*\}/;

function parsePlanOutput(task, rawOutput, config) {
  const match = String(rawOutput).match(PLANNER_OUTPUT_RE);
  if (!match) {
    return {
      goal: task,
      steps: [{ agent: 'coder', task, verify: 'task is complete' }],
      raw: rawOutput,
    };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const cleanSteps = steps
      .filter((s) => s && typeof s.task === 'string')
      .map((s) => ({
        agent: ORCHESTRATOR_ROLES.includes(s.agent) ? s.agent : 'coder',
        task: String(s.task).trim(),
        verify: typeof s.verify === 'string' ? s.verify : 'task is complete',
      }))
      .slice(0, config?.orchestrator?.maxSteps || 10);
    if (!cleanSteps.length) {
      cleanSteps.push({ agent: 'coder', task, verify: 'task is complete' });
    }
    return { goal: parsed.goal || task, steps: cleanSteps, raw: rawOutput };
  } catch {
    return {
      goal: task,
      steps: [{ agent: 'coder', task, verify: 'task is complete' }],
      raw: rawOutput,
    };
  }
}

// Build a plan from a task using the planner agent.
export async function buildPlan({ task, config = {}, target, cwd, hooksConfig, planner } = {}) {
  const plannerPrompt = `${ROLE_SYSTEM_PROMPTS.planner}\n\nTask: ${task}\n\nRespond with ONLY a JSON object: {"goal": "...", "steps": [...]}`;

  if (typeof planner === 'function') {
    let rawOutput = '';
    try {
      rawOutput = String(await planner(plannerPrompt) ?? '');
    } catch (err) {
      return { goal: task, steps: [], raw: '', error: String(err?.message ?? err) };
    }
    return parsePlanOutput(task, rawOutput, config);
  }

  const pickedPlanner = pickForRole('planner', {
    config,
    complexity: 0.7,
  });
  const plannerTarget = pickedPlanner || target;

  let rawOutput = '';
  try {
    for await (const ev of runAgent({
      target: plannerTarget,
      messages: [{ role: 'user', content: plannerPrompt }],
      ctx: {
        cwd: cwd || process.cwd(),
        hooksConfig,
        allTools: [],
        enableSubagents: false,
        depth: 0,
        maxDepth: 0,
      },
      config,
      maxIterations: 3,
      auxTarget: null,
    })) {
      if (ev.type === 'final') {
        rawOutput = ev?.message?.content || '';
      } else if (ev.type === 'text-delta' && ev.text) {
        rawOutput += ev.text;
      }
    }
  } catch (err) {
    return { goal: task, steps: [], raw: '', error: String(err?.message ?? err) };
  }

  return parsePlanOutput(task, rawOutput, config);
}

// Execute a single step with the appropriate agent.
async function executeStep({ step, config, target, cwd, hooksConfig, context }) {
  const role = step.agent || 'coder';
  const agent = pickForRole(role, { config, complexity: role === 'reviewer' ? 0.7 : 0.5 });
  const agentTarget = agent || target;

  const systemPrompt = ROLE_SYSTEM_PROMPTS[role] || ROLE_SYSTEM_PROMPTS.coder;
  const taskPrompt = `${systemPrompt}\n\nTask: ${step.task}\nVerify: ${step.verify}\n${context ? `\nContext from previous steps:\n${context}` : ''}`;

  let result = '';
  let ok = true;
  let error = null;
  try {
    for await (const ev of runAgent({
      target: agentTarget,
      messages: [{ role: 'user', content: taskPrompt }],
      ctx: {
        cwd: cwd || process.cwd(),
        hooksConfig,
        enableSubagents: false,
        depth: 0,
        maxDepth: 0,
      },
      config,
      maxIterations: config?.orchestrator?.maxIterationsPerStep || 15,
      auxTarget: null,
    })) {
      if (ev.type === 'final') {
        result = ev?.message?.content || '';
      } else if (ev.type === 'error') {
        ok = false;
        error = String(ev.error);
      }
    }
  } catch (err) {
    ok = false;
    error = String(err?.message ?? err);
  }
  return { result, ok, error };
}

// Run a complete plan with the team.
export async function* runPlan({ plan, config = {}, target, cwd, hooksConfig }) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    yield { type: 'error', error: 'empty or invalid plan' };
    return;
  }

  let context = '';
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    yield { type: 'step-start', step, index: i, total: plan.steps.length };
    const { result, ok, error } = await executeStep({ step, config, target, cwd, hooksConfig, context });
    yield { type: 'step-end', step, index: i, result, ok, error };
    if (ok) {
      context += `\n[Step ${i + 1} (${step.agent}): ${step.task}]\n${result}\n`;
    } else {
      context += `\n[Step ${i + 1} (${step.agent}): FAILED - ${error}]\n`;
    }
  }
  yield { type: 'plan-done', totalSteps: plan.steps.length };
}

// Run end-to-end: plan + execute + optional review.
export async function* orchestrate({ task, config = {}, target, cwd, hooksConfig, skipReview }) {
  if (config?.orchestrator?.enabled === false) {
    yield { type: 'error', error: 'orchestrator is disabled (set orchestrator.enabled: true in config)' };
    return;
  }

  yield { type: 'planning-start', task };
  const plan = await buildPlan({ task, config, target, cwd, hooksConfig });
  yield { type: 'plan', goal: plan.goal, steps: plan.steps };

  if (plan.error) {
    yield { type: 'warning', message: `planner returned: ${plan.error}` };
  }

  let context = '';
  for await (const ev of runPlan({ plan, config, target, cwd, hooksConfig })) {
    yield ev;
    if (ev.type === 'step-end' && ev.ok) {
      context += `\n[${ev.step.agent}: ${ev.step.task}]\n${ev.result}\n`;
    }
  }

  if (!skipReview && config?.orchestrator?.skipReview !== true) {
    yield { type: 'review-start' };
    const reviewStep = {
      agent: 'reviewer',
      task: `Review the work done for goal: "${plan.goal}". Identify any bugs, style issues, or missing tests.`,
      verify: 'review is complete',
    };
    const { result, ok } = await executeStep({ step: reviewStep, config, target, cwd, hooksConfig, context });
    yield { type: 'review', verdict: ok ? 'ok' : 'error', issues: result, ok };
  }

  yield { type: 'final', goal: plan.goal, stepsCompleted: plan.steps.length };
}
