# ox Multimodal Architecture

> **Status:** Design document · **Date:** 2026-09-14 · **Target:** ox v1.x multimodality layer

This document describes how ox extends from a terminal-first coding agent into a
multimodal AI platform — voice (speech-to-text, text-to-speech, voice agents) and
video generation — while preserving the zero-dependency, config-driven, locally
honest philosophy of the core agent. The multimodal layer is **opt-in**: it ships
no heavy runtime dependencies in the core agent; instead it provides thin MCP
server adapters (`src/voice-mcp.js`, `src/video-mcp.js`) that delegate to
locally-installed or cloud-hosted backends.

---

## 1. Overview — ox as a Multimodal AI Platform

### 1.1 Positioning

ox is a **terminal-first coding agent**. The multimodal extension adds voice and
video capabilities as first-class MCP tools, callable from the same agentic loop,
slash commands, and `--json` event stream that already power coding workflows.

The design follows three rules inherited from the core:

1. **Local-first by default** — backends run on the user's machine. Cloud fallbacks
   require explicit opt-in (`VOX_CLOUD_ALLOWED=1`, `VIDEO_LOCAL_ONLY=0`) and
   require API keys to be set *before* the server starts; there is no silent
   paid fallback.
2. **Config-driven backend selection** — every backend is selectable via env vars
   or `~/.ox/voice/config.json` / `~/.ox/video/config.json`. The user picks, not
   the software.
3. **Transparent resource accounting** — latency, VRAM usage, and cost (for cloud
   backends) are reported per-tool-call in the same meter that tracks token spend.

### 1.2 System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  ox CLI (Node ≥18, zero-dep)                                    │
│  bin/ox.js → src/cli.js → agent loop (src/agent.js)             │
└────┬───────────────────────────────────────────────────────┬────┘
     │                                                       │
     │ MCP stdio transport                                   │ MCP stdio transport
     ▼                                                       ▼
┌─────────────┐                                    ┌──────────────────┐
│ voice-mcp    │                                   │ video-mcp         │
│ src/voice-mcp.js  │                               │ src/video-mcp.js  │
│ (STT, TTS,   │                                    │ (T2V, I2V, V2V,  │
│  voice agents)│                                    │  galleries, jobs)│
└────┬─────────┴──┐                            ┌────┴──────────┬──────┘
     │               │                            │              │
     ▼               ▼                            ▼              ▼
┌────────┐     ┌──────────┐              ┌──────────┐    ┌────────────┐
│whisper│     │Kokoro    │              │ComfyUI   │    │Open-Sora / │
│.cpp   │     │TTS       │              │(pipeline │    │Wan2.1 /    │
│(C++)  │     │(Python)  │              │orchestr) │    │Hunyuan etc)│
└───────┘     └──────────┘              └──────────┘    └────────────┘
     │               │                            │              │
     ▼               ▼                            ▼              ▼
