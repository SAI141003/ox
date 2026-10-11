# ox Desktop

A native desktop wrapper for the `ox` CLI, built with Tauri 2.0. Provides a
chat-style UI with side panels for files, plans, and history.

## Current state (honest)

This is a **chat wrapper with a basic file editor and diff/apply**, not an IDE.
It runs the ACP driver (`desktop/scripts/ox-acp-driver.mjs`) and renders the
NDJSON event stream.

### What IS implemented

- **Chat panel**: Streaming assistant responses, tool execution log
- **File tree**: Click to open files in the editor panel
- **Editor panel**: Textarea-based editor (no syntax highlighting) with Save
- **Diff/apply view**: When the agent proposes file changes (`write_file`/`edit_file`),
  a side-by-side diff appears with **Accept All / Reject All** and per-hunk
  **Accept / Reject** buttons. Accepted changes are written to disk via
  `ox_write_file`.
- **Plan & History panels**: Read-only views of `.agent/plans/` and
  `.agent/procedural.md`

### What is NOT shipped (explicitly)

- Integrated terminal
- LSP diagnostics / syntax highlighting / code intelligence (Monaco not used)
- Settings panel
- Multi-file tabs, split views, minimap
- Git integration (diff vs HEAD, blame, staging)
- Debugger, test runner, task runner UI
- Real IDE features (go to definition, refactor, rename, etc.)

The editor is a plain `<textarea>` — honest about its limitations. The diff
algorithm is a simple single-hunk prefix/suffix matcher (good enough for
typical agent edits, not a full Myers/LCS implementation).

## Hostable agent core: ACP

`ox acp server` exposes the real `runAgent` loop over the standard Agent Client
Protocol (stdio, newline-delimited JSON). A host — Tauri desktop, VS Code
extension, or Zed — can drive agent turns through `createAcpClient` instead of
spawning the CLI. This is the shared-core path: one agent implementation, CLI
and host both call it.

## Prerequisites

The build is **fail-closed**: `npm run build` (and `npm run check`) verify
every prerequisite before any tauri/cargo work begins. If anything is missing
the script exits non-zero with a clear list of what to fix.

- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
  - `cargo` and `rustc` must be on `PATH` (checked with a 5s timeout)
- [Node.js](https://nodejs.org/) >= 18
- `desktop/node_modules` present (run `npm install` in `desktop/`)
- `desktop/src-tauri/src/main.rs` exposes a real `fn main()` entry point
  (the desktop target has no `mobile_entry_point`, so a missing `main()`
  leaves the crate unbuildable)

## Scripts

| Script           | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `npm run check`  | Run the prerequisite checker only (exit 0 or 3)         |
| `npm run build`  | Check prerequisites, then run `vite build`              |
| `npm run dev`    | Vite dev server (Tauri dev loop)                        |
| `npm run tauri`  | Delegate to the Tauri CLI                                |

## Build

```bash
cd desktop
npm install
npm run build        # fails closed if any prerequisite is missing
npm run tauri build  # actual Tauri/cargo build
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  ox Desktop (Tauri 2.0)                                          │
│                                                                  │
│  ┌─────────┐ ┌──────────────────┐ ┌──────────────────────────┐  │
│  │ Files   │ │ Chat             │ │ Tools / Editor / Diff    │  │
│  │ Panel   │ │                  │ │ Panel                    │  │
│  │         │ │ Messages area    │ │                          │  │
│  │ file    │ │ with streaming   │ │ Execution log            │  │
│  │ tree    │ │ NDJSON render    │ │ from ox acp driver       │  │
│  │         │ │                  │ │                          │  │
│  │ Plan    │ │ Input box        │ │ Tool result display      │  │
│  │ view    │ │                  │ │                          │  │
│  │ History │ │                  │ │ Editor (textarea)        │  │
│  └─────────┘ └──────────────────┘ │ Diff/apply (accept/reject)│  │
│       ▲              ▲             └──────────────────────────┘  │
│       │              │                       ▲                   │
│  ox_list_files   ox_run               ox_read_file               │
│  ox_get_procedural                      ox_write_file            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Rust Backend (src-tauri/src/main.rs)                     │   │
│  │ - Spawns ox ACP driver via node                          │   │
│  │ - Parses NDJSON output                                   │   │
│  │ - Reads .agent/ files                                    │   │
│  │ - File read/write (ox_read_file, ox_write_file)          │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Event stream consumed by the UI

The ACP driver emits `text-delta`, `tool-start`, `tool-end`, and `final`
events. `App.jsx` maps those to assistant messages and the tool log. The
legacy `message`/`tool` event types are not emitted and are not handled.

When a `tool-end` event for `write_file` or `edit_file` arrives with
`newContent`/`oldContent`, the UI computes a line-based diff and shows the
diff/apply panel in the right sidebar. Accepting writes the new content via
`ox_write_file`; rejecting discards it.

## Project Structure

```
desktop/
├── src/
│   ├── App.jsx          # Main React app with 3-pane layout + editor/diff
│   ├── main.jsx         # React entry point
│   ├── styles.css       # Dark theme styles
│   └── diff.js          # Pure-JS line diff + apply helpers (no deps)
├── src-tauri/
│   ├── src/
│   │   └── main.rs      # Rust backend: ACP driver spawning, file ops
│   ├── Cargo.toml       # Rust dependencies
│   └── tauri.conf.json  # Tauri window config
├── scripts/
│   ├── build.mjs        # Fail-closed prerequisite checker
│   └── ox-acp-driver.mjs # ACP client driver (node ESM)
├── test/
│   ├── build-prereqs.test.js
│   ├── acp-driver.test.js
│   └── editor-diff.test.js   # Editor/diff unit tests
├── index.html           # HTML entry
├── package.json         # Node deps and scripts
└── vite.config.js       # Vite config for Tauri
```

## Testing

```bash
cd desktop
node --test test/*.test.js
```

Tests use isolated temp directories, fake fs where appropriate, no network,
no real credentials.
