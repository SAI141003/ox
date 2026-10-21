---
name: loop-until-done
description: Use when the user wants a task repeated until a check passes ("keep going until the tests pass", "loop until the build is green", "retry until it works"), or re-run on a timer. A bounded loop with a real check, never an endless one.
---
# Loop until done

A loop is a task, a check that says done or not done, and a limit.

## Before the first round
- Name the check as a command whose exit code decides: `npm test`, `npm run build`,
  `curl -fsS localhost:3000/health`. If the user gave none, propose one and use it.
- Set the limit: 8 rounds unless the user says otherwise. Say both out loud.

## Each round
1. Run the check. Done (exit 0)? Stop and report.
2. Read the failure: the first error, its file and line.
3. Change one thing that addresses that error. Never weaken, skip or delete a test,
   and never edit the check itself to make it pass.
4. Note the round in one line: what failed, what you changed.

## Stop early when
- The same failure comes back twice after different fixes: report it, with what
  you tried, instead of guessing again.
- A fix would need something only the user can give (a key, a decision, access).

## On a timer
For "every morning" or "every hour", use `ox schedule "<task>" --every 1h` (or
`--at 07:45`); each run is one bounded loop as above.

## Report
Rounds used, final check output (last lines), and each round's one-line note.
