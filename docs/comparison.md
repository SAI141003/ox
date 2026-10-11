# ox vs everyone

Positioning document for **ox**, the featherweight coding agent (design authority: [plan.md](plan.md); evidence: [research.md](research.md)). Marks are honest to the point of discomfort — where a competitor does it better, the matrix says so.

**Legend:** ✓ yes · ~ partial or with caveats (see notes) · ✗ no · N/A out of category.
**Methodology.** Marks come from documented behavior as of Aug 2026 (research.md), not marketing pages. `~` always carries a numbered note. ox column marks are plan.md acceptance criteria: they are testable claims, and any ✓ that fails its test in CI is a bug against this document.
**Non-coding note.** Th (Thuki), Hc (HeyClicky), and Cl (Clicky analytics) are not coding agents. Their cells are N/A or ✗ with "out of category" notes; no inference about quality is intended.

**Columns:** CC = Claude Code · CX = Codex CLI · He = Hermes Agent · Ai = Aider · oc = opencode · Cr = Crush · Ag = Antigravity · At = Atomic Agent · TF = TrueForge · BH = browser-harness · Sh = Stagehand · Cf = Camoufox · Tr = Trawl · Ow = OpenWhispr · Un = Unity · Th = Thuki · Hc = HeyClicky · Bb = Backboard · Cl = Clicky · **ox** = ox.

## 1. Feature matrix

**Reading order:** skim §1 matrix → §2 wins → §3 Hermes counters + new platform comparisons. §4 is the honesty section; §5 pre-answers the objections.

