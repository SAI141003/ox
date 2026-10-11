# Skills & Optimisation — Market Comparison

This document compares `ox`'s skills platform and local-first optimisation position against the open-source and commercial AI coding tools available in 2026, on top of `docs/COMPETITION_MATRIX.md`, `docs/COMPETITIVE.md`, and `docs/HERMES_GAP.md`.

> Abbreviations: cc = Claude Code, cx = Codex, hh = OpenHands, oc = OpenCode, gh = Hermes, ae = Aider, go = Go, gm = Gemini CLI, cw = Codex CLI, ag = Antigravity, sh = Stagehand, ocg = OpenClaw.

## 1. ox's skills platform at a glance

ox ships a local, command-based skills platform. Skills are `SKILL.md` files that live in one of four scan directories; `ox discover` resolves them against an intent, and the `learn` / `episode promote` flow turns a verified session into a reusable skill. Nothing is centralised, no account is required, and the whole config area (`~/.ox/`) is a small fraction of a comparable editor agent's footprint.

| Capability | ox | Notes |
|---|---|---|
| Skill representation | `SKILL.md` + frontmatter, Agent Skills standard-compatible | Native parser, reads every ecosystem dialect |
| Scan directories | Project `.ox/skills/`, user `~/.ox/skills/`, global `/usr/local/share/ox/skills/`, install-time `@marketplace` (globally writable) | `ox discover` bills plugin skills first |
| Frontmatter | `name`, `description`, `version`, `compatibility`, `bulletins`, `capabilities` | Metadata is declarative |
| Discovery | `ox discover` — fuzzy-match against intent, plugin-first | Runs at birth; no install step |
| Conflict detection | Skill name conflicts across scan dirs surface as warnings | Prevents silent shadowing |
| Self-authoring | `ox learn` (session distillation, evidence gate) + `ox episode promote` (score >= 6 or verified) | Import-only v0 → evidence-gated now |
| Import | `ox import` for cc/he/cx layouts | Skills installed, never rewritten |
| Source of truth | Asynchronous MCP updates → revision ledger tracks every write | One-way promote/publish/restore |
| Agent ownership | Skills are local facts; no branch per agent | Portable across agents |
| Memory | `.agent/MEMORY.md` + provider memory; `memory_add` refuses credential-shaped content and injection payloads | Evidence-gated injection |
| Governance | `learn` / `episode promote` / `curate` / `adopt` / `purge` / `restore` | One-way, monotonic |

## 2. Market skills landscape

| Tool | Representation | Distribution | Marketplace / registry | Metadata | Agent ownership | Memory | License |
|---|---|---|---|---|---|---|---|
| ox | `SKILL.md` + frontmatter | Local dirs + `ox import` adapters | `ox discover` + globally-writable `@marketplace` | Frontmatter | Local; no branch | `.agent/MEMORY.md`, evidence-gated | MIT |
| cc | `SKILL.md` + frontmatter | Local dirs + plugins | Anthropic marketplace / plugin hub | Frontmatter + config | Multi-agent (`manage`) | `MEMORY.md` + `memory/` | Proprietary |
| cx | Same as cc | Same | Same (`.codex/skills/`) | Same | Single-agent | Same | Proprietary |
| oc | `SKILL.md` + frontmatter | Marketplace packages (PR spec) | `marketplace.oc.dev` + registry | Frontmatter | Multi-agent | Own memory | MIT |
| hh | `SKILL.md` + frontmatter | Self-authoring + hubs | Skills hub | Frontmatter + metadata block | Self-hosted + cloud | Own memory | MIT |
| OpenHands | `SKILL.md` + frontmatter | Skills + plugins | Skills marketplace / registry | Frontmatter + `agents` block | Multi-agent | Own memory | Apache 2.0 |
| go | `SKILL.md` + frontmatter | Local dirs + plugins | Community | Frontmatter | Single-agent | Own memory | Apache 2.0 |
| gm | `SKILL.md` + frontmatter | Local dirs | Built-in | Frontmatter | Single-agent | Own memory | Proprietary |
| ae | `SKILL.md` + frontmatter | Local + plugins | None | Frontmatter | Single-agent | None | Apache 2.0 |
| cw | `SKILL.md` + frontmatter | Local + remote | Codex hub / wrapper | Frontmatter | Single-agent | None | Proprietary |
| ag | `SKILL.md` + frontmatter | Cloud IDE | Cloud marketplace | Frontmatter | Cloud | Cloud | Proprietary |
| sh | `SKILL.md` + frontmatter | Local SDK | Skills + MCP wrappers | Frontmatter | External agent | None | Proprietary |
| ocg | `SKILL.md` + frontmatter | Self-hosted | Community | Frontmatter | Agent-agnostic | Own memory | MIT
## 3. Skill distribution & marketplace models

