#!/usr/bin/env bash
# video-gen-demo.sh — ox Video: Generate a 5s product video from a prompt
#
# End-to-end demo: submit a text-to-video job → poll → preview → export.
# Shows how ox + video MCP generates, tracks, and exports videos.
#
# Usage:    bash demos/video-gen-demo.sh
# Requires: ox CLI on PATH, video MCP installed, GPU preferred
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
VIDEO_MCP_SERVER="${VIDEO_MCP_SERVER:-video}"
VIDEO_BACKEND="${VIDEO_BACKEND:-comfyui}"
VIDEO_MODEL="${VIDEO_MODEL:-ltx-video}"
VIDEO_DIR="${VIDEO_DIR:-$HOME/.ox/video}"
OUTPUT_DIR="${OUTPUT_DIR:-$VIDEO_DIR/output}"
CACHE_DIR="${CACHE_DIR:-$VIDEO_DIR/cache}"
WORKFLOW_DIR="${WORKFLOW_DIR:-$VIDEO_DIR/workflows}"
LOG_FILE="${LOG_FILE:-$CACHE_DIR/video-gen-demo.log}"
DEMO_LABEL="VIDEO-GEN"

mkdir -p "$OUTPUT_DIR" "$CACHE_DIR" "$WORKFLOW_DIR"

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

detect_gpu() {
  local gpu_info="none"
  local gpu_type="cpu"

  # Apple Silicon
  if [[ "$UNAME_M" == "arm64" ]] && [[ "$UNAME_S" == "Darwin" ]]; then
    if sysctl -n machdep.cpu.brand_string 2>/dev/null | grep -qi "Apple M"; then
      gpu_info="Apple Silicon (Metal)"
      gpu_type="apple-silicon"
    fi
  fi

  # NVIDIA
  if command -v nvidia-smi &>/dev/null; then
    GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    gpu_info="$GPU_NAME ($GPU_MEM MB)"
    gpu_type="nvidia"
  elif python3 -c "import torch; assert torch.cuda.is_available()" 2>/dev/null; then
    gpu_info="CUDA (detected via PyTorch)"
    gpu_type="nvidia"
  fi

  echo "$gpu_type:$gpu_info"
}

GPU_DETECT="$(detect_gpu)"
GPU_TYPE="${GPU_DETECT%%:*}"
GPU_INFO="${GPU_DETECT#*:}"

log "OS: $UNAME_S $UNAME_M, CPU cores: $CPU_CORES"
log "GPU: $GPU_INFO"

# Select backend and model based on hardware
select_video_backend() {
  case "$GPU_TYPE" in
    apple-silicon)
      VIDEO_BACKEND="comfyui"
      VIDEO_MODEL="ltx-video-mlx"
      ;;
    nvidia)
      if command -v nvidia-smi &>/dev/null; then
        GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
        if [[ "$GPU_MEM" -ge 16000 ]]; then
          VIDEO_MODEL="wan2.1"
        else
          VIDEO_MODEL="ltx-video"
        fi
      fi
      ;;
    *)
      VIDEO_BACKEND="comfyui"
      VIDEO_MODEL="ltx-video"
      ;;
  esac
}

select_video_backend

log "Video backend: $VIDEO_BACKEND"
log "Video model: $VIDEO_MODEL"

if command -v coco_ai &>/dev/null; then
  ok "coco_ai CLI found"
else
  fail "coco_ai CLI not on PATH. Install with: npm link"
fi

# ── 1. Install video MCP ──────────────────────────────────────────
step "1. Installing video MCP"

if coco_ai mcp ls 2>/dev/null | grep -q "video"; then
  ok "video MCP already registered"
else
  log "Installing video MCP..."
  coco_ai mcp add video --yes 2>&1 | tee -a "$LOG_FILE" || fail "video MCP install failed"
  ok "video MCP installed"
fi

# Verify MCP tools
if coco_ai mcp ls video 2>/dev/null | grep -qE "text_to_video|get_job_status|export_video"; then
  ok "video MCP tools available (text_to_video, get_job_status, export_video)"
else
  warn "Could not list video MCP tools — they may need a server restart"
  warn "Run: coco_ai mcp restart video"
fi

# ── 2. Detect GPU and set environment ─────────────────────────────
step "2. Configuring video backend"

log "Exporting video environment variables..."
export VIDEO_BACKEND="${VIDEO_BACKEND}"
export VIDEO_MODEL="${VIDEO_MODEL}"
export VIDEO_LOCAL_ONLY="${VIDEO_LOCAL_ONLY:-1}"
export VIDEO_OUTPUT_DIR="${OUTPUT_DIR}"

log "VIDEO_BACKEND=$VIDEO_BACKEND"
log "VIDEO_MODEL=$VIDEO_MODEL"
log "VIDEO_OUTPUT_DIR=$OUTPUT_DIR"

# ── 3. Show text_to_video call with example prompt ────────────────
step "3. Submitting text-to-video job"

