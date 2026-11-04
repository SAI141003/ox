# Multi-agent orchestration, memory and sessions in AI coding harnesses (as of 4 Nov 2026)

Evidence labels used on every claim about results:
- **[IND]** measured by a party with no product at stake in that comparison.
- **[IND*]** measured by academics who are also proposing a competing method or benchmark.
- **[VENDOR]** measured by the maker of the thing measured.
- **[UNMEASURED]** documented design, stated behaviour or opinion. Docs facts carry this label by default when no label is shown.

Product facts come from official docs fetched on 4 Nov 2026 unless marked "secondary". Pre-2025 sources are marked. ox checks come from reading source in `/Users/saiyaganti/ox/src` with grep and partial reads. Nothing in ox was executed, so each one is a lead to verify and not a finding about runtime behaviour.

## Subagents and multi-agent: isolation, merging, failure modes, costs, evidence

### Takeaway
No controlled evidence shows that hierarchical subagents improve coding results in general. The strongest 2026 test found native subagents cost about 1.5 to 2.9 times as much, with accuracy flat or lower. Parallelism looks safe for independent components and risky when workers share an invariant. Harnesses have converged on fresh-context children that return a summary, while file isolation and merge policy still differ widely.

### Cited Findings

**How each harness isolates and merges**

| Harness | Context isolation | File isolation and merge | Limits |
|---|---|---|---|
| Claude Code subagents | Fresh window with own prompt, task message, CLAUDE.md hierarchy (not for Explore and Plan), git status, listed skills. Forks inherit the full conversation | Optional `isolation: worktree`, branched from the default branch rather than parent HEAD, removed if unchanged | Depth 3 by default, 20 concurrent by default, transcripts kept 30 days ([docs](https://code.claude.com/docs/en/sub-agents)) |
| Claude Code agent teams | Separate sessions that load project context but not lead history. JSON mailboxes, shared task list with file-locked claiming | None automatic: "Two teammates editing the same file leads to overwrites", so split ownership by file | Experimental and off by default. One team per session, no nesting, `/resume` and `/rewind` do not restore in-process teammates. Suggests 3-5 teammates ([docs](https://code.claude.com/docs/en/agent-teams)) |
| Codex | Subagents return summaries to keep noise off the main thread. Custom agents in `.codex/agents/` | Inherit sandbox and approval settings, and cannot override them. In non-interactive flows, a new approval need fails back to the parent | `agents.max_concurrent_threads_per_session` (legacy alias `agents.max_threads`), default chosen by Codex ([docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)) |
| Factory custom droids | Fresh window, one final message returned | Same working tree unless `-w` is used at exec level | Subagents cannot spawn subagents or ask the user. Resumable by `task_id` ([docs](https://docs.factory.com/cli/configuration/custom-droids)) |
| Factory Missions | Orchestrator, then a fresh session per feature. Git is the handoff source of truth ([Factory post](https://factory.com/news/missions)) | Validators run at each milestone and can create fix features | Suited to roughly 1-500 features. Repo should be Agent Readiness Level 4 or above ([docs](https://docs.factory.com/missions/overview)). `--mission` needs `--auto high` or unsafe skip ([docs](https://docs.factory.com/cli/droid-exec/overview)) |
| Cursor | Clean context, parent sees final message only. Also reads `.claude/agents/` and `.codex/agents/` | Parallel subagents share the checkout by default "and can overwrite each other's edits". Isolation on request gives a worktree or cloud VM on its own branch, merged only when the parent merges | Nesting one level since 2.5 ([docs](https://cursor.com/docs/subagents)). Worktree cap 25 per machine. `/best-of-n` compares and never merges. Conflict handling undocumented ([docs](https://cursor.com/docs/configuration/worktrees)) |
| Amp | Task and Read Thread subagents start from instructions, not the conversation. "they can't communicate with each other". Oracle, Librarian and Finder are now plugins, and Oracle never edits | Not documented on the page read | Same model as the parent. Parent can send follow-up work ([docs](https://ampcode.com/docs/models-and-subagents)) |
| OpenHands V1 | `TaskTool` makes a separate conversation per task with its own event log, and `DelegateTool` runs tasks concurrently in threads. The V0 shared-stream delegate is gone ([source-code study, search excerpt only](https://arxiv.org/pdf/2609.00006)) | Not verified | SDK is event-sourced with one mutable state class ([MLSys 2026 paper, excerpt](https://arxiv.org/pdf/2511.03690)) |

**Measured evidence**
- **[IND*] Native subagents on long tasks.** Stanford's DeLM paper reports these (10 long tasks per benchmark, chosen by Codex latency) ([arXiv 2606.10662v3](https://arxiv.org/pdf/2606.10662)):

| Benchmark, model | Single-agent accuracy, cost | Native subagents accuracy, cost | Speed vs single |
|---|---|---|---|
| Terminal-Bench 4.0, GPT-6-Astra | 71.67%, $9.01 | 71.67%, $25.80 | 1.34x |
| Terminal-Bench 4.0, Opus 5.5 | 81.67%, $20.31 | 80.00%, $30.88 | 0.94x |
| DeepSWE v1.1, GPT-6-Astra | 88.33%, $9.40 | 90.00%, $24.97 | 1.05x |
| DeepSWE v1.1, Opus 5.5 | 71.67%, $12.01 | 50.00%, $19.83 | 0.86x |

- **[IND*] Named failure.** In the DeepSWE Opus case, most failed runs ended with an empty patch or a timeout, often because the main agent held the final commit while waiting on subagents cut off by the CLI's idle limit, or while extra review rounds ran. The paper's footnote gives a 600-second default for idle waiting on background subagents ([arXiv 2606.10662v3](https://arxiv.org/pdf/2606.10662)).
- **[IND*] Shared context did better, per its own authors.** DeLM replaces the main agent with a task queue and an incrementally published shared context. Examples are 93.33% vs 81.67% on Terminal-Bench with Opus at $17.91 vs $20.31 per task (n=2), and 88.33% at $12.15 vs 71.67% at $12.01 on DeepSWE with Opus. On cost per task, n=4 usually costs more than the single agent ($29.98 vs $20.31 on Terminal-Bench with Opus). The authors built DeLM and 10-task samples are small, with wide intervals in some cells (for example 85.00 ± 13.23) ([arXiv 2606.10662v3](https://arxiv.org/pdf/2606.10662)).
- **[IND] Decomposition depends on coupling.** On a tightly coupled migration, Codex passed 2/6 decomposed and 3/3 single-worker. On independent fixes, both passed 3/3, and Claude was 30% faster with subagents (116.0s vs 167.5s). The authors call these cells small and exploratory ([arXiv 2608.16630](https://arxiv.org/pdf/2608.16630)).
- **[IND] Same result, very different token use.** Across configurations that all passed, peak per-turn context varied 1.8x and cumulative input varied 12.8x (293,882 to 3,752,134 tokens), and the authors attribute this to refetch rate ([arXiv 2608.16630](https://arxiv.org/pdf/2608.16630)).
- **[IND] Not repository-scale.** Across ten benchmarks with GPT-4.1, only EvoAgent beat the single-agent reference on pooled accuracy (79.70% vs 76.65% at 1.27x tokens). ChatEval used 4.34x tokens and scored lower. On HumanEval and MBPP, several workflows did beat the reference, but these are function-level tasks ([arXiv 2606.05670](https://arxiv.org/html/2606.05670v2)).
- **[VENDOR] Mission telemetry, not outcomes.** Median mission about 2 hours, 14% over 24 hours, longest 16 days, median 12x the tokens of a normal session, no success rate or dollar figures. "Serial execution with targeted parallelism" worked better in the authors' experience. The extracted date read 26 Feb 2025, which cannot be right given that the post names Opus 4.6, so the date needs checking ([Factory](https://factory.com/news/missions)). The docs still call parallelisation an open question and cost versus quality unresolved ([Factory docs](https://docs.factory.com/missions/overview)).
- **[VENDOR] 16-agent C compiler, no control arm.** Nearly 2,000 sessions, about 2B input and 140M output tokens, just under $20,000, about 100K lines, builds Linux 6.9, 99% on most compiler test suites. Its generated code is slower than GCC with optimisations off. Coordination was a bare git repo, one container per agent, and lock files in `current_tasks/`, with no orchestrator. The author calls it an early research prototype ([Anthropic, 2026](https://www.anthropic.com/engineering/building-c-compiler)).
- **[VENDOR] Hundreds of agents, no controlled comparison.** Over 1M lines in about a week. Locks failed (20 agents performing like 2 or 3), flat structure made agents risk-averse, and an integrator role became a bottleneck and was removed. Planners, workers and a judge with periodic fresh starts were kept ([Cursor, Jan 2026](https://cursor.com/blog/scaling-agents)).
- **[VENDOR] Research, not coding.** 90.2% better than single-agent on an internal research eval, and about 15x chat tokens. The same post says coding has fewer parallelisable subtasks ([Anthropic, June 2025](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **[VENDOR] Reviewer agents.** Devin Review reports about 2 bugs per PR, about 58% severe, and works best with a clean context that sees only the diff. Cognition's conclusion: writes stay single-threaded, extra agents contribute intelligence, and unstructured swarms are "mostly a distraction". Its failure list: over-prescriptive managers, agents wrongly assuming shared state with children, and no cross-agent communication by default ([Cognition, 22 Apr 2026](https://cognition.com/blog/multi-agents-working)).

**Vendor cost statements [UNMEASURED]**
- Cursor: five parallel subagents use roughly five times the tokens of one agent, and a skill is usually cheaper for simple tasks ([docs](https://cursor.com/docs/subagents)).
- Codex: subagent workflows use more tokens than comparable single-agent runs ([docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
- Claude Code: teams use significantly more tokens, scaling with active teammates, and teammate cache lasts five minutes by default unless `subagentPromptCacheTtl` is `1h`. Listed failures include tasks not marked done, agents stopping early, and leads declaring completion early or implementing instead of waiting ([docs](https://code.claude.com/docs/en/agent-teams)).

**Checklist against ox (source read, not run)**
- Default depth limit is 2, and model-supplied `max_depth` is clamped to config (`src/subagent.js:119,524-528`). Compare: Claude Code 3, Droid flat (subagents cannot spawn), Cursor 2 levels. Amp's depth was not stated on the page read.
- `src/subagent.js` and `src/agent-teams.js` have no worktree creation that grep could find, only an empty `worktrees: {}` field (`src/agent-teams.js:153,250`). Check whether concurrent fan-out shares a checkout. Worktree isolation does exist in `src/build-room.js`, `src/arena.js` and `src/evolve.js`.
- `src/build-room.js` already merges a part only after tests pass and a different agent reviews it, with two rounds at most. This matches the review-with-clean-context evidence. Check that the reviewer really sees only the diff.
- Test for the DeLM failure: does a parent with a pending commit exit with an empty patch when a child is killed or idles out? Does partial child work survive?
- `src/race-select.js` ranks by repro test, project checks, cross-lane tests and security findings, with the judge only breaking ties. Compare with Cursor's `/best-of-n`, which leaves the choice to the user.
- Mailbox text is screened on write and read for credentials and injection (`src/agent-teams.js:5-13`). Claude Code similarly marks peer messages as not coming from the user and bars relayed approvals ([docs](https://code.claude.com/docs/en/agent-teams)). Check that a peer message cannot satisfy an ox approval.
- Add an "independence gate": estimate coupling from the plan's file sets before fanning out, based on the coupling result above.
- Record delegated cost separately so `ox trace` can show the parent-versus-children split, since the published gap is 1.5-2.9x.

### Inferences
- Default to one writer. Fan out for read-only exploration, review and clearly independent file sets.
- DeLM's two ideas are cheap to test in ox separately from its full design: publish findings as they arrive so peers can reuse them, and do not let the parent block on children to deliver a patch.
- Project-scale vendor runs show the possible output, not efficiency, because none has a single-agent arm.

### Gaps
- No independent head-to-head test of Claude Code agent teams, Factory Missions, Cursor's cloud agents or Amp was found. DeLM tested native subagents only.
- Whether Factory's Mission artifacts have known corruption or replay failures: one search result named `features.json` churn, but it was on a proxy domain and the real GitHub URL returned 404, so it is unverified and should not be cited.
- Merge conflict handling in Cursor's worktree flow is undocumented on the page read. Codex's maximum nesting depth was not on the page read.
- OpenHands details rest on search excerpts, not a full read. The 2025 Cognition essay "Don't Build Multi-Agents" was not read.

## Long-running work: checkpoints, resume, fork, spec and goal modes

### Takeaway
Fork, resume and spec flags are now table stakes and well documented, but none has a controlled evaluation. What separates harnesses is who decides completion and how much state survives restart. Checkpoints in Claude Code do not cover Bash-only changes or most subagent edits, and teammates do not survive resume, so git remains the true recovery layer.

### Cited Findings

**Sessions and fork**
- `droid exec`: `-s/--session-id` continues in place. `--fork <id>` starts a new run from that history with a fresh ID and leaves the original unchanged. `--use-spec` starts in spec mode, with `--spec-model` and `--spec-reasoning-effort` for that phase. `-w` runs in a worktree. Runs are read-only by default, and exceeding the `--auto` level exits non-zero while leaving earlier edits in place ([docs](https://docs.factory.com/cli/droid-exec/overview)).
- Mission flags: `--mission`, `--worker-model`, `--validator-model`, and settings that skip scrutiny or user testing ([docs](https://docs.factory.com/missions/reference)). Custom droids are read-only in spec mode ([docs](https://docs.factory.com/cli/configuration/custom-droids)).
- Claude Code: `/branch` or `claude --continue --fork-session` to branch ([docs](https://code.claude.com/docs/en/checkpointing)).

**Checkpoints in Claude Code**
- A checkpoint is created per prompt that starts a turn. Snapshots are kept for the 100 most recent checkpoints and swept after about 30 days. Restore options are code, conversation, both, or summarise from or up to a point ([docs](https://code.claude.com/docs/en/checkpointing)).
- Not restored: files changed only by Bash, edits by most subagents (including the default background forked skill), external edits, and symlinked or hard-linked paths. It is "not a replacement for version control" ([docs](https://code.claude.com/docs/en/checkpointing)).

**Goal modes**
- Claude Code `/goal` is a session-scoped prompt-based Stop hook. A small fast model checks after each turn and returns not yet met, met, or impossible. The evaluator cannot run tools, so it judges only what the transcript shows. Condition up to 4,000 characters. Resume restores the condition but resets turn count, timer and token baseline. No tool use for several turns stops the loop. Three automatic retries, then pause. Evaluation is deferred while background work runs, with check-ins from 30 minutes ([docs](https://code.claude.com/docs/en/goal)).
- Codex `/goal` is reported as experimental in v0.128.0 (30 Apr 2026), default-on from v0.133.0 (21 May 2026), persisted per thread and surviving resume, with token budgets. These details come from one independent blog and were not confirmed in OpenAI docs ([secondary](https://codex.danielvaughan.com/2026/07/23/codex-cli-goal-mode-long-horizon-autonomous-workflows-ralph-loop-token-budgets/)).
- Missions: validation at milestone ends, pause and steer rather than fire-and-forget, and "long-running plans accumulate errors". A scriptable way to exercise the app is needed or the mission cannot reliably verify its work ([docs](https://docs.factory.com/missions/overview)).

**Compaction and restart**
- Amp removed compaction on 23 Oct 2025 in favour of Handoff, a goal-directed draft prompt plus file list for a new thread, arguing that compaction encourages long threads and stacks summaries. No data was given ([Amp](https://ampcode.com/news/handoff)). Current Amp docs say Task subagents are compacted "the same way it compacts a thread" and list a system model for compacting long conversations, so compaction appears to be back at least in part ([docs](https://ampcode.com/docs/models-and-subagents)). These two sources conflict, and the current docs should win.
- **[VENDOR]** Factory's probe-based evaluation over 36,611 messages scored structured anchored summaries 3.70, Anthropic 3.44, OpenAI 3.35 on a 0-5 scale. Artifact trail was weak for all (2.19-2.45). No significance tests, an LLM judge, and Factory's summaries came from production while the others came from API calls ([Factory, Dec 2025](https://factory.com/news/evaluating-compression)).
- **[VENDOR]** OpenHands reports its summarising condenser cuts API cost by up to 2x with no performance loss ([paper excerpt](https://arxiv.org/pdf/2511.03690)).
- Claude Code re-attaches invoked skills after compaction: first 5,000 tokens each, 25,000 combined, newest first, so older skills can be dropped ([docs](https://code.claude.com/docs/en/skills)).
- **[VENDOR]** Cursor needs periodic fresh starts to counter drift and tunnel vision ([Cursor](https://cursor.com/blog/scaling-agents)). Anthropic's compiler loop likewise restarts fresh sessions after each one ends ([Anthropic](https://www.anthropic.com/engineering/building-c-compiler)).
- **[IND]** A missing fact produces wrong work rather than absent work: agents fabricate a file or guess a value. Only 37% of pooled trials said they were blocked, ranging from 100% (Opus) to 0% (GPT-5 with Codex, GLM-5.2 with opencode) ([arXiv 2608.16630](https://arxiv.org/pdf/2608.16630)).

**Checklist against ox (source read, not run)**
- `forkSession` copies transcript events into a new session with a `fork` event (`src/session.js:410-417`), reachable by `/fork` (`src/cli.js:8797`). Grep found `--resume` but no `--fork` CLI flag in `src/cli.js`. A headless fork is a checkable gap against `droid exec --fork` and `--fork-session`.
- Grep found no `--spec-model` or `--use-spec`. ox has `ox build --spec-only`, `--plan-only` and `--plan`, plus `src/plan-first.js`. Check whether planning can use a different model from execution.
- `src/goal.js` stores goals as transcript events, says "a claim is not evidence" (tool calls prove items, assistant prose does not), and treats a limit as non-success (`noteGoalStop` keeps it active). This is stricter by design than Claude Code's transcript judge. Test whether an evidence token match can be satisfied by an unrelated tool call (`requiredCoverage`, `salientTokens`).
- `src/checkpoints.js` takes explicit `files` and has undo, rewind, diff and prune (`keep = 10`). Test Claude Code's known holes: Bash-only edits, subagent edits, symlinks.
- Test resume after kill with live children: are orphaned subagents and mailboxes reported or silently lost? Claude Code documents its own limit here.
- Test that spend counters reset or persist as stated on resume, since Claude Code documents a reset.

### Inferences
- A completion judge that only reads the transcript can be fooled by whatever the worker prints. Independent validators that run things, as in Missions and in ox's evidence rule, address this, but no data compares them.
- Artifact tracking scored worst in Factory's evaluation, so explicit structured file ledgers are a sensible default for compaction.

### Gaps
- No controlled evaluation was found of spec mode vs no spec mode, or of checkpoints or fork on outcomes. Behaviour differences here are documented, not measured.
- Mission resume behaviour and artifact formats were not on the pages read.
- Codex goal and token-budget details lack an official confirmation in this research.

## Memory: instruction files, auto memory, graphs, token cost, benchmarks

### Takeaway
The best evidence favours short, human-written, non-obvious rules and points against generated overviews and transcript-heavy retrieval. Instruction files added about 20% to cost without a significant gain in resolution, and eleven of twelve memory-system pairings failed to beat memory off in a repository test. LOCOMO-style scores do not predict this and have serious flaws.

### Cited Findings

**What is injected and how much**
- Claude Code: all CLAUDE.md files load every session and should stay under 200 lines. Auto memory loads the first 200 lines or 25KB. Imports do not reduce context cost. By default AGENTS.md loads only if no CLAUDE.md exists in the working directory or above it ([docs](https://code.claude.com/docs/en/memory)).
- Non-fork subagents do not inherit auto memory, and `memory:` scopes give each its own `MEMORY.md` with the same limit ([docs](https://code.claude.com/docs/en/sub-agents)).
- Codex: one file per directory from root to cwd, `AGENTS.override.md` first, 32 KiB default for `project_doc_max_bytes`, and it stops adding files at the limit ([docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). Third-party pages disagree (one says 65536), and the official page should win ([secondary](https://agentconfig-ing.pages.dev/files/agents-md)).
- Codex Memories are reported as background-generated local summaries under `~/.codex/memories/` with separate read and write switches. This comes from a competitor's blog, and the official page could not be reached ([secondary](https://mem0.ai/blog/how-memory-works-in-codex-cli)).
- **[IND]** MemPalace's wake-up cost is about 170 tokens, per its audit ([arXiv 2604.21284](https://arxiv.org/pdf/2604.21284)).

**Instruction file evidence**
- **[IND]** ETH Zurich and LogicStar tested Claude Code, Codex (two models) and Qwen Code on 300 SWE-bench Lite tasks and 138 tasks from repos with real context files. LLM-generated files lowered resolution by 0.5% and 2% (not significant, p=0.87 and 0.37) and raised cost by 20% and 23% (p<0.001%). Developer-written files raised resolution by 2.4% (p=0.21) and cost by up to 19%, and beat generated files significantly (p=0.038). They helped every agent except Claude Code ([arXiv 2602.11988v3, 29 Sep 2026](https://arxiv.org/pdf/2602.11988)).
- **[IND]** Instructions are followed, but repository overviews do not help. 100% of Sonnet-4.5-generated files contained overviews. The authors suggest omitting LLM-generated files for now and describing only needed requirements. The benchmark favours Python and measures resolution rather than maintainability ([arXiv 2602.11988v3](https://arxiv.org/pdf/2602.11988)). A secondary summary's "about 4%" for developer files conflicts with the paper's 2.4%, so use the paper ([secondary](https://api.emergentmind.com/papers/2602.11988)).
- **[IND]** A written standard beats code examples and a stale one does harm: 100% of decisions used the better form with a correct standard, 33% with code only, and 0% with a standard demanding the worse form (10 trials per condition, 3,385 decisions) ([arXiv 2608.16630](https://arxiv.org/pdf/2608.16630)).

**Memory systems on actual coding tasks**
- **[IND*]** VibeMemBench used 111 targets from 90 repos with four seeds. Eleven of twelve pairings of Mem0, SimpleMem, MemoryOS and A-MEM with three solvers failed to exceed memory off (Mem0 -1.8 to -5.5 points). A pre-selected verified experience gave +0.0 to +4.5 points on five solvers, with all intervals crossing zero. Irrelevant text cost 0.7-3.4 points ([arXiv 2609.23570](https://arxiv.org/html/2609.23570)).
- **[IND*]** Of 231 failing pairings, 69.3% came from how a record was rendered (largest cause: instruction pollution from raw transcripts), 16.0% from coverage misses, 13.4% from use failures, 1.3% from ranking misses ([arXiv 2609.23570](https://arxiv.org/html/2609.23570)).
- Limits of that study: no Claude or GPT solvers, one top-ranked record injected before the run, oracle-assisted target selection, no memory-side cost, and no instruction-file arm ([arXiv 2609.23570](https://arxiv.org/html/2609.23570)).
- **[VENDOR]** MemCoder reports gains on SWE-bench Verified, but this is the authors' own method and its numbers were not read ([arXiv 2603.13258](https://arxiv.org/pdf/2603.13258)).
- AMB uses `claude_md` rather than a bare agent as baseline, but results looked unfinished ([page](https://gde05-agent-memory-bench.static.hf.space/index.html)).
- Zhou et al. compared 12 systems and report no single best architecture and that localised maintenance is more cost-efficient than global reorganisation. The abstract gives no numbers ([arXiv 2606.24775](https://arxiv.org/abs/2606.24775)).

**Published recall benchmarks and critiques**
- **[VENDOR dispute]** LOCOMO is too short and full context beats memory systems: conversations are about 16,000-26,000 tokens, and a full-context baseline scored about 73% against Mem0's best of about 68%. Zep corrected its own score to 75.14% ± 0.17, says Mem0 misconfigured Zep at 65.99%, and notes missing ground truth, wrong speaker attribution and ambiguous questions ([Zep, May 2025](https://www.getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)). A secondary page gives Mem0's figure for Zep as 58.44%, which conflicts with Zep's account ([secondary](https://atlan.com/know/zep-vs-mem0/)).
- **[IND*]** Scoring defects: 444 of 446 category-5 items have empty gold answers and the Mem0 runner's matcher returns false for them, so about 23% of the set is unscorable. Category 4 (42%) uses substring matching on paraphrases. The author's system scores 8.8% on LOCOMO and 96% on his own benchmark, so he has a stake ([arXiv 2604.10981](https://arxiv.org/pdf/2604.10981)).
- **[IND*]** Reproduction: the same paper cites mem0 issues #2800, #3943 and #3944 on failure to reproduce, and argues that LongMemEval and BEAM cannot distinguish a memory system from a long-context model ([arXiv 2604.10981](https://arxiv.org/pdf/2604.10981)).
- **[IND]** MemPalace's 96.6% Recall@5 is attributable to verbatim text with ChromaDB's default embeddings, not its spatial structure. Its compressed mode scored 84.2%. Its 100% LoCoMo used top_k=50, and at reasonable k it was 60.3% raw or 88.9% with reranking. Maintainers later replaced the 100% headline with 98.4%. The auditors are unaffiliated with the project as far as the paper shows ([arXiv 2604.21284](https://arxiv.org/pdf/2604.21284)).
- **[VENDOR]** Mem0 lists 91.6 on LoCoMo, 93.4 on LongMemEval, and 64.1 / 48.6 on BEAM 1M / 10M ([Mem0](https://mem0.ai/library/agent-memory/zep-vs-mem0-which-ai-memory-layer-should-you-choose)). Another page gives 94.4 on LongMemEval for the same algorithm ([secondary](https://atlan.com/know/zep-vs-mem0/)). An independent test reportedly got Mem0 49.0% against 82.4% for plain long context with a cheap extractor, which was not confirmed at primary source ([secondary](https://www.implicator.ai/claude-mem-leads-ai-coding-memory-plugin-ranking/)).

**Checklist against ox (source read, not run)**
- `MAX_INDEX_LINES = 150`, `MAX_INDEX_BYTES = 20KB`, re-injected into every prompt (`src/memory.js:23-24,44`), inside the published 200 lines / 25KB range. Project instructions cap at 48,000 characters (`src/context.js:10`), above Codex's 32 KiB. Measure real token cost per turn against the 20% finding with `bench/token-overhead`.
- ox loads `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.ox.md` with later files winning (`src/context.js:38-41`). Claude Code by default loads CLAUDE.md or AGENTS.md, not both. Check for duplicates when one file is a symlink or import of another, which Claude Code explicitly dedupes.
- Any `/init` or `ox wiki` style generated file should not produce repository overviews by default, per the ETH result. Also `src/context.js` adds a file tree share (`TREE_BUDGET_SHARE = 0.125`), so test tree-on vs tree-off on resolution and cost, as it functions like an overview.
- `src/memory-graph.js` implements supersession, bi-temporal facts, BM25 plus entity hop, and RRF. `bench/memory/run.mjs` is LongMemEval-style recall on its own scripted sessions, which is exactly what VibeMemBench says does not establish coding value. Add a paired coding arm: memory off, instruction file only, memory on, irrelevant text control, with several seeds.
- Check render form: does injected memory contain imperative text from transcripts? Episodes cap at 40 lines (`MAX_EPISODE_LINES`, `src/memory.js:25`), and read-time screening exists for injection shapes (`src/memory.js:293`). Test for instruction pollution specifically, since a screen for injection is not the same as a filter on transcript volume.
- Add staleness handling for project rules, given the 0% result for a wrong standard: for example, flag memory lines contradicted by current code.

### Inferences
- A sensible default for ox: short human rules, non-injected retrieval on demand, verified lessons over transcript storage, and every memory feature gated by a coding benchmark with an irrelevant-text control.
- The disagreement over LOCOMO means no ox marketing claim should rest on it. Publishing a full-context baseline next to any score would avoid the known traps.

### Gaps
- No study compares CLAUDE.md alone, auto memory and memory graphs on frontier models on coding tasks. VibeMemBench excludes those models and has no instruction-file arm.
- Measured per-turn token cost of auto memory in Claude Code, Codex Memories or Droid was not found. Only caps are documented.
- Factory Droid's memory injection was not researched beyond compaction, and the official Codex Memories page could not be fetched.
- Cost of memory-side extraction is unmeasured in VibeMemBench.

## Skills and plugins: SKILL.md conventions, interoperability, overflow behaviour

### Takeaway
SKILL.md is a real shared core, with `name`, `description` and a folder, but paths and extension fields differ. Overflow behaviour differs in ways that matter: Claude Code always keeps every name and drops descriptions for the least-used skills, while Codex shortens all descriptions and may drop whole skills. No measured evidence on overflow's effect on outcomes was found.

### Cited Findings

**The standard**
- Required: `name` (1-64 chars, lowercase alphanumerics and hyphens, no leading, trailing or double hyphen, must match parent directory) and `description` (1-1024 chars). Optional: `license`, `compatibility` (max 500), `metadata`, experimental `allowed-tools`. Progressive disclosure targets about 100 tokens for metadata, under 5,000 tokens for instructions, under 500 lines in SKILL.md, and references one level deep. `skills-ref validate` checks files ([agentskills.io](https://agentskills.io/specification)).
- **[IND]** A source-code study of eleven harnesses found SKILL.md in 9 of 11, ahead of MCP at 8 of 11. None retrieves code with vector embeddings ([arXiv 2609.00006](https://arxiv.org/abs/2609.00006)). Claims of "30+" adopting tools come only from a blog ([secondary](https://codex.danielvaughan.com/2026/05/05/agent-skills-open-standard-portable-skills-codex-cli-cross-agent/)).

**Portability differences**

| Harness | Locations | Conflict rule | Extensions |
|---|---|---|---|
| Claude Code | `.claude/skills`, user, plugin, managed | Not read in detail | `when_to_use`, `context: fork`, `paths`, `disable-model-invocation`, others. Non-standard keys fail outside Claude Code at packaging or upload ([docs](https://code.claude.com/docs/en/skills)) |
| Codex | `.agents/skills` from cwd to repo root, `$HOME/.agents/skills`, `/etc/codex/skills`, bundled | Same names are both kept, not merged | `[[skills.config]]` to disable ([docs](https://learn.chatgpt.com/docs/build-skills)) |
| Droid | `.factory/skills`, plus `.agents/skills` and `.agent/skills`, and personal equivalents | Project over personal over built-in. `allowed-tools` is metadata only, not a security boundary | `enabled`, `user-invocable`, `disable-model-invocation`, `version`. Page does not mention `.claude` ([docs](https://docs.factory.com/cli/configuration/skills)) |

**Overflow behaviour**
- Claude Code: every skill name stays. The budget is 1% of the context window. On overflow it drops descriptions starting with the least-invoked skills. Each entry is capped at 1,536 characters (description plus `when_to_use`), configurable with `skillListingMaxDescChars`. Budget set by `skillListingBudgetFraction` or `SLASH_COMMAND_TOOL_CHAR_BUDGET`. `skillOverrides` can set `"name-only"`. Signals are a debug-log warning, `/doctor`, `/skill-doctor` and `/context` ([docs](https://code.claude.com/docs/en/skills)).
- Codex: 2% of the context window by default, 8,000 characters if unknown, raisable with `skills.max_context_tokens` up to 10,000 tokens. It shortens descriptions first and for large sets "may omit some skills from the initial list and show a warning" ([docs](https://learn.chatgpt.com/docs/build-skills)).
- A July 2026 blog says the 2% ceiling was hardcoded, reports that v0.146.0 compressed metadata for about 20% more skills keeping full descriptions in OpenAI's internal test **[VENDOR, secondary]**, and says warnings now name truncated skills. The configurable setting in the official docs conflicts with the hardcoded claim, and the docs are likely newer ([secondary](https://codex.danielvaughan.com/2026/07/30/codex-cli-skill-context-budget-pressure-v0146-retention-truncation-profile-strategies/)).
- Droid: overflow and listing limits are not documented on the page read ([docs](https://docs.factory.com/cli/configuration/skills)). Cursor and Amp overflow were not verified.
- Skill testing: Claude's skill-creator benchmarks pass rate, time and tokens with and without a skill, and runs description-trigger tuning. `claude plugin eval` can grade `tool_used: Skill` ([docs](https://code.claude.com/docs/en/skills)).

**Checklist against ox (source read, not run)**
- `MAX_INDEX_SKILLS = 25` and `MAX_DESCRIPTION_CHARS = 1024` (`src/skills.js:9-10`). The cap is count-based, not a share of context as in Claude Code and Codex. Check small local-model contexts and very large ones.
- `renderFocusedSkillIndex` gives full lines to at most 6 skills sharing words (over 3 letters) with the task, lists others by name per folder, and summarises those past the cap as "and N more". An empty task gets names only (`src/skills.js:212-243`). Rival harnesses rank by use frequency or none. Check that synonyms and short words do not hide the right skill, for example "PR" or "CI", which the 4-letter filter excludes. This looks like a real weak spot worth a test.
- Unmatched skills past position 25 appear only as a count, unlike Claude Code's "every name stays" rule (task matches are picked from all skills, so they still show). Check whether the model can still find the rest.
- ox scans `.agents/skills` and `.claude/skills` (`src/skills.js:16-19`). Grep showed no `.factory/skills`. Decide whether to add it for Droid migrants.
- Validate against the spec: name must match parent directory, no double hyphens, `compatibility` max 500. Only the lowercase rule was confirmed (`src/skills.js:135`). Check that unknown keys load without failure.
- Add a visible overflow signal and an equivalent of `/skill-doctor` or `/context` showing post-budget size.
- Check skill text after compaction: does ox re-attach an invoked skill with a cap, as Claude Code does (5,000 / 25,000 tokens)?
- Check that the index text, re-screened on read, cannot be a route for injection when a skill arrives from a shared `.agents/skills` folder. Screening exists at `src/skills.js:187-205`.

### Inferences
- Portable authoring rule: keep to the six spec fields, put trigger words first, and stay within 1,024 characters. Put harness-specific behaviour in optional extensions that fail soft.
- Dropping least-used descriptions favours existing habits, while proportional shortening hurts everything a little. Neither has been compared on outcomes, so ox's task-match method is a defensible third option only if a trigger benchmark supports it.

### Gaps
- No published measurement was found of skill-trigger accuracy vs catalogue size, or of outcomes under overflow.
- Cursor and Amp skill paths and overflow were not confirmed. The `.agents/skills` adoption count across all tools is unverified beyond the 9-of-11 harness study, which covers SKILL.md support generally.
- Plugin format interoperability (manifests, hooks) was not researched in depth and does not appear to be standardised in the sources read.
