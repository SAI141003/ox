---
name: refactor-safely
description: Use when restructuring code without changing behaviour - renames, extractions, moving modules, simplifying.
---
# Refactor safely

1. Make sure tests cover the behaviour you are about to move. Add characterisation tests if not.
2. Change structure in small steps; run tests after each step.
3. Never mix a refactor with a behaviour change in the same step or commit.
4. For renames and moves, grep every reference (imports, strings, docs, configs) before and after.
5. Delete dead code you proved dead; do not leave commented-out copies.
6. Stop when the code is clear enough for the task at hand. Refactoring has no finish line.
