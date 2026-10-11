#!/usr/bin/env bash
# voice-agent-demo.sh — ox Voice: Talk to the agent and get spoken replies
#
# End-to-end demo: bidirectional conversation — listen → reason → speak.
# Shows how ox can hold a spoken conversation using voice MCP + TTS.
#
# Usage:    bash demos/voice-agent-demo.sh
# Requires: ox CLI on PATH, voice MCP installed, STT + TTS backends
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
VOICE_MCP_SERVER="${VOICE_MCP_SERVER:-voice}"
STT_BACKEND="${VOICE_STT_BACKEND:-whisper}"
TTS_BACKEND="${VOICE_TTS_BACKEND:-kokoro}"
AUDIO_DIR="${AUDIO_DIR:-$HOME/.ox/voice/audio}"
CACHE_DIR="${CACHE_DIR:-$HOME/.ox/voice/cache}"
LOG_FILE="${LOG_FILE:-$CACHE_DIR/voice-agent-demo.log}"
DEMO_LABEL="VOICE-AGENT"

mkdir -p "$AUDIO_DIR" "$CACHE_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────────
log()  { printf '[%s] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
step() { printf '\n[%s] ▶ %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
ok()   { printf '[%s][OK] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[%s][WARN] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; }
fail() { printf '[%s][FAIL] %s\n' "$DEMO_LABEL" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

# ── 0. Hardware & environment detection ─────────────────────────────────────
step "0. Detecting hardware and environment"

UNAME_M="$(uname -m)"
UNAME_S="$(uname -s)"
CPU_CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '4')"

detect_hw_stt_backend() {
  if [[ "$UNAME_M" == "arm64" ]] && [[ "$UNAME_S" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      echo "whisper"; return
    fi
  fi
  if command -v nvidia-smi &>/dev/null; then
    echo "faster-whisper"; return
  fi
  echo "whisper"
}

if [[ -z "${VOICE_STT_BACKEND}" || "${VOICE_STT_BACKEND}" == "whisper" ]]; then
  STT_BACKEND="$(detect_hw_stt_backend)"
fi

detect_hw_tts_backend() {
  if [[ "$UNAME_M" == "arm64" ]] && command -v python3 &>/dev/null; then
    if python3 -c "import mlx" 2>/dev/null; then
      echo "kokoro-mlx"; return
    fi
  fi
  echo "$TTS_BACKEND"
}
TTS_BACKEND="$(detect_hw_tts_backend)"

log "OS: $UNAME_S $UNAME_M, CPU cores: $CPU_CORES"
log "STT backend: $STT_BACKEND"
log "TTS backend: $TTS_BACKEND"

if command -v coco_ai &>/dev/null; then
  ok "coco_ai CLI found"
else
  fail "coco_ai CLI not on PATH. Install with: npm link"
fi

# ── 1. Install voice MCP ────────────────────────────────────────────────────
step "1. Installing voice MCP"

if coco_ai mcp ls 2>/dev/null | grep -q "voice"; then
  ok "voice MCP already registered"
else
  coco_ai mcp add voice --yes 2>&1 | tee -a "$LOG_FILE" || fail "voice MCP install failed"
  ok "voice MCP installed"
fi

# ── 2. Install a TTS backend ────────────────────────────────────────────────
step "2. Installing/verifying TTS backend"

TTS_READY=false

# Check Kokoro
if python3 -c "import kokoro" 2>/dev/null; then
  ok "Kokoro TTS available"
  TTS_READY=true
fi

# Check Edge-TTS
if ! "$TTS_READY" && python3 -c "import edge_tts" 2>/dev/null; then
  ok "Edge-TTS available (fallback)"
  TTS_BACKEND="edge-tts"
  TTS_READY=true
fi

# Check Piper
if ! "$TTS_READY" && command -v piper &>/dev/null; then
  ok "Piper TTS available"
  TTS_READY=true
fi

# Install if none found
if ! "$TTS_READY"; then
  log "No TTS backend found — installing Kokoro..."
  pip3 install --user kokoro >> "$LOG_FILE" 2>&1 && {
    python3 -c "import kokoro" 2>/dev/null && {
      ok "Kokoro TTS installed"
      TTS_READY=true
      TTS_BACKEND="kokoro"
    } || warn "Kokoro install may have failed"
  } || warn "pip install failed"
fi

# Verify TTS can synthesize a short phrase
if "$TTS_READY"; then
  VOICE_TEST_AUDIO="$AUDIO_DIR/tts-test.wav"
  log "Testing TTS synthesis..."
  if python3 -c "
import asyncio, edge_tts
async def gen():
    c = edge_tts.Communicate('ox voice agent is ready.', voice='en-US-GuyNeural')
    await c.save('$VOICE_TEST_AUDIO')
asyncio.run(gen())
" 2>> "$LOG_FILE" && [[ -f "$VOICE_TEST_AUDIO" ]]; then
    ok "TTS test audio generated: $VOICE_TEST_AUDIO"
  elif command -v edge-tts &>/dev/null; then
    edge-tts --voice "en-US-GuyNeural" --text "ox voice agent is ready." --write-media "$VOICE_TEST_AUDIO" >> "$LOG_FILE" 2>&1 && ok "TTS test audio generated"
  else
    warn "Could not test TTS synthesis — proceeding with demo"
  fi
fi

# ── 3. Bidirectional conversation flow ──────────────────────────────────────
step "3. Bidirectional conversation: listen → reason → speak"

cat << 'FLOW' | tee -a "$LOG_FILE"

  ┌─────────────────────────────────────────────────────────────┐
  │         Bidirectional Voice Agent Flow                      │
  │                                                             │
  │  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
  │  │  SPEAKER │───▶│   ox  │───▶│   TTS    │              │
  │  │ (you)    │    │ AGENT    │    │ OUTPUT   │              │
  │  └──────────┘    └──────────┘    └──────────┘              │
  │       │                │                │                  │
  │       │   1. LISTEN    │                │                  │
  │       │  (STT: audio → │                │                  │
  │       │   text)        │                │                  │
  │       │                │                │                  │
  │       │   2. REASON    │                │                  │
  │       │  (Agent loop:  │                │                  │
  │       │   context +    │                │                  │
  │       │   LLM call)    │                │                  │
  │       │                │                │                  │
  │       │   3. SPEAK     │                │                  │
  │       │  (TTS: text →  │                │                  │
  │       │   audio)       │                │                  │
  │       │◀───────────────│◀───────────────│                  │
  │       │  Ready for next input              │                  │
  └─────────────────────────────────────────────────────────────┘

  Conversation loop:
    while user_active:
      audio ← listen(microphone, timeout=10s)
      text  ← STT(audio)                    # speech_to_text
      reply ← agent.think(text)             # reasoning
      speech← TTS(reply)                    # text_to_speech
      play(speech)                          # speaker output

  With barge-in (interrupt while speaking):
    while user_active:
      audio ← listen(microphone, can_interrupt=true)
      if speech_playing && audio.has_voice():
        cancel_current_speech()             # interrupt TTS
      text  ← STT(audio)
      reply ← agent.think(text)
      speech← TTS(reply)
      play(speech)

FLOW

# ── 4. Example REST/curl calls to voice MCP server ──────────────────────────
step "4. Example API calls to voice MCP server"

# Determine if voice MCP server is running and on what port
VOICE_MCP_PORT="${VOICE_MCP_PORT:-8080}"

log "Voice MCP REST API examples (default port: $VOICE_MCP_PORT)"
echo "" | tee -a "$LOG_FILE"

echo "  # ── Health check ──" | tee -a "$LOG_FILE"
echo "  curl -s http://localhost:$VOICE_MCP_PORT/health" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── STT: Transcribe audio ──" | tee -a "$LOG_FILE"
echo "  curl -X POST http://localhost:$VOICE_MCP_PORT/v1/speech-to-text \\" | tee -a "$LOG_FILE"
echo "    -H 'Content-Type: application/json' \\" | tee -a "$LOG_FILE"
echo "    -d '{\"audio\": \"$(base64 -w0 "$AUDIO_DIR/test-sample.wav" 2>/dev/null || echo '<base64>')\", \"language\": \"en\"}'" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── STT: Transcribe from file ──" | tee -a "$LOG_FILE"
echo "  curl -X POST http://localhost:$VOICE_MCP_PORT/v1/speech-to-text/file \\" | tee -a "$LOG_FILE"
echo "    -F 'file=@$TEST_AUDIO'" | tee -a "$LOG_FILE" 2>/dev/null || true
echo "" | tee -a "$LOG_FILE"

echo "  # ── TTS: Synthesize text to speech ──" | tee -a "$LOG_FILE"
echo "  curl -X POST http://localhost:$VOICE_MCP_PORT/v1/text-to-speech \\" | tee -a "$LOG_FILE"
echo "    -H 'Content-Type: application/json' \\" | tee -a "$LOG_FILE"
echo "    -d '{\"text\": \"Hello, this is ox speaking.\", \"voice\": \"default\", \"format\": \"wav\"}' \\" | tee -a "$LOG_FILE"
echo "    -o output.wav" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── Voice conversation: streaming ──" | tee -a "$LOG_FILE"
echo "  curl -X POST http://localhost:$VOICE_MCP_PORT/v1/voice-conversation \\" | tee -a "$LOG_FILE"
echo "    -H 'Content-Type: application/json' \\" | tee -a "$LOG_FILE"
echo "    -d '{\"input_audio\": \"audio.wav\", \"model\": \"gpt-4\", \"stream\": true}'" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── Voice clone: create a custom voice ──" | tee -a "$LOG_FILE"
echo "  curl -X POST http://localhost:$VOICE_MCP_PORT/v1/voice-clone \\" | tee -a "$LOG_FILE"
echo "    -F 'sample=@voice_sample.wav' \\" | tee -a "$LOG_FILE"
echo "    -d '{\"name\": \"my-voice\"}'" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── List voices ──" | tee -a "$LOG_FILE"
echo "  curl http://localhost:$VOICE_MCP_PORT/v1/voices" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── Voice agent config ──" | tee -a "$LOG_FILE"
echo "  curl http://localhost:$VOICE_MCP_PORT/v1/config" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

echo "  # ── Set agent model for conversation ──" | tee -a "$LOG_FILE"
echo "  curl -X PATCH http://localhost:$VOICE_MCP_PORT/v1/config \\" | tee -a "$LOG_FILE"
echo "    -H 'Content-Type: application/json' \\" | tee -a "$LOG_FILE"
echo "    -d '{\"llm_model\": \"grok-4.6\", \"temperature\": 0.7}'" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── 5. Barge-in / interrupt support ─────────────────────────────────────────
step "5. Interrupt while speaking (barge-in)"

cat << 'BARGEIN' | tee -a "$LOG_FILE"

  ┌─────────────────────────────────────────────────────────────┐
  │  Barge-in (interrupt) Support                               │
  │                                                             │
  │  Problem: Users want to interrupt the agent mid-sentence.   │
  │  Solution: Detect voice activity during TTS playback and    │
  │            cancel the current utterance immediately.        │
  │                                                             │
  │  Flow:                                                      │
  │    1. TTS starts playing agent response                     │
  │    2. VAD (Voice Activity Detection) monitors mic           │
  │    3. If voice detected during playback →                   │
  │       a. Cancel current TTS stream (API: DELETE /v1/tts/{id}│
  │          or signal via WebSocket close)                     │
  │       b. Flush audio buffer                                 │
  │       c. Feed detected speech to STT                        │
  │       d. Agent re-reasons with combined context             │
  │       e. New TTS response starts                            │
  │                                                             │
  │  Latency target: < 300ms from voice detection to            │
  │  TTS cancellation.                                          │
  │                                                             │
  │  VAD backends:                                              │
  │    • Silero VAD (Python, lightweight)                       │
  │    • WebRTC VAD (C, very fast)                              │
  │    • Whisper-based VAD (high accuracy)                      │
  └─────────────────────────────────────────────────────────────┘

BARGEIN

log "Demonstrating interrupt simulation..."

# Simulate: start TTS, detect audio, cancel, re-process
INTERRUPT_AUDIO="$AUDIO_DIR/interrupt-demo.wav"
log "Step 1: Agent starts speaking response..."
log "Step 2: User interrupts (simulated by generating new audio)"
generate_interrupt() {
  python3 -c "
import wave, struct, math
sr=16000; dur=1; 
with wave.open('$INTERRUPT_AUDIO','w') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    for i in range(int(sr*dur)):
        v=int(16384*0.5*math.sin(2*math.pi*600*i/sr))
        w.writeframes(struct.pack('<h',v))
" 2>> "$LOG_FILE"
}
generate_interrupt
ok "Interrupt signal recorded to $INTERRUPT_AUDIO"

log "Step 3: VAD detects voice → cancels TTS stream"
log "Step 4: STT transcribes interrupt: 'wait, what do you mean?'"
log "Step 5: Agent re-renders with clarification"
log "Step 6: TTS speaks new response"
echo "" | tee -a "$LOG_FILE"

# ── 6. Voice conversation example with ox ───────────────────────────────────
step "6. Running a voice conversation with ox"

cat << 'CONVO' | tee -a "$LOG_FILE"

  # Start a voice conversation in ox:
  ox -p "Start a voice conversation. Listen to my question,
    then respond out loud."

  # Or in the REPL after starting:
  #   /voice conversation --model grok-4.6 --voice en-US-GuyNeural
  #   → Speak your question when prompted
  #   → Agent listens, reasons, and speaks the answer
  #   → Say "exit" or press Ctrl-C to end

  # One-shot voice Q&A:
  ox --voice "What is the time in Tokyo?" --speak

  # Continuous conversation mode:
  ox --voice --listen --speak --mode continuous

CONVO

# ── 7. Next steps ───────────────────────────────────────────────────────────
step "7. Next steps"

echo "" | tee -a "$LOG_FILE"
echo "  ── Voice agent setup for ox ──" | tee -a "$LOG_FILE"
echo "  • STT:  export VOICE_STT_BACKEND=$STT_BACKEND" | tee -a "$LOG_FILE"
echo "  • TTS:  export VOICE_TTS_BACKEND=$TTS_BACKEND" | tee -a "$LOG_FILE"
echo "  • Voice MCP running on:  localhost:$VOICE_MCP_PORT" | tee -a "$LOG_FILE"
echo "  • Start conversation:    ox --voice --listen --speak" | tee -a "$LOG_FILE"
echo "  • Set voice:             export VOICE_VOICE=en-US-GuyNeural" | tee -a "$LOG_FILE"
echo "  • Install TTS:           bash scripts/install-voice.sh" | tee -a "$LOG_FILE"
echo "  • Full log:              $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

ok "Voice agent demo complete!"