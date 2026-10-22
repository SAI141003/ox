# ox build plan (authoritative)

**This document is the single source of truth for implementation agents.** Where this file and any other doc disagree, this file wins. Where this file is silent, implement the smallest dependency-free option that satisfies research.md's evidence base. README is finalized in a later task — do not write it now.

---

## 0. Product identity & hard constraints

- **Name:** `ox` — "the featherweight coding agent".
- **Repo:** `/Users/saiyaganti/ox`.
- **Runtime:** Node ≥18, ESM only (`"type":"module"`), **ZERO npm runtime dependencies**. Dev/test framework: `node:test`. No postinstall scripts, no network calls except provider/MCP endpoints configured by the user.
- **Performance budgets (CI-enforced):** `ox --version` cold start <150ms; entire source tree <250KB.
- **Trust posture:** zero telemetry by construction (no telemetry code path exists); all state under user control (`~/.ox/`, project `.agent/`).
- **Package name:** `ox-agent`.

## 1. Layout

```
ox/
├── package.json
├── bin/
│   └── ox.js                 # #!/usr/bin/env node → import ../src/cli.js
├── src/
│   ├── cli.js                # arg parsing, mode dispatch, REPL
│   ├── config.js             # layered config, env keys, project files
│   ├── bots.js               # presets + custom bots + /bot resolution
│   ├── agent.js              # agentic loop, self-heal, reflection
│   ├── context.js            # hierarchy files, repo tree, compaction, honest meter
│   ├── memory.js             # .agent/ store backend
│   ├── skills.js             # SKILL.md discovery, index, invoke
│   ├── mcp.js                # stdio MCP client
│   ├── session.js            # JSONL sessions: continue/resume/fork/export
│   ├── approval.js           # modes, gates, audit log
│   ├── headless.js           # -p / --json / exit codes
│   ├── cost.js               # price table, ledger, --max-cost
│   ├── system-prompt.js      # prompt assembly
│   ├── ui.js                 # ANSI rendering, diffs, meter
│   ├── providers/
│   │   ├── index.js          # registry, canonical format, hard pinning
│   │   ├── openai-compat.js  # xAI/Groq/OpenRouter/DeepSeek/Ollama/OpenAI/custom
│   │   ├── anthropic.js      # /v1/messages adapter
│   │   └── gemini.js         # alt=sse adapter
│   └── tools/
│       ├── index.js          # dispatcher + JSON schemas
│       ├── fs.js             # read_file write_file edit_file list_dir glob grep
│       ├── exec.js           # bash
│       ├── todo.js           # todo_write
│       ├── memory.js         # memory tool (actions over src/memory.js)
│       └── skills.js         # skills_invoke tool
└── test/
    ├── fixtures/             # SSE transcripts, fake MCP server, fake OpenAI server
    └── *.test.js             # node:test
```

### 1.1 package.json

```json
{
  "name": "ox-agent",
  "type": "module",
  "bin": {"ox": "./bin/ox.js"},
  "engines": {"node": ">=18"},
  "scripts": {"test": "node --test test/"}
}
```

### 1.2 bin/ox.js

Shebang line, then import and call `src/cli.js`. Starts a monotonic clock used by `--version` to print real startup ms (the <150ms claim must be self-measurable).

### 1.3 src/cli.js

Hand-rolled arg parser (no deps). Modes:

| Invocation | Behavior |
|---|---|
| `ox` on a TTY | REPL |
| `ox` piped/non-TTY | usage text, exit 3 |
| `ox -p "prompt…"` or `ox -p -` (stdin) | headless one-shot |
| `ox --json …` | headless emitting JSON-lines events |
| `ox version` | semver + node version + measured startup ms |
| `ox help` | usage table |
| `ox bots` | preset/custom bot table: name, provider, model, required env var |
| `ox sessions` | list sessions: id, date, bot, messages, cost |
| `ox doctor` | diagnostics (see §17.3) |

Global flags: `-c/--continue`, `--resume <id>`, `--bot <name>`, `--model <name>`, `--yes-edits`, `--dangerously-skip-approvals`, `--max-cost <usd>`, `--json`, `-p [prompt…]`, `--version`, `--help`.

### 1.4 src/config.js

Precedence: **flags > env > `~/.ox/config.json` > defaults**.

