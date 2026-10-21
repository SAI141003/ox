# Creative Studio Demand: What Users Want from AI Image, Video and Audio Tools (2025–Oct 2026)

Scope note: research done 2026-10-20 with about 15 search/fetch calls. The strongest quantitative sources are a16z's Top 100 (6th ed., Mar 2026) and Adobe's Creators' Toolkit survey (Sept 2025, n=16,000+). Much of the product-complaint material comes from review blogs and vendors, so treat it as directional. Search did not surface Reddit threads directly; findings attributed to "community" come from secondary write-ups.

## 1. Usage and market data: what people make, and who makes it

### Takeaway
Most creators now use creative AI: 86% of 16k surveyed. The most common job is **improving existing media** (editing, upscaling, enhancement: 55%), slightly ahead of generating new images and video (52%). Standalone image generators are losing traffic to bundled models in ChatGPT and Gemini. Video is the fastest-moving category, and voice/music remain defensible niches. Mass use runs through all-in-one editors (CapCut at 736M MAU), not single-purpose generators.

### Cited Findings
- 86% of creators actively use creative generative AI. Top uses: editing, upscaling and enhancement (55%); generating new images and video (52%); ideation and brainstorming (48%). 60% used more than one AI tool in the past 3 months. Sample: 16,000+ creators in 8 countries, Sept 2025, Adobe + Harris Poll, mostly Gen Z/Millennial emerging and semi-pro creators. Adobe sells these tools, and the figures are self-reported. — [Adobe MAX 2025 Creators' Toolkit press release](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey); [report PDF](https://news.adobe.com/news/downloads/pdfs/2025/10/10282025-inauguraladobecreatorstoolkitreport.pdf)
- Adoption barriers: **high cost (38%)**, **unreliable output quality (34%)**, uncertainty about how models were trained (28%). 69% worry their own content will be used to train AI without permission. — [Adobe](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)
- 76% say AI grew their business or following; 81% say it lets them make content they otherwise couldn't. 85% would consider an AI agent that learns their creative style. Desired agent uses: automating repetitive tasks (51%), brainstorming (50%), performance insights (44%). Creators want a human-in-the-loop setup and to keep creative control. — [Adobe](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)
- 72% of creators frequently create on mobile, and 75% expect to make more mobile content next year. — [Adobe](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)
- India: 99% use creative AI; 77% use it for editing/upscaling and 75% to generate images and video. — [Impact on Net summary of Adobe India report](https://www.impactonnet.com/more-from-impact/adobe-report-finds-97-of-indian-creators-say-generative-ai-boosts-creator-economy-13204.html)
- a16z Top 100, 6th ed. (Mar 9, 2026; SimilarWeb and Sensor Tower data as of Jan 2026):
  - In edition 1, 7 of 9 creative tools on the web list were image generators; **only 3 remain**. a16z attributes this to native image models in ChatGPT (GPT Image 1.5) and Gemini (Nano Banana).
  - **Midjourney fell from the top 10 to #46.**
  - Nano Banana generated 200M images and brought 10M new Gemini users in its first week.
  - Video had the most movement: Kling, Hailuo and Pixverse gained real traction, Chinese models lead on quality, and Veo 3 was the first US model to close the gap. The Sora app spiked and then declined, though it still has about 3M mobile DAU.
  - **CapCut has 736M mobile MAU**, driven by AI background removal, AI effects, auto-captions and text-to-video.
  - Suno held #15. ElevenLabs has appeared in every edition; a16z says voice cloning and dubbing are "specialized enough" not to be commoditized.
  - Other creative entries: Canva, Civitai, Cutout, Freepik, Higgsfield, Photoroom, Pixelcut, Remove.bg, SeaArt, Veed, Picsart, Remini, Lightroom.
  - Krea, Pika and Runway are not on the list.
  - Source: [a16z Top 100 Gen AI Consumer Apps, 6th ed.](https://a16z.com/100-gen-ai-apps-6/)
- ChatGPT's upgraded image generation (Mar 25, 2025): 130M+ users made 700M+ images in the first week, driven by the Ghibli-style trend. Altman said GPUs were "melting", and rate limits followed. — [TechCrunch via The Decoder](https://the-decoder.com/chatgpts-image-generation-explodes-with-700m-creations-in-first-week/); [Wikipedia: GPT Image](https://en.wikipedia.org/wiki/GPT_Image)
- Faceless short-form, script-to-video tools are crowded: GhostShorts, ShortsFaceless, Fliki, Pictory and HeyGen all offer script → images → voiceover → subtitles pipelines. — [Capterra GhostShorts](https://www.capterra.com/p/10038895/GhostShorts/); [Fliki](https://fliki.ai/features/ai-youtube-shorts-generator); [HeyGen](https://www.heygen.com/en-ca/tool/faceless-video)
- Platform risk for template-made shorts: YouTube renamed its "repetitious content" policy to "inauthentic content" in July 2025 and tightened enforcement. A vendor blog claims a January 2026 enforcement wave removed thousands of channels; this is unverified against YouTube's own docs. — [Pictory blog](https://pictory.ai/blog/faceless-youtube-channel-ai)

### Inferences
- "Make my existing thing better" is the largest job. That means upscale, cut-out, enhance, captions and edit, and it is also what local models do well on 16 GB. ox's upscale, cut-out (Apple Vision) and ffmpeg/whisper captioning sit squarely on that 55% use case.
- Pure text-to-image as a destination is commoditized by ChatGPT and Gemini. Being free and private won't win on image quality versus GPT Image or Nano Banana. It has to win on workflow: in place, batch, no account, inside the dev's tool.
- Script-to-scenes (Flick-style) competes in a crowded faceless-video market under platform-policy risk. It is better positioned as "explainer / demo / docs video" than as content-farm shorts.

### Gaps
- No reliable 2025–26 data on thumbnail or auto-caption usage share. The search returned only vendor pages, including an unverifiable claim that thumbnails lift CTR 25–40% ([fueler.io](https://fueler.io/blog/ai-thumbnail-generators-youtube-creators-use)).
- No independent market-size figures for AI video or faceless-video tools.
- No split of users by persona (creator vs marketer vs developer) beyond Adobe's creator-only sample.

## 2. Most-requested features and top complaints by tool

### Takeaway
The dominant complaints across cloud tools are **cost and credit burn**, especially credits charged on failed generations; **billing and cancellation friction**; and **character consistency / control**. Quality is broadly accepted as good, but value-for-money is questioned.

### Cited Findings
- **Runway:**
  - Reports of 625 credits burned in 15 minutes on one 10-second clip, with failed generations still charged ([vantaige.io aggregate review](https://vantaige.io/ai-tool/runway)).
  - Gen-4.5 costs 25 credits per second, Runway's most expensive model ([fast.io review](https://www.fast.io/resources/runway-ai-review-2026.md)).
  - Gen-4 holds one character well from a single reference but sometimes ignored scene instructions in tests ([Atlas Cloud test](https://www.test.atlascloud.ai/blog/tips/kling-ai-vs-runway-vs-luma); vendor-linked).
- **Kling:**
  - Output is praised, but the most serious complaints are about billing: charges after cancellation, confusing renewals, lost credits and absent support ([yespress.io](https://yespress.io/products/kling-ai); [diyai.io](https://diyai.io/ai-tools/video-generation/reviews/kling-ai-review/)).
  - Kling 3.0 drifts when two characters interact in close-up ([neural4d](https://blog.neural4d.com/comparisons/best-ai-video-generator-for-consistent-characters/); a competitor's blog).
- **Midjourney V7:**
  - Omni Reference, its consistency feature, costs 2x GPU time and is incompatible with Vary Region, Pan and Zoom Out ([Midjourney docs](https://docs.midjourney.com/hc/en-us/articles/36285124473997)).
  - One user estimated failure above 50%, with faces especially off ([hunted.space comment](https://hunted.space/product/midjourney-omni-reference); anecdotal).
- **ElevenLabs:**
  - G2 rating is 4.5/5 across 1,155 reviews, but reviewers repeat that credits deplete fast, are "use it or lose it" with no rollover, and are lost on downgrade.
  - Some cancellation complaints, and AI TTS is not accepted by ACX/Audible.
  - Sources: [G2](https://g2.com/products/elevenlabsio/reviews?page=5); [Trustpilot](https://www.trustpilot.com/review/elevenlabs.io?page=7); [Kimola insights](https://kimola.com/reports/elevenlabs-ai-voice-generation-consumer-insights)
- **Descript:**
  - Two-part metering (media hours plus AI credits) makes spend hard to predict.
  - Studio Sound and Overdub burn monthly credits quickly.
  - Stability bugs are flagged repeatedly.
  - Sources: [eesel.ai](https://www.eesel.ai/en/blog/descript-reviews); [hackceleration](https://hackceleration.com/labs/review/descript)
- **Thumbnail tools (Pikzels):** the claimed 10–20 credits per thumbnail becomes 50–100 in real use once iterations are counted. — [fast.io](https://fast.io/resources/best-ai-thumbnail-makers-2026/)
- **Across tools:** reviews agree character consistency is "still the hardest practical problem" for video. — [neural4d](https://blog.neural4d.com/comparisons/best-ai-video-generator-for-consistent-characters/); [Atlas Cloud](https://www.atlascloud.ai/blog/guides/kling-ai-vs-runway-vs-luma)
- **Adobe survey at the macro level:** cost (38%) and unreliable quality (34%) are the top two barriers. — [Adobe](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)

### Inferences
- "Pay per attempt, including failures" is the most emotionally charged pain point. Local generation reframes iteration as free, a direct answer to the #1 barrier. That is ox's clearest pitch for the local pieces: unlimited retries, no credits, no subscription to cancel.
- Consistency (same character or product across scenes) is a top request everywhere. For Flick-style script-to-scenes, ox needs some consistency mechanism to be credible. Options include a fixed seed and style, a reference image, or reusing one generated character via img2img or cut-out compositing.
- Cloud restyle via fal (Wan 2.2) carries the same credit-burn risk users hate. ox should show cost per clip up front and avoid charging for failed runs where possible.

### Gaps
- No direct data found on Pika, Krea, CapCut AI or ChatGPT-images complaints specifically.
- No primary Reddit or GitHub-issues complaint counts were retrieved.
- Licensing and commercial-use concerns appear only as Adobe's 28% "uncertainty about training". No tool-specific licensing complaint data was found.

## 3. Local/private generation vs cloud quality

### Takeaway
Local tools win on **zero marginal cost, privacy, no content restrictions and unlimited iteration**. They lose on **setup pain (ComfyUI), speed on modest Macs, and frontier quality, especially video**. On Apple Silicon, Draw Things is the de facto favourite because it is fast (Metal FlashAttention) and needs no Python. ComfyUI is flexible but fragile. A 16 GB Mac handles SDXL and Flux Schnell images. No source shows local video generation being practical on 16 GB.

### Cited Findings
- **Draw Things vs ComfyUI on an M2 Pro 16 GB:**

  | Model | Draw Things | ComfyUI |
  |---|---|---|
  | SD 1.5, 512px, 20 steps | ~10 s | ~30 s |
  | SDXL, 1024px | ~30 s | ~90–110 s |
  | Flux Schnell, 1024px, 4 steps | ~35 s | ~60–80 s |

  The gap is attributed to Metal FlashAttention versus PyTorch MPS. — [InsiderLLM, Feb/Jul 2026](https://insiderllm.com/guides/stable-diffusion-mac-mlx/)
- **Memory tiers:**
  - 8 GB: SD 1.5 only.
  - 16 GB: SDXL comfortable, Flux Schnell works, Flux Dev swaps.
  - 24 GB: needed for Flux Dev.
  - M3 Pro 18 GB SDXL at 1024px: 18–30 s.
  - Source: [InsiderLLM](https://insiderllm.com/guides/stable-diffusion-mac-mlx/)
- Other single-author benchmarks put Draw Things 20–40% faster than ComfyUI on an M4 Mac mini. Sources disagree on the size of the gap (20% vs 3x). — [heyuan110 Mac mini guide](https://www.heyuan110.com/posts/ai/2026-02-15-mac-mini-local-image-generation/); [Draw Things guide](https://www.heyuan110.com/posts/ai/2026-02-15-draw-things-ultimate-guide/)
- **What Draw Things users value:** no Python or terminal, runs on 8 GB, local LoRA training, JS scripting for batches, ControlNet, and MCP integration so Claude Code can generate images. — [heyuan110](https://www.heyuan110.com/posts/ai/2026-02-15-draw-things-ultimate-guide/); [InsiderLLM](https://insiderllm.com/guides/stable-diffusion-mac-mlx/)
- **What drives users away from ComfyUI:**
  - Partial updates leave the frontend, templates and custom nodes out of sync ([popularai](https://www.popularai.org/p/why-comfyui-updates-break-workflows-and-how-to-fix-them?open=false)).
  - One shared Python environment causes dependency conflicts, "package hell" ([alanbonnici, Jul 2026](https://www.alanbonnici.com/2026/07/comfyui-and-package-hell.html)).
  - "Failed to import" and missing-node errors are common enough for the official docs to cover them ([docs.comfy.org](https://docs.comfy.org/troubleshooting/custom-node-issues.md)).
  - Comfy Desktop has startup crashes ([forum, May 2026](https://forum.comfy.org/t/problems-starting-comfy-desktop-v0-8-36/4417)).
  - Workflows don't port between machines ([RunDiffusion](https://www.rundiffusion.com/troubleshooting-workflows-in-comfyui)).
  - On Mac specifically, some custom nodes fail on MPS ([InsiderLLM](https://insiderllm.com/guides/stable-diffusion-mac-mlx/)).
- **Reasons cited for going local** (from vendor and commentary sources, not surveys):
  - Prompts and outputs aren't logged ([dupple](https://dupple.com/blog/best-ai-image-generators-for-privacy)).
  - Proprietary or unpublished work stays on the machine ([promptus](https://www.promptus.ai/blog/best-privacy-first-ai-image-tools)).
  - No content restrictions ([tumada substack](https://tumada.substack.com/p/nsfw-ai-image-generators-a-deep-dive)).
  - Some privacy-minded users doubt local apps' privacy claims ([Privacy Guides forum](https://discuss.privacyguides.net/t/local-ai-question/36445)).
- **Local voice (Kokoro):**
  - Kokoro is an 82M-parameter model. Claims that it ranked #2 on TTS Arena behind ElevenLabs are promotional and unverified.
  - A practitioner swapped ElevenLabs for Kokoro on an M4 and got ~100 ms latency at near-zero cost ([dTelecom](https://blog.dtelecom.org/we-replaced-elevenlabs-with-kokoro-tts-on-an-m4-gpu-latency-fell-to-100-ms-and-tts-cost-nearly-68bcc3313cdd)).
  - Kokoro is best for clean narration with preset voices. It has **no voice cloning**, and ElevenLabs remains preferred for expressive, cloned or commercial delivery ([aireiter guide](https://aireiter.com/blog/kokoro-82m-tts-local-guide); [promptquorum](https://www.promptquorum.com/ja/power-local-llm/kokoro-vs-elevenlabs)).
- **Survey context:** 69% of creators worry about their content training AI without consent ([Adobe](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)). This is a privacy/trust sentiment that local tools can address, though it isn't a direct measure of demand for local generation.

### Inferences
- **Where ox can win:**
  - Zero-setup local generation. Draw Things' appeal is "no Python", and ComfyUI's main churn driver is setup and dependency fragility. ox's no-API-key, works-out-of-the-box Studio matches what Mac users reward.
  - Free iteration, privacy, and the editing and enhancement jobs (upscale, cut-out, captions, narration) that run well on 16 GB.
- **Where ox should not compete locally:** frontier image quality (GPT Image, Nano Banana) and video generation. SD-Turbo is far below SDXL and Flux on quality, and Wan-class video on 16 GB is not shown to be practical. ox's hybrid approach (cloud for video restyle) is consistent with the evidence. It should be transparent about cost, and optionally let users plug in GPT Image or Nano Banana for quality-critical stills.
- Draw Things exposing MCP to Claude Code shows developers want image generation callable from their coding agent. That is directly ox's territory.
- On a machine with little free disk, model size matters. SD-Turbo and Kokoro, both small, are sensible defaults. Larger models (SDXL ~7 GB, Flux larger) should be opt-in downloads with size shown.

### Gaps
- No quantified survey of local vs cloud preference was found.
- No timing data was found for SD-Turbo on M3 16 GB. The InsiderLLM table doesn't cover it.
- No reliable local video benchmarks on 16 GB Macs (Wan 2.2 / LTX) were found.
- DiffusionBee's current status and user sentiment were not covered by any retrieved source.
- Draw Things app-store review themes were not found.

## 4. What developers specifically want media tools for

### Takeaway
The evidence is thin and mostly from vendors. The visible developer demand is for **app icons in every platform size, App Store/marketing screenshots, social graphics, and cheap product demo videos**, plus **agent-callable generation** (MCP). No survey quantifies it.

### Cited Findings
- **Icon and screenshot tools:**
  - IconLab is PeerPush's top 2026 design tool for indie hackers; it generates app icons in under a minute ([PeerPush](https://peerpush.com/best/for/indie-hackers/uc/design-prototyping)).
  - Pixelle generates icons, marketing graphics and App Store screens that stay visually consistent across a project. It exports iOS, Android, favicon, macOS and Windows sizes, and turns uploaded UI into App Store screens with ASO-focused headlines ([Vercel community](https://community.vercel.com/t/pixelle-ai-icons-and-graphics-generator-that-makes-indie-apps-look-professional/36196)).
  - Iconik AI offers prompt-to-icon in every iOS, Android and web size ([Indie Hackers](https://www.indiehackers.com/post/introducing-iconik-ai-create-beautiful-app-icons-using-ai-59b549d7a1)).
- **Demo videos:** an Indie Hackers post claims product demo videos for $0 with an AI workflow, versus ~$5,000 at an agency. Only a teaser is visible. — [Indie Hackers](https://www.indiehackers.com/johnm2)
- **Agent-callable generation:** Draw Things' MCP server lets Claude Code generate images directly. — [heyuan110](https://www.heyuan110.com/posts/ai/2026-02-15-draw-things-ultimate-guide/)
- **Commentary:** with building apps now easy, distribution and positioning matter more, which shifts value to marketing assets. — [indie hacker 2026 essay (mirror; low confidence)](https://zhowcdn01-endpoint01-domain01.localdev.cdn.azure.cn/blog/what-it-means-to-be-an-indie-hacker-in-2026)

### Inferences
- **Highest-value developer recipes for ox:**
  1. App icon set: generate, cut out, and export every size (iconset, favicon, Android).
  2. Store screenshots and social cards from real app screenshots: background removal, frames, captions.
  3. Demo or changelog video: screen recording + whisper captions + Kokoro narration + ffmpeg edit.
  4. Docs images and diagrams.
- These recipes lean on editing and compositing, which local tools do well, more than on raw generation quality.
- "Consistent across a project" is the recurring dev ask (Pixelle's pitch). A project-level style memory (palette, seed, style prompt) would match it.
- ox lives inside the coding agent, which is an advantage. Developers want generation as a tool call during the build, not a separate app.

### Gaps
- No survey or usage data quantifying developer use of AI media tools was found.
- No GitHub-issue analysis was done.
- Product Hunt traction for dev-focused media tools was not retrieved.
