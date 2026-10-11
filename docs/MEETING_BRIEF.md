# Meeting Brief — ox ONE PLATFORM

**Date**: Tomorrow (2026-09-23)  
**Audience**: Stakeholders, engineering, product  
**Duration**: 15 min presentation + 15 min Q&A

## The Problem

Chatbots don't act on your machine. IDEs don't listen. Cloud assistants like HeyClicky promise voice + computer control but:
- Your data goes to their cloud
- You're locked into their ecosystem
- They're expensive at scale
- No local first, no BYOK, no transparent cost

## ox's Answer

**One platform — talk, act, code — local, approved, BYOK.**

| Capability | How ox does it |
|---|---|
| Voice input | OpenWhispr local STT → ox agent (zero cloud deps) |
| Open apps/URLs | Operator tools (approval-gated except `notify`; all 7 skip approval under yolo/trusted) |
| Coding | Existing CLI agent loop (hooks, subagents, verified edits) |
| Desktop | Tauri shell with chat, editor, diff (existing) |
| API | `ox serve` — OpenAI-compatible HTTP endpoint |

## Live Demo (5 min)

1. Voice: "Open Chrome" → Chrome opens (with approval)
2. Text fallback: `ox -p "open https://backboard.io"` → browser opens
3. Code: `ox -p "explain serve.js"` → accurate explanation
4. API: `curl` to `ox serve` → chat completion

## Key Wins

- **No cloud dependency** — voice and control run locally
- **Approval-gated** — no UI action without your OK (`notify` never prompts, and
  the other six skip approval under `--yolo` or `trusted` trust)
- **BYOK** — bring your own model, your own key
- **Zero telemetry** — we don't track usage
- **Zero npm runtime deps** in CLI core (sub-250KB)

## Competitive Positioning

ox coexists with Backboard (model routing + memory), OpenWhispr (voice), browser tools — doesn't replace them. We speak their formats, don't fork them.

## Status

All core surfaces exist. Demo-ready. Tests green (`npm test` for current totals).

## Next Steps

1. Ship desktop voice button (Q4)
2. Expand operator toolset (clipboard, contacts) (Q4)
3. Multi-model voice routing via Backboard (Q1)
