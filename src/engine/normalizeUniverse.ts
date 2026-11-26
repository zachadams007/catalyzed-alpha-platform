import type { ScoreCategoryKey, StockSignal } from "@/types";
import { CATEGORY_CONFIG } from "./scoringConfig";
import {
  clamp,
  invNormalCdf,
  mean,
  percentileRank,
  residualize,
  round,
  stdev,
  winsorize,
} from "@/lib/math";
import { thesisGate, DATA_BACKED_MIN_SCORE } from "./thesisGate";
import { reversalReadiness } from "./reversalReadiness";
import { catalystStrength, materialSellSignal } from "./catalystStrength";
import {
  capCurveWeights,
  dampMomentumWeight,
  V5_MOMENTUM_WEIGHT_SCALE,
  type ArchetypeFlags,
  type RegimeContext,
} from "./capCurve";
import { getScoreSpreadWeight, getQualityCapStrength } from "@/data/globalControls";

/**
 * Anti-megacap cross-sectional normalization - the UNIVERSAL ranking pass every
 * engine model runs (champion and challenger alike; they differ only in the
 * {@link NormalizationOptions} knobs, never in the universe they sweep).
 *
 * `scoreCompany` scores each company in isolation, which leaves a residual
 * size/popularity edge: megacaps get more headlines and dollar volume simply for
 * being big, and a great-for-its-sector value name can lose to a mediocre one
 * from a richer sector. This pass re-expresses every dimension RELATIVE TO THE
 * UNIVERSE before blending, then applies a bounded small/mid-cap balancing tilt,
 * so a catalyzed small-cap can out-rank an un-catalyzed megacap and Today + the
 * feeds surface a real large/mid/small mix instead of a wall of mega-caps.
 *
 * Per dimension, in order:
 *   1. size-residualize the coverage/volume dimensions (news, social, liquidity)
 *      against log(market cap) - strip the "big therefore covered" edge;
 *   2. sector-neutralize the slow quality factors (fundamentals, growth,
 *      valuation) by removing the sector mean (guarded: ≥5 names/sector, else
 *      universe-wide) - score "good for its sector", not "good sector";
 *   3. winsorize at 5/95 to tame outliers, then map to a cross-sectional z-score
 *      via rank → inverse-normal (magnitude-immune, MAD-collapse-proof).
 * The z-scores blend with the SAME `CATEGORY_CONFIG` weights (still sum to 1.0 -
 * neutralization is upstream of the blend), the blend is standardized for a
 * healthy display spread, mapped to 0..100, and the existing risk penalty is
 * subtracted - mirroring the champion's `blended − penalty` shape.
 *
 * Pure and deterministic: array in, array out, no mutation, no clocks/RNG - the
 * daily research cache stays stable. RAW per-dimension scores are left untouched
 * so card explainers never change; only the ranking key (opportunityScore) moves.
 */

/** Sectors smaller than this fall back to universe-wide neutralization. */
const MIN_SECTOR_COUNT = 5;
/** Display mapping: z=0 → 50, ±1σ → ±15 points. */
export const DISPLAY_CENTER = 50;
export const DISPLAY_SCALE = 15;
/**
 *
 * The z→`50 + 15·z` mapping fixes the TAILS (worst → ~3, best → 100) but a Gaussian
 * still piles the BODY around 50 - empirically ~70% of names land in 30-59, so the
 * feed "all looks the same" (every card a 36-44). The final, MONOTONE
 * {@link decompressDisplayScores} remap spreads the body across the whole 0-100
 * scale WITHOUT re-ranking: each name's displayed score becomes a blend of
 *   • its cross-sectional PERCENTILE (fills the scale - worst → ~0, best → ~100,
 *     every 10-pt band evenly populated), and
 *   • its ABSOLUTE champion score (so a genuinely strong universe still lifts
 *     everyone and a weak day's top floats below 100 - "there may be no 100 on a
 *     given day, that's fine").
 * `weight` = how much PERCENTILE vs ABSOLUTE. 0.6 (60% percentile) fills the scale
 * while keeping the top-30 differentiated (~86-100) instead of percentile's crushed
 * 94-100. 1.0 = pure percentile (uniform), 0.0 = pure absolute (bunched body).
 * Tunable; a pure taste dial - it changes the displayed NUMBER, never the order.
 */
export const DISPLAY_DECOMPRESS_WEIGHT = 0.3;
/** Quality/risk ceiling weights: how hard a name's risk penalty and low confidence
 *  cap its displayed score, so a flawed/volatile name can't read near-100. */
export const QUALITY_CEILING_RISK_W = 1.4;
export const QUALITY_CEILING_CONF_W = 0.06;
/**
 * COHERENCE CAP (owner request 2026-06-30): the displayed headline score must be JUSTIFIED by
 * the dimensions the card actually shows. Momentum, coverage, and attention alone must
 * NOT float a name into the 90s while its valuation reads "chasing highs", its catalyst
 * is empty, and its fundamentals are weak (the ESTA 91 / AVGO 92-on-catalyst-5 problem).
 *
 * A name may only display above {@link COHERENCE_SOFT_TOP} to the extent it has a real
 * STRUCTURAL claim - strong fundamentals, growth, a dated catalyst, an inflection/
 * pipeline setup, or disclosed conviction. Its cap is `max(SOFT_TOP, bestLegitDim +
 * SLACK)`: with no legit dimension above the soft top it is floored there (a strong-but-
 * momentum-carried name still scores well, just not near-100); with a genuinely strong
 * dimension the cap rises so real quality still reaches the top. This is a DISPLAY cap
 * (applied after decompression, same place as the risk/conf ceiling) - it never changes
 * how the raw dimensions are scored, only bounds the headline number to what they show.
 */
export const COHERENCE_SOFT_TOP = 80;
export const COHERENCE_SLACK = 8;
/** Dimensions that count as a LEGITIMATE reason to display a top score. Momentum, news,
 *  social, liquidity, volatility and sentiment are deliberately excluded - they can lift
 *  the RANK, but must not solo-carry the displayed NUMBER above the coherence soft top. */
const COHERENCE_LEGIT_DIMS: ScoreCategoryKey[] = [
  "fundamentals",
  "growth",
  "catalyst",
  "inflection",
  "pipeline",
  "conviction",
];
/** Score that produces a zero revision tilt (the neutral midpoint). */
const REVISION_NEUTRAL = 50;
/** Max ± points an estimate-revision trend can move a name (bounded, like the
 *  thesis gate) - a secondary, time-aware tilt, never a primary driver. */
export const MAX_REVISION_POINTS = 5;
/**
 * The challenger's catalyst-driven knobs (the LANE-D refinement). All bounded
 * display-point tilts, deliberately MODERATE - catalysts are significant and
 * clearly felt in the blend, never dominant, and never a gate.
 */
/** Max + points a strong, early catalyst (ANY type) adds. One-sided UP: a name
 *  with no catalyst gets 0, so quality names are never penalized for lacking one. */
export const MAX_CATALYST_POINTS = 10;
/** Max − points material disclosed selling by major insiders / important people
 *  subtracts (a negative catalyst / watch-out). */
export const MAX_SELL_PENALTY = 8;
/** Max ± points the discount-with-thesis tilt moves a name: rewards a discounted
 *  entry with the thesis intact, penalizes "already ran / chasing highs". */
export const MAX_DISCOUNT_POINTS = 10;
/**
 * Max display points the REVERSAL tilt adds (one-sided UP) for the owner's large-cap
 * discounted-REVERSAL archetype - a washed-out QUALITY name (cheap + oversold +
 * quality, e.g. MSFT below its 50/200-day averages but a high-quality megacap).
 * Quality-gated so a low-quality falling knife (RKLB-style) gets ~0. Added OUTSIDE
 * the size-balanced bundle so the lift isn't residualized away.
 */
export const REVERSAL_TILT_MAX = 8;
/**
 * V5 live tweak: max display points for discounted QUALITY compounders.
 *
 * This is deliberately separate from the stricter washed-out reversal tilt. A
 * Microsoft-style mega-cap compounder can be a good entry without looking like a
 * panic-bottom chart: strong fundamentals, a real valuation/discount read, and
 * durable business quality should not sit near 50 just because there is no fresh
 * catalyst today. Commodity/regulated cyclicals are excluded here so AEM-style
 * miner strength still needs its own catalyst/inflection proof rather than
 * inheriting the software-compounder lift.
 */
export const QUALITY_COMPOUNDER_TILT_MAX = 18;
/**
 * V6: max display points for the T4 MISUNDERSTOOD-QUALITY archetype.
 *
 * Sized at 16 - below the quality-compounder lift (18) on purpose. A compounder
 * at a discount is a name whose price action has NOT broken down; a T4 name is
 * still falling, so it should be able to reach the top of the board on strong
 * disclosed evidence without being able to out-rank an equally-evidenced name
 * that is also basing. Multiplicatively gated on disclosed order-book growth ×
 * drawdown × fundamentals quality, so a typical name earns a fraction of this.
 */
export const MISUNDERSTOOD_TILT_MAX = 16;
/**
 * V6 UPSIDE-ASYMMETRY tilt (owner request 2026-07-25). Signed: +max for a quality name with
 * real room to run, down to −max for one whose upside is structurally capped.
 *
 * "Be greedy when others are fearful" needs a term that actually measures HOW MUCH
 * ROOM IS LEFT, because nothing else in the model did. The engine could rank a
 * megacap 12% below its high above a quality name 65% below its high purely on
 * fundamentals and a live catalyst - but a company already near its high, already
 * the largest in the world, and moving ~1.5x the market has a very different
 * payoff shape from the same-quality company after a 65% drawdown, and the score
 * said nothing about it.
 *
 * Deliberately NOT a discount factor. It is quality-gated, so a cheap broken
 * business earns none of it - the point is room to run ON A NAME WORTH OWNING.
 */
export const ASYMMETRY_TILT_MAX = 14;
/**
 * Max display points the OWN-HISTORY tilt moves a name, either way.
 *
 * Sized at 18 - the largest single tilt in the engine, deliberately. "Buy it
 * before it has run, not after" is the product's core claim, and the live board
 * showed that expressing it as 25% of one dimension was not enough to stop a name
 * at its most-expensive-ever multiple ranking #9.
 */
export const OWN_HISTORY_TILT_MAX = 18;
/**
 * Max display points the ABSOLUTE-MULTIPLE tilt subtracts (one-sided DOWN).
 *
 * Sized at 20 so a genuinely extreme multiple can push a name OFF the top of the
 * board rather than merely nudging it. Graduated and PEG-relieved, so an ordinary
 * 30-40x grower loses very little; it is the 100x+ end that pays.
 */
export const ABSOLUTE_MULTIPLE_TILT_MAX = 20;
/**
 * Max display points the ATTENTION tilt moves a name. Sized at 10 - enough to
 * separate a well-followed setup from an ignored one, never enough to carry a name
 * on popularity alone. The downside is a third of this by construction.
 */
export const ATTENTION_TILT_MAX = 10;

// ---------------------------------------------------------------------------
// V7 SYNTHESIS constants (2026-09-17). Every July-2026 version was scored
// against live closes on 2026-09-16 (docs/scoring-framework.md, "V7"). The
// evidence is ONE short window in ONE regime - information, not gospel -
// so V7 keeps every mechanism whose reasoning stands and re-sizes the ones the
// backtest flagged, rather than reverting wholesale or scrapping wholesale.
// ---------------------------------------------------------------------------
/**
 * Own-history tilt, V7 sizing. At +/-18 (V6.6) it out-muscled the blend and put
 * Lockheed at #2 while reading it as the most expensive it had ever been; at
 * 0.25-of-one-dimension (V6.5) it helped. +/-6 keeps the signal
 * as a real but SECONDARY voice - the same reading still feeds `scoreValuation`,
 * `asymmetryTilt` (consolidation room) and `qualityReadinessFloor` directly.
 */
export const V7_OWN_HISTORY_TILT_MAX = 10;
/**
 * Attention tilt, V7 sizing. The only version carrying it (V6.8) beat the two
 * before it, but on a sample of one board; halved until the track record says more.
 */
export const V7_ATTENTION_TILT_MAX = 5;
/**
 * How far the reward side is damped for a name at the top of its own valuation
 * range. V6 used 0.6 (pays 40% at percentile 1.0). V7 softens to 0.4 (pays 60%):
 * the July board showed the damping was not what stopped Lockheed - the catalyst
 * tilt simply overran it - and at 0.6 it also shaved Palantir.
 */
export const V7_ENTRY_QUALITY_DAMP = 0.4;
/**
 * How much of the SECOND valuation demotion counts once the first has been
 * applied. 0.35 keeps "dear on both measures" meaningfully worse than "dear on
 * one" without letting the same fact be charged twice at full price.
 */
