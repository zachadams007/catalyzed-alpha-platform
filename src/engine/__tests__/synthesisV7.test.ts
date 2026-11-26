import { describe, expect, it } from "vitest";

import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import {
  computeNormalizedScores,
  MISUNDERSTOOD_V6_NORMALIZATION,
  SYNTHESIS_V7_NORMALIZATION,
  V7_ATTENTION_TILT_MAX,
  V7_OWN_HISTORY_TILT_MAX,
} from "@/engine/normalizeUniverse";
import { NORMALIZATION_FOR_VARIANT } from "@/engine/challenger";
import { seedModelRegistry, V7_SYNTHESIS_ID } from "@/engine/modelRegistry";
import type { CompanyData } from "@/types";

/**
 * V7 SYNTHESIS - pins the three decisions the 2026-09-16 backtest of every
 * July-2026 version actually supports, so a future "improvement" cannot quietly
 * re-introduce the rejected ones.
 *
 * The evidence (equal-weight top-10 vs SPY): the absolute-P/E penalty at full
 * strength demoted a high-multiple compounder (Palantir) and was rejected. The
 * version that introduced the asymmetry tilt was kept. Own-history was kept at a
 * modest weight and rejected as the
 * loudest voice. [Figures removed from the public copy.] See docs/scoring-framework.md, "V7".
 */

function drawdown(): number[] {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i * 2.5);
  const down = Array.from({ length: 180 }, (_, i) => 297.5 - i * 0.65); // → ~180, ~40% off
  return [...up, ...down];
}

/** A Palantir-shaped name: superb growth and margins, deep drawdown, very high P/E. */
function makeHighMultipleCompounder(over: Partial<CompanyData> = {}): CompanyData {
  const priceHistory = drawdown();
  return {
    ticker: "PLTRISH",
    name: "High Multiple Co",
    sector: "Technology",
    price: priceHistory[priceHistory.length - 1]!,
    dayChange: 0,
    marketCap: 300e9,
    priceHistory,
    priceSeries: priceHistory.map((close, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      close,
    })),
    fundamentals: {
      revenueGrowthYoY: 0.56,
      epsGrowthYoY: 0.9,
      grossMargin: 0.8,
      netMargin: 0.36,
      peRatio: 130,
      pegRatio: 2.4,
      debtToEquity: 0.0,
      fcfMargin: 0.3,
    },
    momentum: {
      return1M: 0.08,
      return3M: -0.12,
      return6M: -0.3,
      rsi: 41,
      aboveSMA50: false,
      aboveSMA200: false,
      relativeStrength3M: -0.15,
    },
    catalyst: { type: "None", description: "", daysAway: 365, magnitude: 0 },
    news: { items: [], sentiment: 0.1, count7d: 8, freshnessHours: 6 },
    social: { redditMentions24h: 0, xMentions24h: 0, politicalMentions: 0, sentiment: 0, trendDelta: 0, summary: "" },
    socialPosts: [],
    volatility: { beta: 1.4, atrPct: 0.05, impliedVol: 0 },
    liquidity: { avgDollarVolume: 3e9, floatShares: 2e9 },
    risk: { shortInterestPct: 0.03, dilutionRisk: 0.05, cashRunwayQuarters: 20, governanceFlag: 0 },
    sources: [],
    pipeline: { backlogToRevTTM: 1.0, backlogYoY: 1.37, deferredRevYoY: 0.58 },
    ...over,
  };
}

const asSignal = (c: CompanyData) => toStockSignal(c, scoreCompany(c), "2026-09-17T00:00:00.000Z");

describe("V7 synthesis profile", () => {
  it("is what the 'v7' variant runs", () => {
    expect(NORMALIZATION_FOR_VARIANT.v7).toBe(SYNTHESIS_V7_NORMALIZATION);
  });

  it("removes the absolute-P/E penalty outright and re-sizes own-history and attention", () => {
    expect(SYNTHESIS_V7_NORMALIZATION.absoluteMultipleTiltMax).toBe(0);
    expect(SYNTHESIS_V7_NORMALIZATION.ownHistoryTiltMax).toBe(V7_OWN_HISTORY_TILT_MAX);
    expect(SYNTHESIS_V7_NORMALIZATION.attentionTiltMax).toBe(V7_ATTENTION_TILT_MAX);
    expect(V7_OWN_HISTORY_TILT_MAX).toBeLessThan(MISUNDERSTOOD_V6_NORMALIZATION.ownHistoryTiltMax!);
    expect(V7_ATTENTION_TILT_MAX).toBeLessThan(MISUNDERSTOOD_V6_NORMALIZATION.attentionTiltMax!);
  });

  it("keeps every other V6 mechanism (asymmetry, T4, compounder) at the same strength", () => {
    expect(SYNTHESIS_V7_NORMALIZATION.asymmetryTiltMax).toBe(MISUNDERSTOOD_V6_NORMALIZATION.asymmetryTiltMax);
    expect(SYNTHESIS_V7_NORMALIZATION.misunderstoodTiltMax).toBe(MISUNDERSTOOD_V6_NORMALIZATION.misunderstoodTiltMax);
    expect(SYNTHESIS_V7_NORMALIZATION.qualityCompounderTiltMax).toBe(
      MISUNDERSTOOD_V6_NORMALIZATION.qualityCompounderTiltMax,
    );
  });

  it("no longer charges a high-multiple compounder for its P/E on top of PEG (the Palantir lesson)", () => {
    const universe = [
      asSignal(makeHighMultipleCompounder()),
      asSignal(makeHighMultipleCompounder({ ticker: "PEER1", marketCap: 120e9, pipeline: undefined })),
      asSignal(makeHighMultipleCompounder({ ticker: "PEER2", marketCap: 60e9, pipeline: undefined })),
    ];
    const v6 = computeNormalizedScores(universe, undefined, { ...MISUNDERSTOOD_V6_NORMALIZATION, decompressDisplay: false });
    const v7 = computeNormalizedScores(universe, undefined, { ...SYNTHESIS_V7_NORMALIZATION, decompressDisplay: false });
    const v6Row = v6.find((r) => r.ticker === "PLTRISH")!;
    const v7Row = v7.find((r) => r.ticker === "PLTRISH")!;
    expect(v6Row.absoluteMultipleTilt).toBeLessThan(0);
    expect(v7Row.absoluteMultipleTilt).toBe(0);
    expect(v7Row.opportunityScore).toBeGreaterThan(v6Row.opportunityScore);
  });

  it("is registered as a candidate, not promoted", () => {
    const reg = seedModelRegistry();
    const v7 = reg.entries.find((e) => e.id === V7_SYNTHESIS_ID);
    expect(v7).toBeDefined();
    expect(v7!.kind).toBe("v7");
    expect(reg.championId).not.toBe(V7_SYNTHESIS_ID);
  });
});
