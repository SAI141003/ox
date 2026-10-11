// Curated MCP server registry for `ox mcp add <template>`.
// Ordered: everyday automation first, money-adjacent last.
//
// risk classes:
//   read-only — cannot mutate external state
//   write     — can send/post/mutate outside the workspace
//   money     — can spend, reserve or transact; ox always asks before executing
//
// entry(config) returns a fresh server entry; ${VAR} placeholders stay literal
// here and are expanded from the environment by config.expandVars at load time.

const npx = (pkg, ...args) => ({ command: 'npx', args: ['-y', pkg, ...args] });

export const MCP_TEMPLATES = {
  browser: {
    name: 'browser',
    title: 'Playwright browser automation',
    risk: 'write',
    desc: 'Drive a real Chromium via @playwright/mcp: navigate, click, fill forms, screenshot, scrape.',
    requires: [],
    entry: () => npx('@playwright/mcp@latest'),
    setup: [
      'Runs a dedicated browser with an ISOLATED profile — your daily browser',
      'cookies/sessions are not shared with the agent.',
      'First run downloads Chromium (~150MB).',
      'Cap the blast radius with capability flags, e.g.:',
      '  args: ["-y","@playwright/mcp@latest","--caps","navigate,screenshot"]',
      'See @playwright/mcp docs for the full capabilities list.',
    ].join('\n'),
  },

  devtools: {
    name: 'devtools',
    title: 'Chrome DevTools inspection',
    risk: 'read-only',
    desc: 'chrome-devtools-mcp (--slim): performance traces, network, DOM and console inspection for local Chrome.',
    requires: [],
    entry: () => npx('chrome-devtools-mcp@latest', '--slim'),
    setup: [
      'Read-only diagnostics class: inspect and profile, no page mutations.',
      'Let it launch its own Chrome instance or attach to one you started',
      'with --remote-debugging-port=9222 via --browser-url.',
    ].join('\n'),
  },

  gsuite: {
    name: 'gsuite',
    title: 'Google Workspace (Gmail · Calendar · Drive)',
    risk: 'write',
    desc: 'workspace-mcp covering Gmail, Calendar and Drive — installs READ-ONLY by default; drop --read-only to allow writes.',
    requires: [],
    entry: () => ({ command: 'uvx', args: ['workspace-mcp', '--read-only'] }),
    setup: [
      'Installs the READ-ONLY variant by default.',
      'Run once interactively to complete the OAuth consent flow; tokens are',
      'cached locally so later headless runs just work.',
      'To allow writes (send mail, create events/files) remove "--read-only"',
      'from args in .mcp.json — least-privilege scopes are requested, but the',
      'mounted surface becomes mutable. Think before you flip it.',
    ].join('\n'),
  },

  slack: {
    name: 'slack',
    title: 'Slack (hosted MCP)',
    risk: 'write',
    desc: 'Slack official hosted MCP over Streamable HTTP: read channels, send messages.',
    requires: ['SLACK_MCP_TOKEN'],
    entry: () => ({
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      headers: { Authorization: 'Bearer ${SLACK_MCP_TOKEN}' },
    }),
    setup: [
      'Hosted endpoint — nothing is downloaded or spawned.',
      'A WORKSPACE ADMIN must create the OAuth app installation with',
      'least-privilege bot scopes; put the resulting token in SLACK_MCP_TOKEN.',
      'The header keeps a literal ${SLACK_MCP_TOKEN} placeholder in .mcp.json;',
      'ox expands it from your environment at runtime and never stores the token.',
    ].join('\n'),
  },

  whatsapp: {
    name: 'whatsapp',
    title: 'WhatsApp Business (Cloud API)',
    risk: 'write',
    desc: 'wbmp over WhatsApp Cloud API: send/receive messages on a business number.',
    requires: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
    entry: () => ({
      command: 'npx',
      args: ['-y', 'wbmcp@latest'],
      env: {
        WHATSAPP_ACCESS_TOKEN: '${WHATSAPP_ACCESS_TOKEN}',
        WHATSAPP_PHONE_NUMBER_ID: '${WHATSAPP_PHONE_NUMBER_ID}',
      },
    }),
    setup: [
      'TERMS OF SERVICE WARNING:',
      '  Only WhatsApp Business Platform (Cloud API) numbers are supported.',
      '  Personal-account bridges/modulos VIOLATE WhatsApp ToS and carry a real',
      '  permanent-ban risk — do not point this at a personal number.',
      'Get WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID from',
      'developers.facebook.com; both expand from env at runtime.',
    ].join('\n'),
  },

  telegram: {
    name: 'telegram',
    title: 'Telegram userbot',
    risk: 'write',
    desc: '@overpod/mcp-telegram: automate a Telegram account over MTProto (userbot, not Bot API).',
    requires: [],
    entry: () => npx('@overpod/mcp-telegram'),
    setup: [
      'GRAY-ZONE NOTICE: this drives a personal Telegram account via the MTProto',
      'user-api ("userbot") protocol, which sits outside the official Bot API and',
      'may draw spam enforcement from Telegram. Prefer a Bot API token workflow',
      'when possible; keep automation rate-limited and human-initiated.',
    ].join('\n'),
  },

  booking: {
    name: 'booking',
    title: 'Booking.com demand intelligence',
    risk: 'read-only',
    desc: 'Booking.com hosted demand API MCP: travel search/pricing intel, read-only.',
    requires: [],
    entry: () => ({
      type: 'http',
      url: 'https://demandapi-mcp.booking.com/v1/mcp/8132308',
    }),
    setup: [
      'Requires an active Booking.com AFFILIATE partner status.',
      'The endpoint key embedded in the URL is account-bound — request your own',
      'endpoint via the affiliate program before relying on it in production.',
    ].join('\n'),
  },

  opentable: {
    name: 'opentable',
    title: 'OpenTable reservations',
    risk: 'money',
    desc: '@striderlabs/mcp-opentable: search restaurants and book tables (unofficial, browser-based).',
    requires: [],
    entry: () => npx('@striderlabs/mcp-opentable'),
    setup: [
      'UNOFFICIAL and browser-based — can break without notice when OpenTable',
      'changes their web flow.',
      'POLICY: reservations are money-risk class; ox confirms EVERY reservation',
      'with you before booking. Never let the agent auto-commit a table.',
    ].join('\n'),
  },

  alpaca: {
    name: 'alpaca',
    title: 'Alpaca trading',
    risk: 'money',
    desc: 'alpaca-mcp-server: market data and order placement against Alpaca (paper trading by default).',
    requires: ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'],
    entry: () => ({
      command: 'uvx',
      args: ['alpaca-mcp-server'],
      env: {
        ALPACA_API_KEY: '${ALPACA_API_KEY}',
        ALPACA_SECRET_KEY: '${ALPACA_SECRET_KEY}',
        ALPACA_PAPER_TRADE: '${ALPACA_PAPER_TRADE:-true}',
      },
    }),
    setup: [
      'PAPER DEFAULT: ALPACA_PAPER_TRADE expands to "true" unless you explicitly',
      'export it otherwise — keep paper mode until you have a tested reason.',
      'Keys live only in env (ALPACA_API_KEY / ALPACA_SECRET_KEY); ox never',
      'writes them to disk.',
      'Money-risk class: every order asks for approval first.',
    ].join('\n'),
  },

  coinbase: {
    name: 'coinbase',
    title: 'Coinbase agent MCP',
    risk: 'money',
    desc: 'Coinbase hosted agent MCP: portfolio reads and trades over Streamable HTTP.',
    requires: [],
    entry: () => ({
      type: 'http',
      url: 'https://agents.coinbase.com/mcp',
    }),
    setup: [
      'Use SCOPED API keys restricted to portfolio-read/trade only.',
      'NEVER grant withdrawal permissions to an agent key — transfers are out',
      'of scope by policy.',
      'Money-risk class: portfolio actions always ask before they execute.',
    ].join('\n'),
  },

  wechaty: {
    name: 'wechaty',
    title: 'Wechaty (WeChat / WhatsApp)',
    risk: 'write',
    desc: 'weixin-mcp: WeChat/Weixin automation via OpenClaw plugin. Send messages, read conversations, manage contacts.',
    requires: ['WEIXIN_AUTH'],
    entry: () => ({
      command: 'npx',
      args: ['-y', 'weixin-mcp@latest'],
      env: { WEIXIN_AUTH: '${WEIXIN_AUTH}' },
    }),
    setup: [
      'Uses weixin-mcp (OpenClaw Weixin plugin) for WeChat automation.',
      'Run `npx weixin-mcp login` once to authenticate via QR code.',
      'The WEIXIN_AUTH token is stored locally and expands from env at runtime.',
      'Supports WeChat Personal (via web protocol) and WhatsApp via Wechaty puppets.',
      'Sending messages is a write action — ox confirms before posting.',
    ].join('\n'),
  },

  'agent-reach': {
    name: 'agent-reach',
    title: 'Agent Reach (Internet Capability Layer)',
    risk: 'read-only',
    desc: 'agent-reach-mcp: 15+ internet platforms (Twitter, Reddit, YouTube, GitHub, Bilibili, XiaoHongShu, RSS, web search, etc.) via unified MCP tools. Zero API fees for most platforms.',
    requires: ['EXA_API_KEY'],
    entry: () => ({
      command: 'npx',
      args: ['-y', 'agent-reach@latest'],
    }),
    setup: [
      'Installs agent-reach-mcp which provides 8 MCP tools: doctor, read_url, search, trending, stock_quote, get_details, transcribe, install.',
      'Run `npx agent-reach doctor` to check which platforms are active.',
      'Optional: set EXA_API_KEY for AI semantic web search (free tier available).',
      'Optional: configure Twitter/X and XiaoHongShu cookies for authenticated access.',
      'Zero config for: Web (Jina Reader), YouTube, GitHub (gh CLI), RSS, Exa Search, V2EX, Bilibili (basic).',
      'All read operations — ox does not auto-execute write actions.',
    ].join('\n'),
  },

  voice: {
    name: 'voice',
    title: 'Voice Agent (STT + TTS + Dictation)',
    desc: 'Local-first voice agents: speech-to-text, text-to-speech, voice cloning, push-to-talk dictation, and real-time bidirectional conversation. Backends: whisper.cpp, faster-whisper, Vosk (STT); Kokoro, Bark, Edge-TTS, Piper (TTS). Cloud fallbacks: ElevenLabs, OpenAI.',
    risk: 'write',
    requires: [],
    setup: [
      'Install a STT backend (whisper.cpp: https://github.com/ggerganov/whisper.cpp)',
      'and a TTS backend (Kokoro: https://github.com/neihy/kokoro-tts).',
      'Set VOICE_STT_BACKEND=whisper|faster-whisper|vosk',
      'and VOICE_TTS_BACKEND=kokoro|bark|edge-tts|piper.',
      'For cloud fallbacks, set VOICE_API_KEY.',
      'Use VOICE_LOCAL_ONLY=1 to block all cloud calls.',
    ].join('\n'),
    entry: () => ({ command: 'node', args: ['-e', "import('./voice-mcp.js').then(m => m.createVoiceMcpServer().start())"] }),
  },

  video: {
    name: 'video',
    title: 'Video Generation Studio (T2V/I2V/V2V)',
    desc: 'Higgsfield-class video generation: text-to-video, image-to-video, video-to-video. OSS models: Open-Sora, Wan2.1, HunyuanVideo, CogVideoX, LTX-Video, Mochi. ComfyUI orchestration. Cloud fallbacks: Kling, Runway, Veo, Minimax.',
    risk: 'money',
    requires: ['VIDEO_API_KEY'],
    setup: [
      'For OSS: install ComfyUI (https://github.com/comfyanonymous/ComfyUI) and a video model.',
      'Set VIDEO_BACKEND=comfyui|opensora|wan.',
      'For cloud: set VIDEO_API_KEY and VIDEO_BACKEND=kling|runway|veo|minimax.',
      'Set VIDEO_LOCAL_ONLY=1 to block cloud.',
      'Use VIDEO_WATERMARK=1 to disclose synthetic media.',
    ].join('\n'),
    entry: () => ({ command: 'node', args: ['-e', "import('./video-mcp.js').then(m => m.createVideoMcpServer().start())"] }),
  },

  aas: {
    name: 'aas',
    title: 'AAS Core — Agentic Skill Catalog & Stack Manager',
    desc: 'Agent-first control plane for the 2,122+ skill catalog: search skills, inspect SKILL.md files, compose and validate a stack, produce an immutable install plan, and review selection evidence. Read-only by default — install actions require explicit approval.',
    risk: 'read-only',
    requires: [],
    setup: [
      'AAS Core is built into ox. No external install needed.',
      'The MCP exposes search_skills, get_skill, list_skill_files, read_skill_file,',
      'compose_stack, inspect_stack, diff_stack, export_selection_evidence,',
      'and inspect_selection_evidence.',
      'Set OX_AAS_CATALOG_SOURCE=npm|github|local to choose how the catalog is loaded.',
      'Use `ox aas hosts` to see supported agent hosts',
      '(Codex, Cursor, Gemini, Claude, Antigravity, Kiro, OpenCode, Copilot, Autohand, AdaL).',
    ].join('\n'),
    entry: () => ({ command: 'node', args: ['-e', "import('./aas-mcp.js').then(m => m.createAasMcp([]).start())"] }),
  },

  'browser-harness': {
    name: 'browser-harness',
    title: 'Browser Harness (browser-use/browser-harness)',
    risk: 'write',
    desc: 'browser-use/browser-harness: browser automation harness for AI agents — navigate, click, fill, screenshot, scrape.',
    requires: [],
    entry: () => npx('browser-use/browser-harness@latest'),
    setup: [
      'Runs a dedicated browser with an ISOLATED profile — your daily browser',
      'cookies/sessions are not shared with the agent.',
      'First run downloads the bundled Chromium (~150MB).',
      'Cap the blast radius with capability flags, e.g.:',
      '  args: ["-y","browser-use/browser-harness@latest","--caps","navigate,screenshot"]',
      'See the browser-harness docs for the full capabilities list.',
    ].join('\n'),
  },

  stagehand: {
    name: 'stagehand',
    title: 'Stagehand (browserbase/stagehand)',
    risk: 'write',
    desc: 'browserbase/stagehand: LLM-powered browser automation — navigate, act, observe, extract structured data.',
    requires: [],
    entry: () => npx('@browserbasehq/stagehand-mcp@latest'),
    setup: [
      'Stagehand wraps a Playwright-backed browser with LLM-driven action/observation.',
      'Runs a dedicated browser with an ISOLATED profile — your daily browser',
      'cookies/sessions are not shared with the agent.',
      'First run downloads Chromium (~150MB).',
      'Cap the blast radius with capability flags, e.g.:',
      '  args: ["-y","@browserbasehq/stagehand-mcp@latest","--caps","navigate,screenshot"]',
      'See the Stagehand docs for the full capabilities list.',
    ].join('\n'),
  },

  unity: {
    name: 'unity',
    title: 'Unity Engine MCP (IvanMurzak/Unity-MCP)',
    risk: 'write',
    desc: 'IvanMurzak/Unity-MCP: Unity Editor integration — read/edit scenes, assets, components, and run tests from an agent.',
    requires: [],
    entry: () => npx('@unity/mcp@latest'),
    setup: [
      'Connects to a running Unity Editor instance over a local socket.',
      'Requires the Unity-MCP package installed in your Unity project.',
      'Read/write access to the Editor — can mutate scenes, assets, and project settings.',
      'Only safe against a dedicated test/sandbox project; never point it at a shipped build.',
      'Run the Unity Editor with the MCP server enabled before invoking.',
    ].join('\n'),
  },

  trawl: {
    name: 'trawl',
    title: 'Trawl (germondai/trawl)',
    risk: 'read-only',
    desc: 'germondai/trawl: read-only web research and information retrieval MCP.',
    requires: [],
    entry: () => npx('trawl@latest'),
    setup: [
      'Read-only class: fetches and summarizes web content, no external mutations.',
      'Runs entirely locally — no cloud dependency for basic retrieval.',
      'Optionally configure a search provider API key for enhanced results.',
    ].join('\n'),
  },

  camoufox: {
    name: 'camoufox',
    title: 'Camoufox (anti-detect Firefox)',
    risk: 'write',
    desc: 'Camoufox: stealth Firefox browser with realistic fingerprints for anti-detection automation.',
    requires: [],
    entry: () => npx('@camoufox/mcp-server@latest'),
    setup: [
      'Stealth Firefox builds with realistic browser fingerprints.',
      'Bypasses bot detection for web automation.',
      'Configure via CAMOUFOX_MODE (stealth/normal) and CAMOUFOX_RANDOMIZE (true/false).',
      'Pairs with browser-harness or stagehand for full automation.',
    ].join('\n'),
  },

  backboard: {
    name: 'backboard',
    title: 'Backboard.io Platform',
    risk: 'read-only',
    desc: 'Backboard.io hosted MCP: read-only access to the Backboard platform over Streamable HTTP.',
    requires: [],
    entry: () => ({
      type: 'http',
      url: 'https://backboard.io/mcp',
    }),
    setup: [
      'Hosted endpoint — nothing is downloaded or spawned.',
      'Requires an active Backboard.io account and API access.',
      'Read-only by policy: inspect and query, no writes to platform state.',
      'The endpoint key is account-bound — request your own access token before relying on it.',
    ].join('\n'),
  },
};


export function getTemplate(name) {
  const key = String(name ?? '').trim();
  return Object.prototype.hasOwnProperty.call(MCP_TEMPLATES, key) ? MCP_TEMPLATES[key] : undefined;
}

export function riskOf(name) {
  return getTemplate(name)?.risk ?? null;
}