const SECOND_VALUATION_CHARGE = 0.35;
/**
 * P9 REDESIGN (owner request 2026-07-03): the flight-to-safety tilt is GONE.
 *
 * The old design (a ±REGIME_SAFETY_TILT_MAX nudge toward low-vol/defensive names + defensive
 * re-reads of the valuation/momentum/volatility dimensions in risk-off) was a safety ROTATION -
 * exactly what the owner rejected: by the time a fear index confirms panic, the defensive names have
 * already been bid and the sold-off quality names are the opportunity. "Be greedy when others
 * are fearful."
 *
 * What replaces it (the PANIC-OPPORTUNITY mode, all riskOffness-scaled so a calm
 * day is bit-identical to before):
 *   • weight overlay → PANIC_QUALITY_WEIGHTS (capCurve.ts): quality + valuation +
 *     inflection + catalyst lean, momentum halved, volatility a minor sanity check
 * - never the headline;
 *   • the discount tilt AMPLIFIES in fear (see discountTilt): a data-backed,
 *     reversal-ready quality discount earns up to 1.5× its normal reward, and
 *     "chasing highs" penalizes up to 1.5× - one symmetric dial;
 *   • the risk-penalty multiplier below still scales pumpRisk/dilution/etc. UP in
 *     panic, so speculative junk is demoted harder (anti-speculation discipline -
 *     the OTHER half of the owner's rule: greedy on quality, never on lottery tickets);
 *   • the structural small-cap lift still cools down (REGIME_CAP_TILT_COOLDOWN_MAX)
 * - panic liquidity hits small caps hardest; that's discipline, not rotation.
 */
/** How much of the structural small-cap lift is muted in full risk-off conditions. */
const REGIME_CAP_TILT_COOLDOWN_MAX = 0.85;
/** How much the discount tilt's cap grows at FULL panic (riskOffness 1): ×1.5. */
const PANIC_DISCOUNT_AMP = 0.5;

/**
 * Per-model normalization profile - what makes one engine version differ from
 * another. Every model runs the SAME cap-balanced cross-sectional pass over the
 * SAME full universe (the anti-megacap guardrail is universal, not a variant
 * perk); they differ ONLY in these algorithmic knobs.
 */
export interface NormalizationOptions {
  /**
   * Apply the soft thesis gate (a challenger refinement): demote - never remove -
   * names that lack both a reason to move and something behind it. Champion runs
   * without it.
   */
  thesisGate: boolean;
  /**
   * Max ± display points of the small/mid-cap tilt at the size extremes. The tilt
   * is a bounded, ~zero-mean nudge that actively favors smaller caps AFTER the
   * structural size advantage has already been residualized out - so the surfaced
   * set is cap-BALANCED (a real large/mid/small mix), not just cap-neutral. 0
   * disables it. This is the universal "kill mega-cap over-representation" lever.
   */
  capTilt: number;
  /**
   * Max + display points a strong, EARLY catalyst of ANY type adds (LANE D). A
   * one-sided UP boost proportional to the unified catalyst strength
   * (materiality × magnitude × credibility × earliness - see catalystStrength.ts),
   * so catalysts are a MODERATE, clearly-felt weight in the blend without a gate:
   * a name with no catalyst gets 0 and is never penalized for lacking one.
   * Omit / 0 ⇒ off (the champion runs without it).
   */
  catalystStrengthMax?: number;
  /**
   * Max − display points material disclosed SELLING by significant insiders /
   * important people subtracts (LANE D - honest downside). Threshold-gated so a
   * small routine sale never moves the score. Omit / 0 ⇒ off.
   */
  sellWatchMax?: number;
  /**
   * Max ± display points the discount-with-thesis tilt moves a name (LANE D):
   * rewards a discounted entry whose thesis is intact, penalizes a name that has
   * already run to highs ("chasing"). Strengthens the Entry/Value-Timing knob so
   * momentum alone can't carry a pick. Omit / 0 ⇒ off.
   */
  discountTiltMax?: number;
  /**
   * Max + display points the REVERSAL tilt adds (one-sided UP) for a washed-out
   * QUALITY reversal - discounted + oversold + quality all holding at once. Lifts a
   * genuine large-cap reversal (MSFT) that the momentum penalty would otherwise
   * bury, while the quality gate keeps a low-quality falling knife at ~0. Omit/0 ⇒ off.
   */
  reversalTiltMax?: number;
  /**
   * Max + display points for discounted, high-quality large/mega compounders.
   * This broadens V5 beyond "panic-bottom reversal" into "excellent company at
   * a fair/discounted entry", without rewarding commodity/regulated cyclicals.
   */
  qualityCompounderTiltMax?: number;
  /**
   * Max + display points the T4 MISUNDERSTOOD-QUALITY tilt adds (one-sided UP):
   * a profitable large cap in a deep drawdown whose DISCLOSED order book is
   * compounding far ahead of recognized revenue. Requires filed pipeline data, so
   * it is inert for any name that discloses none. Omit / 0 ⇒ off.
   */
  misunderstoodTiltMax?: number;
  /**
   * Max ± display points the UPSIDE-ASYMMETRY tilt moves a name: how much room is
   * left to run, discounted for size and for how much of the move the market
   * would be doing. Quality-gated. Omit / 0 ⇒ off.
   */
  asymmetryTiltMax?: number;
  /**
   * Max ± display points the OWN-HISTORY tilt moves a name: cheap against its own
   * multi-year multiple with the business outgrowing the stock lifts; expensive
   * against its own past demotes. Requires disclosed history. Omit / 0 ⇒ off.
   */
  ownHistoryTiltMax?: number;
  /**
   * Max display points the ABSOLUTE-MULTIPLE tilt subtracts when a name's P/E is
   * extreme in absolute terms and its growth does not explain it. Omit / 0 ⇒ off.
   */
  absoluteMultipleTiltMax?: number;
  /**
   * Max ± display points the ATTENTION tilt moves a name: cap-normalised turnover
   * plus news coverage, so a mispricing with a real audience to close it outranks
   * an equally cheap name nobody trades. Omit / 0 ⇒ off.
   */
  attentionTiltMax?: number;
  /**
   * How much of the REWARD side is removed for a name at percentile 1.0 of its
   * own valuation range (linear from 0.5). Omit => 0.6 (the V6 behaviour).
   */
  entryQualityDamp?: number;
  /**
   * SIZE-BALANCE the challenger's additive tilt bundle (catalyst + sell + discount
   * + revision) so the model stays cap-BALANCED, not just cap-neutral.
   *
   * WHY: those LANE-D tilts are the right *idea* (catch catalysts early, favor a
   * discounted entry) but in a discovery universe they are STRUCTURALLY correlated
   * with small market cap - the catalyzed / discounted names skew small - so they
   * stack on the same small-caps and quietly re-introduce a size skew the upstream
   * residualization just removed. Left unchecked the challenger's Today rotates to
   * small-caps (the observed mega1/large0/mid1/small6).
   *
   * HOW (principled, not a magic number): regress the tilt bundle on log(market
   * cap) across the universe and SUBTRACT the size-explained component (OLS
   * residual - the same `residualize` already used per-dimension). This removes the
   * systematic "small ⇒ more tilt" lift while preserving each tilt's ordering
   * WITHIN a size cohort - a catalyzed small-cap still beats an un-catalyzed one,
   * and a catalyzed large-cap still beats an un-catalyzed one - so small-caps still
   * surface on merit and the surfaced set becomes a real small/mid/large spread.
   * It is self-calibrating: it removes exactly the size skew the tilts introduce,
   * however strong, instead of hoping a hand-tuned cap number cancels it.
   *
   * Omit / false ⇒ off (the champion has no LANE-D tilts, so it never needs this).
   */
  sizeBalanceTilts?: boolean;
  /**
   * (v2) Route the per-name blend WEIGHTS by market-cap cohort (see capCurve.ts):
   * small/micro names are blended on the small curve (pipeline/catalyst/inflection/
   * sentiment-shift/growth heavy) and large names on the large curve (margin
   * inflection + entry timing + trend). This is the second half of the cap-balance
   * fix - the size-residualization makes the ranking cap-NEUTRAL; this judges each
   * cohort on the signals that actually predict ITS runs, so a great small-cap setup
   * isn't scored as if it had to look like a mega-cap. The per-name vector still sums
   * to 1.0, so the z-blend stays a proper weighted average. Unknown cap → small
   * curve (never hard-fails). Omit / false ⇒ use the flat CATEGORY_CONFIG weights.
   */
  capCohortWeights?: boolean;
  /**
   * V4 archetype overlay: blend the size-cohort vector toward a T1/T2/T3 profile
   * using pure flags computed once per normalization pass (or supplied by the
   * scan via NormalizationContext). Untagged names keep the base cohort vector.
   */
  archetypeOverlay?: boolean;
  /**
   * V4 regime tilt: when upstream scan context marks risk-off conditions, blend
   * per-name vectors toward quality/valuation/volatility discipline and scale
   * existing risk penalties modestly. Absent context is neutral.
   */
  regimeTilt?: boolean;
  /**
   * Decompress the FINAL displayed score across the full 0-100 scale (see
   * {@link DISPLAY_DECOMPRESS_WEIGHT}). A monotone, order-preserving remap of the
   * opportunityScore - blends each name's cross-sectional percentile with its
   * absolute champion score so the body stops bunching at 30-59 and the feed uses
   * the whole scale (worst → ~1, best → ~100). NEVER re-ranks. On for the live
   * champion display; off for the shadow challenger so it stays the absolute-scale
   * comparison baseline the outcome ledger measures against. Omit / false ⇒ off.
   */
  decompressDisplay?: boolean;
  /**
   * V5 challenger (reversal / breakout-first): scale DOWN the momentum blend weight in every
   * per-name cohort vector to this fraction of its value, redistributing the freed weight into
   * the early-entry dimensions (see {@link dampMomentumWeight}). Only applies when {@link
   * capCohortWeights} is on. Omit / ≥1 ⇒ momentum unchanged.
   */
  momentumWeightScale?: number;
}

/**
 * The CATALYST-DRIVEN profile - the cap-balanced base PLUS the soft thesis gate,
 * the LANE-D catalyst-driven blend (strong/early catalysts of any type lift;
 * material disclosed selling lowers; discounted entries with the thesis intact
 * beat names that already ran), and (when daily history exists) the time-aware
 * EWMA + estimate-revision refinements supplied via {@link NormalizationContext}.
 *
 * This is the PROMOTED, live-by-default algorithm (the current Champion runs it).
 * The only differences from the curated-base profile are algorithmic; the
 * universe is identical.
 *
 * CAP BALANCE: it uses a GENTLE, zero-mean structural `capTilt` (not a "harder"
 * tilt - that over-rotated the feed to small-caps because the LANE-D tilts
 * already skew small) and adds `sizeBalanceTilts`, which residualizes the LANE-D
 * tilt bundle against log(market cap). The net effect is a model that is
 * cap-BALANCED - a real small/mid/large spread in Today - while small-caps still
 * surface fully on catalyst/discount merit within their size cohort.
 */
export const CATALYST_DRIVEN_NORMALIZATION: NormalizationOptions = {
  thesisGate: true,
  capTilt: 4,
  catalystStrengthMax: MAX_CATALYST_POINTS,
  sellWatchMax: MAX_SELL_PENALTY,
  discountTiltMax: MAX_DISCOUNT_POINTS,
  sizeBalanceTilts: true,
};

/**
 * The INFLECTION-v2 profile - the PROMOTED live Champion (the "Pre-Move Inflection
 * Engine"). Everything the catalyst-driven model does PLUS `capCohortWeights`: the
 * per-name blend weights are routed by market-cap cohort (capCurve.ts) so small/
 * micro names are judged on the curve that predicts THEIR runs and the feed stops
 * over-representing large caps. The new leading dimensions (inflection / pipeline /
 * sentimentShift) and the anti-lottery pumpRisk are scored UNIVERSALLY in
 * scoreCompany, so they flow into every model; this profile is what makes them the
 * cap-aware, thesis-gated CHAMPION ranking. Cold-start safe: with no v2 inputs yet
 * the new dims are neutral (zero cross-sectional spread) and this behaves like the
 * catalyst-driven model with cohort-routed weights.
 */
export const INFLECTION_V2_NORMALIZATION: NormalizationOptions = {
  thesisGate: true,
  // capTilt stays GENTLE (4): the structural tilt is zero-mean and `sizeBalanceTilts`
  // residualizes the LANE-D small-skew, so on a naturally small-heavy universe a harder tilt
  // over-rotates to all-small (proven by capBalance.demo). One linear tilt cannot serve both
  // pools; the ceiling can.
  capTilt: 4,
  catalystStrengthMax: MAX_CATALYST_POINTS,
  sellWatchMax: MAX_SELL_PENALTY,
  discountTiltMax: MAX_DISCOUNT_POINTS,
  sizeBalanceTilts: true,
  capCohortWeights: true,
  archetypeOverlay: true,
  regimeTilt: true,
  // Reward the large-cap discounted-REVERSAL archetype (the owner): a washed-out quality
  // name (cheap + oversold + quality) gets a bounded lift so its momentum penalty
  // doesn't bury it. Quality-gated → a low-quality falling knife gets ~0.
  reversalTiltMax: REVERSAL_TILT_MAX,
  // Decompress the live champion's DISPLAYED score across the full 0-100 scale -
  // the body otherwise bunches at 30-59 even though the tails already reach 3/100.
  // Monotone, so the cap-cohort/catalyst-driven RANKING above is untouched.
  decompressDisplay: true,
};

