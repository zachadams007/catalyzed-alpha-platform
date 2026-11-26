import type { StockSignal } from "@/types";
import type { RegimeContext } from "./capCurve";
import { clamp, mean, round } from "@/lib/math";

export const REGIME_SPY_SMA_DAYS = 200;
export const REGIME_SPY_CORRECTION_SMA_DAYS = 50;
export const REGIME_RISK_OFF_BUFFER = 0;
const FULL_RISK_OFF_DISTANCE = -0.15;
const CORRECTION_DISTANCE = -0.08;
const CORRECTION_LOOKBACK_DAYS = 21;
const CORRECTION_RETURN_TRIGGER = -0.05;
const CORRECTION_FULL_RETURN = -0.2;
const BREADTH_WEAK = 0.35;
const BREADTH_WASHOUT = 0.25;

function finitePositive(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v) && v > 0);
}

export function trailingMean(values: readonly number[], period: number): number | null {
  const cleaned = finitePositive(values);
  if (period <= 0 || cleaned.length < period) return null;
  return mean(cleaned.slice(-period));
}

export function breadthAboveSma50(signals: readonly StockSignal[]): number | undefined {
  let known = 0;
  let above = 0;
  for (const signal of signals) {
    const value = signal.momentum?.aboveSMA50;
    if (value == null) continue;
    known++;
    if (value) above++;
  }
  return known > 0 ? above / known : undefined;
}

// ---------------------------------------------------------------------------
// Fear & Greed (P9 redesign, owner request 2026-07-03)
//
// A 0-100 market-sentiment composite (0 = extreme fear, 100 = extreme greed),
// modeled on CNN's Fear & Greed construction but computed ONLY from data the scan
// already has - SPY trend, 21-day return, universe breadth, and realized-vol
// expansion - so the product never hard-depends on CNN's undocumented endpoint.
// The scan MAY pass a live CNN reading as an override (fearGreedSource "cnn");
// when it can't, this internal composite ("internal") is the value. Pure and
// deterministic either way.
//
// What it drives: the PANIC-OPPORTUNITY mode (see capCurve PANIC_QUALITY_WEIGHTS and
// normalizeUniverse) and the feed-tab banner.
// ---------------------------------------------------------------------------

export type FearGreedLabel =
  | "extreme-fear"
  | "fear"
  | "neutral"
  | "greed"
  | "extreme-greed";

export function fearGreedLabelFor(value: number): FearGreedLabel {
  if (value < 25) return "extreme-fear";
  if (value < 45) return "fear";
  if (value <= 55) return "neutral";
  if (value <= 75) return "greed";
  return "extreme-greed";
}

/** Map `value` across [lo, hi] → [0, 100] (clamped, works with lo > hi inverted). */
function leg(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi === lo) return 50;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}

/**
 * Internal fear/greed composite from SPY closes + universe breadth. Averages only
 * the legs that have data; no inputs at all → neutral 50.
 */
export function computeFearGreed(
  spyCloses: readonly number[],
  breadthPct?: number,
): number {
  const closes = finitePositive(spyCloses);
  const legs: number[] = [];
  const last = closes[closes.length - 1];

  // 1) Trend: SPY vs its 125-day mean (CNN's "market momentum" leg).
  const sma125 = trailingMean(closes, 125);
  if (last != null && sma125 != null && sma125 > 0) {
    legs.push(leg(last / sma125 - 1, -0.1, 0.1));
  }
  // 2) 21-day return (drawdown/rip speed).
  const lookback = closes[closes.length - 22];
  if (last != null && lookback != null && lookback > 0) {
    legs.push(leg(last / lookback - 1, -0.12, 0.08));
  }
  // 3) Breadth: share of the universe above its own 50-DMA.
  if (breadthPct != null && Number.isFinite(breadthPct)) {
    legs.push(leg(breadthPct, 0.2, 0.8));
  }
  // 4) Volatility expansion: 20d realized vol vs 60d (rising vol = fear). Inverted.
  if (closes.length >= 61) {
    const rets: number[] = [];
    for (let i = closes.length - 60; i < closes.length; i++) {
      const prev = closes[i - 1]!;
      rets.push(prev > 0 ? closes[i]! / prev - 1 : 0);
    }
    const vol60 = stdevLocal(rets);
    const vol20 = stdevLocal(rets.slice(-20));
    if (vol60 > 0) legs.push(leg(vol20 / vol60, 1.6, 0.7));
  }

  if (legs.length === 0) return 50;
  return round(mean(legs));
}

