// What the app's screens show, read from the same files and registries the
// terminal uses. Every view here is computed on request from real state; none
// of it is sample data, and no secret leaves this process (keys are shown as
// their last four characters, bot tokens only as "configured").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KEY_ENV, BOTS } from './bots.js';
import { keyStatus, setKey } from './keystore.js';

// Every key the app can hold, grouped as the page shows them: what it is, where
// to get one (the provider's own key page), and what it unlocks. `free` is set
// only where the provider has a free tier.
export const PROVIDER_CATALOG = Object.freeze({
  // AI models
  anthropic: { label: 'Anthropic', group: 'models', url: 'https://console.anthropic.com/settings/keys', blurb: 'Claude Opus, Sonnet, Haiku' },
  openai: { label: 'OpenAI', group: 'models', url: 'https://platform.openai.com/api-keys', blurb: 'GPT models; images with gpt-image' },
  gemini: { label: 'Google Gemini', group: 'models', url: 'https://aistudio.google.com/apikey', blurb: 'Gemini Pro and Flash', free: true },
  openrouter: { label: 'OpenRouter', group: 'models', url: 'https://openrouter.ai/settings/keys', blurb: 'One key for 300+ models from every lab, free ones included', free: true, aliases: 'router' },
  xai: { label: 'xAI', group: 'models', url: 'https://console.x.ai', blurb: 'Grok', aliases: 'grok' },
  deepseek: { label: 'DeepSeek', group: 'models', url: 'https://platform.deepseek.com/api_keys', blurb: 'DeepSeek V-series and R-series' },
  mistral: { label: 'Mistral', group: 'models', url: 'https://console.mistral.ai/api-keys', blurb: 'Mistral Large, Codestral' },
  groq: { label: 'Groq', group: 'models', url: 'https://console.groq.com/keys', blurb: 'Open models at very high speed', free: true },
  cerebras: { label: 'Cerebras', group: 'models', url: 'https://cloud.cerebras.ai', blurb: 'Open models at very high speed', free: true },
  together: { label: 'Together AI', group: 'models', url: 'https://api.together.ai/settings/api-keys', blurb: 'Open models: Llama, Qwen, DeepSeek' },
  fireworks: { label: 'Fireworks AI', group: 'models', url: 'https://fireworks.ai/account/api-keys', blurb: 'Open models, fast' },
  perplexity: { label: 'Perplexity', group: 'models', url: 'https://www.perplexity.ai/settings/api', blurb: 'Sonar: answers with live web sources' },
  cohere: { label: 'Cohere', group: 'models', url: 'https://dashboard.cohere.com/api-keys', blurb: 'Command models' },
  huggingface: { label: 'Hugging Face', group: 'models', url: 'https://huggingface.co/settings/tokens', blurb: 'Thousands of open models through one router', free: true, aliases: 'hf inference' },
  // NVIDIA Developer Program access is free only for prototyping, research,
  // development and testing. Production NIM use requires NVIDIA AI Enterprise,
  // so this must not be presented as an unconditional “free tier”.
  nvidia: { label: 'NVIDIA NIM', group: 'models', url: 'https://build.nvidia.com', blurb: 'NVIDIA-hosted models; free for prototyping, Enterprise license for production' },
  github: { label: 'GitHub Models', group: 'models', url: 'https://github.com/settings/tokens', blurb: 'Models with your GitHub account (a token with the models scope)', free: true },
  dashscope: { label: 'Alibaba Qwen (Model Studio)', group: 'models', url: 'https://modelstudio.console.alibabacloud.com', blurb: 'Qwen models from Alibaba Cloud', aliases: 'qwen dashscope alibaba' },
  deepinfra: { label: 'DeepInfra', group: 'models', url: 'https://deepinfra.com/dash/api_keys', blurb: 'Open models, low prices' },
  sambanova: { label: 'SambaNova', group: 'models', url: 'https://cloud.sambanova.ai/apis', blurb: 'Open models at high speed' },
  nebius: { label: 'Nebius AI Studio', group: 'models', url: 'https://studio.nebius.com', blurb: 'Open models' },
  novita: { label: 'Novita AI', group: 'models', url: 'https://novita.ai/settings/key-management', blurb: 'Open models' },
  venice: { label: 'Venice', group: 'models', url: 'https://venice.ai/settings/api', blurb: 'Private, uncensored open models' },
  chutes: { label: 'Chutes', group: 'models', url: 'https://chutes.ai', blurb: 'Open models on a decentralised network' },
  moonshot: { label: 'Moonshot Kimi', group: 'models', url: 'https://platform.moonshot.ai/console/api-keys', blurb: 'Kimi K2', aliases: 'kimi' },
  zhipu: { label: 'Zhipu GLM', group: 'models', url: 'https://open.bigmodel.cn/usercenter/apikeys', blurb: 'GLM models', aliases: 'glm z.ai' },
  minimax: { label: 'MiniMax', group: 'models', url: 'https://www.minimax.io/platform', blurb: 'MiniMax models' },
  baichuan: { label: 'Baichuan', group: 'models', url: 'https://platform.baichuan-ai.com', blurb: 'Baichuan models' },
  yi: { label: '01.AI Yi', group: 'models', url: 'https://platform.lingyiwanwu.com', blurb: 'Yi models' },
  stepfun: { label: 'StepFun', group: 'models', url: 'https://platform.stepfun.com', blurb: 'Step models' },
  backboard: { label: 'Backboard', group: 'models', url: 'https://backboard.io', blurb: 'Model routing with memory' },
  custom: { label: 'Custom endpoint (default key)', group: 'models', url: null, blurb: 'The key for OX_BASE_URL. For named endpoints use Custom endpoints' },
  // Web search: the agent's web_search tool uses the first one set (else a keyless search).
  tavily: { label: 'Tavily', group: 'search', env: 'TAVILY_API_KEY', url: 'https://app.tavily.com', blurb: 'Search built for AI agents', free: true },
  brave: { label: 'Brave Search', group: 'search', env: 'BRAVE_SEARCH_API_KEY', url: 'https://api-dashboard.search.brave.com', blurb: 'Independent web index' },
  serper: { label: 'Serper (Google results)', group: 'search', env: 'SERPER_API_KEY', url: 'https://serper.dev', blurb: 'Google results as data', free: true, aliases: 'google' },
  marginalia: { label: 'Marginalia', group: 'search', env: 'MARGINALIA_API_KEY', url: 'https://about.marginalia-search.com/article/api/', blurb: 'The small, independent web' },
  // Images & video (OX Studio)
  fal: { label: 'fal.ai', group: 'media', env: 'FAL_KEY', url: 'https://fal.ai/dashboard/keys', blurb: 'Images and video: Flux, Veo, Kling and more' },
  higgsfield: { label: 'Higgsfield', group: 'media', env: 'HIGGSFIELD_API_KEY', url: 'https://higgsfield.ai', blurb: 'Video' },
});
export const PROVIDER_LABELS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_CATALOG).map(([id, p]) => [id, p.label])));
export const MEDIA_KEYS = Object.freeze(Object.fromEntries(Object.entries(PROVIDER_CATALOG).filter(([, p]) => p.group === 'media').map(([id, p]) => [id, { label: p.label, env: p.env }])));
const GROUP_ORDER = ['models', 'search', 'media'];
const keyEnvOf = (id) => KEY_ENV[id] ?? PROVIDER_CATALOG[id]?.env ?? null;

