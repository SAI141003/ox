# ox Integrations

Comprehensive documentation for all supported integrations in the ox ecosystem.

## Available Integrations

### Core Integrations
- **[Backboard.io](./backboard.md)** - Sovereign AI infrastructure coexistence (model routing, memory bridge, R-CLI)
- **[Browser Automation](./browser.md)** - Browser harness, Stagehand, Camoufox, Trawl
- **[Unity Game Development](./unity.md)** - Unity editor and runtime integration
- **[OpenWhispr Voice](./voice.md)** - Voice input/output integration

### Non-Goals (Explicitly Not Supported)
- **[Non-Goals](./non-goals.md)** - Thuki, HeyClicky, Clicky Analytics, TrueForge Full UI

---

## Integration Guidelines

All integrations follow these principles:
1. **Explicit opt-in** — No integration activates without explicit configuration
2. **Environment-based config** — Secrets via environment variables, never committed
3. **Graceful degradation** — Missing integrations don't break core functionality
4. **Version pinning** — Lock integration versions in lockfiles

## Quick Start

```bash
# Browser automation (Playwright MCP)
ox mcp add browser

# Browser harness (browser-use)
ox mcp add browser-harness

# Stagehand (Browserbase)
ox mcp add stagehand

# Camoufox (anti-detect Firefox)
ox mcp add camoufox

# Trawl (read-only web research)
ox mcp add trawl

# Unity Editor MCP
ox mcp add unity

# Backboard.io Platform (read-only HTTP MCP)
ox mcp add backboard

# Voice agents (STT/TTS)
ox mcp add voice

# Install skills from docs/
ox skill add docs/skills/openwhispr
ox skill add docs/skills/browser-harness
ox skill add docs/skills/stagehand
ox skill add docs/skills/camoufox
ox skill add docs/skills/unity
ox skill add docs/skills/backboard

# Use Backboard as provider
export OX_BASE_URL=https://api.backboard.io/v1
export BACKBOARD_API_KEY=bb_live_xxx...
ox -p "your prompt"

# Or use bot preset
ox --bot backboard -p "your prompt"

# Save as agent preset
ox agent save backboard --provider backboard --model backboard-routing --base-url https://api.backboard.io/v1
```

## Contributing

To add a new integration:
1. Create a new `.md` file in this directory
2. Follow the template structure (setup, usage, limits, troubleshooting)
3. Update this README with a link
4. Add MCP template to `src/mcp-templates.js` if applicable
5. Add bot preset to `src/bots.js` if applicable
6. Add Agent Skill to `docs/skills/` if applicable