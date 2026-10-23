// Session transfer: carry a conversation from one AI tool on this computer to
// another (Claude Code, Codex, Hermes, ox; Gemini CLI and Cursor as targets)
// without breaking any of them.
//
// The rule that keeps the others safe: ox only READS their stores (files, or
// a SQLite database opened read-only) and never writes into them. A session
// moves as a handoff: one neutral transcript, written as .agent/handoff/<id>.md
// (+ .json) in the project, and the target tool is started in the same folder
// through its own command line with a short first message pointing at it.
// When the target is the tool the session came from, its own resume is used.
// Paperclip (paperclipai/paperclip, MIT) keeps each agent's native session and
// resumes it per task; ox follows the same shape, and hands a session to
// Paperclip as a task created with Paperclip's own CLI, under its own login.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redactSecrets as redactMemory } from './memory.js';
import { redactSecrets as redactSession } from './session.js';
// A handoff carries a conversation into another vendor's context: both of ox's
// redactors run (memory's names what it hid; the session one is broader).
const redactSecrets = (text) => ({ text: redactSession(redactMemory(String(text ?? '')).text) });
import { resolveCli, SUBSCRIPTION_CLIS, codexListedModel } from './subscriptions.js';

export const HANDOFF_DIR = path.join('.agent', 'handoff');
const MAX_FILES_SCANNED = 400;

// ---------------------------------------------------------------- helpers
const readLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
// The start of a file, for listing: titles and folders are near the top, and
// a long session file can be many megabytes.
const readHead = (file, bytes = 65536) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const lines = text.split('\n');
    if (n === bytes) lines.pop();
    return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
};
// The end of a file: where a session's latest title and last prompt are.
const readTail = (file, bytes = 65536) => {
  let fd;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
};
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const textOfParts = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text' ? p.text ?? '' : '')).filter(Boolean).join('\n') : '');
// Tool-injected context a person did not type (environment blocks, slash
// command echoes, reminders): not part of the conversation being handed over.
// A summary a tool wrote over its own earlier turns (Hermes, ox, Claude Code
// compaction): background for the handoff, never "what the session was for".
const SUMMARY = /^\s*(?:\[CONTEXT COMPACTION\b|\[ox: summary of earlier conversation turns\]|This session is being continued from a previous conversation)/;
const INJECTED = /^\s*<(?:environment_context|user_instructions|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|turn_aborted|user_shell_command)\b|^\s*# AGENTS\.md instructions\b|^\s*Caveat: The messages below were generated/;

function walkFiles(dir, re, depth = 4, out = []) {
  if (depth < 0 || out.length >= MAX_FILES_SCANNED * 4) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, re, depth - 1, out);
    else if (re.test(e.name)) out.push(full);
  }
  return out;
}

