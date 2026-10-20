// Other coding agents in OX Island: Claude Code's sessions show up next to
// ox's own runs — every tool step live, and its permission requests answered
// with Allow / Always / Deny from the island. The idea is Coucou's hook bridge
// (MIT); this is ox's own implementation on ox's existing island protocol.
//
//   Claude Code ──hook──> `ox hook claude` ──> relay (one per session)
//                                                 │  an ox IPC server: the
//                                                 │  island finds it like any
//                                                 ▼  ox run and connects
//                                             OX Island
//
// `ox hook claude` is what Claude Code runs on each event, with the event's
// JSON on stdin. It hands the event to that session's relay — starting it if
// needed — and returns at once, except for a permission request, where it
// waits for your answer in the island and prints Claude Code's decision. The
// relay is a small detached process that ends when the session ends (or after
// 30 idle minutes).
//
// Safety, the same rules as ox's own runs: silence is "ask". No island, no
// connection, a timeout, a crash — all print nothing, and Claude Code asks in
// its own terminal as it always does. Nothing here can ever turn into "allow"
// except your click. `ox hooks install claude` shows the change to
// ~/.claude/settings.json, backs the file up, and only then writes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIpcServer, socketPathFor, sanitizeForWire } from './ipc.js';

const OX_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
// Each agent: where its hooks live, which events to hook (with timeouts), and
// whether tool events take a matcher. Codex reads Claude-style groups from
// ~/.codex/hooks.json (no matcher), runs them only after you trust them with
// /hooks in Codex, and reads the same PermissionRequest decision.
//
// format: 'groups' = Claude-style { hooks: { Event: [{ matcher?, hooks: [{ command }] }] } },
//         'flat'   = Cursor's { version: 1, hooks: { event: [{ command }] } },
//         'copilot'= Copilot CLI's own file, { version: 1, hooks: { event: [{ type, bash, timeoutSec }] } }.
// eventOnCommand: the agent does not put the event in the payload, so the
//   command line carries it (`ox hook gemini BeforeTool`).
// decision: how a permission answer is written back — 'claude' (hookSpecificOutput),
//   'bare' ({ permissionDecision }, always valid JSON: Copilot is fail-closed),
//   or 'none' (the agent has no permission hook; ox only shows its steps).
// Formats follow Coucou's installers (MIT), which are tested against each agent.
export const AGENTS = Object.freeze({
  claude: {
    label: 'Claude Code', settings: () => path.join(os.homedir(), '.claude', 'settings.json'), format: 'groups', matcher: true, decision: 'claude',
    events: { PreToolUse: 120, PostToolUse: 5, PostToolUseFailure: 5, PermissionRequest: 120, UserPromptSubmit: 5, Stop: 5, SubagentStart: 5, SubagentStop: 5, SessionEnd: 5 },
  },
  codex: {
    label: 'Codex', settings: () => path.join(os.homedir(), '.codex', 'hooks.json'), format: 'groups', matcher: false, decision: 'claude',
    events: { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 10, PermissionRequest: 120, PostToolUse: 10, Stop: 10, SubagentStart: 10, SubagentStop: 10, SessionEnd: 3 },
    statusMessage: 'Waiting for your answer in OX Island',
    after: 'In Codex, run /hooks once and trust them — Codex only runs hooks you have trusted.',
  },
  gemini: {
    label: 'Gemini CLI', settings: () => path.join(os.homedir(), '.gemini', 'settings.json'), format: 'groups', matcher: true, matcherAll: true, eventOnCommand: true, timeoutMs: true, decision: 'none',
    // AfterModel is left out on purpose: it fires on every streamed chunk.
    events: { SessionStart: 10, SessionEnd: 10, BeforeTool: 5, AfterTool: 5, BeforeAgent: 5, AfterAgent: 5 },
  },
  cursor: {
    label: 'Cursor', settings: () => path.join(os.homedir(), '.cursor', 'hooks.json'), format: 'flat', decision: 'none',
    events: { sessionStart: 10, sessionEnd: 10, beforeSubmitPrompt: 10, preToolUse: 10, postToolUse: 10, postToolUseFailure: 10, stop: 10 },
  },
  copilot: {
    label: 'Copilot CLI', settings: () => path.join(os.homedir(), '.copilot', 'hooks', 'ox.json'), format: 'copilot', eventOnCommand: true, decision: 'bare',
    events: { sessionStart: 10, userPromptSubmitted: 10, preToolUse: 10, permissionRequest: 120, postToolUse: 10, agentStop: 10, sessionEnd: 3, notification: 10 },
  },
});

