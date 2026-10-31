// Modes: what kind of help a turn is. Each mode is enforced where tools are
// dispatched (src/tools/index.js), not just described to the model, so "ask"
// really cannot edit a file and "plan" really can only write plan files.
//
// `auto` is not a mode of its own: it picks one of the others per message with
// a deterministic classifier and says which one and why, so the routing can be
// checked rather than taken on trust.
import path from 'node:path';

const READ_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'todo_write', 'show_ui', 'web_search', 'web_fetch', 'mail_accounts', 'agent_status', 'code_graph'];
const PLAN_DIR = path.join('.agent', 'plans');

export const MODES = Object.freeze({
  code: {
    label: 'Code',
    desc: 'the default: reads, edits and runs, under your approval settings',
    block: '',
  },
  ask: {
    label: 'Ask',
    desc: 'answers and explanations; nothing in the project is changed',
    block: [
      '# Mode: ask',
      'Answer the question. Read code to ground the answer and cite files as path:line.',
      'You cannot edit files or run commands in this mode; do not offer to, and do not pretend you did.',
    ].join('\n'),
  },
  plan: {
    label: 'Plan',
    desc: `look and plan; the only files it can write are under ${PLAN_DIR}/`,
    block: [
      '# Mode: plan',
      'Investigate first, then write a concrete plan: the files to change, the order, the risks, and how each step will be verified.',
      `Save it with write_file under ${PLAN_DIR}/<short-name>.md. Every other change is refused in this mode.`,
    ].join('\n'),
  },
  debug: {
    label: 'Debug',
    desc: 'root cause first: reproduce, hypothesise, prove, then the smallest fix',
    block: [
      '# Mode: debug',
      '1. Reproduce the failure and quote the exact error before touching code.',
      '2. List the plausible causes and test them one at a time with evidence (logs, a failing test, a minimal script).',
      '3. Fix the cause you proved, with the smallest change. No speculative fixes.',
      '4. Re-run the reproduction and show it now passes; add a regression test when the project has tests.',
    ].join('\n'),
  },
  data: {
    label: 'Data',
    desc: 'analysis as notebook cells: each step a file in .agent/data/, run and read back',
    block: [
      '# Mode: data',
      'Work like a notebook. Each step is a new numbered cell file in .agent/data/<analysis>/ (01-load.py, 02-clean.py, ...),',
      'run with bash; read its output before writing the next cell. Print the numbers you rely on; never state a figure you did not compute.',
      'Inputs are read where they are; the only files you write are cells and results under .agent/data/.',
    ].join('\n'),
  },
  orchestrate: {
    label: 'Orchestrate',
    desc: 'splits the work and hands parts to subagents, then checks and merges their results',
    block: [
      '# Mode: orchestrate',
      'Break the request into independent parts. Delegate each part with the subagent tool, giving it a self-contained task and what "done" means.',
      'Do small glue work yourself. When results come back, verify them (read the changes, run the tests) before reporting.',
    ].join('\n'),
  },
});

export const MODE_NAMES = Object.freeze(Object.keys(MODES));

export function normalizeMode(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (n === 'orchestrator') return 'orchestrate';
  if (n === 'auto' || MODES[n]) return n;
  return null;
}

