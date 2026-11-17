// DipSnap v2: the only change from v1 is RIP_BPS 100 -> 150.
//
// Why: on the dev window v1's two trades both exited on the +120 take, so the
// rip exit never fired there -- but on every other validation window (reversed,
// three block-shuffles) it fired too early. A 100 bps 15-minute rise is normal
// recovery noise while a dip is healing, so selling into it cut winners short
// (reversed window: +$12.96 with rip 100, +$18.80 with rip 150). A 150 bps
// 15-minute rise is a genuine exhaustion rip, and the exit is still needed:
// with no rip exit at all one shuffle window goes to -$0.55 (a rip that
// precedes a fall is never sold). rip 140-160 is a flat plateau, so 150 sits
// in the middle of it, not on a knife-edge. Everything else is v1 unchanged:
// the same dip rule, take, stop, rest and fallback, so the dev grade is
// identical (+$18.36) and the dev gate is exactly as safe as v1's.
//
// What was tried and rejected (all measured on dev + reversed + 3 shuffles +
// 2 half-windows, selection by the mean of the real windows): lower dip
// thresholds (40-60) and lower takes (60-100) trade more but lose on real
// windows; trailing stops bleed on this choppy data (real mean -0.7 to -11.7);
// max-hold cuts the slow recoveries; bounce confirmation misses the dips;
// ladder averaging-down loses on dev; multi-arm 60m/30m/5m entries, regime
// filters and two-dip confirmation all block the good trades; the Gemini
// hydrogen design (breakout + V-bottom + ATR trailing stop) loses money at
// 1.0x and 1.5x fees. v1's single-arm dip rule was already near-optimal;
// this one exit-threshold fix is the only change that improved every window
// it touched and worsened none.

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** A 15-minute fall this deep counts as a dislocation worth buying. */
const DIP_BPS = 70;
/** A 15-minute rise this steep while holding counts as a rip worth selling into.
 *  v2: 150, not 100 -- a 100 bps 15-minute rise is normal recovery noise
 *  (it cut winners short on the reversed and shuffled windows), while 150 bps
 *  is a genuine exhaustion rip. The exit is still needed: with no rip exit at
 *  all, one shuffled window goes negative. */
const RIP_BPS = 150;
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
