// Other agents working on this Mac, live: Claude Code (the CLI, the desktop
// app's Code tab, worktree sessions) and Codex, from their own session files,
// read-only. Claudex's "4 sessions working" and Coucou's live feed: what each
// is doing now (the file it edits, the command it runs), its model, and how
// long it has been idle. Nothing is written to their folders and no login or
// token file is read: only the session transcripts, as `ox transfer` reads them.
import { isOwn } from './own-sessions.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const WORKING_MS = 30_000;       // written to in the last 30 s: at work
const SHOW_MS = 30 * 60_000;     // idle up to 30 min: still listed
const TAIL = 128 * 1024;

function tailLines(file, bytes = TAIL) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // a cut first line
    return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

const base = (p) => (p ? path.basename(String(p)) : '');
/** "ox · practical-vaughan" for a worktree session, else the folder's name. */
export function projectName(cwd, home = os.homedir()) {
  // A session started in the home folder is not "saiyaganti": it is "home".
  if (cwd && path.resolve(String(cwd)) === path.resolve(home)) return 'home';
  const m = /^(.*?)[\\/]\.(?:claude|codex|ox)[\\/]worktrees[\\/]([^\\/]+)/.exec(String(cwd ?? ''));
  return m ? `${base(m[1])} · ${m[2].replace(/-[0-9a-f]{5,}$/i, '')}` : base(cwd);
}
const clip = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What a tool call is doing, in a few words ("editing Bridge.swift", "$ swift build"). */
export function describeCall(name, input = {}) {
  const n = String(name ?? '');
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/i.test(n)) return `editing ${base(file) || 'files'}`;
  if (/^Read$/i.test(n)) return `reading ${base(file)}`;
  if (/^(Bash|shell|exec_command|local_shell)$/i.test(n)) { const c = Array.isArray(input.command) ? input.command.join(' ') : input.command ?? input.cmd; return `$ ${clip(String(c ?? '').replace(/^\s*cd\s+\S+\s*&&\s*/, ''), 50)}`; }
  if (/^(Grep|Glob)$/i.test(n)) return `searching ${clip(input.pattern, 40)}`;
  if (/^(WebFetch|WebSearch)$/i.test(n)) return `browsing ${clip(input.url ?? input.query, 40)}`;
  if (/^(Agent|Task)$/i.test(n)) return `delegating: ${clip(input.description, 40)}`;
  return clip(n.replace(/^mcp__[^_]+__/, ''), 40);
}

function recentFiles(dir, depth, now) {
  const out = [];
  const walk = (d, left) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0 && e.name !== 'subagents') walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const m = fs.statSync(p).mtimeMs; if (now - m < SHOW_MS) out.push({ file: p, mtime: m }); } catch {}
      }
    }
  };
  walk(dir, depth);
  return out;
}

export function claudeSessions({ home = os.homedir(), now = Date.now() } = {}) {
  return recentFiles(path.join(home, '.claude', 'projects'), 1, now).map(({ file, mtime }) => {
    const lines = tailLines(file);
    let cwd = '', model = '', doing = '', lastKind = '', pendingTool = false, tokens = null;
    for (const l of lines) {
      if (l.cwd) cwd = l.cwd;
      if (l.type === 'assistant' && l.message) {
        if (l.message.model && !/synthetic/.test(l.message.model)) model = l.message.model;
        // The newest message's tokens: what it read (new and from cache) and wrote.
        const u = l.message.usage;
        if (u) tokens = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cached: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
        const calls = (l.message.content ?? []).filter((c) => c?.type === 'tool_use');
        if (calls.length) { const c = calls.at(-1); doing = describeCall(c.name, c.input); pendingTool = true; lastKind = 'tool'; } else if ((l.message.content ?? []).some((c) => c?.type === 'text')) { lastKind = 'text'; pendingTool = false; }
      } else if (l.type === 'user' && Array.isArray(l.message?.content) && l.message.content.some((c) => c?.type === 'tool_result')) {
        pendingTool = false; lastKind = 'result';
      }
    }
    const age = now - mtime;
    const working = age < WORKING_MS || (pendingTool && age < 5 * 60_000);
    return { id: `claude:${path.basename(file, '.jsonl')}`, tool: 'Claude Code', project: projectName(cwd) || 'claude', cwd, model, state: working ? (doing && lastKind !== 'text' ? 'tool' : 'thinking') : 'idle', doing: working ? doing : '', idleSec: working ? 0 : Math.round(age / 1000), updated: mtime, ...(tokens ? { tokens } : {}) };
  }).filter((s) => s.cwd || s.model);
}

