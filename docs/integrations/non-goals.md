# Non-Goals: Explicitly Unsupported Integrations

This document lists integrations that are **explicitly not supported** and will not be implemented in ox. These are documented to prevent feature requests and clarify boundaries.

---

## Thuki

### What it is
Thuki is a Thai-language-focused analytics and user behavior tracking platform.

### Why not supported
1. **Regional specificity** - Thailand-only market focus doesn't align with ox's global scope
2. **Closed ecosystem** - No public API, SDK only available through direct partnership
3. **Data sovereignty** - Requires data residency in Thailand, conflicts with ox's deployment flexibility
4. **Language barrier** - Documentation and support only in Thai
5. **No community** - Zero open-source presence, no community extensions

### Alternatives
- **PostHog** - Open-source, self-hostable, global CDN
- **Plausible** - Lightweight, privacy-friendly, multi-region
- **Umami** - Simple, self-hosted, no external dependencies

### If you need Thai analytics
Use a general-purpose analytics platform with:
- Thai language support in dashboards
- Bangkok region data residency (AWS ap-southeast-1, GCP asia-southeast1)
- Custom event tracking for Thai-specific metrics

---

## HeyClicky

### What it is
HeyClicky is a click tracking and heatmap service for marketing optimization.

### Why not supported
1. **Marketing-focused** - Designed for landing page optimization, not developer workflows
2. **Proprietary script** - Requires injecting third-party JavaScript on every page
3. **Cookie-dependent** - Relies on third-party cookies (phasing out)
4. **No API for developers** - Dashboard-only, no programmatic access
5. **Pricing model** - Per-pageview pricing doesn't scale for applications
6. **GDPR/CCPA complexity** - Requires explicit consent flows ox doesn't manage

### What ox provides instead
- **Built-in interaction tracking** - Via browser integration for testing
- **Custom event system** - `ox.track('event', { props })` for your own analytics
- **Privacy-first** - No third-party scripts, no cookies required

### Alternatives
- **Hotjar** - If you need heatmaps (but still third-party)
- **Microsoft Clarity** - Free, but same third-party concerns
- **Custom solution** - Canvas-based heatmaps in your own app

---

## Clicky Analytics

### What it is
Clicky is a real-time web analytics service (getclicky.com).

### Why not supported
1. **Legacy architecture** - Flash-era technology, limited modern framework support
2. **No modern API** - REST API is minimal, no GraphQL, no webhooks
3. **Single-tenant SaaS** - No self-hosting, no data export automation
4. **Pricing** - Pay-per-site, expensive at scale
5. **No developer experience** - Built for marketers, not engineers
6. **Cookie banner required** - Not privacy-friendly by default

### What ox provides instead
- **Self-hosted analytics** - Via PostHog/Umami integration patterns
- **Real-time logs** - `ox logs --follow` for actual real-time data
- **Custom dashboards** - Build exactly what you need

### Alternatives
- **PostHog** - Real-time, self-hosted, full SQL access
- **Matomo** - Self-hosted, GDPR-compliant, plugin ecosystem
- **Fathom** - Simple, privacy-first, but SaaS only

---

## TrueForge Full UI

### What it is
TrueForge is a visual UI builder that generates complete React/Vue applications from designs.

### Why not supported
1. **Code generation anti-pattern** - ox generates *tools*, not *application code*
2. **Lock-in risk** - Generated code depends on TrueForge runtime/patterns
3. **Design-to-code gap** - Figma → Code is lossy; manual refinement always needed
4. **Maintenance burden** - Regenerating overwrites customizations
5. **Not a developer tool** - Targets non-technical users, ox targets engineers
6. **Framework coupling** - Ties you to specific React/Vue versions and patterns

### What ox does instead
- **Component scaffolding** - `ox generate component` creates starter files
- **Design token sync** - Backboard.io integration for design system tokens
- **Storybook integration** - Develop components in isolation
- **Type-safe props** - TypeScript interfaces from design specs

### If you want visual development
- **Use Backboard.io** - For design review and token management
- **Use Storybook** - For component development and documentation
- **Use ox CLI** - For scaffolding, testing, and deployment automation
- **Write code** - The last 20% (polish, logic, edge cases) requires a developer

### Related: No-Code/Low-Code Platforms
The following are also non-goals for the same reasons:
- **Bubble.io** - Platform lock-in, not portable
- **Webflow** - Designer tool, not developer tool
- **FlutterFlow** - Generates Flutter, but same maintenance issues
- **Retool** - Internal tools only, not customer-facing apps
- **Appsmith** - Same category as Retool
- **ToolJet** - Same category
- **Budibase** - Same category
- **NocoDB** - Airtable alternative, not app builder

---

## General Non-Goal Criteria

Any integration request will be rejected if it meets **any** of these criteria:

| Criterion | Explanation |
|-----------|-------------|
| **Requires third-party script injection** | ox controls the runtime; no external JS on pages |
| **No public API / closed ecosystem** | Cannot build reliable integration without API |
| **Marketing/sales tool, not developer tool** | ox is for engineers, not growth teams |
| **Single-tenant SaaS only** | No self-hosting = no data control = non-goal |
| **Generates application code** | ox generates tooling/config, not business logic |
| **Region-locked / language-locked** | ox is global, English-first |
| **Cookie-dependent tracking** | Privacy regulations make this unsustainable |
| **Pricing doesn't scale** | Per-seat or per-pageview models break at scale |
| **No community / abandoned** | Unmaintained = security risk |
| **Competes with ox core** | We don't integrate things that replace ox features |

---

## Requesting Exceptions

If you believe an integration should be reconsidered:

1. **Open a GitHub Discussion** - Not an Issue
2. **Provide evidence** for:
   - Public API documentation
   - Self-hosting option
   - Developer-first design
   - Active maintenance (commits < 30 days)
   - Community adoption (GitHub stars > 1k, Discord > 500)
   - No vendor lock-in (data export, standard protocols)
3. **Explain the workflow** - How does this fit in *your* ox pipeline?
4. **Show the alternative** - What would you use if this didn't exist?

Exceptions are granted **quarterly** at most. Most requests are closed with "wontfix" referencing this document.

---

## Related: Deprecated Integrations

These were previously supported but removed:

| Integration | Removed | Reason | Migration |
|-------------|---------|--------|-----------|
| `netlify-cms` | v0.2.0 | Unmaintained, security issues | Use Decap CMS or Sanity |
| `forestry` | v0.2.0 | Acquired, shut down | Use TinaCMS or CloudCannon |
| `zeit/now` | v0.1.0 | Rebranded to Vercel, API changed | Use Vercel integration |
| `heroku` | v0.3.0 | Free tier removed, DX declined | Use Railway, Render, or Fly.io |
| `circleci` | v0.3.0 | Config v2 breaking changes | Use GitHub Actions or GitLab CI |

---

## Summary

| Category | Integrations |
|----------|--------------|
| **Analytics** | Thuki, HeyClicky, Clicky, Mixpanel, Amplitude (use PostHog) |
| **Visual Builders** | TrueForge, Bubble, Webflow, FlutterFlow, Retool, Appsmith |
| **CMS (Legacy)** | Netlify CMS, Forestry, Contentful (use Sanity, Strapi, TinaCMS) |
| **Hosting (Legacy)** | Heroku, Zeit/Now (use Vercel, Railway, Fly.io, Render) |
| **CI/CD (Legacy)** | CircleCI, TravisCI (use GitHub Actions, GitLab CI) |

**Bottom line**: ox integrates with *developer infrastructure*, not *business tools*. If it's for marketers, designers, or non-technical users, it's a non-goal.
