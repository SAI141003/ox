# ox — Competitive Gap Analysis (Ranked by Impact)

**Research date:** 2026-10-01; **gap statuses re-checked 2026-10-03.** Star counts from the GitHub API on 2026-10-01 and will drift.
**Sources:** GitHub REST API (stars, `pushed_at`, `archived`, license), each project's own docs/README/changelog, and vendor documentation. Anything from a secondary channel is marked **UNVERIFIED**.

**Flagged pages:** two competitor-affiliated pages surfaced during research carried promotional framing inconsistent with their own projects' documentation. No claim below rests on them; noted here only so the exclusion is auditable.

---

## 1. Adoption landscape

| project | stars | license | status |
|---|---|---|---|
| OpenClaw | 391.1k | MIT-file (GitHub reports `NOASSERTION`) | active — personal assistant framework, *not* a coding agent |
| Hermes Agent | 250.4k | MIT | active |
| opencode | 211.2k | MIT | active |
| Claude Code | 148.8k | none declared | active |
| Codex CLI | 127.5k | Apache-2.0 | active |
| Gemini CLI | 107.2k | Apache-2.0 | active |
| Zed | 91.1k | `NOASSERTION` | active |
| OpenHands | 89.7k | MIT | active |
| Cline | 69.6k | Apache-2.0 | active |
| Warp | 60k+ | open-sourced | active — block model, GPU renderer, Rust UI |
| Goose | 54.8k | Apache-2.0 | active |
| Aider | 49.3k | Apache-2.0 | **last push 2026-05-22** — maintenance mode |
| Continue | 36.1k | Apache-2.0 | **README: "no longer actively maintained, read-only"** |
| Crush | 28.4k | FSL-1.1-MIT | active |
| Kilo | 27.5k | MIT | active |
| Roo Code | 24.3k | Apache-2.0 | **ARCHIVED**, last push 2026-05-15 |
| Plandex | 15.7k | MIT | last push 2025-10-03 — dormant |

**Read:** consolidation. Two canonical 2024–25 OSS agents are archived or explicitly discontinued (Roo Code, Continue); two more are dormant (Aider, Plandex). Star totals do not track activity — the top of the table is not where live work is concentrated.

---

## 2. Ranked gaps in ox, by impact

Effort: **S** ≤1d · **M** 1–2w · **L** >2w.

