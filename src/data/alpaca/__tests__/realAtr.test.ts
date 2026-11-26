import { describe, expect, it } from "vitest";

import { applyAlpacaBarsToCompany, type DailyBars } from "@/data/alpaca/bars";
import type { CompanyData } from "@/types";

function baseCompany(): CompanyData {
  return {
    ticker: "T",
    name: "T",
    sector: "Technology",
    price: 100,
    dayChange: 0,
    marketCap: 1e9,
    priceHistory: [],
    priceSeries: [],
    fundamentals: {
      revenueGrowthYoY: 0,
      epsGrowthYoY: 0,
      grossMargin: 0.3,
      netMargin: 0,
      peRatio: null,
      pegRatio: null,
      debtToEquity: 0.5,
      fcfMargin: 0,
    },
    momentum: {
      return1M: 0,
      return3M: 0,
      return6M: 0,
      rsi: 50,
      aboveSMA50: false,
      aboveSMA200: false,
      relativeStrength3M: 0,
    },
    catalyst: { type: "Product", description: "", daysAway: 30, magnitude: 0.3 },
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 100 },
    social: { redditMentions24h: 0, xMentions24h: 0, politicalMentions: 0, sentiment: 0, trendDelta: 0, summary: "" },
    socialPosts: [],
    volatility: { beta: 1, atrPct: 0.99, impliedVol: 0.5 }, // synthetic seed we expect to be replaced
    liquidity: { avgDollarVolume: 1e7, floatShares: 1e8 },
    risk: { shortInterestPct: 0, dilutionRisk: 0, cashRunwayQuarters: 8, governanceFlag: 0 },
    sources: [],
  };
}

/** A 40-day series where each bar has a true range of ~2% of price. */
function bars(): DailyBars {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const series = [];
  let px = 100;
  for (let i = 0; i < 40; i++) {
    px = px * (1 + (i % 2 === 0 ? 0.001 : -0.001)); // gentle drift
    const high = px * 1.01;
    const low = px * 0.99; // intraday range ≈ 2% of price
    closes.push(Number(px.toFixed(2)));
    highs.push(Number(high.toFixed(2)));
    lows.push(Number(low.toFixed(2)));
    series.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, close: Number(px.toFixed(2)) });
  }
  return { series, closes, highs, lows };
}

describe("real Wilder ATR(14)", () => {
  it("replaces the synthetic atrPct with a real value from OHLC (~2% here)", () => {
    const out = applyAlpacaBarsToCompany(baseCompany(), bars());
    expect(out.volatility.atrPct).not.toBe(0.99); // synthetic seed replaced
    expect(out.volatility.atrPct).toBeGreaterThan(0.01);
    expect(out.volatility.atrPct).toBeLessThan(0.04);
  });

  it("keeps the prior atrPct when high/low are unavailable (never fabricates)", () => {
    const b = bars();
    const noHl: DailyBars = { series: b.series, closes: b.closes };
    const out = applyAlpacaBarsToCompany(baseCompany(), noHl);
    expect(out.volatility.atrPct).toBe(0.99); // unchanged - no OHLC to compute from
  });
});
