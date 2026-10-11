---
name: frontend-craft
description: Use when building or changing a user interface. Produces interfaces that look deliberate, work by keyboard, and survive real content.
---
# Frontend craft

Design:
- Start from the content and the user's task, not a template. Pick one memorable element; keep the rest quiet.
- Define tokens first: 4-6 colours, one type scale, one spacing scale. Use them everywhere.
- Copy is part of the design: plain verbs, sentence case, buttons say what they do.

Build:
- Semantic elements (button, nav, label). Every control reachable and visible on keyboard focus.
- Test with long text, empty states, errors, slow network, narrow screens, dark mode.
- Respect prefers-reduced-motion. Motion should answer an action, not decorate.

Verify:
- Look at it: screenshot or run it. Check contrast (4.5:1 for body text).
