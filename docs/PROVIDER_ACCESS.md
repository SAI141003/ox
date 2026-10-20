# How ox connects to each provider

ox never asks for, reads, copies or stores a sign-in token from any AI
provider. It connects in one of four ways, and you pick which.

| Way | Who it is for | What ox does | What ox never does |
|---|---|---|---|
| **API key** | Anthropic, OpenAI, Google, xAI, Groq, DeepSeek, Mistral, OpenRouter and the rest (22 providers) | Sends your requests with your key, from your shell's environment or `~/.ox/keys.json` (mode 600, readable only by your account) | Send the key anywhere but that provider |
| **ChatGPT plan** | ChatGPT Free, Plus, Pro, Team | Runs OpenAI's own Codex program, which you signed in to with "Sign in with ChatGPT". OpenAI allows partner apps to use a plan's allowance this way | Read Codex's login file |
| **Claude plan** | Claude Pro and Max | Only when **you** pick it: runs Anthropic's own `claude` program (Claude Code) on your Mac | Pick it for you, read or reuse its login, or call Anthropic's servers with it |
| **Local model** | Ollama, LM Studio, MLX | Talks to the model server on your own machine | Send anything off the machine |

## The Claude plan, plainly

Since February 2026 Anthropic's consumer terms say that logins from Claude
Free, Pro and Max may be used only in Claude Code and Claude.ai, and Anthropic
has acted against tools that used those logins elsewhere. ox therefore:

- never reads Claude Code's login (its Keychain item or `~/.claude/.credentials.json`);
  a test fails the build if any code reads them (test/provider-access.test.js);
- never picks the Claude plan as the default: a ChatGPT plan comes first, then
  an Anthropic API key, then any other key or a local model;
- shows the Claude plan only as something you choose, and only runs Anthropic's
  own Claude Code with it.

Running your own Claude Code from another program is a grey area that
Anthropic has not ruled on clearly. If you want no doubt at all, use an
Anthropic API key for Claude in ox (Settings › API keys) and keep your Claude
plan for Claude Code itself. ox shows your Claude Code sessions in the island
and the office either way: that only reads the session files Claude Code
writes on your Mac.

## ChatGPT plan

OpenAI's "Sign in with ChatGPT" lets Plus and Pro plans be used in partner
apps, with a weekly cap per app. ox uses it through OpenAI's Codex program (the
command line, or the copy inside the ChatGPT editor extension or the ChatGPT /
Codex app), so the plan's own limits and model choices apply.
