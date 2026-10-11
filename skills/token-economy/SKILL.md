---
name: token-economy
description: Use on long or large tasks, or when cost matters. Gets the same result with fewer tokens.
---
# Token economy

- Search before reading: grep/glob to find the lines, then read a window (offset/limit), not whole files.
- Batch independent read-only calls in one turn; they run in parallel.
- Never re-read a file you just wrote or read unless it changed.
- Keep tool output small: filter (grep, head, --quiet) at the source instead of reading noise.
- Delegate wide searches to a subagent and keep only its conclusion.
- Route cheap work (summaries, classification, formatting) to a small or local model; keep the strong model for reasoning.
- Write answers short. Lead with the result; skip restating the question.
