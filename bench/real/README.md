# ox REAL agent benchmark (`bench/real/`)

**This measures real agent behaviour. The suite in `bench/` does not.**

Everything else in `bench/` is a *replay* suite: `bench/harness.mjs` starts a mock
OpenAI-SSE server, each scenario in `bench/scenarios/` scripts the tool calls that
come back, and each check asserts that the transcript matched the script. That proves
ox's plumbing is wired up. It proves nothing about whether the model can do anything,
because the model's decisions were written down in advance by the scenario author. A
completely broken model scores 100% on that suite.

This suite exists because of the audit conclusion: *every claim the replay suite
supports is a claim about the harness; every claim you would actually want to make is
a claim about the model, and the model is a switch statement.*

Two rules define everything below.

**RULE 1 — THE MODEL DECIDES.**
There is no mock provider, no `script()` hook, and no scripted tool call anywhere in
this directory. ox is spawned for real against a real provider. The model chooses
which tools to call, with what arguments, in what order. Every number in the result
table is something the model actually did.

**RULE 2 — GRADING EXECUTES CODE.**
Every task has a `verify(ctx)` that spawns real processes (`node`, `grep`) inside the
workspace the agent left behind and decides pass/fail from exit codes and real stdout.
Nothing here grades the shape of a transcript. A transcript that reads like a perfect
agent transcript but leaves the workspace wrong **fails**, because the transcript is
never consulted for the verdict.

## Reproduce a run

`--model` is **required**. There is no default and no silent fallback: a benchmark that
picks a model for you is a benchmark whose results you cannot interpret.

```sh
# one task, local model, keep the sandbox for inspection
cd /Users/saiyaganti/ox
node bench/real/runner.mjs --task debug-and-fix --model ox-ollama:qwen2.5:0.5b --keep

# the flagship debug task against a hosted model
node bench/real/runner.mjs --task debug-and-fix --model ox-openrouter:meta-llama/llama-3.3-70b-instruct --keep

# everything, three independent repeats per task, machine-readable output
node bench/real/runner.mjs --model ox-openrouter:deepseek/deepseek-v4-flash --all --repeats 3 --json /tmp/real.json

# just the task list
node bench/real/runner.mjs --list
```

Useful flags: `--task <id>` one task · `--filter <regex>` a subset · `--all` ·
`--repeats <n>` variance (fresh sandbox per repeat) · `--json <path>` ·
`--keep` leave sandboxes on disk · `--timeout <ms>` override every task timeout.

Model specs resolve through `resolveBot()` in `src/bots.js`, so every provider ox
supports is selectable and the list cannot drift out of sync with the CLI:

```
ox-ollama:qwen2.5:0.5b
ox-openrouter:meta-llama/llama-3.3-70b-instruct
ox-claude
ox-gpt
ox-deepseek
```

## Results vary by MODEL, not by harness

Two runs of the same task, on the same fixtures, with the same grader, differ only in
the model. The grader is a constant. That is the entire point: **the number moves when
you change the model, and nothing else.** A harness that can produce a score is not a
harness whose score means anything.

Concretely, from real runs on the `debug-and-fix` fixture:

| model | tool calls | turns | tokens in/out | verdict |
|---|---|---|---|---|
| `ox-ollama:qwen2.5:0.5b` | 1 (errored) | 2 | 0/0 | FAIL — gave up, no edits |
| `ox-openrouter:meta-llama/llama-3.3-70b-instruct` | 0 | 1 | 4199/16 | FAIL — empty completion, never called a tool |
| `ox-openrouter:deepseek/deepseek-v4-flash` | 16 | 10 | 67850/4084 | FAIL — thrashed (6 redundant calls), hit the timeout |

The third row is the useful one: that model genuinely ran tools, read the failure
output, and burned 67k input tokens over 10 turns without ever calling `edit_file`. A
replay suite would have scored all three 100%.

## The tasks

| id | category | what it actually tests |
|---|---|---|
| `read-and-report` | read | Locate a value the prompt does not name (a stale `.bak` decoy carries a different one) and write it to `answer.txt`. Grading is objective: `verify` greps the workspace for the true value and requires `answer.txt` to contain exactly that. Saying the right thing scores zero. |
| `exact-edit` | edit | A retry-limit literal is copy-pasted into two files. The verifier greps that the old value is gone and the new one appears exactly once per declaration, then runs `node -e "require('./src/lib.js').k()===42"` and the provided test. |
| `debug-and-fix` | debug | Flagship. `node test.js` genuinely exits 1 (a `movingAverage` divisor that grows with the loop index). Requires read → diagnose → edit → re-run. `verify` requires exit 0. |
| `multi-file-refactor` | refactor | `calcTotal` lives in 4 files, one occurrence of which is inside a comment that must NOT be renamed. `verify` runs a test importing all 4 and then greps `src/` and `tools/` to prove the old name survives only on comment lines, exactly once. A blanket `sed` fails. |
| `create-runnable-script` | create | Write `gen.js` to a 7-rule spec. `verify` executes `node gen.js` and compares stdout to an exact expected string, derived twice (a frozen literal *and* an independent implementation) so a fixture typo cannot make the task unpassable. |
| `add-feature-to-spec` | edit | A `summarize()` stub returns `null`. A provided test is red before and green after. `verify` runs the test **and** SHA-256s it against the shipped bytes, so deleting or weakening the test fails the task. |
| `recover-from-broken-state` | recover | A syntax error in `src/util/money.js` — a file the prompt never mentions — makes `node test/total.test.js` unrunnable. `verify` requires `require('./src/index.js')` to exit 0 *and* the stated goal to be met. Implementing the stub alone is not enough. |
| `discipline-dont-touch` | discipline | Add `doubleAll` to `src.js` without touching `SECRET_DO_NOT_MODIFY.txt`. `verify` requires the secret file to be byte-identical (SHA-256), the test file to be un-gutted, and the function to exist. Restraint is where agents typically fail. |
| `multi-step-plan-execute` | edit | A four-step release checklist spanning four files. `verify` runs one test that asserts all of it, then independently re-reads the final module state. |

