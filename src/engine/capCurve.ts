import type { ScoreCategoryKey } from "@/types";

/**
 * Cap-cohort weight curves (v2 - fix large-cap over-representation).
 *
 * The universal cap-balancing in normalizeUniverse.ts (size-residualize the
 * coverage dims + a zero-mean structural size tilt) makes the ranking cap-NEUTRAL.
 * This module adds the second half: it judges small/micro names on the WEIGHT
 * CURVE the research says actually predicts THEIR runs (revenue growth, Rule-of-40,
 * a contract/backlog, catalyst + hype WITH substance) instead of large-cap
 * financials. Each name's per-dimension blend weights are chosen by its size
 * cohort, so a great small-cap setup is no longer scored as if it had to look like
 * a mega-cap to rank.
 *
 * Pure + deterministic: market cap in, a fixed weight vector out. The vectors are
 * the §1.7 priors of the build spec; the backtest grid-search may re-tune them, but
 * both must always sum to 1.0 (asserted below) so the cross-sectional z-blend stays
 * a proper weighted average.
 */

export type CapCohort = "small" | "mid" | "large" | "unknown";

export type ArchetypeKey =
  | "megaReversal"
  | "compounder"
  | "smallRunner"
  | "misunderstoodQuality";

export interface ArchetypeFlags {
  /** T1: quality large/mega cap washed out vs its own base, with fundamentals bottoming/improving. */
  megaReversal?: boolean;
  /** T2: large/mid compounder with revenue/margin re-acceleration and non-parabolic momentum. */
  compounder?: boolean;
  /** T3: small/micro runner with a fresh reason, early trend, and room to grow. */
  smallRunner?: boolean;
  /**
   * T4: a profitable large-cap in a deep drawdown whose CONTRACTED demand is
   * still compounding far faster than recognized revenue - the market is pricing
   * the near-term spend/leverage while the disclosed order book says demand grew.
   * Requires DISCLOSED pipeline evidence (SEC XBRL RPO / contract liabilities), so
   * it can never fire on narrative alone. See `inferArchetypeFlags`.
   */
  misunderstoodQuality?: boolean;
}

export interface RegimeContext {
  /** 0 = risk-on / normal, 1 = risk-off. Computed upstream and passed in. */
  riskOffness?: number;
  /** Human label for audit/explainer surfaces. */
  label?: "risk-on" | "neutral" | "risk-off";
  /** Fear & Greed reading 0-100 (0 = extreme fear). CNN's live index when the scan
   *  could fetch it, else the internal composite (see engine/regime.ts). */
  fearGreed?: number;
  /** Banded label for the fearGreed value (extreme-fear … extreme-greed). */
  fearGreedLabel?: "extreme-fear" | "fear" | "neutral" | "greed" | "extreme-greed";
  /** Where the fearGreed number came from. */
  fearGreedSource?: "cnn" | "internal";
  /** Last SPY close used by the upstream scan/backtest, when available. */
  spyClose?: number;
  /** SPY 200-day moving average used by the upstream scan/backtest, when available. */
  spySma200?: number;
  /** SPY 50-day moving average used only as a correction-pressure read. */
  spySma50?: number;
  /** (SPY close / 200-DMA) - 1. Negative means below trend. */
  spyDistanceToSma200?: number;
  /** (SPY close / 50-DMA) - 1. Negative means below short trend. */
  spyDistanceToSma50?: number;
  /** SPY trailing 21-trading-day return, used as correction-pressure context. */
  spyReturn21d?: number;
  /** Share of the scored universe above its own 50-DMA, when available. */
  breadthAboveSma50Pct?: number;
  /** Short audit string explaining why the tilt landed where it did. */
  reason?: string;
}