export function providersView(env = process.env) {
  const ids = [...new Set([...Object.keys(PROVIDER_CATALOG), ...Object.keys(KEY_ENV).filter((p) => KEY_ENV[p])])].filter((id) => keyEnvOf(id));
  const catalogOrder = Object.keys(PROVIDER_CATALOG);
  ids.sort((a, b) => (GROUP_ORDER.indexOf(PROVIDER_CATALOG[a]?.group ?? 'models') - GROUP_ORDER.indexOf(PROVIDER_CATALOG[b]?.group ?? 'models')) || ((catalogOrder.indexOf(a) + 1 || 999) - (catalogOrder.indexOf(b) + 1 || 999)));
  return ids.map((id) => {
    const meta = PROVIDER_CATALOG[id] ?? {};
    const group = meta.group ?? 'models';
    return {
      id,
      label: meta.label ?? id,
      env: keyEnvOf(id),
      group,
      url: meta.url ?? null,
      blurb: meta.blurb ?? '',
      free: !!meta.free,
      aliases: meta.aliases ?? '',
      testable: group === 'models' && id !== 'custom',
      media: group === 'media',
      bots: Object.entries(BOTS).filter(([, d]) => d.provider === id && d.model).map(([b]) => b),
      ...keyStatus(keyEnvOf(id), env),
    };
  });
}

