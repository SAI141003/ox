# OX Island (and ox) upgrade checklist

From the owner's videos and screenshots of October 16–17, 2026 and the latest
Coucou (`Louis-CFM/coucou`, MIT code, main at `434d6a2`, Oct 16), checked
against the island's own source. Coucou's name, Mochi, art and sounds are
reserved: its ideas and MIT code may be used, never its character.

States: ✓ the island has it · ~ partly · ✗ missing · → next to build

## A. From Coucou (latest)

| # | Feature | Island now | |
|---|---|---|---|
| A1 | Approve other agents from the notch: Allow / Deny / Always for Claude Code, Codex, Gemini CLI, Cursor, Copilot… (through each agent's hooks; installer shows the diff and keeps a dated backup) | ~ **built, not installed on this Mac**: `ox hooks install claude` (codex, gemini, cursor, copilot) | your step: run it once |
| A2 | Answer an agent's multiple-choice question (AskUserQuestion) in the notch | ✗ | → with A1 |
| A3 | Live diff ticker: each file an agent edits with +N −M; click opens the diff | ~ ox runs only | |
| A4 | Jump to the exact terminal window of a session | ✗ | |
| A5 | Plan usage: Claude 5-hour and weekly, Codex limits, reset times | ~ Codex real; Claude: **relay built** (`ox statusline`, installed with `ox hooks install claude`, keeps your own status line) | your step: same install |
| A6 | Integrations as pills/cards: GitHub (PRs, CI, reviews), Vercel, Stripe, n8n, Resend, Notion, Cal.com | ✗ | |
| A7 | Flow dictation: hold a key, speak, pasted anywhere | ✓ (⌃⌥D) | |
| A8 | Hands-free: two quick taps keep listening; Esc cancels; paste the last dictation again | ✗ | → |
| A9 | Styles: optional clean-up of a dictation by a model, per app (as said / natural / polished) | ✗ | → |
| A10 | Dictation statistics: words, time saved, words per minute, apps | ✗ | → |
| A11 | Dictionary and snippets | ✓ | |
| A12 | Translate a dictation into ~70 languages; prompt mode | ✗ | |
| A13 | Parakeet offline speech (25 languages) | ✗ (Apple's on-device speech) | |
| A14 | Notetaker: the other side of the call too (system audio), speakers named, summary and to-dos | ~ mic only | |
| A15 | The pill: see-through, bottom or side of the screen, toolbar on hover, voice level dots | ✗ | |
| A16 | Drop a file on the notch, ask about it or email it | ✓ (Shelf) | |
| A17 | Drag the character onto a window to give it as context | ✗ | |
| A18 | Character on the desktop, follows the cursor | ~ | |
| A19 | Open on hover; invisible when idle; any Mac and several displays | ~ | |
| A20 | Weekly recap (time, sessions, files, lines, top agent), shareable image | ✗ | → |
| A21 | Your own sounds (drop a file to replace one) | ✗ | |
| A22 | Character reacts to the Mac's load (stressed when hot or busy) | ✗ | → |
| A23 | Capture shortcut (⌘⇧S) with a tick | ✗ | |
| A24 | 10 languages | ✗ | |
| A25 | iPhone / Android: approvals from the phone, widgets, Live Activity | ✗ | needs a phone app |
| A26 | Chat in the notch with any provider, switchable | ✓ (Tray chat through ox) | |

## B. From the videos

**Clicky (farza): a screen buddy that writes for you**
| # | Feature | Island now | |
|---|---|---|---|
| B1 | Say what you want; it writes the reply into the focused text box (Gmail, Slides…) in your style | ~ dictation pastes your words, not a written reply | → "write it for me" mode |
| B2 | Types a good follow-up prompt into Claude Code's terminal | ~ ox can, deliberately not offered to plans | |
| B3 | Skills library (e.g. a Y Combinator advice skill) | ✓ in ox (Marketplace) | |
| B4 | "Hey <name>" wake phrase | ✓ ("OK ox", your chosen name) | |

**Claudex: the notch as a live usage meter**
| # | Feature | Island now | |
|---|---|---|---|
| C1 | Rings per tool: session %, week %, model-week %, each with a reset countdown | ~ | → |
| C2 | "4 sessions working", listed per project with model; "Codex idle for 3 m" | ~ ox runs only | → from Claude Code's and Codex's own session files (read-only, as `ox transfer` reads them) |
| C3 | Alert before the limit, not after | ✓ **new**: a notification at 80 % and 95 % of each window, once per reset period | |
| C4 | Water estimate per tool (litres, days of drinking water) | ✗ | → with a stated method |

## C. From the screenshots

| # | Item | What ox takes from it | |
|---|---|---|---|
| D1 | addyosmani/agent-skills (51k, MIT) | already in the Marketplace and installs | ✓ |
| D2 | affaan-m/ECC "Everything Claude Code" (311 skills, 71 sub-agents, MCP configs) | add as a Marketplace catalogue after its licence is checked | → |
| D3 | Paperclip (101k, MIT): run a company of agents | task board ✓; next: org chart, heartbeats, budgets per agent | |
| D4 | caveman-ai/trim-1: a 1.2 MB model that keeps only the log lines a question needs | token saving: query-aware trimming of long tool output (own implementation first, then the model if its licence allows) | → |
| D5 | Elorian Glimpse: a model that reasons over video | ox already reads YouTube transcripts; next: local video files (frames + speech) | |
| D6 | awesome-n8n-templates (280+) | import n8n templates into ox Automations | |
| D7 | Google Agent Development Kit + agents-cli (Apache-2.0) | Marketplace entry; run ADK agents as bots | |
| D8 | Fish Audio S2.1 Pro TTS (90 ms voice agent) | another voice for the island (needs its key) | |
| D9 | Tesser: worktrees with dev servers offloaded to cloud machines | later: remote backends for heavy runs | |
| D10 | "/hairline": a slash skill that draws diagrams (funnels…) | Interactive answers already draw charts; add diagram shapes | |
| D11 | DeepMind Polaris (evaluating coding agents), Polsia (agents replacing a team) | context: public, honest benchmarks matter; no feature | |

## Test of the island as it is (October 17, late)

| Check | Result |
|---|---|
| Island running on this Mac | ✓ since 18:41, built after its last source change |
| Island builds from source (`swift build -c release`) | ✓ 30 s, 2 harmless warnings |
| 18 no-AI requests (time, date, maths, apps, sites, "open chrome and youtube", play a song, music controls, volume, timer, note, to-do, to-dos today, unread mail, email draft), dry run through the running app | ✓ every one routed right, 0–9 ms |
| Requests that need real work ("open whatsapp and message all my friends") | ✓ handed to an agent |
| "make the island smaller" | ✓ handled in the island itself (Bridge.swift), no model |
| Questions on the local model (qwen2.5:3b, offline) | ✓ correct, 0.8–3.8 s |
| `~/.ox/island.log` | not created: no request has gone through the island since its restart (it logs only what it handles); needs one real try by you |
| Approving Claude Code / Codex from the notch | built, not installed (A1) |
| Claude plan usage | relay now built (A5), not installed |
| Live voice (Fn / ⌃⌥Space, mic), dictation pasting, call notes | need you at the Mac: speech and Accessibility cannot be driven from here |
