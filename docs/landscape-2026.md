# ox in the October 2026 landscape

What the other agents do, what ox does, measured where it can be measured and
sourced where it cannot. Claims about other products come from their own
pages or launch coverage (links at the end) and can change week to week; ox's
numbers are measured on a MacBook (M3, 16 GB, Node 22) with the scripts noted.
Nothing here is a guess dressed as a fact: where a thing could not be checked,
it says so.

## Two kinds of agent

**Coding agents** live in a terminal or editor and change code: Claude Code,
Codex CLI, Gemini CLI, Cursor CLI, Copilot CLI, Grok Build (xAI), Muse Code
(Meta), Qwen Code, Kimi CLI, and the open-source opencode, aider, goose, Crush,
OpenHands, Cline/Kilo.

**Always-on personal agents** take a goal, keep working in the background, and
answer you in a chat app: OpenAI Dots (Sept 29 2026), Meta Muse (Sept 8 2026,
modelled on OpenClaw), Grok Bot, Hermes Agent (Nous Research), OpenClaw.

ox is the first kind and now does the core of the second: a phone channel,
background runs that keep the machine awake, memory, and approvals that follow
you to the phone.

## ox, measured

| | ox | how measured |
|---|---|---|
| `ox --version` | 41 ms | median of 7, `scratchpad/speed.mjs` |
| start to first model request (`ox -p`) | 270–310 ms | instant local provider, median of 7 |
| a whole short turn | ~310 ms | same |
| source size | 2.9 MB (`src` + `bin`), zero npm dependencies | `du` |
| package | 12.1 MB packed / 14.4 MB unpacked (includes the island art and skills) | `npm pack --dry-run` |
| unit tests | 1,735 pass, 0 fail | `node scripts/verify.mjs --only unit` |
| deterministic benchmark | 25/25 | `node bench/runner.mjs` |
| fresh-user launch check | every command and slash command, 0 crashes | `node scripts/launch-check.mjs` |

Competitors' startup times were not measured here (their CLIs are not
installed and working on this machine), so none are claimed.

## Feature by feature

✓ has it · ~ partly · ✗ not · ? not verified

| | ox | Claude Code | Codex CLI | Gemini CLI | opencode | Grok Build | Muse Code | Hermes | OpenClaw | Dots / Muse |
|---|---|---|---|---|---|---|---|---|---|---|
| Any model / provider | ✓ 22 providers + local | ✗ Claude only | ~ OpenAI-first | ~ Google-first | ✓ 75+ | ~ xAI-first | ✗ Muse Spark | ✓ | ✓ | ✗ own models |
| Use a plan you already pay for | ✓ 16 CLIs (`ox connect`) | n/a | n/a | n/a | ✓ Claude login | n/a | n/a | ? | ? | n/a |
| Modes (ask / plan / debug / orchestrate) enforced at the tool gate | ✓ + auto-routing | ~ plan mode | ~ approval presets | ~ | ✓ plan/build | ✓ plan | ? | ? | ✗ | ✗ |
| Your own agents (bot + mode + instructions) | ✓ `ox agent new` | ✓ subagent files | ? | ? | ✓ | ? | ? | ✓ | ✓ | ✓ named dot |
| Parallel subagents | ✓ | ✓ | ✓ | ? | ✓ | ✓ | ✓ | ✓ | ? | ✓ |
| Each agent sees only the tools you grant | ✓ `--tools`, refusals name the grant | ✓ per-subagent tools | ? | ? | ✓ | ? | ? | ? | ? | ✓ (OpenBot/OpenDots per-bot tools) |
| Watch a page for changes / prices | ✓ `ox watch`, desktop + phone alerts, no model | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ? | ✓ (OpenMuse goals & tracking) |
| Agents check on each other live | ✓ `agent_status` + mailbox | ? | ✗ | ? | ? | ? | ? | ? | ? | ? |
| Several models race, best change wins | ✓ `ox arena` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| OS sandbox | ✓ macOS/Linux | ✓ | ✓ macOS/Linux/Windows | ✓ | ? | ? | ? | ✗ | ✗ | cloud VM |
| Hooks, skills, MCP | ✓ (imports Claude Code plugins) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (imports Claude/Codex skills) | ✓ | ✓ 100+ skills | plugins |
| Memory that persists and is screened for secrets | ✓ | ✓ | ~ | ✓ | ? | ? | ? | ✓ learning loop | ✓ | ✓ |
| Phone / chat-app channel | ✓ Telegram, Discord | ~ remote control | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ WhatsApp/Telegram/Discord | ✓ ChatGPT/Slack/Teams/WhatsApp |
| Approvals on the phone | ✓ Allow/Deny buttons | ? | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ? | ✓ |
| Keeps working when you walk away | ✓ local, holds the machine awake | ~ | ~ cloud | ✗ | ✗ | ✗ | ✓ background | ✓ | ✓ | ✓ cloud computer |
| Desktop presence | ✓ notch island (Mac) + top bar (Windows/Linux): chat with your agents as faces, approvals, file shelf | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | app |
| Voice | ✓ push-to-talk, on-device speech | ✓ | ? | ? | ✗ | ? | ✓ | ? | ? | ✓ |
| Email from the right account | ✓ from must match Mail, draft default | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ✓ | ✓ |
| Small tasks with no AI and no internet | ✓ `ox do` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Telemetry | none | yes (opt-out) | ? | yes (opt-out) | ? | had a data-upload incident (July 2026) | contributor tier trains on your data | ? | none | cloud |
| Windows | ✓ (Git Bash or PowerShell, named-pipe IPC) | ✓ | ✓ | ✓ | ✓ | ? | ✗ macOS/Linux | ? | ✓ | web/app |
| Licence | MIT | proprietary | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 (no outside contributions) | proprietary | MIT | MIT | proprietary |

