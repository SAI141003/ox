# ox bench results

| field | value |
|---|---|
| date | 2026-10-01T00:23:07.489Z |
| node | 22.22.3 |
| platform | darwin/arm64 |
| mode | deterministic |

| scenario | category | result | ms | tokens in/out | cost | detail |
|---|---|---|---|---|---|---|
| 14-budget-stop | safety | PASS | 130 | 20000/8000 | $0.088 | aborted at $0.088 > $0.000001; exit 2 via budget-stop (reason=cost-cap) |

**Totals:** 1/1 passed (**100%**) · 0 failed · 0 skipped · suite wall time 131ms · tokens 20000/8000 · $0.088
