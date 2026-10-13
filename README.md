# ox — the featherweight coding agent

```
  █                                        █
  ██                                      ██
   ███                                  ███
    █████                            █████
     ███████       ████████       ███████
       ███████   ████████████   ███████
         ██████ ██████████████ ██████
           ████████████████████████
            ██████  ██████  ██████
             █████   ████   █████
              ████  ██████  ████
                 ████████████
                 ███  ██  ███
                 ███  ██  ███
                    ██████
```

A zero-dependency terminal coding agent for Node ≥ 18: reads your code, edits
files behind approval gates, runs shell commands through a denylist, remembers
what it learns across sessions, and talks to 22 LLM providers (Anthropic,
OpenAI, Gemini, xAI, Groq, DeepSeek, Mistral, OpenRouter, Together, Fireworks,
Cerebras, Moonshot/Kimi, Zhipu, MiniMax, Baichuan, Yi, StepFun, local Ollama,
LM Studio, llama.cpp, vLLM and more) or to the coding plan you already pay for
(`ox connect`). Plain ES modules, no `npm install`, no telemetry, no accounts.
Runs on macOS, Linux and Windows.

```
node bin/ox.js            # start the REPL right now — nothing to install
npm link                  # or install the `ox` command globally
```

## What it is

ox is an agentic loop: a ground-truth system prompt (cwd, git branch/status,
workspace tree), streaming model calls, tool dispatch behind graduated approvals,
self-healing retries, lossless JSONL session logs.

**Honest positioning.** Claude Code is the completeness benchmark — hooks,
subagents, IDE panels — at ~232MB installed, single-vendor models, quota opacity.
Codex CLI has real kernel sandboxing and zero-dep binaries but pins its provider
surface and grinds through per-tool consent prompts. Hermes Agent has the widest
feature fan and weakest verification spine: frozen 2KB memory, unverified skill
births, silent paid fallbacks, SQLite corruption. ox competes where a CLI can win
outright — weight, provider freedom, cost honesty, evidence-gated memory,
scriptable CI semantics — and concedes the rest on the record. October 2026 landscape (Muse, Dots, Grok Build, Hermes, OpenClaw and the coding CLIs), measured: [docs/landscape-2026.md](docs/landscape-2026.md). Older matrix:
[docs/comparison.md](docs/comparison.md); rationale in docs/plan.md, docs/research.md.

## Quickstart

```bash
export XAI_API_KEY=xai-...        # or ANTHROPIC_API_KEY / OPENAI_API_KEY / ...
node bin/ox.js                    # interactive REPL (default bot: ox-grok)
ox -p "why does test/auth.spec fail?"          # headless: one prompt, exit
ox -p "summarize this repo" --json             # JSONL agent events on stdout
ox --bot ox-claude                              # preset bot switch
ox --model anthropic:claude-haiku-4-5          # or --bot ox-openrouter:<model>
ox -c                                          # continue most recent session

export OX_BASE_URL=http://localhost:8000/v1   # any OpenAI-compatible endpoint
export OX_API_KEY=sk-...                       # optional; endpoint may not need one
export OX_MODEL=my-fine-tune                   # default model on that endpoint
ox                                             # now talks to your endpoint
```

In the REPL: type a task, `/help` for commands, `!<shell command>` runs a shell
line yourself, Ctrl-C once interrupts a turn / twice within 3s quits. Other
flags: `--max-cost <usd>`, `--verify`, `--max-mode <n>`, `--yes-edits`, `-y`,
`--plan`, `--cwd <dir>`.

On an interactive terminal ox plays its launch: a small ox charges a pane of
glass, the glass shatters, and the mark resolves where it stood
(`OX_INTRO=swarm` brings back the older particle swarm). Piped and CI output
stays plain ASCII with no escape codes, so `ox --version` is exactly `ox 0.1.0`
under a pipe. Set `NO_COLOR=1` or `OX_NO_ANIM=1` to drop the logo and the
animation entirely.

## Run any model, pay for fewer tokens

**Find a model that fits your machine.** ox reads your hardware (Apple unified
memory, NVIDIA VRAM, or CPU RAM), checks the real file size of every
quantisation on Hugging Face, and estimates speed from memory bandwidth:

```bash
ox models hw                      # what fits: e.g. "Apple M3, 16 GB · budget 8.2 GB"
ox models recommend --task code   # ranked picks with quant, size, ~tok/s, pull command
ox models search "qwen coder"     # any query, fitted to this machine
ox models pull Qwen/Qwen2.5-Coder-7B-Instruct-GGUF   # picks the quant, pulls via Ollama
```

Local servers need no key: `--bot ox-ollama`, `ox-lmstudio`, `ox-llamacpp` or
`ox-vllm`, and a model of `auto` uses whatever the server has loaded (tool-
capable models preferred). A model that cannot call tools keeps working in
chat-only mode instead of failing.

**Cheaper agents by default.** Subagents do most of the reading, so ox runs
them on the cheapest model you can reach that can still use tools — but only
when the saving is provable (a free local model, or a lower list price than
your main model). It says so once per run. Pin it with `subagent.bot` in
`~/.ox/config.json` (or `OX_SUBAGENT_BOT`): `"main"`, `"auto"`, or any bot spec.

**See who spent what.** Every run that delegated ends with a ledger (example output):

```
cost by agent
  main agent           claude-opus-5     12.4k in   1.1k out   $0.0895  41%
  ↳ audit auth module  grok-build-0.1     8.2k in    900 out   $0.0100  28%
  ↳ map API routes     qwen2.5-coder:7b   7.9k in    700 out   free/unpriced  26%
```

`/cost` in the REPL shows the whole session; `--json` emits `{t:"ledger"}`.

## Download the app

Every release has desktop downloads (Releases page), nothing else to install:

| | download | open it |
|---|---|---|
| macOS | `ox-mac-arm64.zip` / `ox-mac-x64.zip` | unzip, drag **OX.app** to Applications, open it (first time: right-click › Open) |
| Windows | `ox-windows-x64.zip` | unzip, double-click **OX.vbs**; `ox.cmd` is the terminal command |
| Linux | `ox-linux-x64.tar.gz` | unpack, run `./install.sh`: `ox` in the terminal and in your app menu |

Each carries its own Node and ox. The app and the terminal are the same ox:
same agents, sessions and approvals. OX Island comes with it; switch it on or
off in the app's **Settings** (or `ox island on|off`). On a Mac, **ox ›
Install Command-Line Tool** puts `ox` in your terminal, and **File › Open
Folder** picks the project. From source: `ox app` opens the same window.

Building the downloads yourself: `node scripts/package.mjs` (on each platform);
pushing a `v*` tag runs `.github/workflows/release.yml`, which builds all three
and attaches them to the release.

## Modes and auto-routing

```bash
ox --mode ask -p "how does the router pick a model?"   # answers, changes nothing
/mode            # in chat: list the modes; /mode debug to switch
```

| mode | what it may do |
|---|---|
| `code` (default) | read, edit and run, under your approval settings |
| `ask` | read and answer; every write or command is refused |
| `plan` | look and plan; it can write only `.agent/plans/*.md` |
| `debug` | reproduce, test one cause at a time, smallest fix, re-run |
| `data` | analysis as notebook cells in `.agent/data/`, run and read back; writes nowhere else |
| `orchestrate` | split the work across subagents, then check and merge |
| `auto` | picks one of the above per message and prints which, and why |

The limits are enforced where tools run, not just described to the model:
`ask` cannot edit a file even under `-y`.

## Your own agents

```bash
ox agent new reviewer --bot claude-plan --mode ask --prompt "Review diffs for bugs. Cite file:line."
ox agent new researcher --tools read_file,grep,web_search,web_fetch
ox --agent reviewer -p "review the last commit"
ox agent list
```

An agent is a bot (any model, or a plan you pay for), a mode, standing
instructions, and optionally the only tools it may use (`--tools`;
`mcp__github__*` grants a whole MCP server). A refused call names the grant,
before anyone is asked to approve it. In the island's chat, your agents appear
as faces you can tap to talk to. Flags on the command line still win over the
agent's.

## Bring your own subscription

Already paying for Claude, ChatGPT, Gemini, Qwen, Kimi, Copilot or Cursor? ox
hands the turn to that vendor's own signed-in CLI and streams its work back:

```bash
ox connect                       # what is installed and working here, and how to fix the rest
ox --bot claude-plan             # Claude Code on your Pro/Max plan
ox --bot chatgpt-plan:gpt-5 -p "fix the failing test"   # Codex on your ChatGPT plan
```

Supported: Claude Code, Codex, Gemini CLI, Qwen Code, Kimi CLI, Copilot CLI,
Cursor CLI, and the open-source opencode, aider, goose, Crush, OpenHands, iFlow,
plus Amp, Droid and Auggie. Add any other in config:
`"subscriptions": { "mine": { "bin": "mycli", "args": ["run", "{prompt}"] } }`.
ox never reads or copies your logins: the vendor's program does the talking,
under the vendor's terms. Tools then run inside that CLI with its own
permission rules; ox maps `-y`, `--yes-edits` and the read-only modes onto them.

## Email, from the right account

`mail_compose` (for the agent) and `ox mail draft` (for you) write through the
Mail app. With several accounts signed in, the sending account is never guessed:
`from` must be exactly one of the addresses Mail has, the default is a visible
draft, sending always asks you (even under `-y`), and Mail's chosen sender is
read back before sending; on any mismatch nothing is sent. macOS only for now.

## Small tasks with no AI and no internet

```bash
ox do "open notes"      ox do "timer 25 minutes"      ox do "what is 18% of 240"
ox do "search ramen"    ox do "note call the bank"    ox do "volume 30"
```

A rules parser (no model, no network) handles short requests and says so when
something is bigger. The island's voice falls back to it when no ox run is live.

## ox learns from its own work

When a run finishes a task in several good steps, ox drafts a skill from the
steps that actually worked (with how it was checked) into
`.agent/skill-drafts/`. A draft is never used until you keep it:

```bash
ox self-improve drafts            # what it learned, and from which run
ox self-improve accept <name>     # moves it to .agents/skills/, loaded from now on
ox self-improve run               # re-read this project's chat sessions for lessons and drafts
```

Counts are real: nothing is proposed that was not seen, and nothing is called
applied that was not. `OX_LEARN=0` turns drafting off.

## Watch a page

