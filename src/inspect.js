import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const INSPECT_SCHEMA_VERSION = '1.0.0';

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function inspectConfig() {
  let config = {};
  const paths = [path.join(os.homedir(), '.ox', 'config.json'), path.join('.ox', 'config.json')];
  for (const p of paths) {
    const loaded = readJson(p);
    if (loaded) config = { ...config, ...loaded };
  }
  return config;
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const knownKeys = new Set(['mcp', 'skills', 'plugins', 'hooks', 'instructions', 'schemaVersion', 'settings']);
  for (const key of ['schemaVersion']) {
    if (!(key in config)) errors.push(`Missing required field: ${key}`);
  }
  for (const key of Object.keys(config)) {
    if (!knownKeys.has(key)) warnings.push(`Unknown key: ${key}`);
  }
  if ('schemaVersion' in config && config.schemaVersion !== INSPECT_SCHEMA_VERSION) {
    warnings.push(`schemaVersion mismatch: expected ${INSPECT_SCHEMA_VERSION}, got ${config.schemaVersion}`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function inspectProject(cwd) {
  const root = cwd || process.cwd();
  const report = { config: {}, skills: [], plugins: [], hooks: [], mcp: [], instructions: {}, warnings: [] };

  const homeConfig = path.join(os.homedir(), '.ox', 'config.json');
  if (fs.existsSync(homeConfig)) {
    const loaded = readJson(homeConfig);
    if (loaded) report.config = loaded;
  }

  const oxDir = path.join(root, '.ox');
  if (dirExists(oxDir)) {
    try {
      for (const entry of fs.readdirSync(oxDir)) {
        const full = path.join(oxDir, entry);
        const stat = fs.statSync(full);
        if (stat.isFile() && entry === 'config.json') {
          const local = readJson(full);
          if (local) report.config = { ...report.config, ...local };
        }
      }
    } catch {
      report.warnings.push('Failed to scan .ox/');
    }
  }

  const skillsDir = path.join(root, '.agents', 'skills');
  if (dirExists(skillsDir)) {
    try {
      report.skills = fs.readdirSync(skillsDir).filter((e) => fs.statSync(path.join(skillsDir, e)).isDirectory());
    } catch { /* skip */ }
  }

  const mcpFile = path.join(root, '.mcp.json');
  if (fs.existsSync(mcpFile)) {
    const loaded = readJson(mcpFile);
    if (loaded) report.mcp = Array.isArray(loaded) ? loaded : [loaded];
  }

  for (const md of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const fp = path.join(root, md);
    if (fs.existsSync(fp)) {
      try {
        const key = md === '.cursorrules' ? 'cursorrules' : md.replace('.md', '');
        report.instructions[key] = fs.readFileSync(fp, 'utf8');
      } catch { /* skip */ }
    }
  }

  const grokDir = path.join(root, '.grok');
  if (dirExists(grokDir)) {
    try {
      for (const entry of fs.readdirSync(grokDir)) {
        const full = path.join(grokDir, entry);
        if (fs.statSync(full).isDirectory()) {
          report.hooks.push(entry);
        } else {
          report.plugins.push(entry);
        }
      }
    } catch { /* skip */ }
  }

  return report;
}

export function formatInspect(report) {
  const lines = [`inspect@${INSPECT_SCHEMA_VERSION}`, ''];
  const walk = (prefix, key, value) => {
    lines.push(`${prefix}${key}:`);
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(prefix + '  ', k, v);
    } else if (Array.isArray(value)) {
      for (const item of value) lines.push(`${prefix}  - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    } else {
      const str = String(value);
      lines.push(`${prefix}  ${str.length > 120 ? str.slice(0, 120) + '...' : str}`);
    }
  };
  for (const [key, value] of Object.entries(report)) walk('', key, value);
  return lines.join('\n');
}
