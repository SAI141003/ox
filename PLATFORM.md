# ox Multimodal Platform — Quick-Start Guide

> **Version:** 0.1.0 · **Status:** Stable · **Last updated:** 2026-09-15

## Getting Started in 3 Commands

```bash
# 1. Create a platform instance (auto-detects your hardware)
import { createPlatform } from './src/platform.js';
const p = createPlatform({ verbose: true });

# 2. Generate a video
await p.video.generate('A drone shot over a forest at sunrise');

# 3. Check job progress
const job = await p.video.status('vid_1_1726380000000');
```

```
┌──────────────────────────────────────────────────────────────────┐
│                    ox Platform Quick Start                       │
│                                                                  │
│  createPlatform() ──▶  Auto-detect hardware                     │
│                          Configure backends                       │
│                          Ready to use                            │
│                                                                  │
│  Then simply call:  p.voice.speak() | p.video.generate()        │
│                     p.skills.invoke() | p.benchmark.run()       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Platform Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  ox Platform (createPlatform)                                       │
│  Auto-detects hardware · Configures backends · Progress events      │
├──────────────┬──────────────┬──────────────┬────────────────────────┤
│  voice       │  video       │  skills      │  benchmark             │
│  .speak()    │  .generate() │  .list()     │  .run()               │
│  .listen()   │  .imageToV() │  .search()   │  .results()           │
│  .dictate()  │  .status()   │  .invoke()   │                        │
│  .conversation()│           │              │                        │
├──────────────┴──────────────┴──────────────┴────────────────────────┤
│  Hardware Auto-Detection                                          │
│  CPU / Apple Silicon / NVIDIA → Backend routing                    │
├────────────────────────────────────────────────────────────────────┤
│  Backends                                                         │
│  whisper.cpp · Kokoro · ComfyUI · Open-Sora · Wan2.1 · Cloud      │
└────────────────────────────────────────────────────────────────────┘
```

---

## Voice

| Method | Description | Returns |
|--------|-------------|---------|
| `voice.speak(text, opts)` | Text-to-speech | `{ audioPath }` |
| `voice.listen(opts)` | STT recording | `{ text }` |
| `voice.dictate(opts)` | Push-to-talk dictation | `AsyncGenerator` |
| `voice.conversation(opts)` | Bidirectional agent | `AsyncGenerator` |

### Examples

```js
// Speak
const { audioPath } = await p.voice.speak('Hello ox!');

// Listen (transcribe mic input)
const { text } = await p.voice.listen({ timeout: 15 });

// Dictate (stream transcripts)
for await (const chunk of p.voice.dictate({ timeout: 30 })) {
  console.log(chunk.transcript, chunk.progress + '%');
}

// Conversation
for await (const turn of p.voice.conversation({ maxTurns: 3 })) {
  console.log(`${turn.role}: ${turn.text}`);
}
```

---

## Video

| Method | Description | Returns |
|--------|-------------|---------|
| `video.generate(prompt, opts)` | Text-to-video | `{ jobId, status }` |
| `video.imageToVideo(image, prompt, opts)` | Image-to-video | `{ jobId, status }` |
| `video.status(jobId)` | Check job status | `{ status, progress, output }` |

### Examples

```js
// Generate video — returns immediately with a job ID
const { jobId } = await p.video.generate('A cat walking on a beach');

// Poll status (or use the progress stream)
const job = await p.video.status(jobId);
// { status: 'completed', progress: 100, output: './video-output/vid_1.mp4' }

// Use the progress stream for live updates
for await (const evt of p.progress) {
  renderJobProgress(evt);
}
```

---

## Skills

| Method | Description | Returns |
|--------|-------------|---------|
| `skills.list()` | List all skills | `Array<{name, description, path}>` |
| `skills.search(query)` | Find skills | `Array<{name, description, path}>` |
| `skills.invoke(id, input)` | Run a skill | `{ output }` |

### Examples

```js
// List
for (const s of p.skills.list()) console.log(s.name, '—', s.description);

// Search
const results = p.skills.search('video');

// Invoke
const result = await p.skills.invoke('video-gen-comfyui', { prompt: '...' });
```

---

## Benchmark

| Method | Description | Returns |
|--------|-------------|---------|
| `benchmark.run(name, agent)` | Run a benchmark | `{ benchmarkId, results, stats }` |
| `benchmark.results()` | Get all results | `{ benchmarks, overall }` |

### Examples

```js
const result = await p.benchmark.run('swe-coding', { model: 'claude-sonnet-5' });
const all = await p.benchmark.results();
```

---

## Configuration Reference

All configuration is via environment variables. Set before calling `createPlatform()` or in your shell profile.