// Ordered: the first rule that matches wins. Plain words, so a reader can
// predict the route; anything unmatched is code, the default.
const RULES = [
  ['plan', /\b(plan|design|architect(ure)?|roadmap|approach|proposal|spec)\b(?!.*\b(fix|implement)\b)|^how (should|would) (i|we)\b/i, 'asks for a plan or design'],
  ['debug', /\b(bug|error|exception|crash(es|ed|ing)?|fail(s|ed|ing|ure)?|broken|doesn'?t work|not working|stack ?trace|traceback|regression|flaky|debug)\b/i, 'describes a failure'],
  ['data', /\b(analy[sz]e|analysis|csv|dataset|spreadsheet|xlsx|chart|plot|statistics|average|median|correlat\w*|trend)\b/i, 'is a data analysis'],
  ['orchestrate', /\b(in parallel|parallel(ise|ize)?|across (all|every|the whole)|each (of the|module|package|file)|multiple (services|packages|repos)|whole (codebase|repo|project)|migrate (all|every|the whole))\b/i, 'spans many independent parts'],
  ['ask', /^(what|why|how|where|which|who|when|explain|describe|is|are|does|do|can|should)\b[^]*\?\s*$|^(explain|describe|summari[sz]e|what is|what does|how does|where is|why does)\b/i, 'is a question'],
];

export function classifyMode(text) {
  const t = String(text ?? '').trim();
  if (!t) return { mode: 'code', reason: 'empty message' };
  for (const [mode, re, reason] of RULES) if (re.test(t)) return { mode, reason };
  return { mode: 'code', reason: 'a change to make' };
}

// The mode a turn actually runs in: a fixed mode, or auto's pick for this text.
// A question to answer from what the model knows, with nothing to read, run or
// look up: it is answered with no tools and the short answer prompt (about 100
// tokens instead of about 1,900 with tools, the workspace tree and skills).
const PLAIN_TOUCHES = /\b(file|files|repo|repository|project|codebase|function|class|module|component|test|tests|bug|fix|refactor|commit|branch|src|readme|this code|my code|here|folder|directory)\b|[\w-]+\.(js|ts|tsx|jsx|py|go|rs|java|rb|css|html|json|md)\b/i;
const PLAIN_NEEDS = /\b(search|look up|google|browse|latest|today|news|price|weather|open|run|install|email|mail|send|remember|forget|schedule|remind|screenshot|download|fetch|https?:\/\/|www\.|agent|build|create|make|write|generate|edit|change|update|delete|rename|add|remove|deploy)\b/i;
export function isPlainQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 400 || t.includes('\n')) return false;
  return !PLAIN_TOUCHES.test(t) && !PLAIN_NEEDS.test(t) && (/\?\s*$/.test(t) || /^(what|why|how|who|when|where|which|explain|define|tell me|is|are|can|does|do)\b/i.test(t));
}

export function resolveTurnMode(setting, text) {
  const m = normalizeMode(setting) ?? 'code';
  if (m !== 'auto') return { mode: m, routed: false, reason: null };
  const { mode, reason } = classifyMode(text);
  return { mode, routed: true, reason };
}

export function modeBlock(mode) {
  return MODES[mode]?.block ?? '';
}

// Tool gate. null = allowed; a string = why it is refused.
export function modeRefusal(mode, name, args = {}, cwd = process.cwd()) {
  if (mode === 'data') {
    if (name === 'write_file' || name === 'edit_file') {
      const p = String(args?.path ?? args?.file_path ?? '');
      const abs = path.resolve(cwd, p);
      const dir = path.resolve(cwd, '.agent', 'data');
      return p && abs.startsWith(dir + path.sep) ? null : `${name}: data mode writes only cells and results under .agent/data/; switch with /mode code to change ${p || 'files'}.`;
    }
    return null;
  }
  if (mode === 'ask') {
    return READ_TOOLS.includes(name) ? null : `${name}: ask mode only reads; switch with /mode code to make changes.`;
  }
  if (mode === 'plan') {
    if (READ_TOOLS.includes(name)) return null;
    if (name === 'write_file' || name === 'edit_file') {
      const p = String(args?.path ?? args?.file_path ?? '');
      const abs = path.resolve(cwd, p);
      const dir = path.resolve(cwd, PLAN_DIR);
      if (p && abs.startsWith(dir + path.sep) && abs.endsWith('.md')) return null;
      return `${name}: plan mode only writes plan files under ${PLAN_DIR}/*.md; switch with /mode code to change ${p || 'files'}.`;
    }
    return `${name}: plan mode is read-only apart from ${PLAN_DIR}/; switch with /mode code to run it.`;
  }
  return null;
}

// An agent sees only the tools it was granted (`ox agent new --tools ...`).
// Finishing and the todo list are always allowed: an agent must be able to say
// it is done. null = no grant list, everything the mode allows.
const ALWAYS_ALLOWED = ['report_result', 'todo_write'];
export function grantRefusal(allowed, name, agentName = 'this agent') {
  if (!Array.isArray(allowed)) return null;
  if (ALWAYS_ALLOWED.includes(name) || allowed.includes(name)) return null;
  if (name.startsWith('mcp__') && allowed.some((t) => t.endsWith('*') && name.startsWith(t.slice(0, -1)))) return null;
  return `${name}: ${agentName} is not granted this tool (granted: ${allowed.join(', ') || 'none'}).`;
}
