# Real tool and provider audit — 2026-10-21

## Scope and evidence

This is a bounded audit of the Ox checkout on this Mac, not a claim to have tested every tool or provider in existence. Ox has 35 model-provider adapters and nine real-agent benchmark tasks. The full hermetic test suite exercises the supported local tool contracts; live model runs require an authenticated and reachable backend.

The real benchmark used `bench/real/runner.mjs`, which starts Ox in a disposable workspace, sends real requests to the selected backend, and grades the actual files and command results left behind. It does not grade model prose. Real runs used one repeat each; results below are observations, not statistical confidence estimates.

## Live backend results

| Backend / task | Wall time | Main-agent tokens in/out | Tool calls | Provider cost | Result |
|---|---:|---:|---:|---:|---|
| Ollama `qwen2.5:3b-64k`, `debug-and-fix` | 154.7 s | 14,469 / 521 | 3 | $0 model charge reported; hardware/electricity excluded | Failed; misdiagnosed the divisor bug and proposed an edit whose old text did not exist. |
| Ollama `qwen2.5:1.5b`, `read-and-report` | 38.0 s | 6,289 / 182 | 1 | $0 model charge reported; hardware/electricity excluded | Failed; hallucinated a temporary absolute path and never wrote the required answer. |
| Ollama `qwen2.5:3b-64k`, `read-and-report` | 53.0 s | 6,329 / 151 | 4 | $0 model charge reported; hardware/electricity excluded | Failed; final prose gave the right value, but `answer.txt` contained `300000`. |
| Ollama `qwen2.5:3b-64k`, repeated `read-and-report` | 84.5 s | 10,193 / 222 | 5 | $0 model charge reported; hardware/electricity excluded | Failed; emitted pseudo-code instead of the value, then left `answer.txt` blank. |
| Ollama `qwen2.5:3b-32k`, `read-and-report` | 58.8 s | 11,671 / 155 | 4 | $0 model charge reported; hardware/electricity excluded | Passed; hidden value was written exactly to the required file. |
| Ollama `qwen2.5:3b-32k`, `debug-and-fix` | 100.9 s | 19,679 / 511 (run total) | 1 | $0 model charge reported; hardware/electricity excluded | Failed; delegated to a subagent but never edited or fixed the file. The original per-request table omitted 12,895 / 343 subagent tokens; the benchmark now attributes that aggregate as its own nested-agent row. |
| Ollama `qwen2.5:3b-32k`, `debug-and-fix` (fresh approved run) | 180.1 s | 20,217 / 742 | 3 | Unpriced local inference; no metered provider bill | Failed; timed out, made three tool calls, and left the `movingAverage` fixture failing. First text arrived at 87.1 s; mean tool duration was 14.5 s. |
| Ollama `qwen2.5:3b-64k`, `exact-edit` | 104.9 s | 12,673 / 286 | 4 | $0 model charge reported; hardware/electricity excluded | Failed; wrote an unrelated new file instead of editing the two required constants. |
| Ollama `qwen2.5:3b-64k`, `multi-file-refactor` | 36.8 s | 6,797 / 164 | 0 | $0 model charge reported; hardware/electricity excluded | Failed; no tool calls; rejected batch error surfaced before edits. |
| Ollama `qwen2.5:3b-64k`, `create-runnable-script` | 240.6 s | 12,270 / 1,153 | 3 | $0 model charge reported; hardware/electricity excluded | Failed and timed out at the task’s 240 s cap; generated script produced no expected output. |
| Ollama `qwen2.5:3b-64k`, `add-feature-to-spec` | 85.6 s | 8,761 / 255 | 5 | $0 model charge reported; hardware/electricity excluded | Failed; inserted an undefined helper and the fixture test still failed. |
| Ollama `qwen2.5:3b-64k`, `recover-from-broken-state` | 240.3 s | 5,648 / 141 | 1 | $0 model charge reported; hardware/electricity excluded | Failed and timed out at the task’s 240 s cap; syntax error remained. |
| Ollama `qwen2.5:3b-64k`, `discipline-dont-touch` | 179.2 s | 17,768 / 647 | 5 | $0 model charge reported; hardware/electricity excluded | Failed; broke an existing export while adding the requested function. |
| Ollama `qwen2.5:3b-64k`, `multi-step-plan-execute` | 304.1 s | 9,921 / 256 | 3 | $0 model charge reported; hardware/electricity excluded | Failed and timed out at the task’s 300 s cap; release checklist was untouched. |
| Claude subscription CLI, `debug-and-fix` | 6.8 s | 0 / 0 | 0 | No model request | Not runnable: CLI reported `Not logged in` inside Ox’s isolated benchmark environment. |
| OpenRouter key check | 0.2 s | — | — | No tokens generated | Rejected with HTTP 401. |
| Cursor CLI status | immediate | — | — | No model request | Not runnable: CLI reported `Not logged in`. |

Local model “$0” means no provider token charge was reported; it is not a claim of zero total cost. No successful paid-provider completion was available, so comparative paid cost-per-task, token efficiency, and provider latency remain unmeasured. Claude credentials were not copied into the benchmark environment.

Across the **nine distinct real-agent task types**, `qwen2.5:3b-64k` passed **0/9**. The six-task second sweep consumed 61,165 input / 2,616 output tokens over 1,086.8 seconds (18.1 minutes) and used 17 tool calls. Including the first four 3B attempts and repeated read task, the observed 3B attempts consumed 104,829 input / 3,796 output tokens over about 24.7 minutes. These are workload wall times, not model-only token-generation latency; they include Ox’s round trips and tool execution. The 1.5B model also failed its one sampled task.

The repeated 3B read run was preserved at `/var/folders/_h/jzzmdxjd3c5f5bx97h4k658r0000gn/T/ox-realbench-read-and-report-Ze92di` for inspection. It demonstrated why output verification matters: the agent claimed completion while the filesystem contained an empty answer.

## Fixes made during this audit

