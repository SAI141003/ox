# ox vs Hermes Agent: overhead, measured

Run 2026-10-12 on one MacBook (M3, 16 GB), ox at commit `b1e90a4`, Hermes Agent
v0.21.3 (2026.9.14). Script: [`bench/compare-hermes.mjs`](../bench/compare-hermes.mjs).

## What this measures, and what it does not

Both agents are pointed at the **same local mock model** that always answers
`ready`, and given the same one-line task (`Reply with the single word:
ready`) in a throwaway home folder and project. The mock records every request
each agent sends. So this measures what an agent costs **around** the model:

- how long it takes to start and reach the model,
- how many model requests it makes for a trivial answer,
- how many bytes (≈ tokens) it sends per request: system prompt plus tool
  definitions, which a paid model bills on **every** turn.

It does **not** measure how well either agent solves real tasks. That needs
the same capable (paid) model driving both through graded tasks, as in
[`REAL_BENCH.md`](REAL_BENCH.md), and has not been run against Hermes yet.

## Results

Median of runs on the same machine, at the same time.

**Warm** (one home per agent reused, so first-run setup is excluded; 4 runs):

| | ox | Hermes |
|---|---|---|
| Launch to first model request | **0.80 s** | 10.18 s |
| Total time for the answer | **0.83 s** | 10.35 s |
| Model requests for one answer | **1** | 3 |
| Largest request | **13.0 KB** (≈3,300 tokens) | 43.7 KB (≈10,900 tokens) |
| Tool definitions sent | **9 tools, 6.9 KB** | 23 tools, 37.3 KB |
| System prompt | 5,858 chars | 6,135 chars |

**Cold** (a fresh home every run; 3 runs): ox 1.15 s to the first request,
Hermes 28.6 s.

## Why the gap

- **Tools are offered per turn, not all at once.** ox has 27 tools but sends
  the 9 a turn needs (more when the message asks for web, memory, UI and so
  on). Hermes sends 23 tool definitions on every request. At ~$3 per million
  input tokens, the ~7,600-token difference is about $0.02 per turn.
- **One request per answer.** Hermes made 3 requests for a one-word reply; ox
  made 1.
- **Startup.** ox is a zero-dependency Node program and, since `2a515b2`, starts
  no subprocesses before the first turn.

## Caveats

- Mock model: answer quality is not compared here.
- One machine; the absolute times depend on its load (the load average was
  roughly 6-150 during these runs). The ratios held across the cold and warm
  runs.
- Hermes ran with `--ignore-user-config --ignore-rules`, the `openai` provider
  and `OPENAI_BASE_URL` pointed at the mock, so personal configuration did not
  affect it. Its defaults may differ for a configured user.
- Bytes/4 is an estimate of tokens, applied the same way to both.

Rerun:

```bash
node bench/compare-hermes.mjs bin/ox.js 3          # cold
WARM=1 node bench/compare-hermes.mjs bin/ox.js 4   # warm
```
