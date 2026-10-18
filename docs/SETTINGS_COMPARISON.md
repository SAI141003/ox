# ox Settings, side by side with ChatGPT, Claude and Hermes

October 17, 2026. ox from its own app (checked page by page in a running copy);
Hermes from its real config on the owner's Mac (`~/.hermes/config.yaml`, 70+
settings); ChatGPT and Claude from their help centres
([ChatGPT memory](https://help.openai.com/en/articles/8590148-memory-in-chatgpt),
[ChatGPT data controls](https://help.openai.com/en/articles/7039943-how-openai-handles-data-in-consumer-services),
[Claude memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context),
[Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities),
[Claude incognito](https://support.claude.com/en/articles/12260368-use-incognito-chats)).

✓ has it · ~ partly · ✗ does not · **new** = added to ox in this round.

| Setting | ChatGPT | Claude | Hermes | ox |
|---|---|---|---|---|
| **Models and keys** | | | | |
| Choose the model | ✓ (its own) | ✓ (its own) | ✓ | ✓ any of 31 providers, local models, plans |
| Bring your own API key | ✗ | ✗ | ✓ (config file) | ✓ **37 providers** in the app, each with Get a key, Test, Use (**new**) |
| See what a key unlocks before using it | ✗ | ✗ | ✗ | ✓ Test lists its models (**new**) |
| Use a plan you already pay for | — | — | ✗ | ✓ Claude, ChatGPT, Cursor and 13 more CLIs |
| Custom / self-hosted endpoints | ✗ | ✗ | ✓ | ✓ with Test |
| Fallback model when one fails | ✗ | ✗ | ✓ | ~ in config (`fallbackTargets`), not in the app yet |
| Prompt caching | automatic | automatic | ✓ toggle | ✓ automatic (**new**), `OX_PROMPT_CACHE=0` off |
| **You** | | | | |
| Custom instructions / how to respond | ✓ | ✓ | ✓ (SOUL.md) | ✓ **Instructions** page, every chat, terminal and plans (**new**) |
| Memory: view, add, forget | ✓ | ✓ | ✓ | ✓ |
| Temporary / incognito chats | ✓ | ✓ | ~ | ✓ |
| Name it | ✗ | ✗ | ✗ | ✓ (and the voice wake word follows) |
| **Tools** | | | | |
| Connectors (MCP servers) | ✓ apps | ✓ | ✓ | ✓ **Connectors** page (**new**); Marketplace of 1,129 |
| Web search provider | built in | built in | ✓ | ✓ keyless, or Tavily / Brave / Serper / Marginalia keys (**new** on the page) |
| Images and video | ✓ | ✗ | ✓ | ✓ fal, Higgsfield, OpenAI, Gemini |
| Approvals / permissions | ✗ | ~ | ✓ allowlist | ✓ modes and approvals; command allowlist in config only |
| Scheduled tasks | ✓ | ✗ | ✓ cron | ✓ Scheduled page |
| **Looks and voice** | | | | |
| Theme, text size | ✓ | ✓ | ✓ | ✓ plus width and motion |
| App language | ✓ | ✓ | ✗ | ✗ (English only) |
| Voice, read aloud | ✓ | ✓ | ✓ | ✓ 54 natural voices, offline |
| Keyboard shortcuts | ✓ | ✓ | ✗ | ✓ |
| **Your data** | | | | |
| Export your chats | ✓ | ✓ | ~ | ✓ JSON or Markdown (**new**) |
| Delete all chats | ✓ | ✓ | ✓ | ✓ (**new**) |
| Archived chats | ✓ | ✗ | ✓ | ✓ |
| Training on your chats | opt out | opt out | n/a | never: no account, no telemetry |
| Usage | ~ | ✓ | ✓ | ✓ by day, model, agent, place, project |
| **Reach** | | | | |
| Messaging apps | ✗ | ✓ Slack | ✓ 5 (Slack, Discord, Telegram, Mattermost, Matrix) | ✓ 3 (Slack, Discord, Telegram) |
| Check for updates | automatic | automatic | ✓ | ✓ button in About (**new**) |
| Settings search | ✓ | ~ | ✗ | ✓ pages and providers (**new**); it used to find page names only |

## Fixed in this round

- API keys: the provider search did nothing (CSS overrode the `hidden`
  attribute); there was no way to add a web-search key; no link to get a key,
  no test, no way to start using a model from the page. All fixed and checked
  in the app (OpenRouter: Test listed 471 models; Use set a free model that
  then answered).
- Settings search found page names only; now providers too, and says when
  nothing matches.
- A slow page finishing late could replace the page you had moved to.
- Your instructions were not a feature; now they are, and they apply to quick
  answers too (the first version was silently left out of them: found by
  checking with a stand-in model, then a real answer in French).

## Still behind, in order

1. **App language**: ChatGPT and Claude have one; ox is English only.
2. **Messaging**: Hermes reaches Mattermost and Matrix; ox does not.
3. **Fallback model and command allowlist** exist in config but not in the app.