/** Population stdev without importing more of math.ts surface here. */
function stdevLocal(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

export function computeMarketRegime(
  spyCloses: readonly number[],
  breadthPct?: number,
  /** Live external Fear & Greed reading (e.g. CNN, 0-100) - overrides the internal
   *  composite when finite; the internal value remains the always-available fallback. */
  externalFearGreed?: number | null,
): RegimeContext {
  const closes = finitePositive(spyCloses);
  const spySma200 = trailingMean(closes, REGIME_SPY_SMA_DAYS);
  const spySma50 = trailingMean(closes, REGIME_SPY_CORRECTION_SMA_DAYS);
  const spyClose = closes[closes.length - 1];

  const internalFearGreed = computeFearGreed(spyCloses, breadthPct);
  const hasExternal =
    externalFearGreed != null && Number.isFinite(externalFearGreed);
  const fearGreed = hasExternal
    ? round(clamp(externalFearGreed!, 0, 100))
    : internalFearGreed;
  const fearGreedSource = hasExternal ? ("cnn" as const) : ("internal" as const);
  const fearGreedLabel = fearGreedLabelFor(fearGreed);

  if (spyClose == null || spySma200 == null || spySma200 <= 0) {
    return {
      riskOffness: 0,
      label: "neutral",
      breadthAboveSma50Pct: breadthPct,
      fearGreed,
      fearGreedLabel,
      fearGreedSource,
      reason: "Regime neutral: insufficient SPY history for a 200-DMA read.",
    };
  }

  const distance = spyClose / spySma200 - 1;
  const longTrend =
    distance < REGIME_RISK_OFF_BUFFER
      ? 0.35 +
        0.65 *
          clamp(
            (REGIME_RISK_OFF_BUFFER - distance) /
              (REGIME_RISK_OFF_BUFFER - FULL_RISK_OFF_DISTANCE),
            0,
            1,
          )
      : 0;
  const shortDistance = spySma50 && spySma50 > 0 ? spyClose / spySma50 - 1 : 0;
  const shortCorrection =
    spySma50 && shortDistance < 0
      ? 0.2 + 0.3 * clamp((0 - shortDistance) / (0 - CORRECTION_DISTANCE), 0, 1)
      : 0;
  const lookbackClose = closes[closes.length - 1 - CORRECTION_LOOKBACK_DAYS];
  const spyReturn21d = lookbackClose && lookbackClose > 0 ? spyClose / lookbackClose - 1 : 0;
  const drawdownCorrection =
    spyReturn21d <= CORRECTION_RETURN_TRIGGER
      ? 0.2 +
        0.35 *
          clamp(
            (CORRECTION_RETURN_TRIGGER - spyReturn21d) /
              (CORRECTION_RETURN_TRIGGER - CORRECTION_FULL_RETURN),
            0,
            1,
          )
      : 0;
  const primary = Math.max(longTrend, shortCorrection, drawdownCorrection);

  const breadthBoost =
    breadthPct == null
      ? 0
      : breadthPct <= BREADTH_WASHOUT
        ? 0.2
        : breadthPct <= BREADTH_WEAK
          ? 0.1
          : 0;

  const riskOffness = round(clamp(primary + breadthBoost, 0, 1), 3);
  const label =
    riskOffness >= 0.55 ? "risk-off" : riskOffness > 0 ? "neutral" : "risk-on";
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const breadthText = breadthPct == null ? "" : `; breadth above 50-DMA ${pct(breadthPct)}`;
  const correctionText =
    shortCorrection > 0 || drawdownCorrection > 0
      ? `; correction pressure: SPY is ${pct(shortDistance)} vs 50-DMA and ${pct(spyReturn21d)} over 21 trading days`
      : "";

  return {
    riskOffness,
    label,
    fearGreed,
    fearGreedLabel,
    fearGreedSource,
    spyClose: round(spyClose, 2),
    spySma200: round(spySma200, 2),
    spySma50: spySma50 == null ? undefined : round(spySma50, 2),
    spyDistanceToSma200: round(distance, 4),
    spyDistanceToSma50: spySma50 == null ? undefined : round(shortDistance, 4),
    spyReturn21d: round(spyReturn21d, 4),
    breadthAboveSma50Pct: breadthPct,
    reason:
      riskOffness > 0
        ? `Regime ${label}: SPY is ${pct(distance)} vs its 200-DMA${correctionText}${breadthText}.`
        : `Regime risk-on: SPY is ${pct(distance)} vs its 200-DMA${breadthText}.`,
  };
}

export function buildMarketRegimeContext(args: {
  spyCloses: readonly number[];
  signals?: readonly StockSignal[];
  /** Live external Fear & Greed reading (0-100), when the caller fetched one. */
  externalFearGreed?: number | null;
}): RegimeContext {
  return computeMarketRegime(
    args.spyCloses,
    args.signals ? breadthAboveSma50(args.signals) : undefined,
    args.externalFearGreed,
  );
}
