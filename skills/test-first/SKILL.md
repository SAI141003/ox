---
name: test-first
description: Use when adding behaviour or fixing a bug. Write the failing test before the code, watch it fail for the right reason, then make it pass.
---
# Test first

1. Find how this project runs tests (package.json, Makefile, pyproject, CI config). Use that command, nothing invented.
2. Write one test for the next small behaviour. For a bug, the test reproduces the report.
3. Run it. It must fail, and the failure message must be about the missing behaviour, not a typo or import error.
4. Write the least code that makes it pass. Run the test again.
5. Run the surrounding test file, then the full suite if it is cheap.
6. Refactor only while green. Re-run after each refactor.

A test that cannot fail proves nothing: if you never saw it red, delete it or make it able to fail.
