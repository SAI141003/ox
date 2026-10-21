# Reference audit: images, repositories, and recordings

**Audited October 21, 2026.** This is a source-and-test audit, not a product
claim. “Built” means a corresponding Ox implementation was found and covered
by the focused test run recorded below. “Live setup needed” means it still
requires a real account, hardware, service, or a physical second machine.

## Verification performed

```sh
OX_ISLAND=0 OX_LEARN=0 OX_NO_KEYSTORE=1 OX_USAGE_LOG=0 \
OX_NO_BUILTIN_SKILLS=1 OX_NO_PLUGINS=1 \
node --test test/market.test.js test/comfyui.test.js test/library.test.js \
  test/arena.test.js test/race-live.test.js test/dictation.test.js \
  test/agent-hooks.test.js test/agent-messaging.test.js \
  test/slack-gateway.test.js test/skill-index-screen.test.js
```

Result: **67 passed, 0 failed**. Those tests use local fixtures/stand-ins where
a third-party service would otherwise be needed. They do not prove a paid
provider, a real Slack workspace, a microphone, or a phone is configured.

## Supplied images and repository references

| Attachment(s) | Reference and requested capability | Ox status | Evidence / honest boundary |
|---|---|---|---|
| `IMG_9380.PNG`; clipboard `6b7b…` | [Google agents-cli](https://github.com/google/agents-cli): skills and commands for Google’s Gemini Enterprise Agent Platform | **Partial** | Ox lists the Google agents-cli skill family in `src/market.js`, so it can discover/install scanned skills. It does **not** embed, deploy to, or administrate a Google Cloud Agent Platform project. That needs the user’s Google Cloud account, billing, and consent. |
| clipboard `6c26…` | `feder-cr/git-ai`: agent-oriented Git | **Absent as named** | No `feder-cr/git-ai` integration is present. Ox does have safe worktree races (`src/arena.js`), git/PR helpers, checkpoints, and session traces, but not line-level AI attribution in Git Notes. The similarly named [git-ai-project/git-ai](https://github.com/git-ai-project/git-ai) records attribution with agent hooks; it should be evaluated separately rather than assumed equivalent. |
| clipboard `df40…` | `usestrix/strix`: AI security/pentest agent | **Discoverable; not bundled** | Ox’s marketplace advertises Strix and makes its authorized-use restriction explicit. Ox’s own `ox secure` is a different static security scanner. Strix actively tests targets, needs Docker/model credentials, and must only be run against systems the owner is authorized to test. |
| `IMG_9436.PNG`; clipboard `0ac8…` | [Orca](https://github.com/stabylai/orca): several coding agents in isolated worktrees, one command center | **Built, with UI difference** | `ox arena`/`ox race` run supported coding tools in isolated worktrees and select a verified winner; `test/arena.test.js` and `test/race-live.test.js` pass. Ox also observes Claude, Codex, Gemini, Cursor, and Copilot hook events. It does not yet replicate Orca’s exact multi-terminal tiled desktop UI or a production mobile companion. |
| clipboard `a94f…` | DeepSeek Bot / DeepSeek Harness: named role bots and group work | **Partial** | Ox has agent teams, per-agent messaging, scoped tools, and approvals; `test/agent-messaging.test.js` proves delivery, at-most-once reads, access control, and credential/injection filtering. A DeepSeek-specific mascot/bot product is not included, and a live DeepSeek account/model has not been verified. |
| `IMG_9401.PNG`; clipboard `04e9…` | [OpenDots](https://github.com/CopilotKit/OpenDots): persistent coworkers over text, calls, and Slack | **Partial** | Ox has a daemon, schedules, agents, call-note/voice foundations, and Slack gateway code; `test/slack-gateway.test.js` passes against a stand-in. Ox does **not** yet provide OpenDots’ separate persistent container/computer per agent or prove an end-to-end configured Slack/call deployment. Those require credentials and a real service test. |
| `IMG_9425 2.PNG`; clipboard `e746…` | Four-agent crypto scanner/risk/trader/exits team | **Not built as an autonomous trading product** | This is deliberately not turned into an unattended money-moving system. Ox can orchestrate roles and its MCP catalogue documents paper-trading-first integrations, but live trading requires a separately connected broker account, explicit approvals, risk limits, and an audit. No profitability claim is made. |
| clipboard `338a…` | “five free tools”: brain, skills hub, agent reach, design/studio | **Mixed** | Local-model/offline brain, scanned skills, agent teams, and Studio exist. “Agent reach” across machines works only over a current shared LAN/cable/hotspot; AWDL/Bluetooth/sound are research, not shipping transports. “Open design” is not a separately integrated product. |
| `IMG_9431 2.PNG`; clipboard `64b9…` | [ComfyUI](https://github.com/Comfy-Org/ComfyUI): node-graph image/video/audio workflows | **Built provider; local installation needed** | Ox Studio can send a standard image workflow to a running local ComfyUI endpoint; `test/comfyui.test.js` passes. It does not embed ComfyUI’s whole node editor, and advanced video/audio workflows need ComfyUI, models, compatible hardware, and real workflow testing. |
| clipboard `dc08…` | composable engineering skills / decision notes | **Built, with safeguards** | Ox supports local `SKILL.md` skills, discovery, marketplace installs, security screening, a capped progressive skill index, and learning/drafts. `test/market.test.js` and `test/skill-index-screen.test.js` pass. Each externally sourced skill still needs review; installing a skill is not proof it is trustworthy or appropriate. |

## Supplied recordings

| File | What is visibly demonstrated | Ox status | Evidence / honest boundary |
|---|---|---|---|
| `ScreenRecording_10-16-2026 21-05-05_1.MP4` | Voice-first “Vovy” style assistant drafting a creative task | **Partial** | Ox has dictation, local/offline intents, and Island voice/wake-word components. `test/dictation.test.js` passes. A real microphone, permission, wake phrase, and full computer-control session still require a physical live test. |
| `ScreenRecording_10-16-2026 20-15-22_1.MP4` | HeyClicky-style voice tasking and an in-product skill library | **Partial** | Ox’s Clicky/operator design, skills UI, and approval model are implemented. Its controls must remain approval-gated; it is not acceptable to claim unattended arbitrary computer control from this video alone. |
| `ScreenRecording_10-21-2026 12-09-21_1.MP4` | A physical “Mochi” controller that turns voice into a Codex task | **Absent as hardware product** | Ox can receive voice/dictation and send tasks to supported coding agents, but it has no shipping dedicated hardware accessory, pairing flow, or physical-device test. |
| `ScreenRecording_10-16-2026 19-13-41_1.MP4` | Harness command center with several coding agents side-by-side | **Built in core; presentation partial** | Ox runs/observes multiple supported agents, teams, and worktree races. The exact four-pane Harness visual shell is not present, and remote-machine sessions depend on a real paired machine. |
| `ScreenRecording_10-18-2026 08-25-10_1.MP4` | Saved articles/PDFs with highlights and questions | **Built** | `src/library.js` and the authenticated `/ox/library` routes support add, list, search, read, highlight, and ask; `test/library.test.js` passes. Importing bookmarks from a proprietary social service is not an automatic built-in import. |
| `IMG_9393.MOV` | No identifiable product feature (the frame is an indistinct fabric surface) | **No actionable requirement** | There is nothing reliable to implement or compare from this clip. |

## What should not be claimed

1. A marketplace listing, documentation, or a passing mock test does not mean
   Google Cloud, ComfyUI, Slack, a phone, or a voice device is connected.
2. AWDL, Bluetooth, and acoustic links remain research until their respective
   native adapters and physical two-device tests exist.
3. Ox does not ship the named Git AI attribution integration, a Mochi-style
   hardware controller, OpenDots’ persistent per-agent computer, or an
   autonomous live crypto trading system.
4. Exact competitor visual designs and branded mascots are not copied. Ox may
   implement equivalent behavior with its own UI and assets.

## Recommended next implementation order

1. Test the existing voice/island path with a real microphone and record the
   result; fix only concrete failures found there.
2. Give `ox arena` a clearer multi-lane desktop view, preserving each agent’s
   worktree, branch, test result, cost, and approval state.
3. Add optional Git AI-compatible attribution only after a licensing and Git
   Notes interoperability review.
4. Build a local persistent-agent runtime only with isolated execution,
   per-agent permissions, resource limits, and an explicit stop control.
5. Treat broker connections as a separate, paper-trading-only feature with
   user confirmation on every live-money action.
