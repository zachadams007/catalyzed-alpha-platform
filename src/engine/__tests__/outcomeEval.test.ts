import { describe, expect, it } from "vitest";

import {
  compareModels,
  computeRankIC,
  PROMOTION_MIN_COHORTS,
  spearman,
} from "@/engine/outcomeEval";
import type { ModelId, OutcomeEntry, OutcomeLedger } from "@/engine/outcomeLedger";

function ledgerOf(entries: OutcomeEntry[]): OutcomeLedger {
  return { schemaVersion: 2, droppedCount: 0, entries };
}

function dayISO(i: number): string {
  return new Date(Date.UTC(2026, 0, 1 + i, 16)).toISOString();
}

/** One pick with both models' opportunity scores + a realized d30 return. */
function entry(
  ticker: string,
  publishedAtISO: string,
  scores: { champion: number; challenger?: number },
  d30: number,
): OutcomeEntry {
  const modelScores: OutcomeEntry["modelScores"] = {
    champion: { opportunityScore: scores.champion, categoryScores: { momentum: scores.champion } },
  };
  if (scores.challenger != null) {
    modelScores.challenger = {
      opportunityScore: scores.challenger,
      categoryScores: { momentum: scores.challenger },
    };
  }
  return {
    ticker,
    name: ticker,
    publishedAtISO,
    opportunityScore: scores.champion,
    confidence: 70,
    categoryScores: { momentum: scores.champion },
    modelScores,
    priceAtPublish: 100,
    forwardReturns: { d30 },
  };
}

describe("spearman", () => {
  it("is +1 for a perfectly monotone relationship", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
  });
  it("is −1 for a perfectly inverse relationship", () => {
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 9);
  });
  it("handles ties via midranks", () => {
    // Two tied x's; still a strong positive monotone trend.
    expect(spearman([1, 1, 2, 3], [5, 6, 7, 8])!).toBeGreaterThan(0.7);
  });
  it("returns null for degenerate input (no spread / too short)", () => {
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([5], [5])).toBeNull();
  });
});

describe("computeRankIC", () => {
  it("reports a strong positive IC when higher scores earned higher returns", () => {
    const day = dayISO(0);
    const entries = Array.from({ length: 6 }, (_, j) =>
      entry(`T${j}`, day, { champion: j * 10 }, j / 100),
    );
    const result = computeRankIC(ledgerOf(entries), "d30", "champion");
    expect(result.overall.meanIC).toBeCloseTo(1, 6);
    expect(result.overall.cohorts).toBe(1);
    expect(result.overall.n).toBe(6);
    // Per-category IC is reported for every dimension.
    expect(Object.keys(result.perCategory).length).toBeGreaterThanOrEqual(9);
  });

  it("ignores cohorts below the minimum name count", () => {
    const entries = Array.from({ length: 4 }, (_, j) =>
      entry(`T${j}`, dayISO(0), { champion: j }, j / 100),
    );
    expect(computeRankIC(ledgerOf(entries), "d30", "champion").overall.cohorts).toBe(0);
  });

  it("produces no challenger cohorts when entries lack challenger scores", () => {
    const day = dayISO(0);
    const entries = Array.from({ length: 6 }, (_, j) =>
      entry(`T${j}`, day, { champion: j }, j / 100),
    );
    // No challenger model recorded → nothing to correlate.
    expect(computeRankIC(ledgerOf(entries), "d30", "challenger").overall.cohorts).toBe(0);
  });
});

/** Build N daily cohorts: challenger tracks returns, champion runs inverse. */
function buildComparisonLedger(cohorts: number): OutcomeLedger {
  const entries: OutcomeEntry[] = [];
  for (let i = 0; i < cohorts; i++) {
    const day = dayISO(i);
    // returns ascending by j; occasionally swap the top pair so per-cohort IC
    // varies (non-zero variance → a real t-stat).
    const swap = i % 3 === 0;
    for (let j = 0; j < 6; j++) {
      const ret = j / 100;
      const challenger = swap && j >= 4 ? (j === 4 ? 5 : 4) : j; // tracks return (IC≈1)
      const champion = 5 - j; // inverse of return (IC≈−1)
      entries.push(entry(`D${i}T${j}`, day, { champion, challenger }, ret));
    }
  }
  return ledgerOf(entries);
}

describe("compareModels — promotion rule", () => {
  it("does NOT promote on too few cohorts even when the challenger leads", () => {
    const cmp = compareModels(buildComparisonLedger(10), "d30");
    expect(cmp.deltaIC).toBeGreaterThan(0);
    expect(cmp.cohorts).toBe(10);
    expect(cmp.promote).toBe(false);
    expect(cmp.rationale).toMatch(/cohorts/i);
  });

  it("promotes when the challenger leads significantly over enough cohorts", () => {
    const cmp = compareModels(buildComparisonLedger(PROMOTION_MIN_COHORTS + 5), "d30");
    expect(cmp.deltaIC).toBeGreaterThan(0);
    expect(cmp.cohorts).toBeGreaterThanOrEqual(PROMOTION_MIN_COHORTS);
    expect(cmp.deltaTStat).toBeGreaterThanOrEqual(2);
    expect(cmp.winRate).toBe(1);
    expect(cmp.promote).toBe(true);
    expect(cmp.rationale).toMatch(/clears the promotion bar/i);
  });

  it("never promotes when the challenger is behind", () => {
    // Flip the roles by relabeling: reuse the builder then read the worse side.
    const entries: OutcomeEntry[] = [];
    for (let i = 0; i < PROMOTION_MIN_COHORTS + 5; i++) {
      const day = dayISO(i);
      for (let j = 0; j < 6; j++) {
        // champion tracks return, challenger inverse → challenger should lose.
        entries.push(entry(`D${i}T${j}`, day, { champion: j, challenger: 5 - j }, j / 100));
      }
    }
    const cmp = compareModels(ledgerOf(entries), "d30");
    expect(cmp.deltaIC).toBeLessThan(0);
    expect(cmp.promote).toBe(false);
  });

  it("is honest when there are no paired cohorts", () => {
    const cmp = compareModels(ledgerOf([]), "d30");
    expect(cmp.cohorts).toBe(0);
    expect(cmp.promote).toBe(false);
    expect(cmp.rationale).toMatch(/no paired cohorts/i);
  });
});
