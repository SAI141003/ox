# ox — Comprehensive Comparison Matrix

**Research date: 2026-10-03; re-verified 2026-10-04** (subagent parallelism and steering, `ox heartbeat` routing, the capability layer, and the `ipc` redaction defect — commands in §10.31–§10.34). Star counts from the GitHub API snapshot of **2026-10-01** (carried forward from [`COMPETITIVE.md`](./COMPETITIVE.md) §1, itself sourced that date). Everything else was checked on **2026-10-02**, except the rows re-verified on **2026-10-03** — daemon continuity, agent-to-agent messaging, heartbeats, persistent goals, prompt layering and `/refine` (§1.2^2^, §1.3^2^, §5^2^) — which were re-measured live; their commands are logged in §10.20–§10.26.

**This document is docs-only.** No `src/` or `test/` file was created, modified, or deleted while producing it.

---

## How to read this document

### Vocabulary

| Mark | Meaning |
|---|---|
| **Y** | Yes — verified from a cited first-party or project-owned source |
| **P** | Partial — works, with a stated limit |
| **N** | No — verified absent |
| **—** | Out of category (the system is not a coding agent, or the axis does not apply) |
| **?** | **UNVERIFIED** — I could not source it. This is not "probably no". A blank guess is forbidden; see §0.3. |

**Rule applied throughout:** a cell is `Y` or `N` only if a source is cited in the Notes/§10 block. Anything I could not source is `?`. The `?` cells are numerous and that is the honest state of the art: proprietary agent internals are not publicly documented, and I did not paper over that.

### Columns

| Code | System | Licence | Note |
|---|---|---|---|
| **ox** | **ox** (ox-agent 0.1.0) | MIT | This project. Every ox cell was verified this session — see §10. |
| OC | OpenClaw | MIT-file (API: `NOASSERTION`) | Personal-assistant framework, **not** a coding agent |
| He | Hermes Agent | MIT | |
| oc | opencode | MIT | |
| CC | Claude Code | none declared | Anthropic |
| CX | Codex CLI | Apache-2.0 | OpenAI |
| GC | Gemini CLI | Apache-2.0 | Google |
| Zd | Zed | `NOASSERTION` | Editor + agent host |
| OH | OpenHands | MIT | |
| Cl | Cline | Apache-2.0 | |
| Wp | Warp | open-sourced | Block model, GPU renderer, Rust UI |
| Go | Goose | Apache-2.0 | Block |
| Ai | Aider | Apache-2.0 | |
| Ct | Continue | Apache-2.0 | **Discontinued** — see §9 |
| Cr | Crush | FSL-1.1-MIT | |
| Ki | Kilo | MIT | |
| Ro | Roo Code | Apache-2.0 | **ARCHIVED** — see §9 |
| PA | Prime Agent | MIT | Prime Intellect |
| Px | Plandex | MIT | **Dormant** — see §9 |
| Cu | Cursor | proprietary | |
| Dv | Devin | proprietary | Cognition |
| Cp | GitHub Copilot CLI / agent mode | proprietary | GitHub |
| Ws | Windsurf | proprietary | **Acquired by Cognition**, rebranded Devin Desktop 2026-06-02 |
| Am | Amp | proprietary | Sourcegraph |
| Hc | HeyClicky | proprietary, all-rights-reserved | **Not a coding agent** — see §0.4 |

---

## §0. Method, and four things that changed my conclusions

### §0.1 What I did with ox

I did not take any prior ox claim on trust. I ran the tool enumeration, the CLI help, the doctor, a live sandbox network probe, the hook test suite, and module inspection, and every ox cell below cites one of those. The full command log is **§10**. Where an earlier ox doc in this repo disagrees with what I measured, §10 says so and I believe the measurement.

### §0.2 The ox baseline moved a lot since the existing docs were written

`docs/comparison.md` was written against an earlier ox. Two of its claims are now wrong and are corrected here:

| Prior claim in `docs/comparison.md` | Measured 2026-10-02 |
|---|---|
| "Kernel sandboxing (✗) … Codex wins this row today" (§4) | **Wrong.** `--sandbox strict` compiles a Seatbelt `(deny network*)` that I verified is kernel-enforced. See §1.5 and §10.4. The same doc's §1 row 22 already said ✓ — it contradicted itself. **RESOLVED 2026-10-02:** `docs/comparison.md` §4, §2.1, §1.1 and the §4 sequencing table were corrected; the `✓` at row 22 was the accurate cell. |
| 19→16 tool schemas, "1.5MB src", 8 provider targets | **19 tool schemas**, `du -sh src/` = **1.9M**, **9** providers behind 13 bot presets, 43,174 lines. |

### §0.3 Where I refused to fill a cell

The brief asked for a HeyClicky licence/IP row. **There is nothing to describe.** Details in §0.4. Separately, I have left a large number of `?` cells in the proprietary columns (Cu, Dv, Cp, Ws, Am) for a specific reason: these vendors document *features* but not *mechanisms*, and a matrix that reports "sandbox: Y" for Devin on the strength of a marketing page is worse than one that reports "container isolation, mechanism documented; host-runtime isolation explicitly disclaimed upstream". I have graded the mechanism where it is documented and `?` where it is not.

### §0.4 HeyClicky: the brief's attribution does not survive checking

The task brief stated HeyClicky's maker was associated with a named proprietary
character, icon, and sound set. I checked this against first-party sources.
**That claim does not hold.**

| Brief's claim | What heyclicky.com and GitHub actually show (fetched 2026-10-02) |
|---|---|
| Maker is "Louis Raillé" | Site signs itself **"\|farza, founder"**. The open-source Clicky lineage README says *"Hi there! I'm Farza, the guy that made Clicky."* Founder is **Farza Majeed** (ex-Buildspace; third-party trackers list YC S26). No occurrence of "Louis Raillé" in any first-party source. |
| Rights held by an individual | Site footer: **"© Humansongs, Inc. 2026"** — a corporation, not a person. |
| A named proprietary character exists | The mascot is an **ASCII-art face** (`^ ω ^`, `{ ^-^ }`). No separately named character appears in any first-party source. |
| A `LICENSE-ASSETS.md` governs it | **It does not exist.** `github.com/heyclicky` is an org with, verbatim, *"This organization has no public repositories."* The product is a closed-source `.dmg` download. |

**Consequences, applied as licence constraints in the tables below:**

1. HeyClicky's name, mascot art, iconography, and sounds are **© Humansongs, Inc. 2026, all rights reserved, and there is no public licence file**. They are **not adoptable by ox or by anyone else.** Nothing in this document should be read as suggesting otherwise.
2. I have **not** reproduced the mascot art. Referring to it descriptively is not the same as copying it.
3. **UNVERIFIED / NOT FOUND** is the correct mark for the brief's four claims. I have not silently dropped them — they are recorded here so the correction is auditable, and flagged to the coordinator on the board.

What HeyClicky actually is (first-party, verified): a native **macOS** app, Sonoma 14.2+, "an ai buddy that lives on your mac", mac-only with a Windows waitlist. Hotkey-triggered screen awareness with the explicit promise *"we never look at your screen unless you press the hotkey"* and *"screenshots are never stored"*; on-device dictation; it draws on the screen to point at things; and it runs background "agents" metered per month. Free / **pro $20/mo** (150 agent msgs) / **max $100/mo** (1,000 agent msgs). GPT Realtime 2 based. 5,000+ users is its own claim. **It writes into coding tools; it is not one.** Its row is graded "—" on coding-agent axes and `Y` on the desktop/voice axes where it genuinely leads.

---

## §1. FUNCTION

Split into five themed tables because 24 columns × 50 rows is unreadable as one grid.

### §1.1 Models, providers, network

| Capability | **ox** | OC | He | oc | CC | CX | GC | Zd | OH | Cl | Wp | Go | Ai | Ct | Cr | Ki | Ro | PA | Px | Cu | Dv | Cp | Ws | Am | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Provider count (verified) | **9**^1^ | ? | ? | ? | 1 | ? | ? | ? | ? | ? | ? | any^12^ | LiteLLM^13^ | ? | ? | ? | many^14^ | ? | ? | SWE-1.6+frontier^15^ | ? | ? | ? | GPT-Realtime^2^ |
| BYOK | **Y**^1^ | ? | Y | Y | Y | Y | Y | Y | Y | Y | ? | Y | Y | Y | Y | Y | ? | Y^14^ | ? | ? | Y | ? | Y | **N** (bundled) |
| Bot/preset shortcuts | **Y** 13^2^ | ? | ? | ? | N | N | N | N | ? | ? | ? | ? | N | ? | ? | ? | N | N | ? | ? | ? | ? | N | N |
| Local models (Ollama) | **Y** 4 backends^3^ | ? | P (64k floor)^15^ | P | P | P | P | P | P | P | ? | Y | P | ? | ? | P | ? | P^14^ | ? | ? | P | ? | ? | ? | N |
| LM Studio / llama.cpp / vLLM discovery | **Y** 4 origins^3^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Built-in web search | **Y** `web_search`^4^ | ? | ? | ? | Y | ? | Y^16^ | ? | Y | ? | Y^16^ | ? | ? | ? | ? | ? | ? | ? | ? | Y (research)^16^ | ? | Y^16^ | ? | ? | N |
| Built-in web fetch | **Y** `web_fetch`^4^ | ? | ? | ? | Y | ? | Y | ? | Y | ? | ? | ? | ? | ? | ? | ? | ? | ? | Y | ? | Y | ? | ? | N |
| MCP client | **Y** stdio+HTTP^17^ | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | Y^12^ | N | Y | Y | Y | Y | ? | ? | Y | ? | Y | Y | ? | N |
| MCP template registry | **Y** 21 templates^17^ | ? | N | N | Y | Y | Y (manifest) | ? | ? | ? | ? | 70+ ext^12^ | N | ? | ? | ? | ? | pkg install^14^ | ? | ? | Y | ? | Y | ? | N |
| Executable / code-capable skills | **N** | ? | ? | ? | P | ? | ? | ? | P (plugin) | ? | ? | P (recipes) | N | ? | ? | ? | ? | **Y**^14^ | ? | ? | P | ? | ? | P^14^ | N |
| Plugin/SDK distribution unit | **N** | ? | ? | ? | **Y** `.claude-plugin` | ? | Y (manifest) | Y (ext) | Y (ext repo) | Y | ? | Y | N | ? | ? | ? | ? | **Y**^14^ | ? | Y (marketplace) | Y (playbooks) | Y (ext) | ? | N |

^1^ `listToolSchemas`/`BOTS` import → 13 bots, 9 providers: xai, anthropic, openai, gemini, groq, deepseek, ollama, openrouter, backboard (§10.1, §10.3).
^2^ `ox --help`: `ox bots`, `/bot [name]`; §10.5.
^3^ `ox local` live: Ollama 0.35.0 @ :11434 with tinyllama:1.1b (608 MB) + qwen2.5:0.5b (379 MB), and the gate *"not approved — ox will not send anything here"*. `LOCAL_ORIGINS` covers 11434 Ollama, 8080 llama.cpp, 8000 vLLM, 1234 LM Studio. §10.2, §10.6.
^4^ `listToolSchemas({})` returns `web_search`, `web_fetch` (§10.1). **These are new since `docs/COMPETITIVE.md` was written — COMPETITIVE.md gap #4 is now closed.**
^12^ Goose: *"every tool it uses is an MCP extension"*, 70+ extensions, Apache-2.0, Rust + desktop app.
^13^ Aider routes through LiteLLM (docs/comparison.md §1 note, project-owned docs).
^14^ Prime Agent README: provider list spans Anthropic, OpenAI, Prime Inference, Azure OpenAI, DeepSeek, Gemini, Vertex, Bedrock, Mistral, Groq, Cerebras, Cloudflare AI Gateway + Workers AI, xAI, OpenRouter, Vercel AI Gateway, ZAI, OpenCode Zen. Also `prime-agent package install npm:@foo/prime-agent-tools@1.2.3` — version-pinned package distribution.
^15^ Hermes hard `MINIMUM_CONTEXT_LENGTH = 64_000` (cited in COMPETITIVE.md §3).
^16^ Gemini CLI / Warp / Copilot built-in search per COMPETITIVE.md §2 gap #4. Copilot's is the `research` agent.

### §1.2 Agents, orchestration, continuity