```bash
ox watch add https://shop.example/shoe --price-below 100 --every 30m
ox watch add https://example.com/tickets --contains "Available"
ox watch start        # check in the background; ox watch list / check / stop
```

Tells you when a page changes, shows (or stops showing) some text, or a price
falls below a number — a desktop notification, and your phone if the Telegram
gateway is paired. No model and no key: plain page fetches. One alert per
change, and a failing page backs off instead of being hammered.

## Keep the computer awake

ox holds the machine awake while it works (`caffeinate` on macOS,
`systemd-inhibit` on Linux, `SetThreadExecutionState` on Windows), and lets go
when it stops. `ox awake 2h` holds it for a while, `ox awake off` releases it,
`ox awake --lid` explains what each OS needs to keep running with the lid closed.
`OX_NO_AWAKE=1` turns it off.

## ox on your phone

```bash
ox gateway telegram --token <token from @BotFather> --cwd ~/my-project
ox gateway discord  --token <bot token> --cwd ~/my-project     # DM the bot
```

Message your bot and ox works on it in that project. One status message
updates in place with what it is doing; approvals arrive as **Allow / Deny**
buttons (a phone gets ten minutes, then the usual decline); the answer comes
back when it is done. `/status`, `/stop`, `/mode ask`, `/new`, `/where`.
Until a chat sends the pairing code printed in your terminal, nobody can run
anything, and afterwards every other chat is ignored. Long polling: no port is
opened, no server is exposed. Telegram and Discord (direct messages) work today.

## OX Island (macOS notch)

```bash
ox island          # builds once (~10 s on an idle Mac), then lives in your notch
```

Every ox run shows up in the notch while the island runs — no flags. Approvals
appear there with **Deny / Allow / Always** (or answer in the terminal; first
answer wins, and only an explicit allow ever allows). When a run delegates,
the island opens an **office**: one desk per agent with its task, current tool,
model and tokens. Finished or failed runs peek briefly. With nothing running,
the bull lives on a little pasture: it grazes, wanders and looks around, gets
the zoomies now and then, and a farmer sometimes walks by to wave.

The header has a small **tray**: **Shelf** (drop files on the notch, then ask
ox about one or start an email with it attached, from the account you pick),
**Focus** (a focus timer whose countdown rides in the notch wing) and **Clips**
(what you copied recently, kept in memory only and never anything a password
manager marks as secret).

**Windows and Linux** get the same island as a slim bar at the top of the
screen (an Edge/Chrome app window): live runs, approvals, the shelf and the
focus timer. `ox island` starts it there. It listens on 127.0.0.1 only and every
request needs the per-launch token, so another web page cannot answer your
approvals.

`ox island off` turns the island off everywhere (runs stay in the terminal)
until `ox island on`; the island's right-click menu has the same switch, and
`/island on|off` works in the REPL. `ox island stop|status`; `OX_ISLAND=0`
keeps a single run out of it.

### OX Buddy: talk to ox about your screen

Hold **⌃⌥Space** (or click the mic in the island) and ask out loud: "why is
this test red?", "where do I turn on dark mode?". The island listens with
on-device speech recognition and takes a screenshot when you start speaking.
The live ox run answers, and your avatar (the Ox or one of the pixel cast;
right-click to choose) speaks the reply with lip-sync, expressions and hand
gestures. When the answer names a place on screen, a pointer flies there.

What you say arrives the way you meant it:

- **Accurate:** the island records your question while you hold the key and,
  with whisper.cpp installed (`brew install whisper-cpp`, then
  `ox voice setup` for a 142 MB model or `ox voice setup small.en` for a
  466 MB one), ox transcribes the recording on your Mac. Without whisper it
  uses Apple's on-device recognizer, with automatic punctuation. It waits for
  the recognizer's final result, so the last word isn't cut off.
- **Clean:** "um" and "uh" are removed, repeated words ("the the") collapse,
  spacing and punctuation are fixed, sentences are capitalized, and "new line"
  and "new paragraph" work.
- **Your project's names:** "package dot json" becomes `package.json`, "use
  state" becomes `useState`, and "read me" becomes `README.md`, matched only
  against names that exist in this project.

`ox voice status` shows what is in use, and `ox voice test --text "um so open
package dot json"` shows the cleanup on typed text.

From the terminal, `/screen <question>` does the same with a screenshot, and
`ox -p "…" --image shot.png` attaches any image. Every provider gets the image
(Anthropic, Gemini, OpenAI-compatible including Ollama/LM Studio/vLLM vision
models). Only the newest screenshot in a conversation is sent, so long voice
sessions pay for one image, not all of them.

## Web chat

```bash
ox serve        # then open http://127.0.0.1:8080/
```

`ox serve` includes a chat page, so ox works in a browser with nothing else to
install: conversations kept in the browser, a model picker, streaming answers,
code blocks with copy buttons, light and dark themes, and a phone layout. While
the agent works, each tool it runs appears in the reply (for example
`read_file src/app.js`). The stream carries this as an extra `ox` field that
other OpenAI clients ignore, and only the tool's name and a short preview leave
the server, never its output. With `OX_SERVE_API_KEY` set, the page asks for
the key and the API stays locked without it.

## Run the agent's commands in a container

```bash
ox --backend docker                     # node:22-bookworm
ox --backend docker:python:3.12-slim    # any image
ox --backend docker:alpine:offline      # no network inside the container
ox backend list                         # what is available right now
```

With `--backend docker`, every command the agent runs goes into one container
for the session (started on the first command and removed when ox exits), with
your project mounted at `/workspace`. ox's file edits and the container see the
same files, but nothing else from your machine is inside: not your home folder,
not `~/.ssh`, not your environment variables. Subagents share the session's
container. Timeouts and Ctrl-C also stop the processes inside it. Set it for
every run with `"backend": "docker"` in `~/.ox/config.json` or `OX_BACKEND`;
`OX_DOCKER_BIN=podman` uses Podman.

## Reading JavaScript-only pages

Many sites (React, Next, Vue) send an empty `<div id="root">` and build the page
in the browser, so a plain fetch reads nothing. When `web_fetch` gets such a
shell, it renders the page **on your machine** with the Chrome, Edge, Brave or
Chromium you already have: headless, with a throwaway profile, no extensions,
a time limit and the usual size cap. Nothing goes to a third-party reader, and
it works for your own `localhost` apps too. The result says
`rendered locally (Google Chrome)` when this happened. `OX_BROWSER=<path>`
picks the browser and `OX_BROWSER=off` turns rendering off. Under a sandbox
that restricts the network it never renders, because the page's own scripts
would reach hosts the allow-list didn't name.

## OX Canvas: answers as live UI

When a table, chart or dashboard says it better than prose, ox draws one with
the `show_ui` tool, in your terminal and in the notch:

```
root = Stack([k, t, b])
k = Row([Stat("Tests", 1840, 12), Stat("Failing", 3, -2)])
t = Table([Col("Suite", ["agent", "cli"]), Col("Time", [41.2, 22.5], "number")])
b = Buttons([Button("Fix the failing test", Action([@ToAssistant("fix it")]))])
```

The syntax is compatible with OpenUI Lang (one `name = Component(args)` per
line), and on the benchmark dashboard it costs 255 tokens, against 350 for
compact JSON and 1,094 for pretty-printed JSON. It is built for an agent:

- **Repair without a gateway:** bad lines are dropped and reported back to the
  model in a few tokens ("unknown component Crad (use Card)"), and the model
  re-sends only those lines (`patch: true`).
- **Live data under ox's rules:** `Query("grep", {…})` runs only read-only tools.
  A `Mutation` never runs without you.
- **Buttons that cost nothing:** type a button's number in the REPL. Changing a
  `$value` or re-running a query redraws locally without calling the model.
- **Cheap to offer:** the tool ships only on turns that ask for a table, chart,
  status or similar, and its full syntax is fetched only when needed.

`/ui` redraws the last canvas.

## Task board: many agents, no collisions

`ox task` is a board that agents and people share:

```bash
ox task add "Ship v1"                                   # a goal
ox task add "Design schema" --parent <goal> --budget 1  # work under it, $1 cap
ox task add "Build API" --parent <goal> --blocked-by <schema> --review
ox task next --as mira        # claims the oldest ready task, prints its brief
ox task done <id> --note "schema in db/schema.sql"
ox task approve <id>          # or: ox task reject <id> --note "add pagination"
ox task log                   # who did what, when
```

- **One owner per task.** Claiming takes an exclusive lock, so two agents
  racing for the same task can't both win. An agent's claim ends with its
  process; a claim made from the command line holds for 4 hours.
- **Blockers and goals.** A task is ready only when its blockers are done, and
  a goal isn't handed out while tasks under it are still open. The agent gets
  the chain of goals above its task as the "why".
- **Budgets are hard stops.** Spend past a task's budget is refused, and the
  task is blocked with the reason.
- **Review gates.** With `--review`, finishing a task sends it for review;
  only an approval marks it done.

## Library docs for agents: `@llms:`

Many UI and API libraries publish `/llms.txt`, docs written for agents. Mention
one in a prompt and ox reads it:

```bash
ox "add a liquid-glass carousel to the hero using @llms:componentry.dev"
```

ox fetches it once (cached for a day in `~/.ox/cache/llms`) and inserts the
overview plus only the sections that match your request, capped at about
1.5k tokens, instead of the whole 10–50 KB file.

## Skills and Claude Code plugins

ox ships 14 short built-in skills (`skills/`): plan-first, test-first,
root-cause-debugging, verify-before-done, code-review, security-review,
brainstorm-design, git-hygiene, frontend-craft, refactor-safely,
research-sources, token-economy, parallel-delegation, write-docs. A skill of
yours with the same name always wins.

Claude Code plugins run unchanged:

```bash
ox plugin import-claude              # link the plugins you already installed in Claude Code
ox plugin add owner/repo             # any GitHub repo, or name@owner/marketplace
ox plugin ls                         # skills, commands, MCP servers per plugin
```

Plugin skills appear as `plugin:skill`, commands as `/plugin:command`, and MCP
servers as `plugin-server` (off for imported plugins until `ox plugin mcp <name> on`).
Plugin hooks are never executed. Every install passes the same safety scan as
`ox skill add`.

## Verify loop

```bash
npm run verify        # syntax → CLI smoke → unit tests → agent bench → live local model
npm run verify:loop   # re-run on every change in src/ bin/ test/
```

