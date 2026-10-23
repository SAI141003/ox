# Performance and token evidence — 2026-10-23

This note records measurements already present in this checkout. It is not a
cross-provider leaderboard and it must not be used to claim that one model is
universally faster, cheaper, or better. Model choice, prompt/context size,
network, provider queueing, and hardware all materially affect these numbers.

## What was measured

### Fresh regression check: NVIDIA Nemotron after hosted schema-pruning repair

On 2026-10-23, a real `read-and-report` run was repeated after fixing a
hosted-provider runtime error in `pruneToolSchemas`:

```sh
node bench/real/runner.mjs \
  --model nvidia:nvidia/nemotron-3-ultra-550b-a55b \
  --task read-and-report --timeout 90000
```

The first attempt failed before an inference request with
`TOOL_SCHEMA_BUDGET_FLOOR is not defined`.  That was an Ox code defect, not
provider latency or model quality.  The repaired run completed the actual
workspace task: it read the live configuration and wrote the expected `7314`
to `answer.txt`.

| Metric | Observed result |
|---|---:|
| Runs / passes | 1 / 1 |
| End-to-end time | 7.092 s |
| First output text | 6.815 s |
| Tool calls | 2 (`read_file`, `write_file`) |
| Mean tool execution | 10 ms |
| Input / output tokens | 13,202 / 272 |
| Cost | Unknown — this provider response did not supply price data |

This is one warm-path sample, not a provider leaderboard or a cost quote.
The complete captured result is kept outside the repository at
`/tmp/ox-real-nvidia-nemotron-read-after-floor-fix.json` for the current
machine session.

### Real tool-use task: NVIDIA Nemotron

`bench/results/2026-10-22T15-45-00-live-nvidia/nemotron-read.json` recorded
one live run of `nvidia-nemotron-3-ultra-550b-a55b` on a read-and-write task:
find a current configuration value while avoiding a stale backup, then write a
single integer to a file.

| Metric | Observed result |
|---|---:|
| Runs / passes | 1 / 1 |
| End-to-end time | 9.149 s |
| First tool call | 2.198 s |
| First output text | 8.862 s |
| Tool calls | 2 (`read_file`, `write_file`) |
| Tool-execution time | 12 ms |
| Input / output tokens | 14,951 / 268 |
| Cost | Unknown — the run had no price record |

This proves one successful live run only. It does **not** establish price,
reliability, or latency distributions for NVIDIA or any other provider.

### Real tool-use task: local Qwen 2.5 3B

`bench/results/2026-10-22T-local-qwen3b-deep.json` recorded two pinned local
`qwen2.5:3b-64k` attempts on the same task.

| Metric | Observed result |
|---|---:|
| Runs / passes | 2 / 0 |
| End-to-end time | 114.898–152.680 s |
| First tool call | 31.158–62.540 s |
| Tool calls | 4–6 |
| Input / output tokens | 12,074–16,881 / 243–515 |
| Billed API cost | $0 (local runtime) |

Both attempts identified the correct value but failed the required file-write
check. The evidence therefore does **not** support using this pinned 3B model
for autonomous file-edit tasks on this Mac. Zero API billing is not a claim of
zero compute or electricity cost.

### Deterministic harness

`bench/results/2026-10-22T23-47-30-928Z/RESULTS.md` contains a 25/25 passing,
11.395-second deterministic harness. Its token and dollar figures are fixture
accounting used to check Ox's budgeting/stop logic; they are not live provider
bills or latency measurements. The harness reports a measured local framework
overhead profile of 40.5 ms cold-start mean, 43.7 ms p95, 226.6 ms full turn,
and about 182.9 ms per-turn overhead in that controlled fixture.

## Product action from this evidence

The `session_recall` schema is now offered only when the latest user message
mentions earlier work/history (or a caller explicitly enables it). A direct
schema measurement showed 6,506 tokens for the ordinary tool offer versus
6,654 when session recall is included: **148 prompt-schema tokens avoided per
ordinary tool-enabled turn**. This changes no underlying history data and does
not make a provider or model faster; it removes unnecessary context from turns
that cannot use recall.

## What still needs a fair comparison

- At least several warm and cold repeats per model on identical isolated tasks.
- Exact provider model/version, region, rate limits, and pricing at run time.
- Provider usage/billing responses, rather than estimated price tables.
- Separate measurements for answer-only, code-edit, web/tool, image, and long
  context tasks.
- A configured Docker engine before comparing isolated-backend execution.
