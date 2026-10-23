# bench/cost results

- run started: 2026-10-23T08:29:56.435Z
- mode: quick (live max-cost + dropped-fallback runs skipped)
- node: v22.22.3 · platform: darwin/arm64
- wall clock: 11468 ms
- token estimator: every token figure below is `src/context.js:estimateTokens` (ceil(chars/4)) applied to bytes measured in this run. It is NOT a provider tokenizer.

> OpenRouter account on this machine reports 0 credits: remote calls are best-effort. HTTP 402 = account limit, NOT a model failure.

Integrity: every figure is read off something observed in this run. Nothing is estimated,
extrapolated, or carried over from a previous run. Unmeasurable fields read `unmeasured`
with a reason. External figures (none are used here) would be labelled EXTERNAL.

## A-harness-overhead

Fixed per-run token floor paid before the model says anything, measured off the request
ox actually sent to the loopback mock.

| field | value | where it came from |
|---|---|---|
| request captured | #0 → /v1/chat/completions | loopback mock request log |
| system message | 6787 B (6747 chars) | `messages[role=system]` |
| tool schemas | 5345 B (5343 chars) | `tools` (8 sent) |
| conversation | 34 B | non-system messages |
| **floor (system + schemas)** | **3023 tok** | (1687 + 1336) |
| system tokens | 1687 tok | estimateTokens(systemChars) |
| schema tokens | 1336 tok | estimateTokens(schemaChars) |
| conversation tokens | 9 tok | estimateTokens(conversationChars) |
| full builtin schema set (NOT what this run sent) | 38 tools, 25968 B, 6488 tok | listToolSchemas({}) |
| tool narrowing in this run | offered 8 of 45 | tool-narrowing event |

## A-overhead-ratio

Floor tokens per output token, both sides measured in the same run (real local model via a
logging reverse proxy in front of Ollama).

| field | value |
|---|---|
| floor tokens | 3022 |
| input tokens (provider usage-total) | 2926 |
| output tokens (provider usage-total) | 4 |
| **floor per output token** | **755.5** |
| overheadRatio (input/output) | 731.5 |
| residual (provider − estimator) | -105 |
| upstream | http://localhost:11434 |

## C-fallback-policy

| probe | result |
|---|---|
| `OX_FALLBACK_COST=free_only` → loadConfig().fallbackPolicy | `{"cost":"free_only"}` |
| accepted policy values | `free_only`, `allow_paid` |
| default when unset | `{"cost":"allow_paid"}` |
| invalid value `free_when_paid` | **rejected** — `ox: fallback policy cost must be one of free_only, allow_paid (got 'free_when_paid')` (exitCode 3) |
| dropped-fallback branch present in src/agent.js | true |
| all-dropped warning branch present | true |
| classifyTargetCost(ox-grok (grok-4.6, PRICING row in=2/out=6)) | `paid` |
| classifyTargetCost(ox-ollama (keyEnv null -> can never bill)) | `free` |
| classifyTargetCost(ox-cost-bench-no-such-model (no PRICING row, paid provider)) | `unknown` |
| classifyTargetCost(null target) | `unknown` |

Exact dropped-fallback reason string (quoted from src/agent.js):

```
fallback_policy.cost=free_only refused a ${cost} fallback target
```

Exact all-dropped warning TEMPLATE, extracted from src/agent.js at run time (the `${...}` holes are what ox interpolates):

```
`fallback policy free_only refused all configured fallback bots (${droppedFallbacks.map((d) => `${d.target} [${d.cost}]`).join(', ')}) — no free fallback remains, staying on ${targetLabel(activeTarget)} instead of spending`
```

The warning ox actually EMITTED on the live run is printed verbatim under C-fallback-drop-path below.

## D-model-overrides

| probe | result |
|---|---|
| `OX_MODEL_OVERRIDE="m:4096:0.5:1.5"` → config.modelOverrides | `{"m":{"window":4096,"in":0.5,"out":1.5}}` |
| lookupModel('m', overrides) | `{"in":0.5,"out":1.5,"window":4096,"priced":true}` |
| lookupModel('m') with NO override | `{"priced":false}` |
| resolveModelWindow('m', with override) | 4096 |
| resolveModelWindow('m', no override) | 128000 |
| costOf('m', 1000in/100out, overrides) | 0.00065 |
| lookupModel('ox-cost-bench-no-such-model') | `{"priced":false}` |
| **costOf('ox-cost-bench-no-such-model', 1000in/100out)** | **`null` (not 0)** |
| control costOf('grok-4.6', 1000in/100out) | 0.0026 |
| budget.snapshot() with one unpriced model | `{"inputTokens":1000,"outputTokens":100,"costUsd":null,"knownCostUsd":0,"unknownModels":["ox-cost-bench-no-such-model"],"maxCostUsd":5}` |

> costUsd is null (NOT 0) whenever any model in the run has no price row; knownCostUsd carries only the priced part.

> lookupModel(), resolveModelWindow(), and costOf() accept the same model_overrides table. Passing config.modelOverrides makes a user-declared in/out price row participate in exact per-run cost accounting; omitting overrides deliberately leaves an unknown model unpriced rather than inventing a price.

---

What this suite does NOT measure: see `bench/cost/README.md`.
