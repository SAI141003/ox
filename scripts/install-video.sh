#!/usr/bin/env bash
# install-video.sh — ox video pipeline installer
#
# Installs local-first video generation backends with hardware-aware selection:
#   Orchestration: ComfyUI (primary, node-based pipeline editor)
#   OSS Models:    Open-Sora, Wan2.1, HunyuanVideo, CogVideoX, LTX-Video, Mochi
#
# Usage:    bash scripts/install-video.sh
# Config:   ~/.ox/video/config.json (written by this script)
# Env opts: VIDEO_LOCAL_ONLY=1 VIDEO_BACKEND=comfyui VIDEO_MODEL=ltx-video
set -euo pipefail

OX_HOME="${OX_HOME:-$HOME/.ox}"
VIDEO_DIR="$OX_HOME/video"
MODELS_DIR="$VIDEO_DIR/models"
WORKFLOW_DIR="$VIDEO_DIR/workflows"
CACHE_DIR="$VIDEO_DIR/cache"
LOG_FILE="$VIDEO_DIR/install.log"

log()  { printf '[video-install] %s\n' "$*" | tee -a "$LOG_FILE"; }
err()  { printf '[video-install][ERROR] %s\n' "$*" | tee -a "$LOG_FILE" >&2; }
ok()   { printf '[video-install][OK] %s\n' "$*" | tee -a "$LOG_FILE"; }
skip() { printf '[video-install][SKIP] %s (already installed)\n' "$*" | tee -a "$LOG_FILE"; }

# ─────────────────────────────────────────────────────────────────────────────
# 0. Hardware detection
# ─────────────────────────────────────────────────────────────────
echo "=== ox Video Pipeline Installer ===" | tee -a "$LOG_FILE"
echo "Started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')" | tee -a "$LOG_FILE"

