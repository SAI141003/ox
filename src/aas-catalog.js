import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const AAS_CATALOG_SOURCES = [
  { id: 'npm', name: 'npm package', type: 'primary' },
  { id: 'github', name: 'GitHub mirror', type: 'retrieval' },
  { id: 'local', name: 'Local skills dir', type: 'local' }
];

export const AAS_HOSTS = {
  codex: '~/.agents/skills',
  cursor: '~/.cursor/skills',
  gemini: '~/.gemini/skills',
  claude: '~/.claude/skills',
  antigravity: '~/.gemini/antigravity-cli/skills',
  kiro: '~/.kiro/skills',
  opencode: '~/.agents/skills',
  autohand: '~/.autohand/skills',
  copilot: '~/.copilot/skills',
  adal: '~/.adal/skills'
};

export const AAS_RISK_LEVELS = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export function parseSkillMd(content) {
  const parts = content.split('---');
  if (parts.length < 3) {
    return { name: '', description: '', triggers: [], inputs: '', outputs: '', body: content, metadata: {} };
  }
  const frontmatter = parts[1];
  const body = parts.slice(2).join('---');
  const metadata = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  return {
    name: metadata.name || '',
    description: metadata.description || '',
    triggers: metadata.triggers ? metadata.triggers.split(',').map(t => t.trim()) : [],
    inputs: metadata.inputs || '',
    outputs: metadata.outputs || '',
    body: body.trim(),
    metadata
  };
}

export function scanSkillsDir(dir) {
  try {
    const skills = [];
    function walk(currentDir) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name === 'SKILL.md') {
          const content = fs.readFileSync(fullPath, 'utf8');
          const parsed = parseSkillMd(content);
          const id = path.basename(path.dirname(fullPath));
          skills.push({ id, name: parsed.name || id, path: fullPath, source: 'local', ...parsed });
        }
      }
    }
    walk(dir);
    return skills;
  } catch {
    return [];
  }
}

export function fetchCatalogFromNpm(packageName, version) {
  try {
    const output = execSync(`npm view ${packageName}@${version} skills_index.json --json`, { encoding: 'utf8' });
    const data = JSON.parse(output);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function fetchCatalogFromGithub(owner, repo, branch) {
  try {
    const output = execSync(`curl -fsSL https://raw.githubusercontent.com/${owner}/${repo}/${branch}/skills_index.json`, { encoding: 'utf8' });
    const data = JSON.parse(output);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function inferCategory(name) {
  const lower = name.toLowerCase();
  if (lower.includes('test') || lower.includes('qa')) return 'testing';
  if (lower.includes('sec') || lower.includes('audit')) return 'security';
  if (lower.includes('devops') || lower.includes('deploy') || lower.includes('infra')) return 'devops';
  if (lower.includes('doc') || lower.includes('write')) return 'documentation';
  if (lower.includes('data') || lower.includes('analytics')) return 'data';
  if (lower.includes('frontend') || lower.includes('web') || lower.includes('react')) return 'frontend';
  if (lower.includes('backend') || lower.includes('api')) return 'backend';
  if (lower.includes('agent') || lower.includes('mcp')) return 'agents';
  if (lower.includes('ml') || lower.includes('ai') || lower.includes('model')) return 'ml-ai';
  return 'general';
}

export function mergeCatalogs(oxCatalog, aasSkills) {
  const seen = new Set(oxCatalog.map(s => s.id));
  const merged = [...oxCatalog];
  for (const skill of aasSkills) {
    const id = 'aas-' + (skill.name || skill.id || 'unknown').toLowerCase().replace(/\s+/g, '-');
    if (seen.has(id)) continue;
    seen.add(id);
    const category = inferCategory(skill.name || '');
    merged.push({
      id,
      category,
      name: skill.name || '',
      description: skill.description || '',
      inputs: skill.inputs || '',
      outputs: skill.outputs || '',
      primary: {
        name: 'AAS Skill: ' + (skill.name || ''),
        license: 'MIT',
        repo: 'https://github.com/sickn33/agentic-awesome-skills',
        install: 'npx agentic-awesome-skills --skills ' + (skill.name || ''),
        run: '@' + (skill.name || ''),
        hardware: 'CPU/2GB'
      },
      fallback: null,
      examplePrompts: skill.triggers || [],
      source: 'aas'
    });
  }
  return merged;
}

export function filterByRisk(skills, maxRisk) {
  const maxLevel = AAS_RISK_LEVELS[maxRisk] ?? 0;
  return skills.filter(s => (AAS_RISK_LEVELS[s.risk] ?? 0) <= maxLevel);
}

export function filterByCategory(skills, categories) {
  const set = new Set(categories.map(c => c.toLowerCase()));
  return skills.filter(s => set.has((s.category || '').toLowerCase()));
}

export function searchAasSkills(skills, query) {
  const q = query.toLowerCase();
  return skills.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q) ||
    (s.examplePrompts || []).some(t => t.toLowerCase().includes(q))
  );
}

export function listHosts() {
  return Object.entries(AAS_HOSTS).map(([host, path]) => ({ host, path }));
}

export function getInstallCommand(host, skillNames, flags = {}) {
  const names = Array.isArray(skillNames) ? skillNames.join(' ') : skillNames;
  const parts = ['npx agentic-awesome-skills', `--${host}`, '--skills', names];
  if (flags.category) parts.push('--category', flags.category);
  if (flags.risk) parts.push('--risk', flags.risk);
  if (flags.dryRun) parts.push('--dry-run');
  if (flags.release) parts.push('--release', flags.release);
  if (flags.path) parts.push('--path', flags.path);
  return parts.join(' ');
}

export async function loadAasCatalog(oxCatalog) {
  const source = process.env.OX_AAS_CATALOG_SOURCE || 'npm';
  const pkg = process.env.OX_AAS_PACKAGE || 'agentic-awesome-skills';
  const owner = process.env.OX_AAS_GITHUB_OWNER || 'sickn33';
  const repo = process.env.OX_AAS_GITHUB_REPO || 'agentic-awesome-skills';
  const localDir = process.env.OX_AAS_LOCAL_DIR;
  const version = process.env.OX_AAS_VERSION || 'latest';
  const branch = process.env.OX_AAS_BRANCH || 'main';

  let aasSkills = [];
  if (source === 'npm') {
    aasSkills = fetchCatalogFromNpm(pkg, version);
  } else if (source === 'github') {
    aasSkills = fetchCatalogFromGithub(owner, repo, branch);
  } else if (source === 'local' && localDir) {
    aasSkills = scanSkillsDir(localDir);
  }
  return mergeCatalogs(oxCatalog, aasSkills);
}