**Re-graded 2026-10-03.** This section used to carry the document's most important negative finding — that ox's agent-to-agent mailbox was "a data structure with no sender", and that daemon continuity was unproven. Both are now wrong; the corrections are recorded below rather than quietly edited. **Second pass, 2026-10-04: parallelism moved too, and so did heartbeats.** Fan-out is real (`P` at §1.2, `CONCURRENTLY_BATCHABLE` + a 3-way scheduler), and `ox heartbeat` is routed and works, so that row is `Y` rather than `P`. **What is still weak here is steering mid-flight**, which no subagent change touched. The residue is §8.1 (steering and isolation, not fan-out) and §8.4's cancelled `ox heartbeat` defect.

| Capability | **ox** | OC | He | oc | CC | CX | GC | Zd | OH | Cl | Wp | Go | Ai | Ct | Cr | Ki | Ro | PA | Px | Cu | Dv | Cp | Ws | Am | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Subagents | **Y**^1^ | ? | Y | Y | **Y** | Y | ? | Y (`spawn_agent`) | ? | ? | ? | ? | N | ? | Y | ? | **Y** `rlm.spawn` | ? | Y (8 parallel)^18^ | **Y** managed Devins^19^ | Y (`/fleet`) | ? | Y (`oracle`) | agents^20^ |
| **Subagent parallelism** | **P** — 3 concurrent, ceiling 8; no steering^1^ | ? | ? | ? | Y (agent teams) | ? | ? | Y (threads) | ? | ? | ? | ? | N | ? | ? | ? | **Y** (parallel + background)^14^ | ? | Y (8, isolated worktrees)^18^ | Y (each own VM)^19^ | Y (dependency waves) | ? | ? | N |
| Agent-to-agent messaging | **Y** `agent_message.send` / `agent_observe`^2^ | ? | Y (Channels) | ? | **Y** (agent teams) | ? | ? | Y (threads) | ? | ? | ? | ? | N | ? | ? | ? | **Y** (direct, "without routing everything through the user")^14^ | ? | ? | **Y** (message child sessions)^19^ | ? | ? | N |
| Daemon continuity (survives terminal death) | **Y** — started, doctored and shut down clean this session^2^ | ? | Y | ? | Y (Remote Control) | ? | ? | Y | ? | ? | ? | ? | N | ? | ? | ? | **Y**^14^ | ? | Y (background remote) | Y (cloud VM) | ? | Y | Y (cloud) |
| Heartbeats | **Y** — `/heartbeat` **and** `ox heartbeat start\|list\|stop` both work^2^ | Y (cron) | Y (built-in cron)^15^ | ? | Y (`/loop`, Monitor) | Y (scheduled tasks) | ? | ? | Y (automation repo) | ? | ? | ? | N | ? | ? | ? | **Y**^14^ | ? | Y (cron + self-message) | Y (automations) | Y (schedules)^19^ | Y | N |
| Persistent goals | **Y** `/goal` — survives compaction + resume, progress must be proven^2^ | ? | Y | ? | Y | Y | ? | ? | ? | ? | ? | ? | N | ? | ? | ? | **Y**^14^ | ? | Y (MEMORIES.md) | Y | ? | Y | ? | N |
| Bounded autonomous mode | **Y** `ox auto` (80 iters, forced --verify, gates)^1^ | Y | Y | ? | Y | Y | ? | ? | Y | ? | Y (`/plan` contrast) | Y | N | ? | ? | ? | **Y**^14^ | ? | Y | Y | ? | Y | N |
| Quality gates | **Y** shell gates in contract^1^ | ? | ? | ? | P (hooks) | Y (tests) | ? | ? | Y (eval) | ? | ? | ? | N | ? | ? | ? | P (verifiers) | ? | Y (CI) | Y (playbooks) | Y | ? | N |
| Multi-agent visibility | **Y** `/agents` live tree^1^ | ? | ? | ? | Y | Y | ? | Y (Threads sidebar) | ? | ? | ? | ? | ? | ? | ? | ? | ? | Y | Y (monitor children) | ? | Y | N |

^1^ **Subagent parallelism — `N` → `P`, re-graded 2026-10-04. The previous `N` rested on a prompt clause that has since been deleted, and this footnote is corrected rather than quietly rewritten.** That clause told the model delegation was one subagent at a time and that a same-turn batch of two was rejected; it was the *runtime* proof this footnote leaned on, and **it no longer exists**. In its place the prompt carries `SUBAGENT_PARALLEL_CLAUSE` (`src/system-prompt.js:124`), emitted at `system-prompt.js:293`. What the model is told now — interpolated from the constants it describes rather than hardcoded, so the prompt cannot claim a cap the scheduler does not enforce:

> *"Independent subagent calls may be emitted together in one turn and run CONCURRENTLY, up to 3 at a time (config `subagent.maxParallel` or `$OX_SUBAGENT_CONCURRENCY`, ceiling 8); calls past the cap wait for a free slot and still run this turn. The subagent tool is still approval-gated (one decision covers the whole batch) and still may not be mixed with other tools, so a subagent batch is delegation alone."*

The runtime behind that text, all read from source: `CONCURRENTLY_BATCHABLE = new Set(['subagent'])` (`resource-class.js:71`) is the predicate that lets a gated tool batch **with itself**, and `batchPlan` (`resource-class.js:131-147`) returns `mode:'concurrent'` for a same-tool batch — so the `BATCH_REJECT_APPROVAL` refusal that used to throw the whole turn away no longer applies to it. `DEFAULT_SUBAGENT_CONCURRENCY = 3` and `MAX_SUBAGENT_CONCURRENCY = 8` (`resource-class.js:96,98`) are the numbers the clause prints, enforced by `runSubagentBatch` (`agent.js:2249`), which resolves **one** approval for the batch (`agent.js:2252`), admits `min(size, cap)` and defers the remainder to free slots instead of refusing them (`agent.js:2257-2259`), and announces `"3 of 5 running concurrently (cap 3), 2 deferred"` as a progress note (`agent.js:2307`). Verified by running it, not by reading: `resolveSubagentConcurrency` returns `3` unset, `5` for `subagent.maxParallel: 5`, and **clamps `99` to `8`**; `node --test test/parallel-subagents.test.js` = **17/17 pass**, including a drift canary (`test/parallel-subagents.test.js:989-1011`) that fails if the clause ever claims something the runtime does not do, and `:1032` asserts every factual claim in the clause is true.

**`P`, not `Y`, and the residue is steering (§8.1) and isolation (§8.7), not fan-out.** Three at a time is a real improvement on one-at-a-time and is still short of Cursor's 8 isolated worktrees (`^18^`), Devin's per-child VMs (`^19^`) and Copilot's dependency waves. **The `subagent-registry.js` comment this footnote used to quote verbatim has also changed**: its "still runs exactly one subagent at a time" wording is now past tense and names the scheduler as built (`subagent-registry.js:522-529`), so it is a design note re-read against reality, not a statement of current behaviour. Its "no engine for `agent-teams.js`" half was already stale and is handled at §1.2^2^.

^2^ **Six capabilities re-verified, and five of them have moved since 2026-10-03.** Messaging, daemon continuity and persistent goals were re-measured live on 2026-10-03; **heartbeats and subagent parallelism were re-graded on 2026-10-04** (^1^, §10.31–§10.32); **and the `ox serve` HTTP surface was re-graded on 2026-10-04 by a reviewer who did not write it** (^1^, §10.36) — five routes, a `BOTS`-generated `/v1/models`, a working `/v1/responses`, and a refusal to bind a non-loopback address without `OX_SERVE_API_KEY`. Full command log in §10.20–§10.26; `node --test` on `daemon`, `prompt-layering`, `persistent-goal`, `agent-messaging`, `refine` = **97/97 pass**, and `schedule` + `schedule-regressions` = **17/17 pass**.

- **Agent-to-agent messaging — `Y`, and the previous `N` was this document's worst error.** `agent_message.send` / `agent_observe` are dispatched at `src/tools/index.js:629` behind a real handler (`ctx.agentTeamsHandler`), not described. Four properties, all read from source and all tested: **(a)** the recipient is *never* taken from a tool argument — it is resolved from `ctx` (`agent-teams.js:92`: *"recipient is NEVER taken from tool arguments… merely screened: there is no argument through which a different identity could"* be addressed), so a model cannot address a mailbox that is not its own; **(b)** delivery is **at-most-once** by a durable monotonic per-mailbox cursor persisted in `teams.json`, and a message is returned iff `seq > cursor`; **(c)** writes go through the *same* `screenPersistText` from `src/memory.js` that memory uses, with a matching read-side screen; **(d)** it works subagent↔parent and subagent↔subagent. The `# AGENT MESSAGING` prompt layer (459 B, static) is emitted only when a mailbox handler is installed. Prime Agent's row stays `Y` — it has had this since launch; ox has now caught up, it did not lead.
- **Daemon continuity — `P` → `Y`, verified end to end rather than inferred.** I started it (`ox daemon started pid 11244 · socket …/daemon/c.sock`), confirmed detached state, ran `ox daemon doctor` (**healthy**: dir `0700` owned by uid 501, socket `0600`, pidfile matched, orphan check clean), read `ox daemon log`, then `ox shutdown` and confirmed `state: stopped` with **exit 1** when stopped — matching its own documented contract. The instance-id design is real: the id travels in the socket's `hello` frame and the pidfile is `(pid, instanceId)`, so a **recycled PID is not mistaken for ours** (`daemon.js:303` rejects a pidfile with no usable `pid + instanceId`; `daemon.js:328` refuses to clear on `instance-mismatch`). **One correction to the "one worker per session" framing:** the supervisor spawns one worker *process* per session but caps concurrency at `MAX_WORKERS = 16` by default (`OX_DAEMON_MAX_WORKERS`), so it is per-session fan-out under a cap, not an unbounded one-worker-per-session guarantee.
- **Heartbeats — `P` → `Y`, re-graded 2026-10-04. The defect I recorded here on 2026-10-03 is fixed and the `P` is withdrawn.** This bullet previously reported that `ox heartbeat start|list|stop` did not run because `'heartbeat'` was absent from the `SUBCOMMANDS` set (`src/cli.js:190`), producing `ox: unknown command 'heartbeat'`. **That is no longer true.** `'heartbeat'` **is** in `SUBCOMMANDS` (`src/cli.js:197`) and reaches `case 'heartbeat':` (`src/cli.js:3374`). Run it:
  ```
  $ ox heartbeat list
  heartbeats (0)
    none — ox heartbeat start [--every 5m] [--max-runs 3]
    daemon NOT opted in — nothing fires until `ox schedule opt-in`
  ```
  Both `ox heartbeat` and `ox heartbeat list` exit **0** and print their real usage/state. Note what the output preserves: the two independent gates are still there, so "routed and working" does **not** mean "fires by default" — nothing fires until daemon-wide `opt-in` **and** per-row `enabled`. `/heartbeat` remains the REPL path and keeps its `maxRuns` default of 3 and its refusal to arm without an active goal. The row is `Y`: the command exists, is reachable, and is correctly bounded. `COMPETITIVE.md` §2.2 carried the same defect and is corrected there.
- **Persistent goals — `Y`, and the evidence rule is the interesting part.** A goal is persisted as a `{t:'goal'}` event in the **existing append-only transcript** (`src/goal.js:13`) and read back by `loadSessionWithStatus` — so it survives compaction and `--resume` with no new storage. Progress must be *proven*, and the exclusions are the point: assistant prose is never evidence (`goal.js:310`: `if (!ev || ev.kind === 'text') continue; // prose is never proof`), and read-only calls are excluded wholesale — `READ_ONLY_EVIDENCE = read_file, list_dir, glob, grep, todo_write, todo_read` (`goal.js:72`) — with `todo_write` excluded *because its own result echoes the checklist*, so a model cannot mark its own homework. `/goal done` refuses and **names** each unproven item, and a completed goal is terminal: `goal.js:208` returns *"goal is COMPLETE and does not resume"*. Prime Agent's row was `Y` (MEMORIES.md) and stays the reference point; ox's mechanism is stricter, not broader.

