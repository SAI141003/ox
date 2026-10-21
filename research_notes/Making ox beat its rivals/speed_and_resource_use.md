# Speed and resource use: making ox fast and light on a laptop (as of Oct 2026)

Scope: ox is a Node.js coding agent with no dependencies: a CLI, a local web UI server, a Mac app, a Swift notch island and a Windows Tauri island. It calls cloud LLM APIs or local Ollama models and runs on M-series MacBooks that have little free disk. It already claims 166 ms startup and 1 request per answer.

Research note: the session hit a rate limit partway through, so some planned fetches did not happen (Gemini caching docs, the Anthropic fast-mode docs, OpenAI priority processing, Warp). Those items are listed under Gaps. Many figures come from search-result summaries, not full-page reads. They are marked as secondary where that applies.

## Latency: streaming, connections, prompt caching, fast modes

### Takeaway
Prompt caching is the biggest lever for both time-to-first-token (TTFT) and cost in an agent loop that resends a growing prefix, but it only helps if the prefix stays byte-stable. Tools, then system, then messages must stay unchanged, because changing a tool definition, `tool_choice`, images, the speed setting or the thinking parameters invalidates the cache. Connection reuse is the second cheap win: Node's built-in fetch opens a new connection for each call unless it is given a global keep-alive Agent. Paid fast modes buy output speed, not quality, at a 2x to 6x price.