// Every agent's event names, as Claude Code's (which the relay understands).
const CANONICAL = {
  BeforeTool: 'PreToolUse', BeforeToolSelection: 'PreToolUse', AfterTool: 'PostToolUse', AfterModel: 'PostToolUse', BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', startup: 'SessionStart', exit: 'SessionEnd',
  pre_tool_use: 'PreToolUse', post_tool_use: 'PostToolUse', user_prompt_submit: 'UserPromptSubmit', session_start: 'SessionStart', session_end: 'SessionEnd', stop: 'Stop',
  sessionStart: 'SessionStart', userPromptSubmitted: 'UserPromptSubmit', agentStop: 'Stop', notification: 'Notification', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', permissionRequest: 'PermissionRequest', sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit', postToolUseFailure: 'PostToolUseFailure', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop',
};
export const canonicalEvent = (name) => CANONICAL[name] ?? name;

// One payload, whatever agent sent it, in Claude Code's field names. What the
// payload already says is never overwritten; odd shapes are ignored, not trusted.
export function normalize(raw = {}, eventArg = null, env = process.env) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const str = (v) => (typeof v === 'string' && v ? v : null);
  p.hook_event_name = canonicalEvent(str(eventArg) ?? str(p.hook_event_name) ?? str(p.hookEventName) ?? str(p.event) ?? '');
  const call = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : null;
  if (!str(p.tool_name)) {
    const name = str(p.toolName) ?? str(call?.name) ?? str(p.tool);
    if (name) p.tool_name = name;
  }
  if (!p.tool_input || typeof p.tool_input !== 'object') {
    let args = null;
    if (p.toolArgs && typeof p.toolArgs === 'object') args = p.toolArgs;
    else if (typeof p.toolArgs === 'string') { try { const v = JSON.parse(p.toolArgs); if (v && typeof v === 'object') args = v; } catch {} }
    else if (call?.args && typeof call.args === 'object') {
      args = { ...call.args };
      for (const [from, to] of [['CommandLine', 'command'], ['FilePath', 'file_path'], ['Path', 'path'], ['Url', 'url'], ['Query', 'query'], ['Pattern', 'pattern']]) if (args[from] != null) args[to] = args[from];
    }
    if (args) p.tool_input = args;
  }
  if (!str(p.session_id)) {
    const sid = str(p.conversationId) ?? str(p.conversation_id) ?? str(p.sessionId) ?? str(env.GEMINI_SESSION_ID);
    if (sid) p.session_id = sid;
  }
  if (!str(p.cwd)) {
    const cwd = str(p.workdir) ?? str(p.workspacePaths?.[0]) ?? str(p.workspace_roots?.[0]);
    if (cwd) p.cwd = cwd;
  }
  if (p.hook_event_name === 'Stop' && p.status === 'error') p.hook_event_name = 'StopFailure';
  return p;
}
const IDLE_MS = 30 * 60_000;

// Claude Code's tool names, as the island already describes ox's own tools.
const TOOL = {
  Read: 'read_file', Write: 'write_file', Edit: 'edit_file', MultiEdit: 'edit_file', NotebookEdit: 'edit_file', Bash: 'bash', Grep: 'grep', Glob: 'glob', LS: 'list_dir', WebFetch: 'web_fetch', WebSearch: 'web_search', Task: 'subagent', Agent: 'subagent', TodoWrite: 'todo_write',
  // Codex
  apply_patch: 'edit_file', shell: 'bash', exec_command: 'bash', local_shell: 'bash', update_plan: 'todo_write', spawn_agent: 'subagent', view_image: 'read_file',
  // Gemini CLI
  run_shell_command: 'bash', replace: 'edit_file', search_file_content: 'grep', list_directory: 'list_dir', read_many_files: 'read_file', google_web_search: 'web_search',
  // Copilot CLI / Antigravity
  view: 'read_file', create: 'write_file', edit: 'edit_file', str_replace: 'edit_file', run_command: 'bash',
};
export const toolName = (n) => TOOL[n] ?? String(n ?? 'tool');
export function preview(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  // Codex's apply_patch carries the whole patch: show the file it touches.
  if (typeof i.command === 'string' && i.command.startsWith('*** Begin Patch')) {
    const f = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(i.command);
    if (f) return f[1].trim();
  }
  const cmd = Array.isArray(i.command) ? i.command.join(' ') : i.command;
  const s = cmd ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.label ?? i.shape ?? '';
  return String(s).replace(/\s+/g, ' ').slice(0, 300);
}