## The app, memory and island, against Hermes, Claude, Coucou and Devin

Hermes desktop and the Claude app are judged from screenshots of the real
apps (October 2026); Coucou from its MIT source and changelog (0.5.0, October
15 2026); Devin from its site and a demo video. "?" means it was not visible.

| | ox | Hermes desktop | Claude app | Coucou | Devin |
|---|---|---|---|---|---|
| Sessions sidebar: pinned, ages, search | ✓ + your terminal sessions, read-only, continue in a chat | ✓ | ✓ | n/a | ✓ |
| Settings with search | ✓ 14 sections | ✓ 17 sections | ✓ | ✓ sidebar | ? |
| API keys pasted in the app | ✓ 0600 file, last 4 chars shown, shell keys win | ✓ | n/a | ✓ (chat keys) | n/a |
| Use a subscription you already pay for | ✓ found on this machine | ✓ Nous Portal, Anthropic OAuth | n/a | ✓ plan-usage gauges | n/a |
| Local models: what fits this machine | ✓ RAM, running servers, fit / too big | ✓ + Hugging Face search and download | ✗ | ✓ chat with Ollama / LM Studio | ✗ |
| Skills / plugins marketplace | ✓ catalogue plugins + GitHub agent-skills, safety scan, pinned commits | ✓ Skills Hub, 100k skills | ✓ | ✗ | ✗ |
| Memory: new facts replace old ones, with history | ✓ temporal graph | ✓ learned skills | ✓ memory | ✗ | ✓ knowledge |
| Memory: relative dates fixed, events expire | ✓ | ? | ? | ✗ | ? |
| Learns how a repo is tested and built | ✓ from commands that worked | ? | ✗ | ✗ | ✓ saved environment |
| Live plan / worklog | ✓ checklist ticks off as it works | ? | ✗ | ✓ step ticker | ✓ |
| Interactive answers (live widgets) | ✓ sandboxed html-live | ✗ | ✓ artifacts | ✗ | ✗ |
| Phone channels | ✓ Telegram, Discord | ✓ 20+ incl. WhatsApp, Slack, Signal | ✓ mobile app | ✓ iPhone / Android apps | ✓ Slack |
| Scheduled jobs with on/off | ✓ | ✓ | ✓ | ✗ | ✓ automations |
| Other agents' sessions in the island, approve there | ✓ Claude Code | n/a | n/a | ✓ 10+ agents | n/a |
| Dictation anywhere, notetaker, wake word | ✗ not yet | ✗ | ✓ voice | ✓ | ✗ |
| Cloud machine per session | ✗ runs on yours | ✓ Hermes Cloud | ✗ | ✗ | ✓ |
| Changes its own code, judged by tests | written, not enabled (needs your permission) | ✗ | ✗ | ✗ | ✗ |

## Where others are still ahead, plainly

- **Cloud computers.** Dots and Muse each get a cloud machine and browser that
  keep running with your laptop closed. ox runs on your machine: private and
  free, but it needs the machine on (`ox awake --lid` explains each OS).