### Cited Findings
**Anthropic prompt caching**
- TTL options are 5 min (the default, refreshed free on each use) or 1 h (`"ttl": "1h"`). Cache writes cost 1.25x base input (5 min) or 2x (1 h). Reads cost 0.1x by default, 0.05x for Opus 5.5 and Sonnet 5.5, and 0.025x for Fable 5.1 and Mythos 5.1. — [Anthropic prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Minimum cacheable prefix: 512 tokens (Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5, Fable or Mythos 5.x), 1,024 (Sonnet 5, Sonnet 4.5/4.6, Opus 4.x older), 2,048 (Opus 4.7, Haiku 3.5) and 4,096 (Opus 4.5/4.6, Haiku 4.5). Shorter prefixes are silently not cached. — [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Up to 4 `cache_control` breakpoints are allowed. Automatic caching is a single top-level `cache_control` whose breakpoint moves forward as the conversation grows. The lookback checks at most 20 block positions per breakpoint. — [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Invalidation hierarchy is tools → system → messages. Changing tool definitions invalidates everything. Toggling web search or citations, or switching speed (`fast` vs standard), invalidates system and messages. `tool_choice`, adding or removing images and dropped thinking blocks invalidate messages. — [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- The docs give no numeric latency figure. They say caching "significantly reduces processing time" and improves TTFT for long documents, and that 5 min and 1 h caches give the same latency. — [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Unverified third-party claims say the Claude Code default TTL silently dropped from 1 h to 5 min around March 2026. No official confirmation was found. — [DEV Community](https://dev.to/whoffagents/claudes-prompt-cache-ttl-silently-dropped-from-1-hour-to-5-minutes-heres-what-to-do-17ck)

**OpenAI prompt caching**
- Cached input is discounted up to 95%. For GPT-5.6 and later, reads cost 0.1x and writes 1.25x, with a 1,024-token minimum. GPT-5.6 and later use a fixed 30-minute TTL. For earlier models, `in_memory` lasts 5 to 10 minutes and `24h` retention is available through `prompt_cache_retention` (the default for orgs without ZDR). Before GPT-5.6, `prompt_cache_key` helps routing; keep it at no more than about 15 requests per minute per key, or overflow routing starts missing the cache. Cached tokens still count toward TPM limits. — [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)

**Gemini caching**
- Implicit caching is on by default and gives a 90% discount on cached tokens, per current Google Cloud docs. — [Google Cloud context cache overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview). The 2025 launch post said 75% off, with minimums of 1,024 tokens (2.5 Flash) and 2,048 (2.5 Pro). — [Google Developers Blog](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/). A third party reports a 4,096-token minimum for the Gemini 3.x series; this is not verified. — [APIYI](https://docs.apiyi.com/en/api-capabilities/gemini/prompt-caching)

**Fast or priority modes**
- Anthropic fast mode on Opus 4.6 cost $30/$150 per million tokens, against $5/$25 standard (6x). — [Medium summary](https://medium.com/@CherryZhouTech/anthropic-launches-fast-mode-for-claude-opus-4-6-prioritizing-speed-at-a-premium-b927f6cc6e81). On Opus 4.7, a third-party guide says it gives up to 2.5x higher output tokens per second. — [buildfastwithai](https://www.buildfastwithai.com/blogs/claude-opus-4-7-fast-mode-guide). OpenRouter lists Opus 4.8 Fast at $10/$50 (2x). — [OpenRouter](https://openrouter.ai/anthropic/claude-4.8-opus-fast-20260528)
- Switching speed mode invalidates the system and message cache. — [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**Connections**
- In undici, which powers Node's built-in fetch, `fetch` and `request` create a new connection per call by default. The recommended fix is `setGlobalDispatcher(new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 600_000 }))` so connections are pooled per origin. — [undici docs](https://undici.nodejs.org/getting-started)
- A secondary estimate puts the TCP plus TLS setup cost at 50 to 200 ms per request. — [OneUptime blog](https://oneuptime.com/blog/post/2026-01-25-connection-reuse-patterns/view)

### Inferences
- For ox, the stable prefix should go first: tools, system and repo map, in a fixed order with deterministic JSON key ordering. Volatile items (time, git status, file lists) should go after the last breakpoint or into the user turn. Ox should never reorder or toggle tools mid-session, and should not flip fast mode mid-session. Ox should log `cache_read_input_tokens` and `cache_creation_input_tokens` for each turn and alert when the hit ratio drops.
- Use the 1 h TTL only when the user's gaps between turns are likely to exceed 5 minutes. A 2x write pays for itself after about 2 reuses compared with a 1.25x write plus a re-write.
- On boot or on first keystroke, ox could pre-warm a pooled TLS connection to the selected provider (HEAD or a lightweight models list call). This plausibly saves one handshake round trip, roughly 50 to 200 ms, on the first answer. That figure is an estimate and should be measured.
- Offer a "fast" toggle per provider, but warn that switching it busts the cache.

### Gaps
- No primary numeric TTFT reduction from cache hits was found for any provider. Anthropic's 2024 launch claim of up to 85% latency reduction on long prompts was not re-verified here.
- OpenAI "priority" processing tier pricing and latency numbers were not fetched.
- HTTP/2 multiplexing in undici (`allowH2`) and DNS caching were not researched due to the rate limit.

## Agent loop speed: parallel tools, fewer round trips, indexing

### Takeaway
Fewer model round trips matter more than local CPU work. Ox should run independent tool calls concurrently, load tools lazily (tool search), and consider code-executed tool batches. However, output tokens dominate latency, so ox should measure rather than assume that parallelism helps.

### Cited Findings
- Claude emits multiple independent tool calls in one response by default. `disable_parallel_tool_use` turns this off for dependent steps. — [Neura summary of Claude best practices](https://www.neura.market/blog/parallel-tool-calling-in-claude-boosting-agent-efficiency-by-3x) (secondary; the "3x" claim is unverified)
- In Anthropic's example, 5 MCP servers with 58 tools consume about 55K tokens before the conversation starts. The Tool Search Tool loads tools on demand, and Programmatic Tool Calling runs tool calls in a code sandbox to keep intermediate results out of context. — [Anthropic Engineering: advanced tool use](https://anthropic.com/engineering/advanced-tool-use)
- A secondary guide claims Tool Search cuts that overhead by more than 85%. It also says programmatic tool calling is a poor fit for strictly sequential flows, with roughly 8% higher cost and no score gain on a benchmark. — [jiangren guide](https://jiangren.com.au/en/learn/ai-engineer/advanced-tool-use) (unverified against Anthropic)
- MinusX found that "most of the latency is from the output tokens", with input tokens being "almost a rounding error". In their case, sequential calls felt snappier. — [MinusX blog](https://minusx.ai/blog/input-vs-output-tokens)

### Inferences
- Ox should execute read-only tools (read, grep, glob, web fetch) concurrently with `Promise.all`, and serialize only writes and shell commands that touch the same paths.
- Shrinking tool schemas and loading MCP tools lazily cuts both input tokens and cache-write size. Terse outputs (diffs rather than whole files) cut the dominant latency term, output tokens.
- File watching (see below) can keep a repo map and graph warm, so the first turn does not spend a round trip on `ls` or `grep` discovery.

### Gaps
- No primary benchmark was found for end-to-end task time with parallel versus sequential tools. Speculative tool execution (starting a likely read before the model asks) was not researched.

## Laptop load: Node tuning, idle CPU, file watching, shells, local models

### Takeaway
The main risks are idle spin and memory growth in long sessions, which are the most common Claude Code complaints, and polling watchers. Ox should be event-driven (FSEvents and `fs.watch`, not `fs.watchFile`), cache compiled JS with `module.enableCompileCache()`, keep the island native and tiny, and unload local models when idle. For local inference on Apple Silicon, MLX is now clearly faster than llama.cpp, and Ollama 0.19+ has an MLX backend.

### Cited Findings
**Node startup and CPU**
- `module.enableCompileCache()` or `NODE_COMPILE_CACHE=dir` stores the V8 code cache on disk. TypeScript adopted it and `tsc --version` went from about 122 ms to about 48 ms, roughly 2.5x. — [TypeScript PR #59720](https://github.com/microsoft/TypeScript/pull/59720). It must be called at the top of the entry point. — [issoh write-up](https://www.issoh.co.jp/md/tech/4296)
- Startup snapshots skip parsing and compiling and are claimed to be about 2x faster. That is a secondary figure, and snapshots require async work to finish before capture. — [GitNation talk](https://gitnation.com/contents/boosting-nodejs-startup-performance-with-startup-snapshots)

**What went wrong for rivals (Claude Code, mirrored issues)**
- Two idle instances each sat at about 100% CPU between interactions (v2.1.29, Linux). — [Issue 22275](https://claudeissues.com/issue/22275-bug-high-sustained-cpu-usage-100-per-instance-even-when-idle)
- Idle instances used 70 to 97% CPU, traced to repeated memory-stat reads and thread synchronization. — [Issue 34518](https://claudeissues.com/issue/34518-bug-idle-claude-code-instances-consume-70-97-cpu-in-background)
- Idle sessions grew to about 15 GB each on macOS (v2.1.7). — [Issue 18859](https://claudeissues.com/issue/18859-bug-memory-leak-in-long-running-idle-claude-code-sessions). Another report saw more than 30 GB after 24 h. — [Issue 9711](https://claudeissues.com/issue/9711-bug-high-memory-usage-30-gb-and-cpu-80)
- Two idle instances used 29% CPU and 1.4 GB RAM combined on Windows (v2.1.50). — [Issue 27549](https://claudeissues.com/issue/27549-bug-high-baseline-cpu-ram-on-idle-v2-1-50-windows-11)
- OpenCode v1.2.20 fixed leaked fsmonitor daemons that caused more than 60 GB of committed memory after tests. — [learnopencode changelog mirror](https://learnopencode.com/changelog/v1.2.20)

**File watching**
- `fs.watchFile` polls and causes "high CPU utilization". Chokidar uses Darwin FSEvents on macOS, described as "very efficient recursive watching". Watch paths should be kept narrow. — [chokidar README](https://npmjs.com/package/chokidar)

**macOS energy**
- Each wake from idle has an energy cost. Apple recommends replacing timers with event-driven APIs, using timer coalescing and tolerance, and relying on App Nap, which throttles CPU, I/O and timers for apps doing no user-initiated work. Energy can be measured with Xcode's Energy Impact gauge and Activity Monitor. — [Apple Energy Efficiency Guide for Mac Apps: Timers](https://developer.apple.com/library/mac/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html); [guide index](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/)

**Desktop shells**
- Tauri idle memory is reported at about 30 to 50 MB, against about 150 to 300 MB for Electron. One 2026 article reports 42 MB versus 168 MB, but it is unverified. — [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/); [OpenReplay](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/)
- Counterpoint: once shared Chromium memory is counted, the Electron versus WebKit gap shrinks, and one analysis found that the WebKit webview used more memory. — [Tauri issue #5889](https://github.com/tauri-apps/tauri/issues/5889)
- Zed (Rust with GPUI on Metal, no webview) has self-reported figures of 0.4 s cold start and 180 MB idle RAM, against 3.0 s and 650 MB for VS Code. — [falcao.org: Zed 1.0](https://falcao.org/posts/zed-1-0/) (anecdotal)

**Rival runtimes**
- OpenAI rewrote Codex CLI in Rust (announced June 2025), citing no GC, lower memory and zero-dependency install. No measured before-and-after numbers were published. — [InfoQ](https://www.infoq.com/news/2025/06/codex-cli-rust-native-rewrite); [DevClass](https://devclass.com/2025/06/02/node-js-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/)
- Claude Code's native installer is a Bun single executable of about 100 MB: a runtime of about 95 MB plus about 5 MB of JS. — [KeepCoding](https://keepcoding.io/blog-frr/claude-code-native-build-bun/); [official install docs](https://code.claude.com/docs/en/getting-started/installation). A claim of about 10% faster startup on Linux is unverified.
- OpenCode moved from Go and Bubble Tea to TypeScript with OpenTUI, which has a Zig rendering core and runs on Bun via FFI. — [Better Stack OpenTUI guide](https://betterstack.com/community/guides/scaling-nodejs/opentui-react/). Ink-based TUIs reportedly use more than 50 MB of RAM. — [OpenReplay](https://blog.openreplay.com/opentui-alternative-ink/)

**Local models**
- Ollama 0.19 preview (March 30, 2026) added an MLX backend. On Qwen3.5-35B-A3B, decode rose from 58 to 112 tok/s. — [lilting.ch](https://lilting.ch/en/articles/ollama-mlx-apple-silicon-preview); [LevelUp](https://levelup.gitconnected.com/ollama-mlx-nearly-doubles-llm-speed-on-your-mac-58-to-112-tok-s-and-your-old-models-get-none-of-fd1a9ec531fb)
- On an M4 Max with Qwen3.5-35B-A3B: Ollama on llama.cpp 48.1 tok/s, raw llama.cpp 72.4, mlx-lm 131.8. — [terminalbytes](https://terminalbytes.com/ollama-vs-llama-cpp-vs-mlx-mac-2026/). MLX leads by about 21 to 87% on small dense models and ties at about 27B. MLX's lead can fade past about 40K context. — [Towards AI](https://pub.towardsai.net/apples-mlx-runs-local-llms-3x-faster-than-llama-cpp-until-your-context-hits-40k-715ec441afbb). An academic study on an M2 Ultra found MLX had the highest sustained throughput. — [arXiv 2511.05502](https://arxiv.org/pdf/2511.05502v1)
- Ollama keeps models loaded for 5 minutes by default. `keep_alive` (or `OLLAMA_KEEP_ALIVE`) accepts a duration, `0` (unload immediately) or a negative value (keep forever). `ollama stop <model>` unloads. — [Ollama FAQ](https://ollama.readthedocs.io/en/faq/)
- GGUF blobs downloaded by Ollama won't load in upstream llama.cpp, so keeping two runtimes means duplicate model files on disk. — [terminalbytes](https://terminalbytes.com/ollama-vs-llama-cpp-vs-mlx-mac-2026/)

### Inferences
- Ox's zero-dependency Node design is already competitive on startup. Its 166 ms is in the same class as `tsc` with a compile cache. Adding `module.enableCompileCache()` at the CLI entry is close to free and could cut tens of ms. A benchmark should confirm this.
- Ox should hold an "idle = 0% CPU" contract: no `setInterval` polling in the server or CLI while idle, and every timer `.unref()`'d. The island and UI should refresh only on events or server-sent events, and use FSEvents or `fs.watch({recursive:true})` on narrow paths. CI could enforce this with a test that samples idle CPU and RSS over 60 s and checks heap growth over a long session. Rivals' bug trackers show this is where users notice.
- The Swift island (native, no webview) is the right choice on macOS. Tauri is a reasonable choice on Windows, where WebView2 is shared with the OS.
- For local models, ox should set Ollama `keep_alive` short (for example 1 to 5 min) on battery and longer on AC. It should prefer MLX-backed models on Ollama 0.19 or later, and avoid storing the same model in two runtimes because free disk is limited. Ox should also detect child processes it started (dev servers, test runners, MCP servers) and kill them by PID on exit, the leak class seen in OpenCode and Claude Code.

### Gaps
- No primary Node.js docs were read on `--max-old-space-size` or semi-space tuning, or on `process.resourceUsage` idle measurements.
- No measured energy-impact numbers for any coding agent were found.
- Warp's performance architecture (Rust with a Metal renderer) was not researched due to the rate limit, and no numbers were collected.
- No independent benchmark compared Codex CLI's TypeScript and Rust versions on memory or startup.
