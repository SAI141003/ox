// What the app's screens show, read from the same files and registries the
// terminal uses. Every view here is computed on request from real state; none
// of it is sample data, and no secret leaves this process (keys are shown as
// their last four characters, bot tokens only as "configured").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEY_ENV, BOTS } from './bots.js';
import { keyStatus, setKey } from './keystore.js';

// Human names for the providers ox talks to with an API key.
export const PROVIDER_LABELS = Object.freeze({
  anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', gemini: 'Google Gemini', openrouter: 'OpenRouter',
  deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', together: 'Together AI', fireworks: 'Fireworks AI',
  cerebras: 'Cerebras', zhipu: 'Zhipu GLM', moonshot: 'Moonshot Kimi', baichuan: 'Baichuan', minimax: 'MiniMax',
  yi: '01.AI Yi', stepfun: 'StepFun', backboard: 'Backboard', custom: 'Custom endpoint',
});
const ORDER = ['anthropic', 'openai', 'xai', 'gemini', 'openrouter', 'deepseek', 'mistral', 'groq', 'together', 'fireworks', 'cerebras'];

// Keys for image and video generation (OX Studio), next to the model keys.
export const MEDIA_KEYS = Object.freeze({ higgsfield: { label: 'Higgsfield (images & video)', env: 'HIGGSFIELD_API_KEY' }, fal: { label: 'fal.ai (images & video)', env: 'FAL_KEY' } });
const keyEnvOf = (id) => KEY_ENV[id] ?? MEDIA_KEYS[id]?.env ?? null;

