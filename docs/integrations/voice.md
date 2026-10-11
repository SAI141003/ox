# OpenWhispr Voice Integration

Voice input/output integration using OpenWhispr for speech-to-text and text-to-speech capabilities.

## Overview

The OpenWhispr integration provides:
- Real-time speech recognition (STT)
- Natural text-to-speech (TTS)
- Voice command processing
- Multi-language support
- Offline-capable models

## Setup

### Prerequisites
- OpenWhispr server (self-hosted or cloud)
- Audio input/output devices
- ox CLI v0.4.0+
- FFmpeg for audio processing

### Installation

```bash
# Add voice integration
ox integrations add voice

# Install audio dependencies
# macOS
brew install ffmpeg portaudio

# Ubuntu/Debian
sudo apt-get install ffmpeg libportaudio2

# Verify
ox voice doctor
```

### Configuration

Create `.ox/voice.json`:

```json
{
  "openwhispr": {
    "endpoint": "http://localhost:8080",
    "apiKey": "${OPENWHISPR_API_KEY}",
    "model": "whisper-large-v3",
    "language": "auto",
    "translate": false
  },
  "stt": {
    "vadThreshold": 0.5,
    "silenceDuration": 1.0,
    "maxDuration": 30,
    "sampleRate": 16000,
    "channels": 1
  },
  "tts": {
    "voice": "en-us-female-1",
    "speed": 1.0,
    "pitch": 1.0,
    "format": "mp3",
    "sampleRate": 22050
  },
  "wakeword": {
    "enabled": true,
    "model": "hey_ox",
    "sensitivity": 0.7,
    "cooldown": 2.0
  },
  "audio": {
    "inputDevice": "default",
    "outputDevice": "default",
    "echoCancellation": true,
    "noiseSuppression": true
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENWHISPR_API_KEY` | Yes | API key for OpenWhispr server |
| `OPENWHISPR_ENDPOINT` | No | Server URL (default: http://localhost:8080) |
| `VOICE_INPUT_DEVICE` | No | Audio input device ID |
| `VOICE_OUTPUT_DEVICE` | No | Audio output device ID |

### Self-Hosted OpenWhispr

```bash
# Using Docker
docker run -d \
  --name openwhispr \
  -p 8080:8080 \
  -v ./models:/models \
  ghcr.io/openwhispr/server:latest \
  --model whisper-large-v3 \
  --device cuda

# Or CPU-only
docker run -d \
  --name openwhispr \
  -p 8080:8080 \
  ghcr.io/openwhispr/server:latest \
  --model whisper-base \
  --device cpu
```

## Usage

### Speech-to-Text (STT)

```typescript
import { voice } from 'ox/voice';

// One-shot transcription
const result = await voice.stt.transcribe('./audio.wav');
console.log(result.text, result.language, result.confidence);

// Streaming transcription
const stream = voice.stt.createStream({
  onPartial: (text) => console.log('Partial:', text),
  onFinal: (text) => console.log('Final:', text),
  onError: (err) => console.error(err)
});

await stream.start();
// ... speak into microphone ...
await stream.stop();

// From microphone directly
const mic = await voice.stt.fromMicrophone({
  onResult: (result) => console.log(result.text)
});
await mic.start();
```

### Text-to-Speech (TTS)

```typescript
import { voice } from 'ox/voice';

// Generate speech
const audio = await voice.tts.speak('Hello, this is ox speaking!', {
  voice: 'en-us-male-1',
  speed: 1.1
});

// Save to file
await audio.save('./output.mp3');

// Stream to speaker
await audio.play();

// SSML support
const ssml = `<speak>
  <prosody rate="slow">Welcome to</prosody>
  <emphasis level="strong">ox</emphasis>
  <break time="500ms"/>
  voice integration.
</speak>`;
await voice.tts.speakSSML(ssml);
```

### Voice Commands

```typescript
import { voice } from 'ox/voice';

const commands = {
  'open *': (target) => ox.cmd(`open ${target}`),
  'run *': (script) => ox.cmd(`run ${script}`),
  'search *': (query) => ox.cmd(`search "${query}"`),
  'stop listening': () => voice.stopListening()
};

await voice.commands.listen(commands, {
  wakeWord: 'hey ox',
  continuous: true,
  onMatch: (cmd, args) => console.log(`Executing: ${cmd}`, args),
  onNoMatch: (heard) => console.log('Not recognized:', heard)
});
```

### Real-time Conversation

```typescript
import { voice } from 'ox/voice';

const conversation = voice.createConversation({
  systemPrompt: 'You are a helpful coding assistant.',
  model: 'gpt-4o',
  voice: 'en-us-female-1'
});

conversation.on('user-speech', (text) => {
  console.log('You:', text);
});

conversation.on('assistant-speech', (text, audio) => {
  console.log('Assistant:', text);
  audio.play();
});

await conversation.start();
// Speak naturally, conversation handles turn-taking
await conversation.stop();
```

## CLI Commands

```bash
# Test microphone
ox voice test-mic

# Test speaker
ox voice test-speaker --text "Testing audio output"

# Transcribe file
ox voice transcribe ./recording.wav --output text

# Speak text
ox voice speak "Build complete" --voice en-us-male-1

# Start voice command listener
ox voice listen --wake-word "hey ox"

# List available voices
ox voice voices

# Benchmark models
ox voice benchmark --model whisper-large-v3
```

## Available Voices

| Voice ID | Language | Gender | Style |
|----------|----------|--------|-------|
| `en-us-female-1` | English (US) | Female | Neutral |
| `en-us-male-1` | English (US) | Male | Neutral |
| `en-gb-female-1` | English (UK) | Female | Neutral |
| `en-au-female-1` | English (AU) | Female | Neutral |
| `es-es-female-1` | Spanish (ES) | Female | Neutral |
| `fr-fr-female-1` | French (FR) | Female | Neutral |
| `de-de-male-1` | German (DE) | Male | Neutral |
| `ja-jp-female-1` | Japanese (JP) | Female | Neutral |
| `zh-cn-female-1` | Chinese (CN) | Female | Neutral |

Custom voices: Train via OpenWhispr voice cloning (requires 30min+ audio).

## Models

### STT Models (Whisper)

| Model | Size | Speed | Accuracy | VRAM | Use Case |
|-------|------|-------|----------|------|----------|
| `whisper-tiny` | 39 MB | ~10x | Low | 1 GB | Real-time, low resource |
| `whisper-base` | 74 MB | ~7x | Good | 1 GB | Balanced |
| `whisper-small` | 244 MB | ~4x | Better | 2 GB | Production |
| `whisper-medium` | 769 MB | ~2x | High | 5 GB | High accuracy |
| `whisper-large-v3` | 1550 MB | 1x | Highest | 10 GB | Maximum accuracy |

### TTS Models

| Model | Quality | Speed | Languages |
|-------|---------|-------|-----------|
| `piper` | Good | Fast | 50+ |
| `coqui` | High | Medium | 16 |
| `bark` | Highest | Slow | 100+ |
| `xtts-v2` | High | Medium | 16 (cloning) |

## Limits

### OpenWhispr Cloud (if using hosted)

| Tier | Requests/min | Concurrent | Model Access |
|------|--------------|------------|--------------|
| Free | 10 | 1 | tiny, base |
| Pro | 60 | 5 | All |
| Enterprise | 300 | 20 | All + custom |

### Self-Hosted

- Limited by GPU/CPU resources
- `whisper-large-v3`: ~10s per 30s audio on RTX 3080
- TTS: ~2x realtime on CPU, ~10x on GPU
- Concurrent streams: VRAM / model_size

## Troubleshooting

### No Audio Input
```bash
# List devices
ox voice devices

# Test specific device
ox voice test-mic --device "MacBook Pro Microphone"

# Check permissions (macOS)
# System Settings > Privacy & Security > Microphone
```

### High Latency
```bash
# Use smaller model
ox voice config --stt.model whisper-base

# Enable VAD tuning
ox voice config --stt.vadThreshold 0.3 --stt.silenceDuration 0.5

# Use GPU
docker run --gpus all ...
```

### Poor Recognition Accuracy
```bash
# Set language explicitly
ox voice config --stt.language en

# Increase model size
ox voice config --stt.model whisper-medium

# Train custom vocabulary
ox voice vocab add --terms "ox, kilocode, typescript, react"
```

### TTS Quality Issues
```bash
# Try different voice
ox voice speak "Test" --voice en-us-female-1

# Adjust speed/pitch
ox voice speak "Test" --speed 0.9 --pitch 1.1

# Use higher quality model
ox voice config --tts.model xtts-v2
```

### Wake Word Not Detected
```bash
# Test wake word
ox voice test-wakeword --model hey_ox

# Adjust sensitivity
ox voice config --wakeword.sensitivity 0.5

# Retrain wake word
ox voice train-wakeword --phrase "hey ox" --samples ./samples/
```

## Privacy & Security

- **Local processing**: All audio stays on your machine with self-hosted OpenWhispr
- **No cloud logging**: Configure `OPENWHISPR_ENDPOINT` to localhost
- **Encryption**: Use TLS for remote OpenWhispr (`https://`)
- **Data retention**: Configure auto-delete in OpenWhispr settings

```json
{
  "privacy": {
    "localOnly": true,
    "encryptAudio": true,
    "retentionDays": 0
  }
}
```

## Best Practices

1. **Use VAD** - Voice Activity Detection reduces false triggers
2. **Model selection** - Balance speed/accuracy for your use case
3. **Noise suppression** - Enable in noisy environments
4. **Wake word** - Prevents accidental activation
5. **Streaming STT** - Better UX for long dictation
6. **Cache TTS** - Cache common phrases for instant playback

## Migration

### From Other STT/TTS

```bash
# Migrate from Azure Speech
ox voice migrate --from azure --key $AZURE_KEY --region eastus

# Migrate from Google Cloud Speech
ox voice migrate --from gcp --credentials ./gcp-key.json

# Migrate from ElevenLabs
ox voice migrate --from elevenlabs --key $ELEVENLABS_KEY
```
