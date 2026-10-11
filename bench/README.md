# ox bench

Deterministic benchmark harness for the **ox** coding agent. Node >= 18, ESM, zero dependencies.

## Purpose

Each scenario runs `node bin/ox.js -p "<prompt>" --json` against a **local mock OpenAI-SSE
server** (127.0.0.1, ephemeral port) inside an isolated sandbox (`HOME` + workspace under a
temp dir, removed after the run). The mock's completions are driven per-scenario by a
scripted function over the parsed request body, so every agentic behavior — tool dispatch,
approval gates, edit plumbing, compaction, session resume, MCP, skills, memory, budget
stops — is exercised end-to-end through the real CLI without touching the network.

### Honesty statement

These benchmarks measure **harness** agentic correctness and reliability — do tools fire,
do files mutate, does recovery happen, are safety semantics honored — deterministically and
for free. They say **nothing about model quality**: the "model" is a script. SWE-bench-class
evaluations of real coding ability need live provider keys; use `--live` for that (scenarios
opting in run against a real provider when any provider key in `src/bots.js`'s
`KEY_ENV` map is present).

## Usage

```
node bench/runner.mjs                      # deterministic mode, all scenarios
node bench/runner.mjs --filter resume      # substring/regex filter on name/category
node bench/runner.mjs --json out.json      # machine-readable results
node bench/runner.mjs --out-dir <dir>      # choose where run artifacts land
node bench/runner.mjs --live               # real-provider runs where scenarios opt in
node bench/runner.mjs --live-model <spec>  # force the live provider/model
node bench/runner.mjs --update-baseline    # OPT-IN: replace the RESULTS.md baseline
node bench/runner.mjs --list               # list scenarios without running
```

Artifacts: console table + totals + pass rate, plus a **run-scoped** directory
`bench/results/<ISO-timestamp>/` holding `RESULTS.md` (env header, table, totals)
and `canary.json` (the machine-readable payload the regression canary diffs). An
optional extra JSON file can be written anywhere via `--json`.

### Baseline protection

`bench/RESULTS.md` is **not** run output — it is the regression baseline that
`scripts/regression-canary.js` diffs each run against, and writing it is the
canary's whole protection mechanism. Therefore:

- an ordinary run **never** touches `bench/RESULTS.md`; it writes only to its
  run-scoped directory under `bench/results/`;
- replacing the baseline requires the explicit `--update-baseline` opt-in;
- `--update-baseline` is **rejected** together with `--filter`, because a subset
  table written over the full-suite baseline is unrecoverable data loss.

The canary reads the baseline from `bench/RESULTS.md` and the current run from the
run-scoped directory it directs the runner to. To diff against an already recorded
run instead of re-running the suite:

```
node scripts/regression-canary.js --current bench/results/<ISO-timestamp>/RESULTS.md
```

### Live provider selection

`--live` resolves a provider from `KEY_ENV` in `src/bots.js` (xai, anthropic,
openai, gemini, groq, openrouter, deepseek, ollama, backboard, custom) — the same
map ox itself uses, not a parallel hardcoded list. Precedence is `KEY_ENV`
declaration order; `ollama` is keyless and therefore last, and is only selected when
a loopback probe finds its endpoint answering, so an absent Ollama install skips
live scenarios instead of failing all of them.

The model per provider is chosen for **reliable tool calling**, because live
scenarios assert on tool dispatch: `xai` grok-4.6 · `anthropic` claude-sonnet-5 ·
`openai` gpt-5.6-sol · `gemini` gemini-3.1-pro-preview · `groq` and `openrouter`
moonshotai/kimi-k2-instruct-0905 · `deepseek` deepseek-v4-pro · `ollama`
qwen2.5:7b · `backboard` backboard-routing. Note the OpenRouter default replaced
`meta-llama/llama-3.3-70b-instruct`, an instruct model that is unreliable at tool
calls. Override with `--live-model <provider:model>` or `OX_BENCH_LIVE_MODEL`.

## Scenario contract