export function providersView(env = process.env) {
  const ids = Object.keys(KEY_ENV).filter((p) => KEY_ENV[p]);
  ids.sort((a, b) => ((ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  return [
    ...ids.map((id) => ({
      id,
      label: PROVIDER_LABELS[id] ?? id,
      env: KEY_ENV[id],
      bots: Object.entries(BOTS).filter(([, d]) => d.provider === id && d.model).map(([b]) => b),
      ...keyStatus(KEY_ENV[id], env),
    })),
    ...Object.entries(MEDIA_KEYS).map(([id, m]) => ({ id, label: m.label, env: m.env, bots: [], media: true, ...keyStatus(m.env, env) })),
  ];
}

export function saveProviderKey(provider, key, env = process.env) {
  const name = keyEnvOf(provider);
  if (!name) throw new Error(`unknown provider: ${provider}`);
  setKey(name, key, { env });
  return providersView(env);
}

// Subscriptions you already pay for (Claude, ChatGPT, …) through their CLIs.
export async function accountsView(env = process.env) {
  const { checkAll } = await import('./subscriptions.js');
  const { loadConfig } = await import('./config.js');
  let config = {};
  try { config = loadConfig(); } catch {}
  return checkAll(config, env).map((c) => ({
    id: c.id, label: c.label, bin: c.bin, installed: !!c.installed, works: !!c.works,
    version: c.version ?? null, problem: c.problem ?? null, fix: c.fix ?? null, login: c.login ?? null,
    bot: `${c.id}-plan`,
  }));
}

// Models on this machine: what is running now, and what would fit.
export async function localView() {
  const { scanLocalEndpoints, LOCAL_MODELS } = await import('./local-inference.js');
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  let found = [];
  try { found = await scanLocalEndpoints({ deadlineMs: 2000 }); } catch {}
  const runtimes = found.map((f) => ({
    name: f.displayName, url: f.baseUrl, version: f.version ?? null,
    models: (f.models ?? []).map((m) => ({ id: m.name ?? m.id, size: m.size ?? null })),
  }));
  const catalog = LOCAL_MODELS.map((m) => ({
    id: m.id, name: m.name, size: m.size, minRAM: m.minRAM, bestFor: m.bestFor, pull: `ollama pull ${m.ollamaName}`,
    fits: m.minRAM <= ramGB,
  }));
  return { machine: { ramGB, cpus: os.cpus().length, arch: os.arch(), platform: process.platform, unified: process.platform === 'darwin' && os.arch() === 'arm64' }, runtimes, catalog };
}

// Skills, tools, MCP servers and your own agents.
export async function capabilitiesView(cwd = process.cwd()) {
  const { discoverSkills, BUILTIN_SKILLS_DIR } = await import('./skills.js');
  const { listToolSchemas } = await import('./tools/index.js');
  const { listAgents, loadAgent } = await import('./agents.js');
  const home = os.homedir();
  const where = (p = '') => p.startsWith(BUILTIN_SKILLS_DIR) ? 'built-in'
    : p.includes(`${path.sep}.agent${path.sep}skill-drafts${path.sep}`) ? 'draft'
    : p.startsWith(cwd) ? 'this project'
    : p.startsWith(home) ? 'yours' : 'other';
  let skills = [];
  try {
    skills = discoverSkills({ cwd }).map((s) => ({
      name: s.name, description: s.description, source: s.plugin ? `plugin ${s.plugin}` : where(s.path), path: s.path,
      learned: /(^|\n)\s*learned:\s*true/.test(fs.readFileSync(s.path, 'utf8').slice(0, 600)),
    }));
  } catch {}
  let tools = [];
  try {
    tools = listToolSchemas({}).map((t) => ({ name: t.name, description: String(t.description ?? '').split('\n')[0].slice(0, 220) }));
  } catch {}
  let mcp = [];
  try {
    const { loadConfig } = await import('./config.js');
    const servers = loadConfig().mcpServers ?? {};
    mcp = Object.entries(servers).map(([name, s]) => ({ name, kind: s?.url ? 'http' : 'stdio', target: s?.url ?? s?.command ?? '' }));
  } catch {}
  const agents = listAgents().map((name) => {
    try {
      const a = loadAgent(name);
      return { name, mode: a.mode ?? 'code', bot: a.bot ?? null, desc: a.description ?? a.desc ?? '', tools: a.tools ?? null };
    } catch { return { name, broken: true }; }
  });
  return { skills, tools, mcp, agents };
}

export function skillBody(name, cwd = process.cwd()) {
  return import('./skills.js').then(({ discoverSkills }) => {
    const s = discoverSkills({ cwd }).find((x) => x.name === name);
    if (!s) return null;
    return { name: s.name, description: s.description, path: s.path, body: String(s.body ?? '').slice(0, 20000) };
  });
}

// Telegram and Discord: whether a bot token is set and whether a chat is paired.
export async function messagingView(env = process.env) {
  const tg = await import('./telegram-gateway.js');
  const dc = await import('./discord-gateway.js');
  const one = (id, label, st, tokenEnv, how) => ({
    id, label,
    configured: !!(env[tokenEnv] || st.token),
    tokenFrom: env[tokenEnv] ? 'environment' : st.token ? 'saved' : null,
    paired: !!st.owner,
    pairing: !!st.pairCode && !st.owner,
    command: `ox gateway ${id}`,
    how,
  });
  return [
    one('telegram', 'Telegram', tg.loadState(), 'TELEGRAM_BOT_TOKEN', [
      'In Telegram, talk to @BotFather, send /newbot and copy the token it gives you.',
      'Run: ox gateway telegram --token <token> (the token is saved, mode 0600).',
      'ox shows a 6-digit code; send /pair <code> to your bot. Only that chat can drive ox.',
    ]),
    one('discord', 'Discord', dc.loadState(), 'DISCORD_BOT_TOKEN', [
      'At discord.com/developers create an application, add a Bot and copy its token.',
      'Invite the bot, then run: ox gateway discord --token <token>.',
      'DM the bot /pair <code> with the code ox shows. It answers DMs only.',
    ]),
  ];
}

// Scheduled runs (ox schedule) and page watches (ox watch).
export async function scheduledView() {
  const sch = await import('./schedule.js');
  const w = await import('./watch.js');
  let schedules = [];
  try {
    schedules = sch.listSchedules().map((s) => ({
      id: s.id, prompt: String(s.prompt ?? '').slice(0, 200), enabled: s.enabled === true,
      cadence: s.cadence?.description ?? s.cadence?.kind ?? '', next: sch.scheduleRunStatus(s).text,
    }));
  } catch {}
  let watches = [];
  try { watches = w.loadWatches().map((x) => ({ id: x.id, label: x.label ?? x.url, url: x.url, every: x.everyS ? `every ${Math.round(x.everyS / 60)}m` : null, what: w.describe(x).split('  ').slice(1).join('  ') })); } catch {}
  let watcher = null;
  try { watcher = w.watcherPid(); } catch {}
  return { schedules, watches, watcherRunning: !!watcher };
}

export async function setScheduleEnabled(id, enabled) {
  const sch = await import('./schedule.js');
  if (!sch.getSchedule(id)) throw new Error(`no schedule ${id}`);
  sch.updateSchedule(id, { enabled: !!enabled });
  return scheduledView();
}

// Terminal sessions (~/.ox/sessions), newest first, so the app can show them.
const SESSIONS_DIR = () => path.join(os.homedir(), '.ox', 'sessions');
const SESSION_ID = /^[\w.-]{1,80}$/;

function readLines(file, max = 4000) {
  return fs.readFileSync(file, 'utf8').split('\n').slice(0, max).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function sessionsView({ limit = 60 } = {}) {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR()).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const f of files.sort().reverse()) {
    if (out.length >= limit) break;
    const file = path.join(SESSIONS_DIR(), f);
    let rows;
    try { rows = readLines(file, 400); } catch { continue; }
    const first = rows.find((r) => r.t === 'user');
    if (!first) continue; // opened and closed with nothing said
    const meta = rows.find((r) => r.t === 'meta') ?? {};
    out.push({
      id: f.slice(0, -6), title: String(first.text ?? '').slice(0, 80), cwd: meta.cwd ?? null, bot: meta.bot ?? null,
      at: Date.parse(meta.created ?? '') || fs.statSync(file).mtimeMs,
      turns: rows.filter((r) => r.t === 'user').length,
    });
  }
  return out;
}

export function sessionView(id) {
  if (!SESSION_ID.test(id)) return null;
  const file = path.join(SESSIONS_DIR(), `${id}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const rows = readLines(file);
  const meta = rows.find((r) => r.t === 'meta') ?? {};
  return {
    id, cwd: meta.cwd ?? null, bot: meta.bot ?? null,
    messages: rows.filter((r) => r.t === 'user' || r.t === 'assistant').map((r) => ({ role: r.t, content: String(r.text ?? '') })),
  };
}

export async function aboutView() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return {
    version: pkg.version, license: pkg.license, node: process.version, platform: process.platform, arch: os.arch(),
    cwd: process.cwd(), config: path.join(os.homedir(), '.ox', 'config.json'), keys: path.join(os.homedir(), '.ox', 'keys.json'),
  };
}

// What ox remembers: about you (every project) and about the folder it serves.
export async function memoryView(cwd = process.cwd()) {
  const mg = await import('./memory-graph.js');
  const pick = (m) => ({ id: m.id, text: m.text, kind: m.kind, at: m.createdAt, strength: m.strength ?? 1, replaced: !!m.updates, until: m.expiresAt ?? null });
  const user = mg.profile({ file: mg.memoryFile('user'), maxStatic: 200, maxRecent: 200 });
  const proj = mg.profile({ file: mg.memoryFile('project', { cwd }), maxStatic: 200, maxRecent: 200 });
  return {
    user: { stable: user.stable.map(pick), lately: user.lately.map(pick) },
    project: [...proj.stable, ...proj.lately].map(pick),
    learning: process.env.OX_LEARN !== '0',
  };
}

export async function memoryAction(body = {}, cwd = process.cwd()) {
  const mg = await import('./memory-graph.js');
  const scope = body.scope === 'project' ? 'project' : 'user';
  if (body.action === 'add') {
    const r = mg.remember(String(body.text ?? ''), { scope, file: mg.memoryFile(scope, { cwd }), source: 'app' });
    if (r.op === 'refused') throw new Error(r.reason);
  } else if (body.action === 'forget') {
    const id = String(body.id ?? '');
    if (!mg.forget(id, { file: mg.memoryFile('user') }) && !mg.forget(id, { file: mg.memoryFile('project', { cwd }) })) throw new Error(`no memory ${id}`);
  } else {
    throw new Error("action must be 'add' or 'forget'");
  }
  return memoryView(cwd);
}

// OX Studio (src/media-studio.js): providers and their models, and every run.
export async function studioView() {
  const ms = await import('./media-studio.js');
  return {
    providers: Object.entries(ms.PROVIDERS).map(([id, p]) => ({ id, label: p.label, kinds: p.kinds, anyModel: !!p.anyModel, ready: !p.key || !!process.env[p.key], key: p.key, models: p.models() })),
    higgsfield: ms.MODELS,
    history: ms.history({ limit: 120 }).map((r) => ({ ...r, files: (r.files ?? []).map((f) => `/ox/media/${encodeURIComponent(r.id)}/${encodeURIComponent(path.basename(f))}`) })),
  };
}

export async function studioCreate(b = {}) {
  const ms = await import('./media-studio.js');
  const media = {};
  for (const role of ['start', 'end', 'reference', 'video', 'audio']) {
    const list = (Array.isArray(b.media?.[role]) ? b.media[role] : []).map(String).filter(Boolean);
    if (list.length) media[role] = list;
  }
  const r = await ms.generate({ provider: String(b.provider ?? 'higgsfield'), model: String(b.model ?? ''), prompt: String(b.prompt ?? ''), settings: b.settings && typeof b.settings === 'object' ? b.settings : {}, media });
  return { ...r, files: (r.files ?? []).map((f) => `/ox/media/${encodeURIComponent(r.id)}/${encodeURIComponent(path.basename(f))}`) };
}

export async function studioAction(b = {}) {
  const ms = await import('./media-studio.js');
  const id = String(b.id ?? '');
  if (!/^[0-9a-f]{6,20}$/.test(id)) throw new Error('bad id');
  if (b.action === 'delete') ms.remove(id);
  else if (b.action === 'favorite') ms.favorite(id, b.on !== false);
  else throw new Error("action must be 'delete' or 'favorite'");
  return studioView();
}

// A finished file, only from inside ~/.ox/media/<id>/.
export async function mediaFile(id, name) {
  const ms = await import('./media-studio.js');
  if (!/^[0-9a-f]{6,20}$/.test(id) || !/^[\w.-]{1,40}$/.test(name) || name.startsWith('.')) return null;
  const f = path.join(ms.MEDIA_DIR(), id, name);
  if (!f.startsWith(path.join(ms.MEDIA_DIR(), id) + path.sep) || !fs.existsSync(f)) return null;
  return f;
}

// Bots: your own (a name, a model, a mode, the tools it may use and standing
// instructions; the same files `ox agent` writes in ~/.ox/agents) and every
// model ox can run them on, with whether it is ready.
export async function botsView(env = process.env) {
  const { listAgents, loadAgent, agentBotSpec } = await import('./agents.js');
  const { MODE_NAMES } = await import('./modes.js');
  const { listToolSchemas } = await import('./tools/index.js');
  const { listEndpoints } = await import('./endpoints.js');
  const mine = listAgents().map((name) => {
    const a = loadAgent(name);
    if (!a) return null;
    return { name, description: a.description ?? '', bot: agentBotSpec(a), mode: a.mode ?? 'code', tools: a.tools ?? null, instructions: a.systemPrompt ?? '', updatedAt: a.updatedAt ?? null };
  }).filter(Boolean);
  const models = Object.entries(BOTS).filter(([, d]) => d.model).map(([id, d]) => {
    const k = KEY_ENV[d.provider] ?? null;
    return { id, kind: 'model', provider: d.provider, desc: d.desc ?? '', ready: !k || !!env[k] };
  });
  let endpoints = [];
  try { endpoints = listEndpoints(env).map((e) => ({ id: e.name, kind: 'endpoint', provider: 'custom', desc: `${e.model ?? 'no model'} at ${e.baseUrl}`, ready: !!e.model })); } catch {}
  let plans = [];
  // Installed or not, from PATH alone: running every vendor CLI to check its
  // sign-in took ~9 s here (Settings › Accounts does that full check).
  try {
    const { allClis, findOnPath } = await import('./subscriptions.js');
    const { loadConfig } = await import('./config.js');
    let config = {};
    try { config = loadConfig(); } catch {}
    plans = Object.entries(allClis(config)).map(([id, c]) => ({ id: `${id}-plan`, kind: 'plan', provider: id, desc: `${c.label} (${c.bin})`, ready: !!findOnPath(c.bin, env) }));
  } catch {}
  let tools = [];
  try { tools = listToolSchemas({}).map((t) => t.name).sort(); } catch {}
  return { mine, runsOn: [...endpoints, ...plans, ...models], modes: MODE_NAMES, tools };
}

export async function botSave(body = {}, env = process.env) {
  const { saveAgent, loadAgent, renameAgent, AGENT_NAME } = await import('./agents.js');
  const { MODE_NAMES } = await import('./modes.js');
  const { resolveBot } = await import('./bots.js');
  const { readConfigDoc, saveConfigDoc } = await import('./config.js');
  const name = String(body.name ?? '').trim();
  if (!AGENT_NAME.test(name)) throw new Error('a bot name is 1 to 48 letters, digits, dashes or underscores');
  const from = body.from ? String(body.from) : null;
  if (from && from !== name) renameAgent(from, name, { saveConfig: saveConfigDoc });
  else if (!from && loadAgent(name)) throw new Error(`there is already a bot called ${name}`);
  const mode = body.mode && body.mode !== 'auto' ? String(body.mode) : null;
  if (mode && !MODE_NAMES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const bot = body.bot ? String(body.bot) : null;
  if (bot) resolveBot(bot, { bots: readConfigDoc().bots ?? {} }, env);
  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools.map(String) : null;
  const prior = loadAgent(name) ?? {};
  saveAgent(name, { ...prior, description: String(body.description ?? '').slice(0, 200), bot, mode, tools, systemPrompt: String(body.instructions ?? '').slice(0, 20_000) });
  return botsView(env);
}

export async function botDelete(name, env = process.env) {
  const { deleteAgent, AGENT_NAME } = await import('./agents.js');
  if (!AGENT_NAME.test(String(name)) || !deleteAgent(String(name))) throw new Error(`no bot called ${name}`);
  return botsView(env);
}
