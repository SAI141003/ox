---
name: paper-trading-team
description: Use when the user wants an AI trading team to test a strategy (scanner, risk, trader, exits), a "trading bot", or to simulate trades. Paper trading only: simulated money, never real orders.
---
# Paper-trading team (simulation only)

ox never places real trades, moves money, or connects to an exchange or broker
account with order rights. This skill runs a simulated team on public market
data and a paper ledger, so a strategy can be tested before anyone risks money.
Say this once at the start. It is not financial advice.

## The team (an `ox org team`, or four subagents)
1. **Scanner**: finds candidates from public data (prices, volumes, new listings)
   by the user's rules; writes each with its reason.
2. **Risk**: checks each candidate (liquidity, spread, concentration, the user's
   limits, red flags such as tiny liquidity or one wallet holding most of a token).
   It can **reject**; a rejection is final for that round and is logged with why.
3. **Trader**: enters only what Risk approved, as **paper** entries: size by the
   user's rules, the price at the time, fees and slippage assumed.
4. **Exits**: closes paper positions by the user's rules (target, stop, time),
   and keeps the running result.

Set it up with: `ox org team "a paper-trading team: scanner, risk with veto,
paper trader, exits; simulation only, never real orders"`, then review the hires.

## The ledger
`paper-ledger.csv` in the project: time, symbol, side, size, price, fees, reason,
who decided, risk verdict. Results are computed from it, never from memory.

## Report
Trades taken and rejected (with Risk's reasons), simulated profit and loss after
fees, worst drawdown, and what the strategy would need to be tested further.
Never present a simulated result as money made.
