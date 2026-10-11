# Hermes Agent — gap analysis vs ox

Hermes Agent ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
MIT, ~240k stars) is the widest-feature open coding agent: the widest tool fan,
the widest provider surface, and the weakest verification spine. Latest released
tag at check time: **v0.21.5 / v2026.9.24**. Date checked: **2026-09-30**.

Marks below are ox's own status against that release. `PARTIAL` means the
capability exists in a weaker form — the module that would need to change is
named in every row.

## 1. What Hermes has that ox does not

| Capability | ox | ox module that would change |
|---|---|---|
| Background, non-foreground desktop automation (`computer_use` / cua-driver over AX/UIA/AT-SPI; the cursor never moves) | PARTIAL | `src/tools/operator.js` — drives only the frontmost app |
| Bounded computer-use capability manifests | NO | new manifest layer over `src/tools/` |
| A2A (agent-to-agent) protocol | NO | new; no `a2a` reference anywhere in `src/` |
| Mixture-of-Agents exposed as selectable models | NO | `src/bots.js`, `src/model-registry.js` |
| First-party `web_search` / `web_extract` with pluggable backends + TTL cache | NO | web is MCP-template only; no native tool |
| LSP-backed semantic diagnostics | PARTIAL | syntax advisory only, no language server |
| Memory provider plugin abstraction (8 backends) | PARTIAL | `src/honcho-user.js` is hardcoded to one backend |
| Live subagent steering (`steer` / `stop` mid-flight) | PARTIAL | `src/subagent.js` is resumable but not steerable |
| Cron that runs an agent with per-job memory, continuity, and monitor mode | PARTIAL | `src/cron-scheduler.js` only emits crontab / launchd snippets |

## 2. Where ox is already ahead

**Partly evidence-gated persistence.** `ox episode promote` (`src/memory.js:627`)
requires at least one lesson **and** (`score >= 6` **or** `verified`), otherwise it
returns `kind: 'unqualified'` and the CLI exits **4** (`src/cli.js:2092`).

The secret/persistence half is closed by **one shared screen** covering every
store ox writes and every path it reads back into a prompt; the pattern tables
live only in `src/memory.js` (`screenMatch`, `screenPersistText`,
`screenReadLines`, `screenReadTexts`, `shortWithheldNotice`) and no module
re-derives them. It matches credential shapes (provider key prefixes, JWTs, PEM
private-key blocks, long bearer tokens, inline `secret = <opaque>` assignments)
and prompt-injection phrasing, refusing with an error that names the pattern
class and never echoes the text.

- **Write = refuse.** `addMemory` (`.agent/MEMORY.md`, `topics/*`),
  `recordLesson`, `writeSessionNote` (`.agent/notes/`) and `writeEpisode`
  (`.agent/episodes/`) — each also screened in the derived filename slug, since
  `memory_search` echoes hit paths to the model — `recordPattern`
  (`.agent/procedural.md`), subagent-scoped `addEntry`
  (`.agent/_sub/<id>/MEMORY.md`), and `screenFilePaths` (subagent
  `filesTouched`).
- **Read = withhold, never rewrite.** `loadMemoryBlock`, `memory_list` /
  `memory_get` / `memory_search` (including stored hit paths),
  `formatProceduralContext` / `recallPatterns`, the subagent lessons block plus
  scoped block/list/get/search and `filesTouchedBlock`, `screenSkillBody` +
  skill-index frontmatter (`/skill <name>`, the `# SKILLS` prompt block), and
  `replayMessages` (`--resume` / `--continue` / `/resume` / `/rewind`), which
  covers `tool_call` arguments and tool results while preserving order and
  `tool_call`/`tool_result` pairing. Entries written before the screen existed are
  no longer re-injected; a withheld line is skipped, never echoed, and the file on
  disk is left untouched — deletion stays the user's call. Skips are counted in the
  block/tool notice, `memoryScreenStats()`, and one `t: "memory-screen"` /
  `event: "read-withheld"` row per read in the `OX_AUDIT` ledger; a replay also
  warns on stderr. Cost is zero added bytes when nothing is withheld, one
  ~26-token notice when something is.

Precision guards keep ordinary prose storable (`token = config.getToken()`,
`OPENAI_API_KEY`, "you are now able to run the suite"). One deliberate residual: a
subagent’s `finalText` — its live answer — passes through unscreened into the
parent’s result; its persisted `result`, `error` and `filesTouched` are. Hermes has
no memory-load, tool-result or session-replay chokepoint at all, so whatever a
store holds is re-injected verbatim.
`.agent/MEMORY.md` is still re-injected every turn by `src/context.js`, but only in
screened form.
The **evidence gate is still missing**: `memory_add` validates only `type` and a
non-empty `statement`, with no source, citation, or score requirement, so most
memories are still *not* born through the gate. Hermes ships *advisory* scanning
only — its Curator auto-archived 54 of 87 skills on a live install (#18373).

**No silent paid fallbacks, by design.** Hermes: $4.12 spent across 46.9M tokens
accidentally (#97942), 5x cost escalation on re-login (#68144), silent model
substitution (#33174). ox fails closed on unknown pricing and announces every
switch (§3).

**Append-only JSONL sessions, never a SQLite `state.db`.** A crashed or corrupt
session file costs you that one transcript and nothing else. Hermes' `state.db`
corruption cluster: #5563, #92996, #100788, #97940/#98077.

**Adaptive context that supports sub-64K local models.** Hermes hard-rejects
startup with `MINIMUM_CONTEXT_LENGTH = 64_000` (#31600, #53347), which pushes
users to lie about their context window. ox adapts instead of refusing.

**Zero-dep install.** `node bin/ox.js`, no `npm install`, no build. Hermes needs
Python >= 3.11 + uv + Node.

## 3. What we changed in response

- **Cost honesty.** `model_overrides` plus `fallback_policy.cost: free_only`,
  which fails closed on unknown pricing instead of guessing, and an explicit
  non-dismissible `model_switch` event so every target change is announced:
  `src/cost.js`, `src/config.js`, `src/agent.js`.
- **Degraded-history honesty.** `loadSessionWithStatus` returns `ok` / `empty` /
  `unavailable`, so a failed transcript read can never masquerade as an empty
  conversation; `OX_STRICT_READ=1` aborts instead of degrading; resume sites in
  `src/cli.js` print an explicit warning.
- **Identity.** The ox logo and the converging particle-swarm intro
  (`src/logo.js`), with `NO_COLOR=1` / `OX_NO_ANIM=1` opt-outs.

## 4. Not verified

- v0.22.0 release notes were unpublished as of 2026-09-30.
- main-branch source beyond the released tags was not read.
- Issue counts drift at Hermes' release cadence; numbers above are as-seen
  2026-09-30.