| # | gap | who has it | why it matters | eff | ox module |
|---|---|---|---|---|---|
| 1 | **OS-enforced sandbox + network egress control** — **PARTIALLY SHIPPED, see §2.1** | Claude Code (Seatbelt macOS, seccomp+bwrap Linux, domain-gated network, out-of-sandbox commands labelled in-prompt), Codex CLI (OS-enforced, network off by default), OpenHands (Docker default), Gemini CLI (`--sandbox`) | Spawned commands are now confined by Seatbelt/bwrap with a kernel `deny network*` on `restrict_network`, and a `network_allow` host allow-list is enforced in-process. Still open: no kernel-level *allow* list on either platform, and the agent process itself is never confined. | L (remaining) | tool executor, MCP client, trust |
| 2 | ~~**Unattended execution writing to persistent memory**~~ — **CLOSED 2026-10-03, see §2.2** | Claude Code (`/loop`, Monitor, scheduled tasks, Channels), Codex (scheduled tasks), Cursor (Automations, `MEMORIES.md`), Hermes (built-in cron), Devin (cron + self-messaging) | **Both halves are now shipped.** The hard half (screened memory) always existed; the easy half is `ox schedule` (daemon-backed store + system crontab), `/heartbeat`, and `/goal`, which persists an objective *across turns, compaction and resume* with progress that must be **proven** — prose is not evidence, read-only calls are excluded, and `todo_write` is refused as proof because its output echoes the checklist. | **done** | memory, session runner, goal, schedule, daemon |
| 3 | **Subagent orchestration: spawn/delegate/steer/aggregate** — **PARTIALLY CLOSED, re-graded 2026-10-04: spawn ✓, message ✓, aggregate ✓, **parallel ✓ (partial)** · **steer ✗** | Claude Code (subagents + agent teams, task dependencies), Codex (subagents by default), Copilot CLI (`/fleet`, waves), Devin (managed Devins, per-child ACU caps), Zed (`spawn_agent`/`create_thread`), Amp (`oracle`, `Librarian`), Crush (`agent`) | **What landed:** spawn/delegate; real agent-to-agent messaging (`agent_message.send` / `agent_observe`, recipient resolved from `ctx` and never from an argument, **at-most-once** on a durable per-mailbox cursor, writes screened by the *same* `screenPersistText` gate as memory); aggregate; **and, as of 2026-10-04, genuine parallelism** — independent `subagent` calls in one turn run **CONCURRENTLY, 3 at a time by default, ceiling 8** (`src/resource-class.js:71,96,98`), scheduled by `runSubagentBatch` (`src/agent.js:2249`) with **one** approval covering the batch and overflow **deferred to a free slot rather than refused**. The prompt states this, interpolated from the constants so it cannot outrun them (`src/system-prompt.js:124,293`), and `test/parallel-subagents.test.js` is **17/17** including a drift canary. So *"investigate five things at once"* is now available: 3 running, 2 queued into the same turn. **What did not:** ox still has **no mid-flight steering** — nothing can redirect, cancel, or inject into a running subagent. There is **no cancel/stop/kill entry point anywhere in `src/`**; `finishSubagent` is the only exit and is idempotent, and there is still no `abort` reason distinct from `failed`, so an aborted agent reports as failed (`src/subagent-registry.js:554-558`). Mail is **not** steering: a note *"steers nobody"* until the target agent itself polls (`src/resource-class.js:29-30`). And the 3 concurrent subagents **share one filesystem**, so two writing the same file is still last-one-wins — that is #7, and it is why this row stays partial rather than closed. | **M** remaining (was L) — now **steer alone** | subagent, agent-teams, session runner |
| 4 | ~~**First-class web search and fetch**~~ — **CLOSED, re-verified 2026-10-04** | Gemini CLI (built-in), Warp, Copilot (`research` agent), OpenHands (browser + Playwright), Cursor | **Shipped — this row said "ox cannot read the web", which is no longer true.** `web_search` and `web_fetch` are real tools (`src/tools/index.js:37,38`) over an **ordered-backend capability layer** (`addCapability` / `setBackendOrder` / `registerBackend`, `src/capability.js:149,183,225`), not one hardcoded provider. `web_fetch` resolves to the keyless `direct` backend and probes usable at position 1; `web_search` walks its chain and names, per backend, exactly what to set (`TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY`, or reorder with `setBackendOrder`). **`ox doctor` now consumes those probes**: `capabilityReport({capabilities:['web_search','web_fetch']})` populates the same verdict cache the tools read (`src/cli.js:1157-1164`), so the route doctor just proved is the route the next call takes, and a failed route is not retried until its TTL expires (`src/capability.js:284-295`). **Honest limit: `web_search` needs a key** — unconfigured it reports "no live backend", which is a configuration state, not a missing capability. | **done** | capability layer, tool registry |
| 5 | **LSP / code intelligence** | Crush (`lsp add`, `diagnostics`, `references`, `lsp_restart` — its most-copied feature), Aider (tree-sitter repo map), Copilot, Cline | Three payoffs: symbol-accurate edits, `find references` for refactors, and the agent **verifying its own work** — `diagnostics` after an edit turns "I believe this compiles" into "the language server says so". | M | tool registry, context builder, edit tool |
| 6 | **Plugin/extension SDK as a distribution unit — STILL OPEN.** *(Ox's import path moved, the gap did not close: `ox import <claude-code\|hermes\|codex\|all>` brings *other* ecosystems' skills/MCP/memory **in**, which is interoperability, not an SDK for extending ox.)* | Claude Code (`.claude-plugin/plugin.json` bundling skills+agents+hooks+MCP, marketplaces, scopes), Cursor (same five primitives + Marketplace), Gemini CLI (manifest; install/update/validate/link; extensions may ship policies), Goose (70+) | ox has an MCP template registry — right primitive, wrong granularity. **Nobody but ox's author can extend ox as a coherent package**, and that is still true. Unchanged by this session's work. | L | plugin/registry |
| 7 | **Workspace isolation for concurrent work** | Zed (per-thread worktree picker + `create_worktree` hook with `ZED_WORKTREE_ROOT`), Amp (fresh machine per thread), Crush (parallel sessions), Devin Review CLI (isolated worktree) | **Precondition for #3.** Copilot's own docs name the failure: "Sub-agents share a filesystem with no file locking. If two agents write to the same file, the last one to finish wins—silently." | M | session runner |
| 8 | **Per-child compute and spend caps** | Devin (per-child ACU), pi-agents (`maxCost`, `maxTurns`, `maxDepth`, `maxAgents`), Codex quotas | ox already has `--max-cost` as a *hard* stop, but only at session scope. Once subagents exist, fan-out is an unbounded bill. Small change to an existing subsystem; should ride with #3. | S | cost ledger |
| 9 | **Cross-model second opinion** | Amp (`oracle`: deliberately a different model family, extra-high reasoning), Copilot (`rubber-duck`: "runs on a different model from the one driving your session") | Same-model self-review on the same context is the weakest possible check. ox already has 13 bot presets across ~10 providers plus `model_overrides`, so this is nearly free. | S-M | provider, bot |
| 10 | **Transcript retrieval + autonomous skill synthesis** — **HALF CLOSED 2026-10-03: retrieval ✓ · agent-authored skills ✗** | Hermes (FTS5 session search + LLM summarisation; skills created from experience; periodic self-nudges), Cursor Memories, Devin (derives playbooks from successful sessions) | **Retrieval shipped:** real BM25 over raw transcripts with `-term` negation (`src/session-index.js:160-192`), surfaced as `ox history [query]` — not substring matching. **Synthesis did not:** `/refine` landed but over four fixed, evidence-gated categories (`supplemental-prompt`, `memory`, `skill-description`, `subagent-spec`) and it edits a skill's *description* — **it does not author a skill**. Its structural immutability (7 targets incl. the base system prompt, refused on bytes) and reviewer-sourced `score`/`verified` are things I can verify for ox and **cannot** source for any competitor (**UNVERIFIED** elsewhere). | M (synthesis only) | memory, refine |
| 11 | **Plan mode as a distinct read-only mode** | opencode (Tab-switchable, denies edits), Copilot, Crush, Warp (`/plan`), Cursor, Devin | Cheapest mitigation for the most common expensive failure: the agent edits before understanding scope. | S-M | plan mode |
| 12 | **Automatic compaction + context-window breakdown** | Zed (auto-compaction at 90%, dedicated `compaction_model`, visible "Context Compacted" entry you can audit), Copilot (95%, background, `/context` breakdown), Warp (per-segment: system prompt / tool defs / history / latest input / images) | Auto-compaction is what makes long unattended runs (#2) survivable; the breakdown tells a user *why* the bill went up. | S-M | context builder |
| 13 | **Chat-channel / mobile ingress** | Hermes (Telegram/Discord/Slack/WhatsApp/Signal/CLI, one gateway), OpenClaw (20+ channels, 391k★), Claude Code Channels (research preview) + Remote Control | This is how the market shifted from "a tool you run" to "an agent you live with". ox already has 13 bot presets and an out-of-band approval bridge over a Unix socket, so the transport half exists. **Security caveat:** claims that OpenClaw's marketplace became a malware delivery channel (**UNVERIFIED**: 135k exposed instances, CVE-2026-25253, 800+ malicious skills) are secondary-source and unconfirmed — but the direction matches the #6 plugin-supply-chain risk. This capability carries real cost and needs a designed trust model, not a bolt-on. | M | bots, bridge |
| 14 | **Code review / PR agent** | Cursor Bugbot, Devin Review, Codex (`@codex review`), Copilot `code-review` | Review is read-mostly — cheap to sandbox, easy to make safe — and produces an artifact rather than mutating code. Also the ecosystem entry point for Codex/Devin/Bugbot. | M-L | review, plugins |
| 15 | **First-party IDE extension** — **NOT RECOMMENDED** | Cline, Roo/Kilo, Continue, Cursor, Windsurf, Zed, Warp, Gemini CLI | **Mitigating fact:** ox already ships `ox acp` and Zed consumes ACP, so ox can reach an IDE today without writing an extension. Recommend **do not** build one; register `ox acp` with the ACP/agent directories instead — same outcome, a fraction of the cost. | L | `ox acp` |
| 16 | **A2A protocol** — **SPECULATIVE, NOT A GAP** | A2A is Linux-Foundation-hosted at 26k stars, but **no coding agent in this survey ships it** as client or server | ox already has ACP, which is the protocol with actual editor adoption. Treat as a possible bet, not a competitive loss. | L | — |

**Sequencing:** #7 gates the *parallel* half of #3; #8 should ship with it; #6 gates #14's distribution story. #4, #9 and #11 are individually cheap and independent.

**Status as of 2026-10-03, re-verified 2026-10-04:** #2 **CLOSED** (§2.2). #3 **partially closed — a further quarter has closed since**: messaging, aggregate **and now parallelism** have landed (3 concurrent subagents, ceiling 8, overflow deferred rather than refused), so **steering is the whole of what remains** of #3, along with the isolation in #7. #4 **CLOSED** — built-in `web_search`/`web_fetch` over an ordered-backend capability layer that `ox doctor` now consumes and whose verdicts the tools share. #7 and #8 are **still open, and their reason for being urgent has inverted**: the reasoning when this was written was that concurrency #3 lacked was the only thing between a user and a surprising bill. That concurrency now exists, which is precisely what makes #7 and #8 matter — three subagents sharing one filesystem with no worktree is the sharp form of Copilot's own warning (*"if two agents write to the same file, the last one to finish wins—silently"*), and the per-child cost cap matters because spend is **linear** in agent count and the fan-out cap is its denominator.

### 2.1 Gap #1 — what is actually enforced now, and what is not

Shipped in `src/sandbox.js`, `src/tools/web.js`, `src/mcp.js`. Two pre-existing
defects had to be fixed first, because any policy layered on them would have been
corrupt: `compileSbpl` dispatched on `profile.name` while `loadCustomProfile`
overwrites `name`, so **every** custom profile silently took strict's policy (a
`(deny network*)` it never asked for, no workspace write roots) and disagreed with
the bwrap argv; and `cacheKey` omitted `read_only` (and would have omitted
`network_allow`), so two different policies shared one compiled SBPL file. Both are
now keyed off `profileBaseName()` = `extends ?? name`, and the cache key covers
every field either backend reads.

