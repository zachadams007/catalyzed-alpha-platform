/**
 * Profitability truth helpers (the owner's #1 rule - never show a stale/fabricated
 * fundamental as real).
 *
 * The "SoFi unprofitable −19.8% net margin" bug came from trusting Finnhub's
 * `netProfitMarginTTM` field alone: for SoFi it read −19.8% while the company is
 * GAAP-profitable (TTM EPS +$0.44, P/E ~38). That single field lags/distorts, so
 * any "Unprofitable" label derived from it must be CORROBORATED before it shows.
 *
 * A POSITIVE trailing P/E can only exist with positive trailing earnings - so a
 * positive P/E is hard evidence the company is profitable, and overrides a
 * negative net-margin reading. Pure + framework-free so the engine, feed, and UI
 * can all share one rule.
 */

/** Positive trailing P/E ⇒ positive trailing earnings ⇒ profitable. */
export function hasPositiveEarningsEvidence(peRatio: number | null | undefined): boolean {
  return typeof peRatio === "number" && Number.isFinite(peRatio) && peRatio > 0;
}

/**
 * Should a name be labelled "unprofitable" from its net margin? Only when net
 * margin is negative AND nothing else proves it's profitable. A positive P/E
 * (real positive trailing earnings) vetoes the label - that's the SoFi guard.
 */
export function looksUnprofitable(
  netMargin: number | null | undefined,
  peRatio: number | null | undefined,
): boolean {
  if (typeof netMargin !== "number" || !Number.isFinite(netMargin) || netMargin >= 0) return false;
  return !hasPositiveEarningsEvidence(peRatio);
}