detect_hardware() {
  local tier="cpu"
  local gpu="none"

  # Apple Silicon
  if [[ "$(uname -m)" == "arm64" ]] && [[ "$(uname -s)" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      tier="apple-silicon"
      log "Detected Apple Silicon — Metal-accelerated models will be selected"
    fi
  fi

  # NVIDIA GPU
  if command -v nvidia-smi &>/dev/null; then
    GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    gpu="nvidia-${GPU_MEM}mb"
    if [[ "$tier" == "cpu" ]]; then
      if [[ "$GPU_MEM" -ge 24000 ]]; then tier="nvidia-24gb"
      elif [[ "$GPU_MEM" -ge 16000 ]]; then tier="nvidia-16gb"
      elif [[ "$GPU_MEM" -ge 8000 ]];  then tier="nvidia-8gb"
      fi
    fi
    log "Detected NVIDIA GPU: $GPU_NAME ($GPU_MEM MB)"
  else
    # Check for CUDA without nvidia-smi (e.g., in containers)
    if pip3 show torch 2>/dev/null | grep -q "cuda"; then
      log "PyTorch CUDA detected (nvidia-smi not available)"
    fi
  fi

  echo "$tier:$gpu"
}

HARDWARE=$(detect_hardware)
HW_TIER="${HARDWARE%%:*}"
HW_GPU="${HARDWARE#*:}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Create directories
# ─────────────────────────────────────────────────────────────────
mkdir -p "$MODELS_DIR" "$WORKFLOW_DIR" "$CACHE_DIR"
log "Created video config directories: $VIDEO_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Install ComfyUI (orchestration layer)
# ─────────────────────────────────────────────────────────────────
install_comfyui() {
  local cdir="$MODELS_DIR/ComfyUI"
  if [[ -x "$cdir/venv/bin/python" ]] || command -v comfy &>/dev/null; then
    skip "ComfyUI"
  else
    log "Installing ComfyUI (orchestration layer)..."
    if [[ ! -d "$cdir" ]]; then
      git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$cdir" >> "$LOG_FILE" 2>&1 || \
        { err "ComfyUI clone failed"; return 1; }
    fi
    cd "$cdir"

    # Create virtual environment
    log "Creating Python venv for ComfyUI..."
    python3 -m venv venv >> "$LOG_FILE" 2>&1 || { err "venv creation failed"; return 1; }

    # Install dependencies
    # Apple Silicon: use Metal (torch) via pip
    # NVIDIA: install torch with CUDA
    # CPU-only: install CPU-only torch
    if [[ "$HW_TIER" == "apple-silicon" ]]; then
      log "Installing ComfyUI dependencies for Apple Silicon (Metal)..."
      "$cdir/venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/nightly >> "$LOG_FILE" 2>&1 || \
        err "torch install failed — ComfyUI may use system Python instead"
    elif [[ "$HW_TIER" == "nvidia-"* ]]; then
      log "Installing ComfyUI dependencies for NVIDIA CUDA..."
      "$cdir/venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cu121 >> "$LOG_FILE" 2>&1 || \
        err "torch CUDA install failed — falling back to CPU-only"
      "$cdir/venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cpu >> "$LOG_FILE" 2>&1 || true
    else
      log "Installing ComfyUI dependencies (CPU-only)..."
      "$cdir/venv/bin/pip" install torch torchvision --index-url https://download.pytorch.org/whl/cpu >> "$LOG_FILE" 2>&1 || \
        err "torch install failed"
    fi

    # Install ComfyUI requirements
    if [[ -f "$cdir/requirements.txt" ]]; then
      "$cdir/venv/bin/pip" install -r requirements.txt >> "$LOG_FILE" 2>&1 || \
        err "ComfyUI requirements install had errors"
    fi

    # Install custom nodes for video
    mkdir -p "$cdir/custom_nodes"
    log "Installing video custom nodes..."
    # LTX-Video ComfyUI node
    if [[ ! -d "$cdir/custom_nodes/ComfyUI-LTX-Video" ]]; then
      git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTX-Video.git \
        "$cdir/custom_nodes/ComfyUI-LTX-Video" >> "$LOG_FILE" 2>&1 || \
        err "LTX-Video node install failed"
    fi
    # WAS Suite (utility nodes)
    if [[ ! -d "$cdir/custom_nodes/WAS_StretchIt" ]]; then
      git clone --depth 1 https://github.com/eduardo-gonzalez/WAS_StretchIt.git \
        "$cdir/custom_nodes/WAS_StretchIt" >> "$LOG_FILE" 2>&1 || \
        err "WAS utility nodes install failed"
    fi

    # Symlink comfy binary
    ln -sf "$cdir/venv/bin/python" "$HOME/.local/bin/comfyui" 2>/dev/null || true

    ok "ComfyUI installed at $cdir"
    log "Run with:  $cdir/venv/bin/python $cdir/main.py --listen"
  fi

  # Write a default workflow
  if [[ ! -f "$WORKFLOW_DIR/t2v-basic.json" ]]; then
    cat > "$WORKFLOW_DIR/t2v-basic.json" << 'WF'
{
  "prompt": "A cinematic drone shot over a neon-lit city at night, 4K, ultra-realistic",
  "width": 1280,
  "height": 720,
  "frames": 120,
  "fps": 24,
  "steps": 30,
  "guidance": 7.5,
  "seed": 42,
  "scheduler": " DPM++ 2M Karras"
}
WF
    log "Default workflow written to $WORKFLOW_DIR/t2v-basic.json"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Install recommended OSS video model based on hardware
# ─────────────────────────────────────────────────────────────────
install_video_model() {
  local cdir="$MODELS_DIR/ComfyUI"
  local model=""

  case "$HW_TIER" in
    nvidia-24gb|nvidia-16gb)
      model="wan2.1"
      log "Installing Wan2.1-T2V (best quality/price for 16GB+ GPU)..."
      if [[ ! -d "$MODELS_DIR/wan2.1" ]]; then
        git clone --depth 1 https://github.com/Wan-Video/Wan2.1.git "$MODELS_DIR/wan2.1" >> "$LOG_FILE" 2>&1 || \
          { err "Wan2.1 clone failed"; return 1; }
        ok "Wan2.1-T2V installed at $MODELS_DIR/wan2.1"
      else
        skip "Wan2.1-T2V"
      fi
      ;;
    nvidia-8gb)
      model="ltx-video"
      log "Installing LTX-Video (fast, fits in 8GB VRAM)..."
      if [[ ! -d "$MODELS_DIR/ltx-video" ]]; then
        git clone --depth 1 https://github.com/Lightricks/LTX-Video.git "$MODELS_DIR/ltx-video" >> "$LOG_FILE" 2>&1 || \
          { err "LTX-Video clone failed"; return 1; }
        ok "LTX-Video installed at $MODELS_DIR/ltx-video"
      else
        skip "LTX-Video"
      fi
      ;;
    apple-silicon)
      model="ltx-video-mlx"
      log "Installing LTX-Video (MLX build for Apple Silicon)..."
      if ! pip3 show mlx 2>/dev/null | grep -q "mlx"; then
        pip3 install --user mlx >> "$LOG_FILE" 2>&1 || err "MLX install failed"
      fi
      if [[ ! -d "$MODELS_DIR/ltx-video-mlx" ]]; then
        git clone --depth 1 https://github.com/Lightricks/LTX-Video.git "$MODELS_DIR/ltx-video-mlx" >> "$LOG_FILE" 2>&1 || \
          { err "LTX-Video MLX clone failed"; return 1; }
        ok "LTX-Video (MLX) installed at $MODELS_DIR/ltx-video-mlx"
      else
        skip "LTX-Video (MLX)"
      fi
      ;;
    cpu)
      model="ltx-video-cpu"
      log "CPU-only system — LTX-Video is the recommended local model."
      log "For best CPU performance, consider the diffusers pipeline with ONEDNN."
      model="ltx-video"
      ;;
  esac

  echo "$model"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Run installations