┌────────┐     ┌──────────┐              ┌──────────┐    ┌────────────┐
│Vosk    │     │Edge-TTS  │              │Cloud API │    │GPU: CUDA / │
│(CPU)   │     │(fallback)│              │(fallback)│    │Metal / CPU │
└────────┘     └──────────┘              └──────────┘    └────────────┘
```

### 1.3 Data Flow

1. **Agent** emits an MCP `tools/call` request with `mcp__voice__speech_to_text`
   or `mcp__video__text_to_video`.
2. The corresponding MCP server (`src/voice-mcp.js` or `src/video-mcp.js`)
   resolves the backend from its config (env vars or `~/.ox/<domain>/config.json`),
   spawns the subprocess, and tracks the job in memory.
3. For long-running video jobs, the server queues them in a `Map` and reports
   progress via `get_job_status`.
4. Results (transcript text, audio file path, video file path) are returned as
   MCP tool content back to the agent.
5. **Observability events** (latency, error reason, cost estimate) are emitted on
   stderr as structured JSON lines, consumed by the agent's logger.

---

## 2. Capability Matrix

No central skill-catalog module exists in ox; skills are discovered at runtime
via `src/skills.js` (Agent-Skills directory scanning, not a 142-skill registry).
The table below maps each category to its primary OSS backend, cloud fallback,
and minimum hardware tier. Categories relevant to the multimodal stack are marked
with **§**.

| # | Category | Primary OSS Backend | Cloud Fallback | Hardware Tier | Multimodal? |
|---|----------|--------------------|----------------|---------------|-------------|
| 1 | `coding` | Claude Code / Aider | Cursor (commercial) | CPU / 8GB | — |
| 2 | `research` | Perplexity / Brave | Perplexity Pro | CPU / 4GB | — |
| 3 | `writing` | Obsidian / Hemingway | Grammarly | CPU / 2GB | — |
| 4 | `data` | Pandas / Jupyter | — | CPU / 8GB | — |
| 5 | `image-gen` | Stable Diffusion | DALL-E 3 / Midjourney | NVIDIA 8GB | § |
| 6 | `video-gen` | Open-Sora / ComfyUI | Kling / Runway / Veo | NVIDIA 16GB+ | § |
| 7 | `audio-stt` | whisper.cpp / Vosk | OpenAI Whisper API | CPU / 4GB | § |
| 8 | `audio-tts` | Kokoro / Piper | ElevenLabs / Edge-TTS | CPU / 2GB | § |
| 9 | `voice-agents` | Pipecat / LiveKit | Twilio / Vonage | CPU / 8GB | § |
| 10 | `document-ocr` | Tesseract / Docling | Google Vision | CPU / 2GB | § |
| 11 | `automation` | Playwright | — | CPU / 4GB | — |
| 12 | `devops` | Docker / Ansible | — | CPU / 4GB | — |
| 13 | `security` | Semgrep / Trivy | Snyk | CPU / 4GB | — |
| 14 | `design` | Figma MCP / Tailwind | Figma (cloud) | CPU / 2GB | — |
| 15 | `knowledge-base` | ChromaDB / pgvector | — | CPU / 4GB | — |
| 16 | `multimodal` | Qwen-VL / LLaVA | GPT-4V / Gemini Pro | NVIDIA 8GB | § |
| 17 | `translation` | Argos / M2M100 | DeepL / Google | CPU / 2GB | — |
| 18 | `education` | Khanmigo | Coursera Plus | CPU / 2GB | — |
| 19 | `project-mgmt` | Linear / Trello | Jira / ClickUp (cloud) | CPU / 4GB | — |
| 20 | `local-llm` | Ollama / llama.cpp | — | NVIDIA 16GB+ | § |

### 2.1 Hardware Tier Definitions

| Tier | GPU | VRAM | CPU | Notes |
|------|-----|------|-----|-------|
| **CPU-only** | None | — | Any modern x86/ARM | whisper.cpp (quantized), Vosk, Kokoro (CPU build), Piper, Stable Diffusion (slow) |
| **Apple Silicon** | M-series (M1/M2/M3/M4) | Shared | 8+ cores | Core ML acceleration for whisper.cpp, MLX for LLMs, no CUDA video models yet |
| **NVIDIA 8GB** | RTX 3060 / 4060 / 4070 | 8GB GDDR6 | 6+ cores | Stable Diffusion, Qwen-VL, LTX-Video (low-res) |
| **NVIDIA 16GB** | RTX 3090 / 4080 / 4090 | 16GB GDDR6 | 8+ cores | Wan2.1, CogVideoX, LTX-Video full, ComfyUI pipelines |
| **NVIDIA 24GB+** | RTX 3090 Ti / 4090 D / A6000 | 24GB+ | 12+ cores | Open-Sora, HunyuanVideo, full ComfyUI orchestration |

---

## 3. Voice Stack

### 3.1 Speech-to-Text (STT) Backends

The voice MCP server (`src/voice-mcp.js`) selects its STT backend via the
`VOICE_STT_BACKEND` env var (default: `whisper`). Supported backends:

| Backend | License | Repo | Hardware | Use Case |
|---------|---------|------|----------|----------|
| **whisper.cpp** | MIT | [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp) | CPU / Apple Silicon | Offline, low-latency transcription; primary local backend |
| **Faster Whisper** | MIT | [guillaumekln/faster-whisper](https://github.com/guillaumekln/faster-whisper) | CPU / NVIDIA | GPU-accelerated transcription; best quality/speed tradeoff |
| **Vosk** | Apache-2.0 | [alphacep/vosk-api](https://github.com/alphacep/vosk-api) | CPU / 4GB | Lightweight, real-time streaming; dictation mode |
| **OpenAI Whisper API** | Proprietary | api.openai.com | Cloud | Fallback when local fails; requires `VOICE_API_KEY` |

**Backend selection logic** (in `src/voice-mcp.js:7`):
```
VOICE_STT_BACKEND = whisper (default)
  → whisper.cpp if binary on PATH and model present
  → faster-whisper if CUDA_VISIBLE_DEVICES set
  → Vosk if CPU-only and low latency required
  → Cloud Whisper API if VOICE_API_KEY set and local unavailable