export const sessionKey = (agent, sessionId) => `${agent}-${String(sessionId ?? 'default').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'default'}`;

const lineCount = (t) => (typeof t === 'string' && t.length ? t.replace(/\n$/, '').split('\n').length : 0);

/** Lines added and removed by an edit, from the tool's own input (Coucou's live diff ticker). */
export function diffStat(toolName, input = {}) {
  const i = input ?? {};
  const base = (f) => String(f ?? '').split('/').pop();
  if (Array.isArray(i.edits)) {
    let plus = 0, minus = 0;
    for (const e of i.edits) { plus += lineCount(e.new_string); minus += lineCount(e.old_string); }
    return { file: base(i.file_path), plus, minus };
  }
  if (typeof i.old_string === 'string' || typeof i.new_string === 'string') return { file: base(i.file_path), plus: lineCount(i.new_string), minus: lineCount(i.old_string) };
  if (typeof i.content === 'string' && (i.file_path || i.path)) return { file: base(i.file_path ?? i.path), plus: lineCount(i.content), minus: 0 };
  const cmd = Array.isArray(i.command) ? i.command.join('\n') : i.command;
  if (typeof cmd === 'string' && cmd.includes('*** Begin Patch')) {
    const f = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(cmd);
    const lines = cmd.split('\n');
    return { file: base(f?.[1]), plus: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, minus: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length };
  }
  return null;
}

// ---- risk in plain words (Pushary's approval cards) and safe commands allowed on their own

