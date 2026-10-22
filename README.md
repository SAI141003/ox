# ox

**The coding agent that proves its work, on any model.** It writes a failing
test before the fix, runs it again after, and shows you the result. Terminal,
desktop app and a voice assistant in your Mac's notch. It runs on your ChatGPT
plan, any API key (Claude through an Anthropic key) or a model on your own
machine, with no dependencies, no account and no telemetry.

![ox answering with an interactive chart](assets/screenshots/chat-interactive-chart.png)

## Why ox

Models write plausible code. ox makes them prove it, whichever model it is.

| The problem | What ox does | Measured |
|---|---|---|
| **Security holes**, whatever the model | `ox secure` scans code for 62 vulnerability patterns (injection, XSS, SSRF, path traversal, secrets, weak crypto…), each with its CWE and a fix. When the agent edits a file, ox scans it and makes the model fix what it introduced. | Held-out lines: **24/27 caught on the first run, 0/18 false alarms**. DVNA, untuned: 3/7 on the first run, 6/7 after. OWASP NodeGoat: 7/8. Found 3 real command-injection risks in ox itself. [Details](bench/security/RESULTS.md) |
| **Requirements turned into code that misses the point** | `ox build "<requirement>"` turns it into numbered acceptance criteria for *your* project, writes a test for each before the code, codes until they pass, then proves each criterion separately. | A real business requirement on the ChatGPT plan: 7 criteria, tests failed first, **7/7 proven**, code checked by hand. [Details](bench/build/RESULTS.md) |
| **Language migrations that break** | `ox port <project> --to <lang>` inventories everything the project touches (env vars, files, endpoints, ports, commands, databases), ports module by module in dependency order with the tests, and names anything the port forgot. | A JS project to Python: **11/11 of the same tests pass**, the env var and data file kept, one behaviour difference reported rather than hidden. [Details](bench/port/RESULTS.md) |
| **Cost and speed** | One request per answer, a small prompt, tools offered only when needed. | Against Hermes, same model: starts **13× faster** (166 ms vs 2,250 ms), sends **5× fewer tokens** per request (2,073 vs 10,923), 1 request per answer vs 3. [Method](bench/compare-hermes.mjs) |

What is **not** proven yet, and is on the list: a head-to-head on real coding
tasks against Claude Code, Codex and others on the same model (the runner is
built; its first full run, on a 3B local model, passed nothing under any agent,
see `bench/h2h/RESULTS.md`), and the public benchmarks
(SWE-bench, Terminal-Bench). No claim here goes beyond the linked files.

## Get it

