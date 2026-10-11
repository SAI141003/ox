---
name: benchmarking-methodology
description: Benchmarking methodology: how to measure agent performance, Terminal-Bench patterns, and reproducible evaluation.
metadata:
  category: quality
  trigger: command
---

# Benchmarking Methodology

Evaluate changes with reproducible, fair benchmarks.

1. Define a baseline before modifying any behavior. Record exact version, config, dataset, and environment details.
2. Use Terminal-Bench-style tasks: isolated, deterministic prompts with measurable pass/fail outcomes.
3. Measure agent performance across:
   - Accuracy (task completion rate)
   - Latency (wall-clock and token usage)
   - Cost (input/output tokens and model spend)
   - Consistency (variance across repeated runs)
4. Run at least 5 repetitions per configuration and report median and interquartile range.
5. Control variables: same model, temperature, context window, prompt template, and seed.
6. Report deltas, not just final numbers. Include confidence intervals and statistical significance.

Rules:
- Never benchmark on the live production dataset without explicit approval.
- Publish raw results alongside aggregated metrics for reproducibility.
