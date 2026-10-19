# The fast browser (after browser-use/jev-ultrafast)

October 18, 2026. The owner asked to compare ox with
[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
(MIT, "Fastest and cheapest web agent": Zürich → London on Google Flights in
7.07 s) and bring all of its logic into ox, including OX Island.

## What ox had before

`web_task` started a browser MCP server through npx on every run, took a
full-page screenshot after every step, waited a fixed 2–3 s for "network idle"
after every click, and let the model write CSS selectors. Its default path
(`browser-harness`) asked a planner at `localhost:__OX_PLANNER_PORT__` from
inside the page. That placeholder was never filled in, so the default path
answered "Planner unavailable" and **could not finish any task**.

## What jev does (read from its source)

1. One browser call per look: a DOM snapshot of visible controls (role, name,
   value, state) and visible text, with code-owned node ids (WeakMap + Map).
2. An indexed element table; each operation (CLICK, TYPE_TEXT, SELECT,
   SCROLL, WAIT, DONE, BLOCKED) lists only targets it can act on.
3. Freshness guards: page key (URL, scroll, viewport, form values) plus the
   target's surroundings; geometry and a hit test are read again just before input.
4. Waits that end on events: two animation frames or 50 ms; after typing into a
   combobox, until suggestions show (at most 200 ms).
5. A background tab that keeps rendering (focus emulation).
6. Model output never becomes selectors, coordinates or scripts.
7. Budgets: 60 actions, 120 decisions; stop after 3 unchanged actions.
8. Decisions by TypeSafe (a paid classifier, ~178 ms) plus a small LLM for text.

## What ox does now (`src/fast-browser.js`)

All of the above, in ox's own Node code over Chrome DevTools (Node's built-in
WebSocket; nothing installed, no npx server). And where ox goes further:

| | jev | ox |
|---|---|---|
| Calls per typing step | 2 (decision, then text) | **1** (operation, target and text together) |
| DONE | trusted | **checked**: one more call lists each requirement with its evidence; a false DONE goes back into the loop |
| BLOCKED | final | checked the same way (a finished page counts as done); one more try before stopping |
| Covered controls | offered, refused at click time | **not offered** (hit test in the snapshot), so the model cannot pick them |
| A refused answer | an error | shown to the model as `REFUSED? …`, so it corrects itself |
| Odd answer shapes | rejected | accepted only when they have one meaning inside what was offered (an option sent as CLICK is that SELECT) |
| Buy / pay / send / delete | clicked | **waits for your OK**, even in `--yes` mode |
| Headless tab | background | foreground when headless (no window to steal): reading after a click went 239 → 33 ms, typing 199 → 34 ms |
| Model | TypeSafe + OpenRouter | any OpenAI-style API (OpenRouter by default, `inception/mercury-2.5`, jev's text model) |

Password, file and hidden inputs are never read or offered. A list item's
numeric `.value` is no longer shown as a field value (jev shows `value="0"`).

## Measured (real Chrome, real model, Oct 18)

| Task | Result |
|---|---|
| Local hotel page: cookie dialog, autocomplete, 2 filters, sort, search, open Casa Flora (scripted decider, no model) | **2.46 s**, 76 browser calls; in the test suite |
| Same task, `inception/mercury-2.5` | 3/3 passed (13.1 s, 14.7 s, 31.7 s) |
| Same task, `openai/gpt-4.1-mini` | 0/3 before refusals were shown to the model, then 2/2 (11.2 s, 14.1 s) |
| Same task, `google/gemini-2.5-flash-lite` | fastest per call (~0.5 s) but never clicks the suggestion; the DONE check stopped every false finish |
| Wikipedia: open Gödel's incompleteness theorems, mercury-2.5 | 3/3 passed: 6.26 s, 6.31 s, **4.25 s** (jev: 2.80 s) |

Each call to the model took 0.5–1.3 s from this Mac, against jev's 178 ms
TypeSafe median. That is most of the gap; the browser side is not the
bottleneck. The DONE check adds one call (about 0.65 s) at the end.

**Not measured yet:** Google Flights (jev's headline task). After the runs
above the OpenRouter account had no credit left (402), and its free models
answered 429. With credit added: `ox browse "Find one-way flights from Zurich
to London on September 20 for one adult in economy. Stop when flights are
visible." --url "https://www.google.com/travel/flights?hl=en"`.

## Where it is

- `ox browse "<goal>" [--url …] [--show] [--model …]`: the terminal, with a ✓ per step.
- `web_task`: the agent's browser tool; `fast` is now the default backend.
- `GET /ox/browse`, `POST /ox/browse/run`: the app and OX Island.
- OX Island: a browser card while a run goes (timer, ✓ chips, final time).
