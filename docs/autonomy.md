# ox autonomy — long-horizon headless runs over real-world surfaces

ox v3b turns the agent from a coding loop into a **gated autonomy layer**: the same
`-p` pipeline, hardened for unattended runs (`ox auto`), pointed at curated MCP
servers for browser, messaging, calendar and trading domains, and schedulable
(`ox schedule`) as a daily cron job. Everything here is optional — ox is still a
zero-dependency terminal agent, and every external surface stays behind an
approval gate you control.

The three commands:

```bash
ox auto "<goal>" [flags]     # one long-horizon autonomous run, then exit
ox schedule "<goal>"         # print (or --install) a daily crontab for it
ox mcp add <template>        # wire up a surface (see table below)
```

All three were re-verified on **2026-10-03** against a live binary; the corrections
that came out of that pass are marked inline. Test coverage:
`test/schedule.test.js` + `test/schedule-regressions.test.js` = **17/17**,
`test/daemon.test.js` = part of **97/97** with the goal/messaging/refine/layering
suites.

## Curated stack

Install any domain with the exact command; `${VAR}` env placeholders expand at
runtime and never touch disk. Risk class drives gating (next section).

| Domain | Server | Add command | Required env | Risk | Gating policy |
|---|---|---|---|---|---|
| Browser automation | Playwright MCP (`@playwright/mcp`) | `ox mcp add browser` | none | write | asks per action by default |
| DevTools inspection | `chrome-devtools-mcp --slim` | `ox mcp add devtools` | none | read-only | ask (cheap to allow) |
| Email / Calendar / Drive | `workspace-mcp --read-only` | `ox mcp add gsuite` | OAuth on first run | write | installs READ-ONLY; drop flag to allow sends |
| Slack | Slack hosted MCP (Streamable HTTP) | `ox mcp add slack` | `SLACK_MCP_TOKEN` | write | admin-scoped bot token; asks per send |
| WhatsApp | `wbmcp` over Cloud API | `ox mcp add whatsapp` | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | write | **Cloud API only** — personal-number bridges violate ToS (permanent-ban risk) |
| Telegram | `@overpod/mcp-telegram` | `ox mcp add telegram` | none | write | gray-zone MTProto userbot; rate-limit, keep human-initiated |
| Travel intelligence | Booking.com demand API | `ox mcp add booking` | affiliate status | read-only | affiliate endpoint; search/pricing intel only |
| Restaurant booking | `@striderlabs/mcp-opentable` | `ox mcp add opentable` | none | **money** | confirms EVERY reservation before booking |
| Trading | `alpaca-mcp-server` | `ox mcp add alpaca` | `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | **money** | paper-trading default (`ALPACA_PAPER_TRADE:-true`) |
| Crypto portfolio | Coinbase agent MCP (HTTP) | `ox mcp add coinbase` | scoped API key | **money** | portfolio-read/trade only; withdrawals out of scope |

Inspect risk live with `ox mcp ls` (RISK column); probe a server with
`ox mcp test <name>`.

## Safety model

**Risk classes.** Every curated server carries one of three classes:
`read-only` (cannot mutate external state), `write` (can post/send/navigate),
`money` (can spend, reserve or transact). The registry lives in
`src/mcp-templates.js`; unknown servers default to the most conservative gate.

**Policy engine.** Before ox dispatches any `mcp__<server>__<tool>` call it
resolves a decision:

1. explicit entry wins — `"mcpPolicy"` map (`"allow" | "ask" | "deny"`), merged
   from project `.ox.json` over global `~/.ox/config.json`;
2. otherwise the template's risk class defaults to `ask`;
3. otherwise `ask`.

- `deny` → the tool result is `Blocked by policy (mcpPolicy)` without executing.
  It applies even under `-y`: an explicit config deny outranks approval skipping.
- `allow` → skips interactive approval.
- **money cannot self-authorize**: an `allow` on a money-risk server only stands
  when the entry came from the *global* config or you passed
  `--side-effects-ok`. A project-scope `.ox.json` allow downgrades to `ask`
  with a one-time warning telling you exactly how to authorize properly.

```jsonc
// ./.ox.json (project scope)
{ "mcpPolicy": { "devtools": "allow", "browser": "ask", "coinbase": "deny" } }
```

**Paper-trade first.** Alpaca mounts with `ALPACA_PAPER_TRADE=true` unless you
export otherwise. Keep it there until a tested reason exists; moving to live
capital should require the full chain below, deliberately, not by accident.

**Spend caps.** `--max-cost <usd>` hard-stops a run past the given spend,
counting verifier and planning tokens like everything else. Budget-stop events
surface in both text and `--json` output.

**Audit trail.** Every `ox auto` run writes a JSONL session under
`~/.ox/sessions/`, a session-end checkpoint under `.agent/checkpoints/` (goal,
files, decisions, tokens/cost/model), and an episode under `.agent/episodes/`.
A scheduled job's stdout/stderr lands in `~/.ox/auto.log`.

**What ox will NOT do**, by design:

- bridge personal-account WhatsApp/Instagram/TikTok APIs that violate platform ToS;
- move money without BOTH an explicit policy allow (or per-call approval) AND
  `--side-effects-ok` / global-config authorization;
- auto-install launchd jobs (crontab install is opt-in, idempotent, marked);
- fall back silently. ox *does* have a fallback chain (`fallback_bots`,
  `aux_bot`) and will use it — what it won't do is switch without telling you:
  every switch emits a non-dismissible `model_switch` event, and
  `fallback_policy.cost: free_only` refuses paid fallbacks outright.

## Setup walkthroughs

### Browser takeover

```bash
ox mcp add browser      # review, then re-run with --yes
```

The template runs a dedicated Chromium with an ISOLATED profile — your daily
cookies are not shared. For tasks that need your existing login ("log into my X
session and do Y"), either complete the login once inside the automated profile
and let its storage persist, or pass an explicit user-data-dir in `.mcp.json`
via `args`. Cap blast radius with capability flags, e.g.
`args: ["-y","@playwright/mcp@latest","--caps","navigate,screenshot"]`.

Example goal: `ox auto "log into my GitHub session and star every repo I own"`
— expect the first run to pause at the credential step in interactive mode;
scheduled runs should only wrap sessions that are already authenticated inside
the isolated profile.

### Email & calendar via Google Workspace

1. `ox mcp add gsuite` (installs the READ-ONLY variant by default).
2. Run ox interactively once and invoke a gsuite tool — the OAuth consent flow
   opens; least-privilege scopes are requested; tokens cache locally so later
   headless/cron runs just work.
3. Only if you need sends/writes, remove `--read-only` from args in `.mcp.json`
   and think about which approval posture you want for it.

### Slack app setup

1. Create an internal app in your workspace; request least-privilege bot scopes.
2. A workspace ADMIN must approve the installation; put the resulting token in
   `SLACK_MCP_TOKEN`.
3. `SLACK_MCP_TOKEN=… ox mcp add slack --yes` — the header keeps the literal
   `${SLACK_MCP_TOKEN}` placeholder in config; expansion happens at runtime.

### Alpaca paper trading first-run

1. `export ALPACA_API_KEY=… ALPACA_SECRET_KEY=…` (paper keys from alpaca.markets).
2. `ox mcp add alpaca` — env expands at runtime; keys never written to disk.
3. Leave `ALPACA_PAPER_TRADE` unset (defaults true). Probe: `ox mcp test alpaca`.
4. First goal idea: `ox -y --side-effects-ok "rebalance my PAPER portfolio to
   60/40 and show the resulting positions"`.

