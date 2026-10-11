---
name: git-hygiene
description: Use when committing, branching, or preparing a pull request. Keeps history reviewable and never loses work.
---
# Version-control hygiene

- Check status before you start and before you commit. Know what is staged.
- Work on a branch, never directly on the main branch.
- One logical change per commit. Subject in the imperative (under 70 chars); body says why.
- Stage files by name. Never commit secrets, build output, or editor junk; fix .gitignore instead.
- Run the tests before committing. Do not commit a red tree unless the message says so.
- Never force-push a shared branch, rewrite published history, or delete branches without asking.
- To set work aside, commit it (a WIP commit is fine) rather than relying on a shared stash.
