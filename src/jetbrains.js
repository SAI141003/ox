// ox inside JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, GoLand, Rider, …).
// Their AI chat runs outside agents over the Agent Client Protocol, which ox
// already speaks (`ox acp server`, src/acp.js). An agent is registered in
// ~/.jetbrains/acp.json under "agent_servers"; this writes ox's entry there,
// keeping every other agent, and never rewrites a file it cannot read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const acpJsonPath = (home = os.homedir()) => path.join(home, '.jetbrains', 'acp.json');
const CLI = fileURLToPath(new URL('../bin/ox.js', import.meta.url));

/** ox's entry: absolute paths, since an IDE started from the Dock has no shell PATH. */
export function oxAgentEntry({ node = process.execPath, cli = CLI } = {}) {
  return { command: node, args: [cli, 'acp', 'server'] };
}

function readDoc(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix or move it, then run this again. It was left as it was.`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} is not a JSON object; it was left as it was.`);
  return doc;
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Add or refresh ox in acp.json. → { file, changed, backup } */
export function setupJetBrains({ home = os.homedir(), name = 'ox', entry = oxAgentEntry() } = {}) {
  const file = acpJsonPath(home);
  const doc = readDoc(file);
  const servers = doc.agent_servers && typeof doc.agent_servers === 'object' && !Array.isArray(doc.agent_servers) ? doc.agent_servers : {};
  const before = JSON.stringify(servers[name] ?? null);
  const next = { ...(servers[name] ?? {}), ...entry };
  if (before === JSON.stringify(next)) return { file, changed: false, backup: null };
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
  }
  writeDoc(file, { ...doc, agent_servers: { ...servers, [name]: next } });
  return { file, changed: true, backup };
}

/** Take ox out of acp.json, leaving the other agents. → { file, changed } */
export function removeJetBrains({ home = os.homedir(), name = 'ox' } = {}) {
  const file = acpJsonPath(home);
  const doc = readDoc(file);
  if (!doc.agent_servers?.[name]) return { file, changed: false };
  const { [name]: _gone, ...rest } = doc.agent_servers;
  writeDoc(file, { ...doc, agent_servers: rest });
  return { file, changed: true };
}

export function jetbrainsStatus({ home = os.homedir(), name = 'ox' } = {}) {
  const file = acpJsonPath(home);
  try {
    const entry = readDoc(file).agent_servers?.[name] ?? null;
    return { file, installed: !!entry, entry, ok: !!entry && fs.existsSync(String(entry.command ?? '')) };
  } catch (e) {
    return { file, installed: false, entry: null, ok: false, error: e.message };
  }
}
