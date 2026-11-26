import type { ScoreCategoryKey } from "@/types";

/**
 * Central, tunable configuration for the scoring engine.
 *
 * Everything that decides "what is a good signal" lives here so the math in
 * scoring.ts stays mechanical and the model is easy to audit and re-tune.
 * See docs/scoring-framework.md for the rationale behind each number.
 */

export interface CategoryConfig {
  key: ScoreCategoryKey;
  label: string;
  /** Blend weight. The positive-category weights sum to 1.0. */
  weight: number;
  /**
   * Applies to EVERY model's cross-sectional normalization
   * (src/engine/normalizeUniverse.ts) - champion and challenger alike; it is keyed
   * off this flag, not the per-model NormalizationOptions. When true, the dimension
   * is scored RELATIVE TO ITS SECTOR (sector mean removed) before the
   * cross-sectional rank - so "good for a utility" isn't punished against "good for
   * a chip stock". Applied to the slow-moving quality factors; the across-sector
   * "this space is hot" dimensions deliberately keep their level.
   */
  sectorNeutral?: boolean;
  /**
   * Applies to EVERY model's cross-sectional normalization - champion and
   * challenger alike (keyed off this flag, not the per-model NormalizationOptions).
   * When true, the dimension is RESIDUALIZED against log(market cap) before ranking
   * - stripping the raw size/coverage edge (a megacap gets more headlines and
   * volume by virtue of being big).
   */
  sizeResidualized?: boolean;
}

/**
 * Positive categories and their blend weights (must sum to 1.0).
 *
 * v2 ("Pre-Move Inflection Engine"): the weights shift OUT of raw attention (news +
 * social) and pure momentum and INTO the *leading* signals the research shows
 * actually precede a major run - a fundamental/margin INFLECTION off a depressed
 * base, a hard PIPELINE (backlog/contract), and a SENTIMENT-SHIFT vs the name's own
 * baseline - alongside the unified, type-agnostic catalyst strength and a
 * depressed-base-aware entry timing. P/E is never a gate and high P/E is never
 * down-weighted; `inflection` carries "catch it before it's obvious". These are the
 * STARTING priors - the point-in-time backtest grid-searches them - and the live
 * ranking additionally routes the per-name weights by cap cohort (see capCurve.ts)
 * so small/micro names are judged on the curve that predicts THEIR runs.
 *
 * NOTE: these flags (sectorNeutral / sizeResidualized) apply to EVERY model's
 * cross-sectional normalization. The slow quality + leading-fundamental factors are
 * sector-relative; the raw coverage/volume dims are size-residualized.
 */
export const CATEGORY_CONFIG: CategoryConfig[] = [
  { key: "inflection", label: "Fundamental Inflection", weight: 0.18, sectorNeutral: true },
  { key: "conviction", label: "Conviction Buying", weight: 0.08 },
  { key: "catalyst", label: "Catalyst Strength", weight: 0.12 },
  { key: "sentimentShift", label: "Sentiment Shift", weight: 0.13, sizeResidualized: true },
  { key: "pipeline", label: "Forward Pipeline", weight: 0.1, sectorNeutral: true },
  { key: "momentum", label: "Momentum Strength", weight: 0.1 },
  // Entry/value timing - rewards a discounted, depressed-base price with room to
  // run, penalizes chasing all-time highs. Sector-relative.
  { key: "valuation", label: "Entry / Value Timing", weight: 0.1, sectorNeutral: true },
  { key: "news", label: "News Freshness", weight: 0.05, sizeResidualized: true },
  { key: "social", label: "Social / Political Attention", weight: 0.03, sizeResidualized: true },
  { key: "volatility", label: "Volatility Opportunity", weight: 0.05 },
  { key: "growth", label: "Growth Quality", weight: 0.04, sectorNeutral: true },
  { key: "fundamentals", label: "Fundamentals Quality", weight: 0.02, sectorNeutral: true },
  // Liquidity is no longer a positive points-earner (a thin name shouldn't rank
  // HIGHER for being thin); it lives in the anti-lottery pumpRisk guard instead.
  { key: "liquidity", label: "Liquidity / Tradability", weight: 0.0, sizeResidualized: true },
];

/**
 * Risk penalty configuration. Each component contributes up to `max` points
 * of penalty, subtracted from the blended score. Total penalty is capped at
 * RISK.cap so a single signal can never be fully zeroed by risk alone.
 */
