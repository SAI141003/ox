# Every reference, and what ox did with it

Each screenshot, video and repo shared while building ox, the idea worth taking,
and where it stands. **done** = built and tested; **partial** = the core is in,
named parts are not; **not yet** = planned; **no** = deliberately not taken,
with the reason. Nothing here is marked done without a test or a real run.

## Apps and settings screens

| Reference | Idea | Status |
|---|---|---|
| Hermes desktop — settings (Model, Chat, Appearance, Providers › Accounts / API keys / Custom endpoints / Local models, Gateways, Shortcuts, Tools & Keys, Archived) | One settings window with search and every area reachable | **done** — 15 sections incl. Memory, Usage; search box |
| Hermes, Local models (RAM, "too big for this machine", Hugging Face search and download) | Show what fits, search HF, download | **done**: search from Settings › Providers, the model picker (Find a model on Hugging Face…) and Local models, and `ox hf`; real download tested |
| Hermes — Custom endpoints (any OpenAI-compatible URL, test, use for new chats) | Add your own endpoint from the app | **done** — Settings › Custom endpoints: add, Test (models + latency), Use, Remove; own key per endpoint; keyless on your network; tested against local Ollama |
| Hermes — Messaging (20+ channels, QR setup) | Phone channels with status | **partial** — Telegram, Discord; Slack/WhatsApp **not yet** |
| Hermes — Capabilities (skills with use counts, toggles, Skills Hub) | Browse skills, install from a hub | **done** — Capabilities view + Marketplace (Anthropic catalogues + GitHub agent-skills) |
| Hermes — Scheduled jobs with toggles | See and pause scheduled runs | **done** |
| Hermes — "couldn't start" recovery screen | Retry / repair / logs when the backend is down | **partial** — Retry on every settings error; no dedicated start-failure screen |
| Hermes — browser pane next to chat | Built-in browser | **no** — the agent has web tools; a browser pane needs Electron-level work, not worth it now |
| Claude app — settings (Appearance: theme, font size, width, motion; Time & focus; Reflect) | Personal appearance settings | **done** (appearance); Time & focus / Reflect **not yet** |
| Claude app — composer (model, effort, mic) | Model + mode in the composer | **done** (model, mode, mic); effort level **not yet** |
| Claude Code — ASCII-art idle animation (IMG_9268) | A living empty state | **not yet** |

## Agents and orchestration

| Reference | Idea | Status |
|---|---|---|
| Devin (site + video) | Live worklog, saved environment, PR→CI loop, Slack | **partial** — live plan checklist and learned test/build commands done; PR→CI loop **not yet** |
| Orchestrator.inc | Board of workers (working / needs you / review / merge), one branch each | **partial** — `ox kanban`, agent teams; no board view in the app yet |
| agenttrail | Live map of plan vs files | **done** — Project map (PLAN.md convention, ported, MIT) |
| GitBot | Reusable bots tied to repos, each with threads | **partial** — custom agents with modes/tools; no per-agent repo binding |
| Reason (video) | Agents and people in one place, Claudes talking to each other | **partial** — agent mailbox + `agent_status`; no team chat UI |
| the-delegation (3D office) | Agents shown at work | **partial** — island pixel office (2D) |
| Laminar | Traces, "agent stuck" alerts, evals | **partial** — usage log by model/agent/surface; no trace viewer yet |
| company-brain | Shared team memory in Slack | **no** for now — needs Slack; ox memory is personal + per project |
| Kilo modes | Ask / Plan / Code / Debug / Orchestrate, enforced | **done** |
| Paperclip-style agents; OpenDots / Grok Bot bots (your request: a Bots section) | Make and manage your own bots in the app | **done**: sidebar › Bots: make, edit, rename, delete; model, mode, tools, instructions; chat with one (it answers to its name); what each can run on, ready or not. Tested on local qwen2.5:3b |
| OpenDots / openmuse / openbot / grok-build / Grok Bot OS | Bots with their own tools, phone, voice | **done** for tools/phone/voice; see Island |

## OX Island (notch) — from Coucou, Pixie, Kodemon, Lintel, Glance

