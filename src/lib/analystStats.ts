import type { AnalystCoverage, AnalystRecommendations } from "@/types";

/** Upside to consensus mean at or above this is highlighted on feed cards. */
export const STRONG_UPSIDE_THRESHOLD = 0.15;

export function analystRatingTotal(rec?: AnalystRecommendations): number {
  if (!rec) return 0;
  return rec.strongBuy + rec.buy + rec.hold + rec.sell + rec.strongSell;
}

export function upsideVsSpot(spot: number, target: number): number {
  if (spot <= 0) return 0;
  return (target - spot) / spot;
}

export function consensusSpread(consensus?: AnalystCoverage["consensus"]): number | null {
  if (consensus?.high == null || consensus?.low == null) return null;
  return consensus.high - consensus.low;
}

export function consensusMean(coverage?: AnalystCoverage | null): number | undefined {
  const mean = coverage?.consensus?.mean;
  return mean != null && Number.isFinite(mean) && mean > 0 ? mean : undefined;
}

export function hasDisplayableTargets(coverage?: AnalystCoverage | null): boolean {
  if (!coverage) return false;
  return consensusMean(coverage) != null;
}

export function isStrongUpside(spot: number, coverage?: AnalystCoverage | null): boolean {
  const mean = consensusMean(coverage);
  if (mean == null || spot <= 0) return false;
  return upsideVsSpot(spot, mean) >= STRONG_UPSIDE_THRESHOLD;
}

/** Model a street range from Finnhub buy/hold/sell counts when consensus PT is unavailable. */
export function estimateConsensusFromRatings(
  spot: number,
  rec: AnalystRecommendations,
): NonNullable<AnalystCoverage["consensus"]> {
  const total = analystRatingTotal(rec);
  const bullish = rec.strongBuy * 1.15 + rec.buy - rec.sell * 0.9 - rec.strongSell * 1.2;
  const skew = total > 0 ? Math.max(-1, Math.min(1, bullish / total)) : 0;
  const meanUpside = 0.05 + ((skew + 1) / 2) * 0.22;
  const mean = spot * (1 + meanUpside);
  const band = mean * (0.1 + (1 - (skew + 1) / 2) * 0.06);
  return {
    mean,
    median: mean * 0.99,
    high: mean + band,
    low: Math.max(spot * 0.85, mean - band * 1.15),
    updatedAt: rec.period,
  };
}
