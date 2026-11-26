import { describe, expect, it } from "vitest";

import { evaluateLearningPredictions } from "@/engine/learningEvaluation";

describe("evaluateLearningPredictions", () => {
  it("reports calibration, expectancy, concentration, and rank stability without a profitability claim", () => {
    const result = evaluateLearningPredictions(
      [
        { rowId: "a", decisionAtISO: "2026-01-02T16:00:00Z", ticker: "A", sector: "Energy", capCohort: "large", baselineScore: 80, shadowScore: 90, successProbability: 0.9, forwardReturn: 0.1 },
        { rowId: "b", decisionAtISO: "2026-01-02T16:00:00Z", ticker: "B", sector: "Health Care", capCohort: "mid", baselineScore: 60, shadowScore: 50, successProbability: 0.2, forwardReturn: -0.05 },
        { rowId: "c", decisionAtISO: "2026-01-03T16:00:00Z", ticker: "C", sector: "Energy", capCohort: "large", baselineScore: 70, shadowScore: 80, successProbability: 0.8, forwardReturn: 0.03 },
        { rowId: "d", decisionAtISO: "2026-01-03T16:00:00Z", ticker: "D", sector: "Industrials", capCohort: "small", baselineScore: 40, shadowScore: 30, successProbability: 0.1, forwardReturn: -0.02 },
      ],
      { topNPerDecisionDay: 1, positiveReturnThreshold: 0, calibrationBins: 2 },
    );
    expect(result).toMatchObject({ totalPredictions: 4, scoredPredictions: 4, selectedCount: 2, selectedLabelCoverage: 1, selectedHitRate: 1, selectedMeanReturn: 0.065, selectedExpectancy: 0.065 });
    expect(result.brierScore).toBeGreaterThanOrEqual(0);
    expect(result.expectedCalibrationError).toBeGreaterThanOrEqual(0);
    expect(result.sectorConcentration).toEqual({ maxShare: 1, hhi: 1 });
    expect(result.rankStabilityAgainstBaseline).toBe(1);
  });

  it("keeps missing labels out of both selected-return and calibration metrics", () => {
    const result = evaluateLearningPredictions([
      { rowId: "pending", decisionAtISO: "2026-01-02T16:00:00Z", ticker: "A", sector: "Energy", capCohort: "large", baselineScore: 80, shadowScore: 90, successProbability: 0.9, forwardReturn: null },
    ]);
    expect(result.selectedCount).toBe(1);
    expect(result.selectedLabelCoverage).toBe(0);
    expect(result.selectedMeanReturn).toBeNull();
    expect(result.brierScore).toBeNull();
  });

  it("excludes non-finite outcomes from return and calibration metrics", () => {
    const result = evaluateLearningPredictions([
      { rowId: "nan", decisionAtISO: "2026-01-02T16:00:00Z", ticker: "A", sector: "Energy", capCohort: "large", baselineScore: 80, shadowScore: 90, successProbability: 0.9, forwardReturn: Number.NaN },
      { rowId: "inf", decisionAtISO: "2026-01-02T16:00:00Z", ticker: "B", sector: "Energy", capCohort: "large", baselineScore: 70, shadowScore: 80, successProbability: 0.8, forwardReturn: Number.POSITIVE_INFINITY },
    ]);
    expect(result.selectedLabelCoverage).toBe(0);
    expect(result.selectedMeanReturn).toBeNull();
    expect(result.selectedExpectancy).toBeNull();
    expect(result.brierScore).toBeNull();
  });

  it("rejects a non-finite positive-return threshold", () => {
    expect(() =>
      evaluateLearningPredictions([], {
        topNPerDecisionDay: 8,
        positiveReturnThreshold: Number.NaN,
        calibrationBins: 5,
      }),
    ).toThrow(/positiveReturnThreshold must be finite/i);
  });
});
