# Browser Automation Integration

Unified browser automation layer supporting multiple backends: browser-harness, Stagehand, Camoufox, and Trawl.

## Overview

The browser integration provides a single API for:
- Headless browser control
- AI-powered web interactions (Stagehand)
- Stealth/anti-detection browsing (Camoufox)
- Large-scale crawling (Trawl)

## Architecture

```
ox browser
├── browser-harness (default) - Core browser management
├── stagehand              - AI-driven interactions
├── camoufox               - Stealth Firefox builds
└── trawl                  - Distributed crawling
```

## Setup

### Prerequisites
- Node.js 20+ or Bun 1.1+
- Docker (for Camoufox/Trawl)
- Playwright browsers: `npx playwright install`

### Installation

```bash
# Core (browser-harness)
ox integrations add browser

# With AI backend (Stagehand)
ox integrations add browser --backend stagehand

# With stealth (Camoufox)
ox integrations add browser --backend camoufox

# With distributed crawling (Trawl)
ox integrations add browser --backend trawl

# All backends
ox integrations add browser --all
```

### Configuration

Create `.ox/browser.json`:

```json
{
  "defaultBackend": "browser-harness",
  "backends": {
    "browser-harness": {
      "browser": "chromium",
      "headless": true,
      "viewport": { "width": 1280, "height": 720 },
      "timeout": 30000,
      "args": ["--disable-blink-features=AutomationControlled"]
    },
    "stagehand": {
      "model": "gpt-4o",
      "apiKey": "${STAGEHAND_API_KEY}",
      "domStrategy": "accessibility",
      "verbose": 1
    },
    "camoufox": {
      "image": "ghcr.io/daijro/camoufox:latest",
      "headless": true,
      "fingerprint": "auto",
      "geoip": "US",
      "languages": ["en-US", "en"]
    },
    "trawl": {
      "coordinator": "http://localhost:8080",
      "workers": 4,
      "maxDepth": 3,
      "respectRobotsTxt": true,
      "rateLimit": 10
    }
  },
  "shared": {
    "downloadsDir": "./downloads",
    "screenshotsDir": "./screenshots",
    "tracesDir": "./traces",
    "recordVideo": "on-failure"
  }
}
```

### Environment Variables

| Variable | Backend | Required | Description |
|----------|---------|----------|-------------|
| `STAGEHAND_API_KEY` | Stagehand | Yes | OpenAI-compatible API key |
| `STAGEHAND_MODEL` | Stagehand | No | Model override (default: gpt-4o) |
| `CAMOUFOX_IMAGE` | Camoufox | No | Docker image override |
| `TRAWL_COORDINATOR` | Trawl | Yes | Coordinator URL |
| `PLAYWRIGHT_BROWSERS_PATH` | All | No | Custom browser install path |

## Usage

### Basic Navigation (browser-harness)

```typescript
import { browser } from 'ox/browser';

const page = await browser.newPage();
await page.goto('https://example.com');
await page.waitForSelector('h1');
const title = await page.title();
await page.screenshot({ path: 'example.png' });
await page.close();
```

### AI-Powered Interactions (Stagehand)

```typescript
import { stagehand } from 'ox/browser/backends/stagehand';

const page = await stagehand.newPage();
await page.goto('https://github.com');

// Natural language actions
await page.act('Click the "Sign in" button');
await page.act('Fill in the email field with "user@example.com"');
await page.act('Fill in the password field with "secret"');
await page.act('Click the "Sign in" button');

// Extract structured data
const repos = await page.extract({
  instruction: 'Get all repository names and descriptions',
  schema: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    stars: z.number()
  }))
});
```

### Stealth Browsing (Camoufox)

```typescript
import { camoufox } from 'ox/browser/backends/camoufox';

const page = await camoufox.newPage({
  fingerprint: 'chrome-win10',  // or 'auto', 'firefox-linux', 'safari-mac'
  geoip: 'DE',
  languages: ['de-DE', 'de', 'en-US', 'en']
});

await page.goto('https://bot.sannysoft.com/');
// Passes fingerprinting checks
const result = await page.evaluate(() => window.navigator.userAgent);
```

### Distributed Crawling (Trawl)

