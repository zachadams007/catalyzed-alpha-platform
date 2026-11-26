import { describe, expect, it } from "vitest";

import { buildModelScores } from "@/engine/modelScores";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import {
  REVERSAL_V5_NORMALIZATION,
  computeNormalizedScores,
} from "@/engine/normalizeUniverse";
import type { ScoreCategoryKey, StockSignal } from "@/types";

const ALL_KEYS = CATEGORY_CONFIG.map((c) => c.key);

function sig(over: {
  ticker: string;
  opportunityScore: number;
  riskPenalty?: number;
  marketCap?: number;
  sector?: string;
  cats?: Partial<Record<ScoreCategoryKey, number>>;
}): StockSignal {
  const categories = ALL_KEYS.map((key) => ({
    key,
    label: key,
    score: over.cats?.[key] ?? 50,
    weight: CATEGORY_CONFIG.find((c) => c.key === key)!.weight,
    contribution: 0,
    explanation: "",
  }));
  return {
    ticker: over.ticker,
    name: over.ticker,
    sector: over.sector ?? "Technology",
    marketCap: over.marketCap ?? 1_000_000_000,
    score: {
      opportunityScore: over.opportunityScore,
      confidence: 70,
      confidenceExplanation: "",
      riskPenalty: over.riskPenalty ?? 0,
      riskExplanation: "",
      categories,
    },
  } as unknown as StockSignal;
}

const universe = () => [
  sig({ ticker: "A", opportunityScore: 70, cats: { catalyst: 80, news: 90 }, marketCap: 3e8 }),
  sig({ ticker: "B", opportunityScore: 55, cats: { catalyst: 40, news: 95 }, marketCap: 8e11 }),
  sig({ ticker: "C", opportunityScore: 60, cats: { momentum: 70 }, marketCap: 2e9 }),
  sig({ ticker: "D", opportunityScore: 45, cats: { valuation: 65 }, marketCap: 1e10 }),
];

describe("buildModelScores", () => {
  it("records both models keyed by ticker with 0..100 category snapshots", () => {
    const map = buildModelScores(universe(), "champion");
    expect(map.size).toBe(4);
    const a = map.get("A")!;
    expect(a.champion).toBeDefined();
    expect(a.challenger).toBeDefined();
    for (const key of ALL_KEYS) {
      const cv = a.challenger!.categoryScores[key]!;
      expect(cv).toBeGreaterThanOrEqual(0);
      expect(cv).toBeLessThanOrEqual(100);
    }
  });

  it("in a champion build, champion score is the live displayed score", () => {
    const map = buildModelScores(universe(), "champion");
    expect(map.get("A")!.champion!.opportunityScore).toBe(70);
    expect(map.get("B")!.champion!.opportunityScore).toBe(55);
    // Champion category snapshot is the raw per-category scores.
    expect(map.get("A")!.champion!.categoryScores.catalyst).toBe(80);
  });

  it("in a champion build, the challenger (V5 reversal-first) score is reconstructed from its profile", () => {
    // The live champion runs the INFLECTION-v2 (V4) profile, so the counterfactual
    // CHALLENGER ModelId is the V5 reversal-first candidate (V4 + momentum de-weight).
    const u = universe();
    const map = buildModelScores(u, "champion");
    const challenger = computeNormalizedScores(u, undefined, REVERSAL_V5_NORMALIZATION);
    for (const n of challenger) {
      expect(map.get(n.ticker)!.challenger!.opportunityScore).toBe(n.opportunityScore);
    }
  });

  it("in a challenger build, challenger score is the live score and champion is reconstructed", () => {
    // Simulate a curated-base (challenger) build: opportunityScore is the
    // challenger's, raw categories are preserved (so the catalyst-driven champion
    // can be reconstructed).
    const u = universe().map((s) => ({
      ...s,
      score: { ...s.score, opportunityScore: 99 }, // pretend the challenger wrote this
    }));
    const map = buildModelScores(u, "challenger");
    expect(map.get("A")!.challenger!.opportunityScore).toBe(99);
    // Champion is reconstructed from raw categories (the catalyst-driven profile),
    // independent of the overwritten live score.
    expect(map.get("A")!.champion!.opportunityScore).not.toBe(99);
    expect(map.get("A")!.champion!.opportunityScore).toBeGreaterThan(0);
  });
});