export function saveProviderKey(provider, key, env = process.env) {
  const name = keyEnvOf(provider);
  if (!name) throw new Error(`unknown provider: ${provider}`);
  setKey(name, key, { env });
  return providersView(env);
}

/**
 * Does this key work, and what does it unlock? Asks the provider for its model
 * list with the key (the saved one, or one being tried before saving): no
 * tokens are spent. Returns { ok, ms, count, models, error }.
 */
export async function testProviderKey(provider, key = null, env = process.env, { fetchImpl = fetch } = {}) {
  const { PROVIDERS } = await import('./providers/index.js');
  const cfg = PROVIDERS[provider];
  const keyEnv = keyEnvOf(provider);
  if (!cfg?.baseUrl || !keyEnv) return { ok: false, error: `${PROVIDER_CATALOG[provider]?.label ?? provider} cannot be tested here` };
  const k = (typeof key === 'string' && key.trim()) || env[keyEnv];
  if (!k) return { ok: false, error: 'no key: paste one first' };
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const started = Date.now();
  let url = cfg.keyTestUrl ?? `${base}/models`;
  const headers = { authorization: `Bearer ${k}` };
  if (cfg.kind === 'anthropic') { delete headers.authorization; headers['x-api-key'] = k; headers['anthropic-version'] = '2023-06-01'; }
  if (cfg.kind === 'gemini') { delete headers.authorization; url = `${base}/models?key=${encodeURIComponent(k)}`; }
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
    const ms = Date.now() - started;
    if (r.status === 401 || r.status === 403) return { ok: false, ms, error: `the provider refused this key (HTTP ${r.status})` };
    if (!r.ok) return { ok: false, ms, error: `the provider answered HTTP ${r.status}` };
    // OpenRouter's account check proves the key is valid, but does not list
    // models. Fetch its public catalog separately to populate the picker.
    if (cfg.keyTestUrl) {
      url = `${base}/models`;
      const catalog = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!catalog.ok) return { ok: true, ms: Date.now() - started, count: 0, models: [], catalogError: `the key is valid, but the model catalog answered HTTP ${catalog.status}` };
      const j = await catalog.json().catch(() => ({}));
      const list = (Array.isArray(j) ? j : j.data ?? j.models ?? []).map((m) => String(m?.id ?? m?.name ?? m).replace(/^models\//, '')).filter(Boolean);
      return { ok: true, ms: Date.now() - started, count: list.length, models: list.slice(0, 3000) };
    }
    const j = await r.json().catch(() => ({}));
    const list = (Array.isArray(j) ? j : j.data ?? j.models ?? []).map((m) => String(m?.id ?? m?.name ?? m).replace(/^models\//, '')).filter(Boolean);
    return { ok: true, ms, count: list.length, models: list.slice(0, 3000) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: `could not reach ${base}: ${e?.cause?.code ?? e?.message ?? e}` };
  }
}

/**
 * Use one of a provider's models: it is saved as a named model the picker
 * lists (e.g. "openrouter-laguna-s-2.1") and becomes the default.
 */
export async function useProviderModel(provider, model) {
  const { readConfigDoc, saveConfigDoc } = await import('./config.js');
  const { resolveBot } = await import('./bots.js');
  const m = String(model ?? '').trim();
  if (!keyEnvOf(provider) || !PROVIDER_CATALOG[provider] || PROVIDER_CATALOG[provider].group !== 'models') throw new Error(`not a model provider: ${provider}`);
  if (!m || m.length > 200 || /\s/.test(m)) throw new Error('choose a model');
  const name = `${provider}-${m.split('/').pop().replace(/:free$/, '-free').replace(/[^a-z0-9.-]+/gi, '-').toLowerCase()}`.slice(0, 60);
  const def = { provider, model: m, desc: `${PROVIDER_CATALOG[provider].label} · ${m}` };
  resolveBot(name, { bots: { ...(readConfigDoc().bots ?? {}), [name]: def } });
  saveConfigDoc((doc) => { doc.bots = { ...(doc.bots ?? {}), [name]: def }; doc.defaultBot = name; });
  return { name, ...def };
}

// Settings > Instructions: your own instructions for every chat.
export async function instructionsView(env = process.env) {
  const { userInstructionsFile } = await import('./context.js');
  const file = userInstructionsFile(env);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  return { file, text, max: 4000 };
}
export async function saveInstructions(text, env = process.env) {
  const { userInstructionsFile } = await import('./context.js');
  const t = String(text ?? '');
  if (t.length > 4000) throw new Error('keep it under 4,000 characters');
  const file = userInstructionsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (t.trim()) fs.writeFileSync(file, `${t.trim()}\n`, { mode: 0o600 });
  else { try { fs.unlinkSync(file); } catch {} }
  return instructionsView(env);
}

// Settings > Connectors: MCP servers every run can use (config mcpServers).
const CONNECTOR_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/;
export async function connectorsView() {
  const { readConfigDoc } = await import('./config.js');
  const doc = readConfigDoc();
  const servers = doc.mcpServers ?? {};
  const policy = doc.mcpPolicy && typeof doc.mcpPolicy === 'object' ? doc.mcpPolicy : {};
  return Object.entries(servers).map(([name, s]) => ({
    name,
    kind: s?.url ? 'http' : 'stdio',
    target: s?.url ?? [s?.command, ...(s?.args ?? [])].filter(Boolean).join(' '),
    env: Object.keys(s?.env ?? {}),
    // No entry means the runtime asks.  Expose that explicitly instead of
    // making a missing configuration look like an undocumented permission.
    policy: ['ask', 'allow', 'deny'].includes(policy[name]) ? policy[name] : 'ask',
  }));
}
export async function saveConnector(body = {}) {
  const { saveConfigDoc, readConfigDoc } = await import('./config.js');
  const name = String(body.name ?? '').trim();
  if (!CONNECTOR_NAME.test(name)) throw new Error('name: letters, numbers, - and _ (up to 40)');
  if (body.action === 'remove') { saveConfigDoc((doc) => { if (doc.mcpServers) delete doc.mcpServers[name]; }); return connectorsView(); }
  if (body.action === 'policy') {
    const policy = String(body.policy ?? '').toLowerCase();
    if (!['ask', 'allow', 'deny'].includes(policy)) throw new Error('permission must be ask, allow or deny');
    const configured = readConfigDoc().mcpServers ?? {};
    if (!Object.prototype.hasOwnProperty.call(configured, name)) throw new Error(`connector '${name}' does not exist`);
    saveConfigDoc((doc) => {
      const next = { ...(doc.mcpPolicy ?? {}) };
      if (policy === 'ask') delete next[name];
      else next[name] = policy;
      doc.mcpPolicy = next;
    });
    return connectorsView();
  }
  let def;
  const url = String(body.url ?? '').trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new Error('the URL must start with http:// or https://');
    def = { url };
  } else {
    const command = String(body.command ?? '').trim();
    if (!command) throw new Error('give a command (like npx) or a URL');
    const args = Array.isArray(body.args) ? body.args.map(String) : String(body.args ?? '').trim() ? String(body.args).trim().split(/\s+/) : [];
    def = { command, args };
  }
  saveConfigDoc((doc) => { doc.mcpServers = { ...(doc.mcpServers ?? {}), [name]: def }; });
  return connectorsView();
}

// Settings > About: is there a newer ox?
export async function updateView() {
  const { updateCheck } = await import('./evolve.js');
  try { return updateCheck(); } catch (e) { return { kind: 'error', message: String(e?.message ?? e) }; }
}

// Subscriptions you already pay for (Claude, ChatGPT, …) through their CLIs.
export async function accountsView(env = process.env, onlyId = null) {
  const { checkAll, checkCli, planModel, accountInstallPage, accountCanConnect } = await import('./subscriptions.js');
  const { loadConfig } = await import('./config.js');
  let config = {};
  try { config = loadConfig(); } catch {}
  const checked = onlyId ? [checkCli(String(onlyId), config, env)] : checkAll(config, env);
  return checked.filter((c) => c.known !== false).map((c) => ({
    id: c.id, label: c.label, bin: c.bin, installed: !!c.installed, works: !!c.works,
    signedIn: c.signedIn ?? null, version: c.version ?? null, problem: c.problem ?? null, fix: c.fix ?? null, login: c.login ?? null,
    installUrl: accountInstallPage(c.id), canConnect: accountCanConnect(c.id),
    bot: `${c.id}-plan`,
    // The model this account accepted last time (e.g. a free ChatGPT account), shown on its card.
    model: c.works ? (c.model ?? planModel(c.id)) : null,
  }));
}

// Open the vendor's own interactive OAuth/login flow in Terminal. Ox never
// reads or stores the vendor's credentials; the official CLI owns that flow.
export async function connectAccount(id, { env = process.env, platform = process.platform } = {}) {
  const { launchSubscriptionLogin } = await import('./subscriptions.js');
  return launchSubscriptionLogin(String(id ?? ''), { env, platform });
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
  let plugins = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'plugins.json'), 'utf8')).plugins ?? {};
    const { readPlugin } = await import('./plugins.js');
    plugins = Object.entries(pj).map(([name, x]) => {
      const plugin = x.path ? readPlugin(x.path) : null;
      return { name, source: x.source ?? '', enabled: x.enabled !== false, version: x.version ?? plugin?.version ?? null,
        kind: x.kind ?? 'copy', mcp: x.mcp !== false, missing: !plugin,
        description: plugin?.description ?? '', skills: plugin?.skills ?? [], commands: plugin?.commands ?? [],
        mcpServers: Object.keys(plugin?.mcpServers ?? {}), hasHooks: Boolean(plugin?.hasHooks) };
    });
  } catch {}
  return { skills, tools, mcp, agents, plugins };
}

