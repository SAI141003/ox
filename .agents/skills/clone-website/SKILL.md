---
name: clone-website
description: Clone any website pixel-perfect into Next.js, Vite+React, Vue, Svelte, or plain HTML using a 5-phase AI pipeline with design token extraction, animation detection, and parallel component building.
author: ox
version: 1.0.0
metadata:
  category: productivity
  trigger: command
---

# Clone Website

Clone any website into a modern component codebase with pixel-perfect fidelity. One command. Full pipeline.

## Usage

/invoke the skill body then run:

```
clone-website <target-url> [--stack nextjs|vite|vue|svelte|plain] [--mobile] [--no-video]
```

Or invoke the module directly:

```
node /Users/saiyaganti/ox/src/website-cloner.js clone <url> --stack nextjs
```

## 5-Phase Pipeline

```
Phase 1 → Reconnaissance    Screenshots, design token extraction, interaction + animation sweep
Phase 2 → Foundation        Download fonts, images, videos (yt-dlp for streams); write tokens
Phase 3 → Component Specs   Per-section spec files with EXACT getComputedStyle() values
Phase 4 → Parallel Build    Builder agents in worktrees, one per section/component
Phase 5 → Assembly & QA     Merge worktrees, wire page, run visual diff vs original
```

### Phase 1 — Reconnaissance

1. Launch headless browser, navigate to `<url>`
2. Take full-page screenshot + viewport screenshots (desktop + mobile @375px)
3. Extract design tokens via `scripts/design-tokens.js` + `scripts/sniper-css.js`
4. Walk the DOM; classify sections by semantic landmark (`<header>`, `<main>`, `<section>`, `<footer>`)
5. Detect interactions: forms, modals, carousels, tabs, dropdowns, accordions, tooltips, menus
6. Detect animations: GSAP, Framer Motion, Lottie, CSS keyframes, Lenis, Locomotive Scroll
7. Detect scroll behavior: sticky, parallax, IntersectionObserver triggers
8. Save results to `docs/research/recon.json`

### Phase 2 — Foundation

1. Write `globals.css` with extracted design tokens as CSS custom properties
2. Download all images (`<img src>`, CSS `background-image`) → `public/images/`
3. Download all fonts (`@font-face`, `font-display: swap`) → `public/fonts/`
4. Download videos: iframes (Vimeo/YouTube → yt-dlp) and direct URLs → `public/videos/`
5. Extract SVGs as inline React components → `src/components/icons.tsx`
6. Run `extractDesignTokens` → `toTailwind(tokens)` → inject into `tailwind.config.ts`

### Phase 3 — Component Specs

For each section, write `docs/research/components/<section>.md` containing:

```
## <SectionName>
- **Position:** <static | sticky | fixed>
- **Z-index:** <int>
- **Layout:** <flexbox | grid | block | absolute>
- **Computed styles:** <exact getComputedStyle dump>
- **Responsive:** <breakpoint classes>
- **Interactions:** <hover/click/focus states>
- **Animations:** <keyframes, transitions, timing functions>
- **Content:** <real text + asset paths>
```

Builder agents MUST receive the spec inlined — never guess.

### Phase 4 — Parallel Build

- Spawn one builder agent per section in its own git worktree branch
- Each builder reads ONLY its section spec + design tokens
- Two-agent pattern: **Builder** (writes code) → **Evaluator** (reviews, does NOT write)
- Builder MUST NOT evaluate its own output
- Worktrees merge back into `main` after all builds complete

### Phase 5 — Assembly & QA

1. Assemble section components into `page.tsx` in original DOM order
2. Wire up shared providers: Framer Motion, Lenis, Embla Carousel
3. Run visual diff (`scripts/visual-diff.js`) against original screenshots
4. QA checklist (see Quality Checklist below)
5. Report: invisible sections, broken images, console errors, TypeScript errors

## Design Token Extraction

Use `scripts/sniper-css.js` and `scripts/design-tokens.js` to extract:

| Token Type | Source | Method |
|---|---|---|
| Colors | `color`, `background-color`, `border-color`, gradient stops | `getComputedStyle` |
| Fonts | `font-family`, `@font-face` rules, font files | `document.styleSheets` |
| Spacing | `margin`, `padding`, `gap` values | `getComputedStyle` |
| Shadows | `box-shadow` (ALL layers) | `getComputedStyle.boxShadow` |
| Border-radius | `border-radius`, `border-start-end-radius` etc | `getComputedStyle` |
| Breakpoints | `@media` queries | `CSSRuleList` |
| Typography | `font-size`, `line-height`, `letter-spacing`, `font-weight` | `getComputedStyle` |

### sniping-css.js

```js
import { extractComputedStyles, extractTypography, extractBoxShadow, extractBackground, extractAnimations } from './scripts/sniper-css.js';
```

## Asset Extraction

- **Images:** `<img srcset>` and CSS `url()` — download at `srcset` resolutions
- **Videos:** `@playwright/mcp` browser + `yt-dlp` for Vimeo/YouTube/HLS; direct `download()` for MP4
- **SVGs:** Extract as React components with `import { ReactComponent as Icon }` pattern
- **Fonts:** `@font-face` → WOFF2, `font-display: swap`, preconnect to CDN
- **Favicon:** All sizes via `<link rel="icon">` + `apple-touch-icon`

## Animation Detection

