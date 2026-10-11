# ox Clicky — Voice + Computer Control Onboarding

## Purpose

ox Clicky is ox's HeyClicky-class voice + operator mode. It lets you talk to ox, and ox acts on your computer — all local, all BYOK, and approval-gated on every UI tool except `notify` (which never prompts; the other six also skip approval under `--yolo`/`trusted`).

## Onboarding Checklist (macOS)

Run `ox clicky onboard` for interactive checklist. Manually:

1. **Microphone**: System Settings → Privacy & Security → Microphone → enable Terminal.app
2. **Accessibility**: System Settings → Privacy & Security → Accessibility → enable Terminal.app
3. **Screen Recording**: System Settings → Privacy & Security → Screen Recording → enable Terminal.app
4. **Whisper/STT**: `pip install openwhispr-stt && openwhispr --start --port 8799` (or set `VOICE_LOCAL_ONLY=0` for cloud)

## Modes

| Mode | Short | Description |
|---|---|---|
| Idle | 🟢 | Waiting for input |
| Listening | 🔵 | Capturing audio (STT active) |
| Processing | 🟡 | Transcribing + agent thinking |
| Needs Approval | 🔴 | Action needs your OK |
| Acting | 🟣 | Executing approved action |
| Done | ⚪ | Completed, awaiting next command |

## Integration Points

- **Desktop**: Tauri app shows voice button (start/stop) + operator status badge
- **CLI**: `ox clicky` starts listening loop; `ox listen` single-transcribe
- **MCP**: voice-mcp provides STT/TTS tools to any MCP-capable agent
- **Serve**: Desktop → ox serve → agent loop (shared core)

## Keyboard Shortcuts (Desktop)

| Shortcut | Action |
|---|---|
| Fn+Space | Push-to-talk (default) |
| Cmd+Shift+V | Toggle voice mode |
| Cmd+Enter | Send/submit |
| Cmd+Shift+A | Approve pending action |
| Cmd+Shift+D | Deny pending action |
