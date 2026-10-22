// ox import: bring your setup from Claude Code, Codex, Cursor and Hermes, read
// in each tool's real formats (as Cursor already reads .claude/agents and
// .codex/agents), never changing their files:
//   skills       folders with a SKILL.md (~/.claude/skills, ./.claude/skills,
//                ~/.codex/skills, ~/.hermes/skills)
//   subagents    markdown with front matter (~/.claude/agents, ./.claude/agents,
//                ~/.codex/agents, ./.codex/agents) → ox agents (~/.ox/agents)
//   MCP servers  ./.mcp.json and ~/.claude.json (user and this project),
//                ~/.codex/config.toml [mcp_servers.<name>], ~/.cursor/mcp.json
//                and ./.cursor/mcp.json, Hermes's config
//   instructions CLAUDE.md, AGENTS.md, .cursorrules, .cursor/rules/*.mdc
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** Skill folders (each with a SKILL.md) directly inside `dir`. */
export function skillFolders(dir, from) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), from }));
}

/** Front matter + body of a markdown file. */
export function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text));
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: m ? String(text).slice(m[0].length).trim() : String(text).trim() };
}

/** Subagents defined as markdown (Claude Code's and Codex's format). */
export function subagents(dir, from) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return []; }
  return names.map((n) => {
    const { meta, body } = frontMatter(fs.readFileSync(path.join(dir, n), 'utf8'));
    const tools = meta.tools ? meta.tools.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean) : null;
    return { name: (meta.name || n.replace(/\.md$/, '')).replace(/[^\w-]/g, '-'), description: meta.description ?? '', tools, model: meta.model ?? null, systemPrompt: body, path: path.join(dir, n), from };
  });
}

/** MCP servers from Codex's config.toml: [mcp_servers.<name>] with command, args, env. */
export function codexMcp(toml) {
  const out = {};
  let cur = null, sub = null;
  const val = (v) => {
    v = v.trim();
    if (v.startsWith('[')) { try { return JSON.parse(v.replace(/'/g, '"')); } catch { return v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean); } }
    if (/^["']/.test(v)) return v.slice(1, -1);
    if (v === 'true' || v === 'false') return v === 'true';
    return Number.isFinite(Number(v)) ? Number(v) : v;
  };
  for (const raw of String(toml).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const head = /^\[mcp_servers\.("?)([^".\]]+)\1(?:\.(\w+))?\]$/.exec(line);
    if (head) { cur = head[2]; sub = head[3] ?? null; out[cur] ??= {}; if (sub) out[cur][sub] ??= {}; continue; }
    if (line.startsWith('[')) { cur = null; continue; }
    const kv = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
    if (cur && kv) { if (sub) out[cur][sub][kv[1]] = val(kv[2]); else out[cur][kv[1]] = val(kv[2]); }
  }
  return out;
}

function readMemoryFiles(cwd, names) {
  return names.map((n) => path.join(cwd, n)).filter((f) => fs.existsSync(f)).map((f) => {
    try { return { name: path.basename(f), path: f, content: fs.readFileSync(f, 'utf8') }; }
    catch { return null; }
  }).filter(Boolean);
}

// Claude Code keeps auto-memory outside the repository, per project. Its
// project directory is the absolute cwd with path separators replaced by '-'
// (for example /Users/me/app -> -Users-me-app). Only the exact candidate is
// considered; we never scan unrelated Claude projects or read transcripts.
function claudeAutoMemory(cwd, home) {
  const project = path.resolve(cwd).replace(/[\\/]/g, '-');
  const dir = path.join(home, '.claude', 'projects', project, 'memory');
  const files = [];
  const visit = (folder, relative = '', depth = 2) => {
    if (depth < 0) return;
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(folder, entry.name);
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(abs, rel, depth - 1);
      else if (entry.isFile() && entry.name.endsWith('.md') && files.length < 100) {
        try {
          const stat = fs.statSync(abs);
          if (stat.size > 256 * 1024) continue;
          files.push({ name: `Claude Code auto-memory/${rel}`, path: abs, content: fs.readFileSync(abs, 'utf8'), autoMemory: true });
        } catch {}
      }
    }
  };
  visit(dir);
  return files;
}

export function importFromClaudeCode(cwd, home = os.homedir()) {
  const user = readJson(path.join(home, '.claude.json')) ?? {};
  return {
    skills: [...skillFolders(path.join(home, '.claude', 'skills'), 'Claude Code'), ...skillFolders(path.join(cwd, '.claude', 'skills'), 'Claude Code (project)')],
    agents: [...subagents(path.join(home, '.claude', 'agents'), 'Claude Code'), ...subagents(path.join(cwd, '.claude', 'agents'), 'Claude Code (project)')],
    mcpServers: { ...(user.mcpServers ?? {}), ...(user.projects?.[cwd]?.mcpServers ?? {}), ...(readJson(path.join(cwd, '.mcp.json'))?.mcpServers ?? {}) },
    memoryFiles: [...readMemoryFiles(cwd, ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']), ...claudeAutoMemory(cwd, home)],
  };
}

export function importFromCodex(cwd, home = os.homedir()) {
  let toml = '';
  try { toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'); } catch {}
  return {
    skills: skillFolders(path.join(home, '.codex', 'skills'), 'Codex'),
    agents: [...subagents(path.join(home, '.codex', 'agents'), 'Codex'), ...subagents(path.join(cwd, '.codex', 'agents'), 'Codex (project)')],
    mcpServers: codexMcp(toml),
    memoryFiles: readMemoryFiles(cwd, ['AGENTS.md']),
  };
}

export function importFromCursor(cwd, home = os.homedir()) {
  let rules = [];
  try { rules = fs.readdirSync(path.join(cwd, '.cursor', 'rules')).filter((n) => /\.mdc?$/.test(n)).map((n) => ({ name: `.cursor/rules/${n}`, path: path.join(cwd, '.cursor', 'rules', n) })); } catch {}
  return {
    skills: [],
    agents: [],
    mcpServers: { ...(readJson(path.join(home, '.cursor', 'mcp.json'))?.mcpServers ?? {}), ...(readJson(path.join(cwd, '.cursor', 'mcp.json'))?.mcpServers ?? {}) },
    memoryFiles: [...readMemoryFiles(cwd, ['.cursorrules']), ...rules],
  };
}

export function importFromHermes(cwd, home = os.homedir()) {
  const config = readJson(path.join(home, '.hermes', 'config.json')) ?? {};
  return { skills: skillFolders(path.join(home, '.hermes', 'skills'), 'Hermes'), agents: [], mcpServers: config.mcpServers || config.mcp || {}, memoryFiles: readMemoryFiles(cwd, ['AGENTS.md']) };
}

const SOURCES = { 'claude-code': importFromClaudeCode, claude: importFromClaudeCode, codex: importFromCodex, cursor: importFromCursor, hermes: importFromHermes };

export function importAll(cwd, source, home = os.homedir()) {
  const pick = source === 'all' ? [importFromClaudeCode, importFromCodex, importFromCursor, importFromHermes] : SOURCES[source] ? [SOURCES[source]] : [];
  const parts = pick.map((f) => f(cwd, home));
  const uniq = (list, key) => [...new Map(list.map((x) => [key(x), x])).values()];
  return {
    skills: uniq(parts.flatMap((p) => p.skills), (s) => s.name),
    agents: uniq(parts.flatMap((p) => p.agents), (a) => a.name),
    mcpServers: Object.assign({}, ...parts.map((p) => p.mcpServers)),
    memoryFiles: uniq(parts.flatMap((p) => p.memoryFiles), (m) => m.path),
  };
}
