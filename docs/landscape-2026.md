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
| Phone / chat-app channel | ✓ Telegram | ~ remote control | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ WhatsApp/Telegram/Discord | ✓ ChatGPT/Slack/Teams/WhatsApp |
| Approvals on the phone | ✓ Allow/Deny buttons | ? | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ? | ✓ |
| Keeps working when you walk away | ✓ local, holds the machine awake | ~ | ~ cloud | ✗ | ✗ | ✗ | ✓ background | ✓ | ✓ | ✓ cloud computer |
| Desktop presence | ✓ notch island (Mac) + top bar (Windows/Linux): chat with your agents as faces, approvals, file shelf | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | app |
| Voice | ✓ push-to-talk, on-device speech | ✓ | ? | ? | ✗ | ? | ✓ | ? | ? | ✓ |
| Email from the right account | ✓ from must match Mail, draft default | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ? | ✓ | ✓ |
| Small tasks with no AI and no internet | ✓ `ox do` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Telemetry | none | yes (opt-out) | ? | yes (opt-out) | ? | had a data-upload incident (July 2026) | contributor tier trains on your data | ? | none | cloud |
| Windows | ✓ (Git Bash or PowerShell, named-pipe IPC) | ✓ | ✓ | ✓ | ✓ | ? | ✗ macOS/Linux | ? | ✓ | web/app |
| Licence | MIT | proprietary | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 (no outside contributions) | proprietary | MIT | MIT | proprietary |

## Where others are still ahead, plainly

- **Cloud computers.** Dots and Muse each get a cloud machine and browser that
  keep running with your laptop closed. ox runs on your machine: private and
  free, but it needs the machine on (`ox awake --lid` explains each OS).
- **Chat apps.** OpenClaw and Muse reach WhatsApp, Discord and more; ox's phone
  channel today is Telegram only.
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

## The interface

ox's colours are one palette across the island, the web island and the web
chat: text `#F5F6F8`, muted `#8E939C`, dim `#6B7079`, card `#141518` on black,
and three signal colours that always mean the same thing: amber `#F5A524` (ox
needs you), green `#34D399` (done), red `#F4505E` (failed). The terminal uses
the same meanings through ANSI colours and honours `NO_COLOR`.

Other products' exact colour values were not sampled, so they are not listed.

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