### Voice Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICE_STT_BACKEND` | `whisper` | STT backend: `whisper`, `faster-whisper`, `vosk` |
| `VOICE_TTS_BACKEND` | `kokoro` | TTS backend: `kokoro`, `bark`, `edge-tts`, `piper` |
| `VOICE_MODEL_PATH` | `''` | Path to STT model file |
| `VOICE_API_KEY` | `''` | API key for cloud STT/TTS fallback |
| `VOICE_LANGUAGE` | `en` | Language code (e.g. `en`, `ja`, `fr`) |
| `VOICE_VOICE` | `default` | Voice ID for TTS |
| `VOICE_LOCAL_ONLY` | unset | Set `1` to block cloud calls |

### Video Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIDEO_BACKEND` | `opensora` | Video backend: `opensora`, `wan`, `comfyui`, `cloud` |
| `VIDEO_MODEL` | `''` | Model name (e.g. `Wan2.1-T2V`) |
| `VIDEO_RESOLUTION` | `720p` | Resolution: `480p`, `720p`, `1080p` |
| `VIDEO_DURATION` | `5` | Duration in seconds |
| `VIDEO_FPS` | `24` | Frames per second |
| `VIDEO_SEED` | `42` | Random seed for reproducibility |
| `VIDEO_OUTPUT_DIR` | `./video-output` | Output directory |
| `VIDEO_LOCAL_ONLY` | unset | Set `1` to block cloud calls |
| `VIDEO_WATERMARK` | unset | Set `1` to enable synthetic media watermark |

### Platform Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OX_BENCHMARK_DIR` | `.agent/benchmarks` | Benchmark data directory |
| `OX_JUDGE_MODEL` | `null` | LLM-as-judge model ID |
| `OX_BENCHMARK_MAX_PARALLEL` | `2` | Max parallel benchmark jobs |
| `NO_COLOR` | unset | Set `1` to disable colored output |

---

## Hardware Recommendations

| Tier | GPU | VRAM | Best For | Voice (STT/TTS) | Video |
|------|-----|------|----------|------------------|-------|
| **CPU-only** | None | — | Basic STT, lightweight tasks | whisper.cpp q4, Piper | LTX-Video (low-res) |
| **Apple Silicon** | M-series | Shared | Great all-around | whisper.cpp CoreML, Kokoro MLX | LTX-Video via MLX |
| **NVIDIA 8GB** | RTX 3060/4060 | 8GB | SD, CogVideoX | faster-whisper, Kokoro | LTX-Video, CogVideoX |
| **NVIDIA 16GB** | RTX 3090/4080 | 16GB | Full video gen | faster-whisper XL, Bark | Wan2.1-T2V, CogVideoX |
| **NVIDIA 24GB+** | RTX 4090/A6000 | 24GB+ | Best quality | Whisper XXL | Open-Sora, Hunyuan |

---

## Troubleshooting

### STT returns empty or errors
- Verify `VOICE_STT_BACKEND` is set and binary is installed
- Run `which whisper` to confirm the binary is on your PATH
- Try `VOICE_STT_BACKEND=vosk` for a lightweight fallback

### Video generation fails immediately
- Check that the backend binary exists: `which open-sora` or `which comfyui`
- Ensure `VIDEO_LOCAL_ONLY=0` if using cloud backends (and API key is set)
- Verify GPU VRAM meets model requirements (see table above)

### Skill not found
- Pass `opts.skills` to `createPlatform()` or ensure skills are installed in `~/.agents/skills/` or `~/.claude/skills/`
- Use `p.skills.search('term')` to discover available skills

### Progress events not firing
- Pass `opts.onProgress` to `createPlatform()` to receive global events
- Or iterate `for await (const e of p.progress)` for the combined stream
- Subsystem-specific streams are also available via internal progress objects

### Cloud backend refused
- Set `VOICE_LOCAL_ONLY=0` (or `VIDEO_LOCAL_ONLY=0`) to allow cloud fallback
- Ensure your API key is set (`VOICE_API_KEY`, `KOLING_API_KEY`, etc.)
- Cloud calls require explicit opt-in by design

### Color output not showing
- Ensure `NO_COLOR` is not set to `1`
- Output must be a TTY (`process.stdout.isTTY`)
- Colors are automatically disabled for pipes/redirects

---

## Progress Events

The platform emits progress events for all long-running operations.

```js
// Global stream — all subsystems combined
for await (const evt of p.progress) {
  console.log(`[${evt.phase}] ${evt.progress}% — ${evt.message}`);
}
```

Each event has: `phase` (voice:tts, video:running, skills:invoke, etc.), `progress` (0-100), and `message`.

---

*For detailed architecture documentation, see `docs/multimodal-architecture.md`.*
