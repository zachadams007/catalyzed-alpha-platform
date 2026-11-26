import { describe, it, expect } from "vitest";

import { researchRankScore } from "@/engine/ranking";
import type { StockSignal } from "@/types";

type RankingFixture = Pick<StockSignal, "id" | "confidence" | "score">;

function makeSignal(
  id: string,
  opportunityScore: number,
  confidence = 70,
  riskPenalty = 0,
): StockSignal {
  const fixture: RankingFixture = {
    id,
    confidence,
    score: {
      opportunityScore,
      confidence,
      confidenceExplanation: "Test fixture",
      riskPenalty,
      riskExplanation: "Test fixture",
      categories: [],
    },
  };

  return fixture as StockSignal;
}

function rank(signals: StockSignal[]): StockSignal[] {
  return [...signals].sort((a, b) => researchRankScore(b) - researchRankScore(a));
}

describe("researchRankScore ordering", () => {
  it("ranks higher opportunity scores first when confidence and risk are equal", () => {
    const signals = [
      makeSignal("middle", 70),
      makeSignal("lowest", 60),
      makeSignal("highest", 80),
    ];

    expect(rank(signals).map((signal) => signal.id)).toEqual([
      "highest",
      "middle",
      "lowest",
    ]);
  });

  it("uses confidence and risk penalty to order equal opportunity scores", () => {
    const signals = [
      makeSignal("higher-risk", 75, 70, 8),
      makeSignal("higher-confidence", 75, 85, 0),
      makeSignal("baseline", 75, 70, 0),
    ];

    expect(rank(signals).map((signal) => signal.id)).toEqual([
      "higher-confidence",
      "baseline",
      "higher-risk",
    ]);
  });

  it("returns the same ordering across repeated rankings", () => {
    const signals = [
      makeSignal("third", 65, 75, 2),
      makeSignal("first", 82, 80, 1),
      makeSignal("second", 74, 72, 0),
    ];
    const expected = ["first", "second", "third"];

    for (let run = 0; run < 5; run += 1) {
      expect(rank(signals).map((signal) => signal.id)).toEqual(expected);
    }
  });

  it("preserves input order when signals have equal ranking scores", () => {
    const signals = [
      makeSignal("first-tied", 75, 80, 4),
      makeSignal("second-tied", 75, 80, 4),
      makeSignal("lower", 70, 70, 0),
    ];

    expect(rank(signals).map((signal) => signal.id)).toEqual([
      "first-tied",
      "second-tied",
      "lower",
    ]);
  });
});
