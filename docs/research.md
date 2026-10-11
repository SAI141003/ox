# ox research dossier (Aug 2026)

> Evidence base for ox's design decisions ([plan.md](plan.md)) and market positioning ([comparison.md](comparison.md)).
> All facts verified August 2026. Prices are USD per Mtok (input/output) unless noted. Uncertainty is flagged inline; nothing is silently smoothed.

## Contents

1. [The incumbents](#1-the-incumbents) — Claude Code, Codex CLI, and the parity bar they set
2. [The field](#2-the-field) — thirteen tools profiled, including a deep dive on Hermes Agent
3. [Techniques that work](#3-techniques-that-work) — edit formats, repo maps, context math, verification, sandboxing, headless contracts, and the papers behind them
4. [Provider API cheat sheet](#4-provider-api-cheat-sheet-aug-2026)
5. [MCP spec essentials](#5-mcp-spec-essentials)
6. [Skills landscape](#6-skills-landscape)
7. [Cross-cutting gaps](#7-cross-cutting-gaps-the-thesis) — the eight gaps ox exists to close

**How to read this dossier:** §1–2 are the competitive landscape — what shipped, what died, what users complain about. §3 is the engineering canon — techniques with evidence behind them, each ending in an "ox take". §4–6 are integration specs distilled to what an implementer needs. §7 is the thesis: eight market-wide gaps that define ox's charter.

---

## 1. The incumbents

### 1.1 Claude Code (Anthropic) — the 800-pound default

Docs: https://code.claude.com/docs · Repo mirror: https://github.com/anthropics/claude-code

**Shape.** Native binary compiled from Bun-bundled TypeScript (~512K lines). ~232MB installed. ~40 built-in tools.

**Permissions.** Tiered model: manual → acceptEdits → plan → bypass, plus an ML auto-classifier that routes actions by risk. "Sandboxing" is rules + classifier — prompt-level policy, weaker than OS-level isolation.

**Extensibility.** Subagents, 27 hook events, MCP client with deferred tool loading (`ToolSearch` on by default so huge tool catalogs don't flood context), plugins + skills + third-party marketplaces.

**Memory & sessions.** Hierarchical CLAUDE.md; auto-memory (MEMORY.md index plus topic files — first ~200 lines / 25KB auto-loaded; typed user/feedback/project/lesson entries; prune reminders); JSONL session logs with `--resume` and `--fork`; auto-compaction.

**Git-native.** Worktree-per-task flows and checkpoint/rollback of agent edits.

**Surfaces.** First-class IDE integration; GitHub Actions harness; headless `claude -p` with JSON/stream-JSON output.

**Models & pricing (Claude-only).**
| Model | $/Mtok in | out |
|---|---|---|
| Opus 5 | $5 | $25 |
| Sonnet 5 | $2 | $10 |
| Haiku 4.5 | $1 | $5 |

Subscriptions: Pro $20/mo · Max $100–200/mo.

**Documented complaints (the ox opening).**
- Quota-drain bugs burn subscription limits faster than real usage warrants.
- A May 2026 quality-regression postmortem acknowledged shipped degradations.
- **Silent Edit failures** (issue #64171): the agent edits "from memory," claims success — file unchanged.
- 20-minute turns on complex tasks.
- Resource leaks: 20GB temp-file accumulation, unbounded file-history growth, 36MB session JSONLs.

### 1.2 Codex CLI (OpenAI) — the engineered contrarian

Docs: https://developers.openai.com/codex/cli · Repo: https://github.com/openai/codex

**Shape.** Rust rewrite across ~70 crates; zero-dependency binaries; millisecond startup.

**Editing.** `apply_patch`-style structured edits; `/plan` and `/review`; multi-agent flows; hooks.

**Kernel sandboxing (standout).** Real OS primitives enforced over the whole process tree:
- macOS Seatbelt profiles
- Linux Landlock/seccomp + bubblewrap
- Windows DACLs

`.git` is forced read-only even in `workspace-write` mode. Sandbox modes: `read-only | workspace-write | danger-full-access`. Approval policies: `untrusted | on-request | never`.

**Config & memory.** Layered TOML config; hierarchical AGENTS.md with a 32KB cap.

**Access.** BYOK; OSS mode against Ollama/LM Studio; custom providers; token-credit pricing.

**Documented complaints.**
- Approval-prompt friction: users maintain hundreds of per-tool allowlist entries.
- Config schema churn breaks setups between releases.
- Worktree `.git` pointer stalls.
- "Consent theater": prompts that neither protect nor speed up.


**Copy vs avoid (Codex).** Copy: zero-dependency binaries, kernel-sandbox posture, layered config, AGENTS.md hierarchy. Avoid: approval UX that trains users to auto-click, config churn between releases, and consent dialogs that protect nothing — friction without safety is just cost.

### 1.3 The parity bar for ox

Any credible coding agent must match: agentic loop with verified edits · graduated permissions · plan mode · hierarchical memory files · session resume + compaction · hooks · subagents · MCP · extensibility · git-native workflows · an IDE path · flexible auth with transparent costs. Codex proves the loop can be fast and dependency-free; Claude Code proves the ecosystem surface is table stakes. Neither proves it needs 232MB or a single-vendor lock.

---

## 2. The field

Thirteen tools, three dead. The graveyard matters as much as the leaders: Gemini CLI's free tier sunset (Jun 18 2026, folded into Antigravity), Roo Code shut down May 15 2026, Windsurf folded into Devin Desktop Jun 2026 amid metering churn, Qwen Code's free OAuth discontinued Apr 2026, Amp closed to new users. Every one of these took user workflows down with it.

| Tool | Status Aug 2026 |
|---|---|
| Gemini CLI (individual tier) | sunset Jun 18 2026 → Antigravity |
| Roo Code | shut down May 15 2026 |
| Windsurf | folded into Devin Desktop Jun 2026 |
| Qwen Code free OAuth | discontinued Apr 2026 |
| Amp | closed |
| Claude Code, Codex CLI, Aider, Cline, Goose, opencode, Crush, Cursor CLI, Antigravity, Hermes | active |

Compact profiles:

- **Gemini CLI** — Node 20+; famously generous free tier and 1M-token context window; individual tier then sunset into Antigravity. Cautionary tale: Google can retire your free ride mid-project. https://github.com/google-gemini/gemini-cli
- **Antigravity** — closed VS Code fork spanning desktop + CLI + SDK. Manager View orchestrates ~5 parallel agents; built-in Chrome visual verification; Artifacts as first-class outputs; Gemini-tuned models only. Frictions: tightening free tiers, forced auto-updates.
- **Aider** — the technique treasury (Python). tree-sitter + PageRank repo map packing a whole-repo outline into ~1k tokens; 12 edit formats auto-matched per model; git auto-commits with `/undo`; headless `--message`; per-message cost reporting; LiteLLM underlay → 100+ providers; deliberately no shell autonomy. https://aider.chat · https://github.com/Aider-AI/aider
- **Cline** — Plan/Act separation with per-step checkpoints; BYOK across 30+ providers; notorious token hunger ($50/day reports). https://github.com/cline/cline
- **Roo Code** — custom modes and Boomerang orchestration; shut down May 15 2026. Graveyard datum #2.
- **Goose** — Rust binary; 70+ MCP extensions; YAML "Recipes"; lead/worker/reviewer routing; local-first ethos. Sprawls generalist, config complexity grows. https://github.com/block/goose
- **opencode** — client/server split over REST+SSE; models.dev registry (75+ providers); was cut off from Anthropic 3P access at one point; Bun dependency. https://github.com/sst/opencode · https://models.dev
- **Amp** — multi-model routing (smart/deep/rush tiers); "Oracle" second-opinion pattern; parallel subagents; went closed; costs spiral on unpublished rates. https://ampcode.com
- **Cursor CLI** — standalone binary; Tab-completion pedigree; closed and account-bound; measured ~5.5× token inefficiency vs Claude Code on identical tasks. https://cursor.com/cli
- **Windsurf** — Cascade agent + SWE-1.6 models; absorbed into Devin Desktop Jun 2026 after metering churn. Graveyard datum #3.
- **Qwen Code** — proved an open harness is trivially forkable; its free OAuth died anyway. Lesson: forkability is survival insurance. https://github.com/QwenLM/qwen-code
- **Crush** — Go binary; Bubble Tea TUI; LSP-enriched context; standout mid-session model switching that preserves conversation; per-session permissions; drifts on large refactors. https://github.com/charmbracelet/crush

### 2.2 Market structure summary

- **Consolidation is real**: five products died or were absorbed in ~14 months; survivors cluster around big-vendor distribution (Claude Code, Codex, Antigravity, Cursor) or ideology (Aider, Goose, Hermes).
- **The middle died**: mid-size VC-backed agents without either moat are the rug-pull casualties.
- **Openness correlates with survival options**: Aider (technique donor), Qwen Code (forkable harness), Hermes (MIT) all outlive their business models because users can carry them.
- **Nobody owns featherweight**: every capable agent assumes hundreds of MB and a runtime stack. The <100MB, <1s slot documented as beat-delta #9 is unoccupied.
- **Interop standards just landed**: Agent Skills + AGENTS.md + `.mcp.json` form a portable surface an upstart can adopt wholesale on day one — historically unprecedented, and the window ox walks through.

### 2.1 Deep dive: Hermes Agent (Nous Research) — the instructive comet

Repo: `NousResearch/hermes-agent` on GitHub · MIT license · ~234k stars

A self-improving personal agent with a 22-platform messaging gateway. The most ambitious memory-and-skills architecture in the field — and therefore the richest catalog of failure modes ever collected in one open-source project. ox studies it the way aviation studies accident reports: every beat-delta below traces to a real, documented wound.

**Runtime & footprint.** Python 3.11+ managed by uv, plus a Node TUI. Heavy stack, heavy install — nothing featherweight about it.

**Model flexibility.** Any OpenAI-compatible endpoint — no vendor lock-in on paper. In practice it demands ≥64K context for reliable tool use and leans on an "auxiliary model" layer whose cloud fallbacks were silent: local users found themselves billed for Gemini Flash (issues #7559, #45782; $145 surprise charges reported). 8B-class local models are effectively unsupported ("can't tool-call").

**Tools.** 40–60+ tools in toggleable toolsets: web, browser, media, `execute_code`, `delegate_task` subagents, cron, and seven terminal backends (local/Docker/SSH/Modal/…). Breadth over depth.

**Memory.** MEMORY.md capped ~2,200 chars + USER.md ~1,375 chars, injected frozen per session. A memory tool offers add/replace/remove — but no read. Session search via FTS5 SQLite, undermined by state.db corruption (bug #5563). Background self-improvement review forks; write_approval staging for sensitive writes. Tiny, static, fragile.

**Skills.** SKILL.md files under ~/.hermes/skills using agentskills.io frontmatter. Genuine progressive disclosure: `skills_list()` ≈3k tokens → `skill_view` loads the body. Every skill doubles as a slash command. Self-authoring via `skill_manage`; `/learn` distills sessions into skills; security scanning on intake. The best skills UX anywhere — undercut entirely by what gets admitted to the library (next).

**Self-improvement.** Background review forks distill experience into new skills/memories with no evidence gate: procedures get captured regardless of whether they worked. The user community's verdict, verbatim-ish: **"It always thinks it did a good job. ALWAYS."** After ~5 tool calls the skill list floods with no pruning or conflict detection (#12877) — "only births, no nurturing."

**MCP & surfaces.** Full MCP client *and* server mode; plugins/hooks (`pre_llm_call`, etc.); headless `-q`; an OpenAI-compatible API server; ACP support.

**UX.** Rich TUI: status bar, `!` shell passthrough, mid-turn steering, checkpoints, SOUL.md personality files.

**Criticisms ledger.**
- "It always thinks it did a good job. ALWAYS." — learning loop encodes FAILED procedures as skills
- Skill flooding: no pruning/conflict detection (#12877)
- Astroturfing suspicions around star velocity
- SQLite corruption (#5563)
- 2.2KB effective memory ceiling
- Environment hallucination: claimed a cloud container while running on local WSL2
- Silent paid fallbacks (#7559/#45782)
- Local LLMs effectively unsupported (64K floor; 8B can't tool-call)
- Plagiarism row (#10232)
- CVE-2026-7113; eight P0 security fixes in a single release

**Beat-deltas — what ox must beat.** Each maps to a concrete plan.md mechanism:

1. Hard provider pinning, zero silent fallback, loud errors.
2. Tiered memory at real scale, with provenance.
3. **Evidence-gated self-improvement**: save skills/memories only after objective verification (tests/lint/user confirm). Never learn from failures silently.
4. Skill metabolism: usage stats, decay, dedupe, conflict detection.
5. Small-model competence: adaptive schema pruning below 64K contexts; verified 8–14B local support.
6. Corruption-proof append-only storage.
7. Coding-first loop parity: plan mode, pre-write diffs, test gates.
8. Transparent economics: per-turn cost ledger, hard budget caps, no hidden aux-model spend.
9. Lean footprint: <100MB installed, <1s cold start.
10. Trust hygiene.
11. Lossless session logs + export.
12. Sandbox-by-default posture.

---

## 3. Techniques that work

### 3.1 Edit formats (Aider's empirical leaderboard)

Reference: https://aider.chat/docs/llms.html — Aider runs the field's longest-running edit-format benchmarks.

- **whole-file**: most reliable for weak models; ruinously token-expensive for big repos.
- **search/replace blocks**: comparable accuracy at far fewer tokens for strong models.
- **unified diff (udiff)**: fixing lazy application took GPT-4 Turbo from 20% → 61% success.
- **str-replace**: the frontier-model standard.
- Matching-rule families, loosest-to-tightest: FAMILIAR · SIMPLE (no escaping, no line numbers) · HIGH-LEVEL (whole functions) · FLEXIBLE (fuzzy, whitespace-normalized apply).
- Function-calling edit formats consistently underperform plain-text formats.

**ox take:** exact-match first, whitespace-normalized fuzzy second, and on failure return an error that tells the model to re-read the file. Never trust whole-file rewrites from strong models; never demand udiff discipline from weak ones.

### 3.2 Repo maps

- Aider: tree-sitter symbol extraction + PageRank ranking = whole-repo outline in ~1k tokens. https://aider.chat/docs/repomap.html
- Claude Code style: agentic just-in-time exploration (grep/glob on demand), no maintained index.
- These trade off freshness vs cost. A cheap git-aware tree (~1k-token budget, .gitignore-respecting) plus symbols-on-demand captures both benefits.

### 3.3 Context-management arithmetic

- ≈4 chars/token prose, 3–3.5 chars/token code. A constant-factor estimate beats flying blind and is what honest meters are made of.
- Compaction = summarize older turns while KEEPING: decisions made, unresolved bugs, file details, plus recent turns verbatim.
- Cap tool outputs (~25k tokens); replace stale tool_results with placeholders once consumed.
- Anthropic's engineering guidance: simplest patterns win; mandatory stopping conditions; structured note-taking (NOTES.md) kept OUTSIDE the context window; subagents return 1–2k-token summaries, not transcripts; hybrid context (static rules upfront, everything else JIT); render errors as actionable prose. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Codex guide wisdom: "when the agent repeats a mistake, codify the retrospective in AGENTS.md."

### 3.4 Verification & recovery loops

Every serious harness (SWE-agent, OpenHands, Aider) converges on the same skeleton:

```
act → verify (syntax/lint/test) → inject structured error → retry within budget → checkpoint/rollback
```

Field-tested details:
- Pre-check bash syntax before execution.
- Most "replacement not found" loops come from assuming file contents — re-read before retrying an edit.
- On attempt ≥2, VARY STRATEGY: different approach, not reworded same approach.
- Unit-test feedback beats explanation-based debugging; repair beats resample by 10× sample-efficiency (Self-Debugging paper, below).

### 3.5 Sandboxing spectrum

- Kernel-level: Seatbelt (macOS), Landlock/seccomp + bubblewrap (Linux), DACLs (Windows), Docker containers. Codex applies these over the entire process tree and keeps `.git` read-only under workspace-write.
- Lightweight alternative, adequate when approvals exist: path allowlists + denylists + timeouts + resource caps, applied at the tool boundary. This is ox v0; kernel modes are roadmap with a flag-shaped seam reserved in the design.

### 3.6 Headless contracts

`claude -p` with `--output-format json|stream-json`, stdin piping, and a strict exit-code contract is what makes coding agents composable from scripts, CI, and other agents. The contract costs almost nothing to implement — the 232MB binary it ships in does.

### 3.7 Tool ergonomics beats prompting (poka-yoke)

The cheapest quality lever is making tools impossible to misuse, rather than begging the model to be careful:

- Require **absolute paths** — kills cwd drift and `../` escape confusion in one rule.
- **Pre-check bash syntax** before execution; a syntax error should never burn a model turn.
- Design edit tools so the failure mode is a **structured, actionable error** ("string not found; re-read the file"), not a silent no-op. Claude Code issue #64171 is what the opposite looks like.
- Cap outputs at the tool boundary; truncate with a visible marker instead of silently swallowing.
- A poka-yoke tool replaces a paragraph of prompt rules — and works on weak models too.

### 3.8 Papers — one-line implementable takeaways

| # | Paper | arXiv | Implementable takeaway |
|---|-------|-------|------------------------|
| 1 | Reflexion | [2303.11366](https://arxiv.org/abs/2303.11366) | On failure, write a short self-diagnosis into an episodic buffer fed to the next attempt (HumanEval 80→91). Cost multiplies per attempt; requires trustworthy test signals. |
| 2 | Self-Refine | [2303.17651](https://arxiv.org/abs/2303.17651) | Generate→feedback→refine, ≤4 iterations. +20% preference, +13% code-optimization on weak models. Feedback must be specific/actionable, not vibes. |
| 3 | Self-Debugging | [2304.05128](https://arxiv.org/abs/2304.05128) | Execute→explain→repair. Unit-test feedback beats explanations; repairing beats resampling by 10× sample-efficiency. |
| 4 | CRITIC | [2305.11738](https://arxiv.org/abs/2305.11738) | Self-correction only works anchored to external tools (compiler/linter/tests/diffs). Tool-free critique is noise. |
| 5 | Huang et al., can LLMs self-correct | [2310.01798](https://arxiv.org/abs/2310.01798) | Intrinsic self-critique without external signals is worthless-to-harmful. This is ox's reflection rule: external signals only. |
| 6 | Constitutional AI | [2212.08073](https://arxiv.org/abs/2212.08073) | Written principles enable principled critique. A repo's AGENTS.md conventions ARE the project's constitution. |
| 7 | Voyager | [2305.16291](https://arxiv.org/abs/2305.16291) | A skill library of VERIFIED procedures with descriptions, retrieved at task time; skills compose. Verification-before-storage is the whole point. |
| 8 | MemGPT/Letta | [2310.08560](https://arxiv.org/abs/2310.08560) | Tiered memory files + self-managed paging at pressure thresholds. No vector DB required. |
| 9 | Generative Agents | [2304.03442](https://arxiv.org/abs/2304.03442) | Retrieve memories scored by recency × importance × relevance; distill periodically. |
| 10 | A-MEM | [2502.12110](https://arxiv.org/abs/2502.12110) | Notes are living documents: on write, merge/update stale neighboring notes instead of duplicating. |
| 11 | HippoRAG | [2405.14831](https://arxiv.org/abs/2405.14831) | Take the principle, skip the machinery: entity-tagged notes + grep/BM25 retrieval suffice at personal scale. |

**Cross-paper synthesis (what ox actually implements).** The papers triangulate on three rules: (1) critique only against external signals — compiler, linter, tests, diffs (CRITIC + Huang), which becomes ox's reflection gate; (2) persist verified procedures, never failed ones (Voyager), which becomes evidence-gated memory and the death of "it always thinks it did a good job"; (3) tiered files with pressure-threshold paging and merge-on-write (MemGPT + A-MEM + Generative Agents), which becomes the `.agent/` store — no vector database, per HippoRAG's lesson that entity-tagged notes plus grep/BM25 win at personal scale.

---

## 4. Provider API cheat sheet (Aug 2026)

Seven of eight targets are OpenAI-shaped. Only Anthropic and Gemini need real adapters. The genuinely hard parts — the only parts worth engineering effort: **tool-definition mapping**, **tool-result mapping keyed by call id**, and **streaming delta accumulation**.

| Provider | Endpoint | Auth (env var) | Wire shape | Example models ($in/$out per Mtok) |
|----------|----------|----------------|-----------|-------------------------------------|
| xAI | `https://api.x.ai/v1/chat/completions` | Bearer `$XAI_API_KEY` | OpenAI-compat, tools + SSE | grok-4.6 $2/$6 · grok-build-0.1 $1/$2 |
| OpenAI | `https://api.openai.com/v1/chat/completions` | Bearer `$OPENAI_API_KEY` | canonical OpenAI | gpt-5.6-sol $4/$20 · terra $2/$12 · luna $0.20/$1.20 |
| Groq | `https://api.groq.com/openai/v1` | Bearer `$GROQ_API_KEY` | OpenAI-compat | moonshotai/kimi-k2-instruct-0905 $1/$3 · qwen/qwen3.6-27b $0.60/$3 |
| OpenRouter | `https://openrouter.ai/api/v1` | Bearer `$OPENROUTER_API_KEY` | OpenAI-compat meta-router | passthrough pricing, 100s of models |
| DeepSeek | `https://api.deepseek.com` | Bearer `$DEEPSEEK_API_KEY` | dual-compat: OpenAI + Anthropic shapes | deepseek-v4-pro $1.32/$3.96 (peak) · v4-flash $0.44/$1.32 · chat/-reasoner RETIRED 2026-07-24 |
| Ollama (local) | `http://localhost:11434/v1` | none | OpenAI-compat; tools YES, `tool_choice` NO — omit it | local models, e.g. qwen3 |
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key: $ANTHROPIC_API_KEY` + header `anthropic-version: 2023-06-01` | own shape | opus-5 $5/$25 · sonnet-5 $2/$10 · haiku-4.5 $1/$5 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (+ `:streamGenerateContent?alt=sse`) | `x-goog-api-key: $GEMINI_API_KEY` | own shape | gemini-3.1-pro-preview $2/$12 · gemini-3.7-flash $0.38/$1.88 |

Provider docs: https://docs.x.ai · https://platform.openai.com/docs/api-reference/chat · https://console.groq.com/docs/api · https://openrouter.ai/docs · https://api-docs.deepseek.com · https://docs.ollama.com · https://docs.anthropic.com/en/api/messages · https://ai.google.dev/gemini-api/docs

**Wire notes for adapter authors.**

- Canonical OpenAI flow: `tools:[{type:"function",function:{name,description,parameters}}]` → assistant returns `tool_calls:[{id,function:{name,arguments /*JSON string*/}}]` → send back `{role:"tool", tool_call_id, content}`. Streaming: `delta.tool_calls` arrive as FRAGMENTS that must be accumulated by array index (id + name on first fragment, argument strings concatenated thereafter); set `stream_options:{include_usage:true}` to get a usage chunk; stream ends with `[DONE]`; `finish_reason:"tool_calls"` signals a tool turn.
- Anthropic flow: request `tools:[{name,description,input_schema}]` → response block `{type:"tool_use",id,name,input}` → return user message with `{type:"tool_result",tool_use_id,content}`. SSE event order: `message_start` → `content_block_start` → `content_block_delta` (`text_delta` | `input_json_delta` — JSON arrives in partial strings that must be concatenated) → `content_block_stop` → `message_delta` (usage + stop_reason) → `message_stop`.
- Gemini flow: request `functionDeclarations` → model returns `functionCall{name,args,id}` → return `functionResponse{name,response,id}`. Streaming via `:streamGenerateContent?alt=sse`.
- DeepSeek accepts BOTH OpenAI and Anthropic request shapes at the same host — useful as an adapter smoke target.
- Ollama quirk: never send `tool_choice`; unsupported.

**Adapter test strategy.** Because 7/8 targets share one shape, the openai-compat parser is tested against recorded SSE transcripts from xAI, Groq, DeepSeek, and Ollama; the Anthropic and Gemini parsers get their own fixtures. DeepSeek's dual-compat host makes it the cheapest live cross-check that the two adapter families agree on canonical messages.

---

## 5. MCP spec essentials

Spec: https://modelcontextprotocol.io/specification — JSON-RPC 2.0 throughout. Transports: **stdio** (newline-delimited frames over a subprocess's stdin/stdout; stderr is for logs; shutdown ladder = close stdin → SIGTERM → SIGKILL) and **Streamable HTTP** (plain POST; legacy HTTP+SSE transport deprecated).

### Two protocol eras

| | NEW era (2026-07-28) | LEGACY era (≤2025-11-25) |
|---|---|---|
| Session model | stateless | stateful after handshake |
| Version negotiation | every request carries `_meta {io.modelcontextprotocol/protocolVersion, clientInfo, clientCapabilities}` | one-time `initialize` → response → `notifications/initialized` |
| Discovery | optional `server/discover` | `tools/list` |

**Reality check:** most servers in the wild — including Claude Code's own — still speak the legacy era. ox implements the legacy handshake first-class and carries `_meta` fields opportunistically.

### Minimal tools-only client message list (legacy)

```
→ initialize        {protocolVersion:"2025-11-25", capabilities:{}, clientInfo:{name:"ox",version}}
← result            {protocolVersion, capabilities, serverInfo, instructions?}
→ notifications/initialized
→ ping              {}                      ← must answer server pings with {result:{}}
→ tools/list        {cursor?}               ← paginate via nextCursor until absent
← result            {tools:[{name, description?, inputSchema, annotations?}]}
→ tools/call        {name, arguments}
← result            {content:[{type:"text",text}...], isError}
```

### Error semantics (memorize this)

- `isError:true` in a call RESULT = **model-recoverable** failure → surface the content to the model and let it adapt.
- A JSON-RPC protocol ERROR (negative code) = infrastructure problem → report loudly to the user, do NOT blind-retry.
- Tool `annotations` like `readOnlyHint` are **UNTRUSTED hints**, never permission grants.
- `notifications/tools/list_changed` → invalidate the cached tool list.

### Failure modes & mitigations

- **Crashes**: stdio has no auto-reconnect — restart deliberately (`/mcp restart`).
- **Timeouts**: enforce spec timeouts; support `notifications/cancelled`.
- **Huge tool lists**: deferred loading; name-collision prefixing `mcp__<server>__<tool>`; cap outputs (~25k tokens); treat descriptions as untrusted input.

### Config compatibility

Parse Claude Code's `.mcp.json` DIRECTLY — it is the de-facto interchange format:

```json
{"mcpServers":{
  "fs":   {"command":"npx","args":["-y","@modelcontextprotocol/server-fs","/tmp"],"env":{"KEY":"${VAR:-default}"}},
  "http": {"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}
}}
```

`${VAR}` expands from environment; `${VAR:-default}` supplies a fallback. Codex has a TOML equivalent. Supporting Claude's format means every published server config works with ox unchanged.

---

## 6. Skills landscape

**The Agent Skills standard** (https://agentskills.io) — spec authored by Anthropic Dec 2025; adopted by OpenAI and Microsoft within 48 hours; ~40 clients support it; marketplaces skills.sh and SkillsMP list 100k+ skills; the tool-neutral `.agents/skills/` directory convention is emerging alongside vendor dirs.

**SKILL.md anatomy.**

```markdown
---
name: pdf-report            # required, [a-z0-9-], = directory name
description: Builds PDF reports from markdown. Use when generating printable docs.  # required, what+when, ≤1024 chars
license: MIT                # optional
compatibility: ox>=0.1      # optional
metadata:                   # optional nested map (ox reads metadata.trigger)
  trigger: command
allowed-tools: bash,read_file  # hint only, not enforcement
---
Body markdown — instructions, examples. Optional siblings:
scripts/  references/  assets/
```

**Progressive disclosure economics:** the name+description line sits in context permanently (~100 tokens); the body loads only on invoke; scripts run through the normal bash tool, approval-gated like any other command.

**Why progressive disclosure wins:** 100k marketplace skills at ~100 tokens of index each is the only arithmetic that survives contact with a real context window — full-body injection dies at ~10 skills, index injection scales indefinitely. Hermes's `skills_list()` ≈3k tokens for its whole library is the existence proof ox copies.

**Format zoo.**

| Format | Owner/era | Shape | ox stance |
|--------|-----------|-------|-----------|
| Agent Skills SKILL.md | Anthropic → open standard, ~40 clients | frontmatter + md + assets | **native format** |
| Claude Code skills | Anthropic | SKILL.md in `.claude/skills/`, `~/.claude/skills/` | parse directly, zero conversion |
| Goose Recipes | Block | YAML workflows | convert at import time |
| opencode agents | opencode | JSON agents | out of scope v0 |
| Cursor rules | Cursor | `.mdc` files | out of scope v0 |
| AGENTS.md | AAIF / Linux Foundation, 60k+ repos | always-on hierarchical project context | read hierarchically, closest-wins |

**Recommended unified design (adopted by plan.md):** SKILL.md native; scan all four locations — `~/.agents/skills`, `<proj>/.agents/skills`, `~/.claude/skills`, `<proj>/.claude/skills`; inject ONLY the name+description index into the system prompt; load body on invoke; scripts via approval-gated bash; `metadata.trigger: command` registers the skill as a slash command. Every skill an agent can read, ox can read, with zero conversion code.

---

## 7. Cross-cutting gaps (the thesis)

Eight gaps survive across every tool surveyed. They are ox's reason to exist.

1. **Install bloat everywhere.** 232MB here, Python+uv+Node stacks there, Bun dependencies elsewhere. Nothing featherweight ships.
2. **Rug-pulls.** Gemini CLI sunset, Qwen free tier dead, Roo dead, Amp closed, Windsurf rebranded mid-flight. Users need a durable BYO-everything hedge that no vendor can retire.
3. **Cost opacity.** Quota drain bugs, unpublished Amp rates, Hermes's hidden aux-model billing ($145 surprises), token-hungry Cline days. Nobody shows a real-time ledger with hard caps.
4. **Telemetry opt-out, not opt-in.** Closed forks and forced updates compound distrust.
5. **Weak scriptability & CI semantics.** Exit codes, JSON streams, and pipe behavior are afterthoughts outside Claude Code and Codex.
6. **Local/offline is nominal, not real.** Antigravity demands accounts; Hermes's 64K floor locks out small local models despite advertising any-endpoint support.
7. **Fragmented persona/extension standards.** Skills vs recipes vs rules vs agents — five formats where one would do. Interop is left as an exercise for the user.
8. **Dishonest context management.** Advertised windows vs effective use diverge wildly (Cursor CLI ~5.5× inefficiency). No tool shows users how much context actually remains or what compaction will keep.

Each gap has a named owner in plan.md: zero-dep footprint (§0), hard pinning + BYOK presets (§3–4), cost ledger + caps (§16), no-telemetry-by-construction (§0), headless contract (§13), adaptive small-model context (§7), native Agent Skills + `.mcp.json` + AGENTS.md interop (§8–10), and the honest context meter (§7).

---

## Sources & further reading

- Claude Code docs & changelog — https://code.claude.com/docs
- Codex CLI repo & config guide — https://github.com/openai/codex
- Aider edit formats, repo map, LLM docs — https://aider.chat/docs/llms.html · https://aider.chat/docs/repomap.html
- Anthropic effective context engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- MCP specification (2025-11-25 legacy, 2026-07-28 current) — https://modelcontextprotocol.io/specification
- Agent Skills standard — https://agentskills.io · marketplaces https://skills.sh · https://skillsmp.com
- AGENTS.md — https://agents.md
- Provider API references — links in §4 table
- Papers — arXiv links inline in §3.7
- Field repos — inline links in §2 profiles

*End of dossier. Design consequences live in [plan.md](plan.md); competitive framing lives in [comparison.md](comparison.md).*

---

## 8. Platform absorption profiles (Sep 2026)

### 8.1 Atomic Agent (AtomicBot-ai/atomic-agent)
**Repo:** https://github.com/AtomicBot-ai/atomic-agent · License: MIT · Stack: Python/Node
**What it is:** A coding agent focused on parallel read-only tool batches, strict schema-constrained tool calling for small local models, and import adapters for migrating from Claude Code, Hermes, Codex layouts.
**Overlap with ox:** Both target BYOK multi-provider, local model support, skills/MCP interop. Atomic's parallel read batches and strict schema approach complement ox's agent loop.
**Absorbed into ox:** Parallel read-only tool batching (agent loop), strict schema path for small models (provider-side), import adapters for skills/MCP/memory (`ox import`), durable task store (`~/.ox/tasks/`), `ox serve` HTTP surface (Node http only), browser via MCP template only.

### 8.2 TrueForge (truefoundry/trueforge)
**Repo:** https://github.com/truefoundry/trueforge · License: Apache-2.0 · Stack: Python/Go/K8s
**What it is:** Enterprise AI developer platform with subagents, sandbox-as-tool, agent presets, and compaction/reconnect for long runs. Products: TrueForge Platform (cloud), R-CLI (open harness), Studio (UI).
**Overlap with ox:** Subagents (summary-return), sandbox seam, agent presets (`~/.ox/agents/*.json`), session compaction hardening.
**Absorbed into ox:** Subagents (already implemented in src/subagent.js), sandbox-as-tool seam (approval/sandbox profile engine), agent presets CLI (`ox agent list|save|use|delete`), compaction/reconnect hardening for `ox serve`. NOT absorbed: full Chat UI, Kubernetes product.

### 8.3 browser-harness (browser-use/browser-harness)
**Repo:** https://github.com/browser-use/browser-harness · License: MIT · Stack: Python/Playwright
**What it is:** Browser automation harness with CDP connection, structured tools (navigate, click, fill, extract), and eval framework.
**Overlap with ox:** Browser capability via MCP only. ox does not embed Playwright.
**Absorbed into ox:** `ox mcp add browser-harness` template, skill install instructions, default mcpPolicy=browser tools=ask, doctor notes for CDP failures.

### 8.4 Stagehand (browserbase/stagehand)
**Repo:** https://github.com/browserbase/stagehand · License: MIT · Stack: TypeScript/Playwright
**What it is:** Browser automation SDK with `act`/`observe`/`extract`/`agent` primitives. Runs on local Chromium or Browserbase cloud.
**Overlap with ox:** Browser automation primitives. Kept as external integration.
**Absorbed into ox:** Skill + optional MCP wrapper design exposing act/observe/extract/agent primitives. Document local vs cloud. No npm add to core.

### 8.5 Camoufox (daijro/camoufox)
**Repo:** https://github.com/daijro/camoufox · License: MIT · Stack: Python/Firefox
**What it is:** Anti-detect Firefox browser for automation. Avoids fingerprinting detection.
**Overlap with ox:** Optional browser backend for MCP profile.
**Absorbed into ox:** Document as optional anti-detect backend (`OX_BROWSER_PROFILE=camoufox`). Implementation lives in MCP server, not ox core. Note production-caution status from upstream.

### 8.6 Trawl (germondai/trawl)
**Repo:** https://github.com/germondai/trawl · License: MIT · Stack: Bun/Redis/Camoufox
**What it is:** Self-hosted web fetching with challenge solving (CAPTCHA, Cloudflare). Hard fetches for difficult sites.
**Overlap with ox:** Optional MCP/client for self-hosted instance.
**Absorbed into ox:** Optional MCP/client docs to talk to self-hosted Trawl. Do not embed Bun/Redis/Camoufox stack.

### 8.7 OpenWhispr (OpenWhispr/openwhispr)
**Repo:** https://github.com/OpenWhispr/openwhispr · License: MIT · Stack: Electron/Whisper.cpp
**What it is:** Local-first voice dictation app. Speech-to-text via Whisper.cpp, push-to-talk, paste-to-ox workflow.
**Overlap with ox:** Voice front-end integration.
**Absorbed into ox:** Voice integration path: pipe transcribed text into `ox -p -` or REPL. Skill: "Dictate with OpenWhispr → send to ox". Do not Electron-embed Whisper.

### 8.8 Unity MCP + Skills (all variants)
**Repos:** IvanMurzak/Unity-MCP, CoplayDev/unity-mcp, batihandev/unity-mcp-skills, Unity official `com.unity.ai.assistant`
**What they are:** Unity Editor MCP servers and skill packs for AI-driven game development. IvanMurzak = skills+MCP, CoplayDev = MCP, batihandev = skills docs, Unity official = relay.
**Overlap with ox:** Game development via MCP + skills.
**Absorbed into ox:** `ox mcp add unity` (and variants) templates, skill install path for unity-mcp-skills into `~/.agents/skills`, example `.mcp.json` for Unity repos, README "Game development with ox + Unity MCP".

### 8.9 Thuki (quiet-node/thuki)
**Repo:** https://github.com/quiet-node/thuki · License: MIT · Stack: Swift/SwiftUI (Apple Silicon only)
**What it is:** Local overlay UI for AI coding assistance. Floating window, context capture, prompt handoff.
**Overlap with ox:** Non-goal for merging overlay UI.
**Absorbed into ox:** Explicit NON-GOAL for overlay UI merge. Optional handoff docs: copy prompt / open cwd in ox from Thuki-style local ask. Note Apple Silicon-only constraint.

### 8.10 HeyClicky (heyclicky.com)
**What it is:** Consumer GUI/cloud buddy product for coding assistance. Cloud-hosted, account-bound.
**Overlap with ox:** Non-goal for consumer GUI/cloud product.
**Absorbed into ox:** Explicit NON-GOAL. Optional "export task to ox CLI" skill stub only if local API exists; otherwise document as out-of-scope with rationale. Not to be confused with Clicky web analytics (clicky.com).

### 8.11 Backboard.io (backboard.io)
**What it is:** Sovereign AI infrastructure company (Ottawa-based, founders Rob Imbeault/Jonathan Murray, pre-seed from Mistral VP et al. — public-source claims). Products: Backboard Platform API (model routing, persistent memory/state, RAG, embeddings, tool calling, multi-agent, adaptive context), R-CLI (open coding harness), Backboard Studio, memory/portable state claims, Terminal Bench marketing. Deploy modes: cloud/private cloud/on-prem/on-device. Pricing (public): Free / Education $5 / Developer $20 / Scale $400 + usage.
**Overlap with ox:** Model routing, memory, multi-agent, tool calling. ox = featherweight local agent; Backboard = infra+platform.
**Absorbed into ox (compatible):**
1. Provider/preset: Backboard as OpenAI-compatible endpoint via `OX_BASE_URL` / bot preset `backboard` if compatible; else document integration steps.
2. R-CLI coexistence skill: when to use Backboard R-CLI vs ox.
3. Memory bridge (optional): skill/docs for portable memory export/import without cloud lock-in.
4. Model routing bot: optional bot pointing at Backboard for multi-model routing with honest cost ledger.
5. Comparison section: Backboard = infra+platform with CLI wedge; ox = rug-proof local agent.
6. `docs/integrations/backboard.md` with setup, env vars, limits, "what ox will never outsource" (approvals, denylist, evidence-gated memory, telemetry-free).

### 8.12 Clicky (clicky.com) — web analytics
**What it is:** Web analytics SaaS (real-time tracking, heatmaps, goals). Not an AI coding agent.
**Overlap with ox:** Out of category.
**Absorbed into ox:** Document as out-of-category vs ox. Do not build analytics into ox. Optional skill to install Clicky snippet in web project if trivial — lowest priority.