| Layer | Enforcement | Status |
|---|---|---|
| macOS, spawned commands | `restrict_network` compiles `(deny network*)` | **kernel-enforced** — verified live (`curl https://example.com` under a compiled strict profile cannot resolve a host; the same curl unsandboxed returns HTTP 200) |
| macOS, per-host allow rules | `(allow network-outbound (remote ip "H:P"))` | **not available on this platform** — macOS 15.7's `sandbox-exec` refuses to compile it (`host must be * or localhost in network address`); ox probes the local binary once (`seatbeltAllowsRemoteIp()`) and only emits rules where they load, with a `;` comment in the compiled profile saying which case applies. Hostname and CIDR entries are never translated to kernel rules. |
| Linux, spawned commands | `--unshare-net` | **kernel-enforced deny** |
| Linux, `network_allow` / `read_only` | no bwrap primitive exists (`--unshare-net` is all-or-nothing; a writable bind cannot be re-ro-mounted underneath itself) | **unapplied, reported loudly** — `bwrapGaps()` returns the names, `prepareSandbox()` warns once on stderr, and the result carries them. Fail-closed: the deny is still applied. |
| In-process web tools (`web_fetch`, `web_search`, `open_url`) | `network_allow` matched against the normalised host | **enforced, userspace** — this is the layer where host allow-lists genuinely work, because no seatbelt/bwrap rule reaches node code inside the agent. Not a DNS boundary: an allowed name can resolve elsewhere later. |
| MCP server processes | spawned through the same `prepareSandbox` prefix as `bash` | **enclosed** (stdio framing unaffected; both backends pass inherited pipes through). An MCP server's own host allow-list remains inexpressible. |
| The agent process itself | — | **never confined.** No plugin, dependency, or in-process tool call is constrained by Seatbelt/bwrap. |

