# Clone Website — Agent Instructions

## Project Overview

A skill for the ox agent system that clones any public website into a modern,
component-based codebase (Next.js 15, Vite+React, Vue, Svelte, or plain HTML).
The pipeline is fully specified in `.agents/skills/clone-website/SKILL.md`.

**Goal:** pixel-perfect recreation — same layout, colors, typography,
animations, and interactions — using real content and assets from the target.

## Supported Stacks

| Stack | Template Directory | Component Extension |
|---|---|---|
| Next.js 15 (App Router) | `templates/nextjs-app-router/` | `.tsx` |
| React + Vite | `templates/vite-react/` | `.tsx` |
| Vue 3 | `templates/vite-react/` (adapt) | `.vue` |
| Svelte | `templates/vite-react/` (adapt) | `.svelte` |
| Plain HTML/CSS | `templates/plain-html/` | `.html` |

## The 5-Phase Pipeline

### 1. Reconnaissance
Launch headless browser, navigate to URL, wait for network idle.
Take full-page screenshots (desktop 1920×1080, mobile 375×812).
Run `scripts/sniper-css.js` and `scripts/design-tokens.js` against the DOM.
Classify sections by semantic landmark. Detect interactions and animations.
Output: `docs/research/recon.json`.

### 2. Foundation
Write `globals.css` with extracted tokens as CSS custom properties.
Download all fonts, images, videos (yt-dlp for streams), SVGs.
Preconnect to font CDNs. Set `font-display: swap`.
Convert tokens to Tailwind format via `toTailwind(tokens)`.

### 3. Component Specs
Write one spec file per section to `docs/research/components/<name>.md`.
Each spec MUST contain exact `getComputedStyle()` values, responsive
breakpoints, interaction states, animation details, and real content.
Builder agents receive the spec INLINED — never guess.

### 4. Parallel Build
Spawn one builder agent per section in its own git worktree branch.
Two-agent pattern: BUILDER writes code, EVALUATOR reviews.
**Builder MUST NOT evaluate its own output.**
Merge all worktrees back after builds complete.

### 5. Assembly & QA
Assemble sections into `page.tsx` in DOM order. Wire providers.
Run `visualDiff()` comparing original screenshot to clone screenshot.
Check QA checklist. Fix failures before declaring complete.

## Critical Gotchas

### Framer nests text deeply
```js
// WRONG — misses nested text, includes helper spans
const text = el.textContent;

// CORRECT — walk only visible leaf elements
import { extractTypography } from '../scripts/sniper-css.js';
const { text, layers } = extractTypography(el);
```
**Fix:** Use `extractTypography()` which uses TreeWalker and filters
non-text-bearing nodes. De-duplicates doubled Framer text.

### Layered gradient orbs
```css
/* This looks like ONE gradient but is actually TWO */
background-image: radial-gradient(circle at 30% 70%, #0066ff, transparent 40%),
                   radial-gradient(circle at 80% 20%, #00ccff, transparent 30%);
```
**Fix:** `extractBackground()` preserves ALL gradient layers.
Do NOT merge them into a single gradient.

### Multi-layer box-shadows
```css
box-shadow: 0 1px 3px rgba(0,0,0,.1),
            0 4px 6px rgba(0,0,0,.1),
            0 8px 25px rgba(0,0,0,.1);
```
**Fix:** `extractBoxShadow()` splits on commas respecting `rgba()` parens.
Reproduce ALL layers in Tailwind `[0_1px_3px_rgba(0,0,0,0.1),...]`.

### Compound badges
Badges with gradient + border + shadow need separate extraction per layer.
Extract `backgroundImage`, `border`, and `boxShadow` as separate token groups.

### Negative letter-spacing
```css
letter-spacing: -0.02em;  /* Framer button */
```
**Fix:** Preserve exactly. Do NOT auto-correct negative values.
Map to Tailwind `tracking-[-0.02em]` arbitrary value.

