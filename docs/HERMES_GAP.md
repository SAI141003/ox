# Agent platform comparison — verified 2026-10-21

Scope: NousResearch's current Hermes Agent repository and first-party Hermes
documentation, compared with the Ox source and tests in this checkout. This is a
capability audit, not a claim that either product has been exhaustively tested
against every provider, operating system, or deployment. Upstream docs and code
change frequently; re-check before treating this as a release certification.

Primary references: [Hermes Agent repository](https://github.com/NousResearch/hermes-agent),
[Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers),
[Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools),
[Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
[Scheduled Tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron),
[Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging),
[Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator), and
[LSP diagnostics](https://hermes-agent.nousresearch.com/docs/user-guide/features/lsp).

## Memory: actual capacity and architecture

| Dimension | Hermes (first-party docs) | Ox (this checkout) |
|---|---|---|
| Always-loaded curated memory | `MEMORY.md` 2,200 characters (~800 tokens) plus `USER.md` 1,375 characters (~500 tokens); capacity shown in the prompt; overflow is refused, not silently dropped. | Project `.agent/MEMORY.md` index is capped for prompt injection at 150 lines / 20 KiB; overflow remains on disk and is reported. The temporal graph has no fixed entry-count cap; each fact is limited to 1,000 characters. Prompt selection is bounded (up to 12 stable + 8 recent user facts, plus task-relevant recall). |
| Structure / recall | Two compact files plus optional external provider; frozen snapshot at session start. | Separate user and per-project append-only JSONL temporal graphs, typed facts, entities/slots, supersession history, time validity/expiry, strength/importance, lexical BM25-style ranking, recency decay, one-hop entity expansion; plus project index/topic notes, brain notes, episodes, procedural memory and subagent memory. |
| Update / deletion | `memory` tool supports add/patch/remove; exact char-cap feedback and duplicate prevention. | Similar entries are deduplicated/updated; changed values supersede prior facts with history; CLI/UI can inspect and forget (forget marks inactive, retained on disk). `memory_add` can append detail to topic notes. |
| Safety / consent | Injection, credential, and invisible Unicode scanning; optional `write_approval` stages memory changes for review; notification of writes. | Shared persistence screen blocks credential-shaped and injection-shaped content at write and read time across memory and related stores; withheld content is surfaced and audited. Explicit memory tool and app action save locally. App chat preference learning is opt-in; terminal learning can be disabled with `OX_LEARN=0`; incognito must neither inject nor write memory. There is no general approval queue for a model-requested memory write today. |
| Conversation recall | All CLI and messaging sessions in SQLite/FTS5; search yields actual messages and supports browse/scroll, with no LLM call claimed for search itself. | CLI transcript search exists, including BM25-style index and a raw JSONL substring fallback. A BM25 session-index module provides search/browse/scroll but is currently instantiated in `src/platform.js` without an evident indexing/search-tool integration. This is a concrete wiring gap to resolve before claiming parity with Hermes' agent-callable cross-session recall. |
| External memory | Built-in memory always remains; two bundled provider plugins (RetainDB and ByteRover), with additional catalog integrations including Honcho, Hindsight, Supermemory, Mem0, OpenViking and Holographic. One external provider active at a time. Context prefetch, turn sync, end-of-session extraction and mirrored writes are provider-dependent. | Honcho integration exists, as do plugins/MCP and local memory; there is not yet a uniform, provider-neutral memory adapter matching Hermes' documented provider selection and lifecycle. Connecting cloud memory would send conversation/context data off-device and should remain explicit opt-in with per-provider disclosure. |

**Capacity conclusion:** Hermes' built-in always-loaded memory is deliberately small and
predictable (~1,300 tokens total). Ox can retain a much larger local corpus, and its
graph carries temporal/history metadata, but only a bounded subset is injected each
turn. Neither product's docs establish a true finite maximum for all disk-backed
history; “unlimited” should be read as no product-level session-count quota, not
unlimited storage. Ox's append-only graph can grow until compacted; compaction keeps
the latest record per fact ID. Session transcripts are also local JSONL. The web app
does not persist chats by default; local browser history is opt-in. Provider requests
still contain the prompt and code/context needed to answer.

## Current feature map

| Hermes capability | Ox evidence / status | What remains |
|---|---|---|
| Multi-provider coding agent, tools/toolsets, MCP and plugins | Ox has multi-provider routing, MCP, plugins, a large built-in tool set, adaptive schema narrowing and local models. See `src/providers/`, `src/tools/`, `src/plugins.js`, tests. | Audit provider- and platform-level tool compatibility with real credentials; this checkout has no valid hosted inference credential, so live comparisons cannot prove all paths. |
| Skills, progressive/on-demand context, learned procedures and skill cleanup | Ox supports skills, skill usage/curation/archiving, evidence-qualified drafts, and `ox self-improve`; skills are reviewed/accepted rather than silently promoted. | Hermes allows direct agent-authored skill changes with optional approval and a background curator; Ox intentionally stages drafts but has no memory-write review queue. Compare UX, not just feature count. |
| Session search and recall | Ox stores JSONL sessions, exposes CLI history search, and gives agents a read-only `session_recall` tool over matching terminal-transcript excerpts. Results name the local transcript, project folder, and date; the existing secret redactor runs before content reaches a model. | The experimental `session-index.js` BM25 index/scroll implementation is still not the serving path. Recall currently uses the established transcript search and does not expose full-message scrolling. Incognito sessions remain excluded. |
| Cron / scheduled agents | Ox has schedule/cron modules and app schedule surfaces. | Verify in a running daemon that per-job model, project, skills, continuity, delivery and no-agent execution all work end-to-end; do not infer complete parity from module presence. |
| Messaging gateway / voice and cross-platform continuity | Ox has Telegram, Discord and Slack gateways, phone bridge, voice and mesh features. | Hermes documents a broader platform roster (including WhatsApp, Signal, email, Teams, Matrix, iMessage via BlueBubbles, etc.). Ox does not have equivalent turnkey coverage for every listed channel. |
| Persistent, profile-scoped external memory | Ox has a local temporal graph and Honcho integration. | Provider-neutral lifecycle (selection/status, background recall/sync, provider write mirroring, strict opt-in/data disclosure) is still a gap. Do not send user/project content to a cloud provider by default. |
| Computer-use / remote execution | Ox has local operator tools and a deliberate security boundary around remote machine control; mesh is not authorization to execute commands on another machine. | Hermes deployment backends and Ox mesh are not the same capability. No implicit remote execution should be added from this comparison. |
| LSP semantic diagnostics | Ox has repository maps and language-aware analysis, but no general language-server manager comparable to Hermes' documented post-write semantic diagnostics. | Consider an opt-in local LSP diagnostic adapter with explicit server installation/launch controls and safe workspace scoping. |
| Mixture of Agents, delegated execution, model gateway | Ox has parallel subagents, agent teams, model routing, and provider adapters. | Validate provider/model feature combinations and cancellation/steering; avoid claiming parity with all Hermes backends or orchestration modes. |
| Cross-platform deployment and terminal UI | Ox ships macOS app/island plus CLI/web/server surfaces and is actively tested across targets. Hermes documents Linux/macOS/Windows/Termux and container/SSH/cloud terminal backends. | Linux desktop and signed distribution items remain separate release gaps; use the CI matrix for platform proof. |
| Durable Kanban collaboration and worker lanes | Ox's local board already had atomic claims, blockers, goals, budgets, review gates, activity, org assignment and a web board. The Hermes parity pass adds durable attributed comments, worker heartbeats, explicit block/unblock transitions, worker-lane metadata, completion-contract metadata, and auditable HTTP artifact links through the existing task files/activity log. | Ox still uses its JSON task store and `ox task run`/org beats rather than Hermes' SQLite dispatcher and external non-Hermes lane plugin API. It does not claim drop-in compatibility with `~/.hermes/kanban.db`; the task-board API is the supported boundary. |

## Priorities from this review

1. **Improve the existing session recall path.** Agent-accessible recall now uses
   the established transcript search with redacted excerpts. The remaining
   `session-index.js` BM25 experiment should either become a separately verified,
   incrementally maintained index with paginated message access, or be removed;
   it must not silently replace the transcript source of truth.
2. **Offer an optional memory-write approval mode.** Keep today's explicit/local
   workflow as default; add a durable pending queue and review/approve/reject UI/CLI
   only if it can atomically pin the exact fact version being approved, reject stale
   edits, surface automatic learning, and preserve the existing security screen.
3. **Show memory capacity and lifecycle clearly.** Expose graph counts/bytes, index
   cap/truncation, last write, sources, and what is actually injected into the next
   prompt. Distinguish “stored” from “available to this turn.”
4. **Benchmark semantic diagnostics and external memory providers separately.** LSP
   can be local; provider adapters can incur external data egress and extra model/API
   costs. Keep opt-in, consent, pricing, and failure behavior explicit.

## Hermes Kanban parity pass — 2026-10-23

The current Hermes reference defines Kanban as a durable SQLite-backed board shared
by named profiles, with a canonical lifecycle (`ready` → `running` → `review`,
`blocked`, `done`, `archived`), explicit worker lanes, liveness heartbeats,
comments/handoffs, dependency links, attachments, and reviewer-gated completion.
Hermes workers report through `kanban_*` tools while operators use the CLI or
dashboard; neither surface is allowed to become a second source of truth.

Ox now covers the worker-facing lifecycle without introducing an unreviewed second
store: `task_board` supports `comment`, `heartbeat`, `block`, `unblock`, and
`link` in addition to its existing brief/add/done/next actions. Task records carry
`workerLane`, `completionContract`, `heartbeatAt`, `links`, and `attachments`
defaults for forward-compatible board data. Tests prove ownership checks, durable
handoffs, liveness, pause/resume, and artifact links. The implementation does not
import Hermes' database or silently spawn arbitrary workers; Ox's existing claims,
approvals, budgets, review gate and local-only persistence remain the security
boundary.

Primary evidence: [Hermes Kanban reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md),
[worker-lane contract](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban-worker-lanes.md),
and [Hermes desktop plugin](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/plugins/kanban/plugin.tsx).

## Verification and honesty

This comparison is based on source/docs, not a live product-vs-product benchmark.
The full Ox test suite on this checkout executed 2,441 tests: 2,192 passed, 0
failed, and 249 were skipped (duration 223.4 seconds). Targeted memory, web-chat,
pricing, and session tests also passed before that run. This verifies the current
checkout's tests, not every real provider, GUI path, operating system, or release
build. Provider latency, token cost, and model quality require identical tasks,
models, accounts, hardware/network conditions, and credentials; no such benchmark
was run here.

## Xiryn — repository shown in the screenshot

The screenshot is Xiryn, repository
[`SouravBeraAkaSpeed/xiryn`](https://github.com/SouravBeraAkaSpeed/xiryn), not
OpenMausBot. Its README and source were inspected at commit
[`0a55cd9`](https://github.com/SouravBeraAkaSpeed/xiryn/commit/0a55cd9). These are
the upstream project's implementation/documentation claims, not an independent
installation or security certification.

| Xiryn feature area | Ox status from this checkout | Assessment / appropriate next step |
|---|---|---|
| Personal agents, separate roles/instructions/models, squads, task continuity | Ox has configurable agents/providers, agent teams, subagents, work tracking, resumable sessions, and project memory. | Core orchestration is present, but Xiryn's dedicated agent/workstation lifecycle is a different product shape. Compare per-agent identity, workspace, memory and lifecycle UX before claiming equivalent. |
| One Linux desktop per agent, Docker, persistent home, Chromium, live view and pause/takeover | Ox `--backend docker` runs shell commands in one temporary per-process container, mounts the project, and removes it at exit. It does not create one persistent GUI desktop per bot, include Chromium/screen control, or offer takeover. | **Major gap.** Design an opt-in, isolated per-agent workstation service as a separate backend, with lifecycle controls, narrow workspace mounts, resource limits, and explicit live-view/takeover consent. Do not repurpose the current shell-only backend or give a bot host-wide access. |
| Any model / local inference | Ox routes to hosted and local providers and has model discovery/routing. | Strong overlap. Validate actual installed models and tool-call compatibility per provider; README support is not proof every model works equally. |
| Local-first storage and update transparency | Ox keeps CLI sessions/memory/usage locally and describes app-chat persistence explicitly. | Overlap. Continue to disclose provider egress (prompt/code sent for inference), app history choices, and update checks. |
| Telegram access from outside the laptop | Ox has a Telegram gateway and phone bridge/approval path, plus Discord and Slack gateways. | **Present, but not the same surface.** Xiryn documents per-agent/squad selection, live screenshots/progress, and workstation takeover from Telegram. Verify/extend Ox's phone UX only within explicit pairing and approval boundaries; never imply offline remote control. |
| Encrypted vault for logins/payment details, masked hints, site-bound autofill, payment approval | Ox has credential screening, key storage, `.oxignore`, and approval gates, but no Xiryn-style autofill/payment vault. | **Absent by design.** Do not copy payment/autofill functionality as a quick feature. It requires threat modeling, platform keychain, domain binding, payment confirmation, replay prevention, and a dedicated security review. |
| Web search/research with citations; browser fallback | Ox has web search/fetch, research and browser tooling. | Present in parts; no equivalent Firecrawl account/search-fallback contract established by this source scan. Test citation retention, site failures and local-vs-provider egress separately. |
| Background work, notifications, spend tracking | Ox supports schedules/flows, daemon tasks, desktop/phone notifications and usage/cost tracking. | Strong overlap; Xiryn's README lists recurring schedules as roadmap rather than shipped, so don't count them as an Xiryn match. Ox schedules intentionally require opt-in and a budget cap. |
| Speech input | Ox has dictation/voice features, with platform-specific backends and honest fallbacks. | Overlap; compare on-device behavior and actual platform availability rather than feature labels. |
| Security boundary | Xiryn says its web server is loopback-only, agents run inside their workstation containers, and Telegram is owner-paired. | Ox has tool approval modes, workspace controls, incognito boundaries, and encrypted mesh identity. These are different boundaries; adding a workstation backend must preserve or strengthen current approval and privacy guarantees. |

Xiryn also documents a local setup path (Docker, model provider or Ollama), optional
Firecrawl and Telegram, per-turn usage, notifications, persistent/disposable
workstations, reset/delete behavior, and a vault. Its current README lists scheduled
and recurring tasks as a roadmap item, so this report does **not** classify those as
shipped. No Xiryn setup script was run and no Docker desktop session was launched.

## OpenMausBot — separate GitHub project

The second target is the repository
[`milind-soni/OpenMausBot`](https://github.com/milind-soni/OpenMausBot), inspected at
[`bd5e209`](https://github.com/milind-soni/OpenMausBot/commit/bd5e209), plus the
[OpenMausBot feature documentation](https://docs.openmausbot.com/docs/features).
The project calls itself OpenMausBot (also MausBot); it is separate from Xiryn.
The feature docs explicitly distinguish released capabilities from proposals, but
this review did not install/run the app or independently verify service accounts.

| OpenMausBot feature area | Ox status from this checkout | Assessment / appropriate next step |
|---|---|---|
| Agent roster, per-bot role/model/folder, persistent chats, live tool events | Ox has agents/providers, project-scoped sessions, streaming runs and a web app. | Present in core; audit per-bot configuration and discoverability in the UI separately. |
| Edit/branch/rewind/pin/react/export/share chat controls | Ox has session continuation, `/undo`, rewind/history and exports, but not every conversation-management affordance as a single coherent app UI. | Partial. Inventory each visible operation and its persistence/undo semantics before implementation. |
| Rooms, agent-to-agent delegation, queueing/steering | Ox has agent teams, subagents, task board, run cancellation/steering surfaces. | Partial-to-present; room-style shared conversation and queued message UX are not assumed equivalent. |
| Per-task tokens and cost | Ox has usage logs, cost estimates, model/provider prices, budgets and trace views. | Present; improve in-turn visibility only if estimates are labeled and match provider billing. |
| Readable/editable bot memory | Ox has local temporal memory, project notes, CLI/app controls and skill drafts. | Present with a different architecture; transcript recall wiring and reviewable memory-write queue remain gaps from the Hermes audit. |
| Local host, isolated Docker/Podman VM, hosted computers, self-hosted VPS, screen preview/takeover, Android USB | Ox has local operator tools, a shell-only ephemeral Docker backend, and a direct paired-machine mesh. | **Partial/major UX and capability gap.** There is no single bot-level computer picker spanning those backends, and mesh is a different trust model. Do not equate paired-machine access to a disposable agent workstation. |
| Composio connected apps (hundreds; multiple labeled accounts) | Ox has plugins/MCP and email plus messaging integrations, not a unified OAuth marketplace with per-bot labeled accounts. | Partial. A provider-neutral connector UX/permission registry is a candidate, but each connector needs real account authorization and least-privilege scopes. |
| One-time/weekday routines, secret webhooks, app-event triggers, run receipts | Ox has opt-in, cost-capped schedules and flows/webhook support. | Partial: the full event-triggered-app integration and durable per-run receipt UX are not established as equivalent. Build only with replay protection, secret rotation, approval, and spend controls. |
| Bot-specific TTS, Mac dictation/call mode, paired iOS companion with search/approvals/view | Ox has voice/dictation, Telegram/Discord/Slack gateways, phone bridge/approval, and desktop web/app surfaces. | Partial. No equivalent native iOS client has been verified in Ox. Compare platform behavior and the exact approval/viewing scope. |
| Cross-platform packaged app and automatic updates | Ox has macOS app/island, web/CLI, and a CI matrix; some distribution targets remain open in the handoff. | Partial. A successful source/CI test is not a signed installer or automatic updater. |
| Theme, sidebar, pinned messages, attachments, accessibility | Ox has theme controls, app navigation, media/attachments and accessibility work. | Needs visual/interaction acceptance testing; source presence alone doesn't certify layout or usability. |

The project documentation also advertises integrations, computer backends, routine
management, chat editing/search, and platform-specific safety gates. Notable
constraints in its own docs: Ubuntu Wayland host control is disabled under a safety
hold; Windows installer signing is incomplete; and the iOS companion keeps sensitive
workspace configuration on the host. These caveats matter as much as the feature
list. The current README/docs describe a release-oriented feature set; this audit
does not exercise its native app, OAuth, cloud desktop, or phone client.

## What to build in Ox from these comparisons

This is not a request to copy either application's source or reproduce every screen.
Both projects cover large products with differing security and deployment models.
The audit yields the following safe Ox work packages; each needs its own design,
acceptance criteria and tests before it can be called done:

1. **Per-agent isolated workstations (Xiryn's key differentiator).** New backend,
   persistent container identity, per-agent working home, optional Chromium GUI,
   preview, pause/takeover, restart/reset/delete, offline network policy, CPU/RAM/disk
   quotas, and no host home/key mounts. This is not shipped by Ox's current
   `--backend docker` command runner.
2. **Connected-app catalog and account scopes (OpenMausBot).** Discover, OAuth
   connect/disconnect, show scopes/account labels, and route tool access by agent.
   Add connectors only after permissions and secret storage are reviewed.
3. **App-event automations and receipts (OpenMausBot).** Add source-filtered event
   triggers, replay-safe webhook secrets, per-run context/receipts, pause/edit/undo,
   attention notifications, and budgets. Current schedules/flows are not a blanket
   substitute.
4. **Conversation controls and historical recall.** Close the session-index wiring
   gap documented above; then test exact hit retrieval/pagination and add explicit
   edit/branch/export/share affordances where the Ox UI lacks them.
5. **Mobile continuity.** Audit which phone bridge actions can safely be completed
   from paired devices; make approvals, run status, search, and any screen viewing
   clear and revocable. Do not advertise an iOS companion until it exists and passes
   platform tests.
6. **Keep intentionally high-risk features separate.** Do not add automated
   payment, password/card autofill, unconstrained host computer use, or remote
   execution merely to match a competitor's feature list. They require explicit
   user demand, threat models, opt-in, narrow grants, and security acceptance.

The only meaningful design decision from these sources that should affect Ox now is
to treat **agent identity + isolated persistent computer + approvals + cost + logs**
as one coherent unit, rather than presenting shell containers, mesh peers, and
browser control as interchangeable. That is an architecture roadmap item, not a
claim that all competitor features have already been added.
