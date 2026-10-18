import { execSync } from 'node:child_process';
import { withTrace } from './trace.js';
import fs from 'node:fs';
import path from 'node:path';
import { breakdownContext, buildContext, estimateTokens, instructionScopesFromText, pureCompact, staleToolOutputTrim } from './context.js';
import { buildSystemPrompt, renderContractBlock } from './system-prompt.js';
import { harvestEvidence, mergeGoalTodos, progressSignature, proveGoalItems, renderGoalBlock } from './goal.js';
import { listToolSchemas, dispatchTool, pruneToolSchemas, narrowToolSchemas } from './tools/index.js';
import { LOAD_TOOLS_SCHEMA } from './tools/load-tools.js';
import { alreadyLiveBroadcast, noteSubagentBatch, noteSubagentLive } from './subagent-registry.js';
import { getProvider, streamVia } from './providers/index.js';
import { batchPlan, resolveSubagentConcurrency } from './resource-class.js';
import { assertCostBudget, costOf, currentCostBudget, lookupModel, resolveModelWindow } from './cost.js';
import { writeSessionNote } from './memory.js';
import { riskOf } from './mcp-templates.js';
import { compactionKnobs, compactionModelChoice, compactionPassKnobs, resolveAuxTarget } from './config.js';
import { applyContextOptimize } from './context-opt.js';
import { LlmFailure, normalizeFailure } from './llm-failure.js';
import { readOnlyAutoVerdict } from './approval.js';
import { generateCritique, reflect as reflectSession } from './self-improve.js';
import { recordDecision, recordOutcome } from './audit.js';
import { createVerifier } from './verify-loop.js';
import { fireHooks, formatHookOutputs, hooksFor, loadHooksConfig } from './hooks.js';
import { modeBlock, modeRefusal, grantRefusal } from './modes.js';
import { runSubscriptionTurn } from './subscriptions.js';
import { withUsageLog } from './usage-log.js';

const SUMMARY_PREFIX = '[ox: summary of earlier conversation turns]\n';
const VERIFY_MAX_ROUNDS = 2;
const PRE_COMPACTION_THRESHOLD = 0.7;
// Compaction rewrites `history` only. If the tool schemas ALONE sit over the
// trigger budget no amount of summarizing reclaims them, so without a cap the
// trigger would re-fire on every remaining turn of a run (each one burning a
// summarizer call) and never converge.
const COMPACTION_MAX_PER_RUN = 3;
const TOOL_SCHEMA_BUDGET_FLOOR = 8_000;
const SMALL_MODEL_CONTEXT_THRESHOLD = 32_000;
const SMALL_MODEL_NAME_MARKERS = Object.freeze(['qwen3', 'llama3', 'llama-3', 'phi', 'gemma']);

export function isSmallModel(modelOrTarget, contextWindow) {
  const isTarget = modelOrTarget && typeof modelOrTarget === 'object';
  const model = isTarget ? modelOrTarget.model ?? modelOrTarget.name : modelOrTarget;
  const window = isTarget
    ? contextWindow ?? modelOrTarget.contextWindow ?? modelOrTarget.window
    : contextWindow;
  const name = String(model ?? '').toLowerCase();
  const resolvedWindow = Number(window);
  return (
    (Number.isFinite(resolvedWindow) &&
      resolvedWindow > 0 &&
      resolvedWindow < SMALL_MODEL_CONTEXT_THRESHOLD) ||
    SMALL_MODEL_NAME_MARKERS.some((marker) => name.includes(marker))
  );
}
// G3 Hermes-style continuation knobs.
const TRANSPORT_MAX_RETRIES = 3;
const CONTINUATION_BUDGET = 3;
const CONTINUE_PROMPT = 'Continue exactly where you left off. Do not repeat completed text.';

// F3 goal-contract knobs: shell quality gates get their own retry counter
// (never charged against maxIterations) plus a hard wall-clock budget.
const GATE_RETRY_CAP = 3;
const GATE_BUDGET_MS = 5 * 60_000;
const CONTRACT_FIELDS = ['outcome', 'verification', 'constraints', 'boundaries', 'stop_when'];
// Module-scoped so a batch id is unique across turns, not merely within one.
let subagentBatchCounter = 0;
// Read-only tools that can be executed in parallel when all calls in a turn are read-only
const READONLY_TOOLS = Object.freeze(new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'memory_list',
  'memory_get',
  'memory_search',
  ]));
// F2 cross-provider fallback: bucket a provider failure so the turn runner can
// decide between retrying primary and bouncing to a fallback target. Auth and
// not-found are terminal for the primary (retrying cannot help); rate-limit /
// quota / server errors ride the normal transport retry budget first; null
// means generic network death, which only bounces after retries exhaust.
export function classifyProviderError(message) {
  const s = String(message ?? '');
  const low = s.toLowerCase();
  const hasStatus = (code) => new RegExp(`\\bhttp\\s*${code}\\b`).test(low);
  if (/rate.?limit|too many requests|quota/.test(low) || hasStatus(429)) return 'rate-limit';
  // "Missing API key" is local configuration: no retry can make a key appear.
  if (/unauthorized|forbidden|invalid api key|missing api key|no api key|authentication/.test(low) || hasStatus(401) || hasStatus(403)) {
    return 'auth';
  }
  // Checked before not-found: Ollama phrases it "<model> does not support tools".
  if (/does not support tools|tools? (are|is) not supported|tool[_ ]?(use|calling|choice).{0,30}not supported/.test(low)) {
    return 'no-tools';
  }
  if (/not found|no such model/.test(low) || hasStatus(404)) return 'not-found';
  if (/\bhttp\s*5\d\d\b/.test(low)) return 'server';
  // Any other 400 is a malformed request: resending it byte-identical cannot help.
  if (hasStatus(400) || hasStatus(422)) return 'bad-request';
  return null;
}

// DeepSeek dsh: map canonical LlmFailure codes to the fallback-bucket vocabulary
// the turn runner already understands (auth / rate-limit / server / network).
function failureCodeToBucket(code) {
  switch (code) {
    case LlmFailure.AUTH:
      return 'auth';
    case LlmFailure.RATE_LIMITED:
      return 'rate-limit';
    case LlmFailure.SERVER:
      return 'server';
    case LlmFailure.NETWORK:
    case LlmFailure.TIMEOUT:
      return 'network';
    default:
      return null;
  }
}

function targetLabel(t) {
  const base = `${t?.bot ?? t?.model ?? '?'}/${t?.provider ?? '?'}`;
  return t?.baseUrl ? `${base} @ ${t.baseUrl}` : base;
}

// Cost-honest routing: the canonical event for ANY active-target change.
// `announced: true` means non-dismissible — a dismissible notice is how surprise
// spend stays invisible. A bounce is turn-scoped, so the matching
// kind: 'recovery' switch is emitted by whoever re-arms the primary.
export function modelSwitchEvent({ from, to, reason, kind, cost }) {
  return { type: 'model_switch', from, to, reason, kind, cost, announced: true };
}

// Cost-honest routing: what would serving this target actually charge?
//   'free'     — no pricing entry, priced === false, a keyless local endpoint
//                (keyEnv null, e.g. ollama), or an explicitly 0/0 entry
//   'paid'     — real per-token prices, i.e. a provider bounce would spend money
//   'unknown'  — priced-looking but unusable numbers; never silently trusted
// A model with no pricing row is treated as free because ox has no evidence it
// bills anything; an explicitly malformed entry is not.
export function classifyTargetCost(target, overrides = null) {
  if (!target) return 'unknown';
  // keyless local providers (ollama) can never bill.
  if (target.keyEnv === null) return 'free';
  const pricing =
    target.pricing && typeof target.pricing === 'object'
      ? target.pricing
      : lookupModel(target.model, overrides);
  if (!pricing || pricing.priced === false) return 'free';
  const i = Number(pricing.in);
  const o = Number(pricing.out);
  if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return 'unknown';
  if (i === 0 && o === 0) return 'free';
  return 'paid';
}

