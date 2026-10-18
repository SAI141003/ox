# ox and Devin, side by side

October 18, 2026. Devin from Cognition's docs
([first session](https://docs.devin.ai/get-started/first-run),
[advanced capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities),
[playbooks](https://docs.devin.ai/product-guides/using-playbooks),
[Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp),
[release notes](https://docs.devin.ai/release-notes/overview)) and reported pricing
([lindy.ai](https://wf.lindy.ai/blog/devin-pricing), [usecarly](https://www.usecarly.com/blog/devin-pricing)).
ox from its own code and measurements in this repository.

## Where ox is ahead, and why

| | Devin | ox | Why it matters |
|---|---|---|---|
| Cost | $20/month + about $2.25 per ACU (~15 min of work); Team $500/month | Free and open source (MIT); runs on the plans you already pay for (Claude, ChatGPT, Cursor…), any of 31 API providers, or a local model at $0 | The same task costs nothing extra |
| Which model | Cognition's choice | Any: 31 providers, local models, plans, a backup model when one fails | No lock-in; use the best or cheapest model per message |
| Where your code goes | Cognition's cloud VM | Your machine (or a container); no account, no telemetry | Private code stays private |
| Proof it is done | PR + tests it runs | Gates that must pass, a goal judge plus real test/lint/build checks, `ox build` (each acceptance criterion proven by its own test), `ox secure` on every file it edits | "Done" is checked, not claimed |
| Security of what it writes | (not documented) | 62-rule scanner runs on every edited file; the model must fix or justify each finding | Measured: 24/27 held-out vulnerabilities caught, 0/18 false alarms |
| Tokens per task | not published | Measured on the same task and model as Claude Code, Hermes, Codex: fewest tokens and fastest of the four (25,918 in, 20 s; one task, one run) | Cheaper and faster on every plan |
| Your other AI tools | Devin only | Hands sessions to and from Claude Code, Codex, Hermes, Gemini, Cursor, Paperclip without touching their files (`ox transfer`) | Keep using what you like |
| Desktop and voice | Web app, Slack | Terminal, desktop app, notch island with voice and no-AI actions in ~0.1 s, offline | Works where you are, even offline |
| Code understanding | DeepWiki (cited answers) | `ox graph`: a queryable code graph (86% agreement with graphify's call graph, 0.8 s), the agent's `code_graph` tool | Same kind of answer, local and instant |
| A team of agents | One Devin per session, "managed Devins" | `ox org`: org chart, hiring with your approval, monthly budget per agent with hard stop, heartbeats that pick up assigned tasks, each agent on its own runtime (ox, Claude Code, Codex) | Run a team, not one agent, with money limits |
| Improves itself | — | `ox evolve`: changes its own code in a worktree, kept only if the test suite measures it better | It gets better from its own failures |

## Where Devin is ahead (gaps ox closes next)

| Devin | ox today | Next |
|---|---|---|
| A cloud machine per session that keeps working when your laptop sleeps | Local, or a Docker container on your machine | Remote backends (an SSH box or cloud VM) for long runs |
| Starts from Slack, **Jira** or **Linear**, ends with a pull request and answers review comments | Slack, Telegram, Discord; PRs through `gh` when asked | A built-in PR flow (branch, commit, open PR, read and answer review comments) and Jira / Linear triggers |
| Playbooks made from a successful session | Skills and a 1,129-plugin Marketplace; no "turn this session into a playbook" | `ox playbook from <session>` |
| DeepWiki pages for a repo | Graph and report, no browsable wiki | A wiki page per subsystem from `ox graph` |
| Polished team admin (seats, knowledge management UI) | Single user | Not a goal for now |
| Public benchmark results | SWE-bench / Terminal-Bench not run yet | Run them with a strong model and publish whatever they say |

## Honest bottom line

On cost, privacy, model choice, verification and token use, ox is ahead, and
the token and speed claims are measured (one task so far; a full nine-task
head-to-head needs more than OpenRouter's free tier). Devin is ahead on
running unattended in the cloud and on ticket-to-PR team workflows; those are
the next items to build. Neither has a public SWE-bench score in this repo:
"better than Devin" on coding ability is not proven until that run exists.
