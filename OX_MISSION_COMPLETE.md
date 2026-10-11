# OX_MISSION_COMPLETE

Final verified state. Supersedes the 2026-09-21 snapshot (754 tests).

## Core CLI

- `ox agent list|save|use|delete` → `~/.ox/agents/*.json`
- `ox import <claude-code|hermes|codex|all> [--dry-run]`
- `ox task list|add|get|run|update|delete` → `~/.ox/tasks/*.json`
- `ox serve [--port] [--host] [--api-key]` — `/health`, `/v1/models`, `/v1/models/:id`, `/v1/chat/completions`, `/v1/responses`; bearer auth via `OX_SERVE_API_KEY`; loopback default; refuses non-loopback bind without key (`OX_SERVE_ALLOW_UNAUTHENTICATED=1` overrides)
- `ox daemon start|stop|status|doctor|log` — supervisor + detached workers, Unix socket (0700 dir, 0600 socket), ownership-screened paths
- `ox agents [--json] [--limit]` — list running/saved/idle agents
- `ox attach <id> [--no-replay]` — stream running session, answer approvals, detach leaves worker running
- `ox shutdown [--force]` — stop workers + supervisor
- `ox schedule add "<prompt>"` / `ox schedule "<goal>" [--install]` / `ox cron ...` — schedules running inside daemon
- `ox -p "<task>" --detach` — run as supervised worker, return immediately
- `ox ipc serve|status|watch` — Unix-socket session monitor + out-of-band approval bridge (newline-delimited JSON: hello/event/approval-request/ready/approval-answer/ping)
- `ox --context [--json]` — per-turn context breakdown (system/tools/history/schema tokens, threshold, headroom)
- `ox prompt` — dump prompt layers (static prefix, dynamic sections)
- `ox models` / `ox model list` — 12 models, no `undefined`
- `ox local [--no-prompt]` — local model discovery with explicit approval

## Agent Loop / Architecture

Prime Agent imports (6/6):
- **Daemon continuity** — sessions survive CLI exit via detached workers
- **Cache-stable prompt layering** (`buildPromptLayers`, static prefix 42B → 1831B)
- **Persistent goals** — `{t:'goal'}` events, survive compaction + resume; `/goal done` refuses without evidence
- **Agent-to-agent messaging** — `agent_message.send` / `agent_observe`, at-most-once durable cursor, isolated by ctx identity, screened via `screenPersistText`
- **Schedules + heartbeats** — `src/schedule.js`, `src/cron-scheduler.js`, off by default behind two gates
- **`/refine`** — evidence-gated via `episodePromotionQualifies`, snapshots + `/refine undo`, structural immutability

- Parallel read-only tool batching for `pure_read` group
- Parallel subagents: `CONCURRENTLY_BATCHABLE={subagent}`, `runSubagentBatch`, cap 3 / ceiling 8, 17/17 tests
- Small-model strict schemas (auto-detects <32K context)
- Agent Reach Architecture: capability layer with ordered backend chains selected by real probe (`ox doctor` consumes; found working keyless backend: marginalia)

## Tools (19 built-in)

- **File:** read_file, write_file, edit_file, list_dir, glob, grep
- **Shell:** bash
- **Memory:** memory_add, memory_read, memory_screen
- **Agent:** subagent, report_result, agent_message.send, agent_observe
- **Operator (7):** open_app, open_url, open_path, open_window, type_text, screenshot, notify
- **Web:** web_fetch, web_search, critique
- **Planning:** todo_write

## MCP Templates (7 new)

browser-harness, stagehand, camoufox, unity, trawl, backboard, voice (registry in `src/mcp-templates.js`)

## Agent Skills (6)

browser-harness, stagehand, camoufox, openwhispr, unity, backboard (`docs/skills/*/SKILL.md`)

## Bot Presets (11)

ox-openrouter, ox-ollama, ox-claude, ox-grok, ox-xai, ox-anthropic, ox-gemini, ox-deepseek, ox-groq, ox-custom, backboard

## Integration Guides (`docs/integrations/`)

browser.md, unity.md, voice.md, backboard.md, non-goals.md, README.md

## Security / Safety

- Non-TTY plan-mode fail-closed (`src/plan-first.js`, `src/cli.js` TTY-only gate)
- `ox serve` refuses non-loopback bind without `OX_SERVE_API_KEY` before `listen()`
- IPC approval bridge: silence ⇒ decline, explicit 'allow' only
- Credential/injection screening on memory read AND write (`screenPersistText`, `screenReadLines`)
- Sandbox profiles: off | workspace | read-only | strict | custom (seatbelt on macOS, bwrap reported gaps)
- Kernel-enforced network deny (sandboxed curl → HTTP=000)
- Fail-closed spend: unpriced model under cap → budget-stop unknown-cost, aborts before request
- Honest error text: "Missing API key for xai: set XAI_API_KEY (no silent fallback)"
- Zero telemetry code path
- Zero npm dependencies (deps: {}, devDeps: {})

## Documentation

- `docs/COMPARISON_MATRIX.md` (542 lines, 17 tables, 26 columns, 24 competitors)
- `docs/COMPETITIVE.md` (147 lines)
- `docs/autonomy.md` (297 lines)
- `docs/MISSION_STATUS.md`, `MEETING_BRIEF.md`, `MEETING_DEMO.md`, `UX_SPEC.md`, `E2E_CLICKY.md`, `clicky-onboarding.md`
- `docs/skills/operator/SKILL.md`
- `docs/HERMES_GAP.md`
- `README.md` (1041 lines)
- `ox-setup.sh`: no hardcoded key, `OX_REPO` configurable, secure prompt with confirmation

## Deploy Blockers Resolved

- `ox-setup.sh`: placeholder GitHub URL → `OX_REPO` env var (override clone URL)
- Hardcoded API key removed → secure prompt / env var with confirmation before writing to shell RC

## Tests

- **1649 pass / 0 fail / 1 skip** (bwrap runtime enforcement — macOS has no bwrap)
- 105 test files, 82 suites
- All `src/*.js`, `src/tools/*.js`, `src/providers/*.js`, `bin/*.js` pass `node --check`

Date: 2026-10-06