Still open, in impact order: (1) the agent process is not confined, so any
in-process network call outside `networkEgressVerdict` is unmediated; (2) there is
no kernel-level allow-list on either platform, so a spawned `curl` is either fully
denied or fully allowed — never host-scoped; (3) DNS rebinding is out of reach for
any implementation that does not pin addresses at connect time.

### 2.2 Gap #2 — closed, with the measurements

Verified 2026-10-03. `node --test test/{daemon,prompt-layering,persistent-goal,agent-messaging,refine}.test.js` = **97/97**, `test/{schedule,schedule-regressions}.test.js` = **17/17**.

| Half of the gap | Status | Evidence |
|---|---|---|
| Unattended execution | **Y** | `ox daemon start` → `pid 11244`, `ox daemon status` → `running · up 3s · instance 799971a0…`, `ox daemon doctor` → **healthy** (`0700` dir uid 501, `0600` socket, pidfile matched, no orphans), `ox shutdown` → clean. `ox schedule add` runs **inside** the daemon; `ox schedule "<goal>" --install` writes a system crontab and **refuses with exit 4** off a TTY. |
| Writing to persistent memory, unattended | **Y** | `/goal <text>` persists across turns, compaction and resume as a `{t:'goal'}` event in the existing append-only transcript — no new store to lose. |
| **Honest limits that survive the closing** | | Heartbeat/schedule dispatch is **off by default behind two independent gates** (daemon-wide `opt-in` **and** per-row `enabled`). A schedule may carry only `--max-cost`/`--bot`/`--model` — it can never widen its own sandbox, trust level or approval policy. Goal progress must be **proven**: prose is never evidence, read-only calls are excluded, `todo_write` is excluded *because its result echoes the checklist*, and `/goal done` refuses and names what is unproven. |
| **Known defect found while verifying** | | **RESOLVED 2026-10-04 — no longer a defect.** It read: *`ox heartbeat start\|list\|stop` does not run*, because `'heartbeat'` was absent from `SUBCOMMANDS` at `src/cli.js:190` and so rejected before the implemented `case 'heartbeat':`. **It is now present** (`src/cli.js:197`) and the handler at `src/cli.js:3374` is reached — `ox heartbeat` and `ox heartbeat list` both exit **0** and print real usage and state (`heartbeats (0)`, `daemon NOT opted in — nothing fires until ox schedule opt-in`). The two gates that actually protect the user are untouched: nothing fires until daemon-wide `opt-in` **and** per-row `enabled`, so "routed and working" is not "fires by default". `/heartbeat` remains correctly bounded (`maxRuns` default 3, refuses without an active goal). |