| Library | Detection Selector | Output |
|---|---|---|
| GSAP | `gsap.`, `_gsap`, `transform3d` in inline styles | Extract timeline config |
| Framer Motion | `motion-*` classes, `data-framer-*` attrs | Translate to `motion.*` |
| Lottie | `<lottie-player>`, `bodymuffin` class | Embed `<lottie-player>` tag |
| CSS Keyframes | `@keyframes`, `animation` property | Export as `.animate-*` |
| CSS Transitions | `transition`, `transition-*` | Tailwind `transition-*` |
| Lenis | `lenis-scroll`, `data-lenis-prevent` | Apply `useScrollReveal` hook |
| Locomotive Scroll | `locomotive-scroll`, `data-scroll` | Replace with Lenis |

## Interaction Detection

| Interaction | Detection | Output |
|---|---|---|
| Forms | `<form>`, `input[type]`, `select`, `textarea` | Form component + validation |
| Modals | `[role="dialog"]`, `[aria-modal]` | `Dialog` (Radix/shadcn) |
| Carousels | `splide`, `swiper`, `flickity`, `embla` | Embla Carousel |
| Tabs | `[role="tablist"]`, `[role="tab"]` | `Tabs` (Radix) |
| Dropdowns | `data-dropdown`, `[role="menu"]` | `DropdownMenu` |
| Accordions | `<details>`, `data-accordion` | `Accordion` (Radix) |
| Tooltips | `[data-tooltip]`, `title` attr | `Tooltip` |
| Menus | `[role="menubar"]`, hamburger icons | `NavigationMenu` / Sheet |

## Component Classification (Server vs Client)

| Rule | Component Type |
|---|---|
| Static HTML, no JS needed | Server Component (RSC) |
| Uses `useState`, `useEffect`, `useRef`, `motion` | Client Component (`'use client'`) |
| Interactive (click/hover/focus handlers) | Client Component |
| Uses `getServerSideProps` / `fetch` at build | Server Component |
| Framer Motion | Client Component |
| Lenis / Embla init | Client Component |

Default: classify as Server Component unless interactivity is detected.

## Critical Gotchas

1. **Framer nests text deeply** — use `TreeWalker` on the element to extract the actual rendered text node, not `el.textContent` (which may include hidden helper spans).
2. **Layered gradient orbs** — `background-image` may contain multiple layered gradients; capture the FULL string, not just the first layer.
3. **Multi-layer box-shadows** — `box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 4px 6px rgba(0,0,0,.1)` — split on commas but preserve ALL layers.
4. **Compound badges** — `<span>` inside `<span>` with gradient + border + shadow — extract each layer separately.
5. **Negative letter-spacing** — `letter-spacing: -0.02em` on buttons — faithfully reproduce, don't auto-correct.
6. **Double text in Framer buttons** — Framer renders text twice (for responsive sizing); de-duplicate.
7. **Fluid wrapping** — `clamp()` values in `font-size`, `padding`, `width` — preserve exactly, don't "simplify".
8. **Glassmorphism** — `backdrop-filter: blur(...)` + semi-transparent background — capture BOTH.
9. **Scroll-snap / sticky** — elements with `position: sticky` need `overflow-anchor: none` on parent.
10. **CSS `:nth-child` selectors** — extract the Nth pattern as a Tailwind `nth-child` utility or inline style.

## Quality Checklist

Pass ALL of these before declaring a section done:

- [ ] Semantic HTML (`<nav>`, `<main>`, `<section>`, `<header>`, `<footer>`)
- [ ] Section order matches original DOM
- [ ] Layout centering (`flex justify-center items-center` or `mx-auto`)
- [ ] Responsive breakpoints (`sm:`, `md:`, `lg:`, `xl:`)
- [ ] Typography matches (`font-size`, `line-height`, `letter-spacing`, `font-weight`)
- [ ] Colors match (including hover/focus states)
- [ ] Spacing matches (margins, padding, gaps)
- [ ] Box-shadows match (ALL layers)
- [ ] Border-radius matches
- [ ] Animations match (duration, easing, delay)
- [ ] No console errors in browser
- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Visual diff < 5% pixel difference

## Speedrun Prompt

Paste this into any AI agent to fast-clone a site:

```
Clone <url> into a Next.js App Router project. Skip the analysis — I need production code now. Use the 5-phase pipeline from .agents/skills/clone-website/SKILL.md. Be pixel-perfect. Use the two-agent pattern: builder writes, evaluator reviews. Do NOT stop for permission — execute every phase.
```

## Two-Agent Builder+Evaluator Pattern

```
Builder Agent:
  - Receives full component spec (computed styles, content, interactions)
  - Writes the component file only
  - Does NOT review or critique its own output

Evaluator Agent:
  - Reads the builder's output
  - Compares against the spec
  - Reports: layout drift, missing styles, broken animations, TypeScript errors
  - Does NOT write code — only critiques
```

## Supported Stacks

| Stack | Template Path |
|---|---|
| Next.js 15 (App Router) | `templates/nextjs-app-router/` |
| React + Vite | `templates/vite-react/` |
| Vue | `templates/vite-react/` (adapt `.tsx` → `.vue`) |
| Svelte | `templates/vite-react/` (adapt `.tsx` → `.svelte`) |
| Plain HTML/CSS | `templates/plain-html/` |

## Safety

- This skill must NOT be used for phishing, impersonation, or any deceptive purpose.
- Respect the target site's Terms of Service — check `robots.txt` and ToS before cloning.
- Clone only sites you own or have explicit permission to replicate.
- Preserve and credit original copyright notices, logos, and brand assets.
- Do not hotlink; download and self-host all assets.

## References

- `scripts/sniper-css.js` — CSS extraction functions
- `scripts/design-tokens.js` — design token pipeline
- `templates/nextjs-app-router/` — Next.js 15 scaffold
- `templates/vite-react/` — Vite + React scaffold
- `templates/plain-html/` — Plain HTML scaffold
- `src/website-cloner.js` — ox integration module
