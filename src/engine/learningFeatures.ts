/**
 * learningFeatures - deterministic point-in-time feature extraction for the
 * offline learning system.
 *
 * Converts one signal snapshot into the named numeric features a learning row
 * (`PointInTimeFeatureRow.features`) carries. The mechanism families the owner
 * mandated are kept as SEPARATE features so a model can never blur them:
 *
 *  - entry state (valley / early turn / falling knife / fresh shock),
 *  - drawdown normalized to the stock's OWN history and volatility,
 *  - staleness (how much of a rebound is already consumed),
 *  - quality (margins, growth, profitability) - separate from
 *  - financing burden (debt) - separate from
 *  - demand evidence (backlog / deferred revenue / book-to-bill, the
 *    Oracle-style RPO mechanism) - separate from
 *  - valuation (multiples, own-history percentile),
 *  - expectations / momentum,
 *  - catalyst state,
 *  - insider evidence (ONLY verified open-market Form 4 P-code aggregates -
 *    grants, options, and creator claims have no path into these features),
 *  - evidence completeness (so the model can learn to distrust thin rows).
 *
 * Fail-honest rules (non-negotiable):
 *  1. A missing input is a `null` feature value, NEVER a fabricated default.
 *  2. A record with `marketDataUnavailable` set (sample/directory) yields ALL
 *     null values - sample data can never leak into training as real.
 *  3. Fundamentals are emitted only when per-field availability proves a live
 *     provider supplied them (`fundamentalsAvailability[field] === true`).
 *  4. Pure and deterministic: same snapshot in, byte-identical features out.
 */

import { reversalReadiness } from "@/engine/reversalReadiness";
import type { PointInTimeFeature, FeatureSourceKind } from "@/engine/learningDataset";
import type { RawFundamentals, StockSignal } from "@/types";
import { round, stdev } from "@/lib/math";

export const LEARNING_FEATURES_VERSION = 1 as const;

/** Canonical feature names, frozen so config-ledger feature sets stay stable. */
export const LEARNING_FEATURE_NAMES = [
  // entry state / valley detection
  "entry_reversal_readiness",
  "entry_deceleration",
  "entry_basing",
  "entry_falling_knife_veto",
  "entry_fresh_shock",
  "entry_catalyst_bypass",
  // drawdown normalized to the stock's own history & volatility
  "entry_drawdown_from_high",
  "entry_drawdown_vol_normalized",
  // staleness / already-moved
  "staleness_runup_from_20d_low",
  "staleness_runup_vol_normalized",
  // quality (kept apart from financing & valuation)
  "quality_gross_margin",
  "quality_net_margin",
  "quality_fcf_margin",
  "quality_revenue_growth_yoy",
  "quality_eps_growth_yoy",
  // financing burden (Oracle mechanism: debt is NOT demand)
  "financing_debt_to_equity",
  "financing_dilution_risk",
  // demand / forward evidence (Oracle mechanism: RPO/backlog is NOT debt)
  "demand_backlog_growth_yoy",
  "demand_deferred_revenue_yoy",
  "demand_book_to_bill",
  // valuation
  "valuation_pe_ttm",
  "valuation_pe_vs_own_5yr_pctile",
  // expectations / momentum
  "momentum_rsi",
  "momentum_return_1m",
  "momentum_return_3m",
  "momentum_relative_strength_3m",
  // catalyst state
  "catalyst_live",
  "catalyst_magnitude",
  "catalyst_days_away",
  // insider evidence (verified open-market Form 4 P-code aggregates ONLY)
  "insider_open_market_buys_90d",
  "insider_net_open_market_value_90d",
  // evidence completeness
  "evidence_price_history_length",
  "evidence_feature_coverage",
] as const;

export type LearningFeatureName = (typeof LEARNING_FEATURE_NAMES)[number];

export interface LearningFeatureObservation {
  /** When the collector observed this snapshot (row `asOfISO`-aligned). */
  readonly observedAtISO: string;
  /** Original publication instant for fundamentals, when known (EDGAR/IR). */
  readonly fundamentalsPublishedAtISO?: string;
}

const MIN_HISTORY = 120;

type FeatureMap = Record<LearningFeatureName, PointInTimeFeature>;

