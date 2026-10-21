# Competitive Landscape of AI Coding Agents (CLI + Desktop), as of October 2026

Source-quality note: Most 2026 coverage is secondary (blogs, aggregators, comparison sites). Official changelogs were not fetched directly for most products. Where only a secondary source exists, it is flagged "(secondary)". Model names, versions and benchmark figures conflict between sources. Treat precise numbers as indicative.

## Which agents lead today, and what does each do best?

### Takeaway
The market has consolidated around three vendor-integrated agents (Claude Code, OpenAI Codex, Cursor), with Google moving users from the open-source Gemini CLI to the closed Antigravity CLI. A tier of open-source, any-model harnesses (OpenCode about 210K stars, Pi about 109K, Cline, Goose, Kilo) competes on openness. Several 2025 names have died or stalled: Roo Code shut down, Continue is unmaintained, and Aider is slowing. Each leader now ships the same core (subagents, hooks, skills, plugins, MCP, cloud/background agents, mobile control). Leaders now differ on autonomy, how long the agent runs, and distribution.

### Cited Findings

**Claude Code (Anthropic), closed, subscription (Pro $20, Max $100/$200) or API**
- Harness: 30 lifecycle hook events, Skills, plugins, subagents, MCP, and Dynamic Workflows (parallel subagents). Reported SWE-bench Verified 88.6% and Terminal-Bench 2.1 74.6% (Opus 4.8, vendor-reported); Opus 4.8 shipped May 28, 2026 — [Firecrawl, Aug 2026](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- Dynamic Workflows (v2.1.154, May 28, 2026): Claude writes its own JavaScript orchestration scripts to coordinate many subagents. These are distinct from subagents (bounded delegation) and agent teams (persistent role-based collaboration) — [Context Studios (secondary)](https://www.contextstudios.ai/fr/blog/claude-code-dynamic-workflows-agenten-orchestrierung)
- Agent teams (v2.1.178, June 15, 2026): every session now has one implicit team. Teammates are spawned via the Agent tool's name parameter. In v2.1.172 subagents could nest up to 5 levels deep — [ClaudeMarket changelog summary (secondary)](https://claudemarket.ai/blog/claude-code-changelog)
- Routines (April 14, 2026, research preview): a saved config of prompt, repos and MCP connectors that runs on cloud infra. Triggers are a schedule or an HTTP POST API call. The desktop was redesigned the same day for parallel sessions, with a multi-session sidebar, an integrated terminal, and a preview pane for HTML/PDF — [claudeainews (secondary)](https://www.claudeainews.com/news/claude-code-routines-desktop-redesign); [buildfastwithai (secondary)](https://www.buildfastwithai.com/blogs/claude-code-desktop-redesign-2026)
- Remote Control: drive a local session from phone, tablet or browser. It launched as a research preview in Feb 2026 for Max. An Aug 2026 update allows starting new sessions from the phone on any machine running the remote-control command — [TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move); [pasqualepillitteri (secondary)](https://pasqualepillitteri.it/en/news/12249/claude-code-start-session-from-phone)
- Claude Code Security (Feb 21, 2026, research preview for Team/Enterprise): scans codebases for vulns and proposes patches. It runs a second pass that tries to prove or disprove each finding to cut false positives. Code Review (Mar 9, 2026) sends agent teams to review every PR. As of Oct 2026, Claude Security is reported as a web app for Enterprise and a Claude Code plugin for Pro/Max/Team — [aggregator via search](https://aitoolsreview.co.uk/insights/claude-code-2026); [SmartScope, verified Oct 6, 2026](https://smartscope.blog/en/blog/claude-security-plans-pricing-setup-differences-plugin-codex-2026/)
- Common complaint: a 5-hour rolling window plus a weekly cap, shared across claude.ai and Claude Code. It is Claude-centric, which limits model switching — [ofox.ai (secondary)](https://ofox.ai/blog/agentic-coding-claude-codex-gemini-cursor-2026/)

**OpenAI Codex (CLI, app, IDE extension, cloud), CLI is open source (Apache-2.0, Rust)**
- Harness: skills, plugins with marketplace, subagents, hooks, MCP, kernel-level sandbox. Pricing: Go $8, Plus $20, Pro from $100. Terminal-Bench 2.0 82.7% and SWE-Bench Pro 58.6% with GPT-5.5 (vendor-reported) — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- `/goal` (CLI v0.128.0, Apr 30, 2026, GA May 21, 2026): a persistent multi-turn objective with lifecycle states (pursuing, paused, achieved, unmet, budget-limited). Goals survive restarts and can be managed remotely. It works in the Codex app, IDE extension and CLI. Reported as running for hours unattended — [noqta](https://www.noqta.tn/en/news/openai-codex-cli-goal-autonomous-agentic-coding-2026); [gihyo.jp](https://gihyo.jp/article/2026/05/codex-goal)
- Codex in ChatGPT mobile (May 14, 2026 preview): steer sessions that keep running on a laptop, Mac mini or devbox. From the phone you can start tasks, read terminal output, inspect diffs, approve risky commands, switch models, and get notifications — [pasqualepillitteri (secondary)](https://pasqualepillitteri.it/en/news/2564/codex-chatgpt-mobile-vs-claude-code)
- Codex CLI governance features (Apr 2026): Guardian Auto-Review, OTEL hook metrics, MITM pattern matching (secondary, unverified) — [Codex Knowledge Base](https://codex.danielvaughan.com/page116/)

**Cursor (Anysphere), closed, Free / Pro $20 / Pro+ $60 / Ultra $200**
- Supports rules, MCP, hooks, skills, plugins and subagents. It reads `.claude/agents` and `.codex/agents`, so it imports rivals' agent definitions. Composer 2.5 in-house model (May 18, 2026). Series D at a $29.3B valuation. Artificial Analysis Coding Agent Index: 62 — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- Cursor 3 "Glass" (Apr 2, 2026): an Agents Window showing all local and cloud agents, including ones started from mobile, web, Slack, GitHub and Linear. Prefix `&` to hand a CLI task to the cloud. Cloud agents run on isolated VMs. `/in-cloud` moves a local session to the cloud — [codepick.dev (secondary)](https://codepick.dev/en/guides/cursor-3-new-features/); [freeacademy](https://freeacademy.ai/lessons/agents-window-cloud-agents)
- Bugbot PR review: reported as 90s per review (down from 5 min) with 10% better detection. Three effort levels. `/review` is in Cursor 3.7+ (single third-party source) — [skills-hub (secondary)](https://skills-hub.ai/blog/cursor-3-cloud-agents-2026); [Cursor forum](https://forum.cursor.com/t/review-bugbot-is-missing-on-cloud-agents-launched-from-grok-bot/170096)
- Cursor cloud agents can click through browsers in cloud VMs — [ofox.ai (secondary)](https://ofox.ai/blog/agentic-coding-claude-codex-gemini-cursor-2026/)

**Google: Gemini CLI to Antigravity / Antigravity CLI (`agy`)**
- Since June 18, 2026, personal Google accounts (free, AI Pro, Ultra) moved to the closed-source Antigravity CLI. Gemini CLI (Apache-2.0) remains for enterprise, GCP and API-key users. Qwen Code is a diverged fork of Gemini CLI — [developertoolkit.ai, updated Oct 12, 2026](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Antigravity launched Nov 20, 2025: Agent Manager, subagents, browser use, Agent Skills, free for individuals. Antigravity 2.0, CLI, SDK and Managed Agents were announced at I/O 2026. Gemini 3.5 Flash scores Terminal-Bench 2.1 76.2% — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)

**GitHub Copilot (agent mode, CLI, cloud agent), closed**
- Free / Pro $10 / Pro+ $39 / Max $100, metered in AI Credits. Multi-model up to Opus 4.8 and GPT-5.5. The cloud agent runs in GitHub Actions (issue to PR) with a firewall on by default — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- Copilot CLI: `/delegate` hands off to the cloud and opens a PR. Ships GitHub's MCP server by default. `/model` discovers local Ollama models. Usage-based billing since June 1, 2026. Local sandboxing GA Oct 7, 2026 — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- The cloud agent starts more than 20% faster, and sessions launch from Visual Studio (Apr 2026) — [GitHub changelog Apr 2026](https://github.blog/changelog/month/04-2026/)

**OpenCode (Anomaly), open source MIT, BYOK, about 210K stars**
- Terminal and desktop app, any provider (75+), Tab switches between build and read-only plan agents, plus LSP, skills, a headless server and AGENTS.md. Claude subscriptions are not allowed, API key only. The original Go repo is archived and the live repo is `anomalyco/opencode` — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/); [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)

**Pi**: open source (MIT), minimal and hackable terminal agent, about 109K stars. Third-party orchestrators (herdr, Orca, Sculptor, CC Switch) support it — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)

**Cline / Roo / Kilo**
- Cline: Apache-2.0, about 69K stars. VS Code and JetBrains extension plus CLI, desktop app and SDK. Plan/act toggle. Recommended successor for Roo users — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Roo Code shut down May 15, 2026 and was archived (README points to Cline and the ZooCode fork) — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Kilo Code: MIT, about 27K stars. Extension plus `kilo` CLI (an OpenCode fork). Code, Plan, Ask and Debug agents plus a marketplace. Memory bank deprecated in favor of AGENTS.md — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/). Claims 1.5M+ users — [terminaltrove (secondary)](https://terminaltrove.com/compare/ai-coding-agents/kilo-code-vs-warp-agent-cli/)

**Amp (formerly Sourcegraph, now `@ampcode/cli`), closed**
- Free Hobby tier (pay as you go or bring your own runners), Megawatt $20/mo. Subagents and an "Oracle" second-opinion model. Execute mode via `amp -x`. Since Oct 10, 2026, Claude Pro/Max subscriptions can be used via Mode > Claude Code — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/). "Deep mode" for autonomous research. No markup on API costs — [DEV map, Apr 2026](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob)

**Goose**: Apache-2.0, about 55K stars. Now a Linux Foundation AAIF project (repo moved from `block/goose` to `aaif-goose/goose`). Desktop, CLI and API. Vendor-neutral, also handles non-code tasks — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)

**Factory Droid**: closed. Pro $20, Plus $100, Max $200 per month; Teams $60/team + $40/seat. Headless `droid exec`, read-only by default, with tiered auto-approval. Mission Mode runs multi-agent orchestration with worker and validator agents. Site moved to factory.com — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/). Droid with GPT-5.3-Codex is #10 on Terminal-Bench 2.0 at 77.3% — [Snorkel TB2 leaderboard](https://snorkel.ai/leaderboard/terminal-bench-2-0/)

**Warp**: open-sourced its client (AGPL) on Apr 28, 2026, positioned as an "agentic development environment" powered by Oz. Oz is a cloud agent orchestration platform: interactive local agents plus autonomous cloud agents triggered by events, schedules, Slack, GitHub, CI or API, with shareable runs, a headless CLI and REST. OpenAI is the flagship sponsor. Warp hosts third-party CLI agents (Claude Code, Codex, Gemini CLI, OpenCode) — [Warp press release](https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment); [i-programmer](https://www.i-programmer.info/news/90-tools/18852-warp-the-open-source-agentic-development-environment-goes-open-source.html). The standalone Warp Agent CLI was released Aug 4, 2026 and has voice mode — [terminaltrove (secondary)](https://terminaltrove.com/compare/ai-coding-agents/droid-vs-warp-agent-cli/)

**Zed**: editor-first. Agent Panel with MCP tools and checkpoints. Runs external agents (Claude Code, Gemini CLI, Codex, Copilot) via ACP (Agent Client Protocol), described as adopted by 20+ agents and JetBrains — [implicator.ai (secondary)](https://www.implicator.ai/zed-and-warp-both-ship-ai-coding-they-bet-on-opposite-surfaces-2/); [soloterm](https://soloterm.com/zed-vs-warp)

**Hermes Agent (Nous Research)**: MIT, BYO model. A self-improving personal agent rather than a pure coding tool. It writes reusable Skill documents (agentskills.io standard) from past work, keeps persistent memory, and is reachable through Telegram, Discord, Slack, WhatsApp, Signal, email or terminal. It is reported at about 230K GitHub stars, with a desktop app and paid cloud option (Aug 2026 newsletter). Launch date conflicts (July 2025 vs Feb 2026) — [agentic-ai docs](https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/hermes-agent/); [hermes-agent.org](https://hermes-agent.org/about/); [trendingtopics](https://www.trendingtopics.eu/hermes-nous-research/)

**Devin (Cognition)**: closed. Free, Pro $20, Max $200, Teams from $80/mo. Parallel "Managed Devins" in cloud VMs. Devin Desktop (from the Windsurf acquisition). Cognition reports a 67% PR merge rate (up from 34%) — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents). Reported $1B raise at a $26B valuation (June 2026, secondary) — [mojoauth](https://mojoauth.com/blog/top-10-ai-dev-agents)

**Jules (Google)**: async cloud agent, 15 free tasks per rolling 24h, plus a paid AI Pro tier (secondary) — [ssojet](https://ssojet.com/blog/best-cloud-coding-agents)

**Kiro (AWS)**: spec-driven, generates requirements before code — [DEV map](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob). Amazon Q Developer was sunset (new signups blocked May 15, 2026) and replaced by Kiro. "Kiro Web autonomous mode" is listed among cloud agents (secondary) — [capy.ai](https://capy.ai/articles/best-cloud-coding-agents-2026)

**Aider**: slowing. Last push May 22, 2026, last PyPI release 0.86.2 on Feb 12, 2026, and the README still recommends early-2025 models — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/). **Continue** CLI: README says no longer maintained — [same](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)

**Others**: Crush (FSL-1.1-MIT source-available, LSP-aware, usage metrics on by default), Qwen Code, Mistral Vibe (Devstral 2), Kimi Code CLI (claims a 100-agent swarm) — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/); [DEV map](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob)

### Inferences
- **Subscription access is a real wedge.** OpenCode can't use Claude subscriptions. Amp added Claude Pro/Max only on Oct 10, 2026, apparently by wrapping Claude Code. Running one harness on Claude, ChatGPT and Cursor subscriptions, as ox claims, is rare. It is worth leading with, and also worth checking regularly against vendor ToS changes.
- **Open-source consolidation favors ox.** Roo's shutdown, Continue's abandonment, Aider's stall, and Google closing Gemini CLI for consumers leave fewer actively maintained open, any-model agents: mainly OpenCode, Pi, Cline, Kilo, Goose and Hermes.
- **Cross-reading rivals' config is now competitive.** Cursor reads `.claude/agents` and `.codex/agents`, Kilo and Cline read AGENTS.md, and Zed and Warp host other agents via ACP. Ox should import Claude, Codex and Cursor configs and speak ACP if it does not already.

### Gaps
- No official changelog pages were fetched for Claude Code, Codex, Cursor or Copilot, so version and date details are secondary.
- I could not verify current GitHub star counts for Codex CLI, Gemini CLI, Goose or Cline beyond the Sep 26, 2026 snapshot.
- Hermes's "#1 coding app on OpenRouter" claim is unverified. Its star count comes from a newsletter.
- I found no reliable 2026 data on Zed's own pricing or agent changes, or on Jules and Kiro feature launches.
- I found no source for an OpenAI "Codex Security" product. Only SmartScope references it.

## What features are now table stakes?

### Takeaway
By late 2026, any serious coding agent is expected to have: subagents; lifecycle hooks; Skills (the agentskills.io / SKILL.md format); plugins with a marketplace; MCP; AGENTS.md rules; plan/read-only mode; checkpoints/undo; cloud or background agents with local-to-cloud handoff; worktree or parallel sessions; a sandbox; headless/exec mode for CI; and remote/mobile control. Long-horizon autonomy (goals, routines, scheduled triggers) has become the new frontier.

### Cited Findings
- Claude Code: hooks (30 events), Skills, plugins, subagents, MCP, Dynamic Workflows. Codex: skills, plugin marketplace, subagents, hooks, MCP, kernel sandbox. Cursor: rules, MCP, hooks, skills, plugins, subagents. OpenCode: primary agents and subagents, MCP, AGENTS.md, LSP, skills, headless server — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- Plan/act or plan/build modes: OpenCode (Tab between build and read-only plan), Cline (plan/act), Kilo (Code/Plan/Ask/Debug). AGENTS.md is read by Cline, Kilo, Qwen Code and Crush. Headless exec: `droid exec`, `amp -x` — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Cloud handoff from local: Cursor `&` prefix and `/in-cloud`, Copilot CLI `/delegate` — [codepick.dev](https://codepick.dev/en/guides/cursor-3-new-features/); [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Checkpoints in Zed's agent panel — [soloterm](https://soloterm.com/zed-vs-warp)
- Sandboxing: Codex kernel-level sandbox; Copilot CLI local sandboxing GA Oct 7, 2026; Copilot cloud agent firewall on by default — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents); [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Mobile/remote control: Claude Code Remote Control (Feb 2026, start-from-phone Aug 2026); Codex in ChatGPT mobile (May 2026); Cursor agents started from mobile, Slack and Linear — [TechRadar](https://www.techradar.com/pro/anthropic-reveals-remote-control-a-mobile-version-of-claude-code-to-keep-you-productive-on-the-move); [pasqualepillitteri](https://pasqualepillitteri.it/en/news/2564/codex-chatgpt-mobile-vs-claude-code); [codepick.dev](https://codepick.dev/en/guides/cursor-3-new-features/)
- Memory: Hermes keeps persistent memory and auto-writes skills. Kilo deprecated its "memory bank" in favor of AGENTS.md. Claude Code re-injects project memory files after compaction — [hermes-agent.org](https://hermes-agent.org/about/); [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/); [LangChain blog](https://blog.langchain.com/improving-deep-agents-with-harness-engineering)
- An agent interoperability protocol is emerging: ACP is supported by Zed, JetBrains and 20+ agents — [implicator.ai](https://www.implicator.ai/zed-and-warp-both-ship-ai-coding-they-bet-on-opposite-surfaces-2/)

### Inferences
- Ox's worktree races, browser agent and org of agents overlap with now-standard parallel and cloud agents. Racing several models on one task is still differentiated, but only if results are scored by an objective check (tests, scan) rather than by eye.
- The one table-stakes item ox's described pitch does not mention is cloud/background execution with phone control. Ox's local-first stance can be reframed as "remote control of your own machines via the mesh" — the same thing Codex mobile does with "laptop/Mac mini/devbox".

### Gaps
- No source gave a canonical "feature checklist" matrix across all products. The list above is assembled from per-product reports.
- Checkpoint/undo support was not confirmed for Codex or Cursor in 2026 sources.

## What unique features caught on in the last 6–12 months that ox may lack?

### Takeaway
The breakout features of 2026 are about autonomy and orchestration rather than editing:
- persistent goals that run for hours (Codex `/goal`)
- self-written orchestration scripts (Claude Dynamic Workflows)
- scheduled or API-triggered cloud routines (Claude Routines, Warp Oz)
- worker+validator mission modes (Droid)
- second-opinion "oracle" models (Amp)
- self-improving skills and memory (Hermes)
- automated PR review bots (Bugbot, Claude Code Review)
- verified security scanning (Claude Code Security)

### Cited Findings
- Codex `/goal`: persistent objectives with explicit states including "budget-limited", resumable across restarts — [noqta](https://www.noqta.tn/en/news/openai-codex-cli-goal-autonomous-agentic-coding-2026)
- Claude Dynamic Workflows: the model writes JS orchestration code to coordinate subagents — [Context Studios](https://www.contextstudios.ai/fr/blog/claude-code-dynamic-workflows-agenten-orchestrierung)
- Claude Routines: cloud-run saved configs with cron or per-routine HTTP endpoint triggers — [claudeainews](https://www.claudeainews.com/news/claude-code-routines-desktop-redesign)
- Warp Oz: event, schedule, Slack, GitHub, CI or API-triggered cloud agents with tracked, shareable runs — [Warp](https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment)
- Droid Mission Mode: worker plus validator agents. Amp Oracle: a second-opinion model — [developertoolkit.ai](https://developertoolkit.ai/en/ecosystem/agent-tools/other-coding-agents/)
- Hermes: auto-generates reusable skill docs from completed work and lives in messaging apps — [agentic-ai docs](https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/hermes-agent/)
- Claude Code Security proves or disproves its own findings to reduce false positives. Claude Code Review runs agent teams per PR — [aitoolsreview](https://aitoolsreview.co.uk/insights/claude-code-2026)
- Cursor Bugbot has tunable effort levels and fast PR review — [skills-hub](https://skills-hub.ai/blog/cursor-3-cloud-agents-2026)
- Cursor offers its own fast in-house model (Composer 2.5). Kimi claims 100-agent swarms — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents); [DEV map](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob)
- Kiro: spec-driven (requirements before code) — [DEV map](https://dev.to/soulentheo/every-ai-coding-cli-in-2026-the-complete-map-30-tools-compared-4gob)
- Voice: Warp Agent CLI ships voice mode. No source documented voice in Claude Code or Codex — [terminaltrove](https://terminaltrove.com/compare/ai-coding-agents/droid-vs-warp-agent-cli/); [search summary of TechRadar/noqta results](https://noqta.tn/en/news/anthropic-claude-code-remote-control-mobile-2026)

### Inferences
- **Ox's "checks its own work" overlaps with three paid features.** Its scan on every edit, requirements→acceptance criteria→tests-first build, and validation overlap with Claude Code Security (Enterprise/plugin), Kiro's spec-driven flow, and Droid's validator agents. Ox's edge is doing all of this locally, on every edit, with any model and at no extra cost. Copying Claude's step of trying to prove or disprove each finding would strengthen the scan.
- **Likely gaps to check in ox:**
  - (a) a persistent `/goal`-style objective with budget and states that survives restarts
  - (b) a model writing its own orchestration scripts
  - (c) event and webhook triggers for scheduled runs (ox has `ox schedule` and `ox flow`; HTTP and GitHub triggers should be verified)
  - (d) a second-opinion "oracle" model, which ox's multi-provider design makes cheap
  - (e) a PR-review bot posting to GitHub (ox has `ox pr` and `ox review`)
  - (f) auto-written skills from completed sessions, as in Hermes
  - (g) messaging-app access (Telegram, Slack)
  - (h) ACP support so Zed and JetBrains can host ox
- **Voice and notch are rare.** Only Warp's CLI has documented voice mode in these sources, so ox's notch voice assistant looks differentiated.

### Gaps
- I found no evidence on how widely developers actually use these features (no usage stats for /goal, Routines or Bugbot).
- I could not confirm whether any rival offers model races in worktrees, multi-machine mesh or a media studio. None of the sources mentioned them, which suggests ox is distinctive there, but this is unproven.

## Benchmarks: which harnesses score highest and why?

### Takeaway
On Terminal-Bench 2.0, GPT-5.5-based harnesses lead (NexAU-AHE 84.7%, LemonHarness 84.5%, Capy 83.1%, Codex CLI 82.2%). The top 10 span only about 7 points with heavily overlapping confidence intervals. Harness design measurably matters: LangChain gained 13.7 points with the model fixed, mainly from forced verification before finishing, loop detection, and time-budget awareness. The gap shrinks when reasoning effort and dates are matched. SWE-bench Pro numbers are inconsistent across sources and should not be cited without checking Scale's SEAL board.

### Cited Findings
- Snorkel Terminal-Bench 2.0 top 10:
  - NexAU-AHE (GPT-5.5): 84.7% ±2.1
  - LemonHarness (multiple models): 84.5%
  - Capy (GPT-5.5): 83.1%
  - Codex CLI (GPT-5.5): 82.2%
  - Polaris: 82.2%
  - WOZCODE (Claude Opus 4.7): 80.2%
  - TongAgents (Gemini 3.1 Pro): 80.2%
  - LemonHarness: 79.9%
  - SageAgent (GPT-5.3-Codex): 78.4%
  - Droid (GPT-5.3-Codex): 77.3%

  Each agent+model pair is its own row, and the CIs overlap heavily — [Snorkel](https://snorkel.ai/leaderboard/terminal-bench-2-0/)
- Model-centric view (BenchLM, Oct 17, 2026): GPT-5.5 82%, GPT-5.3 Codex 77.3%, GPT-5.4 75.1%, Claude Opus 4.7 sixth at 69.4%. Vals.ai (June 4, 2026, Terminus 2 harness): GPT-5.5 73.2%, Opus 4.8 70.04% — [BenchLM](https://benchlm.ai/benchmarks/terminal-bench-2); [Vals.ai](https://www.vals.ai/benchmarks/terminal-bench-2)
- Vendor-reported: Claude Code with Opus 4.8 scores Terminal-Bench 2.1 74.6% and SWE-bench Verified 88.6%. Codex with GPT-5.5 scores TB 2.0 82.7% and SWE-Bench Pro 58.6% (Opus 4.7: 64.3% on SWE-Bench Pro). Gemini 3.5 Flash scores TB 2.1 76.2% — [Firecrawl](https://www.firecrawl.dev/blog/best-ai-coding-agents)
- Harness effect: LangChain kept gpt-5.2-codex fixed and raised deepagents-cli from 52.8 to 66.5 on TB 2.0 (from outside the top 30 to the top 5). Levers:
  - PreCompletionChecklistMiddleware, which forces a verification pass against the task spec before exit
  - directory maps and time-budget warnings injected into context
  - loop-detection middleware
  - extra reasoning helps, but can cost over 2x time under strict timeouts

  — [LangChain blog](https://blog.langchain.com/improving-deep-agents-with-harness-engineering)
- On Terminal-Bench 2.1, harness spreads reportedly shrink to 0.2–8.1 points when reasoning effort and dates are matched. There is a risk of hill-climbing on the eval (secondary, via search summary) — [Addy Osmani, Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/); [datanorth.ai](https://datanorth.ai/blog/harness-engineering-the-complete-guide-to-ai-agent-scaffolding)
- SWE-bench Pro: Scale SEAL runs every model through identical tooling with a 250-turn limit. A Mar 1, 2026 snapshot had Opus 4.5 at 45.9%, Sonnet 4.5 at 43.6% and Gemini 3 Pro at 43.3%. BenchLM (Apr 10, 2026) listed Claude Mythos Preview at 77.8%, GLM-5.1 at 58.4% and GPT-5.4 at 57.7% (not comparable harnesses). Scaffold choice is estimated to swing Pro scores by 5–10 points — [morphllm](https://morphllm.com/swe-bench-pro); [BenchLM SWE-Pro](https://benchlm.ai/benchmarks/swePro)
- Terminal-Bench 2.1, 3.0 and 4.0 successors are referenced in some sources, so check which version a number refers to — [BenchLM](https://benchlm.ai/benchmarks/terminal-bench-2)

### Inferences
- **Ox should submit to Terminal-Bench 2.x.** The top harnesses are small, specialized scaffolds (NexAU, LemonHarness, Capy, WOZCODE) on frontier models, and multi-model harnesses (LemonHarness, Polaris) place #2 and #5. A model-agnostic harness can therefore rank highly, and ox could submit with GPT-5.5 or Opus. Its "checks its own work" design matches the strongest documented lever (a forced verification pass before completion).
- **Ox's races resemble best-of-N.** Picking the winner automatically (tests pass plus scan clean) could help benchmark scores in the same way multi-model harnesses appear to.

### Gaps
- I did not fetch Scale's SEAL SWE-bench Pro board directly. Current (Oct 2026) authoritative Pro rankings are unverified.
- The Snorkel page shows no submission dates, and it does not document how the top harnesses (NexAU-AHE, LemonHarness, Capy) work.
- I found no public Terminal-Bench entries for Claude Code itself, OpenCode, Cline, Goose or Aider in the fetched top 10.