Env keys consumed: `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, plus overrides `OX_BASE_URL`, `OX_API_KEY`, `OX_MODEL`.

Config file shape:

```json
{
  "defaultBot": "grok",
  "bots": { "<name>": { "provider": "<xai|anthropic|openai|gemini|groq|openrouter|deepseek|ollama|custom>", "model": "…", "baseUrl": "…" } },
  "mcpServers": { "<name>": { "command": "npx", "args": ["-y","srv"], "env": { "K": "${VAR:-x}" } } }
}
```

Project reads (hierarchical, closest-wins): `.mcp.json` (merged over config `mcpServers`), `.agents/` (skills), `AGENTS.md`/`CLAUDE.md` chains (see §7). `${VAR}` / `${VAR:-default}` expansion applies to all string values pulled from project files.

### 1.5 src/providers/

Canonical internal message format = OpenAI-style:

```js
{ role: "user"|"assistant"|"system"|"tool",
  content: string|null,
  tool_calls?: [{ id, type:"function", function:{ name, arguments /*JSON string*/ } }],
  tool_call_id?: string }
```

Adapters translate canonical → wire on request and wire → canonical on response/stream, both directions, losslessly. Registry maps provider names to adapters.

**HARD PINNING (non-negotiable):** no silent fallback of any kind — no model fallbacks, no provider failover, no auxiliary model. Wrong or missing key = immediate loud error naming the exact env var:

```
error: provider 'xai' requires XAI_API_KEY.
Set it in your environment or ~/.ox/config.json. ox never switches providers silently.
```

#### openai-compat.js (serves xAI, Groq, OpenRouter, DeepSeek, Ollama, OpenAI, custom)

- POST `{base}/chat/completions`, Bearer auth (`$XAI_API_KEY` etc.; Ollama: none). Custom = `OX_BASE_URL`+`OX_API_KEY`+`OX_MODEL`.
- Streaming SSE parse rules: accumulate `delta.tool_calls` fragments **by array index** (first fragment carries `id`+`function.name`; later fragments append to `function.arguments` strings); `finish_reason:"tool_calls"` ends a tool turn; request `stream_options:{include_usage:true}` and consume the trailing usage chunk; terminate on `[DONE]`.
- Ollama quirk: never send `tool_choice`.
- DeepSeek accepts this shape AND Anthropic's at the same host — keep it usable as a cross-check target.

#### anthropic.js

- POST `https://api.anthropic.com/v1/messages`; headers `x-api-key: $ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`.
- Map tools → `{name,description,input_schema}`; assistant `tool_use{id,name,input}` blocks ↔ canonical tool_calls; send results as user-message `tool_result{tool_use_id,content}` blocks.
- SSE: `message_start` → `content_block_start/delta` where `text_delta` appends text and `input_json_delta` appends partial JSON (concatenate, then parse once per block) → `content_block_stop` → `message_delta` (usage + stop_reason) → `message_stop`.

#### gemini.js

- POST `v1beta/models/{model}:streamGenerateContent?alt=sse`; header `x-goog-api-key: $GEMINI_API_KEY`.
- Map `tools:[{functionDeclarations}]` ⇄ canonical; model `functionCall{name,args,id}` ⇄ canonical tool_calls; return `functionResponse{name,response,id}`.

### 1.6 src/bots.js

Preset table (name → provider/model):

| Bot | Provider | Model | Env |
|---|---|---|---|
| grok | xai | grok-4.6 | XAI_API_KEY |
| grok-fast | xai | grok-build-0.1 | XAI_API_KEY |
| claude | anthropic | claude-sonnet-5 | ANTHROPIC_API_KEY |
| opus | anthropic | claude-opus-5 | ANTHROPIC_API_KEY |
| haiku | anthropic | claude-haiku-4-5 | ANTHROPIC_API_KEY |
| gpt | openai | gpt-5.6-sol | OPENAI_API_KEY |
| gemini | gemini | gemini-3.1-pro-preview | GEMINI_API_KEY |
| flash | gemini | gemini-3.8-flash | GEMINI_API_KEY |
| groq | groq | moonshotai/kimi-k2-instruct-0905 | GROQ_API_KEY |
| deepseek | deepseek | deepseek-v4-pro | DEEPSEEK_API_KEY |
| ollama | ollama | qwen3 @ http://localhost:11434/v1 | none |
| openrouter | openrouter | *(model argument required)* | OPENROUTER_API_KEY |