```js
export default {
  name, description, category,
  prompt,                       // -p prompt (default pipeline)
  model?,                       // priced model string for cost math (default grok-4.6)
  tokensPerTurn?: {in,out},     // usage the mock attaches to every completion
  extraArgs?: [...], env?: {...},
  async setup(sandbox),         // populate the workspace
  script(body, ws, state),      // -> array of SSE data payloads ending with [DONE]
                                //   (helpers: turn(), sseText(), ... from ../harness.mjs)
  check(result) -> {pass,detail}, // result: {events, exitCode, stdout, stderr, ws, ms,
                                  //          requests, flags, errors, model}
};
```

Scenarios needing multiple ox processes export `async run({sb, startMock, spawnOx,
deterministicEnv})` instead of `prompt`+relying on the default single-spawn pipeline.

## Scenarios

| # | name | category | what it proves |
|---|------|----------|----------------|
| 01 | basic-read | core-tools | read_file round-trip; marker echoed; exactly one call |
| 02 | exact-edit | core-tools | exact-substring edit_file mutates disk |
| 03 | fuzzy-edit | core-tools | whitespace/CRLF-tolerant fuzzy edit applied; `meta.fuzzy` surfaced |
| 04 | multi-file-refactor | agentic-loop | create module + rewire importer + bash verification exit 0 |
| 05 | test-fix-loop | agentic-loop | red bash → fix → green bash within budget |
| 06 | bad-edit-recovery | agentic-loop | failed old_string → error surfaced → correct retry |
| 07 | decline-compliance | safety | declined bash never executes, never retried; exit code 2 |
| 08 | compaction-integrity | agentic-loop | history crosses window threshold; summary preserves turn-1 fact |
| 09 | resume-pairing | sessions | crashed session resumes; orphan tool_call sanitized to `[not executed: interrupted]` |
| 10 | mcp-end-to-end | integrations | stdio MCP fixture server: initialize/list/call echo |
| 11 | skills-disclosure | integrations | skill index in system prompt, body read, instruction followed |
| 12 | memory-recall | memory | memory_add persists; fresh process sees fact in system prompt |
| 13 | plan-mode-compliance | safety | --plan blocks write_file at dispatch; file untouched |
| 14 | budget-stop | safety | --max-cost aborts with budget-stop event and exits **2**; exit 2 is ambiguous (it is also an approval denial), so the scenario asserts the event — see README.md "Breaking change: a budget-stopped run now exits 2" |
| 15 | overhead-profile | meta | 20x cold-start p95 + one full turn overhead (report-only tolerance) |

Note on 08: `src/agent.js` has no env hook for the context window (`lookupModel().window`
or programmatic `ctx.modelWindow` only), so the scenario grows history past the natural
75%-of-128k threshold instead of failing or being skipped.

## Interpreting the table columns

- **RESULT** — `PASS` / `FAIL` / `SKIP` (skips carry documented reasons).
- **MS** — wall time of the scenario including child spawn(s); scenario 15's row covers its
  internal timing loop.
- **TOKENS IN/OUT** — accumulated `usage` events from the NDJSON stream (mock-reported).
- **COST** — `src/cost.js costOf(model, usage)`; `—` if the model is unpriced. Deterministic
  costs are synthetic (tokens come from `tokensPerTurn`) but use the real pricing table.
- **DETAIL** — pass/fail specifics; always inspect details for FAIL rows before trusting a
  regression report.

## Product edits made by the harness (surgical, documented)

1. `src/agent.js`: `tool-end` events include `result.meta` when present (surfaces
   `fuzzy:true` from edit_file) — previously invisible to `--json` consumers.
2. `src/tools/fs.js`: the whitespace-mapped fuzzy-match success path of `edit_file` now
   returns `meta:{fuzzy:true}` like the unmapped path already did (inconsistent surfacing).
3. `src/headless.js`: `--json` mode now accumulates usage/cost like text mode — without
   this, `--max-cost` (budget-stop) was silently inert whenever `--json` was used.
4. `src/cli.js` + `src/headless.js`: `-c`/`--resume` are now honored in the headless
   (`-p`) path via an `initialMessages` parameter — previously the flags were parsed but
   silently ignored outside the REPL.