/**
 *   • smaller  ≤ $2B - catalyst / early-runner / pipeline-led (SMALL_CAP_WEIGHTS)
 *   • middle   $2B–$10B - revenue/margin RE-acceleration led (MID_CAP_WEIGHTS)
 *   • larger   > $10B - discounted-quality reversal + margin inflection + entry
 *                         timing (LARGE_CAP_WEIGHTS)
 * An UNKNOWN / unquoted cap (≤0 or non-finite) routes to the SMALL curve (the
 * discovery default) and is reported as "unknown" - NEVER hard-failed, NEVER folded
 * to Nano (honors the "Unknown never hard-fails" lock). {@link effectiveCapCohort}
 * upgrades an unknown that trades like a mega-cap ($1B+/day) to the large curve.
 */
export const SMALL_CAP_CEILING_USD = 2_000_000_000;
export const MID_CAP_CEILING_USD = 10_000_000_000;

export function capCohort(marketCap: number): CapCohort {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "unknown";
  if (marketCap <= SMALL_CAP_CEILING_USD) return "small";
  if (marketCap <= MID_CAP_CEILING_USD) return "mid";
  return "large";
}

/**
 * Effective cohort for WEIGHT ROUTING - folds in liquidity so a cap-UNKNOWN name
 * that trades like a mega-cap (>$1B/day dollar volume, e.g. the TSM ADR that
 * published with marketCap 0) is judged on the LARGE curve instead of the small
 * discovery default (P2, refinement proposal 2026-07-02 §3c). A genuine small-cap
 * never trades $1B+/day, so this can't misfire downward; a thin unknown keeps the
 * small curve. Liquidity is REAL data - no fabricated market cap.
 */
export function effectiveCapCohort(marketCap: number, avgDollarVolume?: number): CapCohort {
  const cohort = capCohort(marketCap);
  if (cohort === "unknown" && (avgDollarVolume ?? 0) > 1_000_000_000) return "large";
  return cohort;
}

export type WeightVector = Record<ScoreCategoryKey, number>;

const WEIGHT_KEYS: ScoreCategoryKey[] = [
  "inflection",
  "conviction",
  "pipeline",
  "catalyst",
  "sentimentShift",
  "growth",
  "valuation",
  "momentum",
  "volatility",
  "news",
  "social",
  "fundamentals",
  "liquidity",
];

function normalizeWeightVector(raw: Partial<WeightVector>): WeightVector {
  const sum = WEIGHT_KEYS.reduce((acc, key) => acc + (raw[key] ?? 0), 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new Error("capCurve weights must have a positive finite sum");
  }

  const out = {} as WeightVector;
  for (const key of WEIGHT_KEYS) out[key] = (raw[key] ?? 0) / sum;
  return out;
}

function averageWeightVectors(vectors: WeightVector[]): WeightVector {
  const out = {} as WeightVector;
  for (const key of WEIGHT_KEYS) {
    out[key] = vectors.reduce((sum, vector) => sum + vector[key], 0) / vectors.length;
  }
  return out;
}

function blendWeightVectors(base: WeightVector, target: WeightVector, targetWeight: number): WeightVector {
  const raw = {} as WeightVector;
  const w = Math.min(1, Math.max(0, targetWeight));
  for (const key of WEIGHT_KEYS) {
    raw[key] = base[key] * (1 - w) + target[key] * w;
  }
  return normalizeWeightVector(raw);
}

/**
 * SMALL / MICRO curve (down to the ~$300M floor enforced in the scan). Weights the
 * leading signals for a small-cap run: a hard pipeline (backlog/contract), an early
 * catalyst, the fundamental inflection, a sentiment shift WITH substance, and raw
 * revenue growth. Trailing/quality factors (fundamentals, raw news/social volume)
 * are de-emphasized - a small-cap is not judged by mega-cap financials.
 */
export const SMALL_CAP_WEIGHTS: WeightVector = {
  inflection: 0.1618181818,
  conviction: 0.1,
  pipeline: 0.1387012987,
  catalyst: 0.1387012987,
  sentimentShift: 0.1213636364,
  growth: 0.1040909091,
  valuation: 0.0866233766,
  momentum: 0.0693506494,
  volatility: 0.0520779221,
  news: 0.0172727273,
  social: 0.01,
  fundamentals: 0.0,
  liquidity: 0.0,
};

