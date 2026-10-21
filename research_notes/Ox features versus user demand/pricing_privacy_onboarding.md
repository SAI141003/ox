# User preferences on pricing, privacy, local vs cloud, onboarding and UX for AI developer tools (2025 to Oct 2026)

Scope note: about 14 search and fetch calls. The Stack Overflow 2025 AI page was fetched directly. Most other figures come from secondary coverage (TechCrunch, The Register, Visual Studio Magazine, InfoWorld, trade press) and are flagged where unverified.

## 1. Willingness to pay: price points, BYOK vs bundled, usage-based vs flat, reactions to pricing changes

### Takeaway
The market has settled on $20/month as the mainstream individual tier and $200/month for heavy users. Each move from flat or "unlimited" plans to metered or compute-based billing (Cursor in June 2025, Claude Code weekly caps in Aug 2025, Copilot premium requests in June 2025 and AI Credits in June 2026) set off loud backlash, cancellations, and, at Cursor, refunds. Developers care most about predictability. BYOK open-source agents (Cline, OpenCode) have grown large because they charge no seat fee and pass inference through at provider rates.

### Cited Findings
- On June 16, 2025, Cursor added a $200/month Ultra plan and moved its $20/month Pro plan from request limits to compute limits (about $20 of usage at API rates). Heavy users ran out quickly and some were billed overage they did not expect. — [TechCrunch](https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/); [Fintech Weekly](https://www.fintechweekly.com/magazine/articles/cursor-pricing-change-user-backlash-refund)
- Cursor's CEO apologized ("we didn't handle this pricing rollout well") and promised full refunds for unexpected charges from June 16 to July 4, 2025. Users reported cancelling in large numbers and waiting weeks for refunds. — [TechCrunch](https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/); [WeAreFounders timeline (blog)](https://www.wearefounders.uk/cursors-pricing-disaster-the-full-timeline-of-how-an-ai-coding-darling-burned-its-most-loyal-users/)
- Anthropic added weekly caps to Claude Pro and Max starting Aug 28, 2025, on top of 5-hour resets. It said fewer than 5% of users would be affected and blamed 24/7 background use and account reselling. Critics calculated that the $200 Max tier, marketed as "20x Pro", gave only about 6x Pro's Claude Code hours. — [Gigazine](https://gigazine.net/gsc_news/en/20250729-anthropic-calude-code-rate-limits); [Analytics India Mag](https://analyticsindiamag.com/ai-news-updates/anthropics-new-rate-limits-for-claude-code-sparks-backlash); [UserJot/Dev.to](https://dev.to/shayy/claude-code-pricing-is-the-200mo-plan-worth-it-new-rate-limits-explained-lk1)
- Developers reported hitting Claude limits within about 30 minutes and then waiting hours. Max users in an April 2026 Reddit thread said their weekly allowance felt like it was shrinking. A blog also says a later change, sold as "+25%", was really a 17% cut against the prior baseline (secondhand, not checked against Anthropic). — [Dev.to](https://dev.to/shayy/claude-code-pricing-is-the-200mo-plan-worth-it-new-rate-limits-explained-lk1); [Pillitteri (blog)](https://pasqualepillitteri.it/en/news/13403/claude-code-weekly-limits-25-percent-17-cut)
- GitHub Copilot began billing premium requests on June 18, 2025, for all paid plans. One developer reported a single request costing more than $6 and asked how individuals can budget. — [GitHub Docs](https://help.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests); [GitHub changelog](https://github.blog/changelog/2025-06-18-update-to-github-copilot-consumptive-billing-experience/); [The Register](https://www.theregister.com/a/5249826)
- On June 1, 2026, Copilot replaced premium requests with token-based "AI Credits". The GitHub discussion thread drew more than 400 comments and about 900 downvotes. By Aug 2026, developers reported using most or all of their monthly allowance within 1 to 2 days and objected to paying a subscription plus overages. — [MLQ.ai](https://mlq.ai/news/v2/github-copilot-switches-to-token-based-billing-june-1-drawing-developer-backlash/); [Visual Studio Magazine, Aug 2026](https://visualstudiomagazine.com/articles/2026/08/07/copilot-credit-complaints-keep-coming-too-expensive-to-use.aspx)
- Cost is a barrier to AI agent adoption for 53.3% of developers (25.4% strongly agree, 27.9% somewhat agree). — [Stack Overflow 2025 survey, AI](https://survey.stackoverflow.co/2025/ai)
- "Prohibitive pricing" is the #2 reason developers abandon a technology, behind security and privacy (#1) and ahead of better alternatives (#3). — [Stack Overflow 2025 survey](https://survey.stackoverflow.co/2025/); [Stack Overflow press release](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/)
- Enterprise spend: Menlo Ventures (survey of 495 US enterprise AI decision-makers, Nov 2025) put coding AI apps at about $4.0B in 2025, 55% of departmental AI spend, up from $550M. Another write-up of the same report gives $4.2B. Total enterprise GenAI spend was $37B. — [SaaStr](https://www.saastr.com/55-of-all-departmental-ai-spend-is-now-on-coding-and-its-not-slowing-down); [No Jitter](https://www.nojitter.com/ai-automation/menlo-ventures-estimates-19-billion-in-gen-ai-spend-during-2025)
- BYOK open-source agents: Cline (Apache 2.0) has a free open-source tier with no seat fees, so users pay only provider inference rates. It has about 61k to 64k stars (mid-2026) and is reported at 4.3M to 8M+ installs. OpenCode (MIT, 75+ providers) has about 161k to 165k stars (May 2026) and is described as the most-starred open-source CLI coding agent. Roo Code, a Cline fork, was archived May 15, 2026. — [Pinggy](https://pinggy.io/blog/best_open_source_cli_coding_agents/); [OpenAlternative](https://openalternative.co/compare/cline/vs/opencode); [DeployHQ guide](https://deployhq.com/guides/cline); [AutomationAtlas](https://automationatlas.io/answers/cline-review-2026/) (star counts are from review sites and were not audited)

### Inferences
- If ox stays free with BYOK or a user's existing subscription, it avoids the most hated pattern in the category: opaque metering on top of a subscription. ox's advantage is "you pay your provider directly, we take nothing". It should state this plainly and show users their spend (an `ox usage`-style view supports this).
- If ox ever charges, the evidence points to a flat, predictable price (for example a one-time or $X/month "pro" tier for convenience features such as signed builds, sync, or mesh relay), never metered inference. Any change to limits needs advance notice and must not be presented as an increase when it is a cut.
- The $20 and $200 anchors apply to bundled inference. A BYOK tool cannot plausibly charge at those levels. Successful open-source BYOK tools (Cline, OpenCode) earn adoption first and monetize enterprise or teams later.
- Letting users plug in an existing Claude or ChatGPT subscription is valuable because so many developers already pay $20 to $200 for one. Users dislike paying twice.

### Gaps
- No survey data was found that measures willingness to pay directly (for example the % who would pay $10 vs $20). The SO and JetBrains 2025 pages surfaced do not break out price thresholds.
- Copilot's $10 Pro price and Claude's $100 Max tier were not verified from primary sources in this pass.
- I did not find quantitative data comparing BYOK and bundled-credit preference.
- Menlo's coding figure conflicts between write-ups ($4.0B vs $4.2B), and the primary report was not reached.

## 2. Privacy and local-first: how much users care; enterprise vs individual

### Takeaway
Privacy and security is the #1 reason developers drop a technology (Stack Overflow 2025), and 81.4% are concerned about data security or privacy when using AI agents. When developers rank AI concerns against each other, though, privacy comes third, behind quality and correctness (JetBrains: 13% vs 23%). Enterprises are where privacy turns into hard constraints: 28.2% of developers say IT or InfoSec rules block agent use, and Cisco finds widespread leakage of sensitive data into GenAI. Local-model usage is large in practice (Ollama is used by 51.1% of agent users), but I found no survey that isolates "privacy" as the reason.

### Cited Findings
- 81.4% of developers are concerned about the security and privacy of data when using AI agents (56.1% strongly, 25.3% somewhat). 86.9% are concerned about accuracy. — [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)
- 28.2% agree that company IT or InfoSec rules block their use of AI agents. — [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)
- Security or privacy concerns are the #1 deal-breaker that makes developers abandon a technology, and missing AI integration ranks low as a deal-breaker. — [Stack Overflow 2025](https://survey.stackoverflow.co/2025/); [AppDeveloperMagazine summary](https://appdevelopermagazine.com/Stack-Overflow-2025-Developer-Survey/)
- 61.7% would turn to a human rather than AI because of ethical or security concerns about code. — [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)
- Ollama is used by 51.1% of developers who use agents, as an orchestration or runtime tool. LangChain is used by 32.9%. — [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)
- JetBrains 2025 (24,534 developers, 194 countries) ranks the top AI concerns as code quality 23%, limited understanding of complex logic 18%, privacy and security 13%, skill erosion 11%, and lack of context awareness 10%. 85% regularly use AI for coding. — [JetBrains Research blog](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/); [InfoWorld via scour](https://scour.ing/p/https://www.infoworld.com/article/4077352/85-of-developers-use-ai-regularly-jetbrains-survey.html)
- Cisco 2025 Data Privacy Benchmark (2,600 privacy and security professionals, 12 countries): about 46% say employee information is entered into GenAI tools, and 42 to 48% say non-public company information is (figures differ between write-ups). More than two-thirds worry about data being shared with competitors or the public. — [Cisco press release](https://newsroom.cisco.com/content/r/newsroom/en/us/a/y2025/m04/cisco-2025-data-privacy-benchmark-study-privacy-landscape-grows-increasingly-complex-in-the-age-of-ai.html); [HCA Mag](https://www.hcamag.com/us/specialization/hr-technology/nearly-half-of-organisations-entering-employee-info-into-genai-survey/530858); [Tech Monitor](https://www.techmonitor.ai/?p=404699)
- Ollama (July 2026 Series B, $65M) says it is used within 85% of the Fortune 500, including government, healthcare, and finance, and stresses that data never leaves the machine. This is a company claim. — [Las Vegas Sun / press release](https://lasvegassun.com/news/2026/jul/09/ollama-raises-65m-series-b-funding-to-grow-its-ope/)
- Practitioner guides call privacy and data residency one of the three arguments for local LLMs that "held up in production". This is qualitative. — [Dev.to 2026 Ollama guide](https://dev.to/cursuri-ai/run-llms-locally-with-ollama-in-2026-the-practical-developer-guide-48n)

### Inferences
- "No account, no telemetry, local models" is a real differentiator, but mostly as a reason not to reject ox (a gate) rather than the main reason to adopt it. Developers pick tools on quality and correctness first. ox should lead with what it does well and use privacy as reassurance.
- The enterprise and regulated segment (28% blocked by InfoSec) is where local-first pays most. A clear "what leaves this machine" page, a verifiable no-telemetry claim (open code, no network calls by default), and support for local models would serve that buyer.
- Individual developers lean toward the best model, which is usually cloud. A local option adds credibility, but ox should not assume users will accept weaker local output.

### Gaps
- No 2025 or 2026 survey was found giving the % of developers who run local LLMs for privacy, or who would pay more for local-only.
- I did not reach Pew 2025 consumer AI privacy data in this pass.
- No quantitative data was found on how much "no telemetry" counts as a choice factor.

## 3. Onboarding: time-to-first-value, abandonment causes, first-run best practice

### Takeaway
General SaaS benchmarks put average activation at about 37.5% and median time-to-value at about 1.5 days (Userpilot 2025). AI/ML tools activate better than average (54.8%). For a Mac app distributed as a zip or git clone, the biggest concrete risk is macOS Gatekeeper: since Sequoia 15.1, unsigned or unnotarized apps can no longer be opened with the Control-click bypass, and the warning dialog offers only "Move to Trash" or "Cancel". I found no study measuring how many users abandon at the API-key step.

### Cited Findings
- Userpilot 2025 benchmark: average activation rate 37.5% (median 37.04% in a 62-company subset; Userpilot elsewhere cites 547 companies). Median time-to-value is 1 day 12 h 23 min. AI and ML tools average 54.8% activation, against 5% for FinTech. — [Userpilot, time to value](https://userpilot.com/blog/time-to-value); [Userpilot onboarding metrics](https://userpilot.com/blog/user-onboarding-metrics/)
- Userpilot warns that teams often mismeasure activation by tracking "completed setup" or "logged in twice", which are prerequisites rather than first value. — [Userpilot](https://userpilot.com/blog/time-to-value)
- A separate (lower-quality) source claims a 22-minute median time to first value for self-serve SaaS, which conflicts with Userpilot's 1.5 days, probably because of different definitions. — [Konabayev (unverified)](https://konabayev.com/blog/customer-onboarding-statistics-2026/)
- macOS Sequoia 15 removed the Control-click Gatekeeper bypass for unsigned apps, and 15.1 disabled the bypasses completely. Open-source projects such as OpenSCAD were caught out (GitHub issues, forum posts). — [Hackaday](https://hackaday.com/tag/appledrm/)
- Notarization has been required for apps distributed outside the Mac App Store since Catalina. It needs a $99/yr Apple Developer membership. Command-line tools do not need to be notarized. — [Electron docs commit](https://ayakael.net/mirrors/electron/commit/7932e28aa2a974f39019770fc3f8e77a8276cdaa); [Bastion docs](https://docs.bastion.tech/devices/apple/signing-notarizing); [HN comment](https://hn.svelte.dev/item/24217116)
- The warning for an unsigned app offers only "Move to Trash" or "Cancel". Electron advises signing early because trust "builds over time". — [Electron docs commit](https://ayakael.net/mirrors/electron/commit/7932e28aa2a974f39019770fc3f8e77a8276cdaa)

### Inferences
- For ox, a signed and notarized Mac app (DMG) plus a one-line installer or Homebrew tap is likely the highest-leverage onboarding fix. A GitHub zip that triggers the "Move to Trash" dialog is a first-run cliff. The CLI path is exempt from notarization and has less friction.
- First value should arrive before the API-key step where possible. For example, detect an existing Claude Code or Codex login, an `ANTHROPIC_API_KEY` env var, or a running Ollama, so a user with any of these gets a working answer in their first minute. Ask for macOS permissions (Accessibility, Screen Recording, Microphone) only when a feature first needs them, not up front.
- ox should measure activation as "first successful task", not "app opened".

### Gaps
- No developer-tool-specific time-to-first-value benchmark was found. No quantitative data was found on drop-off at the API-key step or at the macOS permission dialogs.
- I did not find Appcues or Reforge 2025 reports in this pass.
- No abandonment rate was found for unsigned Mac apps.

## 4. Feature bloat vs focus; presenting many features

### Takeaway
The evidence here is thin and mostly anecdotal. The most-cited statistic (Standish Group, about 64% of features rarely or never used) is old and second-hand. Developer opinion is split between focused, composable tools and integrated bundles. Stack Overflow data shows "lack of AI integration" is a weak deal-breaker, which suggests that adding capabilities does not on its own win developers. Correctness and trust dominate.

### Cited Findings
- Feature usage: Standish Group (cited second-hand) found about 64% of features in typical software are rarely or never used. The columnist claims about 80% for modern apps without a source. — [Entrepreneur](https://www.entrepreneur.com/growing-a-business/most-of-your-product-features-suck-heres-how-to-fix-them/504710)
- Bloat often comes from piling up feature requests and from pressure to ship new features. — [UserGuiding](https://userguiding.com/blog/feature-bloat)
- Practitioners disagree. Some want IDEs as loosely coupled plugins, while others say integrated bundles are more robust. In the Eclipse community, some argue there is "no evidence" users value bundles, while one project reports users prefer its all-in-one package. — [Eclipse mailing list](https://eclipse.org/lists/cross-project-issues-dev/msg09476.html); [TUHS COFF list](https://www.tuhs.org/pipermail/coff/2024-May/001831.html)
- The top AI frustration is solutions that are "almost right, but not quite" (66%), and 45.2% say debugging AI code takes longer. Developers' pain is about quality, not missing features. — [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)
- The most-adopted open-source agents are narrowly positioned. In one comparison, "Terminal people choose OpenCode; IDE people choose Cline". — [WeTheFlywheel comparison](https://wetheflywheel.com/en/comparisons/opencode-vs-roo-code-vs-cline/)

### Inferences
- With coding, Studio, voice, browser agent, automations, and mesh, ox risks reading as unfocused. The data suggests leading with one sharp job (a local-first coding agent that works with any model or subscription) and presenting the rest as discoverable extras: a command palette, a `ox help` grouped by job, and off-by-default modules.
- Progressive disclosure is the standard pattern: show the core loop first and reveal advanced features in context. I did not retrieve formal evidence on it in this pass (see Gaps).

### Gaps
- No rigorous 2025 or 2026 study was found comparing "does everything" and focused developer tools.
- No usability research on command palettes or progressive disclosure was retrieved. Nielsen Norman Group's progressive disclosure article would be the canonical source, but I did not fetch it.

## 5. Trust signals for a new open-source AI tool

### Takeaway
Developers judge open-source projects by visible cues: README quality, recent commit and release activity, contributor spread, and maintainer availability. Research finds that many important qualities lack easily observable signals. Star counts are used socially (as the coding-agent comparisons show) but are not validated as trust signals. For a one-person project, the main weaknesses are bus-factor concerns, and on Mac, unsigned builds.

### Cited Findings
- In the TrustSECO interview study, developers said a high contributor count means little if one person wrote nearly all the code (example: 3,000 contributors but 99.9% of code from one person). They valued visible reasoning in discussions and controlled contributor access, citing backdoors. — [TrustSECO (arXiv)](https://arxiv.org/pdf/2101.06138)
- Developers infer project quality from visible repository signals such as badges. A study of 294,941 npm repositories tested which badges actually match the qualities they claim to signal. — [Trockman et al., NSF PAR](https://par.nsf.gov/servlets/purl/10063054)
- Interviews identified README structure and recent activity as selection signals. A test on 9,977 projects found that many important qualities lack easily observable signals. — [unibz research](https://bia.unibz.it/esploro/outputs/conferenceProceeding/An-Investigation-of-the-Users-Perception/991006493779701241)
- Users weigh whether original developers stay available for support and whether releases come regularly and predictably. They check commit and release history first (practitioner comment). — [Eclipse open-regulatory-compliance list](https://www.eclipse.org/lists/open-regulatory-compliance/msg00682.html)
- The large BYOK agents are routinely compared by GitHub stars (OpenCode about 165k, Cline about 63k), so stars work as social proof in the category. — [Pinggy](https://pinggy.io/blog/best_open_source_cli_coding_agents/)
- Developer trust in AI output is low and falling. 46% don't trust AI accuracy (up from 31%), and only 3.1% "highly trust" it. — [Stack Overflow press release](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/); [Stack Overflow 2025, AI](https://survey.stackoverflow.co/2025/ai)

### Inferences
- For ox, the cheapest credible trust signals are: a regular, tagged release cadence with changelogs; signed and notarized Mac builds; a SECURITY.md and a documented "what network calls ox makes" list; reproducible benchmark results (for example the Terminal-Bench-style evals ox already references); and a visible test suite or CI badge.
- Because AI-output trust is low, features that prove work (ox's "proof the coder cannot fake", evidence-based race winners) match a real user anxiety and belong in front-page positioning.
- Single-maintainer risk can be eased with open governance signals: CONTRIBUTING.md, good-first-issues, and a public roadmap.

### Gaps
- No 2025 or 2026 survey was found that quantifies which trust signals (stars, signed builds, benchmarks) developers weigh most for AI tools.
- No data was found on how star counts relate to adoption or trust.