/**
 * The V5 REVERSAL / BREAKOUT-FIRST profile - the current shadow CHALLENGER, the
 * next candidate being measured against the live V4 champion.
 *
 * It IS the V4 champion (archetype router + regime tilt + all the LANE-D tilts and
 * cohort routing) with ONE deliberate change: momentum's blend weight is cut ~70%
 * and redistributed into the early-entry signals (inflection, entry/value timing,
 * catalyst, sentiment-shift, pipeline). This encodes the owner's hypothesis that momentum
 * has little value when we're catching reversals/breakouts BEFORE the move - a
 * below-trend name shouldn't be dragged for not already being in an uptrend. Kept as
 * a SHADOW so the outcome ledger can prove whether de-weighting momentum actually
 * improves the ranking before it is ever promoted to live. A single-variable change
 * from the champion, so the rank-IC comparison isolates exactly that hypothesis.
 */
export const REVERSAL_V5_NORMALIZATION: NormalizationOptions = {
  ...INFLECTION_V2_NORMALIZATION,
  momentumWeightScale: V5_MOMENTUM_WEIGHT_SCALE,
  qualityCompounderTiltMax: QUALITY_COMPOUNDER_TILT_MAX,
};

/**
 * The V6 MISUNDERSTOOD-QUALITY profile - V5 plus the T4 archetype.
 *
 * V5's stated identity was "reversal-first", but a board audit on 2026-07-25
 * (`scripts/diag_coverage.mts`) showed the dimensions that were supposed to carry
 * that identity had no inputs in production: `pipeline` was a flat neutral 50 for
 * 100% of the published board, as were `sentimentShift` and the own-history
 * valuation percentile. With its leading signals inert, V5 was ranking mostly on
 * price action - which is why the surfaced board skewed to names that had already
 * run, and why a 65%-off, still-profitable Oracle carrying a disclosed $638B order
 * book sat at rank 246 of 486.
 *
 * V6 changes two things and nothing else:
 *   1. the daily scan now folds DISCLOSED SEC XBRL remaining-performance-obligation
 *      / contract-liability figures, so `pipeline` finally has real inputs
 *      (~45% of the published board); and
 *   2. the T4 archetype + tilt above give that evidence a route to the top of the
 *      board even when the price trend is bad, which for this archetype is the
 *      precondition rather than a disqualifier.
 *
 * Everything else - the risk penalties, the anti-lottery guards, the falling-knife
 * discipline, cap balancing, the thesis gate - is unchanged from V5.
 */
export const MISUNDERSTOOD_V6_NORMALIZATION: NormalizationOptions = {
  ...REVERSAL_V5_NORMALIZATION,
  misunderstoodTiltMax: MISUNDERSTOOD_TILT_MAX,
  asymmetryTiltMax: ASYMMETRY_TILT_MAX,
  ownHistoryTiltMax: OWN_HISTORY_TILT_MAX,
  absoluteMultipleTiltMax: ABSOLUTE_MULTIPLE_TILT_MAX,
  attentionTiltMax: ATTENTION_TILT_MAX,
};

/**
 * The V7 SYNTHESIS profile - the best of every July-2026 version, sized by what
 * the 2026-09-16 backtest actually showed, without treating one short
 * window as proof.
 *
 * Scorecard (equal-weight top-10, first close on/after board date -> 09-16 close,
 * versus SPY over the same window): [figures removed from the public copy].
 *
 * What that supports, and what V7 does about it:
 *   KEEP as-is - every data-layer fix (XBRL pipeline/FCF/net margin/revenue,
 *     the vendor-contradiction guard, the lender revenue path), the asymmetry
 *     tilt at 14, the
 *     discount-led compounder, corroboration relief, consolidation-as-room and
 *     the good-price readiness floor. Their reasoning stands and nothing in the
 *     backtest argues against them.
 *   REMOVE - the absolute-P/E tilt. At full strength it demoted
 *     strong names for their multiple alone
 *     (Palantir is the worked case), and that charge
 *     was redundant: the PEG leg inside scoreFundamentals
 *     was already pricing that in. Off, not shrunk - a second P/E charge on top
 *     of PEG is a double count regardless of size.
 *   RE-SIZE - own-history 18 -> 6 and attention 10 -> 5 (see the V7 constants);
 *     entry-quality damping 0.6 -> 0.4.
 *
 * Everything else is inherited from V6, so the two remain directly comparable
 * on the same board.
 */
export const SYNTHESIS_V7_NORMALIZATION: NormalizationOptions = {
  ...MISUNDERSTOOD_V6_NORMALIZATION,
  absoluteMultipleTiltMax: 0,
  ownHistoryTiltMax: V7_OWN_HISTORY_TILT_MAX,
  attentionTiltMax: V7_ATTENTION_TILT_MAX,
  entryQualityDamp: V7_ENTRY_QUALITY_DAMP,
};

/**
 * The CURATED-BASE profile - the prior live-by-default model, now the
 * shadow / next-challenger after the catalyst-driven algorithm was promoted to
 * Champion. Cap-balanced (size-residualized dims + a gentle small/mid tilt) so it
 * is never mega-cap heavy, but WITHOUT the thesis gate, the time-aware context, or
 * the LANE-D catalyst/sell/discount tilts. Kept as the comparison baseline so the
 * champion/challenger loop still has a shadow model to measure against.
 */
export const CURATED_BASE_NORMALIZATION: NormalizationOptions = { thesisGate: false, capTilt: 4 };

/**
 * Default = the full catalyst-driven pass, so a bare `computeNormalizedScores(signals)`
 * (and every existing caller/test) keeps the complete behavior. The curated-base
 * path opts down explicitly via {@link CURATED_BASE_NORMALIZATION}.
 */
const DEFAULT_OPTIONS: NormalizationOptions = CATALYST_DRIVEN_NORMALIZATION;

/**
 * Time-aware inputs the challenger normalization folds in when the daily signal
 * history is available (Mission 4 data-deps). Built impurely from the persisted
 * history in the research pipeline ({@link buildNormalizationContext}) and passed
 * in so this module stays pure. Absent → the pass behaves exactly as before.
 */
export interface NormalizationContext {
  /**
   * Per-ticker EWMA-smoothed news/social sub-scores, replacing the raw
   * point-in-time value as the normalization input so one loud day decays
   * gracefully. Raw card explainers are untouched - only the ranking input moves.
   */
  smoothed?: Record<string, { news?: number; social?: number }>;
  /**
   * Per-ticker estimate-revision momentum, 0..100 (50 = neutral). Maps to a
   * bounded ± point tilt on the final blended score.
   */
  revision?: Record<string, number>;
  /**
   * V4 archetype flags computed by the scan/enrichment layer. If absent, the
   * normalizer computes the same pure flags once from the provided StockSignal
   * objects so existing callers keep working.
   */
  archetypes?: Record<string, ArchetypeFlags>;
  /**
   * V4 market regime context computed once by the scan/backtest layer and passed
   * in. This module never reads a clock or market data globally; absent => neutral.
   */
  regime?: RegimeContext;
}

/** Dimensions whose normalization input can be EWMA-smoothed from history. */
const SMOOTHABLE: ReadonlySet<ScoreCategoryKey> = new Set(["news", "social"]);

// P9: the defensive re-reads (defensiveVolatility/Momentum/SectorScore,
// riskOffSafetyScore, and the risk-off blending inside rawDimension) are deleted -
// they redefined the valuation/momentum/volatility dimensions toward "safety" in a
// fearful tape, i.e. the defensive rotation the owner rejected. Dimensions now mean the
// same thing in every regime; the regime expresses itself through the
// PANIC_QUALITY_WEIGHTS overlay, the amplified discount tilt, and the scaled risk
// penalty instead.

function rawDimension(
  signals: StockSignal[],
  key: ScoreCategoryKey,
  ctx?: NormalizationContext,
): number[] {
  const smoothable = SMOOTHABLE.has(key);
  return signals.map((s) => {
    const raw = s.score.categories.find((c) => c.key === key)?.score ?? 50;
    if (!smoothable || !ctx?.smoothed) return raw;
    const smoothed = ctx.smoothed[s.ticker]?.[key as "news" | "social"];
    return smoothed != null && Number.isFinite(smoothed) ? smoothed : raw;
  });
}

function offHighFromHistory(signal: StockSignal): number | null {
  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  if (closes.length < 120 || price <= 0) return null;
  const high = Math.max(price, ...closes);
  return high > 0 ? (high - price) / high : null;
}

/** How far a name has RUN above its trailing low, as a ratio (1.0 = doubled off the
 *  base, 0 = at the low). Mirror of {@link offHighFromHistory} for the "already ran /
 *  chasing highs" read that separates a re-accelerating compounder from a chaser. */
function runFromLowHistory(signal: StockSignal): number | null {
  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  if (closes.length < 120 || price <= 0) return null;
  const low = Math.min(price, ...closes);
  return low > 0 ? (price - low) / low : null;
}

/**
 * Small/micro caps legitimately run further off a low early in a move, so this gate is LARGE-cap
 * only - their own extension is handled by the (lenient) risk guard, not by disqualifying the
 * archetype.
 */
const LARGE_EXTENDED_RUN = 0.8; // up >80% from the trailing base ⇒ extended

/**
 * How far DISCLOSED contracted demand must be growing ahead of recognized
 * revenue for the T4 "misunderstood" archetype to fire (0.15 = 15 percentage
 * points). Chosen to sit well above ordinary reporting noise while admitting the
 * real cases on the live board - Oracle runs ~+346pp, Alphabet ~+360pp,
 * Microsoft ~+79pp, Caterpillar ~+99pp.
 */
const MISUNDERSTOOD_DEMAND_LEAD = 0.15;
/** Minimum drawdown off the name's own high before "misunderstood" is on the table. */
const MISUNDERSTOOD_MIN_OFF_HIGH = 0.2;

/**
 * Above this, leverage is treated as balance-sheet distress no matter how
 * profitable the business is. Below it, leverage carried by real earnings is not
 * a disqualifier - see {@link hasQualityFloor}.
 */
const LEVERAGE_HARD_CEILING = 8;
/** Net margin that proves leverage is being SERVICED by the business. */
const SERVICEABLE_NET_MARGIN = 0.05;

function hasQualityFloor(signal: StockSignal): boolean {
  const f = signal.fundamentals;
  const inf = signal.inflection;
  const revenueStable =
    (f?.revenueGrowthYoY ?? 0) > -0.08 ||
    (inf?.revYoYAccel != null && inf.revYoYAccel >= -0.02) ||
    (inf?.revAccelQoQ != null && inf.revAccelQoQ >= 0);
  const cashFlowOk =
    (f?.fcfMargin ?? 0) >= -0.02 ||
    (f?.netMargin ?? 0) >= 0 ||
    (f?.debtToEquity ?? 1) <= 0.8;
  // LEVERAGE IS ONLY DISQUALIFYING WHEN IT IS UNSERVICED (2026-07-25).
  // The old test was a bare `debtToEquity <= 2.5`, which rejected 36.8% of the
  // large caps on the live board - including profitable compounders whose equity
  // is small because they bought back stock, or who borrowed against contracted
  // revenue. Oracle carries ~3.0x D/E on a ~25% net margin: that is a financing
  // choice, not distress, yet it silently blocked every quality-gated archetype.
  // D/E can also be NEGATIVE (book equity wiped out by buybacks), which the old
  // `<= 2.5` comparison quietly PASSED - so the fix handles that case explicitly
  // instead of by accident: negative equity clears only on real profitability.
  const de = f?.debtToEquity ?? 1;
  const netMargin = f?.netMargin ?? -1;
  const serviceable = netMargin >= SERVICEABLE_NET_MARGIN;
  const leverageOk =
    (de >= 0 && de <= 2.5) || (serviceable && (de < 0 || de <= LEVERAGE_HARD_CEILING));
  const balanceSheetOk =
    leverageOk &&
    (signal.risk?.dilutionRisk ?? 0) < 0.45 &&
    signal.risk?.goingConcernFlag !== true;
  return revenueStable && cashFlowOk && balanceSheetOk;
}

/**
 * DISCLOSED contracted-demand lead: how far the order book is growing ahead of
 * recognized revenue, in ratio points (0.35 = booked demand growing 35pp faster).
 *
 * This is the quantitative core of the T4 "misunderstood" archetype and the one
 * thing that separates it from a value trap. A falling price with FALLING backlog
 * is a business in decline; a falling price with a backlog compounding far faster
 * than the income statement is the market pricing near-term spend while contracted
 * demand keeps accruing (Oracle: RPO +363% vs revenue +17%).
 *
 * Returns null when the filer discloses no order-book figure - the archetype then
 * cannot fire, so it is never inferred from narrative or price action.
 */
