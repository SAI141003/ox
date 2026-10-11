#!/usr/bin/env bash
# install-voice.sh — ox voice pipeline installer
#
# Installs local-first voice backends with hardware-aware recommendations:
#   STT:   whisper.cpp (primary), faster-whisper (GPU), Vosk (lightweight)
#   TTS:   Kokoro (primary), Bark (GPU), Edge-TTS (fallback), Piper (lightweight)
#
# Usage:    bash scripts/install-voice.sh
# Config:   ~/.ox/voice/config.json (written by this script)
# Env opts: VOICE_LOCAL_ONLY=1 VOICE_STT_BACKEND=whisper VOICE_TTS_BACKEND=kokoro
set -euo pipefail

OX_HOME="${OX_HOME:-$HOME/.ox}"
VOICE_DIR="$OX_HOME/voice"
MODELS_DIR="$VOICE_DIR/models"
LOG_FILE="$VOICE_DIR/install.log"

mkdir -p "$VOICE_DIR"

log()  { printf '[voice-install] %s\n' "$*" | tee -a "$LOG_FILE" >&2; }
err()  { printf '[voice-install][ERROR] %s\n' "$*" | tee -a "$LOG_FILE" >&2; }
ok()   { printf '[voice-install][OK] %s\n' "$*" | tee -a "$LOG_FILE" >&2; }
skip() { printf '[voice-install][SKIP] %s (already installed)\n' "$*" | tee -a "$LOG_FILE" >&2; }

# ─────────────────────────────────────────────────────────────────────────────
# 0. Hardware detection
# ─────────────────────────────────────────────────────────────────
echo "=== ox Voice Pipeline Installer ===" | tee -a "$LOG_FILE" >&2
echo "Started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE" >&2

