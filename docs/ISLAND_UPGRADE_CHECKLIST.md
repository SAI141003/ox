# OX Island (and ox) upgrade checklist

From the owner's videos and screenshots of October 16–17, 2026 and the latest
Coucou (`Louis-CFM/coucou`, MIT code, main at `434d6a2`, Oct 16), checked
against the island's own source. Coucou's name, Mochi, art and sounds are
reserved: its ideas and MIT code may be used, never its character.

States: ✓ the island has it · ~ partly · ✗ missing · → next to build

## Audit, October 19 (every row, against the code)

The tables further down were last edited on October 18 at 20:56. Nineteen
commits since then built rows they still mark ✗ or ~, so every row was
checked again. Proof, strongest first:
**live** = run on this Mac in this audit · **test** = a unit test in the
named file, passing in the full run · **build** = the island compiles with it
· **code** = found in the source but not run here · **owner** = needs the owner
at the Mac (speech, mic, Screen Recording, a second laptop, a phone) ·
**key** = needs a paid or personal key.

### A. Coucou

| # | State | Proof |
|---|---|---|
| A1 Allow / Deny / Always from the notch | ✓ installed for all five | live (October 20): `ox hooks status` shows Claude Code, Codex, Gemini CLI, Cursor and Copilot CLI connected (each config backed up first); each hook run on this Mac with a harmless end-of-session event, exit 0. Codex runs only hooks you have trusted: in Codex, `/hooks` once. Tests: agent-hooks, approval-island-race |
| A2 Questions answered in the notch | ✓ | test: agent-hooks; installed with A1 |
| A3 Live diff ticker, other agents too | ✓ | test: agent-hooks (lines added/removed from the edit's own input) |
| A4 Jump to a session's own terminal tab | ✓ | live: with Calculator in front, ox brought Terminal forward on the exact tab of a stand-in agent session (2.1 s). The check found that it had never worked (an AppleScript variable named `running`, a reserved word), fixed; test: agents-live |
| A5 Claude plan usage | ✓ installed | live: `statusLine` set in Claude Code's settings; test: statusline |
| A6 Integrations as pills | ✓ | open PRs and failing CI (gh); the newest Vercel deployment; your next Cal.com booking; today's failed n8n workflows: read-only with your own keys (test: integrations; tested with fake replies, no keys on this Mac). Open-source services only, by the owner's rule: Stripe, Notion and Resend left out |
| A7 Hold-to-dictate | ✓ | build; owner (speech) |
| A8 Hands-free, Esc, paste last | ✓ | build; owner |
| A9 Styles per app | ✓ | as said / natural / polished / prompt, set per app in the app (Settings › Voice › Dictation) or `ox dictation style`; test: dictation-style |
| A10 Dictation stats | ✓ | code: words, sessions, wpm, time saved and **per app** (Dictation.swift `Summary.apps`) |
| A11 Dictionary and snippets | ✓ | test: dictionary |
| A12 Translate a dictation, prompt mode | ✓ | translate and **prompt mode** (live October 20 through the server); test: dictation-style |
| A13 Parakeet offline speech | — | set aside by the owner (October 19); the hook stays: used first when parakeet-mlx is installed, else whisper.cpp |
| A14 Call notes, both sides | ✓ | code: SystemAudio.swift (ScreenCaptureKit); owner (Screen Recording) |
| A15 Floating pill | ✓ | build: DictationPill.swift; **new:** one tap on it finishes |
| A16 Drop a file on the notch | ✓ | build (Shelf) |
| A17 Drop the ox on a window | ✓ | code: IslandExtras.swift `window(at:)`, `drop(at:)` |
| A18 Character follows the cursor | ✓ | live: the opened island's ox turns to face the pointer (screenshots left and right). The notch-lane follow code had never been switched on; the notch opens under the pointer, so facing is done in the opened island |
| A19 Hover open, any display | ✓ | code: `island.screen active` (IslandPanel.swift) |
| A20 Weekly recap | ✓ | code: files changed and lines from git (IslandCards.swift) |
| A21 Your own sounds | ✓ | code: `ox island sound <event> <file>` (src/island.js) |
| A22 Worried when the Mac is hot or busy | ✓ | code: thermalState and getloadavg (IslandView.swift) |
| A23 Capture shortcut | ✓ | code: ⌃⌥S (IslandExtras.swift) |
| A24 10 languages | ✓ | `OxIsland --check-l10n` (earlier round) |
| A25 Phone app, lock screen, widgets | ✓ | desktop/ios (SwiftUI + Live Activity) and src/phone-bridge.js: pair with `ox phone pair` (QR), approvals in the app (Allow behind Face ID) and on the lock screen / Dynamic Island with Deny and Allow (Allow asks Face ID first). Proven: the app's Swift crypto against the bridge, and a Claude Code hook denied from the phone code end to end; the iPhone code type-checks against the iOS 26.2 SDK. Not run on a phone or simulator here (Xcode's iOS platform is not installed, low disk). Limit: a NEW approval reaches a locked phone with the app closed only through Apple push (paid developer account) |
| A26 Chat with any provider | ✓ | code (Tray chat) |

### B, C. Clicky and Claudex

| # | State | Proof |
|---|---|---|
| B1 Write the reply where you type | ✓ | code; owner (screen) |
| B2 Type a follow-up prompt | ✓ | code |
| B3 Skills | ✓ | test: market, skills |
| B4 Wake phrase | ✓ | code: WakeWord.swift; owner |
| C1 Rings with reset countdowns | ✓ | code: UsageRing, PlanPill (IslandHome.swift) |
| C2 Sessions per project | ✓ | test: agents-live |
| C3 Alerts at 80 / 95 % | ✓ | code |
| C4 Water estimate | ✓ | **new**, build: per tool (Claude, OpenAI, Gemini…) in the recap's water tooltip |

### D. Screenshots, Oct 16–17

