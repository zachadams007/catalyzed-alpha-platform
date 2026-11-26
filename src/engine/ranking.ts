import type { StockSignal } from "@/types";
import { clamp, round } from "@/lib/math";

/**
 * Ranking score used by feeds/screens.
 *
 * Opportunity stays the visible model score. Ranking gets a light evidence tilt
 * so exciting but thinly sourced signals do not dominate the feed.
 */
export function researchRankScore(signal: StockSignal): number {
  const opportunity = signal.score.opportunityScore;
  const confidenceTilt = (signal.confidence - 70) * 0.18;
  const riskTilt = signal.score.riskPenalty * 0.25;
  return round(clamp(opportunity + confidenceTilt - riskTilt), 1);
}
