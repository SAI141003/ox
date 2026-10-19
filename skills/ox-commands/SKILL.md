---
name: ox-commands
description: Use ox's own commands when the user wants a website task done (ox browse), an image, video or sound made (ox studio, ox create), the app restyled (ox theme), saved reading or web research (ox library, ox research), a pull request opened or fixed (ox pr), agents hired or given work (ox org), other machines checked (ox mesh), or anything else listed here. ox is installed on this machine.
---
# ox commands

ox is installed (`ox`). When a request matches one of these, run the ox command with the shell instead of doing the work by hand: it is faster, it keeps the user's own settings and keys, and it asks before anything that pays, sends or deletes.

## Make

- `ox studio [models [kind] | recipes [name] | connect]`: open image, video and sound models; recipes for productions
- `ox create "<prompt>" [--edit <image>] [--provider fal|hf|openai|openrouter|local] [--model id]`: make an image or a clip now
- `ox video captions|cut|vertical|highlights|gif|polish <file> …`: edit a video on this machine (ffmpeg, whisper)
- `ox theme ["<look>" | list | use <name> | reset]`: restyle the app from a sentence (neumorphic, glass, paper…)
- `ox clone <url>`: rebuild a website as a Next.js, Vite or plain HTML project

## Web

- `ox browse "<goal>" [--url <page>] [--show]`: the fast browser: does a task on a website, asks before buy, pay or send
- `ox research "<topic>" [--on reddit,hn,youtube]`: what Reddit, Hacker News and YouTube say, with links
- `ox library [add <link|pdf> | search <words> | read <id> | ask <id> "q"]`: your saved articles and PDFs

## Code

- `ox pr open [--title T] [--draft] | status | fix`: branch, checks, push and a pull request; its CI and reviews
- `ox env [show | detect | check]`: how this repo installs, lints, builds and tests
- `ox wiki [--out dir]`: a wiki of this project from its code graph
- `ox graph [update | query "<question>"]`: map the code (files, functions, calls) and ask about it
- `ox race "<task>" --models a,b`: two or more models do the same task in their own worktrees; keep the best
- `ox review`: a code review of your changes
- `ox trace [<id>] [--signals]`: each run: turns, tokens, cost, tool calls, stuck signals
- `ox usage [--days n]`: tokens and spend by model and day

## Agents

- `ox org [hire "<sentence>" | tell <id> "…" | team "<sentence>" | timeline]`: a company of agents: hire, give work, follow it
- `ox task [list | add "<title>" | done <id> | next]`: the task board
- `ox agents`: every agent running on this Mac (Claude Code, Codex, ox…)
- `ox schedule [add <cadence> "<text>" | list]`: runs on a timer
- `ox flow [list | new "<description>" | run <id> | templates | import <id>]`: automations, and n8n templates turned into ox flows
- `ox mesh [describe | agents | ls machine:path | audit]`: your other machines: what they have and run

## Connect

- `ox skill <name> | add <folder|owner/repo> | from <book.pdf>`: skills: read one, install one, or make one from a book
- `ox market [<words> | install <name>]`: search and install skills and plugins
- `ox mcp [ls | add <name> | test <name>]`: MCP servers ox uses
- `ox commands [install [--claude] [--codex] | list]`: these commands, also inside Claude Code and Codex

## Voice

- `ox dictation [show | style <as-said|natural|polished> | translate <language|off>]`: how dictated text is written
- `ox speak "<text>"`: say it out loud
- `ox island [start | stop | status | sound <name>]`: the notch island

## System

- `ox doctor`: checks: keys, models, tools, permissions
- `ox models`: the models ox can use right now
- `ox secure [--diff | <paths>]`: find security problems in this code
- `ox update`: update ox

Every command takes `--help`. Report what the command printed; do not claim a result it did not print.
