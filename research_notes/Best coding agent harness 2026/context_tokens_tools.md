# How leading AI coding agent harnesses manage context, tokens and tools (as of 2026-11-04)

Evidence labels used on every claim:
- **[IND]** measured by a party that does not sell the harness or technique being tested.
- **[VEN]** measured by the vendor or by the author of the technique. Treat as a claim with numbers.
- **[UNM]** design claim, documentation statement or opinion, with no measurement behind it.
- **[CODE]** a constant or behaviour read directly from the source at the named commit. This is fact about the code, not evidence that the technique helps. I searched the code but did not trace every call path, and I did not run any of it.

Source commits read (shallow clones, all fetched 2026-11-04): openai/codex `3e743d1` (2026-11-04), anomalyco/opencode `ffe6fed` (2026-11-04; sst/opencode resolves to the same commit), google-gemini/gemini-cli `89e9d25` (2026-11-03), NousResearch/hermes-agent `71736c9f` (2026-11-03), badlogic/pi-mono `676af1d` (2026-11-03), OpenHands/software-agent-sdk `2f2cd2b` (2026-11-04), Aider-AI/aider `5dc9490` (2026-05-22, the newest commit on the default branch, so development has slowed). Claude Code, Droid, Cursor and Amp are closed source, so their entries rest on docs, vendor posts and third-party traffic captures.

## How each harness handles context: compaction, thresholds, clearing tool results, caching

### Takeaway
The field agrees on three things: exact-prefix caching with static content first, some form of tool-result clearing or externalisation, and summarising only as a fallback. It disagrees on trigger points, which run from 50% of the window (Gemini CLI, Hermes) to about 97% (Claude Code on 1M models). Thresholds are mostly unmeasured choices. The best-supported findings are that observation masking is about as good as LLM summarisation at much lower complexity [IND], and that caching saves 41-81% with the static prefix driving almost all of it [IND].

### Cited Findings

**Comparison table of compaction triggers and tool-output limits**