PROMPT="A sleek black product box opening with golden light rays emanating from the seams, cinematic 4K, slow motion, studio lighting, white background"
JOB_ID="demo-$(date +%s)"

log "Prompt: \"$PROMPT\""
log "Job ID: $JOB_ID"

# Show the API call format
echo "" | tee -a "$LOG_FILE"
echo "  ┌─────────────────────────────────────────────────────┐" | tee -a "$LOG_FILE"
echo "  │  text_to_video API Call:                              │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  POST /v1/video/text-to-video                          │" | tee -a "$LOG_FILE"
echo "  │  {                                                    │" | tee -a "$LOG_FILE"
echo "  │    \"prompt\": \"$PROMPT\",                       │" | tee -a "$LOG_FILE"
echo "  │    \"model\": \"$VIDEO_MODEL\",                   │" | tee -a "$LOG_FILE"
echo "  │    \"duration\": 5,                                  │" | tee -a "$LOG_FILE"
echo "  │    \"resolution\": \"720p\",                        │" | tee -a "$LOG_FILE"
echo "  │    \"fps\": 24,                                      │" | tee -a "$LOG_FILE"
echo "  │    \"seed\": 42,                                     │" | tee -a "$LOG_FILE"
echo "  │    \"style\": \"cinematic\",                        │" | tee -a "$LOG_FILE"
echo "  │    \"negative_prompt\": \"blurry, low quality\",    │" | tee -a "$LOG_FILE"
echo "  │    \"watermark\": true                               │" | tee -a "$LOG_FILE"
echo "  │  }                                                    │" | tee -a "$LOG_FILE"
echo "  │                                                       │" | tee -a "$LOG_FILE"
echo "  │  Response:                                            │" | tee -a "$LOG_FILE"
echo "  │  { \"jobId\": \"$JOB_ID\", \"status\": \"queued\" }" | tee -a "$LOG_FILE"
echo "  └─────────────────────────────────────────────────────┘" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Attempt actual API call if server is reachable
if curl -s --max-time 3 "http://localhost:7860/status" &>/dev/null || curl -s --max-time 3 "http://localhost:8080/health" &>/dev/null; then
  log "Video MCP server detected — submitting real job..."
  # Try the MCP tool call via ox
  coco_ai mcp call video text_to_video \
    --prompt "$PROMPT" \
    --model "$VIDEO_MODEL" \
    --duration 5 \
    --resolution 720p \
    --seed 42 2>&1 | tee -a "$LOG_FILE" || warn "Job submission failed — continuing with demo flow"
else
  warn "Video MCP server not running — showing demo flow"
  warn "Start it with: coco_ai mcp start video"
  log "Simulating job submission for demonstration..."
fi

# ── 4. Job queue flow: submit → poll → preview → export ──────────
step "4. Job queue flow: submit → poll → preview → export"

# SUBMIT
echo "" | tee -a "$LOG_FILE"
echo "  ━━━━ SUBMIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
log "Job submitted: $JOB_ID"
log "Status: queued"
log "Estimated time: 10-30s (GPU) / 5-15min (CPU)"

# POLL
echo "" | tee -a "$LOG_FILE"
echo "  ━━━━ POLL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
log "Polling job status every 5 seconds..."

# Simulate polling progress
for i in 1 2 3 4 5; do
  if [[ "$GPU_TYPE" == "cpu" ]]; then
    sleep 1
  else
    sleep 0.5
  fi
  PROGRESS=$(( i * 20 ))
  case $PROGRESS in
    20) STATUS="queued"; PROGRESS_TEXT="Job queued" ;;
    40) STATUS="running"; PROGRESS_TEXT="Loading model" ;;
    60) STATUS="running"; PROGRESS_TEXT="Generating frames (pass 1/2)" ;;
    80) STATUS="running"; PROGRESS_TEXT="Generating frames (pass 2/2)" ;;
    95) STATUS="running"; PROGRESS_TEXT="Encoding output" ;;
    100) STATUS="completed"; PROGRESS_TEXT="Done" ;;
  esac
  log "Poll #$i: status=$STATUS progress=$PROGRESS% — $PROGRESS_TEXT"
done

# PREVIEW
echo "" | tee -a "$LOG_FILE"
echo "  ━━━━ PREVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
VIDEO_FILE="$OUTPUT_DIR/${JOB_ID}.mp4"
PREVIEW_THUMB="$OUTPUT_DIR/${JOB_ID}-thumb.jpg"

log "Video output: $VIDEO_FILE"
log "Duration: 5 seconds"
log "Resolution: 720p"
log "Frames: 120 @ 24fps"
log "Size: ~2-8 MB (H.264)"

if [[ -f "$VIDEO_FILE" ]]; then
  ok "Preview available: $VIDEO_FILE"
  log "To preview: open $VIDEO_FILE in a video player"
else
  warn "Video file not yet generated (server not running)"
  log "Preview would show: first frame at $PREVIEW_THUMB"
fi

# Export
echo "" | tee -a "$LOG_FILE"
echo "  ━━━━ EXPORT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" | tee -a "$LOG_FILE"
log "Exporting video in multiple formats..."

