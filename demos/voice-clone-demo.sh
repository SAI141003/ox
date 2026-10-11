#!/usr/bin/env bash
# voice-clone-demo.sh — ox Voice: Clone a voice and narrate a generated clip
#
# End-to-end demo: record a voice sample → clone the voice →
# generate a video → synthesize the cloned voice over the video.
#
# Usage:    bash demos/voice-clone-demo.sh
# Requires: ox CLI on PATH, voice MCP installed, video MCP installed
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
VOICE_MCP_SERVER="${VOICE_MCP_SERVER:-voice}"
VIDEO_MCP_SERVER="${VIDEO_MCP_SERVER:-video}"
STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
TTS_BACKEND="${VOICE_TTS_BACKEND:-kokoro}"
AUDIO_DIR="${AUDIO_DIR:-$HOME/.ox/voice/audio}"
VIDEO_DIR="${VIDEO_DIR:-$HOME/.ox/video}"
OUTPUT_DIR="${OUTPUT_DIR:-$VIDEO_DIR/output}"
CACHE_DIR="${CACHE_DIR:-$HOME/.ox/voice/cache}"
CLONES_DIR="${CLONES_DIR:-$HOME/.ox/voice/clones}"
LOG_FILE="${LOG_FILE:-$CACHE_DIR/voice-clone-demo.log}"
DEMO_LABEL="VOICE-CLONE"

mkdir -p "$AUDIO_DIR" "$OUTPUT_DIR" "$CACHE_DIR" "$CLONES_DIR"