// Independent goal verifier (MiMo 'Goal verifier'): strict completion auditor.
const JUDGE_PROMPT = [
  'You are a strict completion auditor for a coding agent.',
  'Judge ONLY whether the stated GOAL was achieved, using the transcript digest as your sole evidence.',
  'Ignore style, tone, wording, and implementation choices.',
  'The goal is complete only when every explicit requirement is demonstrably addressed by real work in the digest.',
  'Anything skipped, partial, promised for later, or merely described counts as incomplete.',
  'Do not invent requirements that are not stated in the goal.',
  'Respond with ONLY a JSON object and nothing else:',
  '{"complete": <true|false>, "gaps": "<short comma-separated list of unmet criteria, empty string if complete>"}',
].join('\n');

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n)}…[truncated ${str.length - n} chars]`;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function shortHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ---- F3 goal contracts -----------------------------------------------------

// Lenient `field: value` extraction for the five contract fields. Accepts
// bullet prefixes, mixed case, and `stop-when`/`stopwhen` spellings. Returns
// null when none of the five fields were found.
export function parseContractFields(text) {
  const found = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    const m = line.match(/^(outcome|verification|constraints|boundaries|stop[_\- ]?when)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase().startsWith('stop') ? 'stop_when' : m[1].toLowerCase();
    if (found[key] !== undefined) continue;
    found[key] = m[2].trim().slice(0, 400);
  }
  const keysFound = Object.keys(found).filter((k) => CONTRACT_FIELDS.includes(k));
  if (!keysFound.length) return null;
  return {
    outcome: found.outcome ?? '',
    verification: found.verification ?? '',
    constraints: found.constraints ?? '',
    boundaries: found.boundaries ?? '',
    stop_when: found.stop_when ?? '',
  };
}

// F3: draft a goal contract with ONE tools-omitted aux call asking for exactly
// five `field: value` lines. Any failure degrades silently to null.
export async function draftContract(auxTargetOrTarget, { goal, signal } = {}) {
  const target = auxTargetOrTarget;
  if (!target || typeof target !== 'object' || !String(goal ?? '').trim()) return null;
  const prompt = [
    'Draft a goal contract for the coding task below.',
    'Respond with EXACTLY five lines, each in `field: value` form, using these exact field names:',
    'outcome: what "done" concretely looks like',
    'verification: how completion is proven; may include shell quality gates as semicolon-separated segments starting with "gate: <shell cmd>"',
    'constraints: limits on scope or approach',
    'boundaries: what must NOT be touched',
    'stop_when: conditions that mean stop further work',
    'Each value is at most 40 words. Output only the five lines, nothing else.',
    '',
    `TASK: ${String(goal).trim()}`,
  ].join('\n');
  try {
    const res = await collectText(target, [{ role: 'user', content: prompt }], signal);
    return parseContractFields(res.text);
  } catch {
    return null;
  }
}

// F3: shell quality gates live in the verification field as semicolon-
// separated segments starting with 'gate:'.
export function parseGates(contract) {
  const verif = String(contract?.verification ?? '');
  return verif
    .split(';')
    .map((seg) => seg.trim())
    .filter((seg) => seg.toLowerCase().startsWith('gate:'))
    .map((seg) => seg.slice(5).trim())
    .filter(Boolean);
}

function verifierCriteriaFromContract(contract, cwd) {
  const text = String(contract?.verification ?? '').trim() || String(contract?.outcome ?? '');
  const hasExplicit = /(?:\btests?\b|\blint(?:er|ing)?\b|\bbuild(?:ing)?\b|\bsecurity\b|\baudit\b|\bchecks?\b|\bverification\b)/i.test(text);
  const allChecks = /(?:\ball\b|\bevery\b)[^.;\n]{0,40}\bchecks?\b|\bchecks?\s+(?:green|pass(?:ed|ing)?)\b|\bverification\b/i.test(text);
  const requested = {
    tests: allChecks || !hasExplicit || /(?:\btests?\b|\bnpm\s+test\b|\bunit\b|\btest\s+suite\b)/i.test(text),
    lint: allChecks || !hasExplicit || /(?:\blint(?:er|ing)?\b|\beslint\b|\bstyle\s+check\b)/i.test(text),
    build: allChecks || !hasExplicit || /(?:\bbuild(?:ing)?\b|\bcompile\b|\bbundle\b|\bpackage\b)/i.test(text),
    security: allChecks || !hasExplicit || /(?:\bsecurity\b|\baudit\b|\bvulnerabilit(?:y|ies)\b|\bdependency\s+check\b)/i.test(text),
  };
  const hasPackage = fs.existsSync(path.join(cwd, 'package.json'));
  return {
    tests: hasPackage && requested.tests,
    lint: hasPackage && requested.lint,
    build: hasPackage && requested.build,
    security: hasPackage && requested.security,
  };
}

// F3 REPL helper: /subgoal appends a criterion to the verification field.
export function applySubgoal(contract, criterion) {
  const c = criterion?.trim ? criterion.trim() : String(criterion ?? '').trim();
  if (!c) return contract;
  const cur = String(contract?.verification ?? '').trim();
  return { ...contract, verification: cur ? `${cur}; ${c}` : c };
}

// Best-effort repo-state fingerprint for gate GIT-FINGERPRINT SKIP: hash of
// `git status --porcelain` + HEAD; non-repos fall back to the file-mtime set
// of the cwd top level.
export function repoFingerprint(cwd) {
  try {
    const opts = { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    const status = execSync('git status --porcelain', opts).toString();
    const head = execSync('git rev-parse HEAD', opts).toString();
    return shortHash(`${status}\u0000${head}`);
  } catch {
    try {
      const entries = fs
        .readdirSync(cwd)
        .slice(0, 200)
        .map((f) => {
          try {
            return `${f}:${fs.statSync(path.join(cwd, f)).mtimeMs}`;
          } catch {
            return `${f}:?`;
          }
        })
        .join('|');
      return `f:${shortHash(entries)}`;
    } catch {
      return 'none';
    }
  }
}

function gateExitOf(content) {
  const m = String(content ?? '').split('\n')[0].match(/^exit (\d+|null)/);
  if (!m) return null;
  return m[1] === 'null' ? null : Number(m[1]);
}

// ---- F5 session titles ------------------------------------------------------

export function sanitizeTitle(s) {
  const t = String(s ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^[-\s]+|[\s.-]+$/g, '')
    .slice(0, 80)
    .trim();
  return t;
}

// F5: aux-model one-liner session title from the first assistant final.
export async function draftTitle(target, { text, signal } = {}) {
  if (!target || typeof target !== 'object') return null;
  const body = String(text ?? '').trim();
  if (!body) return null;
  const prompt = [
    'Write a concise session title summarizing this coding-agent answer.',
    'Rules: one line only, at most 80 characters, no quotes, no trailing period.',
    'Reply with ONLY the title text.',
    '',
    truncate(body, 1500),
  ].join('\n');
  try {
    const res = await collectText(target, [{ role: 'user', content: prompt }], signal);
    return sanitizeTitle(res.text) || null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One-line, bounded reason string for transport-failure events.
function shortNetReason(s) {
  const line = (String(s ?? 'unknown').split('\n').find((l) => l.trim()) ?? 'unknown').trim();
  return truncate(line, 120);
}

export function extractJsonObject(s) {
  const text = String(s ?? '').replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function buildDigest(history, finalText, cap = 4000) {
  const parts = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'user') {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      parts.push(`[user] ${truncate(body, 600)}`);
    } else if (Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        parts.push(`[tool] ${c?.function?.name ?? '?'}(${truncate(String(c?.function?.arguments ?? ''), 120)})`);
      }
    }
  }
  parts.push(`[assistant-final] ${truncate(String(finalText ?? ''), 1500)}`);
  let out = '';
  for (const part of parts) {
    if (!out) out = part;
    else if (out.length + 1 + part.length <= cap) out += `\n${part}`;
    else break;
  }
  return out.slice(0, cap);
}

async function judgeGoal(target, { goal, contract, digest }, signal) {
  // F3: when a goal contract is present, the auditor judges the CONTRACT
  // fields (outcome/verification/constraints/boundaries/stop_when) instead of
  // the raw goal text.
  const source = contract ? contractSource(contract) : String(goal ?? '');
  const res = await collectText(
    target,
    [
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `GOAL:\n${source}\n\nTRANSCRIPT DIGEST:\n${digest}` },
    ],
    signal
  );
  const parsed = extractJsonObject(res.text);
  if (!parsed) {
    return { complete: false, gaps: truncate(res.text || 'verdict unparsable', 400), usage: res.usage };
  }
  return {
    complete: parsed.complete === true,
    gaps: typeof parsed.gaps === 'string' ? parsed.gaps : '',
    usage: res.usage,
  };
}

export function tokensOf(messages) {
  return messages.reduce((n, m) => n + estimateTokens(JSON.stringify(m ?? {})), 0);
}

// The tool-schema array travels to streamVia as `tools`, SEPARATE from
// `messages`, so it is never part of `history` and compaction cannot rewrite
// it. A history-only estimate therefore under-reports every request by the
// whole schema block. Measure the serialized schema payload with the SAME
// estimator so both terms share units; an empty (no-tools) offer is exactly 0.
export function toolSchemaTokens(tools) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  return list.length ? estimateTokens(JSON.stringify(list)) : 0;
}

// The FULL payload ox is about to send: history PLUS tool schemas.
export function payloadTokens(messages, tools) {
  return tokensOf(messages) + toolSchemaTokens(tools);
}

function modelWindow(ctx, model, config) {
  return resolveModelWindow({
    model,
    configWindow: ctx?.modelWindow ?? config?.modelWindow,
    env: process.env,
  });
}

export function normalizeStreamEvent(raw) {
  if (typeof raw === 'string') return raw ? { kind: 'text', text: raw } : null;
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type ?? raw.event ?? '';
  if (type === 'text-delta' || type === 'text') {
    const t = raw.text ?? raw.content ?? '';
    return t ? { kind: 'text', text: t } : null;
  }
  if (type === 'tool-call' || type === 'tool_call' || raw.tool_call) {
    return { kind: 'call', call: raw.tool_call ?? raw.call ?? raw };
  }
  if (type === 'tool-calls' || type === 'tool_calls') {
    const calls = raw.calls ?? raw.tool_calls ?? [];
    return Array.isArray(calls) && calls.length ? { kind: 'calls', calls } : null;
  }
  if (type === 'usage' || (!type && raw.usage)) {
    const u = raw.usage ?? raw;
    const i = u.inputTokens ?? u.input_tokens ?? u.prompt_tokens ?? u.in ?? 0;
    const o = u.outputTokens ?? u.output_tokens ?? u.completion_tokens ?? u.out ?? 0;
    const cr = Number(u.cacheReadTokens) || 0;
    const cw = Number(u.cacheWriteTokens) || 0;
    if (Number(i) || Number(o)) {
      return { kind: 'usage', usage: { inputTokens: Number(i) || 0, outputTokens: Number(o) || 0, ...(cr ? { cacheReadTokens: cr } : {}), ...(cw ? { cacheWriteTokens: cw } : {}) } };
    }
    return null;
  }
  if (
    type === 'done' ||
    type === 'end' ||
    type === 'stop' ||
    type === 'finish' ||
    type === 'message_stop' ||
    type === 'message-end'
  ) {
    return { kind: 'done', stopReason: raw.stopReason ?? raw.stop_reason ?? raw.finish_reason ?? null };
  }
  if (type === 'error') {
    const e = raw.error ?? raw.message ?? raw;
    return { kind: 'error', message: e?.message ?? String(e) };
  }
  return null;
}

function makeCallAccumulator() {
  const slots = [];
  const slotFor = (ev) => {
    const idx = Number.isInteger(ev.index) && ev.index >= 0 ? ev.index : -1;
    let slot;
    if (idx >= 0) {
      while (slots.length <= idx) slots.push(null);
      if (!slots[idx]) slots[idx] = { id: '', name: '', args: '' };
      slot = slots[idx];
    } else {
      slot = { id: '', name: '', args: '' };
      slots.push(slot);
    }
    return slot;
  };
  return {
    add(ev) {
      const slot = slotFor(ev);
      const id = ev.id ?? ev.call_id ?? ev.tool_call_id;
      if (id && !slot.id) slot.id = id;
      const name = ev.name ?? ev.function?.name;
      if (name && !slot.name) slot.name = name;
      const indexed = Number.isInteger(ev.index) && ev.index >= 0;
      const explicitDelta =
        ev.argumentsDelta ?? ev.argument_delta ?? ev.partial_json ?? ev.function?.arguments_delta;
      if (explicitDelta !== undefined) {
        if (typeof explicitDelta === 'string') slot.args += explicitDelta;
        else if (explicitDelta && typeof explicitDelta === 'object') slot.args += JSON.stringify(explicitDelta);
        return;
      }
      const full = ev.arguments ?? ev.function?.arguments ?? ev.input ?? ev.args;
      if (full !== undefined) {
        if (indexed && typeof full === 'string') slot.args += full;
        else if (typeof full === 'string') slot.args = full;
        else slot.args = JSON.stringify(full);
      }
    },
    finish() {
      return slots
        .filter(Boolean)
        .map((s, i) => ({
          id: s.id || `call_${i}`,
          type: 'function',
          function: { name: s.name || 'unknown', arguments: s.args || '{}' },
        }));
    },
  };
}

export function sanitizeHistory(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m !== 'object') continue;
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
    const answered = new Set();
    let j = i + 1;
    while (j < list.length && list[j]?.role === 'tool') {
      if (list[j].tool_call_id != null) answered.add(list[j].tool_call_id);
      j++;
    }
    for (let k = i + 1; k < j; k++) out.push(list[k]);
    for (const c of m.tool_calls) {
      const id = c?.id;
      if (id != null && !answered.has(id)) {
        out.push({ role: 'tool', tool_call_id: id, content: '[not executed: interrupted]' });
        answered.add(id);
      }
    }
    i = j - 1;
  }
  return out;
}

async function collectText(target, messages, signal) {
  let out = '';
  const usage = { inputTokens: 0, outputTokens: 0 };
  for await (const raw of streamVia(target, { model: target?.model, messages, signal })) {
    const ev = normalizeStreamEvent(raw);
    if (!ev) continue;
    if (ev.kind === 'text') out += ev.text;
    else if (ev.kind === 'usage') {
      usage.inputTokens += ev.usage.inputTokens;
      usage.outputTokens += ev.usage.outputTokens;
    }
  }
  return { text: out.trim(), usage };
}

// Wave5b I: the compaction summarizer prompt. detail level maps to a word
// budget (none=80, minimal=150, balanced=300, verbose=500) via config.
export function buildSummarizePrompt(transcript, { wordBudget = 300 } = {}) {
  const n = Number(wordBudget);
  const budget = Number.isFinite(n) && n > 0 ? Math.round(n) : 300;
  return [
    'Summarize the following coding-agent conversation excerpt so work can continue seamlessly.',
    `In ${budget} words or fewer preserve: decisions made, files touched (with absolute paths),`,
    'unresolved bugs/errors with their exact messages, and pending next steps.',
    '',
    transcript,
  ].join('\n');
}

function contractSource(contract) {
  return CONTRACT_FIELDS.filter((f) => String(contract?.[f] ?? '').trim())
    .map((f) => `${f}: ${String(contract[f]).trim()}`)
    .join('\n');
}

export async function summarizeMessages(target, toSummarize, signal, opts = {}) {
  const transcript = toSummarize
    .map((m) => {
      const role = m?.role ?? '?';
      if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
        const calls = m.tool_calls
          .map((c) => `${c?.function?.name ?? '?'}(${truncate(c?.function?.arguments ?? '', 200)})`)
          .join('; ');
        return `[${role}] called tools: ${calls}`;
      }
      if (role === 'tool') return `[tool result for ${m?.tool_call_id ?? '?'}] ${truncate(m?.content ?? '', 400)}`;
      const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      return `[${role}] ${truncate(body, 2000)}`;
    })
    .join('\n');
  const first = await collectText(
    target,
    [{ role: 'user', content: buildSummarizePrompt(transcript, { wordBudget: opts.wordBudget }) }],
    signal
  );
  // Wave5b I second pass: distill further against the goal contract (when one
  // is present). Failure keeps the first-pass summary; usage is accumulated.
  if (opts.twoPass !== true || !first.text) return first;
  const lines = ['Distill further to what remains ACTIONABLE for the stated goal.'];
  const contractText = contractSource(opts.goalContract);
  if (contractText) lines.push('', `STATED GOAL:\n${contractText}`);
  lines.push('', 'SUMMARY:', first.text);
  try {
    const second = await collectText(target, [{ role: 'user', content: lines.join('\n') }], signal);
    if (second.text) {
      return {
        text: second.text,
        usage: {
          inputTokens: first.usage.inputTokens + second.usage.inputTokens,
          outputTokens: first.usage.outputTokens + second.usage.outputTokens,
        },
      };
    }
  } catch {}
  return first;
}

function needsApproval(name, ctx) {
  if (ctx?.yolo) return false;
  if (name === 'bash') return true;
  // Making an image or video spends money (or GPU time): always asked.
  if (name === 'create_media' || name === 'install_skill') return true;
  if (name.startsWith('mcp__')) return true;
  if (name === 'write_file' || name === 'edit_file') {
    return (ctx?.approval ?? 'default') === 'default';
  }
  return false;
}

export function parseMcpToolName(name) {
  const n = String(name ?? '');
  if (!n.startsWith('mcp__')) return null;
  const rest = n.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

// v3b risk-gated MCP policy resolution for a `mcp__<server>__<tool>` call.
// Precedence: explicit mcpPolicy entry (project .ox.json / global ~/.ox/config.json)
// > template risk default (read-only|write|money → 'ask') > 'ask'.
// A money-risk server may keep an explicit 'allow' ONLY when the entry came from
// the GLOBAL config or --side-effects-ok is present; otherwise it downgrades to
// 'ask' with a one-time stderr warning naming the proper authorization path.
export function resolveMcpPolicy(name, ctx = {}, warned = new Set()) {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { decision: 'ask', risk: null, source: null };
  const pctx = ctx?.mcpPolicyContext && typeof ctx.mcpPolicyContext === 'object' ? ctx.mcpPolicyContext : {};
  const policy = pctx.policy && typeof pctx.policy === 'object' ? pctx.policy : {};
  const origins = pctx.origins && typeof pctx.origins === 'object' ? pctx.origins : {};
  const hasEntry = Object.prototype.hasOwnProperty.call(policy, parsed.server);
  const risk = riskOf(parsed.server);
  let decision = hasEntry ? String(policy[parsed.server]).toLowerCase() : 'ask';
  let source = hasEntry ? origins[parsed.server] ?? 'project' : null;
  if (decision === 'allow' && risk === 'money') {
    const authorized = source === 'global' || pctx.sideEffectsOk === true;
    if (!authorized) {
      decision = 'ask';
      if (!warned.has(parsed.server)) {
        warned.add(parsed.server);
        process.stderr.write(
          `ox: policy downgrade — money-risk MCP server '${parsed.server}' stays approval-gated: ` +
            `a project-scope mcpPolicy 'allow' cannot self-authorize spend. Authorize properly by moving the entry ` +
            `into ~/.ox/config.json mcpPolicy (global trust) or re-running with --side-effects-ok.\n`
        );
      }
    }
  }
  return { decision, risk, source };
}

async function askApproval(ctx, name, args, detail) {
  if (typeof ctx?.requestApproval !== 'function') return false;
  try {
    return (await ctx.requestApproval(name, args, detail)) === true;
  } catch {
    return false;
  }
}

function approvalDetail(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'bash') return truncate(String(a.command ?? ''), 300);
  if (a.path) return `${name}: ${a.path}`;
  try {
    return truncate(JSON.stringify(a), 300);
  } catch {
    return name;
  }
}

// ---- parallel subagent batches: the gate ------------------------------------
//
// The rule this replaces was STRUCTURAL, and its strength has to be stated
// honestly before it is replaced. `subagent` is classified approval_gated, and
// src/agent.js refused the whole turn whenever a batch carried one alongside
// anything else -- so the gate on delegation was not an interactive prompt at
// all (needsApproval('subagent') is false; a single call ran under
// auto-allow), it was "this many things at once is never allowed", applied per
// turn. That is what actually stood between a model and an unbudgeted fan-out.
//
// The replacement is at least as strong on every axis that matters:
//
//   * It is EXPLICIT where the old rule was structural. An approver is asked
//     about the whole batch, and the prompt carries EVERY task in it -- a
//     confirmation that says "3 subagents?" and hides what they are authorises
//     a number, not the work.
//   * It is ALL-OR-NOTHING. One refusal refuses the entire batch and nothing
//     runs. The old rule was strictly weaker here: it authorised nothing but it
//     also never had to unwind half a batch, because half a batch was
//     structurally impossible.
//   * It does not run unattended. With no approver attached -- a non-TTY
//     headless run, a script, an agent embedding ox as a library -- the fan-out
//     DEGRADES TO SERIAL rather than proceeding. The thing being authorised is
//     the concurrency, so no approver means no concurrency; what the caller
//     asked for still runs, one at a time, which is exactly what the old rule
//     forced anyway. Degrading is not the same as refusing, and the difference
//     is deliberate: refusing would take a capability away from every scripted
//     run that uses delegation today.
//   * The cap holds even under `--yolo`. Yolo answers "yes to the tools"; it is
//     not a licence to raise a resource ceiling.
//
// Everything the normal path enforces still runs inside each lane: doom-loop
// detection, PreToolUse/PostToolUse hooks, the audit decision/outcome pair,
// per-agent cost ceilings, and the abort check.
export const BATCH_APPROVAL_TOOL = 'subagent';

// Readable FIRST in the args object, because that is what the interactive
// approver renders (renderDetail -> JSON.stringify(args), truncated at 300
// chars). Leading with `{batch: <the whole list>}` puts the operator-facing
// text in the surviving prefix instead of the machine-readable tail.
function parallelBatchArgs(batchCalls) {
  const lines = batchCalls.map((call, i) => {
    const parsed = safeJsonParse(call.function.arguments || '{}');
    const a = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const task = truncate(String(a.task ?? '(no task)').replace(/\s+/g, ' ').trim(), 140);
    const desc = a.description ? ` (${truncate(String(a.description).replace(/\s+/g, ' '), 60)})` : '';
    return `  ${i + 1}. ${task}${desc}`;
  });
  return {
    batch: `${batchCalls.length} subagent${batchCalls.length === 1 ? '' : 's'} in this turn:\n${lines.join('\n')}`,
    count: batchCalls.length,
    tasks: batchCalls.map((c) => {
      const parsed = safeJsonParse(c.function.arguments || '{}');
      const a = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      return truncate(String(a.task ?? ''), 140);
    }),
  };
}

async function resolveParallelBatchGate(ctx, batchCalls) {
  const args = parallelBatchArgs(batchCalls);
  const detail = args.batch;
  // No approver anywhere. Serial is the safe direction: the fan-out still
  // happens, it just does not pretend someone authorised the concurrency.
  if (typeof ctx?.requestApproval !== 'function') {
    return { mode: 'serial', gateActor: 'policy', gateRule: 'no-approver:serial', args, detail };
  }
  // One prompt for the whole batch, through the SAME approver every other gated
  // tool goes through -- so --yolo, accept-edits, plan mode and the sandbox
  // denies keep exactly the precedence they have everywhere else, and none of
  // them has to be re-implemented here to be respected.
  const ok = await askApproval(ctx, BATCH_APPROVAL_TOOL, args, detail);
  if (ok) return { mode: 'concurrent', gateActor: 'approval', gateRule: 'user-approved-batch', args, detail };
  return { mode: 'deny', gateActor: 'approval', gateRule: 'user-declined-batch', args, detail };
}

// ---- the fan-out cost division ----------------------------------------------
//
// `--max-cost` is RUN-scoped (createCostBudget wraps the whole run in
// AsyncLocalStorage; the transport asserts and records against whatever budget
// is in scope). A subagent therefore inherits the session cap rather than a cap
// of its own, and a fan-out multiplies what that one cap can buy: three agents
// at the iteration budget is three times the spend of one.
//
// Two ceilings, both enforced, both visible:
//
//   AGGREGATE -- the session budget, unchanged and still enforced by
//     providers/index.js on every model call a subagent makes, so the sum of
//     what a fan-out spends still cannot exceed the cap the operator set. The
//     batch is REFUSED UP FRONT when there is no headroom left to divide, which
//     is the fail-closed direction: an over-cap turn spawns nothing at all
//     rather than spawning N agents that each discover the cap themselves.
//
//   PER AGENT -- each admitted agent gets an equal share of the REMAINING
//     budget, so N shares sum to at most what was left. A declared
//     per-agent cap (config.subagent.maxCostUsd / OX_SUBAGENT_MAX_COST) only
//     ever lowers a share. The share rides the agent's descriptor, its live
//     registry record, its subagent-spawn event and the parent's own tool
//     result, so the division is a thing an operator can read rather than a
//     property to infer.
// Exported for the guard's own test. It is a DEFENCE-IN-DEPTH check, not the
// primary enforcement: runAgentLoop's own assertCostBudget() fires right after
// every model call, so in a normal single-parent run the aggregate cap is
// already past its headroom limit by the time a batch is admitted, and this
// function's `blocked` branch is reached only when a batch is driven without
// passing through that assert -- a subagent spawned straight through the tool
// handler, a budget mutated between a turn's assert and its tools, or a test.
export function resolveBatchCostDivision(count, config) {
  const budget = currentCostBudget();
  const cap = budget?.maxCostUsd ?? null;
  const declared = (() => {
    const raw = config?.subagent?.maxCostUsd ?? process.env.OX_SUBAGENT_MAX_COST;
    const n = raw == null || raw === '' ? null : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  if (!Number.isFinite(cap) || cap <= 0) {
    return { blocked: null, perAgentUsd: declared, sessionCapUsd: null };
  }
  if (budget.reason) {
    return {
      blocked: `parallel subagent batch refused: the session cost cap of ${cap} USD is already reached (${budget.reason}) -- no headroom to divide`,
      perAgentUsd: null,
      sessionCapUsd: cap,
    };
  }
  const spent = Number(budget.snapshot()?.knownCostUsd) || 0;
  const remaining = Math.max(0, cap - spent);
  const share = remaining / Math.max(1, count);
  if (!(share > 0)) {
    return {
      blocked: `parallel subagent batch refused: the session cost cap of ${cap} USD is already spent (${spent.toFixed(4)} USD), so there is nothing left to divide across ${count} subagents`,
      perAgentUsd: null,
      sessionCapUsd: cap,
    };
  }
  return {
    blocked: null,
    perAgentUsd: declared == null ? share : Math.min(share, declared),
    sessionCapUsd: cap,
    remainingUsd: remaining,
  };
}

function failureKey(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (a.path != null) return `${name}:${String(a.path)}`;
  let basis;
  try {
    basis = a.command ?? JSON.stringify(a);
  } catch {
    basis = String(a.command ?? '');
  }
  return `${name}:${shortHash(basis)}`;
}

// A tool call's parsed arguments ({} when absent or malformed), the same shape
// runOne keys its failures on.
function callArgs(call) {
  const parsed = safeJsonParse(call?.function?.arguments || '{}');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

// Wave5a E: stable stringify (sorted keys, recursive) for doom-loop keys.
export function stableStringify(value) {
  const v = value;
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s;
}

function renderMsg(m) {
  const role = m?.role ?? '?';
  const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
  return `[${role}] ${body}`;
}

// The loop itself. Everything it yields is an agent event; the exported
// runAgent() below decides whether those also cross the IPC wire.
// In-flight fire-and-forget hook work (PreLLM/PostLLM). Module-scoped, not
// loop-scoped, so `drainPendingHooks()` in the consumer wrapper below can still
// reach it after a consumer breaks out of the event stream mid-run (SIGINT,
// budget stop): a hook that was dispatched must get to finish writing whatever
// it writes, or "non-blocking" would quietly become "dropped".
const pendingHookWork = new Set();
export async function drainPendingHooks() {
  while (pendingHookWork.size) {
    await Promise.all([...pendingHookWork]);
  }
}

// ---------------------------------------------------------------------------
// Working directory resolution.
//
// `cwd` decides where a run READS from and WRITES to: AGENTS.md and the other
// instruction files, session notes and memory, hooks config, and the repo
// fingerprint. It used to be read from exactly one place -- `ctx.cwd` -- so a
// caller who passed the far more plausible top-level `runAgent({ cwd })` got NO
// error of any kind: the run proceeded against the real process cwd and wrote a
// whole session's artefacts into the wrong tree. Silence about which directory
// an agent is writing to is the worst failure mode this function has, so the
// top-level option is honoured explicitly rather than ignored.
//
// `cwd` is an ALIAS for `ctx.cwd`, not a second independent setting. Precedence
// for existing callers is unchanged -- ctx.cwd, then cwd, then config.cwd, then
// process.cwd(). Because it is an alias, passing both with DIFFERENT values is
// a real ambiguity and throws: letting one silently beat the other would
// reintroduce exactly the class of bug this removes.
// ---------------------------------------------------------------------------
export function resolveRunCwd(opts = {}) {
  const ctxCwd = opts?.ctx?.cwd;
  const topCwd = opts?.cwd;
  if (topCwd !== undefined && topCwd !== null) {
    if (typeof topCwd !== 'string' || !topCwd.trim()) {
      throw new TypeError(
        `runAgent: \`cwd\` must be a non-empty string, received ${typeof topCwd === 'string' ? JSON.stringify(topCwd) : typeof topCwd}. Pass a directory path (or set ctx.cwd) -- it is never ignored.`
      );
    }
    if (ctxCwd !== undefined && ctxCwd !== null) {
      // Resolved before comparing so `/tmp/x` and `/tmp/x/` are agreement, not
      // a conflict.
      if (path.resolve(String(ctxCwd)) !== path.resolve(topCwd)) {
        throw new Error(
          `runAgent: conflicting working directories -- ctx.cwd=${JSON.stringify(ctxCwd)} but cwd=${JSON.stringify(topCwd)}. \`cwd\` is an alias for \`ctx.cwd\`, so pass only one.`
        );
      }
    }
  }
  return ctxCwd ?? topCwd ?? opts?.config?.cwd ?? process.cwd();
}