## Scheduling

Print a ready-to-paste block (nothing is installed):

```bash
ox schedule "triage my inbox and summarize open PRs" --at 09:00 --max-cost 1
```

Generates a crontab line plus a launchd plist skeleton, stamped with a
deterministic marker comment:

```cron
# ox-schedule 8f14e2ac
0 9 * * * cd '/path/to/project' && XAI_API_KEY='__SET_XAI_API_KEY__' node '/path/to/bin/ox.js' auto 'triage my inbox and summarize open PRs' --max-cost 1 --yes-edits >> '~/.ox/auto.log' 2>&1
```

Install it (idempotent — same goal/time is detected by hash and skipped):

```bash
ox schedule "…" --at 09:00 --install          # interactive confirmation
OX_INSTALL_YES=1 … --install --yes            # non-TTY requires --yes
```

**Verified 2026-10-03: the non-TTY refusal is real and it is exit 4.** With no TTY
and no `--yes`:

```
$ ox schedule "…" --at 09:00 --install
✗ refusing to write to your system crontab: this is not a terminal, and unattended
  installs need both confirmations.
```

`crontab -l` was byte-identical before and after. The refusal message also points at
the daemon-backed equivalent, which ox *can* remove.

Remove or change jobs with `crontab -e`; delete the whole marked block. macOS
users who prefer launchd get a print-only plist — ox never loads launchd jobs
for you.

An installed crontab entry is genuinely outside ox: `ox schedule list` cannot see
it, `ox schedule remove` cannot stop it, and `ox schedule remove-all` will not
clear it. That is why `--install` refuses outright when there is no terminal and
no `--yes` + `OX_INSTALL_YES=1`, and it is why the daemon-backed equivalent
prints itself next to every block.

### The daemon-backed schedule store

`ox schedule` also owns a store that runs *inside* ox, which is the path ox
recommends:

```bash
ox schedule add 30m "triage my inbox" --max-cost 0.50   # created disabled
ox schedule enable <id>
ox schedule opt-in                                        # the daemon-wide switch
ox schedule list                                          # cadence, cap, next run, last result
ox schedule run-now <id>                                  # run one job NOW, attended
```

