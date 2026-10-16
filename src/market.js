// The skills & plugins marketplace: search what other people have published and
// install it into ox in one step.
//
// Two real sources, nothing invented:
//   * Plugin catalogues — repos with a .claude-plugin/marketplace.json (the
//     format Claude Code uses). Anthropic's official catalogue and its skills
//     repo by default; add your own with `ox market add owner/repo`.
//   * GitHub — public repos tagged `agent-skills`, ranked by stars.
//
// Installing goes through ox's existing installers (src/plugins.js,
// src/skill-add.js), which scan every file against the denylist and refuse on
// a finding. Results are cached for a while so search stays fast and inside
// GitHub's unauthenticated rate limit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CATALOGS = Object.freeze(['anthropics/claude-plugins-official', 'anthropics/skills']);
const RAW = () => process.env.OX_MARKET_RAW_BASE || 'https://raw.githubusercontent.com';
const API = () => process.env.OX_MARKET_API_BASE || 'https://api.github.com';
const CACHE = () => path.join(process.env.OX_MARKET_CACHE || path.join(os.homedir(), '.ox', 'cache', 'market'));
const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/; // no "..", no leading dot

async function cached(key, ttlMs, fetcher) {
  const file = path.join(CACHE(), `${key.replace(/[^\w.-]+/g, '_')}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const value = await fetcher();
  try { fs.mkdirSync(CACHE(), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); } catch {}
  return value;
}

async function getJson(url, timeoutMs = 10_000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ox-market', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

export async function catalogList() {
  const { readConfigDoc } = await import('./config.js');
  const extra = (readConfigDoc().marketplaces ?? []).filter((r) => REPO_RE.test(r));
  return [...new Set([...DEFAULT_CATALOGS, ...extra])];
}

export async function addCatalog(repo) {
  if (!REPO_RE.test(String(repo))) throw new Error('a catalogue is a GitHub repo: owner/repo');
  await fetchCatalog(repo); // it must actually be one
  const { saveConfigDoc } = await import('./config.js');
  saveConfigDoc((doc) => { doc.marketplaces = [...new Set([...(doc.marketplaces ?? []), repo])]; });
  return catalogList();
}

export async function fetchCatalog(repo) {
  return cached(`catalog-${repo}`, 6 * 3600_000, async () => {
    let doc = null;
    for (const branch of ['main', 'master']) {
      try { doc = await getJson(`${RAW()}/${repo}/${branch}/.claude-plugin/marketplace.json`); break; } catch {}
    }
    if (!doc) throw new Error(`${repo} has no .claude-plugin/marketplace.json`);
    return (doc.plugins ?? []).filter((p) => p?.name).map((p) => ({
      name: String(p.name), description: String(p.description ?? '').slice(0, 400), category: p.category ?? null,
      author: p.author?.name ?? doc.owner?.name ?? null, homepage: p.homepage ?? null,
      skills: Array.isArray(p.skills) ? p.skills.map((s) => path.basename(String(s))) : null,
      catalog: repo,
    }));
  });
}

export async function searchGithub(query = '') {
  const q = `${String(query).trim()} topic:agent-skills`.trim();
  return cached(`gh-${q}`, 15 * 60_000, async () => {
    const d = await getJson(`${API()}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`);
    return (d.items ?? []).map((r) => ({
      repo: r.full_name, description: String(r.description ?? '').slice(0, 300), stars: r.stargazers_count,
      updated: r.pushed_at, license: r.license?.spdx_id ?? null, url: r.html_url,
    }));
  });
}

function installedNames() {
  const names = new Set();
  try { for (const n of Object.keys(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ox', 'plugins.json'), 'utf8')).plugins ?? {})) names.add(n); } catch {}
  for (const dir of [path.join(os.homedir(), '.ox', 'skills'), path.join(os.homedir(), '.agents', 'skills')]) {
    try { for (const n of fs.readdirSync(dir)) names.add(n); } catch {}
  }
  return names;
}

export async function search(query = '', { sources = ['catalogs', 'github'] } = {}) {
  const q = String(query).trim().toLowerCase();
  const have = installedNames();
  const out = { plugins: [], repos: [], errors: [], catalogs: await catalogList() };
  if (sources.includes('catalogs')) {
    for (const repo of out.catalogs) {
      try {
        const list = await fetchCatalog(repo);
        out.plugins.push(...list.filter((p) => !q || `${p.name} ${p.description} ${p.category ?? ''} ${(p.skills ?? []).join(' ')}`.toLowerCase().includes(q)).map((p) => ({ ...p, installed: have.has(p.name) })));
      } catch (e) { out.errors.push(`${repo}: ${e.message}`); }
    }
  }
  if (sources.includes('github')) {
    try { out.repos = (await searchGithub(q)).map((r) => ({ ...r, installed: have.has(r.repo.split('/')[1]) })); } catch (e) { out.errors.push(`GitHub: ${e.message}`); }
  }
  return out;
}

// Install a catalogue plugin (name + catalog) or a GitHub repo (repo): a repo
// with SKILL.md at its root is one skill, anything else is tried as a plugin.
export async function install({ name, catalog, repo, force = false } = {}) {
  const { addPlugin } = await import('./plugins.js');
  if (catalog) {
    if (!REPO_RE.test(catalog) || !/^[\w.-]+$/.test(String(name))) throw new Error('bad plugin name or catalogue');
    const r = await addPlugin(`${name}@${catalog}`, { force });
    return { ok: r.ok, message: r.message, findings: (r.findings ?? []).length };
  }
  if (!REPO_RE.test(String(repo))) throw new Error('a repo is owner/repo');
  const { installSkill } = await import('./skill-add.js');
  const skill = await installSkill(repo, { force }).catch((e) => ({ ok: false, message: e.message }));
  if (skill?.ok) return { ok: true, message: skill.message ?? `installed the skill from ${repo}` };
  const r = await addPlugin(repo, { force }).catch((e) => ({ ok: false, message: e.message }));
  return { ok: !!r.ok, message: r.ok ? r.message : `${repo} is not an installable skill or plugin: ${r.message}${skill?.message ? ` (as a skill: ${skill.message})` : ''}`, findings: (r.findings ?? []).length };
}
