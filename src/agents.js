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
    description: agent.description ?? '',
    // A bot spec (any `--bot` value, `claude-plan` included) wins over the
    // older provider/model pair, which is kept for agents saved before it.
    bot: agent.bot ?? null,
    mode: agent.mode ?? null,
    // The tools this agent may use; null means everything its mode allows.
    tools: Array.isArray(agent.tools) ? agent.tools : null,
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    baseUrl: agent.baseUrl ?? null,
    mcpServers: agent.mcpServers ?? {},
    skills: agent.skills ?? [],
    systemPrompt: agent.systemPrompt ?? '',
    // The avatar shape picked in the app (0 to 12); null for the default.
    shape: Number.isInteger(agent.shape) && agent.shape >= 0 && agent.shape <= 12 ? agent.shape : null,
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

// What `--bot` an agent runs on: its own bot spec, else provider:model.
export function agentBotSpec(agent) {
  if (!agent) return null;
  if (agent.bot) return agent.bot;
  if (agent.provider && agent.model) return `${agent.provider}:${agent.model}`;
  return null;
}

// The agent's own instructions, as a prompt block.
export function agentPersonaBlock(agent) {
  const text = String(agent?.systemPrompt ?? '').trim();
  if (!text) return '';
  return `# You are the "${agent.name}" agent${agent.description ? ` — ${agent.description}` : ''}\n${agent.name} is your name: when the user says it, they are talking to you.\n${text}`;
}

export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

// Give one of your agents a new name: same bot, mode, tools and instructions,
// first-made date kept; a default that pointed at the old name follows it.
export function renameAgent(from, to, { saveConfig } = {}) {
  const next = String(to ?? '').trim();
  if (!AGENT_NAME.test(next)) throw new Error('an agent name is 1–48 letters, digits, dashes or underscores');
  const agent = AGENT_NAME.test(String(from)) ? loadAgent(from) : null;
  if (!agent) throw new Error(`no agent '${from}'`);
  if (next === from) return agent;
  if (loadAgent(next)) throw new Error(`there is already an agent called '${next}'`);
  const saved = saveAgent(next, { ...agent, name: next });
  deleteAgent(from);
  saveConfig?.((doc) => { if (doc.defaultBot === `agent:${from}`) doc.defaultBot = `agent:${next}`; });
  return saved;
}
