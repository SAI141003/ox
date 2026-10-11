---
name: code-review
description: Use when asked to review a diff, branch, or pull request, or before merging your own change. Finds real defects, ranked by severity.
---
# Code review

Read the diff, then the code around each hunk. For every change ask:

1. Correctness: wrong condition, off-by-one, missing await, unhandled null, wrong variable.
2. Contracts: does every caller still get what it expects? Grep for callers.
3. Failure paths: what happens on timeout, empty input, partial write, retry?
4. Security: untrusted input reaching a shell, SQL, file path, URL, or HTML.
5. Tests: is the new behaviour tested by a test that would fail without it?

Report each finding as: file:line, what breaks, a concrete input that triggers it, the fix.
Rank most severe first. Skip style nits unless asked. Say "no defects found" when that is true.
