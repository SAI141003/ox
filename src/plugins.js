// Claude Code plugin compatibility.
//
// The plugin ecosystem (the Claude plugin directory, GitHub marketplaces,
// superpowers, vendor plugins) ships one bundle format: a folder with
// .claude-plugin/plugin.json plus any of skills/<name>/SKILL.md,
// commands/*.md, agents/*.md, .mcp.json and hooks/. ox reads that format
// directly, so every such plugin works here without a port:
//
//   skills    -> discovered as `<plugin>:<skill>` (namespaced: a plugin can
//                never shadow your own skill of the same name)
//   commands  -> REPL slash commands `/<plugin>:<command>` (prompt templates)
//   mcp       -> MCP servers `<plugin>-<server>`, ${CLAUDE_PLUGIN_ROOT} expanded
//   hooks     -> reported, NEVER executed: a plugin's hooks are arbitrary
//                shell on every tool call, and ox does not grant that silently
//
// Safety: every install passes the same denylist scan as `ox skill add`
// (skills, commands, agents); findings refuse the install unless --force.
// Linked plugins (`ox plugin import-claude`) are read in place and never
// written to.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const pluginsRoot = (home = os.homedir()) => path.join(home, '.ox', 'plugins');
export const registryPath = (home = os.homedir()) => path.join(home, '.ox', 'plugins.json');

export function readRegistry(home = os.homedir()) {
  try {
    const doc = JSON.parse(fs.readFileSync(registryPath(home), 'utf8'));
    return doc && typeof doc.plugins === 'object' ? doc : { plugins: {} };
  } catch {
    return { plugins: {} };
  }
}

function writeRegistry(home, doc) {
  fs.mkdirSync(path.dirname(registryPath(home)), { recursive: true });
  const tmp = `${registryPath(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, registryPath(home));
}

/** Enabled plugins whose folder still exists. OX_NO_PLUGINS=1 turns them all off. */
export function enabledPlugins(home = os.homedir()) {
  if (process.env.OX_NO_PLUGINS === '1') return [];
  return Object.entries(readRegistry(home).plugins)
    .filter(([, p]) => p && p.enabled !== false && p.path && fs.existsSync(p.path))
    .map(([name, p]) => ({ name, ...p }));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/** Parse a plugin folder into what ox can use. Returns null if it is not one. */
export function readPlugin(dir) {
  const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  const hasSkills = fs.existsSync(path.join(dir, 'skills'));
  if (!manifest && !hasSkills) return null;
  const name = String(manifest?.name ?? path.basename(dir));
  const skillsDir = path.join(dir, 'skills');
  const skills = [];
  try {
    for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (ent.isDirectory() && fs.existsSync(path.join(skillsDir, ent.name, 'SKILL.md'))) skills.push(ent.name);
    }
  } catch { /* no skills */ }
  const mcpDoc = readJson(path.join(dir, '.mcp.json'));
  const inlineMcp = manifest && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : null;
  // .mcp.json comes wrapped ({ mcpServers: {...} }) or flat ({ name: {...} }).
  const fileServers = mcpDoc?.mcpServers
    ?? Object.fromEntries(Object.entries(mcpDoc ?? {}).filter(([, v]) => v && typeof v === 'object' && (v.command || v.url)));
  const mcpServers = { ...fileServers, ...(inlineMcp ?? {}) };
  return {
    name,
    version: manifest?.version ?? null,
    description: manifest?.description ?? '',
    dir,
    skillsDir: skills.length ? skillsDir : null,
    skills,
    commands: listMd(path.join(dir, 'commands')).map((f) => f.replace(/\.md$/, '')),
    agents: listMd(path.join(dir, 'agents')).map((f) => f.replace(/\.md$/, '')),
    mcpServers,
    hasHooks: fs.existsSync(path.join(dir, 'hooks')) || Boolean(manifest?.hooks),
  };
}

/** Denylist scan of everything that becomes model-visible text. */
export async function scanPlugin(plugin) {
  // Lazy: skill-add imports config, which imports this module.
  const { scanSkillSource, scanText } = await import('./skill-add.js');
  let findings = [];
  for (const s of plugin.skills) {
    const r = scanSkillSource(path.join(plugin.skillsDir, s));
    findings = findings.concat(r.findings.map((f) => ({ ...f, file: `skills/${s}/${f.file ?? ''}` })));
  }
  for (const [sub, names] of [['commands', plugin.commands], ['agents', plugin.agents]]) {
    for (const n of names) {
      const rel = `${sub}/${n}.md`;
      let text = '';
      try {
        text = fs.readFileSync(path.join(plugin.dir, rel), 'utf8');
      } catch {
        continue;
      }
      findings = findings.concat(scanText(rel, text));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Sources: local folder, GitHub owner/repo[/subdir], or a marketplace entry
// `plugin@owner/repo` (a repo whose .claude-plugin/marketplace.json lists it).
// ---------------------------------------------------------------------------

function gitClone(url, dest, { sha = null } = {}) {
  const r = spawnSync('git', ['clone', ...(sha ? [] : ['--depth', '1']), '--quiet', url, dest], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  if (r.status !== 0) throw new Error(`git clone ${url} failed: ${String(r.stderr || r.error || '').trim().slice(0, 300)}`);
  // A catalogue that pins a commit gets exactly that commit, not whatever the
  // branch says today: what was reviewed is what is installed.
  if (sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`not a commit id: ${sha}`);
    const co = spawnSync('git', ['-C', dest, 'checkout', '--quiet', '--detach', sha], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    if (co.status !== 0) throw new Error(`the pinned commit ${sha} is not in ${url}`);
  }
}

function resolveMarketplaceEntry(repoDir, pluginName) {
  const mk = readJson(path.join(repoDir, '.claude-plugin', 'marketplace.json'));
  const entry = (mk?.plugins ?? []).find((p) => p?.name === pluginName);
  if (!entry) {
    const names = (mk?.plugins ?? []).map((p) => p?.name).filter(Boolean);
    throw new Error(`plugin '${pluginName}' is not in this marketplace${names.length ? ` (has: ${names.slice(0, 20).join(', ')})` : ''}`);
  }
  const src = entry.source;
  if (typeof src === 'string') return { local: path.resolve(repoDir, src) };
  if (src?.source === 'github' && src.repo) return { github: src.repo, subdir: src.path ?? '', sha: src.sha ?? null };
  if (src?.url) return { url: src.url, subdir: src.path ?? '', sha: src.sha ?? null };
  throw new Error(`unsupported marketplace source for '${pluginName}'`);
}

/** Fetch a source into a fresh staging folder; returns the plugin root inside it. */
export function stageSource(source, { tmpRoot = os.tmpdir() } = {}) {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'ox-plugin-'));
  const at = String(source).match(/^([^@\s]+)@([\w.-]+\/[\w.-]+)$/);
  if (at) {
    gitClone(`https://github.com/${at[2]}.git`, path.join(stage, 'repo'));
    const hit = resolveMarketplaceEntry(path.join(stage, 'repo'), at[1]);
    if (hit.local) return { stage, root: hit.local };
    const url = hit.github ? `https://github.com/${hit.github}.git` : hit.url;
    gitClone(url, path.join(stage, 'plugin'), { sha: hit.sha });
    return { stage, root: path.join(stage, 'plugin', hit.subdir) };
  }
  if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    return { stage, root: path.resolve(source), local: true };
  }
  const gh = String(source).match(/^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(.+))?$/);
  if (gh) {
    gitClone(`https://github.com/${gh[1]}.git`, path.join(stage, 'repo'));
    return { stage, root: path.join(stage, 'repo', gh[2] ?? '') };
  }
  throw new Error(`cannot resolve plugin source '${source}' (use a folder, owner/repo, or plugin@owner/repo)`);
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, filter: (p) => !p.split(path.sep).includes('.git') });
}

