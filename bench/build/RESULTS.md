# ox build: a requirement to proven code (measured)

Date 2026-10-17, ChatGPT plan through Codex (gpt-6-luna), macOS arm64.

The project: a small shop (orders with coupons, an empty purchase ledger, one
test), made by `bench/build/mkshop.mjs` so the run can be repeated. The
requirement, as a business person would write it:

> Loyal customers should be rewarded. Anyone who spent more than 1,000 dollars
> with us in the last 12 months is Gold and gets 5% off every order. Gold doesn't
> add up with coupons: the customer gets whichever discount is bigger. Refunds
> count against what they spent.

## What happened

1. **Spec**: 7 acceptance criteria (Gold over the threshold, not Gold at or
   under it, 5% off, the bigger discount wins, no doubling, refunds subtract,
   activity outside 12 months ignored), the files to change, and three open
   questions with the assumption made (a rolling window ending now, inclusive
   boundaries, existing coupon conventions).
2. **Tests first**: it wrote the tests named AC-1…AC-7, ran them, and reported
   they failed because `isGold` did not exist yet.
3. **Code**: `netSpend` and `isGold` in history.js, the larger discount in
   orders.js; `npm test` passed (8 tests: 7 new, the old one kept).
4. **Trace**: each criterion's tests run on their own: **7/7 pass**.

Read by hand afterwards: the threshold is strict (`> 100000` cents, "more than"),
refunds subtract, the window is 12 months, discounts do not stack. Two flaws a
reviewer would raise: an `import` placed mid-file, and a `GOLD5` coupon added
that nobody asked for (scope creep the spec's out-of-scope list did not catch).

One run, one requirement: this shows the pipeline works end to end on a real
model; it is not a success rate. A rate needs many requirements, with and
without `ox build`, on the same model.

## Reproduce

    node bench/build/mkshop.mjs /tmp/shop && cd /tmp/shop
    ox build "<the requirement above>" --bot chatgpt-plan -y
    ox spec trace

With a plan (ChatGPT, Claude), the run happens inside the vendor's CLI: ox's
in-loop gates and security check apply to runs ox drives itself (API keys,
local models); the trace afterwards applies to both.