const READ_ONLY_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir', 'web_search', 'web_fetch', 'notebook_read', 'todo_write']);
const DANGER = [
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\b|\brm\s+-r\b/i, 'deletes files and folders recursively'],
  [/\bgit\s+push\b[^|;&]*(--force|-f\b)/i, 'force-pushes, rewriting the remote history'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i, 'throws away uncommitted work'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'deletes database tables'],
  [/\b(prod|production)\b/i, 'touches production'],
  [/\b(kubectl\s+delete|terraform\s+(apply|destroy)|helm\s+uninstall)\b/i, 'changes live infrastructure'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, 'runs a script straight from the internet'],
  [/\bsudo\b/, 'runs as administrator'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b/i, 'publishes a release'],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/i, 'changes permissions on a whole tree'],
];
const CAUTION = [
  [/\bgit\s+push\b/i, 'pushes to the remote'],
  [/\b(migrate|migration)\b/i, 'changes the database schema'],
  [/\b(npm|pnpm|yarn|pip|brew|cargo)\s+(install|add|i)\b/i, 'installs packages'],
  [/\bcurl\b.*-X\s*(POST|PUT|DELETE|PATCH)\b/i, 'sends a request that changes something online'],
  [/\bmv\b|\bcp\s+-r\b/i, 'moves or copies files'],
];
const SAFE_CMD = /^\s*(ls|ll|pwd|cat|head|tail|wc|echo|which|whoami|date|tree|file|stat|du|df|env|printenv|rg|grep|ag|fd|find(?![^|;&]*(-delete|-exec))|git\s+(status|log|diff|show|branch|remote|rev-parse|blame|ls-files)|node\s+(-v|--version)|npm\s+(ls|view|-v)|python3?\s+(-V|--version))\b[^;&|<>`$]*$/;

/** { level: 'safe' | 'caution' | 'danger', why } for a tool call, from its own input. */
export function riskOf(tool, input = {}) {
  const t = toolName(tool);
  if (READ_ONLY_TOOLS.has(t)) return { level: 'safe', why: 'only reads' };
  const cmd = String(Array.isArray(input?.command) ? input.command.join(' ') : input?.command ?? '');
  if (cmd) {
    for (const [re, why] of DANGER) if (re.test(cmd)) return { level: 'danger', why: `This ${why}` };
    for (const [re, why] of CAUTION) if (re.test(cmd)) return { level: 'caution', why: `This ${why}` };
    if (SAFE_CMD.test(cmd) && !/[>]/.test(cmd)) return { level: 'safe', why: 'only reads' };
    return { level: 'caution', why: 'This runs a command' };
  }
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (file) return /(^|\/)\.(env|ssh|aws)|secrets?|credentials?/i.test(String(file)) ? { level: 'danger', why: `This changes ${String(file).split('/').pop()}, which may hold secrets` } : { level: 'caution', why: `This changes ${String(file).split('/').pop()}` };
  return { level: 'caution', why: '' };
}

const approvalsFile = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'island-approvals.json');
/** Read-only calls allowed without asking (on unless turned off: ox hooks safe off). */
export function autoSafe() { try { return JSON.parse(fs.readFileSync(approvalsFile(), 'utf8')).autoSafe !== false; } catch { return true; } }
export function setAutoSafe(on) { fs.mkdirSync(path.dirname(approvalsFile()), { recursive: true }); fs.writeFileSync(approvalsFile(), `${JSON.stringify({ autoSafe: !!on }, null, 2)}\n`); return !!on; }

// One hook payload -> the ox events the island draws (none for some).
export function toEvents(p = {}) {
  const ev = p.hook_event_name;
  const id = String(p.tool_use_id ?? `${p.tool_name ?? 'tool'}-${Date.now()}`);
  switch (ev) {
    case 'UserPromptSubmit': return [{ type: 'text-delta', text: '' }];
    case 'PreToolUse': return [{ type: 'tool-start', id, name: toolName(p.tool_name), argsPreview: preview(p.tool_input) }];
    case 'PostToolUse': { const d = diffStat(p.tool_name, p.tool_input); return [{ type: 'tool-end', id, name: toolName(p.tool_name), isError: false, ...(d && (d.plus || d.minus) ? { diff: d } : {}) }]; }
    case 'PostToolUseFailure': return [{ type: 'tool-end', id, name: toolName(p.tool_name), isError: true }];
    case 'SubagentStart': return [{ type: 'subagent-start', id: String(p.agent_id ?? id), task: String(p.agent_type ?? 'subagent') }];
    case 'SubagentStop': return [{ type: 'subagent-end', id: String(p.agent_id ?? id), status: 'done' }];
    case 'Stop': return [{ type: 'turn-end', stopReason: 'end_turn' }];
    case 'StopFailure': return [{ type: 'error', error: String(p.error ?? 'stopped with an error') }];
    case 'SessionEnd': return [{ type: 'final' }];
    default: return [];
  }
}

// What the agent reads back from a permission hook. Claude Code / Codex: "ask"
// prints nothing, so the agent asks in its own terminal. Copilot is fail-closed,
// so it always gets valid JSON — "ask" when nobody clicked.
export function decisionOutput(decision, style = 'claude') {
  if (style === 'bare') return JSON.stringify({ permissionDecision: decision === 'always' ? 'allow' : ['allow', 'deny'].includes(decision) ? decision : 'ask' });
  if (style !== 'claude') return '';
  if (decision === 'allow' || decision === 'always') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  if (decision === 'deny') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from OX Island' } } });
  return '';
}

/** "Which search engine? (Postgres full-text / Meilisearch / Algolia)": one line for the notch. */
export function questionPreview(input = {}) {
  const q = (input.questions ?? [])[0] ?? {};
  const opts = (q.options ?? []).map((o) => (typeof o === 'string' ? o : o?.label)).filter(Boolean);
  return `${q.question ?? 'A question'}${opts.length ? ` (${opts.join(' / ')})` : ''}`.slice(0, 300);
}

/** What Claude Code reads back when the question was answered in the notch. */
export function answerOutput(answer) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The user already answered this in OX Island: ${answer}. Continue with that answer; do not ask again.` } });
}

// ---- the relay: one ox IPC server per agent session ----------------------------------

