import { describe, expect, it } from "vitest";

import { deriveWhyTags } from "@/components/signal/WhyTags";
import type { ScoreCategoryKey, StockSignal, WhyTagKind } from "@/types";

function makeSignal(over: {
  cats?: Partial<Record<ScoreCategoryKey, number>>;
  inflection?: StockSignal["inflection"];
  pipeline?: StockSignal["pipeline"];
}): StockSignal {
  const categories = ([
    "inflection", "catalyst", "sentimentShift", "pipeline", "momentum", "valuation",
    "news", "social", "volatility", "growth", "fundamentals", "liquidity",
  ] as ScoreCategoryKey[]).map((key) => ({
    key,
    label: key,
    score: over.cats?.[key] ?? 50,
    weight: 0,
    contribution: 0,
    explanation: "",
  }));
  return {
    ticker: "T",
    name: "T",
    marketCap: 1.2e9,
    marketCapBucket: "Small",
    hype: { tier: "Warming", score: 40, tldr: "", drivers: [] },
    catalyst: { type: "Product", description: "", daysAway: 40, magnitude: 0.3 },
    catalystLive: false,
    fundamentals: { revenueGrowthYoY: 0.1, epsGrowthYoY: 0, grossMargin: 0.4, netMargin: 0, peRatio: null, pegRatio: null, debtToEquity: 0.5, fcfMargin: 0 },
    news: { items: [], sentiment: 0, count7d: 6, freshnessHours: 50 },
    inflection: over.inflection,
    pipeline: over.pipeline,
    score: { opportunityScore: 62, confidence: 60, confidenceExplanation: "", riskPenalty: 0, riskExplanation: "", categories },
  } as unknown as StockSignal;
}

const kinds = (s: StockSignal): WhyTagKind[] => deriveWhyTags(s).map((t) => t.kind);

describe("WhyTags v2 leading-signal chips — cold-start safe", () => {
  it("emits NO v2 chips when the v2 inputs are absent (cold start)", () => {
    const k = kinds(makeSignal({ cats: { inflection: 50, pipeline: 50, sentimentShift: 50 } }));
    expect(k).not.toContain("reaccelerating");
    expect(k).not.toContain("backlog_building");
    expect(k).not.toContain("sentiment_turning");
  });

  it("emits a reaccelerating chip on real inflection data + a strong inflection score", () => {
    const k = kinds(
      makeSignal({ cats: { inflection: 72 }, inflection: { revAccelQoQ: 0.06, grossMarginDeltaYoY: 0.04 } }),
    );
    expect(k).toContain("reaccelerating");
  });

  it("emits a backlog_building chip on a real book-to-bill + a strong pipeline score", () => {
    const k = kinds(makeSignal({ cats: { pipeline: 70 }, pipeline: { bookToBill: 1.5 } }));
    expect(k).toContain("backlog_building");
  });

  it("does NOT emit a pipeline chip when the score is weak even if data exists", () => {
    const k = kinds(makeSignal({ cats: { pipeline: 50 }, pipeline: { bookToBill: 1.5 } }));
    expect(k).not.toContain("backlog_building");
  });
});
