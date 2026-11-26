/**
 * Pure helpers for the two-ticker compare view (the Phase-3 multi-pane seed).
 *
 * Price math + a head-to-head verdict, kept pure + deterministic so they're
 * unit-testable and reusable by both columns and the verdict strip. Research /
 * discovery framing only - "ahead" means ahead on the named, objective metric,
 * never a buy/sell call.
 */

/** Trailing return over `lookback` closes (0.05 = +5%), or null if too short. */
export function returnOver(closes: ReadonlyArray<number>, lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const last = closes[closes.length - 1]!;
  const prior = closes[closes.length - 1 - lookback]!;
  if (!Number.isFinite(last) || !Number.isFinite(prior) || prior === 0) return null;
  return (last - prior) / prior;
}

/** How far the price sits below the 52-week high, as a ratio (−0.2 = 20% below). */
export function pctFromHigh(price: number, closes: ReadonlyArray<number>): number | null {
  if (!closes.length || !Number.isFinite(price)) return null;
  const hi = Math.max(...closes);
  if (!Number.isFinite(hi) || hi === 0) return null;
  return (price - hi) / hi;
}

export type Side = "a" | "b" | "tie";

/** A snapshot of one side, reduced to the comparable scalars. */
export interface CompareSide {
  ticker: string;
  score: number;
  /** 3-month trailing return, or null. */
  momentum: number | null;
  /** Discount to the 52-week high (≤ 0), or null. Less negative = nearer the high. */
  fromHigh: number | null;
  /** Market cap in USD, or null when missing/zero/unknown (never shown as $0). */
  marketCap: number | null;
  /** Analyst upside ratio, or null when no coverage. */
  upside: number | null;
}

export interface CompareMetric {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  /** Which side leads on this metric (or "tie"/can't-compare). */
  winner: Side;
  /** True when a higher value is the leader (drives the verdict + styling). */
  higherWins: boolean;
}

function decide(a: number | null, b: number | null, higherWins: boolean): Side {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return "tie";
  if (a === b) return "tie";
  const aLeads = higherWins ? a > b : a < b;
  return aLeads ? "a" : "b";
}

/**
 * Build the head-to-head metric rows. "Discount to 52w high" treats the more
 * discounted name as ahead (a value lens); every other metric rewards the
 * higher value. Market cap is informational (no winner).
 */
export function buildComparison(a: CompareSide, b: CompareSide): CompareMetric[] {
  return [
    { key: "score", label: "Opportunity score", a: a.score, b: b.score, higherWins: true, winner: decide(a.score, b.score, true) },
    { key: "momentum", label: "3-month return", a: a.momentum, b: b.momentum, higherWins: true, winner: decide(a.momentum, b.momentum, true) },
    { key: "fromHigh", label: "Discount to 52w high", a: a.fromHigh, b: b.fromHigh, higherWins: false, winner: decide(a.fromHigh, b.fromHigh, false) },
    { key: "upside", label: "Analyst upside", a: a.upside, b: b.upside, higherWins: true, winner: decide(a.upside, b.upside, true) },
    { key: "marketCap", label: "Market cap", a: a.marketCap, b: b.marketCap, higherWins: true, winner: "tie" },
  ];
}

/** Tally how many comparable metrics each side leads. */
export function tallyWins(metrics: ReadonlyArray<CompareMetric>): { a: number; b: number } {
  let aWins = 0;
  let bWins = 0;
  for (const m of metrics) {
    if (m.key === "marketCap") continue; // informational, never a "win"
    if (m.winner === "a") aWins += 1;
    else if (m.winner === "b") bWins += 1;
  }
  return { a: aWins, b: bWins };
}
