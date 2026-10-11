---
name: coding-standards
description: Coding standards: consistent style, patterns, and conventions across the codebase.
metadata:
  category: quality
  trigger: command
---

# Coding Standards

Enforce consistency and readability in every change.

1. Match the existing code style: indentation, brace placement, naming conventions, and import ordering.
2. Use the project's configured linter and formatter. Do not suggest manual formatting over tool output.
3. Prefer explicit over clever code. Avoid one-liners that reduce readability.
4. Keep functions small and single-purpose. Extract complex logic into well-named helpers.
5. Add or update docstrings/comments only where the existing codebase already documents behavior.
6. Follow existing architectural patterns (layers, modules, error handling) instead of introducing new ones.

Rules:
- If no style guide exists, propose one in the PR description and apply it consistently to changed files.
- Do not reformat untouched files.