function contractedDemandLead(signal: StockSignal): number | null {
  const p = signal.pipeline;
  if (!p) return null;
  const visibility = Math.max(
    p.backlogYoY ?? Number.NEGATIVE_INFINITY,
    p.deferredRevYoY ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(visibility)) return null;
  const revenueGrowth = signal.fundamentals?.revenueGrowthYoY ?? 0;
  return visibility - revenueGrowth;
}

export function inferArchetypeFlags(signal: StockSignal): ArchetypeFlags {
  const inf = signal.inflection;
  const pipeline = signal.pipeline;
  const momentum = signal.momentum;
  const catalyst = signal.catalyst;
  const cap = signal.marketCap;
  const isLarge = Number.isFinite(cap) && cap > 3_000_000_000;
  const isSmallOrUnknown = !Number.isFinite(cap) || cap <= 3_000_000_000;
  const gmOk = inf?.grossMarginDeltaYoY == null || inf.grossMarginDeltaYoY >= 0;
  // GENUINE 2nd-derivative re-acceleration only. The old bar (revAccelQoQ > 0.01 OR
  // revYoYAccel > 0) fired for almost any growing company, so "Revenue re-accelerating"
  // labeled the whole board and the compounder archetype swallowed every cap (the owner
  // 2026-07-01). Require a MEANINGFUL acceleration (~2pp QoQ or ~3pp YoY), so it's a
  // real, selective signal - a factor, not the default. `?? -1` ⇒ a missing field never
  // qualifies.
  const reAccel =
    ((inf?.revAccelQoQ ?? -1) > 0.02 || (inf?.revYoYAccel ?? -1) > 0.03) && gmOk;
  const runFromLow = runFromLowHistory(signal);
  const marginTurn =
    inf?.opMarginNow != null &&
    inf?.opMarginPrevYearQ != null &&
    (inf.opMarginPrevYearQ < 0 ? inf.opMarginNow >= 0 : (inf.grossMarginDeltaYoY ?? 0) >= 0);
  const backlogLead =
    (pipeline?.bookToBill ?? 0) > 1.2 ||
    (pipeline?.backlogToRevTTM ?? 0) > 1.2 ||
    (pipeline?.namedContractPctRev ?? 0) >= 0.12;
  const offHigh = offHighFromHistory(signal);
  const troughTurn =
    isLarge &&
    offHigh != null &&
    offHigh >= 0.3 &&
    offHigh <= 0.75 &&
    marginTurn &&
    hasQualityFloor(signal);
  const boundedMomentum =
    (momentum?.rsi ?? 50) < 80 &&
    (momentum?.aboveSMA50 === true ||
      momentum?.aboveSMA200 === true ||
      (momentum?.return3M ?? 0) > 0);
  const earlyTrend =
    (momentum?.rsi ?? 50) < 80 &&
    (momentum?.aboveSMA50 === true ||
      (momentum?.return1M ?? 0) > 0 ||
      (momentum?.return3M ?? 0) > 0);
  const freshCatalyst =
    signal.catalystLive === true &&
    (catalyst?.daysAway ?? Number.POSITIVE_INFINITY) >= -30 &&
    (catalyst?.daysAway ?? Number.POSITIVE_INFINITY) <= 180 &&
    (catalyst?.magnitude ?? 0) >= 0.35;

  // EFFECTIVELY large: a genuine large-cap OR an unknown-cap name that TRADES like a
  // mega-cap (>$1B/day dollar volume). This catches the TSM case - a ~$450B ADR that
  // published with marketCap 0 (a data miss) and so escaped every large-cap guard,
  // getting scored as a small-cap runner. Liquidity is REAL data (no fabricated cap):
  // a genuine small-cap never trades $1B+/day. QNT-tier ($0.5B/day) stays unknown/small.
  const capKnown = Number.isFinite(cap) && cap > 0;
  const effLarge = isLarge || (!capKnown && (signal.liquidity?.avgDollarVolume ?? 0) > 1_000_000_000);
  // A large (or effectively-large) name that has already run >80% off its base is
  // CHASING, not compounding - it must not ride the momentum-heavy compounder curve
  // (the TSM +128%, no-catalyst, scored-90 problem) or be treated as an early runner.
  const extendedLarge = effLarge && runFromLow != null && runFromLow > LARGE_EXTENDED_RUN;

  // --- T4: the MISUNDERSTOOD large cap (2026-07-25) ------------------------
  // The hole this fills: a profitable large cap in a deep drawdown whose
  // disclosed order book is compounding far faster than recognized revenue got
  // NO archetype at all. megaReversal rejected it on leverage/margin-turn,
  // compounder rejected it on `boundedMomentum` (it is by definition in a
  // downtrend), and smallRunner rejected it on size - so it fell through to the
  // base curve and was ranked mostly on the momentum it was never going to have.
  //
  // Every leg below is a DISCLOSED figure. The archetype cannot fire without a
  // filed order-book number, so "the market misunderstands this" is never
  // inferred from a chart or a narrative.
  const demandLead = contractedDemandLead(signal);
  // A single criterion on purpose. An earlier draft also admitted "a big absolute
  // backlog that is still growing at all", which tagged names whose order book was
  // growing SLOWER than revenue (ServiceNow at −1pp, Synopsys at −4pp) - the
  // opposite of the thesis. Booked demand must genuinely be outrunning the
  // income statement.
  const bookedAhead = demandLead != null && demandLead >= MISUNDERSTOOD_DEMAND_LEAD;
  const profitable = (signal.fundamentals?.netMargin ?? -1) >= SERVICEABLE_NET_MARGIN;
  // A drawdown deep enough to matter, but not so deep it implies a broken
  // business - past ~80% off the high this is a solvency story, not a repricing.
  const deepButNotBroken =
    offHigh != null && offHigh >= MISUNDERSTOOD_MIN_OFF_HIGH && offHigh <= 0.8;
  const misunderstoodQuality =
    effLarge && profitable && deepButNotBroken && bookedAhead && hasQualityFloor(signal);

  return {
    misunderstoodQuality,
    megaReversal: troughTurn,
    compounder: isLarge && (reAccel || backlogLead) && boundedMomentum && !extendedLarge,
    // An effectively-large name is NOT a small-cap runner - TSM must not get the
    // small-runner curve just because its cap field is missing.
    smallRunner:
      isSmallOrUnknown && !effLarge && (freshCatalyst || reAccel || backlogLead) && earlyTrend,
  };
}

export function buildArchetypeContext(signals: StockSignal[]): Record<string, ArchetypeFlags> {
  return Object.fromEntries(signals.map((signal) => [signal.ticker, inferArchetypeFlags(signal)]));
}

/** Subtract each name's sector mean (sectors with ≥5 names) or the universe mean. */
function sectorDemean(values: number[], sectors: string[]): number[] {
  const universeMean = mean(values);
  const groups = new Map<string, { sum: number; n: number }>();
  for (let i = 0; i < values.length; i++) {
    const g = groups.get(sectors[i]!) ?? { sum: 0, n: 0 };
    g.sum += values[i]!;
    g.n += 1;
    groups.set(sectors[i]!, g);
  }
  return values.map((v, i) => {
    const g = groups.get(sectors[i]!)!;
    const center = g.n >= MIN_SECTOR_COUNT ? g.sum / g.n : universeMean;
    return v - center;
  });
}

/** Winsorize @5/95 then map to a cross-sectional z via rank → inverse-normal. */
function toCrossSectionalZ(values: number[]): number[] {
  const tamed = winsorize(values, 0.05, 0.95);
  return percentileRank(tamed).map(invNormalCdf);
}

/**
 * Bounded, ~zero-mean small/mid-cap tilt in display points, one per name.
 *
 * Each name's tilt is proportional to how extreme its log market cap is relative
 * to the universe (a z-score of logCap), inverted so smaller caps tilt UP and
 * larger caps tilt DOWN, then clamped to ±`capTilt`. Because the dimensions that
 * structurally scale with size (news/social/liquidity) are already
 * size-residualized upstream, this tilt is the deliberate, transparent nudge that
 * turns a cap-NEUTRAL ranking into a cap-BALANCED one - so a researched small/mid
 * is not quietly out-ranked by a mega-cap's sheer size. Zero for an all-same-cap
 * universe (no spread to tilt on), so degenerate inputs stay flat.
 */
function sizeTilts(logCaps: number[], capTilt: number): number[] {
  if (capTilt <= 0) return logCaps.map(() => 0);
  const center = mean(logCaps);
  const spread = stdev(logCaps) || 1;
  return logCaps.map((lc) => clamp((-(lc - center) / spread) * capTilt, -capTilt, capTilt));
}

/**
 * Discount-with-thesis tilt (LANE D), in display points, from one name's
 * cross-sectional dimension z-scores. Strengthens the Entry/Value-Timing knob so
 * the feed favors a DISCOUNTED entry whose thesis is intact and pushes down a
 * name that has ALREADY RUN to highs:
 *   • REWARD (up to +max): the name is cheap relative to the universe (valuation
 *     z > 0) AND has a reason behind it (a catalyst, or solid fundamentals/growth)
 * - a discount only counts when the thesis still holds, so we never reward a
 *     falling knife.
 *   • PENALTY (down to −max): the name is expensive (valuation z < 0) WHILE its
 *     momentum is hot (z > 0) - i.e. it ran up and is now pricier with nothing
 *     else changed (the Robinhood example). Momentum alone must NOT carry a name.
 * Bounded to ±max; zero-ish for a middle-of-the-pack name.
 */
function discountTilt(
  dimZ: Partial<Record<ScoreCategoryKey, number>>,
  max: number,
  riskOffness = 0,
  /**
   * P1 reversal-readiness (0..1): how much of the discount REWARD to pay. 1 =
   * the fall has stopped / a live catalyst bypassed the gate; 0 = an active
   * falling knife. It scales only the reward (a bonus), never the chasing penalty,
   * so a below-MA name is never PENALIZED for it - it just doesn't collect the
   * discount bonus until its decline decelerates/bases. See reversalReadiness.ts.
   */
  readiness = 1,
  /**
   * RAW 0..100 sub-scores for the same name. When supplied, `thesisStrength` only
   * counts a backer whose raw score is genuinely data-backed (≥ floor), so a
   * cold-start neutral-50 dimension can no longer unlock the reward via the midrank
   * artifact (P4 §1d.1). Omitted ⇒ legacy behavior (every dimension eligible).
   */
  dimRaw?: Partial<Record<ScoreCategoryKey, number>>,
): number {
  if (max <= 0) return 0;
  const z = (k: ScoreCategoryKey) => dimZ[k] ?? 0;
  const value = z("valuation"); // high = discounted entry, low = near highs
  const momentum = z("momentum"); // high = has already run
  // A reason behind the discount: a live catalyst, leading inflection/pipeline,
  // or solid fundamentals/growth - but only counted when genuinely DATA-BACKED
  // (raw ≥ floor). Neutral/missing data does not earn the reward (P4): the +max
  // reward must never be unlocked by "we know nothing" reading as a positive z.
  const backerKeys: ScoreCategoryKey[] = [
    "catalyst",
    "fundamentals",
    "growth",
    "inflection",
    "pipeline",
    "sentimentShift",
  ];
  const dataBacked = (k: ScoreCategoryKey) =>
    dimRaw == null || (dimRaw[k] ?? 0) >= DATA_BACKED_MIN_SCORE;
  let thesisStrength = -Infinity;
  for (const k of backerKeys) if (dataBacked(k)) thesisStrength = Math.max(thesisStrength, z(k));
  const thesisIntact = thesisStrength > 0.1;

  // P9 panic-opportunity amplification: in a fearful tape the discount signal
  // matters MORE, not less - a data-backed, reversal-ready quality discount earns
  // up to ×1.5 its normal reward and "chasing highs" penalizes up to ×1.5, one
  // symmetric dial. (The old defensive-confirmation logic - low-vol/momentum
  // "safety" unlocking the reward in risk-off - was the rotation P9 removed; the
  // quality principles are regime-invariant now.)
  const amplifiedMax = max * (1 + PANIC_DISCOUNT_AMP * clamp(riskOffness, 0, 1));

  // Reward a genuine discount only when the thesis holds (z capped to ~1.5σ → 1)
  // AND the fall has measurably slowed (readiness scales the reward, P1).
  const reward = (thesisIntact ? clamp(value, 0, 1.5) / 1.5 : 0) * clamp(readiness, 0, 1);
  // Penalize "already ran": expensive AND momentum running hot (both must hold).
  const chasing = (clamp(-value, 0, 1.5) / 1.5) * (clamp(momentum, 0, 1.5) / 1.5);

  return round(clamp(amplifiedMax * reward - amplifiedMax * chasing, -amplifiedMax, amplifiedMax), 2);
}

/**
 * The base + momentum dimension BURY such a name (being below trend only hurts), yet a quality
 * name sold off hard is a SETUP, not a dud.
 *
 * Uses ABSOLUTE signals, NOT cross-sectional z: on a board where EVERYTHING is
 * beaten down, MSFT isn't "discounted vs peers" (z≈0) even though it's genuinely
 * washed out in absolute terms - so a z-based version never fired for it. We score
 * the real archetype:
 *   washout = below-200-DMA + oversold RSI + deep off-its-own-high (each 0..1),
 *   quality = the fundamentals sub-score (gates out a low-quality falling knife),
 *   size    = larger cap (this is the LARGE-cap reversal archetype the owner described).
 * Multiplicative so all must hold: RKLB-style junk dies on the quality gate, a
 * near-highs name dies on the washout gate, a thin/IPO name dies on the history
 * guard. One-sided UP, bounded to +max.
 */
function reversalTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  // Need a real, deep base to honestly call a name "washed out" (the BMNR guard).
  if (closes.length < 120 || price <= 0) return 0;

  const high = Math.max(price, ...closes);
  const offHigh = high > 0 ? (high - price) / high : 0;
  const mom = signal.momentum;
  const below200 = mom?.aboveSMA200 ? 0 : 1;
  const rsi = mom?.rsi ?? 50;
  const oversold = clamp((45 - rsi) / 20, 0, 1); // RSI ≤ 25 → 1, ≥ 45 → 0
  const offHighScore = clamp(offHigh / 0.3, 0, 1); // 30%+ off its high → 1
  const washout = (below200 + oversold + offHighScore) / 3;

  const fundDim = signal.score.categories.find((c) => c.key === "fundamentals")?.score ?? 50;
  const quality = clamp((fundDim - 40) / 40, 0, 1); // real quality, not a junk knife

  const cap = signal.marketCap ?? 0;
  // 10^9.5 ≈ $3.2B floor → 0, 10^11.7 ≈ $500B → 1 (favours genuine large-caps).
  const size = cap > 0 ? clamp((Math.log10(cap) - 9.5) / (11.7 - 9.5), 0, 1) : 0;

  const reversal = washout * quality * size; // 0..1, all required
  return round(max * reversal, 2);
}

/**
 * Discounted quality compounder lift (V5): a broader version of the reversal
 * archetype for names such as MSFT that are excellent businesses and discounted
 * enough to matter, but not necessarily below every moving average.
 */
function qualityCompounderTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const cap = signal.marketCap ?? 0;
  if (cap < 50_000_000_000) return 0;

  const sector = String(signal.sector ?? "").toLowerCase();
  if (
    sector.includes("materials") ||
    sector.includes("energy") ||
    sector.includes("utilities") ||
    sector.includes("real estate")
  ) {
    return 0;
  }

  const dim = (key: ScoreCategoryKey) =>
    signal.score.categories.find((c) => c.key === key)?.score ?? 50;
  const fundamentals = dim("fundamentals");
  const valuation = dim("valuation");
  const growth = dim("growth");
  const conviction = dim("conviction");

  // `conviction` used to be a HARD gate here (`conviction < 55 ⇒ 0`). It is not a
  // quality measure - it scores DISCLOSED insider / congressional / activist
  // BUYING, and `scoreConviction` returns exactly 50 when no such filing exists,
  // which is the case for the large majority of the board. So the gate silently
  // required "an insider bought recently" before a discounted quality compounder
  // could earn anything, which is not what this tilt is for. It stays below as a
  // SUPPORT term (a real disclosed buy still adds), but no longer a veto.
  if (fundamentals < 72 || valuation < 56) return 0;

  const quality = clamp((fundamentals - 65) / 25, 0, 1);
  const discount = clamp((valuation - 50) / 35, 0, 1);
  const growthSupport = clamp((growth - 35) / 35, 0, 1);
  const confidenceSupport = clamp((conviction - 55) / 30, 0, 1);

  // DISCOUNT-LED, NOT QUALITY-LED (owner request 2026-07-26).
  //
  // This tilt is called the DISCOUNTED quality-compounder lift, but it was weighted
  // 0.46 quality / 0.34 discount - which made it behave as a pure quality reward.
  // The consequence showed up immediately at the top of the board: Nvidia took the
  // single largest tilt on the board (+11.7) and ranked #1 while sitting only ~16%
  // off its high, because a 98 fundamentals score dominated a 0.2 discount reading.
  //
  // The mandate is to find quality BEFORE it has run, so the discount has to lead and quality
  // has to gate.
  //
  // Rebalanced so the same tilt now separates the cases it was always meant to:
  // a properly sold-off compounder keeps most of the lift, a barely-dipped mega-cap
  // keeps far less, and a low-quality name still earns nothing because `quality`
  // remains a multiplicative floor via the >=72 fundamentals gate above.
  const score = 0.5 * discount + 0.3 * quality + 0.12 * growthSupport + 0.08 * confidenceSupport;
  return round(max * clamp(score, 0, 1), 2);
}

/**
 * MISUNDERSTOOD-QUALITY tilt (T4) - the one-sided lift for a profitable large cap
 * whose disclosed order book is compounding far ahead of recognized revenue while
 * the price is deep in a drawdown.
 *
 * Multiplicative in three DISCLOSED quantities, so all must genuinely hold:
 *   lead - how far contracted demand growth exceeds revenue growth,
 *   drawdown - how far the name is off its own high (the entry),
 *   quality - the fundamentals sub-score (this must still be a real business).
 *
 * Deliberately does NOT look at momentum: bad momentum is the archetype's
 * precondition, and paying for it twice is what buried these names. The
 * anti-falling-knife discipline lives where it belongs - the archetype requires
 * profitability, a serviced balance sheet, a bounded drawdown, and a GROWING
 * disclosed order book, none of which a genuine value trap has.
 */
function misunderstoodTilt(
  signal: StockSignal,
  flags: ArchetypeFlags | undefined,
  max: number,
): number {
  if (max <= 0 || !flags?.misunderstoodQuality) return 0;

  const lead = contractedDemandLead(signal);
  if (lead == null) return 0;
  // Saturates at +100pp of demand lead - beyond that it is already maximal
  // evidence, and letting it scale further would just rank filing quirks.
  const leadScore = clamp(lead / 1.0, 0, 1);

  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  if (closes.length < 120 || price <= 0) return 0;
  const high = Math.max(price, ...closes);
  const offHigh = high > 0 ? (high - price) / high : 0;
  // 20% off → 0, 60%+ off → 1. The deeper the discount on the SAME evidence, the
  // more asymmetric the entry.
  const drawdownScore = clamp((offHigh - MISUNDERSTOOD_MIN_OFF_HIGH) / 0.4, 0, 1);

  const fundDim = signal.score.categories.find((c) => c.key === "fundamentals")?.score ?? 50;
  const quality = clamp((fundDim - 45) / 35, 0, 1);

  // Geometric-ish blend: the lead is the thesis, the drawdown is the entry, and
  // quality gates both. A zero in any leg collapses the tilt.
  const strength = leadScore * (0.35 + 0.65 * drawdownScore) * quality;
  return round(max * clamp(strength, 0, 1), 2);
}

/**
 * How much of a name's fundamental evidence actually exists, 0..1.
 *
 * Every scorer treats an UNDISCLOSED field as a neutral 50 - individually correct
 * (never fabricate, never punish a gap) but collectively exploitable: a name with
 * three of eight fundamentals on file collects neutral readings for the other five
 * and can then out-rank a fully-documented peer on the strength of a couple of
 * tilts. Galaxy Digital reached #1 with gross margin, P/E, PEG, EPS growth and
 * debt/equity all absent.
 *
 * The fix is not to punish missing data - it is to refuse to pay MAXIMUM REWARD on
 * MINIMUM EVIDENCE. This scales the positive tilts only; penalties are untouched,
 * so a thinly-documented name can never dodge a risk it does disclose.
 */
const EVIDENCE_FLOOR = 0.55;

function evidenceCompleteness(signal: StockSignal): number {
  const map = signal.fundamentalsAvailability;
  if (!map) return 1; // no map at all ⇒ legacy/sample record, judged as before
  const keys = Object.keys(map) as Array<keyof typeof map>;
  if (keys.length === 0) return 1;
  const disclosed = keys.filter((k) => map[k] === true).length;
  const fraction = disclosed / keys.length;
  const base = clamp(EVIDENCE_FLOOR + (1 - EVIDENCE_FLOOR) * fraction, EVIDENCE_FLOOR, 1);

  // CORROBORATION RELIEF (owner request 2026-07-26). Scaling rewards by disclosure alone punishes the
  // wrong names: an early-stage contractor can have a thin ratio file and still be one of the
  // best-evidenced ideas on the board because it has filed an order book and won a dated
  // contract. So HARD, DATED, PRIMARY-SOURCE evidence buys back the benefit of the doubt that a
  // missing P/E took away.
  //
  // Only genuinely hard evidence counts - a filed backlog, a dated catalyst of real
  // magnitude, or disclosed insider/strategic buying. News volume and social
  // chatter are deliberately excluded: they are the things a thin-file speculative
  // name has MOST of, and letting them count would invert the whole point.
  const pipe = signal.pipeline;
  const hasOrderBook = (pipe?.backlogToRevTTM ?? 0) > 0 || pipe?.backlogYoY != null;
  const hasCatalyst =
    signal.catalystLive === true && (signal.catalyst?.magnitude ?? 0) >= 0.35;
  const hasConviction =
    (signal.congressTrades?.length ?? 0) > 0 || signal.strategicCapital != null;
  const corroboration = clamp(
    (hasOrderBook ? 0.45 : 0) + (hasCatalyst ? 0.4 : 0) + (hasConviction ? 0.15 : 0),
    0,
    1,
  );

  // Relief closes the gap toward full credit, never beyond it.
  return clamp(base + (1 - base) * corroboration, EVIDENCE_FLOOR, 1);
}

/**
 * UPSIDE ASYMMETRY - how much room is left, on a name worth owning.
 *
 * Three DISCLOSED / MEASURED quantities, no narrative:
 *
 *   room - the gain needed to reclaim the name's own prior high. A stock 65%
 *             off its high must rise ~186% to get back; one 12% off needs ~14%.
 *             This is the honest arithmetic of a drawdown and nothing more.
 *   size - headroom to multiply. A $5T company doubling means adding $5T of
 *             market value; a $200B one adding $200B. Both are possible, but they
 *             are not equally probable, and "it has the strongest fundamentals" is
 *             partly a CONSEQUENCE of already being the largest, not independent
 *             evidence of what happens next.
 *   beta - how much of the move would be the market's rather than the company's.
 *             A name that moves ~1.5x the index carries amplified drawdown for the
 *             same thesis; measured from real closes (`realizedBeta`), not assumed.
 *
 * The NEGATIVE side has no such gate - being large, extended and market-driven caps your upside
 * regardless of how good the business is, which is precisely the point being made.
 */
function asymmetryTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const closes = signal.priceHistory ?? [];
  const price = signal.price > 0 ? signal.price : (closes[closes.length - 1] ?? 0);
  if (closes.length < 120 || price <= 0) return 0;

  const high = Math.max(price, ...closes);
  const offHigh = high > 0 ? (high - price) / high : 0;
  // Gain required to reclaim the prior high, saturating at +100%.
  const recovery = offHigh < 1 ? offHigh / (1 - offHigh) : 1;
  const drawdownRoom = clamp(recovery, 0, 1);

  // CONSOLIDATION IS ALSO ROOM (owner request 2026-07-26).
  //
  // Measuring "room to run" purely as distance from the 52-week high treats two
  // opposite situations identically. Amazon sits ~1% off its high and therefore
  // scored as extended - but its price compounded 5.8% a year while its revenue
  // compounded 10.9%, and it trades at the cheap end of its own earnings history.
  // It has not run; it has CONSOLIDATED while the business grew past it. A name
  // that has gone sideways for years as its fundamentals caught up has real room,
  // and a name that tripled to reach the same "1% off its high" does not.
  //
  // So room is the BETTER of two honest readings: how far it fell, or how far its
  // fundamentals have outrun its price. Both are bounded and evidence-backed, and
  // a name with neither still scores zero.
  const pctile = signal.valuation?.peVsOwn5yrPctile;
  const divergence = signal.valuation?.revenueVsPriceDivergence;
  // Cheap against its own multi-year multiple (0.5 → 0, 0.0 → 1).
  const cheapVsOwnPast =
    pctile != null && Number.isFinite(pctile) ? clamp((0.5 - pctile) / 0.5, 0, 1) : 0;
  // Business compounding ahead of the share price, saturating at +15pp a year.
  const businessAhead =
    divergence != null && Number.isFinite(divergence) ? clamp(divergence / 0.15, 0, 1) : 0;
  const consolidationRoom = Math.min(cheapVsOwnPast, businessAhead);

  const room = Math.max(drawdownRoom, consolidationRoom);

  // Size headroom: full at ≤$50B, none at ≳$3T.
  const cap = signal.marketCap ?? 0;
  const size =
    cap > 0 ? clamp(1 - (Math.log10(cap) - Math.log10(5e10)) / (Math.log10(3e12) - Math.log10(5e10)), 0, 1) : 0.5;

  // Market dependence: beta 1.0 is neutral, 2.0+ means most of the move is the tape.
  const beta = signal.volatility?.beta;
  const marketDriven =
    beta != null && Number.isFinite(beta) ? clamp((beta - 1) / 1, 0, 1) : 0;

  const fundDim = signal.score.categories.find((c) => c.key === "fundamentals")?.score ?? 50;
  const quality = clamp((fundDim - 40) / 40, 0, 1);

  // POSITIVE: real room, on a quality business, not already gigantic.
  const upside = room * quality * (0.45 + 0.55 * size);
  // NEGATIVE: upside is capped when the name is large, market-driven, and
  // genuinely EXTENDED.
  //
  // "Extended" used to mean "near its 52-week high" (1 − room). A name that went sideways for
  // years while the business compounded past it is near its high because it CAUGHT UP, not
  // because it ran. Extension is therefore measured as PRICE OUTRUNNING THE BUSINESS - a
  // negative revenue-vs-price divergence over the multi-year window - and the 52-week reading
  // only says whether there is room to recover, not whether the name ran. A name with a positive
  // divergence (business ahead) is not extended at all; Constellation-style price +31%/yr on
  // revenue +1%/yr is fully extended. Where no multi-year history exists, fall back to the old
  // proximity read so a recent listing is neither excused nor condemned by a series it lacks.
  const extension =
    divergence != null && Number.isFinite(divergence)
      ? clamp(-divergence / 0.15, 0, 1)
      : 1 - room;
  const capped = (1 - room) * extension * (1 - size) * (0.4 + 0.6 * marketDriven);

  return round(clamp(max * upside - max * capped, -max, max), 2);
}

