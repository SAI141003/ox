import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
function expandP(p) {
  return p.replace(/^~\//, home + path.sep);
}

export const AAS_HOSTS = {
  codex: { path: '~/.agents/skills', skillsDir: '.agents/skills', name: 'Codex CLI', installCmd: 'npx agentic-awesome-skills --codex' },
  cursor: { path: '~/.cursor/skills', skillsDir: '.cursor/skills', name: 'Cursor', installCmd: 'npx agentic-awesome-skills --cursor' },
  gemini: { path: '~/.gemini/skills', skillsDir: '.gemini/skills', name: 'Gemini CLI', installCmd: 'npx agentic-awesome-skills --gemini' },
  claude: { path: '~/.claude/skills', skillsDir: '.claude/skills', name: 'Claude Code', installCmd: 'npx agentic-awesome-skills --claude' },
  antigravity: { path: '~/.gemini/antigravity-cli/skills', skillsDir: '.gemini/antigravity-cli/skills', name: 'Antigravity', installCmd: 'npx agentic-awesome-skills --antigravity' },
  kiro: { path: '~/.kiro/skills', skillsDir: '.kiro/skills', name: 'Kiro', installCmd: 'npx agentic-awesome-skills --kiro' },
  opencode: { path: '~/.agents/skills', skillsDir: '.agents/skills', name: 'OpenCode', installCmd: 'npx agentic-awesome-skills --opencode' },
  autohand: { path: '~/.autohand/skills', skillsDir: '.autohand/skills', name: 'Autohand Code', installCmd: 'npx agentic-awesome-skills --autohand' },
  copilot: { path: '~/.copilot/skills', skillsDir: '.copilot/skills', name: 'GitHub Copilot', installCmd: 'gh skill install' },
  adal: { path: '~/.adal/skills', skillsDir: '.adal/skills', name: 'AdaL CLI', installCmd: 'npx agentic-awesome-skills --adal' },
};

export const AAS_RISK_LEVELS = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const RISK_SUMMARY = {
  safe: 'No discernible risk; read-only or informational.',
  low: 'Minor risk; minimal blast radius.',
  medium: 'Moderate risk; may alter project files or state.',
  high: 'High risk; can affect system integrity or credentials.',
  critical: 'Critical risk; destructive, privileged, or irreversible operations.',
};

const DEFAULT_HOST = process.env.OX_AAS_DEFAULT_HOST || 'codex';
const DEFAULT_DRY_RUN = process.env.OX_AAS_DRY_RUN === '1' || process.env.OX_AAS_DRY_RUN === 'true';

// Every part goes into a shell command line: a skill name from a catalogue
// like "x; rm -rf ~" would run. Plain names, versions and paths only (ox secure).
const SAFE_PART = /^[\w.,@/:~+=-]+$/;
function plain(label, v) {
  const s = String(v);
  if (!SAFE_PART.test(s)) throw new Error(`refused: the ${label} "${s.slice(0, 60)}" has characters a shell would run`);
  return s;
}

export function buildInstallCommand({ host, skills, category, risk, dryRun, release, path: p } = {}) {
  const cfg = getHost(host);
  for (const [label, v] of [['skills', Array.isArray(skills) ? skills.join(',') : skills], ['category', Array.isArray(category) ? category.join(',') : category], ['risk', risk], ['release', release], ['path', p]]) {
    if (v != null && v !== '') plain(label, v);
  }
  const parts = [cfg.installCmd];
  if (skills) {
    const ids = Array.isArray(skills) ? skills.join(',') : String(skills);
    parts.push(`--skills ${ids}`);
  }
  if (category) {
    const cats = Array.isArray(category) ? category.join(',') : String(category);
    parts.push(`--category ${cats}`);
  }
  if (risk) parts.push(`--risk ${risk}`);
  if (dryRun) parts.push('--dry-run');
  if (release) parts.push(`--release ${release}`);
  if (p) parts.push(`--path ${p}`);
  return parts.join(' ');
}

export function previewInstall({ host, skills, category, risk, dryRun } = {}) {
  const command = buildInstallCommand({ host, skills, category, risk, dryRun });
  let warning = '';
  if (host === 'antigravity' && !skills) {
    warning = 'Warning: Antigravity installs all skill contexts into Gemini CLI; without --skills this may exhaust context limits.';
  }
  return { command, host, skills: skills || [], dryRun: dryRun || DEFAULT_DRY_RUN, warning };
}

export function executeInstall({ host = DEFAULT_HOST, skills, category, risk, dryRun = DEFAULT_DRY_RUN, release, path: p, force = false } = {}) {
  const command = buildInstallCommand({ host, skills, category, risk, dryRun: dryRun || DEFAULT_DRY_RUN, release, path: p });
  if (!force && !dryRun) {
    const resolved = resolveRisk(Array.isArray(skills) ? skills : (skills ? [skills] : []), {});
    if (resolved.level === AAS_RISK_LEVELS.critical) {
      throw new Error(`Critical-risk install aborted without --force. Command: ${command}`);
    }
  }
  try {
    // ox-secure-ignore: every part was checked by buildInstallCommand above.
    const stdout = execSync(command, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, stdout, command };
  } catch (err) {
    return { ok: false, stdout: (err.stdout ? err.stdout.toString() : '') || err.message, stderr: (err.stderr ? err.stderr.toString() : ''), command, code: err.status };
  }
}

export function listHosts() {
  return Object.entries(AAS_HOSTS).map(([host, cfg]) => ({
    host,
    name: cfg.name,
    path: cfg.path,
    skillsDir: cfg.skillsDir,
    installCmd: cfg.installCmd,
  }));
}

export function getHost(name) {
  const cfg = AAS_HOSTS[name];
  if (!cfg) throw new Error(`Unknown AAS host: ${name}. Available: ${Object.keys(AAS_HOSTS).join(', ')}`);
  return cfg;
}

const SIGNAL_PATTERNS = {
  command: ['exec', 'spawn', 'child_process', 'subprocess', 'runCommand', 'shell'],
  network: ['fetch', 'axios', 'http', 'https', 'request(', 'got(', 'node-fetch', 'curl'],
  credential: ['password', 'secret', 'token', 'apiKey', 'env[', 'process.env', 'credential', 'access_key'],
  filesystem: ['fs.', 'readfile', 'writefile', 'unlink', 'rmdir', 'truncate', 'chmod', 'mkdir'],
  privileged: ['sudo', 'root', 'setuid', 'setgid', 'privilege'],
  destructive: ['rm ', 'delete', 'rmdir', 'truncate', 'drop', 'destroy', 'kill -9', 'format'],
  symlink: ['symlink', 'readlink', 'lstat'],
  binary: ['execSync', 'execFile', 'spawn(', '.exe', '.sh', 'shebang'],
};

export function auditSkills(skillDirs) {
  const dirs = Array.isArray(skillDirs) ? skillDirs : [skillDirs];
  const skills = [];
  const signals = { command: [], network: [], credential: [], filesystem: [], privileged: [], destructive: [], symlink: [], binary: [] };
  for (const dir of dirs) {
    const real = expandP(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = path.join(real, entry.name);
        const mdPath = path.join(skillPath, 'SKILL.md');
        let content = '';
        try {
          content = fs.readFileSync(mdPath, 'utf8');
        } catch (e) {
          content = '';
        }
        const skill = { id: entry.name, path: skillPath, hasDoc: fs.existsSync(mdPath), signals: {} };
        for (const [sig, keywords] of Object.entries(SIGNAL_PATTERNS)) {
          const hits = keywords.filter(k => content.toLowerCase().includes(k.toLowerCase()));
          skill.signals[sig] = hits;
          if (hits.length) signals[sig].push({ skill: entry.name, hits });
        }
        skills.push(skill);
      }
    }
  }
  return { skills, signals };
}