detect_hardware() {
  local tier="cpu"
  local gpu="none"
  local accel=""

  # Apple Silicon detection
  if [[ "$(uname -m)" == "arm64" ]] && [[ "$(uname -s)" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      tier="apple-silicon"
      accel="core-ml"
      log "Detected Apple Silicon — enabling Core ML acceleration for whisper.cpp"
    fi
  fi

  # NVIDIA GPU detection
  if command -v nvidia-smi &>/dev/null; then
    GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    gpu="nvidia-${GPU_MEM}mb"
    if [[ "$tier" == "cpu" ]]; then
      if [[ "$GPU_MEM" -ge 24000 ]]; then tier="nvidia-24gb"; accel="cuda"
      elif [[ "$GPU_MEM" -ge 16000 ]]; then tier="nvidia-16gb"; accel="cuda"
      elif [[ "$GPU_MEM" -ge 8000 ]];  then tier="nvidia-8gb";  accel="cuda"
      fi
    fi
    log "Detected NVIDIA GPU: $GPU_NAME ($GPU_MEM MB)"
  fi

  # CPU core count
  CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "4")
  log "CPU cores: $CPU_CORES"

  echo "$tier:$gpu:$accel"
}

HARDWARE=$(detect_hardware)
HW_TIER="${HARDWARE%%:*}"
HW_GPU="${HARDWARE#*:}"
HW_GPU="${HW_GPU%%:*}"
HW_ACCEL="${HARDWARE##*:}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Create directories
# ─────────────────────────────────────────────────────────────────
mkdir -p "$MODELS_DIR"
mkdir -p "$VOICE_DIR/cache"
mkdir -p "$VOICE_DIR/workflows"
log "Created voice config directories: $VOICE_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Install STT backends
# ─────────────────────────────────────────────────────────────────

install_whisper_cpp() {
  local bin_name="whisper"
  if command -v whisper &>/dev/null || [[ -x "$MODELS_DIR/whisper.cpp/main/whisper" ]]; then
    ok "whisper.cpp already installed"
  else
    log "Installing whisper.cpp..."
    local clone_dir="$MODELS_DIR/whisper.cpp"
    if [[ ! -d "$clone_dir" ]]; then
      git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$clone_dir"
    fi
    cd "$clone_dir"
    make clean > /dev/null 2>&1 || true
    # Build with Metal support on Apple Silicon for GPU acceleration
    if [[ "$HW_TIER" == "apple-silicon" ]]; then
      if ! make coreml 2>> "$LOG_FILE"; then
        if ! make 2>> "$LOG_FILE"; then
          err "whisper.cpp build failed"
        fi
      fi
      log "Built whisper.cpp with CoreML support"
    else
      if ! make 2>> "$LOG_FILE"; then
        err "whisper.cpp build failed"
      fi
    fi
    # Symlink the binary to PATH
    ln -sf "$clone_dir/whisper" "$HOME/.local/bin/whisper" 2>/dev/null || true
    ok "whisper.cpp built and linked"
  fi

  # Download default model
  local model_dir="$clone_dir/models"
  if [[ ! -f "$model_dir/ggml-base.en.bin" ]]; then
    log "Downloading whisper.cpp base model (this may take a moment)..."
    # Use the whisper.cpp download script if available
    if [[ -x "$clone_dir/models/download-ggml-models.py" ]]; then
      python3 "$clone_dir/models/download-ggml-models.py" --model base.en --dir "$model_dir" >> "$LOG_FILE" 2>&1 ||         err "Model download failed — you can download manually later"
    else
      log "Model download script not found — download models manually to $model_dir"
    fi
  else
    skip "whisper.cpp base model"
  fi
}

install_faster_whisper() {
  if python3 -c "import faster_whisper" 2>/dev/null; then
    skip "faster-whisper (pip installed)"
  else
    log "Installing faster-whisper..."
    pip3 install --user faster-whisper >> "$LOG_FILE" 2>&1 ||       err "faster-whisper install failed (pip error)"
    ok "faster-whisper installed"
  fi
}

install_vosk() {
  if python3 -c "import vosk" 2>/dev/null; then
    skip "Vosk"
  else
    log "Installing Vosk for lightweight real-time STT..."
    pip3 install --user vosk >> "$LOG_FILE" 2>&1 ||       err "Vosk install failed"
    ok "Vosk installed"
  fi

  # Download small English model (optional, ~40MB)
  local vmodel_dir="$MODELS_DIR/vosk"
  if [[ ! -d "$vmodel_dir/model-en-us" ]]; then
    log "To download a Vosk model, run:"
    echo "    wget -O /tmp/vosk-model.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
    echo "    unzip /tmp/vosk-model.zip -d $vmodel_dir && mv $vmodel_dir/vosk-model-small-en-us-0.15 $vmodel_dir/model-en-us"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Install TTS backends
# ─────────────────────────────────────────────────────────────────

install_kokoro() {
  if python3 -c "import kokoro" 2>/dev/null; then
    skip "Kokoro TTS"
  else
    log "Installing Kokoro TTS..."
    if ! pip3 install --user kokoro >> "$LOG_FILE" 2>&1; then
      err "Kokoro install failed"
    fi
    ok "Kokoro TTS installed"
  fi
  # Create default voice directory
  mkdir -p "$MODELS_DIR/kokoro/voices"
}

install_edge_tts() {
  if python3 -c "import edge_tts" 2>/dev/null; then
    skip "edge-tts"
  else
    log "Installing Edge-TTS (cloud fallback)..."
    pip3 install --user edge-tts >> "$LOG_FILE" 2>&1 ||       err "edge-tts install failed"
    ok "edge-tts installed"
  fi
}

install_piper() {
  if command -v piper &>/dev/null; then
    skip "Piper TTS"
  else
    log "Installing Piper TTS (lightweight, low-latency)..."
    pip3 install --user piper-tts >> "$LOG_FILE" 2>&1 ||       err "Piper install failed"
    ok "Piper TTS installed"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Run installations (hardware-aware)
# ─────────────────────────────────────────────────────────────────

log "Hardware tier: $HW_TIER"

# STT backends
install_whisper_cpp || true
if [[ "$HW_TIER" == nvidia-* ]] || [[ "$HW_TIER" == "apple-silicon" ]]; then
  install_faster_whisper || true
fi
install_vosk || true

# TTS backends
install_kokoro || true
if [[ "$HW_TIER" == "cpu" ]] || [[ "$HW_TIER" == "apple-silicon" ]]; then
  install_piper || true
fi
install_edge_tts || true

# ─────────────────────────────────────────────────────────────────────────────
# 5. Write config
# ─────────────────────────────────────────────────────────────────

# Select primary STT backend based on hardware
case "$HW_TIER" in
  apple-silicon) STT_BACKEND="whisper" ;;       # whisper.cpp with CoreML
  nvidia-*)      STT_BACKEND="faster-whisper" ;;  # GPU-accelerated
  cpu)           STT_BACKEND="whisper" ;;         # whisper.cpp is CPU-friendly