/**
 * Install (copy) a plugin. Returns { ok, plugin?, findings?, message }.
 * Refuses on denylist findings unless force.
 */
export async function addPlugin(source, { home = os.homedir(), force = false, stager = stageSource } = {}) {
  const { stage, root } = stager(source);
  try {
    const plugin = readPlugin(root);
    if (!plugin) return { ok: false, kind: 'not-a-plugin', message: `${source} has no .claude-plugin/plugin.json or skills/ folder` };
    if (!NAME_OK.test(plugin.name)) return { ok: false, kind: 'bad-name', message: `unsafe plugin name '${plugin.name}'` };
    const findings = await scanPlugin(plugin);
    if (findings.length && !force) return { ok: false, kind: 'unsafe', plugin, findings, message: `refused: ${findings.length} safety finding(s)` };
    const dest = path.join(pluginsRoot(home), plugin.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyDir(root, dest);
    const doc = readRegistry(home);
    doc.plugins[plugin.name] = {
      source: String(source),
      path: dest,
      kind: 'copy',
      version: plugin.version,
      enabled: true,
      mcp: true,
      installedAt: new Date().toISOString(),
    };
    writeRegistry(home, doc);
    return { ok: true, plugin: readPlugin(dest), findings, message: `installed ${plugin.name}` };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Link the Claude Code plugins already installed on this machine (read in place). */
export async function importClaudePlugins({ home = os.homedir(), force = false } = {}) {
  const doc = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const out = { linked: [], warned: [], missing: [] };
  const reg = readRegistry(home);
  for (const [id, installs] of Object.entries(doc?.plugins ?? {})) {
    const inst = Array.isArray(installs) ? installs[0] : installs;
    const dir = inst?.installPath;
    if (!dir || !fs.existsSync(dir)) {
      out.missing.push(id);
      continue;
    }
    const plugin = readPlugin(dir);
    if (!plugin || !NAME_OK.test(plugin.name)) continue;
    // These are plugins the user already chose to install in Claude Code, so
    // findings are surfaced as warnings, not a block (`ox plugin add` from the
    // network stays strict).
    const findings = await scanPlugin(plugin);
    if (findings.length) out.warned.push({ id, name: plugin.name, findings });
    // MCP stays off for bulk-linked plugins: starting every server they bring
    // on each run costs startup time and needs their credentials. Opt in per
    // plugin with `ox plugin mcp <name> on`.
    const prev = reg.plugins[plugin.name];
    reg.plugins[plugin.name] = {
      source: `claude:${id}`, path: dir, kind: 'link', version: plugin.version,
      enabled: prev?.enabled ?? true, mcp: prev?.mcp ?? false, installedAt: new Date().toISOString(),
    };
    out.linked.push(plugin);
  }
  writeRegistry(home, reg);
  return out;
}

export function removePlugin(name, { home = os.homedir() } = {}) {
  const doc = readRegistry(home);
  const rec = doc.plugins[name];
  if (!rec) return { ok: false, message: `no plugin named '${name}'` };
  // Only ever delete what ox copied; a linked plugin belongs to its owner.
  if (rec.kind === 'copy' && rec.path?.startsWith(pluginsRoot(home) + path.sep)) {
    fs.rmSync(rec.path, { recursive: true, force: true });
  }
  delete doc.plugins[name];
  writeRegistry(home, doc);
  return { ok: true, message: `removed ${name}${rec.kind === 'link' ? ' (unlinked; files left in place)' : ''}` };
}

export function setPluginMcp(name, on, { home = os.homedir() } = {}) {
  const doc = readRegistry(home);
  if (!doc.plugins[name]) return { ok: false, message: `no plugin named '${name}'` };
  doc.plugins[name].mcp = Boolean(on);
  writeRegistry(home, doc);
  return { ok: true, message: `${name}: MCP servers ${on ? 'on' : 'off'}` };
}

export function setPluginEnabled(name, enabled, { home = os.homedir() } = {}) {
  const doc = readRegistry(home);
  if (!doc.plugins[name]) return { ok: false, message: `no plugin named '${name}'` };
  doc.plugins[name].enabled = Boolean(enabled);
  writeRegistry(home, doc);
  return { ok: true, message: `${enabled ? 'enabled' : 'disabled'} ${name}` };
}

// ---------------------------------------------------------------------------
// Runtime integration
// ---------------------------------------------------------------------------

/** [{ plugin, dir }] skill roots for discovery (read-only use). */
export function pluginSkillRoots(home = os.homedir()) {
  const out = [];
  for (const p of enabledPlugins(home)) {
    const dir = path.join(p.path, 'skills');
    if (fs.existsSync(dir)) out.push({ plugin: p.name, dir });
  }
  return out;
}

function expandRoot(value, root) {
  if (typeof value === 'string') return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
  if (Array.isArray(value)) return value.map((v) => expandRoot(v, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandRoot(v, root)]));
  return value;
}

/** MCP servers contributed by enabled plugins, named `<plugin>-<server>`. */
export function pluginMcpServers(home = os.homedir()) {
  const out = {};
  for (const p of enabledPlugins(home)) {
    if (p.mcp === false) continue;
    const plugin = readPlugin(p.path);
    for (const [name, cfg] of Object.entries(plugin?.mcpServers ?? {})) {
      out[`${p.name}-${name}`] = expandRoot(cfg, p.path);
    }
  }
  return out;
}

/**
 * Custom slash commands: Claude Code's commands/*.md prompt templates from
 * ~/.claude/commands, ./.claude/commands and enabled plugins (as
 * `plugin:command`). Returns Map(name -> { file, source }).
 */
export function listCustomCommands({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const map = new Map();
  const add = (dir, prefix, source) => {
    for (const f of listMd(dir)) map.set(`${prefix}${f.replace(/\.md$/, '')}`, { file: path.join(dir, f), source });
  };
  add(path.join(home, '.claude', 'commands'), '', 'user');
  add(path.join(cwd, '.claude', 'commands'), '', 'project');
  for (const p of enabledPlugins(home)) add(path.join(p.path, 'commands'), `${p.name}:`, `plugin ${p.name}`);
  return map;
}

/** Expand a command template: strips frontmatter, fills $ARGUMENTS / $1..$9. */
export function expandCommand(file, args = '') {
  let text = fs.readFileSync(file, 'utf8');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) text = text.slice(text.indexOf('\n', end + 4) + 1);
  }
  const parts = String(args).trim().split(/\s+/).filter(Boolean);
  text = text.replaceAll('$ARGUMENTS', String(args).trim());
  text = text.replace(/\$([1-9])/g, (_, d) => parts[Number(d) - 1] ?? '');
  if (!/\$ARGUMENTS/.test(fs.readFileSync(file, 'utf8')) && String(args).trim()) text += `\n\n${String(args).trim()}`;
  return text.trim();
}
