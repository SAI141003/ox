---
name: backboard
description: Backboard.io platform integration. Use for model routing, memory bridge, R-CLI coexistence.
author: ox
version: 1.0.0
metadata:
  category: infrastructure
  trigger: command
---

# Backboard

Integration with the [Backboard.io](https://backboard.io) platform for model
routing, memory bridging, and seamless coexistence between R-CLI and ox
agent workflows.

## Installation

### Prerequisites

- ox platform installed
- Backboard.io API key ([dashboard](https://backboard.io/app))
- Node.js >= 18

### Step 1 — Install Backboard MCP adapter

```bash
npm install -g @backboard/mcp-adapter
```

### Step 2 — Configure with ox

Add to `~/.config/ox/mcp.json`:

```json
{
  "mcpServers": {
    "backboard": {
      "command": "npx",
      "args": ["@backboard/mcp-adapter"],
      "env": {
        "BACKBOARD_API_KEY": "your-api-key",
        "BACKBOARD_ENDPOINT": "https://api.backboard.io"
      }
    }
  }
}
```

### Step 3 — Enable R-CLI coexistence

For projects that also use R-CLI, configure the shared memory bridge:

```bash
# In your project root
backboard init --adapter ox
```

This creates `.backboard/config.json`:

```json
{
  "adapters": {
    "ox": {
      "type": "mcp",
      "memory_path": ".backboard/memory.db"
    },
    "r-cli": {
      "type": "native",
      "memory_path": ".backboard/memory.db"
    }
  },
  "routing": {
    "default_model": "gpt-4o",
    "fallback_chain": ["gpt-4o", "gpt-4o-mini", "claude-3-haiku"]
  }
}
```

### Step 4 — Verify

```bash
ox mcp list
# backboard — registered, connected

backboard status
# Model: gpt-4o | Memory: connected | R-CLI: synced
```

## Available Tools

| Tool | Description |
|---|---|
| `backboard_route(prompt, opts?)` | Route a prompt through smart model fallback |
| `backboard_memory_read(key)` | Read from shared memory store |
| `backboard_memory_write(key, value)` | Write to shared memory store |
| `backboard_memory_context()` | Get current conversation context |
| `backboard_models()` | List available models and their status |
| `backboard_rcli_sync()` | Sync state with R-CLI workspace |
| `backboard_stats()` | Get usage stats and routing decisions |
| `backboard_config()` | Get current Backboard configuration |

## Usage Examples

### Smart Model Routing

```js
const response = await tools.backboard_route({
  prompt: "Explain quantum computing in simple terms",
  max_tokens: 500,
  temperature: 0.7
});

// Backboard auto-selects the best model based on cost/latency
// falls back to cheaper models if primary is unavailable
```

### Shared Memory Bridge

```js
// ox agent writes context
await tools.backboard_memory_write({
  key: "project.context",
  value: {
    goal: "build a landing page",
    tech_stack: "Next.js 15",
    design_system: "shadcn/ui"
  }
});

// Later, read it back
const ctx = await tools.backboard_memory_read("project.context");
console.log(ctx.value.goal); // "build a landing page"

// R-CLI can access the same memory:
// R> backboard::memory_read("project.context")
```

### R-CLI Coexistence

```js
// Sync with R-CLI state before starting work
await tools.backboard_rcli_sync();

const rState = await tools.backboard_memory_context();
// Now we have the full conversation history from both tools

// Continue the conversation in ox
const response = await tools.backboard_route({
  prompt: "Continue from where @r-cli left off — summarize the analysis",
  context: rState
});
```

### Model Health Check

```js
const models = await tools.backboard_models();
console.log(models.map(m => `${m.name}: ${m.status} (${m.latency}ms)`));
// openai/gpt-4o: healthy (120ms)
// openai/gpt-4o-mini: healthy (85ms)
// anthropic/claude-3-5-sonnet: degraded (340ms)
// google/gemini-1.5-flash: healthy (95ms)
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BACKBOARD_API_KEY` | — | Backboard.io API key (required) |
| `BACKBOARD_ENDPOINT` | `https://api.backboard.io` | API endpoint URL |
| `BACKBOARD_TEAM_ID` | — | Team/workspace ID (optional) |
| `BACKBOARD_ROUTING_STRATEGY` | `cost-optimized` | Routing: `cost-optimized`, `latency`, `quality` |
| `BACKBOARD_FALLBACK_ENABLED` | `true` | Enable model fallback chain |
| `BACKBOARD_MEMORY_TTL` | `3600` | Memory entry TTL in seconds |
| `BACKBOARD_RCLI_SYNC` | `true` | Enable R-CLI memory sync |

## Routing Strategies

| Strategy | Behavior |
|---|---|
| `cost-optimized` | Pick cheapest model that can handle the task |
| `latency` | Pick the fastest available model |
| `quality` | Always pick the highest-tier model available |
| `custom` | Use the fallback chain defined in `.backboard/config.json` |

## Troubleshooting

### `BACKBOARD_API_KEY not set`
Set the variable in your environment or in the ox MCP config.

### R-CLI sync not working
- Ensure both tools share the same `.backboard/` directory
- Run `backboard rcli-connect` to establish the sync bridge
- Check that `BACKBOARD_RCLI_SYNC=true`

### Model routing always falls back
- Check model health: `backboard models`
- Verify API keys for all providers are configured in Backboard dashboard
- Increase timeout: `BACKBOARD_TIMEOUT=60000`

## References

- [Backboard.io documentation](https://backboard.io/docs)
- [Backboard MCP adapter](https://github.com/backboard/mcp-adapter)
- [R-CLI integration guide](https://backboard.io/docs/r-cli)
