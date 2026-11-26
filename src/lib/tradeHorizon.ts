import type { StockSignal, TradeHorizon } from "@/types";

const HORIZONS: TradeHorizon[] = ["scalping", "day_trading", "swing_trading", "position_trading"];

export function isTradeHorizon(value: string): value is TradeHorizon {
  return (HORIZONS as string[]).includes(value);
}

/** Map legacy persisted values after rename. */
export function normalizeTradeHorizon(value: string | undefined): TradeHorizon {
  switch (value) {
    case "day_trade":
      return "day_trading";
    case "swing":
      return "swing_trading";
    case "long_term":
      return "position_trading";
    default:
      return isTradeHorizon(value ?? "") ? (value as TradeHorizon) : "swing_trading";
  }
}

/** Nudge a horizon one step shorter or longer along the standard ladder. */
export function shiftHorizon(h: TradeHorizon, dir: "shorter" | "longer"): TradeHorizon {
  const i = HORIZONS.indexOf(normalizeTradeHorizon(h));
  const step = dir === "shorter" ? -1 : 1;
  const clamped = Math.max(0, Math.min(HORIZONS.length - 1, i + step));
  return HORIZONS[clamped];
}

export interface LikelyHorizon {
  horizon: TradeHorizon;
  /** Short plain-English reason this time scale fits. */
  why: string;
}

function categoryScore(signal: StockSignal, key: string): number {
  return signal.score.categories.find((cat) => cat.key === key)?.score ?? 50;
}

/**
 * A per-signal guess at what time scale the reason-to-watch plays out on.
 * It is derived from catalyst timing, headline freshness, liquidity, volatility,
 * and quality scores, not the user's global preference. Research-only.
 */
export function likelyHorizon(signal: StockSignal): LikelyHorizon {
  const { catalystType, catalyst, news } = signal;
  const mentions = signal.social.redditMentions24h + signal.social.xMentions24h;
  const fresh = news.freshnessHours <= 12;
  const veryFresh = news.freshnessHours <= 4;
  const liquid = signal.liquidity.avgDollarVolume >= 25_000_000;
  const veryLiquid = signal.liquidity.avgDollarVolume >= 150_000_000;
  const tradableVol = signal.volatility.atrPct >= 0.03 && signal.volatility.atrPct <= 0.12;
  const attentionBurst = news.count7d >= 8 || (mentions >= 500 && signal.social.trendDelta >= 0.6);
  const qualityScore =
    (categoryScore(signal, "fundamentals") +
      categoryScore(signal, "growth") +
      categoryScore(signal, "liquidity")) /
    3;

  if (veryFresh && veryLiquid && tradableVol && catalystType === "Technical" && attentionBurst) {
    return { horizon: "scalping", why: "Ultra-fresh technical attention with high liquidity" };
  }

  if (
    fresh &&
    liquid &&
    tradableVol &&
    attentionBurst &&
    (catalyst.daysAway <= 2 || catalystType === "Political" || catalystType === "Macro")
  ) {
    return { horizon: "day_trading", why: "Fresh catalyst flow, liquid and fast-moving" };
  }

  if (qualityScore >= 70 && (catalyst.daysAway > 30 || news.count7d < 8)) {
    return {
      horizon: "position_trading",
      why: "Quality and liquidity lead more than headline timing",
    };
  }

  if (catalyst.daysAway > 60) {
    return {
      horizon: "position_trading",
      why: `Catalyst ~${Math.round(catalyst.daysAway)}d out - longer research window`,
    };
  }

  switch (catalystType) {
    case "Technical":
      return liquid && tradableVol
        ? { horizon: "day_trading", why: "Technical setup with enough liquidity" }
        : { horizon: "swing_trading", why: "Technical setup needs confirmation" };
    case "Political":
    case "Macro":
      return fresh && liquid
        ? { horizon: "day_trading", why: `${catalystType} headline-driven` }
        : { horizon: "swing_trading", why: `${catalystType} effects may unfold over days` };
    case "Earnings":
      return { horizon: "swing_trading", why: "Earnings catalyst - days/weeks setup" };
    case "Product":
    case "Partnership":
    case "M&A":
      return { horizon: "swing_trading", why: `${catalystType} event - plays out over days/weeks` };
    case "Regulatory":
    case "Clinical":
    case "Insider":
    case "Institutional":
      return { horizon: "position_trading", why: `${catalystType} timeline - longer research window` };
    default:
      return { horizon: "swing_trading", why: "Balanced setup" };
  }
}

export const SCALPING_DISCLAIMER =
  "Scalping needs sub-second quotes, depth of book, and execution tools Catalyzed Alpha does not provide. This horizon only biases scores toward volatile, liquid names for research - not live scalp setups.";
