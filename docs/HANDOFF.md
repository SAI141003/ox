# ox: project handoff

Everything someone taking over ox needs, top to bottom: what it is, how it is
built and run, every feature with its state and where its code is, every
connection, the GitHub setup, the benchmarks, the repositories studied, the
screenshots and videos that shaped it, what is broken or missing, and the rules
the owner set. Written October 17, 2026 and updated twice the same evening
(releases v0.1.1, v0.1.2), from the code as it is on `main`, not from memory.
Section 0 is the latest round; everything after it is the full picture.

States used: **✓** works and was tested for real (how, is said) · **~** works
with a named gap · **✗** missing or broken · **?** not tested.

---

## 00. Round of October 30 (memory layer, media routing, page previews, open-intelligent-ui)

| What | State | Evidence |
|---|---|---|
| A web page the agent writes (`write_file *.html`) opens in the default browser; not in tests (`NODE_TEST_CONTEXT` / `OX_OPERATOR_DRY`), not in `-p` runs (`ctx.headless`), opt-out `OX_NO_AUTO_OPEN=1` | ✓ | real: Chrome opened `animals-check.html`; `src/tools/fs.js`, test 9 in `test/tools-fs.test.js` |
| "Create an image of …" in the app made a Wikipedia photo (routed as a question: no tools, the drawn-answer guide's `SearchImage`). Now `wantsMediaMade()` routes it to code mode with only `create_media`; the made file is shown in the reply (`ox: media` event, from the tool result or, for plan CLIs that run `ox create`, from what this turn added to Studio) | ✓ | real: app chat → `create_media` → SD-Turbo on this Mac → `/ox/media/2f5912a52d/1.png` shown; `test/chat-media-intent.test.js` |
| A small model naming a provider with no key (`provider: "higgsfield"`) failed every time: `create_media` now drops an unusable named provider | ✓ | `src/tools/media.js` |
| **Memory layer**: an events log (`~/.ox/memory/layer-events.jsonl`, ids and counts only, never text) for the read path (what went in front of a run, tokens) and write path (add / update / extend / noop / forget); a **sleep pass** (`src/memory-layer.js`): merge near-duplicates, retire past events, reinforce what was recalled (MemoryBank), let unused facts go dormant (never deleted), promote a lesson verified twice to a procedure (Voyager). Runs 30 s after the server starts, then every 6 h; "Sleep now" on the page | ✓ | `test/memory-layer.test.js` (5), all 122 memory tests green; tests never touch the real `~/.ox` |
| **Memory page** `/memory` (and live in Settings › Memory): a pixel house in the Office's style, write desk, read desk, vault, sleep room, with workers carrying cards for each real event; live numbers, profile, decay bars, activity feed | ✓ | headless Chrome screenshot with a scratch `OX_MEMORY_HOME` |
| The older `~/.ox/memory/memory.jsonl` (87 rows) is not in the graph: its rows are repeated generic test lines ("prefer local models for coding tasks" ×N), so they were **not** imported into the profile; the page shows the count | ~ | owner may delete or keep it |
| **open-intelligent-ui** (ideas only, no licence): ox had 42 of ~50 components and none of its date/list/data functions. Added from scratch: TextArea, DatePicker, RadioGroup, Timer (minutes), Flashcard, Carousel, Quote, Link, Image (`/ox/media` and data: only), Math, Popover, Celebration, Ellipse, Polyline, Path; @AddDays @AddMonths @DaysBetween @MonthsBetween @StartOf @FormatDate @Now @Take @Slice @Reverse @Unique @Chunk @Flatten @Prepend @RemoveAt @Update @Find @Pick @Shuffle @Between @Change @Cumulative @MovingAvg @Stats @Top @Histogram @MixColor; terminal renderings too | ✓ | `test/ui-lang-oiu.test.js`; real app render of every one (screenshot); Map not built (the app's CSP loads no outside tiles) |
| "Make me flashcards / a timer / help me memorize" went to code mode and wrote a .md file: those words now ask for an interactive answer | ✓ | real app run: drawn Timer |
| Modes, real runs on scratch projects (default bot muse-glimmer-30b): all seven | ✓ | `code` wrote calc + test, green; `ask` answered, no file changed; `plan` planned, calc untouched; `debug` fixed the failing test; `data` 255.5 correct; `orchestrate` 3 subagents in parallel, 3/3 files; `auto` routed to ask |
| **Apps on this Mac are detected** (`src/desktop-apps.js`, one Spotlight query, ~0.3 s): WhatsApp, Mail, Outlook, Messages, Telegram, Slack, Discord, with version and whether open. Messaging page shows "Found on this Mac"; new **Outlook** channel | ✓ | this Mac: WhatsApp 26.37.76, Mail, Outlook 16.113.2, Messages, Slack found; `test/desktop-apps.test.js` |
| **WhatsApp with no Cloud API**: `whatsapp_send` opens the chat in WhatsApp for Mac with the message typed in (after approval); the person presses Enter. Voice: "send a whatsapp to mom saying on my way" (a number goes to that chat; a name is looked up in Contacts; else the text is ready and you pick the chat) | ✓ (dry) | tests; real open not exercised (it would put a draft in the owner's WhatsApp) |
| **Outlook**: `mail_compose app:"outlook"` opens a draft in Outlook (mailto:, no attachments, never sent); "open outlook" opens the app, not outlook.live.com | ✓ | tests |
| **Chat microphone "blocked"**: OX.app's Info.plist had no NSMicrophoneUsageDescription / NSSpeechRecognitionUsageDescription, and the web view had no media-capture handler, so WebKit answered `not-allowed`. Fixed both (loopback origin only), and the mic now falls back to recording + on-device transcription (`POST /ox/voice/dictate`, Whisper/Parakeet, file removed) when speech recognition is missing or refused | ✓ / ? | OX.app reinstalled with both keys; dictate endpoint transcribed a spoken sentence word for word (6 s); the first press after reopening OX.app shows macOS's permission prompt (not exercised: needs a person) |
| **Studio, free on this Mac** (no key; the Higgsfield-style basics): text→image ✓ (35 s), edit ✓ (46 s), cut-out ✓ (Apple Vision, 47 s), upscale ✓ after a fix (it returned the same 512 px it was given: this sd-cli build answers img2img at 512 whatever -W says; now the result is brought to the size asked), image→video ("living picture") — see below | ✓ | `~/.ox/media/{7db2d8493c,237f4b8963,981bbed3c0}` |
| Studio gaps vs Higgsfield, on-device: reframe / outpaint, relight, lip-sync / talking avatar (need an inpainting or lip-sync model not on this Mac; with a Higgsfield or fal key they run through those providers) | ✗ | |
| Studio fix: **upscale and cut-out silently ran as an unprompted edit** whenever a source image was given (`editOf || model === 'mac-edit' ? 'edit' : …` precedence). Now `deviceOp()`; upscale returns 1024 px for 512 px in, cut-out a transparent PNG (Apple Vision, 1 s) | ✓ | `~/.ox/media/{8e729f5bee,52168d09ef}`; test |
| **Desktop pet moves**: drag it anywhere (a tap still opens chat), let go near a corner and it snaps there, the spot is kept across launches and it stops wandering once placed; right-click: four corners, Stay here / Wander around. The old pet could not be dragged (a Button over a web view swallowed the mouse), reset to bottom-right on every layout, and its wander never moved it (`animator()` origin changes were not applied) | ✓ | harness on the real `DesktopPetController`: tap → chat, drag → snapped top-left [16, 758] saved, wander held, menu → bottom-right; OX.app reinstalled and relaunched |
| **Island from real use** (`ox island learn`): "whats the date of today" went to an agent (fixed, offline); the four real phrases are eval cases now (26/26 offline, 37/37 commands). A run started from the island that got no answer said "stdin is not a TTY"; it now first says "no answer from OX Island in time for <tool>: declined, nothing was done" | ✓ | `ox island evals` |
| Hooks for approving Claude Code / Codex / Gemini / Cursor / Copilot commands from the notch | ✓ | already installed (`ox hooks status`: all connected); relay answers in 0.2 s |
| **Test suite** (`npm test`, the isolated runner): **2,538 tests, 0 failures**. The failures were stale tests, all owner decisions: two route tables (WhatsApp webhook), chat history now saved by default (60a517f), WhatsApp health `inboundReady`, prompt +183 B (create_media rule), +3 tools (messages_send, whatsapp_send, create_bot), cosmetic presets removed (8f207af), "Plugins & connectors" label, "unpriced" status line, the 429becc schema cap (compaction fixtures now cross the line with history + the pruned offer), and two ACP tests that read the owner's real `~/.ox` trust store and keys (now a temporary home) | ✓ | |
| Legacy `~/.ox/memory/memory.jsonl` (87 generic rows from Sept 17, nothing writes it now) moved aside to `memory.legacy-2026-09-17.jsonl` | ✓ | |
| **Wake word** ("OK ox"): Apple's recognizer is now told the phrase (`contextualStrings`) and "ox"'s sound-alikes (box, ax, oaks…) count after ok / hey / hi | ✓ build / ? live | island rebuilt and running; a live microphone test needs a person |
| Full suite: 24 failures, **the same 24 on clean `main`** (pre-existing; none from this round) | ~ | compared run by run |

### 00b. Island look from the owner's reels, and the connectors gallery (October 30, afternoon)

| What | State | Evidence |
|---|---|---|
| Notch eyes (`NotchEyes.swift`): mint `#E0FBCF` glowing pills in the left wing; blink, follow the pointer; poke = red, 3 pokes = dizzy spirals; dance while music plays; doze after `island.eyes.awayAfter` s (90) with no input, hearts then ^ ^ on return; amber = needs you, red x = error, ^ ^ = done. Off: `defaults write dev.ox.island island.eyes -bool false` | ✓ render | `OxIsland --render-tiles <dir>` → eyes.png |
| Closed notch: a tap pokes the eyes; the island opens after the pointer rests `island.hoverDelay` s (0.4) and 1.2 s after the last poke | built | `IslandPanel.tick`, `IslandRoot` tap |
| Music in the notch: album art beside the eyes, red level bars in the right wing | built | `MiniArt`, `MusicBars` |
| Open island = the classic cards (ox, herd, steps, other sessions, day strip: unchanged) **plus** a row of glowing tiles under them: the run's turn clock + step (Claude `#835241`, Codex, Gemini, Cursor, ox palettes), Music (`#752836`, real Spotify/Music track + play/pause), Focus (`#653486`, start/pause, right-click for minutes). `island.home classic` hides the row | ✓ live | screenshot of the real island: Claude Code 0:24 Testing, Spotify track with art |
| Tap the agent tile: the island takes that agent's colour and shows the turn: project, big clock, "Making changes · step 2 of 4", the file being edited with + / − counts, Read·Edit·Test·Done bar, Chat (session card) and Open buttons. Chat bubble on the tile too | ✓ render | turn.png; `AgentSession.turnStartedAt/stage/trackTurn` |
| Edge glow: gold light + sparks around the island while a run needs you, violet while it listens | built | `IslandEdgeGlow` |
| Header clock "Fri 30 Oct 13:10" | ✓ live | screenshot |
| Settings › Plugins & connectors › **Connectors** (default tab): Claude-style gallery with each service's logo (inline SVG, no network): Google Drive/Gmail/Calendar/Docs/Sheets (gsuite MCP), Notion, GitHub, Slack, Browser (templates), Outlook, Mail, WhatsApp, Messages (apps found on this Mac), Telegram (gateway). States are real: Connect (adds the template, Ask every call), Added (never "Connected" until it signs in), Found (app on this Mac), Connected (paired gateway only), Set up / needs X | ✓ | `src/connector-gallery.js`, `GET/POST /ox/connectors/gallery`, `test/connector-gallery.test.js` (5/5, child process with its own HOME) |
| Not done | | the converter radial menu from the 3rd reel (drop a file → ring of formats); the Coucou "update / your stats" cards already exist as `UpdateHome`/Recap |

## 0. Round of October 17, late evening (v0.1.2)

| What | State | Evidence |
|---|---|---|
| **`ox transfer`**: move a session between Claude Code, Codex, Hermes, ox (read) and to those plus Gemini CLI, Cursor, Paperclip. Other tools' stores only read (Hermes's SQLite opened read-only); the session moves as `.agent/handoff/*.md` (self-ignoring in git, secrets redacted by both redactors); the target starts on it through its own CLI, or resumes its own session | ✓ | real: a 6,941-message Claude Code session handed to Codex (read-only), which named the project, worktree and next steps correctly; 9 tests incl. "source files byte-identical after transfer"; `src/session-transfer.js` |
| **`ox graph`** (graphify's idea, own zero-dependency code): files, functions, classes, imports, calls, NOTE/WHY comments; EXTRACTED vs INFERRED on every edge; subsystems; `query` / `path` / `explain` / report / graph.html; `code_graph` agent tool | ✓ | vs graphify 0.9.92 on `src/`: finds 86.0% of its call links, 81.5% of ox's are in graphify's; 0.8 s vs 60 s; `src/code-graph.js`, 9 tests |
| graphify itself installed for Claude Code (owner ran `graphify install`); its graph of ox in `graphify-out/` (gitignored) | ✓ | 4,739 nodes, 12,875 edges |
| Linux CI: uncaught EPIPE when an MCP server exits at once (`src/mcp.js`); ACP `close()` racing `start()` (`src/acp.js`); "open chrome and open youtube" taken as one app off macOS (`src/offline.js`) | ✓ fixed | reproduced in a `node:22` container; Linux, Intel Mac, Apple Silicon green on `6b43eb9` |
| Parallel reads of different files shared one self-heal key, so 3 failed reads stopped a run | ✓ fixed | `src/agent.js`, test |
| CI: Intel Mac job queued forever (`macos-13` retired) → `macos-15-intel`; actions v5; **Windows unit tests hang** (25+ min) → step cut at 15 min there, job limit 60 min, so the Windows download is built anyway | ✓ / ~ | which Windows test hangs is **not yet known** (next: run the suite file by file on a Windows runner) |
| Version was hard-coded in 3 places and drifted (`ox --version` said 0.1.0 after v0.1.1): now package.json only | ✓ | |
| Island relaunch after the interrupted rebuild | ✓ | running since 18:41, built after its last source change |

## 0b. Previous round (October 17, evening: v0.1.1)

| What | State | Evidence |
|---|---|---|
| **ox improved itself**: the first `ox evolve` change kept. ox wrote a CWE-377 rule (Python `tempfile.mktemp`) with its test, in its own worktree; the suite measured it better (1,875 pass vs 1,874, 0 fail); reviewed and accepted | ✓ | commit `9b5a873`, author "ox" |
| `ox evolve` judge re-runs newly failing tests alone before rejecting (the first real attempt was rejected for an unrelated flaky test) | ✓ | `recheck()` in src/evolve.js, test |
| `ox evolve "<goal>"` was ignoring its goal (an absent flag's position, −1 + 1 = 0, skipped the goal) | ✓ fixed | |
| Attempts run their own committed ox, not the half-edited working copy beside them | ✓ fixed | |
| **Photos reach the plans** (ChatGPT, Claude): a message with an image was dropped whole; now the words are kept, Codex gets `--image`, Claude Code is told the file path | ✓ | ChatGPT plan read a Task-board screenshot: title, 5 columns, their names (68 s) |
| **CI on clean machines** found: `ox doctor` gave no next step without a local model; unit tests opened a real browser tab and Finder window on the owner's Mac on every run (now a dry run under the test runner); "open youtube" became an app on Linux/Windows; the Windows download never built (raw `C:\` import) | ✓ fixed | release v0.1.0 builds failed on all three; fixes in v0.1.1 |
| **Head-to-head**, first full run on qwen2.5:3b: ox, Hermes, Codex, Claude Code all **0/9** (a floor effect, no ranking) | recorded | `bench/h2h/RESULTS.md`, 36-row JSON |
| Release **v0.1.1** with the Mac zip; CI building Windows/Linux/Mac from the tag | ~ | Linux failed (2 tests), Intel never ran (retired runner), Windows hung: superseded by v0.1.2 |
| Unit suite **1,875 pass, 0 fail**; launch check **141/142** (`/doctor` in the REPL timed out once under load; 4 s and exit 0 when run alone) | ✓ / ~ | |
| `docs/HANDOFF.md` (this file) | ✓ | |
| The user's Mac: `~/ox` merged, OX.app reinstalled; island relaunch confirmed in the next round | ✓ | |

---

## 1. What ox is

A coding agent and personal assistant in three forms, all one program:

| Form | What | Code |
|---|---|---|
| **Terminal** | `ox` REPL and `ox -p "…"` headless runs, 89 subcommands | `bin/ox.js`, `src/cli.js` |
| **Desktop app** | **OX.app**: a native window (WebKit) onto ox's local server; chat, agents, pages | `desktop/island/Sources/OxApp/`, `src/serve.js`, `src/web/chat.html` |
| **OX Island** | A voice and status assistant in the Mac's notch (SwiftUI) | `desktop/island/Sources/OxIsland/` |

Node ≥ 18, plain ES modules, **zero npm dependencies**, no account, no telemetry.
It runs any of 22 model providers, local models, or the AI plans the user already
pays for (Claude, ChatGPT, Cursor…) through those vendors' own CLIs.

Size at handoff: 162 modules in `src/` (~70,700 lines with tools and providers),
16 agent-tool modules exposing 27 tools, 20 Swift files for the island (~6,700
lines with the app launcher), 188 test files (1,875 unit tests, all passing).

---

## 2. Repository map

```
bin/ox.js                 entry point
src/
  cli.js                  every subcommand (the big switch), REPL, runPrint
  agent.js                the agent loop: model calls, tools, approvals, gates,
                          goal judge, verifier, security check after edits
  headless.js             -p runs; assembleCtx (tools, memory, MCP, skills)
  serve.js                the app's HTTP server: OpenAI-compatible /v1 + /ox/* routes
  web/chat.html           the whole web app (single file; ui-lang.js inlined at serve time)
  ui-lang.js              OpenUI Lang parser/evaluator (interactive answers)
  subscriptions.js        plans you pay for: drives Claude Code, Codex, Cursor… CLIs
  mac-mcp.js              ox's Mac actions as an MCP server for those CLIs
  offline.js              everyday tasks with no AI (apps, sites, music, reminders…)
  security-scan.js        ox secure (62 rules, taint within a file)
  build-spec.js           ox build: requirement → spec → tests first → trace
  port.js                 ox port: language migration with an external-factor inventory
  evolve.js               ox evolve: ox improves its own code, judged by the test suite
  system1.js              Laya-based message router (System 1)
  flows.js                Automations (n8n-style)
  market.js, plugins.js, skill-add.js   Marketplace, plugin/skill install + safety scan
  tasks.js                Task board engine (Paperclip's model)
  memory*.js, goal.js     memory, goals that must be proven
  slack-/telegram-/discord-gateway.js   messaging
  providers/              anthropic, openai-compat, gemini, images
  tools/                  the agent's tools (fs, exec, web, operator, mail, media, …)
desktop/island/           Swift package: OxIsland (notch) + OxApp (window launcher)
test/                     node:test suites (scripts/verify.mjs runs them)
bench/                    harness (scripted), real tasks, security, build, port, h2h
docs/                     REFERENCE.md (full manual), FEATURES.md, HANDOFF.md, …
skills/                   14 built-in skills
assets/screenshots/       real screenshots of the app (section 9)
scripts/                  verify.mjs, launch-check.mjs, package.mjs (downloads)
.github/workflows/release.yml   builds Mac/Windows/Linux downloads on a v* tag
```

---

## 3. How to run and develop

**Run**

```bash
node bin/ox.js                 # REPL (or `npm link` once, then `ox`)
ox -p "fix the failing test"   # one headless run
ox app                         # the desktop app (opens OX.app with a local server)
ox island restart              # rebuild and relaunch the notch island (macOS)
ox app install                 # put OX.app in ~/Applications (rebuilds if its source changed)
```

**Test** (always with the test environment; machine features off):

```bash
node scripts/verify.mjs --only unit     # 1,875 tests, ~4–7 min on this Mac
node scripts/launch-check.mjs           # 139 commands/slash commands smoke-run in a fresh HOME
```

Test env used by verify: `OX_ISLAND=0 OX_LEARN=0 OX_NO_KEYSTORE=1 OX_USAGE_LOG=0
OX_NO_BUILTIN_SKILLS=1 OX_NO_PLUGINS=1`. Running a single file without them gives
false failures (e.g. 15 skills found instead of 1). On Node 25 pass
`--test-reporter=tap` to read `# pass / # fail`.

**Known flaky under heavy load** (pass alone): daemon 3 and daemon 7,
serve-settings ("another website cannot change settings"), probe cache TTL,
docker-backend, prompt-layering, mcp restart, local-discovery's mixed-origin
scan and concurrent dead ports, subscriptions when run beside other suites. The Mac this was built on routinely runs at a very high load.

**Branch flow used**: work happens in the worktree `~/ox/.claude/worktrees/ox-repair`
on branch `claude/ox-repair`; the user's checkout `~/ox` (branch `main`) is
updated by `git merge --ff-only claude/ox-repair` run in `~/ox`; then
`git push origin claude/ox-repair:main`. OX.app and the island run from `~/ox`.

**Release**: `node scripts/package.mjs --out dist` builds the download for the
platform it runs on. On macOS it **must** run with the official Node (nodejs.org,
nvm, volta), not Homebrew's (it refuses: Homebrew's links /opt/homebrew libraries
and would not start on another Mac). Pushing a `v*` tag runs
`.github/workflows/release.yml` (macOS arm64/x64, Windows, Linux) and attaches
the zips to the GitHub release.

**Where ox keeps things** (`~/.ox/`): `config.json` (name, default bot, bots,
marketplaces), `app.json` (the app server: pid, url, node, cli), `serve.json`,
`island.json` (island running), `island.log` (every voice request: heard, route,
time, reply), `tasks/` (task board + `activity.jsonl`), `self/` (evolve archive,
failures, baselines), `cache/` (images, market), `laya/` (System 1 model, 680 MB),
`voice/` (Kokoro), `flows/`. Per project: `.agent/specs/` (ox build),
`.agent/port/plan.json` (ox port), `.agent/MEMORY.md`.

---

## 4. Architecture in one page

- **Agent loop** (`src/agent.js`): system prompt (cwd, git, workspace tree,
  memory, skills index) → streaming model call → tool calls behind approvals →
  results back → repeat. Around it: compaction, self-healing retries, quality
  gates (`gate:` commands that must pass), a goal judge and verifier, and since
  this release the **security check of files the run wrote** (one round, cannot
  loop, `OX_SECURE=0` turns it off).
- **Models**: `src/bots.js` resolves a bot spec (`ox-anthropic`, `ox-ollama:qwen2.5:3b`,
  `chatgpt-plan`…) to a provider target. **Plans** (`*-plan`) are run through the
  vendor CLI (`src/subscriptions.js`): the whole turn happens inside Codex /
  Claude Code, so ox's in-loop gates and security check apply only to runs ox
  drives itself; ox attaches its Mac actions to those CLIs as an MCP server
  (`ox mcp-mac`, `src/mac-mcp.js`).
- **Routing**: Auto mode picks a model per message (`autoModel` in serve.js):
  small talk and questions to the quickest model (local first), code and tools
  to the strongest. System 1 (`src/system1.js`, Laya) classifies messages in any
  language; word lists are the fallback.
- **App server** (`src/serve.js`): OpenAI-compatible `/v1/chat/completions` plus
  `/ox/*` routes: about, accounts, agents, bots, canvas, capabilities, connected,
  endpoints, flows, followups, hf, image, live, local, map, market, media,
  memory, messaging, optimize, plan-usage, providers, scheduled, sessions,
  settings, skills, speak, studio, tasks, usage, **voice**.
- **Web app** (`src/web/chat.html`): one file, built into the page with the
  OpenUI parser inlined; cached when the server starts (restart the server to
  see a change).
- **Island** (`desktop/island`): `Bridge.swift` watches ox runs (IPC sockets in
  $TMPDIR) and the app's runs (`/ox/live`); `Buddy.swift` is voice (on-device
  speech, hold Fn or ⌃⌥Space, Kokoro voice); `Tray.swift` holds the chat,
  `OxRunner` (finds ox: env, app.json, OX.app's ox-paths.json, usual places),
  `VoiceServer` (POST `/ox/voice` to the running server) and `IslandLog`.
- **OX.app** (`desktop/island/Sources/OxApp/main.swift`): asks `ox app --print-url`
  (starting the server if needed) and shows it; finds ox the same way as the island.

---

## 5. Every feature, top to bottom

### 5.1 Models and connections

| Feature | State | Evidence / code |
|---|---|---|
| 22 API providers (Anthropic, OpenAI, Gemini, xAI, Groq, DeepSeek, Mistral, OpenRouter, Together, Fireworks, Cerebras, Moonshot/Kimi, Zhipu, MiniMax, Baichuan, Yi, StepFun, Ollama, LM Studio, llama.cpp, vLLM, custom) | ✓ | `src/bots.js`, `src/providers/` |
| Plans you pay for, via their CLIs (`ox connect` knows 16 CLIs) | ✓ | ChatGPT plan: 9/9 real tasks today; Claude plan: works when signed in |
| Expired plan sign-in said plainly, plan stops being offered | ✓ | Claude's "OAuth session expired" caught today; `expiredPlans` in subscriptions.js |
| Photos and screenshots reach the plans (Codex `--image`, Claude Code told the file path) | ✓ | a Task-board screenshot read correctly on the ChatGPT plan |
| Plans get ox's Mac actions (MCP) | ✓ | Codex (approved ahead) and Claude Code (`--mcp-config`, 6 tools allowed); "open whatsapp" opened WhatsApp via `mcp__ox__open_app` |
| Auto model per message; Compare several models | ✓ | serve.js `autoModel`; picker |
| Custom endpoints, local models, Hugging Face search and download | ✓ | Settings › Custom endpoints / Local models |
| Default model shown correctly when the saved one cannot run | ✓ | fixed today (was a blank box) |

### 5.2 Agent, modes, safety

| Feature | State | Evidence / code |
|---|---|---|
| Modes ask / plan / code / orchestrate, auto-routed, with descriptions | ✓ | `src/modes.js`, mode menu |
| Approvals for writes and commands; denylist; sandbox profiles | ✓ | `src/guards.js`, `src/sandbox.js`, `src/tools/exec.js` |
| 27 tools: read/write/edit/list/glob/grep, bash, todo, web fetch/search, web_task (incl. **my-browser**: your signed-in Chrome via Playwright MCP extension), open app/url/path/window, type, screenshot, notify, mail accounts/compose (never sends), media, critique, install skill, YouTube transcript, current page, show_ui, subagent | ✓ (my-browser ~: needs the user to install the Playwright MCP Bridge extension) | `src/tools/` |
| Subagents that delegate and report; agent mailbox | ✓ | app and terminal |
| Goals that refuse "done" until proven; heartbeat | ✓ | `/goal`, `src/goal.js` |
| Security check of every file the agent edits | ✓ | end-to-end test: scripted model wrote SQL injection, was told, fixed it |

### 5.3 The three professor's gaps (built today)

| Feature | State | Evidence |
|---|---|---|
| `ox secure [paths] / --diff / --json / --fail-on` | ✓ | `bench/security/RESULTS.md`: held-out 24/27 caught first run, 0/18 false alarms; DVNA untuned 3/7 → 6/7; NodeGoat 7/8; ox's own 189 files 96 → 2 low; three real injection risks fixed in ox |
| `ox build "<requirement>"`, `ox spec show / trace` | ✓ | `bench/build/RESULTS.md`: 7/7 criteria proven on a real requirement, code read by hand |
| `ox port <project> --to <lang>` (`--inventory`, `--plan-only`, `--check`) | ✓ | `bench/port/RESULTS.md`: JS → Python, 11/11 same tests, env var and data file kept; NodeGoat inventory |

### 5.4 Self-improvement

| Feature | State | Evidence |
|---|---|---|
| `ox evolve "<goal>"`: change in its own worktree, judged by the unit suite, kept only if better, merged only by `ox evolve accept` | ✓ | First kept change: `9b5a873` (a CWE-377 rule), measured 1,875 vs 1,874 pass. On the way: the judge rejected a correct change for a flaky test (now re-run alone), the goal argument was ignored, and attempts ran the half-edited working copy (all fixed) |
| Crash recording → `ox evolve` with no goal fixes the most frequent | ✓ | `~/.ox/self/failures.jsonl` |
| Follows "market trends" by itself | ✗ | Not built: there is no trend source wired to evolve; would need a scheduled flow that reads release notes / repos and files goals |

### 5.5 Memory, tasks, automations, schedules

| Feature | State | Evidence / code |
|---|---|---|
| Memory with history, recall, forget; incognito chats | ~ | tested earlier; quality vs other tools not measured |
| Task board (Paperclip's model): claims, blockers, budgets, review, activity | ✓ | page tested on a throwaway server (`src/tasks.js`, Sidebar › Task board) |
| Automations (n8n-style): triggers manual/schedule/webhook; steps http, ask, extract, if, notify, write, shell | ✓ | real Hacker News flow saved today's top 3; `src/flows.js` |
| Scheduled runs, daemon | ✓ | `ox schedule`, `ox daemon` |

### 5.6 App (OX.app and the web app)

| Feature | State | Evidence |
|---|---|---|
| OX.app opens from Applications with no terminal | ✓ | fixed today (stale saved path, stale binary); self-contained download 51 MB |
| Chat: + menu (web search, deep research, guided learning, interactive answer, think harder, memory), mode menu, prompt wand ⌘I, delete with Undo | ✓ / ~ for deep research and guided learning (not run end to end) | screenshots |
| Interactive answers (OpenUI): calculators, charts, tables, forms, SVG | ✓ | Claude plan, ChatGPT plan and qwen2.5:3b all draw; today's fixes: streamed values, computed $vars, early-closed cards, heading levels, compact numbers |
| Pages: Project map, Bots, Capabilities, Studio, Marketplace, Messaging, Scheduled, Automations, Task board, Office, Settings | ✓ (Studio ~: no image key to test) | `assets/screenshots/` |
| Marketplace: 1,129 plugins from 11 MIT/Apache catalogues, scanned before install | ✓ | addyosmani/agent-skills installs (25 skills, 4 agents) after the scanner fix |
| Resizable three panes, sidebar scroll, Settings back navigation | ✓ | earlier sessions |

### 5.7 OX Island (notch)

| Feature | State | Evidence |
|---|---|---|
| Voice: hold **Fn** (or ⌃⌥Space), on-device speech, Kokoro voice | ✓ build / ~ live mic | Fn monitor built; mic loop needs the user |
| Fast path: requests go to the running ox (`/ox/voice`): no-AI tasks ~0.1 s, questions 2–3 s on the local model (kept loaded), real tasks to an agent with "On it" | ✓ | measured on the user's Mac today |
| Works offline for no-AI tasks and local-model questions | ✓ | |
| Queue: a message sent while busy runs next (was dropped) | ✓ | |
| `~/.ox/island.log` of every request | ✓ | |
| Rename ("call yourself Pixie", menu, `ox name`); wake word uses the name | ✓ build | |
| No-AI intents: apps, sites by name, "open X in Chrome", chains ("open chrome and youtube"), play a song by name (Music library, else Spotify, verified playing), lower/raise music, today's to-dos from Reminders (overdue said as such), notes, to-dos, email drafts (never sent), unread mail, timers, volume, time/date, calculator | ✓ | tested on the user's Mac |
| Screen recording asked once, only when chosen | ✓ | was asking every request |
| Compact size by voice, auto-close, now-playing pill, connected AI tools, usage meter and plan gauges (Codex real; Claude needs a status-line relay not installed) | ✓ / ~ | |
| Dictation anywhere (⌃⌥D) with a personal dictionary; "OK ox" wake word (off by default); call notes (mic only) | ✓ build / ~ live | |
| Draw on the screen to explain (Pixie) | ✗ | next |
| Coucou cards: question chips, live diff, Mail/GitHub/Stripe/Vercel cards, phone approvals | ✗ | Coucou's code is MIT; its protected name, mascot and art are not |
| Approve Claude Code / Codex commands from the notch (hooks) | ✗ | needs hooks in the user's ~/.claude settings: user's OK required |

### 5.8 Messaging, voice, media

| Feature | State |
|---|---|
| Telegram, Discord, Slack (Socket Mode) gateways with pairing and Allow/Deny buttons | ✓ (Slack tested against a stand-in) |
| Kokoro natural voice (54 voices), `ox speak` | ✓ |
| Studio: images and video with provider keys | ~ (no key here) |
| Photos in answers (Wikipedia, cached) | ✓ |

### 5.9 Reliability

| Item | State |
|---|---|
| Unit suite | ✓ 1,875 pass, 0 fail (full run, evening) |
| Launch check | ~ 141/142: `/doctor` in the REPL timed out once on the loaded Mac (4 s, exit 0 alone) |
| Clean-machine CI (GitHub Actions) | ~ v0.1.0 failed on Linux, Mac, Windows (fixed); v0.1.1 building |
| Tests never act on the real machine (operator tools dry-run under the test runner) | ✓ |
| Download self-contained (official Node; packaging refuses Homebrew's) | ✓ |

---

## 6. GitHub

- Repository: **https://github.com/SAI141003/ox** (private at handoff; making it
  public is the owner's decision and one click in Settings).
- Branch: `main` (pushed from `claude/ox-repair`). Remote `origin`.
- Release **v0.1.1** (current): https://github.com/SAI141003/ox/releases/tag/v0.1.1
  with `ox-mac-arm64.zip`; its tag runs the release workflow for Windows, Linux
  and Mac (v0.1.0's run failed on all three; the causes are fixed in v0.1.1).
  Intel-Mac runners (macos-13) queue for hours on GitHub.
- Release **v0.1.0**: https://github.com/SAI141003/ox/releases/tag/v0.1.0 with
  `ox-mac-arm64.zip` (51 MB, official Node 22, island included, ad-hoc signed,
  not notarized: first open is right-click › Open). The tag started the release
  workflow for Windows and Linux zips.
- History scanned for secrets before the first push: only fake keys inside
  tests. Personal data (WhatsApp media etc.) is not in the repository.
- The README is the launch page; every claim links to a measured result.

---

## 7. Benchmarks and evidence

| What | Result | File |
|---|---|---|
| Harness (scripted model: ox's machinery) | 25/25 | `bench/RESULTS.md` |
| Real coding tasks, graded by running code | 9/9 on the ChatGPT plan, 150 s | `bench/real/results-chatgpt-plan-2026-10-17.json` |
| Security scanner | see 5.3 | `bench/security/RESULTS.md` |
| Requirements to code | 7/7 criteria | `bench/build/RESULTS.md` |
| Language port | 11/11 tests | `bench/port/RESULTS.md` |
| ox vs Hermes overhead (same stand-in model) | start 166 ms vs 2,250 ms; 2,073 vs 10,923 tokens per request; 1 vs 3 requests | `bench/compare-hermes.mjs` |
| Head-to-head ox / Hermes / Codex / Claude Code, same 9 tasks, same local model (qwen2.5:3b, 64k), tokens by proxy | **0/9 for every agent**: a floor effect, no ranking. Tokens in: ox 181,544 (58 requests), Hermes 267,764 (35), Codex 53,541 (18), Claude Code 0 (no usable answer from the local model) | `bench/h2h/RESULTS.md`, `results-qwen2.5-3b-64k.json` |
| SWE-bench, GAIA, full Terminal-Bench | not run | |

---

## 8. Repositories and products studied

| Source | Licence | Used for | State |
|---|---|---|---|
| thesysdev/openui | MIT | the language of interactive answers | ✓ in ox (own parser) |
| thesysdev/open-intelligent-ui | none (all rights reserved) | ideas only: 28 components (Map, Carousel, Timer, DatePicker, Flashcard, YouTube, Math…) and ~25 functions to rebuild | ✗ to build, from scratch |
| Louis-CFM/coucou | MIT code; name, mascot, art, sounds reserved | island: voice brain shape, dictation, call notes, wake word, logging; cards still to port | ~ |
| NandhaKishorM/laya | Apache-2.0 | System 1 router | ✓ |
| Paperclip | (studied earlier) | task board model, bots | ✓ |
| ruvnet/ruflo | MIT | in Marketplace; ideas to take: cost/replay cockpit, missions, permission ladder for agent control | ~ |
| addyosmani/agent-skills, obra/superpowers, wshobson/agents, alirezarezvani/claude-skills, jeremylongshore/claude-code-plugins-plus-skills, VoltAgent, huggingface/skills, anthropics/claude-plugins-official, anthropics/knowledge-work-plugins, anthropics/skills | MIT / Apache | Marketplace catalogues (1,129 plugins) | ✓ |
| OWASP NodeGoat, appsecco/dvna | Apache-2.0 / MIT | security scanner validation | ✓ |
| Darwin Gödel Machine (Zhang et al., arXiv 2505.22954) | paper | ox evolve design | ✓ |
| Hermes Agent (installed on the Mac) | — | comparison; install docs as reference | ✓ compared |
| Polar (AI browser) | product | idea: agents in the user's signed-in browser → `web_task` my-browser | ~ |
| Creo (RaazKetan/creo) | MIT | usage meters, session history ideas | ✓ ideas |
| bible-strong-avatar-lab | AGPL | reference only, never vendored | — |
| PrimeIntellect-ai/prime-agent, xai-org/grok-build | MIT / Apache | cloned, study pending | ✗ |
| useamoeba.com, heynixi.com | products | asked for, not reviewed yet | ✗ |
| heyclicky.com (Clicky), Pixie, Vovy | products | island behaviour (screen buddy, voice actions) | ~ |
| Omarchy | open source | ideas: install agent CLI on first use, crash watcher | ✗ |
| Devin, Sauna, Harness, AgentReach, Krea, AutoAgent, Freebuff, deepagents, Wajo, /anatomy | products/repos | see FEATURES.md section 13 | mixed |

---

## 9. Screenshots (`assets/screenshots/`, taken from the real app)

| File | Shows |
|---|---|
| chat-interactive-chart.png | Claude plan's answer: planets compared, two coloured bar charts and a table, drawn live |
| chat-light.png | the same in light theme |
| chat-loan-calculator.png | a loan calculator with sliders written by local qwen2.5:3b, maths correct |
| chat-plus-menu.png | the + menu: photos, camera, files, web search, deep research, guided learning, interactive answer, think harder, memory, Studio |
| page-tasks.png | Task board: columns, budgets, review tag, activity log |
| page-flows.png | Automations |
| page-market.png | Marketplace |
| page-office.png | Office: which agent works on what |
| page-bots.png, page-caps.png, page-studio.png, page-msg.png, page-sched.png, page-map.png, page-settings.png | the other pages; Settings shows the island switch, rename and default model |

---

## 10. The videos the owner sent, and what each is about

| File (~/Downloads) | Length | What it shows | ox |
|---|---|---|---|
| ScreenRecording_10-13-2026 21-07-45_1 | 5 s | Coucou: a protected mascot in the notch with a Mail card (GitHub, Stripe, Vercel rows, unread count) | Mail card ✗ |
| ScreenRecording_10-14-2026 18-16-11_1 | 48 s | Coucou promo: live session card, edits as a diff, "Claude wants to run a command" with Allow / Always / Deny in the notch, agent questions as chips, a happy jump when done, approve from the iPhone lock screen, works with Claude Code, Codex, Cursor, Gemini CLI, on macOS/Windows/Linux, MIT, no account | ✗ approvals of other CLIs, chips, diff, phone |
| ScreenRecording_10-15-2026 12-42-15_1 | 26 s | Reason: agents and developers collaborating; mention teammates, work from Slack, computers in sync, stack your subscriptions, connect your bots, "your Claudes talk to each other" (live graph) | Slack ✓, subscriptions ✓, bots ✓, sync ✗, live graph ✗ |
| ScreenRecording_10-15-2026 14-33-55_1 | 36 s | Coucou 0.5 for Windows: the Coucou app (flows, notetaker, settings), hold Right Ctrl to talk, dictation typed where you are, learns your words, notes of every call, "OK Coucou" | dictation ✓, dictionary ✓, call notes ~, wake word ✓, Windows island ✗ |
| ScreenRecording_10-16-2026 3 | 80 s | **Pixie** (the main reference): "Pixie, play Billie Jean" plays it with a card; "lower the music" and it shrinks; "open my to-do list, what do I have today" reads Reminders; "I'm a visual learner, draw and explain" draws boxes, circles, arrows and labels on a YouTube physics video; small talk; two big eyes | all ✓ except drawing on screen ✗ |
| ScreenRecording_10-16-2026 19-13-41_1 | 26 s | Harness by Autonomous: Claude Code, OpenCode, Pi, Hermes side by side in one window; each agent on its own branch; every machine linked (Mac, home server, office, GPU box); keeps going when you close the laptop | ~ (Compare, Office); per-agent panes ✗; machines ✗ |
| ScreenRecording_10-16-2026 20 (= 19-14-50_1) | 37 s | AgentReach for Hermes: one free skill to research leads on LinkedIn, pull YouTube transcripts, search X, collect across platforms | YouTube ✓; LinkedIn/X ✗ (signed-in sessions) |
| ScreenRecording_10-16-2026 21 (= 20-15-22_1) | 48 s | Clicky (farza): a screen buddy that writes replies for you and types follow-up prompts into Claude Code, explaining as it goes | ~ (Buddy sees the screen; typing into other apps is deliberately not exposed to plans) |
| ScreenRecording_10-16-2026 22 (= 21-05-05_1) | 51 s | "AI maxxing": a voice assistant on a Mac opening Spotify and shopping for golf irons in the browser | ~ (apps, music ✓; browsing by voice through an agent) |
| ScreenRecording_10-16-2026 23-16-40_1 / 24 | 9 s | Agent canvas (luciomakes): many Claude Code terminals as cards on an infinite board, a Mission Map tree, a Tools menu (Presets, GitHub, Code, Markdown, Mission Map, Memory, Skills, Loops, Settings), live count and plan reset time | ✗ (Office is the nearest) |
| ScreenRecording_09-15-2026 00-12-46_1 | 15 s | not reviewed in this project | — |

Earlier images and videos (Krea, AutoAgent, Freebuff, deepagents, Claude video
editor, Wajo, /anatomy, Sauna, Devin, Symvibe, Vovy, heyclicky.com) are mapped
feature by feature in `docs/FEATURES.md` sections 10–13.

---

## 11. What is broken or missing, in the order to take it

1. **Island**: draw-on-screen marks (Buddy `MarksView`), question chips
   (AskUserQuestion), the live diff ticker, Allow / Always / Deny and the Mail
   card are in the code as of October 30. Still open: approving other CLIs'
   commands from the notch (needs the owner's OK to install hooks into Claude
   Code / Codex), and the Windows island (`test/island-web.test.js` hangs on the
   Windows runner: the approval test spawns a real run over a named pipe).
2. **Head-to-head benchmark**: rerun with a shared model strong enough to
   separate the agents (a 7B+ coder model, ~5 GB download, owner's OK; or an
   API key); then SWE-bench Lite / Terminal-Bench with a strong model.
3. **open-intelligent-ui components** (28) and functions (~25), written from scratch.
4. **Agent canvas / Harness board**: live panes per agent CLI.
5. **ox evolve**: it works (one change kept); next is a trend source (release
   notes, repos) that files goals on a schedule, and a scheduled run.
6. **ruflo ideas**: cost/replay cockpit, missions, permission ladder.
7. **Devin parity**: Jira/Linear, PR flow, codebase wiki.
8. Notarized Mac app (needs an Apple developer account), Windows island.
9. `docs/FEATURES.md` predates October 17: this handoff is the current state;
   FEATURES.md should be brought in line.
10. Amoeba, Nixi, prime-agent, grok-build: not reviewed yet.
11. Confirm the v0.1.1 CI builds finished and attached Windows/Linux zips.
12. The owner's decisions: make the repo public; sign Claude back in
    (`claude`, then `/login`); allow the island's hooks into Claude Code/Codex.

---

## 12. Rules the owner set (keep them)

- No fake data, no façades: a feature is ✓ only after a real run; failures are
  reported as they came out (first runs included).
- ox never sends email, never handles credentials or logs in for the user, never
  reads or copies vendor login tokens.
- Never touch the owner's real island, config or memory from tests; tests use a
  temporary HOME.
- Don't install hooks into `~/.claude/settings.json`, edit `~/.codex/config.toml`,
  install large packages, or delete personal files without asking.
- WhatsApp media stays local. Keep the island on.
- Commits: end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Licences: Coucou's protected name/mascot/art, open-intelligent-ui's code (no licence)
  and AGPL code are never copied into MIT ox.
