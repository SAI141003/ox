// Hooks system: user-defined shell commands that fire at agent lifecycle
// points. Modeled after Claude Code's hooks but zero-dep and simpler.
//
// Config: ~/.ox/config.json (global) or ./.ox/hooks.json (project, overrides).
// Schema:
//   {
//     "hooks": {
//       "PreToolUse":    [{ "matcher": "Bash|Edit", "command": "...", "timeoutMs"?: 10000 }],
//       "PostToolUse":   [{ "matcher": "...",       "command": "..." }],
//       "PreLLM":        [{ "command": "..." }],   // fired per LLM call, non-blocking
//       "PostLLM":       [{ "command": "..." }],   // fired per LLM call, non-blocking
//       "SessionStart":  [{ "command": "..." }],   // fired once per run, blocking
//       "SessionStop":   [{ "command": "..." }]    // fired once per run, blocking
//     }
//   }
//
// ALL SIX DECLARED EVENTS ARE WIRED. Every name in `HOOK_EVENTS` has a call
// site in src/agent.js; test/hook-events.test.js drives all six through the
// real agent loop and test/hooks.test.js guards the call-site set against
// drift. What each one means here:
//
//   PreToolUse    before tool dispatch, on BOTH the serial and the parallel
//                 read-only path. Blocking. exit 2 denies the tool.
//   PostToolUse   after dispatch. Blocking.
//   PreLLM        immediately before each streamVia() request.
//   PostLLM       after each streamVia() request completes OR throws.
//   SessionStart  once per runAgentLoop() call, before the first LLM call.
//   SessionStop   once per runAgentLoop() call, at teardown.
//
// PreLLM/PostLLM fire once per stream ATTEMPT (so a transport retry or a
// fallback bounce produces a fresh PreLLM/PostLLM pair, matching what actually
// hit the provider), while SessionStart/SessionStop fire once per run.
//
// BLOCKING vs NON-BLOCKING: runHook is awaited serially with a 10s default
// timeout and fails open, so every blocking hook is up to 10s of dead latency.
// PreLLM/PostLLM therefore fire-and-forget with an explicit catch that cannot
// throw into the agent loop; the run keeps their in-flight promises and drains
// them at teardown so a hook is never silently lost on exit. Measured cost of
// the two extra blocking awaits: ~5.5ms/turn for trivial `sh -c` hooks, and up
// to 2 x timeoutMs per turn in the fail-open hang case. SessionStart/SessionStop
// stay blocking (once per run, ~5.5ms total) because a teardown hook must be
// finished before the process exits. PreToolUse/PostToolUse semantics are
// unchanged.
//
// NOT SILENT: whenever a configured hook actually fires, the agent loop emits a
// `hook-event` NDJSON event (visible under `--json`) carrying the event name
// and whether it was blocking or fire-and-forget. A user who configures a hook
// can never get silence with no signal. `hooksFor()` is the shared predicate:
// the agent uses it to decide whether to emit, fireHooks uses it to decide what
// to run, so the two cannot disagree.
//
// matcher: optional, pipe-separated tool names (anchored regex). Absent = match all.
// FAIL-OPEN: a hook that times out (default 10s) or errors resolves to
// decision 'allow'. Hooks can block only by succeeding with exit code 2; they
// can never block by failing. Hooks are awaited serially, each stalling the
// agent loop up to its timeout. Not a security control.
// PreToolUse exit code 2 = DENY the tool call (tool result is replaced with
// "[blocked by hook: <stderr>]"). Exit code 0 + stdout is appended to the
// tool result as extra context for the model to see. PostToolUse stdout is
// discarded. Hook errors are swallowed, not logged.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shellArgv } from './shell.js';

export const HOOK_EVENTS = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'PreLLM',
  'PostLLM',
  'SessionStart',
  'SessionStop',
]);

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8_000;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // Malformed JSON is a config error: log once and skip.
    return null;
  }
}

// Load hooks config: project .ox/hooks.json overrides global ~/.ox/config.json.
export function loadHooksConfig(cwd = process.cwd()) {
  const globalDoc = readJsonFile(path.join(os.homedir(), '.ox', 'config.json')) || {};
  const projectDoc = readJsonFile(path.join(cwd, '.ox', 'hooks.json')) || {};
  const merged = {};
  for (const ev of HOOK_EVENTS) {
    const globalList = Array.isArray(globalDoc?.hooks?.[ev]) ? globalDoc.hooks[ev] : [];
    const projectList = Array.isArray(projectDoc?.hooks?.[ev]) ? projectDoc.hooks[ev] : [];
    merged[ev] = [...globalList, ...projectList];
  }
  return merged;
}

// Match a tool name against a pipe-separated matcher list.
// "Bash|Edit" matches "Bash" or "Edit". "*" or absent matches everything.
function matchesMatcher(matcher, toolName) {
  if (!matcher) return true;
  if (matcher === '*') return true;
  const parts = String(matcher).split('|').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (p === toolName) return true;
    try { if (new RegExp(`^${p}$`).test(toolName)) return true; } catch { /* invalid regex */ }
  }
  return false;
}

