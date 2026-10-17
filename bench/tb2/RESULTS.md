# ox tb2 results

| field | value |
|---|---|
| date | 2026-10-17T04:26:40.399Z |
| node | 22.22.3 |
| platform | darwin/arm64 |

| task | category | result | ms | tokens in/out | detail |
|---|---|---|---|---|---|
| task-01 | file-io | PASS | 8205 | 26555/47 | ok |
| task-02 | file-editing | PASS | 11086 | 41015/185 | ok |
| task-03 | code-creation | PASS | 11541 | 53858/308 | ok |
| task-04 | safety | PASS | 6934 | 26611/108 | ok |
| task-05 | memory | FAIL | 10165 | 73282/244 | test.sh: FAIL: .agent/MEMORY.md does not exist |
| task-06 | mcp | FAIL | 10089 | 55349/291 | test_output.sh: FAIL: Transcript does not contain TB2-MCP-8821 |

**Totals:** 4/6 passed (**66.7%**) · 2 failed · 0 skipped · suite wall time 58167ms · tokens 276670/1183
