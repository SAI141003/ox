# ox against every major coding agent (2026-11-06)

Built from each project's own docs, changelogs, release notes and GitHub data, read on 2026-11-06, and from ox's code and real runs. Y yes, P partly, N no, ? could not be verified from a first-party source (not the same as no), — does not apply. ox's cells marked "in PR" are in [the open pull request](https://github.com/SAI141003/ox/pulls) and not released yet.

"cocou" in the request was read as Claude Code, Claude Cowork and Codex.

## Taking over the laptop

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Controls desktop apps | Y (accessibility tree, any model) | Y (Mac + Windows, Pro/Max/Ultra only) | Y (Mac + Windows) | Y (Mac, Windows, Linux, any model) | P (cloud agents use their own computer) | P (phone nodes; desktop not documented) |
| Works in the background (your pointer stays yours) | Y (tested: TextEdit, 61 s) | N (hides your other apps while working) | Y (Mac only; Windows takes the pointer) | Y (all three platforms) | Y (in the cloud) | ? |
| Per-app permission with "always allow" | Y (in PR: once or always, by app) | P (per-app, per-session) | Y (saved under Always-allowed apps) | Y (Bounded mode, a reviewed manifest) | — | ? |
| Warns on apps that equal shell access (Terminal, Finder, System Settings) | Y (in PR: warns, never always-allowed) | Y | Y (refuses terminals outright) | P (blocks dangerous keys and shell text) | — | ? |
| Presses Return and any keyboard shortcut | Y (in PR: asks; lock, logout, force quit refused. Tested in TextEdit) | Y | Y (sensitive actions ask) | P (force delete and lock screen blocked) | — | ? |
| Stop from anywhere (Esc) | P (in PR: Esc needs the island's Accessibility; ox computer stop always works) | Y (Esc, key press swallowed) | ? | ? | — | ? |
| One session controls the screen at a time | Y (in PR: lock file) | Y (lock file) | P (several agents, background) | ? | — | ? |
| "Using your computer" notice | Y (in PR: macOS notification) | Y (notification each turn) | Y (picture-in-picture preview) | ? | — | ? |
| Keeps running with the lid closed or locked | Y (new: timer, turns sleep back on itself) | N (Mac must be awake; or use cloud) | Y (Locked use, Mac only) | ? | Y (cloud) | P (server install) |
| Refuses unattended screen actions | Y (in PR: schedules and daemon runs refused) | — (needs an interactive session) | ? | Y (cron refused) | — | ? |
| Voice on your own screen, with a pointer | Y (island, Fn to talk) | N | P (realtime voice, no pointer) | P (voice, wake word) | P (voice calls with agents (new Nov 6)) | P (voice on phone nodes) |
| Errands with no AI at all (music, apps, timers) | Y (0.1 s, offline) | N | N | N | N | N |

## Building things on its own

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Plan, write, run, fix loop | Y | Y | Y | Y | Y | Y |
| Failing test first, then proves the fix | Y (ox fix, ox build: ox runs it itself) | N (on request) | N (on request) | N (on request) | N (on request) | ? |
| Long goal that refuses "done" until proven | Y (/goal, ox auto) | P (workflows) | P | Y (goals, loops) | P (automations) | P |
| Type errors shown after each edit (LSP) | Y (in PR: tested with clangd; uses servers you have) | P (plugins) | ? | Y (edits in ms with LSP on) | Y (IDE) | ? |
| Sees its own app to check it (screenshots, clicks through) | P (possible by hand; not part of build) | Y (native apps, Chrome, iOS Simulator) | Y (computer use, browser) | Y | Y (records demos) | P |
| Survives provider rate limits without stalling | Y (in PR: waits, honours Retry-After, returns to main model) | Y (one vendor) | Y (one vendor) | Y (credential pools, fallback) | Y (one vendor) | Y (failover) |
| Scripts many tool calls in one step (fewer tokens) | N | Y (dynamic workflows) | ? | Y (execute_code) | ? | ? |
| Publishes what it builds to a live URL | P (ox deploy) | P (via connectors) | ? | ? | Y (Live Apps with database and sign-in) | ? |
| Language migration with proof | Y (ox port) | N (by prompting) | N (by prompting) | N (by prompting) | N (by prompting) | ? |

## Running several agents

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Subagents | Y (3 at once, ceiling 8) | Y | Y | Y | Y | Y (per-agent sessions) |
| Separate git worktree per agent | Y | Y | Y | P | Y | Y (workspace isolation) |
| Screen that shows all agents | Y (Office, /agents) | Y (agent view) | Y (command center (Nov 6)) | Y (Kanban, group chats) | Y (Agents window) | P |
| Same prompt raced on several tools | Y (ox vs, ox race) | ? | ? | P (mixture of agents) | P | ? |
| Moves a session between tools | Y (ox transfer: 7 tools) | ? | ? | P (importers) | ? | ? |
| Agents chat as a team | Y (ox org) | Y (agent teams) | P | Y (Bot Mode, A2A) | P | Y (routing) |

## Where it runs

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Terminal | Y | Y | Y | Y | Y | Y |
| Desktop app | Y (Mac best; 4 platform builds) | Y | Y | Y | Y | Y (Mac) |
| VS Code / JetBrains plugin | P (ACP only) | Y (both) | Y | P (ACP) | Y (is an IDE) | N |
| Runs in the cloud with your laptop off | N | Y (web, routines) | Y | P (Daytona, Modal, Vercel backends) | Y (up to 300 repos) | P (self-host) |
| Phone app that steers a session | P (iPhone companion: approvals) | Y (Remote Control, Dispatch) | Y (iOS) | P (phone web view) | Y (iOS with Siri) | Y (iOS, Android nodes) |
| Chat app control | P (Telegram, Discord, Slack) | P (Channels: Telegram, Discord, iMessage; Slack) | N | Y (20+ platforms) | P (Slack triggers) | Y (12+ including WhatsApp, Signal) |
| Several machines in one view | Y (mesh, Office floors) | ? | P (connected backends) | Y (all gateways in one window) | ? | P (nodes) |
| Runs code in Docker / SSH / remote sandbox | P (Docker backend) | Y (cloud) | Y (cloud) | Y (6 backends) | Y | P |
| Windows and Linux computer use | P (needs agent-desktop installed) | P (Desktop on Windows; no Linux) | P (Windows foreground; no Linux) | Y | — | ? |

## Models and cost

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Any model or provider | Y (35 providers) | P (Claude; 3 clouds) | P (OpenAI; custom providers) | Y | P (many, usage pools) | Y |
| Models on your own machine | Y (4 backends) | N | Y (custom local) | Y | N | Y |
| Small first request | Y (about 2,300 tokens, measured) | ? | ? | P (was 10,924 in our Oct test) | ? | ? |
| Drops old output on uncached providers | Y (new: from 32k tokens) | P (compaction) | P (compaction) | Y (compression) | P | ? |
| Hard spending stop | Y (--max-cost) | ? | ? | P (paid tool limits) | P (plan limits) | ? |
| Price shown on each paid tool call | N | ? | ? | Y | ? | ? |
| No account, no telemetry | Y | N | N | P (optional portal) | N | P (version check only) |

## Memory, skills and plugins

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Memory across sessions | Y (temporal graph) | Y (auto memory) | Y (memories) | Y (plus Honcho and others) | Y | Y |
| Learns new skills from its work | P (reviewed drafts) | P | N | Y (skills + curator) | Y (memories) | ? |
| Search past conversations | Y | Y | Y | Y (FTS5) | Y | Y |
| Hooks | Y | Y | Y | Y | Y | Y |
| MCP | Y | Y | Y | Y | Y | Y |
| Plugin marketplace | Y (1,129 from 11 catalogues) | Y | Y | Y (1,050+) | Y (20+ apps) | Y (ClawHub) |
| Plugins scanned before install | Y (every file, then a second scanner) | ? | ? | P (verified tier) | ? | P (trust guidance) |
| Plugins update themselves safely | N | Y | ? | Y | ? | ? |

## Safety and undo

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Approves each write and command | Y | Y | Y | Y | Y | Y |
| OS-enforced sandbox | P (opt-in, off by default) | Y | Y | P (plugin) | Y (cloud) | P |
| Security scan on every edit | Y (62 patterns) | P (review) | P | N | Y (Security Review) | N |
| Undo the last turn's files | Y (/undo) | Y (checkpoints) | ? | Y | Y | ? |
| Rewind, edit an old message, or fork | P (rewinds, cannot edit or fork) | Y | P (fork) | Y (/rewind (new)) | Y | ? |

## Review, code and creative work

| Feature | ox | Claude Code + Cowork | Codex / ChatGPT | Hermes Agent | Cursor | OpenClaw |
|---|---|---|---|---|---|---|
| Reviews your changes | Y (ox review) | Y | Y | P | Y (Bugbot) | N |
| Automatic review on every pull request | N | Y | Y | N | Y | N |
| Runs in CI (GitHub Action) | N | Y (GitHub, GitLab) | Y | ? | Y | N |
| Code graph you can query | Y (ox graph) | ? | ? | ? | P (index) | ? |
| Security audit command | Y (ox secure) | Y | ? | ? | Y | ? |
| Images and video made on your machine | Y (no key) | ? | ? | N (hosted) | ? | ? |
| Pictures shown in the terminal | N | ? | P (previews) | Y (new) | N | N |
| Charts and forms in chat | Y (any model) | Y (artifacts) | Y (canvas) | ? | Y (canvases) | P |

## Other agents checked

| Agent | Stars | Latest | Licence | What it is |
|---|---|---|---|---|
| opencode | 225k | v1.19.5, Oct 28 | MIT | Terminal, desktop beta. Build and plan agents, 75+ providers. The largest open source terminal agent. |
| Gemini CLI | 109k | v0.67.0, Nov 4 | Apache-2.0 | Terminal agent with a large free tier, 1M context, built-in Google Search. |
| Antigravity 2.0 | closed | 2.23.1, Oct 13 | Google | Desktop app, IDE, CLI and SDK for starting and coordinating agents. Secondary source. |
| Zed | 93k | v1.27.0, Nov 4 | open | Fast editor that hosts agents over ACP. ox can run inside it today. |
| OpenHands | 93k | v1.37.0, Nov 6 | MIT | Runs with or without Docker sandboxes; own cloud. |
| Cline | 71k | v4.1.26, Oct 26 | Apache-2.0 | CLI, desktop, VS Code, JetBrains, SDK. Multi-agent teams and scheduled agents. |
| Warp | 66k | June build; Oz platform | AGPL-3.0 | Terminal plus Oz, for running and steering agents locally or in the cloud. |
| Goose | 56k | v1.57.0, Oct 28 | Apache-2.0 | Local agent with MCP extensions and recipes; desktop and CLI. |
| Aider | 50k | v0.86.0, Aug 2025 | Apache-2.0 | Git-native pair programmer. No release in over a year. |
| Crush | 29k | v0.100.0, Nov 5 | FSL | Terminal agent from Charm. Has LSP context and switches model mid-session. |
| Kilo Code | 28k | v7.8.27, Nov 5 | MIT | VS Code, JetBrains, CLI. 500+ models, inline autocomplete, browser control. |
| GitHub Copilot CLI | 11k | v1.0.107, Nov 6 | GitHub | Plan mode, MCP, your own provider, --cloud sandbox, autopilot permissions. |
| Devin + Devin Desktop (Windsurf) | closed | renamed June 2026 | Cognition | Local and cloud agents, Agent Command Center, opens pull requests. Secondary sources. |
| Replit Agent, Jules, Amp | closed | not verified | — | Hosted agents. I found no first-party source this round, so they have no detailed row. |

## Where ox leads

- **Proof, not promises:** ox fix, ox build and ox port write the failing test first and run it themselves, on any model. I did not find this built in anywhere else.
- **Any-model computer use with voice and a pointer:** Claude's needs a paid Claude plan, Codex's a ChatGPT plan. Hermes matches any-model; none of them has the notch and pointer.
- **Offline errands:** Music, apps, timers and notes in 0.1 s with no model at all.
- **Moving between tools:** ox transfer moves a session across 7 tools, and ox vs races them side by side.
- **Local creative work:** Images, edits and clips on your own chip with no key.
- **Security on every edit, safer installs:** A 62-pattern scan on each edit, and skills scanned file by file before they install.
- **Small requests:** About 2,300 tokens on a first request, measured today. Whole-task cost against others is still unmeasured; the benchmark pilot is what will measure it.

## Where ox is behind, ranked

| # | Area | Gap | Why it matters | Status | Fix |
|---|---|---|---|---|---|
| 1 | Laptop | Return refused always, and only ten ⌘ shortcuts allowed | Why ox cannot finish many GUI jobs: it can type a search but never run it. | Fixed in this PR | Return and other shortcuts can be pressed; chat apps and unusual shortcuts ask. Lock, log out, force quit and file-delete keys stay refused, and so does paying. |
| 2 | Laptop | No per-app "always allow" | Every click asks, so long GUI jobs need constant babysitting. | Fixed in this PR | Allow an app once or always; listed in ~/.ox/computer-apps.json and removable with ox computer. |
| 3 | Laptop | No warning for apps that equal shell access | Approving Terminal or Finder quietly grants far more than it looks. | Fixed in this PR | Terminals, Finder and System Settings carry a warning and cannot be always-allowed. |
| 4 | Laptop | No stop from anywhere, no notice, no one-at-a-time lock | You cannot grab control back fast. | Fixed in this PR | Esc in the island (needs its Accessibility permission) or ox computer stop; a lock; a macOS notice. |
| 5 | Laptop | Unattended runs could use the screen, and Send or Delete were all-or-nothing | A scheduled job could click anything, while you could not approve Send even by hand. | Fixed in this PR | Schedules and daemon runs are refused. Send and Delete ask every time, even with -y. |
| 6 | Building | Rate limits burn retries, then drop to a slow backup for the whole run | The biggest cause of "slow" on free NVIDIA: the build test lost minutes to it. | Fixed in this PR | Honours Retry-After, waits with backoff, and tries your main model again after a backup. |
| 7 | Building | No type errors after an edit (LSP) | Hermes, Crush and IDEs catch mistakes at once. ox finds out at test time, or not at all. | Fixed in this PR | Uses a language server already on your machine; errors come back with the edit result. |
| 8 | Building | Does not look at the UI it just built | Claude Code, Codex and Cursor click through their own apps. | Next | Add a "see it working" step to ox build for web and native apps. |
| 9 | Building | No scripted multi-tool calls | Hermes execute_code collapses long pipelines into one model call, saving tokens. | Next | A sandboxed script tool that calls ox's read-only tools. |
| 10 | Everywhere | Cannot run with your laptop off | Claude, Codex and Cursor have cloud agents; Hermes uses Daytona, Modal, Vercel. | Later | Run ox on a rented machine or in a sandbox service, driven through mesh. |
| 11 | Everywhere | Phone can approve but not steer | Claude Remote Control and Dispatch, ChatGPT iOS and Cursor iOS can. | Next | Grow the iPhone companion into a chat with live sessions. |
| 12 | Everywhere | No VS Code or JetBrains plugin | Most developers start there. | Later | A thin extension over ACP. |
| 13 | Everywhere | No WhatsApp, Signal or iMessage gateway | Hermes has 20+ platforms, OpenClaw 12+. | Next | Add these three first. |
| 14 | Review | No automatic pull request review, no GitHub Action | Bugbot, Claude and Codex review every PR. | Next | ox review as a GitHub Action. |
| 15 | Sessions | Rewind cannot edit an old message or fork | Hermes and Claude Code do this. | Next | Add edit-and-resend and fork to /rewind. |
| 16 | Voice | Voice is one-way turns, no realtime call | Codex, Hermes and Cursor have live calls. | Later | Realtime provider option in the island. |
| 17 | Cost | No price on paid tool calls | Hermes shows each call's price and a running total. | Later | Add it to the approval prompt. |
| 18 | Plugins | Plugins do not update themselves | Hermes holds back updates that would break your setup. | Later | ox market update with a rescan. |

## Sources

- [Claude Code changelog (v2.1.319, Nov 6)](https://code.claude.com/docs/en/changelog)
- [Claude Code overview](https://code.claude.com/docs/en/overview)
- [Claude Code computer use](https://code.claude.com/docs/en/computer-use)
- [Dispatch and Cowork](https://support.claude.com/en/articles/13947068)
- [Codex changelog (0.167.0, Nov 6)](https://learn.chatgpt.com/docs/changelog)
- [Codex computer use](https://learn.chatgpt.com/docs/computer-use)
- [Hermes v0.23.0 release notes (Nov 5)](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.0)
- [Hermes docs](https://hermes-agent.nousresearch.com/docs/)
- [Hermes computer use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use)
- [Cursor changelog](https://cursor.com/changelog)
- [OpenClaw docs](https://docs.openclaw.ai/)
- [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli)
- [Antigravity](https://en.wikipedia.org/wiki/Google_Antigravity)
- [Warp Oz](https://www.therundown.ai/tools/oz)
- [Devin Desktop](https://www.marktechpost.com/2026/06/10/ai-coding-agents-development-platforms-2026/)
- [Project READMEs, stars and releases (GitHub API, Nov 6)](https://github.com/anomalyco/opencode)

The opencode, Goose, OpenHands, Cline, Kilo, Crush, Gemini CLI, Copilot CLI and Zed rows come from their READMEs and GitHub data on the same day. Antigravity, Warp Oz and Devin Desktop rest on secondary sources.