/** Change one installed plugin using the same registry actions as `ox plugin`. */
export async function pluginAction(body = {}) {
  const P = await import('./plugins.js');
  const name = String(body.name ?? '');
  const action = String(body.action ?? '');
  if (!name || name.length > 64) throw new Error('choose a valid installed plugin');
  if (action === 'enable' || action === 'disable') return P.setPluginEnabled(name, action === 'enable');
  if (action === 'mcp') return P.setPluginMcp(name, body.enabled === true);
  if (action === 'remove') return P.removePlugin(name);
  throw new Error('plugin action must be enable, disable, mcp or remove');
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
  const sl = await import('./slack-gateway.js');
  const one = (id, label, st, tokenEnv, how) => ({
    id, label,
    configured: !!(env[tokenEnv] || st.token || (st.appToken && st.botToken)),
    tokenFrom: env[tokenEnv] ? 'environment' : st.token || st.appToken ? 'saved' : null,
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
    { ...one('slack', 'Slack', sl.loadState(), 'SLACK_BOT_TOKEN', [
      'At api.slack.com/apps create an app. Turn on Socket Mode and generate an app token (xapp-…, scope connections:write).',
      'Bot scopes chat:write and im:history; Event Subscriptions: message.im; Interactivity on; App Home: allow messages. Install it and copy the Bot token (xoxb-…).',
      'Run: ox gateway slack --app-token xapp-… --bot-token xoxb-…, then DM the app "pair <code>" with the code ox shows. It answers DMs only.',
    ]), slashless: true },
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

// A new scheduled run from the app: the same screening, cost cap and refusals
// as `ox schedule add`; the cadence in words ("every 30m", "daily at 9:00").
export async function scheduleAdd({ prompt, when, enabled = true, cwd = process.cwd() } = {}) {
  const sch = await import('./schedule.js');
  const cad = sch.parseNaturalCadence(String(when ?? ''));
  if (cad.refusal) throw new Error(cad.refusal);
  const r = sch.addSchedule({ prompt: String(prompt ?? ''), cadence: cad.cadence, enabled: enabled === true, cwd });
  if (r.refusal) throw new Error(r.refusal);
  return scheduledView();
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
    return { name, description: a.description ?? '', bot: agentBotSpec(a), mode: a.mode ?? 'code', tools: a.tools ?? null, instructions: a.systemPrompt ?? '', shape: a.shape ?? null, color: a.color ?? null, character: a.character === 'mochi' ? 'mochi' : 'ox', colorway: a.colorway ?? 'matcha', updatedAt: a.updatedAt ?? null };
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
  saveAgent(name, { ...prior, description: String(body.description ?? '').slice(0, 200), bot, mode, tools, systemPrompt: String(body.instructions ?? '').slice(0, 20_000), shape: Number.isInteger(body.shape) ? body.shape : prior.shape ?? null, color: typeof body.color === 'string' ? body.color : prior.color ?? null, character: body.character === 'mochi' ? 'mochi' : body.character === 'ox' ? 'ox' : prior.character ?? 'ox', colorway: body.colorway ?? prior.colorway ?? 'matcha' });
  return botsView(env);
}

export async function botDelete(name, env = process.env) {
  const { deleteAgent, AGENT_NAME } = await import('./agents.js');
  if (!AGENT_NAME.test(String(name)) || !deleteAgent(String(name))) throw new Error(`no bot called ${name}`);
  return botsView(env);
}

// Settings › Projects, Worktrees, Server, What's new (after OpenCode's settings):
// the folders ox has worked in, the git worktrees in them, this server, and
// what changed in ox since the version you last saw.
const gitOut = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function projectsView({ limit = 400 } = {}) {
  const byCwd = new Map();
  for (const s of sessionsView({ limit })) {
    if (!s.cwd) continue;
    const p = byCwd.get(s.cwd) ?? { path: s.cwd, sessions: 0, last: 0 };
    p.sessions++; p.last = Math.max(p.last, s.at);
    byCwd.set(s.cwd, p);
  }
  if (!byCwd.has(process.cwd())) byCwd.set(process.cwd(), { path: process.cwd(), sessions: 0, last: Date.now() });
  return [...byCwd.values()].filter((p) => fs.existsSync(p.path)).sort((a, b) => b.last - a.last).slice(0, 40).map((p) => ({
    ...p, name: path.basename(p.path), current: p.path === process.cwd(), branch: gitOut(p.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
  }));
}

/** git worktree list --porcelain → [{ path, branch, head, main, dirty }] for each project that is a repo. */
export function worktreesView() {
  const seen = new Set(), out = [];
  for (const p of projectsView()) {
    const root = gitOut(p.path, ['rev-parse', '--show-toplevel']);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const txt = gitOut(root, ['worktree', 'list', '--porcelain']);
    if (!txt) continue;
    const trees = txt.split('\n\n').map((b) => Object.fromEntries(b.split('\n').map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)])));
    for (const [i, t] of trees.entries()) {
      if (!t.worktree) continue;
      const dirty = i > 0 && fs.existsSync(t.worktree) ? !!gitOut(t.worktree, ['status', '--porcelain']) : null;
      out.push({ repo: root, path: t.worktree, branch: (t.branch ?? '').replace('refs/heads/', '') || (t.detached != null ? 'detached' : ''), head: (t.HEAD ?? '').slice(0, 8), main: i === 0, dirty, ox: /[/\\]\.ox[/\\]|ox-(task|race)/.test(t.worktree), missing: !fs.existsSync(t.worktree) });
    }
  }
  return out;
}

/** Remove a worktree git knows about (never the main one; git itself refuses one with changes). */
export function removeWorktree(repo, wt) {
  const listed = worktreesView().find((t) => t.repo === repo && t.path === wt);
  if (!listed) throw new Error('that is not a worktree of a project ox knows');
  if (listed.main) throw new Error('the main checkout is not removed here');
  const r = spawnSync('git', ['-C', repo, 'worktree', listed.missing ? 'prune' : 'remove', ...(listed.missing ? [] : [wt])], { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) throw new Error((r.stderr || 'git could not remove it').trim().replace(/^fatal: /, ''));
  return { removed: wt };
}

export function serverView({ port = null, startedAt = null } = {}) {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return { pid: process.pid, port, url: port ? `http://127.0.0.1:${port}/` : null, node: process.version, uptime: Math.round(process.uptime()), startedAt, cwd: process.cwd(), code: root, commit: gitOut(root, ['rev-parse', '--short', 'HEAD']), app: process.env.OX_APP === '1', island: process.env.OX_ISLAND_SERVER === '1' };
}

/** What changed in ox since a commit you saw (git installs), newest first. */
export function whatsNew(since) {
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const head = gitOut(root, ['rev-parse', '--short', 'HEAD']);
  if (!head) return { head: null, changes: [] };
  if (!since || !/^[0-9a-f]{6,40}$/.test(since) || since === head) return { head, changes: [] };
  const log = gitOut(root, ['log', '--no-merges', '--format=%h\t%ad\t%s', '--date=short', `${since}..HEAD`, '-n', '30']);
  return { head, changes: (log ?? '').split('\n').filter(Boolean).map((l) => { const [hash, date, subject] = l.split('\t'); return { hash, date, subject }; }) };
}