```

### 3.2 Text-to-Speech (TTS) Backends

TTS backend selected via `VOICE_TTS_BACKEND` env var (default: `kokoro`):

| Backend | License | Repo | Hardware | Voice Count | Notes |
|---------|---------|------|----------|-------------|-------|
| **Kokoro** | MIT | [hexgrad/Kokoro-TTS](https://github.com/hexgrad/Kokoro-TTS) | CPU / 4GB | ~50 voices, 8 languages | Primary local TTS; sub-second latency |
| **Bark** | MIT | [suno-ai/bark](https://github.com/suno-ai/bark) | NVIDIA 8GB | Unlimited (voice cloning) | Expressive, emotion-bearing; slower |
| **Edge-TTS** | MIT | [rany2/edge-tts](https://github.com/rany2/edge-tts) | CPU / 2GB | 300+ voices, 75 languages | Free Microsoft Azure TTS; no API key needed |
| **Piper** | MIT | [rhasspy/piper](https://github.com/rhasspy/piper) | CPU / 2GB | 60+ voices | Ultra-low latency; embedded use |

### 3.3 Voice Agent Frameworks

| Framework | License | Repo | Role in ox |
|-----------|---------|------|------------|
| **Pipecat** | BSD-3 | [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | Real-time voice pipeline orchestration; STT → LLM → TTS streaming |
| **LiveKit** | Apache-2.0 | [livekit/livekit](https://github.com/livekit/livekit) | WebRTC transport for voice conversations; room management |
| **Handy** | MIT | [handy-voice/handy](https://github.com/handy-voice/handy) (project reference) | Local dictation tool; microphone capture → STT |
| **FreeFlow** | MIT | Community project | Dictation daemon; continuous recording with pause/resume |
| **whisrs** | MIT | Community project | Streaming transcription bridge; pipes STT to LLM context |

### 3.4 Voice MCP Tools

`src/voice-mcp.js` exposes 9 tools (defined at line 52, handlers at line 156):

| Tool | Mode | Description |
|------|------|-------------|
| `speech_to_text` | local | Transcribe base64 audio or file path to text |
| `text_to_speech` | cloud* | Synthesize text to speech, returns file path |
| `transcribe_file` | local | Transcribe an audio file from disk |
| `synthesize_file` | cloud* | Synthesize text to a specified output file |
| `list_voices` | cloud* | List available TTS voices for the configured backend |
| `voice_clone` | cloud* | Clone a voice from an audio sample (min 3s clean speech) |
| `dictate` | local | Dictate in real-time (microphone → STT) |
| `voice_conversation` | local | Real-time voice conversation (STT → LLM → TTS loop) |
| `push_to_talk` | local | Hold-to-talk: record audio, transcribe on release |

> \* `checkBackend('cloud')` gates cloud-class tools behind `VOICE_LOCAL_ONLY=1`
> refusal. `checkBackend('local')` gates local tools. This is the **local-first
> design**: local defaults are never silently replaced by cloud calls.

### 3.5 Local-First Design

- **All backends default to local.** Setting `VOICE_LOCAL_ONLY=1` (env) or
  `"localOnly": true` (config) hard-refuses any cloud-class tool.
- **Model files live in `~/.ox/voice/models/`.** whisper.cpp models, Kokoro
  checkpoints, Vosk model packs are downloaded once and cached locally.
- **No telemetry.** The voice MCP server writes only to stderr (readiness,
  errors) and stdout (JSON-RPC responses). No network calls except to
  explicitly-configured cloud endpoints.
- **Secret sanitization** (line 15): a regex strips password/tokens/API keys/
  credit-card numbers from any tool output before it reaches the agent log.

---

## 4. Video Stack

### 4.1 OSS Video Generation Models

`src/video-mcp.js:22-33` defines the model registry. Each model declares its
capabilities (t2v/i2v/v2v), supported resolutions, VRAM requirement, and license:

| Model | License | Repo | T2V | I2V | V2V | VRAM | Speed |
|-------|---------|------|-----|-----|-----|------|-------|
| **Open-Sora-1.0** | Apache-2.0 | [hpcaitech/Open-Sora](https://github.com/hpcaitech/Open-Sora) | ✓ | ✓ | ✓ | 24GB | slow |
| **Wan2.1-T2V** | Apache-2.0 | [Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1) | ✓ | ✓ | ✓ | 16GB | medium |
| **HunyuanVideo** | MIT | [Tencent/HunyuanVideo](https://github.com/Tencent/HunyuanVideo) | ✓ | ✓ | ✓ | 40GB | slow |
| **CogVideoX** | Apache-2.0 | [THUDM/CogVideo](https://github.com/THUDM/CogVideo) | ✓ | ✓ | ✓ | 24GB | medium |
| **LTX-Video** | Apache-2.0 | [Lightricks/LTX-Video](https://github.com/Lightricks/LTX-Video) | ✓ | ✓ | ✓ | 12GB | fast |
| **Mochi-1** | CC-BY-4.0 | [genmoai/mochi](https://github.com/genmoai/mochi) | ✓ | ✓ | ✗ | 16GB | medium |

### 4.2 ComfyUI Orchestration

ComfyUI serves as the **orchestration layer** for video pipelines:

- **Backend mode:** `VIDEO_BACKEND=comfyui` triggers `spawnComfyUI()` at
  `src/video-mcp.js:69`, which spawns the `comfyui` binary with
  `--prompt`, `--resolution`, `--duration`, and `--output` arguments.
- **Workflow templates:** ComfyUI workflows are stored as JSON in
  `~/.ox/video/workflows/` and referenced by name in tool calls.
- **Node-based editing:** Users can drop into the ComfyUI web UI
  (`http://localhost:7860`) for manual pipeline tweaks.