^18^ Cursor: *"Up to 8 parallel subagents work in isolated worktrees with recursive nesting"* (morphllm.com comparison, Feb 2026).
^19^ Devin Advanced Capabilities (docs.devin.ai): orchestrate managed Devins in parallel, each in its own isolated VM; message child sessions; **monitor ACU consumption per child**; analyze session outcomes; create/improve playbooks; manage schedules. Cognition also ships **Fusion** (cognition.com/blog/local-fusion, 2026-09-11): a frontier *lead* agent paired in parallel with a cheaper *sidekick*, exchanging only briefs/results/feedback, 39% cheaper than the frontier model alone.
^20^ HeyClicky runs background "agents" for the user, but they are not developer-visible subagents and not steerable by the user; graded `P` on the row, `—` on the coding-agent rows.

### §1.3 Memory and context

| Capability | **ox** | OC | He | oc | CC | CX | GC | Zd | OH | Cl | Wp | Go | Ai | Ct | Cr | Ki | Ro | PA | Px | Cu | Dv | Cp | Ws | Am | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Memory depth (modules) | **7 modules / 2,964 lines**^1^ | ? | frozen block | ? | Y | Y (AGENTS.md) | ? | Y | ? | ? | Y (per-segment) | ? | N | N | ? | ? | Y (Continual Harness) | Y | Y (MEMORIES.md) | Y (playbooks) | Y | ? | basic summaries |
| Obsidian-compatible memory | **N** | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Notebook / executable memory | **N** | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Transcript search | **Y** BM25 + negation^1^ | ? | Y (FTS5) | ? | Y | Y | ? | Y | Y | ? | Y | ? | ? | ? | ? | ? | ? | ? | Y | Y | Y | Y | ? | N |
| Skill synthesis from experience | **P** `self-improve` reflection + pattern extraction^1^ | ? | Y | ? | P | P | ? | ? | ? | ? | ? | N | ? | ? | ? | ? | **Y** (`/refine`, skill creator)^14^ | Y | Y (derives playbooks)^19^ | Y | ? | ? | N |
| Transcript format | **JSONL, append-only**^1^ | ? | SQLite `state.db` | ? | JSONL | JSONL | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | cloud |
| Context compaction | **Y** `/compact`^1^ | ? | Y | Y | Y | Y | ? | Y (dedicated model) | ? | ? | Y | ? | ? | Y | ? | ? | Y (auto) | Y | Y | Y | Y (95%, background) | ? | ? | N |
| **Automatic** compaction | **Y** `compactAt` knob + per-run cap^1^ | ? | ? | ? | Y | Y | ? | Y (90%) | ? | ? | ? | ? | ? | ? | ? | ? | **Y** (advertised) | ? | ? | Y (95% bg) | ? | ? | N |
| Context breakdown | **Y** `/context`, `--context`^1^ | ? | ? | ? | P | ? | ? | Y (auditable entry) | ? | ? | Y (per segment) | ? | ? | ? | ? | ? | ? | ? | Y | ? | **Y** `/context` | ? | ? | N |
| Prompt cache stability (static prefix vs volatile tail) | **Y** `buildPromptLayers()` + `ox prompt`^2^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | P (sliced in code)^14^ | ? | ? | ? | ? | ? | ? |
| Honest cost/usage reporting | **Y** ledger + `/cost` + `--max-cost`^1^ | ? | P | ? | P (quota opacity) | ? | ? | ? | ? | ? | ? | Y (per-msg) | ? | ? | ? | ? | ? | ? | Y | ? | Y | ? | ? | quota-based |

^2^ **Prompt layering — new row, verified 2026-10-03.** `buildPromptLayers()` (`src/system-prompt.js:211`) returns the prompt as an ordered list of layers each classified `static | session | dynamic`, and `buildSystemPrompt()` is exactly those layers joined — so the layers *are* the bytes, not a description of them. `ox prompt` dumps the breakdown (layer/kind/bytes/~tokens/hash) plus the prefix/tail totals; `--breakdown` prints the table alone, bare `ox prompt` prints the table and then the full assembled text; `--json` emits `cacheablePrefixBytes`, `stablePrefixBytes`, `totalBytes` and the per-layer array.

Measured on this repo, live (`ox prompt`, 2026-10-03): **9 layers — 4 static, 3 session, 2 dynamic.** `static prefix 1831 B` (guaranteed cacheable) + `stable prefix 16335 B` (static+session, fixed for the run) + `volatile tail 124 B`, of `TOTAL 16459 B`; the volatile tail is the `clock` layer and nothing else moves.

On the before/after: **the two numbers in circulation are not a like-for-like pair, and I will not present them as one.** `test/prompt-layering.test.js:15` records the pre-layering measurement on a pinned-clock fixture — *"42 of 1962 bytes were ever cacheable"*, because the assembled text carried `- date: <ISO ms>` at **offset 42**. The 1831 B figure is today's real repo, whose total prompt is 16459 B (33 discovered skills, a workspace tree). The improvement is real and the mechanism is identical — the clock moved out of the prefix — but **1831/42 = 43× compares two different prompt bodies**, so quote it as *"the cacheable prefix went from 42 bytes to the whole static block"*, not as a 43× speedup.

Nobody else in this survey documents a prefix/volatile split. Prime Agent's `P` is not a loss claim — its README describes prompt-as-a-variable sliced in code^14^, which is a different axis, and I have no sourced statement about its cache behaviour.

^1^ §10.1–§10.9. Memory modules: `memory.js` 1645, `procedural-memory.js` 343, `memory-learn.js` 260, `hierarchical-memory.js` 219, `memory-loss.js` 199, `knowledge-graph.js` 178, `arch-memory.js` 120 = 2,964 lines (§10.7). Transcript search is a real BM25 (`session-index.js:160-192`, with `-term` negation), not substring matching. Auto-compaction is wired via `compactionKnobs(config)` → `{compactAt, keepTurns}` at `agent.js:1007` plus `COMPACTION_MAX_PER_RUN` (§10.7).

**Obsidian-compatible memory and notebook/executable memory are `N` for ox and `?` for everyone.** I checked: the only "Obsidian" string in this entire repo is a competitor mention in a doc table (`docs/multimodal-architecture.md:94`), and the string "notebook" does not appear in `src/` at all. I am not going to manufacture a row where the whole column is `?`.

### §1.4 Skills, hooks, sandbox, money, integration

