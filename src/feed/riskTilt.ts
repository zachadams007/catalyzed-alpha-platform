import { clamp, lerp, round } from "@/lib/math";
import { researchRankScore } from "@/engine/ranking";
import type { StockSignal } from "@/types";
import type { PrefilterGates } from "@/data/funnel/prefilter";

/**
 * The For-You risk dial (Mission 3). Reuses the existing `riskAppetite`
 * preference (0 = capital preservation … 1 = max aggression) and turns it into
 * THREE pure knobs, none of which touch the sum-to-1.0 scoring weights:
 *
 *   1. funnel breadth - scales the Stage-0 prefilter floors (a conservative
 *      dial keeps the universe to larger, more liquid names; aggressive opens it
 *      to smaller/thinner ones);
 *   2. risk penalty mult - re-weights the RISK penalty already inside the feed
 *      ranking key (conservative punishes risk harder);
 *   3. surfacing floor - a soft minimum ranking score below which low-conviction
 *      names are demoted for conservative users (never removed - feeds never empty).
 *
 * Everything here is pure. A tiny module-level mirror of the current appetite
 * lets the data provider (which runs at research time, decoupled from the store)
 * read the dial without importing the store.
 */

export const DEFAULT_RISK_APPETITE = 0.55;

/** Module mirror of the live risk appetite, pushed by the store. */
let currentRiskAppetite = DEFAULT_RISK_APPETITE;

export function setCurrentRiskAppetite(value: number): void {
  currentRiskAppetite = clamp(value, 0, 1);
}

export function getCurrentRiskAppetite(): number {
  return currentRiskAppetite;
}

export interface RiskTilt {
  /** Multiplier on the prefilter floors. >1 = stricter/safer, <1 = broader. */
  gateFactor: number;
  /** Multiplier on the risk penalty in the ranking key. >1 = risk hurts more. */
  penaltyFactor: number;
  /** Soft minimum ranking score to surface comfortably (conservative only). */
  surfaceFloor: number;
}

/** Map an appetite (0..1) onto the three tilt knobs. 0.55 ≈ neutral. */
export function riskTilt(appetite: number): RiskTilt {
  const a = clamp(appetite, 0, 1);
  return {
    gateFactor: lerp(1.7, 0.6, a), // safe → higher floors; aggressive → lower
    penaltyFactor: lerp(1.6, 0.5, a), // safe → punish risk; aggressive → forgive
    surfaceFloor: lerp(42, 0, a), // safe → hide weak names; aggressive → show all
  };
}

/** Scale the prefilter floors by the dial (price floor stays - it's a guardrail). */
export function riskAdjustGates(gates: PrefilterGates, appetite: number): PrefilterGates {
  const { gateFactor } = riskTilt(appetite);
  return {
    minPrice: gates.minPrice,
    minDollarVolume: Math.round(gates.minDollarVolume * gateFactor),
    minMarketCap: Math.round(gates.minMarketCap * gateFactor),
  };
}

/**
 * The ranking key with the dial's extra risk weighting folded in. The base
 * `researchRankScore` already subtracts 0.25 × riskPenalty; this adds (or gives
 * back) the marginal amount the dial calls for, plus a soft demotion for names
 * under the conservative surfacing floor.
 */
export function riskAdjustedRankScore(signal: StockSignal, appetite: number): number {
  const tilt = riskTilt(appetite);
  const base = researchRankScore(signal);
  const extraRisk = (tilt.penaltyFactor - 1) * 0.25 * signal.score.riskPenalty;
  let key = base - extraRisk;
  if (base < tilt.surfaceFloor) {
    // Soft floor: push sub-floor names down in proportion to the shortfall, so a
    // conservative dial buries low-conviction names without ever emptying a feed.
    key -= (tilt.surfaceFloor - base) * 0.5;
  }
  return round(key, 2);
}
