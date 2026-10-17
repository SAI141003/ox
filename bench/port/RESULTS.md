# ox port: a project to another language (measured)

Date 2026-10-17, ChatGPT plan through Codex (gpt-6-luna), macOS arm64.

## Inventory, without a model

`ox port <project> --inventory` reads the code only. On OWASP NodeGoat (27
modules, 2,032 lines): a dependency order with data access before routes before
the server; 20 libraries to replace (Node's own modules left out); and the
external factors the port must keep: `MONGODB_URI`, `NODE_ENV`, `PORT`, MongoDB,
four remote endpoints, a native module, the Dockerfile and docker-compose.yml.

## A port, end to end

The small shop from `bench/build` (orders with coupons, the Gold discount ox
built from a requirement, and a ledger loaded from `LEDGER_PATH`, default
`data/ledger.json`), 3 modules and 11 tests, ported to Python:

    ox port . --to py --out ../shop-py --bot chatgpt-plan -y

- Order: history.js → orders.js → store.js (leaves first).
- Result: 3/3 modules, `python3 -m pytest -q`: **11 passed**, the same 11 cases
  as the JavaScript tests.
- External factors: the check found `LEDGER_PATH` and `data/ledger.json` in
  the port (`os.environ.get("LEDGER_PATH") or "data/ledger.json"`).
- Read by hand: the Gold threshold is still strict (`> 100000` cents), refunds
  still subtract, the larger discount still wins.
- Said by the model, as the brief asks: an invalid date raises `ValueError` in
  Python, where JavaScript's invalid `Date` silently left the entry out. A real
  difference in behaviour, reported instead of hidden.
- Observed: in step 1 the model wrote all three modules at once; steps 2 and 3
  then checked and fixed rather than wrote. The plan still recorded each step.

One small project: this shows the method works end to end; it is not evidence
about a large codebase. That needs a port of a real project with its own test
suite (planned: a mid-size open-source library with good tests).

## Reproduce

    ox port <project> --inventory
    ox port <project> --to py --out <dir> --bot chatgpt-plan -y
    ox port <project> --to py --out <dir> --check
