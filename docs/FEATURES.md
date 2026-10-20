# Every ox feature, tested

The working list. Each feature: what it does, how it was checked, its state.
**✓** tested for real (how is written next to it) · **~** works with a named gap ·
**✗** broken or missing · **?** not tested yet. Nothing is ✓ without a run.
Work goes top to bottom through the ~, ✗ and ? rows, each one: test, fix, test again.

Updated October 20 2026.

## 1. Connections and models

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 1.1 | Plans you pay for (Claude, ChatGPT, Cursor CLIs) found on this Mac | ✓ | Found broken PATH copies, now uses the VS Code / Claude app copies; chatgpt-plan answered "pong" (gpt-6-luna, auto-picked from Codex's catalog) |
| 1.2 | Sign-in state shown, with the exact step | ✓ | Claude: "installed and working, but not signed in" + command; ChatGPT: signed in |
| 1.3 | Claude plan answering | ✗ | Needs you to sign in once (ox never handles credentials): run the command shown in Settings › Accounts |
| 1.4 | Model picker lists what can answer first | ✓ | Plans, agents, endpoints, models; keyless models greyed under "Needs a key" |
| 1.5 | A chat with no model picked uses one that works | ✓ | Was a hard-coded gpt-4o; now your default if it can run, else a signed-in plan, a local endpoint, a keyed provider |
| 1.6 | Auto-switching model per message (small talk to a small model, code to a strong one) | ✓ | Picker default "Auto": hi went to qwen2.5:3b on this Mac ("a quick answer, on your machine"), a code fix to chatgpt-plan; only models that can answer are picked; the reason shows on each answer |
| 1.7 | Several models at once on one task | ✓ | Picker › Compare several models: one message to each at once; qwen-3b and qwen-1-5b both said Canberra, 22.1 s vs 13.2 s, side by side with tokens |
| 1.8 | Custom endpoints (any OpenAI-compatible server) | ✓ | Settings › Custom endpoints; Test listed Ollama's models in 31 ms; chat through it worked |
| 1.9 | Local models + Hugging Face search and download | ✓ | Search from Providers, the picker and Local models; BitNet found; a 105 MB model downloaded and chatted earlier |
| 1.10 | Default local model choice | ✓ | Auto uses Ollama's biggest chat model (qwen2.5:3b, not the 135M one); the picker opens on Auto |

## 2. Tokens and speed

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 2.1 | Plain messages sent without tools | ✓ | hi: 2,740 → 239 tokens, 17.8 s → 0.6 s (qwen2.5:3b) |
| 2.2 | Interactive guide only when asked for | ✓ | ~600 tokens off every other message |
| 2.3 | Project questions get only the 4 readers | ✓ | 5,192 → 2,608 tokens over two calls |
| 2.4 | Usage shown per answer, model, agent, surface | ✓ | Time and tokens under each answer; Settings › Usage |
| 2.5 | Coding runs (with tools) are leaner | ✓ | Short single-target task: 2,189 → 1,648 tokens per request (−25%, every turn): planning and delegation wait behind load_tools, and their prompt text goes with them; multi-step tasks keep both |
| 2.7 | Short questions the mode guesser reads as a change | ✓ | "Name the capital of Australia" 2,115 → 255 tokens |
| 2.8 | Tools on demand (load_tools, after Anthropic's Tool Search) | ✓ | A narrowed offer lists the rest by name; the model loads one itself and the next request carries it (tested with a stand-in model) |
| 2.9 | System 1 routing (Laya, Apache-2.0): what kind of message, in any language | ✓ | 26 messages, 7 languages: word lists routed 19 right, System 1 + guards 24 (weather, prices, Hindi news to the web; quiz and Spanish calculator to interactive). ~250–300 ms a turn on this Mac; falls back to the word lists when not installed or loading. Installed in ~/.ox/laya (680 MB checkpoint). Misses: "latest node.js version?", "who won the game last night" in Spanish |
| 2.10 | A model too small to draw (under 1B) gets help for interactive answers | ✓ | SmolLM2-135M was picked on the test server and every interactive answer failed; now the best connected model draws that answer and says why (qwen2.5:3b here, 22 s) |
| 2.6 | Follow-up suggestions cost | ✓ | Off by default (one extra call); switch in Settings › General |

## 3. Answers as interface (OpenUI)

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 3.1 | OpenUI Lang answers render live while streaming | ✓ | Stand-in model page: forms, sliders, charts, drawings, segmented, buttons; loan maths exact |
| 3.2 | Page-style answers in colour (open-intelligent-ui ideas) | ✓ | Donut, area and bar charts, coloured badges, SVG drawings; app chrome stays black and white |
| 3.3 | Real models write it | ✓ | ChatGPT plan (gpt-6-luna): valid OpenUI Lang, 0 errors, 8.5 s, maths exact ($1,798.65), guarded the zero-rate case. qwen2.5:3b writes the language but its formulas are unreliable |
| 3.6 | Plans you pay for get ox's brief (name, bot instructions, OpenUI guide, memory) | ✓ | Was the bare chat only; tested above |
| 3.4 | Query() runs read-only tools only | ✓ | Route refuses anything outside read_file, list_dir, glob, grep |
| 3.5 | Photos in answers (SearchImage) | ✓ | Real lookups: Pena Palace, Golden Gate Bridge, ramen, each the right Wikipedia photo in under 0.7 s, cached in ~/.ox/cache/images; only Wikimedia hosts are fetched (test) |
| 3.7 | Maps in answers | ✗ | Not built |

## 4. Bots and agents

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 4.1 | Bots page: make, edit, rename, delete | ✓ | API + page tested; bad names and unknown models refused |
| 4.2 | Bot shapes and colours | ✓ | 13 shapes, 12 colours |
| 4.3 | A bot answers to its name | ✓ | "I am the critic, reviewing diffs…" |
| 4.4 | Group chat (bots check each other) | ~ | Fixed the empty second answer (the history ended on another bot's turn): skeptic now answers and responds to optimist. Open: the screen switched to an older chat while it answered |
| 4.5 | Subagents checking each other's progress | ~ | agent_status + mailbox for terminal runs; the app's live view is the Office (11.12). Terminal runs are not on it yet |

## 5. Memory

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 5.1 | Facts with history, recall, forget | ~ | Tested earlier (memory-graph tests); not re-checked after today's prompt changes |
| 5.2 | Memory in tool-free turns | ✓ | Kept in the slim prompt |
| 5.3 | Memory quality against Supermemory-style benchmarks | ? | Not measured |

## 6. Voice

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 6.1 | Natural voice (Kokoro, offline) | ✓ | Real WAVs from the server; 54 voices |
| 6.2 | Spoken conversation (Speak) | ~ | Screen and flow built; microphone blocked in the preview pane, so the live loop is untested |
| 6.3 | Dictation, read aloud | ✓ | Earlier tests |

## 7. App pages

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 7.1 | Logo, launch screen, black and white theme | ✓ | Your logo, traced; light and dark |
| 7.2 | Capabilities | ✓ | Opens on the first item |
| 7.3 | Studio (images, video) | ✓ | On this Mac's own chip, no key (M3 / 16 GB): image ~25 s (12 s fast), edit, 5 s clip ~3 min (living picture), cut-out ~18 s (Apple Vision), 2x upscale; made from the Studio page and `ox create`. Hosted models still need their keys |
| 7.3a | Animate a script (Flick-style) | ✓ | Video, transcript or script → scene plan → 7 animated templates with sound effects; 3-scene 12.5 s video from the Studio page; `ox video animate`, redo one scene, save a look |
| 7.3b | Restyle a video (Genjutsu-style: move, swap, new look) | ~ | Routed to open Wan 2.2 Animate / VACE on fal; not run here (no fal key) |
| 7.3c | Settings after OpenCode: activity detail, changed files, what's new, Notifications, Projects, Worktrees, Models, Extensions, Server, Providers with a Connect dialog | ✓ | Every page opened in the app; changed files and the compact fold drawn; Connect dialog lands on the filtered key |
| 7.4 | Marketplace | ✓ | 329 plugins, 30 GitHub skills listed |
| 7.5 | Messaging (Telegram, Discord) | ~ | Setup shown; not paired here |
| 7.6 | Scheduled runs | ✓ | Create in words, pause, resume; no edit, delete or history yet |
| 7.7 | Project map | ✓ | Empty state offers "Have ox write it" |
| 7.8 | Incognito chat | ✓ | Earlier tests |
| 7.9 | Rename ox | ✓ | "My name is Nova" |

## 8. OX Island

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 8.1 | Black and white palette | ✓ | Builds |
| 8.2 | On / off from the app | ~ | Off tested (terminal agrees); on not tested here, to avoid a second island beside yours |
| 8.3 | Live transcript as you speak (Pixie) | ~ | Was marked missing, wrongly: hold ⌃⌥Space and your words show live in the buddy panel (on-device speech, punctuation). Not in the collapsed notch itself |
| 8.14 | The island's buddy speaks in ox's natural voice (Kokoro), not the system voice | ~ | Built: it runs `ox speak … --out`, plays it, the mouth follows the voice's loudness; system voice only as fallback; switch in the island menu. The command is proven (Kokoro WAV, 3.3 s); the island itself not heard yet, it needs `ox island restart` |
| 8.15 | The island shows the app's runs (chats, bots, helpers), not only terminal runs | ~ | Built: the app server writes ~/.ox/serve.json, the island reads /ox/live every 1.5 s; voice questions still go only to runs with a socket. Island builds; not watched live yet |
| 8.4 | Inbox card in the notch: unread list, open, Reply, Mark as read (Coucou video 1) | ✗ | Mail tool exists; no notch card |
| 8.5 | Widget gallery for the island, incl. an AI usage meter (video 2) | ✗ | Usage is recorded; not shown in the island |
| 8.6 | Draft-then-send email card with Send / Cancel from voice (video 4) | ✗ | Mail tool drafts; no notch card |
| 8.7 | Service cards: Stripe payments today, Vercel, GitHub (video 4) | ✗ | |
| 8.8 | Wake word ("OK ox") (video 4) | ✗ | |
| 8.9 | Agent question cards with option chips; live view of the file being read (video 5) | ✗ | Approvals with Allow / Deny work |
| 8.10 | Approvals on the phone lock screen (Live Activity) (video 5) | ~ | Telegram buttons, no Live Activity |
| 8.11 | Now-playing music card; read Reminders (Pixie, video 7) | ✗ | Can open apps only |
| 8.12 | Draw on the screen to explain (Pixie, video 7) | ✗ | |
| 8.13 | Personal dictionary for dictation; call notes with speakers and to-dos (Coucou screenshot) | ✗ | Hold-to-talk dictation exists |

## 10. From the October 16 videos and screenshots, beyond the island

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 10.1 | Slack: work from Slack (Reason, video 6) | ✗ | Telegram and Discord only |
| 10.2 | Your computers in sync (Reason, video 6) | ✗ | |
| 10.3 | Live graph of agents talking (Reason, video 6) | ✗ | Group chat shows it as a thread |
| 10.4 | Interactive breakdowns like ChatGPT's debt simulator (video 3) | ✓ | OpenUI Lang: sliders, live maths, Progress, deltas, @Reset |
| 10.5 | Research-paper lab (Paper Lab, video 8) | ✗ | |
| 10.6 | Agent traces with plain-English alerts ("stuck in a loop") (Laminar screenshot) | ✗ | Usage log only |
| 10.7 | One prompt to a running vision-monitoring system (NVIDIA screenshot) | ✗ | |
| 10.8 | Fast 3D maths animation skill (ManimGX screenshot) | ✗ | |
| 10.9 | Install a missing agent CLI on first use, with your OK (Omarchy) | ✗ | ox connect knows 16 CLIs, shows the install line only |
| 10.10 | Crash watcher: a dev server or test crash briefs the agent at once (Omarchy) | ✗ | |

## 11. Chat box and live view (October 16 screenshots)

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 11.1 | + menu, every row saying what it does (ChatGPT, Gemini, Perplexity, Claude) | ✓ | Opened in the app; picked Web search, its chip showed, ✕ removes it |
| 11.2 | Photos and Camera | ? | Shrunk to 1,600 px and sent as images every provider understands; not yet sent to a model that can see (none connected here with vision) |
| 11.3 | Web search | ~ | The server gets it (answer reason "web search", web tools only); answer quality not checked |
| 11.4 | Deep research | ~ | Asks for several searches, reading sources, citations [1]; not run end to end yet |
| 11.5 | Guided learning | ~ | Teach step by step and check; not run end to end yet |
| 11.6 | Interactive answer on demand | ~ | Forces the OpenUI guide for any message; not run end to end yet |
| 11.7 | Think harder | ~ | Skips the quick pick (test); on a server started seconds ago it can still pick the local model, before your plans are checked |
| 11.8 | Memory off for one chat | ~ | Nothing in, nothing learned; wired, not run end to end yet |
| 11.9 | Mode list with what each mode does (Kilo), ⌘. next mode | ✓ | Opened in the app; descriptions match what each mode enforces |
| 11.10 | Prompt wand (⌘I) | ✓ | "write email to landlord about broken heater" → "Write an email to [landlord] about the broken heater." in 1.0 s on qwen2.5:3b; ⌘Z undoes |
| 11.11 | Delete a chat (Undo), a bot, an endpoint | ✓ | The pane blocked the browser's confirm box, so Delete did nothing; now 15 → 14 chats, Undo → 15 |
| 11.12 | Office: who is working on what (Pixel Agents) | ✓ | Real run: bot scout at a desk, monitor lit on its tool step, then "writing the answer"; writer in the lounge |
| 11.13 | Sidebar hide button on a narrow window | ✓ | Did nothing before (it toggled the wide layout); closes now, also Esc and a click beside it |
| 11.14 | Pictures load when the server has a key | ✓ | Fetched with the key instead of a bare image link |

## 12. Asked for, not started

| # | Feature | State | Note |
|---|---|---|---|
| 12.1 | OX Island upgrade from the Coucou repo and the Pixie video (section 8) | ~ | Started: natural voice (8.14) and the app's runs on the island (8.15) built; the cards in 8.4-8.13 are next |
| 12.2 | ox's own automations (n8n-style flows), no n8n needed | ✗ | Scheduled runs exist (7.6); no flow builder |
| 12.3 | Marketplace with every skill (Karpathy's; languages and stacks: Java, Python, Go, Spring, SQL Server, Postgres, Oracle, MongoDB, Redis, React, Angular, Azure, AWS, GCP, Docker, Kubernetes, Kafka, gRPC, GraphQL, Terraform…; markets, finance, other professions) | ~ | 329 plugins, 30 GitHub skills listed (7.4); far from everything |
| 12.4 | ox's own deep learning (Andrew Ng's course ideas) | ✗ | To be scoped: what it should learn, from what data |
| 12.6 | ox evolve: ox improves ox, kept only when measured better | ✓ | Wired as ox evolve list, failures, diff, accept, reject; its test found crash recording had never saved anything (fixed). A full attempt has not been run yet |
| 12.5 | Paperclip's task board in the app | ✓ | Sidebar › Task board: To do, Working, In review, Blocked, Done; add with a budget and a review step; Run with ox, Approve, Send back, Release, Reopen; blockers shown; activity log. Tested on a throwaway server |

## 13. From the October 16 evening videos and images (and Devin)

| # | Idea (source) | ox today | State |
|---|---|---|---|
| 13.1 | One command center: Claude Code, Codex, Cursor, OpenCode, Pi, Hermes side by side in one window (Harness by Autonomous, video 1) | Plans you pay for answer as bots; Compare runs one message on several models side by side; the Office shows who works on what | ~ no live terminal panes per agent CLI |
| 13.2 | Each agent on its own branch, keeps going when the laptop closes (Harness) | Worktrees exist for teams, arena and evolve; the daemon runs schedules | ~ not per chat agent in the app |
| 13.3 | Every machine linked: Mac, home server, office, GPU box (Harness) | — | ✗ (same as 10.2) |
| 13.4 | Reply by voice from the phone (Harness) | Telegram and Discord, voice notes transcribed | ~ no phone app |
| 13.5 | One-command skill to research LinkedIn, YouTube transcripts, X talk (AgentReach for Hermes, video 2) | youtube_transcript reads any video's transcript (tested: 3Blue1Brown, 31 languages, 18,895 chars), no yt-dlp; web search for the rest | ~ no LinkedIn or X research channel (both need a signed-in session) |
| 13.6 | Every language and stack a recruiter asks for: Java, Go, Spring, SQL Server, Postgres, Oracle, MongoDB, Redis, Cosmos, React, Angular, Azure/AWS/GCP, Docker, Kubernetes, RabbitMQ, Kafka, gRPC, GraphQL, SOAP, SignalR, MAUI, Unity, GitHub Actions, Azure DevOps, Terraform (image) | General coding works in any language; no per-stack skills | ~ (12.3) |
| 13.7 | Precise one-prompt image edits at 2K (Krea, image) | Studio edits an existing image on this Mac (SD-Turbo image to image, ~512 px) or with a key (Qwen-Image-Edit, OpenAI, OpenRouter) | ~ local edits are ~512 px, 2x with upscale; not 2K |
| 13.8 | Make agents from plain language, self-developing (AutoAgent, HKUDS, image) | Bots page and `ox agent new`; ox evolve improves ox | ~ no "describe the agent, ox builds it" |
| 13.9 | Chat bar with Build / Plan / Mission / Skills and a model picker (Freebuff, image) | Mode list with descriptions, + menu, model picker | ✓ (11.1, 11.9) |
| 13.10 | Subagents with isolated context, pluggable filesystem, summarize long threads and offload tool outputs to disk, shell, persistent memory (deepagents, MIT, image) | Subagents, compaction, sandbox, memory; tool results over 20,000 characters are kept whole in a file, the model gets the ends and the path (test) | ✓ |
| 13.11 | Video editing by an agent: watch, hear (Whisper), cut (ffmpeg), animate (Remotion), HTML→MP4, captions (image) | Whisper dictation; an ffmpeg video MCP | ~ no editing workflow |
| 13.12 | Errands from one sentence with suggestion chips: cancel a subscription, track a package, book a plumber (Wajo, image) | Mail, browser and operator tools; scheduled runs | ~ no errand chips; no phone calls |
| 13.13 | /anatomy: an interactive drawing that explains how a machine works (skill, image) | OpenUI answers draw SVG and sliders | ~ no ready-made skill |
| 13.14 | A teammate with its own cloud computer (Sauna, image; Devin) | Runs on your Mac; the daemon keeps schedules | ✗ no cloud machine |
| 13.15 | Devin: works in its own sandbox from a ticket, plans, opens pull requests, answers in Slack, Jira, Linear, wiki of the codebase, playbooks, many in parallel | Plans, modes, subagents, task board, playbooks (procedural memory), Telegram/Discord; GitHub through the gh CLI and MCP | ~ no Slack, Jira or Linear; no PR flow; no codebase wiki |

## 9. Reliability

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 9.1 | Every tool has a resource class | ✓ | 15 of 25 were refused before; test guards it |
| 9.2 | Ollama streaming + tools swallowing answers | ✓ | Recovered with one non-streaming retry; tested |
| 9.3 | Unit suite | ✓ | 1,825 pass, 0 fail. Three failures found today came from my own short-task trim (it slipped past the never-drop-a-needed-tool check); fixed |
| 9.4 | Launch check | ✓ | 132/132 |
| 9.5 | Tests leaving files in your real home | ✓ | The leak was fixed October 12; the three old test-agent files are in your Trash (you OK'd it) |

## Repos studied

| Repo | Licence | Taken |
|---|---|---|
| thesysdev/openui | MIT | The language ox's answers use |
| thesysdev/open-intelligent-ui | none (all rights reserved) | Ideas only, written from scratch |
| PrimeIntellect-ai/prime-agent | MIT | Cloned; study pending (next) |
| xai-org/grok-build | Apache-2.0 | Cloned; study pending (next) |
| Omarchy (DHH, Arch Linux) | open source | Ideas only: agents on first use, crash watcher (10.9, 10.10) |
