# What users want from AI desktop, voice, notch and phone-companion assistants (2025 to Oct 2026)

Note on method: web search and fetch, plus GitHub issue data pulled with `gh api` (search sorted by reactions) on 2026-10-20. Reaction counts are a snapshot taken on that date. Many of the review and statistics sites are vendor blogs or affiliate pages, and each is flagged where it is used.

## 1. Survey and usage data on voice and AI desktop assistants (ChatGPT, Claude, Siri/Apple Intelligence, Copilot)

### Takeaway
Text and writing help is the most-used AI use; voice assistant features are used much less. Apple Intelligence adoption was weak. The only features with real uptake were small, specific and low-friction (Photos Clean Up, photo search, Writing Tools, notification summaries). Showy generative features (Genmoji, Image Playground, Image Wand) and "smarter Siri" were barely used. I found no reliable desktop-only usage data for ChatGPT desktop, Claude desktop, Raycast AI or Copilot on Windows.

### Cited Findings
- TidBITS reader survey, June 2025 (n=760, self-selected Apple enthusiasts). Share reporting "some or major impact" for each Apple Intelligence feature: Clean Up in Photos 25.8%, descriptive Photos search 23.9%, ChatGPT in Siri 16.2%, Writing Tools 15.8%, Mail message summaries 15.6%, Notification Summaries 14.7%, Priority Notifications 10.5%, Smart Replies 9.7%, Genmoji 9.1%, Image Playground 8.8%, "richer language understanding in Siri" 8.4%, Notes transcript summaries 5.3%, Image Wand 1.6%. Half of all features had impact for fewer than 10% of respondents. — [TidBITS](https://tidbits.com/2025/06/20/do-you-use-it-apple-intelligence-sees-weak-adoption/)
- SellCell survey (Dec 2024, just before iOS 18.2): 73% of iPhone users with Apple Intelligence said it added little or no value (64.7% "not very valuable"; 11.1% agreed it adds significant value). Among people who had used it, Writing Tools was used by 72%, notification summaries 54%, priority messages 44.5%, Clean Up 29.1% and Smart Reply 20.9%. — [9to5Mac](https://9to5mac.com/2024/12/16/most-iphone-owners-see-little-to-no-value-in-apple-intelligence-so-far/)
- OpenAI/NBER "How People Use ChatGPT" (Working Paper 34255, 2025): Practical Guidance, Seeking Information and Writing make up about 77–80% of conversations. Non-work use rose from 53% (June 2024) to 73% (June 2025). Coding is about 4.2% of messages. About two-thirds of writing requests change existing text (edit, summarise, translate) rather than create new text. — [NBER](https://www.nber.org/papers/w34255); secondary figures from [TechSpot](https://techspot.com/news/109483-openai-reveals-how-people-really-use-chatgpt-personal.html) (sample size is reported inconsistently as 1M vs 1.5M conversations)
- ChatGPT scale: reported as about 800–900M weekly users in late 2025 and early 2026. These figures come from aggregator blogs and were not checked against an OpenAI primary source. — [WiserNotify](https://wisernotify.com/blog/chatgpt-users/)
- US voice assistant users in 2025 (eMarketer forecast, via secondary sites): Google Assistant about 91.9M, Siri about 86.5M, Alexa about 77.2M. Total US voice assistant users are forecast at about 154M in 2026. — [eMarketer Siri topic page](https://www.emarketer.com/topics/category/siri/2); [SQ Magazine](https://sqmagazine.co.uk/voice-search-statistics/)
- Demand from developers for desktop AI apps, shown by GitHub reactions. In openai/codex, the top-reacted issues are "Codex desktop app for Linux" (1,464 reactions), "Remote Development in Codex Desktop App" (878), "Event Hooks" (688) and "Codex Remote Control" (544). In anthropics/claude-code: "multiple Claude accounts within Claude Desktop" (1,147) and "Official Claude Desktop build for Linux" (655). — [openai/codex#11023](https://github.com/openai/codex/issues/11023), [#10450](https://github.com/openai/codex/issues/10450), [#2109](https://github.com/openai/codex/issues/2109), [#9224](https://github.com/openai/codex/issues/9224); [anthropics/claude-code#18435](https://github.com/anthropics/claude-code/issues/18435), [#65697](https://github.com/anthropics/claude-code/issues/65697)
- Usage limits are a top pain point. "Instantly hitting usage limits with Max subscription" has 726 reactions (claude-code#16157). A Codex issue about the rate-limit cost per token jumping 10–20x has 561. — [claude-code#16157](https://github.com/anthropics/claude-code/issues/16157); [codex#28879](https://github.com/openai/codex/issues/28879)
- Personality and companionship. "Bring Back Buddy" (the /buddy ASCII companion removed in Claude Code v2.1.97, April 2026) has 2,115 reactions and 281 comments. It is the third most-reacted issue in the whole claude-code repo. It merges requests to make the companion customisable, available in VS Code, and "smarter". — [anthropics/claude-code#45596](https://github.com/anthropics/claude-code/issues/45596)

### Inferences
- Apple's data suggests a notch assistant will be valued for small, frequent, reliable actions (summaries, approvals, quick rewrites, status), not for novelty generation. "Writing Tools"-style rewrite-in-place and notification triage are the proven daily habits.
- Two developer pain points map directly onto ox Island's planned **usage meter widget**: usage limits (726 + 561 reactions) and multi-account switching (1,147). The meter is well supported.
- The 2,115-reaction "Bring Back Buddy" issue is strong, unusual evidence that developers want a companion personality in their agent tools. This supports keeping the talking buddy as a differentiator, ideally customisable.
- Remote control and phone control of coding agents is a top-10 request in Codex (544 reactions). This supports the iPhone companion.

### Gaps
- No primary-source daily or weekly usage figures for the ChatGPT desktop app, Claude desktop, Raycast AI, or Copilot on Windows. Searches returned only aggregate ChatGPT numbers.
- No representative (non-enthusiast) 2025–2026 Apple Intelligence usage survey was found. I could not verify a Creative Strategies 2025 survey.
- No figures found for Apple Intelligence usage after the 2026 Siri revamp.

## 2. Dictation tools (Wispr Flow, Superwhisper, MacWhisper, Aqua, open-source): features and complaints

### Takeaway
Dictation is a fast-growing, well-funded category. Wispr Flow reached a $2B valuation in Aug 2026 and reports that retained users produce more than half their typed characters by voice. The main complaints are privacy (cloud-only processing, screenshots for "context"), resource use, and reliability. Open-source requests centre on local models, system-audio capture (for meetings), custom push-to-talk keys, and mobile.

### Cited Findings
- Wispr raised a $280M Series B at a $2B valuation (Aug 2026, led by Menlo), bringing the total raised to $361M. The company reports 100x year-on-year user growth and 70% 12-month retention (self-reported, methodology not given). — [UC Today](https://www.uctoday.com/?p=748171); [VKTR](https://www.vktr.com/ai-platforms/wispr-hits-2b-valuation-launches-canto-voice-model/)
- Wispr says users generate more than half their typed characters by voice after three months. A separate summary reports about 80% 6-month retention and about 19% paid conversion (July 2024–July 2025). — [Sacra](https://sacra.com/c/wispr); [Wikipedia](https://en.wikipedia.org/wiki/Wispr_Flow)
- Wispr Flow complaints: screenshots of the active window are taken for "context" and many users find this intrusive; it adds itself to startup and makes background network calls; it is cloud-only with no offline mode; it uses about 800MB RAM and about 8% CPU while idle on older Macs; the Windows build is worse than Mac; Trustpilot rating 2.7/5 (39 reviews); free tier capped at 2,000 words/week; $15/month. Some of these come from a competitor's review site (Voibe). — [Voibe review](https://www.getvoibe.com/resources/wispr-flow-review/); [Trustpilot](https://no.trustpilot.com/review/wisprflow.ai); [Laxis](https://laxis.com/blog/wispr-flow/)
- Wispr Flow's feature set includes a "personal dictionary", snippets, AI auto-edits and 100+ languages. A custom dictionary is now a baseline feature in the category. — [Creator Economy Tools](https://creatoreconomytools.com/tool/wispr-flow)
- Superwhisper's selling point is private on-device dictation, but only some of its models run offline. Competitors criticise its setup as complex. Pricing is about $8.49/month or $249.99 lifetime. MacWhisper is mainly a file-transcription tool rather than a live dictation tool. — [BuildBetter](https://blog.buildbetter.ai/best-superwhisper-alternatives-in-2026-top-local-ai-dictation-tools-for-mac/); [tl;dv](https://tldv.io/blog/superwhisper-review/) (both are competitors)
- VoiceInk (open-source Mac dictation, about 6.9k stars). Top-reacted issues: system-audio capture (16 and 14 reactions across two issues), Mobile/iOS (14), Apple Foundation Model for cleanup (13), new local models such as Parakeet and Voxtral (7–11 each), speaker diarisation (10), a CLI or agent-callable transcription command (10), custom push-to-talk shortcut (7). — [VoiceInk issues](https://github.com/Beingpax/VoiceInk/issues/31), [#117](https://github.com/Beingpax/VoiceInk/issues/117), [#333](https://github.com/Beingpax/VoiceInk/issues/333), [#801](https://github.com/Beingpax/VoiceInk/issues/801)
- Handy (open-source cross-platform dictation, about 34.2k stars, which suggests strong demand for free, local dictation). Its top issues are about reliability: missing first character on paste (28), shortcut failures (13), and a roughly 500ms mic start-up delay that cuts off speech (7). — [cjpais/Handy](https://github.com/cjpais/Handy/issues/429), [#1283](https://github.com/cjpais/Handy/issues/1283)

### Inferences
- ox's hold-to-talk dictation competes in a validated, high-retention category. The **personal dictation dictionary** is now expected rather than a differentiator, and should be prioritised. Offline and local processing is the clearest wedge against Wispr's privacy complaints. ox already uses offline Kokoro TTS, so offline STT would match that positioning.
- Users notice latency and dropped first words at once (Handy #1283). Pre-warming the mic and fast paste matter more than extra features.
- Open-source users ask for system-audio capture and diarisation inside dictation apps. This shows dictation and meeting notes converging: the same engine can power **meeting/call notes**.

### Gaps
- Could not access r/macapps threads directly. No Aqua Voice review data was found.
- No independent accuracy benchmarks across Wispr, Superwhisper and Aqua.

## 3. Notch apps (Boring Notch, NotchNook, Alcove, Vibe Notch/Claude Island)

### Takeaway
Notch apps have real demand: Boring Notch has 11.1k stars. The most-reacted issues are about polish and staying out of the way (Now Playing breaking, animation annoyances, disabling on fullscreen and external displays), not about new widgets. Among feature requests, notifications, a pomodoro timer, an AI assistant and a teleprompter lead. For coding-agent notch apps, users ask for sound alerts when the agent needs input, and for less intrusive or menu-bar placement.

### Cited Findings
- Boring Notch (TheBoredTeam/boring.notch): 11,086 stars, 1,124 forks, 405 open issues (Oct 2026). Top issues by reactions: "Now Playing no longer working after macOS 15.4" (54); four separate requests to disable the "wobbly" open/close animation (26, 21, 21, 16); "Disable Notch UI in fullscreen and on external displays" (14) plus "Disable for external displays" (8); "[FEATURE] Notifications" (13, open); stuttering when opening (12); pomodoro timer (10); Liquid Glass (10); "boring.notch AI" assistant (9); Teleprompter (8); Apple Music broken on macOS 26 (8); permanently visible sneak peek (7). — [boring.notch#417](https://github.com/TheBoredTeam/boring.notch/issues/417), [#364](https://github.com/TheBoredTeam/boring.notch/issues/364), [#119](https://github.com/TheBoredTeam/boring.notch/issues/119), [#592](https://github.com/TheBoredTeam/boring.notch/issues/592), [#950](https://github.com/TheBoredTeam/boring.notch/issues/950), [#1104](https://github.com/TheBoredTeam/boring.notch/issues/1104), [#351](https://github.com/TheBoredTeam/boring.notch/issues/351)
- The boring.notch AI request (#1104, March 2026) asks for an in-notch assistant with a choice of ChatGPT or Claude, and notes that rival island apps already have one. — [boring.notch#1104](https://github.com/TheBoredTeam/boring.notch/issues/1104)
- The Boring Notch roadmap, as reported by a secondary source, includes reminders integration, a mirror for video calls, custom gestures, lock-screen widgets, weather and an extension system. Recent releases added a compact media player and notification mirroring. — [Korben](https://korben.info/en/boring-notch-macbook-notch-finally-useful.html); [release notes](https://newreleases.io/project/github/TheBoredTeam/boring.notch/release/v2.8-rc.0)
- Competitors: NotchNook costs about $25 one-time or $3/month. Alcove offers live activities, swipe gestures, custom HUDs and a lock-screen presence, and is seen as more polished than Boring Notch. — [Korben](https://korben.info/en/boring-notch-macbook-notch-finally-useful.html); [Peerlist](https://peerlist.io/theboringteam/project/boringnotch)
- Vibe Notch (formerly Claude Island): 2,527 stars and 357 forks. It is a notch UI for Claude Code that shows approve/deny buttons when a tool needs permission, through hooks. The last push was Apr 2026, so it may be stalled, and forks such as "Vibe Hub" and "CodeIsland" have appeared. Top issues: notification sound wrongly triggered by subagents (4); package the hooks as a plugin so users don't edit .claude (4); UI too large and overlays content (3); option to move the UI to the menu bar instead of the island (3); "Notification when Claude has finished work" (2); "Sound notifications when Claude needs user action" (2); support for opencode CLI and for remote SSH sessions. — [Homebrew cask](https://formulae.brew.sh/cask/vibe-notch); [vibe-notch#7](https://github.com/farouqaldori/vibe-notch/issues/7), [#41](https://github.com/farouqaldori/vibe-notch/issues/41), [#58](https://github.com/farouqaldori/vibe-notch/issues/58), [#50](https://github.com/farouqaldori/vibe-notch/issues/50), [#66](https://github.com/farouqaldori/vibe-notch/issues/66)
- A commercial rival, Vibe Island, covers Claude Code, Codex, Gemini CLI and Cursor in the notch, with a paid trial model. — [vibeisland.app](https://vibeisland.app/claude-code/)

### Inferences
- The most valuable "feature" for a notch app is reliability and restraint: no annoying animations, auto-hide in fullscreen and on external monitors, and Now Playing that survives macOS updates. ox Island should have these settings from day one.
- **Now-playing** is the most-used notch widget (the most-reacted issue is about it breaking). It is cheap to add and highly visible. **Reminders**, timers and notifications are the next most-requested.
- A multi-agent status view with approvals is already validated by Vibe Notch (2.5k stars) and Vibe Island. ox's edge is breadth (all agents plus voice plus phone). Things to copy from Vibe Notch's issue list: correct alert sounds (no false alerts from subagents), one-step hook install, and remote and SSH session support.
- **Draw-on-screen**, **service cards (Stripe/Vercel/GitHub)** and an **inbox card** got no direct reactions in these trackers. Their demand is unproven here.

### Gaps
- NotchNook and Alcove are closed source and have no public issue trackers. Product Hunt and App Store reviews were not retrieved.
- No usage telemetry exists showing which notch widgets people keep enabled.

## 4. Meeting notes tools: demand for bot-less, local meeting notes

### Takeaway
Bot-free capture on the user's own device is the winning design in meeting notes. Granola, the leading bot-free notetaker, went from a $250M valuation (May 2025) to $1.5B (March 2026), and the bot-free approach is widely named as the reason.

### Cited Findings
- Granola raised a $125M Series C at a $1.5B valuation (25 March 2026, led by Index Ventures, with Kleiner Perkins). The prior round was a $43M Series B at $250M (May 2025). Total raised is about $192M. It records audio on the user's device without a visible bot; it transcribes in real time and does not keep the audio. — [TNW](https://thenextweb.com/news/granola-series-c-meeting-ai-enterprise-context); [Reworked](https://www.reworked.co/digital-workplace/granola-raises-125m-launches-enterprise-context-tools/); [Sifted](https://sifted.eu/articles/ai-notetaking-startup-granola-hits-unicorn-status)
- Revenue reportedly grew 250% in the quarter before the raise, and weekly retention is cited as 70%+. Both come from a single secondary source and are unverified. — [Entrepreneur Loop](https://entrepreneurloop.com/granola-ai-meeting-notes-unicorn-series-c-2026/)
- Reviewers say the bot-free approach drove early uptake among VCs. They also note it still raises consent and disclosure questions. — [SkillScouter](https://skillscouter.com/granola-review/); [Medium review](https://medium.com/@trelvek/granola-review-2026-a-limitations-first-look-at-ai-meeting-notes-0bcd97d68bc4)
- Dictation users are asking for system-audio capture and diarisation (VoiceInk #31, #199, #529), which is meeting-note capability. — [VoiceInk#31](https://github.com/Beingpax/VoiceInk/issues/31)

### Inferences
- **Meeting/call notes** with local capture and no bot is a strongly validated demand. ox already has local STT/TTS and a notes "brain", so a fully local, Granola-style notes feature would combine the privacy wedge with a proven category. The main risk is crowding: Granola, Otter and the built-in notes in Zoom, Meet and Teams.

### Gaps
- No Otter 2025–2026 usage or complaint data was collected. No survey quantifies the share of users who dislike meeting bots.

## 5. Wake words and always-listening: acceptance vs privacy

### Takeaway
Concern about always-listening devices is persistent but moderate. About a third to a half of voice-assistant users report privacy concerns, and about half don't realise devices listen for wake words. No strong 2025–2026 survey was found. Evidence is thin and mostly dated, which suggests a wake word should be opt-in, on-device, and visibly indicated.

### Cited Findings
- A 2024 survey of more than 1,000 Americans: 31% have privacy concerns when using voice assistants, and 49% did not know assistants continuously listen for wake words. — [Secure Data Recovery](https://www.securedatarecovery.com/blog/smart-device-privacy-concerns)
- Hub research: 53% of regular users wonder about privacy while using voice assistants, down from 59% in 2019 (undated, secondary). — [ETCentric](https://www.etcentric.org/new-reports-reveal-unsettling-facts-about-voice-assistants/)
- Microsoft (2019): 41% worried their assistant was actively listening or recording. — [Connected World](https://connectedworld.com/?p=6338)
- Academic study (IMWUT 2019, n=178): users will share conversations with always-listening assistants when the content isn't sensitive and they see a benefit. — [Chalmers research](https://research.chalmers.se/en/publication/520811)
- Wispr Flow faced backlash over context screenshots and background network activity, which shows that ambient capture by desktop assistants is a live trust issue in 2025–2026. — [Voibe review](https://www.getvoibe.com/resources/wispr-flow-review/)

### Inferences
- Hold-to-talk (ox's current model) avoids the privacy risk entirely. If a **wake word** is added, it should be off by default, processed fully on-device, and shown with a clear mic indicator. Demand evidence is weaker than for the dictionary, meeting notes or approvals, so it is lower priority.

### Gaps
- No 2025–2026 quantitative survey on always-listening acceptance for desktop or laptop assistants specifically. No usage data on desktop wake words (for example "Hey Siri" on Mac).

## 6. Mobile agent companions: notifications, approvals, Live Activities

### Takeaway
Phone control and approval of coding agents is a clear, high-signal demand. Codex "Remote Control" drew 544 reactions before it shipped, and Anthropic shipped Remote Control with push notifications for Claude Code. Live Activity and Lock Screen approval is offered only by third-party apps, so it remains an open gap.

### Cited Findings
- Codex issue "Codex Remote Control" (Jan 2026): 544 reactions, 59 comments, now closed. The requester was using Tailscale plus an SSH client and wanted a proper mobile UI. — [openai/codex#9224](https://github.com/openai/codex/issues/9224)
- Claude Code Remote Control (official): control a local session from the Claude app's Code tab, with push notifications "when a long-running task finishes or when it needs a decision from you". There is no standalone mobile app and no Live Activity. — [Claude Code docs: mobile](https://code.claude.com/docs/en/mobile)
- Reliability problems: "Push notifications broken – mobile devices not receiving notifications" (claude-code#60208, May 2026, closed). — [anthropics/claude-code#60208](https://github.com/anthropics/claude-code/issues/60208)
- Third-party apps: Codync puts Claude Code session monitoring in Live Activities (Dynamic Island and Lock Screen) and on Apple Watch, but only monitors. Forge Remote controls Claude Code, Aider and Codex CLI, with push-for-permission and one-tap approve. — [Codync on hunted.space](https://hunted.space/product/codync); [Forge Remote, App Store](https://apps.apple.com/dk/app/forge-remote/id6760141378)
- Multi-account switching in the Claude mobile app has 1,054 reactions. — [anthropics/claude-code#36151](https://github.com/anthropics/claude-code/issues/36151)
- Mobile versions are among the top requests for dictation apps too (VoiceInk Mobile/iOS, 14 reactions; Handy Android, 7). — [VoiceInk#117](https://github.com/Beingpax/VoiceInk/issues/117); [Handy#171](https://github.com/cjpais/Handy/issues/171)

### Inferences
- ox's iPhone approvals companion matches a validated need. Because official tools now offer push and remote control, ox's differentiators are covering several agents (Claude, Codex and others) and **lock-screen Live Activity approvals**, which neither Anthropic nor OpenAI officially offer. Live Activity approvals look like the highest-leverage mobile item.
- Notification reliability is a known failure point in the official app, so delivery guarantees (and a fallback) are worth investing in.

### Gaps
- No survey data quantifies how often developers approve agent actions from the phone. No download figures for Codync or Forge Remote.
- No demand evidence was found for phone-side email drafting or a Slack integration.

---
### Cross-cutting roadmap signals for ox Island (inferences, ranked by strength of evidence)
1. **Strong:** a usage meter (limit pain: 726 + 561 reactions), Live Activity and lock-screen approvals (Codex Remote Control 544; official gap), the personal dictation dictionary (table stakes in the category), local bot-free meeting notes (Granola valued at $1.5B), keeping and expanding the buddy personality (2,115 reactions), and notch polish settings (fullscreen and external-display hide, toggleable animation).
2. **Medium:** now-playing (most-used notch widget, though fragile across macOS updates), notifications in the island, Reminders and timer, and sound alerts that fire only when an agent needs input.
3. **Weak or unproven in this evidence:** wake word (privacy-sensitive, little demand data), draw-on-screen, service cards (Stripe/Vercel/GitHub), inbox card and voice email send, and Slack.
