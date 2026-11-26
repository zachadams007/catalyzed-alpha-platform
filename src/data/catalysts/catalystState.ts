import type { CompanyData, RawCatalyst, StockSignal } from "@/types";

/**
 * The honest "no dated catalyst" value. A live record gets this UNTIL a REAL
 * structured catalyst event (8-K, 13D/13G, insider cluster, federal contract,
 * FDA approval, congress, newsletter-extracted) is attached. It is NEVER inferred
 * from a news headline. magnitude 0 + (callers set) catalystLive:false, so it
 * scores ~0 on the catalyst dimension and the UI hides the catalyst chip.
 *
 * Root-cause history (2026-06-20): every one of the ~500 daily_signals carried a
 * FABRICATED catalyst - `inferCatalystFromNews` turned any headline into a typed
 * catalyst with a made-up magnitude and stamped `catalystLive:true` (e.g. a
 * "CAN SLIM criteria" article became a "Regulatory catalyst landing today,
 * magnitude 0.85" on ANET), inflating the score and the ranking. Catalysts now
 * come ONLY from real events; otherwise this.
 */
export const NO_CATALYST: RawCatalyst = {
  type: "None",
  description: "No dated catalyst surfaced in our scan",
  daysAway: 365,
  magnitude: 0,
};

/** A fresh copy of the no-catalyst sentinel (so callers can spread/mutate safely). */
export function noCatalyst(): RawCatalyst {
  return { ...NO_CATALYST };
}

/**
 * True only for a GENUINE catalyst: explicitly live (from a real event), a real
 * type (not "None"), and a non-trivial magnitude. Scoring, ranking, and every
 * catalyst UI surface gate on this so a placeholder/no-catalyst never reads or
 * scores as a real one.
 */
export function isRealCatalyst(
  catalyst: RawCatalyst | undefined | null,
  catalystLive: boolean | undefined,
): boolean {
  if (!catalyst) return false;
  return catalystLive === true && catalyst.type !== "None" && catalyst.magnitude > 0;
}

/** Convenience: does this company/signal have a genuine catalyst? */
export function hasRealCatalyst(c: Pick<CompanyData | StockSignal, "catalyst" | "catalystLive">): boolean {
  return isRealCatalyst(c.catalyst, c.catalystLive);
}