function sqliteJson(db, sql) {
  if (!fs.existsSync(db)) return null;
  // Read-only and immutable-safe: ox never takes a write lock on another tool's database.
  const r = spawnSync('sqlite3', ['-readonly', '-json', `file:${db}?mode=ro`, sql], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

// Files a tool call wrote, from its name and input, whatever the tool.
function filesFromCall(name, input) {
  const n = String(name ?? '').toLowerCase();
  const out = [];
  const a = input && typeof input === 'object' ? input : (() => { try { return JSON.parse(String(input ?? '')); } catch { return {}; } })();
  if (/^(edit|write|multiedit|notebookedit|write_file|edit_file|create_file|str_replace_editor|patch)$/.test(n)) {
    const p = a.file_path ?? a.path ?? a.notebook_path ?? a.filename;
    if (typeof p === 'string') out.push(p);
  }
  if (n === 'apply_patch' || n === 'patch') {
    const text = typeof input === 'string' ? input : a.input ?? a.patch ?? '';
    for (const m of String(text).matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) out.push(m[1].trim());
  }
  return out;
}

function summarizeInput(input) {
  const a = input && typeof input === 'object' ? input : (() => { try { return JSON.parse(String(input ?? '')); } catch { return { value: String(input ?? '') }; } })();
  const s = a.command ?? a.cmd ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.description ?? a.value ?? JSON.stringify(a);
  return String(Array.isArray(s) ? s.join(' ') : s).replace(/\s+/g, ' ').slice(0, 140);
}

// ---------------------------------------------------------------- readers
// Each reader: list(home) -> [{ tool, id, cwd, title, updatedAt, ref }],
//              read(home, ref) -> neutral session.
// Neutral session: { tool, id, cwd, branch, model, title, startedAt, updatedAt,
//   messages: [{ role: 'user'|'assistant', text, tools: [{ name, input }] }], files: [] }

const claude = {
  label: 'Claude Code',
  list(home) {
    const files = walkFiles(path.join(home, '.claude', 'projects'), /\.jsonl$/, 2).sort((a, b) => mtime(b) - mtime(a)).slice(0, MAX_FILES_SCANNED);
    return files.map((f) => {
      const head = readHead(f);
      const tail = readTail(f);
      const cwd = head.find((o) => o.cwd)?.cwd ?? tail.find((o) => o.cwd)?.cwd ?? null;
      const titled = [...tail].reverse().find((o) => o.type === 'custom-title') ?? head.find((o) => o.type === 'custom-title');
      const title = titled?.customTitle
        ?? firstUserText(head.filter((o) => o.type === 'user').map((o) => textOfParts(o.message?.content)))
        ?? firstUserText([[...tail].reverse().find((o) => o.type === 'last-prompt')?.lastPrompt]);
      return { tool: 'claude', id: path.basename(f, '.jsonl'), cwd, title, updatedAt: mtime(f), ref: f };
    });
  },
  read(home, ref) {
    const rows = readLines(ref);
    const s = base('claude', path.basename(ref, '.jsonl'), ref);
    for (const o of rows) {
      if (o.cwd && !s.cwd) s.cwd = o.cwd;
      if (o.gitBranch && !s.branch) s.branch = o.gitBranch;
      if (o.type === 'custom-title') s.title = o.customTitle;
      if (o.timestamp) { s.startedAt ??= o.timestamp; s.updatedAt = o.timestamp; }
      if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
      const content = o.message?.content;
      if (o.type === 'assistant') {
        if (o.message?.model && !String(o.message.model).startsWith('<')) s.model = o.message.model;
        const tools = (Array.isArray(content) ? content : []).filter((p) => p?.type === 'tool_use').map((p) => ({ name: p.name, input: summarizeInput(p.input), files: filesFromCall(p.name, p.input) }));
        push(s, 'assistant', textOfParts(content), tools);
      } else {
        // A user record holding only tool results is the tool's output, not the person.
        if (Array.isArray(content) && content.every((p) => p?.type === 'tool_result')) continue;
        push(s, 'user', textOfParts(content));
      }
    }
    return finish(s);
  },
  resume: (id) => ['claude', ['--resume', id]],
  start: (prompt) => ['claude', [prompt]],
};

const codex = {
  label: 'Codex',
  list(home) {
    const files = walkFiles(path.join(home, '.codex', 'sessions'), /^rollout-.*\.jsonl$/, 4).sort((a, b) => mtime(b) - mtime(a)).slice(0, MAX_FILES_SCANNED);
    return files.map((f) => {
      const head = readHead(f);
      // Codex desktop transcripts can be hundreds of MB.  The session meta is
      // at the head, while the useful title is normally at the tail; never
      // read the whole JSONL just to populate Island/Office.
      const tail = readTail(f);
      const meta = head.find((o) => o.type === 'session_meta')?.payload ?? {};
      const users = (tail.length ? tail : head).filter((o) => o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user').map((o) => textOfParts(o.payload.content));
      const hasImage = users.some((u) => /<image\b/i.test(u));
      return { tool: 'codex', id: meta.id ?? meta.session_id ?? path.basename(f, '.jsonl'), cwd: meta.cwd ?? null, title: firstUserText(users) ?? (hasImage ? '(an image)' : null), updatedAt: mtime(f), ref: f };
    });
  },
  read(home, ref) {
    // `fs.readFileSync(..., 'utf8')` throws for very large desktop transcripts
    // (ERR_STRING_TOO_LONG), which used to turn a real active Codex chat into
    // an empty Island card.  Read metadata from the head and recent turns from
    // a bounded tail instead.  The handoff/UI deliberately uses recent context,
    // not an unbounded vendor-native transcript.
    const head = readHead(ref);
    const tail = readTail(ref, 512 * 1024);
    const meta = head.find((o) => o.type === 'session_meta')?.payload ?? {};
    const rows = tail.length ? tail : head;
    const s = base('codex', meta.id ?? meta.session_id ?? path.basename(ref, '.jsonl'), ref);
    s.cwd = meta.cwd ?? null;
    s.branch = meta.git?.branch ?? null;
    let pendingTools = [];
    for (const o of rows) {
      if (o.timestamp) { s.startedAt ??= o.timestamp; s.updatedAt = o.timestamp; }
      const p = o.payload ?? {};
      if (o.type === 'turn_context' && p.model) s.model = p.model;
      if (o.type !== 'response_item') continue;
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        if (p.role === 'assistant') { push(s, 'assistant', textOfParts(p.content), pendingTools); pendingTools = []; }
        else push(s, 'user', textOfParts(p.content));
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        const input = p.arguments ?? p.input ?? p.action;
        pendingTools.push({ name: p.name ?? p.type, input: summarizeInput(input), files: filesFromCall(p.name, input) });
      }
    }
    if (pendingTools.length) push(s, 'assistant', '', pendingTools);
    return finish(s);
  },
  resume: (id) => ['codex', ['resume', id]],
  start: (prompt) => ['codex', [prompt]],
};

const hermes = {
  label: 'Hermes',
  db: (home) => path.join(home, '.hermes', 'state.db'),
  list(home) {
    const rows = sqliteJson(this.db(home), `select id, title, cwd, model, git_branch, started_at, coalesce(last_activity_at, ended_at, started_at) as updated, message_count from sessions where coalesce(hidden,0)=0 and coalesce(archived,0)=0 and message_count > 0 order by updated desc limit ${MAX_FILES_SCANNED}`) ?? [];
    return rows.map((r) => ({ tool: 'hermes', id: r.id, cwd: r.cwd, title: r.title || null, updatedAt: Math.round(Number(r.updated) * 1000), ref: r.id }));
  },
  read(home, id) {
    const safe = String(id).replace(/'/g, "''");
    const [meta] = sqliteJson(this.db(home), `select id, title, cwd, model, git_branch, started_at, coalesce(last_activity_at, ended_at, started_at) as updated from sessions where id='${safe}'`) ?? [];
    if (!meta) throw new Error(`no Hermes session ${id}`);
    const s = base('hermes', meta.id, this.db(home));
    Object.assign(s, { cwd: meta.cwd, title: meta.title, model: meta.model, branch: meta.git_branch, startedAt: new Date(meta.started_at * 1000).toISOString(), updatedAt: new Date(meta.updated * 1000).toISOString() });
    const msgs = sqliteJson(this.db(home), `select role, content, tool_calls from messages where session_id='${safe}' and coalesce(active,1)=1 order by id`) ?? [];
    for (const m of msgs) {
      if (m.role === 'user') push(s, 'user', m.content ?? '');
      else if (m.role === 'assistant') {
        let calls = [];
        try { calls = JSON.parse(m.tool_calls || '[]') ?? []; } catch {}
        const tools = (Array.isArray(calls) ? calls : []).map((c) => ({ name: c?.function?.name ?? c?.name, input: summarizeInput(c?.function?.arguments ?? c?.arguments), files: filesFromCall(c?.function?.name ?? c?.name, c?.function?.arguments ?? c?.arguments) }));
        push(s, 'assistant', m.content ?? '', tools);
      }
    }
    return finish(s);
  },
  resume: (id) => ['hermes', ['--resume', id]],
  start: (prompt) => ['hermes', ['chat', '-q', prompt]],
};

const ox = {
  label: 'ox',
  dir: (home) => path.join(home, '.ox', 'sessions'),
  list(home) {
    let files = [];
    try { files = fs.readdirSync(this.dir(home)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(this.dir(home), f)); } catch {}
    return files.sort((a, b) => mtime(b) - mtime(a)).slice(0, MAX_FILES_SCANNED).map((f) => {
      const rows = readHead(f);
      const meta = rows.find((o) => o.t === 'meta') ?? {};
      return { tool: 'ox', id: path.basename(f, '.jsonl').split('-').pop(), cwd: meta.cwd ?? null, title: rows.find((o) => o.t === 'title')?.title ?? firstUserText(rows.filter((o) => o.t === 'user').map((o) => o.text)), updatedAt: mtime(f), ref: f };
    });
  },
  read(home, ref) {
    const rows = readLines(ref);
    const meta = rows.find((o) => o.t === 'meta') ?? {};
    const s = base('ox', path.basename(ref, '.jsonl').split('-').pop(), ref);
    Object.assign(s, { cwd: meta.cwd ?? null, model: meta.bot ?? null, startedAt: meta.created ?? null, updatedAt: new Date(mtime(ref)).toISOString(), title: rows.find((o) => o.t === 'title')?.title ?? null });
    for (const o of rows) {
      if (o.t === 'user') push(s, 'user', typeof o.text === 'string' ? o.text : textOfParts(o.content));
      if (o.t === 'assistant') {
        const tools = (Array.isArray(o.tool_calls) ? o.tool_calls : []).map((c) => ({ name: c?.function?.name ?? c?.name, input: summarizeInput(c?.function?.arguments), files: filesFromCall(c?.function?.name, c?.function?.arguments) }));
        push(s, 'assistant', o.text ?? '', tools);
      }
    }
    return finish(s);
  },
  resume: (id) => [process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js'), '--resume', id]],
  start: (prompt) => [process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js'), prompt]],
};

// Cline's VS Code extension stores a JSON transcript per task. Reading it is
// safe; continuing it still belongs to Cline, so transfers use a handoff file.
const cline = {
  label: 'Cline',
  list(home) {
    const root = path.join(home, '.cline', 'data', 'sessions');
    let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
    return dirs.map((e) => {
      const id = e.name, ref = path.join(root, id, `${id}.messages.json`);
      if (!fs.existsSync(ref)) return null;
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(root, id, `${id}.json`), 'utf8')); } catch {}
      return { tool: 'cline', id, cwd: meta.cwd ?? meta.workspace_root ?? meta.workspacePath ?? null, title: meta.task ?? meta.title ?? id, updatedAt: mtime(ref), ref };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  read(home, ref) {
    let doc = {}; try { doc = JSON.parse(fs.readFileSync(ref, 'utf8')); } catch {}
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(ref.replace(/\.messages\.json$/, '.json'), 'utf8')); } catch {}
    const s = base('cline', doc.sessionId ?? path.basename(ref, '.messages.json'), ref);
    s.title = doc.task ?? doc.title ?? meta.task ?? meta.title ?? meta.metadata?.title ?? s.id;
    s.cwd = doc.cwd ?? meta.cwd ?? meta.workspace_root ?? meta.workspacePath ?? null;
    s.model = doc.model ?? meta.model ?? meta.metadata?.modelId ?? null;
    s.updatedAt = doc.updated_at ?? meta.updated_at ?? new Date(mtime(ref)).toISOString();
    for (const m of Array.isArray(doc.messages) ? doc.messages : []) {
      const text = textOfParts((m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text ?? ''));
      if (text.trim()) push(s, m.role === 'user' ? 'user' : 'assistant', text);
    }
    return finish(s);
  },
};

// Kimi Code's desktop daemon keeps conversation metadata in a local SQLite
// database and the model wire transcript beside it. Both are read-only here.
const kimi = {
  label: 'Kimi',
  list(home) {
    const db = path.join(home, 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'agents', 'main', 'sessions', 'hosted-logical', 'conversations.sqlite');
    if (!fs.existsSync(db)) return [];
    const q = spawnSync('sqlite3', ['-readonly', '-json', db, 'select conversation_key,title,workspace_path,updated_at,updated_at_ms from conversations order by updated_at_ms desc limit 30'], { encoding: 'utf8', timeout: 5000 });
    let rows = []; try { rows = JSON.parse(q.stdout || '[]'); } catch { return []; }
    return rows.map((r) => ({ tool: 'kimi', id: r.conversation_key, cwd: r.workspace_path || null, title: r.title || 'Kimi session', updatedAt: r.updated_at || new Date(Number(r.updated_at_ms)).toISOString(), ref: `${db}::${r.conversation_key}` }));
  },
  read(home, ref) {
    const raw = String(ref), sep = raw.indexOf('::');
    const db = sep >= 0 ? raw.slice(0, sep) : raw, key = sep >= 0 ? raw.slice(sep + 2) : '';
    const safe = String(key || '').replace(/'/g, "''");
    const q = spawnSync('sqlite3', ['-readonly', '-json', db, `select title,workspace_path,kernel_records_path,updated_at from conversations where conversation_key='${safe}' limit 1`], { encoding: 'utf8', timeout: 5000 });
    let row = []; try { row = JSON.parse(q.stdout || '[]'); } catch {}
    const meta = row[0] || {}, s = base('kimi', key || 'main', ref);
    Object.assign(s, { cwd: meta.workspace_path || null, title: meta.title || 'Kimi session', updatedAt: meta.updated_at || null });
    let lines = []; try { lines = fs.readFileSync(meta.kernel_records_path, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return finish(s); }
    // Kimi records a typed prompt twice in sequence: once as `turn.prompt`
    // and again as the user `context.append_message`.  Keep the real
    // conversation order while suppressing only that adjacent duplicate; two
    // genuinely repeated prompts separated by an assistant turn are retained.
    let previous = null;
    const append = (role, raw) => {
      // Kimi's desktop wire log prefixes some user messages with a private
      // routing envelope. It is not text the person wrote and should never
      // leak into the Island/Office transcript or a transfer handoff.
      const text = textOfParts(raw).replace(/^\s*<meta\b[^>]*\/>\s*/i, '').trim();
      if (previous?.role === role && previous.text === text) return;
      push(s, role, text);
      if (text) previous = { role, text };
    };
    for (const e of lines) {
      if (e.type === 'turn.prompt') append('user', e.input);
      if (e.type === 'context.append_message') append(e.message?.role === 'user' ? 'user' : 'assistant', e.message?.content);
    }
    return finish(s);
  },
};

// Kilo Code keeps its transcript in the same local SQLite database used by
// its desktop and VS Code views.  This is deliberately read-only: Ox can show
// and hand off context, but it must not inject messages into Kilo's private
// store or pretend that it resumed Kilo's vendor-native turn.
const kilo = {
  label: 'Kilo',
  db: (home) => path.join(home, '.local', 'share', 'kilo', 'kilo.db'),
  list(home) {
    const rows = sqliteJson(this.db(home), 'select id,title,directory,model,time_updated from session order by time_updated desc limit 100') ?? [];
    return rows.map((r) => {
      let model = null; try { model = JSON.parse(r.model ?? '{}').id ?? null; } catch { model = r.model ?? null; }
      return { tool: 'kilo', id: r.id, cwd: r.directory || null, title: r.title || 'Kilo session', model, updatedAt: Number(r.time_updated) || 0, ref: `${this.db(home)}::${r.id}` };
    });
  },
  read(home, ref) {
    const raw = String(ref), sep = raw.indexOf('::');
    const db = sep >= 0 ? raw.slice(0, sep) : raw, id = sep >= 0 ? raw.slice(sep + 2) : '';
    const safe = id.replace(/'/g, "''");
    const meta = (sqliteJson(db, `select id,title,directory,model,time_created,time_updated from session where id='${safe}' limit 1`) ?? [])[0];
    if (!meta) throw new Error(`no Kilo session ${id}`);
    let model = null; try { model = JSON.parse(meta.model ?? '{}').id ?? null; } catch { model = meta.model ?? null; }
    const s = base('kilo', meta.id, ref);
    Object.assign(s, { cwd: meta.directory || null, title: meta.title || 'Kilo session', model, startedAt: Number(meta.time_created) ? new Date(Number(meta.time_created)).toISOString() : null, updatedAt: Number(meta.time_updated) ? new Date(Number(meta.time_updated)).toISOString() : null });
    // Bound to the latest 100 messages; Kilo's reasoning/tool parts can be
    // large, while Island and a handoff need recent usable conversation.
    const rows = sqliteJson(db, `select m.id,m.time_created,m.data as message,p.data as part from (select id,time_created,time_updated,data from message where session_id='${safe}' order by time_updated desc limit 100) m left join part p on p.message_id=m.id order by m.time_created asc,p.time_created asc`) ?? [];
    const messages = new Map();
    for (const row of rows) {
      let m; try { m = JSON.parse(row.message ?? '{}'); } catch { m = {}; }
      const existing = messages.get(row.id) ?? { role: m.role === 'user' ? 'user' : 'assistant', text: [] };
      if (row.part) {
        let p; try { p = JSON.parse(row.part); } catch { p = {}; }
        // Visible text is useful context; omit hidden/internal reasoning and
        // step metadata from the transcript and handoff.
        if (p.type === 'text' && !p.ignored && typeof p.text === 'string') existing.text.push(p.text);
      }
      messages.set(row.id, existing);
    }
    for (const m of messages.values()) push(s, m.role, m.text.join('\n'));
    return finish(s);
  },
};

// Targets only: these keep their sessions where ox does not read them, but
// they can be handed a session through their command line.
const gemini = { label: 'Gemini CLI', start: (prompt) => ['gemini', ['-i', prompt]] };
const cursor = { label: 'Cursor', start: (prompt) => ['cursor-agent', [prompt]], resume: (id) => ['cursor-agent', ['--resume', id]] };

export const TOOLS = Object.freeze({ claude, codex, hermes, ox, cline, kimi, kilo, gemini, cursor });
export const SOURCES = Object.freeze(['claude', 'codex', 'hermes', 'ox', 'cline', 'kimi', 'kilo']);
export const TARGETS = Object.freeze(['claude', 'codex', 'hermes', 'ox', 'gemini', 'cursor', 'cline', 'kilo', 'kimi', 'paperclip', 'file']);
const ALIASES = { 'claude-code': 'claude', cc: 'claude', chatgpt: 'codex', openai: 'codex', 'cursor-agent': 'cursor', 'gemini-cli': 'gemini' };
export const toolName = (s) => { const n = String(s ?? '').toLowerCase(); return ALIASES[n] ?? n; };

function base(tool, id, ref) {
  return { tool, id, ref, cwd: null, branch: null, model: null, title: null, startedAt: null, updatedAt: null, messages: [], files: [] };
}
function push(s, role, text, tools = []) {
  const t = String(text ?? '').trim();
  if (role === 'user' && (!t || INJECTED.test(t))) return;
  if (!t && !tools.length) return;
  s.messages.push({ role, text: t, tools: tools.map(({ name, input }) => ({ name, input })) });
  for (const tl of tools) for (const f of tl.files ?? []) if (!s.files.includes(f)) s.files.push(f);
}
function finish(s) {
  if (!s.title) s.title = firstUserText(s.messages.filter((m) => m.role === 'user').map((m) => m.text));
  return s;
}
function firstUserText(texts) {
  const t = texts.map((x) => String(x ?? '').replace(/<image\b[^>]*>(?:\s*<\/image>)?/gi, '').trim()).find((x) => x && !INJECTED.test(x));
  return t ? t.replace(/\s+/g, ' ').slice(0, 80) : null;
}

// ---------------------------------------------------------------- finding sessions
/** Recent sessions across tools, newest first. `cwd` keeps those from that folder (or inside it). */
export function listSessions({ home = os.homedir(), tools = SOURCES, cwd = null, limit = 20 } = {}) {
  const out = [];
  for (const t of tools) {
    try { out.push(...TOOLS[t].list(home)); } catch { /* a tool that is not installed has nothing to list */ }
  }
  const inFolder = (s) => !cwd || (s.cwd && (path.resolve(s.cwd) === path.resolve(cwd) || path.resolve(s.cwd).startsWith(path.resolve(cwd) + path.sep)));
  return out.filter(inFolder).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * A session by reference: "claude" (its latest), "claude:<id or id prefix>",
 * or "latest" (the newest of any tool). With `cwd`, "latest" means latest here.
 */
export function findSession(ref, { home = os.homedir(), cwd = null } = {}) {
  const [rawTool, rawId] = String(ref ?? 'latest').split(/:(.+)/);
  const tool = toolName(rawTool);
  if (tool === 'latest' || tool === '') {
    const [hit] = listSessions({ home, cwd, limit: 1 });
    if (!hit) throw new Error(`no session found${cwd ? ` for ${cwd}` : ''}`);
    return hit;
  }
  if (!SOURCES.includes(tool)) throw new Error(`ox can read sessions from ${SOURCES.join(', ')}; not "${rawTool}"`);
  const all = TOOLS[tool].list(home);
  const id = (rawId ?? '').trim();
  const pick = !id || id === 'latest'
    ? (cwd ? all.find((s) => s.cwd && path.resolve(s.cwd) === path.resolve(cwd)) : null) ?? all[0]
    : all.find((s) => s.id === id) ?? all.find((s) => String(s.id).startsWith(id));
  if (!pick) throw new Error(`no ${TOOLS[tool].label} session ${id || 'found'}`);
  return pick;
}

export function readSession(entry, { home = os.homedir() } = {}) {
  return TOOLS[entry.tool].read(home, entry.ref);
}

// ---------------------------------------------------------------- the handoff
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)} …[${s.length - n} more characters]`);

function gitState(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const g = (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });
  if (g(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return null;
  return {
    branch: g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(),
    // This folder only: the repository can be much bigger (a home folder under git).
    status: g(['status', '--short', '--relative', '--', '.']).stdout.trim().split('\n').filter(Boolean).slice(0, 40),
    log: g(['log', '--oneline', '-5', '--', '.']).stdout.trim().split('\n').filter(Boolean),
  };
}

/**
 * The handoff as Markdown: what the session was for, the conversation
 * (the opening request whole, then the latest turns, within a budget),
 * the files it changed and the folder as it is now. Secrets are redacted.
 */
export function handoffMarkdown(s, { budget = 24_000, git = gitState(s.cwd) } = {}) {
  const summaries = s.messages.filter((m) => m.role === 'user' && SUMMARY.test(m.text));
  const users = s.messages.filter((m) => m.role === 'user' && !SUMMARY.test(m.text));
  const lines = [
    `# Handoff: ${s.title ?? 'a session'}`,
    '',
    `Carried over from **${TOOLS[s.tool]?.label ?? s.tool}** session \`${s.id}\` by ox on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`,
    `Folder: \`${s.cwd ?? 'unknown'}\`${s.branch ? ` · branch \`${s.branch}\`` : ''}${s.model ? ` · model ${s.model}` : ''} · ${s.messages.length} messages${s.startedAt ? ` · started ${String(s.startedAt).slice(0, 16).replace('T', ' ')}` : ''}`,
    '',
    '## What it was for',
    users[0] ? clip(users[0].text, 2000) : '(no request found)',
    ...(users.length > 1 ? ['', '**Latest request:**', clip(users.at(-1).text, 1500)] : []),
    '',
    ...(summaries.length ? ['## Earlier summary (written by the tool itself)', clip(summaries.at(-1).text.replace(/^\s*\[[^\]\n]*\]\s*/, '').replace(SUMMARY, '').trim(), 6000), ''] : []),
  ];
  // The conversation, newest kept first within the budget, shown oldest first.
  const rendered = s.messages.filter((m) => !(m.role === 'user' && SUMMARY.test(m.text))).map((m) => {
    const tools = m.tools.length ? `\n${m.tools.slice(0, 12).map((t) => `  - ${t.name}: ${t.input}`).join('\n')}${m.tools.length > 12 ? `\n  - …and ${m.tools.length - 12} more` : ''}` : '';
    return `**${m.role === 'user' ? 'User' : 'Assistant'}:** ${clip(m.text || '(tools only)', m.role === 'user' ? 1500 : 1200)}${tools}`;
  });
  const kept = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 1; i--) {
    if (used + rendered[i].length > budget) break;
    kept.unshift(rendered[i]);
    used += rendered[i].length;
  }
  const skipped = rendered.length - 1 - kept.length;
  lines.push('## Conversation', ...(rendered[0] ? [rendered[0]] : []), ...(skipped > 0 ? [`\n_…${skipped} earlier message${skipped === 1 ? '' : 's'} left out (the full transcript is in the original tool)…_`] : []), ...kept.flatMap((r) => ['', r]), '');
  if (s.files.length) lines.push('## Files it changed', ...s.files.slice(0, 60).map((f) => `- \`${f}\``), '');
  if (git) {
    lines.push('## The folder now', `Branch \`${git.branch}\`.`);
    if (git.status.length) lines.push('Uncommitted:', '```', ...git.status, '```');
    else lines.push('No uncommitted changes.');
    if (git.log.length) lines.push('Recent commits:', '```', ...git.log, '```');
    lines.push('');
  }
  lines.push('## How to continue', 'Pick up where this session stopped. Read the files above before changing anything, check the current state (git status, the tests), and say what you found before you start.');
  return redactSecrets(lines.join('\n')).text;
}

/** Write the handoff into the project (.agent/handoff/) and return its paths. */
export function writeHandoff(s, { dir = null, home = os.homedir(), ...opts } = {}) {
  const requested = dir ?? (s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd());
  const root = path.parse(path.resolve(requested)).root;
  let target = requested;
  // Some editors persist `/` or a vanished scratch directory as their session
  // folder.  Never try to create `/.agent` (nor fail a transfer): keep the
  // redacted handoff in Ox's local data instead and report that exact folder.
  try { fs.accessSync(target, fs.constants.W_OK); } catch { target = ''; }
  if (!target || path.resolve(target) === root) target = path.join(home, '.ox', 'handoffs', `${s.tool}-${String(s.id).slice(0, 16)}`);
  const out = path.join(target, HANDOFF_DIR);
  fs.mkdirSync(out, { recursive: true });
  // Never an untracked surprise in someone's repository: the folder ignores
  // itself, and the project's own .gitignore is left alone.
  const ignore = path.join(out, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const name = `${new Date().toISOString().slice(0, 10)}-${s.tool}-${String(s.id).slice(0, 8)}`;
  const md = path.join(out, `${name}.md`);
  const json = path.join(out, `${name}.json`);
  fs.writeFileSync(md, handoffMarkdown(s, opts));
  const { ref, ...rest } = s;
  fs.writeFileSync(json, redactSecrets(JSON.stringify({ ...rest, source: { tool: s.tool, id: s.id }, transferredAt: new Date().toISOString() }, null, 2)).text);
  return { md, json, dir: target, rel: path.relative(target, md) };
}

// ---------------------------------------------------------------- delivery
/**
 * How the target gets the session. Returns { kind, cmd, args, cwd, note }:
 *   resume   the same tool: its own resume, nothing copied
 *   start    another tool: started in the folder, told to read the handoff
 *   import   ox: the conversation becomes an ox session (ox's own store)
 *   paperclip  a Paperclip task, created by Paperclip's own CLI
 *   file     only the handoff file
 */
export function deliveryPlan(s, target, handoff, { company = process.env.PAPERCLIP_COMPANY_ID ?? null, home = os.homedir() } = {}) {
  const to = toolName(target);
  const cwd = handoff.dir;
  const prompt = `Continue the work handed over from ${TOOLS[s.tool]?.label ?? s.tool}: read ${handoff.rel} first, then check the current state before changing anything.`;
  if (to === 'file') return { kind: 'file', cwd, note: handoff.md };
  if (to === s.tool && TOOLS[to]?.resume) {
    const [cmd, args] = TOOLS[to].resume(s.id);
    return { kind: 'resume', cmd: binaryFor(to, cmd), args, cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : cwd, note: `${TOOLS[to].label}'s own resume (nothing copied)` };
  }
  if (to === 'ox') return { kind: 'import', cwd, note: 'imported as an ox session' };
  if (to === 'paperclip') {
    const title = `Continue: ${s.title ?? `${s.tool} session ${s.id}`}`.slice(0, 120);
    if (!company) return { kind: 'paperclip', cmd: null, cwd, title, note: 'Paperclip needs a company: --company <id> or PAPERCLIP_COMPANY_ID' };
    return { kind: 'paperclip', cmd: 'paperclipai', args: ['issue', 'create', '-C', company, '--title', title, '--description', fs.readFileSync(handoff.md, 'utf8')], cwd, title };
  }
  // Desktop-only agents do not expose a supported CLI resume endpoint. Ox
  // still creates a redacted handoff for them so the user can paste one
  // deterministic continuation prompt into Cline or Kimi, without writing to
  // either app's private database.
  if (to === 'cline' || to === 'kilo' || to === 'kimi') return { kind: 'external', cwd, target: to, note: `handoff ready for ${to}; open ${to} and paste the continuation prompt`, prompt, handoff: handoff.md };
  if (!TOOLS[to]?.start) throw new Error(`ox can hand a session to ${TARGETS.join(', ')}; not "${target}"`);
  const [cmd, args] = TOOLS[to].start(prompt);
  const bin = binaryFor(to, cmd);
  return { kind: 'start', cmd: bin, args: to === 'codex' ? [...codexModelArgs(bin, { home }), ...args] : args, cwd, prompt };
}

// Codex refuses a model a ChatGPT account cannot use, and its own config can
// ask for one (seen here: gpt-5.5 in ~/.codex/config.toml, refused). As ox's
// plan runner does, the account's own list decides: the configured model is
// kept when it is allowed, otherwise the first model the account lists.
export function codexModelArgs(bin, { home = os.homedir(), listed = null } = {}) {
  let configured = null;
  try { configured = /^\s*model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'))?.[1] ?? null; } catch {}
  if (!configured) return [];
  const models = listed ?? codexModels(bin);
  if (!models.length || models.includes(configured)) return [];
  return ['-m', models[0]];
}
function codexModels(bin) {
  const r = spawnSync(bin, ['debug', 'models'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return [];
  try {
    const j = JSON.parse(r.stdout);
    const list = Array.isArray(j) ? j : j.models ?? Object.values(j);
    return list.filter((m) => (m.visibility ?? m.show_in_picker) === 'list').map((m) => m.slug).filter(Boolean);
  } catch { return codexListedModel(bin) ? [codexListedModel(bin)] : []; }
}

// The copy of a CLI that actually runs: the one on PATH, or the working copy
// an editor or app carries (src/subscriptions.js; on this kind of Mac the npm
// `codex` on PATH had lost its binary while the ChatGPT extension's worked).
const PLAN_ID = { claude: 'claude', codex: 'chatgpt', cursor: 'cursor', gemini: 'gemini' };
export function binaryFor(tool, fallback) {
  const cli = SUBSCRIPTION_CLIS[PLAN_ID[tool]];
  try { return (cli && resolveCli(cli)?.where) || fallback; } catch { return fallback; }
}

/** The conversation as an ox session, so `ox --resume <id>` continues it with ox's own history. */
export function importToOx(s, { home = os.homedir(), handoff = null } = {}) {
  const dir = path.join(home, '.ox', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const id = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  const file = path.join(dir, `${stamp}-${id}.jsonl`);
  const rows = [
    { t: 'meta', created: new Date().toISOString(), cwd: s.cwd ?? process.cwd(), bot: null, importedFrom: { tool: s.tool, id: s.id, handoff: handoff?.md ?? null } },
    ...(s.title ? [{ t: 'title', title: `${s.title} (from ${TOOLS[s.tool]?.label ?? s.tool})` }] : []),
    ...s.messages.map((m) => ({ t: m.role, text: redactSecrets(m.role === 'assistant' && m.tools.length ? `${m.text}${m.text ? '\n' : ''}[${TOOLS[s.tool]?.label ?? s.tool} ran: ${m.tools.map((t) => `${t.name} ${t.input}`).join('; ').slice(0, 600)}]` : m.text).text })),
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { file, id };
}

export function onPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return fs.existsSync(cmd);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
}