- **Chat apps.** OpenClaw and Muse reach WhatsApp and more; ox reaches Telegram
  and Discord today (WhatsApp needs Meta's paid Business API).
- **App connectors.** Dots claims 4,000+ apps through plugins. ox reaches apps
  through MCP servers and its own tools (Mail, the OS), far fewer out of the box.
- **Windows sandbox.** Codex sandboxes on Windows (restricted tokens, ACLs); ox's
  OS sandbox is macOS and Linux.
- **Language servers.** opencode loads LSPs automatically so the model sees
  diagnostics; ox does not yet.
- **An approvals reviewer.** Codex can hand routine approvals to a reviewer
  subagent; ox auto-approves only read-only actions.
- **Windows island.** Built and tested by simulating Windows on a Mac; not yet
  run on a real Windows PC.
- **Hermes' channel count.** Hermes lists 20+ messaging channels (Slack,
  WhatsApp, Signal, iMessage, WeChat…) with QR setup; ox has two.
- **Coucou's voice layer.** Hold-a-key dictation anywhere with a personal
  dictionary, a call notetaker, and an "OK Coucou" wake word, all offline.
- **Small local models.** Tested here with Qwen2.5 1.5B on Ollama: chat works
  end to end, but the model never calls a tool even when asked directly, so it
  cannot drive an agent. A 7B coding model is the realistic minimum.

## The interface

Black and white, like Cursor (October 16 2026): dark is `#000000` background,
`#0A0A0A` sidebar, `#0F0F0F` panels, `#1F1F1F` lines, `#EDEDED` text, `#A1A1A1`
muted; light is the same in reverse on `#FFFFFF`. There is no accent colour:
the primary button is the text colour. Red (`#F2615C` dark, `#D93A35` light) is
kept for errors and deletions only. The island follows: white for "needs you"
(the brightest thing on screen), grey for working, red for errors, sessions told
apart by shade. The mark is the name: a ring for the o, an x whose arms rise
into horns (assets/logo-use.md).

Other products' exact colour values were not sampled, so they are not listed.

## Hermes Desktop, pane by pane (from its docs, checked October 16 2026)

✓ ox has it · ~ partly · ✗ not yet

| Hermes Desktop | ox app |
|---|---|
| Streaming with live tool activity, Markdown | ✓ plus answers drawn as interface (ox-ui, OX Canvas) |
| Shared history with the CLI | ✓ terminal sessions listed in the app |
| Model picker, favourite models, reasoning-effort pill | ~ model picker with Hugging Face search; no favourites or effort pill |
| Context-usage meter, tokens per second | ~ tokens per chat shown; no live meter |
| Up/down prompt history, find in page, timeline rail | ✗ |
| Preview rail for pages, files, tool output; annotate mode | ✗ |
| Artifacts gallery | ~ Studio gallery for images and video only |
| Tabs, several windows, terminal pane | ✗ |
| Live subagents frame with steer and stop | ~ agents report to each other (agent_status, mailbox); no frame in the app |
| Bot mode: roster of bots, @mention handoffs, group chats | ~ Bots page and chatting with a bot; no @mention handoff or group chat |
| Git review pane: diffs, staging, commits, PRs, worktree lanes | ✗ in the app (the agent does git itself) |
| Memory graph you can zoom and edit | ~ Settings › Memory lists, edits and forgets facts; no graph view |
| Skills with on/off toggles, catalogue, Skills Hub links | ~ Capabilities and Marketplace; no per-skill toggle |
| Routines (cron): pause, resume, edit, delete, run history | ~ create, pause and resume; no edit, delete or history in the app |
| Profiles with export and import | ✗ |
| Gateways: local, remote, cloud, SSH | ~ `ox serve` with a key for remote; no switcher |
| Voice: dictation, read aloud, wake word, voice conversations | ~ dictation and read aloud (Kokoro natural voice); no wake word or voice conversation |
| Providers: accounts, keys, custom endpoints with transport choice, local models | ✓ accounts, keys, custom endpoints with Test, local models with Hugging Face search; no transport choice |
| Themes, fonts, UI languages | ~ light and dark, text size and width; no presets, fonts or languages |
| Quick entry hotkey, HUD bar | ✓ OX Island in the notch |
| Command palette, rebindable shortcuts | ~ fixed shortcuts; no palette |
| Keep awake, reopen last chat, auto updates | ✓ keep awake; ~ the rest |
| Failure cards with retry and logs | ~ Retry on every page error |

## Grok Bot (xAI, beta August 11 2026)