Custom bots via config `bots` key override/extend presets. `/bot <name>` switches mid-session: canonical messages are preserved verbatim; subsequent turns are re-rendered through the new provider's adapter. If the new model lacks tool support, error loudly — do not degrade silently.

### 1.7 src/tools/

Dispatcher (`tools/index.js`) owns JSON-schema definitions, validates args, enforces approvals, routes MCP tools registered as `mcp__<server>__<tool>`.

- **fs.js** — `read_file` (offset/limit, binary sniff, cap 2000 lines default), `write_file`, `edit_file`, `list_dir` (depth-limited), `glob` (tiny `**`/`*`/`?`/`{}` matcher written in-source), `grep` (regex, glob filter, context lines, cap 200 matches). All paths absolute-required; resolved inside cwd unless yolo; anything containing `/.git/` refused.
- **exec.js** — `bash {command, timeoutMs?}`: spawn shell in cwd; hard timeout 120s (kill process tree); merged stdout+stderr capped at 25,000 chars (truncation marker appended); denylist checked before run, bypassed only in yolo; cwd-confined.
  Default denylist patterns: `sudo`, `rm -rf` on absolute roots/home, fork-bomb syntaxes, piping remote scripts into shells (`curl|sh` family), writes outside cwd via redirection. List lives in one array; extendable in code only (no config-injected allowlists in v0).
- **edit_file ladder** — exact substring match → whitespace-normalized fuzzy match (collapse runs of spaces/tabs, trim line-ends; require unique match) → failure returns structured error with re-read hint ("old_text not found; re-read the file with read_file before retrying"). Writes show a diff and pass approval gates.
- **todo.js** — `todo_write` maintains an ordered task list rendered by the UI.
- **memory.js** — `memory` tool, actions `list|get|add|update|search` over `.agent/` (§8).
- **skills.js** — `skills_invoke {name}` loads SKILL.md body into the conversation (§9).

### 1.8 src/context.js

- AGENTS.md/CLAUDE.md chain: collect from filesystem root down to cwd, closest wins on conflict, concatenate with path headers, total cap 32KB.
- Repo tree: git-aware listing respecting .gitignore, budget ≈1k tokens.
- Token estimate: single estimator `Math.ceil(chars/4)` used everywhere (meter, budgets, compaction triggers). Documented simplification over prose/code split.
- Auto-compaction at **75% of model window**: summarize older turns keeping decisions-made, files-touched, unresolved-bugs/errors, and the last 4 turns verbatim; write an episode file (§8); replace compacted turns with a placeholder marker.
- Stale tool outputs >25k tokens replaced with placeholders referencing the tool call.
- **Honest context meter:** estimated % remaining computed from the estimator, always visible in the UI/status line, labeled `est`.

### 1.9 src/memory.js — the `.agent/` store

Layout:

```
.agent/
├── MEMORY.md                  # index, ≤150 lines / ≤20KB, auto-loaded into context
├── topics/<slug>.md           # detail notes referenced from the index
└── episodes/YYYY-MM-DD-<slug>.md   # ≤40 lines each, written at session end / compaction
```

- Index entries are typed one-liners: `[YYYY-MM-DD][user|feedback|project|lesson] text`.
- Memory tool actions: `list`, `get`, `add`, `update`, `search` (search = grep over `.agent/`).
- A-MEM evolution rule: `add` first normalizes and compares against existing entries; a similar fact updates the existing entry instead of duplicating.
- Prune reminder emitted when caps approached (150 lines / 20KB).
- Recency = date-prefix sort.
- Evidence gate for `lesson` entries: persisted only via the reflection policy (§2) — i.e., after verified recovery or explicit user confirmation, each stamped with its last-verified date.
- Storage is append-friendly plain text/JSONL journaling; a torn final line truncates with a warning, never fatal.

### 1.10 src/skills.js

Scan order: `~/.agents/skills`, `<proj>/.agents/skills`, `~/.claude/skills`, `<proj>/.claude/skills`. Parse `SKILL.md` frontmatter with a tiny YAML-subset parser (flat `key: value` lines + one nesting level for `metadata.*`; nothing more). Inject ONLY name+description index into the system prompt (~100 tokens/skill). Body loads on invoke (`skills_invoke` or `/skill <name>`). `scripts/` contents run via the bash tool, approval-gated like everything else. `metadata.trigger: command` registers the skill as a slash command. v0 skills are imported, never self-authored.

