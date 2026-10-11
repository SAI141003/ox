---
name: plan-first
description: Use before any change touching more than one file or taking more than a few steps. Turns a request into a short ordered plan with a check per step.
---
# Plan first

1. Restate the goal in one sentence. If you cannot, ask one question, then stop.
2. Read before planning: the files you will change, their tests, and one caller of each.
3. Write the plan as numbered steps. Each step names:
   - the file(s) it touches,
   - the observable result ("test X passes", "command Y prints Z").
4. Order steps so each one leaves the project working. Put the riskiest step early.
5. Mark steps that are independent; those can run in parallel (see parallel-delegation).
6. Track the plan with todo_write. Update it as reality changes; never silently drop a step.

Stop and re-plan when a step's check fails twice for the same reason.