**Also closed while verifying, not on the ranked list:** agent-to-agent messaging (`agent_message.send` / `agent_observe` — recipient from `ctx` not from an argument, at-most-once on a durable cursor, screened like memory), which was part of gap #3.

---

## 3. What ox has that the surveyed competitors lack

- **Zero-dependency install** — no runtime tree at all (`dependencies:{}`, `devDependencies:{}`) against every competitor's heavy stack. **`src/` measured 2.2M on 2026-10-03** (was 1.5M in this document and 1.9M in `COMPARISON_MATRIX.md` §2 on 2026-10-02; the tree grew, the dependency count did not).
- **Credential/injection screening on every persistence surface**, on write *and* read, with single-source pattern tables and *visible withholding*. Re-counted 2026-10-03: **5 call sites inside `src/memory.js` plus 10 outside it**, covering `memory`, `agent message`, `goal objective`, `pattern`, `<category> refinement`, `schedule prompt`, `subagent lesson`, `file path` and descriptor fields. The previous "13 surfaces" figure predates the agent-message and goal-objective paths. Nothing in the survey does this.
- **Evidence-gated *completion*, not just evidence-gated memory.** A goal's progress must be proven from transcript events: prose is never evidence, read-only calls are excluded, and `todo_write` is refused as proof *because its own output echoes the checklist*. A model cannot mark its own homework, and `/goal done` names what is unproven.
- **Fail-closed spend:** `--max-cost` is a hard stop; unpriced models abort before any request; unknown prices report `null`, never `0`. Contrast: Hermes reported $4.12 across 46.9M tokens on silent fallbacks (#97942) and 5× cost escalation on re-login (#68144); Devin's per-PR cap is documented as "a soft block (you can re-enable if needed)"; opencode's permissions "default to allow".
- **Evidence-gated persistence for episodes** — a memory can only be promoted with a lesson plus score/verification. `/refine` uses the identical bar and takes `score`/`verified` from the **reviewer's** judgement, never from the proposal text, so a model cannot vote itself past the gate.
- **Append-only JSONL transcripts**, against a cluster of SQLite state-corruption reports (Hermes #5563, #92996, #100788).
- **Context floor support for small local models**, versus Hermes' hard `MINIMUM_CONTEXT_LENGTH = 64_000` startup rejection (#31600) that forces users to misreport their window.
- **Out-of-band approval over a Unix socket with "silence ⇒ decline"** — the only harness surveyed with a documented fail-safe external approval path.
- **Provider-agnostic IPC/ACP bridge**; competitors are largely single-vendor.

---

## 4. Reliability patterns worth adopting — and two not to copy

Adopt:
- Codex **retired** its `untrusted` approval policy and now refuses to start if it is configured — fail-loud migration over silent acceptance.
- Cursor documents which hooks do **not** fire in cloud agents, and why.
- Claude Code marks commands that fall outside the sandbox as `Bash command (unsandboxed)` in the prompt, so the model can see the downgrade.

Do **not** copy:
- Aider skips pre-commit hooks by default (`--no-verify`) — hook bypass as a default is a hazard.
- Crush executes repo-supplied config at load time (`crushrc` in an untrusted repo) — that is code execution on clone.

Also: Devin's docs warn that `git diff HEAD` on handoff "can include uncommitted secrets — API keys, tokens, or .env edits", and that the prompt is uploaded to a cloud session. ox should scrub handoff context on the same principle.

---

## 5. Integrity notes

1. Star counts, `archived` flags and last-push dates are GitHub API values as of **2026-10-01** and will drift.
2. OpenClaw and Zed report `NOASSERTION` for licence; OpenClaw ships an MIT file. Do not read `NOASSERTION` as a licence judgement.
3. The "who has it" column in §2 is from project-owned documentation. The OpenClaw marketplace malware claim is **UNVERIFIED** (secondary sources) and is used only as a direction-of-risk note, not as a factual count.
4. Two competitor-affiliated pages encountered in research were promotional and were excluded from all findings.
5. The conclusions in **#15** (no IDE extension) and **#16** (A2A) both depend on ACP remaining registered and functional in the editor/agent directories. If that stops being true, #15 becomes live work and #16 rises.

---

## 6. Cross-reference: `docs/REAL_BENCH.md`

ox's own real-world benchmark is **model-driven, not harness-driven**: task outcomes track the model behind the run far more than the harness wrapping it. This document is therefore about **harness capability** — sandboxing, orchestration, ingress, spend control — and is not a claim about measured task success. For success-rate evidence see [`REAL_BENCH.md`](./REAL_BENCH.md); for the earlier vendor-by-vendor feature sweep see [`gap-analysis.md`](./gap-analysis.md) and [`comparison.md`](./comparison.md).