export function codexSessions({ home = os.homedir(), now = Date.now() } = {}) {
  return recentFiles(path.join(home, '.codex', 'sessions'), 3, now).map(({ file, mtime }) => {
    const lines = tailLines(file);
    // The id Codex knows the session by (resume takes it), from the first line.
    let sid = path.basename(file, '.jsonl');
    try {
      const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(4096); fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
      sid = /"(?:id|session_id)":"([0-9a-f-]{36})"/.exec(buf.toString('utf8'))?.[1] ?? sid;
    } catch {}
    let cwd = '', model = '', doing = '', done = false, tokens = null;
    for (const l of lines) {
      const p = l.payload ?? {};
      if (p.cwd) cwd = p.cwd;
      // Codex's token_count event: the last turn's usage.
      const lu = p.type === 'token_count' ? p.info?.last_token_usage : null;
      if (lu) tokens = { in: lu.input_tokens || 0, cached: lu.cached_input_tokens || 0, out: (lu.output_tokens || 0) + (lu.reasoning_output_tokens || 0) };
      if (p.model) model = p.model;
      if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        let args = {};
        try { args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments ?? p.action ?? {}; } catch {}
        doing = describeCall(p.name ?? 'shell', args); done = false;
      }
      if (p.type === 'task_started' || p.type === 'user_message') done = false;
      if (p.type === 'task_complete') { done = true; doing = ''; }
    }
    const age = now - mtime;
    const working = !done && age < WORKING_MS * 4;
    return { id: `codex:${sid}`, tool: 'Codex', project: projectName(cwd) || 'codex', cwd, model, state: working ? (doing ? 'tool' : 'thinking') : 'idle', doing: working ? doing : '', idleSec: working ? 0 : Math.round(age / 1000), updated: mtime, ...(tokens ? { tokens } : {}) };
  });
}

/** GitHub Copilot's agent: ~/.copilot/session-state/<id>/events.jsonl. */
export function copilotSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const dir = path.join(home, '.copilot', 'session-state');
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch { return []; }
  return ids.map((id) => {
    const file = path.join(dir, id, 'events.jsonl');
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    if (now - mtime > SHOW_MS) return null;
    let cwd = '';
    try { const head = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 4000).split('\n')[0]; cwd = JSON.parse(head).data?.context?.cwd ?? ''; } catch {}
    let model = '', doing = '', busy = false;
    for (const l of tailLines(file)) {
      const d = l.data ?? {};
      if (d.model) model = d.model;
      if (l.type === 'tool.execution_start') doing = describeCall(d.toolName, d.arguments ?? {});
      if (l.type === 'assistant.turn_start') busy = true;
      if (l.type === 'assistant.turn_end') { busy = false; doing = ''; }
    }
    const age = now - mtime;
    const working = busy && age < 5 * 60_000 || age < WORKING_MS;
    const chat = /\.copilot[\\/]chats[\\/]/.test(cwd);
    return { id: `copilot:${id}`, tool: 'Copilot', project: chat ? 'Copilot chat' : projectName(cwd) || 'copilot', cwd: chat ? '' : cwd, model, state: working ? (doing ? 'tool' : 'thinking') : 'idle', doing: working ? doing : '', idleSec: working ? 0 : Math.round(age / 1000), updated: mtime };
  }).filter(Boolean);
}