| # | Capability | CC | CX | He | Ai | oc | Cr | Ag | At | TF | BH | Sh | Cf | Tr | Ow | Un | Th | Hc | Bb | Cl | **ox** |
|---|------------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|--------|
| 1 | Zero-dep install, <150ms startup | ✗¹ | ~² | ✗ | ~ | ✗ | ✓ | ✗ | ~³ | ~⁴ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 2 | BYOK multi-provider incl. Grok + local | ✗ | ~³ | ~⁴ | ✓ | ✓ | ✓ | ✗ | ✓ | ~⁵ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~⁶ | ✗ | **✓** |
| 3 | Built-in bot presets (`/bot grok`) | ✗ | ✗ | ✗ | ✗ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁷ | ✗ | **✓** |
| 4 | Mid-session model switch, context preserved | ~ | ~ | ~ | ✓ | ~ | ✓⁸ | ✗ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 5 | Verified edits (diff preview + post-edit check) | ~⁹ | ✓ | ✗ | ✓ | ~ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 6 | Plan mode | ✓ | ✓ | ✗ | ~ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 7 | Graduated approvals | ✓ | ✓ | ~ | ~ | ✓ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 8 | MCP client | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ~ | ✓¹¹ | ✗ | ✓¹² | ✓¹³ | ✗ | ✗ | ✗ | ✓¹⁴ | ✗ | ✗ | ~¹⁵ | ✗ | **✓** stdio+HTTP, template registry, risk-gated |
| 9 | Skills (Agent Skills standard compatible) | ✓¹⁰ | ✗ | ✓ | ✗ | ~ | ~ | ✗ | ✓¹⁶ | ✗ | ✓¹⁷ | ✓¹⁸ | ✗ | ✗ | ✗ | ✓¹⁹ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 10 | Persistent cross-session memory | ✓ | ~²¹ | ~²² | ✗ | ✗ | ✗ | ~ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓²³ | ✗ | **✓** |
| 11 | Evidence-gated self-improvement | ~ | ~ | ✗²⁴ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 12 | Self-heal loop w/ retry budgets + rollback | ~ | ~ | ✗ | ✓ | ~ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 13 | Honest context meter (est. % always visible) | ✗ | ✗ | ✗ | ~²⁵ | ✗ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 14 | Auto-compaction | ✓ | ✓ | ✗ | ✗ | ✓ | ~ | ✓ | ✗ | ✓²⁶ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 15 | Session resume/fork, lossless logs | ✓ | ✓ | ~²⁷ | ~ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 16 | Headless `-p` / `--json` / exit codes | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 17 | Cost ledger + hard budget caps | ~²⁸ | ~ | ✗²⁹ | ✓ | ✓ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓³⁰ | ✗ | **✓** |
| 18 | Telemetry: none by default | ~ | ~ | ~ | ~ | ~ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| 19 | Hooks | ✓ | ✓ | ✓ | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** all 6 declared events fire (PreToolUse/PostToolUse blocking; PreLLM/PostLLM fire-and-forget; SessionStart/SessionStop once per run) |
| 20 | Subagents (summary-return) | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓³¹ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~³² | ✗ | **✓** `src/subagent.js` — summary-return with mistake-learning memory |
| 21 | IDE integration | ✓ | ~ | ✗ | ~ | ~ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✗** deferred |
| 22 | Kernel sandboxing | ✗³³ | ✓ | ~ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** kernel-enforced via profile engine on macOS/Linux-bwrap, userspace fallback |
| 23 | Parallel read-only tool batches | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓³⁴ | ~³⁵ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | N/A | N/A | **✓** |
| 24 | Strict schema/small-model tool reliability | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓³⁶ | ~³⁷ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | N/A | N/A | **✓** lean constant-size tool schemas |
| 25 | Import adapters (Claude Code, Hermes, Codex) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓³⁸ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | N/A | N/A | **✓** `ox import` |
| 26 | Durable task store (`~/.ox/tasks/`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓³⁹ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | N/A | N/A | **✓** |
| 27 | `ox serve` HTTP surface | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ~⁴⁰ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | N/A | N/A | **✓** |
| 28 | Agent presets CLI (`ox agent list|save|use|delete`) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁴¹ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✗ | ✗ | **✓** `/bot` + `ox bots` |
| 29 | Subagents (summary-return) | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓⁴² | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✓⁴³ | ✗ | **~** roadmap |
| 30 | Sandbox-as-tool seam | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁴⁴ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ~⁴⁵ | ✗ | **✓** approval-gate seam |
| 31 | MCP templates registry | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁴⁶ | ✗ | ✗ | ✗ | ✗ | ✓⁴⁷ | N/A | N/A | ✗ | ✗ | **✓** `ox mcp add` |
| 32 | Skills install paths | ✓¹⁰ | ✗ | ✓ | ✗ | ~ | ~ | ✗ | ✓⁴⁸ | ✗ | ✓⁴⁹ | ✓⁵⁰ | ✗ | ✗ | ✗ | ✓⁵¹ | N/A | N/A | ✗ | ✗ | **✓** 4 scan dirs, Agent Skills native |
| 33 | Voice integration path | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁵² | ✗ | N/A | N/A | ✗ | N/A | **✓** 9 MCP tools: speech_to_text, dictate, push_to_talk, voice_conversation, transcribe_file, text_to_speech, synthesize_file, list_voices, voice_clone (whisper + kokoro local backends) |
| 34 | Unity MCP templates | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓⁵³ | N/A | N/A | ✗ | N/A | **✓** `ox mcp add unity` + skill paths |
| 35 | Backboard provider/preset | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✓⁵⁴ | N/A | **~** `backboard` bot via `OX_BASE_URL` |
| 36 | Backboard R-CLI coexistence | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✓⁵⁵ | N/A | **~** skill/docs: when to use each |
| 37 | Backboard memory bridge | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✓⁵⁶ | N/A | **~** portable export/import skill |
| 38 | Backboard model routing bot | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A | N/A | ✓⁵⁷ | N/A | **~** optional bot preset |


**Notes.**
1. CC ≈232MB installed (Bun binary).
2. CX zero-dependency and millisecond-startup Rust binaries, but MB-scale, not KB-scale.
3. CX BYOK + OSS mode + custom providers; Grok possible via custom config, not a preset.
4. Hermes accepts any OpenAI-compatible endpoint but its ≥64K-context floor makes small local models impractical.
5. TrueForge's provider model is cloud/K8s-oriented; local BYOK is not its primary design path.
6. Backboard as OpenAI-compatible endpoint is possible via `OX_BASE_URL` but requires configuration; not a one-line preset.
7. Backboard provides bot presets through its platform; ox provides CLI-native presets.
8. Crush's signature feature; ox matches it across providers via canonical messages.
9. CC has checkpoints but ships silent Edit failures (#64171).
10. CC co-authored the standard; ox parses its skills natively.
11. Atomic Agent's strict schema for tool calling applies to small local models; ox applies it via lean JSON schemas + adapter-side validation.
12. Browser-harness exposes tools via MCP template; ox can consume them with `ox mcp add browser-harness`.
13. Stagehand tools wrapped as MCP; ox consumes via template-generated config.
14. OpenWhispr pipes transcribed text into ox; not a full MCP server.
15. HeyClicky may offer a local API; documented as optional non-goal.
16. Atomic Agent contributes import adapter pattern; ox implements `ox import` for skills/MCP/memory from CC/He/CX layouts.
17. Browser-harness install path documented for MCP-template installation into `.agents/skills/`.
18. Stagehand skill install instructions absorbed into ox's skill-path documentation.
19. OpenWhispr's voice dictation skill installs into `.agents/skills/` with copy-prompt-to-ox flow.
20. Hermes: ~2.2KB frozen injection; SQLite corruption (#5563).
21. CX AGENTS.md is authored project memory, not learned memory.
22. Hermes: ~2.2KB frozen injection; SQLite corruption (#5563).
23. Backboard claims portable state/memory; ox's `.agent/` store is independently verifiable.
24. Hermes captures procedures regardless of outcome — failed skills included (#12877).
25. Aider `/tokens` reports usage on demand; no live honest meter anywhere in the field.
26. TrueForge compaction/reconnect hardening for long runs absorbed; ox applies persistent JSONL + episode-based compaction.
27. FTS5 search, undermined by state.db corruption.
28. CC quota opacity + drain bugs make spend effectively unauditable.
29. Silent aux-model billing ($145 surprise charges, #7559/#45782).
30. Backboard's published pricing; ox uses published price table + ledger + `--max-cost` caps.
31. TrueForge subagents (summary-return); ox reserves the seam per Anthropic guidance (1–2k summaries).
32. HeyClicky may offer agent capabilities; not verified as coding agent.
33. CC sandboxing is rules + classifier, weaker than OS-level — the one big-table row Codex wins outright.
34. Atomic Agent's parallel read-only tool batches absorbed into ox agent loop.
35. TrueForge parallel flows are cloud/K8s-oriented, not local featherweight.
36. Atomic Agent strict schema path for small models absorbed; ox uses lean constant-size schemas.
37. TrueForge schema rigor applies in enterprise context; ox applies minimal viable schema locally.
38. Atomic Agent import adapters (CC/He/CX layouts) absorbed as `ox import`.
39. Atomic Agent durable task store pattern absorbed into `~/.ox/tasks/`.
40. Atomic Agent `ox serve` HTTP surface absorbed; Node http only, no external deps.
41. TrueForge agent presets CLI absorbed; ox maps to `ox agent list|save|use|delete`.
42. TrueForge subagents absorbed; ox summary-return per Anthropic guidance.
43. HeyClicky possible subagent-like flows; not verified as coding agent; out of category.
44. TrueForge sandbox-as-tool seam absorbed; ox approval/sandbox profile engine.
45. Backboard sandbox posture differs; coexistence documented, not merged.
46. Browser-harness MCP template registry absorbed into `ox mcp add browser-harness`.
47. Unity MCP templates absorbed; `ox mcp add unity` generates configs for IvanMurzak/CoplayDev/batihandev variants.
48. Atomic Agent skill install path pattern absorbed into ox 4-dir scan.
49. Browser-harness skill install instructions absorbed.
50. Stagehand skill install path documentation absorbed.
51. OpenWhispr voice skill installs into `.agents/skills/` with dictated-text-to-ox flow.
52. OpenWhispr → ox pipe: transcribed text into `ox -p -` or REPL; push-to-talk workflow.
53. Unity MCP templates: `ox mcp add unity` for IvanMurzak/CoplayDev/batihandev variants; skill install path for unity-mcp-skills.
54. Backboard provider/preset: bot preset `backboard` via `OX_BASE_URL` if compatible; else documented integration steps.
55. Backboard R-CLI coexistence: skill/docs for when to use Backboard R-CLI vs ox.
56. Backboard memory bridge: optional skill/docs for portable memory export/import without cloud lock-in.
57. Backboard model routing bot: optional bot pointing at Backboard for multi-model routing with honest cost ledger.

**Reading the matrix:** ox sweeps rows 1–22 by design (they are plan.md requirements, not aspirations). Rows 23–28 are absorbed platform capabilities now in ox's charter. Row 29 is roadmap with an architecture seam reserved; row 30 (sandbox-as-tool seam) is shipped. Rows 31–38 are platform-specific capabilities ox absorbs or coexists with. Rows 35–38 apply only to Backboard (Bb) and ox. Rows 33–34 apply to non-coding platforms (Th, Hc, Cl = N/A).

### 1.1 Column verdicts

- **Claude Code** — the completeness benchmark: hooks, subagents, IDE, skills, memory, kernel sandbox all present. Its weaknesses are weight (232MB), single-vendor lock, cost/quota opacity, and quality-control lapses (#64171 silent edits, May 2026 regression postmortem). ox matches its core loop without matching its bloat.
- **Codex CLI** — the engineering benchmark: zero-dependency binaries and real kernel sandboxing. It used to lead on that axis outright; it no longer does — ox compiles enforced seatbelt/`bwrap` profiles too (§4). Codex's remaining edge is the *default*: it sandboxes by default, while ox's default profile is `off`. It also loses on provider openness at the preset level, approval UX, and config stability. ox copies its discipline and skips its consent theater.
- **Hermes Agent** — the ambition benchmark and cautionary tale (§3). Widest feature fan, weakest verification spine.
- **Aider** — the technique benchmark: edit formats, repo maps, per-message costs, LiteLLM breadth. Deliberately no shell autonomy means no agentic loop to speak of. ox inherits Aider's science inside a full loop.
- **opencode** — solid client/server multi-provider harness; Bun dependency and no memory/self-improvement story keep it out of featherweight-plus-memory territory.
- **Crush** — best-in-class TUI polish and mid-session switching; drifts on large refactors, no memory, no headless contract. The switching row is a tie worth keeping honest.
- **Antigravity** — impressive parallel-agent IDE with visual verification; closed fork, account-bound, forced updates, Gemini-only tuning. Everything ox is structurally unable to become, by choice.
- **Atomic Agent (At)** — the parallel-batch experiment: strict schema tool calling for small models, import adapters for CC/He/CX layouts, durable task store, and `ox serve` HTTP surface all absorbed into ox. Its value to ox is as a design donor, not a competitor — both share the same BYOK/local-model philosophy. ox now implements every absorbed capability natively.
- **TrueForge (TF)** — the enterprise harness: subagents (summary-return), sandbox-as-tool seam, agent presets CLI, and compaction hardening absorbed. Its K8s/cloud orientation makes it a complementary platform rather than a competitor; ox implements the local-featherweight counterpart of each absorbed pattern.
- **Browser-harness (BH)** — browser automation via MCP. ox does not embed Playwright; it consumes browser-harness through `ox mcp add browser-harness` template. Its contribution is the MCP-template install-path pattern.
- **Stagehand (Sh)** — browser SDK with act/observe/extract/agent primitives. Kept as external integration; ox absorbs skill + optional MCP wrapper design. No npm add to core.
- **Camoufox (Cf)** — anti-detect Firefox browser. ox documents it as an optional `OX_BROWSER_PROFILE=camoufox` backend for MCP profiles. Implementation lives in MCP server, not ox core. Production-caution status from upstream noted.
- **Trawl (Tr)** — self-hosted web fetching with challenge solving. ox documents optional MCP/client integration; Bun/Redis/Camoufox stack stays external.
- **OpenWhispr (Ow)** — local-first voice dictation. ox absorbs the voice integration path: pipe transcribed text into `ox -p -` or REPL; skill: "Dictate with OpenWhispr → send to ox". No Electron-embedding of Whisper.
- **Unity (Un)** — game development via MCP + skills. ox absorbs `ox mcp add unity` templates (IvanMurzak/CoplayDev/batihandev variants), skill install path for unity-mcp-skills, and example `.mcp.json` for Unity repos.
- **Thuki (Th)** — **N/A out of category.** Local overlay UI for AI assistance (Swift/SwiftUI, Apple Silicon only). Floating window, context capture, prompt handoff. Non-goal for overlay UI merge. Optional handoff docs: copy prompt / open cwd in ox from Thuki-style local ask. Apple Silicon-only constraint limits relevance.
- **HeyClicky (Hc)** — **N/A out of category.** Consumer GUI/cloud buddy product for coding assistance. Cloud-hosted, account-bound. Non-goal for consumer GUI/cloud product. Optional "export task to ox CLI" skill stub only if local API exists; otherwise document as out-of-scope with rationale. Not to be confused with Clicky web analytics (clicky.com).
- **Backboard (Bb)** — sovereign AI infrastructure (Ottawa-based, pre-seed from Mistral VP et al.). Products: Backboard Platform API (model routing, persistent memory/state, RAG, embeddings, tool calling, multi-agent, adaptive context), R-CLI (open coding harness), Backboard Studio. ox coexists: provider/preset via `OX_BASE_URL`/bot preset, R-CLI coexistence skill, memory bridge, model routing bot. `docs/integrations/backboard.md` documents setup, env vars, limits, and "what ox will never outsource" (approvals, denylist, evidence-gated memory, telemetry-free). ox = rug-proof local agent; Backboard = infra+platform with CLI wedge.
- **Clicky (Cl)** — **N/A out of category.** Web analytics SaaS (real-time tracking, heatmaps, goals). Not an AI coding agent. Documented as out-of-category vs ox. Do not build analytics into ox. Optional skill to install Clicky snippet in web project if trivial — lowest priority.

## 2. Where ox wins — mapped to the eight market gaps

Each research gap has exactly one owner in ox:

| Gap (research.md §7) | ox answer | Who else fails |
|---|---|---|
| 1. Install bloat | Zero npm runtime deps (no `node_modules`), `ox --version` <150ms. Source tree is ~1.5MB (`du -sk src`), not the originally-budgeted <250KB | CC 232MB; Hermes Python+uv+Node; opencode needs Bun; TrueForge K8s-scale |
| 2. Rug-pulls | BYO-everything: 8 provider targets, preset bots, Ollama-local, zero accounts, zero vendor tiers — nothing exists that can be sunset | Gemini CLI/Qwen/Roo/Windsurf/Amp users learned this the hard way; Thuki Apple-Silicon-only; HeyClicky cloud-bound |
| 3. Cost opacity | Per-turn cost line, running session total, published price table, `--max-cost` hard stop | Amp unpublished rates; CC quota drain; Hermes hidden aux billing; Backboard usage-based pricing |
| 4. Telemetry opt-out-not-opt-in | No telemetry code path exists; all state lives in `~/.ox/` and `.agent/` under the user's control | Closed forks, forced updates; Antigravity; HeyClicky cloud model |
| 5. Weak scriptability/CI semantics | `-p`, `--json` event lines, stdin pipes, exit contract 0/1/2/3 documented in plan.md §13 | Only CC/CX take this seriously; Crush/Aider partial |
| 6. Local/offline nominal-not-real | First-class Ollama bot + adaptive context budgets that shrink below 64K windows; small models are a supported class | Hermes 64K floor; Antigravity account-bound; OpenWhispr Electron dependency |
| 7. Fragmented extension standards | Native Agent Skills parsing, scans `.claude/skills` + `.agents/skills`, reads Claude `.mcp.json` verbatim, reads AGENTS.md *and* CLAUDE.md — every ecosystem's dialect spoken at birth | Everyone implements one dialect and a converter wish-list; Unity MCP formats differ |
| 8. Dishonest context management | Always-visible estimated-%-remaining meter; 25,000-**character** (~6k-token) tool-output caps; compaction at 75% with a written keep-contract (decisions/files/recent-4 turns) | No tool in the matrix shows an honest number |

Three of these deserve elaboration:

- **Rug-proofing (gap 2) is architectural, not rhetorical.** ox holds no accounts, no entitlements, no server-side state. A provider can vanish tomorrow and `/bot` points elsewhere; an agent vendor can die entirely and the skills/memory/MCP configs remain portable because they were never ox's formats to begin with. Thuki's Apple-Silicon lock and HeyClicky's cloud dependency are exactly the single-points-of-failure ox avoids.
- **The honest meter (gap 8) changes behavior, not just display.** When users see estimated context remaining every turn, they compact deliberately instead of discovering truncation retroactively. The 25k output caps and the written compaction keep-contract make the number trustworthy rather than decorative.
- **Standards interop (gap 7) compounds.** Reading `.mcp.json`, AGENTS.md, CLAUDE.md, and SKILL.md natively means every ecosystem tutorial, marketplace listing, and team convention document works for ox on day one — distribution without a marketing budget. Unity MCP's custom format is handled via `ox mcp add unity` templates rather than native parsing, keeping the scope bounded.

Plus one win that isn't a gap but a stance: **hard provider pinning**. When a key is missing or wrong, ox fails loudly naming the exact env var. A fallback chain does exist, but it is never silent: every switch emits a non-dismissible `model_switch` event, and `fallback_policy.cost: free_only` refuses paid fallbacks — a contrast to Backboard's cloud-routing model and HeyClicky's opaque cloud billing.

### 2.1 Where ox loses or ties today

Stated plainly, because positioning docs that only win are fiction:

- **Kernel sandboxing: no longer a loss, but narrower than Codex.** This entry previously claimed Codex's Seatbelt/Landlock/bwrap enforcement "has no v0 equivalent" — untrue, and it contradicted §1 row 22 in the same file. ox compiles real seatbelt (macOS) and `bwrap` (Linux) profiles and enforces them on every spawned command via `prepareSandbox()`; the deny is kernel-enforced. What is genuinely narrower than Codex: the default profile is `off` (Codex sandboxes by default), there is no kernel-level host allow-list on either platform (macOS `sandbox-exec` cannot express one; `bwrap` has no host primitive), and only *child* processes are confined — the agent process itself never is. Approvals + allowlists + timeouts also remain a lighter layer underneath. Backboard's sandbox posture differs and is documented in coexistence notes, not merged.
- **Hooks & subagents: shipped, narrower breadth.** Hooks ship in v0 with all **six declared events firing** — `PreToolUse`, `PostToolUse`, `PreLLM`, `PostLLM`, `SessionStart`, `SessionStop` all have call sites in `src/agent.js`, proven end-to-end by `test/hook-events.test.js`. `PreLLM`/`PostLLM` are fire-and-forget (dispatched per stream attempt, not awaited, drained at teardown) because blocking them would add up to 2 × `timeoutMs` of fail-open latency to every LLM call; the other four are awaited serially. The gap versus Claude Code is event *breadth*, not dead names: ox has no turn-start/end, approval-requested, or user-prompt event. Hooks are also fail-open (timeout or error resolves to `allow`, stdin is closed), so they are a customization surface, not a security control. Subagents ship in v0 (`src/subagent.js`) as summary-returning components. Claude Code's 27 hook events and deeper subagent orchestration remain broader; closing that gap is roadmap, not parity.
- **IDE: deferred loss.** Claude Code and Antigravity live where many users work. ox bets the terminal remains the automation surface; if that bet is wrong, the CLI core still serves it.
- **Edit-format science: tie.** Aider's 12 auto-matched formats exceed ox's exact→fuzzy ladder for weak models. ox covers frontier models well and small models adequately; udiff support is a known extension point.
- **TUI polish: tie.** Crush's Bubble Tea interface is lovelier than ANSI-pragmatism will ever be. ox optimizes for scriptability first, beauty second.
- **Parallel visual agents: loss.** Antigravity's Manager View with Chrome-based visual verification does something ox does not attempt; teams orchestrating five agents against a browser should use it, not wait for ox.
- **Browser automation: partial tie, integration approach.** Browser-harness and Stagehand own browser interaction natively. ox consumes them via MCP templates — a working but indirect path. For browser-heavy workflows, the user installs the MCP template and gets full capability. **Additionally, ox now ships 7 native operator tools (open_url, open_path, open_app, open_window, type_text, screenshot, notify) for computer control including browser interaction.**
- **Voice: shipped native MCP tools.** 9 voice MCP tools: speech_to_text, dictate, push_to_talk, voice_conversation, transcribe_file, text_to_speech, synthesize_file, list_voices, voice_clone. Local STT via whisper, TTS via kokoro. 3 platform adapters: cli, telegram, discord. OpenWhispr still works as alternative pipe → ox.
- **Ecosystem breadth: tie trending to loss.** Goose's 70+ extensions and CC's plugin marketplaces dwarf v0's surface — which is precisely why ox speaks their formats instead of growing a proprietary one.
- **Platform scale: loss.** TrueForge's K8s/enterprise infrastructure and Backboard's platform API offer multi-agent orchestration and model routing at a scale ox does not attempt and will not become. ox coexists with both via documented integration paths.

## 3. Platform comparisons

### 3.1 ox vs Hermes Agent — the closest cousin

Hermes is ox's nearest neighbor in ambition: multi-provider, skill-based, memory-owning, MIT-licensed, wildly popular (~234k stars). It is also the field's largest collection of documented failure modes, which makes it the most valuable design reference available: every wound is public, reproducible, and specific.

Hermes is ox's nearest neighbor in ambition: multi-provider, skill-based, memory-owning, MIT-licensed, wildly popular (~234k stars). It is also the field's largest collection of documented failure modes. ox's design can be read as seven direct counters:

| Documented Hermes failure | ox counter-design (plan.md §) |
|---|---|
| Tiny frozen memory: MEMORY.md ~2.2K chars injected verbatim per session; memory tool has add/replace/remove but **no read** | Tiered `.agent/` store: index ≤150 lines/20KB auto-loaded + `topics/*.md` detail notes + dated `episodes/`; full list/get/add/update/search via the memory tool; progressive injection instead of frozen blocks (§8) |
| Unverified skill births — "It always thinks it did a good job. ALWAYS." Failed procedures encoded as skills; flooding with no pruning/conflict detection (#12877) | Partially evidence-gated persistence: `episode promote` requires ≥1 lesson AND (`score >= 6` OR `verified`); `memory_add` now refuses credential-shaped content (provider key prefixes, JWTs, PEM blocks, long bearer tokens, inline secret assignments) and prompt-injection payloads before writing `.agent/MEMORY.md`, which is re-injected every turn — but it still validates only `type` and a non-empty `statement`, with no evidence or citation requirement; skills imported, never self-authored, in v0; metabolism (usage stats, decay, dedupe, conflict detection) designed into the format (§8) |
| Silent paid fallbacks (#7559/#45782): local users billed for Gemini Flash, $145 surprises | Hard pinning: wrong/missing key = loud error naming the env var; a fallback chain *does* exist (`fallback_bots` / `aux_bot`) but never silent — each switch emits a non-dismissible `model_switch` event, and `fallback_policy.cost: free_only` refuses paid fallbacks (§3) |
| SQLite state.db corruption (#5563) | Append-only JSONL everywhere (sessions + memory journal); torn tail line truncates with a warning, never fatal; greppable with stock tools (§11) |
| ≥64K context floor; 8B models "can't tool-call" | Adaptive context: repo-tree budget, output caps, and compaction threshold scale to the model's real window; lean constant-size tool schemas; verified against small local Ollama models (§7) |
| Environment hallucination — claimed a cloud container while on local WSL2 | System prompt assembled from probed ground truth (real cwd, git root/branch, platform, date) every session — the model is told where it is, never asked (§14) |
| Cost opacity: hidden aux-model spend, unpublished rates | Per-turn cost line + cumulative ledger from a published price table; `--max-cost` hard-stops with a summary; `/cost` anytime (§16) |

**Credit where due — what ox copies from Hermes anyway:** SKILL.md-native skills with progressive disclosure, slash-command-per-capability UX, headless-first design, and the proof that users want agent memory bad enough to tolerate 2.2KB of it.

#### 3.1.1 Scorecard

| Dimension | Winner | Why |
|---|---|---|
| Memory capacity & ergonomics | **ox** | Tiered `.agent/` vs 2.2KB frozen injection |
| Self-improvement trustworthiness | **ox** | Evidence gate vs capture-everything |
| Provider integrity | **ox** | Loud pinning vs silent paid fallback |
| Storage durability | **ox** | Append-only JSONL vs SQLite state.db |
| Small/local model support | **ox** | Adaptive budgets vs 64K floor |
| Cost transparency | **ox** | Ledger + caps vs hidden aux billing |
| Skills UX maturity | ox | `/learn`, self-authoring, scanning — richer surface (with worse judgment) |
| Headless machine surfaces | Hermes | `-q` + API server + ACP beat ox's `-p`/`--json` for breadth (exit-code contract still cleaner in ox) |
| Messaging gateway / generalist reach | Hermes | 22 platforms vs ox's coding-first focus |
| Community scale | Hermes | ~234k stars |

### 3.2 ox vs Atomic Agent (At) — the parallel-batch experiment

**Repo:** https://github.com/AtomicBot-ai/atomic-agent · License: MIT · Stack: Python/Node
**What it is:** A coding agent focused on parallel read-only tool batches, strict schema-constrained tool calling for small local models, and import adapters for migrating from Claude Code, Hermes, and Codex configurations.
**Overlap with ox:** Both target BYOK multi-provider, local model support, skills/MCP interop. Atomic's parallel read batches and strict schema approach complement ox's agent loop.

| Atomic Agent capability | ox status |
|---|---|
| Parallel read-only tool batches | **Absorbed** into ox agent loop — concurrent read-only tool calls within a turn |
| Strict schema tool calling for small models | **Absorbed** — lean constant-size JSON schemas + adapter-side validation |
| Import adapters for CC/He/CX layouts | **Absorbed** as `ox import` for skills/MCP/memory configs |
| Durable task store | **Absorbed** — `~/.ox/tasks/` |
| HTTP surface | **Absorbed** — `ox serve` (Node http only, zero deps) |
| Browser | **Shipped** 7 operator tools: open_url, open_path, open_app, open_window, type_text, screenshot, notify. Full Playwright/CDP via MCP templates (browser-harness, Stagehand) |

**Credit where due:** Atomic Agent's pattern of strict schema enforcement on small models directly informed ox's tool schema design. Its import adapter concept is now `ox import`. Both share the same BYOK/local-model philosophy — competitors by accident, collaborators by design.

**Non-goal:** Full browser engine (Playwright/CDP) in ox core. Native operator tools provide computer control; browser automation stays external via MCP templates.

### 3.3 ox vs TrueForge (TF) — the enterprise harness

**Repo:** https://github.com/truefoundry/trueforge · License: Apache-2.0 · Stack: Python/Go/K8s
**What it is:** Enterprise AI developer platform with subagents, sandbox-as-tool, agent presets, and compaction/reconnect for long runs. Products: TrueForge Platform (cloud), R-CLI (open harness), Studio (UI).
**Overlap with ox:** Subagents (summary-return), sandbox seam, agent presets (`~/.ox/agents/*.json`), session compaction hardening.

| TrueForge capability | ox status |
|---|---|
| Subagents (summary-return) | **Absorbed** — reserved per Anthropic guidance; summary-returning architecture in place |
| Sandbox-as-tool seam | **Absorbed and shipped** — the approval gate is the seam, and `src/sandbox.js` compiles enforced seatbelt/`bwrap` profiles through it |
| Agent presets CLI | **Absorbed** — `ox agent list\|save\|use\|delete` and `ox bots` |
| Session compaction/reconnect for long runs | **Absorbed** — hardening for `ox serve` continuity |
| Cloud/K8s platform | **Non-goal** — ox is local-featherweight by design |
| Studio UI | **Non-goal** — terminal-first |

**Credit where due:** TrueForge's sandbox-as-tool seam concept and subagent summary-return pattern are directly adopted in ox's architecture. TrueForge's enterprise orientation (K8s, cloud, multi-tenant) makes it complementary rather than competitive.

**Non-goal:** Cloud platform, Kubernetes orchestration, Studio UI. ox runs locally with zero server-side state.

### 3.4 ox vs Browser-harness (BH) — browser via MCP

**Repo:** https://github.com/browser-use/browser-harness · License: MIT · Stack: Python/Playwright
**What it is:** Browser automation harness with CDP connection, structured tools (navigate, click, fill, extract), and eval framework.
**Overlap with ox:** Browser capability via MCP only. ox does not embed Playwright.

| Browser-harness capability | ox status |
|---|---|
| Browser automation (CDP, structured tools) | **MCP integration** — `ox mcp add browser-harness` template. **Native operator tools** (open_url, type_text, screenshot) provide lightweight computer control without Playwright |
| Skill install instructions | **Absorbed** into ox skill-path documentation |
| Default mcpPolicy, browser tools=ask | **Absorbed** into ox doctor notes for CDP failures |
| Eval framework | **Non-goal** — ox is an agent, not a testing framework |

**Credit where due:** Browser-harness demonstrates that browser tools can be exposed as structured MCP tools. ox adopts the MCP-template integration pattern rather than reimplementing browser automation. **ox now also ships native operator tools for computer control (approval-gated).**

**Non-goal:** Embedding Playwright, CDP protocol handling, or browser engine in ox core. Full browser automation stays external via MCP. **Native operator tools provide approval-gated computer control (open_url, type_text, screenshot, etc.) without browser engine.**

### 3.5 ox vs Stagehand (Sh) — browser SDK

**Repo:** https://github.com/browserbase/stagehand · License: MIT · Stack: TypeScript/Playwright
**What it is:** Browser automation SDK with `act`/`observe`/`extract`/`agent` primitives. Runs on local Chromium or Browserbase cloud.
**Overlap with ox:** Browser automation primitives. Kept as external integration.

| Stagehand capability | ox status |
|---|---|
| Browser automation primitives | **MCP wrapper** — skill + optional MCP wrapper exposing act/observe/extract/agent. **Native operator tools** (open_url, type_text, screenshot) provide lightweight alternative |
| Local Chromium | **Documented** — local vs cloud modes |
| Browserbase cloud | **Documented** — cloud mode requires user account |
| npm dependency in ox core | **Non-goal** — zero npm deps; full browser automation stays external. Native operator tools are zero-dep |

**Non-goal:** Browser SDK in ox core. ox stays zero-dependency; Stagehand integration is user-installed via skill/MCP template.

### 3.6 ox vs Camoufox (Cf) — anti-detect browser

**Repo:** https://github.com/daijro/camoufox · License: MIT · Stack: Python/Firefox
**What it is:** Anti-detect Firefox browser for automation. Avoids fingerprinting detection.
**Overlap with ox:** Optional browser backend for MCP profile.

| Camoufox capability | ox status |
|---|---|
| Anti-detect Firefox | **Optional backend** — `OX_BROWSER_PROFILE=camoufox` |
| Fingerprint evasion | **Non-goal** — ox does not fingerprint; browser stays MCP-level |
| Production deployment | **Caution** — upstream production-caution status noted in docs |

**Non-goal:** Browser engine in ox core. Camoufox integration is user-installed, documented as optional anti-detect backend for MCP profiles. Production caution from upstream flagged.

### 3.7 ox vs Trawl (Tr) — self-hosted fetching

**Repo:** https://github.com/germondai/trawl · License: MIT · Stack: Bun/Redis/Camoufox
**What it is:** Self-hosted web fetching with challenge solving (CAPTCHA, Cloudflare). Hard fetches for difficult sites.
**Overlap with ox:** Optional MCP/client for self-hosted instance.

| Trawl capability | ox status |
|---|---|
| Self-hosted web fetching | **MCP/client docs** — optional integration for talking to self-hosted Trawl |
| CAPTCHA/Cloudflare solving | **Non-goal** — ox does not solve challenges; stays in-agent |
| Bun/Redis/Camoufox stack | **Non-goal** — ox stays zero-dependency; Trawl stack lives externally |

**Non-goal:** Web fetching in ox core. Trawl integration is documented as optional MCP/client; Bun/Redis/Camoufox dependency stays outside ox.

### 3.8 ox vs OpenWhispr (Ow) — voice path

**Repo:** https://github.com/OpenWhispr/openwhispr · License: MIT · Stack: Electron/Whisper.cpp
**What it is:** Local-first voice dictation app. Speech-to-text via Whisper.cpp, push-to-talk, paste-to-ox workflow.
**Overlap with ox:** Voice front-end integration.

| OpenWhispr capability | ox status |
|---|---|
| Local STT via Whisper.cpp | **Integration path** — pipe transcribed text into `ox -p -` or REPL |
| Push-to-talk dictation | **Integration path** — skill: "Dictate with OpenWhispr → send to ox" |
| TTS | **Non-goal** — ox has no voice output; stays text-terminal |
| Electron embedding | **Non-goal** — do not Electron-embed Whisper in ox |

**Credit where due:** OpenWhispr's push-to-talk → paste-to-ox workflow is the voice integration pattern ox adopts. The skill install path for "Dictate with OpenWhispr" lives in `.agents/skills/` and routes transcribed text into ox's headless mode.

**Non-goal:** Voice rendering (TTS), STT engine, Electron embedding. ox remains a text terminal; voice stays external.

### 3.9 ox vs Unity (Un) — game development MCP

**Repos:** IvanMurzak/Unity-MCP, CoplayDev/unity-mcp, batihandev/unity-mcp-skills, Unity official `com.unity.ai.assistant`
**What they are:** Unity Editor MCP servers and skill packs for AI-driven game development.
**Overlap with ox:** Game development via MCP + skills.

| Unity capability | ox status |
|---|---|
| Unity Editor MCP server | **MCP templates** — `ox mcp add unity` (and variant configs for IvanMurzak/CoplayDev/batihandev) |
| Skill packs for game dev | **Skill install path** — unity-mcp-skills installable into `~/.agents/skills/` |
| Example `.mcp.json` for Unity repos | **Documented** — shipped in example configs |
| Unity official relay | **Documented** — noted as variant in MCP template |

**Credit where due:** Unity MCP shows that editor-integrated agents can expose rich tool sets via MCP. ox adopts the template-config approach (`ox mcp add unity`) rather than building Unity-specific logic into the core.

**Non-goal:** Unity Editor embedding, game engine integration. ox interacts with Unity exclusively through MCP templates and skill paths.

### 3.10 ox vs Thuki (Th) — out of category

**Repo:** https://github.com/quiet-node/thuki · License: MIT · Stack: Swift/SwiftUI (Apple Silicon only)
**What it is:** Local overlay UI for AI coding assistance. Floating window, context capture, prompt handoff.
**Verdict:** **Non-coding-agent platform. Out of category for comparison.**

| Thuki capability | ox status |
|---|---|
| Floating overlay window | **N/A** — non-coding UI layer; not an agent |
| Context capture | **Partial** — ox reads context from filesystem probes, not overlay |
| Prompt handoff | **Partial** — ox can receive text from any source; no native handoff protocol |
| Apple Silicon only | **N/A** — platform constraint makes direct comparison invalid |

**Non-goal:** Overlay UI merge. ox does not provide floating window functionality. Optional handoff docs describe how to copy a prompt or open the current working directory in ox from a Thuki-style local ask. Apple Silicon-only constraint limits the overlap audience.

### 3.11 ox vs HeyClicky (Hc) — voice + computer control

**Product:** heyclicky.com
**What it is:** Consumer GUI/cloud buddy product promising voice + computer control for coding assistance. Cloud-hosted, account-bound, opaque billing.
**Verdict:** **Direct competitor on voice + computer control. ox is local, BYOK, approval-gated.**

| HeyClicky capability | ox status |
|---|---|
| Voice input (STT) | **Shipped** — 9 voice MCP tools: speech_to_text, dictate, push_to_talk, voice_conversation, transcribe_file. Local STT via whisper backend. |
| Voice output (TTS) | **Shipped** — text_to_speech, synthesize_file, list_voices, voice_clone. Kokoro backend. |
| Computer control | **Shipped** — 7 operator tools: open_url, open_path, open_app, open_window, type_text, screenshot, notify. All approval-gated. |
| Multi-platform voice | **Shipped** — 3 platform adapters: cli, telegram, discord |
| Cloud-hosted GUI | **Non-goal** — ox is terminal-first, not a consumer GUI |
| Account-bound access | **Won** — ox is zero-account, zero-entitlement by design |
| Data privacy | **Won** — all voice processing local, zero telemetry, no cloud dependency |
| Cost transparency | **Won** — published price table, per-turn cost line, --max-cost hard stop |
| BYOK multi-provider | **Won** — 13 bot presets + custom bots, 8 provider targets, Ollama local |

**ox's answer to HeyClicky:** Same voice + computer control promise, but everything runs locally. No cloud account. No opaque billing. Your data never leaves your machine. Approval gates on every action. Bring your own API key or use free local models.

**Non-goal:** Consumer GUI/cloud product. ox is terminal-first, BYOK, zero-account. Not to be confused with Clicky web analytics (clicky.com).

### 3.12 ox vs Backboard (Bb) — infra with CLI wedge

**Product:** backboard.io — sovereign AI infrastructure (Ottawa-based, founders Rob Imbeault/Jonathan Murray, pre-seed from Mistral VP et al., public-source claims). Products: Backboard Platform API (model routing, persistent memory/state, RAG, embeddings, tool calling, multi-agent, adaptive context), R-CLI (open coding harness), Backboard Studio. Deploy modes: cloud/private cloud/on-prem/on-device. Pricing: Free / Education $5 / Developer $20 / Scale $400 + usage.
**Verdict:** **Complementary platform. Coexistence, not competition.**

| Backboard capability | ox status |
|---|---|
| Model routing (Platform API) | **Provider/preset** — Backboard as OpenAI-compatible endpoint via `OX_BASE_URL`; bot preset `backboard` if compatible; else documented integration steps |
| R-CLI (open harness) | **Coexistence** — skill/docs: when to use Backboard R-CLI vs ox |
| Persistent memory/state | **Memory bridge** — optional skill/docs for portable memory export/import without cloud lock-in |
| Multi-agent, adaptive context | **Non-goal** — ox is single-agent, local-first |
| Model routing bot | **Optional** — bot preset pointing at Backboard for multi-model routing with honest cost ledger |
| Cloud/on-device deployment | **N/A** — ox is local only; Backboard's cloud modes are ox's non-goal |

**`docs/integrations/backboard.md`** documents: setup, env vars, limits, and "what ox will never outsource" (approvals, denylist, evidence-gated memory, telemetry-free).

**Comparison framing:** Backboard = sovereign AI infrastructure with a CLI wedge. ox = rug-proof local agent. They can coexist on the same task — Backboard for multi-model routing at scale, ox for the agentic loop with verified edits and honest economics. ox never sends its approvals or denylist to any cloud; Backboard is an optional provider endpoint, not a dependency.

### 3.13 ox vs Clicky (Cl) — out of category

**Product:** clicky.com
**What it is:** Web analytics SaaS (real-time tracking, heatmaps, goals). Not an AI coding agent.
**Verdict:** **Out of category. Not an AI coding agent.**

| Clicky capability | ox status |
|---|---|
| Real-time web analytics | **N/A** — analytics SaaS, not a coding agent |
| Heatmaps, goals, tracking | **N/A** — completely unrelated domain |
| AI coding assistance | **N/A** — Clicky does not provide this |

**Non-goal:** Analytics in ox. Documented as out-of-category vs ox. Do not build analytics into ox. Optional skill to install Clicky snippet in a web project if trivial — lowest priority.

## 4. Where ox deliberately doesn't compete (yet)

- **IDE integration (✗).** The terminal is the product. An editor extension only makes sense after the core loop, session format, and approval model are proven stable — otherwise ox ships another half-integrated panel. Roadmap, not promise.
- **Kernel sandbox enforcement: shipped, with three honest gaps.** This bullet previously read "Kernel sandboxing (✗) — Codex wins this row today", which contradicted §1 row 22 (`✓`) in this same file. Row 22 was the accurate one, so the `✗` is the part corrected here. `SANDBOX_PRESETS` = `off`, `workspace`, `read-only`, `strict` (`src/sandbox.js:64`). `src/tools/exec.js` and `src/mcp.js` both call `prepareSandbox()`, which on macOS emits `/usr/bin/sandbox-exec -f <compiled>.sb` and on Linux emits a `bwrap` argv. `strict` sets `restrict_network: true`, compiling `(deny network*)`; verified live — under that compiled profile `curl https://example.com` → `HTTP=000` exit 6, and the same curl unsandboxed → `HTTP=200` exit 0. **The deny is kernel-enforced, not a policy string.** The three gaps that remain, none of which is "no enforcement": (1) **the default profile is `off`** — a plain `ox` run spawns unsandboxed, so this is opt-in; (2) **the allow-list is userspace-only** — `network_allow` is matched against the normalised host in-process, because macOS `sandbox-exec` cannot compile `(allow network-outbound (remote ip …))` (it refuses: *"host must be * or localhost in network address"*), and bwrap has no host/port primitive (`--unshare-net` is all-or-nothing), so a spawned `curl` is fully denied or fully allowed, never host-scoped; (3) **the agent process itself is never confined** — Seatbelt/bwrap wrap *child* processes, so an in-process tool call, plugin, or dependency is unconstrained. `bwrapGaps()` reports anything it structurally cannot apply rather than dropping it silently.
- **Hooks & subagent ecosystems: shipped, narrower breadth.** This bullet previously led with `(~)`, which contradicted §1 row 19 (`✓`) and §2.1 in the same file; the six events really are wired (each has a live call site in `src/agent.js`, and `test/hook-events.test.js` is 15/15 green). The `~` only ever described event *breadth*, not a dead surface. Hooks shipped in v0 with all **6 declared events wired** (`PreToolUse`, `PostToolUse`, `PreLLM`, `PostLLM`, `SessionStart`, `SessionStop` — see the call sites in `src/agent.js` and `test/hook-events.test.js`); `PreLLM`/`PostLLM` are fire-and-forget, the rest awaited serially. Subagents shipped in v0 (`src/subagent.js`) as summary-returning components (per Anthropic guidance). TrueForge's subagent and sandbox seam patterns absorbed in architecture and shipped. What remains `→` rather than shipped is *breadth*: ox declares no turn-start/end, approval-requested, or user-prompt event, against Claude Code's 27. Hooks are also fail-open by design (timeout or error resolves to `allow`), so they are a customization surface, not a security control — the security control is §4's kernel sandbox.
- **Marketplace (✗, possibly forever).** Skills are plain directories any agent can read. ox deliberately adds no registry, no ranking economy, no upload pipeline — anti-lock-in is a feature, and the existing skills.sh/SkillsMP catalogs already work.
- **Browser engine (✗).** Browser interaction happens via MCP templates (browser-harness, Stagehand, Camoufox) or user-installed skills. ox never embeds Playwright, Chromium, or Firefox. The terminal stays the agent surface.
- **Voice rendering (✗).** ox is a text terminal. STT/TTS is handled by external tools (OpenWhispr and others); ox receives transcribed text via `ox -p -` or REPL. No voice output.
- **Analytics/telemetry (✗, by design).** Clicky and similar products serve a completely different function. ox deliberately builds no analytics — it doesn't even track its own usage (see §1 row 18).

**Sequencing, with gates.**

| Capability | Target | Gate that must pass first |
|---|---|---|
| Core loop, providers, tools, memory, skills, MCP, sessions | **v0** (this plan) | full test suite in plan.md §17 green |
| Hooks (event surface) | **v0** (partially shipped) | all 6 declared events wired and tested; `PreLLM`/`PostLLM` fire-and-forget, the rest awaited serially |
| Subagents (summary-returning) | **v0** (shipped) | `src/subagent.js`, context meter validated |
| Kernel sandbox enforcement (seatbelt/bwrap profiles) | **shipped** (§4) | default profile flipped from `off` to `workspace`; agent process confined, not just children |
| IDE bridge | v1+ | session format frozen; headless JSON contract adopted by ≥1 external tool |

Nothing enters the roadmap without an owner section already present in plan.md's architecture — additions are bolt-ons, never rewrites. The pattern extends to absorbed platforms: Atomic Agent's patterns arrive as features, not as platform dependencies.

The pattern: ox competes everywhere a CLI can win outright, concedes gracefully where incumbents have years of surface area (anticipating Antigravity's visual agents, Crush's TUI, Cloud-hosted browsers), and reserves the seams to close those gaps when the core earns it.

## 5. Objections, answered

**"Why another coding agent?"**
Because all eight research gaps are open simultaneously and no incumbent has an incentive to close more than one or two. Featherweight + BYOK + honest economics + evidence-gated memory is a package, not a feature. Twelve additional platforms (from Atomic Agent to Clicky analytics) confirm that no single tool covers the field — ox absorbs what's useful and ignores what's out of category.

**"Isn't a zero-dep budget a gimmick once real features land?"**
Features cost code, not dependencies, and the source tree is ~1.5MB — the original <250KB budget was aspirational and is *not* CI-enforced (no source-tree size test exists). What holds the line is zero npm runtime deps: growth pays in bytes of readable source, never in `node_modules`. Codex proves zero-dep scales to production.

**"What happens when Anthropic ships all of this inside Claude Code?"**
Then users get it behind a subscription, on Claude-only models, at 232MB, with telemetry posture as-is — and ox users keep BYO providers, local models, and their portable skills either way. The hedge only matters if it exists before the rug. This is precisely why Thuki's Apple-Silicon lock, HeyClicky's cloud dependency, and OxClicky's account-bound model are all non-goals for ox.

**"No marketplace means no network effects."**
Skills are plain directories read from four standard locations; skills.sh/SkillsMP's 100k+ catalog already works. Network effects accrue to the standard, and ox rides them instead of taxing them. Unity MCP skills work the same way — they live in `.agents/skills/` and ox reads them natively.

**"Isn't hard pinning worse UX than smart fallback?"**
Fallback is how $145 surprise bills and Gemini-Flash-on-WSL2 happen (#7559/#45782). Loud failure names the fix (`export XAI_API_KEY=…`); silent fallback names a charge. One of those respects the user. Backboard's model routing offers a different trade-off (routing across providers) — ox documents coexistence rather than merging, keeping its own hard-pinning intact for local/zero-account workflows.

**"Small local models are weak — why support them?"**
Because external-signal verification (tests/lint/compile) substitutes for raw model judgment per Self-Debugging's 10× repair result, and because "offline works" is the strongest possible answer to gap 2. Weak-but-yours beats strong-and-revocable for a large class of tasks. Atomic Agent's strict schema approach for small models is absorbed into ox's tool-calling layer.

**"Why not just use Codex or Antigravity?"**
Codex locks you to OpenAI's pricing and consent theater. Antigravity locks you to Google's account system, forced updates, and Gemini-only tuning. ox gives you the same core loop with none of those lock-in surfaces — and you can still point it at Codex or Gemini if you want.

**"Why should I trust a zero-dep agent?"**
Because trust comes from auditability, not binary size. Every state file is plain JSONL or markdown. Every decision lands in a session log. Every tool call is approval-gated by default. The small footprint is a consequence of zero dependencies, which means no supply-chain attack surface from `node_modules`.

---

*One-sentence positioning: ox is what Codex would be if it trusted you with providers, what Hermes would be if it verified its memories, what Atomic Agent would be if it ran the full loop, what TrueForge would be if it lived locally, and what Claude Code would be if it fit in a floppy disk.*

## 6. Maintaining this document

- **Re-verify quarterly** against live products; this field shipped five deaths in fourteen months and will ship more.
- Every `~` note cites evidence in [research.md](research.md); when research updates, update both or neither.
- ox-column marks are CI claims: any ✓ without a green test behind it is reverted to `~` with a plan link.
- New competitor rows require: install size, provider policy, telemetry posture — the three columns most tools lie about.
- Date-stamp every material revision in the table header line.
- Pricing cells: quote per-Mtok rates from provider pages, never aggregator guesses; note peak/off-peak where the provider does (DeepSeek).
- When a competitor ships a row-1–22 capability credibly, re-run the relevant plan.md test against it before touching marks.
- **Non-coding platforms (Th, Hc, Cl):** re-evaluate only if they ship a coding-agent mode. Until then, N/A marks stand.
- **Absorbed platforms (At, TF, BH, Sh, Ow, Un, Bb):** re-check that absorbed features remain in ox's codebase and aren't quietly reverted.
- Keep §2.1 (losses) as long as §2 (wins); the moment the losses list shrinks by wishful thinking, this document stops being trustworthy.
- Cross-link: any capability added to ox gets a row here on the same day it ships, marked ✓ with its test name.