| Reference | Idea | Status |
|---|---|---|
| Coucou — other agents in the notch with Allow / Deny | Claude Code, Codex, Gemini, Cursor, Copilot | **done** — `ox hooks install <agent>` |
| Coucou — questions with option chips, live diff +N −M | Answer questions and see edits from the notch | **not yet** |
| Coucou — plan-usage gauges | Claude / Codex limits | **not yet** (needs your go-ahead: changes Claude Code's status line) |
| Coucou — mail widget, Stripe/Vercel/GitHub cards | Services at a glance | **partial** — mail tool; no service cards |
| Coucou / Glance (Murmure) — hold a key, speak, words pasted anywhere; dictionary; offline | Dictation everywhere | **not yet** (needs Accessibility + microphone permission, ~650 MB model) |
| Coucou — Notetaker | Call notes, speakers, summary | **not yet** |
| Coucou — "OK Coucou" wake word | Hands-free | **not yet** |
| Coucou — phone app / lock-screen approvals | Approve from the phone | **partial** — Telegram/Discord buttons |
| Pixie (video) — shows your words live as you speak | Live transcript in the island | **not yet** |
| Pixie — plays music, opens Reminders, draws on screen to explain | Real-world tasks + on-screen annotation | **partial** — Mac control tools; on-screen drawing **not yet** |
| Kodemon | Pet battles | **no** — a game, not an agent feature |
| Lintel | Feature switches, idle CPU budget, keys in OS keychain | ideas only (GPL-3.0, no code copied); keychain storage **not yet** |

## Memory, learning, speed

| Reference | Idea | Status |
|---|---|---|
| Supermemory, Zep, Mem0, Generative Agents (papers) | Facts that update with history, dates, forgetting, ranked recall, profile | **done** — memory graph, `ox memory`, Settings › Memory |
| Darwin Gödel Machine | ox improves its own code, judged by tests | **written, not enabled** — waiting for your permission |
| book-to-skill | Turn a book/PDF into a skill | **not yet** |
| alphainsider "install the skill from this GitHub link" | Install a skill by asking in chat | **done** — `install_skill` tool (scanned, asked first) |
| Token use (your request) | Fewer tokens, usage shown everywhere | **done** — focused skill index, truncation warning, `ox usage`, Settings › Usage |
| Incognito (your request) | Private mode | **done** — `--incognito`, ⌘⇧N in the app |
| Your own name for ox (your request; Pixie answers to its name) | Rename ox and your agents; it answers to the name when you say it mid-conversation | **done** — Settings › General, `ox name`, `ox agent rename`; prompt, app and island use it; tested on local qwen2.5 (“My name is Nova”) |
| Cursor (your request) | Black and white only, light and dark; logo made from the name | **done**: monochrome tokens (red kept only for errors), new `ox` mark (the x's arms rise into horns), app icon, favicon, launch screen that draws the mark |

## Media and other repos

| Reference | Idea | Status |
|---|---|---|
| open-higgsfield | 38 image/video models, one composer, gallery | **done** — OX Studio, `ox create`, `create_media` tool; plus fal, OpenAI, local SD |
| GPT-6 / OpenUI interactive answers | Answers drawn as interface | **done**: the app draws `ox-ui` blocks (form with live formulas, table, cards, stats, steps, chart, follow-up buttons) and OX Canvas from the `show_ui` tool with its own components; no model-written code runs. Tested on local qwen2.5:3b (loan calculator, $1,798.65 for $300k at 6% over 30 years). html-live stays as the sandboxed fallback |
| Recordly | Demo videos | **no** (AGPL; a recorder, not an agent feature) |
| ManimGX | 3D math animation | not yet (could be a skill) |
| REA (reverse engineering MCP) | MCP add-on | listed in the Marketplace via GitHub search; not bundled |
| Cua | Agent desktops/VMs | **no** for now |
| NVIDIA vision agent, Awesome Fly | — | **no** (off-topic) |
| VoxCPM | Natural TTS, voice cloning | **done** as optional engine (`ox speak --engine voxcpm`) |
| Handy / Cactus Whistle | Offline speech | **no** — licence unverified |
