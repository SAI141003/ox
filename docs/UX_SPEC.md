# ox UX Specification

## Design Principles

1. **Terminal-first**: All core actions available via CLI. Desktop is optional enhancement.
2. **Approval-gated**: Every external action (open app, URL, path, type, screenshot) requires explicit approval unless yolo/trusted.
3. **Zero surprise**: No silent actions, no hidden fallbacks, no ambiguous defaults.
4. **Consistent vocabulary**: Same terms across CLI, desktop, MCP.

## Visual Vocabulary

| Element | Treatment |
|---|---|
| Primary action | Green (#238636) button |
| Approval required | Red border + "needs approval" badge |
| Dangerous | Red (#da3633) + confirmation dialog |
| Success | Green checkmark + brief toast |
| Error | Red text + human-readable message |
| Loading | Subtle dot animation, no modal |
| Empty state | Italic placeholder text |

## CLI States

```
🟢 idle → 🔵 listening → 🟡 processing → 🟣 acting → ⚪ done
                  ↕ any → 🔴 needs approval → 🟣 acting
```

## Desktop Layout

```
┌──────────┬──────────────────────┬──────────┐
│ Files    │ Chat                 │ Tools/   │
│ panel    │ panel                │ Editor   │
│          │                      │ / Diff   │
│          │  [voice button]      │          │
│          │  [operator status]   │          │
│          │  [approve/deny]      │          │
└──────────┴──────────────────────┴──────────┘
```

## Voice Overlay

- Floating button (bottom-right): pulsing mic icon when listening
- States: idle (gray) → listening (blue pulse) → processing (yellow dots) → done (green check, fade)
- Push-to-talk: hold Fn+Space or Cmd+Shift+V toggle

## Approval Flow

```
Agent → "Open Chrome?" → [✓ Approve] [✗ Deny]
  ↓ (approve)
Agent → action → "Done" → next prompt
  ↓ (deny)
Agent → "Action declined" → ask for alternative
```

## Key Bindings (Desktop)

| Shortcut | Action |
|---|---|
| Cmd+Enter | Submit chat |
| Cmd+Shift+V | Toggle voice mode |
| Cmd+Shift+A | Approve pending action |
| Cmd+Shift+D | Deny pending action |
| Cmd+Shift+S | Take screenshot |
| Cmd+Shift+O | Open file dialog |
| Fn+Space | Push-to-talk |

## Mobile/Touch (Future)

- Tap mic → start listening → speak → auto-transcribe → agent responds
- Long-press on action result → approve/deny dialog
- Swipe to dismiss notifications

## Accessibility

- WCAG AA contrast ratios on all text/background combos
- Keyboard navigable for all actions
- Screen reader labels on all interactive elements
- Voice states announced via ARIA live regions

## Error Handling

| Situation | User Message |
|---|---|
| Mic permission denied | "Microphone blocked — open System Settings → Privacy → Microphone" |
| Accessibility denied | "Window control needs Accessibility permission — open System Settings → Privacy → Accessibility" |
| Whisper not found | "Voice STT not installed — run: pip install openwhispr-stt" |
| No network | "No network — using local-only mode" |
| Unknown command | "Unknown command — type /help for options" |
