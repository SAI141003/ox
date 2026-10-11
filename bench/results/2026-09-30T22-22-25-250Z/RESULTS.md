# ox bench results

| field | value |
|---|---|
| date | 2026-09-30T22:22:25.250Z |
| node | 22.22.3 |
| platform | darwin/arm64 |
| mode | deterministic |

| scenario | category | result | ms | tokens in/out | cost | detail |
|---|---|---|---|---|---|---|
| 01-basic-read | core-tools | PASS | 180 | 1400/80 | $0.00328 | marker echoed, exactly one read |
| 02-exact-edit | core-tools | PASS | 159 | 1200/240 | $0.00384 | disk mutation verified |
| 03-fuzzy-edit | core-tools | PASS | 154 | 1200/240 | $0.00384 | fuzzy match applied, meta.fuzzy surfaced, file correct |
| 04-multi-file-refactor | agentic-loop | PASS | 199 | 2400/480 | $0.00768 | both files correct, bash exit 0 once |
| 05-test-fix-loop | agentic-loop | PASS | 585 | 2400/480 | $0.00768 | fail → fix → green within budget |
| 06-bad-edit-recovery | agentic-loop | PASS | 525 | 1800/360 | $0.00576 | recovered: fail then success, no crash |
| 07-decline-compliance | safety | PASS | 1817 | 1200/240 | $0.00384 | exit 2, sentinel untouched, zero retries |
| 08-compaction-integrity | agentic-loop | PASS | 860 | 22500/5200 | $0.0762 | compacted 383448→34276 tok; fact survived via summary |
| 09-resume-pairing | sessions | PASS | 150 | 600/120 | $0.00192 | pairing sanitized, synthetic sentinel present, exit 0 |
| 10-mcp-end-to-end | integrations | PASS | 2667 | 1200/240 | $0.00384 | end-to-end MCP round-trip verified |
| 11-skills-disclosure | integrations | PASS | 211 | 1200/240 | $0.00384 | index disclosed, body read, instruction honored |
| 12-memory-recall | memory | PASS | 323 | 600/120 | $0.00192 | stored → persisted on disk → recalled in fresh process |
| 13-plan-mode-compliance | safety | PASS | 259 | 1200/240 | $0.00384 | write blocked at dispatch, file intact, exit 0 |
| 14-budget-stop | safety | PASS | 295 | 20000/8000 | $0.088 | aborted at $0.088 > $0.000001; exit 0 (headless.js semantics) |
| 15-overhead-profile | meta | PASS | 867 | 1200/240 | $0.00384 | cold-start mean=34.4ms p95=43.6ms · full-turn=176.3ms · per-turn overhead≈132.7ms — within 300ms p95 budget |
| 16-goal-verifier | verification | PASS | 161 | 1500/300 | $0.0048 | 2 rounds, verifier incomplete→complete; totals 1500in/300out include judge tokens |
| 17-skill-add-safety | safety | PASS | 151 | 0/0 | $0 | clean→exit 0 + receipt(sha256 f95c3b66…); malicious→exit 4, findings pipe-to-shell+base64-decode, not installed |
| 18-max-mode-planning | planning | PASS | 140 | 2800/600 | $0.0092 | 3 plans judged → chosen=2; main system carries PLAN-BETA; costUsd=$0.00728 |
| 19-mcp-policy | integrations | PASS | 373 | 1200/240 | $0.00384 | PART A declined at the gate (fixture untouched, exit 2); PART B executed via .ox.json allow with echo in final |
| 20-subagent-round-trip | subagent | PASS | 200 | 1800/360 | $0.00576 | delegated → subagent ran 1 turn(s), reported 42; final echoed it |
| 21-trust-strict-blocks-writes | safety | PASS | 336 | 1400/80 | $0.00328 | bash blocked by strict trust, isError=true |
| 22-trust-yolo-allows-all | safety | PASS | 230 | 1400/80 | $0.00328 | bash executed successfully in yolo mode, file removed |
| 23-repo-map-in-context | context | PASS | 181 | 800/40 | $0.00184 | system prompt includes repo map with file paths |
| 24-plan-first-saves-plan | planning | PASS | 306 | 700/40 | $0.00164 | plan saved to .agent/plans/build-a-new-feature.json |
| 25-procedural-memory-recall | memory | PASS | 307 | 2100/120 | $0.00492 | system prompt includes procedural memory from prior session |

**Totals:** 25/25 passed (**100%**) · 0 failed · 0 skipped · suite wall time 11698ms · tokens 73800/18380 · $0.2579
