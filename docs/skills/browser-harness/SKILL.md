---
name: browser-harness
description: Browser automation via browser-use/browser-harness MCP. Use for web interaction, scraping, testing.
author: ox
version: 1.0.0
metadata:
  category: automation
  trigger: command
---

# Browser Harness

Browser automation through the `browser-use/browser-harness` MCP server. Enables
web interaction, scraping, and testing from any MCP-capable agent (ox, Claude,
Kilo, etc.).

## Installation

### Prerequisites

- Node.js >= 18
- Python 3.10+ (for `browser-use`)
- Chrome/Chromium installed

### Step 1 — Install browser-harness MCP

```bash
# Via pip (Python package)
pip install browser-harness-mcp

# Or via npx (Node wrapper)
npm install -g browser-harness-mcp
```

### Step 2 — Register with ox agent

Add to your ox MCP config (`~/.config/ox/mcp.json` or `kilo.json`):

```json
{
  "mcpServers": {
    "browser-harness": {
      "command": "npx",
      "args": ["browser-harness-mcp"],
      "env": {
        "BROWSER_PATH": "/usr/bin/google-chrome",
        "HEADLESS": "true"
      }
    }
  }
}
```

### Step 3 — Verify

```bash
ox mcp list
# browser-harness — registered, ready
```

## Available Tools

| Tool | Description |
|---|---|
| `browser_navigate(url)` | Navigate to a URL |
| `browser_screenshot(path?)` | Take a screenshot of current page |
| `browser_click(selector)` | Click an element by CSS selector |
| `browser_fill(selector, text)` | Fill a form field |
| `browser_evaluate(script)` | Execute JavaScript in page context |
| `browser_extract(selector?)` | Extract text/content from elements |
| `browser_links()` | List all links on the page |
| `browser_forms()` | List all forms and their fields |
| `browser_pdf(path)` | Save current page as PDF |
| `browser_close()` | Close the browser session |

## Usage Patterns

### Web Scraping

```js
const page = await tools.browser_navigate('https://example.com');
const links = await tools.browser_links();
const content = await tools.browser_extract('article');
await tools.browser_pdf('output.pdf');
await tools.browser_close();
```

### Form Automation

```js
await tools.browser_navigate('https://example.com/login');
await tools.browser_fill('#username', 'myuser');
await tools.browser_fill('#password', 'secret');
await tools.browser_click('button[type="submit"]');
await tools.browser_screenshot('after-login.png');
```

### Testing

```js
await tools.browser_navigate('http://localhost:3000');
await tools.browser_evaluate('document.title');
const result = await tools.browser_evaluate(
  'document.querySelector(".status").textContent'
);
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BROWSER_PATH` | `auto` | Path to Chrome/Chromium binary |
| `HEADLESS` | `true` | Run browser in headless mode |
| `BROWSER_TIMEOUT` | `30000` | Page load timeout in ms |
| `USER_DATA_DIR` | `default` | Browser profile directory |
| `BROWSER_NO_SANDBOX` | `true` | Disable Chrome sandbox |

## Advanced Configuration

For persistent browser sessions, set a custom `USER_DATA_DIR`:

```json
{
  "mcpServers": {
    "browser-harness": {
      "command": "npx",
      "args": ["browser-harness-mcp"],
      "env": {
        "HEADLESS": "false",
        "USER_DATA_DIR": "/tmp/ox-browser-profile"
      }
    }
  }
}
```

## Troubleshooting

### Chrome not found
Install Chromium:
```bash
npx puppeteer browsers install chrome
```

### Sandbox errors
Set `BROWSER_NO_SANDBOX=true` (default for non-root containers).

### Session timeouts
Increase `BROWSER_TIMEOUT` to 60000+ for slow sites.

## References

- [browser-use project](https://github.com/browser-use/browser-use)
- [MCP server spec](https://spec.modelcontextprotocol.io/)
- [browser-harness docs](https://browser-harness.com)
