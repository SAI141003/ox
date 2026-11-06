---
name: website-launch-check
description: Use before calling a website or landing page finished. Checks accessibility, SEO, speed, brand consistency and behaviour by running them, and fixes what fails.
---
# Website launch check

Open the page and test it; do not review the code from memory. Report what you ran. Fix what fails, then run it again.

Accessibility:
- One h1, headings in order. Every image has alt; every input has a label; every control is a button or a link.
- Tab through the whole page: focus always visible, nothing unreachable, no trap. Body text at least 4.5:1 contrast.
- Works at 200% zoom, and with prefers-reduced-motion.

SEO:
- A unique title (under 60 characters) and meta description (under 160). Canonical link, Open Graph title, description and image.
- Words in real HTML, not only drawn by script or inside images. Links have words a reader can follow.

Speed:
- Image sizes set so nothing jumps; lazy-load what is below the fold; no image far larger than it is shown.
- No script or font the page does not use. The largest thing on first screen appears quickly on a slow connection.

Brand:
- One set of colours, one type scale, one spacing scale, used everywhere. Prices, names and claims say the same thing in every place.
- No placeholder words, no lorem ipsum, no invented testimonials or numbers.

Behaviour:
- Check at 360, 768 and 1280 px wide: no sideways scroll, nothing cut off, tap targets at least 44 px.
- Every link and button goes somewhere; forms validate, show errors and show success. Nothing in the console.