| Harness | Auto-compact trigger (default) | Compaction method | Tool-result handling | Label |
|---|---|---|---|---|
| Claude Code | At the model limit generally; about 967K on native-1M models; 200K boundary for Sonnet/Opus 4.6 without extended context; settable 100K-1M via `/autocompact`, `autoCompactWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ([model-config docs](https://code.claude.com/docs/en/model-config)) | Forked summarisation request sharing the parent's prefix ([caching post](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)); also idle compaction when on 1h TTL ([docs](https://code.claude.com/docs/en/prompt-caching)) | Clears old tool results and counts that as an "expected rebuild" ([costs docs](https://code.claude.com/docs/en/costs)); Bash inline to about 30,000 chars then a file plus 2,000-char preview; failures about 10,000 chars head-and-tail; Read at most 25,000 tokens per call and refuses a whole file over 256 KB; WebFetch 100,000 chars ([tools reference](https://code.claude.com/docs/en/tools-reference)); MCP warning at 10,000 tokens, cap 25,000, text over 50,000 chars saved to file, errors over about 11,000 chars keep first and last 5,000 ([MCP docs](https://code.claude.com/docs/en/mcp)) | [UNM] docs |
| Codex CLI | `min(configured, 90% of window)`; usable window is 95% ([openai_models.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/protocol/src/openai_models.rs)). Most catalog entries are 272K, so about 245K ([models.json](https://github.com/openai/codex/blob/3e743d1/codex-rs/models-manager/models.json)) | Local summary or remote compaction v2 (`compact_remote_v2.rs`); keeps up to 20,000 tokens of user messages ([compact.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/compact.rs)). A `token_budget` feature (stage UnderDevelopment) skips summarising and installs a fresh context window, with a `new_context` tool ([compact_token_budget.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/compact_token_budget.rs), [spec](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/tools/handlers/new_context_window_spec.rs)) | Tool output truncated to 10,000 tokens per model entry, middle-truncated; exec capture cap 1 MiB; AGENTS.md cap 32 KiB ([unified_exec](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/unified_exec/mod.rs), [pty](https://github.com/openai/codex/blob/3e743d1/codex-rs/utils/pty/src/lib.rs)) | [CODE] |
| Factory Droid | `compactionTokenLimit`, model-dependent, per-model override, `compactionModel` defaults to session model ([settings](https://docs.factory.com/droid-cli/settings)); BYOK default limit 250,000 per [BYOK docs](https://docs.factory.com/model-independence/byok) (seen in a search excerpt, not on a full page read) | Anchored iterative summary (intent, file changes, decisions, next steps; only the new span is summarised and merged) as of Dec 2025 ([Factory](https://factory.com/news/evaluating-compression)); summary budget raised from 8,000 to 16,000 tokens in Oct 2026 because a third or more hit the cap ([Droid 1.0](https://factory.com/news/frontier-harness)) | Script mode keeps raw output inside the program; printed output capped, full results logged; numeric caps not published ([Droid 1.0](https://factory.com/news/frontier-harness)) | [UNM]/[VEN] |
| Cursor | Not published | Summarisation, with a pointer to the chat-history file so the agent can search lost detail ([dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery), Jan 2026). A more expensive summarisation model made negligible quality difference and was shelved ([harness post](https://cursor.com/en-US/blog/continually-improving-agent-harness), Apr 2026) | Long shell and MCP output written to a file instead of truncated; agent uses `tail` then reads further; terminal sessions synced to files ([same](https://cursor.com/blog/dynamic-context-discovery)) | [UNM] except noted |
| Amp | Not published | Conflict: Amp announced removing compaction for user-driven Handoff in Nov 2025 ([Amp](https://ampcode.com/news/handoff)); current docs say a system model compacts long conversations and Task subagents compact "the same way" as threads ([docs](https://ampcode.com/docs/models-and-subagents)) | Not found | [UNM] |
| Aider | History summarised by the weak model once over `max_chat_history_tokens`, which is 1/16 of max input, clamped 1,024-8,192 ([models.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/models.py), [history.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/history.py)) | Recursive summary of older chat | User chooses files; no tool-call schema in the classic flow (inference from `coders/`) | [CODE] |
| OpenHands SDK | Event-count or token based: `LLMSummarizingCondenser` default `max_size=240` events, `keep_first=2`, optional `max_tokens`; GPT-5 preset `max_size=80`, planning preset 100/6 ([condenser](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py), [gpt5 preset](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-tools/openhands/tools/preset/gpt5.py)) | Rolling condenser, reduces to half | Terminal output truncated at 30,000 chars; default text limit 50,000 ([terminal constants](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-tools/openhands/tools/terminal/constants.py), [truncate.py](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-sdk/openhands/sdk/utils/truncate.py)) | [CODE] |
| Hermes | Default 50% (`threshold_percent=0.50`), target ratio 20%, protect first 3, protect last 20 messages per config display; per-model thresholds exist. `context_engine.py` base class says 0.75 and last 6, so subclasses override ([context_compressor.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/agent/context_compressor.py), [config_show.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/hermes_cli/config_show.py)) | Prune first, then summarise middle turns with a cheap model ([example config](https://github.com/NousResearch/hermes-agent/blob/71736c9f/cli-config.yaml.example)) | Old outputs replaced with a placeholder; results over 100,000 chars persisted with 1,500-char preview; 200,000 char per-turn budget; MCP 50,000; `read_file` never persisted, capped at 100,000 chars ([budget_config.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/tools/budget_config.py), [file_tools.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/tools/file_tools.py)) | [CODE] |
| opencode | Overflow-based with `RESERVE_MIN=16,000`, `SUMMARY_OUTPUT_FLOOR=32,000`, 200,000 assumed for unknown windows; precomputes above 64,000 tokens, tail minimum 30,000 ([compaction.ts](https://github.com/anomalyco/opencode/blob/ffe6fed/packages/core/src/session/compaction.ts)). Exact trigger not traced | Checkpoint summary updated across compactions with "Work State" and "Next Move" sections (same file) | 2,000 lines, 50 KiB, then spilled; 2,000-char line cap ([tool-output.ts](https://github.com/anomalyco/opencode/blob/ffe6fed/packages/core/src/tool-output.ts), [read-filesystem.ts](https://github.com/anomalyco/opencode/blob/ffe6fed/packages/core/src/tool/read-filesystem.ts)) | [CODE] |
| Gemini CLI | 50% of window; preserves newest 30% ([chatCompressionService.ts](https://github.com/google-gemini/gemini-cli/blob/89e9d25/packages/core/src/context/chatCompressionService.ts)) | Summary, with a 50,000 token budget for function responses before older large ones are truncated (same file) | Output masking: protection threshold 50,000, minimum prunable 30,000, latest turn protected, outputs stored in `tool-outputs` ([toolOutputMaskingService.ts](https://github.com/google-gemini/gemini-cli/blob/89e9d25/packages/core/src/context/toolOutputMaskingService.ts)); truncation threshold 40,000 (unit not checked); read 2,000 lines, 2,000-char lines ([constants.ts](https://github.com/google-gemini/gemini-cli/blob/89e9d25/packages/core/src/utils/constants.ts)) | [CODE] |
| Pi | Reserve 16,384, keep recent 20,000 tokens ([compaction.ts](https://github.com/badlogic/pi-mono/blob/676af1d/packages/coding-agent/src/core/compaction/compaction.ts)) | Summary plus recent tail | 2,000 lines, 50 KB ([truncate.ts](https://github.com/badlogic/pi-mono/blob/676af1d/packages/coding-agent/src/core/tools/truncate.ts)) | [CODE] |

**Provider APIs that harnesses build on**
- Anthropic context editing: `clear_tool_uses_20250919`, default trigger 100,000 input tokens, keep 3 tool uses, options `clear_at_least`, `exclude_tools`, `clear_tool_inputs`; `clear_thinking_20251015`. Clearing invalidates cached prefixes, so `clear_at_least` exists to justify the write ([docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)). [UNM]
- Anthropic server compaction: `compact_20260112`, default trigger 150,000, minimum 50,000, `pause_after_compaction`; custom `instructions` replace the default prompt; add breakpoints on the compaction block and system prompt; top-level usage excludes compaction iterations, so sum `usage.iterations` ([docs](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)). On-demand compaction with kept turns and background mode uses beta `compact-2026-09-04` ([overview](https://platform.claude.com/docs/en/build-with-claude/compaction)). [UNM]
- OpenAI's `/responses/compact` returns opaque output per [Factory](https://factory.com/news/evaluating-compression). OpenAI's "Unrolling the Codex agent loop" post returned HTTP 403 to my fetch, so I only saw [secondary summaries](https://second-brain-nuxt.vercel.app/unrolling-the-codex-agent-loop): stateless requests, each prompt an exact prefix of the next, and cache misses from changing tools, model or sandbox. Not verified at the source.

**Caching practice**
- Claude Code layout, static system prompt and tools, then CLAUDE.md and memory, then session context, then messages. Updates go into `<system-reminder>` in messages rather than the system prompt. Plan mode is a pair of tools, so the tool set never changes. Past breakages: a timestamp in the system prompt, non-deterministic tool order, changed Agent tool parameters. Hit rate is alerted on and drops are treated as SEVs. Published April 30, 2026 ([Anthropic](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)). [UNM, no rates given]
- Claude Code tool list is frozen from the first request when tools are deferred, so a server connecting mid-session leaves the cache intact. Invalidators: model, effort on most models, fast mode, MCP changes without tool search, whole-tool deny rules, compaction, image eviction, upgrades. Default TTL is 1h on the main conversation for subscribers, 5m otherwise and for subagents. A same-prefix workflow fan-out holds followers up to 5 seconds so they read the first agent's write. `/usage` reports hit share, misses and likely cause ([docs](https://code.claude.com/docs/en/prompt-caching)). [UNM]
- Droid: 98% median request cache read, 91.5% token-weighted, 98.6% of requests strictly append-only, over 20.4M CLI requests in 7 days excluding CI and evals. New tools append to the end of the request. Failed requests retry on the provider holding the cache. Next-request reuse in tests: git status change 99.1%, rollback 99.8%, second same-type subagent 96.5%, new tool 100% ([Factory, Oct 29 2026](https://factory.com/news/frontier-harness)). [VEN]
- Systima captured traffic and found Claude Code 2.1.207 used three request classes (warmup probe, main, subagent) with separate cache entries, varied system bytes between sessions, and rewrote about 37-50K tokens mid-task, while OpenCode 1.17.18 prefixes were byte-identical. Cache-write ratio was 5.9x to 54x depending on temperature ([Systima, Jul 12 2026](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)). [IND, small sample, through a gateway, version now about 100 releases old per [the docs' version numbers](https://code.claude.com/docs/en/costs)]
- Hermes uses 4 breakpoints, static system prefix then last messages ([prompt_caching.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/agent/prompt_caching.py)); opencode caps at 4 and drops extras with a warning ([cache.ts](https://github.com/anomalyco/opencode/blob/ffe6fed/packages/ai/src/protocols/utils/cache.ts)); Aider caching is off by default, `--cache-prompts`, with breakpoints on examples or system, repo map and chat files, and keepalive pings default 0 ([args.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/args.py), [chat_chunks.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/coders/chat_chunks.py)); OpenHands has `caching_prompt` and retries uncached if a prompt is too small ([llm.py](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-sdk/openhands/sdk/llm/llm.py)); Codex sets and tracks a `prompt_cache_key` ([client.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/client.rs)). [CODE]

### Inferences
- A low trigger (50%) is cheap per request but pays summary and rebuild costs more often. A high trigger (97% of 1M) keeps the prefix longer but makes each request large. No published study compares trigger points on coding tasks, so all these defaults are engineering judgment.
- Three designs now avoid destructive truncation: spill-to-file with a preview (Claude Code, Cursor, Hermes, opencode, Gemini), keep raw output in a program (Droid Script, Codex code mode), and start a fresh window (Codex `token_budget`, Amp Handoff, Droid `/handoff`).
- The Amp conflict most likely means compaction returned or was never fully gone, but I could not find a post saying so.

### Gaps
- Cursor and Amp publish no thresholds. Droid publishes no tool-output caps.
- I found no independent hit-rate data for any harness other than Systima's small sample.
- Codex's `token_budget` activation path and whether remote compaction is the default were not traced.
- A [user report](https://claudeissues.com/issue/86863-bug-auto-compact-threshold-silently-regressed-fires-at-73-context-used-previousl) of Claude Code's threshold moving from about 83% to 73% was seen only through a search excerpt on a mirror site, and I did not verify it. It concerned an earlier version than the current docs describe.

## Tool design: deferred loading, tool counts, schema size, edit formats, code graphs, read limits

### Takeaway
The leaders send far fewer tool definitions up front than in 2025: MCP tools are deferred in Claude Code by default, and Droid went from 11 to 2 tools plus a script tool. Edit format matters mainly for weaker models, and the strongest public claim (hashline) failed partial replication. Code graphs and semantic search have small or self-reported gains so far, with one well-described online A/B showing only 0.3% (2.6% on large repos).

### Cited Findings

**Tool count and schema size**
- Claude Code 2.1.207: 27 tools, 99,778 chars on Sonnet 4.5 path; on Fable 5 tools shrank to 82,283 chars and system prompt to 10,526 chars. OpenCode 1.17.18: 10 tools, 20,856 chars ([Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)). [IND]
- Real configurations are far larger: OpenCode with 11 MCP servers 179 tools, 277 KB schemas, 90,817-token cold write; Claude Code with 4 MCP servers and plugins 118 tools, 311 KB payload, about 75,000 tokens ([Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)). [IND, one practitioner's setup]
- Droid 1.0: up-front tools 11 to 2, rarely used tools load on demand, tool definition tokens 15,798 to 8,528 (the figure says -46%, the text 45%) ([Factory](https://factory.com/news/frontier-harness)). [VEN]
- OpenHands defaults: terminal, file editor, task tracker, optional browser ([default preset](https://github.com/OpenHands/software-agent-sdk/blob/2f2cd2b/openhands-tools/openhands/tools/preset/default.py)). Pi ships bash, edit, find, grep, ls, read, write in `tools/`; [a third-party article](https://codex.danielvaughan.com/2026/04/19/system-prompts-compared-codex-gemini-claude-code/) says 4 are active by default, which I did not confirm in code. [CODE]

**Deferred tool loading**
- Claude Code: MCP tools deferred by default; `ENABLE_TOOL_SEARCH` values unset or `true`, `auto` (load upfront under 10% of window), `auto:N`, `false`. Description cap 4,096 chars upfront, 16,384 chars through search; `alwaysLoad` per tool ([docs](https://code.claude.com/docs/en/mcp)). Stubs are name-only with `defer_loading: true`, kept in stable order ([Anthropic](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)). [UNM]
- Cursor: per-server folders of tool descriptions, names up front, agent looks up with `rg` or `jq`; chosen over a flat search index ([Cursor](https://cursor.com/blog/dynamic-context-discovery)). [UNM for the design]
- Codex: `tool_search` tool, default limit 8, deferred exposure in the router, `defer_loading` in specs, namespace descriptions truncated to a byte budget ([tool_discovery.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/tools/src/tool_discovery.rs), [router.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/tools/router.rs), [tools_budget.rs](https://github.com/openai/codex/blob/3e743d1/codex-rs/core/src/context/world_state/tools_budget.rs)). The feature keys `tool_search` and `tool_search_always_defer_mcp_tools` are stage `Removed` in [features](https://github.com/openai/codex/blob/3e743d1/codex-rs/features/src/lib.rs). The handler remains, which suggests the flag was retired rather than the feature, but I did not confirm this. [CODE]
- Hermes: `tools/tool_search.py` with a catalog and `tools.tool_search.defer` ([toolsets.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/toolsets.py)). [CODE]
- Gemini CLI: no deferred or tool-search match in [tool-registry.ts](https://github.com/google-gemini/gemini-cli/blob/89e9d25/packages/core/src/tools/tool-registry.ts); a `jit-context.ts` tool file exists. Absence of a grep match is weak evidence. [CODE]
- Programmatic tool calling: Droid Script mode on by default for ten listed models ([Factory](https://factory.com/news/frontier-harness)); Codex `code_mode` is UnderDevelopment while `code_mode_host` is Stable ([features](https://github.com/openai/codex/blob/3e743d1/codex-rs/features/src/lib.rs)). [CODE]/[UNM]

**Edit tool formats**
- Claude Code: string replace via Edit ([tools reference](https://code.claude.com/docs/en/tools-reference)). Codex: freeform `apply_patch` on all sampled catalog models ([models.json](https://github.com/openai/codex/blob/3e743d1/codex-rs/models-manager/models.json)). Opencode: `patch.txt` in core tools ([tool dir](https://github.com/anomalyco/opencode/tree/ffe6fed/packages/core/src/tool)). Aider: many, including whole, diff, udiff, patch and an editor pair ([coders](https://github.com/Aider-AI/aider/tree/5dc9490/aider/coders)), unknown models default to whole ([Aider docs](https://aider.chat/docs/more/edit-formats.html)).
- Cursor gives each model the format it was trained on: patch for OpenAI, string replace for Anthropic ([Cursor](https://cursor.com/en-US/blog/continually-improving-agent-harness)). [UNM]
- Hashline (lines tagged with a 2-3 char content hash): 16 models, 180 tasks, 3 runs each, React codebase mutations. Beats patch on 14 of 16, average +15 points; Grok Code Fast 1 +64.6 points and about 49% fewer output tokens; patch failure 50.7% on Grok 4, 46.2% on GLM-4.7. GPT-5.2 Codex -0.4 and DeepSeek V3.2 -8.3 versus patch ([Bölük, Feb 2026](https://stencil.so/blog/the-harness-problem)). [VEN, the author built hashline; about $300 spent; code in `omp` repo]
- Partial non-replication: 3 models, Python/TS/Rust, 20 tasks each, single attempt. Gemini 3 Flash replace 95/80/95 vs hashline 70/85/90; Qwen 90/85/85 vs 85/85/90; gpt-4.1-mini 65/75/45 vs 50/70/55. Between-model gaps exceed between-format gaps, and the fuzzy matching cascade never fired across 134 replace edits. Author calls the sample small and argues Bölük's JS-only benchmark is confounded by LSP feedback ([nwyin](https://dev.to/nwyin/hashline-vs-replace-does-the-edit-format-matter-15n2)). [IND, small]
- Line numbering on reads costs about 2 tokens per line and raised cost on GLM by 8% and Kimi by 32%, so Droid made it opt-in ([Factory](https://factory.com/news/frontier-harness)). [VEN]
- AST-targeted edits beat search/replace and unified diff in a [small test by a party promoting the format](https://hn.jakechampion.name/reader/https://geometricagi.github.io/2026/04/02/ast-edits.html), seen via search excerpt only. [VEN, unverified]
- Apply models: Relace claims 10k+ tokens/s and [Morph V3 Fast is listed](https://openrouter.ai/morph/morph-v3-fast) at about 10,500 tokens/s with 96% accuracy, in listings with no method. Morph argues tokens/s is the wrong metric and cites a 50-repo end-to-end benchmark, whose numbers are in chart images I could not read ([Morph](https://www.morphllm.com/blog/fast-apply-fast-agents.md)). [VEN]
- Aider's 2023 GPT result favouring whole-file as most reliable is [old and predates current models](https://aider.chat/docs/benchmarks). [VEN, pre-2025]

**Code graph, repo map and retrieval**
- Aider repo map: tree-sitter tags, personalised PageRank, default budget `max_input/8` clamped 1,024-4,096 tokens, multiplied by 2 when no files are in chat, cached as a separate block ([repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/repomap.py), [models.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/models.py), [args.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/args.py)). [CODE] I found no controlled measurement of its token or success effect.
- Cursor semantic search: offline accuracy +12.5% on average (6.5-23.5% by model) on its own Context Bench; online A/B code retention +0.3%, +2.6% on repos of 1,000+ files; dissatisfied follow-ups +2.2% without it ([Cursor, Nov 2025](https://cursor.com/blog/semsearch)). [VEN]
- Cursor retired earlier static context (folder layout, semantically matched snippets, compressed files) in favour of pulled context ([Cursor](https://cursor.com/en-US/blog/continually-improving-agent-harness)). [UNM]
- Claude Code offers LSP through plugins, claiming fewer file reads with no numbers ([docs](https://code.claude.com/docs/en/costs)). [UNM]
- CodeGraph reports 62% token cut and 88% fewer tool calls over 7 repos in [a write-up](https://pasqualepillitteri.it/es/news/11127/codegraph-reducir-tokens-agente-codigo); [an older listing](https://vibeindex.ai/mcp/colbymchenry/codegraph) says 35% cost and 57% tokens. The figures disagree, and both come via secondary pages. [VEN, unverified]
- CodeCompass exposes a Neo4j dependency graph over MCP to Claude and compares it with baseline and BM25 ([arXiv 2602.20048](https://www.arxiv.org/pdf/2602.20048)). I did not read its results. XCE self-reports about 20% token reduction on SWE-bench Verified with mini-SWE-agent ([dev.to](https://dev.to/kyoma_1234/how-a-002call-model-scored-782-on-swe-bench-verified-beating-every-model-on-the-leaderboard-4bm3)). [VEN, unverified]

**Read limits are close to a de facto standard**
- 2,000 lines and 50 KB in opencode and Pi; 2,000 lines and 2,000-char lines in Gemini CLI; Claude Code uses token and size limits instead (25,000 tokens, 256 KB); Hermes 100,000 chars. Sources in the table above. [CODE]/[UNM]

### Inferences
- Stable tool list plus deferred schemas serves both cost and cache stability. Deferred stubs let a harness add tools without moving the prefix, which matches the caching paper's advice to keep the tool set fixed.
- Edit format is a per-model decision rather than a harness-wide one. Evidence is strongest for weak or non-native models and near zero for frontier models on their native format.
- The gap between Cursor's offline +12.5% and online +0.3% is a useful warning about offline retrieval evals, though Cursor notes that not every query needs search.

### Gaps
- Exact current tool lists and schema sizes for Claude Code (post v2.1.207), Cursor and Amp could not be verified. Amp's [manual](https://ampcode.com/manual) did not give them, and I did not fetch its tools page.
- Cursor's Instant Apply: no current figures found.
- No independent head-to-head for code graphs on a public benchmark was found.

## Baseline token overhead per request: what has actually been measured

### Takeaway
Only Claude Code, OpenCode and Codex CLI have third-party request-level measurements, and each is a small sample of one version. Droid's number is vendor-reported. Nothing credible exists for Cursor, Amp, Aider, OpenHands or Hermes.

### Cited Findings

| Harness and version | First-request input tokens | Who, how | Label |
|---|---|---|---|
| Claude Code 2.1.207, Sonnet 4.5 | About 32,800 (system 27,344 chars, tools 99,778 chars, first-message scaffolding 7,997 chars) | [Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead), logging proxy, 3 runs, gateway envelope subtracted, Jul 2026 | [IND] |
| OpenCode 1.17.18 | About 6,900 (system 9,324 chars, tools 20,856 chars) | Same | [IND] |
| Same pair on Fable 5 | Gap narrows to about 3.3x from 4.7x | Same, 2 runs | [IND] |
| Codex CLI 0.114.0 | 8,497 (8,448 cached), other minimal runs 8,151-8,242; about 10,142 with author's config | [Alex Fazio gist](https://gist.github.com/alexfazio/359c17d84cb6a5af12bac88fa1db9770), `input_tokens` from `codex exec --json`, Mar 2026, single runs | [IND] |
| Codex component deltas | `multi_agent` +1,643 to +1,984; `apps` +473; `artifact` +432; replacing the default prompt about -2,533 | Same | [IND] |
| Droid before and after 1.0 | 20,887 to 13,055 on "hi" (tools 8,528, startup reminders 2,362, system prompt 2,155) | [Factory](https://factory.com/news/frontier-harness), Oct 2026 | [VEN] |
| Gemini CLI | 13,055 for two trivial queries, single user report; about 10,000-13,000 estimated | [Article citing issue #3784](https://codex.danielvaughan.com/2026/04/19/system-prompts-compared-codex-gemini-claude-code/) | [UNM, weak] |
| Pi | Under 1,000 estimated from prompt source | [Same article](https://codex.danielvaughan.com/2026/04/19/system-prompts-compared-codex-gemini-claude-code/); `system-prompt.ts` is 9,964 bytes of source, which includes code | [UNM] |

**Task-level measurements from Systima, not just floor**
- File summary: Claude Code 6 requests and about 199K cumulative input vs OpenCode 4 requests and about 41K. FizzBuzz write-and-fix: 3 parallel-batched requests and about 121K vs 9 requests and about 132K, so parallel batching can erase the floor gap. Ten-assertion date task: both 5/5, about 268K vs about 72K, 4-8 min vs 1-2 min ([Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)). [IND]. This resolves an apparent conflict in secondary write-ups, which quote 268K/72K or 121K/132K as if they were the same task.
- Multipliers: 72 KB instruction file adds about 20,000 tokens per request to both; MCP about 1,000-1,400 per small server per request. Claude Code 2.1.207 read only `CLAUDE.md`, ignoring `AGENTS.md` (same source). [IND]
- Subagents in Claude Code: 2.6x-5.9x input tokens over sequential on matched tasks, no fan-out faster; Haiku-pinned subagents 37% fewer tokens than inherited Opus ([Systima](https://systima.ai/blog/subagent-tax)). [IND, through gateway that may distort cache attribution]
- Anthropic says agent teams use about 7x tokens in plan mode, and enterprise cost averages about $13 per active developer day, $150-250 per month ([docs](https://code.claude.com/docs/en/costs)). [VEN]
- Aggregate comparisons. GitHub: same model and task, normalised window and effort, 5 runs per configuration; Copilot CLI lower tokens than Claude Code in every benchmark, and lower than Codex except SWE-bench Verified (+7% GPT-5.4, +4% GPT-5.5). Numbers are in charts I could not read ([GitHub, Jun 2026](https://github.blog/ai-and-ml/github-copilot/evaluating-performance-and-efficiency-of-the-github-copilot-agentic-harness-across-models-and-tasks/)). [VEN]. Factory: Droid 17% fewer tokens and 26% less time per passed task than Claude Code on Opus 5.5; 12% fewer tokens but 10% slower than Codex on GPT-6.1 Sol ([Factory](https://factory.com/news/frontier-harness)). [VEN]

**Figures to treat with care**
- [Daniel Vaughan's April estimate](https://codex.danielvaughan.com/2026/04/19/system-prompts-compared-codex-gemini-claude-code/) of 6,000-10,000 for Claude Code conflicts with Systima's 32,800. Systima measured traffic, and the estimate came from unpacking the npm bundle, so prefer Systima.
- [Kunal Ganglani's write-up](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead.md) has cost projections and 40%/90% hit rates that are the writer's model, and I did not find those hit rates in Systima's post.
- The number 13,055 appears for both Droid and the Gemini CLI issue. They are unrelated; do not merge them.

### Inferences
- Floor ranking from these unmatched snapshots: Pi (estimate) < OpenCode < Codex < Droid and Gemini < Claude Code at v2.1.207. Versions, dates and models differ, so this is rough ordering only.
- Floor tokens matter less than cache behaviour and request count, since cached floor bytes cost about a tenth. The FizzBuzz result shows round-trip count can dominate.

### Gaps
- No same-day, same-model, multi-harness floor measurement exists in what I found. [A²E (arXiv 2608.07346)](https://arxiv.org/abs/2608.07346) says it compares harnesses on GPT-5.6-Sol, but its PDF exceeded my fetch limit and the abstract has no figures, and a [search excerpt](https://arxiv.org/pdf/2608.07346) says some harnesses spend more tokens without higher success.
- No credible baseline for Cursor, Amp, Aider, OpenHands or Hermes. Current Claude Code (well past v2.1.207) has not been remeasured in anything I found.

## Techniques with published measured gains

### Takeaway
The best evidence supports prompt caching (41-81%), masking old tool output (cost about halved, mixed solve-rate effect), and deferred tools (47-85%, vendor only). Context files have a mixed record. Compaction quality differences are small and vendor-measured, and all methods score poorly on tracking files.

### Cited Findings

**Prompt caching, independent, peer-style.** "Don't Break the Cache": 40 sessions per model and condition, 10K system prompt, DeepResearch Bench (web search, not coding), Deep Agents library, t-tests ([arXiv 2601.06007v2](https://arxiv.org/html/2601.06007v2), Jan 2026). [IND]

| Model | Full context: cost / TTFT | System prompt only | Exclude tool results |
|---|---|---|---|
| GPT-5.2 | 79.3% / 9.5% | 81.4% / 10.5% | 79.6% / 13.0% |
| Claude Sonnet 4.5 | 77.8% / 21.8% | 78.5% / 22.9% | 78.1% / 20.9% |
| Gemini 2.5 Pro | 38.3% / 6.0% | 41.4% / 6.1% | 27.8% / -2.9% |
| GPT-4o | 47.8% / -8.8% | 45.9% / 30.9% | 46.8% / 28.1% |

Strategies differ by only 2-4 points per model. At 50K prompts savings reach 89% (GPT-5.2) and 88% (Sonnet). Minimum cacheable sizes matter: below them TTFT regressed 10-18%. Advice: dynamic values at the end of the system prompt, fixed tool set.

**Observation masking versus summarisation, independent of the method's vendors.** "The Complexity Trap": SWE-agent, SWE-bench Verified (500 instances), 5 model configurations, masking window M=10, summary N=21 and M=10, turn limit 250 ([JetBrains Research, arXiv 2508.21433v3](https://arxiv.org/html/2508.21433v3), NeurIPS 2025 DL4C workshop, code and data public). [IND]. Observations are about 84% of an average turn's tokens.

| Model | Raw solve / cost | Masking solve / cost | LLM summary solve / cost |
|---|---|---|---|
| Qwen3-32B | 17.0% / $1.12 | 15.0% / $0.55 | 16.0% / $0.50 |
| Qwen3-32B thinking | 23.0 / 0.51 | 24.6 / 0.46 | 24.8 / 0.51 |
| Qwen3-Coder 480B | 53.4 / 1.29 | 54.8 / 0.61 | 53.8 / 0.64 |
| Gemini 2.5 Flash | 32.8 / 0.41 | 35.6 / 0.18 | 36.0 / 0.24 |
| Gemini 2.5 Flash thinking | 40.4 / 0.56 | 36.4 / 0.24 | 31.4 / 0.25 |

Hybrid: 7% cheaper than masking and 11% cheaper than summary, on a 50-instance subset of one model. OpenHands: masking window had to be retuned to M=58 to match summary, on 50 instances, which the authors call initial evidence. Note the gains are not universal: solve rate fell on 2 of 5 configurations, by up to 22% relative for summary.

**Context editing.** 84% token reduction on a 100-turn web search eval; 29% performance gain alone and 39% with memory tool on an internal agentic search eval ([Anthropic, Sep 2025](https://claude.com/blog/context-management)). [VEN]. Not coding, and metric definitions were not given. Some secondary pages attach the 84% to the combined setup, while Anthropic's post ties it to context editing.

**Deferred tools.** Anthropic: about 77K to about 8.7K before work starts (stated as 85%, though those numbers come to about 89%); 134K internal tool definitions before optimisation; accuracy Opus 4 49% to 74%, Opus 4.5 79.5% to 88.1%, on undisclosed MCP evals ([Nov 2025](https://www.anthropic.com/engineering/advanced-tool-use)). [VEN]. Cursor A/B: 46.9% fewer total agent tokens in runs that called an MCP tool, statistically significant, high variance by number of servers ([Jan 2026](https://cursor.com/blog/dynamic-context-discovery)). [VEN]. Some sites misattribute the 46.9% to Anthropic.

**Programmatic tool calling.** Anthropic: 43,588 to 27,297 average tokens (37%) on complex research tasks; knowledge retrieval 25.6% to 28.5%; GIA 46.5% to 51.2%; tool examples 72% to 90% on parameter handling ([same post](https://www.anthropic.com/engineering/advanced-tool-use)). [VEN, no sample sizes]. Droid Script: 15% lower cost than direct calls on Opus 5.5. Example runs: 312 calls in 2 requests and about 61K tokens vs a modelled 36 requests and about 3.1M; CI sweep had under 0.1% of tool results reach context ([Factory](https://factory.com/news/frontier-harness)). [VEN, direct-call side modelled, not run]

**Whole-harness tuning.** Terminal-Bench 4, all tasks, 3 trials per task and harness, Oct 23-28 2026: Opus 5.5 Droid 65.2%, Cursor 62.1%, OpenCode 62.1%, Devin 59.6%, Claude Code 57.6%. GPT-6.1 Sol Droid 57.6%, Codex 54.0%, OpenCode 51.0%, Devin 45.0% ([Factory](https://factory.com/news/frontier-harness)). [VEN]. Caveats: Factory ran it; cost comparisons use only tasks both harnesses passed all three times; failed trials from outside causes were rerun; blocked Opus 5.5 trials were rerun on Opus 5; Devin question stops were counted as passed if Codex passed. A survey separately reports a 13.7 point spread for GPT-5.3-Codex between Terminus 2 and SageAgent on Terminal-Bench 2.0 ([arXiv 2606.20683](https://arxiv.org/pdf/2606.20683)), seen in a search excerpt only.

**Compaction quality.** Probe-based, 36,611 messages, hundreds of compression points, GPT-5.2 judge. Overall out of 5: Factory 3.70, Anthropic 3.44, OpenAI 3.35. Artifact tracking: 2.45, 2.33, 2.19. Compression removed 98.6%, 98.7% and 99.3% ([Factory, Dec 2025](https://factory.com/news/evaluating-compression)). [VEN]. No confidence intervals, undisclosed weights, and Factory summaries came from production while the others came through APIs. Cursor found no quality gain from a pricier summariser ([Cursor](https://cursor.com/en-US/blog/continually-improving-agent-harness)). [VEN, no numbers]

**Context files.** ETH Zurich: AGENTS.md raises inference cost over 20% on average without generally improving success ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988)). [IND]. Lulla et al.: on 124 PRs, median runtime -28.64% and output tokens -16.58% with comparable completion ([arXiv 2601.20404](https://arxiv.org/abs/2601.20404), seen via search summary). [IND, observational]. These conflict. Secondary pages quote -3% for generated and +4% for human files, which I did not verify in the ETH paper.

**Smaller engineering numbers worth copying.** Droid: turn preparation 24 ms; stuck detection nudges at 3 identical tool calls and stops at 6, stops after 3 turns with no visible output ([Factory](https://factory.com/news/frontier-harness)). [UNM for effect]. Cursor tool-reliability sprint: unexpected tool errors down an order of magnitude ([Cursor](https://cursor.com/en-US/blog/continually-improving-agent-harness)). [VEN]

### Inferences
- Effect size order for cost, roughly: caching, then masking or clearing old outputs, then deferring tools (only when MCP is large), then programmatic calling, then edit format (only for weak models). No study tests them together, so effects should not be added.
- Masking breaks the cache at each clear, so a batched clear with `clear_at_least` style hysteresis is needed. The Complexity Trap's cost numbers should not be assumed to carry over unchanged under caching; I did not confirm how it priced cached tokens.

**Checklist to run against ox's code** (inference from the above; each item is checkable):
1. Byte-compare the request prefix across turns and sessions; count mid-session cache rewrites; log a likely cause per miss.
2. No timestamps, git status or tool changes in the system block; updates arrive as appended messages; tool order deterministic.
3. Compaction uses the same system prompt and tools as the parent, with only a final user message added.
4. Failed requests retry on the same provider; side calls (title, summary) do not burst the main prefix.
5. Old tool outputs masked or cleared in batches before any LLM summary; placeholders kept; most recent output protected.
6. Large outputs spill to a file with a preview rather than being cut; head-and-tail for errors; per-turn budget.
7. MCP tools deferred with name-only stubs in fixed order; description length capped; tool list frozen at first request.
8. Report first-request input tokens for "hi" by system, tools and reminders, comparing against 6,900 / 8,497 / 13,055 / 32,800.
9. Edit format selected per model; rejected edits counted; line numbers on reads optional.
10. Structured summary sections for files changed, decisions and next step; file tracking measured with probes, as this is the weakest dimension everywhere.
11. Stuck detection on repeated identical calls.
12. Parallel tool calls batched in one request; subagent token multiplier measured.

### Gaps
- No independent replication of any harness-vendor number (Factory, Anthropic, Cursor) was found.
- Caching paper is on web research rather than coding, and pricing is from January 2026.
- Factory's TB4 per-harness cost and time figures for competitors were not given as absolute values in the text I read.

## Model routing: cheap-to-strong escalation, per-step choice, and evidence

### Takeaway
Routing can cut cost by about half with no loss on some evidence, but it can also cost three times as much when the router is poor, and a frontier model is a bad router. Vendors disagree on mid-conversation switches because caches are per model, so most harnesses route at subagent boundaries or the session start.

### Cited Findings

**What harnesses do**
- Claude Code: subagent `model`, `CLAUDE_CODE_SUBAGENT_MODEL`, `opusplan` (Opus in plan mode, Sonnet otherwise; each toggle starts a fresh cache), advisor tool placed after the cache breakpoint ([model-config](https://code.claude.com/docs/en/model-config), [caching docs](https://code.claude.com/docs/en/prompt-caching)). Anthropic says switching mid-session 100K in can cost more than staying, and recommends a subagent hand-off ([post](https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/)). [UNM]
- Cursor recommends one model per conversation; switching means cache miss and instructions telling the new model it has taken over ([Cursor](https://cursor.com/en-US/blog/continually-improving-agent-harness)). [UNM]
- Factory Router: session and per-request decisions, weighs cache maintenance heavily, escalates when a model struggles. Claims: production billing 63% below frontier pricing, median session saves 72.5%, Terminal-Bench 2 99% of Opus 4.7 pass rate at 20% lower cost, Legacy-Bench 96% at 25% lower ([docs](https://docs.factory.com/model-independence/factory-router.md)). [VEN, no method]. `compactionModel` and `modelFallbacks` are separate settings ([settings](https://docs.factory.com/droid-cli/settings)).
- Amp modes `low`, `medium`, `high`, `ultra`, each bundling model, effort, prompt and tools; Oracle, Librarian and Finder are plugins with their own `MODEL`; system models handle compaction and naming ([docs](https://ampcode.com/docs/models-and-subagents)). [UNM]
- Gemini CLI `auto`: composite strategy with fallback, override, approval-mode and three classifiers (LLM, numerical, Gemma) choosing flash or pro from the last 4 turns of a 20-turn window ([strategies](https://github.com/google-gemini/gemini-cli/tree/89e9d25/packages/core/src/routing/strategies), [classifierStrategy.ts](https://github.com/google-gemini/gemini-cli/blob/89e9d25/packages/core/src/routing/strategies/classifierStrategy.ts)). [CODE]
- Aider: `weak_model` for summaries and commits, `editor_model` in architect mode ([models.py](https://github.com/Aider-AI/aider/blob/5dc9490/aider/models.py)). Hermes: summary model override ([context_compressor.py](https://github.com/NousResearch/hermes-agent/blob/71736c9f/agent/context_compressor.py)). Copilot "Auto model selection" with no numbers published in the post I read ([GitHub](https://github.blog/ai-and-ml/github-copilot/evaluating-performance-and-efficiency-of-the-github-copilot-agentic-harness-across-models-and-tasks/)).

**Evidence**
- TwinRouterBench, step-level, 17 authors across universities and Gradient. Static: 970 rows from 520 instances, 11 models. Dynamic: 100 locked SWE-bench Verified cases, not a random sample. Results: unrouted Opus 4.6 74 resolved at $54.73; trained UncommonRoute 75 at $25.66 (-53.1%); in-sample SR-KNN 75 at $55.61; rule-based UncommonRoute 73 at $172.56, over 3x the cost. Opus 4.6 as router predicted high on only 7 of 147 verified-high steps and failed all 40 SWE trajectories ([arXiv 2605.18859](https://arxiv.org/html/2605.18859)). [IND with a caveat: I did not check whether the authors are tied to UncommonRoute]. Label depends on fixed pool and price snapshot.
- SWE-Router: cheap model explores K turns, then a value head decides whether to escalate, restarting from the prompt. SWE-bench Verified solo baselines: gpt-5-mini 55.6% at $16.6, deepseek-v3.2 62.4% at $22.6, gemini-3-pro-preview 70.4% at $391.3. Route-AUC deepseek pair 0.627 at K=0 to 0.780 at K=2; gpt-5-mini pair 0.565 best baseline to 0.709 at K=4. Routed runs can briefly exceed all-strong since models solve different subsets. Only 100 instances truly held out, and no operating-point cost or resolve rate is stated ([arXiv 2607.00053](https://arxiv.org/html/2607.00053v1), ICML 2026 DL4Code workshop). [IND, author-run]. A [blog](https://codex.danielvaughan.com/2026/07/10/swe-router-trajectory-based-model-routing-codex-cli-partial-exploration-cost-escalation/) cites 0.750 at K=3, which differs from the paper's table as read.
- GMI live switching, Terminal-Bench 2.1, 89 tasks: V4 Flash pass@1 69.2-70.3% at $0.04-0.07 per trial, Fable 5 80.7-84.3% at $1.15-1.97. Live-switch sample of 15: 3 of 9 hard tasks rescued, all 6 controls passed, but 2 false escalations ($0.93 and $1.51). Escalation sets across harnesses overlapped only 0.35 Jaccard, so routing is harness-specific ([GMI](https://www.gmicloud.ai/en/blog/dynamic-model-escalation-for-coding-agents-a-gmi-router-experiment-across-two-harnesses)). [VEN, early, Fable data from official trajectories]
- Subagent pinning: Haiku subagents 37% fewer tokens than inherited Opus and faster, on one matched task, quality not assessed ([Systima](https://systima.ai/blog/subagent-tax)). [IND, n small]
- Triage routes whole tasks by code quality signals; I saw this only in a search excerpt and did not read results ([arXiv 2604.07494](https://arxiv.org/html/2604.07494)). Unverified.

### Inferences
- Safe defaults supported by the evidence: start cheap for exploration or small steps, escalate via subagent or at a compaction point, use a trained or trajectory-based policy rather than asking a frontier LLM, and always price cache loss into the decision.
- The $172.56 result shows a bad router can be far worse than no router. Its cause was not established in what I read; frequent switching and cache loss is my guess only.
- A router must be evaluated on the same harness it runs on, given the 0.35 Jaccard.

### Gaps
- No independent test of a commercial router (Factory, Cursor Auto, Copilot Auto, Gemini auto) was found.
- Nobody publishes cache-aware step-level routing results. TwinRouterBench's dynamic track bills real API spend, but I did not confirm how it handles cache continuity across switches.
- GMI's rescued-trajectory costs are in chart images I could not read.
