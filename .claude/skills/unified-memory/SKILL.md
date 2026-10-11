---
name: unified-memory
description: Unified memory: maintain PROFILE.md and VOLATILE.md for cross-session context and short-term recall.
metadata:
  category: memory
  trigger: command
---

# Unified Memory

Use two memory files to preserve context across sessions.

## PROFILE.md
Long-lived project memory. Append factual, durable knowledge:
- Project architecture and module boundaries
- Key team conventions and decision rationale
- Common pitfalls and workarounds
- Integration endpoints and credentials (treat secrets separately)

Rules for PROFILE.md:
- Write in past tense for completed work, present tense for current conventions.
- Keep entries concise and timestamped.
- Do not store secrets or credentials in plain text.

## VOLATILE.md
Short-term session scratchpad. Append ephemeral context:
- Active task state and next steps
- TODOs and blockers for the current work session
- Temporary debugging notes and hypotheses
- Scratchpad for API responses, configs, or data samples

Rules for VOLATILE.md:
- Clear at session boundaries unless explicitly preserved.
- Promote durable facts to PROFILE.md, not VOLATILE.md.

## Workflow
1. On session start, read both files if they exist.
2. During work, append new facts to the appropriate file.
3. On session end, review VOLATILE.md and migrate lasting knowledge to PROFILE.md.