function sqliteRows(db, sql) {
  if (!fs.existsSync(db)) return [];
  const r = spawnSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', timeout: 4000 });
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

/** Hermes and OpenCode keep sessions in SQLite: read-only queries. */
export function dbSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const out = [];
  const since = (now - SHOW_MS);
  for (const r of sqliteRows(path.join(home, '.hermes', 'state.db'), `select id, title, cwd, model, coalesce(last_activity_at, started_at) as updated from sessions where coalesce(last_activity_at, started_at) > ${since / 1000} order by updated desc limit 6`)) {
    const t = Number(r.updated) * 1000, age = now - t;
    out.push({ id: `hermes:${r.id}`, tool: 'Hermes', project: projectName(r.cwd) || r.title || 'hermes', cwd: r.cwd ?? '', model: r.model ?? '', state: age < WORKING_MS ? 'thinking' : 'idle', doing: '', idleSec: age < WORKING_MS ? 0 : Math.round(age / 1000), updated: t });
  }
  for (const r of sqliteRows(path.join(home, '.local', 'share', 'opencode', 'opencode.db'), `select id, title, directory, time_updated from session where time_updated > ${since} order by time_updated desc limit 6`)) {
    const t = Number(r.time_updated), age = now - t;
    out.push({ id: `opencode:${r.id}`, tool: 'OpenCode', project: projectName(r.directory) || 'opencode', cwd: r.directory ?? '', model: '', state: age < WORKING_MS ? 'thinking' : 'idle', doing: '', idleSec: age < WORKING_MS ? 0 : Math.round(age / 1000), updated: t });
  }
  return out;
}

/** Google Antigravity (Gemini's IDE): one file per conversation; only whether it is active. */
export function antigravitySessions({ home = os.homedir(), now = Date.now() } = {}) {
  const dir = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.pb')); } catch { return []; }
  return names.map((n) => {
    let m = 0;
    try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch { return null; }
    const age = now - m;
    if (age > SHOW_MS) return null;
    return { id: `antigravity:${n.replace(/\.pb$/, '')}`, tool: 'Antigravity', project: 'Antigravity', cwd: '', model: 'gemini', state: age < WORKING_MS ? 'thinking' : 'idle', doing: '', idleSec: age < WORKING_MS ? 0 : Math.round(age / 1000), updated: m };
  }).filter(Boolean);
}

/** Newest file (by mtime) under `dir`, `depth` levels down, whose name passes `ok`. */
function newest(dir, ok, depth = 3) {
  let best = null;
  const walk = (d, n) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (n > 0) walk(f, n - 1); continue; }
      if (!ok(e.name)) continue;
      let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { continue; }
      if (!best || m > best.m) best = { f, m };
    }
  };
  walk(dir, depth);
  return best;
}
const active = (tool, id, m, now, extra = {}) => {
  const age = now - m;
  if (age > SHOW_MS) return null;
  return { id: `${tool.toLowerCase().replace(/\W+/g, '')}:${id}`, tool, project: tool, cwd: '', model: '', state: age < WORKING_MS ? 'thinking' : 'idle', doing: '', idleSec: age < WORKING_MS ? 0 : Math.round(age / 1000), updated: m, ...extra };
};

/** Cursor (the IDE's agent and cursor-agent): one session, active while its AI files change. */
export function cursorSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const hits = [
    newest(path.join(home, '.cursor', 'chats'), (n) => /\.(db|json|jsonl)$/.test(n), 3),
    newest(path.join(home, '.cursor', 'ai-tracking'), (n) => n.endsWith('.db'), 0),
    newest(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'), (n) => n === 'state.vscdb', 0),
  ].filter(Boolean).sort((x, y) => y.m - x.m);
  return hits.length ? [active('Cursor', 'cursor', hits[0].m, now)].filter(Boolean) : [];
}

/** Gemini CLI: its per-project logs and chats under ~/.gemini/tmp. */
export function geminiCliSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const root = path.join(home, '.gemini', 'tmp');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return dirs.map((d) => { const h = newest(path.join(root, d), (n) => n.endsWith('.json'), 2); return h ? active('Gemini CLI', d.slice(0, 12), h.m, now) : null; }).filter(Boolean);
}

/** Continue (the VS Code / JetBrains assistant): one file per session. */
export function continueSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const dir = path.join(home, '.continue', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'sessions.json'); } catch { return []; }
  return names.map((n) => { let m = 0; try { m = fs.statSync(path.join(dir, n)).mtimeMs; } catch { return null; } return active('Continue', n.replace(/\.json$/, '').slice(0, 12), m, now); }).filter(Boolean);
}

