# Public benchmark plan (draft, 2026-11-06)

What we want to say, and only with numbers we measured: **how well ox solves real coding
tasks, and how many tokens and dollars it spends per solved task, against other agents on
the same model.** The second half is ox's own claim (fewer tokens), so it is the headline.

## The sets

| Set | What it is | Size | Graded by |
|---|---|---|---|
| SWE-bench Verified | real GitHub issues in 12 Python repos; the fix must pass the repo's hidden tests | 500 | the SWE-bench harness (Docker images per task) |
| SWE-bench Verified, 50-task subset | a fixed random sample of the 500, seed published | 50 | same |
| Terminal-Bench 2.0 | terminal tasks in containers (build, debug, data, security) | 89 | its own tests, through Harbor |
| ox's own sets (`bench/real`, `bench/tb2`, `bench/cost`) | 7 real-model tasks, 6 terminal tasks, the token floor | small | code that runs, never the transcript |

SWE-bench Verified is close to saturated (aggregators list the top systems at 94-96 %, and
they disagree on the order), so a pass rate alone says little. Tokens and cost per solved
task, at a fixed model, is where agents still differ.

## This Mac

M3, 8 cores, 16 GB memory, 15 GB disk free, Docker installed but not running, load average
30-97 all week. The SWE-bench test images need well over 100 GB, so grading cannot happen
here: patches are made here and graded in the cloud (`sb-cli`, the SWE-bench team's hosted
grader), or on a rented machine. Terminal-Bench runs one container at a time here if Docker
is started and images are removed after each task.

## Method (the benchmarking-methodology rules)

- Baseline first: ox version (git sha), model, settings and the task list written down before any run.
- Same model, same effort, same time and token limits for every agent compared.
- At least 5 runs per setup on the subsets; median and spread reported, not the best run.
- Graded by executing tests only. A run that times out or crashes counts as failed.
- Raw results published with the summary: every patch, every log, every token count.

## Options, cost and time

Token use per SWE-bench task is estimated from ox's own logs (about 25 model calls, about
750k input and 15k output tokens a task before caching). The first run of each option
replaces this estimate with measured numbers.

| Option | What runs | Model | Est. cost | Est. time |
|---|---|---|---|---|
| **A. Free pilot** | ox on the 50-task subset, 1 run; ox's own sets | NVIDIA minimax-m3.1-flash (your key, free, rate-limited) | $0 | ~1 day (rate limits) |
| **B. Head to head (recommended)** | ox, Claude Code and Codex on the 50-task subset, 5 runs each; Terminal-Bench 2.0 once for ox | Claude Sonnet 5.5 ($2/$10 per M) | ~$250-350 | 2-3 days |
| **C. Full** | B, plus all 500 Verified tasks for ox, and Terminal-Bench 5 runs | Sonnet 5.5 | ~$550-650 | about a week |

Claude Haiku 5.5 ($0.10/$0.50 per M) would cut B to roughly $15-25, but at a much lower
pass rate; worth adding as a second model if B is chosen.

Not used: the ChatGPT plan (a subscription is not a fixed, metered model, and its CLI
sends about 13,000 tokens of its own per request), and the Claude plan (Anthropic keeps
Claude logins for its own apps).

## What it needs from you

1. Pick an option.
2. For B or C: an Anthropic API key with a spending limit set in the Console, added under Settings › API keys.
3. Approval to install the graders: `sb-cli` and Harbor (Python, through `uv`), and to start Docker.
4. Later, approval of each publication.

## Publishing

- Raw results and the harness in this repo (`bench/public/`), with a README that reproduces each number.
- The same results as a Hugging Face dataset.
- A results page; the paper cites these, nothing else.
- Leaderboards: Terminal-Bench's submission repo said submissions were closed while a new
  process was built, and SWE-bench's own leaderboard takes submissions through its site.
  Both are checked again before submitting; nothing is sent without your OK.

Sources: [sb-cli](https://github.com/swe-bench/sb-cli/), [SWE-bench evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/),
[Terminal-Bench 2 leaderboard repo](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard),
[Terminal-Bench 2.0 and Harbor](https://venturebeat.com/ai/terminal-bench-2-0-launches-alongside-harbor-a-new-framework-for-testing),
[SWE-bench Verified standings (llm-stats)](https://llm-stats.com/benchmarks/swe-bench-verified), [BenchLM](https://benchlm.ai/benchmarks/swe-verified).