function feature(
  value: number | null,
  observedAtISO: string,
  source: FeatureSourceKind,
  publishedAtISO?: string,
): PointInTimeFeature {
  const rounded = value != null && Number.isFinite(value) ? round(value, 6) : null;
  return publishedAtISO != null
    ? { value: rounded, observedAtISO, publishedAtISO, source }
    : { value: rounded, observedAtISO, source };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A fundamentals field counts only when per-field availability PROVES a live
 * provider supplied it. An absent availability map means the sample/modeled
 * universe - never trainable evidence.
 */
function liveFundamental(signal: StockSignal, field: keyof RawFundamentals): number | null {
  if (signal.fundamentalsAvailability?.[field] !== true) return null;
  return finiteOrNull(signal.fundamentals?.[field]);
}

/** Deterministic entry-state block computed purely from the close series. */
function entryStateFeatures(signal: StockSignal): {
  readiness: number | null;
  deceleration: number | null;
  basing: number | null;
  fallingKnife: number | null;
  freshShock: number | null;
  catalystBypass: number | null;
  drawdown: number | null;
  drawdownVolNorm: number | null;
  runup20d: number | null;
  runupVolNorm: number | null;
  historyLength: number;
} {
  const closes = signal.priceHistory ?? [];
  const n = closes.length;
  const last = n > 0 ? closes[n - 1]! : 0;
  const price = signal.price > 0 ? signal.price : last;
  if (n < MIN_HISTORY || price <= 0 || last <= 0) {
    return {
      readiness: null,
      deceleration: null,
      basing: null,
      fallingKnife: null,
      freshShock: null,
      catalystBypass: null,
      drawdown: null,
      drawdownVolNorm: null,
      runup20d: null,
      runupVolNorm: null,
      historyLength: n,
    };
  }

  const r = reversalReadiness(signal);

  // Drawdown from the window high, normalized by the stock's OWN daily vol so
  // a −20% move in a quiet mega cap and in a volatile micro cap are comparable.
  const high = Math.max(...closes);
  const drawdown = high > 0 ? price / high - 1 : null;
  const dailyReturns: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = closes[i - 1]!;
    dailyReturns.push(prev > 0 ? (closes[i]! - prev) / prev : 0);
  }
  const dailyVol = stdev(dailyReturns);
  const drawdownVolNorm =
    drawdown != null && dailyVol > 0 ? drawdown / (dailyVol * Math.sqrt(252)) : null;

  // Staleness: how far the price has already rebounded off its 20-session low.
  const low20 = Math.min(...closes.slice(n - 20));
  const runup20d = low20 > 0 ? price / low20 - 1 : null;
  const runupVolNorm =
    runup20d != null && dailyVol > 0 ? runup20d / (dailyVol * Math.sqrt(20)) : null;

  return {
    readiness: r.readiness,
    deceleration: r.deceleration,
    basing: r.basing,
    fallingKnife: r.fallingKnifeVeto ? 1 : 0,
    freshShock: r.freshShock ? 1 : 0,
    catalystBypass: r.catalystBypass ? 1 : 0,
    drawdown,
    drawdownVolNorm,
    runup20d,
    runupVolNorm,
    historyLength: n,
  };
}

/**
 * Extract the canonical point-in-time feature map for one signal snapshot.
 * Every feature is present in every row (stable schema); unavailable inputs
 * yield `value: null`, never a synthetic number.
 */
