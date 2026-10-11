# ox vs Qwen Code — Feature Comparison & Adoption Roadmap

*Generated 2026-09-11 | ox v0.8+ | Qwen Code @qwen-code/qwen-code (npm)*

---

## 1. ox Strengths — What ox Does Better

| # | Capability | ox Implementation | Key Files |
|---|------------|-------------------|-----------|
| 1 | **Zero deps, <250KB install, <150ms startup** | Pure ESM Node ≥18, no `npm install`, no `node_modules`; `package.json` has zero deps | `package.json`, `bin/ox.js` |
| 2 | **Deterministic benchmark suite** | 25 scenarios, mock SSE server on loopback, 100% pass, ~7s wall, reproducible costs | `bench/runner.mjs`, `bench/harness.mjs`, `bench/RESULTS.md` |
| 3 | **Self-improvement (Reflexion)** | Post-task critique + pattern extraction → procedural memory; opt-in via `OX_SELF_IMPROVE=1` | `src/self-improve.js`, `src/procedural-memory.js` |
| 4 | **Plan-first UX** | `/plan` REPL command, `--plan` flag; drafts structured plan, pauses for approval before exec | `src/plan-first.js`, `src/agent.js:1255-1260` |
| 5 | **Repository map** | `buildRepoMap`, `renderRepoMap`, `findRelevantFiles`, `getRelevantSnippets`, `ContextBudget` | `src/repo-map.js` |
| 6 | **Tiered trust (5 levels)** | `paranoid`→`strict`→`balanced`→`trusted`→`yolo`; `--trust`, `/trust`, env, config | `src/trust.js` |
| 7 | **MCP templates (curated registry)** | 30+ templates across risk classes (read-only/write/money); `ox mcp add <name>` | `src/mcp-templates.js` |
| 8 | **Multi-agent orchestrator** | Planner→Coder→Reviewer→Tester→Researcher→Documenter roles; `orchestrate()` generator | `src/orchestrator.js` |
| 9 | **Checkpoints with snapshots** | `.agent/checkpoints/` + manifest JSONL; file snapshots, undo/rewind/diff/prune | `src/checkpoints.js` |
| 10 | **OSINT module** | 22 investigation functions (email, domain, IP, breach, Shodan, VT, Censys, GitHub, DNS, etc.) | `src/osint.js` |
| 11 | **User profile + volatile context** | `PROFILE.md` (habits/preferences/facts) + `VOLATILE.md` (project/task/state) in `.agent/` | `src/user-profile.js` |
| 12 | **Procedural memory** | Cross-session pattern learning by task type; recency-weighted recall for system prompt | `src/procedural-memory.js` |
| 13 | **Token-efficient context** | Hierarchical instructions (32KB cap), gitignore-aware tree, 25k output caps, 75% compaction, keep-contract | `src/context.js`, `src/agent.js:791-851` |
| 14 | **ECC-compatible skills** | Agent-Skills standard; scans 4 dirs; denylist scan on install; usage sidecars; curator lifecycle | `src/skills.js`, `src/skill-add.js` |
| 15 | **TB2 adapter (model routing)** | Universal model registry; strategies: `pinned`/`cost`/`quality`/`fast`; aux routing for cheap calls | `src/model-registry.js`, `src/agent.js:648-654` |

---

## 2. Qwen Code Strengths ox Needs to Adopt