## v0.2 capabilities

- **Goal verifier** (`--verify` or `/verify`) — after each final answer ox fires
  an independent tool-less judge call ("was the stated goal demonstrably
  achieved?"). An incomplete verdict is pushed back as explicit unmet criteria
  and the agent continues (up to 2 audit rounds). Honest cost note: the auditor
  is a real extra model call per round — its tokens are folded into your totals
  and budget meter, expect roughly a third more prompt spend on small tasks.
- **Checkpoints** — structured milestone notes written to `.agent/checkpoints/`
  (pre-compaction and compaction events today): goal, decisions, next steps,
  token/cost state. Plain markdown, inspectable, gitignore-friendly.
- **Patch backups** — before any overwrite of an existing file, the prior
  contents land in `<cwd>/.ox-backups/<timestamp>/`; oldest backups are pruned
  automatically by size. Set `OX_NO_BACKUPS=1` to disable (the bench does).
- **`ox history [query]`** — list recent sessions (id, date, cwd, first prompt)
  or full-text search every stored session transcript from `~/.ox/sessions/`.
- **`ox skill add <dir|owner/repo[/path]>`** — installs Agent-Skills-compatible
  folders into `~/.agents/skills/`. Every install passes a denylist scan of
  `SKILL.md` plus everything under `scripts/` and `references/`: curl/wget piped
  into shells, `base64 -d` obfuscation, `eval()`, destructive `rm -rf`, `.ssh`/
  `.aws` access, prompt-injection phrasing, hardcoded credential literals, and
  subprocess-spawning scripts. Rationale: skills are untrusted prompt+code
  bundles — the ClawHavoc campaign spread malicious typosquat "skills" whose
  SKILL.md bodies steered models into running remote payloads at install or
  invoke time, so ox refuses dangerous sources by default (exit code 4 with a
  findings table; `--force` overrides deliberately). Every successful install
  appends a receipt (name, source, sha256) to `~/.ox/skills-install.log`.
- **`ox episode ls` / `ox episode promote <id>`** — episodes record goal,
  outcome, lessons, optional score/verification. Promotion converts an episode
  into a reusable skill but is evidence-gated: it needs ≥1 lesson bullet AND
  (score ≥ 6 OR verified); anything less exits 4 unless `--force`.
- **Max Mode** (`--max-mode <n>`, `/max [n]`, off ≤1, cap 5) — MiMo-style
  planning: N candidate plans are drafted in independent tool-less calls, a
  strict judge picks one (`{"best": k}`), and only then does the main run start,
  with the chosen plan injected as `[SELECTED PLAN]` system guidance. Cost
  warning: this multiplies spend — N planning calls + 1 judge call happen
  *before* real work starts, and they count against `--max-cost` budgets.

## Bots & providers

`ox bots` prints this live. Prices are $/Mtok from src/cost.js.

| Bot | Provider | Key env var | Model | In | Out |
|---|---|---|---|---|---|
| grok | xai | `XAI_API_KEY` | grok-4.6 | $2 | $6 |
| grok-fast | xai | `XAI_API_KEY` | grok-build-0.1 | $1 | $2 |
| claude | anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-5 | $2 | $10 |
| opus | anthropic | `ANTHROPIC_API_KEY` | claude-opus-5 | $5 | $25 |
| haiku | anthropic | `ANTHROPIC_API_KEY` | claude-haiku-4-5 | $1 | $5 |
| gpt | openai | `OPENAI_API_KEY` | gpt-5.6-sol | $4 | $20 |
| gemini | gemini | `GEMINI_API_KEY` | gemini-3.1-pro-preview | $2 | $12 |
| flash | gemini | `GEMINI_API_KEY` | gemini-3.7-flash | $0.38 | $1.88 |
| groq | groq | `GROQ_API_KEY` | moonshotai/kimi-k2-instruct-0905 | $1 | $3 |
| deepseek | deepseek | `DEEPSEEK_API_KEY` | deepseek-v4-pro | $1.32 | $3.96 |
| ollama | ollama | none — local | qwen2.5:0.5b (any local tag) | free | free |
| openrouter | openrouter | `OPENROUTER_API_KEY` | explicit model required | varies | varies |
| backboard | backboard | `BACKBOARD_API_KEY` | backboard-routing | varies | varies |

Hard pinning by design: a missing key fails loudly naming the env var. Extra bots
are definable under `"bots"` in `~/.ox/config.json`.

A fallback chain *does* exist — `fallback_bots` (`OX_FALLBACK_BOTS`) plus
`aux_bot` — but it is never silent: every switch emits a non-dismissible
`model_switch` event naming the old and new target, and
`fallback_policy.cost: free_only` refuses paid fallbacks instead of quietly
spending.

## Tools

One-liners (`/tools` lists them live):

- `read_file` — absolute or cwd-relative paths (`~` is not expanded); optional offset/limit window; capped at 100k chars.
- `write_file` — create/overwrite with full contents; parents auto-created; overwrites show a diff and ask approval; brand-new files skip the gate.
- `edit_file` — exact match first, then CRLF/space/tab-tolerant fuzzy match; multi-match without `replace_all` errors listing every line number.
- `list_dir` — recursive tree with depth control; skips `.git/`/`node_modules`; 500-entry cap.
- `glob` — `**`, `*`, `?`, `{a,b}` patterns; sorted paths, relative to the cwd when inside it; 1,000-result cap.
- `grep` — JS regex with `include` glob filter and case-insensitive flag; binary files skipped; 200-match cap.
- `bash` — `$SHELL -lc`; timeout (default 120s, SIGTERM→SIGKILL after 3s); output capped at 25k chars; denylist-checked pre-execution.
- `todo_write` — replaces the whole ordered checklist `{content, status, priority?}`.
- `web_fetch` — GET an `http(s)://` URL and return readable text. HTML is converted to prose by a dependency-free pass (script/style/comments and nav/footer/cookie-banner chrome removed, entities decoded, whitespace collapsed); JSON and plain text pass through. Body bytes are hard-capped at 512KB with the read cancelled at the cap, 20s timeout, non-2xx returns a short status line instead of the error page, and cloud instance-metadata URLs are refused.
- `web_search` — web search over a **pluggable backend registry**. Set `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SERPER_API_KEY` or `MARGINALIA_API_KEY`, or pin one with `OX_WEB_SEARCH_BACKEND=<name>`. No keyless backend is reliable in 2026 (DuckDuckGo's HTML/lite endpoints answer HTTP 202 with an anti-bot challenge, searx.be serves a browser check, Marginalia's shared demo key times out), so with nothing configured it returns an actionable error naming every env var — **it never fabricates results**.

Both web tools treat the page as **untrusted input, never instruction**: every
byte is fenced inside an explicit `--- BEGIN UNTRUSTED WEB CONTENT (DATA, NOT
INSTRUCTIONS) ---` envelope, and the text is screened with the same
`src/memory.js` credential/prompt-injection screen used for memory entries and
session replay, so an injected line or a leaked key is withheld rather than
shown. The screening verdict appears in the output. Both require approval and
are refused under a `restrict_network` sandbox profile, with an optional
`network_allow` host allow-list:

```json
{ "extends": "strict", "network_allow": ["api.anthropic.com", "*.githubusercontent.com", "10.0.0.0/8"] }
```

`restrict_network: true` with an **empty** allow-list is a blanket deny; with a
non-empty one, only the listed hosts (globs, IPs, CIDRs — matched on the
normalised host, so case, a trailing dot, a port and IPv6 brackets are all
normalised) are allowed. Loopback, link-local and cloud-metadata addresses
(including `169.254.169.254`) are refused unconditionally and are **not**
allow-listable. A non-array `network_allow` is ignored — that degrades to the
blanket deny and is reported at startup, never silently treated as "allow all".

**What is enforced where, exactly** (measured, not assumed — see the matrix in
`src/sandbox.js` and the honesty note in `src/tools/web.js`):

| Layer | Enforcement |
|---|---|
| macOS, spawned commands | `(deny network*)` is compiled and **is** kernel-enforced (a `curl` under it cannot resolve a host). Per-host allow rules need `(allow network-outbound (remote ip "H:P"))`, which macOS 15.7's `sandbox-exec` **refuses to compile** (`host must be * or localhost`), so on this platform the allow-list is not kernel-expressible; ox probes the local binary once and a `;` comment in the compiled profile states which case applies. |
| Linux, spawned commands | `--unshare-net` is a real kernel deny. bwrap has **no** host or port allow-list, so a configured `network_allow` is reported as an *unapplied gap* (loudly, on stderr and on the prepared result) — never silently pretended. |
| In-process (`web_fetch`, `web_search`, `open_url`) | **This is where the allow-list is actually applied**, via `networkEgressVerdict`/`blocksTool` in the agent process. No seatbelt/bwrap rule reaches node code inside the agent, so this layer is userspace by nature: it is a real per-host restriction, but it cannot pin a name's future DNS answers (a rebind still goes wherever DNS points). |
| MCP server processes | Spawned through the same `prepareSandbox` prefix as `bash`, so they inherit the same deny. stdio framing is unaffected (both backends pass the inherited pipes straight through). An MCP server's *own* host allow-list is not expressible on any backend. |
| The agent process itself | Never confined. Nothing here sandboxes ox's own node process, its loaded plugins, or a dependency making a socket call. |

- `memory_list/get/add/search` — persistent project memory; `mcp__<server>__<tool>` — MCP-contributed tools (below).

## Memory

Project-scoped memory lives in `.agent/` in your repo. `MEMORY.md` is the index
always injected, capped at **150 lines / 20KB** with a prune hint beyond; entries
are typed `[user] [feedback] [project] [lesson]`, optionally dated.
- `topics/<slug>.md` — long-form detail notes behind `-> topics/...` pointers, loaded only on demand (progressive disclosure).
- `episodes/<date>-<slug>.md` — dated session records (goal, outcome, files touched, lessons); 40-line cap each; `.agent/` itself capped at 500KB.

`memory_add` dedupes: similar statements update the existing entry in place
rather than duplicating (normalized substring or Jaccard > 0.8).

### Persistence screen

Everything ox writes to a store or reads back into a prompt goes through **one**
shared screen. The pattern tables live only in `src/memory.js`
(`screenMatch`, `screenPersistText`, `screenReadLines`, `screenReadTexts`,
`shortWithheldNotice`); no module re-derives a pattern or a notice. It matches
**credential shapes** — provider key prefixes `sk-` / `ghp_` / `glpat-` / `xai-` /
`AIza` / `AKIA` / `gsk_`, JWTs, PEM private-key blocks, long bearer tokens,
inline `secret = <opaque>` assignments — and **prompt-injection phrasing**
("ignore previous instructions", "system prompt:", "you are now ..."). A refusal
names the pattern class and never echoes the text. Mentions without values ("the
api key lives in the vault") and ordinary prose ("the tokenizer splits on
whitespace") still store.

Two semantics over one table. **Write = refuse** (the value never reaches disk).
**Read = withhold** (the entry is skipped and never injected) and a read **never
rewrites or deletes the store** — deleting stays your call, and you can open the
file and see exactly what was kept back.

| | Screened |
|---|---|
| **Write** (refuse) | `addMemory` — `.agent/MEMORY.md` + `topics/*`; `recordLesson` — subagent lessons, i.e. raw tool-error text; `writeSessionNote` (`.agent/notes/`) and `writeEpisode` (`.agent/episodes/`), each screened in its collapsed, written form **and** in the derived filename slug; `recordPattern` (`.agent/procedural.md`); subagent-scoped `addEntry` (`.agent/_sub/<id>/MEMORY.md`); `screenFilePaths` — subagent `filesTouched` |
| **Read** (withhold) | `loadMemoryBlock`; `memory_list` / `memory_get` / `memory_search`, including the stored **path** in each hit; `formatProceduralContext` / `recallPatterns`; the subagent lessons block plus scoped block / list / get / search and `filesTouchedBlock`; `screenSkillBody` + skill-index frontmatter (`/skill <name>`, the `# SKILLS` system-prompt block); `replayMessages` — `--resume` / `--continue` / `/resume` / `/rewind`, covering `tool_call` arguments and tool results with order and `tool_call`/`tool_result` pairing preserved |

`addMemory`, `addEntry` and `recordLesson` are module-internal; what is exported around them
is the `memory_add` tool plus `createMemoryApi` / `createScopedMemoryApi`, and the
`memory_list` / `memory_get` / `memory_search` tool names dispatched by them.

Withholding is never silent. The withheld count rides in the injected block or
tool result as a one-line `[memory-screen] withheld N line(s) …` notice, and a
replayed session also warns on stderr. Counts land in `memoryScreenStats()` and in
one `OX_AUDIT` row per read, `t: "memory-screen"` / `event: "read-withheld"` (one
row per read, not per entry). **Cost: zero added bytes when nothing is
withheld** — every rendered path is byte-identical to its pre-screen output — and
a single ~26-token notice only when something is.

Two honest edges. A subagent's `finalText` — its live answer — passes through
unscreened into the parent's tool result, because that *is* the result; its
persisted `result`, `error` and `filesTouched` are screened on write and re-screened
on read, and screening the answer itself would hide the answer rather than
protect a memory. And a store with no prompt or tool-result reader — `.agent/notes/`,
plus `ox episode ls`, which `console.log`s to your terminal — is write-screened
but not read-screened, because nothing replays it to a model.

Precision is enforced by value-shape guards, not bare keywords: a secret-ish
name bound to a code reference (`token = config.getToken()`,
`password: process.env.DB_PASSWORD`), an env-var name (`OPENAI_API_KEY`), a bare
number, a hyphenated slug (`sk-learning-platform-2024-notes-2024`) or ordinary
prose ("you are now able to run the suite") all store normally; only values that
look random are refused. `test/memory.test.js` guards this with a table-driven
accept/reject matrix.
Evidence-gating still applies to `ox episode promote` only (`src/memory.js`),
which demands at least one lesson plus (`score >= 6` or `verified`).
`memory_add` has **no evidence gate**: `statement` is accepted with no source or
citation, and the optional `detail` field is free-form, not attribution. Treat
`memory_add` as secret-filtered but still un-gated. Repeat-failure lessons land
here automatically.

## Skills

Agent-Skills-compatible `SKILL.md` folders discovered from four standard
locations (later paths win name conflicts): `~/.agents/skills`, `.agents/skills`,
`~/.claude/skills`, `.claude/skills`. Only names + descriptions enter the system
prompt (max 25) — progressive disclosure; bodies load via `/skill <name>` or
`ox skill <name>`. Malformed skills skip with a warning, never fatal. No
registry: existing catalogs work as-is.

## MCP

Model Context Protocol client over **stdio and Streamable HTTP** transports.
Configure servers globally via `"mcpServers"` in `~/.ox/config.json` (e.g.
`{ "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } }`)
or per-project in Claude-compatible `./.mcp.json` (project overrides global);
`${VAR:-default}` expansion applies to command/args/env/headers. Tools appear as
`mcp__<server>__<tool>` behind a risk-gated policy engine (below). `/mcp` shows
live status; `/mcp restart <server>` re-spawns a crashed stdio server.

## Autonomy (v0.3)

Long-horizon headless runs over real-world surfaces, gated end to end:

```bash
ox auto "<goal>" --max-cost 1 --yes-edits   # forced verify · 80 iterations · checkpoints · summary
ox schedule "<goal>" --at 09:00             # print crontab + launchd snippets (--install appends, idempotent)
ox schedule add 30m "<prompt>" --enable     # or run it INSIDE the daemon — capped, listed, removable
ox cron add "every minute"                  # the old name; same store, free-text cadence
ox auto "<goal>" -y                         # refuses while money-risk MCP servers are active unless --side-effects-ok
```

### Daemon continuity

Unattended work outlives the terminal. The supervisor is started detached and owns
one worker process per session:

```bash
ox daemon start          # detached, idempotent — a concurrent start never spawns a second
ox daemon status         # running/stopped · pid · uptime · worker count (exit 1 when stopped)
ox daemon doctor         # pidfile / socket perms / orphaned workers; --fix repairs what is safe
ox daemon log --lines 20 # the supervisor's own account of what it did
ox agents                # running (live worker) / idle (detected) / saved (transcript on disk)
ox attach <id>           # stream a session live, answer its approvals — detaching leaves it running
ox shutdown              # stop workers, then the supervisor
ox -p "<task>" --detach  # run this session as a worker and return at once; reattach with ox attach
```

The control socket is a privilege boundary: `~/.ox/daemon` is `0700`, `c.sock` is
`0600`, and every path there is ownership-screened. The pidfile records
`(pid, instanceId)` where the instance id travels in the socket's `hello` frame, so a
**recycled PID is never mistaken for ours** — `ox daemon doctor` says
`pidfile matches the live daemon` only when both agree. Fan-out is capped by
`OX_DAEMON_MAX_WORKERS` (default 16).

### Goals that have to be proven

```bash
/goal <text>     # a PERSISTENT objective — survives turns, compaction and --resume
/goal            # the active goal plus its proven-progress ledger
/goal done       # REFUSES and names every item that is not yet proven
/goal pause | resume | clear
/goal            # also drafts a contract; /subgoal <criterion> appends a verification item
```

A goal is stored as a `{t:'goal'}` event in the same append-only JSONL transcript
everything else uses, so there is no second store to lose. Progress must be evidenced
by the transcript: **assistant prose is never evidence, reading is not doing, and
`todo_write` is excluded because its result echoes the checklist** — the tool that
could most easily fake completion is the one refused as proof. A completed goal is
terminal and never resumes.

`/heartbeat every 5m` re-enters *this* session on an interval to advance its active
goal. It is bounded (3 runs by default; `/heartbeat max-runs <n>`) and refuses to arm
against a session with no active goal — a heartbeat advances a goal, so with none it
would just start unrelated work.

| Command | Effect |
|---|---|
| `ox auto "<goal>" [flags]` | autonomous headless run; prints goal/status/files/tools/tokens/cost/session summary |
| `ox mcp add <template> [--global]` | install from curated registry (browser, gsuite, slack, alpaca, …) |
| `ox mcp ls · test <name> · remove <name>` | inspect risk/status, probe tools, delete entries |
| `ox schedule "<goal>" [--at HH:MM] [--max-cost N] [--install]` | print a system-crontab + launchd block; `--install` appends it to the crontab, marker-hash idempotent, and needs a TTY confirm (or `--yes` **and** `OX_INSTALL_YES=1` when there is no TTY) |
| `ox schedule add [<30s\|5m\|2h\|1d>] "<prompt>" [--every N] [--at HH:MM] [--max-cost N] [--enable]` | a schedule that runs INSIDE the daemon — append-only store, mandatory cost cap, listed and removable by ox |
| `ox schedule list · enable · disable · remove · run-now · opt-in · policy` | the store's verbs; `run-now` is attended (a human is watching), the TIMER is off until `opt-in` **and** the row is enabled |
| `ox cron add "<what to run>" · list · run · pause · resume · remove` | the historical name for `ox schedule`, kept working: free-text cadence, `scheduled job <id>`, `ran job <id>` |
| `ox daemon start · status · stop · doctor · log` | supervisor lifecycle: detached start (idempotent), running/stopped + pid + uptime + worker count (**exit 1** when stopped), `--fix` repair, and its own log |
| `ox agents [--json] [--limit n]` | every session in three states: `running` (live worker) / `idle` (detected, no live worker) / `saved` (transcript on disk) |
| `ox attach <id> [--no-replay]` | stream a running session live and answer its approvals; **detaching leaves the worker running** |
| `ox shutdown [--force]` | stop workers, then the supervisor (alias of `ox daemon stop`) |
| `-p "<task>" --detach` | run the session as a supervised worker and return immediately; starts a supervisor if none is running, and says so |
| `ox prompt [--breakdown] [--json]` | the assembled system prompt with its layer breakdown — kind, bytes, ~tokens and hash per layer, then cacheable prefix vs volatile tail. **No model call**: it is the text a run actually sends |
| `ox schedule policy` | what the daemon is currently allowed to do (opt-in state, max in flight, miss grace, store path) |
| `ox schedule print-crontab "<goal>"` | print a crontab block for humans; installs nothing |

Cadence accepts any `<n><unit>` duration — `30s`, `5m`, `30m`, `2h`, `1d` — or an ISO
timestamp for a one-shot (`2026-10-04T09:00:00Z`); a non-duration string is refused
with exit 3. Unattended dispatch needs **two** opt-ins: the daemon-wide
`ox schedule opt-in` **and** `enabled` on the row itself, so a fresh install runs
nothing.
| `--side-effects-ok` | authorize money-risk MCP servers under `-y` / `ox auto` |

Risk-gated policy engine: project `.ox.json` + global `mcpPolicy` maps decide
`allow`/`ask`/`deny` per server before dispatch; money-risk servers can never
self-authorize an allow (global config or `--side-effects-ok` required).
Curated stack table, safety model and walkthroughs: [docs/autonomy.md](docs/autonomy.md).

## Safety

Four approval postures, hottest to coldest:

- **default** — every `bash` and MCP call asks; writes to *existing* files ask with a diff preview (`y/n/a`).
- **`--yes-edits`** — auto-approve file writes; shell still asks. **`--plan`**/`/plan` — read-only dispatch only.
- **`-y` / `--dangerously-skip-approvals`** / `/yolo` — skip every approval prompt, and lift the extended bash denylist (`sudo`, `curl`/`wget` piped into a shell). You asked for it.

Blocked in *every* posture, yolo included: fork bombs, `mkfs`, `dd of=/dev/`,
`find … -delete`, and recursive `rm` aimed at `/`, `~`, `.` or a glob. Also
posture-independent: refusal of any write under `/.git/`, 25,000-character output
caps, timeouts, and a non-TTY fail-safe that auto-declines approval prompts when
stdin isn't a terminal instead of hanging CI.

## Sessions

Every REPL session appends lossless JSONL to `~/.ox/sessions/<ts>-<id>.jsonl`:
user text, assistant turns with tool calls, tool results. `ox -c` continues the
newest session; `ox --resume <id|path>` and `/resume` pick one mid-flight;
`/fork` copies all events into a fresh session with fork metadata. A torn final
line truncates with a warning; a corrupt mid-file line fails loudly instead of
silently dropping history.

## Context management

- Nested, path-scoped project instructions: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (then ox-native `.ox.md`) plus `rules/*.md` and `.ox/rules/*.md`, collected at every level from the **project root down to cwd** and concatenated root-first, so a deeper file overrides a shallower one for the same rule. All of it shares **one 48,000-char cap** — a nested file cannot claim a budget of its own. Frontmatter `globs:` scopes a rule to the paths the turn is about; `alwaysApply: true` is unconditional; absent or unparseable frontmatter degrades to always-on. Compaction re-reads the files from disk, so a mid-session edit takes effect.
- Gitignore-aware workspace tree embedded in every system prompt (depth ≤ 6, ≤ 800 entries, token-budgeted).
- An honest token meter — estimated context tokens vs the model's window plus running cost — rendered after every turn; it counts chars/4 and never hides.
- Auto-compaction at **75%** of the window: older turns summarized into a keep-contract block (decisions, files touched, unresolved errors, next steps), recent turns verbatim; `/compact` forces it. Stale-output trim replaces oversized outputs of all but the newest tool message with placeholders.

## Prompt assembly & cache stability

The system prompt is assembled as an ordered list of layers, each classified
`static | session | dynamic`, and the prompt is exactly those layers joined — so the
layers *are* the bytes, not a description of them. Static content comes first and all
volatile content sits in one contiguous tail, because a provider reuses an unbroken
prompt **prefix** and re-prices everything from the first changed byte onward.

Inspect it without spending anything:

```bash
ox prompt             # layer table + the full assembled text
ox prompt --breakdown # just the layer table (name · kind · bytes · ~tokens · hash)
ox prompt --json      # cacheablePrefixBytes, stablePrefixBytes, totalBytes, layers[]
```

On this repo:

```
KIND     LAYER            BYTES    ~TOK     HASH
static   core             41       ~11      ac143841dd17
static   tool-rules       699      ~175     f9368508fe11
static   subagents        629      ~158     587ecc4eb795
static   agent-messaging  459      ~115     a43938d309aa
session  skills           9653     ~2414    ee0e868e1793
session  environment      134      ~34      d8a3ad0c442c
session  workspace-tree   4714     ~1179    9f04be3382ec
dynamic  memory           90       ~23      67d43da68164
dynamic  clock            32       ~8      c09f2f3fc65e
           static prefix    1831     ~458     guaranteed cacheable
           stable prefix    16335    ~4084    static + session, fixed for the run
           volatile tail    124      ~31      breaks the cache when it changes
           TOTAL            16459    ~4115
```

Only `clock` and `memory` move. The layering exists because the assembled text used
to carry `- date: <ISO ms>` at **byte 42**, so 42 bytes of a 1962-byte prompt were
ever cacheable and the other 86% was re-read at full input price on every rebuild.

## Self-heal & reflection

Each tool failure injects guidance requiring diagnosis and a **varied strategy on
retry** ("never repeat an identical failed call"; after two failures of the same
target, change approach fundamentally or stop and report). Failures are tracked
per tool+target with a budget of three consecutive failures before aborting
loudly. Critique is external-signal-only — verdicts come from tool results (exit
codes, diffs, test output), never the model grading itself — and lessons from
recovered repeat-failures persist as `[lesson]` memory entries.

## Headless / CI

```bash
ox -p "fix the lint" --max-cost 0.50      # hard stop past $0.50 spend
cat error.log | ox -p "explain this"       # stdin piped ahead of the prompt
ox -p "..." --json > events.jsonl          # machine-readable JSONL event stream
```

`$?` is the contract — what each code means today:

| code | meaning |
|---|---|
| **0** | the run completed |
| **1** | run/stream error — an `error` event was emitted or the run threw. Note: a *tool* failure (including a safety-policy denial) is reported as `tool-end` with `isError: true` and still exits **0** — assert on the event stream, not the exit code |
| **2** | approval declined **or** budget stop (`--max-cost` / `maxCostUsd` reached the cap, or a billable model has no price row) |
| **3** | usage / bot / config error (bad flag, unresolvable bot, unknown session) |
| **4** | refused: the command needs an explicit override (`--yes`, `--force`, `--side-effects-ok`) or a safety gate said no |

`--json` emits one event object per line (`text-delta`, `tool-start/end`,
`reflection`, `compaction`, `usage`, `verification`, `max-mode`, `budget-stop`,
`final`, ...); non-TTY stdin (≤10s) is prepended to `-p`.

### ⚠ Breaking change: a budget-stopped run now exits 2 (it used to exit 0)

A run cut short by `--max-cost` / `maxCostUsd` used to exit **0**. It now exits
**2** — the code the other three budget-stop paths already used
(`OX_BUDGET_STOP`'s `exitCode` in `src/cost.js`, `ox auto`'s preflight assert,
and the in-loop abort in `src/headless.js`). A truncated run must not report
success, so **`ox -p "…" --max-cost 0.5` no longer means "done"**.

**If a script or CI job treats exit 0 as "the run completed", it is affected.**
Exit 2 is also what an approval denial returns, so branch on the output, not on
2 alone.

Structured detection is **unchanged** and is still the supported way to spot a
truncated run in `--json` output:

- every stop emits `{"t":"budget-stop","reason":"cost-cap"|"unknown-cost","message":…,"costUsd":…,"maxCostUsd":…}`
- `ox auto --json` ends with `{"t":"auto-summary","status":"budget-stopped",…}`; `status` is one of `complete` · `blocked` · `error` · `budget-stopped`
- the run's session checkpoint (`.agent/notes/*.md`) records `- Status: budget-stopped`

Migrate by moving the check off `$?` and onto that field:

```bash
# before: exit 0 was read as "no crash". A budget-stopped run now exits 2, so
# keep the cap and detect the stop from the structured output instead.
ox -p "fix the lint" --max-cost 0.50 --json > events.jsonl
grep -q '"t":"budget-stop"' events.jsonl && echo "hit the cost cap" \
  || echo "ran to completion"
```

```yaml
# CI: exit 2 means "declined OR budget-stopped", so allow it and read the event.
- run: ox -p "fix the lint" --max-cost 0.50 --json > events.jsonl
  continue-on-error: true
- run: grep -q '"t":"budget-stop"' events.jsonl && echo "::warning::budget cap hit"
```

## IPC / GUI bridge

`--ipc` gives a connected GUI two things: a live view of the run, and the
ability to answer approval prompts out of band.

```bash
ox -p "refactor the parser" --ipc          # bridge for this run, closed on exit
ox -p "..." --ipc=/tmp/ox.sock             # explicit socket
ox ipc serve [--socket <path>]             # bridge in the foreground
ox ipc status                              # is a bridge listening? (exit 1 if not)
```

The bridge is a unix socket carrying **newline-delimited JSON** — one JSON
object per line, `\n`-terminated. Default path: `<tmpdir>/ox-ipc-default.sock`.
`OX_IPC_APPROVAL_TIMEOUT_MS` caps how long a connected client may hold an
approval (default 115s, i.e. just under a typical GUI dialog timeout).

| direction | message |
| --- | --- |
| server → client | `{type:'hello', sessionId, pid, cwd, bot, model, version}` |
| | `{type:'event', event, at}` — the agent's own events (`tool-start/end`, `text-delta`, `error`, `approval`, `usage`, `turn-end`, ...) |
| | `{type:'approval-request', id, tool, args, argsPreview, cwd, at, deadlineAt}` |
| | `{type:'pong'}` |
| client → server | `{type:'ready', clientId}` — required before a client can hold an approval |
| | `{type:'approval-answer', id, decision}` with `decision` ∈ `allow` \| `deny` \| `ask` |
| | `{type:'ping'}` |

Every frame is passed through `sanitizeForWire` first: `apiKey`/`authorization`/
`token`/`password`/… keys are masked at any depth, strings are truncated, and
nothing is forwarded whole. Streamed text is coalesced into at most one frame
per ~150 ms (and flushed on turn boundaries) so a slow client can't be flooded;
tool, error, and approval events are never throttled.

**Safety — silence is a decline.** The order is: `--yolo`/`a` → interactive TTY
prompt → IPC client that is connected *and ready* *and answers* `allow` →
otherwise the existing non-TTY decline. No client, no answer, a timeout, a
disconnect, a malformed frame, an unknown id, an invalid decision, or a
superseded approval all mean **declined**. A GUI can watch everything and still
be unable to let anything through by accident; it can only ever refuse on your
behalf, or allow something it was explicitly asked about. A second `ox` run
pointed at a live socket fails with `ipc socket already in use` rather than
taking it over, and the socket file is removed on exit, SIGINT, and SIGTERM.

```js
// minimal client: watch the run, answer one prompt
import net from 'node:net';

const socketPath = process.argv[2] ?? '/tmp/ox-ipc-default.sock';
const sock = net.connect({ path: socketPath });
sock.setEncoding('utf8');
sock.write(`${JSON.stringify({ type: 'ready', clientId: 'my-gui' })}\n`);

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }          // bad frame: skip
    if (msg.type === 'event' && msg.event?.type === 'tool-start') {
      console.log('·', msg.event.name);
    } else if (msg.type === 'approval-request') {
      // Anything other than an explicit 'allow' leaves the tool declined.
      sock.write(`${JSON.stringify({ type: 'approval-answer', id: msg.id, decision: 'allow' })}\n`);
    }
  }
});
```

## Benchmarks

```bash
node bench/runner.mjs                 # full deterministic suite (25 scenarios)
node bench/runner.mjs --list          # scenario catalog
node bench/runner.mjs --filter 16     # subset by name/description/category regex
node bench/runner.mjs --live          # real-provider reruns where a scenario defines livePrompt
node bench/runner.mjs --json out.json # machine-readable results
node bench/runner.mjs --update-baseline # opt-in: replace the bench/RESULTS.md canary baseline
```

Honest methodology: deterministic mode (the default) spawns the real `ox` CLI in
a sandboxed HOME/cwd against a local mock OpenAI-SSE server on loopback only —
no network, no keys, fully reproducible. Token counts and costs therefore
reflect ox's metering of *scripted* traffic at listed prices, not live-model
behavior; `--live` reruns scenarios that opt in against a real provider when a
key is present, and skips otherwise.

Headline numbers (deterministic, darwin/arm64, node 22): **25/25 scenarios passing (100%)**
in ~7s wall time, ~73,800 tokens in / ~18,380 out, ~$0.258 simulated spend.
Full per-scenario table: [bench/RESULTS.md](bench/RESULTS.md); harness and
scenario conventions: bench/harness.mjs + bench/README.md.

For real agent runs against live models (no mock provider, graded by executing
code in the workspace the agent left): [docs/REAL_BENCH.md](docs/REAL_BENCH.md).

## Slash commands

| Command | Effect |
|---|---|
| `/help` | command list |
| `/bot [name]` · `/model <provider:model>` | show or hot-switch bot/model, conversation kept |
| `/cost` | estimated tokens, in/out totals, spend |
| `/compact` | summarize older history to shrink context |
| `/clear` · `/plan` | wipe in-memory context (file kept) · toggle plan mode |
| `/tools` | list available tools incl. MCP |
| `/memory` | show project memory index |
| `/skill [name]` | list skills or load one into context |
| `/mcp [restart <server>]` | MCP status / re-spawn a server |
| `/goal <text>` | set a **persistent** goal — kept across turns, compaction and resume; also drafts a contract |
| `/goal` | the active goal plus its **proven** progress |
| `/goal done` | mark complete — **refuses and names items** until every one is proven from the transcript |
| `/goal pause` · `/goal resume` · `/goal clear` | stop pursuing it (keep it) · pursue it again · remove it |
| `/subgoal <criterion>` | append a criterion to the contract's verification field |
| `/refine` | review this trajectory for evidence-backed refinements (dry run) |
| `/refine apply [file]` | apply reviewed proposals: supplemental guidance, memories, skill descriptions, subagent specs |
| `/refine history` · `/refine undo` | applied **and rejected** proposals, with reasons · roll back a snapshot |
| `/schedule` · `/schedule add <cadence> "<text>"` | list every schedule (cadence, cap, next run, last result) · create one |
| `/schedule enable\|disable\|remove <id>` · `/schedule remove-all` · `/schedule run-now <id>` | row verbs; `run-now` dispatches through the daemon NOW |
| `/schedule opt-in` · `/schedule opt-out` | the daemon-wide switch — **OFF until you opt in** |
| `/heartbeat` · `/heartbeat every <30s\|5m\|2h>` · `/heartbeat max-runs <n>` · `/heartbeat stop` | this session's heartbeat state + goal progress · re-enter on an interval · run budget (default 3) · remove them |
| `/session` | current session id, path, message count |
| `/resume <id\|path>` · `/fork` | load another session / fork this one |
| `/verify` | toggle the independent goal verifier (audits each final answer) |
| `/max [n]` | Max Mode: N planning passes judged before each run (off ≤1, cap 5) |
| `/yolo` | toggle approval skipping |
| `/doctor` | environment checks |
| `/screen [question]` | ask about what is on your screen (attaches a screenshot) |
| `/ui` · `1`, `2`, … | redraw the last OX Canvas · press its buttons |
| `/island on\|off\|status` | turn the notch island on or off (remembered) |
| `/exit`, `/quit` | save episode and leave |

`/refine` has **four** target categories and no free-form path: `supplemental-prompt`
(max 1 line / 200 chars), `memory` (240), `skill-description` (300), `subagent-spec`
(300). It shares `ox episode promote`'s bar — **≥1 lesson AND (score ≥ 6 OR
verified)** — and `score`/`verified` come from the **reviewer's** judgement, never
from the proposal text, so a model cannot vote itself past the gate. Seven targets
are never refinable, including the base system prompt, sandbox profiles, trust
levels, the approval policy, cost caps, API keys and the harness source tree.

## Development

```bash
npm test        # node --test test/*.test.js — all suites, offline
npm start       # node bin/ox.js
ox doctor       # probes node/git/~/.ox/provider keys/ollama/MCP/skills/.agent/
```

The `node --test` suite under `test/` (run `npm test` for the current totals —
the count changes as coverage grows) covers providers (SSE parsing for all three wire
formats), tools, memory, skills (incl. the skill-add safety denylist), MCP
(spawned stdio servers), sessions, config, context, bots, CLI parsing, v0.2
verify/checkpoint/history behavior, v0.3-v0.7 lifecycle/skill-curator/
sandbox/rewind/audit/compaction/hooks, model routing, self-improvement,
plan-first, repo map, tiered trust, and end-to-end headless runs. Tests
sandbox
HOME and cwd into tmpdirs; nothing writes outside them.

Source layout: `src/agent.js` (the loop: stream → tools → reflect → compact);
`cli.js`, `headless.js` (REPL, flags, -p pipeline); `bots.js` + `providers/`
(presets; openai-compat/anthropic/gemini adapters + SSE parsers); `tools/`
(fs, exec denylist+timeout, todo); plus `memory.js` (episodes, checkpoints,
promotion), `skills.js`, `skill-add.js` (denylist-gated installs), `maxmode.js`
(planning/judging), `mcp.js`, `session.js`, `context.js`, `cost.js`,
`approval.js`, `ui.js`, `system-prompt.js`. Zero-dependency policy: no
dependencies, no devDependencies,
ever — features cost code, not packages. Background: docs/research.md (field
study), docs/comparison.md (matrix), docs/plan.md (architecture).

## Roadmap

What v0 does **not** do, honestly: hooks ship in v0 with a narrower event set
than Claude Code's 27 — all six declared events fire, but there is no
turn-start/end hook, no approval-requested hook, and no user-prompt hook.
Subagents ship as summary-returning components. Kernel sandboxing (Seatbelt/Landlock/bwrap) is deferred — kernel sandboxing (Seatbelt/Landlock/bwrap) is deferred —
approvals + denylist + timeouts are a lighter guarantee, comparison.md says so
outright; IDE integration deferred, the terminal is the product.

## v0.4 reliability & lifecycle

Reliability additions are opt-in or budgeted; defaults stay loud and pinned.

- **Aux-bot routing**: cheap subtasks (goal-contract drafting, titles, judging)
  go to `aux_bot` when set; the primary still does the heavy lifting.
- **Model windows + schema pruning**: `model_window` (env `OX_MODEL_WINDOW`)
  sizes context; tool schemas are pruned to fit, floored so core tools survive.
- **Transport continuation retries**: rate-limit/quota/server errors ride a
  retry budget; truncated streams continue from the tail instead of dying.
  `classifyProviderError` treats auth/not-found as terminal for the primary.
- **Post-edit syntax lint**: files mutated by edit/write get a best-effort
  syntax check; failure appends an advisory line (`meta.lintFail`) — never blocks.
- **Skill curator lifecycle**: `ox skill curate [--dry-run]` archives stale
  skills via snapshot + ledger; `pin|unpin` immunity (`skill_pins`), plus
  `restore`, `adopt`, `purge [--yes]`. Knobs: curator `stale_after_days` (30),
  `archive_after_days` (90).
- **Cross-provider `fallback_bots`**: ordered chain in config or comma-list env
  `OX_FALLBACK_BOTS`. Default empty — hard pinning remains the default stance;
  you must explicitly name the bots allowed to serve/bill as secondaries.
- **Persistent goals**: `/goal <text>` keeps an objective ACTIVE across turn
  boundaries, compaction and session resume — it is an event in the session
  transcript, recovered by the same `loadSessionWithStatus` read that replays
  messages, so there is no second store to drift. The objective renders at the
  top of every turn's prompt. The checklist is the existing `todo_write` list (one
  mechanism, not two) and progress is PROVEN, not claimed: `todo_write` saying
  `completed` is only a claim, and an item with no supporting tool call (or
  passing quality gate) in the transcript stays **unverified** and can never
  satisfy the goal. Assistant prose is never evidence. `/goal` shows what is
  proven, pending, unverified or blocked; `/goal done` REFUSES and names the
  unmet items until every one is proven; `/goal pause|resume|clear` manage the
  lifecycle, and a completed goal does not resurrect on resume. `--max-cost`
  stopping a run leaves the goal ACTIVE with the budget reason — reaching a limit
  is not task success. Goals are screened like memory (`screenPersistText` on
  write, `screenReadLines` on read): an objective carrying a credential is
  neither persisted nor replayed.
