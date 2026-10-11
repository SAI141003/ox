---
name: root-cause-debugging
description: Use when something fails, errors, or behaves unexpectedly. Find the cause with evidence before changing code.
---
# Root-cause debugging

1. Reproduce. Get the exact command and the exact output. No reproduction, no fix.
2. Read the whole error, top to bottom, including the first frame inside this project.
3. Form one hypothesis that explains every symptom. Write it down.
4. Test the hypothesis with the cheapest probe: a log line, a one-off script, a narrower test.
5. If the probe disagrees, discard the hypothesis. Do not stack fixes on a wrong theory.
6. Fix the cause, not the symptom. Add a test that would have caught it.
7. Search for the same mistake elsewhere (grep the pattern) and fix those too.

Three failed fixes in a row means the model of the system is wrong: stop, re-read the code path end to end.
