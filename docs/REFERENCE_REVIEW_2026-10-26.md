# Reference review — 2026-10-26

This note records what the supplied references demonstrate, which Ox capability
they map to, and the boundary between a usable implementation and a visual
claim.  It is intentionally not a feature checklist or a promise that a third
party's capability is present in Ox.

## Locally available recordings

| File | What was observed | Product implication |
| --- | --- | --- |
| `ScreenRecording_10-22-2026 19.MP4` | An Instagram-style demonstration of a compact dark assistant/Island that visibly presents a permission card for `npm run build`. | Approval feedback must name the action and give a clear pending/approved/denied result; animation is not evidence that the command ran. |
| `ScreenRecording_10-22-2026 20.MP4` | A Windows assistant demonstrates a volume adjustment, clipboard-style recall, low-battery notification, and a changing companion state. | Ox needs practical, truthful local helper actions and useful status feedback.  Ox now exposes real current-clipboard and battery-status requests through the same typed/voice route as the existing volume action. |
| `ScreenRecording_10-24-2026 14-29-05_1.MP4` | The same style of assistant translates a visible message and explains a visible error. | Screen-grounded assistance needs an actual image/screen input plus a model action.  A static card cannot be presented as a translation or diagnosis. |

All three files above were present under `/Users/saiyaganti/Downloads` and were
reviewed as sampled contact sheets.  The recordings show UI demonstrations;
they do not expose a service protocol or prove end-to-end reliability.

## Images and the corresponding Ox state

| Reference | Identified product idea | Ox state after review |
| --- | --- | --- |
| Cua Spaces / `trycua/hermes-cua-spaces` | An authenticated Cua Space is an isolated Linux, macOS, or Windows environment for Hermes terminal/files/code. | **Not integrated.** Ox's `docker` backend isolates shell commands in a disposable container, not a persistent GUI computer.  The `cua` command is not installed on this Mac, and Cua authentication has not been configured. |
| OpenBot | Persistent, self-hosted agent workspaces across operating systems and providers. | Ox can discover local coding tools, retain its own sessions, and create handoff artifacts.  It cannot truthfully resume every vendor-native chat (for example Kimi/Cline) without that vendor's supported session API. |
| NVIDIA SkillSpector | Security inspection of agent skills before execution/installation. | Ox already rejects dangerous install bundles; Settings now adds a local read-only **Skill safety** report for installed skill folders.  It shows capability signals, not a malware verdict. |
| DataVendor | A marketplace to sell private code/data to AI buyers. | **Not implemented by design.** This would require explicit owner authorization, data-rights review, contracts, and a real marketplace account.  Ox's Personal model feature keeps user-selected, individually approved examples local; it does not sell or upload them. |
| Dessa | A full-duplex voice conversation where speech input and output can overlap. | Ox supports on-device dictation and interruption/barge-in (speaking stops before listening starts).  That is **not** full duplex; real simultaneous audio needs echo cancellation, streaming audio transport, microphone consent, and an audio model/runtime. |
| G0DM0D3 | Parallel multi-model comparison with an explicit winner/evaluation view. | Ox's `ox arena` and `ox vs` use real isolated worktrees/folders and retain a patch only after explicit application.  Actual comparison still requires configured providers/agents. |
| NVIDIA OpenShell | Policy-enforced isolated runtimes/sandboxes with model, tool, and knowledge boundaries. | Ox has sandbox profiles and an optional Docker backend.  It is not OpenShell-equivalent: no OpenShell runtime, verified policy layer, or configured VM/container engine is present. |

## Evidence and safe product decisions

* Current local probes found Docker's client but no reachable Docker daemon.
  Attempting a Docker-backed agent must therefore surface the actionable engine
  error; it must not claim a separate computer started.
* Cua Spaces requires Cua installation plus account authentication.  Ox should
  offer it only as a configured external backend, never as a decorative bot
  option.
* A current clipboard can contain credentials or private text.  Ox reads only
  the current clipboard when asked, limits its Island-sized preview, and does
  not invent a hidden clipboard history.
* Data sharing/training is a separate, consequential decision.  No supplied
  reference authorizes uploading, selling, or licensing this user's chats,
  screens, or code.  Personal-model collection remains off by default and
  requires source selection plus individual-example approval.

## Source links

* [Cua Spaces README](https://github.com/trycua/hermes-cua-spaces)
* [OpenBot](https://openbot.run/)
* [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector)
* [G0DM0D3](https://github.com/aetherstate/GODMOD3.AI)
* [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
* [Dessa voice studio](https://dessa-ai.com/)
* [DataVendor](https://datavendor.ai/home)

