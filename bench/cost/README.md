# bench/cost — cost-measurement suite

Four measurements, all taken from real runs of the real `bin/ox.js`. Every figure
in `RESULTS.md` was read off something observed in the run that produced it.

## What it measures

### A — harness token overhead (`A-harness-overhead`, `A-overhead-ratio`)

The fixed token floor ox pays **before the model produces anything**: the system
prompt plus the tool schemas.

- A loopback mock OpenAI-SSE endpoint records the **exact request body** ox sends
  for one `ox -p` turn.
- `messages[role=system]` and the `tools` array are measured at the byte level off
  that recorded request, then converted with ox's own estimator
  (`src/context.js:estimateTokens`, `ceil(chars/4)`).
- **floor** = system tokens + schema tokens. This is the "cost effective" number:
  what every single run costs before the first token of answer.
- The denominator is real too: the same turn is replayed against the **local
  Ollama model** through a logging reverse proxy, which captures the real request
  and lets the provider's own `usage` counters reach ox.

The proxy adds exactly one thing to the forwarded *request*:
`stream_options.include_usage=true`. ox deliberately omits that flag for Ollama
endpoints (`src/providers/openai-compat.js:193`), so a direct Ollama run reports
`usage-total 0/0` and any "tokens spent" figure would be a fiction. The response
is piped back byte-for-byte, so every token number is Ollama's own counter.

### B — `--max-cost` hard stop (`B-max-cost-stop`)

The fixture task (`lib.js` returns 41, `test.js` asserts 42) is run against the
local Ollama model three times: **no cap**, a very low cap, a very high cap.
Reported: exit code, what ox printed, tokens spent before the stop, and the state
of the fixture afterwards. An in-process probe of `src/cost.js:createCostBudget`
additionally shows the `cost-cap` path for a model that *does* ship a price row.

### C — `fallback_policy.cost = free_only` (`C-fallback-policy`, `C-fallback-drop-path`)

- `OX_FALLBACK_COST=free_only` → `loadConfig().fallbackPolicy` is `{cost:'free_only'}`.
- An invalid value throws, with ox's real message and exit code.
- `classifyTargetCost` is called on real resolved bots to show which targets are
  `paid` / `free` / `unknown`.
- The **dropped-fallback path is executed live**: a loopback mock answers HTTP 500,
  the only configured fallback is the priced `ox-grok`, and the warning ox emits is
  printed **verbatim** from the event stream.
- The warning *template* is extracted from `src/agent.js` at run time, never
  re-typed, so the report cannot drift from the source.

### D — `model_overrides` + no-invented-prices (`D-model-overrides`)

- `OX_MODEL_OVERRIDE="m:4096:0.5:1.5"` changes `loadConfig().modelOverrides`,
  `lookupModel('m', overrides)` and `resolveModelWindow({overrides})`.
- A model with no price row yields `costOf(...) === null`, **not 0**, and
  `budget.snapshot().costUsd === null` whenever any model in the run is unpriced.
- The report also states plainly where an override does *not* reach: `costOf()` has
  no overrides parameter, so an override price row feeds cost-honest *routing*
  (`classifyTargetCost`), not the spend arithmetic.

## What it does NOT measure

- **Nothing remote.** No OpenRouter/xAI/Anthropic/OpenAI/Gemini call is made. The
  OpenRouter account on this machine reports **0 credits**; if a remote call is ever
  added, HTTP 402 is an **account limit, not a model failure**, and must be reported
  that way. No figure in `RESULTS.md` depends on a paid provider.
- **No dollars.** No run in this suite is billed. Prices appear only where
  `src/cost.js:PRICING` is read in-process, and those are table values, not spend.
- **No external figures.** Nothing in `RESULTS.md` is copied from an issue tracker,
  a blog post, or another agent's benchmark. Any such figure would have to be
  labelled `EXTERNAL`; there are none.
- **Not a provider tokenizer.** Token counts are ox's `ceil(chars/4)` estimator
  applied to measured bytes. It is not tiktoken. The gap against the provider's own
  counter is reported as `residual`, never folded into a component.
- **Not a latency or quality benchmark.** Task success is not scored; the fixture's
  post-run contents are reported as observed.
- **Not a memory/context benchmark.** `bench/` (the transcript replay suite) and
  `bench/real/` already cover compaction, tools and quality. This suite covers cost
  accounting only.
- **Not the full built-in tool set.** The run sends whatever ox actually sends after
  tool narrowing; `listToolSchemas({})` is reported alongside it for context, clearly
  labelled as *not* what the run sent.

## Rules this suite holds itself to

1. **Measure or say `unmeasured`.** Every field is a value read in this run, or the
   string `unmeasured` plus a reason. Never an estimate, an average of a previous
   run, or a plausible substitute.
2. **Print provenance.** Every number names the run, the request index and the field
   it came from.
3. **Never invent a price.** Unpriced means `null`, and a cap against an unpriced
   model fails closed.
4. **Label external figures `EXTERNAL`.** None are used.

## Repro

```sh
# full run (needs the local Ollama model reachable at localhost:11434)
cd /Users/saiyaganti/ox && node bench/cost/runner.mjs

# quick: skips the three live fixture runs (mock-only + in-process probes)
node bench/cost/runner.mjs --quick

# machine-readable result tree
node bench/cost/runner.mjs --json /tmp/ox-cost-results.json

# where did a given number come from?
node bench/cost/runner.mjs --quick --explain harness-overhead

# self-test of the accounting maths (incl. a deliberately-broken stub)
node /tmp/ox-cost-selftest.mjs
```

Output: `bench/cost/RESULTS.md` (rewritten every run).

All sandboxes are `mkdtemp` dirs under `$TMPDIR` with `HOME` and every XDG dir
redirected inside them. The repo and the developer's real `~/.ox` are never written.
