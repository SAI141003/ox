---
name: verify-before-done
description: Use before saying work is finished, fixed, or passing. Claims need fresh evidence from this session.
---
# Verify before done

Before claiming success, run the check that proves it and read the output:

- "tests pass" -> run them now; quote the pass/fail counts.
- "it builds" -> run the build; quote the last lines.
- "bug fixed" -> rerun the original reproduction.
- "UI works" -> load it and look (screenshot or page text), not just "it compiles".

Report exactly what ran and what it showed. If something was skipped or failed, say so plainly.
Never say "should work". Either it was verified, or it was not.
