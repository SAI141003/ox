# ox Gap Analysis — vs Top 20 AI Coding Agents (2026)

**Date:** 2026-09-13 · **Subject:** `ox` (v0.8, terminal-first coding agent)

---

## 1. Methodology

Each competitor is assessed on three axes: **differentiating features** (what makes them distinct), **ox already has** (confirmed in src/, README, or docs), **ox is missing** (gaps). Evidence is code-level: a feature counts only if it ships in `src/`, `bin/`, `desktop/`, or documented commands — not in planning docs alone.

---

## 2. Competitor Analysis (20 agents)

### 2.1 Terminal-based agents

| # | Competitor | Key Differentiating Features | ox Already Has | ox Is Missing (Gaps) |
|---|-----------|------------------------------|----------------|---------------------|
| 1 | **Claude Code** (Anthropic) | Terminal; plan-first; 27 hook events; subagents; worktrees; 1M context; SWE-bench 93.9%; IDE panel | Plan mode (`src/plan-first.js`); hooks (`src/hooks.js`, 2 events fired); subagents (`src/subagent.js`); repo map (`src/repo-map.js`); session resume/fork | Git worktree isolation; 1M context window; native IDE panel; SWE-bench eval harness; 27 hook events (ox fires 2) |
| 3 | **OpenAI Codex** | Terminal; sandbox by default; `codex exec`; local models; TB2 89.5% | OS sandbox profiles (`src/sandbox.js`); Ollama local models; headless `-p`/`--json` | Kernel sandboxing (Seatbelt/Landlock); `codex exec` single-shot mode; zero-dep binary (ox is zero-dep JS) |
| 6 | **Aider** | Terminal; Git-native; repo-map; auto-commits; edit-format science (12 formats); LiteLLM breadth | Git-aware repo map (`src/repo-map.js`); `/commit` power command (draft + ask); git status in system prompt | Auto-commit on edit (ox drafts, asks); per-message cost tracking; 12 auto-matched edit formats |
| 8 | **Google Antigravity** | IDE+CLI+SDK; parallel agents; built-in browser; free | CLI mode; free/open-source; parallel agents (planned) | IDE; SDK; parallel agents (not shipped); built-in browser (uses MCP); visual verification |
| 9 | **Gemini CLI** | Terminal; open source; free 1000 req/day; LSP integration | Open source (MIT); free; terminal-first | LSP integration; 1000 req/day free tier (ox is BYOK); built-in code review |
| 10 | **OpenCode** | Terminal TUI; 185K stars; MIT; 75+ providers; LSP+AST verification | MIT; multi-provider (12+); TUI; AST-like features in repo-map (symbol extraction) | 75+ providers (ox has 12+); LSP client; AST verification engine; Bubble Tea TUI polish |
| 11 | **OpenHands** | 73K stars; sandboxed Docker/K8s; GitHub/GitLab/Slack; SDK; self-host | Self-host; zero-dep; sandboxed (OS-level); Slack MCP | Docker/K8s sandbox; GitHub/GitLab native integration; SDK; 73K community |
| 17 | **Goose** | Open source; recipes; ACP protocol | Open source (MIT); recipes-like skill system; skill catalog | ACP protocol; 70+ extensions; recipes gallery |
| 18 | **Crush** | TUI; multi-model configs; mid-session switching | Multi-model configs; mid-session `/bot` switch; terminal TUI | Bubble Tea TUI polish; visual workflow editor |
| 19 | **RooCode** | VS Code extension; cloud agents | None (ox is terminal/desktop) | VS Code extension; cloud agent runtime |
| 20 | **Trae AI** (ByteDance) | Multi-agent orchestration; IDE | Subagents (`src/subagent.js`) | Multi-agent orchestration UI; IDE; cloud agents |

### 2.2 IDE-based agents

| # | Competitor | Key Differentiating Features | ox Already Has | ox Is Missing (Gaps) |
|---|-----------|------------------------------|----------------|---------------------|
| 2 | **Cursor** (Anysphere) | IDE; tab completion; Composer; cloud agents; MCP; BugBot | MCP (stdio+HTTP, risk-gated) | IDE extension; tab completion; Composer; cloud agents; BugBot; in-editor AI |
| 7 | **Windsurf/Devin Desktop** | IDE; SWE-1.5; FedRAMP; cloud handoff to Devin | OS sandbox; cloud MCP servers | IDE; SWE-bench eval; FedRAMP; Devin cloud handoff |
| 13 | **Replit Agent** | Browser IDE; prototype-to-deploy; $25/mo | Browser MCP (Playwright) | Browser IDE; deploy pipeline; hosted runtime |
| 14 | **Kiro** (AWS) | IDE+CLI; spec-driven development; hooks; steering files | Hooks (`src/hooks.js`) | IDE; spec-driven workflow; steering files; AWS integration |
| 15 | **Qodo** | PR review; on-prem; air-gapped | Self-host; air-gappable (zero-dep) | PR review automation (has `/review` power command only); on-prem product; CI integration |

### 2.3 Enterprise / cloud / specialized

