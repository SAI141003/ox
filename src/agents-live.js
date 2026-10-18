// Other agents working on this Mac, live: Claude Code (the CLI, the desktop
// app's Code tab, worktree sessions) and Codex, from their own session files,
// read-only. Claudex's "4 sessions working" and Coucou's live feed: what each
// is doing now (the file it edits, the command it runs), its model, and how
// long it has been idle. Nothing is written to their folders and no login or
// token file is read: only the session transcripts, as `ox transfer` reads them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
export function projectName(cwd) {
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
    let cwd = '', model = '', doing = '', lastKind = '', pendingTool = false;
    for (const l of lines) {
      if (l.cwd) cwd = l.cwd;
      if (l.type === 'assistant' && l.message) {
        if (l.message.model && !/synthetic/.test(l.message.model)) model = l.message.model;
        const calls = (l.message.content ?? []).filter((c) => c?.type === 'tool_use');
        if (calls.length) { const c = calls.at(-1); doing = describeCall(c.name, c.input); pendingTool = true; lastKind = 'tool'; } else if ((l.message.content ?? []).some((c) => c?.type === 'text')) { lastKind = 'text'; pendingTool = false; }
      } else if (l.type === 'user' && Array.isArray(l.message?.content) && l.message.content.some((c) => c?.type === 'tool_result')) {
        pendingTool = false; lastKind = 'result';
      }
    }
    const age = now - mtime;
    const working = age < WORKING_MS || (pendingTool && age < 5 * 60_000);
    return { id: `claude:${path.basename(file, '.jsonl')}`, tool: 'Claude Code', project: projectName(cwd) || 'claude', cwd, model, state: working ? (doing && lastKind !== 'text' ? 'tool' : 'thinking') : 'idle', doing: working ? doing : '', idleSec: working ? 0 : Math.round(age / 1000), updated: mtime };
  }).filter((s) => s.cwd || s.model);
}

export function codexSessions({ home = os.homedir(), now = Date.now() } = {}) {
  return recentFiles(path.join(home, '.codex', 'sessions'), 3, now).map(({ file, mtime }) => {
    const lines = tailLines(file);
    let cwd = '', model = '', doing = '', done = false;
    for (const l of lines) {
      const p = l.payload ?? {};
      if (p.cwd) cwd = p.cwd;
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
    return { id: `codex:${path.basename(file, '.jsonl')}`, tool: 'Codex', project: projectName(cwd) || 'codex', cwd, model, state: working ? (doing ? 'tool' : 'thinking') : 'idle', doing: working ? doing : '', idleSec: working ? 0 : Math.round(age / 1000), updated: mtime };
  });
}

let cache = { at: 0, rows: [] };
/** Every live session of other agents, newest first (cached 2 s: the island polls often). */
export function liveAgents({ home = os.homedir(), now = Date.now(), fresh = false } = {}) {
  if (!fresh && now - cache.at < 2000 && home === os.homedir()) return cache.rows;
  const rows = [...claudeSessions({ home, now }), ...codexSessions({ home, now })].sort((a, b) => b.updated - a.updated).slice(0, 12);
  if (home === os.homedir()) cache = { at: now, rows };
  return rows;
}

/** The same sessions as Office board rows (live-board's shape), marked external. */
export function asBoardRows(rows, now = Date.now()) {
  return rows.map((s) => ({
    id: `ext:${s.id}`, kind: 'agent', ext: true, who: s.tool, project: s.project, model: s.model || null,
    title: s.project, state: s.state, tool: s.state === 'tool' ? s.doing.split(' ')[0] : null, detail: s.doing,
    idleSec: s.idleSec, started: s.updated, updated: s.updated, parent: null, steps: 0, seconds: Math.round((now - s.updated) / 1000),
  }));
}
