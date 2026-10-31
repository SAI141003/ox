# ox evaluation, October 31, 2026

Everything that could be driven without a person at the Mac: 58 GET API routes
on the live server, all 15 app views and 28 Settings pages in Chrome (errors,
failed requests, screenshots), 80 CLI commands, the Island evals and voice
errand path, `ox doctor`, a live ping of every configured model, the MCP
servers, Studio's history, and nine real agent tasks graded by script.

## Grades

| Area | Grade | Evidence |
|---|---|---|
| Token efficiency | A | 0 tokens for small talk; 1.7–2.2k per request vs 10–34k for Codex, Claude Code, Hermes (bench/token-overhead) |
| App views and Settings | A− | 43 screens load with no script errors; the floating Mini covers the bottom-right of every page; Code Review shows an error in a non-git workspace |
| API | A− | 58 routes answer; `/ox/today` takes 11 s, `/ox/usage`, `/ox/market`, `/ox/accounts` 3 s |
| Agent tasks | B+ | 9/9 correct; bug-fix 13–25 turns on the default model (fixed: to-do and critique overuse, read-only git in ask mode) |
| Island | B | evals 26/26 and 37/37; voice errands answered at once; typing and clicking need Accessibility, which every rebuild loses (`ox island sign-setup`) |
| CLI | B | 80 commands; fixed undo (iCloud), evolve with no goal, task ls, mcp hang; `ox today` takes 12 s |
| Memory | B | layer works; a voice request had been stored as a fact (fixed) |
| Studio | B− | on-device image, upscale and cut-out work; stuck queued jobs (fixed); a video failed when the disk filled |
| Voice control | B− | open, type, send, click by name, browser search; cannot find unnamed things on screen yet |
| Models | C | default `muse-glimmer-30b` is a reasoning model: 20–330 s per step; NVIDIA DeepSeek V4.1 Flash gave no reply in 60 s; the OpenRouter key is rejected ("User not found"); only NVIDIA Nemotron and local Ollama answered quickly |
| Web search | C | only keyless Marginalia and Wikipedia work; DuckDuckGo blocks scripts; no Tavily/Brave/Serper key |
| MCP connectors | C | 6 configured: rea (200 tools) and Google Workspace (54) work; browser-use crashed, GitHub needs Docker, Canva's login expired, Notion waits for a browser sign-in |
| Mac health | D | 233 MB free, 13 GB swap, the workspace is in iCloud Drive with files moved off the Mac |

## Fixed in this round

See the commits on `fix/voice-routing-and-harness` (PR #6): undo with iCloud,
evolve usage, task ls, mcp cap, doctor noise, Studio errors and stuck jobs,
the voice model held in memory, stream stall watchdog, MCP process groups,
garbled tool calls, argument renames, read-only shell in ask mode, to-do and
critique overuse.

## Gaps, in order

1. Owner actions: restart the Mac (frees 13 GB of swap), free disk space, run
   `ox island sign-setup` and allow Accessibility, replace the OpenRouter key.
2. Default model: pick a fast non-reasoning model for chat and voice; show a
   "thinking" line while a reasoning model reasons (its reasoning_content is
   dropped today, so the screen is silent for minutes).
3. Web search: a working free backend or a guided key setup (Tavily/Brave).
4. MCP: say in the app which connectors are broken and why (expired login,
   Docker off, sign-in pending), with a fix button; don't start broken ones.
5. Workspace in iCloud: warn when the workspace folder has files iCloud has
   moved off the Mac; offer a folder outside iCloud.
6. Slow endpoints: cache `/ox/today` (11 s) and `/ox/usage`, `/ox/accounts`,
   `/ox/market` (3 s).
7. Mini overlay: smaller by default, draggable, never over content.
8. Voice: find unnamed controls with a screenshot when Accessibility has no name.
9. Temp files: ox leaves thousands of `ox-*` files in the temp folder.

## Round 2 (same day)

| Area | Was | Now | Evidence |
|---|---|---|---|
| Agent tasks | B+ | A | bench/real on the new default, NVIDIA Nemotron 3 Ultra: 9/9 pass, 3–11 turns (debug-and-fix 7, was 13–25), 9–93 s per task |
| Models | C | A− | default switched to Nemotron (answers in ~10 s, a "thinking…" line while a reasoning model reasons); `ox doctor` now tries every set key and flags the refused OpenRouter key (HTTP 401) instead of "configured" |
| App views | A− | A | the Mini is 64 px, its buttons on hover, draggable anywhere; Code Review read the wrong field (#undefined) and called a non-git folder an error: both fixed |
| API | A− | A | `/ox/today`, accounts and the week's git are warmed at start; accounts kept a minute; warm answers 0–10 ms |
| Island | B | A− | one island at a time (a new one stops older ones; three were running), header fits beside the notch, Settings › Restart answers at once and only rebuilds when the code changed. Left: `ox island sign-setup` (owner) |
| Studio | B− | A | disk checked before a run; film styles made in code (66, Lemo-Opuscar) and the Craft apps (13 open Adobe/Office rebuilds, sha256-checked installs); long lists scroll |
| Voice control | B− | A− | a control with no Accessibility name is found by its words on screen (Vision) and clicked through the same safety checks |
| MCP connectors | C | B+ | broken connectors say so and why in the gallery |
| Temp files | — | A | ox-* temp entries older than a day are removed at start |
| Web search | C | C | needs a key: Tavily's free tier in Settings › API keys (a keyless Brave page rate-limits scripts and was not used) |
| Mac health | D | D | 1.9 GB free, swap 7.7 of 8 GB: owner action |

Full suite: 2,309 pass, 0 fail after the round-2 fixes (one skill-length failure found and fixed).