### 1.11 src/mcp.js — stdio client

- Spawn servers from `~/.ox/config.json mcpServers` + project `.mcp.json` (Claude-compatible format parsed directly; `${VAR:-default}` expansion).
- Frames: newline-delimited JSON-RPC 2.0 over stdin/stdout; server stderr captured as logs.
- Legacy handshake: `initialize{protocolVersion,capabilities,clientInfo}` → result → `notifications/initialized`. Answer `ping` with `{result:{}}`. Carry `_meta` protocol fields opportunistically for new-era servers.
- `tools/list` with cursor pagination, cached; refresh on `notifications/tools/list_changed`.
- `tools/call`: `isError:true` results surface their content to the model (recoverable); JSON-RPC protocol errors are REPORTED, never blind-retried.
- Timeouts enforced; in-flight cancellations sent as `notifications/cancelled`.
- Tool names exposed as `mcp__<server>__<tool>`; output capped 25,000 chars; descriptions treated as untrusted data.
- Shutdown ladder: close stdin → SIGTERM → SIGKILL.
- Server crash = loud error + `/mcp restart` re-spawns on demand. No silent auto-reconnect.

### 1.12 src/session.js

- One JSONL file per session: `~/.ox/sessions/<ts>-<id>.jsonl` (`ts` = `YYYYMMDD-HHMMSS`, `id` = 6 hex chars). Append-only, lossless.
- Line kinds: `meta` (version, cwd, bot, model, created — first line), `message` (canonical message), `summary` (compaction marker with episode path), `fork` (parent id + offset).
- `-c/--continue`: load latest session and keep appending. `--resume <id>`: named session. `/fork`: copy lines up to current offset into a new id. Export renders a markdown transcript with a cost appendix.

### 1.13 src/ui.js

ANSI rendering: streaming text deltas, spinner frames, diff renderer (green/red), markdown-lite subset (headings, fenced code, inline code, bullets, bold), the always-visible context meter (`[ctx ▮▮▮▯▯ est 61% left]`), per-turn cost line (`↳ $0.0042 · Σ $0.0193`). No TUI framework; plain stdout.

### 1.14 src/cost.js

Price table (USD/Mtok in/out) covering every preset plus alternates:

| Model | in | out |
|---|---|---|
| grok-4.6 | $2 | $6 |
| grok-build-0.1 | $1 | $2 |
| claude-opus-5 | $5 | $25 |
| claude-sonnet-5 | $2 | $10 |
| claude-haiku-4-5 | $1 | $5 |
| gpt-5.6-sol | $4 | $20 |
| terra | $2 | $12 |
| luna | $0.20 | $1.20 |
| gemini-3.1-pro-preview | $2 | $12 |
| gemini-3.8-flash | $0.75 | $3.75 (standard tier through 2026-12-31) |
| moonshotai/kimi-k2-instruct-0905 | $1 | $3 |
| qwen/qwen3.6-27b | $0.60 | $3 |
| deepseek-v4-pro | $1.32 | $3.96 |
| deepseek-v4-flash | $0.44 | $1.32 |
| ollama local models | $0 | $0 |

Ledger: per-message cost + cumulative session total; real usage when the provider returns it, estimator otherwise (labeled). Unknown custom-model pricing = estimator-only with an explicit "unpriced" marker. `--max-cost <usd>` hard-stops the loop with a summary (turns, spend, stop point); `/cost` prints on demand.

### 1.15 src/approval.js

| Mode | How | File writes | bash |
|---|---|---|---|
| default | — | approve each (diff shown) | approve each |
| accept-edits | `--yes-edits` | auto (diff logged) | approve each |
| yolo | `--dangerously-skip-approvals` or `OX_YOLO=1` | auto | auto; denylist lifted; banner shown |
| plan | `/plan` toggle | read-only until toggled off | read-only commands only |

Every decision lands in an audit log line in the session JSONL.

### 1.16 src/headless.js