| # | Capability | Qwen Code Implementation | ox Gap |
|---|------------|--------------------------|--------|
| 1 | **Daemon mode (`qwen serve`)** | HTTP+SSE (ACP) server; multi-client shared session; `qwen serve [--port]`; Express 5 | No daemon; single-process CLI only |
| 2 | **ACP (Agent Client Protocol)** | JSON-RPC over stdio + HTTP/SSE; `qwen --acp` child; capability negotiation, reverse-RPC | No ACP; custom JSONL event stream only |
| 3 | **IM channels** | `qwen channel` → Telegram/DingTalk/WeChat/Feishu; `AcpBridge.ts` spawns `qwen --acp` | No IM integration |
| 4 | **Agent Arena** | Multi-model head-to-head in isolated Git worktrees (`~/.qwen/arena/...`); tab-bar UI; max 5 agents | No multi-model comparison; orchestrator is single-model team |
| 5 | **LSP integration** | Language Server Protocol for code intel (refs, defs, diagnostics); used by IDE plugins | No LSP; repo-map is static analysis only |
| 6 | **Computer Use (desktop automation)** | Desktop control via accessibility/OS APIs; sandbox; visual verification | No computer use; browser MCP template exists but no native desktop control |
| 7 | **Mobile MCP** | Qwen Studio (iOS/Android) + Web + Desktop; unified account sync | Desktop only (Tauri wrapper); no mobile/web |
| 8 | **OpenTelemetry** | Built-in OTel tracing/metrics for agent runs; exported to collectors | No OTel; cost ledger only |
| 9 | **SDK (TS/Python/Java)** | `@qwen-code/sdk` npm package; programmatic agent control | No SDK; CLI-only interface |
| 10 | **Web UI** | Qwen Studio web; AionUi community GUI; browser-based session mgmt | No web UI; Tauri desktop only |
| 11 | **Git Worktrees (native)** | Arena uses worktrees for isolation; auto-mode uses worktrees for parallel tasks | No worktree support; `.agent/` is single-workspace |
| 12 | **Cron tasks** | `qwen schedule` / built-in cron; recurring agent runs | `ox schedule` prints crontab snippets only; no daemon to execute |
| 13 | **Auto-Memory "dream"** | Background consolidation of sessions → insights; runs during idle | Self-improve runs post-task only; no background dream |
| 14 | **Insight generation** | Auto-extracts architectural patterns, decisions, gotchas from sessions | Manual `/reflect` + procedural memory only |
| 15 | **Runtime model switching** | Hot-swap model mid-session via UI/command; context preserved | `/bot` + `/model` hot-switch works; but no per-turn routing UI |
| 16 | **Ghost text (inline completions)** | IDE plugins show gray inline suggestions; accept with Tab | No inline completions; terminal-only |
| 17 | **SWE-bench Verified 77.33%** | Qwen 3.7 Max + adaptive thinking; 1,500 jobs/version | No SWE-bench published; bench is deterministic mock only |
| 18 | **27.8k GitHub stars** | Large community, active contributors, rapid iteration | Newer project; smaller community |

---

## 3. Priority Adoption List — 15 Items Ranked by Impact/Effort

