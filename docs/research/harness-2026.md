# A harness that works with any model (research notes, October 30, 2026)

The same model scores very differently in different harnesses, so the harness is
part of the product, not plumbing. What the 2026 papers and practitioner reports
show, what ox already does, what this round added, and what is next.

## What the evidence says

| Finding | Source |
|---|---|
| Claude Opus 4.6 scores 58.0% to 76.4% on Terminal-Bench 2.0 depending only on the harness; LangChain raised GPT-5.2-Codex from 52.8% to 66.5% by changing the harness alone. | [Substack summary](https://aipractitioner.substack.com/p/from-prompt-engineering-to-harness) |
| Model rankings flip across harnesses (Claude +7.94 under OpenHands, −30.16 under PI). Kimi issues malformed tool calls and does best where failures come back in a usable form; a missing tool timeout blocked one run for 40 minutes. A vendor's own harness is not reliably its best. | [Finding the Right Fit, arXiv 2610.00917](https://www.alphaxiv.org/abs/2610.00917) |
| Context management alone (shortening older tool results as the window fills, reacting to stalled work) raised fully solved SWE-bench Verified tasks from 43 to 72 under a 20k-token window, for several models without retuning. | [Same Model, Different Harness, arXiv 2608.26218](https://arxiv.org/abs/2608.26218) |
| An automatically evolved harness went from 69.7% to 77.0% on Terminal-Bench 2, beating Codex-CLI's 71.9%; the gains came from tools, middleware and long-term memory, not the system prompt, and transferred to other model families (+5 to +10 points). | [Agentic Harness Engineering, arXiv 2604.25850](https://arxiv.org/abs/2604.25850) |
| Durable states, phase-local context, checked transitions and runbooks took GPT-5.5 from 83.1% to 92.1% on Terminal-Bench 2.1, at about $15 against $575. | [StateM, arXiv 2608.15089](https://arxiv.org/abs/2608.15089) |
| Six harness responsibilities: observation, context, control, action, state, verification. Stronger model generations still matter, so the harness is not the whole story. | [Survey, arXiv 2606.20683](https://arxiv.org/abs/2606.20683) |
| Programmatic tool calling (tools as typed code stubs) matched or beat JSON tool calling in 11 of 14 models. | [The Bitter Lesson of Tool Calling, arXiv 2608.06370](https://arxiv.org/abs/2608.06370) |
| A 100-line bash-only agent reaches 65% to 74% on SWE-bench Verified across models: a small, uniform action space travels well between models. | [mini-swe-agent](https://github.com/swe-agent/mini-swe-agent) |
| Most cross-model tool-calling failures come from templates, parsers and providers: repair JSON, coerce types to the schema, reject unknown names, return precise errors, 2–3 retries, parse tool calls leaked into text. | [HonestHarness notes](https://github.com/loganw234/HonestHarness/blob/main/Research/open-weight-harness-research.md) |
| Weaker models edit more reliably with whole-file or unified-diff formats than with search/replace blocks. | [Aider edit formats](https://aider.chat/docs/more/edit-formats.html) |

## Amoeba (useamoeba.com)

A multiplayer IDE for a team and its coding agents (early access, macOS, free):
local-first sessions shared over WebSocket, every agent's owner, files and
progress in one place, overlapping edits caught before they happen, memory tied
to files in the repo and flagged when that code moves, per-session permissions
and approval gates, any ACP harness or subscription, and a model router
("Jev") that picks a model per task, keeps the cache warm and can be pinned in
the message (`[jev: only use Opus]`). [Site](https://useamoeba.com), [about](https://useamoeba.com/about).

For ox: ox already has the router (auto model per message), approvals, the
Island's view of every agent, and ACP. Worth taking: memory anchored to files
and invalidated when they change; overlap detection between agents editing the
same files; a model pin written in the message itself.

## ox against this

| Practice | ox |
|---|---|
| Old tool outputs shortened as context fills | yes (`src/context-mask.js`, arXiv 2508.21433) |
| Stalled / repeated calls detected, model escalated | yes (doom-loop, SWE-Router escalation) |
| Deferred tool loading for large tool sets | yes (`load_tools`) |
| Schema pruning for small windows | yes |
| Tool timeouts returned to the model | yes (bash `timeout_ms`) |
| **JSON repair, type coercion, name resolution, precise errors** | **added: `src/tool-repair.js`** |
| **Tool calls written into the reply text (Hermes, Llama, Mistral, bare JSON)** | **added: run instead of shown** |
| Per-family reasoning preservation (Kimi, GLM, Qwen, gpt-oss) | next |
| A conformance suite per model × provider, run on change | next |
| Programmatic tool calling as an option for strong coders | next |
| Harness changes judged by trajectories (observability-driven evolution) | partly (`ox evolve`, traces) |
| Memory tied to files and invalidated when they change (Amoeba) | next |
