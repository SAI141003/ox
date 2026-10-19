# OX Island (and ox) upgrade checklist

From the owner's videos and screenshots of October 16–17, 2026 and the latest
Coucou (`Louis-CFM/coucou`, MIT code, main at `434d6a2`, Oct 16), checked
against the island's own source. Coucou's name, Mochi, art and sounds are
reserved: its ideas and MIT code may be used, never its character.

States: ✓ the island has it · ~ partly · ✗ missing · → next to build

## A. From Coucou (latest)

| # | Feature | Island now | |
|---|---|---|---|
| A1 | Approve other agents from the notch: Allow / Deny / Always for Claude Code, Codex, Gemini CLI, Cursor, Copilot… (through each agent's hooks; installer shows the diff and keeps a dated backup) | ~ **built, not installed on this Mac**: `ox hooks install claude` (codex, gemini, cursor, copilot) | your step: run it once |
| A2 | Answer an agent's multiple-choice question (AskUserQuestion) in the notch | ✓ built: the Claude PreToolUse hook sends the question to the island, which shows a cyan card with the options; the choice goes back as the answer (tests in test/agent-hooks.test.js) | needs A1's install |
| A3 | Live diff ticker: each file an agent edits with +N −M; click opens the diff | ~ ox runs only | |
| A4 | Jump to the exact terminal window of a session | ✗ | |
| A5 | Plan usage: Claude 5-hour and weekly, Codex limits, reset times | ~ Codex real; Claude: **relay built** (`ox statusline`, installed with `ox hooks install claude`, keeps your own status line) | your step: same install |
| A6 | Integrations as pills/cards: GitHub (PRs, CI, reviews), Vercel, Stripe, n8n, Resend, Notion, Cal.com | ✗ | |
| A7 | Flow dictation: hold a key, speak, pasted anywhere | ✓ (⌃⌥D) | |
| A8 | Hands-free: two quick taps keep listening; Esc cancels; paste the last dictation again | ✓ double tap ⌃⌥D = hands-free, Esc cancels, ⌃⌥V pastes the last one again | |
| A9 | Styles: optional clean-up of a dictation by a model, per app (as said / natural / polished) | ✗ | → |
| A10 | Dictation statistics: words, time saved, words per minute, apps | ~ words and time saved, today and this week (~/.ox/dictation-stats.jsonl); per-app not yet | |
| A11 | Dictionary and snippets | ✓ | |
| A12 | Translate a dictation into ~70 languages; prompt mode | ✗ | |
| A13 | Parakeet offline speech (25 languages) | ✗ (Apple's on-device speech) | |
| A14 | Notetaker: the other side of the call too (system audio), speakers named, summary and to-dos | ✓ built: the call's sound recorded with ScreenCaptureKit, transcribed with whisper.cpp, merged by time as You / Them, summary and to-dos (transcription path checked; live capture needs Screen Recording access) | your step: allow Screen Recording once |
| A15 | The pill: see-through, bottom or side of the screen, toolbar on hover, voice level dots | ✗ | |
| A16 | Drop a file on the notch, ask about it or email it | ✓ (Shelf) | |
| A17 | Drag the character onto a window to give it as context | ✗ | |
| A18 | Character on the desktop, follows the cursor | ~ | |
| A19 | Open on hover; invisible when idle; any Mac and several displays | ~ | |
| A20 | Weekly recap (time, sessions, files, lines, top agent), shareable image | ~ Recap card: 7 days of tokens and cost per day, top model, words dictated, water estimate, Save as image; files/lines not yet | |
| A21 | Your own sounds (drop a file to replace one) | ✗ | |
| A22 | Character reacts to the Mac's load (stressed when hot or busy) | ~ worried ox past 80 % of a plan window (Claudex); Mac load not yet | |
| A23 | Capture shortcut (⌘⇧S) with a tick | ✗ | |
| A24 | 10 languages | ✓ English, Español, Français, Deutsch, Português, Italiano, 日本語, 한국어, 简体中文, हिन्दी (OxIsland --check-l10n: 61 strings, 0 missing) | |
| A25 | iPhone / Android: approvals from the phone, widgets, Live Activity | ✗ | needs a phone app |
| A26 | Chat in the notch with any provider, switchable | ✓ (Tray chat through ox) | |

## B. From the videos

**Clicky (farza): a screen buddy that writes for you**
| # | Feature | Island now | |
|---|---|---|---|
| B1 | Say what you want; it writes the reply into the focused text box (Gmail, Slides…) in your style | ✓ **new**: "write a reply saying…", "draft a post…": ox reads the screen and writes it in your voice, pasted where you type; never sent | checked: command matching; image to model real |
| B2 | Types a good follow-up prompt into Claude Code's terminal | ✓ **new**: "type a good follow-up prompt": pasted, Return never pressed, and the island says what it does | |
| B3 | Skills library (e.g. a Y Combinator advice skill) | ✓ in ox (Marketplace) | |
| B4 | "Hey <name>" wake phrase | ✓ ("OK ox", your chosen name) | |

**Claudex: the notch as a live usage meter**
| # | Feature | Island now | |
|---|---|---|---|
| C1 | Rings per tool: session %, week %, model-week %, each with a reset countdown | ~ | → |
| C2 | "4 sessions working", listed per project with model; "Codex idle for 3 m" | ✓ **new**: Claude Code (CLI, desktop Code tab, worktrees) and Codex sessions read from their own session files (read-only), in the notch (count of those working), the open island (project · what it does now / idle for N m) and the app's Office | checked: this session and two worktree sessions shown live |
| C3 | Alert before the limit, not after | ✓ **new**: a notification at 80 % and 95 % of each window, once per reset period | |
| C4 | Water estimate per tool (litres, days of drinking water) | ~ total in the Recap card: cloud tokens × 18 mL per 1,000 (Li et al. 2023), local models not counted; method shown on hover | |

## C. From the screenshots

| # | Item | What ox takes from it | |
|---|---|---|---|
| D1 | addyosmani/agent-skills (51k, MIT) | already in the Marketplace and installs | ✓ |
| D2 | affaan-m/ECC "Everything Claude Code" (311 skills, 71 sub-agents, MCP configs) | add as a Marketplace catalogue after its licence is checked | → |
| D3 | Paperclip (101k, MIT): run a company of agents | task board ✓, **`ox org`** ✓: org chart, hiring with approval, pause/resume, monthly budgets per agent, heartbeats that run assigned tasks through ox / Claude Code / Codex | ✓ |
| D4 | caveman-ai/trim-1: a 1.2 MB model that keeps only the log lines a question needs | token saving: query-aware trimming of long tool output (own implementation first, then the model if its licence allows) | → |
| D5 | Elorian Glimpse: a model that reasons over video | ox already reads YouTube transcripts; next: local video files (frames + speech) | |
| D6 | awesome-n8n-templates (280+) | import n8n templates into ox Automations | |
| D7 | Google Agent Development Kit + agents-cli (Apache-2.0) | Marketplace entry; run ADK agents as bots | |
| D8 | Fish Audio S2.1 Pro TTS (90 ms voice agent) | another voice for the island (needs its key) | |
| D9 | Tesser: worktrees with dev servers offloaded to cloud machines | later: remote backends for heavy runs | |
| D10 | "/hairline": a slash skill that draws diagrams (funnels…) | Interactive answers already draw charts; add diagram shapes | |
| D11 | DeepMind Polaris (evaluating coding agents), Polsia (agents replacing a team) | context: public, honest benchmarks matter; no feature | |

## Test of the island as it is (October 17, late)

| Check | Result |
|---|---|
| Island running on this Mac | ✓ since 18:41, built after its last source change |
| Island builds from source (`swift build -c release`) | ✓ 30 s, 2 harmless warnings |
| 18 no-AI requests (time, date, maths, apps, sites, "open chrome and youtube", play a song, music controls, volume, timer, note, to-do, to-dos today, unread mail, email draft), dry run through the running app | ✓ every one routed right, 0–9 ms |
| Requests that need real work ("open whatsapp and message all my friends") | ✓ handed to an agent |
| "make the island smaller" | ✓ handled in the island itself (Bridge.swift), no model |
| Questions on the local model (qwen2.5:3b, offline) | ✓ correct, 0.8–3.8 s |
| `~/.ox/island.log` | not created: no request has gone through the island since its restart (it logs only what it handles); needs one real try by you |
| Approving Claude Code / Codex from the notch | built, not installed (A1) |
| Claude plan usage | relay now built (A5), not installed |
| Live voice (Fn / ⌃⌥Space, mic), dictation pasting, call notes | need you at the Mac: speech and Accessibility cannot be driven from here |

## E. The owner's standing requests (October 18), cross-checked each round

| # | Request | State |
|---|---|---|
| E1 | Test the app like a person: every function, by clicking, not by API | → in progress |
| E2 | Uploads: videos are not accepted | ✓ any file now: a video becomes frames the model sees (checked in the app: a dropped video was described correctly), PDFs give their text, everything else its path |
| E3 | Interactive answers (OpenUI) must work every time, not once in a while: measure the rate, fix the failures | ~ **measured** (`bench/openui/run.mjs`, 10 prompts). 3B local model (qwen2.5:3b): 0/10 → 10/20 clean, and 20/20 draw something. Free OpenRouter model (laguna-s-2.1): 9/9 of the prompts it answered (the 10th hit the free tier's daily limit). Fixes: named args, bracket mending, implicit commas, extra args left out, True/False, @Divide-style builtins, interactive turns never wander into tools, and one repair round with the engine's errors. Not 100 % on a 3B model; a capable model is the way to "every time" |
| E4 | Better than Devin, and why (side by side, honest) | ✓ docs/VS_DEVIN.md; Devin's leads (cloud VMs, ticket→PR) listed as next |
| E5 | Use the repos from the screenshots (agent-skills, ECC, n8n templates, ADK, trim-1) | ~ D1 ✓, D4 ✓ (idea) |
| E6 | Use Paperclip fully (org chart, heartbeats, budgets, governance, adapters, sessions) | ✓ `ox org` (checked for real: a local-model agent woke, took its assigned task, wrote the file, task done). Still missing: a web page for the chart, comments and documents on tasks in the app |
| E7 | Keep this checklist current; go back and forth to cross-check | ✓ this file |

## F. The owner's October 18 batches (screenshots and screen recordings)

Every screenshot and recording sent on October 18, one line each. Nothing is ✓
until it has run for real. Licences are checked before any code is taken; for
AGPL, unlicensed or brand-protected work only the idea is used, in ox's own
code. Duplicates are noted where they appear.

States: ✓ done and tested · ~ partly · → building now · ✗ not yet · — context only, nothing to build

### F1. Screenshots: tools, repos and products

| # | Seen | What it is | What ox / the island gets | Licence | State |
|---|---|---|---|---|---|
| F1.1 | Krea | One prompt edits an image precisely, 2K in seconds | Studio "Edit image": pick an image, one prompt, edited image back (fal / OpenAI image edit), saved with its recipe | — | ✗ |
| F1.2 | HKUDS/AutoAgent (9.8k) | Build agents and teams from plain language | `ox org hire "<one sentence>"`: title, role, runtime, schedule and instructions filled in from the sentence | MIT | ✗ |
| F1.3 | Freebuff | Free coding agent; modes Build / Plan / Mission / Skills; "Open a PR" | ox is free with no ads. In the app: a one-click **Open a PR** after a change; modes as clear as theirs | — | ✗ |
| F1.4 | langchain-ai/deepagents (30k) | Sub-agents, pluggable filesystem, context summarising + offload, sandboxed shell, persistent memory | Each one exists in ox; check each works from the app and the island chat | MIT | ✗ check |
| F1.5 | "Claude can edit your videos" | Watch (frames), hear (Whisper), edit (ffmpeg), animate (Remotion, HTML→MP4), captions, yt-dlp, research | Uploads: frames ✓. Next: speech-to-text of an uploaded video/audio (local whisper), and "cut / caption / clip / speed up this" with ffmpeg from chat | — | ~ |
| F1.6 | Wajo | Errands in plain words: cancel a subscription, track a package, book a table | Island chips for everyday errands; ox drafts and finds, never sends or pays (owner rule) | — | ✗ |
| F1.7 | `/anatomy` skill | "Explain how a rocket engine works, interactive" | Interactive explainers: a diagram with clickable steps (Svg + Segmented) on a capable model | — | ✗ |
| F1.8 | Sauna.ai | "A teammate with its own cloud computer" | ox org agents run on the Mac; a remote runner later (same gap as Devin) | — | ✗ later |
| F1.9 | Devin (devin.ai) | Cloud or local; tests in its own browser; keeps going until the PR can merge; sidebar Automations / Security / Review / Wiki; a test recording in the PR | ox: a PR flow (branch → commit → PR → read and answer review comments), a browser test recording attached to the PR, a Wiki page from `ox graph` | — | ✗ |
| F1.10 | AlphaInsider/skills | "Install the strategy-creator skill from <GitHub URL>, confirm where it went and whether it is ready" | `ox skill install <github url>[#name]` from chat and the island; reports the path and a ready check | check | ✗ check |
| F1.11 | Glance / Murmure | Local dictation, instant, no subscription, "light that dances with your voice" | Island dictation is local ✓; add a voice-level glow on the notch while listening | — | ~ |
| F1.12 | the-delegation | A 3D playground where agents walk around an office | ox's Office (pixel office) ✓; idea: agents walk to the desk of the tool they use | check | ~ |
| F1.13 | company-brain | A Slack teammate that remembers everything the team says and does the work | ox gateways (Slack, Telegram, Discord) + memory; check a team channel's memory is kept per channel and searchable | Apache-2.0 | ✗ check |
| F1.14 | virgiliojr94/book-to-skill | Turns a book or folder of docs into a skill; 24–51× fewer tokens than pasting the book | `ox skill from <pdf|folder>`: chapters → a SKILL.md with an index and per-chapter files the agent loads on demand | MIT | ✗ |
| F1.15 | GPT-6 "Intelligent UI" | Split the bill, take photos after dark: answers you can use | ox Interactive answers (measured above) | — | ~ |
| F1.16 | Coucou "Hold fn, just talk" | Dictation, learns your words, notes of every call, offline, unlimited | Island dictation ✓, dictionary ✓; call notes mic only (A14); Fn hold as a trigger | MIT (ideas) | ~ |
| F1.17 | ManimGX | Fast 3D math animation engine for agents (Manim API) | Studio/video: "animate this explanation" through Manim when installed | MIT | ✗ |
| F1.18 | lmnr-ai/laminar | Agent observability: traces, plain-English signals ("agent stuck in a loop"), evals, SQL | ox run traces: every turn's tool calls and tokens kept and viewable; a loop / stuck signal raised to the island | Apache-2.0 | ✗ |
| F1.19 | NVIDIA "Build Vision Agent" | One prompt → a camera-monitoring system with alerts, search, incident reports | Idea only: a flow template "watch a folder of images/clips and alert" | — | — |
| F1.20 | Omarchy (DHH) | An agentic Linux desktop | Context; ox runs on Linux | MIT | — |
| F1.21 | `/page-mascot` skill | A character at the top of a page that follows the cursor and blinks when poked | The island character already follows the cursor (A18); add blink-when-poked | — | ~ |
| F1.22 | storytold/photocraft | A Photoshop rebuilt in Rust (early alpha) | Context: image editing stays in Studio (F1.1) | MIT/Apache | — |
| F1.23 | gitbot-hq/GitBot | Reusable bots running Claude Code / Codex / OpenCode on your repos, each with a job, a place and threads you return to | `ox org` agents ✓ (runtime, folder, instructions); add per-agent threads you can reopen in the app | MIT | ~ |
| F1.24 | Grok Bot "GPU night shift" | Agents scout / quant / risk / exec with you approving; "0 irreversible"; a timeline of who did what | `ox org` dashboard in the app: each agent's lane, approvals, an activity timeline, an "irreversible actions: 0" count | — | ✗ |
| F1.25 | OrchestratorInc/agent-orchestrator | Plan, run, supervise coding agents: a worktree per worker, PR / CI / review in a live Kanban | Task board ✓ + `ox org` ✓; add worktree per task and PR/CI state on the board | Apache-2.0 | ~ |
| F1.26 | sodiumsun/agenttrail | Live project map of what coding agents do: plans, tool calls, files, progress | Island live diff for ox runs ✓ (A3); extend to Claude Code / Codex through their hooks | MIT | ~ |
| F1.27 | awesome-fly | Fruit-fly connectome projects | — not related to ox | CC0 | — |
| F1.28 | trycua/cua | Desktops for agents: Cua Spaces, Lume VMs, desktop automation, computer-use bench | ox computer use on the Mac ✓ (operator); later: run risky computer-use inside a Lume VM | MIT | ~ |
| F1.29 | REA "Reverse Engineer Anything" | One MCP for reverse engineering | Marketplace entry once its licence is checked | check | ✗ |
| F1.30 | webadderall/Recordly | Screen recorder that adds zooms, cursor polish, backgrounds | Idea only (AGPL): "make a polished demo of this screen recording" via ffmpeg zoom/pan in ox's own code | AGPL-3.0 | ✗ idea |

### F2. Screen recordings (first set: 11 files, 2 exact duplicates)

| # | Recording | What it shows (frames + speech) | What the island / ox gets | State |
|---|---|---|---|---|
| F2.1 | 10-13 21:07 (louis_rlee, Coucou) | Mail in the notch: unread list (Arnaud, Léa, Figma, GitHub, Stripe, Vercel), open one, **Reply**, **Mark as read**, **Open in Mail** | Island mail card with open / reply (draft, never sent) / mark read / open in Mail | ✓ mail card (unread list when Mail is open, open, reply as a draft, mark read, open in Mail) |
| F2.2 | 10-14 18:16 (Coucou) | Live feed of what Claude Code reads / edits / runs; **Allow / Deny / Always** in the notch; answering Claude's multiple-choice question in the notch; happy jump on "Done, 48 tests passed"; lock-screen approvals with Face ID; works with Claude, Codex, Cursor, Gemini; no account | A1 approvals (built, install step), A2 questions in the notch, done animation, phone later (A25) | ~ live feed, Allow / Deny / Always and questions in the notch built (install step); done animation ✓; lock screen ✗ |
| F2.3 | 10-15 14:33 (Coucou 0.5 for Windows) | Coucou app window: Flow stats (11,204 words, 196 sessions…), Notetaker, settings; hold a key to talk; "learns your words"; notes of every call (mic + computer audio); "OK Coucou" | Dictation stats (A10), call notes with system audio (A14), wake phrase ✓ | ~ |
| F2.4 | 10-16 3 (agentmaxxing, "Pixie") | Voice: play a song, "make yourself smaller and turn down the volume", read today's to-dos, **explain the YouTube video on screen by drawing circles and arrows over it** | Songs ✓, smaller ✓, volume ✓, to-dos ✓; new: **screen annotation overlay** (draw circles/arrows/labels over the screen while explaining) | ✓ songs, smaller + volume, to-dos, circles / arrows / boxes drawn over the screen, album art |
| F2.5 | 10-16 20 (deployaibots, AgentReach for Hermes) | One-command skill so the agent researches LinkedIn, YouTube, Instagram, X without separate API keys | `research` across platforms through public pages and transcripts ✓ (YouTube); add X/Reddit/LinkedIn public search via web search; respect each site's terms | ~ |
| F2.6 | 10-16 21 = 10-16 23 (farza, Clicky) | "Write the reply in my Gmail box in my voice" from screen context; "type a good follow-up prompt into the Claude Code terminal and explain it"; skills in the product (YC skill) | B1 write-for-me into the focused field (draft, user sends), B2 follow-up prompt, skills ✓ | ✓ write-for-me (B1), follow-up prompt (B2), skills |
| F2.7 | 10-16 22 (Vovy) | Voice computer-use: open Spotify and play a track, find Callaway irons in Chrome, "build an app" | ✓ open app + play, ✓ open a search; building apps by voice goes to an agent | ~ |
| F2.8 | 10-16 23-16-40 = 10-16 24 (luciomakes) | A canvas of many agent terminals instead of a grid; a **mission map** (tree of tasks/agents); tools menu: Presets, GitHub, Code, Markdown, Mission Map, Memory, Skills, Loops, Settings; "resets 2:39 pm" | App: a mission-map view of tasks and agents (goal tree from the board), plan reset time in the notch ✓ (Codex) / Claude via relay | ✗ |
| F2.9 | 10-17 22:42 (Claudex) | Notch usage meter: Claude and Codex session %, weekly %, reset timers, sessions per project, **mascot panics past 80 %**, water estimate | Rings (C1), sessions list (C2), alerts ✓ (C3), stressed character (A22), water with a stated method (C4) | ~ |

### F3. Screen recordings (second set: 10 files)

Filled in from each recording's frames and speech below.

| # | Recording | What it shows (frames + speech) | What the island / ox gets | State |
|---|---|---|---|---|
| F3.1 | 10-13 10:51 (KODEMON) | Coding agents as creatures that level up and fight; "skills are attacks"; capture | Idea only: a playful side to ox org (each agent's level from tasks done); not a priority | — |
| F3.2 | 10-13 22 | Same clip as F2.1 (Coucou mail in the notch) | see F2.1 | dup |
| F3.3 | 10-14 12:30 (Devin ad) | Asked from Slack to upgrade Next.js: fixes the dependency conflict, the TypeScript errors, lint, build, then opens a PR with CI green; runs in its own cloud machine; **"Save to environment"**: install / lint / build / start steps kept for next time | ox: a per-repo **environment recipe** (`.ox/environment.yml`: install, lint, build, start) written after the first successful run and used by later runs and `ox org` agents; Slack-started PR flow (with F1.9) | ✗ |
| F3.4 | 10-14 12:34 (theaiskool) | A Mac app that turns the Dock into a hub of 160+ widgets with AI usage tracking | Island widgets: usage ✓, music ✓, focus ✓, clips ✓, shelf ✓; next: calendar (next event) and weather in the idle card | ~ |
| F3.5 | 10-14 13:54 (ChatGPT) | "Interactive breakdowns": a credit-card payoff slider instead of a lecture | ox Interactive answers (measured: E3) | ~ |
| F3.6 | 10-14 14:12 (Coucou, talk) | "Did anybody pay me today?" → Stripe card, 3 payments, €1,240; "Write an email to Camille, tell her it's done" → a draft in the notch with Send / Cancel ("you just have to hit send"); joking personality ("Claude wrote 90 % of your code. Rude.") | Stripe pill (needs your key; read-only); email draft card in the notch (draft only, you press Send in Mail — owner rule); a little personality in short answers | ~ email draft in the notch ✓ (you press Send); Stripe ✗ (needs your key) |
| F3.7 | 10-14 19 | Same video as F2.2 (Coucou permissions, lock screen) | see F2.2 | dup |
| F3.8 | 10-15 13 (Reason) | Agents and developers in one place: mention teammates, work from Slack, your computers in sync, stack your subscriptions (Gemini, ChatGPT, Claude), connect bots, "your Claudes talk to each other" | Agent-to-agent mailboxes ✓, plans stacked ✓, Slack gateway ✓; ✗ two Macs in sync | ~ |
| F3.9 | 10-15 15 | Same video as F2.3 (Coucou for Windows) | see F2.3 | dup |
| F3.10 | 10-16 19:12 (Little Agent Club) | A gallery of agents, each a character card (Muse, dots, Instinct, OpenClaw, Cue, Hark, MausBot, Poke, Hermes): what it does, price, Favorite / "I use this" | Marketplace / `ox agent` list as character cards with Favorite and "I use this" | ✗ |

### F4. The island, read line by line (October 18)

Every Swift file read; each defect below was found in the code and fixed, then
the island was rebuilt. "Checked" says how the fix was proven.

| # | Defect found | Fix | Checked |
|---|---|---|---|
| F4.1 | "make the text smaller", "can you close the tab", "hide the dock" were taken as island commands and swallowed; a bare "close" did nothing | Island commands match only when the whole clause is about the island | `OxIsland --check-commands` |
| F4.2 | "Make yourself smaller and turn down the volume" did the first half only | Clauses split; the island does its part, the rest goes to ox | `--check-commands` |
| F4.3 | With a terminal run open, "play Billie Jean" was sent into the coding run | Errands go to ox's no-AI router first (`offlineOnly`), even with a run open | unit test on `/ox/voice` + live try |
| F4.4 | Plan gauges called every non-Codex plan "Claude" | Label from the plan id (Claude, ChatGPT, Gemini, Cursor, Copilot…) | `--check-commands` |
| F4.5 | A typed chat message to a live run was answered out loud | Only spoken questions are spoken | code path |
| F4.6 | A hung ox run kept the chat busy forever | Runs stop after 20 min (logged) | code path |
| F4.7 | Screenshots of your screen and voice recordings piled up in the temp folder | Deleted after 10 minutes | live try |
| F4.8 | Holding the talk key while ox spoke recorded ox's own voice | Speaking stops before listening | code path |
| F4.9 | "Start ox in a terminal" shown when ox simply wasn't found | Says to open the OX app once | code path |
| F4.10 | "The run is still open in your terminal" shown for app and island runs | Message fits where the run came from | code path |
| F4.11 | Approval card showed one line of a long command | Up to three lines, the whole text on hover | screenshot |
| F4.12 | Notch geometry recomputed 60 times a second | Cached, refreshed when displays change | code path |
| F4.13 | A dictation that failed to start left « OK ox » off | The microphone is handed back | code path |
| F4.14 | Two calls in the same minute overwrote each other's notes | Seconds in the file name | code path |
| F4.15 | OX.app kept a dead page after its server stopped (an update, `ox app stop`); reopening did not bring it back | The window reconnects: a failed load or reopening asks ox for the server again | live: app restarted, board answered |
| F4.16 | The island found the app only through serve.json, which OX.app's server does not always write | Reads serve.json or app.json, skipping a file whose process is gone | live: island showed the app's board |
| F4.17 | Other agents' sessions (this Claude Code session, worktree sessions) were invisible to ox and the island | src/agents-live.js, merged into /ox/live: Claude Code, Codex, Copilot, Hermes, OpenCode, Antigravity | test/agents-live.test.js + notch screenshot, real island screenshot |
| F4.18 | A click on the island (a session, Allow / Deny, a tray tool) could be used up just bringing the panel forward | The island takes the first click (acceptsFirstMouse) | real island: card opened |
| F4.19 | The island closed 6 s after the pointer left, even while you typed in it | It stays while it has the keyboard | real island screenshot |
| F4.20 | The open island put the session list above the walking-ox floor, so it grew tall (unlike Coucou / Claudex) | With sessions listed the floor goes; small characters in the rows; up to 4 rows, working ones first | real island screenshot |
| F4.22 | Messaging a Codex session from the island failed: Codex's config named gpt-5.5, which the ChatGPT account may not use; the raw error JSON was shown | Resume with a model the account allows; errors shown as words | real: "pong" came back from a Codex session |
| F4.23 | `ox -p … --image f` printed the help (the flag was documented, not parsed); with a plan, the image was dropped | Parsed; plan runs get the image as a file | real: "A screenshot of a dark chat app." |
| F4.24 | The ox had been taken out of the open island | Back, in the card's left like Mochi; its face is the most urgent state; on alert past 80 % of a plan limit (Claudex) | real island screenshot |
| F4.21 | No way to open a session from the island, read it, message it or take it over | Click a session's character: its last messages, a message box (one turn through the tool's own resume; waits while the session is busy in its own window), Open in Terminal | test/agents-live.test.js; real island shows the conversation |
| F4.25 | The ox stood and walked only; no eating, sleeping or reacting | New renders from the Blender rig: graze, doze, gallop (working), think, alert (needs you), happy (done), dizzy (error), worried (past 80 % of a plan) | real island screenshot |
| F4.26 | Every other agent shared one pixel character | Friends Puff, Pebble (first named Pip) and Dot (white, white with black; never black), same rig, 12 cycles each; each session gets one by its id | real island screenshot |
| F4.27 | "Save as image" and dictation stats had nowhere to live | Recap card (7 days of tokens and cost, top model, words dictated, water estimate) and mail card under the plus tab | build + screenshot |

## G. The owner's October 18 evening batch (screenshots and two recordings)

Licences are checked before any code is taken. A product's name, mascot and art are its own.

| # | Source | What it shows | What ox takes from it | Licence | State |
|---|---|---|---|---|---|
| G1 | pinchtab/pinchtab | A 12 MB Go server that gives agents direct Chrome control over HTTP, 10–20 % fewer tokens than agent-browser | ox's browser tools as a background daemon reused across runs, compact page snapshots (accessibility tree, not screenshots) to cut tokens | Apache-2.0 | ✓ web_task backend, MCP template, Marketplace entry (needs brew install pinchtab/tap/pinchtab); MIT, not Apache as the video said |
| G2 | Microsoft MAI-Code-1.1-Flash, "Hybrid Intelligence" | A coding model that runs locally; Copilot uses local models on the PC | ox already runs local models; add it to the local model catalogue when its weights are public, and a hybrid router: local first, cloud when needed | — | ✗ no public weights yet (checked Hugging Face Oct 18); ox runs local models and routes local-first already |
| G3 | feder-cr/git-ai + "scaled git" (Anthropic's blog) | Git designed for AI agents; mirrors so CI jobs, dev environments and agent sandboxes do not each fetch everything | ox worktrees per task (built) share one object store; add a local mirror cache for agent sandboxes and parallel worktrees | MIT | ✓ ox git clone: one local mirror per repo, clones borrow its history (2.1 s vs 5.1 s on pinchtab); worktrees share objects already. git-ai itself: licence unclear, idea only |
| G4 | usestrix/strix | Open-source AI agents that pentest your own apps | Marketplace entry after its licence is checked; security review skill already in ox | check | ✓ Marketplace tool entry (Apache-2.0): pipx install strix-agent; your own apps only |
| G5 | Google agents-cli | CLI and skills for building agents on Gemini Enterprise Agent Platform; works with Claude Code, Codex, Antigravity | Featured with the ADK skills in the Marketplace | Apache-2.0 | ✓ seven agents-cli skills featured (Apache-2.0); workflow skill installed for real |
| G6 | stablyai/orca | Run Codex, Claude Code, OpenCode side by side, each in its own worktree, tracked in one place; a mobile companion | ox has worktree-per-task and every agent's sessions in the island; add parallel runs of several agents on one task, side by side, and phone follow-ups | Apache-2.0 | ✓ ox race: several agents on one task side by side, each in its own worktree, compared, keep one (checked with two local models); phone follow-ups through the Telegram gateway |
| G7 | Recording 08:25 (theaiskool, "Gloss") | Saved articles, PDFs and bookmarks as a bookshelf library; connect your agent; it shelves for you; highlight any line and ask | An ox Library: save links and PDFs, a shelf view in the app, highlight and ask, and the agent can add to it | — | ✓ Library: save links and PDFs, shelf, reader, highlight and ask, the agent saves for you (checked with a real essay and PDF); importing X bookmarks needs X sign-in, not done |
| G8 | Recording 16:20 (Pushary, mascot Pip) | Live agents in the notch; approvals with a risk summary; questions with numbered options and "type your answer"; a happy hop when done; approvals on the phone with Face ID; safe commands run on their own, risky ones wait | Risk line on approval cards, a typed answer for questions, safe tools allowed automatically for connected agents, phone approvals through ox's own gateways. ox's friend formerly named Pip is renamed so ox never shares Pushary's mascot name | — | ✓ risk line, typed answers, safe calls on their own (ox hooks safe off), phone approvals through the Telegram gateway; our Pip renamed Pebble. Face ID: the phone's own lock, no app of ours |

## H. October 18, night

| # | Source | What it shows | What ox takes from it | Licence | State |
|---|---|---|---|---|---|
| H1 | DeepSeek Bot (a plugin for DeepSeek Harness) | A "Chief of Staff" bot: say the team you want; it creates the bots (Writer, Coder) and starts a group chat with them | `ox org team "<sentence>"`: the chief drafts the hires from one sentence, you approve, and the team gets one group thread where they talk and you join | Apache-2.0 (per the screenshot; repo not found to confirm) | → |
| H2 | CopilotKit/OpenDots | Always-on AI coworkers that move between text, calls and Slack, each with its own computer, web and mobile | ox org agents wake on a schedule (always on), Slack gateway with channel memory, phone through Telegram, each agent in its own worktree or on another machine (mesh). Calls: not built | MIT | ~ |