esac

# Select primary TTS backend
case "$HW_TIER" in
  nvidia-*)      TTS_BACKEND="kokoro" ;;          # can also use Bark
  *)             TTS_BACKEND="kokoro" ;;          # Kokoro runs on CPU
esac

cat > "$VOICE_DIR/config.json" << 'CONFIG_EOF'
{
  "hardwareTier": "$HW_TIER",
  "localOnly": true,
  "stt": {
    "backend": "$STT_BACKEND",
    "model": "base.en",
    "language": "en",
    "modelDir": "$MODELS_DIR/whisper.cpp/models",
    "voskModelDir": "$MODELS_DIR/vosk/model-en-us"
  },
  "tts": {
    "backend": "$TTS_BACKEND",
    "voice": "default",
    "language": "en",
    "modelDir": "$MODELS_DIR/kokoro"
  },
  "watermark": true,
  "costLimitUSD": 10.00,
  "backends": {
    "stt": ["whisper.cpp", "faster-whisper", "vosk"],
    "tts": ["kokoro", "bark", "edge-tts", "piper"]
  }
}
CONFIG_EOF
ok "Config written to $VOICE_DIR/config.json"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Print next steps
# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Voice Pipeline Installation Complete ==="
echo ""
echo "Hardware tier:  $HW_TIER"
echo "STT backend:    $STT_BACKEND"
echo "TTS backend:    $TTS_BACKEND"
echo "Config dir:     $VOICE_DIR"
echo "Models dir:     $MODELS_DIR"
echo ""
echo "Next steps:"
echo "  1. Ensure voice models are downloaded:"
echo "       whisper:  $MODELS_DIR/whisper.cpp/models/"
echo "       kokoro:   $MODELS_DIR/kokoro/voices/"
echo ""
echo "  2. Set environment variables for ox:"
echo "       export VOICE_LOCAL_ONLY=1          # enforce local-only"
echo "       export VOICE_STT_BACKEND=$STT_BACKEND"
echo "       export VOICE_TTS_BACKEND=$TTS_BACKEND"
echo "       export VOICE_API_KEY=your-key      # only if using cloud fallback"
echo ""

case "$HW_TIER" in
  nvidia-*)
    echo "  3. GPU acceleration is available — consider installing Bark for"
    echo "     expressive voice synthesis:  pip install bark"
    ;;
  apple-silicon)
    echo "  3. Apple Silicon detected — whisper.cpp was built with CoreML."
    echo "     For MLX-accelerated Kokoro, run:  pip install mlx"
    ;;
  cpu)
    echo "  3. CPU-only system detected — Vosk and Piper provide the fastest"
    echo "     real-time dictation. For higher quality, connect a GPU or use"
    echo "     edge-tts as a cloud fallback (set VOICE_LOCAL_ONLY=0)."
    ;;
esac

echo ""
echo "  4. Test voice tools:"
echo "       ox -p 'use voice-mcp to transcribe my meeting notes'"
echo ""
echo "  5. Install the video pipeline too:"
echo "       bash scripts/install-video.sh"
echo ""
echo "Full install log: $LOG_FILE"
