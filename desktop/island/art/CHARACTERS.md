# OX Island — the notch crew

A plan for the tiny animated characters that live on the notch. Each one stands
for something ox is actually doing, so the notch tells you at a glance what is
happening, with no text needed.

## The stage

```
        ┌──────────── menu bar ────────────┐
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╭━━━━━ notch ━━━━━╮┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  left wing     ┃                 ┃     right wing
  🐂 ox lane    ╰━━━━━━━━━━━━━━━━━╯   crew lane 🧑‍🔧🧑‍💻
 ═════════════════ ground line (island bottom edge) ═══════
```

- **Compact island (the notch wings):** characters are about 20 pt tall. They
  stand on the island's bottom edge and walk across it, passing *behind* the
  notch: they disappear on one side and come out on the other.
- **Expanded island:** the same characters at about 34 pt walk along the floor
  strip under the cards. Each card's character stands next to its card.
- At most 5 characters are on stage at once. Extra subagents become a "+3"
  chip so the notch never looks crowded.
- Each character has a soft ground shadow and turns to face the way it walks.
  Two characters never stand on the same spot: they keep about 10 pt apart.

## The cast

Two art styles, each where it works best:

- **The bull** is the 3D rigged Bull (CC0, Quaternius), rendered in Blender
  (`bull_render.py`). It is the mascot and lives on the pasture.
- **The people** are pixel art in the style of Pixel Agents: top-down,
  three-quarter chibi figures with big heads, a 1-pixel dark outline, shaded
  hair, dot eyes, and varied hairstyles and clothes. They are our own
  originals, not Pixel Agents' sprites (those are based on JIK-A-4's Metro
  City pack). Each one is composed in code (`PixelPeople.swift`) from layered
  string sprites (body pose, head, face, hair, accessory, palette) with the
  outline added automatically, so they stay crisp at any size and need no
  image files.

Sprite: 16 x 24 art pixels plus the outline. Directions: front, back and side
(the left side is the right side mirrored). Poses: stand (breathing), walk (4
frames), sit and type, sit and read, wave, point, talk (mouth shapes), cheer.

| Character | Look | Plays |
|---|---|---|
| **Mira** | long black hair, red top | helper #1 / Buddy |
| **Theo** | spiky brown hair, blue hoodie | helper #2 / Buddy |
| **Ade** | afro, orange tee | helper #3 / Buddy |
| **Lin** | teal bob, teal top | helper #4 / Buddy |
| **Sol** | silver hair, cream sweater | helper #5 / Buddy |
| **Rui** | curly hair, glasses, green shirt | helper #6 / Buddy |
| **Farmer** | straw hat, blue overalls | visits the bull on the pasture |

Subagents get the helpers in order, so a helper's colour matches its desk in
the office and its row in the ledger.

### Where the people appear

- **The office** (expanded island, a team at work): each subagent walks to a
  desk and sits down. It types while editing or running commands, reads while
  searching or fetching, and shows a "…" bubble while thinking. When it needs
  an approval it shows a "!" bubble and turns to face you. When it finishes it
  stands, cheers or slumps, and walks out.
- **The notch** (compact island): while a team works, tiny versions of the
  same helpers walk back and forth in the wings beside the notch.
- **Buddy** (talking avatar): the chosen person, front view and large. They
  talk with pixel mouth shapes, blink, and wave, point or gesture with their
  hands while speaking. The Ox remains a Buddy option too.
- **The pasture:** the pixel farmer walks by the 3D bull and waves.

## The script: what happens for each ox function