| # | Competitor | Key Differentiating Features | ox Already Has | ox Is Missing (Gaps) |
|---|-----------|------------------------------|----------------|---------------------|
| 4 | **GitHub Copilot** | Widest IDE support; free tier; Agent Merge; GitHub-native | None native | IDE extensions; GitHub integration; free tier; Agent Merge |
| 5 | **Cline** | VS Code extension; BYOK; MCP; Apache 2.0; 5M+ installs | BYOK; MCP; MIT | VS Code extension; 5M+ installs; UI panel |
| 12 | **Devin** | Cloud autonomous; ticket-in/PR-out; $500+/mo | Cloud MCP (browser, Slack) | Autonomous cloud runtime; ticket workflow; PR creation/merge |
| 16 | **Tabnine** | Enterprise; VPC; on-prem; air-gapped; code completion | On-prem deployable; zero-dep | Enterprise VPC product; code completion engine; commercial license |

---

## 3. Summary: Gap Distribution

| Gap Category | Competitors Closed | Impact |
|-------------|-------------------|--------|
| IDE integration | Cursor, Windsurf, Kiro, Replit, Tabnine, Cline, Trae, Copilot | High |
| LSP / AST | Gemini CLI, OpenCode | Med |
| Worktree isolation | Claude Code | High |
| Auto-commit | Aider | Med |
| Docker/K8s sandbox | OpenHands, Codex | Med |
| Cloud agents | Cursor, Devin, Windsurf, RooCode | High |
| PR review / spec-dev | Qodo, Kiro | Med |
| Native browser agent | Antigravity, Replit | Med |
| IM channels | OpenHands, Hermes | Low |
| Enterprise features | Tabnine, Qodo | Low |

---

## 4. Prioritized Implementation Roadmap (17 items)

Ranked by impact/effort ratio. **S** = Small (<1 dev-week), **M** = Medium (1–4 weeks), **L** = Large (1+ month).

| # | Item | What It Does | ox Implementation | Effort | Impact | Closes Gap vs |
|---|------|-------------|-------------------|--------|--------|--------------|
| 1 | **Git worktree isolation** | Each agent run in a fresh git worktree; parallel agents never conflict; base branch stays clean | Not implemented — no module exists | S | High | Claude Code |
| 2 | **LSP integration** | Real-time diagnostics, go-to-definition, rename refactor via Language Server Protocol | Not implemented — no module exists | M | High | Gemini CLI, OpenCode |
| 3 | **AST verification** | Parse edited files into AST, verify structural correctness (imports, exports, types) after every edit | New `src/ast-verify.js`: acorn (zero-dep, bundled) parse + validation rules; call post-edit in `tools/fs.js` `write_file`/`edit_file` success path; report parse errors as tool-result advisories | M | High | OpenCode |
| 4 | **Auto-commit on every edit** | Each successful edit auto-staged and committed with conventional-commit message drafted by agent | Extend `src/cmd-power.js` `/commit`; add auto-commit hook in `agent.js` post-edit: stage file, draft message via LLM, commit (or ask if `--yes-edits` absent); track `git --no-pager diff --stat` in checkpoint | S | Med | Aider |
| 5 | **Code review skill (parallel multi-dimensional)** | Run parallel review passes: security, performance, style, correctness; aggregate findings | New `src/review.js`: fan-out N subagents (`src/subagent.js`) each with a focused prompt dimension; merge results via `Promise.all`; output unified diff-comment format; register as `skills_invoke` skill and `/review` command enhancement | M | High | Qodo, Claude Code |
| 6 | **Insight generation from chat history** | Semantic search over past sessions: surface patterns, recurring bugs, frequently-touched files | New `src/insight.js`: index JSONL sessions with keyword TF-IDF; `ox insight query` CLI subcommand; integrate into system prompt as "past patterns" section; uses existing `session.js` logs | M | Med | Codex, Claude Code |
| 7 | **Cron / scheduled tasks** | Define recurring agent tasks beyond `ox schedule`'s crontab-print model | Extend `src/headless.js` `ox auto` to daemonize via `setInterval` + `setTimeout` within a persistent process; or write to `~/.ox/cron/` with a tiny scheduler checking every minute | M | Med | Gemini CLI, OpenHands |
| 8 | **OpenTelemetry structured logging** | Emit OTLP-formatted logs for observability pipelines; Jaeger/Zipkin tracing | New `src/telemetry.js`: OTLP HTTP exporter to configurable endpoint; trace spans per agent turn (tool calls, model calls, durations); env var `OX_OTLP_ENDPOINT` to enable; zero-code path when disabled | S | Med | OpenHands, Tabnine |
| 9 | **TypeScript SDK** | npm package `@ox/sdk` exposing agent loop as a function: `runTask(prompt, opts)` returns structured result | New `src/sdk.ts` (compiled to `dist/`): TypeScript types for all options; wrapper around `runAgent` from `agent.js`; publish as ESM; tests in `test/sdk.test.js`; zero runtime deps retained | M | High | OpenHands (SDK), Codex |
| 10 | **Web UI (browser interface)** | Browser-based chat at `ox serve` — chat, file tree, plan view, cost meter | New `src/web.js`: static HTML + WebSocket server (Node raw `net` module, zero-dep); serve `desktop/index.html` adapted; stream JSON events over WS; run `ox --json` internally | L | High | Replit, Cursor, Antigravity |
| 11 | **IM channels (Telegram/DingTalk/WeChat/Feishu)** | Agent accessible via chat: `/ox help` in Telegram, DingTalk bot, WeChat, Feishu | New `src/im.js`: MCP server adapters for each channel (Telegram MCP exists; add DingTalk/Feishu templates in `mcp-templates.js`); `ox im start <channel>` command; bridges messages to agent loop | M | Med | OpenHands, Hermes |
| 12 | **Agent Arena (multi-model comparison)** | Same prompt dispatched to N models; results diffed; vote on best answer | New `src/arena.js`: `ox arena <text>` runs prompt against all configured bots in parallel via `Promise.all`; outputs side-by-side; costs tracked per bot; optionally auto-vote via judge model | L | Med | OpenAI Codex (TB2 eval), Antigravity |
| 13 | **Daemon mode (HTTP+SSE server)** | Persistent agent server: POST task, SSE stream results; REST API for status/cancel | New `src/daemon.js`: Node `http` server (zero-dep); SSE endpoint `/events`; POST `/tasks` spawns agent; `GET /tasks/:id` status; in-memory + `session.js` persistence; `ox daemon start/stop/status` commands | L | High | OpenHands, Codex (`codex exec` server) |
| 14 | **Browser agent (web automation)** | Navigate, click, fill forms, extract data from web pages natively | Ship `src/browser.js` wrapping Playwright MCP server (`@playwright/mcp`) as builtin tools `browser_navigate`/`browser_click`/`browser_extract`; auto-spawn dedicated Chromium with isolated profile; add to tool registry | L | Med | Antigravity, Replit, Devin |
| 15 | **Computer Use (desktop automation)** | Control desktop: click, drag, screenshot, OCR, keyboard input | New `src/computer.js`: macOS via `osascript`/SystemEvents; Linux via `xdotool`+`import`; expose tools `computer_click`, `computer_screenshot`, `computer_type`; risk-gated like money-risk MCP | L | Med | Anthropic Computer Use, Devin |
| 16 | **Mobile MCP (iOS/Android)** | Agent controls phone: tap, swipe, text, read notifications, install APKs | New `src/mobile.js`: Android via `adb` shell commands; iOS via `ideviceinstaller` (optional); tools `mobile_tap`, `mobile_text`, `mobile_screenshot`; add as MCP-style tools | L | Low | Google Antigravity |
| 17 | **Spec-driven development** | Write spec -> generate tasks -> execute -> verify against spec | New `src/spec.js`: `/spec` command writes spec to `.agent/spec.md`; agent reads it each turn as hard constraint; goal-contract system prompt augmented with spec section; verification checks spec compliance at end | M | Med | Kiro, GitHub Copilot (spec mode) |