/**
 *
 * The own-history valuation percentile was already being computed correctly, but
 * it entered the score as 25% of ONE dimension out of thirteen - far too weak to
 * change an outcome. The live board proved it: Lockheed Martin ranked #9 while
 * sitting at percentile 1.00, i.e. the most expensive it has EVER been against its
 * own history, with the business growing 2.3% a year against a share price growing
 * 8.3%. Constellation Energy ranked #7 having compounded 31% a year on 1.2%
 * revenue growth. Both are "already ran", which is the exact inverse of the
 * mandate. Meanwhile SoFi - whose revenue compounded 34.8% a year against a 5.5%
 * share price, the widest positive divergence on the board - sat at #42.
 *
 * So the reading is promoted to a first-class, SIGNED tilt:
 *
 *   REWARD  cheap against its own past AND the business outgrew the stock. Both
 *           are required: cheap-with-shrinking-revenue is a value trap, and a wide
 *           divergence on an already-expensive multiple is just a re-rating.
 *   PENALTY expensive against its own past. Deliberately NOT quality-gated -
 *           being an excellent company is no defence against having already been
 *           re-rated, and that is precisely the failure mode being corrected.
 *
 * Inert for any name without a real disclosed multi-year history, so it can never
 * fire on an assumption.
 */
/**
 * Combine the two valuation demotions without double-charging.
 *
 * `ownHistoryTilt` (dear against its own past) and `absoluteMultipleTilt` (dear in
 * absolute terms) are two measurements of one observation: this name is
 * expensively priced. Summing them at full strength punishes that single fact
 * twice. The worse of the two stands in full; the other contributes only a
 * fraction, so failing both tests is still worse than failing one - just not
 * additively worse.
 */
function cappedValuationPenalty(ownHistoryPts: number, absoluteMultiplePts: number): number {
  const a = Math.min(ownHistoryPts, 0);
  const b = Math.min(absoluteMultiplePts, 0);
  if (a === 0 && b === 0) return 0;
  const worst = Math.min(a, b);
  const other = Math.max(a, b);
  return round(worst + SECOND_VALUATION_CHARGE * other, 2);
}

function ownHistoryTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const pctile = signal.valuation?.peVsOwn5yrPctile;
  if (pctile == null || !Number.isFinite(pctile)) return 0;

  const divergence = signal.valuation?.revenueVsPriceDivergence;

  // CHEAP side: 0.45 → 0, 0.00 → 1.
  const cheap = clamp((0.45 - pctile) / 0.45, 0, 1);
  // EXPENSIVE side: 0.60 → 0, 1.00 → 1.
  const rich = clamp((pctile - 0.6) / 0.4, 0, 1);

  // Divergence support, saturating at +25pp a year of business-over-price growth.
  const outgrew =
    divergence != null && Number.isFinite(divergence) ? clamp(divergence / 0.25, 0, 1) : 0;
  // A negative divergence (the stock ran ahead of the business) compounds the
  // expensive side rather than merely failing to help.
  const ranAhead =
    divergence != null && Number.isFinite(divergence) ? clamp(-divergence / 0.25, 0, 1) : 0;

  // The reward REQUIRES both legs: a cheap multiple only matters when the business
  // behind it actually grew.
  const reward = cheap * (0.35 + 0.65 * outgrew);
  const penalty = rich * (0.55 + 0.45 * ranAhead);

  return round(clamp(max * reward - max * penalty, -max, max), 2);
}

/**
 * ABSOLUTE-MULTIPLE tilt - the judgement the engine never had.
 *
 * He is pointing at a genuine hole. EVERY valuation read in this engine is
 * RELATIVE - a cross-sectional z against the universe, a discount against the
 * name's own 52-week high, a percentile against its own multi-year multiple.
 * Palantir scores well on the first two (41% off its high) and is already
 * penalised on the third, yet nothing anywhere states the plain fact that you are
 * paying ~130 years of current earnings. A stock can be simultaneously "cheaper
 * than it was", "well off its high", and still expensive in absolute terms, and
 * the engine had no way to say so.
 *
 *   • nothing fires below {@link RICH_PE_FLOOR} - an ordinary multiple is ignored;
 *   • the penalty is graduated, so 40x and 130x are not treated alike;
 *   • GROWTH BUYS RELIEF via PEG, because a high multiple on genuine compounding
 *     is a different thing from a high multiple on a flat business. A PEG at or
 *     under 1 keeps most of the credit; by a PEG of 3 the growth no longer
 *     explains the price.
 *   • an unprofitable name (null P/E) is NOT handled here - that is the burn /
 *     solvency penalty's job, and double-charging it would be wrong.
 *
 * One-sided DOWN and bounded, so it can demote a richly-priced name out of the
 * top of the board without ever being the reason something is picked.
 */
const RICH_PE_FLOOR = 30;
const RICH_PE_SATURATION = 120;

function absoluteMultipleTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const f = signal.fundamentals;
  const pe = f?.peRatio;
  // Null/negative P/E means no meaningful earnings multiple - the burn penalty
  // covers that case, so stay silent rather than charge twice.
  if (pe == null || !Number.isFinite(pe) || pe <= 0) return 0;

  const richness = clamp((pe - RICH_PE_FLOOR) / (RICH_PE_SATURATION - RICH_PE_FLOOR), 0, 1);
  if (richness <= 0) return 0;

  // Growth relief: PEG <= 1 keeps ~70% of the credit, PEG >= 3 keeps none.
  const peg = f?.pegRatio;
  const relief =
    peg != null && Number.isFinite(peg) && peg > 0
      ? 0.7 * clamp((3 - peg) / 2, 0, 1)
      : 0; // no PEG on file ⇒ the multiple stands unexplained

  return round(-max * richness * (1 - relief), 2);
}

/**
 * ATTENTION tilt - a setup only pays if somebody is watching.
 *
 * He is describing a real mechanism, not a popularity contest. Everything else in
 * this engine identifies a mispricing; NOTHING asks whether there is enough of a
 * market present to CLOSE it. A cheap, ignored name can stay cheap and ignored for
 * years - the thesis is right and the trade still does not work. Conversely a name
 * with a real following re-rates quickly once the evidence turns, which is exactly
 * the reversal response this product is trying to catch.
 *
 * Measured CAP-NORMALISED so it is not a back-door mega-cap preference:
 *   turnover - daily dollar volume ÷ market cap. A heavily-traded small cap
 *              (SoFi, AMC) scores ABOVE a sleepy mega-cap, which is the intent.
 *   coverage - qualifying news items in the trailing week, as a second, weaker
 *              leg so a name can qualify on genuine attention as well as flow.
 *
 * Mostly a REWARD, with only a mild demotion for genuinely untraded names - the owner
 * was explicit that nothing should be removed, and a neglected quality name should
 * still be able to surface on the strength of its evidence.
 */
function attentionTilt(signal: StockSignal, max: number): number {
  if (max <= 0) return 0;
  const cap = signal.marketCap;
  const dollarVolume = signal.liquidity?.avgDollarVolume;
  if (!(cap > 0) || dollarVolume == null || !Number.isFinite(dollarVolume)) return 0;

  // Daily turnover. ~0.05%/day is a name nobody trades; ~1.5%/day is heavily
  // traded relative to its size.
  const turnover = dollarVolume / cap;
  const turnover01 = clamp((turnover - 0.0005) / (0.015 - 0.0005), 0, 1);

  // Coverage: a weaker second leg, saturating at ~15 qualifying items a week.
  const count7d = signal.news?.count7d ?? 0;
  const coverage01 = clamp(count7d / 15, 0, 1);

  const attention = clamp(0.75 * turnover01 + 0.25 * coverage01, 0, 1);

  // Centred just below the middle so an ordinary name is ~neutral, a well-followed
  // one is rewarded, and only a genuinely ignored name is (mildly) demoted. The
  // downside is deliberately a third of the upside.
  const centred = attention - 0.35;
  return round(centred >= 0 ? max * (centred / 0.65) : (max / 3) * (centred / 0.35), 2);
}

/**
 * So the reversal-readiness gate gets a QUALITY FLOOR: a genuine washed-out-QUALITY reversal
 * (the megaReversal archetype - cheap + oversold + quality floor + margin turn) or a compounder
 * / strong-fundamentals name earns most of its discount reward even while its price is still
 * drifting down - its quality, not merely "the fall has already stopped", justifies the entry.
 * This is exactly the CEG/AEM/KKR case the raw price-action gate under-rewarded (×0.15). A junk
 * falling knife (no archetype, weak fundamentals) gets floor 0 and stays fully gated by price
 * action, so the knife-drop from P1 is preserved. A live catalyst already bypasses the gate
 * upstream (readiness 1). Returns a 0..1 floor.
 */
function qualityReadinessFloor(
  flags: ArchetypeFlags | undefined,
  dimRaw: Partial<Record<ScoreCategoryKey, number>>,
  valuation?: StockSignal["valuation"],
): number {
  // The floor is tied to a genuine reversal / re-acceleration ARCHETYPE, not bare fundamentals:
  // megaReversal requires a controlled washout (30-75% off-high + quality floor + margin turn)
  // and compounder requires bounded/positive momentum, so both exclude a vertically-crashing
  // knife.
  const fundamentals = dimRaw.fundamentals ?? 0;
  if (flags?.megaReversal) return 0.8; // deliberate washed-out-QUALITY reversal
  // T4: a profitable large cap whose DISCLOSED order book is compounding ahead of
  // revenue. Its price is still falling by definition - that is the setup - so a
  // pure price-action readiness gate would zero its discount reward exactly when
  // the evidence is strongest. The floor is deliberately BELOW megaReversal's:
  // this name has not yet shown the fall has stopped, so it collects most, not
  // all, of the discount reward. The archetype's own solvency/profitability/
  // growing-backlog requirements are what keep a genuine knife out.
  if (flags?.misunderstoodQuality) return 0.7;
  if (flags?.compounder && fundamentals >= 55) return 0.6; // re-accelerating quality

  // Price-action readiness answers "has the fall stopped?", which is the wrong
  // question for a name whose fundamentals are demonstrably improving while the
  // multiple compresses. SoFi's readiness was 0.00 - no deceleration, no basing -
  // in the same week it beat, RAISED guidance and posted record originations, so
  // its discount reward was zeroed at the exact moment the entry was best.
  //
  // DISCLOSED valuation evidence therefore earns a PARTIAL floor: cheap against
  // its own multi-year multiple AND the business compounding ahead of the share
  // price. Capped well below the archetype floors above, because the fall really
  // has not stopped and that is a genuine risk - this softens the gate rather than
  // removing it. A deteriorating business gets nothing: the divergence leg
  // requires revenue to be outgrowing price, which a value trap never is.
  const pctile = valuation?.peVsOwn5yrPctile;
  const divergence = valuation?.revenueVsPriceDivergence;
  if (
    pctile != null &&
    Number.isFinite(pctile) &&
    pctile <= 0.4 &&
    divergence != null &&
    Number.isFinite(divergence) &&
    divergence > 0 &&
    fundamentals >= 45
  ) {
    const cheapness = clamp((0.4 - pctile) / 0.4, 0, 1);
    const ahead = clamp(divergence / 0.15, 0, 1);
    return round(0.45 * (0.4 + 0.6 * Math.min(cheapness, ahead)), 3);
  }
  return 0;
}

/**
 * `TOP_TAPER` is the softness.
 */
const TOP_KNEE = 95;
const TOP_TAPER = 7;

/** Smoothly bend everything above the knee toward an asymptote of 100. Monotone +
 *  identity below the knee, so it only tames the saturated top. */
function softTopTaper(x: number): number {
  if (x <= TOP_KNEE) return x;
  return TOP_KNEE + (100 - TOP_KNEE) * (1 - Math.exp(-(x - TOP_KNEE) / TOP_TAPER));
}

