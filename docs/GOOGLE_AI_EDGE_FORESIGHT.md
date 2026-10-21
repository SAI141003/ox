# Google AI Edge Foresight: an OX integration boundary

Researched 2026-10-21. Foresight was not installed on the development Mac when
this note was written.

## What Foresight adds

Google describes Foresight as an experimental Apple Silicon Mac meeting
companion. It records microphone and system audio, transcribes and expands
shorthand notes, and searches local meeting and document context. Its important
property for OX is local-first operation: it can continue without a network.

- Google announcement: https://developers.googleblog.com/google-ai-edge-with-embeddinggemma-2/
- Product page: https://developers.google.com/edge/foresight
- Runtime and model tooling: https://github.com/google-ai-edge/LiteRT

The underlying Google AI Edge stack is also useful independently of the app:
LiteRT is an on-device runtime, and LiteRT-LM supports local language and
vision-language inference. Those are potential future OX runtimes, not a
promise that every Mac can run every model quickly.

## What OX should do now

1. Keep OX Island's own call-notes recorder for live capture, permissions and
   status. It already works with the Island's visible recording state.
2. Accept a **user-selected Foresight export** (Markdown, text, or JSON) via
   `ox library add <path>`. OX Library is local, searchable, and treats saved
   material as data rather than executable instructions.
3. Let an OX agent use an imported meeting only for an explicit task such as
   “turn this meeting into action items” or “find the decision about launch.”
   It must not silently add every meeting transcript to a chat prompt.
4. Offer a future folder watcher only after the user chooses an export folder;
   show every file before importing it, and make the watcher removable.

## Deliberate limits

Foresight does not presently publish a stable, supported automation or data
API for OX. OX must **not** read or write Foresight's private SQLite files,
infer their schema, or modify meeting data. That would be brittle, risks
private data, and could corrupt a running app.

Likewise, a local embedding index is not permission to expose private meeting
content to cloud models. Before an imported meeting reaches a paid/cloud model,
OX must display that destination and ask. A fully local Ox model may be offered
as an explicit alternative when it is available and has been benchmarked on the
current machine.

## Recommended next implementation

When Foresight is installed, add a dedicated **Import Foresight export** card
under OX Settings → Library. It should choose one exported file or one folder,
preview title/date/word count, import only after confirmation, and retain the
source path so the user can remove it later. This reuses OX Library rather than
claiming a hidden live connection.
