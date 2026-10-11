# ox Voice — Operator & Voice Control

This skill documents the ox voice and computer-control pipeline: STT → intent → operator tools → action.

## Install

No installation required — voice is built into ox core. Ensure one of:

1. **OpenWhispr daemon** (preferred local): `pip install openwhispr-stt && openwhispr --start --port 8799 --model large-v3-turbo`
2. **Whisper CLI**: `npm install -g faster-whisper` or `pip install faster-whisper`
3. **Cloud STT**: Set `VOICE_STT_BACKEND=openwhispr` and `OPENWHISPR_HOST=localhost`

## Commands

| Command | Description |
|---|---|
| `ox listen` | Read audio from stdin (base64 WAV), transcribe via STT, print text |
| `ox voice` | Show voice template / MCP server info |
| `ox voice start` | Start voice mode session |
| `ox voice stop` | Stop voice mode session |
| `ox clicky onboard` | Run permissions checklist (mic, accessibility, screen recording) |
| `ox clicky` | Start clicky operator mode |

## Quick Start (macOS)

```bash
# 1. Check permissions
ox clicky onboard

# 2. Start listening (push-to-talk style)
echo "$(base64 -i /path/to/audio.wav)" | ox listen

# 3. Or use voice mode
ox voice start

# 4. Use operator tools from the agent
# "Open Chrome" → ox runs open_app("Chrome") with approval
```

## STT → Agent Pipeline

```
Microphone → OpenWhispr/whisper STT → transcript → ox agent → operator tools
                                                         ↓
                                                   open_app
                                                   open_url
                                                   open_path
                                                   type_text
                                                   screenshot
                                                   notify
```

## Privacy

- Voice STT runs locally by default (`VOICE_LOCAL_ONLY=1`)
- No voice audio or transcripts leave the machine unless cloud STT is explicitly configured
- Audio capture indicator shown when listening

## Troubleshooting

### Microphone permission denied (macOS)
1. Open System Settings → Privacy & Security → Microphone
2. Add Terminal.app (or your terminal emulator)
3. Re-run `ox clicky onboard`

### Accessibility permission denied (macOS)
1. Open System Settings → Privacy & Security → Accessibility
2. Add Terminal.app
3. Re-run `ox clicky onboard`

### Whisper not found
```bash
pip install faster-whisper
# or
npm install -g @whisper/faster-whisper
```

## OS Support

| OS | STT | TTS | open_app | open_url | screenshot |
|---|---|---|---|---|---|
| macOS | whisper (local) | system `say` | `open -a` | `open` | `screencapture` |
| Linux | whisper (local) | espeak/pico2wave | `xdg-open` | `xdg-open` | `import` |
| Windows | whisper (local) | SAPI5 TTS | `start` | `start` | PowerShell |
