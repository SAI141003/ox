#!/usr/bin/env bash
# ox setup — one command to install and verify everything
# Usage: curl -fsSL https://raw.githubusercontent.com/<YOUR_ORG>/ox/main/ox-setup.sh | bash
# Or:    bash ox-setup.sh
# Env:   OX_REPO=https://github.com/<YOUR_ORG>/ox.git  (override clone URL)
#        OPENROUTER_API_KEY=sk-or-...                 (provide key non-interactively)

set -euo pipefail

OX_DIR="${OX_DIR:-$HOME/ox}"
OX_REPO="${OX_REPO:-https://github.com/<YOUR_ORG>/ox.git}"

echo "=== ox setup ==="
echo ""

# 1. Check Node
if ! command -v node &>/dev/null; then
  echo "Node.js not found. Installing..."
  if command -v brew &>/dev/null; then
    brew install node
  else
    curl -fsSL https://nodejs.org/install.sh | bash
  fi
fi
echo "Node: $(node --version)"

# 2. Clone or update
if [ ! -d "$OX_DIR" ]; then
  echo "Cloning ox to $OX_DIR..."
  git clone "$OX_REPO" "$OX_DIR"
fi
cd "$OX_DIR"

# Logo — best effort, never let a missing/broken logo abort setup. This must
# come after the cd: a relative ./src/logo.js resolves against the invocation
# CWD, not the repo, and silently no-ops under `curl | bash`.
node -e "import('$OX_DIR/src/logo.js').then(m=>console.log(m.banner({version:'0.1.0'})))" 2>/dev/null || true

# 3. Get OpenRouter API key
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo ""
  echo "OpenRouter API key not set in environment."
  read -rsp "Enter OPENROUTER_API_KEY (input hidden): " OPENROUTER_API_KEY
  echo ""
fi

if [ -z "$OPENROUTER_API_KEY" ]; then
  echo "Warning: No OpenRouter API key provided. Some features will not work."
else
  export OPENROUTER_API_KEY
  # Ask before writing to shell RC
  SHELL_RC="$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && [ ! -f "$SHELL_RC" ] && SHELL_RC="$HOME/.bashrc"
  read -rp "Add OPENROUTER_API_KEY to $SHELL_RC? [y/N] " -n 1 REPLY
  echo ""
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    if ! grep -q "OPENROUTER_API_KEY" "$SHELL_RC" 2>/dev/null; then
      echo "export OPENROUTER_API_KEY=$OPENROUTER_API_KEY" >> "$SHELL_RC"
      echo "Added to $SHELL_RC"
    else
      echo "OPENROUTER_API_KEY already present in $SHELL_RC"
    fi
  fi
fi

# Probe helper. Every network-backed check below runs through it: under
# `set -euo pipefail` a failed model call would abort the whole script, so a
# missing key, a rate limit, or an offline machine would leave a fresh user with
# no ready banner at all. A failing probe warns and setup continues to
# `=== ox is ready ===`.
probe() {
  local label="$1"
  shift
  if ! "$@" 2>&1 | grep -v "tool offer"; then
    echo "  (${label} probe failed — set that provider's API key and re-run; continuing setup)"
  fi
}

# 4. Verify
echo ""
echo "=== Verification ==="
echo "ox version: $(node bin/ox.js --version 2>&1 || echo '(unavailable)')"
echo "ox bots:    $(node bin/ox.js bots 2>&1 | head -1 || echo '(unavailable)')"

# 5. Test OpenRouter — only the part before the colon is the bot name.
echo ""
echo "Testing OpenRouter..."
probe openrouter node bin/ox.js --bot ox-openrouter:meta-llama/llama-3.3-70b-instruct -p "say hi in one word" --yes-edits

# 6. Local model discovery -- REPORT ONLY. This used to send a real prompt to
# whatever answered on 11434 as a side effect of installation. That is an
# unapproved send: nothing asked the user, and a process impersonating Ollama
# would receive the prompt. `ox local` now requires an explicit approval, and a
# non-interactive run never prompts and never connects, so we only tell the
# user what is there and how to approve it.
echo ""
echo "Local models:"
node bin/ox.js local --no-prompt 2>&1 || echo "  (local discovery failed — continuing setup)"
echo ""
echo "  To send prompts to a local model, run:  cd $OX_DIR && node bin/ox.js local"
echo "  (it shows the endpoint, its models and what approving means, then asks once)"

# 7. Test operator tools
echo ""
echo "Testing operator tools..."
node bin/ox.js -p "open https://example.com" --yes-edits 2>&1 | grep -E "(open_url|opened|done)" || echo "  (no tool activity — approval gate or provider error; continuing)"

echo ""
echo "=== ox is ready ==="
echo ""
echo "Run ox with:"
echo "  cd $OX_DIR"
echo "  node bin/ox.js                    # interactive REPL"
echo "  node bin/ox.js -p \"your task\"     # headless"
echo "  node bin/ox.js --bot ox-claude     # switch bot"
echo ""
echo "Add API keys:"
echo "  export XAI_API_KEY=xai-..."
echo "  export ANTHROPIC_API_KEY=sk-ant-..."
echo "  export OPENAI_API_KEY=sk-..."
echo "  export GEMINI_API_KEY=AIza..."
echo "  export GROQ_API_KEY=gsk_..."
echo "  export DEEPSEEK_API_KEY=sk-..."
echo ""
echo "Benchmark:"
echo "  node bench/runner.mjs              # deterministic (no key needed)"
echo "  node bench/runner.mjs --live      # live (needs API key)"
