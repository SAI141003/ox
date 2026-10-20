---
name: ox-theme
description: Use when the user wants ox (the app, its look, colours, fonts, sizes) restyled: "make it neumorphic", "darker", "bigger text", "a calmer palette". Changes only how ox looks.
---
# Restyle ox

- Built-in looks, no model needed: `ox theme use neumorphic | glass | paper | terminal | contrast`.
- Anything else: `ox theme "<the look in the user's words>"`. It starts from the current
  theme, so "make the accent warmer" changes just that.
- `ox theme list` shows the looks; `ox theme reset` goes back to ox's own.
- The open app picks the change up within seconds; nothing needs a restart.

After a change, read the line ox prints: it reports text contrast (keep it at 4.5:1 or
more) and anything it left out. A theme can only change colours, fonts, sizes, shadows
and radii; ox removes remote loads and scripts. Never edit src/web/chat.html for a
look: themes live in ~/.ox/themes.
