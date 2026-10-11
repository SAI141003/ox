import { extractJsonObject, normalizeStreamEvent } from './agent.js';
import { costOf } from './cost.js';
import { getProvider, streamVia } from './providers/index.js';

export const PLANNER_ASK =
  'Produce a concise step-by-step implementation plan (≤200 words) for this goal.';

// --max-mode N: default 1 = off; useful range clamped to 2..5.
export function resolveMaxMode(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 1;
  if (n <= 1) return 1;
  return Math.min(5, n);
}

// Providers whose streamChat signature accepts a temperature opt (checked via
// the adapter source); unsupported adapters skip variation silently.
function adapterAcceptsTemperature(target) {
  try {
    const fn = getProvider(target?.provider)?.streamChat;
    return typeof fn === 'function' && fn.toString().includes('temperature');
  } catch {
    return false;
  }
}

async function collectCall(target, messages, signal, temperature) {
  const opts = { messages, signal };
  if (temperature != null && adapterAcceptsTemperature(target)) opts.temperature = temperature;
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of streamVia(target, opts)) {
    const ev = normalizeStreamEvent(raw);
    if (!ev) continue;
    if (ev.kind === 'text') text += ev.text;
    else if (ev.kind === 'usage') {
      usage.inputTokens += ev.usage.inputTokens;
      usage.outputTokens += ev.usage.outputTokens;
    }
  }
  return { text: text.trim(), usage };
}

function plannerMessages({ goal, i, n, cwd, tree }) {
  const sys = [
    `You are ox, a featherweight coding agent running a MiMo Max planning pass (${i + 1} of ${n}).`,
    `Workspace cwd: ${cwd}`,
    tree ? `\n# WORKSPACE TREE\n${String(tree).slice(0, 1200)}` : '',
    'Do not execute anything and do not call tools; produce only the requested plan.',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `GOAL:\n${goal}\n\n${PLANNER_ASK}` },
  ];
}

function judgeMessages({ goal, plans }) {
  const numbered = plans.map((p, i) => `Plan ${i + 1}:\n${p || '(no output)'}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a strict plan-selection judge for a coding agent. Given one goal and several numbered candidate plans, pick the single best plan. Respond with ONLY a JSON object and nothing else:\n{"best": <1-based integer>, "reason": "<one short sentence>"}',
    },
    { role: 'user', content: `GOAL:\n${goal}\n\nCANDIDATE PLANS:\n${numbered}` },
  ];
}

function parseBest(text, planCount) {
  const obj = extractJsonObject(text);
  const n = Number(obj?.best);
  if (Number.isInteger(n) && n >= 1 && n <= planCount) return n;
  return 1;
}

// N planning calls (tools omitted) + one judge call; returns the chosen plan
// plus aggregated usage so callers can fold it into totals/budget. When an
// auxiliary target is supplied, ALL planning+judge traffic goes there and the
// spend is reported separately via `aux`/`auxUsage`.
export async function runMaxModePlanning({
  target,
  goal,
  n = 2,
  signal,
  cwd = process.cwd(),
  tree = '',
  auxTarget = undefined,
  overrides = null,
} = {}) {
  const count = resolveMaxMode(n);
  const cleanGoal = String(goal ?? '').trim();
  const callTarget =
    auxTarget === undefined || auxTarget === null
      ? target
      : auxTarget && typeof auxTarget === 'object' && auxTarget.provider
        ? auxTarget
        : target;
  const usedAux = callTarget !== target && !!callTarget?.provider;
  if (count <= 1 || !cleanGoal) {
    return { skipped: true, plan: '', chosen: 0, candidates: 0, plans: [], usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null, judgeReason: '', aux: false, auxUsage: { inputTokens: 0, outputTokens: 0 } };
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  const addUsage = (u) => {
    usage.inputTokens += u?.inputTokens ?? 0;
    usage.outputTokens += u?.outputTokens ?? 0;
  };

  const plans = [];
  for (let i = 0; i < count; i++) {
    try {
      const r = await collectCall(
        callTarget,
        plannerMessages({ goal: cleanGoal, i, n: count, cwd, tree }),
        signal,
        0.7 + 0.1 * i
      );
      addUsage(r.usage);
      plans.push(r.text);
    } catch {
      plans.push('');
    }
  }

  if (!plans.some((p) => p)) {
    return {
      skipped: true,
      plan: '',
      chosen: 0,
      candidates: count,
      plans,
      usage,
      costUsd: costOf(callTarget?.model, usage, overrides),
      judgeReason: 'no planning calls produced usable output',
      aux: usedAux,
      auxUsage: { ...usage },
    };
  }

  let chosen = 1;
  let judgeReason = '';
  try {
    const j = await collectCall(callTarget, judgeMessages({ goal: cleanGoal, plans }), signal, 0);
    addUsage(j.usage);
    const obj = extractJsonObject(j.text);
    chosen = parseBest(j.text, plans.length);
    judgeReason = typeof obj?.reason === 'string' ? obj.reason : '';
  } catch {
    chosen = 1;
  }

  return {
    skipped: false,
    plan: plans[chosen - 1] ?? '',
    chosen,
    candidates: count,
    plans,
    usage,
    costUsd: costOf(callTarget?.model, usage, overrides),
    judgeReason,
    aux: usedAux,
    auxUsage: usedAux ? { ...usage } : { inputTokens: 0, outputTokens: 0 },
  };
}