- **Goal contracts + shell gates**: `/goal <text>` also drafts criteria +
  verification; verification segments starting `gate: <cmd>` run as shell quality
  gates with their own retry counter and a git-fingerprint skip when state is
  unchanged; `/subgoal` appends criteria; `/gates` shows gate states. The LLM
  verifier runs only after gates pass (gated iterations are not charged). The
  contract is per-call; the goal above is what persists.
- **@ context refs**: `@file`, `@dir/`, `@git.diff` expand inline before send,
  capped near 8KB total; unknown tokens stay literal.
- **Session export/redact/prune**: `ox session export (<id>|latest)
  [--format md|jsonl] [--redact] [--out <file>]` (redaction strips secret-like
  strings; files written 0600); `ox session prune --older-than <Nd> [--dry-run]`.

## v0.5 security & context hardening

Hardening wave from the grok-build/OpenBot research. Defaults stay conservative;
every classifier has a kill switch.

- **OS sandbox profiles**: `--sandbox off|workspace|read-only|strict` (or a
  custom profile in `~/.ox/sandbox.json` / `./.ox-sandbox.json`) runs child
  shells under sandbox-exec (macOS SBPL) or bwrap (Linux), pinned per session —
  resume with a different profile refuses (exit 4). Without an OS backend ox
  says so loudly and DEGRADES to userspace confinement rather than pretending.

