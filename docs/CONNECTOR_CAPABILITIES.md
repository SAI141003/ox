# Connector capability matrix

Ox reports four separate states for an integration: configured, reachable,
paired, and send-capable. A token or a menu entry is not treated as a live
connection. Outbound actions remain approval-gated.

| Connector | Implementation | What a fresh install can prove | To enable outbound sends |
|---|---|---|---|
| Mail | macOS Mail AppleScript | `ox mail accounts --json` lists enabled accounts | Pick an exact From address; review the visible draft; approve Send |
| Telegram | Bot API gateway | Gateway tests cover pairing, filtering, approvals | `ox gateway telegram --token …`, then `/pair` |
| Discord | Discord gateway + REST | Gateway tests cover DM pairing and approvals | Invite bot, run `ox gateway discord --token …`, then pair |
| Slack | Socket Mode + Web API | Gateway tests cover pairing, commands and approvals | Configure xapp/xoxb tokens, run the Slack gateway, then pair |
| WhatsApp | Official Cloud API | Health check reports missing/invalid credentials | Set `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`; every send asks approval |
| SMS / iMessage | macOS Messages Automation | Availability is reported on macOS | Allow Automation for OX Island/ox; every send asks approval |

WhatsApp personal-account scraping and unofficial bridges are deliberately not
claimed as connected. Windows and Linux need a supported provider or MCP
connector for Mail and Messages; Ox reports that requirement instead of
opening an unrelated app and pretending the action completed.

The app’s Messaging page is backed by `GET /ox/messaging`, including the
Cloud API health result and the Messages availability flag. The model tools
are `mail_accounts`, `mail_compose`, `whatsapp_send`, and `messages_send`.
