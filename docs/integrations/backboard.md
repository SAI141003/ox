# Backboard.io Integration

**Sovereign AI Infrastructure Coexistence** — Backboard.io provides model routing, persistent memory/state, RAG, embeddings, tool calling, multi-agent, and adaptive context via its Platform API. ox is the rug-proof local agent; Backboard is the infra/platform with a CLI wedge (R-CLI). They coexist on the same task.

## Overview

Backboard.io (backboard.io) — Ottawa-based, founders Rob Imbeault/Jonathan Murray, pre-seed from Mistral VP et al. Products:
- **Backboard Platform API**: Model routing, persistent memory/state, RAG, embeddings, tool calling, multi-agent, adaptive context
- **R-CLI**: Open coding harness
- **Backboard Studio**: Visual interface
- **Deploy modes**: Cloud / private cloud / on-prem / on-device
- **Pricing**: Free / Education $5 / Developer $20 / Scale $400 + usage

ox never sends approvals, denylist, or evidence-gated memory to any cloud. Backboard is an optional provider endpoint, not a dependency.

## Integration Paths

### 1. Provider/Preset (Recommended)

Use Backboard as an OpenAI-compatible endpoint via `OX_BASE_URL` or the `backboard` bot preset.

```bash
# Option A: Environment variable
export OX_BASE_URL=https://api.backboard.io/v1
export BACKBOARD_API_KEY=bb_live_xxx...
export OX_MODEL=backboard-routing
ox -p "refactor the auth module"

# Option B: Bot preset (auto-configures base URL)
ox --bot backboard -p "refactor the auth module"

# Option C: Save as named agent preset
ox agent save backboard --provider backboard --model backboard-routing --base-url https://api.backboard.io/v1
ox agent use backboard
```

### 2. R-CLI Coexistence

When to use Backboard R-CLI vs ox:
- **Use ox**: Local agentic loop, verified edits, honest economics, zero telemetry, sub-150ms cold start
- **Use Backboard R-CLI**: Multi-model routing at scale, team/shared memory, cloud/on-device deployment modes
- **Both**: Backboard for routing + ox for the agentic loop (Backboard as provider, ox as the agent)

### 3. Memory Bridge (Optional)

Export/import portable memory without cloud lock-in:

```bash
# Export ox episodic memory to JSONL
ox episode ls --json > ox-memory.jsonl

# Transform for Backboard import (if schema compatible)
ox skill add docs/skills/backboard  # includes memory bridge helpers
```

### 4. MCP Template (Read-Only)

```bash
ox mcp add backboard
# Adds read-only HTTP MCP endpoint at https://backboard.io/mcp
# Query platform state, inspect routing, no writes to platform
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BACKBOARD_API_KEY` | Yes | API key from Backboard dashboard |
| `OX_BASE_URL` | For preset | Set to `https://api.backboard.io/v1` |
| `OX_MODEL` | For preset | Set to `backboard-routing` |

Add to `.env.local` (never commit):
```bash
BACKBOARD_API_KEY=bb_live_xxx...
OX_BASE_URL=https://api.backboard.io/v1
OX_MODEL=backboard-routing
```

### Agent Preset

```bash
ox agent save backboard \
  --provider backboard \
  --model backboard-routing \
  --base-url https://api.backboard.io/v1 \
  --key-env BACKBOARD_API_KEY
```

Then:
```bash
ox agent use backboard
ox -p "your prompt"
```

## What ox Will NEVER Outsource to Backboard

The following are **core ox responsibilities** and will never be delegated:

1. **Code Execution & Runtime** — ox never sends source code to Backboard for execution
2. **Authentication & Authorization** — User identity stays in your auth system
3. **Database & Data Layer** — Zero database credentials ever shared
4. **Secret Management** — API keys, tokens, certificates never leave your infrastructure
5. **Business Logic** — Domain logic, validation rules, workflows stay in your codebase
6. **Deployment & Infrastructure** — No deployment triggers, no IaC sync
7. **Testing Execution** — Unit/integration/e2e tests run in your CI
8. **Real-time Data Processing** — WebSocket connections, event streams stay local
9. **Approvals & Denylist** — ox's approval gate and denylist are local-only
10. **Evidence-Gated Memory** — ox's verification-before-storage is local
11. **Telemetry-Free Operation** — ox builds no analytics/telemetry; Backboard is opt-in

## Limits & Quotas (Backboard Platform)

| Resource | Free | Education $5 | Developer $20 | Scale $400+ |
|----------|------|--------------|---------------|-------------|
| Projects | 3 | 10 | 25 | Unlimited |
| Memory retention | 7 days | 30 days | 1 year | 7 years |
| Model routing calls/day | 1,000 | 10,000 | 100,000 | 1M+ |
| RAG queries/day | 100 | 1,000 | 10,000 | 100,000 |
| Concurrent agents | 1 | 2 | 5 | 20 |

### Rate Limits
- API: 60 requests/minute (burst: 120)
- Webhooks: 100 deliveries/minute

## Setup Verification

```bash
# Verify bot preset resolves
ox --bot backboard --version

# Test model routing
ox --bot backboard -p "echo hello" --json

# Check agent preset
ox agent list
ox agent use backboard
```

## Support

- Backboard.io Docs: https://docs.backboard.io
- Backboard Platform API: https://api.backboard.io
- ox Backboard Issues: https://github.com/ox/ox/issues?q=label:backboard
- R-CLI: https://github.com/backboard/r-cli