/**
 * Decompress a universe's UNCLAMPED composite scores across the full 0-100 scale.
 *
 * MONOTONE and order-preserving: each score becomes
 *   `softTopTaper( weight·(percentile·100) + (1−weight)·raw )`,
 * a convex combination of two non-decreasing functions passed through a monotone top
 * taper - so the RANKING never changes, only the displayed number. The percentile
 * leg fills the scale (worst → ~0, every band evenly populated); the ABSOLUTE leg
 * uses the **unclamped** composite (not the 0-100-clamped score) so the very top
 * stays differentiated - PLTR ≠ APP ≠ AMAT instead of all three pinning at 100 - and
 * keeps cross-day meaning so a weak day's best floats below 100. The top taper then
 * bends the saturated top toward 100 so the day's best reads ~97-99 and an exact 100
 * is rare. Pure (array in → array out, no clocks/RNG); idempotent via the caller,
 * which always derives `raw` from the preserved raw category scores.
 */
export function decompressDisplayScores(
  raw: number[],
  weight = DISPLAY_DECOMPRESS_WEIGHT,
): number[] {
  if (raw.length === 0) return [];
  const pr = percentileRank(raw);
  return raw.map((x, i) => clamp(round(softTopTaper(weight * (pr[i]! * 100) + (1 - weight) * x))));
}

export interface NormalizedScore {
  ticker: string;
  /** Challenger opportunity score, 0..100 (the ranking key). */
  opportunityScore: number;
  /** Per-dimension cross-sectional z-scores (the challenger's relative view). */
  dimensionZ: Partial<Record<ScoreCategoryKey, number>>;
  /** Whether the soft thesis gate cleared (Mission 4). */
  thesisCleared: boolean;
  /** Per-name "why it cleared" / "soft-gated for…" reason. */
  thesisReason: string;
  /** Estimate-revision momentum, 0..100 (50 = neutral); 50 when no history. */
  revisionScore: number;
  /** Bounded ± points the revision trend added to the blend (0 when neutral). */
  revisionTilt: number;
  /** Bounded ± points the small/mid-cap balancing tilt added (0 for an
   *  all-same-cap universe or when `capTilt` is 0). */
  sizeTilt: number;
  /** Bounded + points a strong, early catalyst (any type) added (LANE D); 0 when
   *  off (champion) or the name has no catalyst - never negative. */
  catalystTilt: number;
  /** Bounded − points material disclosed selling subtracted (LANE D); 0 when off
   *  or below the materiality threshold. */
  sellWatchTilt: number;
  /** Bounded ± points the discount-with-thesis tilt added (LANE D); 0 when off. */
  discountTilt: number;
  /** + points from the large-cap washed-out-QUALITY reversal tilt (0 when off). */
  reversalTilt: number;
  /** + points from the discounted quality-compounder lift (0 when off). */
  qualityCompounderTilt: number;
  /** + points from the V6 T4 misunderstood-quality tilt (0 when off / no filed pipeline). */
  misunderstoodTilt: number;
  /** ± points from the V6 upside-asymmetry tilt (room to run, size- and beta-discounted). */
  asymmetryTilt: number;
  /** ± points from the own-history valuation tilt (cheap vs its own past, business vs stock). */
  ownHistoryTilt: number;
  /** − points when the ABSOLUTE earnings multiple is extreme and growth does not explain it. */
  absoluteMultipleTilt: number;
  /** ± points from the ATTENTION tilt (cap-normalised turnover + news coverage). */
  attentionTilt: number;
  /** P1 reversal-readiness 0..1 that scaled this name's discount REWARD (1 = fall
   *  stopped / live-catalyst bypass; 0 = active falling knife). Exposed for the
   *  refinement report so the gate is auditable; 1 for thin-history names. */
  reversalReadiness: number;
  /** ± points the size-balance correction applied to the LANE-D tilt bundle to
   *  keep the model cap-BALANCED (positive ⇒ a small-cap whose tilts were lifted by
   *  size is brought back; negative ⇒ a large-cap held down by size is restored).
   *  0 when `sizeBalanceTilts` is off (champion) or the bundle has no size skew. */
  sizeBalanceTilt: number;
  /** The unified catalyst strength 0..100 driving `catalystTilt` (0 when off). */
  catalystScore: number;
  /** The lead catalyst type/description driving the pick (for the feed tile). */
  catalystLead: string;
  /** V4 archetype flags used by the cap-curve overlay. */
  archetypeFlags: ArchetypeFlags;
}

/**
 * Compute the challenger's normalized score for every signal in the universe.
 * Returns one entry per input signal, in the same order. Used both by
 * {@link normalizeUniverse} (to re-rank the feed) and by the champion/challenger
 * measurement (to record the challenger's view of the same picks).
 */