| # | State | Proof |
|---|---|---|
| D1 agent-skills | ✓ | test: market |
| D2 Everything Claude Code | ✓ | code: default catalogue (src/market.js); MIT |
| D3 Paperclip / ox org | ✓ | test: org |
| D4 trim-1 idea | ✓ | test: trim-output (ox's own query-aware trim; the model itself not used) |
| D5 Video reasoning | ✓ | test: video-image-edit (`understand`: scene frames + transcript) |
| D6 n8n templates | ✓ | test: n8n-import |
| D7 Google ADK | ✓ | code: ADK skills featured (src/market.js) |
| D8 Fish Audio voice | — | Fish's ideas run on Kokoro (open; test: tts-stream); Fish's own voice is a paid API, left out by the owner's open-source rule |
| D9 Tesser remote dev servers | ✓ | on your own machines (no cloud bill): `ox mesh dev <machine>:<folder>`; the "dev" grant; only ports ox started are reachable (test: mesh, two nodes on this Mac; a real second laptop not tried) |
| D10 Diagram shapes | ✓ | test: openui-reliability (`Flow`, `Explainer` in src/ui-lang.js) |
| D11 Polaris / Polsia | — | context |

### F1. October 18 screenshots

| # | State | Proof |
|---|---|---|
| F1.1 Krea image edit | ✓ | test: video-image-edit; a real edit needs a paid image key |
| F1.2 Hire from one sentence | ✓ | test: org |
| F1.3 Freebuff: Open a PR in one click | ✓ | code: Open a PR in the app (src/web/chat.html, src/serve.js); modes already listed |
| F1.4 deepagents check | ✓ | live end to end on ox's own agent (free laguna-s-2.1 via OpenRouter): todo_write, a subagent reading two files, write_file NOTES.md, to-dos marked done, lessons saved. On the Claude plan, Claude Code's own TodoWrite is off in -p mode (its choice) |
| F1.5 Edit videos from chat | ✓ | test: video-image-edit |
| F1.6 Errand chips | ✓ | code: chips in an empty chat (Tray.swift) |
| F1.7 Interactive explainers | ✓ | test: openui-reliability |
| F1.8 Cloud teammate | ✓ | an ox org agent with its own computer: `ox org hire … --machine <paired machine>`; its runs happen there through ox mesh (test: org) |
| F1.9 Devin PR flow, wiki, app on the PR | ✓ | test: dev-flow, wiki |
| F1.10 Skill from a GitHub link | ✓ | code: src/skill-add.js; commit's live install of AlphaInsider#strategy-creator |
| F1.11 Voice glow | ✓ | code: VoiceLevel bars |
| F1.12 3D office | ✓ | /office and `ox office`: every live agent walks to the desk of what it is doing (Editor, Terminal, Browser, Library, Whiteboard, front desk, lounge), a 3D room on a canvas, drag to turn. Live with 16 agents |
| F1.13 Team memory in Slack | ✓ | test: channel-memory |
| F1.14 Book to skill | ✓ | test: book-skill |
| F1.15 Intelligent UI | ✓ | see E3 |
| F1.16 Hold Fn to talk | ✓ | code: FnKey (Buddy.swift); owner |
| F1.17 Manim-style explainers | ✓ | test: video-image-edit (`ox video explain`) |
| F1.18 Traces and stuck signals | ✓ | test: trace |
| F1.19–F1.22, F1.27 | — | context; F1.21 blink-when-poked ✓ (code) |
| F1.23 Per-agent threads | ✓ | test: org (`ox org thread`) |
| F1.24 Timeline, irreversible count | ✓ | test: org (`ox org timeline`) |
| F1.25 Worktree per task, PR on the board | ✓ | test: dev-flow |
| F1.26 Live map for other agents | ✓ | test: agent-hooks (A3) |
| F1.28 Computer use | ✓ | **new, live:** click and type (below) |
| F1.29 REA | ✓ | code: MCP template (src/mcp-templates.js), MIT |
| F1.30 Recordly idea | ✓ | test: video-image-edit (`polish`, ox's own code) |

### F2, F3. Recordings

| # | State | Proof |
|---|---|---|
| F2.1 Mail in the notch | ✓ | test: mail |
| F2.2 Live feed, approvals, done hop | ✓ | installed for all five agents (A1); lock screen through the phone app (A25) |
| F2.3 Coucou for Windows | ✓ | desktop/island-win: a native Tauri bar at the top of the screen (always on top, never takes the focus, grows on hover) showing ox's island (runs, approvals, shelf, focus); hold Ctrl+Alt+Space to talk, the words written where you are (/api/dictate, Whisper; Windows types by paste). Built on a Windows runner (island-windows workflow, run 39381101047: the island's tests pass on Windows, the NSIS and MSI installers are built); dictation checked on this Mac with real speech. Not tried on a Windows PC with a screen |
| F2.4 Pixie | ✓ | code; owner (voice) |
| F2.5 Research on X / Reddit / LinkedIn | ✓ | test: social-research; X and LinkedIn need a search key |
| F2.6 Clicky | ✓ | code |
| F2.7 Vovy | ✓ | code; **new:** click and type for apps |
| F2.8 Mission map, sessions canvas | ✓ | code: both pages in src/web/chat.html |
| F2.9 Claudex | ✓ | C1–C4 |
| F3.1 KODEMON | ✓ | levels from real work (Lv badge, "Lv↑" and a chime on the notch pills); battles: `ox org battle <a> <b> "<task>"` races two agents through ox race, the winner's change is kept ("captured", applied with --apply), both earn XP; `ox org levels` (tests: org, in a clean checkout of the pushed commit). The badge not seen live: no org agents on this Mac |
| F3.3 Environment recipe | ✓ | test: dev-flow (`.ox/environment.yml`) |
| F3.4 Calendar and weather | ✓ | code: day strip (src/serve.js) |
| F3.5 Interactive breakdowns | ✓ | see E3 |
| F3.6 Stripe pill | — | left out by the owner's choice (not open source); email draft ✓. **New:** "Am I a good developer?" answers from git with the real share ("Hmm… Claude wrote 100% of your code. 224 of your 225 commits this week name Claude. You're an excellent reviewer, though."): live through the island's voice route; the recap shows "% written with AI" (tests: offline, usage-log) |
| F3.8 Machines in sync | ✓ | test: mesh; a real two-laptop test needs the second laptop |
| F3.10 Agents gallery | ✓ | code: Favorite / I use this (src/web/chat.html) |

### G, H, E

| # | State | Proof |
|---|---|---|
| G1–G8 | ✓ as marked | tests: fast-browser, git-fast, market, arena, library; G2 still has no public weights |
| H1 Team from one sentence | ✓ | test: org (`ox org team`, `ox org say`) |
| H2 OpenDots | ✓ | calls: "call Ada" on the island puts you through to an ox org agent; it answers from its real task board, new work asked on the call becomes a task, "hang up" ends it. Live with a real model on a throwaway agent |
| E1 Test by clicking | ✓ | live with ox-hands (October 19): header, Chat, + and its five tabs, Pin, mic, session cards (4 of 4 switched focus), "Open this session" (card with messages, reply box, Go to Terminal), Mail, Recap, and an approval from a new Claude Code session (card shown with its risk; Deny returned `deny` to the hook). Found and fixed on the way: no sessions or plan usage after a restart until OX.app was opened (the island now starts `ox serve` itself); a new session's first approval could go to the terminal prompt (relay start wait 2 s → 6 s, island wait 2.5 s → 4 s); the card said "ox wants to run" for Claude Code; the recap showed 0 while loading; "+N more" sessions could not be reached (now a button, not clicked: only 4 sessions were live); ox-hands' clicks were faster than a hand and the island missed 2 of 3 (now 5 of 6). Two `allow` answers during testing were the owner's own clicks in the notch (confirmed); every island answer is now logged (`approval answered:` in ~/.ox/island.log) |
| E3 Interactive answers every time | ✓ | benchmark 20/20 clean (was 8/10): invented chart names (PieChart, LineChart…) draw as Chart; a drawing still broken after its own repair round is mended by the strongest model connected (test: openui-reliability) |
| E5, E6 | ✓ | D1, D2, D4, D6, D7 and ox org |

### Vovy (October 19, recording 16:34)

| Item | Proof |
|---|---|
| "Build me a pumpkin carver game with Claude": `ox make` and the same by voice: a new project, the idea as a full brief, Claude Code in a new Terminal tab, each step narrated in the notch, the app opened when done | live: built in about 3 min and opened; Claude Code's folder-trust question is left to you and said in the notch (test: make-app) |
| "Carve the smiley face": `draw` takes the cursor and draws shapes or any path (ox's agent with approval; Claude Code and Codex through ox mcp-mac) | live: a face carved into a test canvas, then into the pumpkin game Claude built; moving the mouse stops it; it never draws when the asked app's window is not under the point, and brings back a window parked by Stage Manager (test: mac-control) |

### lumiomac: "Claude Code vs Codex" and its notch office (recording 21:46, photo IMG_9415)

| What it shows | In ox | Proof |
|---|---|---|
| (Owner, October 20) No working Codex command: use the ChatGPT app's | ✓ ox uses the Codex inside the ChatGPT editor extension or the ChatGPT / Codex desktop app when the `codex` command is missing or broken, with a model your ChatGPT sign-in allows | live: the broken `codex` command skipped; the ChatGPT extension's codex-cli 0.162 (signed in) wrote a file on request with `gpt-6-luna`; newer Codex dropped `--full-auto`, ox now passes `--sandbox workspace-write --ask-for-approval on-request` (works on old and new); tests: make-app, race-live |
| The same prompt to Claude Code and Codex, watched from the notch: a timeline per tool with its time, moments pinned ("skills: design + tests", "test fails, on purpose", "bug… fixed", "30 games"), the finish ("Claude Code — 5m 49s") | ✓ `ox vs "<prompt>" --tools claude,codex` (also gemini, opencode, ox): each tool in its own folder and Terminal tab; moments read from each tool's own transcript (skills, a test written, failing, passing, a browser check); the notch shows one row per tool and the winner | tests: race-live (Claude and Codex transcript formats); notch screenshots; a real race not run here: Codex is installed but broken on this Mac (`npm install -g @openai/codex`), Gemini CLI and OpenCode not installed; ox vs says so before opening any tab |
| A clean top-down pixel office: desks with computers and chairs, windows, bookshelf, a stats board, a clock, coffee, cabinets, servers, a lounge; "Working: 1 · Resting: 1"; "Claude · 5 h 89%"; agents at their desks with tags ("Codex running a command", "Claude ✓"); coffee time when done | ✓ /office, `ox office`, and the Office tab in the notch: ox's own pixel sprites; agents sit and type (monitor shows code), stand with "needs you", rest in the lounge, go for coffee when just finished | live: the notch and the browser with 9 real sessions; demo screenshots |
| (Owner) Six or seven AI tools on one Mac: which is which | ✓ each tool its own colour (uniform, tag, legend: Claude, Codex, Copilot, Cursor, Gemini, Antigravity, Hermes, OpenCode, Continue, ox); Cursor, Gemini CLI and Continue now detected | test: agents-live |
| (Owner) Several machines controlled from one laptop | ✓ a floor per machine (this Mac, then every paired machine over ox mesh), each named by you; a machine that does not share its agents says how to allow it | /ox/office/floors live (this Mac); demo with three floors |

### Island design from the references (October 19, evening)

| Item | Proof |
|---|---|
| Vovy's step line: with the notch closed, a narrated step hangs under it (spinner, then a green check): ox make's steps and drawing with the cursor ("Drawing the left eye", from ox or Claude Code) | live screenshots |

### New in this round (October 19)

| Item | Proof |
|---|---|
| **Click and type**: `ui_elements`, `click`, `type_text`, `press_key` for Claude Code, Codex (`ox mcp-mac`) and ox's own agent | live on this Mac: Calculator pressed by button name, 9 × 6 = 54 and 7 × 8 shown right; test: mac-control |
| Fast: ox-hands (desktop/island/Sources/OxHands), ox's own helper on Apple's Accessibility and CoreGraphics, no AppleScript, nothing paid; it stays warm | live: a press 8–40 ms warm (80–400 ms through the MCP call with its checks), a window read ~150–250 ms; the first call ~3.5 s (start, app reopened) |
| Never presses Return, Enter, Send, Pay, Buy, Delete…; text is pasted, so a chat box is filled, not sent | test: mac-control; live: Return refused |
| No more "A keychain cannot be found to store Chrome": every Chrome ox starts (browser, PR shots, rendering, web island, app window) uses `--use-mock-keychain` | test: fast-browser, web-render, island-web (15/15) |
| One tap stops listening: the listening card, the mic (now a stop icon), the dictation chip, the pill; a tap while the mic starts cancels it; held-key listening ends after 45 s at most | live (mic button): start cancelled by a tap, listening stopped by a tap, silence ended it; the pill and chip taps not clicked yet |

**October 20, second pass:** every row of every table below now carries the
audited state (old marks kept as "was: …"), A1 is installed for all five
agents, and the app pages were checked by clicking: the Office section shows
the pixel office (floors, tool colours, legend), Mission map and Sessions
canvas say what they show (31 test tasks left in the real task store by an
old, since-fixed test were moved to ~/.ox/archive/tasks-from-tests), and
Studio's how-to recipes fold open and closed.

**Still open after this audit (October 20):** nothing built is missing. Left out by the
owner: A13 Parakeet (set aside), D8 Fish Audio and Stripe (paid, not open
source). Not run here: the iPhone app on a device (Xcode's iOS platform is
not installed), dev servers on a real second laptop.

## A. From Coucou (latest)

Checked again row by row on October 20 (code found, then run where it can be
run from here). ✓ = built and working; — = left out by the owner.

| # | Feature | State | Proof (October 20) |
|---|---|---|---|
| A1 | Allow / Deny / Always for other agents from the notch | ✓ | `ox hooks status`: Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI all connected (configs backed up first); each hook run here with a harmless event, exit 0; tests: agent-hooks, approval-island-race. Codex: trust the hooks once with `/hooks` |
| A2 | Answer an agent's multiple-choice question in the notch | ✓ | AskUserQuestion → cyan card → the choice goes back (src/agent-hooks.js, Bridge.swift); test: agent-hooks |
| A3 | Live diff ticker with +N −M, other agents too | ✓ | `diffStat` reads lines added/removed from each edit's own input (Claude edits, Codex patches); test: agent-hooks |
| A4 | Jump to a session's own terminal tab | ✓ | `focusByFolder` (src/agents-live.js); live October 19 (Terminal brought forward on the exact tab) |
| A5 | Plan usage with reset times | ✓ | `ox statusline` set as Claude Code's statusLine; Codex limits read; test: statusline |
| A6 | Integrations as pills | ✓ | GitHub PRs/CI, Vercel, Cal.com, n8n (src/integrations.js `servicePills`); test: integrations. Stripe, Notion, Resend left out (not open source) |
| A7 | Hold a key, speak, pasted anywhere | ✓ | ⌃⌥D (Dictation.swift) |
| A8 | Hands-free, Esc cancels, paste the last again | ✓ | double tap ⌃⌥D, Esc, ⌃⌥V (Dictation.swift, Buddy.swift) |
| A9 | Styles per app | ✓ | as said / natural / polished / **prompt**, per app; **new:** set in the app (Settings › Voice › Dictation: style, per-app list with Add and Remove, translate), clicked through here; test: dictation-style |
| A10 | Dictation stats: words, wpm, time saved, apps | ✓ | `Summary` with words, sessions, wpm, saved minutes and the top apps (Dictation.swift) |
| A11 | Dictionary and snippets | ✓ | test: dictionary |
| A12 | Translate (~70 languages) and prompt mode | ✓ | translate after the style (`ox dictation translate <language>` or Settings); **new: prompt mode**, a rough spoken idea pasted as a clear request to an AI tool. Live through the server: "um so like make the login page uh remember me for a week and also the button should be blue" came back as a clean prompt with goal, requirements and the expected result; test: dictation-style |
| A13 | Parakeet offline speech | — | set aside by the owner; whisper.cpp (and parakeet-mlx if installed) used |
| A14 | Call notes, both sides | ✓ | ScreenCaptureKit system audio + mic, whisper.cpp, You / Them, summary and to-dos (SystemAudio.swift, Notetaker.swift); needs Screen Recording allowed once |
| A15 | Floating pill | ✓ | DictationPill.swift: see-through, voice level, one tap finishes |
| A16 | Drop a file on the notch | ✓ | Shelf |
| A17 | Drop the character on a window as context | ✓ | `window(at:)`, `drop(at:)` (IslandExtras.swift) |
| A18 | Character follows the cursor | ✓ | `facesPointer` (OxWalker.swift); live October 19 |
| A19 | Open on hover, any display | ✓ | IslandPanel.swift (`island.screen active`, the mouse's screen) |
| A20 | Weekly recap with files and lines, shareable | ✓ | files changed, +/− lines, commits, % written with AI, Save as image (IslandCards.swift) |
| A21 | Your own sounds | ✓ | `ox island sound <event> <file>` (src/island.js, IslandExtras.swift) |
| A22 | Character reacts to the Mac's load | ✓ | thermalState and getloadavg (IslandView.swift) |
| A23 | Capture shortcut with a tick | ✓ | ⌃⌥S into the shelf with the capture sound (IslandExtras.swift; ⌘⇧S stays Save As) |
| A24 | 10 languages | ✓ | `OxIsland --check-l10n` |
| A25 | Phone: approvals, lock screen, widgets | ✓ | desktop/ios + src/phone-bridge.js (`ox phone pair`); bridge and crypto tested; not run on a phone here (Xcode's iOS platform not installed) |
| A26 | Chat in the notch with any provider | ✓ | Tray chat (Tray.swift) |

## B. From the videos

**Clicky (farza): a screen buddy that writes for you**
| # | Feature | Island now | |
|---|---|---|---|
| B1 | Say what you want; it writes the reply into the focused text box (Gmail, Slides…) in your style | ✓ **new**: "write a reply saying…", "draft a post…": ox reads the screen and writes it in your voice, pasted where you type; never sent | checked: command matching; image to model real |
| B2 | Types a good follow-up prompt into Claude Code's terminal | ✓ **new**: "type a good follow-up prompt": pasted, Return never pressed, and the island says what it does | |
| B3 | Skills library (e.g. a Y Combinator advice skill) | ✓ in ox (Marketplace) | |
| B4 | "Hey <name>" wake phrase | ✓ ("OK ox", your chosen name) | |

**Claudex: the notch as a live usage meter**
| # | Feature | Island now | |
|---|---|---|---|
| C1 | Rings per tool: session %, week %, model-week %, each with a reset countdown | ✓ now (audit at the top) — was: ~ | |
| C2 | "4 sessions working", listed per project with model; "Codex idle for 3 m" | ✓ **new**: Claude Code (CLI, desktop Code tab, worktrees) and Codex sessions read from their own session files (read-only), in the notch (count of those working), the open island (project · what it does now / idle for N m) and the app's Office | checked: this session and two worktree sessions shown live |
| C3 | Alert before the limit, not after | ✓ **new**: a notification at 80 % and 95 % of each window, once per reset period | |
| C4 | Water estimate per tool (litres, days of drinking water) | ✓ now (audit at the top) | |

## C. From the screenshots

| # | Item | What ox takes from it | |
|---|---|---|---|
| D1 | addyosmani/agent-skills (51k, MIT) | already in the Marketplace and installs | ✓ |
| D2 | affaan-m/ECC "Everything Claude Code" (311 skills, 71 sub-agents, MCP configs) | add as a Marketplace catalogue after its licence is checked | ✓ now (audit at the top) — was: → |
| D3 | Paperclip (101k, MIT): run a company of agents | task board ✓, **`ox org`** ✓: org chart, hiring with approval, pause/resume, monthly budgets per agent, heartbeats that run assigned tasks through ox / Claude Code / Codex | ✓ |
| D4 | caveman-ai/trim-1: a 1.2 MB model that keeps only the log lines a question needs | token saving: query-aware trimming of long tool output (own implementation first, then the model if its licence allows) | ✓ now (audit at the top) — was: → |
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
| Approving Claude Code / Codex from the notch | ✓ now (audit at the top) — was: built, not installed (A1) |
| Claude plan usage | ✓ now (audit at the top) — was: relay now built (A5), not installed |
| Live voice (Fn / ⌃⌥Space, mic), dictation pasting, call notes | need you at the Mac: speech and Accessibility cannot be driven from here |

## E. The owner's standing requests (October 18), cross-checked each round

| # | Request | State |
|---|---|---|
| E1 | Test the app like a person: every function, by clicking, not by API | ✓ now (audit at the top) — was: → in progress |
| E2 | Uploads: videos are not accepted | ✓ any file now: a video becomes frames the model sees (checked in the app: a dropped video was described correctly), PDFs give their text, everything else its path |
| E3 | Interactive answers (OpenUI) must work every time, not once in a while: measure the rate, fix the failures | ✓ now (audit at the top) |
| E4 | Better than Devin, and why (side by side, honest) | ✓ now (audit at the top) |
| E5 | Use the repos from the screenshots (agent-skills, ECC, n8n templates, ADK, trim-1) | ✓ now (audit at the top) — was: ~ D1 ✓, D4 ✓ (idea) |
| E6 | Use Paperclip fully (org chart, heartbeats, budgets, governance, adapters, sessions) | ✓ `ox org` (checked for real: a local-model agent woke, took its assigned task, wrote the file, task done). Still missing: a web page for the chart, comments and documents on tasks in the app |
| E7 | Keep this checklist current; go back and forth to cross-check | ✓ this file |

## F. The owner's October 18 batches (screenshots and screen recordings)

Every screenshot and recording sent on October 18, one line each. Nothing is ✓
until it has run for real. Licences are checked before any code is taken; for
AGPL, unlicensed or brand-protected work only the idea is used, in ox's own
code. Duplicates are noted where they appear.

States: ✓ done and tested · ~ partly · → building now · ✗ not yet · — context only, nothing to build

### F1. Screenshots: tools, repos and products

| # | Seen | What it is | What ox / the island gets | Licence | State |
|---|---|---|---|---|---|
| F1.1 | Krea | One prompt edits an image precisely, 2K in seconds | Studio "Edit image": pick an image, one prompt, edited image back (fal / OpenAI image edit), saved with its recipe | — | ✓ now (audit at the top) — was: ✗ |
| F1.2 | HKUDS/AutoAgent (9.8k) | Build agents and teams from plain language | `ox org hire "<one sentence>"`: title, role, runtime, schedule and instructions filled in from the sentence | MIT | ✓ now (audit at the top) — was: ✗ |
| F1.3 | Freebuff | Free coding agent; modes Build / Plan / Mission / Skills; "Open a PR" | ox is free with no ads. In the app: a one-click **Open a PR** after a change; modes as clear as theirs | — | ✓ now (audit at the top) — was: ✗ |
| F1.4 | langchain-ai/deepagents (30k) | Sub-agents, pluggable filesystem, context summarising + offload, sandboxed shell, persistent memory | Each one exists in ox; check each works from the app and the island chat | MIT | ✓ now (audit at the top) — was: ✗ check |
| F1.5 | "Claude can edit your videos" | Watch (frames), hear (Whisper), edit (ffmpeg), animate (Remotion, HTML→MP4), captions, yt-dlp, research | Uploads: frames ✓. Next: speech-to-text of an uploaded video/audio (local whisper), and "cut / caption / clip / speed up this" with ffmpeg from chat | — | ✓ now (audit at the top) — was: ~ |
| F1.6 | Wajo | Errands in plain words: cancel a subscription, track a package, book a table | Island chips for everyday errands; ox drafts and finds, never sends or pays (owner rule) | — | ✓ now (audit at the top) — was: ✗ |
| F1.7 | `/anatomy` skill | "Explain how a rocket engine works, interactive" | Interactive explainers: a diagram with clickable steps (Svg + Segmented) on a capable model | — | ✓ now (audit at the top) — was: ✗ |
| F1.8 | Sauna.ai | "A teammate with its own cloud computer" | ox org agents run on the Mac; a remote runner later (same gap as Devin) | — | ✓ now (audit at the top) — was: ✗ later |
| F1.9 | Devin (devin.ai) | Cloud or local; tests in its own browser; keeps going until the PR can merge; sidebar Automations / Security / Review / Wiki; a test recording in the PR | ox: a PR flow (branch → commit → PR → read and answer review comments), a browser test recording attached to the PR, a Wiki page from `ox graph` | — | ✓ now (audit at the top) — was: ✗ |
| F1.10 | AlphaInsider/skills | "Install the strategy-creator skill from <GitHub URL>, confirm where it went and whether it is ready" | `ox skill install <github url>[#name]` from chat and the island; reports the path and a ready check | check | ✓ now (audit at the top) — was: ✗ check |
| F1.11 | Glance / Murmure | Local dictation, instant, no subscription, "light that dances with your voice" | Island dictation is local ✓; add a voice-level glow on the notch while listening | — | ✓ now (audit at the top) — was: ~ |
| F1.12 | the-delegation | A 3D playground where agents walk around an office | ox's Office (pixel office) ✓; idea: agents walk to the desk of the tool they use | check | ✓ now (audit at the top) — was: ~ |
| F1.13 | company-brain | A Slack teammate that remembers everything the team says and does the work | ox gateways (Slack, Telegram, Discord) + memory; check a team channel's memory is kept per channel and searchable | Apache-2.0 | ✓ now (audit at the top) — was: ✗ check |
| F1.14 | virgiliojr94/book-to-skill | Turns a book or folder of docs into a skill; 24–51× fewer tokens than pasting the book | `ox skill from <pdf|folder>`: chapters → a SKILL.md with an index and per-chapter files the agent loads on demand | MIT | ✗ |
| F1.15 | GPT-6 "Intelligent UI" | Split the bill, take photos after dark: answers you can use | ox Interactive answers (measured above) | — | ✓ now (audit at the top) — was: ~ |
| F1.16 | Coucou "Hold fn, just talk" | Dictation, learns your words, notes of every call, offline, unlimited | Island dictation ✓, dictionary ✓; call notes mic only (A14); Fn hold as a trigger | MIT (ideas) | ✓ now (audit at the top) — was: ~ |
| F1.17 | ManimGX | Fast 3D math animation engine for agents (Manim API) | Studio/video: "animate this explanation" through Manim when installed | MIT | ✓ now (audit at the top) — was: ✗ |
| F1.18 | lmnr-ai/laminar | Agent observability: traces, plain-English signals ("agent stuck in a loop"), evals, SQL | ox run traces: every turn's tool calls and tokens kept and viewable; a loop / stuck signal raised to the island | Apache-2.0 | ✓ now (audit at the top) — was: ✗ |
| F1.19 | NVIDIA "Build Vision Agent" | One prompt → a camera-monitoring system with alerts, search, incident reports | Idea only: a flow template "watch a folder of images/clips and alert" | — | — |
| F1.20 | Omarchy (DHH) | An agentic Linux desktop | Context; ox runs on Linux | MIT | — |
| F1.21 | `/page-mascot` skill | A character at the top of a page that follows the cursor and blinks when poked | The island character already follows the cursor (A18); add blink-when-poked | — | ✓ now (audit at the top) — was: ~ |
| F1.22 | storytold/photocraft | A Photoshop rebuilt in Rust (early alpha) | Context: image editing stays in Studio (F1.1) | MIT/Apache | — |
| F1.23 | gitbot-hq/GitBot | Reusable bots running Claude Code / Codex / OpenCode on your repos, each with a job, a place and threads you return to | `ox org` agents ✓ (runtime, folder, instructions); add per-agent threads you can reopen in the app | MIT | ✓ now (audit at the top) — was: ~ |
| F1.24 | Grok Bot "GPU night shift" | Agents scout / quant / risk / exec with you approving; "0 irreversible"; a timeline of who did what | `ox org` dashboard in the app: each agent's lane, approvals, an activity timeline, an "irreversible actions: 0" count | — | ✓ now (audit at the top) — was: ✗ |
| F1.25 | OrchestratorInc/agent-orchestrator | Plan, run, supervise coding agents: a worktree per worker, PR / CI / review in a live Kanban | Task board ✓ + `ox org` ✓; add worktree per task and PR/CI state on the board | Apache-2.0 | ✓ now (audit at the top) — was: ~ |
| F1.26 | sodiumsun/agenttrail | Live project map of what coding agents do: plans, tool calls, files, progress | Island live diff for ox runs ✓ (A3); extend to Claude Code / Codex through their hooks | MIT | ✓ now (audit at the top) — was: ~ |
| F1.27 | awesome-fly | Fruit-fly connectome projects | — not related to ox | CC0 | — |
| F1.28 | trycua/cua | Desktops for agents: Cua Spaces, Lume VMs, desktop automation, computer-use bench | ox computer use on the Mac ✓ (operator); later: run risky computer-use inside a Lume VM | MIT | ✓ now (audit at the top) — was: ~ |
| F1.29 | REA "Reverse Engineer Anything" | One MCP for reverse engineering | Marketplace entry once its licence is checked | check | ✓ now (audit at the top) — was: ✗ |
| F1.30 | webadderall/Recordly | Screen recorder that adds zooms, cursor polish, backgrounds | Idea only (AGPL): "make a polished demo of this screen recording" via ffmpeg zoom/pan in ox's own code | AGPL-3.0 | ✓ now (audit at the top) — was: ✗ idea |

### F2. Screen recordings (first set: 11 files, 2 exact duplicates)

| # | Recording | What it shows (frames + speech) | What the island / ox gets | State |
|---|---|---|---|---|
| F2.1 | 10-13 21:07 (louis_rlee, Coucou) | Mail in the notch: unread list (Arnaud, Léa, Figma, GitHub, Stripe, Vercel), open one, **Reply**, **Mark as read**, **Open in Mail** | Island mail card with open / reply (draft, never sent) / mark read / open in Mail | ✓ mail card (unread list when Mail is open, open, reply as a draft, mark read, open in Mail) |
| F2.2 | 10-14 18:16 (Coucou) | Live feed of what Claude Code reads / edits / runs; **Allow / Deny / Always** in the notch; answering Claude's multiple-choice question in the notch; happy jump on "Done, 48 tests passed"; lock-screen approvals with Face ID; works with Claude, Codex, Cursor, Gemini; no account | A1 approvals (built, install step), A2 questions in the notch, done animation, phone later (A25) | ✓ now (audit at the top) |
| F2.3 | 10-15 14:33 (Coucou 0.5 for Windows) | Coucou app window: Flow stats (11,204 words, 196 sessions…), Notetaker, settings; hold a key to talk; "learns your words"; notes of every call (mic + computer audio); "OK Coucou" | Dictation stats (A10), call notes with system audio (A14), wake phrase ✓ | ✓ now (audit at the top) — was: ~ |
| F2.4 | 10-16 3 (agentmaxxing, "Pixie") | Voice: play a song, "make yourself smaller and turn down the volume", read today's to-dos, **explain the YouTube video on screen by drawing circles and arrows over it** | Songs ✓, smaller ✓, volume ✓, to-dos ✓; new: **screen annotation overlay** (draw circles/arrows/labels over the screen while explaining) | ✓ songs, smaller + volume, to-dos, circles / arrows / boxes drawn over the screen, album art |
| F2.5 | 10-16 20 (deployaibots, AgentReach for Hermes) | One-command skill so the agent researches LinkedIn, YouTube, Instagram, X without separate API keys | `research` across platforms through public pages and transcripts ✓ (YouTube); add X/Reddit/LinkedIn public search via web search; respect each site's terms | ✓ now (audit at the top) — was: ~ |
| F2.6 | 10-16 21 = 10-16 23 (farza, Clicky) | "Write the reply in my Gmail box in my voice" from screen context; "type a good follow-up prompt into the Claude Code terminal and explain it"; skills in the product (YC skill) | B1 write-for-me into the focused field (draft, user sends), B2 follow-up prompt, skills ✓ | ✓ write-for-me (B1), follow-up prompt (B2), skills |
| F2.7 | 10-16 22 (Vovy) | Voice computer-use: open Spotify and play a track, find Callaway irons in Chrome, "build an app" | ✓ open app + play, ✓ open a search; building apps by voice goes to an agent | ✓ now (audit at the top) — was: ~ |
| F2.8 | 10-16 23-16-40 = 10-16 24 (luciomakes) | A canvas of many agent terminals instead of a grid; a **mission map** (tree of tasks/agents); tools menu: Presets, GitHub, Code, Markdown, Mission Map, Memory, Skills, Loops, Settings; "resets 2:39 pm" | App: a mission-map view of tasks and agents (goal tree from the board), plan reset time in the notch ✓ (Codex) / Claude via relay | ✓ now (audit at the top) — was: ✗ |
| F2.9 | 10-17 22:42 (Claudex) | Notch usage meter: Claude and Codex session %, weekly %, reset timers, sessions per project, **mascot panics past 80 %**, water estimate | Rings (C1), sessions list (C2), alerts ✓ (C3), stressed character (A22), water with a stated method (C4) | ✓ now (audit at the top) — was: ~ |

### F3. Screen recordings (second set: 10 files)

Filled in from each recording's frames and speech below.

| # | Recording | What it shows (frames + speech) | What the island / ox gets | State |
|---|---|---|---|---|
| F3.1 | 10-13 10:51 (KODEMON) | Coding agents as creatures that level up and fight; "skills are attacks"; capture | Idea only: a playful side to ox org (each agent's level from tasks done); not a priority | — |
| F3.2 | 10-13 22 | Same clip as F2.1 (Coucou mail in the notch) | see F2.1 | dup |
| F3.3 | 10-14 12:30 (Devin ad) | Asked from Slack to upgrade Next.js: fixes the dependency conflict, the TypeScript errors, lint, build, then opens a PR with CI green; runs in its own cloud machine; **"Save to environment"**: install / lint / build / start steps kept for next time | ox: a per-repo **environment recipe** (`.ox/environment.yml`: install, lint, build, start) written after the first successful run and used by later runs and `ox org` agents; Slack-started PR flow (with F1.9) | ✓ now (audit at the top) — was: ✗ |
| F3.4 | 10-14 12:34 (theaiskool) | A Mac app that turns the Dock into a hub of 160+ widgets with AI usage tracking | Island widgets: usage ✓, music ✓, focus ✓, clips ✓, shelf ✓; next: calendar (next event) and weather in the idle card | ✓ now (audit at the top) — was: ~ |
| F3.5 | 10-14 13:54 (ChatGPT) | "Interactive breakdowns": a credit-card payoff slider instead of a lecture | ox Interactive answers (measured: E3) | ✓ now (audit at the top) — was: ~ |
| F3.6 | 10-14 14:12 (Coucou, talk) | "Did anybody pay me today?" → Stripe card, 3 payments, €1,240; "Write an email to Camille, tell her it's done" → a draft in the notch with Send / Cancel ("you just have to hit send"); joking personality ("Claude wrote 90 % of your code. Rude.") | Stripe pill (needs your key; read-only); email draft card in the notch (draft only, you press Send in Mail — owner rule); a little personality in short answers | ✓ now (audit at the top) |
| F3.7 | 10-14 19 | Same video as F2.2 (Coucou permissions, lock screen) | see F2.2 | dup |
| F3.8 | 10-15 13 (Reason) | Agents and developers in one place: mention teammates, work from Slack, your computers in sync, stack your subscriptions (Gemini, ChatGPT, Claude), connect bots, "your Claudes talk to each other" | Agent-to-agent mailboxes ✓, plans stacked ✓, Slack gateway ✓; ✗ two Macs in sync | ✓ now (audit at the top) — was: ~ |
| F3.9 | 10-15 15 | Same video as F2.3 (Coucou for Windows) | see F2.3 | dup |
| F3.10 | 10-16 19:12 (Little Agent Club) | A gallery of agents, each a character card (Muse, dots, Instinct, OpenClaw, Cue, Hark, MausBot, Poke, Hermes): what it does, price, Favorite / "I use this" | Marketplace / `ox agent` list as character cards with Favorite and "I use this" | ✓ now (audit at the top) — was: ✗ |

### F4. The island, read line by line (October 18)

Every Swift file read; each defect below was found in the code and fixed, then
the island was rebuilt. "Checked" says how the fix was proven.

| # | Defect found | Fix | Checked |
|---|---|---|---|
| F4.1 | "make the text smaller", "can you close the tab", "hide the dock" were taken as island commands and swallowed; a bare "close" did nothing | Island commands match only when the whole clause is about the island | `OxIsland --check-commands` |
| F4.2 | "Make yourself smaller and turn down the volume" did the first half only | Clauses split; the island does its part, the rest goes to ox | `--check-commands` |
| F4.3 | With a terminal run open, "play Billie Jean" was sent into the coding run | Errands go to ox's no-AI router first (`offlineOnly`), even with a run open | unit test on `/ox/voice` + live try |
| F4.4 | Plan gauges called every non-Codex plan "Claude" | Label from the plan id (Claude, ChatGPT, Gemini, Cursor, Copilot…) | `--check-commands` |
| F4.5 | A typed chat message to a live run was answered out loud | Only spoken questions are spoken | code path |
| F4.6 | A hung ox run kept the chat busy forever | Runs stop after 20 min (logged) | code path |
| F4.7 | Screenshots of your screen and voice recordings piled up in the temp folder | Deleted after 10 minutes | live try |
| F4.8 | Holding the talk key while ox spoke recorded ox's own voice | Speaking stops before listening | code path |
| F4.9 | "Start ox in a terminal" shown when ox simply wasn't found | Says to open the OX app once | code path |
| F4.10 | "The run is still open in your terminal" shown for app and island runs | Message fits where the run came from | code path |
| F4.11 | Approval card showed one line of a long command | Up to three lines, the whole text on hover | screenshot |
| F4.12 | Notch geometry recomputed 60 times a second | Cached, refreshed when displays change | code path |
| F4.13 | A dictation that failed to start left « OK ox » off | The microphone is handed back | code path |
| F4.14 | Two calls in the same minute overwrote each other's notes | Seconds in the file name | code path |
| F4.15 | OX.app kept a dead page after its server stopped (an update, `ox app stop`); reopening did not bring it back | The window reconnects: a failed load or reopening asks ox for the server again | live: app restarted, board answered |
| F4.16 | The island found the app only through serve.json, which OX.app's server does not always write | Reads serve.json or app.json, skipping a file whose process is gone | live: island showed the app's board |
| F4.17 | Other agents' sessions (this Claude Code session, worktree sessions) were invisible to ox and the island | src/agents-live.js, merged into /ox/live: Claude Code, Codex, Copilot, Hermes, OpenCode, Antigravity | test/agents-live.test.js + notch screenshot, real island screenshot |
| F4.18 | A click on the island (a session, Allow / Deny, a tray tool) could be used up just bringing the panel forward | The island takes the first click (acceptsFirstMouse) | real island: card opened |
| F4.19 | The island closed 6 s after the pointer left, even while you typed in it | It stays while it has the keyboard | real island screenshot |
| F4.20 | The open island put the session list above the walking-ox floor, so it grew tall (unlike Coucou / Claudex) | With sessions listed the floor goes; small characters in the rows; up to 4 rows, working ones first | real island screenshot |
| F4.22 | Messaging a Codex session from the island failed: Codex's config named gpt-5.5, which the ChatGPT account may not use; the raw error JSON was shown | Resume with a model the account allows; errors shown as words | real: "pong" came back from a Codex session |
| F4.23 | `ox -p … --image f` printed the help (the flag was documented, not parsed); with a plan, the image was dropped | Parsed; plan runs get the image as a file | real: "A screenshot of a dark chat app." |
| F4.24 | The ox had been taken out of the open island | Back, in the card's left like Mochi; its face is the most urgent state; on alert past 80 % of a plan limit (Claudex) | real island screenshot |
| F4.21 | No way to open a session from the island, read it, message it or take it over | Click a session's character: its last messages, a message box (one turn through the tool's own resume; waits while the session is busy in its own window), Open in Terminal | test/agents-live.test.js; real island shows the conversation |
| F4.25 | The ox stood and walked only; no eating, sleeping or reacting | New renders from the Blender rig: graze, doze, gallop (working), think, alert (needs you), happy (done), dizzy (error), worried (past 80 % of a plan) | real island screenshot |
| F4.26 | Every other agent shared one pixel character | Friends Puff, Pebble (first named Pip) and Dot (white, white with black; never black), same rig, 12 cycles each; each session gets one by its id | real island screenshot |
| F4.27 | "Save as image" and dictation stats had nowhere to live | Recap card (7 days of tokens and cost, top model, words dictated, water estimate) and mail card under the plus tab | build + screenshot |

## G. The owner's October 18 evening batch (screenshots and two recordings)

Licences are checked before any code is taken. A product's name, mascot and art are its own.

| # | Source | What it shows | What ox takes from it | Licence | State |
|---|---|---|---|---|---|
| G1 | pinchtab/pinchtab | A 12 MB Go server that gives agents direct Chrome control over HTTP, 10–20 % fewer tokens than agent-browser | ox's browser tools as a background daemon reused across runs, compact page snapshots (accessibility tree, not screenshots) to cut tokens | Apache-2.0 | ✓ web_task backend, MCP template, Marketplace entry (needs brew install pinchtab/tap/pinchtab); MIT, not Apache as the video said |
| G2 | Microsoft MAI-Code-1.1-Flash, "Hybrid Intelligence" | A coding model that runs locally; Copilot uses local models on the PC | ox already runs local models; add it to the local model catalogue when its weights are public, and a hybrid router: local first, cloud when needed | — | ✓ now (audit at the top) |
| G3 | feder-cr/git-ai + "scaled git" (Anthropic's blog) | Git designed for AI agents; mirrors so CI jobs, dev environments and agent sandboxes do not each fetch everything | ox worktrees per task (built) share one object store; add a local mirror cache for agent sandboxes and parallel worktrees | MIT | ✓ ox git clone: one local mirror per repo, clones borrow its history (2.1 s vs 5.1 s on pinchtab); worktrees share objects already. git-ai itself: licence unclear, idea only |
| G4 | usestrix/strix | Open-source AI agents that pentest your own apps | Marketplace entry after its licence is checked; security review skill already in ox | check | ✓ Marketplace tool entry (Apache-2.0): pipx install strix-agent; your own apps only |
| G5 | Google agents-cli | CLI and skills for building agents on Gemini Enterprise Agent Platform; works with Claude Code, Codex, Antigravity | Featured with the ADK skills in the Marketplace | Apache-2.0 | ✓ seven agents-cli skills featured (Apache-2.0); workflow skill installed for real |
| G6 | stablyai/orca | Run Codex, Claude Code, OpenCode side by side, each in its own worktree, tracked in one place; a mobile companion | ox has worktree-per-task and every agent's sessions in the island; add parallel runs of several agents on one task, side by side, and phone follow-ups | Apache-2.0 | ✓ ox race: several agents on one task side by side, each in its own worktree, compared, keep one (checked with two local models); phone follow-ups through the Telegram gateway |
| G7 | Recording 08:25 (theaiskool, "Gloss") | Saved articles, PDFs and bookmarks as a bookshelf library; connect your agent; it shelves for you; highlight any line and ask | An ox Library: save links and PDFs, a shelf view in the app, highlight and ask, and the agent can add to it | — | ✓ Library: save links and PDFs, shelf, reader, highlight and ask, ox saves for you, and any agent connects over MCP (ox library connect: Claude Code, Codex, any MCP app); checked with a real essay and PDF. Importing X bookmarks needs X sign-in, not done |
| G8 | Recording 16:20 (Pushary, mascot Pip) | Live agents in the notch; approvals with a risk summary; questions with numbered options and "type your answer"; a happy hop when done; approvals on the phone with Face ID; safe commands run on their own, risky ones wait | Risk line on approval cards, a typed answer for questions, safe tools allowed automatically for connected agents, phone approvals through ox's own gateways. ox's friend formerly named Pip is renamed so ox never shares Pushary's mascot name | — | ✓ risk line, typed answers, safe calls on their own (ox hooks safe off), phone approvals through the Telegram gateway; our Pip renamed Pebble. Face ID: the phone's own lock, no app of ours |

## H. October 18, night

| # | Source | What it shows | What ox takes from it | Licence | State |
|---|---|---|---|---|---|
| H1 | DeepSeek Bot (a plugin for DeepSeek Harness) | A "Chief of Staff" bot: say the team you want; it creates the bots (Writer, Coder) and starts a group chat with them | `ox org team "<sentence>"`: the chief drafts the hires from one sentence, you approve, and the team gets one group thread where they talk and you join | Apache-2.0 (per the screenshot; repo not found to confirm) | ✓ now (audit at the top) — was: → |
| H2 | CopilotKit/OpenDots | Always-on AI coworkers that move between text, calls and Slack, each with its own computer, web and mobile | ox org agents wake on a schedule (always on), Slack gateway with channel memory, phone through Telegram, each agent in its own worktree or on another machine (mesh). Calls: not built | MIT | ✓ now (audit at the top) — was: ~ |

## October 20, evening: 9 screenshots and 3 recordings

| Seen | In ox | Proof |
|---|---|---|
| Coucou updates itself from the notch: asks once, "0.5.3 is out" Update now / What's new / Later, checks the signature, swaps, restarts, "Up to date" | ✓ the island asks once; the server checks ox's GitHub every few hours (its own process); the notch says "N updates for ox" at most once a day; Update now: only from github.com/SAI141003/ox, fast-forward only, new code must load or ox goes back; island rebuilt and restarted; "ox is up to date" | test: self-update (real git repos, a broken update rolled back, your own commits never overwritten); live: the ask card answered in the notch, check on this Mac finds origin/main |
| ShogunAI: Ask over mail, meetings and notes with sources | ✓ ox brain also searches call notes (~/ox-notes) and the library, read-only, each hit saying where it came from | test: brain |
| ShogunAI: today's schedule and priorities every morning | ✓ `ox today` (and /ox/today): today's events, what needs you, what changed since yesterday, what is ready; Calendar and Mail read only when open | test: today; live on this Mac |
| ShogunAI: Write anywhere, Meetings | ✓ already (B1, A14) | |
| ShogunAI: Visual recall (search what you saw on screen) | ✓ as a skill, by the owner's choice (not an app feature): `screen-recall` saves what is on screen when you ask, as words in ox brain, never in the background, never passwords or bank pages | skills/screen-recall |
| luciomakes: 26 agents on a canvas, tools menu | ✓ already (Sessions canvas, Mission map, Library, Skills); Loops as a skill: `loop-until-done` (a real check, a round limit, stop on the same failure twice) | skills/loop-until-done |
| WeKnora, OpenWhispr, OpenProject, Cal.com, ComfyUI, Open Design, gbrain, Agent Reach | ✓ in the marketplace with checked licences, each noting ox's own take | live: GitHub API |
| ComfyUI's node graph | ✓ Studio provider: your ComfyUI runs the standard graph or your own Save (API) workflow | test: comfyui (stand-in server) |
| Skills for Real Engineers (mattpocock/skills), Anatomy skill | ✓ in the marketplace (10 + 1 skills, MIT) | live: resolved on GitHub |
| Four-agent trading team (simulated) | ✓ as a skill: `paper-trading-team` (scanner, risk with veto, paper trader, exits; a CSV ledger; simulation only, never real orders) | skills/paper-trading-team |
| (Owner) Tokens for each message, in the app and the island | ✓ app: under every answer, always shown: total, in, out, from cache, time; island: each session's tokens on its row and tile (ox's runs so far; Claude Code's and Codex's newest message, from their own transcripts) | live: "2,879 tokens · 2,875 in · 4 out · 432 from cache · 8.89 s"; /ox/live carries tokens for the island |