/** Cline persists one small metadata file per task.  Read it directly instead
 * of VS Code's opaque state database; no prompt or credentials leave disk. */
export function clineSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const root = path.join(home, '.cline', 'data', 'sessions');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return dirs.map((id) => {
    const file = path.join(root, id, `${id}.json`);
    let st, row;
    try { st = fs.statSync(file); row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const age = now - st.mtimeMs;
    if (age > SHOW_MS) return null;
    const running = /^(running|working|active)$/i.test(String(row.status ?? '')) || (!row.ended_at && age < WORKING_MS);
    const usage = row.metadata?.aggregateUsage ?? row.metadata?.usage;
    const tokens = usage ? { in: Number(usage.inputTokens) || 0, cached: Number(usage.cacheReadTokens) || 0, out: Number(usage.outputTokens) || 0 } : null;
    return { id: `cline:${id}`, tool: 'Cline', project: projectName(row.cwd || row.workspace_root) || 'Cline', cwd: row.cwd || row.workspace_root || '', model: row.model || row.metadata?.modelId || '', state: running ? 'thinking' : 'idle', doing: '', idleSec: running ? 0 : Math.round(age / 1000), updated: st.mtimeMs, ...(tokens ? { tokens } : {}) };
  }).filter(Boolean);
}

/** Kilo Code stores sessions in a local SQLite database (the same database its
 * desktop and VS Code surfaces share).  This is a read-only query. */
export function kiloSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const db = path.join(home, '.local', 'share', 'kilo', 'kilo.db');
  const since = now - SHOW_MS;
  return sqliteRows(db, `select id, title, directory, model, agent, time_updated from session where time_updated > ${since} order by time_updated desc limit 12`).map((r) => {
    const updated = Number(r.time_updated);
    const age = now - updated;
    let model = '';
    try { model = JSON.parse(r.model ?? '{}').id ?? ''; } catch { model = String(r.model ?? ''); }
    return { id: `kilo:${r.id}`, tool: 'Kilo', project: projectName(r.directory) || r.title || 'Kilo', cwd: r.directory ?? '', model, state: age < WORKING_MS ? 'thinking' : 'idle', doing: '', idleSec: age < WORKING_MS ? 0 : Math.round(age / 1000), updated };
  });
}

/** Kimi's daemon records active turns/tools in its local runner state.  Only
 * report a session while it says there is active work; never read its loopback
 * token, conversations, or browser profile. */
export function kimiSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const file = path.join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'agents', 'main', 'runner.state.json');
  let st, row;
  try { st = fs.statSync(file); row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const updated = Date.parse(row.updatedAt ?? '') || st.mtimeMs;
  const turns = Array.isArray(row.activeKernelTurns) ? row.activeKernelTurns : [];
  const tools = Array.isArray(row.activeKernelToolCalls) ? row.activeKernelToolCalls : [];
  if (now - updated > SHOW_MS) return [];
  const activeTurn = turns.length || tools.length || Number(row.kernel?.activeTurnCount ?? 0) > 0;
  const age = Math.max(0, now - updated);
  return [{ id: 'kimi:main', tool: 'Kimi', project: 'Kimi', cwd: '', model: row.kernel?.providerModel?.model ?? '',
    // Kimi keeps the runner state file fresh even between turns. Keep that
    // session visible as idle instead of making it vanish from the Island;
    // active turns/tools still get the stronger working state.
    state: activeTurn ? (tools.length || Number(row.kernel?.activeToolCallCount ?? 0) ? 'tool' : 'thinking') : 'idle',
    doing: tools.length ? 'using a tool' : '', idleSec: activeTurn ? 0 : Math.round(age / 1000), updated }];
}

// ---------------------------------------------------------------- installed tools