- `-p "prompt"` one-shot: run loop, print final answer, exit by contract.
- `--json`: emit one JSON object per event (§2 event enum) to stdout.
- stdin pipe accepted (`-p -` or piped non-TTY).
- **Exit codes: `0` success · `1` runtime/model error (incl. budget-cap stop) · `2` approval denied · `3` usage/config error.**

### 1.17 src/system-prompt.js

Concise (~60 lines) assembled from static skeleton + dynamic header:

- Identity: "You are ox, a featherweight terminal coding agent."
- Workspace truth from probes only: cwd, git root + branch + status summary, platform, today's date. Never model-asserted.
- Injected AGENTS.md/CLAUDE.md contents.
- Tool rules: absolute paths; verify edits after writing (re-read or lint/test); prefer targeted edit_file over whole-file rewrites; stay inside cwd; **on attempt ≥2 vary strategy** (different approach, not rewording); stopping conditions mandatory.
- Memory rules: consult MEMORY.md index; save lessons only via evidence gate; search before asking the user for previously-established facts.
- Skills rules: skim index; invoke relevant skills before reimplementing them.
- Concision in prose; precision in diffs.

## 2. Agent loop & self-correction (src/agent.js)

```
system + context → stream → tool_calls? → execute → append results → loop
```

- Max 40 iterations per turn.
- Event enum (consumed by ui.js and --json): `text-delta | tool-start | tool-end | turn-end | usage | error | reflection`.
  Payload sketches: `{text-delta:{text}}`, `{tool-start:{id,name,argsPreview}}`, `{tool-end:{id,name,ok,ms,bytes}}`, `{turn-end:{stopReason,iters}}`, `{usage:{in,out,costUsd,ctxPctUsed}}`, `{error:{kind,message,recoverable}}`, `{reflection:{trigger,diagnosis}}`.

**SELF-HEAL:** edit/bash/test failure → inject truncated actionable error into context → retry within budgets: **edits 2, bash 2, tests 3**. On attempt ≥2 the prompt instructs varying strategy. Budget exhausted → rollback touched files via git when possible (`git checkout`/stash restore of exactly the files this session modified) + honest report listing attempted strategies.

**REFLECTION (per CRITIC/Huang rule — external signals only):**
- Triggers exclusively on external failure signals: non-zero exit, test/lint failure, edit apply error, protocol error.
- Reflection = 1–3 sentence diagnosis citing the concrete signal, attached before retry.
- Same error seen twice in a chain → persist ONE lesson line to `.agent/` memory (typed `lesson`, last-verified date stamped).
- Session end → write episode summary to `.agent/episodes/YYYY-MM-DD-<slug>.md`.
- Hard cap: **2 diagnostic reflections per failure chain** — beyond that, escalate to the user instead of spiraling.

## 3. Slash commands

| Command | Behavior |
|---|---|
| /help | command table |
| /bot [name] | show or switch bot mid-session (context preserved) |
| /model <name> | raw model override on current provider |
| /cost | cost ledger so far |
| /compact | force compaction now |
| /clear | reset conversation (session log kept; new segment) |
| /plan | toggle read-only plan mode |
| /tools | list builtin + MCP tools with schema summaries |
| /memory | list/search/add memory entries |
| /skill <name> | load skill body into context |
| /mcp [restart] | MCP server status / re-spawn |
| /session | info + export path |
| /resume <id> | switch to stored session |
| /fork | branch current session |
| /yolo | toggle approvals off (confirmation banner first) |
| /doctor | diagnostics |
| /version | version + startup ms |
| /exit | quit |

## 4. Tests (node:test, zero network)

Fixtures live in `test/fixtures/`. Recorded SSE transcripts drive parser tests; no test touches a real provider.