export function formatAuditReport(report) {
  const lines = ['# AAS Skill Audit Report', ''];
  lines.push(`Total skills scanned: ${report.skills.length}`);
  const risky = report.skills.filter(s => Object.values(s.signals).some(h => h.length > 0));
  lines.push(`Skills with signals: ${risky.length}`, '');
  for (const sig of Object.keys(report.signals)) {
    const hits = report.signals[sig];
    lines.push(`## ${sig} (${hits.length} occurrence(s))`);
    for (const h of hits) {
      lines.push(`  - ${h.skill}: ${h.hits.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatHostList() {
  const rows = listHosts();
  const nameW = Math.max(...rows.map(r => r.name.length), 'Host'.length);
  const hostW = Math.max(...rows.map(r => r.host.length), 'Host'.length);
  const lines = [`${'Host'.padEnd(hostW)}  ${'Name'.padEnd(nameW)}  Install Command`, ''];
  for (const r of rows) {
    lines.push(`${r.host.padEnd(hostW)}  ${r.name.padEnd(nameW)}  ${r.installCmd}`);
  }
  return lines.join('\n');
}

export function resolveRisk(skillNames, catalog = {}) {
  const byName = catalog.skills || catalog || {};
  const resolved = [];
  let max = AAS_RISK_LEVELS.safe;
  for (const name of skillNames) {
    const meta = typeof byName === 'object' ? (byName[name] || byName[name.toLowerCase()] || {}) : {};
    const level = AAS_RISK_LEVELS[meta.risk] || AAS_RISK_LEVELS[meta.riskLevel] || AAS_RISK_LEVELS.low;
    if (level > max) max = level;
    resolved.push({ name, level });
  }
  return { level: max, skills: resolved };
}

export default { AAS_HOSTS, AAS_RISK_LEVELS, RISK_SUMMARY, buildInstallCommand, previewInstall, executeInstall, listHosts, getHost, auditSkills, formatAuditReport, formatHostList, resolveRisk };
