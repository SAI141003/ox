# ox bench results

| field | value |
|---|---|
| date | 2026-10-01T19:38:59.376Z |
| node | 22.22.3 |
| platform | darwin/arm64 |
| mode | deterministic |

| scenario | category | result | ms | tokens in/out | cost | detail |
|---|---|---|---|---|---|---|
| 01-basic-read | core-tools | PASS | 287 | 1400/80 | $0.00328 | marker echoed, exactly one read |
| 02-exact-edit | core-tools | PASS | 419 | 1200/240 | $0.00384 | disk mutation verified |
| 03-fuzzy-edit | core-tools | PASS | 212 | 1200/240 | $0.00384 | fuzzy match applied, meta.fuzzy surfaced, file correct |
| 04-multi-file-refactor | agentic-loop | PASS | 949 | 2400/480 | $0.00768 | both files correct, bash exit 0 once |
| 05-test-fix-loop | agentic-loop | PASS | 347 | 2400/480 | $0.00768 | fail → fix → green within budget |
| 06-bad-edit-recovery | agentic-loop | PASS | 181 | 1800/360 | $0.00576 | recovered: fail then success, no crash |
| 07-decline-compliance | safety | PASS | 207 | 1200/240 | $0.00384 | exit 2, sentinel untouched, zero retries |
| 08-compaction-integrity | agentic-loop | PASS | 510 | 22500/5200 | $0.0762 | compacted 385708→36563 tok; fact survived via summary |
| 09-resume-pairing | sessions | PASS | 131 | 600/120 | $0.00192 | pairing sanitized, synthetic sentinel present, exit 0 |
| 10-mcp-end-to-end | integrations | PASS | 2692 | 1200/240 | $0.00384 | end-to-end MCP round-trip verified |
| 11-skills-disclosure | integrations | PASS | 178 | 1200/240 | $0.00384 | index disclosed, body read, instruction honored |
| 12-memory-recall | memory | PASS | 295 | 600/120 | $0.00192 | stored → persisted on disk → recalled in fresh process |
| 13-plan-mode-compliance | safety | PASS | 182 | 1200/240 | $0.00384 | write blocked at dispatch, file intact, exit 0 |
| 14-budget-stop | safety | PASS | 131 | 20000/8000 | $0.088 | aborted at $0.088 > $0.000001; exit 2 via budget-stop (reason=cost-cap) |
| 15-overhead-profile | meta | PASS | 715 | 1200/240 | $0.00384 | cold-start mean=27.8ms p95=41.7ms · full-turn=159.0ms · per-turn overhead≈117.3ms — within 300ms p95 budget |
| 16-goal-verifier | verification | PASS | 162 | 1500/300 | $0.0048 | 2 rounds, verifier incomplete→complete; totals 1500in/300out include judge tokens |
| 17-skill-add-safety | safety | PASS | 137 | 0/0 | $0 | clean→exit 0 + receipt(sha256 f95c3b66…); malicious→exit 4, findings pipe-to-shell+base64-decode, not installed |
| 18-max-mode-planning | planning | PASS | 141 | 2800/600 | $0.0092 | 3 plans judged → chosen=2; main system carries PLAN-BETA; costUsd=$0.00728 |
| 19-mcp-policy | integrations | PASS | 337 | 1200/240 | $0.00384 | PART A declined at the gate (fixture untouched, exit 2); PART B executed via .ox.json allow with echo in final |
| 20-subagent-round-trip | subagent | PASS | 233 | 1800/360 | $0.00576 | delegated → subagent ran 1 turn(s), reported 42; final echoed it |
| 21-trust-strict-blocks-writes | safety | PASS | 182 | 1400/80 | $0.00328 | bash blocked by strict trust, isError=true |
| 22-trust-yolo-allows-all | safety | PASS | 222 | 1400/80 | $0.00328 | bash executed successfully in yolo mode, file removed |
| 23-repo-map-in-context | context | PASS | 169 | 800/40 | $0.00184 | system prompt includes repo map with file paths |
| 24-plan-first-saves-plan | planning | PASS | 249 | 700/40 | $0.00164 | plan saved to .agent/plans/build-a-new-feature.json |
| 25-procedural-memory-recall | memory | PASS | 169 | 2100/120 | $0.00492 | system prompt includes procedural memory from prior session |

**Totals:** 25/25 passed (**100%**) · 0 failed · 0 skipped · suite wall time 9472ms · tokens 73800/18380 · $0.2579
