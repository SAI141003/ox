# ox's interface, surface by surface

One palette, one set of names, one meaning per colour, on every surface ox
has: the terminal, the web chat (`ox serve`), the notch island (macOS), the web
island (Windows/Linux), and the phone (Telegram/Discord).

## Colours (dark)

| token | value | used for |
|---|---|---|
| text | `#F5F6F8` | everything you read |
| muted | `#8E939C` | secondary text, idle labels |
| dim | `#6B7079` | hints, counts |
| card | `#141518` (island) / panel `#15161A` (web) | cards, the composer |
| gold | `#E9A66B` | ox itself: the send button, the selected thing |
| **amber** | `#F5A524` | **ox needs you** (an approval, a waiting run) |
| **green** | `#34D399` | **done** |
| **red** | `#F4505E` | **failed / denied** |

The three signal colours mean the same thing everywhere: an amber card on the
island, an amber status in the web island, an amber dot in the terminal and an
Allow/Deny message on the phone are the same moment. The web chat has a light
theme (gold `#C47A3A` on `#FAF9F7`); the terminal honours `NO_COLOR`.

Agent faces use six fixed hues (`#60A5FA #F472B6 #34D399 #FBBF24 #A78BFA
#22D3EE`); an agent keeps its colour across the island, the chat and the office.

## Names

| thing | name everywhere |
|---|---|
| the product, the mascot | **ox** (lower case), the ox in the notch |
| what kind of help | **mode**: Auto · Code · Ask · Plan · Debug · Orchestrate |
| your saved helpers | **agents** (`ox agent new`), shown by their own names |
| a model to run on | **bot** (`--bot`), `<vendor>-plan` for a subscription |
| asking before acting | **approval**: Allow · Deny (· Always on the island) |
| learned instructions | **skills**; unreviewed ones are **drafts** |

## The chat bar

| | ox web chat | ox island chat | Kilo Code | Claude Code (desktop) |
|---|---|---|---|---|
| Mode picker | ✓ Auto/Code/Ask/Plan/Debug/Data/Orchestrate, enforced by the server | — (Auto) | ✓ Code/Ask/Data/Debug/Orchestrator/Plan | ✓ Auto / plan |
| Model / agent picker | ✓ your agents first, then models | ✓ agent faces | ✓ model | ✓ model + effort |
| Attach | ✓ text/code files, read in the browser | drop files on the notch (shelf) | ✓ | ✓ (+) |
| Talk | ✓ browser speech | ✓ ⌃⌥Space, on-device | ✓ mic | ✓ |
| Send / stop | ✓ one button | ✓ | ✓ | ✓ |
| Says what mode it picked | ✓ "auto → debug · describes a failure" | — | — | — |
| Hint line | Enter / Shift+Enter, "Ask and Plan never change your files" | — | — | — |

## The surfaces

**Terminal.** The REPL and `ox -p`: streamed text, one line per tool
(`● write_file: x` then `✓ 3ms`), a dim line for each decision ox made on its
own (`· auto → ask`, `· tool offer narrowed`), approvals as `y/n/a` with a diff.

**Web chat** (`ox serve`, 127.0.0.1:8080). Sidebar of conversations, model and
agent picker in the header, suggestion chips on an empty chat, tool chips with
a pulsing amber dot that turns green or red, a copy button on every code block.

**Notch island** (macOS). Compact: the ox walks the wing, a status glyph or the
focus countdown on the right. Expanded: a header (the `ox` wordmark, run dots,
the model, tray buttons, the mic), one card that changes with the moment (an
approval in amber, an error in red, a finished run in green, or the list of
runs, each with its face), and a floor the full-size ox walks under your cursor;
it trots to whatever you click, and grazes, wanders or sleeps in its barn when
you leave it be. The tray: Chat (your agents as faces), Shelf, Focus, Clips.
Running teams get an office: one desk per agent, labelled with what it is doing,
"checking on the team" included.

**Web island** (Windows, Linux). The same moments as a slim bar at the top of
the screen: runs, approvals, shelf, focus timer.

**Phone.** One status message that updates in place, approvals as buttons, the
answer when it is done; `/status /stop /mode /new /where`.

## What others do that ox does not (yet)

- (Kilo's **Data** mode now has an ox equivalent: cells in `.agent/data/`.)
- Claude Code shows **effort** next to the model; ox has `--max-mode` but no
  picker for it in the web chat.
- OpenDots and OpenMuse give each agent an **avatar picture and a timeline of
  receipts** in the chat; ox gives agents a face and a colour, and keeps receipts
  in the session transcript, not in the chat view.
