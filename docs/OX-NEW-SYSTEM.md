# ox, as it stands now

ox is a coding agent that has to prove its work. It writes a failing test before a fix, runs it again after, and shows you the result. Use it in a terminal, the desktop app, or by voice from your Mac's notch. It runs on your ChatGPT or Claude plan, on an API key, or on a model on your own machine. There is no account and no telemetry, and your keys stay in `~/.ox/keys.json`.

## What's new

**One page for all your computers.** The new Machines page shows every laptop you've paired and what's running on it, session by session. From there you can read a session on another machine and message it, browse and edit its files, or watch its screen and control it. A save is refused if the file changed while you were editing.

**A main computer you can choose and change.** Any laptop can become main, but only if the owner of the other laptop says yes. Saying yes gives it a set list of permissions, which go back when main moves. Screen and control are never part of the deal. Each one is its own switch on the computer being controlled.

**Asking first.** If a paired machine wants something it hasn't been allowed, its owner gets a card in the app or island with Allow, Always or Deny.

**Connections you can read.** Each machine shows whether it's connected, how fast, and what each side allows. You can disconnect, reconnect without a new code, or remove a machine. Messages between computers say "delivered" only when the other machine confirms it.

**Faster transfers.** Files can now be any size, up from 8 MB, and each is checked with SHA-256 before it takes its name. Bytes on the wire fell from 1.78× the file to 1.00×. On one Mac, downloads went from about 60–100 MB/s to 190–615 MB/s.

**Away from home.** Paired laptops learn each other's addresses and try them in turn, so with Tailscale on both they should find each other from anywhere. Nothing passes through a server of ours.

**Updates that install themselves.** Downloaded copies can now update from inside the app, after a checksum check. A release only goes live once every build has passed. Turn on checks once, or tick automatic.

**Working in any app.** ox reads desktop apps through their accessibility tree and acts on specific controls, using Vercel Labs' agent-desktop. Several agents can work at once, each with its own named cursor. An outline of a Finder window cost 773 tokens against 25,292 for the full tree. Anything that sends, pays or deletes stays yours to press.

**Chats that stay.** Chats and settings now live in a file on your machine, so an update can't lose them.

## The bots system

A bot is simply who answers: a model from a provider, a plan you already pay for, a model on your own machine, your own endpoint, or a model on another of your computers. Pick one, or leave it on Auto and ox chooses for the task. You can also make your own agents.

You choose who gets your prompt. If you name a model and it can't answer, ox only moves to another model from the same provider, or to backups you listed yourself, and it says when it does.

## The memory layer

ox's memory lives on your machine, as a graph of facts rather than a growing pile of notes. When something changes ("works at Stripe" replacing "works at Google"), the new fact takes over and the old one keeps its dates, so ox can still answer what was true in March.

A short profile goes in front of every run, so ox starts already knowing you.

A background pass runs every six hours and never deletes anything. It folds duplicates together and retires events whose day has passed. Facts that keep getting used grow stronger, and ones nobody uses go quiet. A lesson only becomes a how-to procedure after it has been verified twice.

## How we keep token use down

- **A small prompt.** In a side-by-side test against another open-source agent on the same model, ox sent about 2,400 tokens on the first request instead of about 11,000. Cost over a whole task hasn't been compared yet.
- **Only the tools a turn needs.** A simple turn might get 8 tools out of 49, and that list stays the same across a session.
- **Skills as an index.** Hundreds of skills cost around 600 tokens a turn, because only an index is sent.
- **Keeping out of other tools' way.** Skills from ox's big library now live in ox's own folder. That cut a ChatGPT plan test task from about 42,000 tokens to 31,000, and full-price tokens by 57%. The rest is mostly that plan's own prompt, so a plan run will always use more than a direct model call.
- **Answers from a graph.** Asking the code graph took 132× fewer tokens than opening whole files, on five questions about ox itself. For docs and memory, the figure was 39×.

Not everything wins. On a small Finder window, ox's text view of the screen cost more than a screenshot would (915 tokens against 103 to 255), so that saving depends on the window.

## What hasn't been proven yet

Most of the mesh has only run as two apps on one Mac. Between two real laptops we've tested the link and listing sessions, on Wi-Fi only. The away-from-home path hasn't run over real Tailscale. Screen control between two laptops hasn't been tried, only on one Mac. In-app updates are Mac-only for now; Windows and Linux reinstall. The Windows installer hasn't run on Windows, and the Mac app isn't notarized.