Two gates, both defaulting closed: the row must be enabled **and** the daemon
must be opted in, so a fresh install runs nothing unattended. Every schedule is
cost-capped (`--max-cost`, else `OX_MAX_COST`, else $0.25), prompt-screened
twice, and can carry only `--max-cost` / `--bot` / `--model` — a schedule cannot
widen its own trust, sandbox or approval policy. `ox schedule opt-out` keeps the
rows and stops the dispatch. The store is append-only JSONL under
`~/.ox/daemon/schedules/`, so a torn write loses the last event and not the file.

**Verified 2026-10-03, on a live store.** A fresh schedule reports both gates at once:

```
$ ox schedule add 30m "triage my inbox" --max-cost 0.5
✓ schedule b3aa4e97 — every 30m
  state   disabled — `ox schedule enable b3aa4e97`
  daemon  schedules are OFF — `ox schedule opt-in` lets it run this
```

`ox schedule policy` is the one-line audit of the daemon-side gate:

```
$ ox schedule policy
schedule policy
  opted in      no — nothing runs
  max in flight 3
  miss grace    1m
  store         /Users/saiyaganti/.ox/daemon/schedules
```

`ox schedule list --json` adds a `residue` block (`dir`, `files`, `live`, `count`) so
"did anything get left behind" is answerable without reading the filesystem.
`ox schedule remove-all` on an empty store reports `residue: 0 live` and states that
**no crontab entry, no launchd plist and no worker is ever created by a schedule**.

**Cadence correction.** `ox --help` enumerates `[<30s|5m|2h|1d>|<ISO time>]`, but the
parser is wider than that list: `7m`, `30m` and `90s` (normalised to `2m`) all parse,
as does a one-shot ISO timestamp (`once at 2026-10-04 09:00:00 UTC`). A string that
is not a duration is refused with **exit 3**. The help text understates what is
accepted; treat any `<n><unit>` as valid.

`ox cron` is the older name for the same store and is **kept working**: it takes
free text (`ox cron add "every minute"`), prints `scheduled job <id>`, and
`ox cron run <id>` runs one job now. `ox cron add` arms its row, because the
scheduler it replaced had no second gate — but the daemon-wide switch is still
off until `ox schedule opt-in`, and `ox cron list` says so.

### Heartbeats

A heartbeat is a schedule that re-enters an **existing** session to advance its
persistent goal, instead of starting a new one. It is bounded on three axes: a run
budget (`maxRuns`, default **3**, `/heartbeat max-runs <n>` to change it), the goal's
own state (it stops when the goal completes or is paused), and spend. It also refuses
to arm against a session with no active goal — *"A heartbeat advances a goal; with
none it would just start unrelated work."* The goal it would advance is read with the
same loader `--resume` uses, so a heartbeat cannot act on a goal the user's own resume
would not see.

```bash
/heartbeat                    # this session: heartbeat state + goal progress
/heartbeat every 5m           # re-enter THIS session on an interval
/heartbeat at HH:MM           # ...or at a time of day
/heartbeat max-runs <n>       # override the run budget (default 3)
/heartbeat stop               # remove every heartbeat on this session
```

`ox --help` and `ox daemon --help` **also** advertise `ox heartbeat start|list|stop`.

**Correction, re-verified 2026-10-04: they run.** This document previously recorded
that they did not, because `'heartbeat'` was missing from the `SUBCOMMANDS` set and
the dispatcher rejected them with `ox: unknown command 'heartbeat'` before reaching
the implemented handler. That is no longer true — `'heartbeat'` **is** in `SUBCOMMANDS`
(`src/cli.js:197`) and the handler at `src/cli.js:3374` is reached. `ox heartbeat` and
`ox heartbeat list` both exit **0** and print real usage and state.

The two gates that actually bound unattended execution are untouched, and the command
now says so itself: `ox heartbeat list` reports `daemon NOT opted in — nothing fires
until 'ox schedule opt-in'`. So a routed command is still **off by default** behind
daemon-wide `opt-in` *and* per-row `enabled`. The `/heartbeat` slash command above
remains the in-session path, bounded by `maxRuns` (default 3).

## Honest limits

- **OAuth remote servers need manual token provisioning.** Hosted endpoints that
  speak OAuth (Google, Slack) require a human to click consent at least once;
  ox cannot and will not automate consent grants.
- **Personal-account Instagram/TikTok automation is browser-only and against
  their ToS.** ox ships no templates for them; using the browser server against
  those sites is your call and your ban risk.
- **Booking.com bookings stay out-of-chat by design.** The affiliate demand API
  is read-only intelligence; actual reservation flows happen on their platform.
- **IBKR is flagged, not shipped.** Interactive Brokers' API licensing is
  non-commercial-only; until that changes there is no `ox mcp add ibkr`.

## Provenance

Design patterns for checkpoints, sandboxing posture and the headless contract
were informed by reading xai-org/**grok-build** (Apache-2.0). This is a
clean-room implementation: zero code copied, only ideas consulted, and every
idea re-derived against ox's own zero-dependency constraints.