```typescript
import { trawl } from 'ox/browser/backends/trawl';

const crawler = await trawl.createCrawler({
  startUrls: ['https://docs.example.com'],
  maxPages: 1000,
  maxDepth: 3,
  allowedDomains: ['example.com'],
  extractors: [
    {
      name: 'article',
      selector: 'article, main, .content',
      fields: {
        title: 'h1',
        content: 'text',
        links: { selector: 'a', attr: 'href', multiple: true }
      }
    }
  ]
});

const results = await crawler.run();
await crawler.export({ format: 'jsonl', output: './crawl-results.jsonl' });
```

## CLI Commands

```bash
# Launch interactive browser
ox browser open https://example.com

# Run script with specific backend
ox browser run script.ts --backend stagehand

# Record trace
ox browser trace script.ts --output trace.zip

# Crawl site
ox browser crawl https://example.com --backend trawl --max-pages 100

# Generate HAR
ox browser har https://example.com --output site.har

# Test stealth
ox browser stealth-test --backend camoufox
```

## Backend Comparison

| Feature | browser-harness | Stagehand | Camoufox | Trawl |
|---------|-----------------|-----------|----------|-------|
| Speed | Fastest | Slow (AI) | Medium | Scales horizontally |
| AI Actions | No | Yes | No | No |
| Stealth | Basic | Basic | Maximum | Configurable |
| Scale | Single | Single | Single | Distributed |
| Cost | Free | API costs | Free (self-host) | Infrastructure |
| Best For | Testing, screenshots | Complex interactions | Anti-bot sites | Large crawls |

## Limits

### browser-harness
- Concurrent pages: 10 (configurable)
- Memory: ~200MB per browser instance
- Max session: 24 hours

### Stagehand
- API rate limits: Per OpenAI tier
- Token costs: ~$0.01-0.10 per action
- Latency: 2-10s per AI action
- Context window: 128k tokens

### Camoufox
- Docker required
- Startup: 5-15s cold start
- Fingerprint rotation: Manual
- Resource: 500MB-1GB per instance

### Trawl
- Coordinator: Single point (HA planned)
- Workers: 1-100 (horizontal scaling)
- Queue: Redis-backed (required for >10 workers)
- Storage: S3-compatible for results

## Troubleshooting

### Browser Won't Start
```bash
# Install browsers
npx playwright install chromium

# Check dependencies
npx playwright install-deps

# Debug launch
DEBUG=pw:api ox browser open https://example.com
```

### Stagehand AI Failures
```bash
# Check API key
echo $STAGEHAND_API_KEY | head -c 10

# Test model access
curl -H "Authorization: Bearer $STAGEHAND_API_KEY" \
  https://api.openai.com/v1/models

# Increase timeout
ox browser config --stagehand.timeout 60000
```

### Camoufox Detection
```bash
# Update fingerprint database
docker pull ghcr.io/daijro/camoufox:latest

# Test fingerprint
ox browser stealth-test --backend camoufox --verbose

# Custom fingerprint
ox browser run --backend camoufox --fingerprint custom.json
```

### Trawl Coordinator Issues
```bash
# Check coordinator health
curl http://localhost:8080/health

# View worker status
curl http://localhost:8080/workers

# Reset queue
curl -X POST http://localhost:8080/queue/reset
```

## Best Practices

1. **Reuse browser contexts** - Share context across pages for auth state
2. **Pool connections** - Use `browser.pool()` for concurrent operations
3. **Clean up** - Always `await browser.close()` in finally blocks
4. **Trace on failure** - Enable `recordVideo: 'on-failure'` for debugging
5. **Respect robots.txt** - Trawl does this automatically; configure for others

## Migration

### From Puppeteer/Playwright Direct

```typescript
// Before
const browser = await puppeteer.launch();
const page = await browser.newPage();

// After (browser-harness)
import { browser } from 'ox/browser';
const page = await browser.newPage(); // Same API!
```

### From Stagehand Standalone

```typescript
// Before
import { Stagehand } from '@browserbase/stagehand';
const stagehand = new Stagehand({ apiKey: process.env.OPENAI_API_KEY });

// After
import { stagehand } from 'ox/browser/backends/stagehand';
const page = await stagehand.newPage(); // Pre-configured
```