1. Adapter round-trips: canonical → wire request and wire response → canonical vs fixtures, all three adapter families.
2. OpenAI-compat SSE parser: text deltas; `delta.tool_calls` accumulation by index; `include_usage` chunk; `[DONE]`.
3. Anthropic SSE parser: `text_delta`; `input_json_delta` partial-JSON concatenation; `message_delta` usage/stop_reason.
4. Gemini SSE parser: `functionCall` args; `functionResponse` mapping back.
5. `edit_file`: exact match; whitespace-normalized fuzzy; not-found error carries re-read hint.
6. fs tools on tmp dirs: read/write/list/glob/grep incl. `.git/` refusal and outside-cwd refusal.
7. bash: timeout kill; 25k-char cap truncation; denylist rejection; yolo bypass; cwd confinement.
8. Config precedence flags > env > file > defaults; `${VAR:-default}` expansion.
9. Token estimator math.
10. Compaction trigger at 75% + keep-contract assertions (decisions/files/recent-4 preserved verbatim).
11. Session round-trip: append→load→continue; fork at offset; corrupt tail line tolerated with warning.
12. Cost math: per-message, cumulative, `--max-cost` trip condition.
13. Memory caps (150 lines/20KB) + dedupe-update rule + search.
14. Skills: frontmatter-subset parsing incl. nested `metadata`; index injection; `trigger:command` registration; lazy body load.
15. MCP client vs scripted fake stdio server (spawn node fixture speaking the §1.11 frames): handshake, ping answer, paginated list across 2 pages, call ok, call `isError` surfaced, protocol error reported-not-retried, cancel, crash + restart ladder.
16. E2E: local http server speaking OpenAI-style SSE scripted as answer → `tool_call(read_file)` → final; engine pointed at it via `OX_BASE_URL`; assert the target file's content reached the model AND the final answer streamed; exit code 0.
17. `ox --version` spawned fresh completes <300ms (CI-safe bound; product budget remains <150ms).

### 4.1 Doctor (subcommand used by humans, asserted by tests where cheap)

Reports: node version vs engines; config parse result; env keys present/missing per configured bot; `.mcp.json` validity + handshake pings; scanned skill counts per directory; writability of `~/.ox/` and project `.agent/`.

## 5. Non-goals for v0

README (later task) · IDE integration · **kernel sandboxing profiles ship** (`src/sandbox.js`: seatbelt on macOS, `bwrap` on Linux, enforced on every spawned command via `prepareSandbox()` in `src/tools/exec.js` and `src/mcp.js`; the deny is kernel-enforced, default profile is `off`) — what remains open is flipping that default and confining the agent process itself, not the profiles · deeper hooks breadth (18+ events toward Claude Code's 27) · subagent depth (parallel nesting, persistence) · marketplace/registry · vector databases · background daemons · Windows polish beyond functional best-effort.

## 6. Acceptance checklist

- [ ] `npm test` green with zero network access.
- [ ] `ox --version` <150ms locally; spawn test <300ms in CI.
- [ ] Source tree <250KB; `grep -r require(` finds nothing; package.json has zero runtime deps.
- [ ] All four scan dirs yield working skills; a Claude Code skill runs unmodified.
- [ ] A Claude-format `.mcp.json` server connects, lists, calls, cancels, dies loudly, restarts.
- [ ] Missing key produces the exact loud-pin error naming the env var — verified for all 8 providers.
- [ ] Self-heal: induced edit failure recovers within budget; exhausted budget rolls back via git.
- [ ] Compaction fires at 75%, episode written, meter stays honest throughout.
- [ ] `--max-cost` stops mid-run with summary; exit codes verified for all four values.
- [ ] Mid-session `/bot` switch preserves conversation and continues tool use.

## 7. Clarifications & resolved ambiguities (binding)

1. Token estimation is flat `chars/4` everywhere (research notes prose ≈4, code ≈3–3.5; one constant keeps meter/budgets consistent).
2. Exit `3` = usage/config errors (bad flags, unknown bot, unreadable config).
3. "recent-4" in compaction = last 4 turns verbatim.
4. bash denylist ships the default patterns listed in §1.7; yolo lifts both denylist and cwd confinement.
5. Cost units are USD; `--max-cost` compares against cumulative real+estimated spend; cap-stop exits `1` in headless mode.
6. Ollama adapter omits `tool_choice` (unsupported upstream).
7. Skills v0 are import-only; self-authoring waits for evidence-gating infrastructure (anti-Hermes rule #3).
8. MCP client implements the legacy-era handshake as primary; `_meta` fields ride along for new-era servers.
9. Memory `search` = grep over `.agent/` (no FTS infrastructure — corruption-proof by simplicity).
10. Provider usage figures preferred over estimates when returned (`include_usage`, `message_delta`, Gemini usage metadata); estimates always labeled `est`.

*Companion docs: [research.md](research.md) — why these decisions; [comparison.md](comparison.md) — how ox stacks up.*