async function* runAgentLoop(opts = {}) {
  // `goal` is the PERSISTENT goal (src/goal.js) and `goalContract` is the
  // per-call verification contract. They are different things that both belong at
  // the top of the prompt, so both arrive here and render into one layer.
  const { target, messages = [], ctx = {}, config = {}, maxIterations = 40, signal, verify = false, extraGuidance = '', initialUsage = null, auxTarget, goalContract = null, goal = null } = opts;
  let history;
  const cwd = resolveRunCwd(opts);
  const toolCtx = ctx && typeof ctx === 'object' ? { ...ctx, signal } : { signal };
  // What was asked, for tools that trim long output to what matters (src/trim-output.js).
  { const u = [...messages].reverse().find((m) => m?.role === 'user'); toolCtx.query = typeof u?.content === 'string' ? u.content.slice(0, 2000) : Array.isArray(u?.content) ? u.content.map((p) => p?.text ?? '').join(' ').slice(0, 2000) : ''; }
  // `toolCtx` is a SHALLOW copy, so a sessionState that does not exist yet would
  // be created on the copy by todo_write and the caller's checklist would stay
  // permanently empty -- the goal would then never see the model's progress.
  // One shared object on both sides keeps that impossible.
  if (toolCtx && typeof toolCtx === 'object') {
    if (!toolCtx.sessionState || typeof toolCtx.sessionState !== 'object') {
      toolCtx.sessionState = ctx?.sessionState && typeof ctx.sessionState === 'object' ? ctx.sessionState : {};
      if (ctx && typeof ctx === 'object') ctx.sessionState = toolCtx.sessionState;
    }
  }
  // Subagent lifecycle events (subagent-spawn/start/progress/end) are produced
  // from INSIDE a running subagent, which is a nested runAgentLoop. The nested
  // loop cannot yield them to the parent -- its consumer is runSubagent, which
  // is not a stream -- so they are pushed onto a queue that the OUTERMOST loop
  // drains into the stream the operator is actually reading.
  //
  // "Outermost" is decided by presence, not by depth counting: a loop whose ctx
  // already carries a queue adopts it and does NOT drain it, so a subagent
  // inside a subagent still reports once, on the one stream, instead of once
  // per nesting level.
  const ownsSubagentEvents = !Array.isArray(ctx?._subagentEvents);
  const subagentEvents = ownsSubagentEvents ? [] : null;
  if (toolCtx && typeof toolCtx === 'object') toolCtx._subagentEvents = subagentEvents ?? ctx._subagentEvents;
  // Files this run wrote or edited (src/tools/fs.js), for the security check.
  if (toolCtx && typeof toolCtx === 'object' && !(toolCtx.writtenFiles instanceof Set)) toolCtx.writtenFiles = new Set();
  let securityRounds = 0;
  // Yields whatever the subagent calls have queued since the last drain. A
  // no-op on a nested loop, which is exactly right.
  const flushSubagentEvents = function* () {
    if (!subagentEvents) return;
    while (subagentEvents.length) yield subagentEvents.shift();
  };
  const hooksConfig = ctx.hooksConfig ?? loadHooksConfig(cwd);
  // ---- Lifecycle hooks (PreLLM/PostLLM/SessionStart/SessionStop) ----
  // PreToolUse/PostToolUse keep their existing blocking semantics untouched.
  // The four events wired here differ in one crucial respect: PreLLM/PostLLM
  // fire on EVERY LLM call, and runHook is awaited serially with a 10s default
  // timeout that fails open. Measured cost of making them blocking: ~5.5ms per
  // turn for two trivial `sh -c` hooks, and up to 2 x timeoutMs per turn in the
  // fail-open hang case. That is paid on every single call for observability
  // that never gates anything, so PreLLM/PostLLM are FIRE-AND-FORGET.
  //
  // Fire-and-forget here means two specific guarantees, both load-bearing:
  //   1. The promise can never throw into the agent loop (explicit .catch).
  //   2. The promise is not dropped on exit -- `pendingHookWork` is drained at
  //      teardown (and on generator return), so a hook that writes a marker file
  //      still gets to write it even though nobody awaited it.
  // The trade-off, stated plainly: a PreLLM/PostLLM hook's side effects are no
  // longer ordered against the model call that follows it, and its timeout is
  // no longer a latency the agent waits on. A hook that must complete before
  // the next LLM call belongs on PreToolUse, which is blocking.
  const trackHookWork = (p) => {
    const tracked = p.catch(() => null).finally(() => pendingHookWork.delete(tracked));
    pendingHookWork.add(tracked);
    return tracked;
  };
  // A configured hook must never be silently ignored. Every fire emits a
  // `hook-event` NDJSON event (visible under --json) naming the event and how
  // it was dispatched. hooksFor() is the same predicate fireHooks uses, so this
  // fires exactly when real hooks run -- never for a non-matching matcher.
  //
  // The events are queued rather than yielded inline because PreLLM/PostLLM
  // fire from inside the stream retry loop's control flow; the generator body
  // drains the queue with `yield* flushHookEvents()` right after each fire.
  const pendingHookEvents = [];
  const emitHookEvent = (ev) => pendingHookEvents.push({ type: 'hook-event', ...ev });
  const flushHookEvents = function* () {
    while (pendingHookEvents.length) yield pendingHookEvents.shift();
  };
  const fireLifecycle = async (eventName, data, blocking) => {
    const matched = hooksFor(eventName, data, hooksConfig).length;
    if (!matched) return { decision: 'allow', outputs: [], errors: [] };
    const started = Date.now();
    if (blocking) {
      const res = await fireHooks(eventName, data, hooksConfig, { cwd });
      emitHookEvent({ event: eventName, blocking, hooks: matched, ms: Date.now() - started, errors: res.errors.length });
      return res;
    }
    emitHookEvent({ event: eventName, blocking, hooks: matched });
    trackHookWork(fireHooks(eventName, data, hooksConfig, { cwd }));
    return { decision: 'allow', outputs: [], errors: [] };
  };
  const verifier = verify ? createVerifier(cwd, { ctx: toolCtx, execute: dispatchTool }) : null;
  const model = target?.model;
  // G1 auxiliary routing: cheap calls (compaction summarizer, goal verifier,
  // max-mode planning) go to the aux bot when one is resolvable, else to the
  // main target. Explicit auxTarget=null disables lookup for the run.
  const aux =
    auxTarget === undefined
      ? resolveAuxTarget(config)
      : auxTarget && typeof auxTarget === 'object' && auxTarget.provider
        ? auxTarget
        : null;
  const auxModel = aux?.model ?? model;
  // Cost-honest accounting: a user-declared price row (config `model_overrides`
  // / OX_MODEL_OVERRIDE) must price what ox reports it spent, not just where it
  // routes. classifyTargetCost() already reads this; spend reporting now does too.
  const costOverrides = config?.modelOverrides ?? null;
  // F2: active target starts at the primary; a mid-turn bounce swaps it for
  // the rest of THIS TURN only (the next runAgent invocation restores the
  // primary). Max ONE bounce per turn.
  let activeTarget = target;
  let bouncedThisTurn = false;
  // The `critique` tool resolves a critic model and REFUSES one that matches the
  // model driving this session. It reads the live target off the tool ctx, so it
  // sees the post-fallback model too: a turn that bounced from grok to gemini
  // must not be able to pick grok as its "independent" critic.
  toolCtx.activeTarget = activeTarget;
  toolCtx.config = config;
  const activeModel = () => activeTarget?.model ?? model;
  const auxModelNow = () => aux?.model ?? activeTarget?.model ?? model;
  const originalUserText =
    (Array.isArray(messages) ? messages : []).find((m) => m?.role === 'user' && typeof m?.content === 'string')
      ?.content ?? '';
  // Path-scoped rules (globs:) are resolved against the paths this turn is
  // about. Explicit ctx.scopedPaths wins; otherwise the @path refs in the
  // user's own words are the real signal ox has before the model speaks.
  // What the run is about: long tool output keeps the lines that match it.
  toolCtx.taskText = String(originalUserText).slice(0, 2000);
  const scopedPaths =
    Array.isArray(ctx.scopedPaths) && ctx.scopedPaths.length
      ? ctx.scopedPaths
      : instructionScopesFromText(originalUserText);
  // `let`, not `const`: compaction re-reads the project instructions from disk
  // (see below) and rebuilds the system prompt around the fresh block.
  let contextParts = buildContext({ cwd, scopedPaths });
  const memoryBlock = ctx.memoryBlock ?? '';
  const skillIndex = ctx.skillIndex ?? '';
  const personaBlock = [ctx.personaBlock, modeBlock(ctx.mode)].filter(Boolean).join('\n\n');
  let guidance = String(extraGuidance ?? '');
  let builtGuidance = null;
  // The persistent goal renders ABOVE the contract, inside the same prompt layer,
  // and it is rebuilt into the prompt after every compaction -- so the objective
  // is never something a summary can paraphrase away.
  //
  // It is also rebuilt when the model's own checklist changes. A goal that shows
  // an empty checklist on the request right after the model wrote one is worse
  // than no checklist, so the block is computed from the LIVE todo list rather
  // than from whatever the goal record held when the turn began.
  // `history` is REASSIGNED three times in the loop body (compaction, stale-tool
  // trimming, context optimisation). The goal block reads the live one, so every
  // reassignment has to re-point this; otherwise the block silently reverts to a
  // snapshot from before the model's own tool calls and reports its work as
  // unproven while the work sits two messages up in the same array.
  let loopHistory = [];
  const setHistory = (next) => {
    history = next;
    loopHistory = history;
    return history;
  };
  // The record, not the rendered text: progressSignature fingerprints the goal
  // object, and handing it a string normalises to null and reports "no change"
  // forever, which is exactly the stale checklist this is here to prevent.
  const liveGoal = (hist) => {
    if (!goal) return null;
    const merged = mergeGoalTodos(goal, toolCtx?.sessionState);
    // Re-proved against the turn's OWN history, so an item the model completed
    // mid-turn is credited the moment the work exists and not before.
    return merged ? proveGoalItems(merged, harvestEvidence(hist)) : null;
  };
  const goalSignature = () => progressSignature(liveGoal(loopHistory));
  const contractBlockFor = (hist) =>
    [renderGoalBlock(liveGoal(hist)), renderContractBlock(goalContract)].filter(Boolean).join('\n');
  // Names of tools narrowing kept out of this turn's offer. The system prompt is
  // assembled before narrowing runs, so the prompt is rebuilt once after the cut
  // (below) rather than moving the whole offer pipeline ahead of prompt build.
  let withheldTools = [];
  // The subagent steering block, rendered fresh at each turn boundary and NOT
  // persisted (see src/subagent-control.js renderSteeringBlock). It is composed
  // into the prompt alongside `guidance` rather than replacing it, because
  // `guidance` is reassigned wholesale by the self-heal tracker and folding a
  // steer into it would mean losing the note the moment one failed tool bumped
  // the retry counter. Kept separate for that reason and no other.
  //
  // DECLARED HERE, above `systemText`, because `systemText` closes over it and
  // is invoked on the very next statement that builds the opening history. It
  // used to be declared ~80 lines further down, beside `guidanceKey`, which put
  // that first invocation inside the temporal dead zone: every run whose first
  // system prompt was built there threw `Cannot access 'steeringBlock' before
  // initialization`. A `let` read before its declaration is a ReferenceError
  // even when the value would have been the right one, so nothing about the
  // value was ever the problem -- only its position.
  let steeringBlock = '';
  let builtSteering = '';
  const systemText = async () =>
    buildSystemPrompt({ cwd, contextParts, memoryBlock, skillIndex, extraGuidance: steeringBlock ? `${guidance}\n\n${steeringBlock}` : guidance, personaBlock, contractBlock: contractBlockFor(loopHistory), withheldTools, answerOnly: ctx?.noTools === true, agentMessaging: typeof ctx?.agentTeamsHandler === 'function', includeRepoMap: config.repoMap === true || process.env.OX_REPO_MAP === '1' });
  history = [
    { role: 'system', content: await systemText() },
    ...sanitizeHistory(messages).filter((m) => m?.role !== 'system'),
  ];
  loopHistory = history;
  let builtGoalSig = goalSignature();
  const usage = {
    inputTokens: Number(initialUsage?.inputTokens) || 0,
    outputTokens: Number(initialUsage?.outputTokens) || 0,
    cacheReadTokens: Number(initialUsage?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(initialUsage?.cacheWriteTokens) || 0,
  };
  const auxUsage = { inputTokens: 0, outputTokens: 0 };
  let auxSpend = false;
  const addAux = (u) => {
    if (!aux) return;
    const i = Number(u?.inputTokens) || 0;
    const o = Number(u?.outputTokens) || 0;
    if (i > 0 || o > 0) auxSpend = true;
    auxUsage.inputTokens += i;
    auxUsage.outputTokens += o;
  };
  // F2: main-loop usage bucketed per active model so cost math always uses
  // the pricing of the target that actually served the tokens.
  const usageByModel = new Map();
  const addMainUsage = (u, modelKey) => {
    const key = String(modelKey ?? activeModel());
    const b = usageByModel.get(key) ?? { inputTokens: 0, outputTokens: 0 };
    b.inputTokens += Number(u?.inputTokens) || 0;
    b.outputTokens += Number(u?.outputTokens) || 0;
    b.cacheReadTokens = (b.cacheReadTokens ?? 0) + (Number(u?.cacheReadTokens) || 0);
    b.cacheWriteTokens = (b.cacheWriteTokens ?? 0) + (Number(u?.cacheWriteTokens) || 0);
    usageByModel.set(key, b);
  };
  const failures = new Map();
  const lessoned = new Set();
  const policyWarned = new Set();
  const fallbackWarned = new Set();
  // Cost-honest routing: fallback candidates the free_only policy refused, kept on
  // the turn state so callers can report exactly what was dropped and why.
  let droppedFallbacks = [];
  // free_only refuses every configured fallback: say so loudly rather than
  // quietly running on the primary.
  let freeOnlyWarned = false;
  // Targets (by label) whose model rejected the tools array. Small local models
  // often cannot call tools; instead of dying they keep working chat-only.
  const toolessTargets = new Set();
  // The candidate list is policy-filtered, so compute it once per turn.
  let fallbackListCache = null;
  const resolveFallbackList = () => {
    if (fallbackListCache) return fallbackListCache;
    const raw = Array.isArray(ctx.fallbackTargets) ? ctx.fallbackTargets.filter(Boolean) : [];
    const freeOnly = config?.fallbackPolicy?.cost === 'free_only';
    const list = [];
    droppedFallbacks = [];
    for (const t of raw) {
      const cost = classifyTargetCost(t, config?.modelOverrides);
      if (!freeOnly || cost === 'free') {
        list.push(t);
      } else {
        droppedFallbacks.push({
          target: targetLabel(t),
          cost,
          reason: `fallback_policy.cost=free_only refused a ${cost} fallback target`,
        });
      }
    }
    fallbackListCache = { list, allDropped: freeOnly && raw.length > 0 && list.length === 0 };
    if (droppedFallbacks.length) {
      try {
        ctx.droppedFallbacks = [...droppedFallbacks];
        toolCtx.droppedFallbacks = [...droppedFallbacks];
      } catch { /* frozen ctx: the warning below still fires */ }
    }
    return fallbackListCache;
  };
  // Wave5a E: doom-loop resampler state (consecutive identical calls).
  let doomLastKey = null;
  let doomCount = 0;
  const DOOM_GUIDANCE =
    'You have issued this exact same call three times. It is not working. Change approach fundamentally or report the blocker.';
  let guidanceKey = null;
  const window = modelWindow(ctx, model, config);
  const configuredStrictSchemas =
    config?.strictSchemas ?? config?.tools?.strictSchemas ?? ctx?.strictSchemas;
  const strictSchemas =
    configuredStrictSchemas === true || isSmallModel(model, window);
  let tools = pruneToolSchemas(
    listToolSchemas(ctx, strictSchemas),
    Math.max(TOOL_SCHEMA_BUDGET_FLOOR, window),
    strictSchemas
  );
  const { compactAt, keepTurns } = compactionKnobs(config);
  // Wave5b I: summarizer strictness + optional second distillation pass.
  const passKnobs = compactionPassKnobs(config);
  let iters = 0;
  let verifyRounds = 0;
  let continuedRounds = 0;
  let preCompactionMarked = false;
  let compactionsThisRun = 0;
  let compactionBudgetWarned = false;
  // F3 shell quality gates: per-command state plus a retry counter and
  // wall-clock budget that are independent of maxIterations.
  const gates = parseGates(goalContract);
  const gateStates = new Map(); // cmd -> { passed, lastExit, failPrint }
  let gateRetries = 0;
  let gateBudgetStart = null;
  const runGates = async () => {
    if (gateBudgetStart == null) gateBudgetStart = Date.now();
    const print = repoFingerprint(cwd);
    const failures = [];
    const gateEvents = [];
    let lastFailContent = '';
    for (const cmd of gates) {
      assertCostBudget();
      const st = gateStates.get(cmd);
      if (st?.passed) continue;
      if (st && st.passed === false && st.failPrint === print) {
        // GIT-FINGERPRINT SKIP: identical gate failed before and repo state is
        // unchanged — skip re-execution this round.
        failures.push({ cmd, exit: st.lastExit, skipped: true });
        gateEvents.push({ type: 'gate', cmd, ok: false, exit: st.lastExit ?? null, unchanged: true });
        continue;
      }
      let res = null;
      try {
        // Same execution path as the bash tool: denylist + 25k cap + timeout.
        res = await dispatchTool('bash', { command: cmd }, toolCtx);
      } catch (err) {
        res = { content: String(err?.message ?? err), isError: true };
      }
      const contentStr = String(res?.content ?? '');
      const okRun = res?.isError !== true;
      if (okRun) {
        gateStates.set(cmd, { passed: true, lastExit: 0 });
        gateEvents.push({ type: 'gate', cmd, ok: true, exit: 0 });
        continue;
      }
      const exit = gateExitOf(contentStr);
      gateStates.set(cmd, { passed: false, lastExit: exit, failPrint: print });
      failures.push({ cmd, exit, skipped: false });
      lastFailContent = contentStr;
      gateEvents.push({ type: 'gate', cmd, ok: false, exit: exit ?? null });
    }
    return { events: gateEvents, passedAll: failures.length === 0, failures, lastFailContent };
  };
  // Wave5b H: per-turn tool-offer narrowing before the loop starts. The skill
  // index text from ctx drives relevance; the event fires once when narrowing
  // actually shrank the offer.
  if (config?.tools?.narrow !== false) {
    const narrowed = narrowToolSchemas(tools, {
      message: originalUserText,
      relevantSkillTools: skillIndex,
      strict: strictSchemas,
      mode: ctx?.mode,
    });
    if (Array.isArray(narrowed) && narrowed.length > 0 && narrowed.length < tools.length) {
      const totalBefore = tools.length;
      withheldTools = tools
        .filter((s) => !narrowed.includes(s))
        .map((s) => s?.name)
        .filter((n) => typeof n === 'string' && n);
      // Tools on demand: the withheld ones stay one call away (load_tools), so a
      // narrowed offer never strands the model without a tool it turns out to need.
      const everything = tools;
      tools = withheldTools.length ? [...narrowed, LOAD_TOOLS_SCHEMA] : narrowed;
      toolCtx.loadTools = (names) => {
        const loaded = [], unknown = [];
        for (const n of names) {
          const s = everything.find((x) => x?.name === n);
          if (!s) { unknown.push(n); continue; }
          if (!tools.includes(s)) tools = [...tools.filter((x) => x !== LOAD_TOOLS_SCHEMA), s, LOAD_TOOLS_SCHEMA];
          withheldTools = withheldTools.filter((w) => w !== n);
          loaded.push(n);
        }
        return { loaded, unknown };
      };
      // Counted as sent: the narrowed set plus load_tools when anything is withheld.
      yield { type: 'tool-narrowing', offered: tools.length, total: totalBefore };
      if (withheldTools.length && history[0]?.role === 'system') {
        history[0] = { role: 'system', content: await systemText() };
      }
    }
  }
  // Measured AFTER prune + narrow so it describes the offer that really ships.
  const schemaTokens = toolSchemaTokens(tools);
  let prevHistoryForAlign = null;
  // SessionStart: ONCE per runAgentLoop() call, not per turn. Fires here --
  // after the hook config is resolved and the system prompt is built, but
  // BEFORE `outer: while`, so it precedes the first LLM call of the run.
  // Blocking: it costs ~5.5ms once per session, and a hook that sets up state
  // the first model call depends on must be finished before that call.
  await fireLifecycle('SessionStart', {
    cwd,
    sessionId: toolCtx?.sessionId,
    bot: target?.bot ?? null,
    model: activeModel(),
  }, true);
  yield* flushHookEvents();
  outer: while (true) {
    assertCostBudget();

    // ---- the turn boundary --------------------------------------------------
    //
    // Two things are legal here and nowhere else, which is what makes this the
    // right seam for both.
    //
    // 1. ABORT CHECK. A run that is already aborted stops before it starts
    //    another turn. Without this the loop would dispatch one more provider
    //    request against a dead signal, get an AbortError back, and only then
    //    notice -- turning a cancel into one more round trip to the provider for
    //    an agent the operator already decided to stop. This matters most in the
    //    case that was previously invisible: an agent cancelled while INSIDE a
    //    tool call has finished that call and returned here, so this line is
    //    what stops it. It also makes a per-subagent cancel (src/subagent-control
    //    .js, one controller per agent) prompt at the same granularity as the
    //    pre-dispatch tool check further down.
    if (signal?.aborted) {
      yield { type: 'error', error: 'aborted' };
      break;
    }

    // 2. THE STEERING INBOX. Drained once per turn, here, and nowhere else.
    //    Above this line the agent is between turns; below it, it is either
    //    issuing a provider request or executing a tool call. Injecting earlier
    //    would put the note in front of a tool call that has not started, which
    //    is fine; injecting later would mean interrupting one that has, which is
    //    how a steer becomes a half-written file. So: AFTER the in-flight tool
    //    call returned, BEFORE the next request goes out -- and the note is
    //    scoped to this one turn, which is why the block is not persisted.
    //
    //    `_steerInbox` is only ever installed by a subagent (src/subagent.js
    //    runSubagent). A top-level loop has no such function, so this costs one
    //    `typeof` check per turn and nothing else.
    if (typeof toolCtx?._steerInbox === 'function') {
      let steer = '';
      try { steer = await toolCtx._steerInbox(); } catch { /* a broken mailbox must not stop a run */ }
      // Assigned even when EMPTY, which is what scopes the note to exactly one
      // turn. Leaving the previous block in place after the mailbox was drained
      // would re-inject the same redirect on every remaining turn of the run, so
      // a steer would read as a standing instruction rather than the
      // one-time course correction the operator meant -- and the at-most-once
      // delivery contract in src/agent-teams.js would be quietly violated by the
      // loop re-showing it.
      const next = typeof steer === 'string' && steer.trim() ? steer : '';
      if (next !== steeringBlock) {
        steeringBlock = next;
        if (history[0]?.role === 'system') history[0] = { role: 'system', content: await systemText() };
      }
    }

    if (iters >= maxIterations) {
      yield { type: 'error', error: `iteration budget exhausted (${maxIterations})` };
      break;
    }
    iters++;

    const goalSig = goalSignature();
    if (builtGuidance !== guidance || builtGoalSig !== goalSig || builtSteering !== steeringBlock) {
      builtGuidance = guidance;
      builtSteering = steeringBlock;
      builtGoalSig = goalSig;
      if (history[0]?.role === 'system') history[0] = { role: 'system', content: await systemText() };
    }

    const est = payloadTokens(history, tools);
    if (!preCompactionMarked && est >= window * PRE_COMPACTION_THRESHOLD) {
      preCompactionMarked = true;
      try {
        writeSessionNote(cwd, {
          phase: 'pre-compaction',
          goal: originalUserText,
          status: 'ok',
          decisions: [`context estimate ${est} tokens reached ${Math.round(PRE_COMPACTION_THRESHOLD * 100)}% of the ${window}-token window`],
          nextSteps: ['continue toward goal; compaction imminent'],
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          costUsd: costOf(model, usage, costOverrides),
          model,
        });
      } catch {}
    }
    if (est > window * compactAt) {
      if (compactionsThisRun >= COMPACTION_MAX_PER_RUN) {
        // The schemas dominate the payload and survive compaction untouched,
        // so summarizing cannot get us back under the threshold. Say so once
        // and let the run proceed instead of re-summarizing every turn.
        if (!compactionBudgetWarned) {
          compactionBudgetWarned = true;
          yield {
            type: 'warning',
            text: `context still over the ${Math.round(compactAt * 100)}% compaction threshold after ${compactionsThisRun} compactions this run — tool schemas alone are ${schemaTokens} of the ${est} tokens sent and compaction cannot reclaim them; continuing without further auto-compaction`,
          };
        }
      } else {
        compactionsThisRun++;
        const { head, toSummarize, tail } = pureCompact(history, keepTurns);
        if (toSummarize.length > 1) {
          // Which model runs the summarizer. `compaction_model` wins; without
          // it this is the pre-existing `aux ?? activeTarget` chain, so a
          // dedicated cheap summarizer is strictly additive.
          const choice = ctx?.compactionTarget
            ? { target: ctx.compactionTarget, model: ctx.compactionTarget.model ?? ctx.compactionTarget.name ?? null, bot: ctx.compactionTarget.bot ?? null, provider: ctx.compactionTarget.provider ?? null, source: 'caller', separateFromMain: ctx.compactionTarget.model !== activeModel() }
            : compactionModelChoice(config, { aux, main: activeTarget });
          const summarizer = choice.target ?? activeTarget;
          // Audit the composition BEFORE the rewrite so the record explains what
          // compaction actually had to work with, not just the residue.
          const beforeBreakdown = breakdownContext({
            messages: history,
            tools,
            window,
            threshold: compactAt,
            summaryPrefix: SUMMARY_PREFIX,
          });
          let summary = '';
          let sumUsage = { inputTokens: 0, outputTokens: 0 };
          try {
            const summarized = await summarizeMessages(summarizer, toSummarize, signal, {
              wordBudget: passKnobs.wordBudget,
              twoPass: passKnobs.twoPass,
              goalContract,
            });
            summary = summarized?.text ?? '';
            sumUsage = summarized?.usage ?? sumUsage;
          } catch {}
          if (summary) {
            // Re-read project instructions from disk across compaction, the
            // way Claude Code re-reads the project-root file after /compact: a
            // mid-session edit to AGENTS.md must take effect, and the block is
            // cheap next to the summary it rides with. The system message is
            // rebuilt, never re-summarized, so instructions stay verbatim.
            contextParts = buildContext({ cwd, scopedPaths });
            const freshSystem = await systemText();
            const rebuiltHead = head.map((m) =>
              m?.role === 'system' ? { role: 'system', content: freshSystem } : m
            );
            // SAFETY NET, not decoration: `head` is derived from `history` by
            // pureCompact and `history[0]` is always a system message, so this
            // cannot normally trip. If a future edit to the split ever produced
            // a head with no system message, dropping the prompt would silently
            // strip project instructions AND the tool-use contract for the rest
            // of the run. Refuse the rewrite instead and keep the old history.
            const keepsSystem =
              rebuiltHead.length === head.length &&
              rebuiltHead.some((m) => m?.role === 'system' && typeof m?.content === 'string' && m.content.length > 0);
            if (!keepsSystem) {
              compactionsThisRun--;
              yield {
                type: 'warning',
                text: 'compaction refused: the rebuilt history would not contain the system prompt — history left unchanged',
              };
            } else {
              setHistory([...rebuiltHead, { role: 'user', content: SUMMARY_PREFIX + summary }, ...tail]);
              const afterTokens = payloadTokens(history, tools);
              const afterBreakdown = breakdownContext({
                messages: history,
                tools,
                window,
                threshold: compactAt,
                summaryPrefix: SUMMARY_PREFIX,
              });
              // `from`/`to` are kept for existing consumers (the TUI note, the
              // IPC watcher, the JSON stream); everything past them is the audit
              // record. `from`/`to` remain the FULL payload both times, because a
              // history-only number would claim a reclaim that never happened.
              yield {
                type: 'compaction',
                from: est,
                to: afterTokens,
                tokensBefore: est,
                tokensAfter: afterTokens,
                savedTokens: est - afterTokens,
                // How many messages left the live history, and how many survive.
                // Both come from the breakdowns, which were taken on the correct
                // side of the rewrite — reading `history.length` here would
                // report the post-compaction count and make this record claim
                // nothing was ever dropped.
                messagesBefore: beforeBreakdown.messageCount,
                messagesAfter: afterBreakdown.messageCount,
                messagesSummarized: toSummarize.length,
                messagesDropped: toSummarize.length,
                messagesKept: rebuiltHead.length + tail.length,
                summaryMessages: 1,
                summaryTokens: estimateTokens(SUMMARY_PREFIX + summary),
                // Which model wrote the summary, and where that choice came from.
                model: choice.model ?? activeModel(),
                compactionModel: choice.model ?? activeModel(),
                compactionModelSource: choice.source,
                separateCompactionModel: choice.separateFromMain === true,
                bot: choice.bot ?? null,
                // The composition either side of the rewrite, so "why is this
                // still expensive" is answerable without re-running anything.
                breakdownBefore: beforeBreakdown.segments,
                breakdownAfter: afterBreakdown.segments,
                windowPctBefore: beforeBreakdown.windowPct,
                windowPctAfter: afterBreakdown.windowPct,
                window,
                thresholdAt: compactAt,
                // Loop guard, surfaced so the audit can prove it was honoured.
                index: compactionsThisRun,
                cap: COMPACTION_MAX_PER_RUN,
                triggeredBy: 'window-threshold',
              };
              try {
                writeSessionNote(cwd, {
                  phase: 'compaction',
                  goal: originalUserText,
                  status: 'ok',
                  decisions: [summary],
                  tokensIn: usage.inputTokens + sumUsage.inputTokens,
                  tokensOut: usage.outputTokens + sumUsage.outputTokens,
                  costUsd: costOf(model, usage, costOverrides),
                  model,
                });
              } catch {}
            }
          }
          if (sumUsage.inputTokens > 0 || sumUsage.outputTokens > 0) {
            usage.inputTokens += sumUsage.inputTokens;
            usage.outputTokens += sumUsage.outputTokens;
            addAux(sumUsage);
            // Price the compaction turn with the model that ACTUALLY served it,
            // so pointing `compaction_model` at a cheap model shows up as a
            // cheaper line item instead of being billed at the main model's rate.
            const compactionModelNow = choice.model ?? auxModelNow();
            yield {
              type: 'usage',
              inputTokens: sumUsage.inputTokens,
              outputTokens: sumUsage.outputTokens,
              costUsd: costOf(compactionModelNow, sumUsage, costOverrides),
              model: compactionModelNow,
              ...(aux || choice.separateFromMain ? { aux: true } : {}),
              ...(choice.source === 'compaction_model' ? { compaction: true } : {}),
            };
          }
        }
      }
    }

    setHistory(staleToolOutputTrim(history));

    // Consumers that meter against the model window (the TUI meter, /cost)
    // used to measure `history` only and so under-reported by the whole schema
    // block. Hand them the payload that is actually about to be sent.
    const contextEstimate = {
      type: 'context-estimate',
      tokens: payloadTokens(history, tools),
      historyTokens: tokensOf(history),
      schemaTokens,
      window,
    };
    yield contextEstimate;
    // The same payload, segmented. Emitted on every turn so the breakdown a
    // user asks for is the one that was really measured, not a re-derivation.
    yield {
      type: 'context-breakdown',
      ...breakdownContext({
        messages: history,
        tools,
        window,
        threshold: compactAt,
        summaryPrefix: SUMMARY_PREFIX,
      }),
    };

    // ---- G3 transport-resilient streaming + F2 fallback bounce ----
    // Network death (thrown fetch/system errors, non-user aborts, premature
    // end without a done event) is retried identically up to
    // TRANSPORT_MAX_RETRIES times; partially accumulated tool-calls are
    // discarded and never executed. User aborts are never retried.
    // F2: classified provider failures of the PRIMARY target may bounce to
    // ctx.fallbackTargets — auth/not-found immediately (retrying cannot
    // help), everything else after the retry budget exhausts. Max ONE bounce
    // per turn; the swap lasts for the rest of this turn only.
    let accum = makeCallAccumulator();
    let text = '';
    let stopReason = null;
    let transportRetries = 0;
    let lastFailure = null;
    for (;;) {
      accum = makeCallAccumulator();
      text = '';
      stopReason = null;
      let sawDone = false;
      let streamError = null;
      // Per-attempt token totals. The run-cumulative `usage` object spans the
      // whole session, which is the wrong number for a PostLLM payload about
      // ONE stream request; this is reset at the top of every attempt
      // (including transport retries and fallback bounces).
      const attemptUsage = { inputTokens: 0, outputTokens: 0 };
      const am = activeModel();
      try {
        if (config.contextOptimize && prevHistoryForAlign) {
          setHistory(applyContextOptimize(history, prevHistoryForAlign, config));
        }
        // PreLLM: fires immediately before every streamVia() request. Payload
        // mirrors the tool events' shape (cwd + sessionId) plus the model and
        // the user prompt, so a hook sees the same env contract either way.
        // Non-blocking (see the hook helper comment above).
        await fireLifecycle('PreLLM', {
          cwd,
          sessionId: toolCtx?.sessionId,
          model: am,
          bot: activeTarget?.bot ?? null,
          prompt: originalUserText.slice(0, 2000),
        }, false);
        yield* flushHookEvents();
        const offered = toolessTargets.has(targetLabel(activeTarget)) ? [] : tools;
        for await (const raw of streamVia(activeTarget, { model: am, messages: history, tools: offered, signal })) {
          const ev = normalizeStreamEvent(raw);
          if (!ev) continue;
          if (ev.kind === 'text') {
            text += ev.text;
            yield { type: 'text-delta', text: ev.text };
          } else if (ev.kind === 'call') {
            accum.add(ev.call);
          } else if (ev.kind === 'calls') {
            for (const c of ev.calls) accum.add(c);
          } else if (ev.kind === 'usage') {
            usage.inputTokens += ev.usage.inputTokens;
            usage.outputTokens += ev.usage.outputTokens;
            usage.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
            usage.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
            attemptUsage.inputTokens += ev.usage.inputTokens;
            attemptUsage.outputTokens += ev.usage.outputTokens;
            addMainUsage(ev.usage, am);
            yield { type: 'usage', ...ev.usage, costUsd: costOf(am, ev.usage, costOverrides), model: am };
          } else if (ev.kind === 'done') {
            sawDone = true;
            stopReason = ev.stopReason ?? stopReason;
          } else if (ev.kind === 'error') {
            streamError = ev.message;
          }
        }
      } catch (err) {
        streamError = err?.name === 'AbortError' ? 'aborted' : err?.message ?? String(err);
        // DeepSeek dsh: provider-neutral canonical failure classification.
        lastFailure = normalizeFailure(err);
      }
      // PostLLM: fires AFTER the try/catch, so it runs on the clean path AND on
      // the thrown path -- a turn whose stream died is exactly the turn a user
      // most wants a hook to see. The error flag is the documented
      // `error` field: `null` on a clean turn, the stream error text on a
      // failed one. It reaches the hook as $OX_HOOK_ERROR (unset = clean),
      // so a hook can branch on it without parsing stdout or exit status.
      // Token totals are this attempt's own usage, not the run cumulative, so
      // a multi-attempt turn reports per-call numbers.
      await fireLifecycle('PostLLM', {
        cwd,
        sessionId: toolCtx?.sessionId,
        model: am,
        tokensIn: attemptUsage.inputTokens,
        tokensOut: attemptUsage.outputTokens,
        error: streamError ?? null,
      }, false);
      yield* flushHookEvents();
      if (!streamError && !sawDone) streamError = 'premature stream end without a completion event';
      if (streamError != null) {
        assertCostBudget();
        if (signal?.aborted) {
          yield { type: 'error', error: 'aborted' };
          break outer;
        }
        const reason = shortNetReason(streamError);
        // Prefer canonical code ONLY when it yields a recognized bucket;
        // otherwise fall back to the legacy string classifier (provider error
        // objects often omit .status, so canonical classification can be UNKNOWN
        // even when the message clearly says "Unauthorized").
        const code = lastFailure?.code;
        let cls = null;
        if (code && code !== LlmFailure.UNKNOWN) {
          cls = failureCodeToBucket(code);
        }
        if (!cls) cls = classifyProviderError(streamError);
        // DeepSeek dsh: context-window overflow → force compaction immediately
        // rather than retrying or bouncing (no provider has more room).
        if (code === LlmFailure.CONTEXT_WINDOW_EXCEEDED && !bouncedThisTurn) {
          yield { type: 'error', error: 'context window exceeded — reduce context or enable auto-compaction' };
          break outer;
        }
        const fbPolicy = resolveFallbackList();
        if (fbPolicy.allDropped && !freeOnlyWarned) {
          freeOnlyWarned = true;
          yield {
            type: 'warning',
            text: `fallback policy free_only refused all configured fallback bots (${droppedFallbacks.map((d) => `${d.target} [${d.cost}]`).join(', ')}) — no free fallback remains, staying on ${targetLabel(activeTarget)} instead of spending`,
          };
        }
        const fbList = bouncedThisTurn ? [] : fbPolicy.list;
        const doBounce = () => {
          const from = activeTarget;
          bouncedThisTurn = true;
          activeTarget = fbList[0];
          // Keep the tool view of "the model driving this session" in step with
          // the bounce, so `critique` cannot select the pre-fallback model as
          // an "independent" critic for the rest of the turn.
          toolCtx.activeTarget = activeTarget;
          transportRetries = 0;
          const fromLabel = targetLabel(from);
          const toLabel = targetLabel(activeTarget);
          return { from: fromLabel, to: toLabel, reason, kind: cls ?? 'network', cost: classifyTargetCost(activeTarget) };
        };
        // Cost-honest routing: the active-target change is announced on its own
        // event, in addition to the existing `fallback` event, so a bounce onto a
        // paid provider is never something the user only discovers on a bill.
        function* bounceEvents(sw) {
          yield* warnFallback(sw);
          yield { type: 'fallback', from: sw.from, to: sw.to, reason: sw.reason, kind: sw.kind };
          yield modelSwitchEvent({ from: sw.from, to: sw.to, reason: sw.reason, kind: 'fallback', cost: sw.cost });
        }
        const warnFallback = (ev) => {
          const out = [];
          if (!fallbackWarned.has(ev.to)) {
            fallbackWarned.add(ev.to);
            out.push({ type: 'warning', text: `provider fallback active: ${ev.from} → ${ev.to} (${ev.reason})` });
          }
          try {
            recordDecision({
              session: toolCtx?.sessionId,
              tool: 'provider',
              args: { from: ev.from, to: ev.to, reason: ev.reason, kind: ev.kind },
              detail: `provider fallback ${ev.from} → ${ev.to}: ${ev.reason}`,
              decision: 'allow',
              rule: 'provider-fallback',
              actor: 'policy',
            });
          } catch {}
          return out;
        };
        if (cls === 'no-tools' && tools.length && !toolessTargets.has(targetLabel(activeTarget))) {
          toolessTargets.add(targetLabel(activeTarget));
          yield {
            type: 'warning',
            text: `${targetLabel(activeTarget)} cannot call tools — continuing chat-only (no file edits or shell). Use a tool-capable model for agent work.`,
          };
          continue;
        }
        if (cls === 'bad-request' && !fbList.length) {
          yield { type: 'error', error: `provider rejected the request (not retried): ${reason}` };
          break outer;
        }
        if ((cls === 'auth' || cls === 'not-found' || cls === 'no-tools' || cls === 'bad-request') && fbList.length) {
          yield* bounceEvents(doBounce());
          continue;
        }
        if ((cls === 'auth' || cls === 'not-found') && !fbList.length && transportRetries === 0) {
          // No point retrying an auth/model-not-found failure on primary.
          yield { type: 'error', error: `provider ${cls} failure: ${reason}` };
          break outer;
        }
        if (transportRetries < TRANSPORT_MAX_RETRIES) {
          transportRetries++;
          yield { type: 'continuation-retry', attempt: transportRetries, reason };
          await sleep(150 * transportRetries);
          continue;
        }
        if (fbList.length) {
          yield* bounceEvents(doBounce());
          continue;
        }
        const why = cls ? ` (${cls})` : '';
        yield { type: 'error', error: `stream died after ${transportRetries} retries${why}: ${reason}` };
        break outer;
      }
      break;
    }

    if (config.contextOptimize) {
      prevHistoryForAlign = [...history];
    }

    const calls = accum.finish();

    // G3(b) LENGTH TRUNCATION: commit the partial text, ask the model to
    // continue, and keep looping on a separate continuation budget so these
    // rounds never consume maxIterations.
    if (stopReason === 'length' && !calls.length && continuedRounds < CONTINUATION_BUDGET) {
      continuedRounds++;
      history.push({ role: 'assistant', content: text });
      yield { type: 'continued', round: continuedRounds };
      history.push({ role: 'user', content: CONTINUE_PROMPT });
      iters--;
      yield { type: 'turn-end', stopReason, iters };
      continue outer;
    }

    // Progress note: when the model batches a reply with tool calls, the text
    // is an interim message, not a final answer. The turn continues. Only a
    // sole reply (no tool calls) ends the turn.
    if (calls.length > 0 && text) {
      yield { type: 'progress-note', text };
      history.push({ role: 'assistant', content: text, progressNote: true });
    }

    if (!calls.length) {
      const message = { role: 'assistant', content: text };
      history.push(message);

      // Security check of what this run changed (src/security-scan.js): the
      // model is told what it just introduced, once, and fixes it or says why
      // it is safe. Whatever the model, the harness looks. Off: OX_SECURE=0.
      if (securityRounds < 1 && toolCtx?.writtenFiles?.size && process.env.OX_SECURE !== '0') {
        securityRounds++;
        try {
          const { scanText, findingsForModel } = await import('./security-scan.js');
          const fsMod = await import('node:fs');
          const pathMod = await import('node:path');
          const findings = [];
          for (const f of toolCtx.writtenFiles) {
            const abs = pathMod.isAbsolute(f) ? f : pathMod.join(cwd, f);
            let text = '';
            try { text = fsMod.readFileSync(abs, 'utf8'); } catch { continue; }
            findings.push(...scanText(pathMod.relative(cwd, abs) || abs, text));
          }
          const note = findingsForModel(findings);
          yield { type: 'security-check', files: toolCtx.writtenFiles.size, findings: findings.length, high: findings.filter((x) => x.severity === 'high').length };
          if (note) {
            history.push({ role: 'user', content: note });
            yield { type: 'turn-end', stopReason, iters };
            continue outer;
          }
        } catch {}
      }

      // Completion is emitted only after all required checks pass. Streamed
      // text is a draft, not evidence that the run has completed.
      // Shell gates retry on a dedicated counter, then fail closed.
      if (gates.length) {
        const g = await runGates();
        for (const gev of g.events) yield gev;
        if (!g.passedAll) {
          const budgetLeft =
            gateBudgetStart == null || Date.now() - gateBudgetStart < GATE_BUDGET_MS;
          if (gateRetries < GATE_RETRY_CAP && budgetLeft) {
            gateRetries++;
            iters--;
            const lines = g.failures.map((f) =>
              f.skipped
                ? `Quality gate FAILED: ${f.cmd} exited ${f.exit} (state unchanged since last failure)`
                : `Quality gate FAILED: ${f.cmd} exited ${f.exit}`
            );
            history.push({
              role: 'user',
              content: `${lines.join('\n')}\n${String(g.lastFailContent).slice(-2048)}\nFix and ensure it passes.`,
            });
            yield { type: 'turn-end', stopReason, iters };
            continue outer;
          }
          yield { type: 'gate-exhausted', pending: g.failures.map((f) => f.cmd), retries: gateRetries };
          yield { type: 'error', error: `required quality gates failed: ${g.failures.map((f) => f.cmd).join(', ')}` };
          yield { type: 'turn-end', stopReason, iters };
          break outer;
        }
      }

      if (verify) {
        verifyRounds++;
        let verdict = { complete: false, gaps: 'goal judge did not return a verdict', usage: { inputTokens: 0, outputTokens: 0 } };
        try {
          verdict = await judgeGoal(
            aux ?? activeTarget,
            { goal: originalUserText, contract: goalContract, digest: buildDigest(history, text) },
            signal
          );
        } catch (err) {
          verdict.gaps = `goal judge error: ${truncate(err?.message ?? String(err), 400)}`;
        }
        const vUsage = verdict.usage ?? { inputTokens: 0, outputTokens: 0 };
        if (vUsage.inputTokens > 0 || vUsage.outputTokens > 0) {
          usage.inputTokens += vUsage.inputTokens;
          usage.outputTokens += vUsage.outputTokens;
          addAux(vUsage);
          yield {
            type: 'usage',
            inputTokens: vUsage.inputTokens,
            outputTokens: vUsage.outputTokens,
            costUsd: costOf(auxModelNow(), vUsage, costOverrides),
            model: auxModelNow(),
            ...(aux ? { aux: true } : {}),
          };
        }
        assertCostBudget();
        const criteria = verifierCriteriaFromContract(goalContract, cwd);
        let verifierReport = null;
        let verifierError = null;
        try {
          verifierReport = await verifier.verify(originalUserText, text, criteria);
        } catch (err) {
          verifierError = truncate(err?.message ?? String(err), 400);
        }
        const llmGaps = typeof verdict.gaps === 'string' ? verdict.gaps.trim() : '';
        const failedChecks = Array.isArray(verifierReport?.checks)
          ? verifierReport.checks.filter((check) => !check.passed)
          : [];
        const verifierGaps = failedChecks.length
          ? failedChecks
              .map((check) => `${check.name}: ${truncate(check.output || `exit ${check.exitCode ?? 'unknown'}`, 300)}`)
              .join('; ')
          : verifierReport?.passed === false
            ? 'verification checks failed'
            : '';
        const combinedGaps = [llmGaps, verifierGaps, verifierError ? `verifier error: ${verifierError}` : ''].filter(Boolean).join('; ');
        const complete = verdict.complete === true && !verifierError &&
          verifierReport?.passed === true && Array.isArray(verifierReport.checks) &&
          verifierReport.checks.every((check) => check.passed === true);
        const verificationEvent = {
          type: 'verification',
          round: verifyRounds,
          complete,
          gaps: combinedGaps,
          llm: { complete: verdict.complete === true, gaps: llmGaps },
          llmGaps,
          verifierPassed: verifierReport?.passed === true,
          verifierReport,
          verifierError,
          checks: verifierReport?.checks ?? [],
        };
        yield verificationEvent;
        if (!complete && verifyRounds < VERIFY_MAX_ROUNDS) {
          history.push({
            role: 'user',
            content: `Your work is incomplete. Unmet criteria: ${combinedGaps || 'verification did not pass'}. Continue.`,
          });
          yield { type: 'turn-end', stopReason, iters };
          continue outer;
        }
        if (!complete) {
          yield {
            type: 'error',
            error: `verification failed after ${verifyRounds} round(s): ${combinedGaps || 'verifier did not pass'}`,
          };
          yield { type: 'turn-end', stopReason, iters };
          break outer;
        }
      }
      yield { type: 'final', message };
      yield { type: 'turn-end', stopReason, iters };
      break;
    }

    const assistantTurn = {
      role: 'assistant',
      content: text || null,
      tool_calls: calls,
    };
    history.push(assistantTurn);
    yield { type: 'assistant-turn', message: assistantTurn };

    async function* runOne(call) {
      assertCostBudget();
      const name = call.function.name;
      const parsed = safeJsonParse(call.function.arguments || '{}');
      const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      // The plan itself (todo_write) travels with its tool-start, so a live view
      // can draw the checklist instead of a truncated JSON preview.
      const plan = name === 'todo_write' && Array.isArray(args.todos)
        ? args.todos.filter((t) => t && typeof t.content === 'string').slice(0, 40).map((t) => ({ content: String(t.content).slice(0, 200), status: String(t.status ?? 'pending') }))
        : null;
      yield { type: 'tool-start', id: call.id, name, argsPreview: truncate(JSON.stringify(args), 120), ...(plan ? { plan } : {}) };
      const started = Date.now();
      let result;
      let neutral = false;
      // Wave5a E: consecutive-identical doom-loop detection. The 3rd identical
      // occurrence never executes; it does NOT count toward self-heal
      // exhaustion and resets as soon as a different call arrives.
      const doomKey = `${name}\u0000${stableStringify(args)}`;
      if (doomKey === doomLastKey) doomCount++;
      else {
        doomLastKey = doomKey;
        doomCount = 1;
      }
      // Wave5a F audit plumbing for this call.
      let gateActor = 'policy';
      let gateRule = 'auto-allow';
      // The mode is checked before any approval: asking someone to approve a
      // write that Ask or Plan mode will refuse anyway is a question with no
      // point, and with no one to ask it reads as "declined" instead of why.
      const modeNo = modeRefusal(toolCtx.mode, name, args, toolCtx.cwd ?? cwd) ?? grantRefusal(toolCtx.allowedTools, name, toolCtx.agentName);
      if (signal?.aborted) {
        result = { content: '[aborted]', isError: true };
        neutral = true;
      } else if (declinedThisTurn && needsApproval(name, toolCtx)) {
        // A turn can carry several gated calls (they run one after another);
        // once the user has said no to one, the rest of that turn does not run.
        result = { content: '[skipped: the user declined an earlier action in this turn; ask before trying again]', isError: true };
        neutral = true;
      } else if (modeNo) {
        recordDecision({ session: toolCtx.sessionId, tool: name, args, detail: approvalDetail(name, args), decision: 'deny', rule: `mode:${toolCtx.mode}`, actor: 'policy' });
        result = { content: modeNo, isError: true };
        neutral = true;
      } else if (doomCount >= 3) {
        yield { type: 'doom-loop', key: doomKey, count: doomCount };
        const dref = recordDecision({
          session: toolCtx.sessionId,
          tool: name,
          args,
          detail: approvalDetail(name, args),
          decision: 'deny',
          rule: 'doom-loop',
          actor: 'policy',
        });
        recordOutcome({ ref: dref, ok: false, error: 'doom-loop blocked before execution' });
        result = { content: `Blocked by safety policy: doom-loop — ${DOOM_GUIDANCE}`, isError: true };
        neutral = true;
        guidance = DOOM_GUIDANCE;
        guidanceKey = null;
      } else if (name.startsWith('mcp__')) {
        const verdict = resolveMcpPolicy(name, toolCtx, policyWarned);
        const mcpServer = parseMcpToolName(name)?.server ?? name;
        if (verdict.decision === 'deny') {
          // Explicit mcpPolicy deny: never executed, not even under yolo.
          const denyRule = `mcpPolicy:${mcpServer}:deny`;
          const dref = recordDecision({
            session: toolCtx.sessionId,
            tool: name,
            args,
            detail: approvalDetail(name, args),
            decision: 'deny',
            rule: denyRule,
            actor: 'policy',
          });
          recordOutcome({ ref: dref, ok: false, error: `denied by ${denyRule}` });
          result = { content: `Blocked by policy (mcpPolicy: server '${mcpServer}' denied by explicit mcpPolicy deny rule '${denyRule}')`, isError: true };
          neutral = true;
        } else if (verdict.decision === 'allow') {
          gateActor = 'policy';
          gateRule = `mcpPolicy:${mcpServer}:allow`;
          // Policy-authorized: skip interactive approval and execute.
        } else if (needsApproval(name, toolCtx)) {
          const ok = await askApproval(toolCtx, name, args, approvalDetail(name, args));
          gateActor = 'approval';
          if (!ok) {
            recordDecision({
              session: toolCtx.sessionId,
              tool: name,
              args,
              detail: approvalDetail(name, args),
              decision: 'deny',
              rule: 'user-declined',
              actor: 'approval',
            });
            result = { content: "User declined this action (rule: user-declined). It must not be retried.", isError: true };
            neutral = true;
            declinedThisTurn = true;
          } else {
            gateRule = 'user-approved';
          }
        }
      } else if (needsApproval(name, toolCtx)) {
        // Wave5b K: read-only auto-approve ladder — provably read-only bash
        // commands skip the prompt in default mode but stay audit-recorded.
        const rov = readOnlyAutoVerdict(name, args, toolCtx);
        if (rov.auto) {
          gateActor = 'readonly-classifier';
          gateRule = rov.rule ?? 'readonly-auto';
          yield { type: 'approval', name, decision: 'auto', mode: 'read-only', detail: approvalDetail(name, args) };
        } else {
          const ok = await askApproval(toolCtx, name, args, approvalDetail(name, args));
          gateActor = 'approval';
          if (!ok) {
            recordDecision({
              session: toolCtx.sessionId,
              tool: name,
              args,
              detail: approvalDetail(name, args),
              decision: 'deny',
              rule: 'user-declined',
              actor: 'approval',
            });
            result = { content: "User declined this action (rule: user-declined). It must not be retried.", isError: true };
            neutral = true;
            declinedThisTurn = true;
          } else {
            gateRule = 'user-approved';
          }
        }
      }
      let aref = null;
      if (!result) {
        aref = recordDecision({
          session: toolCtx.sessionId,
          tool: name,
          args,
          detail: approvalDetail(name, args),
          decision: 'allow',
          rule: gateRule,
          actor: gateActor,
        });
        // PreToolUse hook
        const preHookData = {
          cwd,
          sessionId: toolCtx.sessionId,
          tool: name,
          args,
          preview: JSON.stringify(args).slice(0, 200),
        };
        const preHookResult = await fireHooks('PreToolUse', preHookData, hooksConfig, { cwd });
        if (preHookResult.decision === 'deny') {
          result = {
            content: `[blocked by hook: ${preHookResult.errors.map((e) => e.error).join('; ')}]`,
            isError: true,
          };
        } else {
          try {
            result = await dispatchTool(name, args, toolCtx);
          } catch (err) {
            result = { content: String(err?.message ?? err), isError: true };
          }
          // Append hook output to tool result if any
          if (preHookResult.outputs.length) {
            const hookOutput = formatHookOutputs(preHookResult.outputs);
            if (hookOutput) {
              result.content = `${result.content ?? ''}\n\n${hookOutput}`.trim();
            }
          }
        }
        recordOutcome({ ref: aref, ok: !result?.isError, error: String(result?.content ?? '').slice(0, 200) });
      }
      const isError = !!result?.isError;
      const content = String(result?.content ?? '');
      // Drained BEFORE this call's own tool-end, so a subagent's lifecycle reads
      // in causal order -- spawn, start, progress, end, THEN the parent learns
      // the subagent tool returned. Draining after would put "the subagent
      // finished" before "the subagent finished".
      yield* flushSubagentEvents();
      yield {
        type: 'tool-end',
        id: call.id,
        name,
        ok: !isError,
        isError,
        ms: Date.now() - started,
        bytes: content.length,
        ...(result?.meta !== undefined ? { meta: result.meta } : {}),
        // The paths a mutating tool ACTUALLY wrote, in the same shape the
        // subagent accumulator already reads. Before this the field existed
        // downstream (subagent.js) and nowhere upstream, so a subagent's
        // filesTouched was always empty no matter what it did.
        ...(Array.isArray(result?.filesTouched) && result.filesTouched.length
          ? { filesTouched: result.filesTouched }
          : {}),
      };
      history.push({ role: "tool", tool_call_id: call.id, content });

      // PostToolUse hook
      const postHookData = {
        cwd,
        sessionId: toolCtx.sessionId,
        tool: name,
        args,
        result: { isError, content: content.slice(0, 200) },
      };
      await fireHooks('PostToolUse', postHookData, hooksConfig, { cwd });

      const key = failureKey(name, args);
      const lintFail = !isError && result?.meta?.lintFail === true;
      if (isError && !neutral) {
        failures.set(key, (failures.get(key) ?? 0) + 1);
        const count = failures.get(key);
        yield { type: 'reflection', text: 'diagnose before retrying', key, count };
        if (count >= 2 && !lessoned.has(key)) {
          lessoned.add(key);
          const firstErrorLine = (content.split('\n').find((l) => l.trim()) ?? '').slice(0, 200);
          try {
            toolCtx.memory?.recordLesson?.(`repeated failure: ${key} — ${firstErrorLine}`);
          } catch {}
        }
        if (count >= 3) {
          yield { type: 'error', error: 'self-heal budget exhausted', key };
          history.push({ role: 'tool', tool_call_id: call.id, content });
          for (const sib of calls.slice(ci + 1)) {
            history.push({ role: 'tool', tool_call_id: sib.id, content: '[skipped: prior call failed]' });
          }
          shouldBreak = true;
          skippedSiblings = calls.slice(ci + 1);
          return;
        }
        let g = `Previous attempt failed: ${truncate(content || 'unknown error', 400)}. Write a 1-3 sentence diagnosis, then RETRY WITH A DIFFERENT APPROACH.`;
        if (count >= 2) {
          g += ' This exact target failed twice — change strategy fundamentally or stop and report.';
        }
        guidance = g;
        guidanceKey = key;
      } else if (lintFail) {
        // G4: syntax advisory = external failure signal. It increments the
        // same failure tracker so repeat offenders escalate their guidance,
        // but stays advisory: no self-heal budget exhaustion and no
        // approval-denial accounting.
        failures.set(key, (failures.get(key) ?? 0) + 1);
        const count = failures.get(key);
        yield { type: 'reflection', text: 'syntax check failed — repair before continuing', key, count };
        const targetPath = typeof args?.path === 'string' ? args.path : key;
        let g = `The previous edit left ${targetPath} with invalid syntax. Re-read the file and fix the syntax error before anything else.`;
        if (count >= 2) {
          g += ' This target failed its syntax check twice — repair it now.';
        }
        guidance = g;
        guidanceKey = key;
      } else if (!isError) {
        failures.delete(key);
        lessoned.delete(key);
        if (guidanceKey === key) {
          guidance = '';
          guidanceKey = null;
        }
      }


    }

    // Parallel read-only tool execution helper: runs a single tool call and returns
    // the tool-end event with content, without yielding intermediate events.
    // Parallel tool execution helper: runs a single tool call and returns
    // the tool-end event with content, without yielding intermediate events.
    //
    // Used for a batch of read-only calls AND for one call of a concurrent
    // subagent batch, which is why it takes an optional per-call context
    // overlay: a fan-out needs to hand ONE lane its batch index, its wait at
    // the cap and its share of the cost budget, and that must not leak into the
    // other lanes or into the loop-level ctx. `tctx` is that overlay applied;
    // with no overlay it IS tctx, so every existing caller is byte-identical.
    async function executeReadOnlyTool(call, ctxOverlay) {
      const tctx = ctxOverlay ? { ...toolCtx, ...ctxOverlay } : toolCtx;

      assertCostBudget();
      const name = call.function.name;
      const parsed = safeJsonParse(call.function.arguments || '{}');
      const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      const started = Date.now();
      let result;
      let neutral = false;
      // Wave5a E: consecutive-identical doom-loop detection.
      const doomKey = `${name}|${stableStringify(args)}`;
      if (doomKey === doomLastKey) doomCount++;
      else {
        doomLastKey = doomKey;
        doomCount = 1;
      }
      // Wave5a F audit plumbing for this call.
      //
      // A lane of a concurrent batch inherits the BATCH's gate decision, so the
      // per-call audit row names the authorization that actually covered it. The
      // default 'auto-allow' would be a fiction here: nothing about this call
      // was allowed by a default, it was allowed by the batch an operator saw
      // in full and approved once.
      let gateActor = tctx._batchGate?.actor ?? 'policy';
      let gateRule = tctx._batchGate?.rule ?? 'auto-allow';
      if (signal?.aborted) {
        result = { content: '[aborted]', isError: true };
        neutral = true;
      } else if (doomCount >= 3) {
        const dref = recordDecision({
          session: tctx.sessionId,
          tool: name,
          args,
          detail: approvalDetail(name, args),
          decision: 'deny',
          rule: 'doom-loop',
          actor: 'policy',
        });
        recordOutcome({ ref: dref, ok: false, error: 'doom-loop blocked before execution' });
        result = { content: `Blocked by safety policy: doom-loop — ${DOOM_GUIDANCE}`, isError: true };
        neutral = true;
      } else if (name.startsWith('mcp__')) {
        const verdict = resolveMcpPolicy(name, tctx, policyWarned);
        const mcpServer = parseMcpToolName(name)?.server ?? name;
        if (verdict.decision === 'deny') {
          const denyRule = `mcpPolicy:${mcpServer}:deny`;
          const dref = recordDecision({
            session: tctx.sessionId,
            tool: name,
            args,
            detail: approvalDetail(name, args),
            decision: 'deny',
            rule: denyRule,
            actor: 'policy',
          });
          recordOutcome({ ref: dref, ok: false, error: `denied by ${denyRule}` });
          result = { content: `Blocked by policy (mcpPolicy: server '${mcpServer}' denied by explicit mcpPolicy deny rule '${denyRule}')`, isError: true };
          neutral = true;
        } else if (verdict.decision === 'allow') {
          gateActor = 'policy';
          gateRule = `mcpPolicy:${mcpServer}:allow`;
        } else if (needsApproval(name, tctx)) {
          result = { content: "Approval required but parallel execution cannot prompt", isError: true };
          neutral = true;
        }
      } else if (needsApproval(name, tctx)) {
        const rov = readOnlyAutoVerdict(name, args, tctx);
        if (rov.auto) {
          gateActor = 'readonly-classifier';
          gateRule = rov.rule ?? 'readonly-auto';
        } else {
          result = { content: "Approval required but parallel execution cannot prompt", isError: true };
          neutral = true;
        }
      }
      let aref = null;
      if (!result) {
        aref = recordDecision({
          session: tctx.sessionId,
          tool: name,
          args,
          detail: approvalDetail(name, args),
          decision: 'allow',
          rule: gateRule,
          actor: gateActor,
        });
        const preHookData = {
          cwd,
          sessionId: tctx.sessionId,
          tool: name,
          args,
          preview: JSON.stringify(args).slice(0, 200),
        };
        const preHookResult = await fireHooks('PreToolUse', preHookData, hooksConfig, { cwd });
        if (preHookResult.decision === 'deny') {
          result = { content: `[blocked by hook: ${preHookResult.errors.map((e) => e.error).join('; ')}]`, isError: true };
        } else {
          try { result = await dispatchTool(name, args, tctx); }
          catch (err) { result = { content: String(err?.message ?? err), isError: true }; }
          if (preHookResult.outputs.length) {
            const hookOutput = formatHookOutputs(preHookResult.outputs);
            if (hookOutput) result.content = `${result.content ?? ''}

${hookOutput}`.trim();
          }
        }
        recordOutcome({ ref: aref, ok: !result?.isError, error: String(result?.content ?? '').slice(0, 200) });
      }
      const isError = !!result?.isError;
      const contentStr = String(result?.content ?? '');
      const toolEndEvent = {
        type: 'tool-end', id: call.id, name, ok: !isError, isError,
        ms: Date.now() - started, bytes: contentStr.length, content: contentStr,
        ...(result?.meta !== undefined ? { meta: result.meta } : {}),
        ...(Array.isArray(result?.filesTouched) && result.filesTouched.length
          ? { filesTouched: result.filesTouched }
          : {}),
      };
      const postHookData = { cwd, sessionId: tctx.sessionId, tool: name, args, result: { isError, content: contentStr.slice(0, 200) } };
      await fireHooks('PostToolUse', postHookData, hooksConfig, { cwd });
      return { event: toolEndEvent, content: contentStr };
    }

    // ---- concurrent subagent batch ------------------------------------------
    //
    // Bounded worker pool over one approval_gated group. Lanes are plain async
    // functions -- a generator cannot yield from a promise the loop is not
    // driving -- so a lane PUBLISHES onto `laneCh` and this generator drains
    // it. The alternative (yield all the tool-starts up front, like the
    // read-only path) would open N calls in the UI and then leave N-`cap` of
    // them visibly idle, and the deferral itself would have nowhere to go until
    // the whole batch was over: exactly the silent throttle this is built to
    // avoid.
    function makeLaneChannel() {
      const items = [];
      let waiter = null;
      const wake = () => { const w = waiter; waiter = null; w?.(); };
      return {
        push(ev) { items.push(ev); wake(); },
        close() { items.push(null); wake(); },
        async next() {
          if (items.length) return items.shift();
          await new Promise((r) => { waiter = r; });
          return items.length ? items.shift() : null;
        },
      };
    }

    async function* runSubagentBatch(batchCalls, tool) {
      const size = batchCalls.length;
      const configuredCap = resolveSubagentConcurrency(config);
      const gate = await resolveParallelBatchGate(toolCtx, batchCalls);
      // ONE decision for the batch, recorded once. N decisions would read in
      // the audit as N separate authorisations of work that was authorised
      // together, which is the opposite of what happened.
      const batchId = `sb_${Date.now().toString(36)}${(subagentBatchCounter++).toString(36)}`;
      let cap = gate.mode === 'concurrent' ? configuredCap : 1;
      let admitted = Math.min(size, cap);
      let deferred = size - admitted;

      let money = { blocked: null, perAgentUsd: null, sessionCapUsd: null, remainingUsd: null };
      if (gate.mode !== 'deny') {
        money = resolveBatchCostDivision(admitted, config);
        if (money.blocked) {
          cap = 0;
          admitted = 0;
          deferred = size;
          gate.mode = 'deny';
          gate.gateActor = 'policy';
          gate.gateRule = 'cost-cap';
          gate.blocked = money.blocked;
        }
        noteSubagentBatch({
          batchId,
          size,
          cap: configuredCap,
          mode: gate.mode,
          gateRule: gate.gateRule,
          admitted,
          deferred,
          perAgentCostCeilingUsd: money.perAgentUsd,
          sessionCostCapUsd: money.sessionCapUsd,
        });
      } else {
        noteSubagentBatch({ batchId, size, cap: configuredCap, mode: 'deny', gateRule: gate.gateRule, admitted: 0, deferred: size });
      }

      const dref = recordDecision({
        session: toolCtx.sessionId,
        tool,
        args: gate.args ?? {},
        detail: gate.detail ?? '',
        decision: gate.mode === 'deny' ? 'deny' : 'allow',
        rule: gate.gateRule,
        actor: gate.gateActor,
      });

      // The batch announcement. It is the operator's answer to "what is this
      // turn about to do, and what did it cost me to let it".
      const moneyText = money.perAgentUsd == null ? 'n/a (no cost cap in force)' : `$${money.perAgentUsd.toFixed(4)}`;
      const moneyLine = gate.mode === 'deny'
        ? ''
        : ` · per-agent cost ceiling ${cap === 1 ? 'n/a (serial)' : `${moneyText} each`}` +
          (money.sessionCapUsd == null ? '' : ` of $${money.sessionCapUsd} session cap`);
      yield {
        type: 'progress-note',
        text: `subagent batch ${batchId}: ${gate.mode === 'deny' ? 'REFUSED' : `${admitted} of ${size} running concurrently (cap ${cap})`}` +
          `${deferred > 0 ? `, ${deferred} deferred to the next free slot` : ''}` +
          `${gate.mode === 'serial' ? ' · no approver attached, downgraded to serial' : ''}` +
          `${moneyLine}`,
      };

      if (gate.mode === 'deny') {
        const content = `${gate.blocked ?? `Blocked by approval (rule: ${gate.gateRule}). All ${size} subagents in this batch were refused; none ran.`}`;
        for (const call of batchCalls) {
          yield { type: 'tool-start', id: call.id, name: tool, argsPreview: truncate(String(call.function.arguments ?? ''), 120) };
          yield { type: 'tool-end', id: call.id, name: tool, ok: false, isError: true, ms: 0, bytes: content.length, content };
          history.push({ role: 'tool', tool_call_id: call.id, content });
        }
        recordOutcome({ ref: dref, ok: false, error: content.slice(0, 200) });
        return;
      }

      const batchStartedAt = Date.now();
      const laneCh = makeLaneChannel();
      const results = new Array(size);
      let next = 0;
      const lanes = Math.max(1, Math.min(cap, size));

      // Set when the CONSUMER walks away from the stream (SIGINT, budget stop,
      // an early break). An agent already admitted still runs to completion --
      // it has a live registry record and an operator watching it, and killing
      // it would strand that record -- but no FURTHER agent is spawned after the
      // consumer is gone, which is the difference between a cancelled fan-out
      // and a runaway one.
      let closed = false;

      const lane = async () => {
        for (;;) {
          if (closed) return;
          const index = next++;
          if (index >= size) return;
          const call = batchCalls[index];
          const admittedAt = Date.now();
          const deferredMs = admittedAt - batchStartedAt;
          // Deferred is a property of the INDEX, not of the clock: with `cap`
          // lanes the first `cap` calls are admitted immediately and every later
          // one is served in a second round, so `index >= cap` is exactly the
          // deferred set. Measuring it as "elapsed > 0" would mark lane 2's
          // first call as deferred whenever lane 1 happened to reach its admit
          // point a millisecond later -- a visible lie about a queue that did
          // not exist.
          const wasDeferred = index >= cap;
          noteSubagentLive();
          // At ADMISSION, not up front: a `tool-start` line means "this is
          // running", and a call that has not been admitted is not running.
          laneCh.push({ type: 'tool-start', id: call.id, name: tool, argsPreview: truncate(String(call.function.arguments ?? ''), 120) });
          if (wasDeferred) {
            laneCh.push({
              type: 'progress-note',
              text: `subagent call ${index + 1}/${size} waited ${deferredMs}ms for a free slot (parallel subagent cap ${cap}) before starting`,
            });
          }
          let r;
          try {
            r = await executeReadOnlyTool(call, {
              _batchGate: { actor: gate.gateActor, rule: gate.gateRule, batchId, mode: gate.mode },
              _subagentBatch: {
                batchId,
                batchIndex: index,
                batchSize: size,
                concurrency: cap,
                deferred: wasDeferred,
                deferredMs,
                perAgentCostCeilingUsd: money.perAgentUsd,
                sessionCostCapUsd: money.sessionCapUsd,
              },
            });
          } catch (err) {
            const content = String(err?.message ?? err);
            r = {
              event: { type: 'tool-end', id: call.id, name: tool, ok: false, isError: true, ms: Date.now() - admittedAt, bytes: content.length, content },
              content,
            };
          }
          r.batchIndex = index;
          r.deferred = wasDeferred;
          r.deferredMs = deferredMs;
          results[index] = r;
        }
      };

      const settled = Promise.all(Array.from({ length: lanes }, lane)).then(
        () => laneCh.close(),
        () => laneCh.close(),
      );
      try {
        for (;;) {
          const ev = await laneCh.next();
          if (ev === null) break;
          yield ev;
        }
        await settled;
      } finally {
        closed = true;
      }

      // Lifecycle events are drained in BATCH order here, not per call: under
      // concurrency a lane's own events are already interleaved in completion
      // order in the queue, and draining per call would not make them any more
      // ordered -- it would only make the parent's stream harder to read.
      // Per-agent order is preserved by the queue (append-only) and is
      // independently checkable from the per-agent `seq` on each event.
      yield* flushSubagentEvents();

      for (let i = 0; i < size; i++) {
        const r = results[i];
        if (!r) continue;
        const note = r.deferred
          ? `\n[subagent call ${i + 1}/${size} waited ${r.deferredMs}ms for a free slot — parallel subagent cap ${cap}]`
          : '';
        const content = note ? `${r.content ?? ''}${note}` : (r.content ?? '');
        r.event.content = content;
        r.event.bytes = content.length;
        yield r.event;
        history.push({ role: 'tool', tool_call_id: r.event.id, content });
        const key = failureKey(r.event.name, callArgs(batchCalls[i]));
        if (r.event.isError) {
          const count = (failures.get(key) ?? 0) + 1;
          failures.set(key, count);
          if (count >= 3) {
            yield { type: 'error', error: 'self-heal budget exhausted', key };
            shouldBreak = true;
            break;
          }
        } else {
          failures.delete(key);
        }
      }
      recordOutcome({ ref: dref, ok: !shouldBreak, error: shouldBreak ? 'self-heal budget exhausted' : '' });
    }

    // One decision per turn, taken BEFORE anything executes: a batch that is
    // going to be refused is refused whole, so a mixed batch cannot half-run
    // and then report an error it already caused.
    const plan = batchPlan(calls);
    const groups = plan.groups;
    if (plan.mode === 'reject') {
      yield { type: 'error', error: plan.reason };
      continue outer;
    }
    let ci = 0;
    let shouldBreak = false;
    let declinedThisTurn = false;
    let skippedSiblings = [];
    let groupIdx = 0;
    for (const group of groups) {
      if (group.class === 'unknown') {
        yield { type: 'error', error: 'unknown tools are forbidden in a batch' };
        continue outer;
      }
      if (group.class === 'terminal' && groupIdx !== groups.length - 1) {
        yield { type: 'error', error: 'terminal call must be the last call in the batch' };
        continue outer;
      }

      if (group.class === 'approval_gated' && plan.mode === 'concurrent') {
        // The batchPlan gate above already proved: one group, one tool, and a
        // scheduler for it. Everything else about the turn still applies.
        yield* runSubagentBatch(group.calls, group.calls[0]?.function?.name ?? 'subagent');
        ci += group.calls.length;
        groupIdx++;
        if (shouldBreak) {
          for (const sib of skippedSiblings) {
            history.push({ role: 'tool', tool_call_id: sib.id, content: '[skipped: prior call failed]' });
          }
          break outer;
        }
        continue;
      }

      if (group.class === 'pure_read') {
        if (config?.parallelReadOnly !== false && group.calls.length > 1) {
          // Parallel execution: yield all tool-start, execute all, yield all tool-end
          for (const call of group.calls) {
            const name = call.function.name;
            const parsed = safeJsonParse(call.function.arguments || '{}');
            const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            yield { type: 'tool-start', id: call.id, name, argsPreview: truncate(JSON.stringify(args), 120) };
          }
          // Execute all read-only tools in parallel
          const results = await Promise.all(group.calls.map(call => executeReadOnlyTool(call)));
          for (const [ri, result] of results.entries()) {
            yield result.event;
            history.push({ role: 'tool', tool_call_id: result.event.id, content: result.content });
            if (result.event.isError) {
              // Keyed on the call's own arguments, like runOne: three different
              // files that fail are three targets, not one failing three times.
              const key = failureKey(result.event.name, callArgs(group.calls[ri]));
              const count = (failures.get(key) ?? 0) + 1;
              failures.set(key, count);
              if (count >= 3) {
                yield { type: 'error', error: 'self-heal budget exhausted', key };
                shouldBreak = true;
                break;
              }
            }
          }
          ci += group.calls.length;
          if (shouldBreak) {
            break outer;
          }
        } else {
          for (const call of group.calls) {
            yield* runOne(call);
            ci++;
            if (shouldBreak) {
              for (const sib of skippedSiblings) {
                history.push({ role: 'tool', tool_call_id: sib.id, content: '[skipped: prior call failed]' });
              }
              break outer;
            }
          }
        }
      } else {
        // fs_write, approval_gated, memory_write, terminal: serial, exactly as today.
        for (const call of group.calls) {
          yield* runOne(call);
          ci++;
          if (shouldBreak) {
            for (const sib of skippedSiblings) {
              history.push({ role: 'tool', tool_call_id: sib.id, content: '[skipped: prior call failed]' });
            }
            break outer;
          }
        }
      }
      groupIdx++;
    }
    yield { type: 'turn-end', stopReason, iters };
    continue outer;
  }

  // Teardown. Reached exactly ONCE per runAgentLoop() call: every `break`,
  // `break outer`, and normal exit of the `outer: while` above funnels through
  // this point. Deliberately NOT attached to any of the `turn-end` yields
  // inside the loop (there are several, and most are `continue outer`, not
  // exits) -- attaching SessionStop to one of those would fire it per turn.
  // Drain first: the fire-and-forget PreLLM/PostLLM hooks from this run must be
  // finished before SessionStop runs, so a SessionStop hook sees the markers
  // its siblings wrote. SessionStop itself is blocking: a teardown hook that
  // is still running when the process exits is a hook that did not run.
  await drainPendingHooks();
  await fireLifecycle('SessionStop', {
    cwd,
    sessionId: toolCtx?.sessionId,
    bot: target?.bot ?? null,
    model: activeTarget?.model ?? model,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
  }, true);
  yield* flushHookEvents();

  // F2: main cost sums each active-model bucket at that model's pricing, so
  // tokens served by a fallback target are billed at the fallback's rates.
  let mainCostSum = 0;
  let anyMainPriced = false;
  for (const [m, u] of usageByModel) {
    const c = costOf(m, u, costOverrides);
    if (typeof c === 'number') {
      anyMainPriced = true;
      mainCostSum += c;
    }
  }
  const mainCost = anyMainPriced ? mainCostSum : null;
  const finalModel = activeTarget?.model ?? model;
  const auxCostUsd = auxSpend ? costOf(aux?.model ?? finalModel, auxUsage, costOverrides) : null;
  const costParts = [mainCost, auxCostUsd].filter((v) => typeof v === 'number');
  yield {
    type: 'usage-total',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // How much of the input the provider served from its prompt cache.
    ...(usage.cacheReadTokens || usage.cacheWriteTokens ? { cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens } : {}),
    costUsd: costParts.length ? costParts.reduce((a, b) => a + b, 0) : null,
    auxInputTokens: auxUsage.inputTokens,
    auxOutputTokens: auxUsage.outputTokens,
    auxCostUsd,
    model: finalModel,
    // Endpoint honesty: the same event already reports servedBy (which embeds the
    // base URL via targetLabel) whenever a bounce happened. Always carry the
    // effective provider + baseUrl so a run record shows exactly which endpoint
    // served the tokens — an OX_BASE_URL override must never be invisible.
    provider: activeTarget?.provider ?? null,
    baseUrl: activeTarget?.baseUrl ?? null,
    ...(bouncedThisTurn ? { fellBack: true, servedBy: targetLabel(activeTarget) } : {}),
    ...(aux ? { auxBot: aux.bot ?? null, auxModel } : {}),
  };
  yield { type: 'history', messages: sanitizeHistory([...history]) };
}
// Live event fan-out. When a GUI bridge is attached (`ox --ipc`, wired into
// ctx.ipcBroadcast by assembleCtx), every event is mirrored to the connected
// clients BEFORE the consumer sees it, in yield order, so a watcher's view can
// never lag the terminal's. The broadcaster coalesces text-delta chunks (see
// createEventBroadcaster in src/ipc.js) and is wrapped in try/catch on both
// sides: it is a side channel, so it may never add latency, throw into the
// loop, or keep the process alive. With no bridge attached this is a plain
// pass-through and the loop is byte-for-byte the pre-IPC one.
async function* withIpcBroadcast(opts, source) {
  const broadcast = opts?.ctx?.ipcBroadcast;
  if (typeof broadcast !== 'function') {
    yield* source;
    return;
  }
  try {
    for await (const ev of source) {
      // A subagent lifecycle event is broadcast the INSTANT it happens, from
      // inside the running subagent, because the parent loop is blocked awaiting
      // the tool and cannot yield it until the subagent is already over -- that
      // is what makes the live dashboard live. By the time the queue drains
      // here, the same event has already crossed the socket; sending it again
      // would replay a subagent's whole run onto the wire in one burst.
      if (!alreadyLiveBroadcast(ev)) {
        try {
          broadcast(ev);
        } catch { /* telemetry must never break the agent loop */ }
      }
      yield ev;
    }
  } finally {
    // A consumer that breaks out mid-stream (SIGINT, budget stop) still gets
    // the buffered text flushed rather than silently dropped.
    try {
      broadcast.flush?.();
    } catch {}
    // Same reason, for hooks: a fire-and-forget PreLLM/PostLLM that was already
    // dispatched gets to finish even though the loop stopped early. Never
    // throws -- it only awaits promises that already have a .catch attached.
    try {
      await drainPendingHooks();
    } catch {}
  }
}

export function runAgent(opts = {}) {
  // Resolved HERE, not on the first next(): a rejected cwd then throws
  // synchronously at the runAgent() call site, with the caller on the
  // stack, instead of surfacing later as a rejected event stream.
  resolveRunCwd(opts);
  // Every run's tokens are kept by model, agent and surface (src/usage-log.js).
  if (opts?.target?.provider === 'subscription') {
    return withUsageLog(opts, withTrace(opts, withIpcBroadcast(opts, runSubscriptionTurn({ ...opts, ctx: { ...(opts.ctx ?? {}), cwd: resolveRunCwd(opts) } }))));
  }
  // Each run is traced and watched for being stuck (src/trace.js).
  return withUsageLog(opts, withTrace(opts, withIpcBroadcast(opts, runAgentLoop(opts))));
}

export async function runAgentCollect(opts) {
  const events = [];
  let messages = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let costUsd = null;
  for await (const ev of runAgent(opts)) {
    events.push(ev);
    if (ev.type === 'history') messages = ev.messages;
    if (ev.type === 'usage-total') {
      usage = { inputTokens: ev.inputTokens ?? 0, outputTokens: ev.outputTokens ?? 0 };
      costUsd = ev.costUsd ?? null;
    }
  }
  // Self-improvement: reflect on the session and extract patterns.
  // Opt-in via config.selfImprove or env OX_SELF_IMPROVE.
  if (opts?.config?.selfImprove || process.env.OX_SELF_IMPROVE === '1') {
    try {
      const toolNames = events
        .filter((e) => e?.type === 'tool-end')
        .map((e) => e.name);
      const taskText = (opts.messages?.[0]?.content ?? '').slice(0, 200);
      const result = await reflectSession({
        cwd: resolveRunCwd(opts),
        config: opts?.config ?? {},
        target: opts?.target,
        sessionSummary: {
          task: taskText,
          outcome: 'completed',
          events: events.filter((e) => e?.type === 'tool-end' || e?.type === 'tool-start'),
        },
      });
      events.push({ type: 'self-improve', recorded: result.recorded, total: result.total });
    } catch { /* never let reflection break the agent */ }
  }
  return { messages, usage, costUsd, events };
}
