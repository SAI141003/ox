# Token efficiency for coding agents (2025 to Oct 2026)

Scope note: research done 2026-10-20. A rate limit cut off several fetches partway through, so many figures below come from search-result summaries of primary pages rather than full reads. Where a figure is secondhand or vendor-reported, that is said next to it.

## 1. Context management (caching, compaction, clearing, sub-agents, just-in-time retrieval)

### Takeaway
The best-evidenced savings are cheap and simple. Drop or mask old tool outputs (about 50% cost cut with no loss in solve rate on SWE-bench Verified), keep the prompt prefix byte-stable so the provider cache hits (41-80% API cost cut), and fetch context just in time instead of stuffing it in. LLM summarization is not clearly better than masking, and it costs more.

### Cited Findings
- **Observation masking vs LLM summarization (JetBrains Research and TU Munich, NeurIPS 2025).** On SWE-agent and SWE-bench Verified across five model configurations, masking old observations roughly halved cost against a raw agent. Its solve rate matched or slightly beat LLM summarization. With Qwen3-Coder 480B, the solve rate went from 53.8% (raw) to 54.8% (masking). A hybrid of the two cut a further 7% against masking alone and 11% against summarization. Without any context management, costs can more than double. Results also checked on OpenHands. — [arXiv 2508.21433](https://arxiv.org/abs/2508.21433)
- **Anthropic context editing.** On a 100-turn web-search eval, context editing (automatically clearing stale tool results) cut token consumption by 84% and let runs finish that would otherwise have run out of context. Context editing alone improved performance 29% over baseline, and 39% when combined with the memory tool. This is one benchmark, and it is not coding-specific. — [Anthropic: context management](https://www.anthropic.com/news/context-management)
- **Anthropic "Effective context engineering for AI agents" (Sept 2025).** It recommends just-in-time retrieval: keep lightweight references (file paths, stored queries) and load data at runtime. Claude Code uses a hybrid, loading CLAUDE.md up front and finding files with glob and grep. Compaction continues from a summary plus the five most recently accessed files. Tool-result clearing is called "one of the lightest-touch forms of compaction". Sub-agents may use "tens of thousands of tokens or more" exploring but return a condensed summary, "often 1,000-2,000 tokens". The post also covers context rot, where recall falls as the context grows. — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Prompt caching in long-horizon agents ("Don't Break the Cache", Jan 2026).** The study covers OpenAI, Anthropic and Google, four models, and 500+ sessions with 10k-token system prompts. Caching cut API cost by 41-80% and time-to-first-token by 13-31%. Three practices gave more consistent gains than naive full-context caching, which could even increase latency: put dynamic content at the end of the system prompt, avoid dynamic function calling (changing the tool set invalidates the prefix), and leave dynamic tool results out of the cached region. Timestamps, session IDs and user details in the system prompt break the cache. — [arXiv 2601.06007](https://arxiv.org/abs/2601.06007v1)
- **Cache stability matters as much as prompt size.** Systima measured raw HTTP traffic. OpenCode's cache prefix stayed byte-identical through a session, while Claude Code's prefix changed mid-session and it wrote up to 54x more cache tokens on the same task. The author's cost model assumes hit rates of about 90% for OpenCode and about 40% for Claude Code (assumed, not measured). — [Kunal Ganglani, summarizing Systima](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead); original at [systima.ai](https://systima.ai/blog/claude-code-vs-opencode-token-overhead), which I did not fetch directly
- **Cache pricing.** Anthropic cache reads cost about 0.1x the base input price. Writes cost 1.25x, or 2x for the 1-hour TTL. Third-party sources disagree on OpenAI's cache discount: 50% in one, 90% for newer models in another. — [silicondata](https://www.silicondata.com/use-cases/anthropic-claude-api-pricing-2026), [techsy.io](https://techsy.io/fr/blog/reduce-llm-api-costs-guide) (secondary; check against official pricing pages)
- **Sub-agents and harness overhead.** Each sub-agent carries the full harness overhead, so per-request payload grows linearly with the number of sub-agents. Author's estimate: Claude Code goes from 59-69k tokens per request with one agent to 177-207k with three sub-agents. — [Ganglani/Systima](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead)
- **Input tokens dominate cost.** Eight frontier LLMs on SWE-bench Verified. Agentic coding uses about 1000x more tokens than code chat or reasoning, and input tokens drive cost rather than output. Repeated runs of the same task vary widely. Accuracy often peaks at intermediate cost and falls at higher cost. Kimi-K2 and Claude Sonnet 4.5 used over 1.5M more tokens per task than GPT-5 on average. Models predict their own cost poorly (correlation up to 0.39). — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750), [Stanford Digital Economy Lab](https://digitaleconomy.stanford.edu/publication/how-do-ai-agents-spend-your-money)

### Inferences
- For ox, the cheapest large win is probably (a) masking or clearing old tool outputs after N turns, keeping a one-line placeholder, and (b) a strictly append-only, byte-stable prefix. Order it as system prompt, then a stable tool list, then the conversation, with anything volatile (date, cwd, git status) at the end or in the latest user turn. Because input tokens dominate agent cost, a cache read at 0.1x the input price is worth more than shaving the base prompt.
- ox offering tools "only when needed" may conflict with caching. If the tool set changes between turns, the cached prefix is invalidated, which "Don't Break the Cache" warns about explicitly. Options are to keep a stable core tool set and add deferred tools after the cache breakpoint, or to measure cache hit rate per session.
- Sub-agents save the lead agent's context but multiply harness overhead. ox's small ~2k harness makes sub-agents unusually cheap for it, which could be a competitive point.

### Gaps
- The Systima page was not fetched directly, and the sources conflict on which model it used. A search summary says claude-sonnet-4-5 with a gap that narrows to 3.3x on a newer model, while the Ganglani summary says the model versions are not named. The 40% vs 90% cache hit rates are the author's assumptions.
- I found no controlled study isolating the benefit of compaction thresholds (when to compact) on coding success.
- I did not retrieve OpenAI's official docs on automatic caching or compaction (for example the Responses API).

## 2. Code context (repo maps, code graphs, search, LSP, file ranges, edit formats)

### Takeaway
Structured code navigation (graph or index queries) shows large token savings, but the evidence is mostly self-reported. The best independent-ish figure is about 10x fewer tokens and 2.1x fewer tool calls against file-by-file exploration. The evidence on edit formats is mixed: diff and search/replace save output tokens, and whole-file rewrites are sometimes more reliable for weaker models.

### Cited Findings
- **codebase-memory-mcp.** The README claims 99.2% token reduction against naive file-by-file grep. Agentic Context Research confirmed the compact output but noted a naive baseline, a single repository and no reproducible harness. An arXiv preprint (2603.27277) over 31 repositories reports 83% answer quality with 10x fewer tokens and 2.1x fewer tool calls against file-by-file exploration. — [letsdatascience summary](https://letsdatascience.com/news/codebase-memory-mcp-speeds-ai-coding-agent-queries-a6a04a1b), [aibuilderclub](https://www.aibuilderclub.com/blog/codebase-memory-mcp-guide)
- **CodeGraph (colbymchenry/codegraph).** Self-reported, Aug 2026: on average 62% fewer tokens and 88% fewer tool calls across seven large OSS repositories, and 97% fewer on an "understand" scenario in a Next.js project. — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/11125/codegraph-cut-coding-agent-tokens)
- **Other graph MCPs** (Tentra 99.4%, MCP Context Graph) report savings on their own single repositories against grep or file-read baselines. Treat these as directional only. — [glama.ai MCP Context Graph](https://glama.ai/mcp/servers/padobrik/mcp-context-graph)
- **Aider repo map.** It uses a default `--map-tokens` budget of 1,024 tokens and resizes the map dynamically, expanding when no files are in the chat. — [fast.io](https://fast.io/resources/aider-token-limit/), [tokenade.net](https://tokenade.net/fr/articles/reduce-aider-token-usage) (secondary)
- **Edit formats, from Aider.** The "whole" format is easiest for an LLM but "uses a lot of tokens and may limit how large a file can be edited". Diff formats are more efficient, and Aider falls back to whole for lesser-known models. — [aider.chat edit formats](https://aider.chat/docs/more/edit-formats.html). On Aider's laziness benchmark (89 Python refactors), GPT-4 Turbo scored about 20% with SEARCH/REPLACE and 61% with unified diff. — [aider.chat unified diffs](https://aider.chat/docs/unified-diffs.html) (older, GPT-4 era)
- **Independent edit-format studies.** In multi-turn work, the whole-code format "tends to be more stable overall" than diff or udiff. — [arXiv 2510.13859](https://arxiv.org/pdf/2510.13859). Whole-file and search/replace showed comparable performance and token usage in another study, which proposes a cascade where a large model plans the edit and a small model applies it. — [arXiv 2604.19201](https://arxiv.org/pdf/2604.19201)
- **Just-in-time file access (glob, grep, read ranges)** is Anthropic's recommended pattern over pre-loading. — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### Inferences
- ox's code graph is the right asset. It should be exposed as a few compact query tools (callers, callees, definition location, signature only, file outline) that return line ranges rather than file bodies. Benchmark it against grep on SWE-bench-style tasks, since the published 62-99% figures use weak baselines.
- Search/replace or apply-patch edits for strong models, with a whole-file fallback for small local models, matches both Aider's practice and the mixed independent evidence. This is especially relevant because ox supports local models.

### Gaps
- I found no rigorous 2025-26 study of LSP-based navigation against grep for agent token use, and none that varies Aider's repo-map budget against success rate.
- I found no published token measurements for OpenAI's apply_patch format specifically.

## 3. Tool output (truncation, pruning, dedup) and MCP or tool-definition bloat

### Takeaway
Tool definitions and tool outputs are the two biggest fixed and variable bloat sources. Deferred tool loading cuts definition tokens by about 85% and improves tool-selection accuracy. Learned or heuristic pruning of tool output removes 23-92% of tokens, but aggressive pruning can backfire because the agent re-reads files.

### Cited Findings
- **Tool Search Tool / `defer_loading` (Anthropic).** With 50+ MCP tools, upfront context fell from about 77k to about 8.7k tokens (85% less). Tool-selection accuracy rose from 49% to 74% for Opus 4 and from 79.5% to 88.1% for Opus 4.5. Frequently used tools can stay non-deferred. — [Anthropic advanced tool use](https://anthropic.com/engineering/advanced-tool-use). OpenRouter's docs warn that a tool needed on almost every request costs more in search round-trips than it saves. — [OpenRouter tool search](https://openrouter.ai/docs/guides/features/server-tools/tool-search.md)
- **Code execution with MCP.** Having the agent write code that calls tools, so intermediate results never pass through the model, cut one Google Drive to Salesforce workflow from 150,000 to 2,000 tokens (98.7%). — [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp). Independent results: 92.8% lower input tokens at 500+ tools with pass rate held ([Maxim/Bifrost](https://www.getmaxim.ai/articles/code-execution-with-mcp-how-code-mode-cuts-agent-token-costs-by-90/)). 78.5% fewer input tokens with equal success, but about 120% more output tokens ([aimultiple](https://aimultiple.com/de/code-execution-with-mcp)). The productized Programmatic Tool Calling averaged 37% fewer tokens on complex research tasks (secondary, via the same search).
- **MCP overhead per server** is about 1,000-1,400 tokens per request, and 5 MCP servers add 5-7k tokens. A 72KB AGENTS.md adds about 20k tokens. — [Ganglani/Systima](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead)
- **SWE-Pruner (Jan 2026).** A 0.6B "skimmer" picks the relevant lines from context given a goal. It cut tokens 23-38% on SWE-bench Verified and 29-54% on SWE-QA with less than 1% success drop, tested with Sonnet 4.5 and GLM-4.6. — [arXiv 2601.16746](https://hyper.ai/ar/papers/2601.16746). A competing paper's retest: Sonnet 4.5 at 72.0% vs 71.8% baseline with 23.1% savings, but with Opus 4.6, SWE-Pruner increased tokens by 6.6% because over-pruning forced re-reads. — [arXiv 2605.15315](https://arxiv.org/pdf/2605.15315)
- **Squeez (Apr 2026).** Task-conditioned tool-output pruning that returns the smallest verbatim evidence block. It removes 92% of input tokens at 0.86 recall and 0.80 F1. This is a pruning-quality metric, not an end-to-end solve rate. — [arXiv 2604.04979](https://arxiv.org/pdf/2604.04979)
- **"Agents Don't Paginate" (2026)** studies first-chunk selection for long tool responses. Found via search; not read. — [arXiv 2608.26130](https://arxiv.org/pdf/2608.26130)
- **Anthropic tool-design guidance.** Tools should return token-efficient, self-contained results, and overlapping tools should be avoided. — [Anthropic engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

### Inferences
- ox already sends tools only when needed, which is effectively deferred loading. Make it cache-safe by appending deferred tools after the stable prefix, or keep a fixed core set.
- Cheap, safe wins for tool output: head and tail truncation with a "N lines omitted, re-run with range" hint; deduplicating repeated identical outputs (test reruns, repeated reads); and replacing superseded file reads with a pointer. Pruning that hides needed lines causes re-reads, so make pruning reversible, with the full output stored and retrievable by ID.

### Gaps
- I found no published head-to-head of simple truncation against learned pruning on end-to-end solve rate.

## 4. Model routing and cascades, effort or thinking budgets, batch APIs

### Takeaway
Routing shows 39-66% cost cuts in vendor reports. The most promising academic approach routes after a few cheap exploratory turns rather than from the prompt alone. Effort controls reportedly cut output tokens sharply at equal quality. Batch APIs give a flat 50% discount, but only for non-interactive work.

### Cited Findings
- **SWE-Router (ICML 2026 DL4Code workshop).** A cheap model runs a few exploratory turns, and the partial trajectory decides whether to escalate. Prompt-only routers hit a ceiling because the description cannot tell a typo from a multi-module refactor. A secondary blog reports a 15-point routing-accuracy gain over description-only baselines (unverified). — [arXiv 2607.00053](https://arxiv.org/abs/2607.00053), [secondary blog](https://codex.danielvaughan.com/2026/07/10/swe-router-trajectory-based-model-routing-codex-cli-partial-exploration-cost-escalation/)
- **Not Diamond Code (vendor).** Near Opus 4.8 XHigh performance on Poly-SWE-Bench Verified at 39% lower inference cost, 61% lower on LongCodeQA, and up to 66% lower with open-weight models in the pool. — [Not Diamond](https://www.notdiamond.ai/blog/not-diamond-code-intelligent-model-routing-for-coding-agents)
- **Arize case study.** Routing the planning, exploration, implementation and review phases to different models cut one workflow from about $100 to $15-20 per run. One practitioner case. — [Arize](https://arize.com/?p=31923)
- **Cascaded code editing.** A large model plans the edit and a small model applies it. — [arXiv 2604.19201](https://arxiv.org/pdf/2604.19201)
- **Effort parameter (Anthropic).** It controls all tokens: text, tool calls and thinking. Lower effort means "fewer and terser tool calls". — [Claude docs: effort](https://platform.claude.com/docs/en/build-with-claude/effort). Reported launch claim: Opus 4.5 at medium effort matched Sonnet 4.5's best SWE-bench Verified score with 76% fewer output tokens. Secondhand, not verified in Anthropic's post. — [claude-facile.fr](https://claude-facile.fr/blog/claude-effort-control-guide/)
- **More tokens are not more accuracy.** Accuracy often peaks at intermediate token spend. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)
- **Batch APIs.** Anthropic and OpenAI both give 50% off for asynchronous processing within a 24-hour window. — [techsy.io](https://techsy.io/de/blog/llm-api-preisvergleich-2026) (secondary)

### Inferences
- For ox, trajectory-based escalation fits its local-model support: start on a local or cheap model and escalate on signals such as repeated failing tests, stuck loops or large diffs. ox-trace's "stuck signals" could feed this.
- Batch fits background jobs (scheduled reviews, wiki generation, overnight runs), not the interactive loop.

### Gaps
- I did not retrieve SWE-Router's actual cost and accuracy numbers.
- I found no independent measurement of routing savings once rework is counted.

## 5. Prompt compression (LLMLingua etc.) for agents

### Takeaway
General-purpose compressors like LLMLingua are weak for coding agents. LLMLingua-2 stays below 3x compression on SWE-bench Verified. Code-aware, task-conditioned pruners (SWE-Pruner, SWEzze, Squeez) do better, though results vary by model.

### Cited Findings
- **LLMLingua (EMNLP 2023).** Up to 20x compression with little loss on general NLP tasks. Not agent-specific. — [arXiv 2310.05736](https://arxiv.org/pdf/2310.05736)
- **SWEzze (2026)** finds LLMLingua-2 conservative on SWE-bench Verified, below 3x compression in every setting. — [arXiv 2603.28119](https://arxiv.org/pdf/2603.28119)
- **SWE-Pruner** beat LLMLingua-2 among baselines. One summary gives 64% success with 31% fewer tokens against a 62% vanilla baseline. — [opentrain summary](https://www.opentrain.ai/tools/hf-eval-papers/paper/f95272cd-5dc8-418d-bdd0-ea344d55df65/) (secondary)

### Inferences
- Token-dropping compression breaks code: identifiers, exact strings and patch anchors must stay verbatim. Line-level selection, as in SWE-Pruner and Squeez, is the safer granularity. For ox, structural compression (outlines and signatures from the code graph) is likely better than LLMLingua-style compression.

### Gaps
- I could not verify ACON (arXiv 2510.00615, agent context compression, 2025).

## 6. Published token-usage comparisons across agents

### Takeaway
There is no clean multi-agent tokens-per-task table. The best measured data is fixed overhead: Claude Code sends about 33k baseline tokens against about 7k for OpenCode, a 4.7x gap. Vendor claims put Claude Code at 3-4x Codex's tokens per task. Artificial Analysis publishes per-task token charts, but I could not extract the numbers. ox's ~2k baseline would be well below both.

### Cited Findings
- **Systima (measured July 12, 2026, raw HTTP capture, same model, machine and tasks).** Baseline before user input: Claude Code about 33k tokens, OpenCode about 7k (4.7x). The gap reportedly narrows to 3.3x on a newer model. Output quality was not measured. — [Ganglani summary](https://www.kunalganglani.com/blog/opencode-vs-claude-code-token-overhead), [developersdigest](https://www.developersdigest.tech/blog/claude-code-token-overhead-opencode-comparison); original [systima.ai](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)
- **Artificial Analysis coding-agent comparison.** Claude Code (Opus 5) and Codex (GPT-5.6) both score 67 on its index. It reports average input, cache and output tokens per task, and warns that cache hit rates vary by provider routing. Numbers not extracted. — [Artificial Analysis](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex)
- **Morph (vendor, Feb 2026).** Claims Claude Code uses 3-4x more tokens than Codex on identical tasks. The methodology is weak. — [morphllm](https://morphllm.com/comparisons/codex-vs-claude-code)
- **Per-model variance on SWE-bench Verified.** Kimi-K2 and Sonnet 4.5 used over 1.5M more tokens per task than GPT-5. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)
- **Aider polyglot benchmark** (225 Exercism exercises) reports cost per run, for example GPT-5 (high) at 88.0% for $29.08 (mirror, unverified). — [steel.dev mirror](https://leaderboard.steel.dev/registry/benchmarks/aider-benchmark)

### Inferences
- ox's ~2k vs ~11k claim fits the published pattern (OpenCode about 7k, Claude Code about 33k). Total task cost also depends on turns, tool output volume and cache hit rate, so ox should publish tokens per solved task on a public benchmark (for example a SWE-bench Verified subset), split into input, cached and output tokens.

### Gaps
- I found no published token-per-task data for Cline or Aider-as-agent on SWE-bench. I could not extract Artificial Analysis's numeric token charts.
