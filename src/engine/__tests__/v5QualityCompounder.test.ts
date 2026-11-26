import { describe, expect, it } from "vitest";

import { computeNormalizedScores, INFLECTION_V2_NORMALIZATION, REVERSAL_V5_NORMALIZATION } from "@/engine/normalizeUniverse";
import type { ScoreCategoryKey, StockSignal } from "@/types";

const keys: ScoreCategoryKey[] = [
  "inflection",
  "conviction",
  "catalyst",
  "sentimentShift",
  "pipeline",
  "momentum",
  "valuation",
  "news",
  "social",
  "volatility",
  "growth",
  "fundamentals",
  "liquidity",
];

function signal(
  ticker: string,
  sector: string,
  marketCap: number,
  scores: Partial<Record<ScoreCategoryKey, number>>,
): StockSignal {
  return {
    ticker,
    name: ticker,
    sector,
    marketCap,
    price: 100,
    dayChange: 0,
    liquidity: { avgDollarVolume: 1_000_000_000 },
    momentum: { rsi: 44, aboveSMA50: false, aboveSMA200: true },
    risk: { shortInterestPct: 0 },
    score: {
      opportunityScore: 50,
      confidence: scores.conviction ?? 60,
      confidenceExplanation: "test",
      riskPenalty: 1,
      riskExplanation: "test",
      categories: keys.map((key) => ({
        key,
        label: key,
        score: scores[key] ?? 50,
        weight: 1 / keys.length,
        contribution: 0,
        explanation: "test",
      })),
    },
  } as unknown as StockSignal;
}

describe("V5 discounted quality compounder lift", () => {
  it("raises a Microsoft-style mega-cap compounder without handing the same lift to a Materials miner", () => {
    const msft = signal("MSFT", "Technology", 2_800_000_000_000, {
      fundamentals: 83,
      valuation: 66,
      conviction: 70,
      growth: 46,
      momentum: 32,
      catalyst: 0,
    });
    const aem = signal("AEM", "Materials", 108_000_000_000, {
      fundamentals: 88,
      valuation: 78,
      conviction: 50,
      growth: 71,
      momentum: 10,
      catalyst: 0,
    });
    const neutral = signal("IBM", "Technology", 230_000_000_000, {
      fundamentals: 70,
      valuation: 54,
      conviction: 60,
      growth: 42,
    });

    const v4 = computeNormalizedScores([msft, aem, neutral], undefined, INFLECTION_V2_NORMALIZATION);
    const v5 = computeNormalizedScores([msft, aem, neutral], undefined, REVERSAL_V5_NORMALIZATION);
    const byTicker = (rows: typeof v5, ticker: string) => rows.find((row) => row.ticker === ticker)!;

    expect(byTicker(v5, "MSFT").opportunityScore).toBeGreaterThan(byTicker(v4, "MSFT").opportunityScore);
    // The lift must be REAL, but its size was re-calibrated on 2026-07-26 when the
    // tilt was rebalanced from quality-led (0.46 quality / 0.34 discount) to
    // discount-led (0.5 discount / 0.3 quality). The old weighting made this a pure
    // quality reward, which put Nvidia - ~16% off its high - at #1 on the live board
    // purely for being excellent. This fixture's MSFT is only modestly discounted
    // (valuation 66), so it now earns a correspondingly smaller lift. What the test
    // protects is unchanged: a discounted quality compounder gains, and a
    // commodity/regulated cyclical does not inherit that gain.
    expect(byTicker(v5, "MSFT").opportunityScore - byTicker(v4, "MSFT").opportunityScore).toBeGreaterThanOrEqual(1);
    expect(byTicker(v5, "AEM").opportunityScore).toBeLessThanOrEqual(88);
  });
});
