import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AGENTS_DIR = path.join(os.homedir(), '.ox', 'agents');

export function ensureAgentsDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

export function agentFile(name) {
  return path.join(AGENTS_DIR, `${name}.json`);
}

export function listAgents() {
  ensureAgentsDir();
  try {
    return fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

export function loadAgent(name) {
  const file = agentFile(name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveAgent(name, agent) {
  ensureAgentsDir();
  const file = agentFile(name);
  const data = {
    name,
    provider: agent.provider,
    model: agent.model,
    baseUrl: agent.baseUrl ?? null,
    mcpServers: agent.mcpServers ?? {},
    skills: agent.skills ?? [],
    systemPrompt: agent.systemPrompt ?? '',
    createdAt: agent.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return data;
}

export function deleteAgent(name) {
  const file = agentFile(name);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgent(name, config) {
  const agent = loadAgent(name);
  if (!agent) return null;
  // Merge with config for MCP servers, skills, etc.
  return {
    ...agent,
    mcpServers: { ...(config.mcpServers ?? {}), ...agent.mcpServers },
    // Skills are additive from config
  };
}
