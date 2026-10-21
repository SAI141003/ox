---
name: screen-recall
description: Use when the user asks ox to remember what is on their screen now ("remember this", "save what I'm looking at"), or to find something they saved from their screen before ("what was that error I saw", "the price I was looking at"). On request only; ox never records the screen in the background.
---
# Screen recall (on request)

ox keeps what you asked it to remember from your screen, as notes in ox brain,
so you can search it later in plain words. Nothing is captured unless you ask,
one time per ask; there is no background recording.

## Remember what is on screen
1. Take one screenshot with the `screenshot` tool (the front window, unless the
   user said the whole screen).
2. Read it and write down what matters in words: the app and page, the text that
   was shown, numbers, names, errors, links.
3. Leave out anything private: passwords, keys, card or account numbers, one-time
   codes, other people's messages unless the user asked for them. If the window
   is a password manager, bank or sign-in page, say so and save nothing.
4. Save it with the `brain` tool, action `note`: title "Seen: <what it was>",
   body the words from step 2, tags `screen` and the app's name, and the time.
   Do not keep the image itself.

## Find something seen before
Use the `brain` tool, action `search`, with the user's words. Answer from the
notes and say when each was saved ("Seen on Oct 20 at 3:12 pm in Safari").

## Forget
"Forget that": find the note and mark it replaced (supersedes) with a note that
says it was removed at the user's request; tell the user where the file is if
they want it gone from disk too.