// A detected extension or app is not automatically an active conversation.
// Discovery can safely show what is available; a live-session adapter must
// understand the tool's local state format before it says a session is active.
const CODING_TOOL_WORDS = /\b(agent|ai|assistant|copilot|claude|cline|kilo|kimi|cursor|codex|continue|aider|gemini|hermes|opencode)\b/i;
const KNOWN_CODING_EXTENSIONS = new Set([
  'github.copilot', 'github.copilot-chat', 'anthropic.claude-code',
  'saoudrizwan.claude-dev', 'kilocode.kilo-code', 'moonshot-ai.kimi-code',
  'continue.continue', 'cursor.cursor', 'google.geminicodeassist',
]);
const NATIVE_SESSION_TOOLS = new Set(['cline', 'kilo', 'kimi', 'claude', 'codex', 'copilot', 'cursor', 'continue', 'gemini', 'hermes', 'opencode']);
const SESSION_TOOL_ALIASES = new Map([
  ['saoudrizwan.claude-dev', 'cline'], ['kilocode.kilo-code', 'kilo'],
  ['moonshot-ai.kimi-code', 'kimi'], ['github.copilot', 'copilot'],
  ['github.copilot-chat', 'copilot'], ['continue.continue', 'continue'],
  ['google.geminicodeassist', 'gemini'], ['anthropic.claude-code', 'claude'],
  ['openai.chatgpt', 'codex'],
]);

function toolSlug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function packageTool(packageFile, source) {
  let p;
  try { p = JSON.parse(fs.readFileSync(packageFile, 'utf8')); } catch { return null; }
  const extensionId = `${p.publisher ?? ''}.${p.name ?? ''}`.replace(/^\.|\.$/g, '');
  const extensionKey = extensionId.toLowerCase();
  const words = [extensionId, p.displayName, p.description, ...(Array.isArray(p.categories) ? p.categories : [])].filter(Boolean).join(' ');
  if (!KNOWN_CODING_EXTENSIONS.has(extensionKey) && !CODING_TOOL_WORDS.test(words)) return null;
  const id = toolSlug(extensionId || p.displayName || path.basename(path.dirname(packageFile)));
  // Do not infer a session protocol merely because an unrelated extension says
  // “Copilot” or “AI”. Only an explicit adapter mapping earns “native”.
  const sessionKey = SESSION_TOOL_ALIASES.get(extensionKey) ?? '';
  return {
    id: `extension:${id}`, tool: p.displayName || p.name || extensionId, source,
    extensionId, state: 'available', sessionSupport: NATIVE_SESSION_TOOLS.has(sessionKey) ? 'native' : 'detected',
  };
}

function runningApp(name) {
  if (process.platform === 'win32') return false; // Windows needs a process-name map, not a guessed .exe name.
  try { return spawnSync('pgrep', ['-x', name], { encoding: 'utf8', timeout: 1500 }).status === 0; } catch { return false; }
}

function defaultAppRoots(home) {
  if (process.platform === 'darwin') return ['/Applications', path.join(home, 'Applications')];
  if (process.platform === 'win32') return [process.env.ProgramFiles, process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  return ['/usr/share/applications', '/usr/local/share/applications', path.join(home, '.local', 'share', 'applications')];
}

/**
 * Finds coding agents already installed on this computer, including VS Code and
 * Cursor extensions. It is read-only on macOS, Windows, and Linux: no settings,
 * API keys, prompts, or extension data are inspected.
 */
export function detectedCodingTools({ home = os.homedir(), appRoots = null } = {}) {
  const found = new Map();
  const add = (row) => { if (row && !found.has(row.id)) found.set(row.id, row); };
  const extensionRoots = [
    [path.join(home, '.vscode', 'extensions'), 'VS Code extension'],
    [path.join(home, '.cursor', 'extensions'), 'Cursor extension'],
    [path.join(home, '.vscode-insiders', 'extensions'), 'VS Code Insiders extension'],
  ];
  for (const [root, source] of extensionRoots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory()) add(packageTool(path.join(root, entry.name, 'package.json'), source));
  }
  for (const root of appRoots ?? defaultAppRoots(home)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const appName = entry.name.replace(/\.(app|exe|desktop)$/i, '');
      if (!CODING_TOOL_WORDS.test(appName)) continue;
      const slug = toolSlug(appName);
      add({ id: `app:${slug}`, tool: appName, source: 'Installed app', appPath: path.join(root, entry.name), state: runningApp(appName) ? 'running' : 'available', sessionSupport: NATIVE_SESSION_TOOLS.has(slug) ? 'native' : 'detected' });
    }
  }
  return [...found.values()].sort((a, b) => a.tool.localeCompare(b.tool));
}

