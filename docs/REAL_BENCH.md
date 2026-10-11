# Real agent benchmark results (measured)

Dates run: **2026-10-01** (Models A and C) and earlier the same day
(Model B, paid). Suite: [`bench/real/`](../bench/real) — 9 fixtures, method in
[`bench/real/README.md`](../bench/real/README.md).

Every number below comes from a run of that suite. Nothing here is estimated,
extrapolated, or carried over from another suite. `bench/RESULTS.md` (25/25) is a
different experiment about a different thing; see "Not a controlled A/B" below.

## Method, in one paragraph

The model decides and the grader executes code. There is no mock provider and no
scripted tool call in `bench/real/`; ox is spawned for real against a real provider,
and the model chooses which tools to call with what arguments in what order. Every
task has a `verify(ctx)` that spawns real processes (`node`, `grep`) inside the
workspace the agent left behind and decides pass/fail from exit codes and real stdout.
The transcript is never consulted for the verdict. Full method:
[`bench/real/README.md`](../bench/real/README.md).

The `tools`, `turns`, `redundant`, and `tok in/out` columns below are diagnostics
only. None of them decide pass/fail.

## Model A — `nvidia/nemotron-3-super-120b-a12b:free`, OpenRouter, FREE tier

Run 2026-10-01. **4 of 4 attempted tasks passed.**

| task | result | ms | tools | turns | tok in/out | redundant |
|---|---|---|---|---|---|---|
| `debug-and-fix` | PASS | 13219 | 5 | 6 | 22178/927 | 1 |
| `exact-edit` | PASS | 35879 | 9 | 15 | 68625/2123 | 1 |
| `create-runnable-script` | PASS | 42949 | 5 | 7 | 23875/3372 | 0 |
| `multi-file-refactor` | PASS | 84186 | 17 | 21 | 124241/3920 | 2 |

**This is not a full-suite score.** 5 of the 9 tasks were never run:
`read-and-report`, `add-feature-to-spec`, `recover-from-broken-state`,
`discipline-dont-touch`, `multi-step-plan-execute`. The OpenRouter free-tier daily
quota (50 requests) was exhausted; `multi-file-refactor` alone consumed 18 requests.
A pass rate over 4 of 9 fixtures is not comparable to a rate over all 9, and this
table must not be read as one.

## Model B — `openai/gpt-4o-mini`, OpenRouter, PAID

Measured earlier the same day. Nine tasks, three independent repeats each.

| task | result (x3 repeats) |
|---|---|
| `read-and-report` | 3/3 |
| `exact-edit` | 3/3 |
| `debug-and-fix` | 3/3 |
| `multi-file-refactor` | **0/3** |
| `create-runnable-script` | 3/3 |
| `add-feature-to-spec` | 1/3 |
| `recover-from-broken-state` | 3/3 |
| `discipline-dont-touch` | 3/3 |
| `multi-step-plan-execute` | 0/3 (2 of 3 runs were OpenRouter HTTP 402 credit exhaustion, not model failure) |

- Single run: **7/9 = 77.8%**.
- Repeats x3: **19/27 = 70.4%**.
- Excluding the 2 credit-blocked runs: **19/25 = 76.0%**.

The 402 runs are a billing failure, not a capability failure, so both figures are
reported rather than only the flattering one.

## Model C — `qwen2.5:0.5b`, local (Ollama)

Run 2026-10-01. **0/9 = 0.0%.** All 9 tasks failed. 5 of the 9 produced zero tool
calls and no final text — the model emitted meta-commentary about tooling instead of
acting. That is a model-capability floor, not a harness defect.

## Not a controlled A/B

**These are different models on different days. It is not valid to conclude "free
model beats paid model" from this document.** Model A's row is 4 tasks out of 9 with
a quota cut short; Model B's is 9 tasks out of 9 on a different date; Model C is a
local 0.5B model of a different class entirely. Nothing was held fixed except the
fixtures and the grader.