export const RISK = {
  cap: 30,
  components: {
    /** Negative free cash flow + short runway. */
    solvency: { max: 8 },
    /** Equity dilution / financing overhang. */
    dilution: { max: 6 },
    /** Crowded short / squeeze-or-collapse risk. */
    shortInterest: { max: 4 },
    /** Governance / accounting red flags. */
    governance: { max: 4 },
    /** Uninvestable-grade volatility (beyond "opportunity"). */
    extremeVol: { max: 3 },
    /**
     * Anti-lottery / pump guard (v2): no-revenue shell + thin float/volume +
     * promo-only hype + material insider selling + chronic dilution. Bounded so it
     * demotes a pump ticket without ever zeroing a genuine high-variance setup that
     * has real inflection/substance behind it.
     */
    pumpRisk: { max: 10 },
    /**
     * A name far above its own trailing base has consumed its asymmetry; we reward discounted
     * bases, not post-run chasers. Penalizes run-up above the trailing low (ramps in only at
     * EXTREME extension so normal winners are barely touched), softened when a fresh
     * inflection/live catalyst justifies continuation. The cap rose 25→30 so this can
     * meaningfully demote a post-run name without starving the other guards.
     */
    extension: { max: 8 },
  },
};

/**
 * Confidence reflects how much we trust the inputs (data coverage + internal
 * agreement), NOT how good the opportunity is. Starts at `base` and is reduced
 * by the listed penalties.
 */
export const CONFIDENCE = {
  /** Relative importance of raw data coverage vs agreement between signals. */
  evidenceWeight: 0.72,
  agreementWeight: 0.28,
  /** Penalty when there is little news to corroborate the thesis. */
  thinNewsPenalty: 8,
  /** Penalty when fundamentals and momentum disagree sharply. */
  signalConflictPenalty: 8,
  /** Penalty for micro/nano illiquidity making data noisy. */
  illiquidityPenalty: 8,
  /** Penalty when the catalyst is modeled, weak, or distant. */
  weakCatalystPenalty: 7,
  /** Penalty when the record is sample/synthetic rather than live sourced. */
  modeledSourcePenalty: 14,
  floor: 30,
};

/** Liquidity reference points (avg daily $ volume) for the liquidity score. */
export const LIQUIDITY_BANDS = {
  thin: 1_000_000, // below this is hard to trade -> ~low score
  healthy: 50_000_000, // around here is comfortable -> ~mid/high
  deep: 1_000_000_000, // institutional depth -> 100
};

/**
 * "Smart-money" catalyst boost (see src/engine/smartMoney.ts).
 *
 * Recent disclosed congressional BUYS - and open-market insider buys (Form 4
 * "P" code, net positive) when an already-aggregated read is available - add a
 * SMALL, BOUNDED boost to the Conviction sub-score. It is a boost ONLY: net
 * selling never subtracts, and with no smart-money data it degrades to exactly
 * zero. It scores ALREADY-AGGREGATED counts/fields (congressional disclosures
 * indexed once per session; optional insider buy/net-value fields) and NEVER
 * fetches per-ticker EDGAR Form 4 XML - so the universe scan stays inside SEC's
 * fair-access policy. V4 promotes the boost into a first-class additive-only
 * category while preserving positive weights that sum to 1.0.
 */
export const SMART_MONEY = {
  /** Max points added to the Conviction sub-score (0..100) for disclosed insider/CEO/
   * congress open-market BUYING - the single ONLY place smart-money is now counted. The
   * DOUBLE-COUNT is now reconciled - smart-money no longer ALSO inflates catalystStrength's tilt
   * (PATH 2 removed; it remains only as the lead LABEL there). So insider conviction is
   * single-counted here, with real weight.
   *  Tunable on real data once the Alpaca-bars fix repopulates the board. */
  maxBoost: 20,
  congress: {
    /** Open-market BUY disclosures that saturate the count path. */
    buysForFull: 4,
    /** Summed disclosed dollar FLOOR ($) of those buys that saturates the size path. */
    usdForFull: 250_000,
  },
  insider: {
    /** Open-market (Form 4 "P") BUY count that saturates the count path. */
    buysForFull: 3,
    /** Net open-market buy $ (buys − sells) that saturates the value path. */
    netUsdForFull: 1_000_000,
  },
} as const;