# Show export options
cat << EXPORT | tee -a "$LOG_FILE"

  Available export formats:
    ┌─────────────┬──────────────────────────────────┐
    │ Format      │ Use case                          │
    ├─────────────┼──────────────────────────────────┤
    │ MP4 (H.264) │ Universal playback                │
    │ MP4 (H.265) │ Smaller file size                 │
    │ WebM        │ Web embedding                     │
    │ GIF         │ Short clips, social media         │
    │ ProRes      │ Post-production editing           │
    │ PNG sequence│ Frame-by-frame editing            │
    └─────────────┴──────────────────────────────────┘

  Export commands:
    curl -X POST localhost:8080/v1/video/export \\
      -d '{"jobId": "'$JOB_ID'", "format": "webm"}'

    coco_ai mcp call video export_video --job-id "$JOB_ID" --format webm

EXPORT

# ── 5. Re-run with seed for reproducibility ───────────────────────
step "5. Re-running with same seed for reproducibility"

log "Resubmitting with identical parameters + seed=42..."
log "This should produce a visually identical (or near-identical) video."
echo "" | tee -a "$LOG_FILE"

cat << SEED | tee -a "$LOG_FILE"

  Reproducibility via seed:
    ┌─────────────────────────────────────────────────────┐
    │  Original call:                                     │
    │    text_to_video(prompt="...", seed=42, ...)        │
    │                                                     │
    │  Re-run:                                            │
    │    text_to_video(prompt="...", seed=42, ...)        │
    │                                                     │
    │  Result: Deterministic output (given same model,    │
    │          same hardware, same backend version).       │
    │                                                     │
    │  Useful for:                                        │
    │    • A/B testing prompts                              │
    │    • Iterating on compositions                        │
    │    • CI/CD video generation pipelines                 │
    │                                                     │
    │  Note: Different GPU/driver versions may produce    │
    │    slight numerical differences despite same seed.  │
    └─────────────────────────────────────────────────────┘

SEED

log "Re-run command:"
log "  coco_ai mcp call video text_to_video \\"
log "    --prompt \"$PROMPT\" \\"
log "    --model $VIDEO_MODEL \\"
log "    --duration 5 \\"
log "    --resolution 720p \\"
log "    --seed 42"

echo "" | tee -a "$LOG_FILE"

# ── 6. Full workflow diagram ──────────────────────────────────────
step "6. Complete workflow diagram"

cat << 'WORKFLOW' | tee -a "$LOG_FILE"

  ╔═══════════════════════════════════════════════════════════╗
  ║          Video Generation Job Queue Flow                   ║
  ╠═══════════════════════════════════════════════════════════╣
  ║                                                           ║
  ║  ┌─────────┐    ┌──────────┐    ┌──────────┐            ║
  ║  │ PROMPT  │───▶│  SUBMIT  │───▶│  QUEUE   │            ║
  ║  │ "A sleek│    │ text_to_ │    │  Job #42 │            ║
  ║  │  box..."│    │ video()  │    │          │            ║
  ║  └─────────┘    └──────────┘    └────┬─────┘            ║
  ║                                       │                   ║
  ║                                       ▼                   ║
  ║  ┌─────────┐    ┌──────────┐    ┌──────────┐            ║
  ║  │ EXPORT  │◀───│ PREVIEW  │◀───│  RUN     │            ║
  ║  │  MP4    │    │  thumb   │    │  model   │            ║
  ║  │  WebM   │    │  frames  │    │  10-30s  │            ║
  ║  │  GIF    │    │  720p    │    │          │            ║
  ║  └─────────┘    └──────────┘    └──────────┘            ║
  ║                                                           ║
  ║  Optional: Re-run with same seed → identical output       ║
  ║                                                           ║
  ╚═══════════════════════════════════════════════════════════╝

WORKFLOW

# ── 7. Next steps ─────────────────────────────────────────────────
step "7. Next steps"

echo "" | tee -a "$LOG_FILE"
echo "  ── Video setup for ox ──" | tee -a "$LOG_FILE"
echo "  • Backend:       export VIDEO_BACKEND=$VIDEO_BACKEND" | tee -a "$LOG_FILE"
echo "  • Model:         export VIDEO_MODEL=$VIDEO_MODEL" | tee -a "$LOG_FILE"
echo "  • Output dir:    export VIDEO_OUTPUT_DIR=$OUTPUT_DIR" | tee -a "$LOG_FILE"
echo "  • Start server:  $VIDEO_DIR/../video-mcp-server --port 8080" | tee -a "$LOG_FILE"
echo "  • Start ComfyUI: $VIDEO_DIR/models/ComfyUI/venv/bin/python" | tee -a "$LOG_FILE"
echo "    $VIDEO_DIR/models/ComfyUI/main.py --listen --port 7860" | tee -a "$LOG_FILE"
echo "  • Generate video: ox -p 'generate a 5-second video of a product'" | tee -a "$LOG_FILE"
echo "  • Full log:       $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

ok "Video generation demo complete!"