The one cross-model observation worth recording is factual and narrow: on
`multi-file-refactor`, gpt-4o-mini failed **3/3** by renaming a comment it had been
explicitly told to preserve; nemotron-3-super-120b passed that task and left the
decoy byte-intact. That was confirmed by inspecting the sandbox directly, not
inferred from the PASS line.

## The `multi-file-refactor` PASS was verified, not trusted

The task plants one occurrence of `calcTotal` inside a comment that must not be
renamed, so a blanket `sed` fails it. After the Model A run the sandbox was
inspected by hand:

- the decoy comment `// literally "calcTotal" ... Do not rename this comment.` is
  confirmed byte-intact at `ws/tools/cli.js:6`;
- no `calcTotal` alias survived anywhere in `src/cart.js`;
- `test/refactor.test.js:13` asserts `cart.calcTotal === undefined`, and that
  assertion passes.

The workspace was genuinely correct. The PASS line was not taken on faith.

## The score moved 0% -> 78% by changing the model

Against the identical fixtures and an identical grader, all nine tasks:

- `qwen2.5:0.5b`: **0/9 = 0.0%**
- `openai/gpt-4o-mini`: **7/9 = 77.8%**

Same harness, same grader, same fixtures, one variable changed: the model. **Harness
choice was not the variable.** The measurement is of the model on these fixtures, not
of ox.

## Ox does not manufacture success from a weak model

`qwen2.5:0.5b` scored 0/9 and was graded 0/9, with real verifier detail rather than a
flattering narrative. A benchmark that can only produce good news is not measuring
anything; this one produced a genuine zero and recorded why.

## Cost column is blank on purpose

The COST column is empty in all three tables. These free/unpriced models have no
`PRICING` row in `src/cost.js`, and ox fails closed on unknown pricing rather than
guessing one. A blank cell here is the no-fabricated-price property working, not a
missing measurement.

## Reproduce

`--model` is required; there is no default and no silent fallback.

```sh
cd /Users/saiyaganti/ox

# `--keep` leaves the sandbox AND its raw NDJSON event stream
# (<sandbox>/events.ndjson) on disk, so every token number below is traceable.

# Model A — free tier. One task at a time; the quota is 50 requests/day.
node bench/real/runner.mjs --model ox-openrouter:nvidia/nemotron-3-super-120b-a12b:free \
  --task debug-and-fix --keep
node bench/real/runner.mjs --model ox-openrouter:nvidia/nemotron-3-super-120b-a12b:free \
  --task multi-file-refactor --keep

# Model B — paid. Full suite, three independent repeats per task.
node bench/real/runner.mjs --model ox-openrouter:openai/gpt-4o-mini \
  --all --repeats 3 --json /tmp/gpt-4o-mini.json

# Model C — local.
node bench/real/runner.mjs --model ox-ollama:qwen2.5:0.5b --all --json /tmp/qwen05b.json

# the task list
node bench/real/runner.mjs --list
```

## Finishing the remaining 5 tasks for Model A

Unrun: `read-and-report`, `add-feature-to-spec`, `recover-from-broken-state`,
`discipline-dont-touch`, `multi-step-plan-execute`.

At roughly 18 requests per task, 5 tasks is about **90 requests — approximately two
days of the 50-request free-tier daily quota**, or a single paid run. Until that
happens, Model A's record stays at "4 of 4 attempted", not a score.

## What this cannot prove

- **Not quality above pass/fail.** Nine fixtures, binary verdicts. One wrong constant
  changes the score. Nothing here distinguishes a good solution from a barely
  adequate one.
- **Not reasoning versus guessing.** A verifier that checks the end state cannot see
  whether the model reasoned its way there or stumbled into it.
- **Not multi-agent behaviour.** Every run here is a single ox process. Nothing in
  this document speaks to subagents, long sessions, or recovery from a bad plan.
- **Runs are non-deterministic.** Two runs of the same model are not identical
  (temperature). `--repeats` exists for this reason, and a single run is a weak claim
  — which is why Model B is reported both ways.
- **Not a ranking.** Different days, different quota states, one model at 4 of 9
  tasks. The comparisons here are between the model and the fixtures, not between the
  models.
