# Head-to-head: ox, Hermes, Codex, Claude Code (measured)

Date 2026-10-17, macOS arm64 (a heavily loaded machine), Node 25.

Same 9 real tasks as `bench/real` (graded by running code in the workspace
each agent left behind), **the same model for every agent**: `qwen2.5:3b` with
a 64k context (`qwen2.5:3b-64k`: Hermes refuses models under 64k), through a
counting proxy in front of Ollama, 5 minutes per task, every agent in a fresh
sandbox with its own empty home.

| agent | pass | time | requests | tokens in | tokens out |
|---|---|---|---|---|---|
| ox | 0/9 | 1,793 s | 58 | 181,544 | 6,247 |
| Hermes | 0/9 | 2,291 s | 35 | 267,764 | 4,298 |
| Codex | 0/9 | 2,018 s | 18 | 53,541 | 1,971 |
| Claude Code | 0/9 | 2,700 s | 9 | 0 | 0 |

## What this shows, and does not

- **No ranking.** A 3B model passed nothing under any harness: a floor effect.
  This run cannot say which harness is better.
- Tokens spent on failed tasks are not a cost comparison, and are not claimed
  as one.
- Claude Code never got a usable answer from the local model (one request per
  task, no tokens counted, every task timed out): its Anthropic-format requests
  to Ollama are the likely cause, not a judgement of Claude Code.
- On the first task in an earlier run (32k context), ox passed in 42 s with 3
  requests and 10,662 tokens while the other three failed: one task, one run,
  not a result.

## What it takes to get a real answer

A shared model strong enough to pass some tasks and fail others: a 7B+ coder
model locally (a ~5 GB download), or an API model all four agents can use.
The runner is ready: `node bench/h2h/run-h2h.mjs --model <ollama model>
--agents ox,hermes,codex,claude --json out.json`.

Every row (36 runs: agent, task, time, requests, bytes, tokens, verdict) is in
`results-qwen2.5-3b-64k.json`. Fixed after this run: the proxy crashed on an
upstream error after a response had finished (after the data was saved).