/**
 * LARGE curve. Weights the margin/profit inflection plus entry timing and trend
 * (the CVNA/ANF/POWL large-cap pattern), with fundamentals as a real (not minority)
 * sanity check and the speculative dims (pipeline/volatility/raw social) lighter.
 */
export const LARGE_CAP_WEIGHTS: WeightVector = {
  inflection: 0.2042857143,
  conviction: 0.07,
  catalyst: 0.1262857143,
  sentimentShift: 0.1082448980,
  valuation: 0.1082448980,
  momentum: 0.1082448980,
  fundamentals: 0.0721632653,
  pipeline: 0.0742857143,
  news: 0.0541224490,
  social: 0.02,
  growth: 0.0360816327,
  volatility: 0.0180408163,
  liquidity: 0.0,
};

/**
 * MIDDLE curve ($2B–$10B) - the owner's mid-cap strategy: the name is judged mainly on
 * revenue/margin RE-acceleration (the 2nd-derivative inflection that leads a mid-cap
 * re-rating - the CVNA/ANF/POWL pattern before it's a large cap), with real growth
 * and a building pipeline, a catalyst, and a moderate valuation/trend read. Heavier
 * on inflection+growth than the large curve, heavier on fundamentals+valuation than
 * the small curve - it sits deliberately between the two.
 */
export const MID_CAP_WEIGHTS: WeightVector = normalizeWeightVector({
  inflection: 0.2,
  catalyst: 0.13,
  pipeline: 0.12,
  sentimentShift: 0.11,
  growth: 0.1,
  valuation: 0.09,
  momentum: 0.09,
  conviction: 0.07,
  fundamentals: 0.04,
  volatility: 0.02,
  news: 0.02,
  social: 0.01,
  liquidity: 0,
});

/** T1 profile: discounted quality reversal with improving fundamentals. */
export const MEGA_REVERSAL_WEIGHTS: WeightVector = normalizeWeightVector({
  inflection: 0.24,
  conviction: 0.1,
  valuation: 0.16,
  pipeline: 0.06,
  catalyst: 0.1,
  sentimentShift: 0.1,
  momentum: 0.06,
  fundamentals: 0.06,
  growth: 0.04,
  volatility: 0.05,
  news: 0.02,
  social: 0.01,
  liquidity: 0,
});

/** T2 profile: re-accelerating large/mid compounder with bounded, healthy trend. */
export const COMPOUNDER_WEIGHTS: WeightVector = normalizeWeightVector({
  inflection: 0.22,
  conviction: 0.07,
  catalyst: 0.12,
  sentimentShift: 0.12,
  momentum: 0.12,
  pipeline: 0.1,
  growth: 0.1,
  valuation: 0.06,
  fundamentals: 0.04,
  news: 0.03,
  social: 0.01,
  volatility: 0.01,
  liquidity: 0,
});

/** T3 profile: small/micro runner. No small-cap discount requirement; lead on
 * catalyst + inflection + pipeline + room-to-grow, with social kept at pump-risk
 * levels. */
export const SMALL_RUNNER_WEIGHTS: WeightVector = normalizeWeightVector({
  pipeline: 0.18,
  inflection: 0.18,
  conviction: 0.1,
  catalyst: 0.15,
  sentimentShift: 0.11,
  growth: 0.08,
  valuation: 0.08,
  momentum: 0.06,
  volatility: 0.03,
  news: 0.02,
  social: 0.01,
  fundamentals: 0,
  liquidity: 0,
});

