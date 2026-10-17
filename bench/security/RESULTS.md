# ox secure: measured results

`ox secure` (src/security-scan.js) is a line-and-file security scanner: 62 rules
over JavaScript/TypeScript, Python, Go, Java, PHP, Ruby, shell and templates,
each with its CWE and a fix, plus taint tracking within a file (a variable
assigned from request input counts as input where it is used later) and SQL
built in one statement and run in the next. Offline, no dependencies. The agent
runs it on every file it edits and is told, once, what it introduced.

Date: 2026-10-17, macOS arm64, Node 25.

## The numbers, in the order they were measured

Every first run is reported as it came out; the rules were then fixed and the
set re-run. A score measured after tuning on that same set is not independent:
the column says which is which.

| set | what it is | first run (untuned) | after fixes |
|---|---|---|---|
| labelled (`cases.mjs`) | 110 hand-written lines from the OWASP cheat sheets: 61 vulnerable, 49 safe lookalikes | 57/61 caught (93.4%), 3/49 false alarms (6.1%) | 62/62, 0/53 (5 lines from real code added) |
| held-out (`holdout.mjs`) | 45 new lines written after the tuning above, run once | **24/27 caught (88.9%), 0/18 false alarms** | 27/27, 0/18 |
| ox's own source | 189 files nobody wrote for a scanner | 96 findings, mostly false alarms (`regex.exec`, `setTimeout(fn)`) | 2 low (SHA-1 used as a cache key: correct) |
| OWASP NodeGoat | deliberately vulnerable app, 8 documented code-level issues | 2/8 | 7/8 (log injection missed: by design) |
| DVNA (appsecco) | deliberately vulnerable app, 7 documented issues; expected list fixed before running | **3/7** | 6/7 (data exposure in an API reply missed: by design) |

The two **bold** cells are the only independent measurements: written or chosen
before the rules were tuned on them, run once. The next independent number has
to come from another app nobody has tuned on.

## What it found in ox itself

Three real command-injection risks, fixed in the same change:

- `src/aas-cli.js`: skill names from a catalogue were pasted into a shell command
  line (`x; rm -rf ~` would have run). Now refused unless plain names and paths.
- `src/aas-catalog.js`: `npm view` and `curl` command strings built from package
  and repository names. Now argument arrays, no shell.
- `src/platform.js`: ``which ${name}`` through a shell. Now an argument array.

## Known limits

- Line and single-file analysis: data that flows through functions or across
  files is not followed. Taint is one level deep, by variable name.
- Semantic issues are out of reach of patterns: sensitive data in a response,
  missing authorization checks, log injection, business-logic flaws.
- Dependencies with known CVEs are not checked (that needs a vulnerability
  database; `npm audit` / `pip-audit` do it).
- No comparison with Semgrep, CodeQL or Bandit yet: none is installed here.

## Reproduce

    node bench/security/run.mjs --misses
    node bench/security/run-holdout.mjs --misses
    git clone --depth 1 https://github.com/OWASP/NodeGoat /tmp/NodeGoat && node bench/security/nodegoat.mjs /tmp/NodeGoat
    git clone --depth 1 https://github.com/appsecco/dvna /tmp/dvna && node bench/security/dvna.mjs /tmp/dvna
    node bin/ox.js secure src bin scripts
