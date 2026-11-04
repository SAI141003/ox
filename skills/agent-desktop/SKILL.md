---
name: agent-desktop
description: Use to see and operate a desktop app through its accessibility tree instead of screenshots - click, fill, read state, navigate menus, manage windows, on macOS, Windows and Linux.
---
# agent-desktop

Use the `desktop` tool. It runs agent-desktop for you with ox's rules on top. If it is missing: `ox desktop install`.

## The loop

1. `find` when you know the role or name. Cheapest.
2. Otherwise `map` for a shallow outline with refs and how much each branch holds. A small app can skip this.
3. `drill` with one ref to read just that region.
4. Act on a ref or a name.
5. Read the same region again to verify. Never assume it worked.

## Rules

- Refs look like `@s1:e8` and belong to their snapshot. If the UI changed you get STALE_REF or AMBIGUOUS_TARGET: take a new `map`.
- After an async step use `wait`, with text or a window title. A fixed pause is a race.
- Don't `map` a menu, sheet or alert: it is already focused. An action that opens one lists it in `surfaces`.
- Actions are headless: no pointer moved, no focus taken. Only `hover` and `drag` move the real pointer.
- A control that sends, pays or deletes is never pressed, and Return is never pressed. The last step stays with the person.
- A control with no click action cannot be clicked here: use `set_value` or `type`.

Full command notes: `references/` beside this file, or `agent-desktop skills get desktop` and `agent-desktop skills get platform`.

---
_From agent-desktop by Vercel Labs (github.com/vercel-labs/agent-desktop), Apache-2.0, at v1.1.0._
