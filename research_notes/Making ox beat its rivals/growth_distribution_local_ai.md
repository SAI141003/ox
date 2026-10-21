# Growth, distribution, trust and local AI on Apple Silicon for ox (as of Oct 2026)

Scope note: 15 web search calls. Most sources are secondary (tech blogs, aggregators, vendor comparison pages). Primary pages (Anthropic legal pages, Apple's membership page, Homebrew release notes) were NOT fetched; flagged where it matters. Star/user numbers vary a lot between sources and are listed with their dates.

## 1. How comparable open-source dev tools gained users

### Takeaway
The breakout projects grew on three things: (a) being model-agnostic or local at a moment when developers distrusted a vendor (OpenCode after Anthropic's OAuth block; Cursor's ownership change), (b) an easy install surface where developers already are (VS Code/OpenVSX marketplace for Cline; one-line install plus a Show HN for Ollama), and (c) a public credibility artifact (Aider's polyglot leaderboard and "Aider wrote X% of its own code"). The money then came from teams/hosted tiers and VC, not from the core tool.

### Cited Findings
- **OpenCode**: about 112.8K stars, 779 contributors and 80 releases in Jan–Feb 2026; stars more than doubled after January 2026, a surge the page ties to Anthropic's OAuth change — [MorphLLM](https://www.morphllm.com/comparisons/opencode-vs-claude-code)
- OpenCode passed 160K stars and roughly 7.5M monthly active developers in July 2026; the article links the timing to SpaceX's reported acquisition of Cursor pushing developers to alternatives (editorial causal claim) — [Tech Insider](https://tech-insider.org/opencode-160k-github-stars-2026/)
- OpenCode reported growing from a ~30-person meetup to 8M monthly users, 140K+ stars, and an expected ~$25M annual revenue — [Let's Data Science](https://letsdatascience.com/news/opencode-reaches-eight-million-monthly-users-in-one-year-51652538). MAU figures across sources range from 2.5M to 8M; they do not reconcile.
- Stars about 172K in early June 2026 and about 194K in early August 2026 (MorphLLM tracker via Tech Insider) — [Tech Insider](https://tech-insider.org/opencode-vs-claude-code-2026)
- The "157,000 developers hedging against Anthropic with OpenCode" framing — [The New Stack](https://thenewstack.io/anthropic-claudecode-opencode-split/)
- OpenCode is MIT-licensed, terminal-based, works with many providers, free apart from tokens; spread credited to model-agnosticism and vendor-lock-in wariness — [MorphLLM](https://www.morphllm.com/comparisons/opencode-vs-claude-code)
- OpenCode offers a paid "Black" plan that gives Claude access through an enterprise API gateway (API billing, not OAuth) — [zbuild.io](https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026)
- **Cline**: passed 5M installs across VS Code, JetBrains, Cursor, Windsurf and others via OpenVSX, and paired the milestone with a $1M Cline-credits grant for open-source projects — [Cline blog](https://cline.bot/blog/5m-installs-1m-open-source-grant-program). Reported 8M+ installs by August 2026 and ~63K stars in June 2026 — [rywalker.com](https://rywalker.com/research/cline)
- Cline raised $32M (Seed plus Series A, Emergence Capital and Pace Capital), announced July 31, 2025, positioned as "the open source AI coding agent that enterprises trust" — [Cline blog](https://cline.bot/blog/cline-raises-32m-series-a-and-seed-funding-building-the-open-source-ai-coding-agent-that-enterprises-trust)
- Cline business model: free core, Teams plan at $20/user/month (first 10 seats free), inference passed through at cost with no markup — [Sacra](https://sacra.com/c/cline)
- **Aider**: published "Aider has written 7% of its own code (outdated, now 70%)", i.e. tracks the share of each release written by Aider itself — [aider.chat](https://aider.chat/2024/05/24/self-assembly.html)
- Aider's polyglot benchmark (Dec 2024; 225 hard Exercism exercises in 6 languages) became the de facto way to compare coding models; snapshot Apr 2026: GPT-5 (high) 88.0% — [Steel leaderboard](https://leaderboard.steel.dev/leaderboards/aider/); [capitalandcompute](https://capitalandcompute.net/ai-benchmarks/aider-polyglot/)
- Aider ~46K stars (June 2026); a July 2026 review says releases stalled after v0.86.0 (Aug 2025) — [codemyspec](https://codemyspec.com/blog/aider-review-2026). Unconfirmed against GitHub.
- **Ollama**: first public post was a Show HN on July 20, 2023; its embeddable local API made it a dependency other tools build on — [brevis-research](https://brevis-research.duckdns.org/examples/ollama.html) (aggregator; low confidence)
- Ollama about 174K stars (June 2026); reported $65M Series B led by Theory Ventures, 8.9M monthly users, $88M total funding — [feedbagel](https://feedbagel.com/post/save-what-matters-1783603265); [boorghani](https://rss.boorghani.com/popular-open-source-ai-developer-tool-ollama-raises-65m-grows-to-nearly-9m-users) (single secondary source)
- A health analysis warns Ollama's core developers shrank from 102 to as few as 13: stars are not maintainer health — [GraphScope](https://graphscope.io/blog/tech/2026/04/20/Star-Counts-Lied-Graph-Database-Health-Check)
- **Zed**: open-sourced Jan 2024 (thousands of contributions followed), 1.0 on Apr 29, 2026; free editor, $10/mo Pro needed for hosted models, hosted usage at list price + ~10% — [implicator.ai](https://www.implicator.ai/zed-and-warp-both-ship-ai-coding-they-bet-on-opposite-surfaces-2/); [toolradar](https://toolradar.com/tools/zed/pricing)
- **Warp**: reportedly opened its client under AGPL-3 in 2026 (one source contradicts this); sells agent capacity as metered credits: $20 Build plan (1,500 credits, BYOK), $50/user Business, up to $200 Max — [devtoolpicks](https://devtoolpicks.com/blog/warp-open-source-indie-hackers-2026); [implicator.ai](https://www.implicator.ai/zed-and-warp-both-ship-ai-coding-they-bet-on-opposite-surfaces-2/)

### Inferences
- The biggest single growth event in the category in 2026 was a trust event, not a feature: OpenCode gained when Claude Code's owner restricted third-party access. ox's pitch "use the subscriptions and machines you already have, local-first, open" fits that mood, but only if it does not depend on the very access Anthropic blocked (see section 3).
- The credibility move a solo developer can copy cheaply is Aider's: publish a reproducible benchmark and a "percent of ox written by ox" stat in the README, and update it every release. ox has no public benchmarks yet, which is the biggest trust gap next to notarization.
- Cline's path (marketplace install, then enterprise trust messaging, then teams tier) depends on being inside an editor. ox is a CLI plus Mac app, so its equivalents are Homebrew, an npm one-liner, and a Show HN with a short demo video of the notch island or Studio (the visually distinctive parts).
- Star counts are noisy and partly hype-driven; contributors and release cadence are better signals and worth showing on the site.

### Gaps
- No primary HN thread data (points, comments) for OpenCode, Goose, LM Studio, Zed or Warp launches was retrieved.
- Nothing found on Goose (Block) or LM Studio growth/monetization in this session.
- No breakdown of how much of OpenCode's growth came from HN vs X vs YouTube vs Discord.

## 2. Distribution essentials on macOS and Windows

### Takeaway
For a Mac app distributed outside the App Store, a paid Apple Developer account, Developer ID signing, hardened runtime and notarization are now effectively required, and Homebrew made that a hard rule for casks (casks failing Gatekeeper were scheduled to be disabled on Sept 1, 2026). Sparkle 2 with EdDSA-signed appcasts is the standard auto-updater. On Windows, Azure Artifact (Trusted) Signing at about $9.99/month is the cheap path if the developer is a US/Canada individual; SignPath Foundation is a free OSS option.

### Cited Findings
- Homebrew 5.0.0 announced that casks failing Gatekeeper checks lose support on Sept 1, 2026 and deprecated `--no-quarantine` — [lemmy.4d2.org](https://lemmy.4d2.org/post/1941658/2526816); deprecation warning seen by users ("will be disabled on 2026-09-01") — [CopyQ issue](https://goodfirstissue.org/hluk/CopyQ/issues/3498)
- Homebrew lifecycle is deprecated, then disabled, then removed — [docs.brew.sh](https://docs.brew.sh/Deprecating-Disabling-and-Removing)
- Apple's notary service checks Developer ID-signed software distributed outside the Mac App Store; the ticket can be stapled to the app, disk image or package — [publicspace.net](https://publicspace.net/blog/?p=514)
- CI pipelines submit zip/DMG with `xcrun notarytool`; adding Sparkle can make notarization come back "Invalid" until Sparkle's embedded helpers are signed correctly — [zenn.dev](https://zenn.dev/iseebi/articles/macos_sparkle_spm_ci_notarization_issue)
- Sparkle signs update archives with an EdDSA (ed25519) key; `sign_update` outputs the `edSignature` and length for `appcast.xml`; alongside Developer ID signing and HTTPS — [Sparkle docs PR](https://github.com/sparkle-project/sparkle-project.github.io/pull/232/files); [agentskills release guide](https://agentskills.so/skills/jamesrochabrun-skills-releasing-macos-apps)
- Windows: Azure Artifact Signing (formerly Trusted Signing) costs about $9.99/month; as of Feb 2026 Public Trust is limited to organizations in the US, Canada, EU and UK and individual developers in the US and Canada; identity validation takes a few business days — [Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- SignPath Foundation offers free code signing for OSS projects — [zenn.dev](https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en); a developer reports a $29 Certum certificate as the cheapest paid option (anecdotal) — [forum.hise.audio](https://forum.hise.audio/post/114810)

### Inferences
- Priority for ox: (1) join the Apple Developer Program, (2) sign with Developer ID and hardened runtime, notarize and staple in CI, (3) ship a Homebrew cask (own tap first, then homebrew-cask) and a formula or npm package for the CLI, (4) add Sparkle 2 for the Mac app. Until (2) is done, an unsigned zip triggers Gatekeeper warnings that read as "malware" to new users, and Homebrew's main cask repo will not accept it.
- Keep a one-line install (`brew install --cask ox` / `npm i -g ...` / `curl | sh` with a checksum) on the README's first screen; this is what OpenCode and Ollama lead with.
- For the Windows island build, check SignPath Foundation first (free for OSS); use Azure signing only if the developer qualifies as a US/Canada individual or registers an org.

### Gaps
- The Apple Developer Program fee (widely known as US$99/year) was not confirmed from Apple's page this session — check https://developer.apple.com/support/compare-memberships/ and whether Apple's fee waiver for nonprofits/education applies.
- Did not confirm whether Homebrew actually disabled unsigned casks on Sept 1, 2026 or moved the date.
- SignPath Foundation eligibility terms not retrieved.

## 3. Terms-of-service risk of using consumer subscriptions in third-party agents

### Takeaway
High risk for Claude, low (sanctioned) risk for ChatGPT. Anthropic blocked consumer-plan OAuth for third-party tools server-side in January 2026, wrote the ban into its terms in February 2026 (Free/Pro/Max OAuth tokens are only for Claude Code and Claude.ai, including not for the Agent SDK), and extended enforcement to harnesses like OpenClaw around April 4, 2026. OpenAI went the other way: "Sign in with ChatGPT" officially lets Plus/Pro users spend their plan allowance in partner apps (OpenCode, Warp, Cline and others) with per-app weekly caps. Uncertainty: most Anthropic details are from secondary reporting, and dates differ by a day or two.

### Cited Findings
- Jan 9, 2026: server-side checks blocked subscription OAuth from third-party tools including OpenCode, Cline and RooCode, without advance notice — [zbuild.io](https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026); [paddo.dev](https://paddo.dev/blog/anthropic-walled-garden-crackdown/)
- Feb 19–20, 2026: docs/consumer terms updated; OAuth tokens from Free, Pro and Max are for use exclusively with Claude Code and Claude.ai; using them elsewhere, including the Agent SDK, is a consumer terms violation; Agent SDK developers are directed to API keys via Claude Console or a cloud provider — [GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block); [Let's Data Science](https://letsdatascience.com/news/anthropic-revises-terms-to-bar-third-party-harnesses-b7377cc7)
- Anthropic's Thariq Shihipar reportedly apologized that the documentation update was confusing — [GIGAZINE](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block)
- OpenCode removed its Claude OAuth code citing "Anthropic legal requests" (dated Feb 19 by one source, mid-March PR by another) — [zbuild.io](https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026); [Shareuhack](https://www.shareuhack.com/en/posts/opencode-anthropic-legal-controversy-2026)
- ~Apr 4, 2026: Pro/Max subscription limits can no longer power third-party automation tools such as OpenClaw; one source reports a one-time $200 credit for Max subscribers redeemable until Apr 17, 2026 — [mlq.ai](https://mlq.ai/news/anthropic-ends-paid-access-for-claude-in-third-party-tools-like-openclaw/); [Sovereign Magazine](https://www.sovereignmagazine.com/article/anthropic-blocks-openclaw-claude-subscriptions)
- Accounts that used OAuth tokens in third-party tools may have been flagged; consumer terms allow suspension without notice for material breach — [Autonomee](https://autonomee.ai/blog/claude-code-account-suspended-banned-safe-usage/)
- Uncorroborated: a May 13, 2026 partial reversal creating "Agent SDK credits" metered at API prices for programmatic use outside Claude Code — [falcao.org](https://falcao.org/posts/anthropic-claude-access-crackdown-ecosystem-fallout/) (single source; verify)
- Some projects (Moltis, Vexa) publicly document why they do not support Anthropic OAuth — [Moltis docs](https://docs.moltis.org/anthropic-oauth.html); [Vexa docs](https://docs.vexa.ai/model-credentials-licensing)
- OpenAI "Sign in with ChatGPT": 16 launch partners including OpenCode, OpenClaw, Pi, Amp, Warp and Devin; Plus and Pro usage; users set weekly caps per app; usage stops at the cap rather than switching to the app's billing; identity sign-in and plan usage are separate permissions and neither grants access to ChatGPT conversations — [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/); [developersdigest](https://www.developersdigest.tech/blog/sign-in-with-chatgpt-coding-agents-plan-usage-2026)
- Codex itself supports Sign in with ChatGPT (subscription) or API key — [OpenAI Codex docs](https://developers.openai.com/codex/auth); Cline's OpenAI Codex provider uses the ChatGPT subscription with no per-token billing — [Cline docs](https://docs.cline.bot/provider-config/openai-codex)

### Inferences
- The defensible design for ox: drive the user's own official CLIs (Claude Code, Codex, Cursor's agent) as subprocesses on the user's machine, rather than extracting or reusing their OAuth tokens in ox's own HTTP client. Driving the official `claude` binary is closer to "use with Claude Code", but whether automated/orchestrated use of Claude Code by another tool counts as "third-party harness" use is unclear — the OpenClaw enforcement suggests Anthropic looks at programmatic, subscription-funded automation. Treat this as a legal grey zone; state it plainly in ox's docs and offer API-key mode as the default for Claude.
- For ChatGPT, applying to be a "Sign in with ChatGPT" partner (or using the Codex CLI's own login) is the sanctioned route and a trust signal worth stating on the site.
- Marketing "use your Claude Max subscription in ox" is risky: it invites a takedown request like OpenCode got, and can get users' accounts flagged.

### Gaps
- Anthropic's actual consumer terms text and any Anthropic blog post were not fetched; exact wording of the "Authentication and credential use" section unverified.
- No source on Cursor's terms for using a Cursor subscription through other tools.
- Unclear whether OpenAI's partner program is open to small OSS projects or requires an application.

## 4. Local AI on Apple Silicon (16–24GB Macs), 2026

### Takeaway
On a 24GB Mac, a ~27–30B Qwen model at 4-bit (about 18–22GB) is the ceiling for local coding and leaves little headroom; on 16GB, expect only small models (roughly 7–14B class) for completion, routing, summarizing, commit messages. Local speech is fully practical: Parakeet (Core ML or MLX) transcribes short clips in well under a second, faster than Whisper large-v3-turbo. Local image gen (SD-Turbo, small FLUX variants) is practical; local video is technically possible with MLX ports of Wan 2.2 5B / LTX-2 distilled but slow and memory-bound, so it is a "demo" feature, not a daily one.

### Cited Findings
- Coding LLMs: Qwen3-Coder-30B-A3B MLX 4-bit named the best MLX coding model; all MoE experts must sit in memory, budget ~22GB for the model alone — [bestllmfor.com](https://bestllmfor.com/guides/mlx-local-llm-apple-silicon/)
- Qwen3.6 27B called the best local coding model of 2026 for a 24GB GPU / 32GB Mac; ~18GB in Ollama — [whatllm.org](https://whatllm.org/best-local-llm-for-coding); [promptquorum](https://www.promptquorum.com/power-local-llm/best-local-coding-models-2026)
- Qwen3-Coder 30B ~19GB at Ollama Q4 as the 24GB sweet spot — [willitrunai](https://willitrunai.com/best-local-llm-for/m4-air-24gb)
- Qwen3-Coder-Next ~52GB at Q4_K_M, the r/LocalLLaMA consensus pick but only for 64GB Macs (secondhand claim) — [Kilo blog](https://blog.kilo.ai/p/the-best-local-coding-models-for)
- Speech: on an M4, a short clip took 0.19s with FluidAudio Core ML Parakeet, 0.50s with parakeet-mlx, 1.02s with mlx-whisper large-v3-turbo, 1.23s with whisper.cpp Core ML (single clip, Aug 2025 benchmark) — [Towards AI](https://pub.towardsai.net/parakeet-vs-whisper-for-local-dictation-speed-accuracy-and-vocabulary-in-2026-f809fcc4271c)
- Parakeet V3 covers 25 languages; Whisper covers 99 and handles accents/vocabulary better — [Spokenly](https://spokenly.app/blog/parakeet-vs-whisper)
- mlx-whisper defaults to whisper-tiny; pass `mlx-community/whisper-large-v3-turbo` explicitly — [skills.sh mlx-whisper](https://skills.sh/moltbot/skills/mlx-whisper)
- Argmax's Swift toolkit (WhisperKit) is another native option — [Superwhisper board](https://superwhisper.userjot.com/board/p/mlx-acceleration-for-local-parakeet-models)
- Video: an MLX package supports Wan 2.1, Wan 2.2 (T2V-14B, TI2V-5B, I2V-14B) and LTX-2 (distilled only) on Mac — [mlx-video mirror](https://git.ddq.nl/n0p/mlx-video/src/commit/dbab95ec4527432a34d80182c0eedf4e09729c81)
- Wan 2.2 TI2V-5B ~8GB, 14B ~11–16GB at GGUF Q5, 1.3B ~4–6GB; LTX-2 official min ~32GB for 720p full quality, FP8 brings it to 12–24GB — [InsiderLLM](https://insiderllm.com/guides/local-ai-video-generation/); [Evetech](https://evezone.evetech.co.za/quick-bytes/vram-needed-for-local-ai-video-generation-wan-2-2-and-ltx-2)
- On an M1 Max 64GB, GGUF Wan 2.2 took ~82 minutes per 2-second clip, and LTX-2 FP8 failed on Metal — [lilting.ch](https://lilting.ch/en/articles/ltx2-wan22-mac-local-video-gen)

### Inferences
- For ox's notch voice assistant, Parakeet via Core ML/MLX is the right default (sub-second, ~0.6GB class model), with Whisper large-v3-turbo as a multilingual fallback.
- For local coding on 16–24GB Macs, local models are best positioned as a "free tier" for cheap sub-tasks (summaries, commit messages, routing, autocomplete) and as an offline fallback, not as a replacement for frontier subscriptions. Recommending Qwen3-Coder-30B-A3B on a 24GB machine is borderline; show a RAM check before download.
- With limited disk, ox should download models on demand, show sizes up front, and let users delete them. Studio video should default to Wan 2.2 TI2V-5B or LTX distilled at low resolution/short length with a clear time estimate, or route video to a cloud model.

### Gaps
- No 2026 M4/M5 timing data for FLUX.1-schnell / SD-Turbo / Draw Things was found; Draw Things' current model support not verified.
- No llama.cpp vs MLX tokens/sec comparison for 16GB Macs retrieved.
- No independent 2026 Parakeet vs Whisper benchmark (sources are mostly dictation-app vendors).

## 5. Monetization of comparable open-source agents

### Takeaway
The common pattern is a free, open core plus one of: a teams/enterprise seat tier (Cline $20/user), a hosted-model tier with a small markup or pro subscription (Zed $10/mo, list +10%), metered agent credits (Warp $20–$200), or a hosted gateway subscription (OpenCode Black). Large outcomes were VC-funded (Cline $32M, Ollama reported $65M Series B). Aider shows the "no monetization" path, and its activity appears to have stalled.

### Cited Findings
- Cline: free core, Teams $20/user/mo with first 10 seats free, inference at cost — [Sacra](https://sacra.com/c/cline)
- Zed: free editor, Pro $10/mo for hosted models, usage billed at list + ~10% — [toolradar](https://toolradar.com/tools/zed/pricing); [implicator.ai](https://www.implicator.ai/zed-and-warp-both-ship-ai-coding-they-bet-on-opposite-surfaces-2/)
- Warp: credit-metered plans ($20 Build with BYOK, $50/user Business, $200 Max) — [devtoolpicks](https://devtoolpicks.com/blog/warp-open-source-indie-hackers-2026)
- OpenCode: paid "Black" plan via enterprise API gateway; expected ~$25M annual revenue — [zbuild.io](https://www.zbuild.io/resources/news/opencode-blocked-anthropic-2026); [Let's Data Science](https://letsdatascience.com/news/opencode-reaches-eight-million-monthly-users-in-one-year-51652538)
- Ollama: reported $65M Series B, $88M total — [feedbagel](https://feedbagel.com/post/save-what-matters-1783603265)
- Aider: free, no paid tier; release cadence reportedly stalled since Aug 2025 — [codemyspec](https://codemyspec.com/blog/aider-review-2026)

### Inferences
- For a solo developer, the lowest-friction options are GitHub Sponsors plus an optional paid "ox Pro" for convenience features that cost money to run (cloud sync across the mesh, hosted Studio video, a team org/dashboard), keeping the local agent fully free. A gateway subscription like OpenCode Black needs capital and provider agreements.
- Monetization should not depend on reselling consumer subscriptions (section 3).

### Gaps
- No data on revenue for Goose (Block; non-commercial), LM Studio's business pricing, or Aider sponsorship income.