// The hooks that will ACTUALLY run for this event: declared, well-formed
// command, and matcher-compatible. `fireHooks` runs exactly this list and the
// agent emits its `hook-event` visibility event off exactly this list, so
// "did a hook fire" and "did we tell the user" cannot drift apart.
export function hooksFor(eventName, data, config) {
  if (!HOOK_EVENTS.includes(eventName)) return [];
  const hooks = Array.isArray(config?.[eventName]) ? config[eventName] : [];
  return hooks.filter(
    (h) => h && typeof h.command === 'string' && h.command.trim() && matchesMatcher(h.matcher, data?.tool)
  );
}

// Build env vars for a hook invocation from event data.
function buildEnv(eventName, data) {
  const env = {
    ...process.env,
    OX_HOOK_EVENT: eventName,
    OX_HOOK_CWD: data?.cwd || process.cwd(),
    OX_SESSION_ID: data?.sessionId || '',
  };
  if (data?.tool) {
    env.OX_TOOL_NAME = data.tool;
    env.OX_TOOL_ARGS = safeStringify(data.args || {});
    env.OX_TOOL_INPUT = data.preview || '';
    const fp = data?.args?.path || data?.args?.file_path;
    if (fp) env.OX_FILE_PATH = String(fp);
  }
  if (data?.model) env.OX_MODEL = data.model;
  if (data?.bot) env.OX_BOT = String(data.bot);
  if (data?.prompt) env.OX_PROMPT = data.prompt;
  // OX_HOOK_ERROR is the PostLLM clean-vs-errored flag: UNSET on a clean turn,
  // set to the stream error text on a failed one. A hook tests `[ -n
  // "$OX_HOOK_ERROR" ]` rather than guessing from exit status.
  if (data?.error) env.OX_HOOK_ERROR = String(data.error);
  if (data?.tokensIn != null) env.OX_TOKENS_IN = String(data.tokensIn);
  if (data?.tokensOut != null) env.OX_TOKENS_OUT = String(data.tokensOut);
  return env;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return '{}'; }
}

// Run a single hook command. Returns { decision, output, error, exitCode, ms }.
//   decision: 'allow' (default) or 'deny' (PreToolUse only, exit code 2).
//   output:   stdout (capped at MAX_OUTPUT_BYTES).
//   error:    stderr (capped). null if clean.
function runHook({ command, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const argv = shellArgv(command, { login: false });
    const child = spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outTrunc = false;
    let errTrunc = false;
    let settled = false;
    const finish = (decision, exitCode, error) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        decision,
        output: outTrunc ? stdout + '\n[truncated]' : stdout,
        error: errTrunc ? stderr + '\n[truncated]' : (error ? (stderr || String(error)) : null),
        exitCode,
        ms: Date.now() - started,
      });
    };
    const started = Date.now();
    const timer = setTimeout(() => finish('allow', -1, 'hook timeout'), timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += d.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) { stdout = stdout.slice(0, MAX_OUTPUT_BYTES); outTrunc = true; }
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += d.toString();
        if (stderr.length > MAX_OUTPUT_BYTES) { stderr = stderr.slice(0, MAX_OUTPUT_BYTES); errTrunc = true; }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); finish('allow', -1, String(err?.message ?? err)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Exit 2 on PreToolUse = deny
      const decision = code === 2 ? 'deny' : 'allow';
      finish(decision, code ?? 0, code && code !== 0 ? stderr : null);
    });
  });
}

// Fire all hooks for an event. Returns:
//   { decision: 'allow'|'deny', outputs: [...], errors: [...] }
// outputs: array of { hook, output, ms } for each hook that ran.
// errors: array of { hook, error, ms } for hooks that failed.
export async function fireHooks(eventName, data, config, opts = {}) {
  const hooks = hooksFor(eventName, data, config);
  if (!hooks.length) return { decision: 'allow', outputs: [], errors: [] };

  const cwd = opts.cwd || process.cwd();
  const env = buildEnv(eventName, data);
  const outputs = [];
  const errors = [];
  let decision = 'allow';

  for (const hook of hooks) {
    try {
      const result = await runHook({
        command: hook.command,
        cwd,
        env,
        timeoutMs: hook.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      if (result.output) outputs.push({ hook, output: result.output, ms: result.ms });
      if (result.error) errors.push({ hook, error: result.error, ms: result.ms });
      // First deny wins (PreToolUse only)
      if (eventName === 'PreToolUse' && result.decision === 'deny') {
        decision = 'deny';
        // Continue running other hooks so the user can log/observe, but
        // we already know the tool will be blocked.
      }
    } catch (err) {
      errors.push({ hook, error: String(err?.message ?? err), ms: 0 });
    }
  }
  return { decision, outputs, errors };
}

// Convenience: format hook outputs for appending to a tool result.
export function formatHookOutputs(outputs) {
  if (!outputs.length) return '';
  const lines = ['[hook output]'];
  for (const o of outputs) {
    const label = o.hook.matcher ? `${o.hook.matcher} hook` : 'hook';
    lines.push(`${label} (${o.ms}ms):`);
    lines.push(o.output);
  }
  return lines.join('\n');
}

// Convenience: format hook errors for logging.
export function formatHookErrors(errors) {
  if (!errors.length) return '';
  const lines = ['[hook errors]'];
  for (const e of errors) {
    const label = e.hook.matcher ? `${e.hook.matcher} hook` : 'hook';
    lines.push(`${label} (${e.ms}ms): ${e.error}`);
  }
  return lines.join('\n');
}
