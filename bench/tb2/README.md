# ox tb2 — Terminal-Bench 2.1 compatibility layer

Bridge module that converts Terminal-Bench 2.1 task directories into ox bench scenarios
and runs them through the deterministic harness.

## Files

- `adapter.mjs` — loads TB2 tasks, converts them to ox bench scenarios, and runs TB2 test scripts.
- `run-tb2.mjs` — runner that discovers tasks under `bench/tb2/tasks/` and executes them.

## Usage

```bash
node bench/tb2/run-tb2.mjs                     # run all tasks
node bench/tb2/run-tb2.mjs --filter "fuzzy"    # filter by name/category/description
node bench/tb2/run-tb2.mjs --list              # list tasks without running
```

Artifacts: console table + totals + pass rate, `bench/tb2/RESULTS.md`.

## TB2 task directory format

Each task lives under `bench/tb2/tasks/<task-name>/`:

```
tasks/<task-name>/
  task.json        # { name, description, category, difficulty }
  prompt           # text file with the user prompt
  script.mjs       # optional deterministic mock script (see below)
  <fixtures>       # any files the agent needs (source, data, etc.)
  tests/
    test.sh        # runs against the workspace filesystem after the agent finishes
    test_output.sh # runs against the agent's transcript / stdout
```

### task.json

```json
{
  "name": "my-task",
  "description": "does something useful",
  "category": "core-tools",
  "difficulty": "easy"
}
```

All fields are optional except `name` (falls back to the directory name).

### prompt

Plain text. The exact string passed to `ox -p "<prompt>" --json`.

### tests/test.sh

Bash script executed with `cwd` set to the agent's workspace.
Environment variables:
- `TB2_WORKSPACE` — path to the workspace root
- `TB2_EXIT_CODE` — ox exit code (string)

Exit 0 on pass, non-zero on fail. Stdout/stderr are captured into the result detail.

### tests/test_output.sh

Bash script executed with `cwd` set to the agent's workspace.
Environment variables:
- `TB2_AGENT_OUTPUT` — path to a file containing the raw NDJSON stdout from the ox run
- `TB2_WORKSPACE` — path to the workspace root
- `TB2_EXIT_CODE` — ox exit code (string)

Exit 0 on pass, non-zero on fail. Use this to inspect the agent's transcript for
specific strings, tool call counts, or other output-level assertions.

### script.mjs (optional)

If present, this module exports a mock model function compatible with the harness
`startMock` script contract:

```js
// taskDir/script.mjs
export default async function script(body, ws, state) {
  // body: parsed OpenAI request body
  // ws:   workspace root path
  // state: mutable flags / requests array from startMock
  const { turn } = await import('../../harness.mjs');
  return turn({ text: 'response', usage: { in: 800, out: 120 } });
}
```

If `script.mjs` is absent, the adapter uses a minimal passthrough that echoes the
last user message back as a single text turn. Complex agentic tasks should provide
their own `script.mjs` to drive deterministic tool-call sequences.

## How to add new tasks

1. Create a directory under `bench/tb2/tasks/`:

```bash
mkdir -p bench/tb2/tasks/my-new-task/tests
```

2. Add `task.json`, `prompt`, fixture files, and test scripts:

```bash
cat > bench/tb2/tasks/my-new-task/task.json << 'JSON'
{
  "name": "my-new-task",
  "description": "example task",
  "category": "core-tools"
}
JSON

cat > bench/tb2/tasks/my-new-task/prompt << 'PROMPT'
Read file.txt and replace "hello" with "world".
PROMPT

cat > bench/tb2/tasks/my-new-task/tests/test.sh << 'SH'
#!/bin/bash
set -e
test -f "$TB2_WORKSPACE/file.txt"
grep -q 'world' "$TB2_WORKSPACE/file.txt"
SH

chmod +x bench/tb2/tasks/my-new-task/tests/test.sh
```

3. (Optional) Add `script.mjs` if the task requires a deterministic mock model.

4. Run:

```bash
node bench/tb2/run-tb2.mjs --filter my-new-task
```

## Adapter internals

### loadTask(taskDir)

Reads `task.json`, `prompt`, `tests/test.sh`, `tests/test_output.sh`, and
`script.mjs` from the given directory. Returns a plain object with the parsed
contents.

### tb2ToScenario(taskDir)

Converts a loaded TB2 task into an ox bench scenario object with the standard
contract:

- `name` / `description` / `category` — from `task.json`
- `prompt` — contents of the `prompt` file
- `setup(sb)` — copies all non-test task files into the sandbox workspace
- `script(body, ws, state)` — returns SSE payloads; loaded from `script.mjs` if present,
  otherwise a minimal passthrough
- `check(r)` — delegates to `runTests`, which shells out to `test.sh` and
  `test_output.sh`

### runTests({taskDir, workspace, agentOutput, exitCode})

Runs the TB2 verification scripts:
1. `test.sh` is spawned with `cwd=workspace`.
2. `test_output.sh` is spawned with `cwd=workspace` and `TB2_AGENT_OUTPUT` pointing
   to a temp file containing the agent's raw stdout.

Returns `{ pass: boolean, detail: string }`.

## Comparing with existing ox bench scenarios

| Feature | ox bench scenarios (`bench/scenarios/*.mjs`) | tb2 tasks (`bench/tb2/tasks/*`) |
|---------|----------------------------------------------|--------------------------------|
| Format | ESM module exporting a scenario object | directory with JSON + text + shell tests |
| Mock script | inline in the `.mjs` file | optional `script.mjs` module |
| Verification | JS `check(r)` function | shell `tests/test.sh` + `tests/test_output.sh` |
| Setup | JS `setup(sb)` function | files copied automatically from task dir |
| Runner | `bench/runner.mjs` | `bench/tb2/run-tb2.mjs` |
| Result artifact | `bench/RESULTS.md` | `bench/tb2/RESULTS.md` |

Existing ox bench scenarios are more expressive (full JS control over setup,
script, and checks). TB2 tasks trade that expressiveness for a portable,
human-readable directory format that can be authored without touching the harness
code. Both run on the same deterministic infrastructure (`harness.mjs`).

## Example: minimal task

```
bench/tb2/tasks/echo-marker/
  task.json
  prompt
  tests/
    test.sh
    test_output.sh
```

`task.json`:
```json
{ "name": "echo-marker", "description": "echoes a marker", "category": "core-tools" }
```

`prompt`:
```
Create a file called marker.txt with the exact line BENCH-MARKER-OK: 12345
```

`tests/test.sh`:
```bash
#!/bin/bash
set -e
test -f "$TB2_WORKSPACE/marker.txt"
grep -q 'BENCH-MARKER-OK: 12345' "$TB2_WORKSPACE/marker.txt"
```

`tests/test_output.sh`:
```bash
#!/bin/bash
set -e
grep -q 'marker.txt' "$TB2_AGENT_OUTPUT"
```

Run it:

```bash
node bench/tb2/run-tb2.mjs --filter echo-marker
```
