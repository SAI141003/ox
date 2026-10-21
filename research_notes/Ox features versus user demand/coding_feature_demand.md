# Coding-agent feature demand and real usage (2025 to Oct 2026), mapped to ox

Method note: GitHub reaction counts were pulled live on 2026-10-20 with the GitHub search API (`gh api search/issues ... sort=reactions`). Reaction counts are total reactions; "+1" counts are given where useful. Cursor forum counts were pulled from the Discourse JSON (`/c/ideas/feature-requests/5/l/top.json`); the number shown is the topic's `like_count` (likes across all posts), and `op_like_count` (votes on the first post) is in parentheses. Complaint-type issues (rate limits, model quality, scrolling bugs) are left out on purpose, because an earlier note covers them.

## Q1. What do usage data show people actually use coding agents for?

### Takeaway
In agentic tools, delegation is now mostly building and debugging. Debugging is still the most common daily use. Building new features is the fastest-growing share of sessions (Anthropic internal: 14% to 37% of Claude Code transcripts in six months). Planning and design is growing from a small base. Across all developers, testing, code review, deployment and project planning are the tasks people most often say they don't want AI to do. Web/UI work in JS/TS and HTML/CSS is the largest language segment.

### Cited Findings
- Anthropic Economic Index on software development (500k interactions, April 2025): 79% of Claude Code conversations were "automation", where the AI does the task, versus 49% on Claude.ai. "Feedback loop" interactions were 35.8% versus 21.3%, and "directive" 43.8% versus 27.5%. — [Anthropic, Apr 28 2025](https://www.anthropic.com/research/impact-software-development)
- Same study: JS+TS were 31% of queries, HTML+CSS 28%, Python 14%, SQL 6%. The top tasks were UI/UX component development (12%) and web & mobile app development (8%); architecture/design and debug/performance were also in the top five, with no percentage given. Startups made up 32.9% of Claude Code conversations and enterprise 23.8%. The intro gives an inconsistent 13% enterprise figure. — [Anthropic](https://www.anthropic.com/research/impact-software-development)
- Anthropic internal study (132-engineer survey plus Claude Code transcripts, Dec 2025): 55% use Claude Code daily for debugging, 42% for code understanding and 37% for implementing new features. In transcripts from Feb to Aug 2025, "implementing new features" rose from 14.3% to 36.9% and "code design/planning" from 1.0% to 9.9%. Maximum consecutive tool calls rose from 9.8 to 21.2, and human turns per transcript fell from 6.2 to 4.1. 27% of Claude-assisted work "would not have been done otherwise", and 8.6% of tasks were "papercut fixes". — [Anthropic, Dec 2 2025](https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic)
- A secondary summary of a later Anthropic internal study says debugging sessions fell from 33% to 19% and ops work rose from 14% to 21%. I could not find the primary source, so this is unverified. — [yage.ai summary](https://yage.ai/share/claude-code-usage-shift-en-20260618.html)
- Anthropic Economic Index, Jan 2026 (via secondary source): "Modifying software to correct errors" was 6% of consumer usage and 10% of enterprise API usage. — [Medium summary](https://medium.com/@ZombieCodeKill/claude-reviews-anthropics-economic-index-ed44052c6e12)
- Stack Overflow 2025 survey, AI in workflow, shown as "mostly AI / partially AI / don't plan to use AI":
  - Writing code: 16.9% / 59% / 28.9%
  - Debugging: 20.7% / 47.1% / 36.4%
  - Documenting code: 30.8% / 30.3% / 38.5%
  - Testing: 17.9% / 27.5% / 44.1%
  - Committing and reviewing code: 10.2% / 22.6% / 58.7%
  - Deployment and monitoring: 6.2% / 10.5% / 75.8%
  - Project planning: 10.8% / 17.1% / 69.2%
  - The "search for answers" row, as extracted, adds up to more than 100%, so treat it as a parsing error.

  — [Stack Overflow 2025 AI](https://survey.stackoverflow.co/2025/ai)
- Stack Overflow 2025, agents: 14.1% use AI agents at work daily, 9% weekly, 7.8% monthly or less, 17.4% plan to, and 37.9% don't plan to. Among agent users, 70.1% say agents reduced time on specific tasks, 37.5% say they improved code quality, and 17.3% say they improved team collaboration. Out-of-the-box agent tools used: ChatGPT 81.7%, GitHub Copilot 67.9%, Gemini 47.4%, Claude Code 40.8%. MCP servers are used by 34.4% and multi-agent orchestration by 28.1%. Ollama is the top "orchestration" tool at 51.1%. — [Stack Overflow 2025 AI](https://survey.stackoverflow.co/2025/ai)
- JetBrains Developer Ecosystem 2025 (24,534 developers): 85% use AI regularly for coding and 62% rely on at least one AI assistant, agent or editor. The top benefits were productivity (74%) and faster repetitive tasks (73%). — [JetBrains Research, Oct 2025](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/)
- JetBrains 2026 survey (15k+ professional developers, fielded Apr/May–Jul 2026): 90% use coding agents at work at least weekly and 68% daily. Claude Code at work rose from 3% to 39% and Copilot fell from 29% to 21%. These numbers come from secondary coverage, because the JetBrains blog returned 403. — [ADTmag](https://adtmag.com/articles/jetbrains-survey-finds-ai-coding-agents-becoming-routine-developer-tools.aspx); [JetBrains blog (403 to fetcher)](https://blog.jetbrains.com/research/2026/04/which-ai-coding-tools-do-developers-actually-use-at-work/)
- Pragmatic Engineer AI tooling survey (900+ respondents, Jan–Feb 2026): about 55% regularly use AI agents (63.5% among staff+ engineers). Most-loved tools: Claude Code 46%, Cursor 19%, Copilot 9%. A secondary source adds that 70% juggle 2–4 AI tools. — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026); [NeuralCoreTech (secondary)](https://neuralcoretech.com/ai-for-software-engineers-2026/)
- GitHub Octoverse 2025 (Sep 2024–Aug 2025): Copilot coding agent created 1M+ PRs from May to Sep 2025. 72.6% of Copilot code review users said it improved their effectiveness (self-reported). Copilot Autofix security fixes were accepted in 6,000+ repos/month for broken access control. 1.13M public repos import an LLM SDK (+178% YoY). Dockerfile use was up 120%, which GitHub links to agent sandboxing; that link is an inference. — [GitHub Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)

### Inferences
- In order of real use, the core jobs are: debug/fix, then build new features (fast-growing), then understand/explain code, then UI/front-end work. Plan/design is small but growing fast. Docs are popular in the general population but are not the main reason people use agents.
- Testing, code review, deploy/CI and planning have the most "don't plan to use AI" answers in the broad population. Demand for `ox build`'s tests-first flow and `ox pr`'s CI flow will come mainly from power users, not the mainstream. Agent-driven security fixes (Autofix acceptance) and AI PR review (72.6% positive) do show real use.
- Multi-tool use is the norm: 70% use 2–4 tools, and ChatGPT, Copilot and Claude Code overlap heavily. This supports ox's "drive any CLI/model" positioning.

### Gaps
- I found no primary 2026 Economic Index figure that breaks Claude Code usage down by task (debug vs feature vs refactor vs tests vs docs).
- The JetBrains 2026 detailed task-delegation data was not reachable (403).
- OpenAI has not published a Codex task breakdown that I could find.

## Q2. Most-upvoted feature requests across agent trackers (top items by reactions, grouped by theme)

### Takeaway
By reaction count, the most-demanded features are not new agent powers. They are open standards and portability (AGENTS.md, ACP, MCP, skills), access to more models (any provider, local models, use an existing subscription), being able to undo and plan before acting, running anywhere (Linux/Windows/remote/mobile/JetBrains), multiple accounts, and showing context and usage. ox already covers most of the model-access and portability themes.

### Cited Findings (reaction counts as of 2026-10-20)

**Theme A: Open standards and portable configuration**
- Claude Code #6235 "Support AGENTS.md": **6,687** reactions (5,188 👍). This is the most-reacted issue in any agent repo. — [link](https://github.com/anthropics/claude-code/issues/6235)
- Claude Code #31005 "Support for AGENTS.md and .agents/skills/": 566 reactions (open). — [link](https://github.com/anthropics/claude-code/issues/31005)
- Claude Code #6686 "Agent Client Protocol (ACP)": 550 reactions. — [link](https://github.com/anthropics/claude-code/issues/6686)
- Cursor forum "Does Cursor CLI support ACP?": 118 likes (41 on the first post). — [link](https://forum.cursor.com/t/does-cursor-cli-support-acp/132783)
- Claude Code #1455 "Respect XDG Base Directory": 460 reactions. — [link](https://github.com/anthropics/claude-code/issues/1455)
- Gemini CLI #1825 "respect XDG specs": 101 reactions. — [link](https://github.com/google-gemini/gemini-cli/issues/1825)
- Aider #216 "Config file location should follow modern specs": 80 reactions. — [link](https://github.com/Aider-AI/aider/issues/216)
- Gemini CLI #11506 "Add Skills like Claude Code": 165 reactions. — [link](https://github.com/google-gemini/gemini-cli/issues/11506)
- OpenCode #3235 "Support for Skills": 132 reactions. — [link](https://github.com/anomalyco/opencode/issues/3235)
- Claude Code #20697 "Sync Skills between Desktop and CLI": 170 reactions. — [link](https://github.com/anthropics/claude-code/issues/20697)
- Aider #3303 "Cursor Rules support": 37 reactions. — [link](https://github.com/Aider-AI/aider/issues/3303)
- Cline #5033 "AGENTS.md standard": 19 reactions. — [link](https://github.com/cline/cline/issues/5033)

**Theme B: Model choice (any model, local, new models, use existing subscriptions)**
- Claude Code #17118 "Support for OpenCode and Max plan": 1,414 reactions. — [link](https://github.com/anthropics/claude-code/issues/17118)
- OpenCode #7410 "Broken Claude Max": 420 reactions. — [link](https://github.com/anomalyco/opencode/issues/7410)
- OpenCode #1686 "OpenAI auth login like claude": 271 reactions. — [link](https://github.com/anomalyco/opencode/issues/1686)
- OpenCode #2072 "Support for Cursor?": 264 reactions. — [link](https://github.com/anomalyco/opencode/issues/2072)
- OpenCode #6231 "Auto-discover models from OpenAI-compatible endpoints": 260 reactions. — [link](https://github.com/anomalyco/opencode/issues/6231)
- Codex #35 "Using with ChatGPT Plus/Pro": 196 reactions. — [link](https://github.com/openai/codex/issues/35)
- Codex #26 "Support local/other LLMs": 159 reactions. — [link](https://github.com/openai/codex/issues/26)
- Aider #2227 "GitHub Copilot as model provider": 119 reactions. — [link](https://github.com/Aider-AI/aider/issues/2227)
- Gemini CLI #5938 "local/offline models (Ollama, LM Studio)": 46 reactions. — [link](https://github.com/google-gemini/gemini-cli/issues/5938)
- Claude Code #1785 "MCP Sampling to use Max subscription": 194 reactions. — [link](https://github.com/anthropics/claude-code/issues/1785)
- Cursor forum: almost every top yearly feature request is a specific model request. Examples:
  - "Add GLM 4.5": 404 likes (143) — [link](https://forum.cursor.com/t/add-glm-4-5-as-a-cursor-auto-model/123631)
  - "Kimi K2": 269 (120) — [link](https://forum.cursor.com/t/kimi-k2-in-cursor/116890)
  - "Kimi K2 Thinking": 197 (55) — [link](https://forum.cursor.com/t/kimi-k2-thinking-in-cursor/141490)
  - "Kimi K2.5": 192 (41) — [link](https://forum.cursor.com/t/kimi-k2-5-in-cursor/150071)
  - "Add GLM 5.3 Flash": 195 (71) — [link](https://forum.cursor.com/t/add-glm-5-3-flash/169574)
  - "DeepSeek R1": 221 (72) — [link](https://forum.cursor.com/t/please-add-deepseek-r1-model/42868)
  - "Qwen3/Minimax": 204 (40) — [link](https://forum.cursor.com/t/qwen3-235b-a22b-instruct-and-minimax-m1/121002)
  - "Ollama natively": 99 (68, 23k views) — [link](https://forum.cursor.com/t/add-support-for-ollama-natively/27291)
  - "R1+Sonnet combination": 70 (54) — [link](https://forum.cursor.com/t/r1-sonnet-combination-implementation/45198)
- Gemini CLI #2208 "Option to disable automatic model fallback (Pro to Flash)": 62 reactions. Gemini CLI #27858 "Bring back intelligent auto-edit and model routing": 21 reactions. — [#2208](https://github.com/google-gemini/gemini-cli/issues/2208); [#27858](https://github.com/google-gemini/gemini-cli/issues/27858)

**Theme C: Plan first, then undo/checkpoints**
- Codex #9203 "Please make /undo back": 538 reactions (open). — [link](https://github.com/openai/codex/issues/9203)
- Codex #2101 "Plan Mode": 506 reactions. — [link](https://github.com/openai/codex/issues/2101)
- Codex #11626 "/rewind checkpoint restore that reverts chat and code": 229 reactions. — [link](https://github.com/openai/codex/issues/11626)
- Gemini CLI #4666 "Plan Mode": 204 reactions. This is Gemini CLI's most-reacted issue. — [link](https://github.com/google-gemini/gemini-cli/issues/4666)
- Claude Code #353 "Undo/Checkpoint": 178 reactions. — [link](https://github.com/anthropics/claude-code/issues/353)
- OpenCode #3844 "Plan mode questions like Claude Code": 126 reactions. — [link](https://github.com/anomalyco/opencode/issues/3844)
- Aider #649 "Confirm each change before doing it": 41 reactions. — [link](https://github.com/Aider-AI/aider/issues/649)
- Cursor forum "Return the Custom Modes features": 80 likes (30). — [link](https://forum.cursor.com/t/return-the-custom-modes-features/144170)

**Theme D: Extensibility (hooks, subagents, MCP, custom commands)**
- Codex #2109 "Event Hooks": 688 reactions. — [link](https://github.com/openai/codex/issues/2109)
- Codex #2604 "Subagent Support": 413 reactions. — [link](https://github.com/openai/codex/issues/2604)
- Codex #2890 "Custom prompts with arguments": 403 reactions. — [link](https://github.com/openai/codex/issues/2890)
- Codex #5 "MCP support": 285 reactions. — [link](https://github.com/openai/codex/issues/5)
- Codex #2628 "Project-specific MCPs": 162 reactions. — [link](https://github.com/openai/codex/issues/2628)
- Claude Code #6915 "MCP tools only for subagent": 377 reactions. — [link](https://github.com/anthropics/claude-code/issues/6915)
- Claude Code #7328 "Enable/disable individual MCP tools": 225 reactions. — [link](https://github.com/anthropics/claude-code/issues/7328)
- Claude Code #91870 "Mods": 224 reactions. — [link](https://github.com/anthropics/claude-code/issues/91870)
- Gemini CLI #2779 "Hooks system": 103 reactions. — [link](https://github.com/google-gemini/gemini-cli/issues/2779)
- Aider #3314 "MCP SUPPORT": 244 reactions (open), and Aider #2525 (MCP): 138. These are Aider's top two issues. — [#3314](https://github.com/Aider-AI/aider/issues/3314); [#2525](https://github.com/Aider-AI/aider/issues/2525)
- OpenCode #12661 "Agent Teams equivalent": 190 reactions. — [link](https://github.com/anomalyco/opencode/issues/12661)
- OpenCode #7101 "Custom system prompts": 168 reactions. — [link](https://github.com/anomalyco/opencode/issues/7101)

**Theme E: Run it anywhere (platforms, IDEs, remote, mobile)**
- Codex #11023 "Codex desktop app for Linux": 1,464 reactions. — [link](https://github.com/openai/codex/issues/11023)
- Codex #10450 "Remote Development in Desktop App": 878 reactions. — [link](https://github.com/openai/codex/issues/10450)
- Codex #9224 "Remote Control": 544 reactions. — [link](https://github.com/openai/codex/issues/9224)
- Codex #4313 "JetBrains extension": 453 reactions. — [link](https://github.com/openai/codex/issues/4313)
- Codex #10410 "macOS Intel": 376 reactions. — [link](https://github.com/openai/codex/issues/10410)
- Codex #13993 "Windows installer": 265 reactions. — [link](https://github.com/openai/codex/issues/13993)
- Claude Code #65697 "Desktop for Linux": 655 reactions. — [link](https://github.com/anthropics/claude-code/issues/65697)
- Claude Code #15942 "Visual Studio 2026": 588 reactions. — [link](https://github.com/anthropics/claude-code/issues/15942)
- Claude Code #30154 "Multi-window desktop": 264 reactions. — [link](https://github.com/anthropics/claude-code/issues/30154)
- Claude Code #28791 "Sync history between CLI and desktop": 182 reactions. — [link](https://github.com/anthropics/claude-code/issues/28791)
- Cursor forum "Cursor Android mobile app": 190 likes (71). This is the top yearly request. — [link](https://forum.cursor.com/t/cursor-android-mobile-app/165496)
- Cursor forum "JetBrains plugin": 167 (64). — [link](https://forum.cursor.com/t/please-consider-a-jetbrains-plugin/17042)
- Cursor forum "Neovim plugin": 171 (71). — [link](https://forum.cursor.com/t/cursor-plugin-for-neovim/6234)
- OpenCode #11176 "VS Code extension": 175 reactions. — [link](https://github.com/anomalyco/opencode/issues/11176)
- Cline #63 "JetBrains/VS2022": 68 reactions. — [link](https://github.com/cline/cline/issues/63)

**Theme F: Accounts, usage and cost visibility**
- Claude Code #18435 "Multiple accounts in Desktop": 1,147 reactions. — [link](https://github.com/anthropics/claude-code/issues/18435)
- Claude Code #36151 (mobile multi-account): 1,054 reactions. — [link](https://github.com/anthropics/claude-code/issues/36151)
- Claude Code #27302 "Multiple connector accounts": 601 reactions. — [link](https://github.com/anthropics/claude-code/issues/27302)
- Cursor forum "Seamless Account Switching": 288 (125). — [link](https://forum.cursor.com/t/seamless-account-switching-in-cursor/58411)
- Codex #23794 "Desktop no longer shows context/token usage indicator": 253 reactions. — [link](https://github.com/openai/codex/issues/23794)
- Codex #17827 "Customizable status line": 220 reactions. — [link](https://github.com/openai/codex/issues/17827)
- OpenCode #6152 "Session context usage like /context": 154 reactions. — [link](https://github.com/anomalyco/opencode/issues/6152)
- OpenCode #16017 "Plan usage/balance API": 138 reactions. — [link](https://github.com/anomalyco/opencode/issues/16017)
- Cursor forum "Rate limit meter for Pro": 84 (63). — [link](https://forum.cursor.com/t/request-to-add-a-rate-limit-meter-for-pro-plan/106556)
- Cursor forum "Email each billing cycle": 172 (101). — [link](https://forum.cursor.com/t/please-send-me-an-email-each-billing-cycle/22101)
- Cursor forum "Visual indication of Max Mode spend": 22 (14). — [link](https://forum.cursor.com/t/visual-indication-that-you-are-using-max-mode-spent-a-ton-of-money-without-noticing-in-max-mode/142321)
- Gemini CLI #2094 "Show costs": 20 reactions. — [link](https://github.com/google-gemini/gemini-cli/issues/2094)

**Theme G: Session flow and ergonomics**
- OpenCode #16992 "/btw command" (ask on the side while the agent works): 410 reactions. Claude Code #37323 "/btw in VS Code": 227 reactions. — [OC](https://github.com/anomalyco/opencode/issues/16992); [CC](https://github.com/anthropics/claude-code/issues/37323)
- Claude Code #50246 "Message queue mode": 254 reactions. OpenCode #4821 "unqueue messages": 126. — [CC](https://github.com/anthropics/claude-code/issues/50246); [OC](https://github.com/anomalyco/opencode/issues/4821)
- OpenCode #27167 "Native session goals /goal": 216 reactions. Cursor forum "Goal Mode like Claude Code's /goal": 31 (19). — [OC](https://github.com/anomalyco/opencode/issues/27167); [Cursor](https://forum.cursor.com/t/add-autonomous-goal-mode-similar-to-claude-code-s-goal/160374)
- Claude Code #8477 "Always show thinking": 364 reactions. — [link](https://github.com/anthropics/claude-code/issues/8477)
- Claude Code #3412 "View/edit pasted text": 313 reactions. OpenCode #8501 (same request): 328. — [CC](https://github.com/anthropics/claude-code/issues/3412); [OC](https://github.com/anomalyco/opencode/issues/8501)
- Codex #3962 "Sound when task finishes": 222 reactions. Gemini CLI #4310 "Audio notifications": 79. — [Codex](https://github.com/openai/codex/issues/3962); [Gemini](https://github.com/google-gemini/gemini-cli/issues/4310)
- Codex #12564 "Rename threads": 214 reactions. Claude Code #2112 "session names": 182. — [Codex](https://github.com/openai/codex/issues/12564); [CC](https://github.com/anthropics/claude-code/issues/2112)
- Voice input: Codex #3000 "Voice transcription": 298 reactions. OpenCode #4695 "Speech-to-text": 208. — [Codex](https://github.com/openai/codex/issues/3000); [OC](https://github.com/anomalyco/opencode/issues/4695)
- Memory: OpenCode #20695 "Memory Megathread": 173 reactions. Claude Code #2511 "Connect Claude Code to Claude Projects": 658. — [OC](https://github.com/anomalyco/opencode/issues/20695); [CC](https://github.com/anthropics/claude-code/issues/2511)
- Codex #19464 "1M context": 241 reactions. — [link](https://github.com/openai/codex/issues/19464)
- Cursor forum "Increase the 25 tool-call limit": 195 (69). — [link](https://forum.cursor.com/t/increase-the-25-tool-calls-limit/72553)

**Theme H: Code intelligence, diff review and safety**
- Codex #8745 "LSP integration (auto-detect + install)": 608 reactions (open). Gemini CLI #2465 "LSP support": 132. — [Codex](https://github.com/openai/codex/issues/8745); [Gemini](https://github.com/google-gemini/gemini-cli/issues/2465)
- Claude Code #33932 "VS Code diff review UI like Copilot Edits": 289 reactions. Codex #2998 "IDE-integrated diff/approval": 238. — [CC](https://github.com/anthropics/claude-code/issues/33932); [Codex](https://github.com/openai/codex/issues/2998)
- Codex #2847 "Exclude sensitive files": 472 reactions. Claude Code #32733 "Secure secrets injection": 212. — [Codex](https://github.com/openai/codex/issues/2847); [CC](https://github.com/anthropics/claude-code/issues/32733)
- Claude Code #16561 "Parse compound Bash commands for permissions": 176 reactions. — [link](https://github.com/anthropics/claude-code/issues/16561)
- Cursor forum "Background Agent + Bugbot for Bitbucket": 149 (87). "Bugbot for GitLab": 112 (44). These show demand for the PR review bot beyond GitHub. — [Bitbucket](https://forum.cursor.com/t/background-agent-bugbot-for-bitbucket/106759); [GitLab](https://forum.cursor.com/t/bugbot-for-gitlab/100885)
- Cursor forum "Jupyter Notebook support": 362 (149). — [link](https://forum.cursor.com/t/jupyter-notebook-support/14851)
- Codex #1797 "PDF support": 195 reactions. — [link](https://github.com/openai/codex/issues/1797)

**Non-functional but very high demand (context only)**
- Claude Code #45596 "Bring back Buddy" (a companion/mascot feature): 2,115 reactions, open. — [link](https://github.com/anthropics/claude-code/issues/45596)
- Cursor forum "Student verification outside USA": 2,436 likes. — [link](https://forum.cursor.com/t/student-verifications-outside-usa-and-organizations-without-edu-email/133736)
- Claude Code #17432 "India pricing": 647 reactions. — [link](https://github.com/anthropics/claude-code/issues/17432)

### Inferences
- Ranked by summed reaction evidence across trackers, the top themes are:
  1. Open standards and portable config (AGENTS.md alone is 6.7k)
  2. Model choice and using existing subscriptions (Claude Code+OpenCode 1.4k, Cursor model threads in the thousands)
  3. Run anywhere: Linux, remote, mobile, IDEs (Codex Linux 1.5k plus remote 0.9k+0.5k)
  4. Multiple accounts and usage/cost visibility (about 2.2k on Claude Code alone)
  5. Plan mode and undo/checkpoints (about 1.6k across Codex, Gemini and Claude Code)
  6. Extensibility: hooks, subagents, MCP, custom commands (about 2k+)
  7. Session-flow ergonomics: /btw, queue, /goal, notifications, voice
  8. LSP/code intelligence and IDE diff review
  9. Secret and file exclusion, permission safety
- Requests for "parallel agents/races", "compare models side by side", "language porting", or "security scanning" barely appear in the top 20 of any tracker. The closest are OpenCode Agent Teams (190), Cursor "R1+Sonnet combination" (70) and Bitbucket/GitLab Bugbot (149/112).
- Many of the top requests were closed as shipped (Codex plan mode, hooks, subagents, MCP; Gemini plan mode, skills). That is evidence vendors converged on: plan mode, hooks, subagents, MCP, skills, AGENTS.md.

### Gaps
- Cline's tracker gets few feature requests (its top issues are under 100 reactions); its demand signal probably lives in Discord or GitHub Discussions, which I did not query.
- The OpenCode repo is now `anomalyco/opencode`; the old `sst/opencode` search returned 422.
- Cursor forum numbers are likes, not a formal vote count, and are biased toward newer threads.

## Q3. Which features do users rate most valuable in reviews and comparisons?

### Takeaway
In both reviews and trackers, the features people value most are plan mode, project instructions (CLAUDE.md/AGENTS.md), hooks, subagents/skills, and checkpoints/undo. Behind those come visible context and usage, and a PR review bot. Multi-model access is valued as a way to choose models, more than as side-by-side comparison.

### Cited Findings
- Reviews and blogs say plan mode "catches bad architecture decisions before they happen". They describe hooks as deterministic, unlike CLAUDE.md instructions, which one source estimates are followed about 80% of the time, and use hooks for formatting and notifications. Subagents keep the main context clean; skills are reusable playbooks; checkpoints let you rewind. Reddit users call CLAUDE.md "the biggest single unlock". These sources are anecdotal and partly promotional. — [websitesetup.org](https://websitesetup.org/?p=57294); [Appwrite tips](https://appwrite.io/blog/post/claude-code-tips-tricks); [Medium](https://medium.com/@rajasekar-venkatesan/making-the-most-of-claude-code-best-practices-hidden-features-b5ed99fbd61f)
- Claude Code is "most loved" at 46% versus Cursor at 19% (Pragmatic Engineer 2026, n=900+). — [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026)
- PR review bots: 72.6% of Copilot code review users say it improved their effectiveness. — [Octoverse 2025](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/). Cursor users asked for Bugbot on Bitbucket (149 likes) and GitLab (112). — [Cursor forum](https://forum.cursor.com/t/background-agent-bugbot-for-bitbucket/106759)
- Losing checkpoints/undo or the usage display causes backlash. Examples are Codex "/undo back" (538) and "Desktop no longer shows context/token usage" (253). On Cursor, removing Custom Modes (80 likes) and the CSS Inspector (82) drew requests to bring them back. — [Codex #9203](https://github.com/openai/codex/issues/9203); [Codex #23794](https://github.com/openai/codex/issues/23794); [Cursor](https://forum.cursor.com/t/return-the-custom-modes-features/144170)
- MCP is used by 34.4% of agent users. The GitHub MCP server is the most used data/memory agent tool at 42.8%. — [Stack Overflow 2025](https://survey.stackoverflow.co/2025/ai)

### Inferences
- Proven value comes from features that control or recover the agent: plan, undo, hooks and instructions. Features that add autonomy are valued less unless they come with review.

### Gaps
- I found no quantitative survey ranking individual features (plan mode vs checkpoints vs parallel agents). The Pragmatic Engineer and JetBrains detailed feature data is paywalled or returned 403.

## Q4. Which hyped features see little real use?

### Takeaway
The evidence is thin and mostly indirect. There is no usage data on parallel/background agents or multi-model comparison. Planning and deployment by AI are strongly rejected by the broad population, and team collaboration is the weakest perceived benefit. Some "pro" UIs (Cursor's 2.0 Agent/Editor switch, the new Review page) drew requests to turn them off.

### Cited Findings
- 69.2% don't plan to use AI for project planning, 75.8% not for deployment/monitoring, and 58.7% not for committing/reviewing code. — [Stack Overflow 2025](https://survey.stackoverflow.co/2025/ai)
- Only 17.3% of agent users say agents improved team collaboration, which is the lowest perceived benefit. — [Stack Overflow 2025](https://survey.stackoverflow.co/2025/ai)
- A secondary analysis puts "regular agentic AI use" at about 25% in early 2026 even though 90% use AI tools. This conflicts with JetBrains' later 2026 figure of 90% weekly agent use. — [agentmarketcap (secondary)](https://agentmarketcap.ai/blog/2026/04/05/jetbrains-developer-survey-2026-ai-tools-agentic-adoption-gap); contradicted by [ADTmag/JetBrains 2026](https://adtmag.com/articles/jetbrains-survey-finds-ai-coding-agents-becoming-routine-developer-tools.aspx)
- Cursor UI pushback:
  - "How do I turn off this new Review page": 54 likes (26) — [link](https://forum.cursor.com/t/how-do-i-turn-of-this-new-review-page-and-go-back-to-reviewing-the-actual-pages/143671)
  - "Hide the Agent/Editor switch": 31 (14) — [link](https://forum.cursor.com/t/cursor-2-0-is-there-way-to-hide-or-move-the-agent-editor-switch-on-the-top-left/140035)
  - "Open Agent Window and Editor simultaneously": 152 likes — [link](https://forum.cursor.com/t/how-to-open-agent-window-and-editor-simultaneously/139304)
  - "Change default mode to Ask, not Agent": 107 (42) — [link](https://forum.cursor.com/t/how-can-i-change-default-chat-mode-as-ask-not-agent/53850)
- Requests to turn off agent "personality" and progress text: Claude Code #6814 "Turn off annoying progress messages" (218) and Gemini CLI #9066 "stop displaying clever messages" (29). — [CC](https://github.com/anthropics/claude-code/issues/6814); [Gemini](https://github.com/google-gemini/gemini-cli/issues/9066)
- Codex #48195 "make daemon_auto_start opt-in": 204 reactions. Users push back on always-on background agents running by default. — [link](https://github.com/openai/codex/issues/48195)
- One blog says 74% run multiple AI tools/agents but gives no source; treat it as unreliable. — [agentmarketcap](https://agentmarketcap.ai/blog/2026/04/05/dual-tool-developer-stack-cursor-claude-code-multi-agent-workflows)

### Inferences
- Model races, side-by-side compare, bots with names in group chat, task boards, scheduled runs and interactive in-chat charts/forms have almost no visible demand signal in trackers. These are differentiators, not proven needs. Treat them as hypotheses.
- Agent-first UIs that hide the editor or code draw complaints; people want to see the diff.

### Gaps
- I found no reliable data on how often people run parallel or background agents, or use multi-model compare, scheduled agent runs or task boards. JetBrains said it would publish more agentic-development data from its 2026 survey, but I could not reach it.

## Mapping to ox (demand rank vs ox coverage)

Each row gives the demand theme with its evidence strength, whether ox has it, and notes. Strength is a judgment from summed reactions plus survey support.

1. **Portable config: AGENTS.md, skills, ACP, XDG (very high: 6.7k+).** Partly covered: ox has a skills/plugins marketplace. Check that ox reads AGENTS.md, CLAUDE.md and `.agents/skills`, and supports ACP.
2. **Any model, local models, existing subscriptions (very high).** Yes: Claude, ChatGPT and Cursor CLIs, 22 providers, Ollama and Hugging Face. This is ox's strongest match with demand. Auto-discovering models from OpenAI-compatible endpoints (OpenCode #6231, 260) is worth checking.
3. **Run anywhere: Linux desktop, remote, mobile, IDE plugins (very high).** Partly covered. ox is a CLI plus a Mac app. Linux/Windows desktop, remote control and IDE (JetBrains/VS Code) presence are likely gaps.
4. **Multiple accounts plus usage/context/cost display (high).** Partly covered. ox shows usage and cost per answer. Multi-account switching and a live context meter or status line should be checked.
5. **Plan mode plus undo/checkpoints/rewind (high).** Unknown. `ox build` gives requirements, then acceptance criteria, then tests, which is plan-like. A general plan mode and /undo or rewind that reverts code and chat are not listed among ox's features.
6. **Hooks, subagents, MCP, custom commands (high).** Partly covered through plugins and skills. Hooks and MCP should be checked.
7. **Session ergonomics: /btw, message queue, /goal, finish sound, voice, session names (medium-high).** Unknown, aside from ox's existing speak and dictation skills.
8. **LSP/code intelligence (medium-high: Codex 608).** Partly covered. ox has a code graph and project wiki; LSP-backed diagnostics are a separate question.
9. **Secret/file exclusion and permission safety (medium).** Partly covered. `ox secure` scans code, which is a different job from keeping the agent away from secrets.
10. **PR review bot and CI (medium: Octoverse 72.6%, Bugbot requests).** Yes: `ox review` and `ox pr`. Bitbucket/GitLab support could set ox apart.
11. **Debugging, the most-used task (top in usage data).** No dedicated feature listed. Consider a first-class debug/fix flow.
12. **New feature building (fastest-growing usage).** Yes: `ox build` (tests first plus proof).
13. **Parallel agents, model race, compare (low visible demand).** Yes: race, compare and auto-routing. Little tracker evidence supports these.
14. **Language migration (`ox port`) (no signal found).** Yes; this is a niche.
15. **Scheduled runs, task board, named bots/group chat, interactive charts (no signal found).** Yes; these are differentiators without proven demand.
