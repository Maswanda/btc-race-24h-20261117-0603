// DipSnap: a patient dip-buyer for cbBTC on 1-minute bars, long only.
//
// The market this bot was built for is a choppy one: on the dev window a 1-minute
// bar moves about 6 bps on average, while one full-size round trip costs about
// 26-35 bps in fee, slippage and pool impact. Every fast trend, momentum and
// mean-reversion rule I tried on that window lost money, because each one traded
// far too often for moves that small. The only rules that made money were the
// ones that waited for something extreme and then sat still.
//
// So this bot does almost nothing, on purpose:
//
//   - It watches the 15-minute return of each symbol. A 15-minute drop of 70 bps
//     or more is a dislocation: on the dev window the hourly returns mean-revert
//     hard (lag-1 autocorrelation about -0.38), so a sharp 15-minute fall is
//     usually followed by a slow recovery over the next hours, not by more falling.
//   - On that signal it buys with the whole equity, once, and then waits for the
//     recovery: it sells when the price has risen 120 bps above the entry close,
//     or when a fresh 15-minute rip of 100 bps or more shows the move is
//     exhausting itself, or when the price has fallen 150 bps below the entry
//     close (a hard stop, for the days the dip keeps dipping).
//   - After any sell it rests for 30 bars before it may buy again, so a choppy
//     stretch cannot make it buy the same dip twice.
//   - If it has still made no trade by bar 1200 it buys a quarter of the equity
//     on the next bar, just so the entry meets the competition's one-trade bar
//     even on a dead-calm day; the same exits apply to that trade.
//
// Everything here is deterministic: the only inputs are the closes the harness
// sends, and the only state is a short history of them plus a few numbers. No
// clock, no randomness, no network, no files.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** A 15-minute fall this deep counts as a dislocation worth buying. */
const DIP_BPS = 70;
/** A 15-minute rise this steep while holding counts as a rip worth selling into. */
const RIP_BPS = 100;
/** Take profit: this many bps above the entry close. */
const TAKE_BPS = 120;
/** Hard stop: this many bps below the entry close. */
const STOP_BPS = 150;
/** Bars to rest after a sell before buying again. */
const REST_BARS = 30;
/** If no trade has filled by this batch, take a small participation trade. */
const FALLBACK_BAR = 1200;
/** The participation trade risks this share of the equity (in bps). */
const FALLBACK_BPS = 2500;
/** How far past the decision close a fill may move before the market refuses it. */
const MAX_SLIPPAGE_BPS = 100;
/** The return window, in bars. */
const WINDOW_BARS = 15;

/** What the bot remembers about one symbol. */
interface Tape {
  /** Closes, oldest first, one per batch that carried a bar. */
  closes: number[];
  /** The close the current position was bought on, or null when flat. */
  entryClose: number | null;
  /** The batch after which buying is allowed again (after a sell). */
  restUntil: number;
  /** A sell was sent and its fill has not been seen yet. */
  awaitingSell: boolean;
}

const tapes = new Map<string, Tape>();
/** Filled orders of the bot's own, counted from the batches' fills. */
let filledTrades = 0;

function tapeFor(symbol: string): Tape {
  let tape = tapes.get(symbol);
  if (tape === undefined) {
    tape = { closes: [], entryClose: null, restUntil: -1, awaitingSell: false };
    tapes.set(symbol, tape);
  }
  return tape;
}

/** The return over the last WINDOW_BARS bars, in bps, or null without the history. */
function windowReturn(tape: Tape): number | null {
  const n = tape.closes.length;
  if (n <= WINDOW_BARS) return null;
  const now = tape.closes[n - 1];
  const then = tape.closes[n - 1 - WINDOW_BARS];
  if (then === 0) return null;
  return ((now / then) - 1) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // The harness's own closes do not count as trades; count the bot's fills.
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) filledTrades++;
    }

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const orders: (SellInput | BuyInput)[] = [];

    for (const bar of batch.bars) {
      const symbol = bar.symbol;
      const tape = tapeFor(symbol);
      // Record every bar, warm-up ones included, so the return window is
      // already seeded when the scored window starts.
      tape.closes.push(Number(bar.c));
      if (state.warmingUp) continue;
      const ret = windowReturn(tape);
      if (ret === null) continue;

      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const entry = tape.entryClose;
        if (entry === null) continue;
        const close = Number(bar.c);
        const up = close > entry * (1 + TAKE_BPS / 10000);
        const rip = ret > RIP_BPS;
        const down = close < entry * (1 - STOP_BPS / 10000);
        if (up || rip || down) {
          // Send the sell every bar while the reason holds: the market may
          // refuse one (a price past the slippage cap), and a refused sell
          // must be retried, not forgotten. The entry is cleared only when
          // the position is actually gone (see the reconcile step below).
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          tape.awaitingSell = true;
        }
        continue;
      }

      // Flat: buy the dislocation, or the small fallback trade late in the window.
      const dip = ret < -DIP_BPS;
      const fallback = filledTrades === 0 && state.seq >= FALLBACK_BAR;
      if (!dip && !fallback) continue;
      if (state.seq < tape.restUntil) continue;

      const weightRoom = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let spend = state.cash < weightRoom ? state.cash : weightRoom;
      if (fallback && !dip) {
        // The participation trade is small on purpose: it only exists to meet
        // the one-trade bar on a dead-calm day, not to bet the equity on it.
        const quarter = (BigInt(FALLBACK_BPS) * state.equity) / BPS;
        if (quarter < spend) spend = quarter;
      }
      if (spend < minNotional) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
      tape.entryClose = Number(bar.c);
      if (orders.length >= caps.max_orders_per_bar) break;
    }

    // Reconcile: a tape that was awaiting a sell whose position is now gone
    // means the sell filled on this batch; clear the entry and start the rest.
    // (Clearing on the sell's fill, not on sending it, so a refused sell is
    // retried on the next bar instead of stranding the position.)
    for (const [symbol, tape] of tapes) {
      if (tape.awaitingSell && !state.positions.has(symbol)) {
        tape.awaitingSell = false;
        tape.entryClose = null;
        tape.restUntil = state.seq + REST_BARS;
      }
    }

    return orders.slice(0, caps.max_orders_per_bar);
  },
});