#### Custom sandbox profiles

`--sandbox <name>` where `<name>` is not a preset loads that profile from
`./.ox-sandbox.json` (project) or `~/.ox/sandbox.json` (home), project first.
The only required field is `extends` (default `workspace`). Every list entry is
either a **literal path** or a **glob** — the gitignore subset `**`, `*`, `?`,
`[...]`, `[!a]`. An unsupported metacharacter (`{…}`, a backslash escape, an
unclosed `[`) makes startup **refuse** (exit 4) naming the file and line.

```json
{
  "extends": "workspace",
  "read_only":  ["/abs/path/to/secrets", "src/**/*.pem"],
  "read_write": ["/tmp/scratch"],
  "deny":       ["/etc/master.key", "~/.ssh"],
  "restrict_network": true,
  "network_allow": ["api.anthropic.com", "10.0.0.0/8"]
}
```

| Field | Meaning | Enforced on macOS | Enforced on Linux |
|---|---|---|---|
| `read_only` | Reads allowed, **writes denied** under each entry. | **Yes**, kernel. One `(deny file-write* (subpath …))` per **literal** entry and one `(deny file-write* (regex …))` per **glob**, both emitted *after* the write roots so they hold **inside `cwd`** and beat an overlapping `read_write`. | **No** — reported as an unapplied gap. |
| `read_write` | Widens the writable set. | Yes, kernel (`(allow file-write* (subpath …))` / anchored regex). | Literals only (`--bind`); a glob has no bwrap form and is reported. |
| `deny` | Explicit read **and** write deny, compiled last. | **Yes**, kernel. | **No** — reported as an unapplied gap. |
| `restrict_network` / `network_allow` | Egress policy — see the table above. | Blanket deny yes; per-host allow-lists are in-process only on macOS. | `--unshare-net` yes; the allow-list is in-process only. |