/**
 * PANIC-OPPORTUNITY tilt (P9 redesign, owner request 2026-07-03) - what the model leans
 * toward when the market regime is fearful/risk-off.
 *
 * NOT a flight-to-safety: the old RISK_OFF_WEIGHTS made low VOLATILITY the single largest weight
 * (0.23) - a defensive-rotation posture. By the time a fear index confirms panic,
 * defensives/gold/banks have already been bid and the risky tail has already been sold -
 * rotating then is buying high and selling low.
 *
 * So this vector leans inflection + valuation + fundamentals + catalyst, halves
 * momentum (don't chase trend through a panic), and keeps volatility a small
 * sanity weight rather than the headline. The blend still riskOffness-scales in
 * regimeTiltOverlay, and pumpRisk/extension guards + the risk-penalty multiplier
 * (quality discipline) are unchanged elsewhere.
 */
export const PANIC_QUALITY_WEIGHTS: WeightVector = normalizeWeightVector({
  inflection: 0.19,
  valuation: 0.17,
  fundamentals: 0.13,
  catalyst: 0.12,
  conviction: 0.08,
  pipeline: 0.08,
  growth: 0.07,
  sentimentShift: 0.05,
  momentum: 0.05,
  volatility: 0.04,
  news: 0.01,
  social: 0.01,
  liquidity: 0,
});

/**
 * T4 profile: the MISUNDERSTOOD large cap - deeply discounted, still profitable,
 * and carrying a disclosed order book growing far faster than recognized revenue.
 *
 * The defining feature of this archetype is that its PRICE TREND IS BAD. That is
 * the setup, not a disqualifier, so momentum is given the smallest weight of any
 * profile (0.02 - kept non-zero only so a genuine vertical collapse still reads
 * slightly worse than an orderly one). The evidence load is carried by `pipeline`
 * (the disclosed contracted demand), `valuation` (the drawdown is the entry), and
 * `fundamentals` (it must still be a real, profitable business - this is what
 * separates a repricing from a value trap).
 */
export const MISUNDERSTOOD_QUALITY_WEIGHTS: WeightVector = normalizeWeightVector({
  pipeline: 0.24,
  valuation: 0.19,
  fundamentals: 0.15,
  inflection: 0.13,
  growth: 0.09,
  catalyst: 0.07,
  conviction: 0.05,
  sentimentShift: 0.04,
  momentum: 0.02,
  news: 0.01,
  volatility: 0.01,
  social: 0,
  liquidity: 0,
});

const ARCHETYPE_PROFILES: Record<ArchetypeKey, WeightVector> = {
  megaReversal: MEGA_REVERSAL_WEIGHTS,
  compounder: COMPOUNDER_WEIGHTS,
  smallRunner: SMALL_RUNNER_WEIGHTS,
  misunderstoodQuality: MISUNDERSTOOD_QUALITY_WEIGHTS,
};

function activeArchetypes(flags: ArchetypeFlags | undefined): ArchetypeKey[] {
  if (!flags) return [];
  return (Object.keys(ARCHETYPE_PROFILES) as ArchetypeKey[]).filter((key) => flags[key] === true);
}

/** Weight vector for a cohort (UNKNOWN uses the small/discovery curve). */
export function cohortWeights(cohort: CapCohort): WeightVector {
  switch (cohort) {
    case "large":
      return LARGE_CAP_WEIGHTS;
    case "mid":
      return MID_CAP_WEIGHTS;
    default:
      return SMALL_CAP_WEIGHTS; // small + unknown (discovery default)
  }
}

/**
 * Bend the base size-cohort vector toward the matching archetype profile. This is
 * deliberately an overlay, not a hard branch: untagged names keep their base
 * cohort vector, and multi-tagged names blend the active profiles before the base
 * overlay is applied. The returned vector is normalized and asserted below.
 */
export function archetypeOverlay(
  base: WeightVector,
  flags?: ArchetypeFlags,
  overlayStrength = 0.62,
): WeightVector {
  const active = activeArchetypes(flags);
  if (active.length === 0) return base;
  const target = averageWeightVectors(active.map((key) => ARCHETYPE_PROFILES[key]));
  return blendWeightVectors(base, target, overlayStrength);
}