# ─────────────────────────────────────────────────────────────────
log "Hardware tier: $HW_TIER"
log "GPU: $HW_GPU"

install_comfyui || true
RECOMMENDED_MODEL=$(install_video_model || echo "ltx-video")

# ─────────────────────────────────────────────────────────────────────────────
# 5. Write config
# ─────────────────────────────────────────────────────────────────

# Determine default backend and model based on hardware
case "$HW_TIER" in
  nvidia-24gb|nvidia-16gb)
    BACKEND="comfyui"
    MODEL_NAME="Wan2.1-T2V"
    RESOLUTION="720p"
    ;;
  nvidia-8gb)
    BACKEND="comfyui"
    MODEL_NAME="LTX-Video"
    RESOLUTION="480p"
    ;;
  apple-silicon)
    BACKEND="comfyui"
    MODEL_NAME="LTX-Video-MLX"
    RESOLUTION="480p"
    ;;
  cpu)
    BACKEND="comfyui"
    MODEL_NAME="LTX-Video"
    RESOLUTION="480p"
    ;;
esac

cat > "$VIDEO_DIR/config.json" << EOF
{
  "hardwareTier": "$HW_TIER",
  "gpu": "$HW_GPU",
  "localOnly": true,
  "backend": "$BACKEND",
  "model": "$MODEL_NAME",
  "resolution": "$RESOLUTION",
  "duration": 5,
  "fps": 24,
  "seed": 42,
  "outputDir": "$VIDEO_DIR/output",
  "workflowDir": "$VIDEO_DIR/workflows",
  "cacheDir": "$VIDEO_DIR/cache",
  "comfyUIDir": "$MODELS_DIR/ComfyUI",
  "watermark": true,
  "costLimitUSD": 25.00
}
EOF
ok "Config written to $VIDEO_DIR/config.json"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Print next steps
# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Video Pipeline Installation Complete ==="
echo ""
echo "Hardware tier:  $HW_TIER"
echo "GPU:            $HW_GPU"
echo "Backend:        $BACKEND"
echo "Recommended:    $MODEL_NAME"
echo "Resolution:     $RESOLUTION"
echo "Config dir:     $VIDEO_DIR"
echo "Models dir:     $MODELS_DIR"
echo ""
echo "Next steps:"
echo ""
echo "  1. Start ComfyUI server:"
echo "       $MODELS_DIR/ComfyUI/venv/bin/python $MODELS_DIR/ComfyUI/main.py --listen --port 7860"
echo ""
echo "  2. Download video model checkpoints:"
case "$HW_TIER" in
  nvidia-24gb|nvidia-16gb)
    echo "       Wan2.1:  https://huggingface.co/Wan-AI/Wan2.1-T2V-14B"
    echo "       Place in: $MODELS_DIR/wan2.1/checkpoints/"
    ;;
  nvidia-8gb)
    echo "       LTX-Video:  https://huggingface.co/Lightricks/LTX-Video"
    echo "       Place in: $MODELS_DIR/ltx-video/checkpoints/"
    ;;
  apple-silicon)
    echo "       LTX-Video (MLX):  https://huggingface.co/collections/ml-exploration"
    echo "       Place in: $MODELS_DIR/ltx-video-mlx/checkpoints/"
    ;;
  cpu)
    echo "       LTX-Video:  https://huggingface.co/Lightricks/LTX-Video"
    echo "       Place checkpoints in: $MODELS_DIR/ltx-video/checkpoints/"
    echo "       CPU generation will be slow — use low resolution and short duration."
    ;;
esac
echo ""
echo "  3. Set environment variables for ox:"
echo "       export VIDEO_LOCAL_ONLY=1"
echo "       export VIDEO_BACKEND=$BACKEND"
echo "       export VIDEO_MODEL=$MODEL_NAME"
echo ""
echo "  4. Test video generation:"
echo "       ox -p 'use video-mcp to generate a 5-second video of a cat playing'"
echo ""
echo "  5. For GPU passthrough in Docker, see:"
echo "       docker-compose.multimodal.yml"
echo ""
echo "Full install log: $LOG_FILE"