`read_only` is the field most likely to be silently wrong, so two rules hold for
it unconditionally:

- **Literal and glob entries are compiled identically.** A literal is a
  `(subpath …)` deny, a glob an anchored `(regex …)` deny. There is no path
  spelling that is parsed and then not enforced — the earlier behaviour of
  skipping literal entries was a fail-open hole inside `cwd`, where the blanket
  `(allow file-write* (subpath "<cwd>"))` overrode the `(deny file-write*)` that
  was supposed to cover them.
- **`read_only` wins over `read_write`** when they overlap, and `/sandbox`
  prints the loaded `read_only` / `read_write` / `deny` entries so you can see
  that a policy was loaded at all.
- **A literal is a subtree deny; a glob is an anchored full-path regex.**
  `"read_only": ["/srv/data"]` denies writes anywhere under `/srv/data`
  (`(subpath …)`), but `"read_only": ["/srv/data*"]` matches only the entry
  `/srv/data` itself — not `/srv/data/inside`. Write `/srv/data/**` when you
  mean the whole tree.

On Linux `read_only` and `deny` cannot be expressed by bwrap (it is a mount
builder, not a policy language). ox does **not** drop them quietly: `bwrapGaps()`
returns their names, `prepareSandbox()` warns once on stderr, the prepared
result carries `gaps.unapplied`, and `/sandbox` prints them under "not
enforceable on the 'bwrap' backend". Check that list before relying on a
`read_only` path on Linux.
- **Network egress control**: `restrict_network` (on by default for `strict`,
  and settable on any custom profile) plus an optional `network_allow` host
  allow-list. What the kernel enforces, what only the in-process layer enforces,
  and what is not expressible at all (Linux allow-lists, macOS per-host rules)
  are each stated in the table above and recorded on the compiled profile.
  `resolveSandbox` attaches a real `blocksTool`, so a profile deny reaches
  `src/guards.js` and `src/verify-loop.js` and stays monotonic — it beats
  `--yolo`. MCP servers are spawned under the same prefix, closing the hole
  where a confined agent's server could still open any socket.
