import { clamp, percentileRank, scaleBand, scaleLinear } from "@/lib/math";
import { LIQUIDITY_BANDS } from "@/engine/scoringConfig";

/**
 * Stage 1 of the full-market funnel - a PURE prefilter.
 *
 * Given cheap screener rows (price, market cap, dollar volume, beta) it applies
 * the liquidity / price / size FLOOR gates, then ranks survivors by a cheap
 * composite and slices the top-N for full per-name hydration + scoring. The
 * composite deliberately leans the *discovery* set toward small/mid, liquid,
 * tradable names - the anti-megacap tilt starts here, before the scorer ever
 * runs. Megacaps still pass the floor (they belong in the universe); they simply
 * don't dominate the candidate pool by size alone.
 *
 * Pure and deterministic: same input + N always yields the same selection,
 * with a stable symbol tiebreak, so the daily research cache never drifts.
 */

export interface ScreenerCandidate {
  /** Uppercase ticker. */
  symbol: string;
  /** Spot price, USD. */
  price: number;
  /** Market cap, USD. 0 = unknown (rejected by the cap floor). */
  marketCap: number;
  /** Average traded value per day, USD (price × share volume). */
  dollarVolume: number;
  /** Levered beta, when the screener reports it. */
  beta?: number;
  /** Sector label from the screener row (for the discovery-mode blend). */
  sector?: string;
}

export interface PrefilterGates {
  /** Minimum spot price (penny-stock floor). */
  minPrice: number;
  /** Minimum average daily dollar volume (tradability floor). */
  minDollarVolume: number;
  /** Minimum market cap (nano-junk floor; NOT a megacap ceiling). */
  minMarketCap: number;
}

/** Default floors: >$5, >$1M ADV (LIQUIDITY_BANDS.thin), >$50M cap. */
export const DEFAULT_PREFILTER_GATES: PrefilterGates = {
  minPrice: 5,
  minDollarVolume: LIQUIDITY_BANDS.thin,
  minMarketCap: 50_000_000,
};

export interface PrefilterResult {
  /** Gated, ranked, and sliced to top-N - ready for hydration. */
  passed: ScreenerCandidate[];
  /** Distinct candidates considered (after symbol dedupe). */
  screenedCount: number;
  /** Candidates clearing every gate (before the top-N slice). */
  passedCount: number;
  /** Candidates actually selected (= passed.length, ≤ topN). */
  selectedCount: number;
  /** The gates applied (for honest telemetry). */
  gates: PrefilterGates;
}

/** Composite weights - liquidity-led with a deliberate small/mid (anti-megacap) tilt. */
const W_LIQUIDITY = 0.45;
const W_SIZE_TILT = 0.35;
const W_MOVEMENT = 0.2;

function compositeScore(c: ScreenerCandidate, sizePercentile: number): number {
  // Liquidity: log-banded between the $1M floor and $1B institutional depth.
  const liquidity = scaleLinear(
    Math.log10(Math.max(c.dollarVolume, 1)),
    Math.log10(LIQUIDITY_BANDS.thin),
    Math.log10(LIQUIDITY_BANDS.deep),
  );
  // Size tilt: smaller cap → higher score (sizePercentile is high for megacaps).
  const sizeTilt = clamp((1 - sizePercentile) * 100, 0, 100);
  // Movement: reward tradable beta around ~1.3; flat 50 when beta is unknown.
  const movement = c.beta != null && Number.isFinite(c.beta) ? scaleBand(c.beta, 1.3, 1.3) : 50;
  return W_LIQUIDITY * liquidity + W_SIZE_TILT * sizeTilt + W_MOVEMENT * movement;
}

export function prefilterUniverse(
  candidates: ScreenerCandidate[],
  gates: PrefilterGates,
  topN: number,
): PrefilterResult {
  // Dedupe by symbol (first occurrence wins).
  const bySymbol = new Map<string, ScreenerCandidate>();
  for (const c of candidates) {
    const sym = c.symbol?.trim().toUpperCase();
    if (!sym || bySymbol.has(sym)) continue;
    bySymbol.set(sym, { ...c, symbol: sym });
  }
  const deduped = [...bySymbol.values()];
  const screenedCount = deduped.length;

  const passedAll = deduped.filter(
    (c) =>
      c.price > gates.minPrice &&
      c.dollarVolume > gates.minDollarVolume &&
      c.marketCap > gates.minMarketCap,
  );
  const passedCount = passedAll.length;

  // Cross-sectional size percentile across survivors (log cap for scale-free spread).
  const logCaps = passedAll.map((c) => Math.log10(Math.max(c.marketCap, 1)));
  const sizePct = percentileRank(logCaps);

  const ranked = passedAll
    .map((c, i) => ({ c, score: compositeScore(c, sizePct[i] ?? 0.5) }))
    .sort((a, b) => b.score - a.score || (a.c.symbol < b.c.symbol ? -1 : a.c.symbol > b.c.symbol ? 1 : 0));

  const selected = ranked.slice(0, Math.max(0, Math.floor(topN))).map((r) => r.c);

  return {
    passed: selected,
    screenedCount,
    passedCount,
    selectedCount: selected.length,
    gates,
  };
}