---

## 5. Roadmap Sequencing

**Phase 1 — Quick wins (items 1, 4, 8):** Worktree isolation, auto-commit, OTel logging. All Small effort; high or med impact. Ship in v0.9.

**Phase 2 — Core expansions (items 2, 3, 5, 9, 11, 17):** LSP, AST verify, code review skill, TypeScript SDK, IM channels, spec-dev. Medium effort. Ship in v1.0.

**Phase 3 — Platform reach (items 6, 7, 10, 12, 13):** Insights, cron, Web UI, arena, daemon. Large/Medium effort. Ship in v1.5-v2.0.

**Phase 4 — Agent surfaces (items 14, 15, 16):** Browser agent, Computer Use, mobile MCP. Large effort; depend on Phase 2 core. Ship in v2.0+.

---

## 6. Competitive Position After Roadmap

| Capability | Before Roadmap | After Phase 1 | After Phase 2 | After Full Roadmap |
|-----------|---------------|---------------|---------------|-------------------|
| Terminal CLI | Yes | Yes | Yes | Yes |
| Multi-provider | Yes | Yes | Yes | Yes |
| Plan mode | Yes | Yes | Yes | Yes |
| Hooks | Yes | Yes | Yes | Yes |
| Subagents | Yes | Yes | Yes | Yes |
| Git worktree | No | Yes | Yes | Yes |
| LSP | No | No | Yes | Yes |
| AST verify | No | No | Yes | Yes |
| Auto-commit | partial | Yes | Yes | Yes |
| Code review | partial | partial | Yes | Yes |
| Web UI | partial | partial | partial | Yes |
| Browser agent | No | No | No | Yes |
| Computer Use | No | No | No | Yes |
| IM channels | No | No | Yes | Yes |
| Daemon | No | No | No | Yes |
| Spec-dev | No | No | Yes | Yes |

---

*Generated from ox v0.8 source analysis. Feature presence verified against `src/`, `desktop/`, `bin/`, and documented commands. Gaps are honest — roadmap items are tractable given ox's zero-dep architecture and existing seams (hooks event surface, subagent scaffolding, MCP transport).*
