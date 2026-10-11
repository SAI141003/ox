---
name: tdd-workflow
description: Test-driven development workflow: write a failing test first, implement minimal code to pass, then refactor.
metadata:
  category: quality
  trigger: command
---

# TDD Workflow

Follow strict test-driven development for every change.

1. Write a failing test that captures the intended behavior. Name it clearly after the behavior under test.
2. Run the test suite and confirm the new test fails for the expected reason (not due to syntax or import errors).
3. Implement the minimum code needed to make the test pass. Do not add extra functionality.
4. Run the full test suite. All tests must pass before proceeding.
5. Refactor the production code for clarity, performance, or structure while keeping tests green. Re-run tests after each refactor step.
6. Commit with a message that references the test coverage added.

Rules:
- Never write production code before a failing test exists.
- If no test framework is configured, ask before choosing one.
- Keep tests fast, deterministic, and isolated.
