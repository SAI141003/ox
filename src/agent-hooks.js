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
export const AGENTS = Object.freeze({ claude: { label: 'Claude Code', settings: () => path.join(os.homedir(), '.claude', 'settings.json') } });
const IDLE_MS = 30 * 60_000;

// Claude Code's tool names, as the island already describes ox's own tools.
const TOOL = { Read: 'read_file', Write: 'write_file', Edit: 'edit_file', MultiEdit: 'edit_file', NotebookEdit: 'edit_file', Bash: 'bash', Grep: 'grep', Glob: 'glob', LS: 'list_dir', WebFetch: 'web_fetch', WebSearch: 'web_search', Task: 'subagent', Agent: 'subagent' };
export const toolName = (n) => TOOL[n] ?? String(n ?? 'tool');
export function preview(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const s = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '';
  return String(s).replace(/\s+/g, ' ').slice(0, 300);
}

export const sessionKey = (agent, sessionId) => `${agent}-${String(sessionId ?? 'default').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'default'}`;

// One hook payload -> the ox events the island draws (none for some).
export function toEvents(p = {}) {
  const ev = p.hook_event_name;
  const id = String(p.tool_use_id ?? `${p.tool_name ?? 'tool'}-${Date.now()}`);
  switch (ev) {
    case 'UserPromptSubmit': return [{ type: 'text-delta', text: '' }];
    case 'PreToolUse': return [{ type: 'tool-start', id, name: toolName(p.tool_name), argsPreview: preview(p.tool_input) }];
    case 'PostToolUse': return [{ type: 'tool-end', id, name: toolName(p.tool_name), isError: false }];
    case 'PostToolUseFailure': return [{ type: 'tool-end', id, name: toolName(p.tool_name), isError: true }];
    case 'SubagentStart': return [{ type: 'subagent-start', id: String(p.agent_id ?? id), task: String(p.agent_type ?? 'subagent') }];
    case 'SubagentStop': return [{ type: 'subagent-end', id: String(p.agent_id ?? id), status: 'done' }];
    case 'Stop': return [{ type: 'turn-end', stopReason: 'end_turn' }];
    case 'StopFailure': return [{ type: 'error', error: String(p.error ?? 'stopped with an error') }];
    case 'SessionEnd': return [{ type: 'final' }];
    default: return [];
  }
}

// What Claude Code reads back from a PermissionRequest hook. "ask" -> nothing,
// so Claude Code asks in its own terminal.
export function decisionOutput(decision) {
  if (decision === 'allow' || decision === 'always') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  if (decision === 'deny') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from OX Island' } } });
  return '';
}

// ---- the relay: one ox IPC server per agent session ----------------------------------

export function runRelay({ agent = 'claude', sessionId, cwd = process.cwd(), socketDir, idleMs = IDLE_MS, waitForIslandMs = 2500 } = {}) {
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
      if (p.hook_event_name === 'PermissionRequest') {
        const tool = toolName(p.tool_name);
        if (always.has(tool)) return { type: 'hook-decision', decision: 'allow' };
        if (!(await waitIsland())) return { type: 'hook-decision', decision: 'ask' };
        const decision = await server.requestApproval({ tool, args: sanitizeForWire(p.tool_input ?? {}), cwd: p.cwd ?? cwd, preview: preview(p.tool_input) });
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

async function ensureRelay(agent, payload, { socketDir, spawnRelay }) {
  const key = sessionKey(agent, payload.session_id);
  const sp = socketPathFor(key, socketDir);
  if (exists(sp)) return sp;
  spawnRelay({ agent, sessionId: payload.session_id, cwd: payload.cwd ?? process.cwd() });
  const until = Date.now() + 2000;
  while (!exists(sp) && Date.now() < until) await new Promise((r) => setTimeout(r, 40));
  return exists(sp) ? sp : null;
}

const defaultSpawnRelay = ({ agent, sessionId, cwd }) => {
  const p = spawn(process.execPath, [OX_BIN, 'hook-relay', agent, String(sessionId ?? 'default')], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, OX_ISLAND: '0' } });
  p.unref();
};

// Returns what to print on stdout (usually nothing).
export async function handleHook(agent, raw, { socketDir, spawnRelay = defaultSpawnRelay, approvalTimeoutMs = 118_000 } = {}) {
  let payload;
  try { payload = JSON.parse(String(raw || '{}')); } catch { return ''; }
  if (!AGENTS[agent] || !payload?.hook_event_name) return '';
  const isAsk = payload.hook_event_name === 'PermissionRequest';
  // A session ending with no relay alive has nothing to tell anyone.
  if (payload.hook_event_name === 'SessionEnd' && !exists(socketPathFor(sessionKey(agent, payload.session_id), socketDir))) return '';
  const sp = await ensureRelay(agent, payload, { socketDir, spawnRelay });
  if (!sp) return '';
  const reply = await talk(sp, { type: 'hook', payload }, { timeoutMs: isAsk ? approvalTimeoutMs : 800 });
  return isAsk ? decisionOutput(reply?.decision) : '';
}

// ---- installing the hooks into Claude Code ---------------------------------------------

const MARK = 'hook claude';
const EVENTS = { PreToolUse: true, PostToolUse: true, PostToolUseFailure: true, PermissionRequest: true, UserPromptSubmit: false, Stop: false, SubagentStart: false, SubagentStop: false, SessionEnd: false };

export function hookCommand() {
  const q = (s) => (/[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  return `${q(process.execPath)} ${q(OX_BIN)} ${MARK}`;
}

// The settings document with ox's hooks added (or removed), without touching
// anything else in it.
export function withHooks(doc = {}, { remove = false, command = hookCommand() } = {}) {
  const next = JSON.parse(JSON.stringify(doc ?? {}));
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? '').includes(MARK)) })).filter((g) => g.hooks.length);
    if (!remove) kept.push({ ...(matcher ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? 120 : 5 }] });
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function installed(doc = {}) {
  return Object.values(doc?.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some((h) => String(h.command ?? '').includes(MARK))));
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
  const after = withHooks(doc, { remove });
  const afterText = `${JSON.stringify(after, null, 2)}\n`;
  return { file, beforeText: text, afterText, changed: afterText.trim() !== text.trim(), mtimeMs: text ? fs.statSync(file).mtimeMs : null };
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
  return backup;
}