- Unknown prices for billable/remote models now classify as `unknown`, rather than `free`, so `fallback_policy.cost=free_only` fails closed. Keyless local providers and explicit `$0` rows remain free.
- OpenRouter credential validation now checks `GET /api/v1/key`, then fetches the public model catalog. The old [`/credits` endpoint](https://openrouter.ai/docs/api/api-reference/credits/get-credits) requires a management key and is unsuitable for ordinary inference keys; [`/key`](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) is the current-key endpoint. Neither response’s key metadata nor budget data is returned to the UI.
- The CLI integration test retries temporary-home removal when macOS reports `ENOTEMPTY` while an npm-backed helper is still settling.
- Re-audited hard-coded Claude token prices against [Anthropic's current API pricing](https://platform.claude.com/docs/en/about-claude/pricing). Ox had assigned `claude-haiku-5-5` $0.10/$0.50 per million tokens, while the provider currently documents Haiku 4.5 at $1/$5 standard and $0.10 only for cached-input reads. Removed the unverifiable Claude 5.x price rows so cost caps report unknown instead of reusing rates for a different model/usage tier; retained the exact public `claude-haiku-4-5` standard row and its cache discount logic. This audit does not establish that those removed model IDs are invalid, only that their prices could not be verified against the provider's public pricing page.
- Cross-checked current official [xAI pricing](https://docs.x.ai/developers/pricing) and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). The default built-in prices omit some tier/long-context distinctions, so treat the estimator as a standard-rate estimate, not an invoice-grade maximum; provider-side usage can vary with request size, caching, service tier, and other billable tools.
- Updated Ox's Gemini Flash default to `gemini-3.8-flash`: Google says 3.7 is deprecated and requests are automatically routed to 3.8. Corrected the standard rate from $0.38/$1.88 (a lower-cost tier, not standard) to the published $0.75/$3.75 promo rate through December 31, 2026, and made that row fail closed as unknown after its announced expiry. The provider says standard pricing increases to $1.50/$7.50 on January 1, 2027. See Google's [deprecation notice](https://ai.google.dev/gemini-api/docs/changelog) and [pricing table](https://ai.google.dev/gemini-api/docs/pricing).
- Updated DeepSeek V4 Pro's context window from 128K to 1M based on its current [official model/pricing table](https://api-docs.deepseek.com/quick_start/pricing/). The built-in $1.32/$3.96 rate is the published peak cache-miss/output rate; off-peak and cache-hit rates vary, so the cost display is conservative, not invoice-exact.
- Added two independently graded real runs for the additional local Qwen 3B/32K model. They show a read task can pass while a code-fix task fails. Its saved stream exposed that the parent run's `usage-total` includes nested subagent usage while request events are folded; `bench/real/lib.mjs` now uses `subagent-end` to attribute those tokens and `bench/real/runner.mjs` displays them in a separate nested-agent column. Reprocessing the exact saved stream reconciles 6,784 main + 12,895 nested = 19,679 total input tokens, and 168 main + 343 nested = 511 total output tokens.
- After the user explicitly approved local Ollama for this test, ran a fresh `debug-and-fix` benchmark against `qwen2.5:3b-32k` in an isolated temporary workspace. It timed out at the configured 180-second limit, used 20,217 input / 742 output tokens across the parent and nested agent, made 3 tool calls, and failed the executable grader. First generated text arrived after 87.1 seconds; mean tool-call duration was 14.5 seconds. The run is preserved at `/var/folders/_h/jzzmdxjd3c5f5bx97h4k658r0000gn/T/ox-realbench-debug-and-fix-MNg2uN`; this is one sample, not a stable latency estimate.

## Verification

- Focused provider, cost, and fallback-routing suites after the new end-to-end policy case: **35 passed, 0 failed**.
- After the official-price audit, model migration, and expiry safeguards, the cost, model-window, bot-preset, and routing suites pass **72/72**.
- Full suite after all provider-pricing and benchmark-accounting changes: **2,185 passed, 0 failed, 249 skipped** (2,434 tests, 226.98 seconds).
- CLI integration suite: **8 passed, 0 failed** after disabling MCP startup in that hermetic CLI fixture and retaining temporary-directory cleanup retries.
- Full suite with test isolation, color enabled, and the repository mutation guard skipped: **2,182 passed, 0 failed, 249 skipped** in 218.3 seconds. The repository guard is skipped here because it recursively re-runs test files; run it separately under the project’s documented guard-test conditions.
- `git diff --check`: clean.

The full-suite command was:

```sh
env -u NO_COLOR OX_ISLAND=0 OX_LEARN=0 OX_NO_KEYSTORE=1 OX_USAGE_LOG=0 \
  OX_MEMORY_HOME=/tmp/ox-test-memory OX_NO_BUILTIN_SKILLS=1 OX_NO_PLUGINS=1 \
  OX_COLOR=1 OX_SKIP_REPO_GUARD=1 \
  node --test --test-concurrency=2 --test-reporter=spec test/*.test.js
```

## What is not yet verified

Only Ollama is configured locally, and those small local models did not pass any of the nine sampled coding-agent tasks. The saved OpenRouter key is invalid. Claude and Cursor CLIs are installed but not authenticated for the isolated run; Codex CLI could not start in the observed environment; Gemini CLI and LM Studio were not installed. Therefore the other provider adapters are covered by deterministic contract tests, not live inference tests. Live price comparisons and model rankings require working credentials and repeated identical tasks across the chosen providers.

Current read-only machine check: **35 provider adapters** are declared in `src/providers/index.js`; an inventory check finds **37 registered built-in tools** in `src/tools/index.js`, and each tool name appears in at least one test file (this is only a name/reference coverage check, not proof of end-to-end live correctness). Ollama `/v1/models` answered with five local models (`qwen2.5:3b-64k`, `qwen2.5:3b-32k`, `qwen2.5:3b`, `SmolLM2-135M-Instruct`, `qwen2.5:1.5b`). LM Studio, llama.cpp, and vLLM endpoints were not answering. An OpenRouter `/api/v1/key` credential check returned HTTP 401; no inference request was sent.

## Fresh machine checks — 2026-10-21

Follow-up commands were run against the current Mac and local Ox configuration:

- `ox doctor` found Ox's configured Ollama service (0.40.8) and five local models,
  but explicitly reported that `http://localhost:11434` is **not approved**. Ox
  correctly refused to send model requests. The configured `ox-ollama` preset
  points at `qwen2.5:0.5b`, which is not installed; the installed model list is
  shown by `ox doctor`. I did not approve the endpoint or bypass that trust gate.
- The same doctor run live-probed keyless web capability routes: Marginalia and
  Wikipedia search returned usable rows; direct fetch and Jina Reader returned
  HTTP 200 text. DuckDuckGo's HTML route returned an anti-bot challenge (HTTP 202)
  and was correctly marked unusable. The sample probe latencies ranged from about
  114 ms to 1.45 s; these are one-shot health probes, not a statistically valid
  latency benchmark.
- `ox mcp ls` showed one configured server, `rea`, risk class `write`, with 200
  tools. `ox mcp test rea` completed initialization plus `tools/list` in 2,636 ms.
  No MCP operation was invoked: this proves discovery/handshake only, not that 200
  tool implementations work, and executing write-risk tools would require specific
  task authorization and safe fixtures.
- `ox models hw` reports Apple M3, 16 GB unified memory, 8.2 GB model budget, and
  approximately 100 GB/s bandwidth. `ox models recommend --task small` returned
  eight Hugging Face model candidates and estimated throughput (roughly 16–50
  tokens/s for the listed sizes). Those are sizing estimates, **not measured Ox
  inference throughput**; no model was downloaded or run from this command.
- `ox usage --days 7` reported 6.22M input / 16.2K output tokens across 204 runs,
  estimated total $6.02. The largest priced row was `claude-haiku-4-5` (6.00M
  input / 2.5K output, $6.02); local models were unpriced, not necessarily zero
  total cost. The usage report includes prior project activity, not only this
  audit, and provider-reported usage can differ from Ox's estimate.
- `ox schedule list` showed one enabled daily schedule due now, but the daemon-wide
  schedule policy is not opted in; it will not run. `ox flow list` found no flows.
- A built-in inventory script counted 37 unique built-in names (34 static schemas
  plus dynamic names) with implementation handlers; every name occurs in at least
  one test file. This measures name/reference coverage only. It does not establish
  that every tool is tested end-to-end, every failure mode is covered, or every
  external integration is live.
- `ox trace 20261021T182246-133e72` reported one completed CLI turn, 7 seconds,
  18.1K input / 42 output tokens and zero tool calls. This is a single historical
  turn, not a comparative latency result.

The initial `ox secure --diff` scan found one medium `js-eval` warning in a test
that compiles inline scripts from the local test server using `vm.Script` solely to
check syntax; it never runs those scripts. The line now has a reasoned
`ox-secure-ignore` annotation. Re-running `ox secure --diff` returned **no
findings in 35 changed files**, and `node --test test/resource-class-coverage.test.js
test/security-scan.test.js test/serve-web-chat.test.js` passed **19/19**.
`git diff --check` is clean.

This still does not constitute a universal “all tools” certification. Paid-provider
comparisons remain unavailable without valid provider credentials; the local Ollama
endpoint was approved for this bounded test and the newly measured coding task failed;
and write-risk MCP functions have not been called.

## Approved local inference follow-up — 2026-10-21

The earlier doctor observation that Ollama was unapproved is historical. The user
subsequently approved `http://localhost:11434` for the benchmark; Ox confirmed the
trust setting was saved. I ran one additional independent `debug-and-fix` sample with
`qwen2.5:3b-32k` using the benchmark's temporary HOME/XDG directories, isolated source
fixture, hard timeout, and executable grader. The task remained failing at the 180-second
timeout, so the approval did not change the coding outcome. No Ox repository source was
included in the prompt or written by the benchmark. The run's event stream and fixture
are retained in the temporary sandbox path in the results table's supporting notes.

## Verification-harness follow-up — 2026-10-22

The repository's documented full gate, `node scripts/verify.mjs`, now passes all stages
on this Mac: syntax (548 files), smoke (6 entry points), unit (2,194 passed, 0 failed,
0 cancelled), deterministic benchmark (25/25), and live local-Ollama check (PONG).
The deterministic benchmark artifact is
[`bench/results/2026-10-22T02-04-03-413Z/RESULTS.md`](../bench/results/2026-10-22T02-04-03-413Z/RESULTS.md).
It records 10.1 seconds suite time, 73,800 input / 18,380 output simulated tokens, and
$0.2579 modeled cost. These are deterministic fixture values using a simulated
`grok-4.6` response; they are **not** measured live-provider latency or real billing.

This pass also corrected test-harness problems exposed by the persisted Ollama trust
approval: the unit runner now isolates HOME, Ox config, and memory so developer-local
approvals, skills, or plugins cannot affect tests; the package test command is
cross-platform; and the island dictation route test injects a deterministic transcriber
instead of depending on an installed speech model, `say`, `ffmpeg`, or shared temporary
files. The interactive verification loop now uses the repo's 40-minute test ceiling
instead of terminating the full suite at 120 seconds, and renders a missing process exit
code as `n/a` rather than misleadingly reporting zero. Focused tests cover those cases.

The separate real `debug-and-fix` attempt against local `qwen2.5:3b-32k` remains a
failure at 180 seconds (see above); a passing synthetic canary does not override that
result. Paid/cloud providers remain unavailable for live comparison without valid
credentials. Nor does the 25-case deterministic canary prove every registered tool or
all provider adapters work against live services. A source audit confirmed a concrete
`web_task` defect: the `browser-harness` and `camoufox` branch asks the *remote page*
to POST to `http://localhost:__OX_PLANNER_PORT__/plan`, but no planner server or port
substitution is wired into Ox. Thus those backends cannot produce actions in the normal
path. The default `fast` backend is separate and has a local-Chrome integration test, but
that test exercises `fast-browser.js` directly rather than the `web_task` wrapper. The
low-reference mail/task-board tools still need broader integration coverage; write-risk
MCP operations remain intentionally uncalled absent an authorized task and safe fixture.

## Browser planner repair — 2026-10-22

The `web_task` planner gap found above is repaired in the working tree. Agent turns now
provide a planner callback bound to the *currently active* Ox target (including a model
switch after escalation), and the browser tool uses it instead of making a page-side
request to a placeholder localhost port. Planner usage is included in the run's token,
cost, and usage events. Legacy MCP browser backends now fail before startup with an
actionable message when called outside an Ox agent context. The default `fast` backend
uses the same selected agent model rather than requiring a separate `OX_FAST_BROWSER_KEY`.

Regression coverage was added for wrapper-level fast-browser execution with an injected
browser and decider, the independent checked-DONE request, and the clear failure path
without an Ox planner. Those tests plus the real-Chrome fast-browser workflow and core
agent tests pass (22/22). After the repair, `node scripts/verify.mjs` passes syntax
(549 files), smoke (6 entry points), unit (2,196 passed, 0 failed), deterministic bench,
and the live Ollama PONG check. This validates the integrated test harness and local
runtime; it does not convert the earlier timed-out real coding task into a pass.

A second-level integration test drives a complete `runAgent` turn against a local
OpenAI-compatible fixture server: the main model requests `web_task`, both browser
decisions return through the same active target, and the final turn totals include all
four requests. With synthetic usage (2 main requests × 4,000 input / 10 output and 2
planner requests × 4,000 input / 5 output) and an explicit `$2/$4 per million` test
price override, the event stream reports 16,000 input / 30 output and `$0.03212`.
These values prove accounting propagation in the test fixture, not an actual provider
invoice or live network run.

## Additional local-model latency/correctness samples — 2026-10-22

After the earlier coding-task timeout, I ran the exact same isolated `read-and-report`
grader against two more installed Ollama models. Both are single samples (no repeated
trials, so not stable performance estimates); Ollama does not report per-request price,
so cost is unknown rather than zero.

| Model | Verdict | Agent wall time | First text | Tools / turns | Tokens in/out | Grader result |
|---|---:|---:|---:|---:|---:|---|
| `qwen2.5:1.5b` | FAIL | 32.9 s | 31.5 s | 1 / 2 | 7,518 / 58 | Did not find/write the required value |
| `qwen2.5:3b-64k` | FAIL | 84.3 s | 79.2 s | 5 / 3 | 12,127 / 200 | Wrote `20000`, expected `7314`; 2 tool calls errored |

Together with the earlier `qwen2.5:3b-32k` debug-and-fix timeout (180 s), current live
evidence is that these local models can be slow and/or fail objective coding/retrieval
tasks on this setup. It does not establish rankings against cloud providers; no valid
hosted credentials are currently available for a controlled comparison.

## Tool inventory and new real-media coverage — 2026-10-22

Current code exports 37 registered built-in tool implementations. A name-to-test-file
scan is useful triage but not coverage proof: many references are generic schema or
resource-class tests. It highlighted `edit_video` as having no dedicated media-output
test (the only prior test-file reference was the generic tool inventory). Added
`test/video-tool.test.js`, which creates a two-second audiovisual fixture with the
installed ffmpeg, invokes `edit_video` through its actual tool handler, checks the
reported sibling output with ffprobe, verifies its duration reflects 2× speed, and
SHA-256 checks that the source bytes did not change. It also checks malformed-op and
missing-file errors. Both tests passed on this Mac. The package's test wrapper now
respects explicit test-file arguments (instead of accidentally running the whole suite
as well), which made targeted reproduction reliable.

The current machine inventory still has only Ollama as a usable inference service.
`ox doctor` reports one key set (OpenRouter), but a fresh non-billing GET to its key
status endpoint returned **HTTP 401, `User not found.`** No prompt or inference request
was sent. The other remote adapters shown by `ox doctor` have no configured keys. This
makes a controlled live cost/latency comparison across the provider market presently
impossible; local
Ollama reports no per-request price, and the real benchmark correctly records cost as
unknown rather than `$0`.

The settings tests exposed and fixed a separate intermittent CI cause: their randomly
chosen high port could already be serving an unrelated local app. The test silently
accepted any HTTP response, so it sometimes parsed a WebSocket server page as JSON. It
now starts Ox on port 0, waits for the actual bound port, and `ox serve` reports that
actual port. The settings tests passed in isolation and the full gate then passed:
syntax (550 files), smoke (6 entry points), unit (2,199 passed, 0 failed), deterministic
benchmark, and live Ollama PONG. `ox secure --diff` found no findings in 54 changed
files.

The configured `rea` MCP server was re-tested read-only: initialize plus `tools/list`
completed in 2,163 ms and advertised 200 tools. No MCP `tools/call` was made; this is a
handshake/list latency only, not proof those 200 actions work. Many are write-capable
binary-analysis operations, so exercising them needs an explicit safe fixture and an
authorized target rather than probing the user's currently selected Hopper document.

The expanded real-media test now exercises the registered `edit_video` handler against
local ffmpeg-generated fixtures for speed, cut, vertical crop, GIF, polish, video-frame
extraction, silent transcription, invalid operation, missing media, invalid cut bounds,
and invalid highlight query. It validates output existence/metadata with ffprobe and
checks SHA-256 of the source after each successful edit; targeted tests pass 3/3. The
test intentionally does not claim semantic speech accuracy: captions and positive
spoken-word highlights require an installed speech-to-text model and a fixture with
known speech, neither of which was available in this test setup. `understand` produced
readable local frame files; its transcript portion remains dependent on the same
unavailable speech stack.

After moving highlight-query validation ahead of transcription, the complete project
gate passed again: syntax (550 files), smoke (6 entry points), unit (2,200 passed,
0 failed/cancelled), deterministic benchmark, and local Ollama PONG. `ox secure --diff`
reported no findings in 55 changed files; `git diff --check` was clean. This gate
validates the current checkout, not every possible user media file or speech model.

The `social_research` handler previously had only generic name/schema references in
the tests. It now accepts injected fetch/environment dependencies and has handler-level
coverage for encoded search terms, its public Hacker News and Reddit endpoints,
independent partial-service failure, safe untrusted-content framing, and empty-query
rejection without network access. The focused suite passes **2/2**. A separate live,
read-only `ox research "local AI coding agents tool latency token cost" --on
reddit,hn,youtube` returned three Hacker News items and six YouTube items; Reddit
returned no matches. A timed one-query Hacker News probe completed in **0.47 s** but
returned no rows. These are individual service observations, not stable latency or
coverage guarantees.

Following this addition, the full verification gate passed again: syntax (551 files),
smoke (6 entry points), unit (2,202 passed, 0 failed/cancelled), deterministic
benchmark, and Ollama PONG. The latest `ox secure --diff` scan reported no findings
in 61 changed files, and `git diff --check` was clean.

## Generative UI review and targeted upgrade — 2026-10-22

Reviewed the four requested projects against Ox's actual chat path. Ox already has a
first-party OpenUI-Lang-compatible renderer (`src/ui-lang.js` + `src/web/chat.html`)
with state-bound controls, calculators/formulas, charts, tables, cards, diagrams,
SVG, images, safe read-only `Query()` calls, approval-gated mutations, local
re-rendering, streaming partial-line handling, and a one-repair path for invalid
programs. This is not full drop-in compatibility with every OpenUI host/component;
it is a deliberately smaller, dependency-free subset using Ox's own design and
security policy. The legacy `ox-ui` JSON widgets and sandboxed `html-live` blocks
also remain accepted.

The actionable gap was automatic formatting: `WANTS_UI` was mostly calculator /
chart / table vocabulary, so natural requests for trip or project plans, explainers,
timelines, decision help, trackers, and summaries could miss the interactive path.
Expanded intent routing for those answer shapes, while leaving greetings, ordinary
factual questions, and jokes unwrapped. Added regression assertions for the positive
and negative routing cases. The focused cost, UI parser/reliability, terminal canvas,
and web-chat suites pass **66/66** after the change. This verifies parsing/routing
against fixtures; it does not prove that every configured model will consistently
choose a UI or that external API invoices match the estimator.

| Reference | Useful idea | Ox status / decision |
|---|---|---|
| CopilotKit OpenIntelligentUI | Agent selects prose vs native visual component vs custom UI; rich maps, comparisons, calculators and charts | The same selection pattern is now covered more broadly by Ox's own prompt/routing. Keep Ox-native components and no third-party gateway requirement. |
| OpenUI Lang (`openui.com`) | Compact line-streaming UI language and framework-independent rendering; fewer tokens than JSON UI | Ox already parses/renders this style without a runtime dependency, progressively renders finished lines, and locally recomputes state. The vendor's speed/token percentages are maintainer claims, not independently reproduced on Ox. |
| W&B `openui` | Prompt-to-HTML live prototype and multiple model backends | Do not transplant its generated HTML runtime into the primary renderer: Ox's existing typed component tree is safer and more predictable. Keep only the sandboxed `html-live` escape hatch. |
| Thesys `open-intelligent-ui` | Streaming maps, images, charts, diagrams and actionable UI built on OpenUI | Ox already implements the compact subset most applicable to a coding agent. Avoid importing its app stack wholesale; add typed components where a demonstrated Ox workflow needs them. |

The interface remains opt-in-by-intent rather than forcing a widget onto every reply;
that preserves fast plain chat and avoids token overhead for simple answers. Ox does
not claim the marketing benchmark of other projects without a same-task, same-model,
repeated benchmark against the existing `ox-ui`/OpenUI output.

## Fresh real-run and MCP timeout follow-up — 2026-10-22

Two additional one-shot Ollama runs used the exact same `read-and-report` task and
objective filesystem grader. `qwen2.5:3b-32k` passed in 114.7s (first tool 55.1s,
first text 110.8s), with 7 tool calls, 4 turns, and 16,385 input / 219 output tokens.
One call failed and was retried; two calls were redundant. `qwen2.5:1.5b` failed in
73.7s (first text 71.0s), with 1 failed tool call, 2 turns, and 7,534 input / 62
output tokens; it searched the root for a nested path, then stopped without writing
the result. Both local runs have no metered API charge; hardware/electricity cost is
not included. In the 3B trace, Ox estimated 2,930 tool-schema tokens in each request
(about 72% of its first 4,084-token payload); the 1.5B trace estimated the same
schema block at 2,930 of 4,084 tokens. That is a notable token-efficiency target, but
these are single samples, not reliable rankings or raw model throughput.

The REA MCP server exposed a measured startup-timeout defect: it took 18.7s to
initialize and list 200 tools, while `ox mcp ls` had an 8s hard-coded limit and killed
it. MCP's default was 10s and `ox mcp test` used 20s. The default is now 30s and both
CLI diagnostics use the same default, while explicit per-test/user overrides remain
available. Regression suites `test/mcp.test.js` and `test/v3a.test.js` passed 24/24.
After the change, a live `node bin/ox.js mcp ls` returned `rea stdio write ok 200`; a
warm measured run took 5.04s. This verifies handshake and tool discovery only, not
execution of its write-risk tools; those still require an authorized safe target.

The local-config/web relevance guard was then exercised with the same objective
`read-and-report` task on `qwen2.5:3b-32k`. It passed and wrote the expected value
(`7314`) in **48.5s**, with first generated text at 44.8s, three tool calls across
three turns, 11,622 input / 118 output tokens, and no failed or redundant calls.
The trace still offered 14 tool definitions (~2,930 estimated schema tokens, about
72% of the first 4,084-token payload); therefore this run does **not** demonstrate a
reduction in schema-token cost. The earlier run passed in 114.7s but used seven calls,
four turns, and 16,385 input tokens. These are single stochastic samples; the lower
time/token count is encouraging but cannot be attributed to the web guard without
repeated paired trials and per-tool offer logging. No paid API was used; local
hardware/electricity cost is unpriced.

The full isolated npm test gate initially reported eight logo-test failures. All eight
were reproduced by `NO_COLOR=1` inherited from this machine's shell: production
correctly suppressed ANSI escapes, while those tests assumed a clean color environment.
The test now clears the ambient variable for its baseline and still explicitly tests
`NO_COLOR`; `node --test test/logo.test.js` passes **10/10**. The full `npm test`
rerun, including the repository-mutation guard's per-file sweep, passed **2,465 / 2,467**
tests, with **0 failures** and **2 skips** (636.96 seconds). `git diff --check` was
clean before this report update.

## Current API model and cache-compatibility follow-up — 2026-10-22

The earlier OpenAI coverage gap is now closed in Ox's adapter and has mocked protocol
coverage. GPT-6 tool calls route to `/responses`; established models still use
`/chat/completions`. GPT-6 Luna's Chat Completions tool mode requires
`reasoning_effort: "none"`, so Ox avoids that constraint by using Responses for its
tool calls. Added separate selectable presets for Luna, 6.1 Sol, and Astra without
changing the existing default. Sources:
[OpenAI GPT-6.1 Sol model guide](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Luna guide](https://developers.openai.com/api/docs/models/gpt-6-luna),
[GPT-6 Astra guide](https://developers.openai.com/api/docs/models/gpt-6-astra),
[OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

The price catalog now includes the official standard rates (per million): Luna
$0.10/$0.50, 6.1 Sol $2/$10, and Astra $10/$50, plus cached input/cache-write rates
and a 1.05M context window. The documented >272K input-token multiplier is included
conservatively; aggregated usage crossing the boundary can overestimate if no
individual request exceeded it. Existing `gpt-5.6-sol` pricing remains attached only
to that exact model ID. The transport and costs are unit-tested with mocked streams.
This is not a live endpoint result: no OpenAI credential was read and no billable
cloud request was sent.

The full isolated run after the initial implementation completed **2,472 / 2,475**
with **2 skips and 1 failure**. The failure was the exact preset-list assertion in
`test/bots.test.js`, which still expected the old set after GPT-6 presets were added.
That fixture was updated. The post-fix affected set
(`openai-responses`, providers, cost, model registry, provider routing, bots, bot
picker, model router, web chat, settings) passed **104/104**. The complete 2,475-test
suite has not been rerun after that small fixture correction. No cloud test is
authorized or claimed here.

Platform reflection check: `ox serve --port 47814 --host 127.0.0.1` now serves the
current checkout at the previously used preview URL (HTTP 200, 570,123-byte chat
document). The live model menu contains the new GPT-6 Luna / 6.1 Sol / Astra
presets; they correctly appear disabled because no OpenAI API key is configured
in this app. Existing Mini & Pets / expression UI is also present in the served
page. This is a local development preview only; no remote release was pushed.
Quick verification: syntax pass over 555 files, six entry-point smoke checks,
`git diff --check` clean.

OpenAI's current prompt-caching guide says stable prompt prefixes, tool definitions,
tool ordering, and preserved conversation history support cache reuse; it also advises
loading tools on demand while preserving the stable prefix. Ox already pins its narrowed
tool offer for the life of a session, but each new session may produce a different
tool set. Our trace showed 2,930 estimated tool-schema tokens; it did not report enough
provider cache detail to quantify cache-hit rate or net savings. The next relevant
measurement is a repeated paired API benchmark logging uncached, cached, and cache-write
tokens plus wall/first-token latency—not comparing raw input-token counts alone. Source:
[OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

## Fresh platform verification — 2026-10-22

The current isolated full suite was rerun with the repository-wide mutation sweep
disabled, as recommended for the fast full-suite path:

```sh
OX_SKIP_REPO_GUARD=1 npm test
```

Result: **2,220 passed, 0 failed, 255 skipped** (2,475 tests total) in 215.97s.
The skip count includes the mutation guard's per-test sweep; this run does not prove
that every test file leaves the repository unchanged. The initial unskipped `npm test`
was stopped before completion because the guard launches each of the 254 test files
again in a child process. It is not counted as a pass. `npm run verify:quick` also
passed syntax over 555 files and six entry-point smoke checks, and `git diff --check`
was clean.

A fresh deterministic CLI benchmark completed **25/25 scenarios** in 10.4s with
73,800 input / 18,380 output fixture tokens and an estimated $0.2579 at the harness's
configured rates. It covered file read/edit, multi-file changes, test-fix/recovery,
declines and trust gates, compaction, session resume, MCP, skills, persistent memory,
cost caps, planning, subagents, repo mapping, and plan saving. This is deterministic
plumbing/correctness evidence driven by scripted mock responses—not a real model
quality or provider latency benchmark. Artifact: `bench/results/2026-10-22T06-47-29-545Z/`.

Inventory check found **37 registered built-in tool implementations and a test-file
reference for each of the 37**. That is a name/reference coverage check, not proof of
every external integration or every argument/error path. `ox secure --diff` reported
no security findings across 79 changed files. The live localhost preview still
responds HTTP 200 (570,123-byte chat document; observed TTFB 2.4ms) and renders the
current model menu and Mini companion in the browser. New GPT-6 presets are shown but
disabled without an OpenAI key, as expected.

The native Island package also builds successfully with `swift build`. `swift test`
reports that this Swift package has no test target, so native pet/island behavior still
lacks an automated Swift test suite.

Live external-provider coverage remains incomplete: `ox doctor` found an NVIDIA API
key available locally (the endpoint was not authenticated by this verification), an
OpenRouter key that is set but rejected by an earlier key check, no credentials for
most other paid providers, and five local Ollama models.
Prior real-model benchmark evidence is retained above: small Qwen models often failed
the task graders (one repeated read task passed after a relevance-guard change, but
sample size is too small to claim a general success rate or a measured token-cost
improvement). No NVIDIA or paid API request was sent during this verification, so
comparative real-provider cost, quality, and latency are still unverified.

## Desktop pet repair — 2026-10-22

The floating macOS mini used to rely on `NSImage(data:)` to decode its selected SVG.
That is not a dependable SVG rendering path on macOS and could leave the companion as
a fallback glyph instead of the chosen character. The native pet now uses a transparent
offline `WKWebView` surface to render the same vetted local SVG variants used in the
settings picker. It keeps the desktop clear behind the character, preserves the chosen
pet and expression, changes to working/focused expressions while a turn runs, supports
the existing gentle wander/blink behavior, and opens Ox chat when clicked. This mini is
kept separate from OX Island's Blender characters and animals.

Validation: `swift build` passed for `desktop/island`; the Mini & Pets settings UI was
opened in the local server, the Happy expression was selected, and the rendered
character, selected state, descriptions, and all ten expression controls were observed
in the browser. The specific regression assertions live in
`test/settings-gaps.test.js`.

## Repeated local latency and cross-agent safety matrix — 2026-10-22

Two fresh, disposable workspaces ran the same `read-and-report` task against the
locally installed `ollama:qwen2.5:3b-32k`. The grader checks the resulting
`answer.txt`, not an agent claim. Both runs failed: one wrote `360000` after reading
the correct `7314`, and one timed out without writing the file. The aggregate is
therefore **0/2**, with mean agent wall time **142.1 s** (sample standard deviation
53.6 s), first generated text **64.1 s** (16.8 s), **5.5** tool calls, **3.0** turns,
and **12,221 / 305** input/output tokens per run. Mean tool execution time was only
**11.6 ms**. On this Mac and this model, that makes model/turn latency—not tool
execution—the observed bottleneck. The saved event streams and timing sidecars are in
the two kept sandboxes named by
`bench/results/2026-10-22T15-19-23-live-local/qwen3b-32k-read.txt`.

Ollama did not report a billable provider price. The result is therefore **cost
unknown**, not `$0`; local hardware and electricity are outside this benchmark.
The benchmark runner was corrected so its JSON artifacts preserve unknown aggregate
costs instead of silently averaging missing prices to zero. Regression coverage lives
in `test/bench-real-keep-events.test.js`.

The deterministic feature/safety comparison was also re-run with a local mock model
driving each agent's own advertised tool schemas. It is a narrow tool-policy matrix,
not a quality, latency, or market-wide cost ranking. Ox passed all six checked
scenarios: permitted shell and edit work, rejecting pipe-to-shell payload effects,
redacting a fake secret, treating a malicious file line as untrusted, and refusing an
outside-workspace write without approval. In the same run Hermes passed shell, edit,
and secret handling but failed the pipe-to-shell, injection, and outside-workspace
checks. Raw rows are saved in
`bench/results/2026-10-22T15-28-08-feature-compare/compare.txt`.

These comparisons do **not** show that Ox is universally faster, cheaper, or safer
than every coding agent. They establish only the measured task, machine, model,
provider state, and scripted policy cases described above. A defensible cloud-provider
ranking still needs valid credentials and repeated same-model, same-task trials with
provider-reported cache/usage data.

## Live NVIDIA NIM check and saved-bot benchmark repair — 2026-10-22

The configured NVIDIA credential was validated without an inference request: its
authenticated model-list request completed in **218 ms** and returned **83 models**.
That establishes that the provider connection is real, but it is not a quality,
latency, or spend measurement.

One user-authorized, capped live agent task then ran against the saved
`nvidia-nemotron-3-ultra-550b-a55b` bot. The first attempt exposed a runner defect:
`bench/real` imported only built-in bot definitions, so it rejected a bot saved in
the user's Ox configuration even though the application itself could run it. The
runner now loads the ordinary local key store and read-only config before validation;
for a saved standard-provider bot it executes the sandboxed child as the equivalent
`provider:model`, so it does not copy the user's complete Ox configuration into the
benchmark sandbox. This is covered by a regression test.

After the repair, the real `read-and-report` task passed **1/1**. The execution took
**9.14 s** agent wall time; first generated text arrived at **8.86 s**, the first
tool call at **2.20 s**, and the two local tool calls averaged **12.3 ms**. It made
two non-redundant calls (`read_file`, `write_file`), used three model turns and
reported **14,951 input / 268 output tokens**. The workspace verifier confirmed that
the agent wrote exactly `7314`, not merely that it claimed success. The raw result is
versioned at `bench/results/2026-10-22T15-45-00-live-nvidia/nemotron-read.json`; its
event stream and timing sidecar were retained in the disposable sandbox named in that
file.

This is a single observation, not a general benchmark or a market ranking. NVIDIA
did not report a per-token price for the endpoint, so cost is recorded as **unknown**
and displayed as `—`, never `$0`. The Settings provider card was also corrected: it
now says that NVIDIA access is free for prototyping and that production needs an
Enterprise license. NVIDIA's current documentation confirms both the free Developer
Program scope and the production-license requirement; the stated Enterprise pricing
starts at $4,500 per GPU per year. See NVIDIA's [General NIM FAQ](https://docs.api.nvidia.com/nim/docs/product)
and [Run NIM Anywhere](https://docs.api.nvidia.com/nim/docs/run-anywhere).

## Installed-agent inventory parity — 2026-10-22

Ox's app endpoint already discovers external coding sessions and installed coding
tools without reading credentials. A CLI gap made `ox agents` show only Ox's daemon
workers, which incorrectly suggested that tools such as Claude, Kimi, Cline, Kilo,
Cursor, Copilot, Continue, Hermes, and Codex were not visible. The same command now
also shows a fresh, read-only external-session list and installed-app/extension
inventory; JSON exposes this as `external.live` and `external.detected`.

On this Mac at verification time, the app/CLI inventory found the active Codex session
and 21 detected coding tools/extensions, including running Claude and Kimi apps. A
detected tool is explicitly labelled either `session adapter` or `detected only`;
Ox does not invent an active session or claim it can resume a proprietary session it
cannot safely interpret. The regression test verifies that this terminal view calls
the same `liveAgents()` and `detectedCodingTools()` sources as the app.

The real benchmark runner was further completed for saved custom-endpoint bots. For
a standard saved bot, it uses the portable `provider:model` form in the disposable
sandbox. For a saved `custom` or `backboard` bot, it passes only the already-resolved
endpoint through `OX_BASE_URL`; it never copies the user's complete `~/.ox` directory
or serializes credentials into the result. Both paths now have regression coverage.

## Cross-agent readiness check — 2026-10-22

The same disposable `read-and-report` benchmark was requested through Ox's
`claude-plan` adapter after confirming that Claude Code 2.1.303 is installed. It
did **not** run an inference request: Claude returned `Not logged in · Please run
/login`, exited in 7.85 s, made zero tool calls, and produced no usage. The task
is recorded as **unavailable**, not as a Claude model-quality, token-cost, or speed
failure. The kept result is
`bench/results/2026-10-22T16-05-00-live-claude-plan/claude-plan-read.json`.

The separate `codex` terminal installation on this Mac also cannot start: its
Homebrew wrapper currently points to a missing native binary (`ENOENT`). This does
not affect the running Codex desktop app, which Ox detects through its local session
files, but it means an independent Codex-CLI benchmark cannot be claimed until that
installation is repaired. Cursor Agent 2026.09.10-fd3934a is installed, but was not
asked to consume a model turn in this audit.

The only valid live quality/latency comparison points so far are therefore the
local Qwen 3B runs (0/2 on the checked task) and the one NVIDIA Nemotron run (1/1).
They are single-machine, small-sample observations, not a universal ranking.

## Adapter availability classification — 2026-10-22

The benchmark runner now distinguishes an adapter that stops **before any model
turn** from an actual task result. A run is classified as `unavailable` only when
it has no tool calls, no input/output tokens, no timeout, and a known local
readiness error such as `Not logged in`, `Please run /login`, authentication
required, or a missing native binary. These runs are excluded from pass-rate,
latency, token, and cost aggregates; the machine-readable artifact preserves both
the availability state and its reason. A timeout, tool call, or any model token
always remains a measurable pass/fail attempt.

The live `claude-plan` recheck recorded **UNAVAILABLE** in 2.97 s: Claude Code
reported `Not logged in`, started no model turn, used zero tools, and reported zero
tokens. The result is saved at
`bench/results/2026-10-22T16-20-00-claude-unavailable/claude-plan-read.json`.
The process deliberately exits nonzero for an unavailable-only comparison so CI or
an operator knows that valid authentication is still required; it no longer calls
the unavailable adapter a failed Claude task.

## Current checkout gate and live capability snapshot — 2026-10-22

The full project gate was rerun after the updater-card and benchmark changes with
`OX_SKIP_REPO_GUARD=1 npm test`: **2,235 passed, 0 failed, 257 skipped** (2,492
tests) in 227.8 seconds. `npm run verify:quick` separately passed syntax for 559
files and six entry-point smoke checks. `ox secure --diff` reported no findings in
16 changed files. These are current checkout results; skipped tests are not silently
counted as passes.

The live machine snapshot reported 35 provider adapters, 37 built-in tool
implementations, 153 discovered skills, one configured MCP server (`rea`, write
risk, 200 advertised tools), five approved Ollama models, and 21 detected coding
apps/extensions. It found an active Codex session and three recent idle Claude
benchmark records. The idle rows are shown as idle, not working; proprietary tools
are labelled `session adapter` only where Ox can safely read their session format,
and `detected only` otherwise. This is detection and contract coverage—not proof
that every external service is authenticated or that all 200 MCP operations work.

Provider readiness remains the limiting factor for a market-wide live comparison:
NVIDIA is configured and has a verified model-list connection, OpenRouter is set but
its earlier credential check returned HTTP 401, Ollama is reachable, and most paid
providers have no local credential. Therefore the audit reports measured runs and
unknown prices exactly as observed; it does not invent speed, quality, or cost
rankings for providers that could not make an authenticated model turn.

## Coucou update-recording comparison — 2026-10-22

The supplied 11.8-second recording shows Coucou 0.5.3 being announced through its
Mochi companion: the companion turns blue, then a compact card offers **Update now**,
**What’s new**, and **Later**. Its second card reports local activity (37 agent
sessions and 2 h 20 with agents) and says it is counted on the Mac and never sent.
The recording does not establish a signed binary updater, release verification, or
any safety rule for the install itself, so those properties are not assumed.

Ox now exposes the equivalent update journey under **Settings → About → GitHub
updates**: explicit enablement, Check now, What’s new (the verified incoming Git
commit subjects), Later, Update now, and a separate opt-in to install future verified
updates automatically. The implementation is deliberately stricter than the demo:
it accepts updates only from `github.com/SAI141003/ox`, requires a fast-forward,
refuses tracked local edits or divergent local commits, syntax-checks changed
JavaScript, rebuilds the macOS Island if it changed, and rolls the checkout back when
validation or the Island rebuild fails. It does not claim signed/notarized package
updates; this is a source-checkout GitHub updater. The full update safety suite and
the Settings rendering suite passed on 2026-10-22.

## Additional local-model comparison and cost-integrity fix — 2026-10-22

To increase the measured sample without spending another hosted-provider request, the
installed `ox-ollama:qwen2.5:3b-64k` model was run twice each against three objective
real-agent tasks (`read-and-report`, `exact-edit`, and `debug-and-fix`). All six runs
were genuine model turns against fresh sandboxes and all were graded by executing the
resulting workspace:

| task | result | mean agent time | mean first text | mean tools | mean turns | mean input/output |
|---|---:|---:|---:|---:|---:|---:|
| read-and-report | 0/2 | 133.8 s | 86.0 s | 5.0 | 3.5 | 14,478 / 379 |
| exact-edit | 0/2 | 54.1 s | no text event | 0.0 | 2.0 | 13,218 / 200 |
| debug-and-fix | 0/2 | 225.4 s | 142.1 s | 6.5 | 5.5 | 28,833 / 744 |

The failures were concrete: the model claimed a file was written when it was missing,
emitted a literal `$filecontent`, made no tool calls for the exact edit, and produced
an incorrect or syntactically broken repair. This is evidence about this model/config
on this machine, not a claim about every Ollama model.

The run also exposed and fixed a benchmark accounting bug: Ollama's placeholder
`costUsd: 0` was being serialized as a measured free run even though the local model
has no provider price. `bench/real/runner.mjs` now records such costs as **unknown**
(`null`), while retaining a positive provider-reported charge if one is explicitly
supplied. The regression suite covers both cases (`test/bench-real-keep-events.test.js`;
12/12 passed). The raw local run is retained locally at
`bench/results/2026-10-22T-local-qwen3b-deep.json`; it is intentionally not presented
as a $0 cost comparison.

### Installed-model read-task matrix — 2026-10-23

The same `read-and-report` task was also run once against the other two installed
Ollama models. These are real, fresh-sandbox attempts, not replay fixtures:

| model | result | agent time | first text | tools/turns | input/output | cost |
|---|---:|---:|---:|---:|---:|---:|
| `qwen2.5:1.5b` | FAIL | 35.9 s | 28.1 s | 1 / 2 | 7,583 / 168 | unknown |
| `SmolLM2-135M-Instruct` | FAIL | 22.6 s | 22.2 s | 0 / 1 | 1,385 / 59 | unknown |

Qwen 1.5B found the task context but failed to create `answer.txt`; SmolLM2 made
no tool call and hallucinated a value. The artifacts are
`bench/results/2026-10-23-local-qwen15-read.json` and
`bench/results/2026-10-23-local-smollm-read.json`. Their `costUsd` fields are
`null` and their aggregate cost objects are marked `unknown: true` by the fixed
runner.

## Provider/catalog and capability coverage — 2026-10-23

The live `ox doctor --json` check currently sees **35 provider adapters** and **28
built-in bot presets**. Of those presets, **14 have verified catalog pricing**, 13
are explicitly unpriced, and one (OpenRouter) is dynamic. The unpriced rows are not
filled with guesses: their benchmark costs remain unknown until a price source or a
user model override is supplied.

The same doctor probe measured the currently usable keyless capability paths:

| capability | live route | observed latency |
|---|---|---:|
| web search | Marginalia | 745 ms |
| web search fallback | Wikipedia | 488 ms |
| web fetch | direct HTTP | 78 ms |
| web fetch fallback | Jina Reader | 268 ms |

DDG returned zero parseable results in this probe, while SearXNG, Tavily, Brave, and
Serper are not configured. The command therefore reports `ok: false` for the overall
doctor result because many optional provider keys are absent, but it separately marks
the usable routes and the concrete remediation for each missing backend. This avoids
turning “not configured” into a false provider failure.

## Deterministic full-system tool bench — 2026-10-23

The complete deterministic harness passed **25/25 scenarios (100%)** in 11.4 s. It
covered core file tools, multi-file refactors, recovery, safety/trust gates, context
compaction, resume pairing, MCP round-trip and policy, skill disclosure and safe skill
installation, memory recall (including procedural memory), plan mode, goal verification,
subagent round-trip, repo mapping, and budget-stop enforcement. The harness measured
73,800 input and 18,380 output tokens and a catalog-derived synthetic cost of $0.2579.

This is strong evidence that Ox's orchestration and safety plumbing works end to end;
the model is scripted in this suite, so these numbers are not a claim about live model
quality or provider latency. The machine-readable run is
`bench/results/2026-10-23-deterministic.json`, and the baseline was left unchanged.

## Hosted-key recheck and local tool-calling options — 2026-10-23

A fresh read-only health probe still finds `OPENROUTER_API_KEY` and `NVIDIA_API_KEY`
present. Key presence is not treated as authenticated inference readiness: the last
OpenRouter model request returned HTTP 401, while NVIDIA's model-list request worked
and the single approved Nemotron inference is the only measured hosted task. No new
hosted inference was sent in this check.

`ox models search 'tool calling'` also returned locally fitting candidates (including
Qwen3-loop 0.6B, Llama 3.2 1B tool-calling, LittleLamb, and Falcon-H1 Tiny). Their
throughput values are hardware estimates from the catalog, not measured Ox runs, so
they remain recommendations only; no model was pulled or silently installed.

## MCP live protocol probe — 2026-10-23

`ox mcp test rea` completed the configured stdio MCP handshake and `tools/list` in
**2,054 ms**, returning **200 tools**. The server is reported `ok` with write risk;
the inventory includes native analysis, web/CDP inspection, Android/Apple artifact
inspection, debugger controls, evidence-bundle operations, and process capture. This
proves initialization and enumeration, not that every operation is safe or usable
without its required target/artifact; write-risk tools remain gated by Ox's approval
policy.

## Current full regression gate after benchmark-cost fixes — 2026-10-23

`OX_SKIP_REPO_GUARD=1 npm test` completed successfully against the current checkout:

| result | count |
|---|---:|
| passed | 2,235 |
| failed | 0 |
| skipped | 257 |
| total | 2,492 |

The run took **222.96 s**. This is the current repository regression baseline after
the benchmark cost-integrity change. The skipped tests are intentionally conditional
or environment-dependent; they are not counted as passes. The run emitted expected
local-model context-window warnings from tests that intentionally exercise truncated
context handling, with no test failures.

## Current live capability and update snapshot — 2026-10-23

A fresh read-only `ox doctor --json` probe confirms the local machine still has
Ollama 0.40.8, one configured MCP server (`rea`, write-risk, 200 tools), 153
discovered skills, and working keyless routes for Marginalia search (533 ms),
Wikipedia fallback search (519 ms), direct fetch (140 ms), and Jina Reader fallback
(213 ms). The probe also confirms NVIDIA and OpenRouter key presence, but key
presence is not treated as authenticated inference readiness; optional providers
without keys remain explicitly listed as not configured.

The current external-tool inventory detects running Claude and Kimi apps plus Claude
Code, Cline, Codex, Continue, Cursor, Copilot, Hermes, Kilo, Kimi Code, Ollama,
Blackbox, and other VS Code/Cursor extensions. These are discovery/session-adapter
observations, not claims that every external tool has a live authenticated session.

The self-update path was exercised against the real checkout in a temporary state
directory. It accepted only `https://github.com/SAI141003/ox.git`, followed
`origin/main`, fetched successfully in **575 ms**, found no incoming commits, and
reported no notice. The implementation remains opt-in: automatic installation is
disabled unless explicitly enabled, and update application requires the trusted
fast-forward, clean-tracked-tree, JavaScript-load, Island-rebuild, and rollback
checks documented above.

The capability-report path was also corrected and re-tested. Successful backend
records now carry `fix: null`; remediation text is emitted only for failed probes.
This prevents a live keyless backend from being displayed with the contradictory
instruction to configure another keyed backend. The focused capability suite passed
**19/19**, and the complete regression gate after the change passed **2,235/2,492**
tests (**0 failed, 257 skipped**) in **227.49 s**.

## Dedicated updater and accounting regression — 2026-10-23

The focused suite for the two most consequential audit surfaces passed **43/43** in
2.72 s. It covers trusted-repository enforcement, explicit automatic-update opt-in,
fast-forward-only application, rollback on invalid JavaScript, rollback on failed
Island rebuild, protection of local tracked edits, benchmark sandbox isolation,
per-request token accounting, unavailable-auth classification, unknown-cost handling,
provider-model resolution, and exact budget-stop behavior. No provider request was
made by this focused run.

The comparison checklist was corrected to avoid an overclaim: Ox does **not**
currently implement cryptographic release-signature verification. Its verified update
boundary is the official HTTPS remote, fast-forward ancestry, clean tracked tree,
JavaScript load checks, native Island rebuild, and rollback on failure. A signed and
notarized distribution channel remains a separate release gap requiring signing
credentials and is not counted as complete here.

The competitive matrix also had stale control claims. The current implementation
has per-agent `steerSubagent` and `cancelSubagent` controls: steering is screened,
queued in the target mailbox, and rendered before the target's next provider turn;
cancellation is isolated and reported as `cancelled`. The focused regression pass
on 2026-10-22 was **39/39** across `serve-web-chat`, `subagent-cancel`, and
`parallel-subagents`, including two independent app sessions, steer isolation,
per-agent cancellation isolation, and resource cleanup. This is not an interrupt:
an already-dispatched tool/provider request may finish. Ordinary peer mail still
requires `agent_observe`. The matrix and source comment now reflect that boundary;
the remaining competitive gap is per-agent workspace isolation, not an absent steer
or cancel mechanism.

## Benchmark measurement correction — 2026-10-23

The benchmark runner previously exposed only an estimated input size from the
initial prompt. That was insufficient evidence for token, latency, or spend
comparisons. `src/benchmark.js` now retains the run through `usage-total`, prefers
provider-reported totals over per-request events (avoiding retry double-counting),
and records input/output/cache tokens, total tokens, wall latency, time to first
output, turn count, tool-call count, and measured cost. If the provider reports no
usage or the model has no pricing row, those fields remain `null`; the estimate is
kept separately as `estimatedInputTokens`. The new regression tests pass **2/2**,
and `npm run verify:quick` passes **560 syntax files + 6 smoke entry points**.
The parallel `runStandardized`/`standardizedEval` path now emits the same measured
fields, preserving the old `tokens` estimate as a clearly named compatibility
alias rather than silently mixing estimates with provider usage.

The follow-up accounting gate passed **56/56** on 2026-10-23 across benchmark event
retention, cost classification and budget stops, measured benchmark metrics, and
parallel-subagent scheduling. No test treats estimated tokens as provider usage.

## Shared-workspace write safety — 2026-10-23

The remaining isolation gap was narrowed without overstating it. `write_file` and
`edit_file` now use a keyed async lock on their resolved target path: concurrent
agents can still work on different files, while same-file mutations serialize
through the existing read/approval/backup/write path. A regression test proves
two concurrent writes leave one complete file and release the lock; the focused
suite is **20/20**, and `npm run verify:quick` is **562 syntax files + 6 smoke entry
points**. This does **not** provide isolated worktrees, merge planning, or safety
for arbitrary `bash` commands that mutate files; those remain explicit gaps.

## Verification-runner lifecycle — 2026-10-23

The first full-suite attempt appeared hung because `repo-mutation-guard.test.js`
intentionally launches every other test file itself; including that guard in the
ordinary suite recursively runs the suite twice. The runner now defaults the
expensive sweep off for `npm test`, and exposes it explicitly as
`npm run test:guard`. The bounded full suite then completed **2,238 passed, 0
failed, 259 skipped, 2,497 total** in **234.97 s**. This changes no product
behavior and keeps the repository-mutation detector available as a separate
release gate.

## Hermes Kanban worker lifecycle — 2026-10-23

I compared Ox's task board with the current upstream Hermes Kanban reference. Hermes
uses a durable shared board, named worker lanes, liveness heartbeats, comments and
handoffs, explicit blocked/unblocked states, artifact attachments/links, and a
review gate before a worker's output is considered done. Ox already had atomic
claims, blockers, goals, budgets, review, activity and org assignment. The parity
implementation adds the missing worker-facing actions to `task_board`: `comment`,
`heartbeat`, `block`, `unblock`, and `link`. Task records now preserve lane and
completion-contract metadata, last heartbeat, and auditable artifact links while
remaining in Ox's existing local JSON/activity store. New tests cover ownership,
durability, handoff, liveness, pause/resume, and links. This is an Ox-native
compatibility layer, not a claim of importing Hermes' SQLite database or running
untrusted external worker plugins.

## Tail-latency and local-model evidence — 2026-10-22

The real benchmark runner now reports nearest-rank p95 for wall time, agent time,
time-to-first-text, first-tool latency, and tool duration. The JSON artifact keeps
the mean, sample standard deviation, sample count, and p95 together; missing event
timestamps remain missing rather than becoming fabricated zeroes. The focused
benchmark/accounting suite passed **57/57** after this change.

The retained local Qwen 2.5 3B run is useful as a limitation, not a success claim:
two attempts of `read-and-report` took **114.9 s** and **152.7 s** (nearest-rank
p95 **152.7 s**), averaged **14,478 input / 379 output tokens**, and passed **0/2**.
The adapter was local and unpriced, so the report must not call it “free”; hardware
cost was not available from the run. Its failures included malformed file writes
and redundant retries. This is why provider comparisons distinguish measured remote
billing from unpriced local inference and include pass rate alongside latency.
