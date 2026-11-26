import type { GroupCall } from "./types";

/**
 * Pure performance math for the call leaderboard. No I/O, no clock reads - the
 * caller passes `now` and the current prices, so this stays fully unit-testable
 * and deterministic (see __tests__/leaderboard.test.ts).
 *
 * Model (honest by design):
 *   • A call snapshots its price at call time (`calledPrice`). Return since the
 *     call is (current − called) / called.
 *   • A call is "pending" until it is at least CALL_MATURITY_MS old - a pick
 *     logged minutes ago has ≈0% move and must not crown anyone. Its live return
 *     is still shown; it just doesn't count toward the rank yet.
 *   • Only directional BUY calls feed the ranked score. A "watch" is
 *     informational - tracked with its return, but not a conviction bet, so it
 *     never moves the leaderboard. (TODO: optionally score watches separately.)
 *
 * Ranking is per-CALL, not per-member: every qualifying (scored) BUY call is
 * its own ranked row, sorted by that call's return descending. A member who
 * made several good calls can occupy several of the top spots - the board
 * celebrates the pick, not just the picker.
 */

/**
 * Wall-clock a call must age before it ranks. First-increment heuristic; a
 * trading-session-aware window (e.g. "next close") is a future refinement.
 */
export const CALL_MATURITY_MS = 60 * 60 * 1000; // 1 hour

export type CallStatus = "unpriced" | "pending" | "mature";

export interface CallPerformance {
  call: GroupCall;
  /** Best-available current price, or null when we have no quote for the ticker. */
  currentPrice: number | null;
  /** Signed return since the call, or null when unpriced. 0.034 = +3.4%. */
  returnPct: number | null;
  status: CallStatus;
  /** True only when this call counts toward the member's ranked score. */
  scored: boolean;
  /** Age of the call in ms (relative to the supplied `now`). */
  ageMs: number;
}

/**
 * One ranked row on the call leaderboard: a single BUY call, not a member
 * rollup. `rank` is 0-based and only ever set on scored calls - pending/
 * unpriced/watch calls are still returned (so the board can show them in
 * their existing "pending" affordance) but carry `rank: null`.
 */
export interface LeaderboardRow {
  perf: CallPerformance;
  /** 0-based rank among scored calls, or null when this call isn't ranked yet. */
  rank: number | null;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Compute the performance of a single call given the current price and `now`.
 * Pure. Returns a fully-typed status so the UI never has to re-derive it.
 */
export function computeCallPerformance(
  call: GroupCall,
  currentPrice: number | null | undefined,
  now: number,
): CallPerformance {
  const ageMs = Math.max(0, now - new Date(call.calledAt).getTime());
  const priceOk = isPositiveFinite(currentPrice);
  const calledOk = isPositiveFinite(call.calledPrice);

  if (!priceOk || !calledOk) {
    return {
      call,
      currentPrice: priceOk ? (currentPrice as number) : null,
      returnPct: null,
      status: "unpriced",
      scored: false,
      ageMs,
    };
  }

  const price = currentPrice as number;
  const returnPct = (price - call.calledPrice) / call.calledPrice;
  const mature = ageMs >= CALL_MATURITY_MS;
  // Only matured, directional BUY calls feed the ranked score.
  const scored = mature && call.direction === "buy";

  return {
    call,
    currentPrice: price,
    returnPct,
    status: mature ? "mature" : "pending",
    scored,
    ageMs,
  };
}

/** Distinct upper-cased tickers across a set of calls (what to fetch prices for). */
export function callTickers(calls: GroupCall[]): string[] {
  return [...new Set(calls.map((c) => c.ticker.trim().toUpperCase()))];
}

/** Performance for every call, newest first - powers the ledger view. */
export function rankCalls(
  calls: GroupCall[],
  currentPrices: Record<string, number | null | undefined>,
  now: number,
): CallPerformance[] {
  return calls
    .map((call) => computeCallPerformance(call, currentPrices[call.ticker.trim().toUpperCase()], now))
    .sort((a, b) => new Date(b.call.calledAt).getTime() - new Date(a.call.calledAt).getTime());
}

/**
 * Build the ranked call leaderboard from the raw call ledger + current prices.
 *
 * Ranking: every scored (matured, priced, BUY) call is its own row, ranked by
 * that call's return, highest first - so a member who made several strong
 * calls can take several of the top spots. Ties break deterministically by
 * call age (older/earlier call ranks first) then ticker. Pending, unpriced,
 * and watch calls are still returned - un-ranked (`rank: null`) - sorted
 * newest first, so the board can show "in flight" calls without hiding them.
 */
export function buildLeaderboard(
  calls: GroupCall[],
  currentPrices: Record<string, number | null | undefined>,
  now: number,
): LeaderboardRow[] {
  const perfs = calls.map((call) =>
    computeCallPerformance(call, currentPrices[call.ticker.trim().toUpperCase()], now),
  );

  const scored = perfs
    .filter((p) => p.scored && p.returnPct != null)
    .sort((a, b) => {
      const diff = (b.returnPct as number) - (a.returnPct as number);
      if (diff !== 0) return diff;
      const timeDiff = new Date(a.call.calledAt).getTime() - new Date(b.call.calledAt).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.call.ticker.trim().toUpperCase().localeCompare(b.call.ticker.trim().toUpperCase());
    });

  const unranked = perfs
    .filter((p) => !(p.scored && p.returnPct != null))
    .sort((a, b) => new Date(b.call.calledAt).getTime() - new Date(a.call.calledAt).getTime());

  const rows: LeaderboardRow[] = scored.map((perf, i) => ({ perf, rank: i }));
  for (const perf of unranked) rows.push({ perf, rank: null });
  return rows;
}