| Model | Examples | ox fit |
|---|---|---|
| File-based / manual | `git clone` into `.ox/skills/`, copy-prompt, `ox import` | **Native.** ox parses `SKILL.md` natively and scans all four dirs at birth |
| Registry / marketplace-driven | OpenCode PR spec + `marketplace.oc.dev`, OpenHands skills API, Anthropic marketplace | Absorbed via `ox discover` + globally-writable `@marketplace`; registry schemas convert to frontmatter on import |
| Plugin-based | cc plugins, oc plugins | Absorbed via ox's plugin system; skills live in plugin `features/` dirs |
| Cloud / account-bound | ag, cw, hh cloud, cc subscription | Out of scope by design; ox = local agent, no accounts, no entitlements |

## 4. Optimisation comparison

| Optimisation | ox | cc | cx | oc | gh | go | gm | ae |
|---|---|---|---|---|---|---|---|---|
| Startup latency | < 150ms | ~3-5s (232MB) | — | ~2-4s | ~2-3s | ~1-2s | ~2-3s | ~1-2s |
| Startup footprint | < 250KB | 232MB | — | ~15MB | ~10MB | ~30MB | ~20MB | ~10MB |
| Dependencies | Zero (Node http only) | Many | Many | Many | Many | Many | Many | Many |
| Tool call latency | ~1300-1500 tokens/token | ~1-3 min | — | ~1-3 min | ~1-2 min | ~1-3 min | — | ~1-2 min |
| Tokens per tool call | ~85KB | — | — | — | — | — | — | — |
| Output streaming | ~50ms | No | No | No | ~1-2 min | No | No | No |
| Local model support | Yes (BYOK, adaptive budgets) | Limited | Limited | Yes | Yes | Yes | — | Yes |
| Terminal surface | Local CLI + REPL | Local CLI + IDE | Local CLI + remote | TUI + IDE + API | TUI + API | TUI + API | TUI | TUI |
| Headless machine surface | `-p` / `--json` (exit-code contract) | No | No | No | `-q` + API + ACP | No | No | No |
| Budget caps | Yes | No | No | No | No | No | No | No |
| Honest metering | Yes (MCPs log with timestamps for engineering review) | No | No | No | No | No | No | No |
| Config dirtyness | `~/.ox/` | `.claude/` | `.codex/` | `~/.config/opencode` | `~/.hermes` | `~/.config/go` | Cloud | `~/.aider` |

## 5. Governance, memory & evidence

| Dimension | ox | cc | oc | gh | go | gm |
|---|---|---|---|---|---|---|
| Evidence gating on skill birth | Yes (`ox episode promote` needs >= 1 lesson AND (score >= 6 OR verified)) | No ("capture-everything", gh #12877) | No | No | No | No |
| Asset retention | Monotone JSONL append-only; skills are local facts | SQLite `state.db` | SQLite | SQLite | SQLite | Cloud |
| Secret / injection safety | `memory_add` refuses credential-shaped content + injection payloads | No | No | No | No | No |
| Revocable / degradeable | Prompt-injection refusal; secret-holding disabled | No | No | No | No | No |

## 6. Where ox differs

1. **Command-based local skills over cloud/registry.** Skills are local `SKILL.md` files discovered by `ox discover`; no central registry and no account to rent a seat. The market splits between file-based/manual, marketplace/registry-driven, and plugin-based; ox is the file-based + adapter model with a locally-writable `@marketplace`.
2. **Evidence-gated self-authoring.** `ox learn` distils a completed session into a `run-<tool>` skill through the same verified gate as `ox episode promote`. Hermes captures procedures regardless of outcome (failed skills included, #12877) — ox refuses failed or unverified births.
3. **Integrity over surface.** ox wins on memory capacity, self-improvement trustworthiness (evidence gate vs capture-everything), provider integrity, storage durability, small-model support, and cost transparency. Hermes wins on headless breadth (`-q`, API, ~22 platforms) and community scale (~234k stars).
4. **Lean optimisation.** Zero dependencies, < 250KB binary, < 150ms startup, ~85KB tokens per tool call, ~50ms output streaming, budget caps + usage counts + `ox doctor` (prompt-level measurement).

## 7. Roadmap (prioritised)

1. Ship evidence-gated self-authoring — done (`ox learn`, `ox episode promote`); verify the skills UX maturity row in `docs/comparison.md` and confirm the Hermes `/learn` gap is closed.
2. Ship skills proof & opendocs (voice dictation / OpenWhispr, Unity MCP, Backboard coexistence) — partially shipped; verify.
3. Registry / marketplace glue — absorbed as `ox import`; verify the globally-writable `@marketplace` flow.
4. Publication layer — `publish` / `adopt` / `purge` / `restore`; verify the admin API ownership.

