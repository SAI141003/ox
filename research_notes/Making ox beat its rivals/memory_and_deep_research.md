# Memory and Deep Research for ox (state as of Oct 2026)

Note on method: about 15 searches and fetches, run on 2026-10-20. Most benchmark numbers in this area are reported by the vendors themselves and conflict with each other. Every such case is flagged below.

## Memory systems: architectures, local-first options, and benchmark scores

### Takeaway
No memory system clearly wins. Vendor scores on LoCoMo and LongMemEval disagree by 20+ points, depending on the setup. The strongest evidence points one way: plain files plus hybrid retrieval (semantic + BM25 + entity matching) plus good agent tool use do as well as complex graph systems. A temporal model (valid-from/valid-to on facts), as in Zep/Graphiti, is the best-documented way to handle facts that go stale or contradict each other.

### Cited Findings
- **Mem0 (Apr 2026 algorithm):** self-reported 92.5 on LoCoMo and 94.4 on LongMemEval, at about 6,900 tokens per retrieval call. BEAM-1M scores 64.1 and BEAM-10M scores 48.6, a drop of about 25% when the context grows 10x. The architecture moved to single-pass, add-only extraction. Retrieval runs semantic, BM25 keyword and entity matching in parallel, then fuses the scores. Entity linking now lives in a parallel `{collection}_entities` collection and replaces the external graph store, so relationships affect ranking but can no longer be traversed. The eval harness is open at github.com/mem0ai/memory-benchmarks. — [Mem0: State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- The same Mem0 page lists Zep at 80.32% on LoCoMo at 189ms (up to 83% depending on config) and 71.2 on LongMemEval (GPT-4o). It lists Letta at 74.0 on LoCoMo (gpt-4o-mini, filesystem) and OpenAI Memory at 52.9 on LoCoMo. — [Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- Conflicting figures:
  - A different Mem0 article gives 91.6/93.4 for the same algorithm.
  - An independent test of open-source Mem0 got 32.4% on LongMemEval, against 93.4% self-reported for the managed platform.
  - Zep's LoCoMo results range from 94.7% (self-reported) to 75.1% (ByteRover's test). — Search summary of [Mem0 benchmarks article](https://mem0.ai/blog/ai-memory-benchmarks-in-2026), [DEV community independent benchmark](https://dev.to/everest_an/-i-benchmarked-ai-agent-memory-in-2026-and-the-numbers-tell-a-different-story-than-the-marketing-2ae4), [preuve.ai stats](https://preuve.ai/blog/ai-memory-systems-statistics-2026)
- An academic paper, "Agent Zero Memory" (provenance-aware), claims 95.6% on LongMemEval and 93.6% on LoCoMo. These are self-reported. — [arXiv 2608.29606](https://arxiv.org/pdf/2608.29606)
- **Letta (formerly MemGPT):** works like an operating system's memory tiers, with core memory in context, recall memory (searchable history) and archival memory. The agent moves data between tiers with explicit tool calls. — [Mem0 summary](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- In Letta's own test, gpt-4o-mini agents that simply saved conversation histories to files reached **74.0% on LoCoMo**. Mem0's best graph variant scored 68.5%, as Mem0 reported it. The agents had grep, search_files, open and close tools, with automatic embedding of the files, and a tool rule that they start with search_files. Letta's conclusions:
  - Memory quality depends more on how agents manage context and use tools than on the retrieval mechanism.
  - Agents use filesystem tools well because they are trained on them, and they struggle more with knowledge-graph tools.
  - LoCoMo may not be very meaningful.
  — [Letta: Benchmarking AI agent memory](https://www.letta.com/blog/benchmarking-ai-agent-memory)
- **Zep/Graphiti architecture (arXiv 2501.13956):**
  - Bi-temporal: each fact carries t_valid and t_invalid (when it was true in the world) and t'created and t'expired (when it was added to and retired from the database).
  - Contradictions: an LLM compares each new edge with related existing edges. When two overlap in time, the old edge's t_invalid is set to the new edge's t_valid, so the history is kept rather than deleted.
  - Three subgraphs: episodic (raw messages, stored without loss), semantic entity (facts as edges) and community (label-propagation clusters with summaries).
  - Search uses cosine similarity, BM25 (Lucene) and breadth-first expansion over n hops. Results can be reranked with RRF, MMR, episode-mentions, node-distance or cross-encoders.
  — [Zep paper HTML](https://arxiv.org/html/2501.13956v1)
- **Zep on LongMemEval_s (about 115k-token histories):**

  | Setup | Model | Accuracy | Latency | Context |
  |---|---|---|---|---|
  | Full context | gpt-4o-mini | 55.4% | 31.3s | 115k tokens |
  | Zep | gpt-4o-mini | 63.8% | 3.20s | 1.6k tokens |
  | Full context | gpt-4o | 60.2% | 28.9s | 115k tokens |
  | Zep | gpt-4o | 71.2% | 2.58s | 1.6k tokens |

  Zep used BGE-m3 for embeddings and reranking. On DMR, Zep scored 94.8% against MemGPT's 93.4%. — [Zep paper](https://arxiv.org/html/2501.13956v1), [abstract](https://arxiv.org/abs/2501.13956)
- **Claude Code auto memory:**
  - Stored per project in `~/.claude/projects/<project>/memory/`, with `MEMORY.md` as an index plus topic files. Worktrees of the same repo share one memory.
  - The first 200 lines (or 25KB) of MEMORY.md load every session; topic files are read on demand.
  - On by default. Claude decides what to save, and users can also ask it to remember something.
  - Local only, not in git (unlike CLAUDE.md). One guide says it arrived in v2.1.32.
  - One guide describes a "Dreams" consolidation pass that merges duplicates and replaces stale entries. This is unverified.
  - These details come from third-party guides; I could not reach Anthropic's docs. — [memoryplugin blog](https://blog.memoryplugin.com/claude-code-memory/), [claudefa.st](https://claudefa.st/blog/guide/mechanics/auto-memory), [the-decoder](https://the-decoder.com/claude-code-now-remembers-your-fixes-your-preferences-and-your-project-quirks-on-its-own/)
  - The same index-plus-topic-files pattern is visible in this user's own memory directory (MEMORY.md linking to `never-pkill-by-name.md`).
- Trends Mem0 names:
  - Production systems now combine semantic, keyword, entity and graph signals.
  - Memory is split into working, episodic, semantic, procedural and hierarchical; procedural memory is the least mature.
  - Open problems: temporal reasoning, staleness, cross-session identity, privacy and deletion.
  — [Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)

### Inferences
- ox should not take on Neo4j or a hosted memory service. The best evidence (Letta's 74.0% with plain files, Mem0's 2026 move away from an external graph store toward entity collections plus hybrid fusion) supports this design:
  - Markdown files are the source of truth.
  - A derived SQLite index sits on top, holding FTS5/BM25, vectors and an entity/link table.
  - Agents use familiar tools on it: grep, search, open.
- ox should borrow Graphiti's bi-temporal idea cheaply. Each fact or note gets `valid_from`/`valid_to`/`superseded_by` frontmatter, and a newer note that contradicts an older one marks the old one invalid instead of deleting it. That keeps history and lets retrieval prefer current facts.
- Retrieval should return a small context: Zep shows about 1.6k tokens beating 115k of full context on both accuracy and latency (about 10x faster).

### Gaps
- I did not fetch first-party data for Cognee, LangMem, ChatGPT memory internals, Supermemory or Reor. The Mem0 page has no LangMem numbers, and the search found nothing on Reor.
- No independent, apples-to-apples leaderboard covers all the memory systems. Every headline score above is vendor-reported or comes from a single third party.

## Obsidian-style design: markdown, wikilinks, curation, consolidation, fast local retrieval

### Takeaway
The working "second brain" pattern for agents, used by Basic Memory, Obsidian Memory MCP and Claude Code auto memory, is:
- plain markdown files with YAML frontmatter and [[wikilinks]] as the source of truth;
- a SQLite index that can be rebuilt from the files at any time, holding full-text search, vectors and the link graph;
- MCP or CLI tools to write, read, edit and search notes.

Hybrid search with FTS5 and sqlite-vec, fused by Reciprocal Rank Fusion, is a proven pattern that needs nothing but SQLite.

### Cited Findings
- **Basic Memory:**
  - Four parts: markdown files on disk (the source of truth, compatible with git, Obsidian and any editor), a local SQLite index for search and graph traversal, an MCP server with read/write/search tools, and a sync engine.
  - The SQLite database can be rebuilt from the files at any time.
  - Tools include write_note, read_note and edit_note, plus a canvas tool that writes Obsidian canvas files for a graph view.
  - It has an optional paid cloud sync.
  — [Basic Memory: how it works](https://www.mintlify.com/basicmachines-co/basic-memory/concepts/how-it-works), [Basic Memory CLAUDE.md](https://glama.ai/mcp/servers/@basicmachines-co/basic-memory/blob/07e304ce8e335643bc4e682abf3b2dad225b6eb1/CLAUDE.md)
- **Obsidian Memory MCP:** a fork of Anthropic's reference memory server. It stores each entity as a markdown file with YAML frontmatter, "observations" and "relations" sections, and [[link]] syntax that shows up in Obsidian's graph view. — [GitHub: YuNaga224/obsidian-memory-mcp](https://github.com/YuNaga224/obsidian-memory-mcp)
- **Smart Connections (Obsidian plugin):**
  - Ships with a local default embedding model (BGE-micro), so it needs no API key. It can also use Ollama or LM Studio.
  - Suggests related notes and offers chat over the vault, saving chat history as markdown.
  — [Obsidian community: Smart Connections](https://community.obsidian.md/plugins/smart-connections), [sourcepulse](https://www.sourcepulse.org/projects/1833807)
- The Smart Second Brain plugin's developer recommends "mxbai-embed-large" as the best local embedding model they tested. This is an opinion, not a benchmark. — [Smart Second Brain](https://community.obsidian.md/plugins/smart-second-brain)
- **Khoj:** can be self-hosted and run local-only alongside a local-only Obsidian vault; answers questions from your docs and the web. — [Khoj blog](https://blog.khoj.dev/posts/obsidian-ux-revamp/)
- **Hybrid SQLite search:** run a sqlite-vec KNN query and an FTS5 query (one CTE each), then fuse the two ranked lists with Reciprocal Rank Fusion. The post shows the full SQL. — [Simon Willison, Oct 2024](https://simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite/)
- The litesearch package defaults to FTS5 plus vectors with RRF, using ONNX encoders for local embeddings. — [PyPI litesearch](https://pypi.org/project/litesearch/0.0.35/)
- Mem0's 2026 retrieval runs semantic, BM25 and entity matching in parallel and fuses the scores, which confirms the hybrid approach at production scale. — [Mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- **Keeping memory consistent:**
  - Graphiti invalidates contradicted facts by time rather than deleting them. — [Zep paper](https://arxiv.org/html/2501.13956v1)
  - Claude Code keeps a size-capped index file (200 lines) that always loads, with details in topic files loaded on demand. — [memoryplugin](https://blog.memoryplugin.com/claude-code-memory/)

### Inferences
Concrete design for ox ("ox brain"):
- **Files.** One vault, `~/.ox/brain/`, with `daily/YYYY-MM-DD.md`, `notes/<slug>.md`, `library/` (saved articles and PDFs turned into markdown with source frontmatter) and `projects/<repo>/`.
  - Frontmatter fields: `type`, `tags`, `source`, `created`, `valid_from`, `valid_to`, `supersedes`, `confidence`.
  - Every note uses [[wikilinks]] to entities, so the vault opens directly in Obsidian.
- **Index.** A single SQLite file `brain.db` holding an FTS5 table, a sqlite-vec table, a `links` table (from, to, type) for backlinks and the graph, and an `entities` table. It is rebuilt incrementally from file modification times or content hashes and is never the source of truth.
- **Retrieval.**
  1. Run BM25 and vector search in parallel.
  2. Fuse the results with RRF.
  3. Add notes one hop away by backlink.
  4. Boost recent and still-valid notes; drop anything with `valid_to` in the past unless the question is historical.
  5. Return roughly 1–2k tokens (Zep's figure).
- **Writing and curation.** The agent adds new notes to the daily note and to topic notes. A scheduled "consolidate" pass, like Claude Code's reported Dreams pass, merges duplicates, finds contradictions with an LLM and marks old facts superseded, and keeps a short `INDEX.md` that always loads (capped at about 200 lines, as Claude Code does).
- **Graph view.** The ox code graph and wiki can share the same link table, so code entities and knowledge notes connect in one graph.
- **Local embeddings.** Use a small model run through ONNX or Ollama, such as BGE-micro or bge-small for speed, or mxbai-embed-large / BGE-m3 for quality.

### Gaps
- I found no benchmark of local embedding models (BGE vs. mxbai vs. EmbeddingGemma) on personal-notes retrieval.
- I found no published accuracy numbers for markdown-vault memory tools (Basic Memory, Smart Connections) on LoCoMo or LongMemEval.
- I could not confirm the Claude Code "Dreams" consolidation pass from a first-party source.

## Deep research agents: architectures, benchmarks, cost and speed, search APIs

### Takeaway
The leading design is orchestrator plus workers:
- a lead agent plans and delegates;
- 3–5 parallel subagents search, each with its own context window;
- a final step attaches a citation to each claim.

Anthropic found that token spend explains about 80% of the variance in quality on BrowseComp, so parallel fan-out buys both quality and speed (up to 90% less time), at about 15x the tokens of a chat. Brave is the best-value search API in the one independent benchmark found; SearXNG is the free self-hosted option.

### Cited Findings
- **Anthropic's Research system:**
  - Architecture: an Opus 4 lead agent writes a plan to memory and spawns Sonnet 4 subagents. They search in parallel, each in its own context, and return findings. The lead decides whether to spawn more. A CitationAgent then maps each claim in the report to its source.
  - Results: the multi-agent setup scored **90.2% better** than a single Opus 4 agent on Anthropic's internal research eval. On BrowseComp, token usage alone explained about 80% of performance variance, and tokens + tool calls + model choice explained 95%. Multi-agent runs use about **15x** the tokens of chat; single agents use about 4x.
  - Speed: 3–5 parallel subagents, each making 3+ parallel tool calls, cut research time by up to 90%.
  - Lessons: scale effort to how complex the query is (no swarm for a simple fact lookup); give detailed delegation instructions, since vague ones caused duplicated work; search broad first, then narrow; a tool-testing agent that rewrote bad tool descriptions cut task time by 40%; build in checkpoints and resume; start evaluation with about 20 queries and an LLM judge.
  — [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- **LangChain open_deep_research:**
  - Built on LangGraph in three phases: scope, research, write.
  - A supervisor has reflect, delegate-to-sub-researcher and research-complete tools. Sub-researchers run in parallel, capped by `max_concurrent_research_units`.
  - Ranked #6 on DeepResearch Bench (overall 0.4344) on 2025-08-02; a later GPT-5 configuration's RACE score is 0.4943.
  - The leaderboard space has reportedly gone offline.
  — [GitHub langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research), [LangChain blog](https://www.langchain.com/blog/open-deep-research)
- **Jina node-DeepResearch:**
  - Loops search → read → reason, splitting the question into sub-queries until it has an answer or runs out of token budget.
  - Uses Jina Reader for extraction, exposes an OpenAI-compatible API (`jina-deepsearch-v1`) and cites sources as GFM footnotes.
  - Apache-2.0; released 2025-02-02.
  — [Jina practical guide](https://jina.ai/de/news/a-practical-guide-to-implementing-deepsearch-deepresearch/), [jimmysong.io](https://jimmysong.io/ai/node-deepresearch), [PyTorch KR](https://discuss.pytorch.kr/t/openai-deep-research-3-feat-hugging-face-jina-ai-firecrawl/6050)
- **Roles of other open-source tools:** GPT-Researcher builds reports; Stanford STORM is a pre-writing system that produces outlines rather than answers. — [digitalapplied guide, Aug 2026](https://www.digitalapplied.com/blog/open-source-deep-research-agents-2026-guide)
- **DeepResearch Bench:** a July 2026 snapshot from a community wiki (unverified) ranks CellCog Max 55.78, Gemini 2.5 Pro Deep Research 49.98, OpenAI Deep Research 47.84, Perplexity Research 43.05 and Grok Deeper Search 41.22, after the judge switched to GPT-5.5. — [ai.miraheze wiki](https://ai.miraheze.org/wiki/DeepResearch_Bench); benchmark paper: [arXiv 2506.11763](https://arxiv.org/pdf/2506.11763)
- **BrowseComp (Oct 2026):**
  - BenchLM (verified 2026-10-16) lists Atria Dawn Preview 92.5%, GPT-5.6 Sol 92.2%, Ling 3.1 Flash 91.7%, GPT-6 Astra 91.5% and Claude Opus 5 90.8%. The top models are within about 0.8 points of each other.
  - OpenAI claims a state-of-the-art 92.2% for GPT-5.6 Sol.
  - At the GPT-5.5 launch (Apr 2026), OpenAI's table showed GPT-5.5 Pro 90.1%, Gemini 3.1 Pro 85.9% and Claude Opus 4.7 79.3%.
  - Model names are not consistent across sources.
  — [BenchLM BrowseComp](https://benchlm.ai/benchmarks/browsecomp), [OpenAI GPT-5.6](https://openai.com/index/gpt-5-6/), [OpenAI GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)
- **Search APIs (prices per 1k requests, approximate):**

  | API | Price per 1k requests | Latency | Notes |
  |---|---|---|---|
  | Brave | about $5 | 669ms in AIMultiple | $5 free credit each month; best Agent Score (14.89/20) in AIMultiple |
  | Exa | about $7 | about 280ms (Exa's own test) | Exa's figure is not comparable to AIMultiple's |
  | Tavily | about $8 basic (advanced costs 2 credits) | 998ms in AIMultiple | Nebius agreed to acquire it in Feb 2026 |
  | Firecrawl | 2 credits per 10 results; plans from about $16/month | about 1,335ms | |
  | SearXNG | no API fee (VPS about $5–10/month) | not measured | self-hosted |

  AIMultiple's quality scores (out of 20) were Brave 14.89, Firecrawl 14.58, Exa 14.39 and Tavily 13.67, within error bars of each other. — [AIMultiple agentic search benchmark (May 2026)](https://aimultiple.com/agentic-search), [Firecrawl comparison](https://www.firecrawl.dev/blog/best-web-search-apis), [Exa blog](https://exa.ai/blog/best-web-search-tools-for-ai-agents), [codenote cost comparison](https://codenote.net/en/posts/tavily-alternatives-cost-comparison-search-extract-api/)

### Inferences
Design for `ox research --deep`:
1. **Scope.** Ask one clarifying question only if the query is ambiguous.
2. **Plan.** The lead agent writes a research plan to a file, sized to the query: 1 worker for a simple question, 3–5 for a broad one.
3. **Fan out.** Parallel subagents, each on its own subtopic, start with short queries and then narrow. They draw on ox's existing Reddit, HN and YouTube sources plus a web search backend (Brave by default; SearXNG for fully local, zero-cost runs; Exa as optional semantic search).
4. **Compress.** Each worker returns condensed findings with URLs, not raw pages.
5. **Write and cite.** The lead writes the report, then a citation pass checks that each claim maps to a fetched source and drops claims with no source.
6. **Save to the brain.** Write the report and sources into the vault/library as markdown with backlinks, so future research and memory reuse them. This is a link between memory and research that hosted products lack.

Other points:
- Use a cheaper model for the workers and the strong model only for the lead and for synthesis, as Anthropic did with Opus lead and Sonnet workers. This controls the 15x token cost.
- Checkpoint the run state so a failed worker can resume.
- Benchmark claims should be treated as directional. For a coding agent, an internal set of about 20 queries with an LLM judge (Anthropic's advice) is more useful than chasing BrowseComp.

### Gaps
- I did not collect first-party architecture or cost and latency details for OpenAI Deep Research, Gemini Deep Research or Perplexity in 2026: run times, per-run prices or model versions.
- I did not fetch the internals of STORM's multi-perspective question-asking or GPT-Researcher's planner from their papers or repos.
- I found no official live DeepResearch Bench leaderboard; the July 2026 snapshot comes from a community wiki.
- I found no independent quality benchmark that includes SearXNG.
