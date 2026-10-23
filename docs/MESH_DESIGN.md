# ox mesh: one person, several machines, one ox

October 18, 2026. The owner's idea: install ox on every laptop, pair them with
a code, name each one, and control all of them from any one, while every
file, key and model stays on the machine it lives on. When a machine is
overloaded, ox tells you and offers choices; when one is about to run out of
credits, ox moves the work to another machine's capacity before the reply
stops coming.

## What ox mesh is, and is not

- **Is:** a private control mesh of the owner's own machines. One machine
  (any of them) is the controller you are using; the others are workers. All
  run the same ox.
- **Is not:** a cloud service, a file sync tool, or a way to share machines with
  other people. Nothing goes through a server of ours; machines talk directly
  (same network, or across networks over the owner's own VPN such as
  Tailscale).

## Principles (from the research)

| Principle | Where it comes from | In ox mesh |
|---|---|---|
| A short code must not be crackable after the fact | PAKE (SPAKE2 in Magic Wormhole; CPace, IETF CFRG draft) | 60-bit one-time codes with key confirmation (see Pairing); a PAKE would allow shorter codes and is the upgrade path |
| Identity is a key, pinned at pairing | Syncthing device IDs (SHA-256 of the device's key, compared on every connection) | Each machine has an Ed25519 key; its id is a hash of it; paired machines pin each other's key |
| Every message authenticated and encrypted, even at home | Zero-trust guidance; Noise-style handshakes | Per-connection X25519 ephemeral keys, signed by each side's pinned key; AES-256-GCM for every frame |
| "Dead or slow?" is a degree, not a timeout | φ-accrual failure detector (Hayashibara et al., 2004; used by Akka and Cassandra) | φ from heartbeat inter-arrival times; suspect at φ ≥ 8, down at φ ≥ 12 |
| Route by capacity, and change the route as load changes | Distributed inference work (exo: topology-aware; arXiv 2504.03668 on orchestration) | Each machine reports load, memory, thermal, battery, models and credit headroom; the router ranks them per request |
| Cheaper/weaker models for easy work | RouteLLM (cost-quality routing) | Ranking prefers a free local model when it is good enough, a paid API last |
| Control plane apart from data plane | Software-defined perimeter architecture | Pairing, permissions and scheduling are separate messages from inference and task output |

## The pieces

### 1. Identity (every machine)

`~/.ox/mesh/identity.json` (0600): an Ed25519 key pair, created once. The
machine's id is the first 16 characters of base32(SHA-256(public key)). The
owner names it ("Studio Mac", "Gaming laptop"); the name is a label, the id is
what is trusted.

### 2. Pairing with a code

1. On the machine you use: `ox mesh invite` (or Add machine in the app). It
   shows a code like `OX-K7P3-Q9XA-2MWD` (60 random bits, one use, 10
   minutes) and starts answering on the network.
2. On the new machine: `ox mesh join OX-K7P3-Q9XA-2MWD --name "Gaming laptop"`.
   It finds the inviting machine on the local network (a small UDP beacon; or
   `--at <host:port>` across networks, e.g. a Tailscale address).
3. They run a handshake: each sends a fresh X25519 key and its Ed25519 public
   key; both compute the shared secret, and each proves it knows the code with
   an HMAC over the whole transcript (both keys, both ids). A machine in the
   middle cannot answer without the code, and 60 bits cannot be searched in
   the 10-minute window. Three wrong answers close the invite.
4. Both sides pin each other's public key, store the name, and the code is
   gone. From then on they recognise each other by key alone.

### 3. The channel

Every connection between paired machines starts with a signed ephemeral
X25519 exchange (forward secrecy: old traffic stays safe if a key leaks later)
and then carries newline-framed JSON messages, each sealed with AES-256-GCM
under a key derived with HKDF from the shared secret and both ids. Unknown
keys are refused before anything is read.

### 4. Permissions (per machine, set on that machine)

Each machine decides what its paired machines may ask of it:

| Grant | Default | Allows |
|---|---|---|
| `status` | on | its health, models and credit headroom |
| `infer` | off | model calls on its local models, or its API keys (the keys never leave it; it makes the call and returns the answer) |
| `tasks` | off | running an ox task in a folder on that machine, under that machine's own approval settings |
| `files` | off, and per folder | sending a file's contents across |
| `files-write` | off, and per folder | atomically writing one selected small file into an existing shared folder; never included in a preset |

`ox mesh allow <machine> infer` on the machine that gives. Nothing is on by
default except status.

### 5. Health and the watchdog

Every machine sends a heartbeat every 5 s with: load (1-minute load / cores),
memory pressure, thermal state, battery and charging, free disk, running ox
runs, local models (Ollama), providers it has keys for (names only), and plan
usage (the most-used window of each plan, as the island's gauges read it).

The controller keeps, per machine: φ (liveness), and these signals:

| Signal | Threshold (sustained 60 s unless noted) |
|---|---|
| CPU | load/cores ≥ 0.9 |
| Memory | used ≥ 90 % (or macOS memory pressure "warn"/"critical") |
| Heat | thermal state above nominal |
| Battery | ≤ 15 % and not charging |
| Disk | under 5 GB free |
| Credits | a plan at ≥ 85 % of a window (before it stops replying) |
| Liveness | φ ≥ 8 suspect, ≥ 12 down |

Crossing one raises an **alert with choices**, never an action: shown in the
notch, the app and `ox mesh status`. Examples:

> Gaming laptop is under heavy load (CPU 94 %, memory 91 %).
> 1. Move its ox task to Studio Mac  2. Use a smaller model  3. Pause it
> 4. Check again in 5 minutes

> Studio Mac's Claude plan is at 88 % of its 5-hour window.
> 1. Finish this task with Gaming laptop's local qwen2.5:7b  2. Use your
> OpenRouter key on Gaming laptop  3. Keep going on Claude (it may stop)

Only the owner's choice runs. ox never closes apps, deletes files, reboots,
or moves a file by itself.

### 6. Using another machine's capacity

The agent loop stays where the work is (its files and tools stay local); only
the **model call** moves:

- `mesh:<machine>/<model>` is a model like any other in ox. A request goes over
  the channel; the other machine runs it on its local model (Ollama) or its
  own provider key, and streams the answer back, tool calls included. Its key
  never travels.
- The router's order for "keep this task going": this machine's model → a
  paired machine's local model that fits → a paired machine's API key (with
  the owner's yes and an estimate) → wait.
- A whole task can also run on another machine (`ox mesh run <machine> "…"
  --in <folder>`), when that machine has the project and grants `tasks`.

### 7. Across networks

Same network: found automatically. Elsewhere: the owner's VPN (Tailscale,
WireGuard) gives each machine an address; `--at` uses it. A relay is not part
of this version (nothing of the owner's passes through anyone else).

## Version 2: one person, every machine under their hand (October 18)

The owner's goal, in their words: install ox on every laptop, pair them, name
them, and from any one of them control all of them, including terminals and
everything else, while each machine keeps its own files, keys and models.
Overload and credits are watched; nothing happens without the owner's say.

### The layers

| Layer | What it does | State |
|---|---|---|
| 1. Trust | Ed25519 identity per machine, one-time code pairing, keys pinned | ✓ built (v1) |
| 2. Channel | One sealed connection per pair (X25519 + AES-GCM), many requests and live streams over it at once (each has an id); a stream carries input, output, resize and close | v2: streams added |
| 3. Grants | Set on the machine that gives, per paired machine: `status` (on), `infer`, `tasks`, `files` (+ folders), `agents`, `dev`, `control`, `screen`. Presets: `viewer` = status · `helper` = status + infer + tasks · `full` = infer + tasks + files + agents + dev; `desktop` = screen + control. Desktop access is never silently included in `full`. | implemented and tested |
| 4. Services | What each node answers (below) | v2 |
| 5. Controller | The same verbs everywhere: `ox mesh <verb> <machine> …`, the chat tool `mesh` (ox itself works across machines), the island (machines and alerts), the app's Machines page | v2 |
| 6. Watch | Heartbeats, φ liveness, overload and credit alerts with choices; picking another machine's model switches to it | ✓ built (v1) |
| 7. Safety | Every remote action is written to the giving machine's `~/.ox/mesh/audit.jsonl`; `ox mesh lockdown` drops every grant at once; a machine you forget can no longer connect. Screen/control writes exclude typed content from the audit. | implemented and tested |

### The services (on every node, each behind its grant)

| Grant | Service | What the controller gets |
|---|---|---|
| status | `describe` | the machine's makeup: model, chip, cores, memory, GPU, disks, OS, which agent tools are installed (Claude Code, Codex, Gemini, Cursor, Copilot, Hermes, OpenCode, Ollama), local models, which providers it has keys for (names only), ox version, uptime |
| status | `stats` | live health (load, memory, heat, battery, disk, models, plans) |
| infer | `infer` | model calls on its models or keys (`mesh:<machine>/<model>`) |
| tasks | `run` | an ox task in a folder there, under that machine's approvals |
| files | `ls`, `pull` | browse and copy one file from an explicitly shared folder |
| files-write | `push` | atomically copy one selected file (maximum 8 MB) into an existing shared folder. It requires its own grant and explicit overwrite; it does not sync folders, delete, or create directory trees. |
| agents | `agents`, `agent-read`, `agent-send`, `agent-delivery` | list/read sessions and ask a supported CLI-backed session to resume. A readable transcript is not treated as sendable; queued and failed delivery remain visible. |
| control | `control-list`, `control-click`, `control-type`, `control-key` | macOS accessibility controls: inspect controls, click safe controls, type text, or press a safe key. Send/Pay/Delete and Return/Enter are refused. |
| screen | `screen` | a current screenshot from the paired macOS machine |

### How it looks

- **Terminal:** `ox mesh` lists paired machines with health; `ox mesh run
  "Gaming laptop" "run the tests and report the result" --in <folder>` starts
  an approval-governed Ox task there; `ox mesh pull studio:~/report.pdf .` and
  `ox mesh push ./report.pdf studio:~/shared/report.pdf` transfer one file.
  There is no unrestricted remote shell/exec command.
- **Chat:** "run the tests on the gaming laptop", "what is the studio Mac
  doing?", "copy the build from studio": ox calls its `mesh` tool (each call
  approval-gated like a local command).
- **Island:** a machine pill per laptop with its health; an alert card with the
  choices; a note when another machine opens a terminal on this one.
- **App:** a Machines page: add a machine (code), grants as switches, health,
  alerts, a terminal per machine.

### What is built (October 18, evening)

| Service | State |
|---|---|
| describe, agents, agent-read, agent-send/delivery, ls, pull, push, share, audit, lockdown, presets | ✓ built and checked: two isolated nodes exercised locally (makeup, supported session reply, shared-root pull/push, overwrite refusal, /etc refused, audit rows). A physical second-machine acceptance run remains required. |
| island machine pills (up/down, load ring) | ✓ built |
| `screen`, `control-list`, `control-click`, `control-type`, `control-key` | ✓ built for paired macOS machines. They require the controlled Mac to grant `screen`/`control` (or the explicit `desktop` preset); every request is audited and dangerous actions are refused. |
| Beam-style native-window pull / “Bring It Back”, Windows/Linux remote-input backend | not built. Ox has screenshot + guarded macOS accessibility control, not virtual native-window transport. |

### Across networks

Same Wi-Fi: found by the beacon. Elsewhere: the owner's own VPN (Tailscale,
WireGuard) and `--at <address>`; no relay of ours. A relay is a later step.

## Build order and what is checked (October 18)

| # | Piece | State | Checked how |
|---|---|---|---|
| 1 | Identity, invite / join, the sealed channel, names | ✓ | `ox mesh invite` + `ox mesh join` between two ox homes on this Mac, both with `--at` and found on the network by the beacon; wrong codes, a used code, a changed key refused (test/mesh.test.js) |
| 2 | Heartbeats with system stats, φ liveness, `ox mesh` status | ✓ | live: the other node's CPU, memory, battery and models shown |
| 3 | Watchdog alerts with choices | ✓ CLI and island card (opens on a new alert, buttons are the choices); app page not yet | unit tests on sustained load, credits, down |
| 4 | Permissions, set on the machine that gives | ✓ | live: a model call refused (403, no retries) until `ox mesh allow … infer`, refused again after `deny` |
| 5 | `mesh:<machine>/<model>` | ✓ | live: `ox --model "mesh:Gaming laptop/qwen2.5:3b" -p …` answered "pong" from the other node's Ollama |
| 6 | Credits-low hand-over | ✓ suggestion at 85 % of a plan window; choosing "Finish with <machine>'s <model>" makes it the default model for the next turns | unit test; the switch is the owner's click |
| 7 | `ox mesh run <machine> "…" --in <folder>` | built; refused without the `tasks` grant (tested); a full remote task not yet run | — |
| 7a | `ox mesh screen <machine>` and `ox mesh control <machine> …` | ✓ on paired macOS machines after an explicit `desktop`/`screen`/`control` grant | integration test verifies the grant boundary and audit redaction |
| — | "Move its work", "pause", "smaller model" choices | shown, not automatic: ox says so and leaves them to you | test |
| 8 | Two physical laptops; a PAKE (CPace) for shorter codes; checkpointing long tasks across machines; a relay | next | — |

The node starts with the OX app (or `ox mesh up`) only once this machine has
joined a mesh: looking at `ox mesh` never creates a key or opens a port. Its
local endpoint answers loopback tools only (Host checked, JSON and a custom
header required, so a web page cannot use it).

## Sources

- Magic Wormhole (SPAKE2, single-use codes): https://pypi.org/project/magic-wormhole/0.6.3/
- CPace, IETF CFRG draft: https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/
- Syncthing device IDs: https://docs.syncthing.net/dev/device-ids.html
- φ accrual failure detector (Akka's notes and the paper): https://doc.akka.io/api/akka/2.3.1/akka/remote/PhiAccrualFailureDetector.html
- exo, distributed inference across devices: https://github.com/exo-explore/exo
- RouteLLM: https://arxiv.org/abs/2406.18665
- Orchestration of distributed LLM inference: https://arxiv.org/abs/2504.03668
- Software-defined perimeter guide (control vs data plane): https://cloudsecurityalliance.org/artifacts/software-defined-perimeter-architecture-guide-v3