Every `setup()` writes a real project shape with nested directories, so `glob`, `grep`
and `list_dir` are genuinely required rather than decorative. All fixtures are plain
CommonJS so `node -e "require('./x.js')"` works with no `"type"` field in package.json.

## Isolation

Each run gets a fresh `mkdtemp` sandbox under `os.tmpdir()` with `HOME` and every
`XDG_*` directory redirected inside it. The repo is never written to and the real
`~/.ox` is never read. `OX_BASE_URL` / `OX_MODEL` / `OX_API_KEY` are stripped from the
child environment so a real run can never be silently redirected at a mock. Real
provider keys are kept, because a real run has to reach a real model. Sandboxes are
destroyed after every run unless `--keep` is passed. Every task has a hard timeout and
ox is SIGKILLed on expiry — a hung agent cannot hang the runner.

## Provenance: `--keep` also keeps the event stream

The runner parses the child's NDJSON stdout to compute the summary, and that
stream exists only in memory. `--keep` writes it into the sandbox as
`<sandbox>/events.ndjson` (one JSON value per line, stream order, written
*before* the summary prints) so the numbers in the report trace back to the
events that produced them:

```
/var/folders/.../ox-realbench-read-and-report-4vsdNz
├── events.ndjson   <- every tool-start/tool-end/usage event, verbatim
├── home/           <- sandboxed HOME + XDG
└── ws/             <- the workspace the agent was graded against
```

The summary also prints a `USAGE PER REQUEST` table — per-request input/output
rather than only run totals, because a mean cannot show you which request cost
the run. Adapters that report only a grand total (some local Ollama builds)
produce no table rather than a row of zeroes. The table is printed whether or
not `--keep` was passed; the *file* only exists with `--keep`.

## Self-test: is the grader itself sound?

A benchmark that cannot fail is worthless. `/tmp/ox-realbench-selftest.mjs` (throwaway,
deliberately not shipped) proves three things without involving any model:

1. **Every task's `verify()` FAILS on the pristine workspace.** A task that already
   passes before the agent acts is a broken task.
2. **Every task's `verify()` PASSES after a scripted oracle solution** — the minimum
   edit that satisfies the verifier. A task with no reachable pass state is broken.
3. **`summarizeEvents()` computes correct metrics** on a hand-counted synthetic NDJSON
   fixture: tool-call count, unique calls, redundant calls, per-tool counts, turns,
   error/retry events, and token totals including the `usage-total` override path.

This has already earned its keep: it caught a genuinely broken
`multi-step-plan-execute` fixture (the checklist said `describeRelease()` must return
`v1.1.0 stable [metrics]` while "the bracketed list is every entry of `FEATURES`" —
two incompatible specifications, so no implementation could pass). The spec now names
the exact expected string.

## What this suite can and cannot prove

**Can prove.** Whether a given model, given a given fixture, left the workspace in the
correct state. Whether it can find information it was not told the location of, edit
precisely, run a command and read its output, follow a written plan across files, and
refrain from touching what it was told not to touch. Because grading executes code, a
pass means the workspace is genuinely correct, not that the transcript looked right.

**Cannot prove.** Anything about ox's plumbing — that is `bench/`'s job, and this suite
deliberately shares no code with it. It cannot measure quality above pass/fail on nine
fixtures: one wrong constant changes the score. It cannot distinguish a model that
reasoned correctly from one that guessed. It does not test multi-agent behaviour, long
sessions, or recovery from a bad plan. Two runs of the same model are not identical
(temperature), which is why `--repeats` exists and why a single run is a weak claim.

**Deliberately excluded from grading.** `summarizeEvents` reports tool-call counts,
unique tools, turns, redundant calls and token totals, but *none of these decide
pass/fail.* They are diagnostic, not scoring. A run that reached the right state with
few calls and a run that flailed to it both PASS; the flailing is visible in the table
and that is where it belongs. Grading on tool-count or turn-count would reward
obedience to a guessed happy path rather than correctness — which is exactly the
failure mode of the replay suite this directory was built to replace.
