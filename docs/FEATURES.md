# Every ox feature, tested

The working list. Each feature: what it does, how it was checked, its state.
**✓** tested for real (how is written next to it) · **~** works with a named gap ·
**✗** broken or missing · **?** not tested yet. Nothing is ✓ without a run.
Work goes top to bottom through the ~, ✗ and ? rows, each one: test, fix, test again.

Updated October 16 2026.

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
| 2.5 | Coding runs (with tools) are leaner | ? | Not measured yet: tool rules and subagent text still sent when the subagent tool is not offered |
| 2.7 | Short questions the mode guesser reads as a change | ✓ | "Name the capital of Australia" 2,115 → 255 tokens |
| 2.8 | Tools on demand (load_tools, after Anthropic's Tool Search) | ✓ | A narrowed offer lists the rest by name; the model loads one itself and the next request carries it (tested with a stand-in model) |
| 2.6 | Follow-up suggestions cost | ✓ | Off by default (one extra call); switch in Settings › General |

## 3. Answers as interface (OpenUI)

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 3.1 | OpenUI Lang answers render live while streaming | ✓ | Stand-in model page: forms, sliders, charts, drawings, segmented, buttons; loan maths exact |
| 3.2 | Page-style answers in colour (open-intelligent-ui ideas) | ✓ | Donut, area and bar charts, coloured badges, SVG drawings; app chrome stays black and white |
| 3.3 | Real local model writes it | ~ | qwen2.5:3b writes the language; its formulas are unreliable at 3B. Larger models not tested here (no keys) |
| 3.4 | Query() runs read-only tools only | ✓ | Route refuses anything outside read_file, list_dir, glob, grep |
| 3.5 | Photos in answers (SearchImage) and maps | ✗ | Not built |

## 4. Bots and agents

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 4.1 | Bots page: make, edit, rename, delete | ✓ | API + page tested; bad names and unknown models refused |
| 4.2 | Bot shapes and colours | ✓ | 13 shapes, 12 colours |
| 4.3 | A bot answers to its name | ✓ | "I am the critic, reviewing diffs…" |
| 4.4 | Group chat (bots check each other) | ~ | Fixed the empty second answer (the history ended on another bot's turn): skeptic now answers and responds to optimist. Open: the screen switched to an older chat while it answered |
| 4.5 | Subagents checking each other's progress | ~ | agent_status + mailbox exist for terminal runs; no live view in the app |

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
| 7.3 | Studio (images, video) | ~ | No provider key here to test generation |
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
| 8.3 | Live transcript as you speak (Pixie) | ✗ | Not built in the island |
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

## 9. Reliability

| # | Feature | State | Evidence / gap |
|---|---|---|---|
| 9.1 | Every tool has a resource class | ✓ | 15 of 25 were refused before; test guards it |
| 9.2 | Ollama streaming + tools swallowing answers | ✓ | Recovered with one non-streaming retry; tested |
| 9.3 | Unit suite | ~ | 1,800 pass; failures seen only under load 300+ (serve-settings, web-render timing) |
| 9.4 | Launch check | ✓ | 132/132 |
| 9.5 | Tests leaving files in your real home | ✗ | Three test-agent*.json in ~/.ox/agents; find the test that leaks them |

## Repos studied

| Repo | Licence | Taken |
|---|---|---|
| thesysdev/openui | MIT | The language ox's answers use |
| thesysdev/open-intelligent-ui | none (all rights reserved) | Ideas only, written from scratch |
| PrimeIntellect-ai/prime-agent | MIT | Cloned; study pending (next) |
| xai-org/grok-build | Apache-2.0 | Cloned; study pending (next) |