let cache = { at: 0, rows: [] };
/** Every live session of other agents, newest first (cached 2 s: the island polls often). */
export function liveAgents({ home = os.homedir(), now = Date.now(), fresh = false } = {}) {
  if (!fresh && now - cache.at < 2000 && home === os.homedir()) return cache.rows;
  const safe = (f) => { try { return f({ home, now }); } catch { return []; } };
  // Runs ox started inside Claude Code or Codex are ox's own (shown as ox), not another agent (src/own-sessions.js).
  const rows = [claudeSessions, codexSessions, copilotSessions, dbSessions, antigravitySessions, cursorSessions, geminiCliSessions, continueSessions, clineSessions, kiloSessions, kimiSessions].flatMap(safe).filter((s) => !isOwn(s.id)).sort((a, b) => b.updated - a.updated).slice(0, 24);
  if (home === os.homedir()) cache = { at: now, rows };
  return rows;
}

/** The same sessions as Office board rows (live-board's shape), marked external. */
export function asBoardRows(rows, now = Date.now()) {
  return rows.map((s) => ({
    id: `ext:${s.id}`, kind: 'agent', ext: true, who: s.tool, project: s.project, model: s.model || null,
    title: s.project, state: s.state, tool: s.state === 'tool' ? s.doing.split(' ')[0] : null, detail: s.doing,
    idleSec: s.idleSec, started: s.updated, updated: s.updated, parent: null, steps: 0, seconds: Math.round((now - s.updated) / 1000),
    ...(s.tokens ? { tokens: s.tokens.in + s.tokens.out, tokensIn: s.tokens.in, tokensOut: s.tokens.out, tokensCached: s.tokens.cached } : {}),
  }));
}

// ---------------------------------------------------------------- one session

/** The last messages of a session, for the island's session card. */
export async function sessionMessages(id, { home = os.homedir(), limit = 12 } = {}) {
  const [tool, ...rest] = String(id).replace(/^ext:/, '').split(':');
  const sid = rest.join(':');
  if (tool === 'copilot') {
    const msgs = [];
    for (const l of tailLines(path.join(home, '.copilot', 'session-state', sid, 'events.jsonl'), 512 * 1024)) {
      if (l.type === 'user.message' && typeof l.data?.content === 'string') msgs.push({ role: 'user', text: l.data.content });
      if (l.type === 'assistant.message' && typeof l.data?.content === 'string' && l.data.content.trim()) msgs.push({ role: 'assistant', text: l.data.content });
    }
    return { tool, id: sid, messages: msgs.slice(-limit).map((m) => ({ ...m, text: m.text.slice(0, 1200) })), canSend: false, why: "Copilot's agent has no command to continue a session from outside" };
  }
  const T = await import('./session-transfer.js');
  if (!['claude', 'codex', 'hermes'].includes(tool)) return { tool, id: sid, messages: [], canSend: false, why: `${tool} keeps its conversation where ox cannot read it; open it in ${tool}` };
  const entry = T.listSessions({ home, tools: [tool], limit: 200 }).find((x) => String(x.id) === sid);
  if (!entry) throw new Error(`no ${tool} session ${sid}`);
  const s = T.readSession(entry, { home });
  return { tool, id: sid, cwd: s.cwd, model: s.model, title: s.title, messages: s.messages.slice(-limit).map((m) => ({ role: m.role, text: String(m.text ?? '').slice(0, 1200), tools: (m.tools ?? []).slice(-3).map((t) => describeCall(t.name, { command: t.input, file_path: t.input })) })), canSend: true };
}