### 4.3 Studio UX

The video MCP server powers a **studio experience**:

1. **Prompt enhancement** (line 39): `PROMPT_ENHANCER` auto-appends cinematic
   camera direction and composition rules if missing.
2. **Style presets** (line 35): `cinematic`, `anime`, `photorealistic`,
   `cyberpunk`, `watercolor` — each maps to a detailed style descriptor.
3. **Negative prompts** (line 37): a default negative prompt filters out
   blurry/low-quality/deformed output.
4. **Seed control**: reproducible generation with configurable random seeds.
5. **Gallery** (`list_galleries` tool): browses `~/.ox/video/output/` with
   size, modification time, and preview image metadata.

### 4.4 Cloud Fallbacks

When `VIDEO_LOCAL_ONLY=0` (default) and a cloud model is selected, the server
falls back to cloud APIs:

| Provider | Models | Auth | Notes |
|----------|--------|------|-------|
| **Kling** | Kling-1.6 | `KOLING_API_KEY` | Best quality, 1080p, fast |
| **Runway** | Gen-3 | `RUNWAY_API_KEY` | Strong I2V/V2V support |
| **Veo** | Veo-3 | `GOOGLE_API_KEY` | Google's flagship; 1080p |
| **Minimax** | Minimax-Video | `MINIMAX_API_KEY` | Cost-effective; 720p/1080p |

Cloud calls require explicit API key configuration. If a key is missing and
`VIDEO_LOCAL_ONLY=1`, the tool returns a refusal error with the reason.

### 4.5 Video MCP Tools

`src/video-mcp.js` exposes 10 tools with a job-queue architecture:

| Tool | Returns | Description |
|------|---------|-------------|
| `text_to_video` | `{ jobId, status }` | Generate video from text prompt |
| `image_to_video` | `{ jobId, status }` | Generate video from image + text |
| `video_to_video` | `{ jobId, status }` | Transform existing video |
| `list_models` | `{ models[], total }` | List available models by backend |
| `get_model_info` | `{ name, vram, speed, ... }` | Detailed model metadata |
| `generate_video` | `{ jobId, status, mode }` | Full-control unified generation |
| `cancel_job` | `{ jobId, status }` | Cancel a queued/running job |
| `get_job_status` | `{ status, progress, output }` | Poll job progress |
| `list_galleries` | `{ gallery[], path }` | Browse output directory |
| `export_video` | `{ output, format }` | Re-encode to different format/aspect |

---

## 5. Skill Catalog Architecture

No central skill-catalog module exists in ox. `src/skills.js` handles Agent-Skills
directory discovery; capability routing is done per-MCP-server, not via a registry. The multimodal stack adds two categories not in the
original catalog structure:

### 5.1 Router Design

```
Skill Request → Skill Catalog Lookup → Backend Resolution → MCP Tool Dispatch
```

1. **Catalog lookup** (`searchSkills`, `getSkillsByCategory`): the agent matches
   the user's intent to a skill ID (e.g., `video-gen-comfyui`, `audio-stt-vosk`).
2. **Backend resolution**: the skill's `primary` field specifies the OSS tool;
   the `fallback` field (if any) specifies a cloud alternate with a toggle env
   var (e.g., `DALLE_USE_SD`).
3. **MCP dispatch**: each skill maps to an MCP tool. The MCP server name is
   derived from the category prefix:
   - `audio-stt-*` → `mcp__voice__speech_to_text` or `transcribe_file`
   - `audio-tts-*` → `mcp__voice__text_to_speech` or `synthesize_file`
   - `video-gen-*` → `mcp__video__text_to_video` / `image_to_video` / etc.
   - `multimodal-*` → `mcp__vision__analyze_image` (future)

### 5.2 Category Expansion

The existing catalog has 18 categories. The multimodal extension adds:

| New Category | Skill Count | Skills |
|-------------|-------------|--------|
| `video-gen` (extended) | 8 | Open-Sora, Wan, Hunyuan, CogVideo, Mochi, ComfyUI, Kling, Runway |
| `audio-stt` (extended) | 6 | Whisper, Faster-Whisper, whisper.cpp, Vosk, DeepSpeech, Speech-to-Text |
| `audio-tts` (extended) | 8 | ElevenLabs, Kokoro, Bark, Tortoise, Voicebox, Edge-TTS, Piper, Say |
| `voice-agents` (new) | 7 | Pipecat, LiveKit, Voice MCP, Vonage, Twilio, Plivo, Telnyx |

> These 29 skills map directly to the tools exposed by `src/voice-mcp.js` and
> `src/video-mcp.js`. The catalog entries reference the same env var toggles
> (e.g., `STT_USE_VOSK`, `DALLE_USE_SD`) used by the MCP servers.

### 5.3 Config Schema (`~/.ox/skills.json`)

Each installed skill can carry a backend config:

```json
{
  "audio-stt-vosk": {
    "enabled": true,
    "localOnly": true,
    "modelDir": "~/.ox/voice/models/vosk-model-en",
    "tier": "cpu"
  },
  "video-gen-comfyui": {
    "enabled": true,
    "port": 7860,
    "workflowDir": "~/.ox/video/workflows",
    "tier": "nvidia-16gb"
  }
}
```

---

## 6. MCP Server Design

### 6.1 Server Architecture

Both `src/voice-mcp.js` and `src/video-mcp.js` follow the same pattern:

```
┌─────────────────────────────────────────────────────────┐
│  MCP Client (ox agent loop, src/mcp.js)                 │
│  — spawns server as stdio subprocess                    │
│  — sends JSON-RPC 2.0 over stdin                        │
├─────────────────────────────────────────────────────────┤
│  MCP Server (voice-mcp.js / video-mcp.js)               │
│  — parse: JSON.parse on each stdin line                 │
│  — dispatch: tools/call → HANDLERS[name](args)          │
│  — respond: write JSON-RPC 2.0 result to stdout         │
│  — readiness: stderr "voice-mcp: ready"                 │
├─────────────────────────────────────────────────────────┤
│  Backend (subprocess or cloud API)                      │
│  — whisper.cpp, kokoro, comfyui, etc.                   │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Stdio Transport

Both servers implement the stdio JSON-RPC transport (lines 168-208 in
`src/voice-mcp.js`):

- **stdin**: newline-delimited JSON-RPC 2.0 messages.
- **stdout**: one JSON-RPC response per line.
- **stderr**: human-readable status (`voice-mcp: ready`) + structured
  observability logs.
- **Protocol version**: `2025-11-25` (matches MCP spec used by ox's client).
- **Lifecycle**: `initialize` → `tools/list` → `tools/call` → `ping` healthchecks.

The `createVoiceMcpServer(opts)` / `createVideoMcpServer(opts)` factory functions
also allow **in-process** usage (returning a server object with `start()`,
`stop()`, `status()`, `schemas()`, `call()` methods) for testing and embedded
scenarios.

### 6.3 Tool Schemas

Tool definitions are arrays of `{ name, description, inputSchema }` objects.
Schemas use JSON Schema draft 2020-12:

**Voice tools** (9 total): all input schemas are flat objects with typed
properties, enums for format/language/voice, defaults propagated from env vars
(`VOICE_LANGUAGE`, `VOICE_VOICE`, etc.).

**Video tools** (10 total): support `prompt`, `imagePath`, `videoPath`, `model`,
`resolution` (enum: `480p`/`720p`/`1080p`), `duration` (enum: `[2,3,4,5,6,8,10,12,15]`),
`fps` (enum: `[24,30,60]`), `seed` (integer), `style` (enum from
`STYLE_PRESETS`), `negative_prompt`, `watermark` (boolean).

### 6.4 Error Handling

- **Missing backend**: if `findBinary()` returns null, the job is marked
  `'error'` with a human-readable message naming the missing binary and
  suggesting the install command.
- **Local-only refusal**: `checkBackend('cloud')` throws when
  `VOICE_LOCAL_ONLY=1`, returning MCP error code `-32603`.
- **Cloud API failure**: 10% simulated failure rate in mock mode (line 98) to
  exercise retry paths; in production, the agent's self-heal loop handles
  transient failures with exponential backoff.

---

## 7. Resource Tiers

Hardware detection is performed at install time (by `scripts/install-voice.sh`
and `scripts/install-video.sh`) and at runtime (by the MCP servers via env vars).

### 7.1 Detection Signals

| Signal | Source | Method |
|--------|--------|--------|
| Apple Silicon | `sysctl -n machdep.cpu.brand_string` | grep "Apple M" |
| NVIDIA GPU | `nvidia-smi --query-gpu=name,memory.total` | parse VRAM |
| CUDA available | `nvcc --version` / `pip show torch` | check PyTorch CUDA |
| CPU cores | `nproc` | count logical cores |
| RAM | `free -h` | total system memory |

### 7.2 Tier → Backend Recommendations

| Tier | STT Recommendation | TTS Recommendation | Video Recommendation |
|------|--------------------|--------------------|---------------------|
| **CPU-only** | whisper.cpp (q4_0) | Piper / Edge-TTS | LTX-Video (low-res) |
| **Apple Silicon** | whisper.cpp (MLX) | Kokoro (MLX) | LTX-Video via MLX |
| **NVIDIA 8GB** | Faster Whisper | Kokoro / Bark | LTX-Video, CogVideoX (512×512) |
| **NVIDIA 16GB** | Faster Whisper (large) | Kokoro / Bark | Wan2.1-T2V, CogVideoX (720p) |
| **NVIDIA 24GB+** | Whisper XXL | Any | Open-Sora, HunyuanVideo (1080p) |

### 7.3 VRAM Budgeting

The video MCP server tracks VRAM via the `hardware` field in each model entry
(`src/video-mcp.js:23-32`). At job submission time, `list_models` filters out
models whose VRAM requirement exceeds the detected GPU:

```js
// Pseudo-code for VRAM filtering
const availableVRAM = detectGPUMem(); // e.g., "16GB"
const feasible = MODELS.filter(m => {
  const req = parseVRAM(m.vram);
  return req === 'cloud' ? !ENV.localOnly : req <= availableVRAM;
});
```

---

## 8. Observability

### 8.1 Logging

- **Agent logs**: `src/session.js` writes JSONL to `~/.ox/sessions/`.
- **MCP logs**: each MCP server writes structured events to stderr:
  ```json
  {"t":"2026-09-14T18:30:00Z","level":"info","tool":"text_to_video","jobId":"vid_1_1726","event":"queued"}
  {"t":"2026-09-14T18:30:05Z","level":"metric","tool":"text_to_video","jobId":"vid_1_1726","latencyMs":5230}
  {"t":"2026-09-14T18:30:05Z","level":"error","tool":"text_to_video","jobId":"vid_1_1726","reason":"VRAM_EXCEEDED"}
  ```
- **Log levels**: `debug`, `info`, `warn`, `error`, `metric`. Controlled by
  `OX_LOG_LEVEL` env var.

### 8.2 Latency

- **Per-tool latency**: measured from `tools/call` receipt to final result
  emission. Reported in the `latencyMs` metric field.
- **Component latency** (video only): split into `queueTime` + `generateTime`
  + `encodeTime` for fine-grained optimization.
- **SLA targets**: 95% of STT calls < 2s (local), 95% of TTS calls < 1s (local),
  95% of 5s video generations < 30s on NVIDIA 16GB.

### 8.3 Cost Tracking

- **Cloud STT/TTS**: billed per-minute of audio (Whisper API $0.006/min,
  ElevenLabs $0.000021/char). Accumulated in `~/.ox/voice/costs.jsonl`.
- **Cloud video**: billed per-minute of output (Kling $0.05/sec, Runway
  $0.04/sec). Accumulated in `~/.ox/video/costs.jsonl`.
- **Budget enforcement**: `--max-cost` budget gate applies to cloud multimoda
  calls; local calls are always free.
- **Cost projection**: before a cloud call, the server estimates cost from
  prompt length / audio duration / video parameters and checks against
  remaining budget.

### 8.4 Failure Reasons

The video MCP server (line 75, 88, 104) captures and reports failure reasons:

| Reason | Source | Action |
|--------|--------|--------|
| `VRAM_EXCEEDED` | GPU OOM | Suggest smaller resolution / model |
| `MODEL_NOT_FOUND` | Missing checkpoint | Link to download URL |
| `COMFYUI_NOT_FOUND` | Missing binary | Suggest `scripts/install-video.sh` |
| `API_KEY_MISSING` | Cloud fallback | Link to key configuration |
| `PROMPT_REJECTED` | Safety filter | Show refusal reason, suggest rephrase |

---

## 9. Safety

### 9.1 Illegal / Harmful Content Refusal

Both MCP servers implement **local-first content filtering**:

```
User Text/Prompt → Style Presets + Prompt Enhancer → Safety Classifier → Generation
```

- **Prompt classifiers** run before any backend is called. The classifier
  checks for: CSAM-related terms, extreme violence, hate symbols, and
  disallowed person impersonation (e.g., "deepfake of [celebrity name]").
- **Refusal semantics**: when a prompt is rejected, the server returns MCP
  error code `-32602` (invalid params) with a `reason` field explaining the
  refusal category — never silently generating harmful content.
- **No cloud bypass**: even with `VIDEO_LOCAL_ONLY=0`, the safety classifier
  runs locally before any cloud API call. This prevents prompt injection that
  might try to route through a permissive backend.

### 9.2 Synthetic Media Watermarking & Disclosure

When `VOICE_WATERMARK=1` (voice) or `VIDEO_WATERMARK=1` (video), generated
media is automatically watermarked:

**Video watermarking** (configured via `ENV.watermark`, line 15 in
`src/video-mcp.js`):
- A semi-transparent ox logo is rendered in the corner of every frame.
- An embedded metadata payload records: generation timestamp, model used,
  prompt hash, and a `"synthetic: true"` flag.

**Voice watermarking** (via `voice_clone` tool):
- A sub-audible frequency tone (19.5 kHz) is embedded in all TTS output.
- A `synthetic_voice: true` header is prepended to transcripts of synthetic
  audio (when round-tripped through STT).

### 9.3 Disclosure Policy

- **Tool results always disclose**: any tool output that is synthetic media
  includes a `synthetic: true` field in the MCP result JSON.
- **Agent behavior**: when synthetic media is presented to the user, the agent
  prepends a disclosure banner. This is enforced by a hook in
  `src/hooks.js` (`PostToolUse` event for voice/video tools).
- **Export**: when exporting sessions (`ox session export`), a manifest
  records all synthetic media files with their metadata for compliance audits.

---

## 10. Roadmap

### MVP (v0.9 — "Foundations")

- [x] `src/voice-mcp.js` — STT/TTS/dictation/voice agent MCP server (done)
- [x] `src/video-mcp.js` — T2V/I2V/V2V MCP server with job queue (done)
- [ ] `src/skill-catalog.js` — no longer exists; was a design doc claim (removed)
- [ ] `scripts/install-voice.sh` — voice backend installer with hardware detection
- [ ] `scripts/install-video.sh` — video backend installer with hardware detection
- [ ] `docker-compose.multimodal.yml` — local pipeline orchestration

### v1.0 — "Full Multimodal"

- OSS voice STT/TTS running natively via MCP
- OSS video generation (Open-Sora, Wan2.1) via ComfyUI orchestration
- Hardware-aware backend routing (CPU / Apple Silicon / NVIDIA auto-detect)
- Observability: latency, cost, failure reason tracking in `~/.ox/` logs
- Safety: local content classifier + watermarking + disclosure
- Docker Compose for one-command local pipeline deployment
- Integration tests for all voice/video MCP tools

### v2.0 — "Studio Mode"

- **Studio UX**: Tauri desktop wrapper (inheriting `desktop/` pattern) for
  voice recording, video preview, and gallery browsing.
- **Voice agents in the loop**: full Pipecat/LiveKit integration so the agent
  can have real-time spoken conversations with the user.
- **Multimodal planning**: the agent can plan a video generation workflow
  (e.g., "create a 3-scene tutorial video") and execute it across multiple
  ComfyUI nodes with checkpoints between stages.
- **Cross-modal skills**: skills that combine voice + video (e.g., "narrate
  this generated video" → TTS → overlay onto video output).
- **Model marketplace**: `ox skill add` can install video model checkpoints
  and voice profiles from a curated registry, with sha256 verification
  (following the existing `skill-add.js` denylist pattern).
- **On-device fine-tuning**: LoRA/QLoRA tuning of video models for personal
  style adaptation (Apple Silicon via `mlx-lora`, NVIDIA via `peft`).

---

## Appendix A: Configuration Reference

### Voice config (`~/.ox/voice/config.json`)

```json
{
  "localOnly": true,
  "stt": {
    "backend": "whisper.cpp",
    "model": "base",
    "language": "en",
    "modelDir": "~/.ox/voice/models/whisper"
  },
  "tts": {
    "backend": "kokoro",
    "voice": "default",
    "language": "en",
    "modelDir": "~/.ox/voice/models/kokoro"
  },
  "hardwareTier": "apple-silicon",
  "watermark": true,
  "costLimit": 10.00
}
```

### Video config (`~/.ox/video/config.json`)

```json
{
  "localOnly": true,
  "backend": "comfyui",
  "model": "LTX-Video",
  "outputDir": "~/.ox/video/output",
  "workflowDir": "~/.ox/video/workflows",
  "resolution": "720p",
  "duration": 5,
  "fps": 24,
  "seed": 42,
  "watermark": true,
  "hardwareTier": "nvidia-16gb"
}
```

## Appendix B: File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `src/voice-mcp.js` | 235 | Voice MCP server (STT/TTS/voice agents) |
| `src/video-mcp.js` | 149 | Video MCP server (T2V/I2V/V2V, job queue) |
| `src/skill-catalog.js` | ~~171~~ | ~~142 skills, 20 categories, router~~ — **removed** (no importers; CJS `module.exports` incompatible with ESM package) |
| `src/skills.js` | ~580 | Skill discovery, index, invocation |
| `src/skill-add.js` | ~680 | Denylist-gated skill installation |
| `src/hooks.js` | ~360 | Lifecycle hooks (PostToolUse for disclosure) |
| `src/mcp.js` | ~1700 | MCP client (stdio + Streamable HTTP) |
| `src/cost.js` | ~90 | Price table + cost ledger |
| `src/audit.js` | ~170 | Decision audit ledger |
| `src/sandbox.js` | ~560 | OS sandbox profiles (SBPL/bwrap) |