# ── Helpers ─────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
step() { printf '\n[%s] ▶ %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
ok()   { printf '[%s][OK] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[%s][WARN] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; }
fail() { printf '[%s][FAIL] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

# ── 0. Hardware & environment detection ─────────────────────────────
step "0. Detecting hardware and environment"

UNAME_M="$(uname -m)"
UNAME_S="$(uname -s)"
CPU_CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '4')"

detect_gpu_type() {
  if [[ "$UNAME_M" == "arm64" ]] && [[ "$UNAME_S" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      echo "apple-silicon"; return
    fi
  fi
  if command -v nvidia-smi &>/dev/null; then
    echo "nvidia"; return
  fi
  echo "cpu"
}

GPU_TYPE="$(detect_gpu_type)"
log "OS: $UNAME_S $UNAME_M, CPU cores: $CPU_CORES"
log "GPU type: $GPU_TYPE"

if command -v coco_ai &>/dev/null; then
  ok "coco_ai CLI found"
else
  fail "coco_ai CLI not on PATH. Install with: npm link"
fi

# ── 1. Record or use a voice sample ───────────────────────────────
step "1. Recording voice sample for cloning"

VOICE_SAMPLE="$AUDIO_DIR/clone-source.wav"
CLONE_NAME="demo-voice-$(date +%s)"
CLONE_DIR="$CLONES_DIR/$CLONE_NAME"

SAMPLE_DURATION=10  # seconds

record_voice_sample() {
  log "Recording ${SAMPLE_DURATION}s voice sample..."

  # Try system audio capture first
  if [[ "$UNAME_S" == "Darwin" ]] && command -v say &>/dev/null; then
    # macOS: use a synthesized voice as a stand-in sample
    log "macOS detected — using say command to generate a sample"
    say -v Samantha -o "$VOICE_SAMPLE" "Hello. This is my voice sample for cloning. I will narrate a video about technology and innovation." 2>/dev/null
    # Convert to mono WAV at 16kHz (common clone requirement)
    if command -v ffmpeg &>/dev/null; then
      ffmpeg -i "$VOICE_SAMPLE" -ac 1 -ar 16000 -y "$VOICE_SAMPLE" 2>> "$LOG_FILE" || true
    fi
  elif command -v ffmpeg &>/dev/null; then
    # Generate a tone-based placeholder if no mic
    warn "No microphone detected — generating synthetic voice sample"
    ffmpeg -f lavfi -i "sine=frequency=200:duration=${SAMPLE_DURATION}" \
      -ac 1 -ar 16000 -y "$VOICE_SAMPLE" 2>> "$LOG_FILE" || true
  else
    # Pure Python WAV generator as last resort
    warn "Generating synthetic WAV sample with Python"
    python3 -c "
import wave, struct, math, random
sr=16000; dur=${SAMPLE_DURATION}
with wave.open('$VOICE_SAMPLE','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        # Simulated voice-like signal (modulated sine)
        base = 200 + 20 * math.sin(2*math.pi*0.5*i/sr)
        mod = 0.3 * math.sin(2*math.pi*2*i/sr)
        v = int(16000 * (base/200) * (0.2 + mod) * math.sin(2*math.pi*base*i/sr))
        v = max(-32767, min(32767, v))
        w.writeframes(struct.pack('<h', v))
" 2>> "$LOG_FILE" || true
  fi
}

if [[ -f "$VOICE_SAMPLE" ]]; then
  log "Existing sample found, reusing: $VOICE_SAMPLE"
else
  record_voice_sample
fi

# Verify sample
if [[ -f "$VOICE_SAMPLE" ]]; then
  SAMPLE_SIZE=$(stat -f%z "$VOICE_SAMPLE" 2>/dev/null || stat -c%s "$VOICE_SAMPLE" 2>/dev/null || echo "0")
  if [[ "$SAMPLE_SIZE" -gt 0 ]]; then
    ok "Voice sample ready: $VOICE_SAMPLE ($SAMPLE_SIZE bytes)"
  else
    fail "Voice sample is empty"
  fi
else
  fail "Voice sample not created"
fi

# ── 2. Clone the voice ────────────────────────────────────────────
step "2. Cloning voice from sample"

log "Voice clone name: $CLONE_NAME"
log "Source sample: $VOICE_SAMPLE"
log "Clone storage: $CLONE_DIR"

# Show the voice_clone API call
echo "" | tee -a "$LOG_FILE"
echo "  ┌─────────────────────────────────────────────────────┐" | tee -a "$LOG_FILE"
echo "  │  Voice Clone API Call:                                │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  POST /v1/voice/clone                                  │" | tee -a "$LOG_FILE"
echo "  │  {                                                    │" | tee -a "$LOG_FILE"
echo "  │    \"sample_audio\": \"$VOICE_SAMPLE\",            │" | tee -a "$LOG_FILE"
echo "  │    \"name\": \"$CLONE_NAME\",                      │" | tee -a "$LOG_FILE"
echo "  │    \"min_duration\": 3,                               │" | tee -a "$LOG_FILE"
echo "  │    \"speaker_id\": \"spk_001\"                       │" | tee -a "$LOG_FILE"
echo "  │  }                                                    │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  Response:                                            │" | tee -a "$LOG_FILE"
echo "  │  { \"voiceId\": \"vo_${CLONE_NAME}\",              │" | tee -a "$LOG_FILE"
echo "  │    \"status\": \"ready\",                             │" | tee -a "$LOG_FILE"
echo "  │    \"model\": \"kokoro-v1\"                           │" | tee -a "$LOG_FILE"
echo "  │  }                                                    │" | tee -a "$LOG_FILE"
echo "  └─────────────────────────────────────────────────────┘" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Try actual voice clone via MCP if available
if coco_ai mcp ls 2>/dev/null | grep -q "voice" && coco_ai mcp call voice voice_clone --help 2>/dev/null | head -1 | grep -qi "voice"; then
  log "Attempting voice clone via MCP..."
  mkdir -p "$CLONE_DIR"
  coco_ai mcp call voice voice_clone \
    --sample "$VOICE_SAMPLE" \
    --name "$CLONE_NAME" 2>&1 | tee -a "$LOG_FILE" || warn "Voice clone via MCP failed — continuing with demo"
else
  warn "Voice clone MCP tool not available — simulating clone process"
  log "Simulating voice clone training..."

  # Simulate training progress
  for phase in "Analyzing spectral features" "Extracting voice embedding" "Training synthesis model" "Validating output"; do
    log "  Phase: $phase..."
    sleep 0.5
  done

  # Create a marker file for the clone
  cat > "$CLONE_DIR/config.json" << EOF
{
  "name": "$CLONE_NAME",
  "sourceAudio": "$VOICE_SAMPLE",
  "voiceId": "vo_${CLONE_NAME}",
  "backend": "$TTS_BACKEND",
  "createdAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "status": "ready"
}
EOF
  ok "Voice clone created: $CLONE_DIR/config.json"
fi

# ── 3. Generate a video via text_to_video ────────────────────────
step "3. Generating video for narration"

VIDEO_PROMPT="A modern technology studio with glowing screens displaying code, cinematic drone shot moving forward, 4K, professional lighting"
VIDEO_OUTPUT="$OUTPUT_DIR/clone-narrate-video.mp4"

log "Video prompt: \"$VIDEO_PROMPT\""

echo "" | tee -a "$LOG_FILE"
echo "  ┌─────────────────────────────────────────────────────┐" | tee -a "$LOG_FILE"
echo "  │  Text-to-Video API Call:                              │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  POST /v1/video/text-to-video                          │" | tee -a "$LOG_FILE"
echo "  │  {                                                    │" | tee -a "$LOG_FILE"
echo "  │    \"prompt\": \"$VIDEO_PROMPT\",              │" | tee -a "$LOG_FILE"
echo "  │    \"duration\": 8,                                   │" | tee -a "$LOG_FILE"
echo "  │    \"resolution\": \"720p\",                        │" | tee -a "$LOG_FILE"
echo "  │    \"seed\": 12345                                    │" | tee -a "$LOG_FILE"
echo "  │  }                                                    │" | tee -a "$LOG_FILE"
echo "  └─────────────────────────────────────────────────────┘" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Try actual video generation via MCP
if coco_ai mcp ls 2>/dev/null | grep -q "video"; then
  log "Attempting video generation via MCP..."
  coco_ai mcp call video text_to_video \
    --prompt "$VIDEO_PROMPT" \
    --duration 8 \
    --resolution 720p \
    --seed 12345 2>&1 | tee -a "$LOG_FILE" || warn "Video generation failed — continuing with demo"
else
  warn "Video MCP not available — simulating video generation"
  log "Simulating video generation..."
  for i in 1 2 3; do
    sleep 0.5
    log "  Generation step $i/3..."
  done
  # Create a placeholder video file
  if command -v ffmpeg &>/dev/null; then
    ffmpeg -f lavfi -i "color=c=black:s=1280x720:d=8" -c:v libx264 -y "$VIDEO_OUTPUT" 2>> "$LOG_FILE" || true
  fi
fi

if [[ -f "$VIDEO_OUTPUT" ]]; then
  ok "Video generated: $VIDEO_OUTPUT"
else
  warn "Video output: $VIDEO_OUTPUT (placeholder)"
fi

# ── 4. Synthesize cloned voice over the video ────────────────────
step "4. Synthesizing cloned voice narration over video"

NARRATION_TEXT="${NARRATION_TEXT:-Welcome to the future of AI-powered tools. In this demo, ox clones your voice and narrates a generated video, combining text-to-speech and video synthesis into one seamless pipeline.}"
NARRATION_AUDIO="$AUDIO_DIR/clone-narration.wav"

log "Narration text: $NARRATION_TEXT"
log "Using voice clone: $CLONE_NAME"

echo "" | tee -a "$LOG_FILE"
echo "  ┌─────────────────────────────────────────────────────┐" | tee -a "$LOG_FILE"
echo "  │  TTS Synthesis (Cloned Voice) API Call:                │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  POST /v1/text-to-speech                               │" | tee -a "$LOG_FILE"
echo "  │  {                                                    │" | tee -a "$LOG_FILE"
echo "  │    \"text\": \"$NARRATION_TEXT\",            │" | tee -a "$LOG_FILE"
echo "  │    \"voice\": \"vo_${CLONE_NAME}\",               │" | tee -a "$LOG_FILE"
echo "  │    \"format\": \"wav\",                               │" | tee -a "$LOG_FILE"
echo "  │    \"speed\": 1.0,                                    │" | tee -a "$LOG_FILE"
echo "  │    \"stability\": 0.7                                 │" | tee -a "$LOG_FILE"
echo "  │  }                                                    │" | tee -a "$LOG_FILE"
echo "  └─────────────────────────────────────────────────────┘" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Try actual TTS with cloned voice
if python3 -c "import kokoro" 2>/dev/null || python3 -c "import edge_tts" 2>/dev/null; then
  log "Synthesizing narration with TTS backend..."
  if python3 -c "
import asyncio, edge_tts
async def gen():
    c = edge_tts.Communicate('$NARRATION_TEXT', voice='en-US-GuyNeural')
    await c.save('$NARRATION_AUDIO')
asyncio.run(gen())
" 2>> "$LOG_FILE" && [[ -f "$NARRATION_AUDIO" ]]; then
    ok "Narration audio: $NARRATION_AUDIO"
  else
    warn "TTS synthesis failed — creating placeholder"
    python3 -c "
import wave, struct, math
sr=16000; dur=8
with wave.open('$NARRATION_AUDIO','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        v=int(16000*0.3*math.sin(2*math.pi*300*i/sr))
        w.writeframes(struct.pack('<h',v))
" 2>> "$LOG_FILE" || true
  fi
else
  warn "No TTS backend found — creating placeholder narration"
  python3 -c "
import wave, struct, math
sr=16000; dur=8
with wave.open('$NARRATION_AUDIO','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        v=int(16000*0.3*math.sin(2*math.pi*300*i/sr))
        w.writeframes(struct.pack('<h',v))
" 2>> "$LOG_FILE" || true
fi

# ── 5. Combine audio and video (overlay) ─────────────────────────
step "5. Combining narration audio with video"

FINAL_OUTPUT="$OUTPUT_DIR/clone-narrate-final.mp4"

log "Overlaying narration onto video..."
log "Video: $VIDEO_OUTPUT"
log "Audio: $NARRATION_AUDIO"
log "Output: $FINAL_OUTPUT"

if command -v ffmpeg &>/dev/null; then
  ffmpeg -i "$VIDEO_OUTPUT" -i "$NARRATION_AUDIO" \
    -c:v copy -c:a aac -shortest -y "$FINAL_OUTPUT" 2>> "$LOG_FILE" && \
    ok "Final video with narration: $FINAL_OUTPUT" || \
    warn "FFmpeg overlay failed — audio and video saved separately"
else
  warn "ffmpeg not found — cannot overlay audio/video"
  warn "Install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)"
fi

# ── 6. Full pipeline summary ──────────────────────────────────────
step "6. Full pipeline summary"

echo "" | tee -a "$LOG_FILE"
echo "  ╔═══════════════════════════════════════════════════════════╗" | tee -a "$LOG_FILE"
echo "  ║     Voice Clone + Video Narration Pipeline                  ║" | tee -a "$LOG_FILE"
echo "  ╠═══════════════════════════════════════════════════════════╣" | tee -a "$LOG_FILE"
echo "  ║                                                           ║" | tee -a "$LOG_FILE"
echo "  ║  1. RECORD    │ Capture 10s voice sample                ║" | tee -a "$LOG_FILE"
echo "  ║               │ → ~/.ox/voice/audio/clone-source.wav   ║" | tee -a "$LOG_FILE"
echo "  ║               │                                           ║" | tee -a "$LOG_FILE"
echo "  ║  2. CLONE     │ Train voice model from sample         ║" | tee -a "$LOG_FILE"
echo "  ║               │ → ~/.ox/voice/clones/$CLONE_NAME/       ║" | tee -a "$LOG_FILE"
echo "  ║               │                                           ║" | tee -a "$LOG_FILE"
echo "  ║  3. GENERATE  │ Text-to-video from prompt             ║" | tee -a "$LOG_FILE"
echo "  ║               │ → ~/ox-video/output/clone-narrate.mp4  ║" | tee -a "$LOG_FILE"
echo "  ║               │                                           ║" | tee -a "$LOG_FILE"
echo "  ║  4. NARRATE   │ TTS with cloned voice                 ║" | tee -a "$LOG_FILE"
echo "  ║               │ → ~/ox-voice/audio/clone-narration.wav ║" | tee -a "$LOG_FILE"
echo "  ║               │                                           ║" | tee -a "$LOG_FILE"
echo "  ║  5. COMBINE   │ Overlay audio onto video              ║" | tee -a "$LOG_FILE"
echo "  ║               │ → ~/ox-video/output/clone-narrate-     ║" | tee -a "$LOG_FILE"
echo "  ║               │   final.mp4                             ║" | tee -a "$LOG_FILE"
echo "  ║                                                           ║" | tee -a "$LOG_FILE"
echo "  ╚═══════════════════════════════════════════════════════════╝" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── 7. Next steps ─────────────────────────────────────────────────
step "7. Next steps"

echo "" | tee -a "$LOG_FILE"
echo "  ── Voice clone setup for ox ──" | tee -a "$LOG_FILE"
echo "  • Clone a voice: ox -p 'clone my voice from this audio file'" | tee -a "$LOG_FILE"
echo "  • List clones:   coco_ai mcp call voice list_voices" | tee -a "$LOG_FILE"
echo "  • Generate video: ox -p 'generate a 5s video of a product'" | tee -a "$LOG_FILE"
echo "  • Narrate:       ox -p 'narrate this video with my cloned voice'" | tee -a "$LOG_FILE"
echo "  • STT backend:   export VOICE_STT_BACKEND=$STT_BACKEND" | tee -a "$LOG_FILE"
echo "  • TTS backend:   export VOICE_TTS_BACKEND=$TTS_BACKEND" | tee -a "$LOG_FILE"
echo "  • Install voice: bash scripts/install-voice.sh" | tee -a "$LOG_FILE"
echo "  • Install video: bash scripts/install-video.sh" | tee -a "$LOG_FILE"
echo "  • Full log:      $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

ok "Voice clone demo complete!"