export function regimeTiltOverlay(base: WeightVector, regime?: RegimeContext): WeightVector {
  const riskOffness = Math.min(1, Math.max(0, regime?.riskOffness ?? 0));
  if (riskOffness <= 0) return base;
  return blendWeightVectors(base, PANIC_QUALITY_WEIGHTS, riskOffness);
}

/**
 * Convenience: pick the per-name weight vector straight from a market cap. Pass
 * `avgDollarVolume` so a cap-UNKNOWN but highly-liquid name routes to the large
 * curve (see {@link effectiveCapCohort}); omit it and unknown stays on the small
 * discovery curve (backward-compatible with every existing caller).
 */
export function capCurveWeights(
  marketCap: number,
  flags?: ArchetypeFlags,
  regime?: RegimeContext,
  avgDollarVolume?: number,
): WeightVector {
  return regimeTiltOverlay(
    archetypeOverlay(cohortWeights(effectiveCapCohort(marketCap, avgDollarVolume)), flags),
    regime,
  );
}

/**
 * V5 challenger (reversal / breakout-first): the fraction of momentum's blend weight
 * to KEEP; the rest is redistributed into the early-entry dimensions.
 *
 * The owner's thesis (2026-07-01): we hunt reversals and breakouts BEFORE the move, not
 * names already mid- or late-breakout - so a name being below its moving averages
 * (which drags the momentum sub-score) should barely matter. Cutting momentum's
 * weight ~70% lets the "catch it early" signals (a fundamental inflection, a
 * discounted entry, a fresh catalyst, a turning conversation) carry the pick. Runs
 * in the SHADOW challenger only, so the live board is measured against it before it
 * could ever go live.
 */
export const V5_MOMENTUM_WEIGHT_SCALE = 0.3;

/** Where momentum's freed weight goes - the leading signals that actually precede a
 *  reversal / breakout, in priority order for the degenerate-fallback case. */
const V5_MOMENTUM_REALLOC: ScoreCategoryKey[] = [
  "inflection",
  "valuation",
  "catalyst",
  "sentimentShift",
  "pipeline",
];

/**
 * Cut a weight vector's momentum weight to `scale` of its value and redistribute the
 * freed weight into the early-entry dimensions (proportional to their current
 * weight). Pure; the returned vector still sums to 1.0. `scale` ≥ 1 → unchanged;
 * `scale` = 0 → momentum removed entirely.
 */
export function dampMomentumWeight(v: WeightVector, scale: number): WeightVector {
  const s = Math.min(1, Math.max(0, scale));
  const freed = v.momentum * (1 - s);
  if (freed <= 0) return v;
  const raw: WeightVector = { ...v, momentum: v.momentum * s };
  const targetSum = V5_MOMENTUM_REALLOC.reduce((acc, k) => acc + (v[k] ?? 0), 0);
  if (targetSum > 0) {
    for (const k of V5_MOMENTUM_REALLOC) raw[k] += freed * ((v[k] ?? 0) / targetSum);
  } else {
    raw.inflection += freed;
  }
  return normalizeWeightVector(raw);
}

// --- Dev invariant: each curve must be a proper weighted-average (sums to 1.0). ---
function assertSumsToOne(label: string, w: WeightVector): void {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`capCurve ${label} weights must sum to 1.0 (got ${sum.toFixed(4)})`);
  }
}
assertSumsToOne("small", SMALL_CAP_WEIGHTS);
assertSumsToOne("mid", MID_CAP_WEIGHTS);
assertSumsToOne("large", LARGE_CAP_WEIGHTS);
assertSumsToOne("megaReversal", MEGA_REVERSAL_WEIGHTS);
assertSumsToOne("compounder", COMPOUNDER_WEIGHTS);
assertSumsToOne("smallRunner", SMALL_RUNNER_WEIGHTS);
assertSumsToOne("misunderstoodQuality", MISUNDERSTOOD_QUALITY_WEIGHTS);
assertSumsToOne("panicQuality", PANIC_QUALITY_WEIGHTS);