| ox event (Bridge) | Ox does | Crew does | Duration / exit |
|---|---|---|---|
| no session (`sleeping`) | lies down with its head low (`Idle_Headlow`) and slowly breathes, with a small "z" floating up every 4 s | nobody on stage | until a session starts |
| session `hello` / launch | gallops in from the left edge (`Gallop`), skids to a stop at the centre-left and shakes its head | — | 1.2 s, then idle |
| `idle` (waiting for you to type) | stands, swishes its tail and sometimes looks around (`Idle`, `Idle_2`) | anyone still on stage waves and walks off | loop |
| `thinking` (`text-delta` streaming) | walks slowly, back and forth along its lane (`Walk`) | — | loop while streaming |
| `tool-start` read/grep/glob | keeps walking | **Scout** walks in from the right, stops, bends to look through the magnifier | leaves on `tool-end` |
| `tool-start` write/edit | stops and watches | **Builder** walks in and hammers (punch/interact loop) | on `tool-end` a small spark puff, then exits |
| `tool-start` bash | trots along | **Runner** jogs across the whole stage. A long command makes laps; a fast one is a single pass | exits on `tool-end` |
| `tool-start` web | — | **Courier** jogs in, hands an envelope to the ox, then jogs off | one pass |
| tests / verify (bash matching `test`/`verify`) | — | **Inspector** stands with the clipboard and nods; on `tool-end` gives a thumbs-up if `ok`, a head-shake if not | exits after the reaction |
| `subagent-start` | turns its head toward the new helper | a coloured **Helper** pops out from behind the notch with a little hop, then works (typing/hammering loop) | stays until `subagent-end` |
| `subagent-progress` | — | the helper's work loop speeds up a little | — |
| `subagent-end` ok | nods | the helper jumps (celebrate) and walks back behind the notch | 1 s |
| `subagent-end` failed / cancelled | — | the helper sits down (defeated), then gets up and leaves | 1.5 s |
| `approval-request` (`needsYou`) | stamps and headbutts toward the approval card (`Attack_Headbutt`), with a gold "!" over it | everyone freezes and turns to face the card | loop until answered |
| approval allowed / always | turns back and carries on | the crew resumes; one waves | — |
| approval denied | gives a small head-shake (`Idle_HitReact`) | the related crew member shrugs and leaves | — |
| `compaction` | — | **Builder** sweeps across the stage with a broom, packing the context away | one pass |
| `error` | flinches (`Idle_HitReact_Left`), with a red "!" | whoever is working falls down and gets back up | 1.5 s, then idle |
| `turn-end` / `final` (`done`) | grazes (`Eating`), with grass growing under it | the crew waves and walks off behind the notch | the peek lasts 5 s, then idle |
| hover over the island | looks toward the cursor | everyone stops for a second | — |
| click on a character | — | it jumps and shows its tool and file in a tooltip | — |

## The pasture (nothing running)

No house and no sleeping. When ox is idle, the bull lives on a little pasture
along the island floor and keeps itself busy with small, unhurried
animations. It never jumps: each activity starts where the last one ended,
and the bull turns to face the way it moves.

| Activity | Bull cycle | Weight | Length | What you see |
|---|---|---|---|---|
| Graze | `Eating` | 35% | 6–10 s | Head down; grass tufts sway under its muzzle |
| Wander | `Walk` | 25% | to a random spot | It walks a few body-lengths and stops |
| Look around | `Idle_2` | 15% | 4–6 s | It looks around and flicks its tail |
| Stand | `Idle` | 15% | 3–5 s | It breathes, shifts its weight, swishes its tail |
| Zoomies | `Gallop` | 6% | 1–2 s | A short, happy sprint to the other side |
| Playful kick | `Attack_Kick` | 4% | 1 s | A little buck, as if at a fly |

**The farmer comes by** every 90–150 s. A tiny farmer (straw hat, blue
overalls) walks in from the far edge, stops near the bull and waves. The bull
turns and looks at them (`Idle_2`), and then the farmer walks off the other
way. A farmer visit never happens while ox is working.

Work moods override the pasture straight away: working or thinking walks the
lane, an approval makes it stamp (`Attack_Headbutt`), and done makes it graze.

## Motion rules

- Motion uses the renders' own animation cycles at 24 fps. Characters move
  between spots at a believable walking speed (about 18 pt/s for the ox,
  26 pt/s for the Runner), with an ease-in when they start and an ease-out
  when they stop. They never teleport.
- Characters enter and exit only from behind the notch or past the wing edges.
- When reduce-motion is on, characters stay in place and only change pose.
- No motion while the screen is locked or in fullscreen. The island hides as
  it does today.
- Budget: playing frames is the only per-tick work. Frames are decoded once
  and cached, and the stage timer stops when nothing on it is moving.

## Build plan

1. **Ox:** render the CC0 Quaternius Bull (walk, eat, headbutt, head-low,
   gallop) with `bull_render.py`. *(In progress.)*
2. **Humans:** download the CC0 Quaternius *Ultimate Animated Character Pack*
   (colourful low-poly people with Walk, Run, Idle, Wave, Punch, Sit, Jump and
   Death cycles). This needs your OK. Recolour each character to its palette,
   add props (magnifier, hammer, satchel, clipboard), and render each cycle
   with the same camera.
3. **`NotchStage` in Swift:** a stage model with actors, lanes, targets and
   cycles, driven by Bridge events through the script table above. It
   replaces `OxWalker`'s single walker, and is drawn in the compact wings and
   the expanded floor strip.
4. **Verify live** with the existing `states.sh` and `run-burst.sh` drivers:
   capture each row of the script on the real notch.