| Rank | Feature | What Qwen Does | How ox Implements It (Specific Files) | Effort | Impact |
|------|---------|----------------|----------------------------------------|--------|--------|
| 1 | **ACP + Daemon mode** | `qwen serve` HTTP+SSE server; multi-client; ACP JSON-RPC; capability negotiation; reverse-RPC | New `src/daemon.js` (Express 5 + SSE); `src/acp.js` protocol; extend `src/agent.js` for session sharing; `src/mcp.js` for MCP proxy | L | High |
| 2 | **Git Worktrees for isolation** | Arena: `~/.qwen/arena/<sid>/worktrees/<model>/`; auto-mode parallel tasks | Not implemented — no module exists | M | High |
| 3 | **Agent Arena (multi-model comparison)** | 5 agents max; isolated worktrees; tab-bar UI; compare/select winner | Extend `src/orchestrator.js` with `arena()` mode; reuse `src/model-registry.js` for model selection; `src/ui.js` for tab-bar | M | High |
| 4 | **LSP Integration** | Code intel (refs/defs/diagnostics) via LSP; used by IDE plugins | Not implemented — no module exists | L | High |
| 5 | **SDK (TypeScript first)** | `@qwen-code/sdk` npm; programmatic `createSession()`, `sendPrompt()`, events | New `src/sdk.ts` (TS for types); publish as `@ox-agent/sdk`; wrap `runAgent()` + event stream | M | High |
| 6 | **OpenTelemetry tracing** | OTel spans for agent runs, tool calls, LLM calls; export to collectors | `src/otel.js` (instrument `runAgent`, `dispatchTool`, `streamVia`); config `otel:` in `~/.ox/config.json` | M | Med |
| 7 | **Cron/Scheduled tasks (daemon-backed)** | `qwen schedule` recurring runs; daemon executes | Extend `src/schedule.js` (currently prints snippets); requires daemon (#1) to execute; `src/headless.js` for run logic | M | Med |
| 8 | **Auto-Memory "dream" (background consolidation)** | Idle-time session → insight extraction; periodic | Background job in daemon (#1); `src/self-improve.js` `reflect()` on session corpus; `src/procedural-memory.js` | M | Med |
| 9 | **Insight Generation (auto architectural patterns)** | Extracts decisions, patterns, gotchas from sessions | No ox implementation; manual `/reflect` + procedural memory only | — | — |
| 10 | **Computer Use (desktop automation)** | OS accessibility APIs; sandboxed; visual verification | New `src/computer-use.js` (macOS `AXUIElement`, Linux `at-spi2`); MCP `desktop` template exists but needs native | L | Med |
| 11 | **Web UI** | Qwen Studio web; session mgmt, history, settings | Tauri desktop exists (`desktop/`); add WebView or separate `desktop-web/` (Vite + React); reuse `src/daemon.js` API | L | Med |
| 12 | **IM Channels (Telegram/Slack/Discord)** | `qwen channel`; `AcpBridge` spawns `qwen --acp` | `src/channels/` (Telegram/Slack/Discord bots); each connects to daemon (#1) via ACP; `src/mcp-templates.js` has Discord/Slack | M | Low |
| 13 | **Ghost Text (inline completions)** | IDE plugins show gray inline; Tab accept | Not implemented — no module exists | L | Low |
| 14 | **Mobile App** | Qwen Studio iOS/Android; account sync | Tauri mobile (iOS/Android) from `desktop/src-tauri/`; needs daemon (#1) for session sync | L | Low |
| 15 | **SWE-bench Evaluation Harness** | 500 cases, 3 trials, Qwen 3.7 Max, 77.33% | New `bench/swebench.mjs` (real provider, Princeton dataset); integrate with `bench/runner.mjs`; publish results | M | Low |

---

## 4. Quick-Start Implementation Order

```
Phase 1 (Foundation)          Phase 2 (Multi-Agent)       Phase 3 (Ecosystem)
├─ 1. ACP + Daemon            ├─ 2. Git Worktrees         ├─ 6. OpenTelemetry
├─ 4. LSP Integration         ├─ 3. Agent Arena           ├─ 7. Cron Tasks
└─ 5. TypeScript SDK          └─ 8. Auto-Memory Dream     ├─ 9. Insight Generation
                                                          ├─ 10. Computer Use
                                                          ├─ 11. Web UI
                                                          ├─ 12. IM Channels
                                                          ├─ 13. Ghost Text
                                                          ├─ 14. Mobile App
                                                          └─ 15. SWE-bench Harness
```

---

## 5. Architectural Notes

- **Daemon is the keystone**: Items 2, 3, 7, 8, 11, 12, 14 all require a persistent daemon process (`qwen serve` equivalent). No `src/daemon.js` exists in ox; this is a gap (was listed as planned, then removed).
- **ACP is the protocol**: Don't invent a custom HTTP API. Implement ACP (JSON-RPC 2.0 over stdio/SSE) per [Agent Client Protocol spec](https://github.com/agent-client-protocol/acp).
- **Worktrees need git**: All worktree features require a git repo. Guard with `git rev-parse --is-inside-work-tree`.
- **LSP augments repo-map**: `src/repo-map.js` provides static structure; LSP adds semantic queries (refs, defs, diagnostics). Use both.
- **SDK wraps existing internals**: `runAgent()` + event stream + config → `createAgentSession()`. No new runtime logic.
- **OTel is additive**: Wrap existing `runAgent`/`dispatchTool`/`streamVia` with spans. Zero behavior change.

---

## 6. Decision Matrix: Build vs Defer

| Feature | Build Now | Defer | Reason |
|---------|-----------|-------|--------|
| ACP + Daemon | ✓ | | Unlocks 6+ other items |
| Git Worktrees | ✓ | | Core to Arena, auto-mode, isolation |
| Agent Arena | ✓ | | Differentiator; reuses orchestrator |
| LSP | ✓ | | Enables IDE plugins, better context |
| TS SDK | ✓ | | Programmatic access; ecosystem growth |
| OTel | | ✓ | Observability; nice-to-have for v1 |
| Cron | | ✓ | Needs daemon first |
| Auto-Memory Dream | | ✓ | Background job; needs daemon |
| Insights | ✓ | | Lightweight; high value |
| Computer Use | | ✓ | Large surface; macOS/Linux divergence |
| Web UI | | ✓ | Tauri desktop covers local; web = daemon |
| IM Channels | | ✓ | Niche; daemon + ACP prerequisite |
| Ghost Text | | ✓ | IDE plugin territory |
| Mobile | | ✓ | Tauri mobile later |
| SWE-bench | | ✓ | Marketing; not a user feature |

---

*End of comparison. For ox architecture rationale see `docs/plan.md`, `docs/research.md`. For Qwen Code details see https://github.com/QwenLM/qwen-code*