/** How each tool continues a session with one message (its own resume, headless). */
export function sendCommand(tool, sid, text, bin = (t, f) => f, { modelArgs = () => [] } = {}) {
  if (tool === 'claude') return [bin('claude', 'claude'), ['-p', text, '--resume', sid]];
  // Codex's own config can name a model the ChatGPT account may not use (gpt-5.5
  // was refused here): the account's own list decides, as for ox's plan runs.
  if (tool === 'codex') { const b = bin('codex', 'codex'); return [b, ['exec', 'resume', ...modelArgs(b), sid, text]]; }
  if (tool === 'hermes') return ['hermes', ['chat', '-q', text, '--resume', sid, '-Q']];
  return null;
}

const queue = new Map(); // id -> [{ text, at }]
const sending = new Set();

/**
 * Send a message to a session from the island. It runs one turn of that
 * session through the tool's own resume. A session at work in its own window is
 * never written to at the same time: the message waits until it is idle.
 */
export async function sendToSession(id, text, { home = os.homedir(), run = null } = {}) {
  const key = String(id).replace(/^ext:/, '');
  const [tool, ...rest] = key.split(':');
  const sid = rest.join(':');
  const msg = String(text ?? '').trim();
  if (!msg) throw new Error('nothing to send');
  const T = await import('./session-transfer.js');
  const cmd = sendCommand(tool, sid, msg, T.binaryFor);
  if (!cmd) throw new Error(`ox cannot send to a ${tool} session; open it in ${tool}`);
  const live = liveAgents({ home, fresh: true }).find((s) => s.id === key);
  if ((live && live.state !== 'idle') || sending.has(key)) {
    queue.set(key, [...(queue.get(key) ?? []), { text: msg, at: Date.now() }]);
    waitAndSend(key, home, run);
    return { queued: true, why: `${live?.tool ?? tool} is working on this session now; your message goes in as soon as it is idle` };
  }
  return runTurn(key, tool, sid, msg, live?.cwd || null, home, run);
}

