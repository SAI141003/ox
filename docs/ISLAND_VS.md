# OX Island side by side: Coucou, Pixie, Hey Clicky

October 18, 2026. Built from the owner's recordings (frames and speech, all
watched) and the island's own source, read line by line. The three are
different products and are kept apart here:

- **Coucou**: Louis-CFM/coucou, MIT. The notch app with the Mochi character.
  Recordings F2.1, F2.2, F2.3, F3.6 and the October 16–17 batch (section A).
- **Pixie**: agentmaxxing's "buddy", called by name. Recording F2.4: "Hey Pixie,
  play Billie Jean", "make yourself smaller and turn down the volume", "open my
  to-do list", "explain this YouTube video, draw circles and arrows".
- **Hey Clicky**: farza's screen buddy. Recording F2.6 (and B in section B):
  "write the reply in my Gmail box in my voice", "type a good follow-up prompt
  into the Claude Code terminal and explain it", skills (a YC skill).

Coucou's name, Mochi, art and sounds are its own; ox takes ideas and MIT code
only. Pixie and Clicky: ideas only (no licence seen).

States: ✓ the island has it, checked · ~ partly · ✗ missing · → being built

## What each one does, and the island

| Feature | Coucou | Pixie | Hey Clicky | OX Island |
|---|---|---|---|---|
| Lives in the notch, opens on hover | ✓ | ✓ | (a cursor buddy, not the notch) | ✓ |
| A character with moods | Mochi: happy jump when done, sad on errors | Pixie: eyes in the notch | Clicky beside the cursor | ✓ the ox, moods for thinking / working / needs you / done / error; poke reactions |
| Called by name ("Hey …") | "OK Coucou" | "Hey Pixie" | "Hey Clicky" | ✓ "OK ox", or any name you give it ("call yourself Pixie") |
| Play a song by voice | ✓ | ✓ "play Billie Jean", album-art card | — | ✓ plays it (offline, 0.1 s); ~ no album-art card yet |
| "Make yourself smaller" | — | ✓ (with "and turn down the volume") | — | ✓ both halves now (F4.2; was only the first) |
| Volume by voice, "just a little bit" | ✓ | ✓ | — | ✓ (fixed today: "just a little bit" was missed) |
| Today's to-dos read aloud | — | ✓ | — | ✓ |
| Explain what is on screen | ✓ (asks about the screen) | ✓ and **draws circles, arrows and labels over the video** | ✓ uses the screen to write | ~ sees the screen, points with one arrow → **drawing several marks over the screen** |
| Write into the box you are typing in | — | — | ✓ Gmail reply in your voice | ~ dictation pastes your words → **"write it for me" (a draft you send)** |
| Type a follow-up prompt into a terminal and explain it | — | — | ✓ | ✗ → same paste path, never presses Enter |
| Skills inside the buddy | — | — | ✓ YC skill | ✓ ox skills and Marketplace |
| Approve Claude Code / Codex / Cursor from the notch: Allow / Deny / Always | ✓ | — | — | ✓ built (`ox hooks install claude`…), install is your step |
| Answer an agent's multiple-choice question in the notch | ✓ | — | — | ✗ → |
| Live feed of what agents read, edit, run | ✓ | — | — | ✓ ox runs; ~ other agents through hooks |
| Done: a happy animation | ✓ | — | — | ✓ done mood |
| Lock screen / iPhone approvals | ✓ beta | — | — | ✗ needs a phone app |
| Dictation: hold a key, talk, pasted | ✓ (Parakeet, offline) | — | — | ✓ ⌃⌥D and Fn, on-device |
| Hands-free (double tap), Esc cancels, paste last again | ✓ | — | — | ✗ → |
| Learns your words | ✓ | — | — | ✓ dictionary and snippets |
| Dictation stats (words, time saved) | ✓ | — | — | ✗ → |
| Call notes, summary and to-dos | ✓ mic and computer audio | — | — | ~ mic only |
| Mail in the notch: read, reply, mark read, open in Mail | ✓ | — | — | ~ unread count, drafts → **mail card** |
| "Did anybody pay me today?" (Stripe) | ✓ | — | — | ✗ needs your Stripe key |
| Email drafted from one sentence, you press Send | ✓ | — | — | ✓ (fixed today: "write an email to Camille, tell her it's done") |
| Plan usage gauges (Claude, Codex) and alerts | ✓ | — | — | ✓ Codex; Claude via relay; alerts at 80 / 95 % |
| Character stressed past 80 % of a limit | (Claudex) | — | — | ✗ → |
| Weekly recap | ✓ | — | — | ✗ → |
| Windows / Linux | ✓ | — | — | ✗ (macOS; ox itself runs everywhere) |
| No account, no telemetry | ✓ | ? | ? | ✓ |
| Checks itself, gets better from real use | — | — | — | ✓ `ox island evals` (22/22 errands, 27/27 commands), `ox island learn`, `ox island evolve` |
| Many agents at work, shown as an office | — | — | — | ✓ pixel office with a desk per helper |
| Local and cloud models, any provider, plans | Claude Code etc. | ? | ? | ✓ 37 providers, local models, plans |

## Where the island is ahead

- One brain for everything: the same ox runs the terminal, the app, the island
  and the phone, with its tools, memory, skills and approvals.
- Small things are done with no AI at all, in about a tenth of a second, and
  offline (time, timers, apps, songs, volume, notes, to-dos, mail drafts).
- It measures itself (evals) and keeps a change only when it measures better.
- A team of agents is visible (the office), not only one run.

## Where it is behind, and being built (in order)

1. Drawing on the screen while explaining (Pixie)
2. "Write it for me" into the focused box, and a follow-up prompt into a terminal (Hey Clicky); drafts only, you send
3. Agent questions answered in the notch (Coucou)
4. Hands-free dictation, Esc to cancel, paste last again; dictation stats (Coucou)
5. Mail card in the notch (Coucou)
6. Stressed character past 80 % of a plan limit (Claudex)
7. Weekly recap (Coucou)
8. Album-art card when a song plays (Pixie)
