---
name: openwhispr
description: Voice dictation with OpenWhispr → pipe to ox. Use for hands-free coding input.
author: ox
version: 1.0.0
metadata:
  category: voice
  trigger: command
---

# OpenWhispr

Real-time voice dictation using the [OpenWhispr](https://openwhispr.com) STT
engine, piped directly into the ox agent for hands-free coding input. Designed
for low-latency, privacy-first voice-to-command workflows.

## Installation

### Prerequisites

- ox platform installed (see `PLATFORM.md`)
- Microphone with audio input
- Python 3.10+ (for the OpenWhispr daemon)

### Step 1 — Install OpenWhispr daemon

```bash
# Via pip
pip install openwhispr-stt

# Or build from source
git clone https://github.com/openwhispr/openwhispr.git
cd openwhispr && python -m pip install -e .
```

### Step 2 — Configure ox voice backend

Set environment variables:

```bash
export VOICE_STT_BACKEND=whisper
export VOICE_MODEL_PATH=/path/to/whisper/model
export VOICE_LANGUAGE=en
export VOICE_LOCAL_ONLY=1
```

For OpenWhispr:

```bash
export OPENWHISPR_HOST=localhost
export OPENWHISPR_PORT=8799
```

### Step 3 — Register with ox

Add to `~/.config/ox/skills.json`:

```json
{
  "openwhispr": {
    "command": "npx @openwhispr/ox-dictation",
    "env": {
      "MODEL": "large-v3-turbo",
      "LANGUAGE": "en",
      "OUTPUT_MODE": "ox-stream"
    }
  }
}
```

### Step 4 — Start the daemon

```bash
openwhispr --start --port 8799 --model large-v3-turbo
```

Verify:

```bash
curl http://localhost:8799/health
# {"status": "ok"}
```

## Available Tools

| Tool | Description |
|---|---|
| `dictation_start()` | Begin listening for voice input |
| `dictation_stop()` | Stop recording and get transcript |
| `dictation_stream()` | Open a streaming transcription session |
| `dictation_status()` | Check current dictation state |
| `dictation_set_language(lang)` | Change STT language |
| `dictation_calibrate()` | Run microphone calibration |

## Usage

### Basic Dictation

```js
// Start listening
await tools.dictation_start();

// ... speak your command ...
// "create a React component named Header with a blue background"

// Stop and get the transcript
const { text } = await tools.dictation_stop();
// text = "create a React component named Header..."
```

### Streaming Mode

```js
// Open streaming session
const stream = await tools.dictation_stream();

// Stream partial results as they come in
for await (const chunk of stream) {
  if (chunk.transcript) {
    console.log("Partial:", chunk.transcript);
  }
  if (chunk.final) {
    console.log("Final:", chunk.final);
  }
}
```

### Hands-Free Coding

```js
await tools.dictation_start({ timeout: 30 });

// Speak naturally — pause detection handles sentence boundaries
// "function calculate total that takes items array and returns the sum"
// "add error handling for empty arrays"
// "write unit tests using vitest"

const result = await tools.dictation_stop();
const { text } = result;

// Pipe the transcript directly to ox
await ox.invoke('code-assistant', { prompt: text });
```

## Voice Commands

| Command | Action |
|---|---|
| "Hey ox" | Activate listening (wake word) |
| "New line" / "New paragraph" | Insert formatting |
| "Delete last line" | Undo last dictation segment |
| "Capital {word}" | Capitalize next word |
| "Code block" | Switch to code mode |
| "Done dictating" | Stop and submit |

## Configuration

### ox config (`~/.config/ox/voice.json`)

```json
{
  "backend": "openwhispr",
  "server": {
    "host": "localhost",
    "port": 8799
  },
  "stt": {
    "engine": "whisper",
    "model": "large-v3-turbo",
    "language": "en",
    "translate": false,
    "task": "transcribe"
  },
  "hotkeys": {
    "push_to_talk": "Ctrl+Space",
    "toggle_listen": "Ctrl+Shift+Space"
  },
  "audio": {
    "device": "default",
    "sample_rate": 16000,
    "channels": 1
  }
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENWHISPR_HOST` | `localhost` | STT server host |
| `OPENWHISPR_PORT` | `8799` | STT server port |
| `VOICE_LANGUAGE` | `en` | Language code |
| `VOICE_LOCAL_ONLY` | `1` | Block cloud calls |
| `VOICE_MODEL_PATH` | — | Path to Whisper model |

## Troubleshooting

### No audio input detected
- Check system microphone permissions
- Run `openwhispr --test-mic` to verify input
- Ensure `VOICE_LOCAL_ONLY=1` is set if using local STT

### Transcription is slow
- Use a smaller model (`tiny`, `base`) for faster inference
- Enable GPU acceleration if available

### Wake word not detecting
- Adjust microphone sensitivity
- Re-run the wake word training: `openwhispr --calibrate-mic`

## References

- [OpenWhispr documentation](https://openwhispr.com/docs)
- [OpenWhispr GitHub](https://github.com/openwhispr/openwhispr)
- [ox Voice docs](https://ox.platform/docs/voice)
