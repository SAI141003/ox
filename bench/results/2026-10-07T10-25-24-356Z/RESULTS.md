# ox bench results

| field | value |
|---|---|
| date | 2026-10-07T10:25:24.356Z |
| node | 22.22.3 |
| platform | darwin/arm64 |
| mode | deterministic |

| scenario | category | result | ms | tokens in/out | cost | detail |
|---|---|---|---|---|---|---|
| 01-basic-read | core-tools | PASS | 243 | 1400/80 | $0.00328 | marker echoed, exactly one read |
| 02-exact-edit | core-tools | PASS | 183 | 1200/240 | $0.00384 | disk mutation verified |
| 03-fuzzy-edit | core-tools | PASS | 203 | 1200/240 | $0.00384 | fuzzy match applied, meta.fuzzy surfaced, file correct |
| 04-multi-file-refactor | agentic-loop | PASS | 319 | 2400/480 | $0.00768 | both files correct, bash exit 0 once |
| 05-test-fix-loop | agentic-loop | PASS | 391 | 2400/480 | $0.00768 | fail → fix → green within budget |
| 06-bad-edit-recovery | agentic-loop | PASS | 197 | 1800/360 | $0.00576 | recovered: fail then success, no crash |
| 07-decline-compliance | safety | PASS | 179 | 1200/240 | $0.00384 | exit 2, sentinel untouched, zero retries |
| 08-compaction-integrity | agentic-loop | PASS | 449 | 22500/5200 | $0.0762 | compacted 386000→36854 tok; fact survived via summary |
| 09-resume-pairing | sessions | PASS | 138 | 600/120 | $0.00192 | pairing sanitized, synthetic sentinel present, exit 0 |
| 10-mcp-end-to-end | integrations | PASS | 2682 | 1200/240 | $0.00384 | end-to-end MCP round-trip verified |
| 11-skills-disclosure | integrations | PASS | 201 | 1200/240 | $0.00384 | index disclosed, body read, instruction honored |
| 12-memory-recall | memory | PASS | 316 | 600/120 | $0.00192 | stored → persisted on disk → recalled in fresh process |
| 13-plan-mode-compliance | safety | FAIL | 77 | 0/0 | $0 | exitCode=4 |
| 14-budget-stop | safety | PASS | 144 | 20000/8000 | $0.088 | aborted at $0.088 > $0.000001; exit 2 via budget-stop (reason=cost-cap) |
| 15-overhead-profile | meta | PASS | 676 | 1200/240 | $0.00384 | cold-start mean=24.8ms p95=26.3ms · full-turn=177.9ms · per-turn overhead≈151.6ms — within 300ms p95 budget |
| 16-goal-verifier | verification | PASS | 168 | 1500/300 | $0.0048 | 2 rounds, verifier incomplete→complete; totals 1500in/300out include judge tokens |
| 17-skill-add-safety | safety | PASS | 150 | 0/0 | $0 | clean→exit 0 + receipt(sha256 f95c3b66…); malicious→exit 4, findings pipe-to-shell+base64-decode, not installed |
| 18-max-mode-planning | planning | PASS | 145 | 2800/600 | $0.0092 | 3 plans judged → chosen=2; main system carries PLAN-BETA; costUsd=$0.00728 |
| 19-mcp-policy | integrations | PASS | 357 | 1200/240 | $0.00384 | PART A declined at the gate (fixture untouched, exit 2); PART B executed via .ox.json allow with echo in final |
| 20-subagent-round-trip | subagent | PASS | 208 | 1800/360 | $0.00576 | delegated → subagent ran 1 turn(s), reported 42; final echoed it |
| 21-trust-strict-blocks-writes | safety | PASS | 178 | 1400/80 | $0.00328 | bash blocked by strict trust, isError=true |
| 22-trust-yolo-allows-all | safety | PASS | 187 | 1400/80 | $0.00328 | bash executed successfully in yolo mode, file removed |
| 23-repo-map-in-context | context | PASS | 145 | 800/40 | $0.00184 | system prompt includes repo map with file paths |
| 24-plan-first-saves-plan | planning | FAIL | 75 | 0/0 | $0 | exitCode=4 stderr=✗ --plan refused: stdin is not a TTY, so no plan review can run and nobody approved this plan.   No plan was built, nothing was applied, and the agent was not started.   Re-run from a terminal to revi |
| 25-procedural-memory-recall | memory | PASS | 187 | 2100/120 | $0.00492 | system prompt includes procedural memory from prior session |

**Totals:** 23/25 passed (**92%**) · 2 failed · 0 skipped · suite wall time 9574ms · tokens 71900/18100 · $0.2524
