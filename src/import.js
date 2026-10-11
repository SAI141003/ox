import fs from 'fs';
import path from 'path';
import os from 'os';

function readSkillsDir(dirPath) {
  const skills = [];
  if (fs.existsSync(dirPath)) {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.json'))) {
        skills.push({ name: file.replace(/\.(js|ts|json)$/, ''), path: fullPath });
      }
    }
  }
  return skills;
}

function readMcpConfig(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }
  return {};
}

function readMemoryFiles(cwd, patterns) {
  const files = [];
  for (const pattern of patterns) {
    const fullPath = path.join(cwd, pattern);
    if (fs.existsSync(fullPath)) {
      files.push({ name: pattern, path: fullPath, content: fs.readFileSync(fullPath, 'utf8') });
    }
  }
  return files;
}

export function importFromClaudeCode(cwd) {
  const homeDir = os.homedir();
  const skills = [
    ...readSkillsDir(path.join(homeDir, '.claude', 'skills')),
    ...readSkillsDir(path.join(cwd, '.claude', 'skills'))
  ];
  const mcpServers = readMcpConfig(path.join(cwd, '.mcp.json'));
  const memoryFiles = readMemoryFiles(cwd, ['CLAUDE.md', 'AGENTS.md']);
  return { skills, mcpServers, memoryFiles };
}

export function importFromHermes(cwd) {
  const homeDir = os.homedir();
  const skills = readSkillsDir(path.join(homeDir, '.hermes', 'skills'));
  let mcpServers = {};
  const configPath = path.join(homeDir, '.hermes', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      mcpServers = config.mcpServers || config.mcp || {};
    } catch {
      mcpServers = {};
    }
  }
  const memoryFiles = readMemoryFiles(cwd, ['AGENTS.md']);
  return { skills, mcpServers, memoryFiles };
}

export function importFromCodex(cwd) {
  const homeDir = os.homedir();
  let mcpServers = {};
  const configPath = path.join(homeDir, '.codex', 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const mcpMatch = content.match(/mcpServers\s*=\s*(\{[\s\S]*?\})/);
      if (mcpMatch) {
        mcpServers = JSON.parse(mcpMatch[1].replace(/(\w+):/g, '"$1":'));
      }
    } catch {
      mcpServers = {};
    }
  }
  const memoryFiles = readMemoryFiles(cwd, ['AGENTS.md']);
  return { skills: [], mcpServers, memoryFiles };
}

export function importAll(cwd, source) {
  switch (source) {
    case 'claude':
    case 'claude-code':
      return importFromClaudeCode(cwd);
    case 'hermes':
      return importFromHermes(cwd);
    case 'codex':
      return importFromCodex(cwd);
    case 'all': {
      const claude = importFromClaudeCode(cwd);
      const hermes = importFromHermes(cwd);
      const codex = importFromCodex(cwd);
      return {
        skills: [...claude.skills, ...hermes.skills, ...codex.skills],
        mcpServers: { ...claude.mcpServers, ...hermes.mcpServers, ...codex.mcpServers },
        memoryFiles: [...claude.memoryFiles, ...hermes.memoryFiles, ...codex.memoryFiles]
      };
    }
    default:
      return { skills: [], mcpServers: {}, memoryFiles: [] };
  }
}