- **Env sanitizer**: children get a filtered environment — `core` keeps basics
  only, `all` passes everything except `*KEY*/*SECRET*/TOKEN` shapes, `none` is
  minimal. Proxy credentials are always stripped; include/exclude override.
- **Chain-aware bash parsing**: commands split quote-aware into segments
  (`&& || ; |` + redirections), wrappers peeled (`env/timeout/nice…`), denylist
  checks PER SEGMENT — `echo ok && rm -rf ~` can't hide behind a benign head.
- **Rewind points**: every user turn drops a marker; `/rewind <n>` restores the
  conversation to that turn (files on disk are NOT reverted).
- **Doom-loop guard**: a third identical tool call in a row never executes; it
  is denied with guidance instead of burning self-heal budget.
- **Decision audit ledger**: every allow/deny recorded pre-execution with rule,
  actor, args hash, linked outcome row in `~/.ox/audit.jsonl` (capped, 0600);
  `OX_AUDIT=0` disables.
- **MCP URL/host hygiene**: http servers refuse credentials, metadata IPs,
  link-local/ULA ranges, wildcard `*.internal`; redirects re-validated per hop.
  `mcp_allowed_hosts` (config/env) gates private hosts, fail-closed at startup.
- **Tool-offer narrowing** (`tools.narrow`, default true): offers >12 tools are
  selected by relevance to the message. The core nine always ship; `memory_*`,
  desktop/operator tools and `mcp__*` ship only when the message carries that
  group's keyword signal (a skill-index line unlocks its tools when it NAMES one
  or shares ≥2 keywords). A cut that saves <50 tokens, or that would drop a tool
  the message is about, is refused; fail-open below 4 survivors. Withheld names
  are listed in the system prompt so the capability is never silently
  unsatisfiable. Emits one `tool-narrowing {offered,total}` event per turn.
- **Two-pass compaction** (`compaction.two_pass`, env `OX_TWO_PASS=1`;
  `compaction.detail` none|minimal|balanced|verbose → 80/150/300/500-word
  budgets): after summarizing, a second aux call distills the summary down to
  what remains actionable for the stated goal contract.