export function runRelay({ agent = 'claude', sessionId, cwd = process.cwd(), socketDir, idleMs = IDLE_MS, waitForIslandMs = 4000 } = {}) {
  const key = sessionKey(agent, sessionId);
  const socketPath = socketPathFor(key, socketDir);
  const always = new Set();
  let idle = null;
  let server = null;
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => server?.close?.(), idleMs); idle.unref?.(); };
  const island = () => [...(server.clients ?? [])].some((c) => c.ready);
  const waitIsland = async () => {
    const until = Date.now() + waitForIslandMs;
    while (!island() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return island();
  };
  server = createIpcServer({
    socketPath, sessionId: key,
    meta: { cwd, bot: AGENTS[agent]?.label ?? agent, model: AGENTS[agent]?.label ?? agent, agent },
    onRequest: async (msg) => {
      if (msg?.type !== 'hook') return undefined;
      bump();
      const p = msg.payload ?? {};
      // Claude Code's multiple-choice question: answered in the notch (Coucou's feature).
      if (p.hook_event_name === 'PreToolUse' && p.tool_name === 'AskUserQuestion') {
        for (const e of toEvents(p)) server.broadcast(e);
        if (!(await waitIsland())) return { type: 'hook-decision', decision: 'ask' };
        const decision = await server.requestApproval({ tool: 'AskUserQuestion', args: sanitizeForWire(p.tool_input ?? {}), cwd: p.cwd ?? cwd, preview: questionPreview(p.tool_input) });
        if (String(decision).startsWith('answer:')) return { type: 'hook-decision', decision: 'answer', answer: String(decision).slice(7) };
        return { type: 'hook-decision', decision: 'ask' };
      }
      if (p.hook_event_name === 'PermissionRequest') {
        const tool = toolName(p.tool_name);
        if (always.has(tool)) return { type: 'hook-decision', decision: 'allow' };
        const risk = riskOf(p.tool_name, p.tool_input);
        // Safe commands run on their own (only reading); risky ones wait for you.
        if (risk.level === 'safe' && autoSafe()) { server.broadcast({ type: 'text-delta', text: '' }); return { type: 'hook-decision', decision: 'allow' }; }
        if (!(await waitIsland())) return { type: 'hook-decision', decision: 'ask' };
        const decision = await server.requestApproval({ tool, args: sanitizeForWire(p.tool_input ?? {}), cwd: p.cwd ?? cwd, preview: preview(p.tool_input), risk });
        if (decision === 'always') always.add(tool);
        return { type: 'hook-decision', decision };
      }
      for (const e of toEvents(p)) server.broadcast(e);
      if (p.hook_event_name === 'SessionEnd') setTimeout(() => server.close?.(), 3000).unref?.();
      return { type: 'hook-ok' };
    },
  });
  bump();
  return { server, socketPath, key };
}

// ---- the hook: what Claude Code runs ---------------------------------------------------

