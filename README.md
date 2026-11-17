# DipSnap — a patient dip-buyer for btc-race-24h-20261117-0603

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars,
long only, starting from $1,000 of paper money. It runs as `main.ts` (Node 22,
erasable TypeScript) under the `agent-fun/bars-replay/v1` protocol; the only
dependency is the vendored `vendor/makefun-bars.ts` shim, a byte-identical copy
of the kit's SDK.

## The idea

One-minute BTC moves about 6 bps per bar on the dev window, while a full-size
round trip costs about 26–35 bps (4 bps fee + 2 bps slippage + pool impact on
each leg). Fast trend, momentum and mean-reversion rules all lose money there:
they trade far too often for moves that small. The only rules that made money
were the ones that waited for something extreme and then sat still.

So DipSnap does almost nothing, on purpose:

- **Entry.** It watches the 15-minute return. A drop of 70 bps or more in 15
  minutes is a dislocation. On the dev window the hourly returns mean-revert
  hard (lag-1 autocorrelation about −0.38), so a sharp 15-minute fall is
  usually followed by a slow recovery over the next hours. On that signal it
  buys with the whole equity, once.
- **Exit.** It sells when the price has risen 120 bps above the entry close,
  or when a fresh 15-minute rip of 100 bps or more shows the move is
  exhausting itself, or when the price has fallen 150 bps below the entry
  close (a hard stop for the days the dip keeps dipping).
- **Rest.** After any sell it rests for 30 bars before it may buy again, so a
  choppy stretch cannot make it buy the same dip twice.
- **Fallback.** If it has still made no trade by bar 1200 it buys a quarter of
  the equity on the next bar, just so the entry meets the competition's
  one-trade bar even on a dead-calm day; the same exits apply.

Everything is deterministic: the only inputs are the closes the harness sends.
No clock, no randomness, no network, no files.

## Local results (dev window, 1,440 bars)

Backtested offline with the harness's own fill model (validated to the cent
against `grade-local` on the buy-and-hold baseline, net PnL $1.067187):

| Strategy | Net PnL | Trades | Max DD |
| --- | --- | --- | --- |
| DipSnap (this bot) | **+$18.36** | 4 | 1.0% |
| buy-and-hold | +$1.07 | 1 | 2.1% |
| best slow EMA cross tested | −$12.65 | 7 | 1.8% |
| best Bollinger mean reversion tested | −$24.74 | 12 | 2.6% |
| best hourly momentum tested | −$15.30 | 10 | 1.6% |

Robustness (same bot, no retuning): time-reversed dev window +$12.96, three
block-shuffled copies +$17.65 / +$18.83 / +$30.92 — while buy-and-hold loses
on all four. The edge is the dislocation-recovery shape, not one event.

## Layout

- `main.ts` — the bot (the only authored file).
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, byte-identical.
- `LICENSE` — MIT.