A cloud computer per bot (browser, files, terminal), its own logins to your
tools, computer use for sites with no API, several bots handing work to each
other, and teaching a workflow by showing it. Beta for SuperGrok Heavy and some
Cursor plans; no published pricing or reliability data. ox runs on your own
machine instead, reaches sites through its web tools and Mac control, and its
bots hand off through the agent mailbox; teaching by demonstration is not built.

## Sources

- Meta Muse launch: [The National](https://www.thenationalnews.com/future/technology/2026/09/08/meta-muse-ai-agent/), [Fox Business](https://www.foxbusiness.com/technology/meta-introduces-muse-personal-ai-agent-can-send-emails-book-travel.amp), [TechRepublic](https://www.techrepublic.com/article/news-meta-muse-ai-agent-us-launch/)
- Muse Code: [Terminal Trove](https://terminaltrove.com/ai-coding-agents/muse-code/), [analysis](https://codex.danielvaughan.com/2026/08/06/meta-muse-code-beta-persistent-agents-codex-cli-terminal-agent-landscape-competitive-analysis/), [Composio](https://composio.dev/blog/muse-code-vs-codex)
- OpenAI Dots: [SF Standard](https://sfstandard.com/2026/09/29/openai-launches-dots/), [IT Brief](https://itbrief.co.uk/story/openai-launches-dots-always-on-ai-agents-for-work), [Bloomberg Tax](https://news.bloombergtax.com/private-equity/openai-unveils-always-on-ai-agent-dots-new-500-paid-tier)
- OpenClaw: [DigitalOcean](https://www.digitalocean.com/resources/article/what-is-openclaw), [Towards Data Science](https://towardsdatascience.com/use-openclaw-to-make-a-personal-ai-assistant/)
- Hermes Agent: [docs](https://hermes-agent.nousresearch.com/docs), [Inside Hermes Agent](https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving)
- Grok Build: [eWeek](https://www.eweek.com/news/xai-grok-build-coding-agent/), [DevOps.com on the upload incident](https://devops.com/xai-open-sources-grok-build-coding-agent-after-cloud-upload-exposes-ssh-keys-repos/), [open-source release](https://aiweekly.co/alerts/xai-open-sources-grok-build-cli-in-rust-resets-user-limits)
- Codex CLI sandbox and approvals: [guide](https://codex.danielvaughan.com/2026/03/26/codex-cli-approval-modes-sandbox-security), [approval framework](https://codex.danielvaughan.com/2026/04/08/codex-cli-approval-framework)
- Claude Code 2026 releases: [release tracker](https://www.havoptic.com/releases/claude-code/2026/10), [March roundup](https://pasqualepillitteri.it/en/news/381/claude-code-march-2026-updates)
- opencode: [package listing](https://community.chocolatey.org/packages/opencode/1.0.67)
- Osaurus: [GitHub](https://github.com/osaurus-ai/osaurus)
- CopilotKit templates read for ideas (all MIT, no code copied): [OpenDots](https://github.com/CopilotKit/OpenDots), [OpenMuse](https://github.com/CopilotKit/openmuse), [OpenBot](https://github.com/CopilotKit/openbot); xAI [grok-build](https://github.com/xai-org/grok-build) (Apache-2.0)
- Hermes Desktop: [docs](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), [Decrypt](https://decrypt.co/369952/hermes-ai-agent-official-app-terminal), [AI Weekly](https://aiweekly.co/alerts/nous-research-ships-hermes-desktop-across-mac-windows-linux)
- OpenAI Dots: [SiliconANGLE](https://siliconangle.com/2026/09/29/openai-launches-dots-always-on-ai-agents-in-chatgpt-with-their-own-cloud-computers/), [TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)
- Meta Muse: [TechCrunch](https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/), [Engadget](https://engadget.com/2253133/meta-reveals-its-ai-agent-that-can-shop-send-emails-and-plan-trips-on-your-behalf/)
- Grok Bot: [KuCoin News](https://www.kucoin.com/news/flash/xai-launches-grok-bot-ai-agent-with-its-own-computer-for-cross-app-task-automation), [Mem0 guide](https://mem0.ai/blog/grok-bot-guide)
- OpenClaw releases: [ClawHub marketplace (2026.3.22)](https://www.createwith.com/tool/openclaw/updates/openclaw-2026322-launches-clawhub-plugin-marketplace-and-expands-agent-capabilit), [2026.6.6](https://www.createwith.com/tool/openclaw/updates/openclaw-202666-tightens-security-and-speeds-up-agent-response-times)