function runTurn(key, tool, sid, msg, cwd, home, run) {
  return new Promise((resolve) => {
    import('./session-transfer.js').then((T) => {
      const [cmd, args] = sendCommand(tool, sid, msg, T.binaryFor, { modelArgs: (b) => T.codexModelArgs(b, { home }) });
      sending.add(key);
      const go = run ?? ((c, a, o) => spawn(c, a, o));
      const p = go(cmd, args, { cwd: cwd && fs.existsSync(cwd) ? cwd : home, env: { ...process.env, OX_ISLAND: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      p.stdout?.on('data', (d) => { out += d; if (out.length > 100_000) out = out.slice(-50_000); });
      p.stderr?.on('data', (d) => { err += d; if (err.length > 20_000) err = err.slice(-10_000); });
      const timer = setTimeout(() => p.kill?.('SIGTERM'), 20 * 60_000);
      p.on('close', (code) => { clearTimeout(timer); sending.delete(key); resolve({ ok: code === 0, reply: out.trim().slice(-4000), error: code === 0 ? null : plainError(err || out, code) }); });
      p.on('error', (e) => { clearTimeout(timer); sending.delete(key); resolve({ ok: false, error: e.message }); });
    });
  });
}

/** The words of a tool's error, not its JSON: "ERROR: {…"message":"X"}" → "X". */
export function plainError(text, code = 1) {
  const t = String(text ?? '').trim();
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t);
  if (m) return m[1].replace(/\\"/g, '"');
  return t.split('\n').filter(Boolean).pop()?.replace(/^ERROR:\s*/i, '').slice(0, 300) || `exit ${code}`;
}

const waiting = new Set();
function waitAndSend(key, home, run) {
  if (waiting.has(key)) return;
  waiting.add(key);
  const started = Date.now();
  const tick = async () => {
    const q = queue.get(key) ?? [];
    if (!q.length || Date.now() - started > 30 * 60_000) { waiting.delete(key); return; }
    const live = liveAgents({ home, fresh: true }).find((s) => s.id === key);
    if ((live && live.state !== 'idle') || sending.has(key)) { setTimeout(tick, 5000).unref?.(); return; }
    const next = q.shift();
    queue.set(key, q);
    const [tool, ...rest] = key.split(':');
    await runTurn(key, tool, rest.join(':'), next.text, live?.cwd || null, home, run);
    setTimeout(tick, 1000).unref?.();
  };
  setTimeout(tick, 5000).unref?.();
}

export const queuedFor = (id) => (queue.get(String(id).replace(/^ext:/, '')) ?? []).length;

// The agent CLIs whose processes can be found by folder.
const AGENT_BINS = /(^|\/)(claude|codex|copilot|opencode|hermes|gemini|cursor-agent|aider|ox)$/;

/** Terminal devices (ttys) of agent processes running in `cwd`, newest first. */
export function ttysFor(cwd) {
  if (!cwd || process.platform === 'win32') return [];
  const ps = spawnSync('ps', ['-axo', 'pid=,tty=,comm='], { encoding: 'utf8', timeout: 5000 });
  const rows = String(ps.stdout ?? '').split('\n').map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean)
    .filter(([, , tty, comm]) => tty !== '??' && AGENT_BINS.test(comm.trim()));
  const out = [];
  for (const [, pid, tty] of rows.reverse()) {
    const l = spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
    const dir = /^n(.+)$/m.exec(l.stdout ?? '')?.[1];
    if (dir && path.resolve(dir) === path.resolve(cwd) && !out.includes(`/dev/${tty}`)) out.push(`/dev/${tty}`);
  }
  return out;
}

/**
 * Bring the exact terminal tab a session runs in to the front (Terminal or
 * iTerm2), found by the agent process's folder and tty. → { focused, app?, tty? }
 */
export async function focusTerminal(id, { home = os.homedir() } = {}) {
  const key = String(id).replace(/^ext:/, '');
  const live = liveAgents({ home }).find((s) => s.id === key);
  if (!live?.cwd) return { focused: false, why: 'this session has no folder to find its terminal by' };
  if (process.platform !== 'darwin') return { focused: false, why: 'jumping to a terminal tab works on macOS' };
  return focusByFolder(live.cwd);
}

/** The terminal tab of an agent running in `cwd`, brought to the front. */
// (The variable is isUp: "running" is a property name in AppleScript, and
// `set running to …` failed on every call, so no tab was ever found.)
export function focusByFolder(cwd) {
  for (const tty of ttysFor(cwd)) {
    const term = `tell application "System Events" to set isUp to (exists process "Terminal")
if isUp then
tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is "${tty}" then
set selected of t to true
set index of w to 1
activate
return "Terminal"
end if
end repeat
end repeat
end tell
end if
return ""`;
    const iterm = `tell application "System Events" to set isUp to (exists process "iTerm2")
if isUp then
tell application "iTerm2"
repeat with w in windows
repeat with t in tabs of w
repeat with s in sessions of t
if tty of s is "${tty}" then
select w
select t
select s
activate
return "iTerm2"
end if
end repeat
end repeat
end repeat
end tell
end if
return ""`;
    for (const script of [term, iterm]) {
      const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 8000 });
      const app = String(r.stdout ?? '').trim();
      if (app) return { focused: true, app, tty };
    }
  }
  return { focused: false, why: 'its terminal tab was not found (it may run inside an editor); open it in a new Terminal instead' };
}

/** Open the session in Terminal, continued by its own tool (you take over there). */
export async function openInTerminal(id, { home = os.homedir(), dryRun = false } = {}) {
  const key = String(id).replace(/^ext:/, '');
  const [tool, ...rest] = key.split(':');
  const sid = rest.join(':');
  const T = await import('./session-transfer.js');
  const cmds = { claude: [T.binaryFor('claude', 'claude'), '--resume', sid], codex: [T.binaryFor('codex', 'codex'), 'resume', sid], hermes: ['hermes', '--resume', sid] };
  const argv = cmds[tool];
  if (!argv) throw new Error(`open ${tool} itself to continue this session`);
  const live = liveAgents({ home }).find((s) => s.id === key);
  const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
  const line = `${live?.cwd ? `cd ${q(live.cwd)} && ` : ''}${argv.map(q).join(' ')}`;
  if (dryRun || process.platform !== 'darwin') return { line };
  spawnSync('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], { timeout: 10000 });
  return { line, opened: true };
}