### Double text in Framer buttons
Framer Motion renders button text twice — once visible, once hidden for
baseline measurement. `extractTypography()` de-duplicates via a `Set`.

### Fluid wrapping
```css
font-size: clamp(1.25rem, 2vw + 1rem, 2rem);
padding: clamp(1rem, 3vw, 2rem);
```
**Fix:** Preserve clamp() values verbatim. Do NOT simplify to static px.

### Glassmorphism
```css
background: rgba(255,255,255,0.1);
backdrop-filter: blur(12px);
```
**Fix:** `extractBackground()` detects glassmorphism by checking
`backdrop-filter` + semi-transparent background. Capture BOTH.

## Component Classification Rules

```
IF component uses: useState | useEffect | useRef | motion.* | scroll hooks
THEN: Client Component — add 'use client' at top

IF component only renders: static HTML | props | RSC fetch results
THEN: Server Component — no 'use client' needed

IF component has: click/hover/focus handlers | event listeners | IntersectionObserver
THEN: Client Component
```

### Framer Motion patterns
```tsx
// CORRECT — with useScrollReveal (Lenis-compatible)
'use client';
import { motion } from 'framer-motion';
import { useScrollReveal } from '@/hooks/useScrollReveal';

export default function Section() {
  const { ref, inView } = useScrollReveal();
  return (
    <section ref={ref}>
      <motion.div
        animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      >
        Content
      </motion.div>
    </section>
  );
}
```

### NEVER use `whileInView` with Lenis
```tsx
// BROKEN — stays invisible when Lenis is active
<motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} />
```

## Animation Rules

1. **Framer Motion:** Translate to `motion.div`, `motion.h2`, etc.
   Use `initial`, `animate`, `transition` props. Never use `whileInView`.
2. **CSS keyframes:** Export as Tailwind `@keyframes` in `globals.css`.
3. **GSAP:** Replace with Framer Motion equivalents where possible.
4. **Lottie:** Use `<lottie-player>` web component with the animation JSON URL.
5. **Lenis scroll:** Initialize with `<LenisProvider>` wrapper.
6. **Embla Carousel:** Use `useEmblaJs` + `embla-carousel-auto-scroll`.

## Quality Checklist

- [ ] Semantic HTML (`<nav>`, `<main>`, `<section>`, `<header>`, `<footer>`)
- [ ] Section order matches original DOM
- [ ] Layout centering correct (`mx-auto`, `flex justify-center`)
- [ ] Responsive breakpoints present (`sm:`, `md:`, `lg:`, `xl:`)
- [ ] Typography matches (`font-size`, `line-height`, `letter-spacing`, `font-weight`)
- [ ] Colors match (including hover/focus states)
- [ ] Spacing matches (margins, padding, gaps)
- [ ] Box-shadows match (ALL layers)
- [ ] Border-radius matches
- [ ] Animations match (duration, easing, delay)
- [ ] No console errors in browser
- [ ] TypeScript compiles (`tsc --noEmit`)
- [ ] Visual diff < 5% pixel difference

## Safety Guidelines

1. **No phishing or impersonation.** Do NOT clone login pages, banks,
   government sites, or anything that could deceive users.
2. **Respect Terms of Service.** Check `robots.txt` and ToS before cloning.
   Some sites explicitly prohibit reproduction.
3. **Own or have permission.** Clone only sites you own or have explicit
   written permission to replicate.
4. **Credit originals.** Preserve copyright notices, logos, and brand assets.
5. **Self-host assets.** Do not hotlink — download and serve locally.
6. **Strip tracking.** Remove analytics, tracking pixels, and third-party
   scripts from the clone.
7. **Attribution.** If distributing the clone, clearly mark it as a recreation
   and credit the original design.

## Speedrun

```
Clone <url> → Next.js. Run all 5 phases. Be pixel-perfect.
Use the two-agent builder+evaluator pattern with git worktrees.
Do NOT pause for questions — execute autonomously.
```
