---
name: camoufox
description: Anti-detect browser profile for MCP. Use with browser-harness for stealth automation.
author: ox
version: 1.0.0
metadata:
  category: automation
  trigger: command
---

# Camoufox

Anti-detect browser profile for MCP-based browser automation. Uses [Camoufox](https://camoufox.com)
to generate realistic browser fingerprints, bypass detection, and provide
stealth automation when paired with browser-harness or stagehand.

## Installation

### Prerequisites

- browser-harness or stagehand MCP server installed
- Node.js >= 18
- Docker (optional, for containerized profiles)

### Step 1 — Install Camoufox MCP server

```bash
npm install -g @camoufox/mcp-server
```

Or via pip:

```bash
pip install camoufox-mcp
```

### Step 2 — Configure with browser-harness

Add Camoufox as a profile provider in `~/.config/ox/mcp.json`:

```json
{
  "mcpServers": {
    "camoufox": {
      "command": "npx",
      "args": ["@camoufox/mcp-server"],
      "env": {
        "CAMOUFOX_MODE": "stealth",
        "CAMOUFOX_RANDOMIZE": "true"
      }
    },
    "browser-harness": {
      "command": "npx",
      "args": ["browser-harness-mcp"],
      "env": {
        "BROWSER_PROFILE": "{{camoufox.profile_path}}"
      }
    }
  }
}
```

### Step 3 — Start Camoufox and generate a profile

```bash
# Start the Camoufox MCP server
npx @camoufox/mcp-server &

# In ox, generate a new stealth profile
const profile = await tools.camoufox_create_profile({
  fingerprint: "chrome-120",
  os: "macos",
  randomize_canvas: true,
  randomize_webgl: true
});
```

### Step 4 — Launch browser-harness with the profile

```js
await tools.browser_harness_launch({
  profile_path: profile.profile_path,
  headless: false
});
```

## Available Tools

| Tool | Description |
|---|---|
| `camoufox_create_profile(opts)` | Create a new anti-detect browser profile |
| `camoufox_list_profiles()` | List existing profiles |
| `camoufox_delete_profile(name)` | Delete a profile by name |
| `camoufox_fingerprints()` | List available fingerprint templates |
| `camoufox_proxy_set(profile, proxyUrl)` | Assign a proxy to a profile |
| `camoufox_headers_get(profile)` | Get HTTP headers for a profile |
| `camoufox_cookies_export(profile, domain?)` | Export cookies from a profile |
| `camoufox_cookies_import(profile, cookies)` | Import cookies into a profile |
| `camoufox_rotate_profile(profile)` | Regenerate fingerprint for a profile |
| `camoufox_detect(profile)` | Run detection tests (are we detected?) |

## Usage Patterns

### Basic Stealth Setup

```js
// 1. Create a stealth profile
const profile = await tools.camoufox_create_profile({
  fingerprint: "chrome-120",
  os: "windows",
  locale: "en-US",
  timezone: "America/New_York",
  screen_resolution: "1920x1080"
});

// 2. Launch browser-harness with this profile
await tools.browser_harness_launch({
  profile_path: profile.profile_path,
  headless: false,
  no_sandbox: true
});

// 3. Verify we're not detected
const detection = await tools.camoufox_detect({
  profile_path: profile.profile_path
});
console.log("Detected:", detection.is_detected); // false
```

### Rotating Profiles for Scraping

```js
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
];

for (const ua of userAgents) {
  const profile = await tools.camoufox_create_profile({
    user_agent: ua,
    randomize_all: true
  });

  await tools.browser_harness_launch({
    profile_path: profile.profile_path,
    headless: true
  });

  await tools.browser_navigate("https://example.com");
  await tools.browser_screenshot(`scrape-${ua.slice(0, 20)}.png`);
  await tools.browser_close();
}
```

### Proxy Rotation with Camoufox

```js
const proxies = [
  "http://user:pass@proxy1.example.com:8080",
  "http://user:pass@proxy2.example.com:8080",
];

for (const proxy of proxies) {
  const profile = await tools.camoufox_create_profile({
    fingerprint: "chrome-120",
    randomize_all: true
  });

  await tools.camoufox_proxy_set({
    profile: profile.profile_path,
    proxy_url: proxy
  });

  // Browser will now route through the proxy with anti-detect
  await tools.browser_harness_launch({
    profile_path: profile.profile_path,
    headless: true
  });

  await tools.browser_navigate("https://ipinfo.io");
  await tools.browser_close();
}
```

## Fingerprint Templates

Camoufox supports these template engines:

| Engine | Fingerprints Available |
|---|---|
| Chrome | 100–120 (Windows, macOS, Linux) |
| Firefox | 110–125 (Windows, macOS, Linux) |
| Safari | 16–17 (macOS) |
| Edge | 110–120 (Windows) |
| Mobile | iOS Safari, Chrome Android |

## Detection Tests

Camoufox includes built-in tests to verify anti-detect effectiveness:

```js
const result = await tools.camoufox_detect({
  profile_path: "/path/to/profile",
  tests: ["webgl", "canvas", "font", "plugins", "languages", "headless"]
});

// {
//   "is_detected": false,
//   "tests": {
//     "webgl": "passed",
//     "canvas": "passed",
//     "font": "passed",
//     "plugins": "passed",
//     "languages": "passed",
//     "headless": "passed"
//   }
// }
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CAMOUFOX_MODE` | `standard` | Profile mode: `standard`, `stealth`, `paranoid` |
| `CAMOUFOX_RANDOMIZE` | `true` | Randomize fingerprints on profile creation |
| `CAMOUFOX_PROFILE_DIR` | `./.camoufox/profiles` | Root directory for profiles |
| `CAMOUFOX_HEADLESS_DESPAIR` | `true` | Override headless detection |
| `CAMOUFOX_DISABLE_WEBDRIVER` | `true` | Remove `webdriver` property |

## Profile Modes

| Mode | Description |
|---|---|
| `standard` | Basic fingerprint randomization |
| `stealth` | Full anti-detect: overrides `navigator`, `plugins`, `languages`, `webdriver` |
| `paranoid` | Maximum stealth: also patches canvas, WebGL, fonts, and timing APIs |

## Troubleshooting

### Browser detected despite profile
- Use `stealth` or `paranoid` mode: `CAMOUFOX_MODE=paranoid`
- Ensure browser-harness uses the same profile path
- Run detection tests: `tools.camoufox_detect()`

### Profile creation fails
- Check write permissions on `CAMOUFOX_PROFILE_DIR`
- Ensure enough disk space (profiles are ~50MB each)
- Try Docker mode: `CAMOUFOX_DOCKER=true`

### Proxy not working
- Verify proxy URL format: `http://user:pass@host:port`
- Ensure proxy supports HTTPS CONNECT
- Check `tools.camoufox_headers_get()` to verify headers

## References

- [Camoufox documentation](https://camoufox.com/docs)
- [browser-harness integration](docs/skills/browser-harness/SKILL.md)
- [Camoufox GitHub](https://github.com/camoufox/camoufox)