- **Deeper-wins, path-scoped rules**: AGENTS.md / CLAUDE.md / GEMINI.md /
  .ox.md (lowest precedence first) plus rules/*.md and .ox/rules/*.md accumulate
  from the project root (git toplevel, else the outermost ancestor carrying a
  project marker) DOWN TO cwd — never above it, so `/Users/me/AGENTS.md` no
  longer leaks into `/Users/me/ox/src`. Root-first concatenation means nested
  instructions appear later and win conflicts (Cursor's parent-child model);
  nearest-wins shadowing stays removed.
  Supported frontmatter, and nothing else: `alwaysApply:` (true/false),
  `globs:` (comma-separated or a `- item` list, globby/globstar semantics so
  `src/**/*.ts` also matches `src/a.ts`), `description:` (informational). A
  `globs:` rule is injected only when a path the turn is about matches it —
  ox resolves that from `ctx.scopedPaths` or the `@path` refs in your message,
  because there is no reliable "about to touch" signal before the model speaks.
  Absent, unterminated or unparseable frontmatter degrades to `alwaysApply:
  true`, never to exclusion. One 48,000-char cap over the whole block with a
  truncation notice; `buildContext().instructions` reports
  files/included/scoped/withheld/truncated/chars.
  Compaction re-reads the block from disk, so an `AGENTS.md` you edit mid-session
  takes effect at the next compaction.
  Instruction content is untrusted INPUT and goes through the same
  credential/injection read screen as skill frontmatter and `.agent/MEMORY.md`
  (withheld lines are counted and disclosed, never silently dropped). A symlink
  whose real target leaves the project is refused, and no instruction file can
  read or change trust/approval configuration — it is data, not a control.
- **Read-only auto-approve ladder**: in default mode, bash calls whose every
  segment provably reads (ls, cat, git status, sort …) skip the prompt — still
  audited as actor `readonly-classifier`, shown dim as "auto · read-only".
  Mutation floors (`rm`, redirections, `xargs`, `sort --compress-program`, …)
  force a prompt; `--strict-approvals` / `/strict` disable the classifier.

## v0.6 model routing, hooks, and power commands

- **Universal Model Registry** (`src/model-registry.js`): every preset bot
  and custom bot is scored against the task profile (kind, complexity,
  requires: { tools, vision, longContext }) and the selected strategy.
  Strategies: `pinned` (always the configured default), `cost` (prefer fast
  /cheap unless complexity is high — the default), `quality` (prefer the
  flagship for any non-trivial task), `fast` (always a fast model). Set via
  `--routing <strategy>` or `routing_strategy` in `~/.ox/config.json`.
  Auxiliary calls (compaction, goal verifier, max-mode planning) auto-route
  to a cheap model when no explicit `auxBot` is configured.
- **Hooks system** (`src/hooks.js`): user-defined shell commands that fire at
  tool boundaries. Configure in `~/.ox/config.json` (global) or
  `.ox/hooks.json` (project, overrides global). Each entry: `{ matcher:
  "Bash|Edit", command: "...", timeoutMs: 10000 }`.

  **All six declared events fire**, and each has a call site in `src/agent.js`
  (`test/hook-events.test.js` drives all six through the real agent loop):

  | Event | When | Dispatch |
  | --- | --- | --- |
  | `PreToolUse` | before tool dispatch, on both the serial and the parallel read-only path | blocking |
  | `PostToolUse` | after dispatch | blocking |
  | `PreLLM` | before every LLM request | **fire-and-forget** |
  | `PostLLM` | after every LLM request, **including one that errored** | **fire-and-forget** |
  | `SessionStart` | once per run, before the first LLM call | blocking |
  | `SessionStop` | once per run, at teardown | blocking |

  `PreLLM`/`PostLLM` fire once per stream **attempt**, so a transport retry or a
  fallback bounce produces a fresh pair — that is what actually hit the
  provider. `SessionStart`/`SessionStop` fire once per `runAgentLoop()` call
  (in the REPL that is once per turn, since each turn is one loop call); they do
  not fire per inner-loop iteration.

  `PreLLM`/`PostLLM` are deliberately **not** awaited. `runHook` is awaited
  serially with a 10s default timeout and fails open, so a blocking pair would
  add ~5.5ms per turn for trivial hooks and up to 2 × `timeoutMs` per turn when
  a hook hangs — paid on every single LLM call for observability that never
  gates anything. Fire-and-forget here cannot throw into the agent loop (explicit
  `catch`), and the in-flight work is drained at teardown and on early exit so a
  hook is never silently dropped. The trade-off: a `PreLLM`/`PostLLM` hook's side
  effects are not ordered against the model call that follows it. A hook that
  must complete before the next LLM call belongs on `PreToolUse`, which blocks.

  **A configured hook is never silent.** Whenever one actually fires, the agent
  emits a `hook-event` NDJSON event (visible under `--json`) carrying the event
  name, whether it was blocking or fire-and-forget, and how many hooks ran.

  Env vars exposed to a hook: `OX_HOOK_EVENT`, `OX_HOOK_CWD`, `OX_SESSION_ID`,
  and for tool events `OX_TOOL_NAME`, `OX_TOOL_ARGS`, `OX_TOOL_INPUT`,
  `OX_FILE_PATH`. `OX_MODEL` / `OX_BOT` / `OX_PROMPT` / `OX_TOKENS_IN` /
  `OX_TOKENS_OUT` reach the LLM and session events. `OX_HOOK_ERROR` is set on a
  `PostLLM` payload **only when the stream errored** (it holds the error text);
  a clean turn leaves it unset, so a hook can branch on it without parsing
  stdout or exit status.

  **Execution and security semantics** — hooks are a security surface, so the
  real rules, not the aspirational ones:

  - **Env-var delivery only.** Hooks are spawned as `sh -c "<command>"` with
    `stdio: ['ignore', 'pipe', 'pipe']`. **stdin is closed**: a hook cannot read
    input from the agent. Everything it learns arrives in environment variables.
  - **Fail-open.** A hook that exceeds its timeout (default 10s) or errors out
    (non-zero exit, spawn failure) resolves to `decision: 'allow'`. A hook can
    block a tool only by *successfully* exiting 2; it can never block by
    failing. **Do not treat a hook as a security control.**
  - **Blocking and serial — except PreLLM/PostLLM.** `PreToolUse`, `PostToolUse`,
    `SessionStart`, and `SessionStop` hooks for an event are awaited one at a
    time, each stalling the agent loop for up to its own timeout. Worst case,
    N hooks × timeout is the latency added to that event. `PreLLM`/`PostLLM` are
    fire-and-forget instead (see the table above): they are dispatched but not
    awaited, and drained at teardown.
  - **Denial is `PreToolUse`-only.** Exit code 2 on `PreToolUse` denies the
    tool and replaces its result with `[blocked by hook: <stderr>]`. Every other
    exit code allows. Exit 2 on any other event does nothing.
  - **Output handling.** `PreToolUse` stdout is appended to the tool result as
    extra context for the model. `PostToolUse` stdout is discarded — only its
    side effects matter.
  - **Errors are not logged.** Hook failures are swallowed, not reported. The
    only hook error that reaches the user is stderr from a `PreToolUse` denial,
    embedded in the `[blocked by hook: ...]` message. If a hook is supposed to
    run, verify it yourself; the agent will not tell you when it doesn't run.
- **Power-user slash commands** (`src/cmd-power.js`): nine one-shot commands
  that inject a curated prompt into the conversation: `/init` (analyze
  project, save memory entries), `/commit` (draft conventional commit from
  diff), `/review` (code review unstaged/staged), `/test [path]` (generate
  tests), `/explain [path]` (explain a file), `/fix` (run detected linter +
  fix), `/refactor [path]` (suggest refactorings), `/doc [path]` (add
  JSDoc/docstrings), `/migrate <desc>` (plan + execute a migration).

## v0.7 Features

- **Self-improvement loop** — Reflexion pattern: after each task, the agent
  analyzes what went well/poorly, extracts reusable behavioral patterns, and
  persists them as `[lesson]`-typed memory entries. Patterns are automatically
  extracted from successful and failed turns alike, building a durable
  improvement signal across sessions.
- **Plan-First UX** (`--plan` flag, `/plan` and `/reflect` commands) — toggles
  plan-only dispatch where the agent drafts a step-by-step plan and pauses for
  approval before executing. `/plan` enters plan-first mode in the REPL;
  `--plan` does the same on the command line. `/reflect` triggers a manual
  pattern-extraction pass against the current session history.
- **Repository map** (`buildRepoMap`, `renderRepoMap`, `findRelevantFiles`,
  `getRelevantSnippets`, `ContextBudget`) — a structured code map indexes
  files, symbols, and cross-references; `findRelevantFiles` ranks by relevance
  to the active task; `getRelevantSnippets` pulls only the needed context under
  a `ContextBudget` that enforces hard token ceilings. `renderRepoMap`
  serializes the live map for inspection.
- **Tiered trust** (`paranoid | strict | balanced | trusted | yolo`) — five
  approval postures replacing the old read-only auto-approve ladder. `paranoid`
  asks on every tool call; `strict` (default) permits only proven read-only
  segments and asks on everything else; `balanced` widens auto-approve to
  project-local shell and project-local writes, still asking on mutations and
  external commands; `trusted` auto-approves edits, network, and non-destructive
  shell (destructive commands still ask); `yolo` skips everything.
  Set via `--trust <level>` or the `/trust` command in the REPL.
- **Reflective commands** — `/reflect` extracts patterns from the current
  session manually, surfacing distilled lessons as memory candidates before
  they are committed to the self-improvement loop.

## Advanced integrations

ox speaks the formats of every major agent ecosystem — skills, MCP, AGENTS.md — so you can bring your existing workflows or extend ox with curated templates.

| Integration | ox command | What it enables |
|---|---|---|
| **Agent presets** | `ox agent list|save|use|delete` | Save model+MCP+skills combos as named presets in `~/.ox/agents/*.json` |
| **Import from CC/Hermes/Codex** | `ox import <claude-code|hermes|codex|all>` | Migrate skills, MCP servers, memory from other agents |
| **Durable tasks** | `ox task list|add|run|update|delete` | Deferred goals in `~/.ox/tasks/` beyond schedule snippets |
| **HTTP API** | `ox serve --port 8080` | OpenAI-compatible server: `/health`, `/v1/models`, `/v1/models/:id`, `/v1/chat/completions`, `/v1/responses` — each turn maps to one ox turn. Binds loopback by default; a non-loopback bind requires `OX_SERVE_API_KEY` |
| **Browser automation** | `ox mcp add browser-harness` | Playwright-based browser via MCP (see `docs/integrations/browser.md`) |
| **Stagehand** | `ox mcp add stagehand` | Browserbase act/observe/extract/agent primitives |
| **Camoufox** | `ox mcp add camoufox` | Anti-detect Firefox backend for browser MCP |
| **Trawl** | `ox mcp add trawl` | Self-hosted hard fetches with challenge solving |
| **Unity game dev** | `ox mcp add unity` | Unity Editor MCP for scripts/scenes/builds (see `docs/integrations/unity.md`) |
| **Voice dictation** | `ox skill add openwhispr` | OpenWhispr STT → pipe to ox (see `docs/integrations/voice.md`) |
| **Backboard.io** | `ox agent save backboard --provider openai --base-url https://api.backboard.io/v1` | Model routing, memory bridge, R-CLI coexistence (see `docs/integrations/backboard.md`) |

**Non-goals** (explicitly unsupported): Thuki overlay UI, HeyClicky cloud buddy, Clicky web analytics, TrueForge full UI. See `docs/integrations/non-goals.md` for rationale.

Full integration guides: `docs/integrations/README.md`

## What's shipped (v0.1.0)

This README describes the **v0.1.0** release. The version is single-sourced in
`package.json`; docs and `bin/ox.js -v` read from the same value via `require('../package.json').version`.

- **Agent core** — streaming tool loop with approvals, bash denylist, doom-loop
  detection, self-heal retries, and cost-budget stops.
- **Providers** — OpenAI-compatible, Anthropic, Gemini, plus bot presets.
- **Tools** — file read/write/edit/list/glob/grep, bash, todo, memory, MCP,
  subagents.
- **Safety** — MCP host allowlist, money-risk gating, sandbox profiles,
  `--max-cost`, skill-install malware scan.
- **Sessions** — append-only JSONL under `~/.ox/sessions/`.
- **Memory & skills** — `.agent/` store, Agent Skills discovery,
  evidence-gated episode promotion.
- **Headless** — `ox -p`, `--json`, exit codes — table, and the budget-stop
  breaking change, in [Headless / CI](#headless--ci).
- **Tiered trust** (`paranoid | strict | balanced | trusted | yolo`) — five
  approval postures. `paranoid` asks on every tool call; `strict` (default)
  permits only proven read-only segments; `balanced` widens auto-approve to
  project-local shell and writes; `trusted` auto-approves edits, network, and
  non-destructive shell (destructive commands still ask); `yolo` skips
  everything. Set via `--trust <level>` or the `/trust` command.
- **Reflective commands** — `/reflect` extracts patterns from the current
  session manually, surfacing distilled lessons as memory candidates before
  they are committed to the self-improvement loop.

## Desktop App (experimental)

ox ships a Tauri-based desktop wrapper that runs the CLI in a native window.
See [desktop/README.md](desktop/README.md) for build prerequisites, dev
workflow, and packaging instructions.

**Not yet shipped:** auto-update mechanism, real IDE editor (the desktop is
currently a thin shell around `ox -p --json`), tab autocomplete, cloud agents.

## Benchmarks

Deterministic 25-scenario benchmark suite under `bench/`. Run with
`node bench/runner.mjs`. Each run writes to a run-scoped `bench/results/<timestamp>/`
directory (`RESULTS.md` + `canary.json`); `bench/RESULTS.md` is the protected
baseline and is only replaced when `node bench/runner.mjs --update-baseline` is
passed explicitly. `node scripts/regression-canary.js` diffs the two and writes
`bench/canary.json`.