| Capability | **ox** | OC | He | oc | CC | CX | GC | Zd | OH | Cl | Wp | Go | Ai | Ct | Cr | Ki | Ro | PA | Px | Cu | Dv | Cp | Ws | Am | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hooks | **Y — all 6 declared events fire**^1^ | ? | Y | ? | Y (27 events) | Y | ? | ? | ? | ? | ? | ? | N | ? | ? | ? | ? | ? | Y (partial; documented non-firing) | Y | Y | Y | ? | N |
| **Do all declared events fire?** | **Y** — verified^1^ | ? | ? | ? | Y | Y | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | P (vendor documents which don't) | ? | ? | ? | ? | — |
| Custom bots | **Y** `ox agent save/use`^1^ | ? | ? | Y | N | ? | ? | Y (profiles) | ? | ? | ? | Y (multi-model) | ? | Y | ? | ? | Y (`/login`) | ? | Y (profiles) | Y (presets) | Y | Y | N |
| Trust levels | **Y** 5 named levels^1^ | ? | ? | Y (permissions) | ? | Y (retired `untrusted`) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Approval gates | **Y** TTY + IPC + `--yolo` | ? | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | Y | Y | Y | Y | Y | N |
| **Out-of-band approval** | **Y** — Unix-socket IPC, *silence ⇒ decline*^1^ | ? | Y (Channels) | ? | Y (Remote Control) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Sandbox | **P** opt-in, default `off`^1^ | ? | ~ | N | P (rules+classifier) | **Y** OS-enforced | Y (`--sandbox`) | ? | **Y** Docker | P | ? | ? | N | N | N | P | N (see §6) | ? | P (worktrees) | Y (cloud VM) | ? | P | ? | N |
| Network egress control | **P** — deny kernel-enforced; allow-list userspace only^1^ | ? | ? | ? | Y (domain-gated) | Y (off by default) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Cost ledger | **Y** | ? | P | ? | P | ? | ? | ? | ? | ? | ? | Y | ? | ? | ? | ? | ? | Y | ? | Y | ? | ? | quota |
| **Hard** cost cap | **Y** `--max-cost` fail-closed^1^ | ? | N | ? | N (subscription) | Y (quotas) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N (soft)^19^ | ? | Y | ? | ? | plan quota |
| Unpriced model handling | **Y** aborts before spend^1^ | ? | N (silent fallback) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | — | — |
| Pricing override | **Y** `model_overrides` | ? | ? | ? | N | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | — | — |
| Fallback policy | **Y** never silent^1^ | ? | N (silent)^15^ | Y | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | Y | ? | ? | ? | ? | — | — |
| Credential/secret screening on memory | **Y** read+write, visible withholding^1^ | ? | N | N | N | N | N | N | N | N | N | N | N | N | N | N | N | ? | N | ? | ? | ? | N | N |
| IDE extension | **N** (deliberate) | N | N | N | Y | ? | Y | Y | Y | **Y** | Y | Y | Y | Y | N | Y | Y | ? | Y | Y | Y | Y | Y | N |
| ACP | **P** server only, *not in the ACP Registry*^1^ | ? | Y | Y | Y (adapter) | Y (community) | Y | Y (host) | ? | Y | ? | Y | ? | ? | ? | ? | ? | ? | ? | ? | Y | Y | Y | N |
| OpenAI-compatible server | **P** 5 routes (`/health`, `/v1/models`, `/v1/models/:id`, `/v1/chat/completions`, `/v1/responses`), streaming + blocking, bearer auth, **refuses an unauthenticated non-loopback bind**; Responses API is core-text only^1^ | ? | Y (API server) | Y | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Voice | **P** 9 MCP tools + 3 adapters, no native TUI path^1^ | ? | Y (multi-channel) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | **Y** (core product) |
| Desktop / operator tools | **Y** 7 tools, approval-gated^1^ | Y (core) | ? | ? | ? | ? | ? | Y | ? | ? | Y (app) | ? | ? | ? | ? | ? | ? | Y | Y (desktop app) | ? | Y (Devin Desktop) | ? | **Y** (mouse/screen) |
| Telemetry | **N** — no outbound analytics^1^ | ? | P | P | P | P | ? | **Y** (anonymized agent metrics, stated on zed.dev/acp pages) | Y (PostHog) | ? | ? | ? | ? | ? | ? | ? | ? | ? | Y | Y | Y | Y | Y | account/telemetry |

^1^ §10 throughout. Specific ox details worth stating plainly:

- **Hooks:** `HOOK_EVENTS` = `PreToolUse, PostToolUse, PreLLM, PostLLM, SessionStart, SessionStop` (`src/hooks.js:67-74`). My first grep for `fireHooks('PreLLM'` returned **nothing** — the four lifecycle events go through a `fireLifecycle()` wrapper. I was wrong and corrected it: all six do have call sites (`agent.js:1090, 1344, 1381, 1780, 1836, 1982, 2008, 2102`), and `node --test test/hook-events.test.js` passes **15/15**, including *"src/ has a call site for all six declared events"*. Hooks are **fail-open** (timeout/error ⇒ allow) and the source says so: *"Not a security control."*
- **Sandbox:** `SANDBOX_PRESETS` = `off, workspace, read-only, strict`. Default is **`off`** — a plain `ox` run spawns unsandboxed. `strict` sets `restrict_network: true`. I verified enforcement live, isolated from the login shell: under `(deny network*)`, `curl https://example.com` → `HTTP=000`, exit 6; unsandboxed, the same curl → `HTTP=200`, exit 0. **The deny is kernel-enforced.** The *allow*-list is userspace-only (host allow-list matched against normalised host), because macOS `sandbox-exec` refuses to compile `(allow network-outbound (remote ip …))` — *"host must be * or localhost in network address"*. **And the agent process itself is never confined.** This is the single most important limitation in the document; §7 and §8 both rest on it.
- **Cost:** `PRICING` has 10 priced families; unknown price ⇒ `budgetStopMessage` refuses to spend against a cap it cannot measure rather than assuming zero; `model_overrides` per model or `OX_MODEL_OVERRIDE` env.
- **serve: RE-GRADED 2026-10-04 by an independent reviewer, and the old cell was factually wrong by the time anyone read it.** `ROUTES` (`src/serve.js:791-797`) declares `GET /health`, `GET /v1/models`, `GET /v1/models/:id`, `POST /v1/chat/completions`, `POST /v1/responses`, with **405** for a known path and the wrong verb and **404** `unknown_url` otherwise (`serve.js:813-827`). All five were curled live against a loopback server (§10.36): `/health` → `{"status":"ok","timestamp":"2026-10-04T17:06:48.834Z"}`; `/v1/models` → 12 entries carrying `ox.provider/model/available/requires_key`; `/v1/models/ox-claude` → one entry with `available:false`; `/v1/models/nope` → **404** `model_not_found`; `POST /v1/responses` → a real `object:"response"` with `output[0].content[0].text` and `output_text` from a live Ollama turn; `POST /v1/chat/completions` → `object:"chat.completion"`, `choices[0].message.content` `"ok"`. **The catalogue is generated from `BOTS` in `src/bots.js` (`serve.js:196-237`), not hand-typed**: with no keys in the environment `ox.servable_now` was **1** (`ox-ollama`), and re-running with `ANTHROPIC_API_KEY` set moved it to **4** with `ox-claude.available:true` — `available` is *read from the environment*, not asserted. A bot with no default model is **withheld, not dropped**: `ox-openrouter` (`model: null`) appears in `ox.withheld` as `reason:"no_default_model"`, and `GET /v1/models/ox-openrouter` answers 404 that names the reason instead of calling it a typo. **Every error body is `{"error":{message,type,param,code}}` with a non-200 status** (`serve.js:69-71`), confirmed live on 400/401/404/405. **Auth:** with `OX_SERVE_API_KEY` set, **all five routes return 401** unauthenticated, a wrong bearer returns 401, `Bearer testkey123` returns 200, and the comparison is constant-time over SHA-256 digests (`serve.js:80-84`). **Network exposure — the security-relevant part, and it holds:** `startServer` **refuses to bind a non-loopback address when `OX_SERVE_API_KEY` is unset, before `listen()` is ever reached** (`serve.js:832-836`; policy and the three-way rule in `authExposure` `:139-177`). Verified by running the binary, not by reading the diff: `ox serve --host 0.0.0.0 --port 8123` → **exit 1** with the refusal naming all three fixes, `grep -c listening` → **0**, and `lsof -nP -iTCP:8123 -sTCP:LISTEN` → **nothing: the port is never opened**. With the key set the same wide bind listens normally (`*:8128 (LISTEN)`); with `OX_SERVE_ALLOW_UNAUTHENTICATED=1` it listens and warns twice as loudly; with the key unset on loopback it starts and prints the no-credentials warning. **The default host is loopback** in both `startServer` (`serve.js:832`) and the CLI (`cli.js:2922`) — `ox serve --port 8129` bound `127.0.0.1:8129`, not `0.0.0.0`. **The grade stays `P`, but the stated limit changes** — the old reason ("only two endpoints") is closed. What remains: `/v1/responses` implements the **core text shape only**. `store`, `previous_response_id`, `conversation`, `background`, client-supplied `tools`, non-`auto` `tool_choice`, and `include` each return a **400 naming the field** (`serve.js:477-491,640-651`; verified live: `store:true` → 400 `param:"store"`, `tools:[{…}]` → 400 `param:"tools"`), and there are no response store/get/list/delete endpoints. A second residual, which the source states itself (`serve.js:392-396`): `/v1/chat/completions` still passes an unresolvable model string through to the raw target instead of 404ing, so *that* endpoint can still come back an empty 200 for a typo — `/v1/responses` does not have the gap.
- **Telemetry:** `grep -rn "telemetry\|analytics\|posthog\|segment\|sentry" src/*.js package.json` returns only one *comment* (`agent.js:2172`, "telemetry must never break the agent loop") and doc prose. **No telemetry code path exists.** Note the honest contrast: Zed publishes per-agent weekly session counts on its ACP pages, and OpenHands' own AGENTS.md documents a `telemetry-analytics` skill covering PostHog, consent, and Cloud funnel observability. ox is the only system in this survey with no outbound analytics *at all*, and several systems are the opposite of that.
- **ACP:** `src/acp.js` exports `ACP_SERVER_INFO, AcpSession, createAcpClient, createAcpServer, startAcpServer`; `ox acp server` runs. But Zed's ACP Registry is curated and its documented roster is Claude Agent, Codex, Gemini CLI, OpenCode, Copilot, Cursor, Pi, Poolside, Cline, Goose, Auggie. **ox is not in it.** Registration is the missing step, not the implementation — and JetBrains AI Assistant 2026.2 supports the same `acp.json` `agent_servers` shape, so a single registration reaches both Zed and JetBrains.
- **Voice:** `src/voice-mode.js` is an MCP-backed subsystem (`VoiceSession`, `createVoiceMode`), driven by the `voice` MCP template — not a built-in microphone path in the REPL. Graded `P`, and it is a genuine loss to HeyClicky, which is a voice product.

---

## §2. ARCHITECTURE

| Axis | **ox** | PA | OH | Go | CC | CX | oc | Ai | Cr | Wp | Zd | Cu | Dv | Am | Cp | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Language | JavaScript (Node ≥18) | TypeScript + Rust crates | Python + TS | Rust + TS | ? (binary) | Rust | TypeScript (Bun) | Python | Go | Rust | Rust | ? | ? | ? | ? | Swift (inferred from native .dmg) |
| Runtime deps | **0** — `dependencies:{}`, `devDependencies:{}` | Node + Python (ipykernel) + Rust | Python + Docker | Rust toolchain | ~232MB Bun binary^1^ | 0 npm (Rust static) | Bun | LiteLLM + deps | Go | GPU stack | Rust | Electron | cloud | ? | Node | none (native) |
| Install footprint | **1.9M `src/`**^2^ | crates + npm + Python | Docker image | Rust binary | ~232MB^1^ | MB-scale^1^ | MB | MB | MB | large | large | large | cloud | ? | MB | ~dmg |
| Model tool surface | **19** schemas, **narrowed per turn** (observed "9 of 23")^2^ | **1** — a persistent IPython kernel^14^ | many | ? | ? | ? | ? | N (no shell autonomy) | ? | ? | ? | ? | ? | ? | ? |
| Capability unit | **tool** (skills are markdown, not executable) | **code** — skills are Python packages^14^ | tool + plugin | **MCP extension** — everything^12^ | tool + skill + hook + agent + plugin | tool | tool + skill + agent | tool | tool | ? | agent | ? | ? | ? | agent | — |
| Execution model | in-process agent loop, `await`ed subagents^2^ | persistent kernel, programmatic tool calls | client-server over REST into a container | local, extension-driven | in-process | in-process | client/server | in-process | in-process | block + GPU | editor-hosted | local + cloud | cloud VM | ? | ? | — |
| Process model | **in-process by default; optional supervisor + detached workers** (`ox daemon`, `--detach`) | daemon-backed, reattachable^14^ | container per session | single process | in-process | in-process | server + client | in-process | in-process | terminal process | editor process | local agent + cloud agent | cloud | ? | ? | — |
| Prompt assembly | assembled from probed ground truth, rebuilt after tool narrowing^2^ | prompt-as-a-variable, sliced in code^14^ | ? | ? | ? | AGENTS.md | AGENTS.md | repo map (tree-sitter) | ? | per-segment^16^ | ? | ? | ? | ? | — |
| File-size discipline | no enforced cap; `src/agent.js` and `src/cli.js` are the giants, and `src/agent.js.bak` is a **stray backup file still inside `src/`**^2^ | ? | monorepo split across 4 repos (AGENTS.md) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | — |

^1^ COMPETITIVE.md §2 note 1. ^2^ §10.11, §10.12.

**The architecture row ox loses outright: capability unit.** Prime Agent's single-tool design (one persistent IPython kernel; file ops, shell, subagents and context management all happen *through code*) is a genuinely different and, for long-horizon work, better bet than ox's 19 fixed JSON schemas. Prime's own launch page argues the case on its own terms — *"results come back as data, not chat"* — and reports 30.2% → 95.5% on ARC-AGI-3 with identical weights (vendor claim, unverified by me). Goose's inversion is the other extreme and is also principled: **every** capability is an MCP extension, so there is no built-in/tool split at all. ox sits in the middle with the largest explicit tool surface of the open harnesses and no code-execution escape hatch, which is simultaneously its safety property and its ceiling.

---

## §3. ACCESSIBILITY

**This section is where the whole industry is weak, and the honest finding is a shared one.**

| Axis | **ox** | oc | CC | CX | Zd | Cr | Ai | PA | Cu | Ws | Dv | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Platforms | macOS, Linux (Node ≥18)^2^ | ? | ? | ? | macOS/Linux/Windows | ? | ? | **macOS/Linux only**^14^ | ? | ? | cloud | **macOS only** (Sonoma 14.2+) |
| Install method | `npm i -g` / clone + `node bin/ox.js`, no build step | ? | binary | binary | app | binary | pip | one-liner `install.sh` (SHA-256 verified)^14^ | download | download | SaaS | `.dmg` download |
| Account required | **N** | ? | Y (Claude) | Y (ChatGPT) or key | N | N | N | N (`/login` optional)^14^ | Y | Y | Y | **Y** |
| Offline / local operation | **Y** — local Ollama, zero accounts, zero network required to start | ? | N | N | P | ? | Y (key) | P | N | N | N | N (cloud models) |
| `NO_COLOR` honoured | **Y** — verified, no escapes emitted^2^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N/A (GUI) |
| Non-TTY behaviour | **Y** — verified; static banner, no animation, no dashboard^2^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N/A |
| Keyboard-only | **Y** — REPL + `--plain` fallback for `ipc watch`; approval keys `a`/`d`/`s`/`q` | ? | ? | ? | Y (Zed is keyboard-first) | ? | ? | ? | ? | ? | ? | hotkey-first |
| Command discoverability | **Y** — `ox --help` enumerates every subcommand and slash command; `/help` in-REPL | ? | Y | Y | Y | Y | Y | Y (docs/) | ? | ? | ? | N (no window) |
| Error message quality | **Y** — see below | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Docs coverage | **P** — extensive in-repo docs (19 files) but no published site | **Y** (docs site) | **Y** | **Y** | **Y** | Y | Y | **Y** | Y | Y | Y | P (FAQ only) |
| First-run experience | **Y** — `ox doctor` enumerates env, per-provider key status, local servers, MCP, skills, memory dir, sandbox backend^2^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N |
| Low-contrast terminals | **P** — `NO_COLOR`/`OX_NO_ANIM` degrade, but dim styling is used in normal output | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | N/A |

**ox's error quality, quoted from what I actually ran** (`ox -p "hi"` with an empty `HOME`):

```
· tool offer narrowed to 9 of 23 for this turn
· stream dropped (Missing API key for xai: set XAI_API_KEY (no silent fallback)) — retry 1/3
· stream dropped (Missing API key for xai: set XAI_API_KEY (no silent fallback)) — retry 2/3
· stream dropped (Missing API key for xai: set XAI_API_KEY (no silent fallback)) — retry 3/3
✗ stream died after 3 retries: Missing API key for xai: set XAI_API_KEY (no silent fallback)
```

That is the behaviour the rest of this document is arguing for: it **names the variable**, it says **"no silent fallback"** in the error text itself, and it refuses three times rather than quietly trying the next provider.

**Screen-reader viability in a TUI — assessed honestly, and the answer is bad for everyone including ox.**

ox is a line-oriented REPL, not an alt-screen TUI, which makes it *relatively* the best case in this survey — a screen reader gets a linear stream of appended text with no redraw, no cursor addressing, no region loss. That is a real structural advantage and I will not pretend otherwise. But:

- **The shared failure is documented and citable.** opencode issue **#39368**, *"Accessibility: add screen-reader-friendly TUI mode"*: *"The TUI uses the alternate screen buffer, so the terminal emulator's own scrollback is empty during a session. NVDA's object navigator and review cursor can only see what is currently painted, not the chat history above. There is no scrollback, no_alt_screen, or linear_mode option."*
- **The root cause is structural, not a bug in any one agent.** TermUI issue **#121** proposes `role`/`label`/`live`/`columnHeaders` metadata because *"there is no equivalent of HTML's aria-label, aria-role, or aria-live for terminal output"*, and concludes *"No other TypeScript terminal UI framework (Ink, blessed) addresses this gap today."*
- **The terminal layer itself fights screen readers.** `microsoft/terminal`'s own a11y doc: *"NVDA is unable to handle too many text changed events, which Conhost and Windows Terminal are both culprits of"*, plus a Screen Reader Backpressure Control proposal because *"Windows Terminal sends too may text changed events at once, causing NVDA to hang."*

**So the honest grade is:** ox `P` — materially better than any alt-screen TUI here (Crush, opencode, Prime Agent, Zed) because its output is linear, but *not* accessible. ox has no screen-reader mode, no semantic annotations, no braille support, and no accessibility documentation at all. **Any claim that ox "supports screen readers" would be false.** The one thing that would genuinely help is documenting the linear-mode behaviour, and that is a docs task, not a code task.

**Low-contrast terminals is a real ox `P`.** ox uses dim styling in ordinary output (`context.js:975`, `headless.js:179` both gate on `isTTY && !NO_COLOR`), so `NO_COLOR` is the mitigation, but a user on a low-contrast theme with colour still on gets faint text. Crush and Zed, being full TUI apps with user-selectable themes, have more surface to fix this properly.

---

## §4. USABILITY

| Axis | **ox** | CC | CX | oc | Cr | Ai | PA | Cu | Dv | Cp | Ws | Am | Hc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Time to first token | **Y** — sub-second; 1.9M src, 0 deps, no build | N (232MB Bun) | P (MB binary) | N (Bun) | P | P | P | N | N (cloud) | P | N | N |
| Works with zero API key | **Y** — local Ollama; `ox doctor` reports `✓ ollama: no API key needed`^2^ | N | Y (ChatGPT login) | P | P | P | Y (`/login` optional)^14^ | N | Y (free tier) | Y | N | N |
| REPL quality | P (line-oriented, no full-screen) | P | Y (full-screen TUI) | Y | **Y** (Bubble Tea) | N (not a REPL) | Y (pi-based TUI) | Y | N (Slack/web) | P | Y | N (voice) |
| Progress visibility | P | Y | Y | Y | Y | P | Y | Y | Y | Y | Y | Y | P |
| Multi-agent visibility | **P** — `/agents` live tree + `ox agents` running/idle/saved, with bounded parallel batches (default 3, ceiling 8); no mid-flight steering or isolated worktrees^1^ | Y | Y | Y | P | N | Y | Y | Y | Y | Y | P | N |
| Approval UX | **Y** — TTY prompt, `--yolo`, `--strict-approvals`, 5 trust levels, IPC, silence⇒decline^2^ | Y | Y | Y | Y | P | ? | Y | P | Y | Y | ? | N |
| Failure recovery | **P** — 3 retries with the same honest error; `--rewind`, `/fork`, `--resume`; corrupt transcripts warn and continue rather than hard-fail | P | P | P | P | P | ? | P | P | P | P | ? | N |
| Resume UX | **Y** — `--resume <id\|path>`, `-c`, `ox sessions resume <prefix>`, `/rewind`, `/fork`; `--no-replay` on attach^2^ | Y | Y | Y | Y | P | Y (reattach)^14^ | Y | Y | Y | Y | Y | N |
| Config burden | **Y** — works with zero config; `~/.ox/config.json` + `./.ox/hooks.json` override | P | P | P | P | P (`.aider.conf.yml`) | P | N (settings UI) | N | N | N | N | N |
| Upgrade path | P (git/npm; no signed releases, no changelog discipline) | Y (auto-update) | Y | Y | Y | P | Y (SHA-256 verified installer) | Y | Y | Y | Y | Y (in-app) |

**ox wins time-to-first-token, zero-key operation, config burden, and approval UX outright.** It loses REPL polish to Crush/opencode/Prime Agent and multi-agent visibility to everyone, both consequences of the same §1.2 finding.

---

## §5. SKILLS

| Axis | **ox** | CC | He | PA | Go | CX | oc | Cr | Ct | Ki | Ro | Cu | Am |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Skill format | `SKILL.md` + frontmatter (Agent Skills native) | `SKILL.md` (co-authored the standard) | `SKILL.md` | **executable Python packages**^14^ | recipe YAML | ? | ? | ? | ? | ? | ? | ? | ? |
| Discovery paths | **4** — `~/.agents/skills`, `./.agents/skills`, `~/.claude/skills`, `./.claude/skills`^2^ | ? | ? | `~/.prime/agent/skills/` | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Reads other ecosystems' dialects | **Y** — `.claude/skills` + `AGENTS.md` + `CLAUDE.md` + `.mcp.json` verbatim; **33 skills discovered live** from `~/.claude/skills`^2^ | P | P | Y (AGENTS.md) | Y (.goosehints) | Y (AGENTS.md) | Y (AGENTS.md) | ? | ? | ? | ? | ? | ? |
| Versioning | **P** — timestamped snapshots, pin/unpin, restore, purge; **no semantic version field**^2^ | ? | ? | **Y** — `prime-agent package install npm:…@1.2.3`, git tag/commit^14^ | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Distribution / marketplace | N (deliberate) | **Y** marketplaces | ? | Y (npm/git/https/ssh) | Y (70+ ext) | ? | ? | ? | ? | ? | ? | Y | Y |
| **Security scan on install** | **Y** — denylist scan refuses unless `--force`; receipt in `~/.ox/skills-install.log`^2^ | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Token cost | P — index injected, bodies on demand | P | P | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Skill vs tool | **Skills are documentation, not executable** — a strict and load-bearing separation | P | P | **skills ARE code**^14^ | extension | ? | ? | ? | ? | ? | ? | ? | ? |
| Authoring UX | **Y** — `ox skill new [--project|--force]`; `ox skill add <dir>` or `owner/repo[/path]`; `ox skill curate --dry-run`; `adopt`/`pin`/`restore`/`purge`^2^ | Y | Y (`/learn`) | Y (skill creator) | Y | ? | ? | ? | ? | ? | ? | Y | Y |
| Synthesis from experience | **P** — `/refine` (evidence-gated, 4 categories) + `ox self-improve run\|status`; **still writes no new skill**^2^ | P | Y | **Y** (`/refine`) | ? | P | ? | ? | ? | ? | ? | ? | ? |

**ox's honest skill story:** authoring and lifecycle are strong and better than most (`curate`/`pin`/`restore`/`purge`/`adopt` is a real lifecycle most rivals lack), the **install-time denylist scan is a genuine differentiator nobody else in this survey documents**, and interoperability is a genuine win (it read 33 real skills out of `~/.claude/skills` on first run).

**`/refine` landed, and it is worth being precise about what it is** (verified 2026-10-03, `ox refine --help` + `test/refine.test.js`). It is evidence-backed harness refinement with snapshots and `/refine undo`, over **exactly four target categories and no free-form path**: `supplemental-prompt` (max 1 line / 200 chars), `memory` (240), `skill-description` (300), `subagent-spec` (300). The gate is the same bar as `ox episode promote` — **≥1 lesson AND (score ≥ 6 OR verified)** — and `score`/`verified` are read from the **proposal's reviewer judgement, never from the proposal text**, so a model cannot vote itself past the gate.

**Structural immutability is the more interesting property.** `ox refine --help` lists seven never-refinable targets — `base-system-prompt`, `sandbox-profile`, `trust-level`, `approval-policy`, `cost-cap`, `api-key`, `harness-source` — and the test file closes with *"the base system prompt is byte-identical after everything above"*, so the immutability is asserted on bytes, not on intent. Seven tampered forms are refused.

**The row stays `P`, and I will not inflate it.** `/refine` edits a skill's *description*; it does not author a skill file. So the two losses that were true before are now one: **ox still has no skill versioning and no synthesis that writes a skill.** Prime Agent keeps both — `@1.2.3` pinned package install, and `/refine` that turns experience into a new skill. On the *evidence discipline* ox is arguably ahead of everyone including Prime Agent, because Prime's `/refine` is documented by its README and I have no sourced statement about its gate or its immutability set (**UNVERIFIED**). And ox's install scan remains a *denylist* — a floor, not a proof: it catches known-bad shapes, not novel payloads.

---

## §6. SAFETY & RELIABILITY

### §6.1 Sandbox enforcement level

| System | Level | Documented? |
|---|---|---|
| **ox** | **Kernel-enforced DENY, userspace ALLOW-LIST, agent process unconfined** | Y, and stated bluntly in the source |
| CX Codex CLI | OS-enforced, network off by default | Y (COMPETITIVE.md §2 gap #1) |
| OH OpenHands | Docker container (default runtime) — real isolation | Y, with an explicit local-mode disclaimer |
| CC Claude Code | Seatbelt (macOS) / seccomp+bwrap (Linux), domain-gated network | Y (COMPETITIVE.md §2.1) |
| PA Prime Agent | **Explicitly NOT a sandbox** | Y, verbatim |
| Dv Devin | Cloud VM per session | P (vendor page) |
| GC Gemini CLI | `--sandbox` | P |
| oc, Cr, Ai, Go, Px, Hc | N / ? | — |

**Two verbatim vendor disclaimers belong in this document**, because "what the vendor explicitly disclaims" is a row the task asked for and it is the most honest signal available:

> **Prime Agent README:** *"Prime Agent executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; **they are not a security sandbox.** Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment."*

> **OpenHands `runtime/README.md`:** *"Important: this runtime provides no isolation as it runs directly on the host machine. All actions are executed with the same permissions as the user running OpenHands. For secure execution with proper isolation, use the Docker Runtime instead."*

ox's own disclaimer is the same genre and worth quoting for symmetry — `src/hooks.js:56`: hooks *"can block only by succeeding with exit code 2; they can never block by failing… **Not a security control.**"* Three of the four projects in this table that are honest about their limits are honest in the same way. That is a better signal than a green checkmark.

### §6.2 Credential and secret handling

**ox is the only system in this survey that screens credentials on the way *into* and *out of* persistent memory.** `screenPersistText()` (`memory.js:169`) refuses credential-shaped content before writing `.agent/MEMORY.md`, which is re-injected into **every** prompt — and the screening applies on read as well as write, with *visible withholding* rather than silent drop. The prompt-injection side of the same screen is what makes ox's self-improvement loop safe to run at all.

The contrast is not subtle. `ox ipc` redacts secret-shaped keys from metric payloads via a single `isSecretKey()` predicate (`src/ipc.js:101`, pattern at `ipc.js:95`, allow-list at `ipc.js:79-87`). **This paragraph used to carry a live defect record, and the claim is now withdrawn:** the regex used `_?` inside its alternatives while the boundary classes accept `-`, so `API-KEY` and `x-api-key` were **not** redacted. The inner alternatives are now `[-_]?`, and running the predicate confirms the fix end to end — `API-KEY`, `x-api-key`, `access-token`, `apiKey` and `Authorization` all return `true`, while `max_cost_usd`, `model` and `prompt_tokens` return `false`. I am recording the correction because "ox is best in class" is a row that has to be able to carry a bug report, and this one no longer applies.

For everyone else: `N` or `?`. Nothing else in this survey screens memory writes, and Hermes's failures (#5563, #92996, #100788 SQLite corruption; #12877 capturing failed procedures as skills; #97942 and #68144 silent spend) are the cautionary column.

### §6.3 Spend protection

| System | Hard cap | Unpriced model | Documented failure |
|---|---|---|---|
| **ox** | **Y** `--max-cost`, fail-closed | **Aborts before spending** | — |
| CX | Y (quotas) | ? | retired its `untrusted` policy rather than accepting it silently |
| Cp | Y (quotas) | ? | — |
| Dv | N — *"a soft block (you can re-enable if needed)"* | ? | ACU model makes forecasting *"genuinely hard"*; heavy users report $300-500/mo drift |
| He | N | **N** — silent fallback | #7559/#45782 ($145 surprise), #97942 ($4.12 across 46.9M tokens) |
| CC | N (subscription) | ? | quota opacity, #64171 silent edits |

ox's specific behaviour is worth stating because it is unusual: an unpriced model under a cap produces `budget-stop (unknown-cost)` and the run **stops** — *"ox refuses to spend against a cap it cannot measure."* It does not assume zero, and it does not proceed and hope.

### §6.4 State corruption risk

ox is **append-only JSONL** for sessions and the memory journal. A torn tail line truncates with a warning and is non-fatal, and the transcript is greppable with stock tools. Against a documented cluster of SQLite `state.db` corruption reports in Hermes (#5563, #92996, #100788) and an FTS5 index undermined by the same, this is a real architectural advantage.

**ox's own residual risks, stated rather than hidden:**
- `~/.ox/` is one flat directory holding config, sessions, skills-install log, daemon socket, agents, tasks. A single bad `config.json` degrades more than it should.
- `src/agent.js.bak` was a **stray backup file sitting inside `src/`** (§10.12). It was not imported, but it was thousands of lines of dead weight inside the tree whose size is an explicit selling point. **RESOLVED 2026-10-02:** verified to contain no symbol, import, or logic absent from the current `src/agent.js` (its `runToolOnly` refactored to `executeReadOnlyTool`), then deleted.
- ~~The `ipc` redaction defect above.~~ **RESOLVED 2026-10-04** — `[-_]?` fix verified by running `isSecretKey` (§6.2). No longer a residual risk.
- `ox models --help` prints a column of `undefined` — a real defect in a discoverability surface.

### §6.5 Known failure modes with citations

| System | Issue | Failure |
|---|---|---|
| He | #5563, #92996, #100788 | SQLite `state.db` corruption |
| He | #7559, #45782 | silent paid fallback, $145 surprise |
| He | #97942 | $4.12 across 46.9M tokens on silent fallbacks |
| He | #68144 | 5× cost escalation on re-login |
| He | #31600 | hard `MINIMUM_CONTEXT_LENGTH = 64_000` startup rejection |
| He | #12877 | captures failed procedures as skills regardless of outcome |
| CC | #64171 | silent Edit failures |
| oc | **#39368** | no screen-reader-friendly TUI mode; alt-screen buffer empties scrollback |
| TermUI | **#121** | no `aria-label`/`role`/`live` equivalent for terminal output |
| Wt | — | Crush executes repo-supplied `crushrc` at load time = code execution on clone (COMPETITIVE.md §4) |
| Ai | — | Aider skips pre-commit hooks by default (`--no-verify`) (COMPETITIVE.md §4) |
| Dv | — | `git diff HEAD` on handoff *"can include uncommitted secrets"*; prompt uploaded to a cloud session (COMPETITIVE.md §4) |

---

## §7. WHERE OX WINS — with evidence

1. **Install and start.** `dependencies:{}`, `devDependencies:{}`; `du -sh src/` = **1.9M**; 43,174 lines. No Bun, no Docker, no Python, no Rust toolchain, no build step. Every competitor in §2 pays a toolchain tax. (§10.11, §10.12)
2. **Credential and injection screening on persistence, both directions, with visible withholding.** Nothing else in the survey documents this. It is what makes ox's self-improvement loop safe to enable at all. (`memory.js:169` `screenPersistText`)
3. **Fail-closed spend.** `--max-cost` is a hard stop; an unpriced model under a cap **aborts before any request**; unknown prices report `null`, never `0`. Only Codex and Copilot have hard caps, and neither refuses on an unpriced model. (§10.5, §10.9)
4. **Honest error text as a product feature.** `Missing API key for xai: set XAI_API_KEY (no silent fallback)`, three times, then a hard stop. The guarantee is *in the error string*. (§10.10)
5. **Install-time skill security scanning.** Denylist scan on `ox skill add`, refuses unless `--force`, receipt appended to `~/.ox/skills-install.log`. Undocumented anywhere else in this survey.
6. **Append-only JSONL transcripts.** Non-fatal torn tail, greppable with stock tools, versus a documented SQLite corruption cluster. (§6.4)
7. **Out-of-band approval with a fail-safe default.** Unix-socket IPC where silence, timeout, disconnect, and "no client attached" **all decline**. `test/e2e.test.js` still passes *"declined bash approval in non-TTY headless run exits 2"* with the bridge up and no client attached. This is the only external approval path in the survey with a documented fail-safe.
8. **No telemetry code path at all.** Not opt-out — absent. Zed publishes per-agent session counts; OpenHands ships a PostHog telemetry skill; ox has a comment and no code.
9. **Zero-dependency interoperability.** It read **33 skills** out of `~/.claude/skills` on first run and speaks `.mcp.json`, `AGENTS.md` and `CLAUDE.md` natively. That is distribution without a marketing budget. (§10.5, §10.9)
10. **Honest negative engineering — and it has now been acted on.** `subagent-registry.js` used to document exactly what a parallel scheduler would need and to admit the current design had none. A scheduler now exists (`agent.js:2249`), and the note has been re-read against what is built: items 1, 2, 3 and 5 are marked **DONE**, and item 4 (a per-agent cancellation path) is still marked open (`subagent-registry.js:531-566`). A design note that admits it was superseded — rather than being quietly deleted — is a stronger signal of a maintained codebase than a green matrix row.
11. **Local models as a first-class class.** Four discovery origins, a 30s probe memo, and an explicit per-endpoint approval gate (*"not approved — ox will not send anything here"*) rather than a silent `localhost` default. (§10.2, §10.6)
12. **41+ subcommands and ~90 slash commands, all discoverable from `ox --help`** with no website to visit. (§10.5)
13. **Cache-stable prompt layering, with the measurement exposed as a command.** `buildPromptLayers()` returns the prompt as classified `static | session | dynamic` layers and `buildSystemPrompt()` is exactly those layers joined, so the layers *are* the bytes. Measured live on this repo: **1831 B static prefix guaranteed cacheable, 16335 B stable prefix, 124 B volatile tail** out of 16459 B. `ox prompt` prints the per-layer table and the prefix/tail totals with **no model call** — the single most useful new diagnostic in the harness, and the honest answer to "why did my input tokens triple". The layering moved the clock out of the cacheable prefix (`test/prompt-layering.test.js`). See §1.3^2^ for why the widely-quoted "42 B → 1831 B, 43×" is not a like-for-like pair.
14. **Goals that must be proven, not asserted.** Assistant prose is never evidence, read-only calls are excluded, and `todo_write` is excluded *because its result echoes the checklist* — the one tool that could most easily fake completion is the one tool refused as proof. `/goal done` names what is unproven instead of accepting the claim. (§1.2^2^)

---

## §8. WHERE OX LOSES — honestly, with evidence

1. **Subagent parallelism and mid-flight steering. Downgraded from a flat loss to a partial: parallelism is no longer a loss, steering still is.** Re-graded 2026-10-04. **Parallelism: `N` → `P`, and this is a real move, not a re-label.** Independent `subagent` calls in one turn now run **CONCURRENTLY, 3 at a time by default, hard ceiling 8** (`resource-class.js:96,98`), scheduled by `runSubagentBatch` (`agent.js:2249`) with one approval per batch (`agent.js:2252`) and overflow **deferred to a free slot rather than refused** (`agent.js:2257-2259`); `batchPlan` returns `mode:'concurrent'` for a same-tool batch (`resource-class.js:131-147`); the prompt states this instead of forbidding it (`system-prompt.js:124,293`); `test/parallel-subagents.test.js` is **17/17**. "Investigate five things at once" now works — 3 running, 2 queued into the same turn.
   **What is still behind the field:** 3 shared-filesystem subagents against Cursor's **8 in isolated worktrees** (`^18^`), Devin's **per-child VMs** (`^19^`) and Copilot's **dependency waves**; and ox has no isolation, so two concurrent subagents writing one file is still last-one-wins (`COMPETITIVE.md` #7, `§8.7`).
   **Steering: still `N`, and this half of the loss stands unchanged.** I searched for a mechanism to redirect, cancel, or inject into a running subagent and **there is none**. No cancel/stop/kill entry point exists anywhere in `src/` or `test/`. `finishSubagent` is the only exit and it is idempotent, so a scheduler can *retire* an agent — which is what `runSubagentBatch` does for a budget-stopped or aborted one — but **there is still no `abort` reason distinct from `failed`, so an aborted agent reports as failed** (`subagent-registry.js:554-558`, its own open item 4, "a per-agent cancellation path… still partly open"). **Mail is not steering**, and I checked this specifically because the word appears in the code: `resource-class.js:29-30` says it outright — *"nothing pulls a message into another agent's context until that agent itself calls `agent_observe`. A note left in a mailbox steers nobody."* `subagent.js:568` uses "steered" loosely to mean mailbox *reachability* from inside a subagent, which is a different property and not a steering mechanism.
   **Messaging remains no longer part of this loss** — see the resolved item below. **Net: the honest remaining gap is steering and isolation, not fan-out.** ox is no longer one-subagent-at-a-time, and this document should stop saying it is. Prime Agent's `rlm.spawn(...)` fans out *and* backgrounds; Claude Code has agent teams.
2. ~~**Agent-to-agent messaging. Loss.**~~ **RESOLVED 2026-10-03 — this row was wrong and is now `Y`.** The old claim (*"the mailbox has no sender — `createAgentTeams` is imported only by `platform.js`, never by the agent loop"*) described the code before this session's imports and does not describe it now: `agent_message.send` / `agent_observe` are dispatched at `tools/index.js:629` behind a real handler, the recipient is resolved from `ctx` and never from an argument, delivery is at-most-once by a durable per-mailbox cursor, and writes pass the same `screenPersistText` gate as memory. Prime Agent still has the stronger *end-to-end* story (its agents *"orchestrate one another"*), so this is **parity on the capability, not a win** — but the `N` was an error and is withdrawn.
3. **Not in the ACP Registry.** The implementation exists (`ox acp server`) and JetBrains 2026.2 and Zed both consume the same `agent_servers` shape — but the curated roster is Claude Agent, Codex, Gemini CLI, OpenCode, Copilot, Cursor, Pi, Poolside, Cline, Goose, Auggie. **ox is not on it.** This is a registration away from reaching two major editors, and it is the cheapest unclosed gap in the document.
4. ~~**Daemon continuity is unproven.**~~ **RESOLVED 2026-10-03 — now `Y`, verified by running it.** Started the supervisor detached, confirmed running state with pid + instance id, ran `ox daemon doctor` (**healthy**: `0700` dir, `0600` socket, pidfile matched, no orphans), read its log, then `ox shutdown` → clean stop, and confirmed **exit 1** when stopped. The `P` existed only because the daemon was not running when I first looked; the honest way to settle it was to start it.
4b. ~~**NEW — `ox heartbeat start|list|stop` does not run, while `ox --help` and `ox daemon --help` both advertise it.**~~ **RESOLVED 2026-10-04 — it runs. This item is struck from the losses list.** The claim was that `'heartbeat'` was missing from `SUBCOMMANDS` and rejected by the dispatcher before its handler. **It is present** (`src/cli.js:197`) and reaches `case 'heartbeat':` (`src/cli.js:3374`); `ox heartbeat` and `ox heartbeat list` both exit **0** and print real usage and state (§1.2^2^, §10.32). The one-line `SUBCOMMANDS` fix this item asked for is no longer outstanding, so §11.2b is closed too. `/heartbeat` remains bounded (`maxRuns` default 3, refuses without an active goal), and the output confirms the two gates still hold — `daemon NOT opted in — nothing fires until ox schedule opt-in` — so the row moves `P` → `Y` rather than to `Y` by waving at help text.
5. ~~**`ox serve` is not OpenAI-compatible.** `/health` + `/v1/chat/completions`, nothing else. No `/v1/models`, no `/v1/responses`. opencode and Hermes ship real API servers.~~ **WITHDRAWN 2026-10-04 — the claim does not describe the code, and it is struck.** Re-graded independently (§10.36): `serve.js:791-797` serves **five** routes including `/v1/models` (generated from the real `BOTS` registry, withheld bots reported) and `/v1/responses`; all five were curled live, all five return **401** behind `OX_SERVE_API_KEY`, and every error body is the OpenAI `{error:{message,type,param,code}}` shape. **The specific assertions here — "no `/v1/models`, no `/v1/responses`" — were false.** **What survives is narrower and is no longer a head-to-head loss against opencode:** `/v1/responses` is the core text shape only (no store, conversations, background, or client tools — each a 400 naming the field), and `/v1/chat/completions` still accepts an unresolvable model string instead of rejecting it. Neither of those is "not OpenAI-compatible".
6. **The agent process is never confined.** Seatbelt/bwrap wrap *child processes*. A plugin, a dependency, or an in-process tool call is unconstrained. §6.1.
7. **The network allow-list is userspace-only.** Deny is kernel-enforced; allow is a host match inside `networkEgressVerdict`. A spawned `curl` is either fully denied or fully allowed — never host-scoped. macOS `sandbox-exec` physically cannot express it (*"host must be * or localhost"*).
8. **The default sandbox profile is `off`.** A plain `ox` run spawns unsandboxed. The capability exists; it is not the default.
9. **No skill versioning, no skill synthesis that writes skills.** Prime Agent has `@1.2.3` pinned install and `/refine`.
10. **TUI polish.** Crush's Bubble Tea interface and Prime Agent's pi-based TUI are simply better. ox optimises for scriptability first, and the scriptability is real, but this is still a loss.
11. **Screen-reader accessibility is not achieved.** Better than any alt-screen TUI here because output is linear — but there is no screen-reader mode, no semantic annotations, no braille support, and no accessibility documentation. **Any stronger claim would be false.**
12. **No Obsidian-compatible and no notebook/executable memory.** Both `N`, and the field is largely `?` too, so this is a shared blank rather than a head-to-head loss.
13. **No IDE extension** — deliberate, and defensible given ACP, but Cline, Roo, Kilo, Continue, Cursor, Windsurf, Zed, Warp and Gemini CLI all have one.
14. ~~**`ipc` secret redaction is defective** for hyphenated keys (`API-KEY`, `x-api-key`).~~ **WITHDRAWN 2026-10-04 — fixed; verified by running the predicate, not by reading the diff.** `SECRET_KEY_RE` (`src/ipc.js:95`) now uses `[-_]?` inside its multiword alternatives instead of `_?`, and `ipc.js:90-94` carries a comment recording that the underscore-only separator let hyphenated spellings normalise to a shape the pattern could not match. Executed against `isSecretKey`: `API-KEY` → `true`, `x-api-key` → `true`, `access-token` → `true`, `apiKey` → `true`, `Authorization` → `true`; and the `SAFE_METRIC_KEYS` allow-list still holds — `max_cost_usd`, `model`, `prompt_tokens` → `false`. Struck from the losses list.
15. **Repository hygiene.** `src/agent.js.bak` is a stray backup file inside the source tree whose size is an explicit selling point.
16. **`ox models --help` prints `undefined` ten times.** A discoverability surface that is broken.
17. **Upgrade path is informal.** No signed releases, no changelog discipline.
18. **Against Prime Agent specifically, the gap has narrowed a lot and the shape of it has changed.** Re-graded 2026-10-03: ox is now at **genuine parity on messaging, daemon continuity, heartbeats/schedules and persistent goals** — four of the rows that made this the document's weakest section — because Prime has shipped those since launch and ox has now caught up. **Re-graded again 2026-10-04: one of those two axes is now closed.** ox fans out — 3 concurrent subagents, ceiling 8, overflow deferred rather than refused — so Prime's `rlm.spawn(...)` no longer has a monopoly on parallel delegation, though it still fans out *and backgrounds* while ox's batch is bounded by the cap and the gate. **Steering mid-flight is the one axis that is still entirely open on ox's side**, and nothing can redirect, cancel, or inject into a running subagent (§8.1). Prime also keeps a real architectural lead on **capability unit** (§2): skills are executable Python packages through a persistent kernel, against ox's 19 fixed JSON schemas and markdown skills. So: **on the §1.2 orchestration block the contest is now roughly even, and it is decided by §2 and by the parallelism row, not by messaging or continuity.** ox's counter remains safety and zero-dependency; Prime's remains capability.

---

## §9. RETIRED / DORMANT

Star counts as of 2026-10-01. **Star totals do not track activity** — the top of the adoption table is not where live work is concentrated.

| Project | Stars | Licence | Status | Evidence |
|---|---|---|---|---|
| **Roo Code** | 24.3k | Apache-2.0 | **ARCHIVED** | GitHub `archived: true`; last push 2026-05-15 |
| **Continue** | 36.1k | Apache-2.0 | **"no longer actively maintained, read-only"** | Verbatim from its own README |
| **Aider** | 49.3k | Apache-2.0 | **Maintenance mode** | Last push 2026-05-22 |
| **Plandex** | 15.7k | MIT | **Dormant** | Last push 2025-10-03 — ~12 months stale |
| OpenClaw | 391.1k | MIT-file (`NOASSERTION`) | Active — **personal-assistant framework, not a coding agent** | Highest stars in the survey, and categorically out of scope for a coding-agent matrix. Its `NOASSERTION` is a GitHub API artefact, not a licence judgement; the repo ships an MIT file. |
| Prime Agent | 21.5k | MIT | Active, launched 2026-08-05 | Youngest entry; 4,911 commits in ~3 months |

**Two canonical 2024–25 OSS agents are archived or explicitly discontinued; two more are dormant.** Four of the top twenty by stars are not being worked on. Any competitive analysis that treats the star table as an activity table is reading it wrong.

---

## §10. ox verification log — every command run this session

Each ox cell in this document traces to one of these. Nothing in the ox columns comes from a prior document.

| # | Command | Result |
|---|---|---|
| 10.1 | `node --input-type=module -e "import {listToolSchemas}…"` | **19 tools**: open_app, open_url, open_path, open_window, type_text, screenshot, notify, web_fetch, web_search, critique, read_file, write_file, edit_file, list_dir, glob, grep, bash, todo_write, subagent |
| 10.2 | `ox local` | Ollama 0.35.0 @ localhost:11434; tinyllama:1.1b 608 MB, qwen2.5:0.5b 379 MB; **"not approved — ox will not send anything here"** |
| 10.3 | `import {BOTS} from './src/bots.js'` | 13 bots, 9 providers (xai, anthropic, openai, gemini, groq, deepseek, ollama, openrouter, backboard) |
| 10.4 | `sandbox-exec -f p.sb curl …` | sandboxed: `HTTP=000` exit 6 · unsandboxed: `HTTP=200` exit 0 → **deny is kernel-enforced** |
| 10.5 | `ox --help` (full) | 41+ subcommands incl. `daemon`, `agents`, `attach`, `schedule`, `ipc`, `serve`, `acp`, `import`; skill lifecycle (`curate`/`pin`/`restore`/`adopt`/`purge`); install-time denylist scan + receipt log |
| 10.6 | `node -e "LOCAL_ORIGINS"` | 4 origins: 11434 Ollama, 8080 llama.cpp, 8000 vLLM, 1234 LM Studio |
| 10.7 | `wc -l` on memory modules; `grep` on sandbox/subagent/session-index/serve | 2,964 memory lines; 4 sandbox presets (default `off`); `subagent-registry.js` seam note (line ref has since moved to `:522-569`); `session-index.js:160-192` BM25; `serve.js:160-162` two endpoints only — **SUPERSEDED 2026-10-04: true when logged, false since. `serve.js:791-797` now declares five routes (10.36)** |
| 10.8 | `ox daemon status`, `ox agents` | `state: stopped — no daemon pidfile`; running 0 / idle 0. **Re-run at 22:11 after the daemon-continuity sibling merged (`src/daemon*.js`, `src/cli.js`, `src/headless.js`, `test/daemon.test.js`): still stopped, commands fully wired into `cli.js:42-43` and the SUBCOMMANDS set at `cli.js:141`. The §1.2 `P` grade therefore still stands after the merge.** |
| 10.9 | `ox doctor` | node 22.22.3 ✓; `✓ ollama: no API key needed`; per-provider key status; `✓ skills discovered: 33`; MCP 0 |
| 10.10 | `ox -p "hi"` with empty `HOME` | 3 × `Missing API key for xai: set XAI_API_KEY (no silent fallback)`, then hard stop; `tool offer narrowed to 9 of 23` |
| 10.11 | `package.json` | `dependencies:{}`, `devDependencies:{}`, MIT, `engines.node>=18`; 43,174 lines across `src/`; 92 `test/*.test.js` files |
| 10.12 | `du -sh src/`, `ls src/*.js \| wc -l` | **1.9M**, 103 top-level modules — **includes a stray `src/agent.js.bak`** |
| 10.13 | `node --test test/hook-events.test.js` | **15/15 pass**, incl. *"src/ has a call site for all six declared events"* |
| 10.14 | `NO_COLOR=1 ox --help` | no escape sequences emitted |
| 10.15 | `grep -rn "telemetry\|analytics\|posthog\|segment\|sentry" src/` | one comment (`agent.js:2172`), no code |
| 10.16 | `node -e "SANDBOX_PRESETS"` + `resolveSandbox({flag})` | `["off","workspace","read-only","strict"]`; default `off`; `strict → restrict_network:true` |
| 10.17 | `MCP_TEMPLATES` | 21 templates; `mcp.js` implements stdio + http |
| 10.18 | `webfetch https://www.heyclicky.com/` | founder "farza"; `© Humansongs, Inc. 2026`; macOS-only; pricing; no separately named hardware controller |
| 10.19 | `webfetch https://github.com/heyclicky` | *"This organization has no public repositories."* → no `LICENSE-ASSETS.md` exists |
| 10.20 | `ox --help` (full, re-run 2026-10-03) | `daemon continuity:` block confirmed: `daemon start/status/stop/doctor/log`, `agents [--json] [--limit n]`, `attach <id> [--no-replay]`, `shutdown [--force]`, `-p --detach`, `schedule add/list/enable/disable/run-now/remove/remove-all/opt-in/opt-out`, `heartbeat start`. Also `/goal`, `/refine`, `/schedule`, `/heartbeat`, `/subgoal` |
| 10.21 | `ox daemon --help` | 5 daemon verbs + `agents`/`attach`/`shutdown`/`--detach` + 8 schedule verbs + `print-crontab`. **Also advertises `ox heartbeat start/list/stop` — which now DO run (10.32); the defect this row recorded on 2026-10-03 is fixed** |
| 10.22 | `ox daemon start` → `status` → `doctor` → `log` → `ox shutdown` → `status` | `started pid 11244 · socket …/daemon/c.sock`; `state: running pid 11244 · up 3s · instance 799971a0…`; doctor **healthy** (`dir 0700 uid 501`, `pidfile matches`, `c.sock 0600 and answering`); log = supervisor start + *"schedule engine idle — no opt-in recorded"*; shutdown graceful; then `state: stopped`, **exit 1** |
| 10.23 | `ox prompt` · `ox prompt --breakdown` · `ox prompt --json` | 9 layers (4 static / 3 session / 2 dynamic); `static prefix 1831 B`, `stable prefix 16335 B`, `volatile tail 124 B`, `TOTAL 16459 B`. Bare = table + full prompt (238 lines); `--breakdown` = table only (17 lines); `--json` keys `cacheablePrefixBytes, stablePrefixBytes, totalBytes, layers[]` with per-layer `hash` |
| 10.24 | `ox schedule list` · `policy` · `add 30m …` · `list --json` · `remove-all` | `optedIn false`, `maxInFlight 3`, `missGrace 1m`, store `~/.ox/daemon/schedules`; add → *"state disabled — `ox schedule enable <id>`"* + *"schedules are OFF — `ox schedule opt-in`"* (**both gates**); cadence probe: `7m`/`90s`(→`2m`)/`1d`/`2h`/ISO all accepted, `bogus` → exit 3. Cleaned up: 0 schedules, residue 0 |
| 10.25 | `ox schedule "<goal>" --at 09:00 --install` (no TTY, no `--yes`) | **exit 4**, *"refusing to write to your system crontab: this is not a terminal, and unattended installs need both confirmations"*. `crontab -l` unchanged before/after. `ox schedule print-crontab` prints cron + launchd and states *"ox never installs anything by itself"* |
| 10.26 | `ox heartbeat list` · `ox heartbeat --help` · `ox agents --help` · `ox attach --help` · `ox refine --help` | **SUPERSEDED BY 10.32 — the `ox heartbeat` half of this row no longer reproduces.** On 2026-10-03: **`ox heartbeat` → `ox: unknown command 'heartbeat'`** (the defect, §8.4b, now resolved). `ox agents --help` prints the live table (daemon stopped · running 0 · idle 0 · **saved 15**) rather than help text. `ox attach --help` → *"ox: attach needs a worker id"* + usage. `ox refine --help` prints the policy: 4 refinable categories, 7 immutable targets, gate `>=1 lesson AND (score >= 6 OR verified)` |
| 10.27 | `node --test test/{daemon,prompt-layering,persistent-goal,agent-messaging,refine}.test.js` | **97/97 pass** |
| 10.28 | `node --test test/{schedule,schedule-regressions}.test.js` | **17/17 pass** |
| 10.29 | `listToolSchemas({})` + `tools/index.js:244` | bare ctx → **19** tools, **no** A2A schemas: they are offered only when `ctx.agentTeamsHandler` is installed. `agentMessagingToolSchemas()` appends them, and the `# AGENT MESSAGING` prompt layer is emitted only when the handler exists (`system-prompt.js:223`) — the offer follows the handler, deliberately |
| 10.30 | Source read: `goal.js:72,310,208` · `agent-teams.js:92,307` · `refine.js:937-944` · `daemon.js:303,328` · `daemon-supervisor.js:110` · `system-prompt.js:211` | mechanisms cited inline in §1.2^2^, §1.3^2^ and §5^2^. **Superseded on one point:** this row cited the subagent delegation clause in `src/system-prompt.js` at its then-current line; that clause has been deleted and replaced by `SUBAGENT_PARALLEL_CLAUSE` at `system-prompt.js:124` (10.31). Its `subagent-registry.js:376` note is likewise superseded: that comment has moved to `:522-529` and been rewritten in past tense now the scheduler exists (10.31) |
| 10.31 | **RE-GRADE 2026-10-04** - `node --test test/parallel-subagents.test.js` - `node --input-type=module -e` importing `resolveSubagentConcurrency`/`DEFAULT_SUBAGENT_CONCURRENCY`/`MAX_SUBAGENT_CONCURRENCY` from `./src/resource-class.js` - `grep -n SUBAGENT_PARALLEL_CLAUSE src/ test/` | **17/17 pass.** `default 3 ceiling 8`; `resolveSubagentConcurrency` returns `3` unset, `5` for `subagent.maxParallel: 5`, **clamps `99` to `8`**, garbage `'x'` -> `3`. the deleted one-at-a-time delegation clause returns **zero** matches in `src/`; `SUBAGENT_PARALLEL_CLAUSE` at `system-prompt.js:124`, emitted `:293`. Scheduler `agent.js:2249`; `CONCURRENTLY_BATCHABLE` `resource-class.js:71`. Grade `N` -> `P` (S1.2, S8.1) |
| 10.32 | **RE-GRADE 2026-10-04** - `ox heartbeat` - `ox heartbeat list` | **Both exit 0.** `ox heartbeat` prints its 3-verb usage; `ox heartbeat list` -> `heartbeats (0)` / `none - ox heartbeat start [--every 5m] [--max-runs 3]` / `daemon NOT opted in - nothing fires until ox schedule opt-in`. `'heartbeat'` **is** in `SUBCOMMANDS` (`cli.js:197`), handler at `cli.js:3374`. The S8.4b defect does not reproduce; Heartbeats row `P` -> `Y` |
| 10.33 | **RE-GRADE 2026-10-04** - `node --input-type=module -e` calling `isSecretKey` from `./src/ipc.js` on 12 keys | `true` for `API-KEY`, `x-api-key`, `access-token`, `apiKey`, `Authorization`, `refresh_token`, `password`, `token`; `false` for `max_cost_usd`, `model`, `prompt_tokens`. Pattern `ipc.js:95` uses `[-_]?` - **the recorded leak is fixed** (S6.2, S8.14) |
| 10.34 | **RE-GRADE 2026-10-04** - `ox doctor` (capability rows) - source read `capability.js`, `cli.js:1144-1164` | `capabilities: 1/2 live (direct) - no live backend: web_search`; a concrete fix printed per backend (`set TAVILY_API_KEY=...`, `setBackendOrder('web_search', [...])`); `web_fetch: live backend "direct" (keyless backend "direct" probed usable (position 1))`. `ox doctor` **consumes** the layer - `capabilityReport({capabilities:['web_search','web_fetch']})` populates the same verdict cache the tools use (`cli.js:1157-1164`). Ordered backends confirmed (`capability.js:149,183,225`). The S1.2 web rows were already `Y`; `COMPETITIVE.md` #4 was the stale one, now corrected |
| 10.35 | **RE-GRADE 2026-10-04** - `grep -rn "cancelSubagent\|stopSubagent\|killSubagent" src/ test/` - source read `subagent-registry.js:522-569`, `resource-class.js:29-30`, `subagent.js:568` | **Zero matches** for any cancel/stop/kill entry point - this *confirms* the steering `N` at S8.1 rather than assuming it. The only exit is the idempotent `finishSubagent`; there is still no `abort` reason distinct from `failed` (`subagent-registry.js:554-558`). `resource-class.js:29-30`: *"nothing pulls a message into another agent's context until that agent itself calls `agent_observe`. A note left in a mailbox steers nobody."* |
| 10.36 | **RE-GRADE 2026-10-04 — independent reviewer, deliberately not the implementer.** `node --check src/serve.js` · `grep -n "'/v1/models'\|'/v1/responses'\|v1/models/:id" src/serve.js` · `grep -n "ALLOW_UNAUTHENTICATED\|127.0.0.1\|0.0.0.0\|isLoopback" src/serve.js` · `HOME=/tmp/srv/home ox serve --host 0.0.0.0 --port 8123` (**no key**) · `lsof -nP -iTCP:8123 -sTCP:LISTEN` · `OX_SERVE_ALLOW_UNAUTHENTICATED=1 ox serve --host 0.0.0.0 --port 8127` · `OX_SERVE_API_KEY=testkey123 ox serve --host 0.0.0.0 --port 8128` · `curl` of all five routes on `:8125` · the same five unauthenticated on `:8126` with the key set · `ox serve --port 8129` (default host) · `ANTHROPIC_API_KEY=… ox serve --port 8130` | **`node --check` clean. The bind refusal is REAL and was confirmed at the socket, not by reading a diff:** `--host 0.0.0.0` with no key → **exit 1**, the 7-line refusal naming all three fixes, `grep -c listening` → **0**, `lsof` → **port 8123 never opened**. Key set + `0.0.0.0` → listens (`*:8128 (LISTEN)`); `ALLOW_UNAUTHENTICATED=1` → listens with the loud warning; default host → `127.0.0.1:8129`. Live bodies: `/health` `{"status":"ok",…}` · `/v1/models` **12** entries from `BOTS`, `servable_now` **1** → **4** once `ANTHROPIC_API_KEY` was set (availability is env-read, not asserted) · `/v1/models/ox-claude` one entry `available:false` · `/v1/models/nope` **404** `model_not_found` · `/v1/models/ox-openrouter` **404** naming `no_default_model` · `POST /v1/responses` → real `object:"response"` with `output_text` from a live Ollama turn, `store:true` → **400** `param:"store"`, client `tools` → **400** `param:"tools"`, unknown model → **404** · `POST /v1/chat/completions` → `object:"chat.completion"`, content `"ok"` · `DELETE /v1/models` → **405** `method_not_allowed` · unknown path → **404** `unknown_url`. **With `OX_SERVE_API_KEY` set, all five routes → 401**; wrong bearer 401; correct bearer 200. **All six implementer claims verified; none refuted.** S1 OpenAI-server row reason corrected (grade held at `P` on the newly named residuals), §10 serve bullet rewritten, S8 item 5 **withdrawn**, S11 item 5 **closed**, §10.7 superseded |

### Corrections to my own probes, recorded because a matrix is only as good as its errors

- **I was wrong twice, and both corrections are in this document rather than hidden.** First, `grep "fireHooks('PreLLM'"` returned nothing and it looked like four of six hook events were dead. They are not — they route through a `fireLifecycle()` wrapper, and `test/hook-events.test.js` 15/15 settles it. Second, `resolveSandbox('workspace')` returned `kind:"off"` for all four presets because I passed a string where the function takes `{flag, config, cwd, home}`. The real result is in §1.4. **Both errors were in my probe, not in ox.**
- The same class of error happened in a sibling agent's session on the tool schemas: the 7 computer-use tools use camelCase `inputSchema`, not `input_schema`, and a naive schema dump makes them look parameterless. They are fully parameterised.
- `docs/comparison.md` contradicts itself on ox's sandbox (§1 row 22 `✓` vs §4 `✗`) and overstates HeyClicky as "cloud-hosted, opaque billing" when the verified facts are a native app with a metered subscription. §0.2 and §0.4 correct both.

---

## §11. What I would fix first, in order

1. **Register `ox acp` in the ACP Registry.** Cheapest gap in the document; reaches Zed and JetBrains at once. No code.
2. ~~**Wire `createAgentTeams` into the agent loop, or delete the mailbox.**~~ **DONE 2026-10-03.** The mailbox has a sender and a reader now (`agent_message.send` / `agent_observe`, `tools/index.js:629`), identity-bound from `ctx`, at-most-once on a durable cursor, screened like memory. §1.2 is `Y`. The item is closed, not deferred.
2b. ~~**Add `'heartbeat'` to the `SUBCOMMANDS` set in `src/cli.js:190`.**~~ **DONE 2026-10-04.** `'heartbeat'` is in the set at `src/cli.js:197` and the handler at `cli.js:3374` is reached; `ox heartbeat` and `ox heartbeat list` exit 0 (§8.4b, 10.32). No longer on this list.
3. **~~Parallel subagents~~ done. Steering, not yet.** Fan-out shipped: `runSubagentBatch` (`agent.js:2249`), `CONCURRENTLY_BATCHABLE` (`resource-class.js:71`), default 3 / ceiling 8, 17/17 tests. `subagent-registry.js:522-569` is the design note that tracks what is built, and it marks items 1, 2, 3 and 5 **DONE**. **What is actually left is item 4, a per-agent cancellation path — "still partly open… there is still no `abort` reason distinct from `failed`" (`:554-558`) — plus a lease/heartbeat so a recycled pid is not read as a live agent (`:540-543`), and the isolation gap (`COMPETITIVE.md` #7): 3 concurrent subagents share one filesystem. Steering — redirect, cancel, or inject into a running subagent — has no mechanism at all; that is the honest remaining item, and `resource-class.js:29-30` is explicit that a mailbox note does not do it.
4. **Make `sandbox` default to `workspace` rather than `off`,** and document loudly that the agent process is unconfined. The capability exists and is verified; the default is the problem.
5. ~~**Fix the `ipc` redaction regex** (`_?` → `[-_]?` inside the alternatives).~~ **DONE 2026-10-04** — `src/ipc.js:95` now uses `[-_]?`; verified by running `isSecretKey` on `API-KEY` / `x-api-key` / `access-token` (10.33). **The "still open" half is closed too, 2026-10-04:** `/v1/models` and `/v1/responses` both exist, and were re-graded independently in 10.36 — five routes, all curled live. This item is closed in full, not deferred.
6. **Delete `src/agent.js.bak`; fix `ox models --help`.** Both are minutes of work against a document that leads on "featherweight". **DONE 2026-10-02:** the `.bak` was verified stale (no unique symbol, import, or logic vs. current `src/agent.js`) and deleted; the formatter was reading `m.id`, a field `listCandidates()` never returns — it yields `{ bot, model, provider }` — so `ox models` and `ox model list` each printed `undefined` once per candidate. Both now print the real fields, with an honest `n/a` where `bot` is genuinely null.
7. **Add a skill `/refine` that writes a skill, and a version field — Prime Agent owns both rows today.** Half-done as of 2026-10-03: `/refine` shipped over four fixed, evidence-gated categories with structural immutability, but it edits a skill's *description* and does not author a skill. The version field is untouched.
8. **Document the linear-output accessibility property** and stop implying more than it is. A screen-reader user is better off in ox than in Crush or opencode, and should be told so in those words.

---

*Sources: heyclicky.com and github.com/heyclicky (fetched 2026-10-02) · zed.dev ACP registry and external-agent docs · opencode.ai/docs/acp · jetbrains.com AI Assistant 2026.2 ACP docs · docs.openhands.dev runtime architecture and OpenHands `runtime/README.md` · docs.devin.ai advanced capabilities · cognition.com/blog/local-fusion · github.com/PrimeIntellect-ai/prime-agent README and CLI README · openagents.org/goose · github.com/anomalyco/opencode#39368 · github.com/Karanjot786/TermUI#121 · microsoft/terminal `terminal-a11y-2023.md` · and, for adoption/issue data, [`COMPETITIVE.md`](./COMPETITIVE.md) §1–§4 (GitHub API, 2026-10-01). Anything not traceable to one of these is marked `?` and is not a claim.*