function talk(socketPath, frame, { timeoutMs }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = net.createConnection(socketPath);
    const t = setTimeout(() => finish(null), timeoutMs);
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify(frame)}\n`));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.type === 'hook-decision' || m.type === 'hook-ok') { clearTimeout(t); finish(m); }
        } catch {}
      }
    });
    sock.on('error', () => { clearTimeout(t); finish(null); });
    sock.on('close', () => { clearTimeout(t); finish(null); });
  });
}

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

// A new session's relay can take over 2 s to start cold (just after a restart),
// and then its first approval went to the agent's own prompt instead of the
// notch. Someone waits on an approval anyway, so it gets longer.
async function ensureRelay(agent, payload, { socketDir, spawnRelay, waitMs = 2000 }) {
  const key = sessionKey(agent, payload.session_id);
  const sp = socketPathFor(key, socketDir);
  if (exists(sp)) return sp;
  spawnRelay({ agent, sessionId: payload.session_id, cwd: payload.cwd ?? process.cwd() });
  const until = Date.now() + waitMs;
  while (!exists(sp) && Date.now() < until) await new Promise((r) => setTimeout(r, 40));
  return exists(sp) ? sp : null;
}

const defaultSpawnRelay = ({ agent, sessionId, cwd }) => {
  const p = spawn(process.execPath, [OX_BIN, 'hook-relay', agent, String(sessionId ?? 'default')], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, OX_ISLAND: '0' } });
  p.unref();
};

// Returns what to print on stdout (usually nothing).
// `event` is the event name from the command line, for agents that do not put it
// in the payload (Gemini CLI, Copilot CLI).
export async function handleHook(agent, raw, { event = null, socketDir, spawnRelay = defaultSpawnRelay, approvalTimeoutMs = 118_000, env = process.env } = {}) {
  const spec = AGENTS[agent];
  if (!spec) return '';
  let parsed;
  try { parsed = JSON.parse(String(raw || '{}')); } catch { return spec.decision === 'bare' && /permission/i.test(String(event)) ? decisionOutput('ask', 'bare') : ''; }
  const payload = normalize(parsed, event, env);
  if (!payload.hook_event_name) return '';
  const isQuestion = payload.hook_event_name === 'PreToolUse' && payload.tool_name === 'AskUserQuestion' && spec.decision === 'claude';
  const isAsk = payload.hook_event_name === 'PermissionRequest';
  const answer = (d) => (isAsk ? decisionOutput(d, spec.decision) : '');
  if (isAsk && spec.decision === 'none') return '';
  // A session ending with no relay alive has nothing to tell anyone.
  if (payload.hook_event_name === 'SessionEnd' && !exists(socketPathFor(sessionKey(agent, payload.session_id), socketDir))) return '';
  const sp = await ensureRelay(agent, payload, { socketDir, spawnRelay, waitMs: isAsk || isQuestion ? 6000 : 2000 });
  if (!sp) return answer('ask');
  const reply = await talk(sp, { type: 'hook', payload }, { timeoutMs: isAsk || isQuestion ? approvalTimeoutMs : 800 });
  if (isQuestion) return reply?.decision === 'answer' && reply.answer ? answerOutput(reply.answer) : '';
  return answer(reply?.decision ?? 'ask');
}

// ---- installing the hooks into an agent's settings ---------------------------------------

const mark = (agent) => `hook ${agent}`;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

export function hookCommand(agent = 'claude', event = null) {
  const q = (s) => (/[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  return `${q(process.execPath)} ${q(OX_BIN)} ${mark(agent)}${event ? ` ${event}` : ''}`;
}

// An entry ox wrote for this agent, in any of the shapes agents use.
const isOurs = (entry, M) => ['command', 'bash', 'powershell'].some((k) => typeof entry?.[k] === 'string' && (entry[k].endsWith(M) || entry[k].includes(`${M} `)));

// A list of entries without ox's, keeping everyone else's exactly as they were.
function withoutOurs(list, M) {
  return list.flatMap((item) => {
    if (Array.isArray(item?.hooks)) {
      const inner = item.hooks.filter((h) => !isOurs(h, M));
      if (inner.length === item.hooks.length) return [item];
      return inner.length ? [{ ...item, hooks: inner }] : [];
    }
    return isOurs(item, M) ? [] : [item];
  });
}

function ourEntry(spec, agent, event, timeout) {
  const command = hookCommand(agent, spec.eventOnCommand ? event : null);
  if (spec.format === 'flat') return { command };
  if (spec.format === 'copilot') return { type: 'command', bash: command, timeoutSec: timeout };
  const hook = { type: 'command', command, timeout: spec.timeoutMs ? timeout * 1000 : timeout, ...(event === 'PermissionRequest' && spec.statusMessage ? { statusMessage: spec.statusMessage } : {}) };
  const matcher = spec.matcher && (spec.matcherAll || TOOL_EVENTS.has(event));
  return { ...(matcher ? { matcher: '*' } : {}), hooks: [hook] };
}

// The settings document with ox's hooks added (or removed), without touching
// anything else in it — other tools' hooks and your own stay exactly as they are.
// Claude Code shares your plan limits only with its status-line command, so
// connecting Claude also routes the status line through `ox statusline`
// (src/statusline.js), which records the limits and then runs the status line
// you had before: what you see in Claude Code does not change.
export const statuslineCommand = () => { const q = (s) => (/[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s); return `${q(process.execPath)} ${q(OX_BIN)} statusline`; };
const isOurStatusline = (sl) => typeof sl?.command === 'string' && / statusline$/.test(sl.command.trim()) && sl.command.includes('ox');

export function withHooks(doc = {}, { remove = false, agent = 'claude', restoreStatusline = null } = {}) {
  const spec = AGENTS[agent];
  const M = mark(agent);
  const next = JSON.parse(JSON.stringify(doc ?? {}));
  if (agent === 'claude') {
    if (!remove) next.statusLine = { ...(next.statusLine && !isOurStatusline(next.statusLine) && typeof next.statusLine === 'object' ? { padding: next.statusLine.padding } : {}), type: 'command', command: statuslineCommand() };
    else if (isOurStatusline(next.statusLine)) { if (restoreStatusline) next.statusLine = restoreStatusline; else delete next.statusLine; }
    if (next.statusLine && next.statusLine.padding === undefined) delete next.statusLine.padding;
  }
  next.hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? next.hooks : {};
  const events = new Set([...Object.keys(spec.events), ...Object.keys(next.hooks)]);
  for (const event of events) {
    if (!Array.isArray(next.hooks[event]) && next.hooks[event] !== undefined) continue; // not a list: not ours to touch
    const kept = withoutOurs(next.hooks[event] ?? [], M);
    if (!remove && spec.events[event] != null) kept.push(ourEntry(spec, agent, event, spec.events[event]));
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  if ((spec.format === 'flat' || spec.format === 'copilot') && next.hooks) next.version ??= 1;
  if (remove && spec.format !== 'groups' && !next.hooks && Object.keys(next).every((k) => k === 'version')) delete next.version;
  return next;
}

export function installed(doc = {}, agent = 'claude') {
  const M = mark(agent);
  return Object.values(doc?.hooks ?? {}).some((list) => Array.isArray(list) && list.some((item) => isOurs(item, M) || (Array.isArray(item?.hooks) && item.hooks.some((h) => isOurs(h, M)))));
}

// plan -> { file, before, after, changed }. apply(plan) backs up, then writes.
export function planInstall(agent = 'claude', { remove = false, file = AGENTS[agent]?.settings() } = {}) {
  if (!AGENTS[agent]) throw new Error(`ox can connect: ${Object.keys(AGENTS).join(', ')}`);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let doc = {};
  if (text.trim()) {
    try { doc = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON — fix it first; ox will not rewrite a file it cannot read`); }
  }
  // The status line you had, kept so `ox statusline` can still show it and an
  // uninstall can put it back.
  const prevFile = path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'statusline-previous.json');
  let restoreStatusline = null;
  if (agent === 'claude' && remove) { try { restoreStatusline = JSON.parse(fs.readFileSync(prevFile, 'utf8'))?.statusLine ?? null; } catch {} }
  const previousStatusline = agent === 'claude' && !remove && doc.statusLine && !isOurStatusline(doc.statusLine) ? doc.statusLine : null;
  const after = withHooks(doc, { remove, agent, restoreStatusline });
  const afterText = `${JSON.stringify(after, null, 2)}\n`;
  return { file, beforeText: text, afterText, changed: afterText.trim() !== text.trim(), mtimeMs: text ? fs.statSync(file).mtimeMs : null, previousStatusline, prevFile: agent === 'claude' ? prevFile : null, remove };
}

export function applyInstall(plan) {
  if (!plan.changed) return null;
  // Refuse if the file changed since the plan was shown.
  if (plan.mtimeMs != null && fs.statSync(plan.file).mtimeMs !== plan.mtimeMs) throw new Error(`${plan.file} changed since the preview; run it again`);
  let backup = null;
  if (plan.beforeText) {
    backup = `${plan.file}.ox-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, plan.beforeText);
  }
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.afterText);
  if (plan.prevFile) {
    try {
      if (plan.previousStatusline) { fs.mkdirSync(path.dirname(plan.prevFile), { recursive: true }); fs.writeFileSync(plan.prevFile, `${JSON.stringify({ statusLine: plan.previousStatusline, command: plan.previousStatusline.command ?? null }, null, 2)}\n`, { mode: 0o600 }); }
      else if (plan.remove) fs.rmSync(plan.prevFile, { force: true });
    } catch {}
  }
  return backup;
}