**Mac app** (Apple Silicon): download `ox-mac-arm64.zip` from
[Releases](https://github.com/SAI141003/ox/releases), unzip, drag **OX** to
Applications. It brings its own runtime; nothing else to install.

The app is not notarized by Apple yet, so macOS blocks the first open. On macOS
Sequoia 15.1 and later the right-click › Open trick no longer works (the warning
only offers "Move to Trash"). Instead:

1. Open **OX** once and close the warning (choose Done, not Move to Trash).
2. Open **System Settings › Privacy & Security**, scroll to "OX was blocked",
   and press **Open Anyway**, then confirm with your password or Touch ID.

Or, in Terminal, clear the download flag once (it only affects this app):

```bash
xattr -dr com.apple.quarantine /Applications/OX.app
```

**Terminal** (macOS, Linux, Windows; Node 18 or later):

```bash
git clone https://github.com/SAI141003/ox.git
```

```bash
cd ox && npm link
```

```bash
ox
```

Then connect a model: set any API key (Anthropic, OpenAI, Gemini, xAI, Groq,
DeepSeek, Mistral, OpenRouter and dozens more); or `ox connect` finds a ChatGPT
plan you are signed in to (OpenAI allows partner apps); or run a local model
with Ollama. For Claude, use an Anthropic API key: Anthropic keeps Claude
Pro/Max logins for its own apps, so ox never reads them or picks that plan for
you ([how ox connects to each provider](docs/PROVIDER_ACCESS.md)).

For OpenAI's current GPT-6 family, choose `ox --bot ox-gpt-luna`,
`ox --bot ox-gpt-sol`, or `ox --bot ox-gpt-astra`. GPT-6 tool calls use the
Responses API; the existing `ox-gpt` preset is unchanged.

**Windows**: the same commands in PowerShell, or `ox-windows-x64.zip` from
[Releases](https://github.com/SAI141003/ox/releases) (`ox.cmd` for the terminal,
`OX.vbs` for the app window). On Windows the island is a bar at the top of the
screen (hold Ctrl+Alt+Space to talk).

## What's inside

![The plus menu: web search, deep research, guided learning, interactive answers](assets/screenshots/chat-plus-menu.png)

- **Agent** with modes (ask, plan, code, orchestrate), approvals for every
  write and command, subagents that delegate and report back, a task board,
  memory that persists across sessions, and goals that refuse "done" until proven.
- **`ox fix "<bug>"`**: a test that fails because of the bug, then the fix, then
  the same test passing, all run by ox itself, not taken on the model's word.
  **`/undo`** takes back the last turn's file changes and the exchange in one go,
  and the agent stays out of `.env`, keys and anything you list in `.oxignore`.
- **`ox transfer`**: move a whole session between Claude Code, Codex, Hermes, ox, Gemini CLI, Cursor and Paperclip. Other tools' files are only read, never written; the target starts on a handoff (or resumes its own session).
- **`ox graph`**: the code as a graph (functions, classes, imports, calls, each link marked as read or inferred) you and the agent query instead of grepping: `explain`, `path`, `query`, a report and a clickable page. No model, under a second on ox itself.
- **Interactive answers**: calculators, charts, tables and forms drawn in the
  chat by any model, even a 3B local one.
- **OX Island**, the notch assistant: "play Billie Jean", "lower the music",
  "what's on my to-do list today", "open Chrome and YouTube", all **without AI
  and offline, in about 0.1 s**. Questions go to your local model in 2–3 s, and
  real tasks to an agent. Hold **Fn** to talk, rename it, dictation anywhere,
  call notes.
- **OX Studio on your own Mac, no key**: images (~25 s on an M3), edits, 5 s
  clips (a generated scene with a camera move), cut-outs (Apple Vision) and 2x
  upscale, all on your chip, nothing sent anywhere. One-time setup of about
  2 GB, every download checked by sha256 (`ox studio local install`). Hosted open
  models (FLUX, Wan, Qwen-Image…) when you add a key.
- **Animate a script**: a video, transcript or script becomes scene-by-scene
  motion graphics (headlines, counting numbers, lists, vs, quotes, steps,
  captions) with sound effects, on this machine (`ox video animate`).
- **Long video, with sound**: Studio's **Long video** tab joins generated or
  imported scenes into a 30-minute or one-hour timeline and mixes narration or
  music across the whole export. It reports the real duration; short video
  models remain short-shot generators (`ox video compose scene-*.mp4 --audio
  narration.m4a`).
- **Approvals everywhere**: every write and command asks Allow / Deny, in the
  app (on any model, Claude and ChatGPT plans included), in the notch, and on
  your iPhone's lock screen.
- **The office**: a floor per connected machine, every AI tool in its own colour,
  each agent at a desk with what it is doing.
- **`ox vs`**: the same prompt to Claude Code and Codex (or more), each in its
  own folder, raced in the notch.
- **Automations**, n8n-style and built in: triggers (by hand, schedule,
  webhook) and steps (HTTP, ask a model, extract, if, notify, write).
- **Marketplace**: 1,129 plugins from 11 MIT/Apache catalogues, scanned before
  install (Anthropic's official plugins, addyosmani/agent-skills, superpowers,
  ruflo, wshobson/agents and more).
- **Messaging**: drive ox from Telegram, Discord or Slack; approvals as buttons.
- **No-AI mode** for everyday tasks: notes, to-dos, email drafts (never sent by
  ox), timers, music, volume, apps and sites.

| | |
|---|---|
| ![Task board](assets/screenshots/page-tasks.png) | ![Automations](assets/screenshots/page-flows.png) |
| ![Marketplace](assets/screenshots/page-market.png) | ![Office: agents at work](assets/screenshots/page-office.png) |
| ![A loan calculator drawn by a local 3B model](assets/screenshots/chat-loan-calculator.png) | ![Settings](assets/screenshots/page-settings.png) |

## Benchmarks, as measured

| Suite | What it measures | Result |
|---|---|---|
| [Harness](bench/RESULTS.md) | ox's machinery (tools, recovery, safety, memory) with a scripted model | 25/25 |
| [Real tasks](bench/real/README.md) | 9 coding tasks (find, edit, debug, refactor, create, add a feature, recover, leave files alone, multi-step), graded by running code; the model decides everything | **9/9** on the ChatGPT plan, 150 s ([results](bench/real/results-chatgpt-plan-2026-10-17.json)). On a plan the loop runs inside the vendor's CLI (Codex here), so the 42k–142k tokens per task are Codex's, not ox's |
| [Security](bench/security/RESULTS.md) | caught / false alarms on labelled, held-out and real vulnerable apps | above |
| [Head-to-head](bench/h2h/RESULTS.md) | ox vs Hermes vs Codex vs Claude Code, same tasks, same model, tokens counted by a proxy | first full run on a 3B local model: **0/9 for every agent**, so no ranking; needs a stronger shared model |

## Everything else

The full reference (every command, mode, provider, safety rule and the
changelog): [docs/REFERENCE.md](docs/REFERENCE.md). Features and their honest
state: [docs/FEATURES.md](docs/FEATURES.md).

MIT licence.