export function extractLearningFeatures(
  signal: StockSignal,
  observation: LearningFeatureObservation,
): Readonly<FeatureMap> {
  const at = observation.observedAtISO;
  const fundsAt = observation.fundamentalsPublishedAtISO;

  // Sample/directory records carry modeled placeholders - nothing here is
  // admissible learning evidence.
  const live = signal.marketDataUnavailable == null;

  const entry = live
    ? entryStateFeatures(signal)
    : {
        readiness: null,
        deceleration: null,
        basing: null,
        fallingKnife: null,
        freshShock: null,
        catalystBypass: null,
        drawdown: null,
        drawdownVolNorm: null,
        runup20d: null,
        runupVolNorm: null,
        historyLength: 0,
      };

  const momentum = live ? signal.momentum : undefined;
  const catalyst = live ? signal.catalyst : undefined;
  const catalystIsLive = live && signal.catalystLive === true;
  const sec = live ? signal.secActivity : undefined;
  const pipeline = live ? signal.pipeline : undefined;
  const valuation = live ? signal.valuation : undefined;
  const risk = live ? signal.risk : undefined;

  const map: FeatureMap = {
    entry_reversal_readiness: feature(entry.readiness, at, "derived"),
    entry_deceleration: feature(entry.deceleration, at, "derived"),
    entry_basing: feature(entry.basing, at, "derived"),
    entry_falling_knife_veto: feature(entry.fallingKnife, at, "derived"),
    entry_fresh_shock: feature(entry.freshShock, at, "derived"),
    entry_catalyst_bypass: feature(entry.catalystBypass, at, "derived"),
    entry_drawdown_from_high: feature(entry.drawdown, at, "market_data"),
    entry_drawdown_vol_normalized: feature(entry.drawdownVolNorm, at, "derived"),
    staleness_runup_from_20d_low: feature(entry.runup20d, at, "market_data"),
    staleness_runup_vol_normalized: feature(entry.runupVolNorm, at, "derived"),
    quality_gross_margin: feature(live ? liveFundamental(signal, "grossMargin") : null, at, "provider", fundsAt),
    quality_net_margin: feature(live ? liveFundamental(signal, "netMargin") : null, at, "provider", fundsAt),
    quality_fcf_margin: feature(live ? liveFundamental(signal, "fcfMargin") : null, at, "provider", fundsAt),
    quality_revenue_growth_yoy: feature(
      live ? liveFundamental(signal, "revenueGrowthYoY") : null,
      at,
      "provider",
      fundsAt,
    ),
    quality_eps_growth_yoy: feature(live ? liveFundamental(signal, "epsGrowthYoY") : null, at, "provider", fundsAt),
    financing_debt_to_equity: feature(
      live ? liveFundamental(signal, "debtToEquity") : null,
      at,
      "provider",
      fundsAt,
    ),
    financing_dilution_risk: feature(finiteOrNull(risk?.dilutionRisk), at, "derived"),
    demand_backlog_growth_yoy: feature(finiteOrNull(pipeline?.backlogYoY), at, "filing"),
    demand_deferred_revenue_yoy: feature(finiteOrNull(pipeline?.deferredRevYoY), at, "filing"),
    demand_book_to_bill: feature(finiteOrNull(pipeline?.bookToBill), at, "filing"),
    valuation_pe_ttm: feature(live ? liveFundamental(signal, "peRatio") : null, at, "provider", fundsAt),
    valuation_pe_vs_own_5yr_pctile: feature(finiteOrNull(valuation?.peVsOwn5yrPctile), at, "derived"),
    momentum_rsi: feature(finiteOrNull(momentum?.rsi), at, "market_data"),
    momentum_return_1m: feature(finiteOrNull(momentum?.return1M), at, "market_data"),
    momentum_return_3m: feature(finiteOrNull(momentum?.return3M), at, "market_data"),
    momentum_relative_strength_3m: feature(finiteOrNull(momentum?.relativeStrength3M), at, "market_data"),
    catalyst_live: feature(live ? (catalystIsLive ? 1 : 0) : null, at, "derived"),
    // Catalyst details are meaningful only when the catalyst is LIVE (dated,
    // headline-backed). Modeled/sample catalysts must not leak into training.
    catalyst_magnitude: feature(catalystIsLive ? finiteOrNull(catalyst?.magnitude) : null, at, "derived"),
    catalyst_days_away: feature(catalystIsLive ? finiteOrNull(catalyst?.daysAway) : null, at, "derived"),
    // ONLY verified open-market Form 4 "P"-code aggregates. `form4Count90d`
    // (all codes - grants, options, awards) is deliberately NOT a feature.
    insider_open_market_buys_90d: feature(finiteOrNull(sec?.form4BuyCount90d), at, "filing"),
    insider_net_open_market_value_90d: feature(finiteOrNull(sec?.form4NetBuyValue90d), at, "filing"),
    evidence_price_history_length: feature(entry.historyLength, at, "derived"),
    evidence_feature_coverage: feature(0, at, "derived"), // filled below
  };

  // Coverage over every feature except itself, so a model can learn to
  // distrust thin evidence rather than treating null-imputation as signal.
  const names = LEARNING_FEATURE_NAMES.filter((n) => n !== "evidence_feature_coverage");
  const covered = names.filter((n) => map[n].value != null).length;
  map.evidence_feature_coverage = feature(covered / names.length, at, "derived");

  return Object.freeze(map);
}
