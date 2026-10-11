#!/usr/bin/env bash
# voice-dictate-demo.sh — ox Voice: Dictate into any app and clean up
#
# End-to-end demo: record your voice → transcribe via STT → clean up text
# → paste the result. Shows how ox + voice MCP turns spoken words into
# polished text in any app.
#
# Usage:   bash demos/voice-dictate-demo.sh
# Requires: ox CLI on PATH, voice MCP installed, STT backend available
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
VOICE_MCP_SERVER="${VOICE_MCP_SERVER:-voice}"
STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
TTS_BACKEND="${VOICE_TTS_BACKEND:-kokoro}"
AUDIO_DIR="${AUDIO_DIR:-$HOME/.ox/voice/audio}"
CACHE_DIR="${CACHE_DIR:-$HOME/.ox/voice/cache}"
LOG_FILE="${LOG_FILE:-$CACHE_DIR/dictate-demo.log}"
DEMO_LABEL="VOICE-DICTATE"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
step() { printf '\n[%s] ▶ %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
ok()   { printf '[%s][OK] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[%s][WARN] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; }
fail() { printf '[%s][FAIL] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

mkdir -p "$AUDIO_DIR" "$CACHE_DIR"

# ── 0. Hardware & environment detection ─────────────────────────────────────
step "0. Detecting hardware and environment"

UNAME_M="$(uname -m)"
UNAME_S="$(uname -s)"
CPU_CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '4')"

# Determine STT backend based on hardware if not explicitly set
detect_hw_stt_backend() {
  if [[ "$UNAME_M" == "arm64" ]] && [[ "$UNAME_S" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      echo "whisper"   # whisper.cpp with CoreML on Apple Silicon
      return
    fi
  fi
  if command -v nvidia-smi &>/dev/null; then
    echo "faster-whisper"   # GPU-accelerated on NVIDIA
    return
  fi
  echo "whisper"             # default CPU fallback
}

if [[ -z "${VOICE_STT_BACKEND}" || "${VOICE_STT_BACKEND}" == "whisper" ]]; then
  STT_BACKEND="$(detect_hw_stt_backend)"
fi
log "OS: $UNAME_S $UNAME_M, CPU cores: $CPU_CORES"
log "STT backend resolved: $STT_BACKEND"
log "TTS backend resolved: $TTS_BACKEND"

# Verify coco_ai CLI is available
if command -v coco_ai &>/dev/null; then
  ok "coco_ai CLI found: $(coco_ai --version 2>/dev/null || echo 'unknown')"
else
  fail "coco_ai CLI not on PATH. Install with: npm link (from ox repo root)"
fi

# ── 1. Install voice MCP if not present ─────────────────────────────────────
step "1. Ensuring voice MCP is installed"

if coco_ai mcp ls 2>/dev/null | grep -q "voice"; then
  ok "voice MCP already registered"
else
  log "Installing voice MCP..."
  if coco_ai mcp add voice --yes 2>&1 | tee -a "$LOG_FILE"; then
    ok "voice MCP installed successfully"
  else
    fail "voice MCP install failed. Check your ox config and network."
  fi
fi

# Verify MCP tools are visible
if coco_ai mcp ls voice 2>/dev/null | grep -qE "speech_to_text|transcribe_file|text_to_speech"; then
  ok "voice MCP tools available (speech_to_text, transcribe_file, text_to_speech)"
else
  warn "Could not list voice MCP tools — they may need a server restart."
  warn "Run: coco_ai mcp restart voice"
fi

# ── 2. Prepare a test audio sample ──────────────────────────────────────────
step "2. Preparing test audio sample"

TEST_AUDIO="$AUDIO_DIR/test-sample.wav"
TEST_TEXT_FILE="$CACHE_DIR/test-transcript.txt"

# Generate a test tone / speech sample using edge-tts if available
generate_test_audio() {
  local out_file="$1"
  local text="$2"

  if python3 -c "import edge_tts" 2>/dev/null; then
    log "Generating test audio with edge-tts..."
    python3 -c "
import asyncio, edge_tts
async def gen():
    communicate = edge_tts.Communicate('$text', voice='en-US-GuyNeural')
    await communicate.save('$out_file')
asyncio.run(gen())
" 2>> "$LOG_FILE" || return 1
  elif command -v edge-tts &>/dev/null; then
    log "Generating test audio with edge-tts CLI..."
    edge-tts --voice "en-US-GuyNeural" --text "$text" --write-media "$out_file" >> "$LOG_FILE" 2>&1 || return 1
  else
    # Fallback: generate a synthetic WAV tone using sox or Python
    warn "edge-tts not found — generating synthetic WAV tone instead"
    if command -v sox &>/dev/null; then
      sox -n -r 16000 -c 1 "$out_file" synth 3 sine 440 vol 0.3 2>/dev/null || {
        # Try Python fallback
        python3 -c "
import wave, struct, math
sr=16000; dur=3; freq=440
with wave.open('$out_file','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        v=int(32767*0.3*math.sin(2*math.pi*freq*i/sr))
        w.writeframes(struct.pack('<h',v))
"
      }
    else
      python3 -c "
import wave, struct, math
sr=16000; dur=3; freq=440
with wave.open('$out_file','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        v=int(32767*0.3*math.sin(2*math.pi*freq*i/sr))
        w.writeframes(struct.pack('<h',v))
" 2>> "$LOG_FILE" || fail "Cannot generate test audio — install sox or edge-tts"
    fi
  fi
}

generate_test_audio "$TEST_AUDIO" "Hello ox. This is a test dictation for the voice demo."

if [[ -f "$TEST_AUDIO" ]]; then
  AUDIO_SIZE=$(stat -f%z "$TEST_AUDIO" 2>/dev/null || stat -c%s "$TEST_AUDIO" 2>/dev/null || echo "0")
  ok "Test audio ready: $TEST_AUDIO ($AUDIO_SIZE bytes)"
else
  fail "Test audio not created at $TEST_AUDIO"
fi

# ── 3. Test STT transcription ───────────────────────────────────────────────
step "3. Testing STT transcription ($STT_BACKEND)"

# Method A: Use voice MCP tool if available
if coco_ai mcp call voice transcribe_file "$TEST_AUDIO" 2>/dev/null | tee -a "$LOG_FILE" | grep -q "text"; then
  log "STT via voice MCP transcribe_file succeeded"
  coco_ai mcp call voice transcribe_file "$TEST_AUDIO" 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        if 'text' in d:
            with open('$TEST_TEXT_FILE','w') as f: f.write(d['text'])
    except: pass
" 2>/dev/null || true
else
  warn "Voice MCP transcribe_file not available — testing STT backend directly"

  # Method B: Test STT backend binary directly
  if [[ "$STT_BACKEND" == "whisper" ]] && command -v whisper &>/dev/null; then
    log "Running whisper.cpp on test audio..."
    whisper "$TEST_AUDIO" --output "$CACHE_DIR/test-transcript" --format txt >> "$LOG_FILE" 2>&1 || true
    if [[ -f "$CACHE_DIR/test-transcript.txt" ]]; then
      cp "$CACHE_DIR/test-transcript.txt" "$TEST_TEXT_FILE"
      ok "whisper.cpp transcription complete"
    fi
  elif [[ "$STT_BACKEND" == "faster-whisper" ]]; then
    log "Running faster-whisper on test audio..."
    python3 -c "
from faster_whisper import WhisperModel
model = WhisperModel('base', device='cpu')
segments, info = model.transcribe('$TEST_AUDIO', beam_size=5)
with open('$TEST_TEXT_FILE','w') as f:
    for seg in segments: f.write(seg.text + ' ')
print(f'Language: {info.language}, Duration: {info.duration:.2f}s')
" >> "$LOG_FILE" 2>&1 || warn "faster-whisper transcription failed"
  elif command -v vosk-transcriber &>/dev/null; then
    log "Running Vosk on test audio..."
    vosk-transcriber "$TEST_AUDIO" --output "$TEST_TEXT_FILE" >> "$LOG_FILE" 2>&1 || warn "Vosk transcription failed"
  else
    warn "No STT backend found — skipping direct test"
  fi
fi

# Verify we got some transcription
if [[ -f "$TEST_TEXT_FILE" ]] && [[ -s "$TEST_TEXT_FILE" ]]; then
  TRANSCRIPT=$(cat "$TEST_TEXT_FILE")
  ok "Transcription result: \"$TRANSCRIPT\""
else
  warn "No transcription output — creating placeholder for demo"
  echo "This is a test dictation for the voice demo." > "$TEST_TEXT_FILE"
fi

# ── 4. Clean up the transcript ──────────────────────────────────────────────
step "4. Cleaning up transcribed text"

# Show raw transcript
log "Raw transcript:"
echo "  ┌─" | tee -a "$LOG_FILE"
while IFS= read -r line; do
  echo "  │ $line" | tee -a "$LOG_FILE"
done < "$TEST_TEXT_FILE"
echo "  └─" | tee -a "$LOG_FILE"

# Cleanup operations
CLEANED_FILE="$CACHE_DIR/cleaned-transcript.txt"

python3 -c "
import re, sys
with open('$TEST_TEXT_FILE') as f: text = f.read()
# Remove filler words and hesitation markers
text = re.sub(r'\b(um|uh|like|you know|basically|literally)\b[\.,]?', '', text, flags=re.IGNORECASE)
# Normalize whitespace
text = re.sub(r'\s+', ' ', text).strip()
# Capitalize first letter
if text: text = text[0].upper() + text[1:]
# Ensure trailing period
if text and not text.endswith('.'): text += '.'
with open('$CLEANED_FILE','w') as f: f.write(text)
print(text)
" 2>> "$LOG_FILE" | tee -a "$LOG_FILE"

ok "Cleaned transcript saved to $CLEANED_FILE"

# ── 5. Show the /voice slash command usage ──────────────────────────────────
step "5. Demonstrating /voice slash command in ox"

cat << 'SLASH_CMD' | tee -a "$LOG_FILE"

  ┌─────────────────────────────────────────────────────────────┐
  │  In the ox REPL, use the /voice command:                  │
  │                                                             │
  │  /voice record                                              │
  │    → Start recording (press Ctrl-D to stop)                │
  │    → Auto-transcribes via STT backend                       │
  │                                                             │
  │  /voice record --format clean                               │
  │    → Record + transcribe + clean filler words               │
  │                                                             │
  │  /voice dictate                                             │
  │    → Dictate continuously (push-to-talk or VAD)            │
  │                                                             │
  │  /voice summarize                                           │
  │    → Summarize current voice memo                           │
  │                                                             │
  │  /voice reply "yes that's correct"                          │
  │    → Speak the response aloud via TTS                       │
  │                                                             │
  │  /voice history                                             │
  │    → List recorded voice memos                              │
  │                                                             │
  │  /voice export --format markdown                            │
  │    → Export transcript as formatted document                │
  │                                                             │
  │  /voice config                                              │
  │    → Show/set STT/TTS backends, language, voice            │
  └─────────────────────────────────────────────────────────────┘
SLASH_CMD

# ── 6. Full workflow summary ────────────────────────────────────────────────
step "6. Full workflow: record → transcribe → clean up → paste"

echo "" | tee -a "$LOG_FILE"
echo "  ╔═══════════════════════════════════════════════════════════╗" | tee -a "$LOG_FILE"
echo "  ║     ox Voice Dictate — Full Workflow                      ║" | tee -a "$LOG_FILE"
echo "  ╠═══════════════════════════════════════════════════════════╣" | tee -a "$LOG_FILE"
echo "  ║                                                           ║" | tee -a "$LOG_FILE"
echo "  ║  1. RECORD    │ Dictate into any app or via /voice record ║" | tee -a "$LOG_FILE"
echo "  ║               │ Audio saved to ~/.ox/voice/audio/         ║" | tee -a "$LOG_FILE"
echo "  ║               │                                         ║" | tee -a "$LOG_FILE"
echo "  ║  2. TRANSCRIBE│ STT backend ($STT_BACKEND) processes   ║" | tee -a "$LOG_FILE"
echo "  ║               │ audio → raw text transcript               ║" | tee -a "$LOG_FILE"
echo "  ║               │                                         ║" | tee -a "$LOG_FILE"
echo "  ║  3. CLEAN UP  │ Remove fillers, normalize spacing,      ║" | tee -a "$LOG_FILE"
echo "  ║               │ fix capitalization                        ║" | tee -a "$LOG_FILE"
echo "  ║               │                                         ║" | tee -a "$LOG_FILE"
echo "  ║  4. PASTE     │ Copy cleaned text into any app via       ║" | tee -a "$LOG_FILE"
echo "  ║               │ pbcopy / xclip / system clipboard         ║" | tee -a "$LOG_FILE"
echo "  ║                                                           ║" | tee -a "$LOG_FILE"
echo "  ╚═══════════════════════════════════════════════════════════╝" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Copy to clipboard if available
if command -p pbcopy &>/dev/null; then
  pbcopy < "$CLEANED_FILE" 2>/dev/null && ok "Cleaned text copied to clipboard (macOS)"
elif command -v xclip &>/dev/null; then
  xclip -selection clipboard < "$CLEANED_FILE" 2>/dev/null && ok "Cleaned text copied to clipboard (Linux)"
elif command -v wl-copy &>/dev/null; then
  wl-copy < "$CLEANED_FILE" 2>/dev/null && ok "Cleaned text copied to clipboard (Wayland)"
else
  warn "No clipboard tool found — cleaned text at: $CLEANED_FILE"
fi

echo "  Final text: $(cat "$CLEANED_FILE")" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── 7. Next steps ───────────────────────────────────────────────────────────
step "7. Next steps"

echo "" | tee -a "$LOG_FILE"
echo "  ── Voice setup for ox ──" | tee -a "$LOG_FILE"
echo "  • Set your STT backend:   export VOICE_STT_BACKEND=$STT_BACKEND" | tee -a "$LOG_FILE"
echo "  • Set your TTS backend:   export VOICE_TTS_BACKEND=$TTS_BACKEND" | tee -a "$LOG_FILE"
echo "  • Restart voice MCP:      coco_ai mcp restart voice" | tee -a "$LOG_FILE"
echo "  • Try dictation in ox:    ox -p 'transcribe my last voice memo'" | tee -a "$LOG_FILE"
echo "  • Install TTS:            bash scripts/install-voice.sh" | tee -a "$LOG_FILE"
echo "  • Full log:               $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

ok "Voice dictate demo complete!"