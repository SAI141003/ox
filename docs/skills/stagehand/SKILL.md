---
name: stagehand
description: Browser automation via Browserbase Stagehand MCP. Use for act/observe/extract/agent browser primitives.
author: ox
version: 1.0.0
metadata:
  category: automation
  trigger: command
---

# Stagehand

Browser automation through the **Browserbase Stagehand** MCP server. Provides
four core primitives — `act`, `observe`, `extract`, and `agent` — for
declarative, AI-powered web interaction.

## Installation

### Prerequisites

- Node.js >= 18
- A Browserbase API key ([sign up](https://browserbase.com))
- An ox/Kilo agent with MCP support

### Step 1 — Install the Stagehand MCP server

```bash
npm install -g @browserbase/stagehand-mcp
```

### Step 2 — Configure with ox

Add to `~/.config/ox/mcp.json`:

```json
{
  "mcpServers": {
    "stagehand": {
      "command": "npx",
      "args": ["@browserbase/stagehand-mcp"],
      "env": {
        "BROWSERBASE_API_KEY": "your-api-key-here",
        "BROWSERBASE_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

Or set env vars in your shell profile:

```bash
export BROWSERBASE_API_KEY="bs_..."
export BROWSERBASE_PROJECT_ID="c1e..."
```

### Step 3 — Verify

```bash
ox mcp list
# stagehand — registered, ready
```

## The Four Primitives

### act — Perform an action

Execute a user-described action using AI. Stagehand figures out the best way.

```js
await tools.stagehand_act({
  action: "Click the 'Sign In' button"
});

await tools.stagehand_act({
  action: "Fill in the email field with user@example.com"
});
```

### observe — Inspect the page

Get structured information about the current page state.

```js
const observation = await tools.stagehand_observe({
  query: "What is the current page title and URL?"
});
console.log(observation.result);
```

### extract — Pull structured data

Extract specific information following a schema.

```js
const data = await tools.stagehand_extract({
  prompt: "Extract all product names and prices from this page",
  schema: {
    products: [{ name: "string", price: "string" }]
  }
});
```

### agent — Autonomous browsing session

Run a full AI agent loop to achieve a goal.

```js
const result = await tools.stagehand_agent({
  task: "Search for red sneakers on Amazon and add the first result to cart"
});
```

## Usage Examples

### Web Scraping with Extract

```js
// 1. Navigate to page
await tools.stagehand_act({
  action: "Go to https://news.ycombinator.com"
});

// 2. Extract structured data
const posts = await tools.stagehand_extract({
  prompt: "Extract all story titles, URLs, and point counts",
  schema: {
    stories: [{
      title: "string",
      url: "string",
      points: "number"
    }]
  }
});

console.log(posts.stories);
```

### Form Filling with Act

```js
await tools.stagehand_agent({
  task: "Log into https://github.com with username 'octocat' and password 'secret', then navigate to the settings page"
});
```

### Testing Workflow

```js
// Start a new session
await tools.stagehand_act({ action: "Go to http://localhost:3000" });

// Verify page loaded
const title = await tools.stagehand_observe({
  query: "What is the page title?"
});

// Check for specific element
await tools.stagehand_act({
  action: "Verify that a 'Sign Up' button is visible"
});

// Close session
await tools.stagehand_act({ action: "Close the browser" });
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BROWSERBASE_API_KEY` | — | Your Browserbase API key (required) |
| `BROWSERBASE_PROJECT_ID` | — | Your Browserbase project ID (required) |
| `BROWSERBASE_TIMEOUT` | `120000` | Session timeout in ms |
| `BROWSERBASE_HEADLESS` | `true` | Run browser in headless mode |
| `BROWSERBASE_CONCURRENCY` | `3` | Max parallel sessions |

## Stagehand Config Options

| Option | Default | Description |
|---|---|---|
| `modelName` | `gpt-4o-mini` | LLM model for act/observe |
| `stream` | `false` | Stream LLM responses |
| `verbose` | `0` | Logging level (0-3) |
| `domSettleTimeout` | `0` | Wait for DOM settle (ms) |
| `logger` | — | Custom logger object |

## Troubleshooting

### `BROWSERBASE_API_KEY not set`
Ensure the environment variable is set before starting the MCP server.

### Session timeout
Browserbase sessions auto-terminate after 15 minutes of inactivity by default.
Adjust via `BROWSERBASE_TIMEOUT`.

### Page not found / navigation errors
Stagehand's `act` uses AI to interpret instructions — be specific and include
full URLs. Ambiguous navigation ("go to sign in") may fail.

## References

- [Stagehand documentation](https://docs.browserbase.com)
- [Browserbase console](https://browserbase.com/console)
- [Stagehand GitHub](https://github.com/browserbase/stagehand)
