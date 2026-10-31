# First-request token overhead: ox, Claude Code, Codex, Hermes Agent (October 30, 2026)

Each agent was pointed at `recorder.mjs`, a stand-in model server that records
the exact request and answers with one line, in the same small repo, with the
same three prompts. Sizes are request characters / 4 (one yardstick for all;
real tokenizers differ by about 10%). This is the fixed cost every model call
pays; it says nothing about how many calls a task takes.

| Prompt | ox (clean, code) | ox (clean, auto) | ox (owner's setup) | Claude Code 2.1.303 (clean) | Claude Code (owner's plugins) | Codex CLI 0.166.0 (clean) | Hermes Agent 0.21.3 (clean) |
|---|---|---|---|---|---|---|---|
| hey how are you | 2,060 | 237 (0 in the app/voice) | 1,679 | 16,724 | 34,160 | 10,325 | 11,737 (2 calls) |
| what is a closure in javascript? | 2,161 | 241 | 1,780 | 20,129 (2 calls) | 37,569 (2 calls) | 10,329 | 11,747 (2 calls) |
| add an add(a, b) function to src/math.js | 2,070 | 2,070 | 1,689 | 16,734 | 34,169 | 10,334 | 11,757 (2 calls) |

Breakdown of the coding prompt: ox sends ~590 system + ~1,390 for 8 tools
(others on demand through load_tools); Claude Code ~1,560 system + ~12,200 for
20 tools + ~2,800 of injected context; Codex ~2,400 for 10 tools + ~7,500 of
instructions and environment in the input; Hermes ~9,800 for 24 tools of an
11,400 main call, plus a ~340-token title call.

Published: on 45 SWE-bench Verified tasks the first call carried 17,134 tokens
through Claude Code and 1,382 through mini-SWE-agent ("What Does a Harness Buy?
Tokens, Mostly", arXiv 2610.04433), matching the 16.7k measured here.

Reproduce: `node recorder.mjs requests.jsonl 48100`, then run each agent with
its base URL pointed at `http://127.0.0.1:48100` (ox: `OX_BASE_URL=…/v1
OX_API_KEY=x ox --bot custom:bench-model -p …`; Claude Code:
`ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=x claude -p …`; Codex: a
`model_providers` entry with `base_url = "…/v1"`, `wire_api = "responses"`).
