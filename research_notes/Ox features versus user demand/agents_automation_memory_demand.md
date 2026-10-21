# What users want from personal AI agents beyond coding (2025 to Oct 2026)

Scope: browser agents, automations and scheduling, multi-agent "AI employee" teams, messaging-app bots, memory, deep research. The goal is to separate what people actually use and pay for from hype, as input on ox features (ox browse, flows, schedule, org, Telegram/Discord bots, memory, library, research).
Research date: 2026-10-20. Source quality varies a lot. Lower-authority sources are marked [secondary] or [vendor/blog].

## 1. Browser agents (ChatGPT agent/Operator, Comet, Atlas, Claude in Chrome, Manus): what people delegate, success, retention

### Takeaway
General-purpose "go do it on the web" browser agents have done poorly on retention. ChatGPT Agent lost about 75% of its weekly users within months, and OpenAI shut down its Atlas browser after about 9 months. Usage and growth have moved to agents scoped to a clear job: shopping research, finance/office work in ChatGPT Work, and Codex. A large minority of AI users now use agents regularly, but those users are mostly heavy paying users.

### Cited Findings
- ChatGPT Agent launched with about 4M weekly active paying users (about 11% of 35M paying subscribers). Within months it fell below 1M, a drop of about 75%. Reported causes: users "couldn't figure out what to do with it or didn't know it existed", plus speed, reliability and security problems, and confusing branding. OpenAI is shifting to specialized agents such as Shopping Research. This is The Information's reporting via The Decoder, Jan 29 2026. — [The Decoder](https://the-decoder.com/chatgpt-agent-reportedly-lost-75-of-its-users-because-nobody-knew-what-it-was-actually-for/)
- Operator was folded into ChatGPT Agent in mid-2025 [secondary]. — [timewell.jp](https://timewell.jp/en/columns/chatgpt-agent)
- OpenAI announced on Jul 9 2026 that it was discontinuing the ChatGPT Atlas browser, with full deprecation on Aug 9 2026, less than 10 months after its Oct 2025 launch. Its features moved into the ChatGPT desktop app (in-app browser) and a Chrome extension. OpenAI framed this as the ChatGPT app becoming the main workspace, not as a verdict that AI browsers failed. Atlas only ever shipped on macOS. — [The Decoder](https://the-decoder.com/openai-kills-its-atlas-browser-after-just-eight-months-and-folds-everything-into-chatgpt/); [BGR](https://bgr.com/2212396/openai-chatgpt-browser-atlas-discontinued/); [Techzine](https://www.techzine.eu/news/applications/142826/openai-is-discontinuing-atlas-but-its-ai-browser-strategy-remains/)
- Atlas reportedly reached about 11M MAU by Q1 2026 (attributed to Presenc AI) [secondary/low-authority]. — [tech-insider.org](https://tech-insider.org/ca/?p=1149)
- Comet: reportedly 48.12% of tracked agentic web traffic in Apr 2026 (attributed to HUMAN Security). This measures agent traffic share, not a user count. Comet is now free worldwide and on Android. Chrome holds about 68% of the browser market and has a Gemini agent built in [secondary]. — [perplexityaimagazine](https://perplexityaimagazine.com/ai-tools/atlas-vs-comet-vs-chrome-2026/); [tech-insider.org](https://tech-insider.org/ca/?p=1149)
- OpenAI's agentic products (Codex plus ChatGPT Work) reached 10M weekly users less than 2 weeks after ChatGPT Work launched on Jul 9 2026. Codex had about 8M weekly users by mid-July, and over 1M people used Codex for non-software work. Delegated tasks include finance month-end reporting and forecasting, reconciling figures, building decks/docs/sheets, scheduled recurring tasks, and desktop Computer Use. The figures are self-reported, and it is unclear how many users pay or retain. — [The Next Web](https://thenextweb.com/news/openai-agents-10-million-chatgpt-work)
- A later report puts Codex plus ChatGPT Work at 40M weekly users in early October 2026 (a company figure first reported by Bloomberg) [secondary]. — [BigGo Finance](https://finance.biggo.com/news/4f456a69-1335-41cc-9dc9-07067bedb973)
- Menlo Ventures 2026 State of Consumer AI (Morning Consult, 5,067 US adults, July 2026), among AI users:
  - 41% have tried an AI agent, 24% use one regularly, and 32% have let AI act without final approval.
  - 36% have given an agent access to their email, and 20% to a financial account.
  - Agent users: 92% pay for AI and 63% use it daily. Payers are 5x as likely as non-payers to use agents (65% vs 13%).
  - US adult AI use went from 61% to 64%, and 55% of AI users pay for at least one AI product.
  — [Menlo Ventures report PDF](https://menlovc.com/wp-content/uploads/2026/09/menlo_ventures_consumer_ai_report-2026.pdf); [Digital Applied summary](https://www.digitalapplied.com/blog/ai-agent-access-permissions-consumer-survey-statistics-2026). I could not parse the PDF directly (too large); these numbers come via search summaries of it.
- Menlo 2025 baseline (Jun 2025, 5,031 US adults): 61% use AI, about 1 in 5 daily, only 3% pay, and about $12B consumer spend. — [Menlo 2025 coverage](https://markets.financialcontent.com/dowtheoryletters/article/gnwcq-2025-6-26-menlo-ventures-2025-consumer-ai-report-12b-market-18-billion-global-users-signal-ais-mainstream-moment)
- Manus says it reached $100M ARR about 8 months after its March 2025 launch (above $125M run rate including usage). Meta acquired it for more than $2B (WSJ) in late 2025. Tasks named: research, coding, resume screening, travel planning, stock analysis. These are company claims. — [Trending Topics](https://www.trendingtopics.eu/meta-acquires-ai-agent-startup-manus-which-recently-reached-100-million-arr/); [Techstrong](https://techstrong.ai/agentic-ai/meta-to-acquire-ai-startup-manus-for-2-billion/)
- Prompt injection and trust are recurring barriers cited for browser agents [secondary]. — [blog.mean.ceo](https://blog.mean.ceo/?p=2918)

### Inferences
- "General web agent" is not a product people return to. Retention comes from a named job (shopping research, month-end report, a scheduled task) plus a trusted, fast path. This supports keeping `ox browse` fast and task-shaped, with the existing confirm-before-buy/pay/send, rather than an open-ended "agent mode".
- About a third of AI users already let agents act without final approval and give them email access. Asking before irreversible steps is therefore a trust differentiator, not an unwanted step.
- Moving the browser into the main assistant app plus a Chrome extension (OpenAI) supports an agent that drives the user's existing browser over a separate browser product.

### Gaps
- No public task-level breakdown of what people delegate to ChatGPT Agent, Comet or Claude in Chrome. No public success-rate or retention numbers for Comet, Claude in Chrome or Manus.
- No independent retention data for Manus after the acquisition.
- I could not open the Menlo 2026 PDF directly (over 10MB), so its agent task breakdown is unverified.

## 2. Personal automation demand (n8n, Zapier, Make, Lindy, OpenClaw/Hermes) and messaging-app agents

### Takeaway
Demand for self-hosted, messaging-first personal agents is very large by developer-interest measures (OpenClaw about 356K GitHub stars in 3 months; Hermes Agent about 230K). Typical real use is modest: morning briefings, reminders, email/calendar summaries, content automation, and coding supervision via Telegram. Much of the observed "use" is people configuring the agent itself. Most n8n templates are now AI-involved, and business automations (CRM, leads, sheets, alerts) dominate.

### Cited Findings
- OpenClaw (launched as Clawdbot in Nov 2025, renamed Moltbot, then OpenClaw in Jan 2026) reached about 356K GitHub stars in 3 months. It connects to 23+ messaging platforms, Telegram is usually set up first, and WhatsApp runs via WhatsApp Web. The creator later joined OpenAI and the project moved to a non-profit foundation. Releases 2026.4.24 and 2026.4.29 had gateway slowdown and stability issues [secondary/guides]. — [heyuan110 guide](https://www.heyuan110.com/posts/ai/2026-03-05-openclaw-setup-guide); [Ollama blog](https://registry.ollama.ai/blog/openclaw); [feedbagel release note](https://feedbagel.com/post/the-6-9-release)
- OpenClaw added about 14K stars per week between late April and mid-June 2026, then slowed [secondary]. — [gradually.ai](https://www.gradually.ai/en/hermes-agent-statistics/)
- Hermes Agent (Nous Research, released Feb 2026) [secondary]:
  - GitHub stars: about 174K on May 31 2026, about 212.5K by mid-July, about 230K by Aug/Sep.
  - Ranked #1 in OpenRouter daily rankings on May 10 2026, with 224B tokens in one day.
  - Its pitch is persistent agent-curated memory and self-improving skills extracted from completed tasks.
  - Reception is mixed, including suspicion of astroturfing from new accounts. Many power users run it alongside OpenClaw.
  — [gradually.ai](https://www.gradually.ai/en/hermes-agent-statistics/); [pasqualepillitteri review](https://pasqualepillitteri.it/en/news/3864/hermes-agent-review-community-opinions)
- What people use OpenClaw for [vendor/blog compilations, not rigorous surveys]:
  - The entry point is messaging-first personal assistant work: daily briefings (calendar, weather, priorities, news via cron/HEARTBEAT.md), reminders, summaries and background task runs. — [tldl.io](https://www.tldl.io/blog/openclaw-use-cases-2026); [clawdocs](https://clawdocs.org/guides/use-cases)
  - Content automation has the widest reach, and coding workflows the highest reported satisfaction (sample not disclosed). — [tldl.io](https://www.tldl.io/blog/openclaw-use-cases-2026)
  - In an analysis of 336 documented examples, the largest category was setup and configuration (dashboards, memory systems, skill libraries), not productive work. — [Claude Market](https://claudemarket.ai/blog/openclaw-use-cases-336)
  - Power-user outlier: a supervisor agent coordinating 5 to 20 Claude Code instances via Telegram, costing about $400 a month. — [Claude Market](https://claudemarket.ai/blog/what-people-actually-use-openclaw-for)
- n8n templates [unofficial trackers]:
  - Library size: about 7.8K to 8.5K templates (333 nodes, 1.7K creators); 9,000+ by May 2026.
  - About 57% of category assignments are AI-related. About 5.2K templates are in the AI category, and 2.6K to 2.9K use the AI Agent node.
  - Most-used nodes: Code 5,931, Set 5,748, HTTP Request 5,516, IF 4,937, AI Agent 3,718, Google Sheets 3,613.
  - Top use-case areas: CRM sync, lead enrichment, AI pipelines, finance automation. For small businesses: orders to spreadsheets, abandoned-cart follow-ups, lead capture to CRM, support-ticket alerts, Stripe-to-accounting sync, weekly revenue reports, error alerts.
  — [n8n-pulse tracker](https://n8n-pulse.gui.do/templates); [n8n-stats tracker](https://n8n-stats.gui.do/templates); [Activepieces (Pixtex counts)](https://www.activepieces.com/blog/n8n-workflows-how-they-work-and-examples-2026-guide.md); [Goodspeed](https://goodspeed.studio/blog/n8n-templates); [ScalaHosting](https://www.scalahosting.com/blog/?p=74678)
- Scheduled recurring tasks are a headline feature of ChatGPT Work (Jul 2026). — [The Next Web](https://thenextweb.com/news/openai-agents-10-million-chatgpt-work)

### Inferences
- Messaging (Telegram first, then WhatsApp) is the main interface for personal agents in the open-source crowd. Lacking Slack matters for work users, and lacking WhatsApp/iMessage matters for consumers. OpenClaw supports 23+ channels.
- "Morning briefing plus reminders plus email triage on a schedule" is the canonical starter flow. ox could ship it as a one-command default flow, which would also address the observed problem of people spending most of their time on setup.
- Templates involve AI more and more, but stay business-plumbing (Sheets, CRM, HTTP). Turning n8n templates into ox flows makes sense if the top AI/Sheets/Gmail/Telegram templates work out of the box.

### Gaps
- No official n8n per-template usage or view rankings. No Zapier/Make/Lindy usage figures in 2026 sources found.
- No active-user (as opposed to star) counts for OpenClaw or Hermes.
- No quantitative data on WhatsApp/iMessage/Slack agent usage specifically.

## 3. Multi-agent "AI employees/teams" (Lindy, Relevance, CrewAI, Devin-style): demand and retention

### Takeaway
I found no public retention, churn or NRR data for "AI employee" products. Reviewers say the "employee" metaphor breaks down, and that these products are really sophisticated automations. The measurable growth is in single-agent products scoped to a job (Codex, ChatGPT Work, Manus). Treat "agent org/team" framing as marketing with unproven demand.

### Cited Findings
- Vellum's 2026 roundup positions the products by job: Lindy for people buried in email, meetings and scheduling; Relevance AI for GTM teams building agent workforces; 11x for 24/7 sales outbound. — [Vellum](https://website.vellum.ai/blog/best-ai-employees)
- A hands-on review calls Lindy the most technically impressive pure-play platform, but says the "employee" metaphor breaks down and these are really sophisticated automations. — [TeamDay](https://www.teamday.ai/blog/ai-employees-market-map-2026)
- VC outlook for 2026: the CFO is becoming the buyer, products without immediate ROI face churn, and renewals of first-wave contracts will test sustained usage [opinion/prediction]. — [VC Cafe](https://www.vccafe.com/2026/01/08/2026-ai-predictions-the-year-of-the-agent-employee); [FourWeekMBA](https://fourweekmba.com/2026-the-year-ai-startups-face-their-do-or-die-moment-as-vcs-predict-consolidation-wave/)
- Claude.ai usage is moving back toward collaboration. In the Anthropic Economic Index (Jan 2026 report, Nov 2025 data), augmented conversations rose 5pp to 52% and automated fell 4pp to 45%, which Anthropic partly attributes to file creation, memory and Skills. The Sep 2025 report had directive automation rising from 27% to 39%. Enterprise API use is about 75% automated. — [Anthropic Economic Index](https://anthropic.com/research/economic-index-primitives); [Anthropic report PDF](https://www-cdn.anthropic.com/096d94c1a91c6480806d8f24b2344c7e2a4bc666.pdf)

### Inferences
- Consumers keep a human in the loop: augmentation is above 50% on Claude.ai. Full-autonomy "teams" match API/enterprise patterns more than personal use.
- For ox, the org/task board and pixel-art office view are likely valued mainly as visibility and fun. The claim worth making is "see what your agents are doing", not "replace staff". This is an inference with no direct data.

### Gaps
- No retention, customer-count or churn data for Lindy, Relevance, CrewAI, 11x or Devin found in 2026 sources.

## 4. Memory: what users want and fear; second-brain demand

### Takeaway
Users want memory but are often unpleasantly surprised by what it retains. The consistent ask in research is visibility, transparency and control over individual memories. Persistent memory is central to the fastest-growing open-source agent (Hermes). Quantitative backlash surveys from 2026 were not found.

### Cited Findings
- CHI 2026 paper (Chen, Molina, Liao, Cho; 20 interviews with ChatGPT users): most participants experienced negative expectancy violations when they learned what ChatGPT remembered. They want more visibility, accessibility, transparency and user control. — [UGA Grady](https://grady.uga.edu/research/ai-never-forgets-exploring-users-perceptions-of-ai-memory-and-chatgpts-memory-feature/)
- A student survey poster (NKU, 2025) found many users unaware or unsure how memory extracts, stores and manages data. — [Murray State Digital Commons](https://digitalcommons.murraystate.edu/postersatthecapitol/2025/NKU/4)
- ChatGPT memory lacks the per-memory granular control that Grok's memory offers. Grok's launch divided users, with "transparency matters" as a theme. — [eWeek](https://www.eweek.com/news/grok-can-remember-conversations-now/)
- Anecdotal reports of ChatGPT using names or details users don't recall giving, which users found creepy. — [Jordan News](https://www.jordannews.jo/Section-129/Technology/Suspicious-Behavior-Sparks-Panic-Is-ChatGPT-Watching-Us-41318)
- A developer blog claims a June 2026 memory change where memories persist after chat deletion. This is unverified, with no official source. — [DEV Community](https://dev.to/rshanmugaraj_e471fa3f2ed/chatgpts-new-memory-system-gave-me-a-privacy-wake-up-call-35o5)
- Anthropic credits memory (with file creation and Skills) for more collaborative, iterative Claude.ai usage. — [Anthropic Economic Index](https://anthropic.com/research/economic-index-primitives)
- Hermes Agent markets agent-curated persistent memory plus self-improving skills. A large share of OpenClaw activity is building memory systems and dashboards. — [gradually.ai](https://www.gradually.ai/en/hermes-agent-statistics/); [Claude Market](https://claudemarket.ai/blog/openclaw-use-cases-336)

### Inferences
- ox's memory design already includes facts with history, recall and explicit forget, and stores notes as markdown with a rebuildable index. That matches what the research says users ask for: inspectable, per-item editable, deletable. Emphasize "you can see and edit every memory as a file" against ChatGPT's opaque memory.
- Power users clearly build their own memory systems (OpenClaw configs), so demand for Obsidian/markdown-vault integration is plausible. I found no quantitative evidence for it, though.

### Gaps
- No 2026 quantitative survey (Pew, Gartner or similar) on AI memory attitudes found.
- No data on how many users want Obsidian or second-brain integrations.

## 5. Deep research: usage frequency, purpose, satisfaction

### Takeaway
Research and information-seeking is a core use of assistants. Practical guidance, seeking information and writing dominate ChatGPT use, and 84% of surveyed policy researchers use AI for research. I found no rigorous public data on how often people run "deep research" modes specifically or how satisfied they are. Accuracy and reliability is the top barrier (80%).

### Cited Findings
- NBER WP 34255, "How People Use ChatGPT" (Sep 2025): by Jul 2025 about 10% of the world's adults had adopted ChatGPT. Non-work messages grew from 53% to over 70% of usage. Practical guidance, seeking information and writing dominate. A secondary briefing puts these at about 80% of conversations; I did not verify that against the paper. — [NBER via RePEc](https://ideas.repec.org/p/nbr/nberwo/34255.html); [eDiscovery Today briefing](https://ediscoverytoday.com/wp-content/uploads/2025/09/Briefing-Document-Overview-How-People-Use-ChatGPT.pdf)
- ChatGPT reached 800M+ weekly users by Dec 2025 and was nearing 900M to 1B in 2026. — [Sherwood](https://sherwood.news/tech/chatgpt-reaches-nearly-900-million-weekly-active-users/); [The Information](https://www.theinformation.com/articles/openais-chatgpt-nears-1-billion-weekly-active-users-seven-months-target)
- APPAM 2026 survey of research and policy professionals: 84% used general assistants for research or policy analysis in the past 12 months, 33% use AI daily or near-daily, and 80% cite accuracy/reliability as the top barrier. — [APPAM](https://www.appam.org/2026-ai-survey/)
- AI chatbot referral share (Statcounter, May 2026): ChatGPT 79.08%, Perplexity 7.67%, Gemini 7.03% [secondary]. — [perplexityaimagazine](https://perplexityaimagazine.com/perplexity-hub/chatgpt-vs-perplexity-user-survey/)
- Small editorial comparisons:
  - In a 10-query test, ChatGPT Deep Research gave longer, more structured reports, while Gemini was faster with slightly better citations (90% vs 87% in one sample). — [aiagentrank](https://aiagentrank.io/blog/gemini-deep-research-vs-chatgpt-2026)
  - Perplexity's deep research is advertised at 2 to 4 minutes, but one user reported runs often take 5 to 20 minutes. — [uzyn.com](https://uzyn.com/2025/thoughts-on-perplexity-deep-research-after-24-hours/)
  - Usage limits vary by plan and source (for example ChatGPT Plus about 10 per month vs Gemini Pro about 20 per day); the sources conflict.
- Manus's paying use cases include research and stock analysis. Perplexity's Comet is described as the leading option for research-first users. — [Trending Topics](https://www.trendingtopics.eu/meta-acquires-ai-agent-startup-manus-which-recently-reached-100-million-arr/); [tech-insider.org](https://tech-insider.org/ca/?p=1149)

### Inferences
- Since reliability is the top barrier, `ox research`'s cited-links approach (Reddit/HN/YouTube with links) and the saved library are aligned with demand. Citation accuracy and speed are the competitive measures.
- Deep research is now bundled free or cheap in every major assistant, so it is unlikely to be a paid differentiator by itself. Value comes from combining it with personal context (library, memory) and scheduled delivery. This is an inference.

### Gaps
- No vendor-published usage-frequency or satisfaction numbers for ChatGPT, Gemini or Perplexity deep research modes.
- No data on what topics people deep-research (shopping vs work vs health) beyond general ChatGPT usage categories.
- No a16z top-100 consumer AI app list data was gathered in this pass. The search budget was used on primary agent sources.