export function computeNormalizedScores(
  signals: StockSignal[],
  ctx?: NormalizationContext,
  options: NormalizationOptions = DEFAULT_OPTIONS,
): NormalizedScore[] {
  const n = signals.length;
  if (n === 0) return [];

  // UNKNOWN caps (≤0 / non-finite - same definition as capCohort) pin to the
  // universe CENTER: no size information must mean NO size tilt. Mapping them
  // through log10(max(cap,1)) = 0 put a cap-unknown $450B ADR (TSM) ~9σ below
  // the center and handed it the MAXIMUM small-cap boost (+capTilt).
  const knownLogCaps = signals
    .filter((s) => Number.isFinite(s.marketCap) && s.marketCap > 0)
    .map((s) => Math.log10(s.marketCap));
  const centerLogCap = knownLogCaps.length > 0 ? mean(knownLogCaps) : 0;
  const logCaps = signals.map((s) =>
    Number.isFinite(s.marketCap) && s.marketCap > 0 ? Math.log10(s.marketCap) : centerLogCap,
  );
  const sectors = signals.map((s) => String(s.sector));
  // Universal cap-balancing tilt (see {@link sizeTilts}) - applied to EVERY model
  // so neither champion nor challenger is mega-cap heavy. Strength is the only
  // per-model knob here; the universe and the residualization are identical.
  const sizeTilt = sizeTilts(logCaps, options.capTilt);
  const archetypeFlags = options.archetypeOverlay
    ? signals.map((s) => ctx?.archetypes?.[s.ticker] ?? inferArchetypeFlags(s))
    : null;
  const regime = options.regimeTilt ? ctx?.regime : undefined;
  const regimeRiskOffness = options.regimeTilt ? clamp(regime?.riskOffness ?? 0, 0, 1) : 0;
  // Quality discipline scales UP in panic (pumpRisk / dilution / extension et al.
  // demote speculative junk harder), which is the anti-speculation half of the
  // panic-opportunity mode - the pro-quality half is the amplified discount tilt.
  const riskPenaltyMultiplier = options.regimeTilt
    ? 1 + regimeRiskOffness * 1.5
    : 1;

  // Per-dimension cross-sectional z across the whole universe. News/social use
  // their EWMA-smoothed input when the context supplies one (Mission 4).
  const dimZ = new Map<ScoreCategoryKey, number[]>();
  for (const cfg of CATEGORY_CONFIG) {
    let vals = rawDimension(signals, cfg.key, ctx);
    if (cfg.sizeResidualized) vals = residualize(vals, logCaps);
    if (cfg.sectorNeutral) vals = sectorDemean(vals, sectors);
    dimZ.set(cfg.key, toCrossSectionalZ(vals));
  }

  // Blend the per-dimension z-scores. v2: when `capCohortWeights` is on, each name
  // uses its cap-cohort weight vector (small/large curve - both sum to 1.0) so the
  // blend stays a proper weighted average; otherwise the flat CATEGORY_CONFIG
  // weights. Then standardize for display spread.
  const cohortVectors = options.capCohortWeights
    ? signals.map((s, i) => {
        const v = capCurveWeights(s.marketCap, archetypeFlags?.[i], regime, s.liquidity?.avgDollarVolume);
        // V5 challenger: de-weight momentum toward the early-entry signals so a
        // below-trend reversal/breakout setup isn't dragged by its momentum sub-score.
        return options.momentumWeightScale != null && options.momentumWeightScale < 1
          ? dampMomentumWeight(v, options.momentumWeightScale)
          : v;
      })
    : null;
  const blend = new Array<number>(n).fill(0);
  for (const cfg of CATEGORY_CONFIG) {
    const z = dimZ.get(cfg.key)!;
    for (let i = 0; i < n; i++) {
      const w = cohortVectors ? cohortVectors[i]![cfg.key] : cfg.weight;
      blend[i]! += w * z[i]!;
    }
  }
  const blendStd = stdev(blend) || 1;

  // --- PASS 1: per-name pieces. We compute the bounded LANE-D tilts (catalyst,
  //     sell, discount) and the revision tilt for EVERY name first, because the
  //     size-balancing correction (below) needs the whole universe's tilt bundle
  //     before it can strip the part that scales with market cap.
  const dimensionZs: Array<Partial<Record<ScoreCategoryKey, number>>> = [];
  const thesisResults = new Array<{ cleared: boolean; reason: string; penalty: number }>(n);
  const revisionScores = new Array<number>(n);
  const revisionTilts = new Array<number>(n);
  const catalystTilts = new Array<number>(n);
  const sellWatchTilts = new Array<number>(n);
  const discountTilts = new Array<number>(n);
  const reversalTilts = new Array<number>(n);
  const qualityCompounderTilts = new Array<number>(n);
  const misunderstoodTilts = new Array<number>(n);
  const asymmetryTilts = new Array<number>(n);
  const ownHistoryTilts = new Array<number>(n);
  const absoluteMultipleTilts = new Array<number>(n);
  const attentionTilts = new Array<number>(n);
  const catalystStrengths = new Array<number>(n);
  const catalystLeads = new Array<string>(n);
  const readinessValues = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const signal = signals[i]!;
    const dimensionZ: Partial<Record<ScoreCategoryKey, number>> = {};
    for (const cfg of CATEGORY_CONFIG) dimensionZ[cfg.key] = round(dimZ.get(cfg.key)![i]!, 4);
    dimensionZs[i] = dimensionZ;
    // RAW 0..100 sub-scores for this name - lets the thesis gate + discount tilt tell
    // a genuinely data-backed backer from a cold-start neutral-50 (P4).
    const dimRaw: Partial<Record<ScoreCategoryKey, number>> = {};
    for (const c of signal.score.categories) dimRaw[c.key] = c.score;
    // P1 reversal-readiness (deceleration + basing), 0..1. Scales the discount
    // REWARD only - a below-MA name is never penalized for it (see reversalReadiness.ts).
    // P1-refine: a solid reversal candidate (megaReversal / compounder / strong
    // fundamentals) gets a QUALITY FLOOR so its discount is prioritized even while
    // still drifting; a junk knife stays fully gated by price action.
    const rr = reversalReadiness(signal);
    let readiness = Math.max(rr.readiness, qualityReadinessFloor(archetypeFlags?.[i], dimRaw, signal.valuation));
    // FRESH-SHOCK damper (owner request 2026-07-03, AEM mine-halt): a washout digesting a
    // recent adverse EVENT isn't a clean entry - halve the discount reward AFTER the
    // quality floor, so it cuts through even a megaReversal's floor.
    if (rr.freshShock) readiness *= 0.5;
    readinessValues[i] = readiness;

    // Soft thesis gate (a challenger refinement): demote - never remove - names
    // that lack both a reason to move and something behind it. The champion runs
    // without it (options.thesisGate === false), so its only quality control is
    // the blend + risk penalty + cap balancing.
    thesisResults[i] = options.thesisGate
      ? thesisGate(dimensionZ, dimRaw)
      : { cleared: true, reason: "Champion model — thesis gate off.", penalty: 0 };

    // Estimate-revision momentum (Mission 4 data-dep): a bounded tilt up for
    // names whose consensus EPS is being revised up, down for cuts. Neutral
    // (50 → 0 points) without snapshot history, so it's cold-start safe.
    const revisionScore = ctx?.revision?.[signals[i]!.ticker] ?? REVISION_NEUTRAL;
    revisionScores[i] = revisionScore;
    revisionTilts[i] = round(
      ((revisionScore - REVISION_NEUTRAL) / REVISION_NEUTRAL) * MAX_REVISION_POINTS,
      2,
    );

    // --- LANE D: catalyst-driven blend (challenger only; champion leaves these
    //     knobs off, so its ranking is unchanged). All bounded & additive on top
    //     of the normalized base - a MODERATE, clearly-felt weight, never a gate.
    // Strong, EARLY catalyst of ANY type lifts the name (one-sided UP, so a
    // catalyst-less quality name is never penalized). Off (0) ⇒ champion / no data.
    const strength = options.catalystStrengthMax
      ? catalystStrength(signal)
      : { strength: 0, leadType: null as string | null, leadDescription: "" };
    catalystTilts[i] = options.catalystStrengthMax
      ? round((strength.strength / 100) * options.catalystStrengthMax, 2)
      : 0;
    catalystStrengths[i] = strength.strength;
    catalystLeads[i] = strength.leadType
      ? `${strength.leadType}: ${strength.leadDescription}`
      : "";
    // Material disclosed selling by major insiders / important people is a
    // negative catalyst (threshold-gated: a small routine sale scores 0).
    const sell = options.sellWatchMax ? materialSellSignal(signal) : { intensity: 0 };
    sellWatchTilts[i] = options.sellWatchMax ? round(-sell.intensity * options.sellWatchMax, 2) || 0 : 0;
    // Discounted-with-thesis up, "already ran / chasing highs" down. The reward
    // leg is scaled by P1 reversal-readiness and gated to genuinely data-backed
    // backers (P4) via the raw sub-scores.
    discountTilts[i] = discountTilt(
      dimensionZ,
      options.discountTiltMax ?? 0,
      regimeRiskOffness,
      readiness,
      dimRaw,
    );
    // Large-cap discounted-REVERSAL archetype: washed-out quality lifts (champion only).
    reversalTilts[i] = reversalTilt(signal, options.reversalTiltMax ?? 0);
    qualityCompounderTilts[i] = qualityCompounderTilt(signal, options.qualityCompounderTiltMax ?? 0);
    // V6 T4: disclosed order book compounding ahead of revenue, deep drawdown.
    misunderstoodTilts[i] = misunderstoodTilt(
      signal,
      archetypeFlags?.[i],
      options.misunderstoodTiltMax ?? 0,
    );
    // V6 asymmetry: how much room is left, size- and beta-discounted.
    asymmetryTilts[i] = asymmetryTilt(signal, options.asymmetryTiltMax ?? 0);
    // Before it has run, not after.
    ownHistoryTilts[i] = ownHistoryTilt(signal, options.ownHistoryTiltMax ?? 0);
    // "138x earnings is not insignificant" - the absolute read the engine lacked.
    absoluteMultipleTilts[i] = absoluteMultipleTilt(
      signal,
      options.absoluteMultipleTiltMax ?? 0,
    );
    // Is anyone present to close the mispricing?
    attentionTilts[i] = attentionTilt(signal, options.attentionTiltMax ?? 0);
  }

  // --- SIZE-BALANCE the LANE-D tilt bundle (challenger only). The catalyst +
  //     sell + discount + revision tilts are the right idea but skew toward
  //     small-caps in a discovery universe, so stacked they quietly re-introduce
  //     the size skew the per-dimension residualization removed - pushing Today to
  //     small-caps. We regress the bundle on log(market cap) and SUBTRACT the
  //     size-explained part (OLS residual), then apply only that CORRECTION to the
  //     ranking score. This keeps each tilt's ordering WITHIN a size cohort (a
  //     catalyzed small-cap still beats an un-catalyzed one) - so small-caps still
  //     surface on merit - while removing the systematic "small ⇒ more tilt" lift,
  //     yielding a cap-BALANCED small/mid/large spread. The structural `sizeTilt`
  //     is already zero-mean and the thesis penalty is a gate, not a size-lift, so
  //     both stay out of the bundle. Off ⇒ correction is exactly 0 (champion).
  const tiltBundle = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    tiltBundle[i] = catalystTilts[i]! + sellWatchTilts[i]! + discountTilts[i]! + revisionTilts[i]!;
  }
  const sizeBalanceCorrections = new Array<number>(n).fill(0);
  if (options.sizeBalanceTilts) {
    const residualBundle = residualize(tiltBundle, logCaps);
    for (let i = 0; i < n; i++) {
      // correction = (size-neutral bundle) − (raw bundle): adds back to a small-cap
      // that was lifted purely by size, subtracts from a large-cap that was held
      // down by it, leaving the cohort-relative ordering intact.
      sizeBalanceCorrections[i] = round(residualBundle[i]! - tiltBundle[i]!, 2) || 0;
    }
  }

  // --- PASS 2: assemble the final scores with the size-balance correction folded
  //     into the ranking key only (raw per-tilt fields are preserved for tiles).
  const results: NormalizedScore[] = [];
  // The UNCLAMPED composite per name (can exceed 100 / go below 0) - decompression
  // uses this so the very top stays differentiated instead of all pinning at the 100
  // clamp (a 3.1σ name and a 2.8σ name are no longer both "100").
  const rawScores = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const standardized = blend[i]! / blendStd;
    const base = DISPLAY_CENTER + DISPLAY_SCALE * standardized;
    const penalty = (signals[i]!.score.riskPenalty ?? 0) * riskPenaltyMultiplier;
    const dimensionZ = dimensionZs[i]!;
    const thesis = thesisResults[i]!;
    const revisionScore = revisionScores[i]!;
    const revisionTilt = revisionTilts[i]!;
    // `|| 0` normalizes a negated -0 to +0 so the public sizeTilt is never -0.
    const sizeTiltPts =
      round(sizeTilt[i]! * (1 - regimeRiskOffness * REGIME_CAP_TILT_COOLDOWN_MAX), 2) || 0;
    const signal = signals[i]!;
    const catalystTilt = catalystTilts[i]!;
    const sellWatchTilt = sellWatchTilts[i]!;
    const discountTiltPts = discountTilts[i]!;
    const reversalTiltPts = reversalTilts[i]!;
    const qualityCompounderTiltPts = qualityCompounderTilts[i]!;
    const misunderstoodTiltPts = misunderstoodTilts[i]!;
    const asymmetryTiltPts = asymmetryTilts[i]!;
    const ownHistoryTiltPts = ownHistoryTilts[i]!;
    const absoluteMultipleTiltPts = absoluteMultipleTilts[i]!;
    const attentionTiltPts = attentionTilts[i]!;
    const sizeBalanceTilt = sizeBalanceCorrections[i]!;

    // Scale the REWARD side by how much evidence the name actually discloses, so a
    // thinly-documented record cannot collect full credit on neutral placeholders.
    // Penalties and the size-balance correction are deliberately NOT scaled.
    const evidence = evidenceCompleteness(signal);
    // ENTRY QUALITY. A separate own-history PENALTY was not enough on its own:
    // Lockheed at percentile 1.00 still reached #2 because a live catalyst (93) and
    // an inflection reading (96) simply out-added the -11.6 demotion. "Already run,
    // and now there is good news" is the exact chase this product exists to avoid,
    // so the REWARD side is scaled down for a name trading at the top of its own
    // multi-year valuation range. At/below the middle of its own range nothing
    // changes; at its most expensive ever the upside tilts pay ~40%.
    const ownPctile = signal.valuation?.peVsOwn5yrPctile;
    const entryDamp = options.entryQualityDamp ?? 0.6;
    const entryQuality =
      ownPctile == null || !Number.isFinite(ownPctile)
        ? 1
        : 1 - entryDamp * clamp((ownPctile - 0.5) / 0.5, 0, 1);
    const rewards =
      Math.max(revisionTilt, 0) +
      Math.max(catalystTilt, 0) +
      Math.max(discountTiltPts, 0) +
      reversalTiltPts +
      qualityCompounderTiltPts +
      misunderstoodTiltPts +
      Math.max(asymmetryTiltPts, 0) +
      Math.max(ownHistoryTiltPts, 0) +
      Math.max(attentionTiltPts, 0);
    const penalties =
      Math.min(revisionTilt, 0) +
      Math.min(catalystTilt, 0) +
      Math.min(discountTiltPts, 0) +
      sellWatchTilt +
      Math.min(asymmetryTiltPts, 0) +
      // `ownHistoryTilt` and `absoluteMultipleTilt` are different measurements of
      // the SAME underlying observation - this name is expensively priced. Applied
      // at full strength together they double-charge it: Palantir took -13.2 and
      // -16.4 for a combined -29.6 and fell from #1 to #58, which overshoots the
      // judgement rather than expressing it. The combined valuation demotion is
      // therefore capped, so being dear on both measures is worse than being dear
      // on one, but not simply additive.
      cappedValuationPenalty(ownHistoryTiltPts, absoluteMultipleTiltPts) +
      Math.min(attentionTiltPts, 0);

    const rawOpp =
      base -
      penalty -
      thesis.penalty +
      rewards * evidence * entryQuality +
      penalties +
      sizeTiltPts +
      sizeBalanceTilt;
    rawScores[i] = rawOpp;
    const opportunityScore = clamp(round(rawOpp), 0, 100);
    results.push({
      ticker: signal.ticker,
      opportunityScore,
      dimensionZ,
      thesisCleared: thesis.cleared,
      thesisReason: thesis.reason,
      revisionScore,
      revisionTilt,
      sizeTilt: sizeTiltPts,
      catalystTilt,
      sellWatchTilt,
      discountTilt: discountTiltPts,
      reversalTilt: reversalTiltPts,
      qualityCompounderTilt: qualityCompounderTiltPts,
      misunderstoodTilt: misunderstoodTiltPts,
      asymmetryTilt: asymmetryTiltPts,
      ownHistoryTilt: ownHistoryTiltPts,
      absoluteMultipleTilt: absoluteMultipleTiltPts,
      attentionTilt: attentionTiltPts,
      reversalReadiness: readinessValues[i]!,
      sizeBalanceTilt,
      catalystScore: catalystStrengths[i]!,
      catalystLead: catalystLeads[i]!,
      archetypeFlags: archetypeFlags?.[i] ?? {},
    });
  }

  // --- FINAL: decompress the displayed score across the full 0-100 scale (live
  //     champion only - `decompressDisplay`). Monotone, so the ranking order from
  //     the blend + tilts above is preserved EXACTLY; only the number the feed
  //     shows spreads out (the body otherwise bunches at 30-59). The shadow
  //     challenger leaves this off so it stays the absolute-scale baseline the
  //     outcome ledger measures against.
  if (options.decompressDisplay) {
    // Operator-tunable (the score-spread + quality-cap dials in the admin tab); both
    // fall back to the module defaults when no operator value is set (incl. the scan/
    // test env), so behaviour is unchanged until the operator moves a dial - at which
    // point every client re-ranks the shared board live with the new spread/cap.
    const spreadW = getScoreSpreadWeight();
    const capW = getQualityCapStrength();
    const decompressed = decompressDisplayScores(rawScores, spreadW);
    for (let i = 0; i < n; i++) {
      // QUALITY/RISK CEILING (owner request 2026-06-28): a name with real ISSUES - high risk
      // (volatility / dilution / already-ran) or thin conviction (low confidence) -
      // can't claim a near-100 score even when it ranks high on growth/momentum. RKLB
      // (unprofitable + volatile + IPO overhang) should NOT read 97. Only a clean,
      // well-backed, high-conviction setup reaches the very top; a strong-but-risky
      // grower still scores well, just capped. Gentle weights so it tempers, not kills.
      const risk = signals[i]!.score.riskPenalty ?? 0;
      const conf = signals[i]!.score.confidence ?? 70;
      const riskConfCeiling = 100 - risk * capW - (100 - conf) * QUALITY_CEILING_CONF_W;
      // COHERENCE CAP: bound the headline to the strongest LEGITIMATE dimension the card
      // shows, so momentum / coverage / attention can't solo-float a weak-fundamentals,
      // chasing-highs, no-catalyst name into the 90s. Uses the RAW per-category scores
      // (exactly what the "Why it scored" breakdown displays), never the z-scores.
      const cats = signals[i]!.score.categories;
      let bestLegitDim = 0;
      for (const key of COHERENCE_LEGIT_DIMS) {
        const s = cats.find((c) => c.key === key)?.score;
        if (s != null && s > bestLegitDim) bestLegitDim = s;
      }
      const coherenceCap = Math.max(COHERENCE_SOFT_TOP, bestLegitDim + COHERENCE_SLACK);
      const catalystDim = cats.find((c) => c.key === "catalyst")?.score ?? 0;
      const convictionDim = cats.find((c) => c.key === "conviction")?.score ?? conf;
      // A no-catalyst, low-conviction setup can still be interesting, but it
      // should not print as a 96/97 "best on the board" call. This catches the
      // AEM-style case without capping Microsoft-style quality names that have
      // high conviction but no fresh catalyst.
      const unconfirmedNoCatalystCap = catalystDim < 10 && convictionDim < 55 ? 88 : 100;
      const ceiling = Math.min(riskConfCeiling, coherenceCap, unconfirmedNoCatalystCap);
      results[i]!.opportunityScore = clamp(Math.min(decompressed[i]!, round(ceiling)));
    }
  }
  return results;
}

/**
 * Re-rank the universe with the challenger's normalized opportunity score. Returns
 * NEW signals (the input is never mutated); only `score.opportunityScore` changes
 * - every raw per-category score, confidence, and risk field is preserved so the
 * card explainers stay exactly as scored.
 */
export function normalizeUniverse(
  signals: StockSignal[],
  ctx?: NormalizationContext,
  options: NormalizationOptions = DEFAULT_OPTIONS,
): StockSignal[] {
  if (signals.length === 0) return signals;
  const scores = computeNormalizedScores(signals, ctx, options);
  return signals.map((s, i) => ({
    ...s,
    score: { ...s.score, opportunityScore: scores[i]!.opportunityScore },
  }));
}
