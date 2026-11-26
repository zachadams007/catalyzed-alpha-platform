import { describe, expect, it } from "vitest";

import {
  evaluateLearningPromotion,
  type LearningPromotionInput,
} from "@/engine/learningPromotion";
import {
  buildEvaluationPredictions,
  buildLearningFixture,
} from "@/engine/__tests__/learningTestFixtures";

function day(value: number): string {
  return new Date(Date.UTC(2026, 0, value)).toISOString().slice(0, 10);
}

function input(): LearningPromotionInput {
  const fixture = buildLearningFixture(40);
  const walkForwardConfig = {
    minTrainingDecisionDays: 10,
    testDecisionDays: 5,
    stepDecisionDays: 5,
    embargoDecisionDays: 1,
  };
  const holdoutStart = day(31);
  return {
    reportAsOfISO: "2026-03-01T00:00:00.000Z",
    ...fixture,
    predictions: buildEvaluationPredictions(fixture, holdoutStart, walkForwardConfig),
    split: {
      splitId: "split-v1",
      candidateId: "candidate-v1",
      frozenAtISO: `${day(29)}T23:59:59.999Z`,
      modelSelectedAtISO: `${day(30)}T23:59:59.999Z`,
      holdoutStartISO: `${holdoutStart}T00:00:00.000Z`,
      holdoutEndISO: `${day(40)}T23:59:59.999Z`,
      holdoutModelTrainedThroughISO: `${day(30)}T23:59:59.999Z`,
      attemptedConfigurationIds: ["linear-v1", "candidate-v1"],
    },
    walkForwardConfig,
    evaluationPolicy: {
      topNPerDecisionDay: 2,
      positiveReturnThreshold: 0,
      calibrationBins: 2,
    },
    promotionPolicy: {
      minWalkForwardFolds: 3,
      minHoldoutDecisionDays: 10,
      minHoldoutFraction: 0.2,
      minLabelCoverage: 1,
      minSelectedLabelCoverage: 1,
      minRankICDelta: 0.01,
      minMeanReturnDelta: 0.001,
      minExpectancyDelta: 0.001,
      maxBrierScore: 0.01,
      maxExpectedCalibrationError: 0.01,
      maxSectorShare: 0.6,
      maxCapShare: 0.6,
      minRankStabilityAgainstBaseline: 0.2,
    },
    drift: {
      trainedAtISO: `${day(30)}T23:59:59.999Z`,
      nowISO: "2026-03-01T00:00:00.000Z",
      baselineFeatureCoverage: 0.95,
      currentFeatureCoverage: 0.94,
      baselineValues: [0.1, 0.2, 0.7, 0.8],
      currentValues: [0.12, 0.22, 0.72, 0.82],
      binEdges: [0, 0.5, 1],
    },
  };
}

describe("evaluateLearningPromotion", () => {
  it("emits complete diagnostics but blocks promotion until all inputs have authenticated admission", () => {
    const source = input();
    const before = JSON.stringify(source);
    const report = evaluateLearningPromotion(source);

    expect(report.verdict).toMatchObject({
      status: "blocked",
      automaticPromotion: false,
      productionMutationAllowed: false,
      blockers: [
        expect.stringMatching(/promotion authentication is unavailable/i),
        "A registered attempted-configuration ledger is required.",
      ],
      failedGates: [],
    });
    expect(report.admission).toEqual({ verified: false, records: [] });
    expect(report.walkForward.folds).toBeGreaterThanOrEqual(3);
    expect(report.holdout.candidate).toMatchObject({
      labelCoverage: 1,
      selectedLabelCoverage: 1,
      brierScore: 0,
      expectedCalibrationError: 0,
    });
    expect(report.holdout.candidate.selectedExpectancy).toBeGreaterThan(
      report.holdout.baseline.selectedExpectancy!,
    );
    expect(report.holdout.rankIC.delta).toBeGreaterThan(0);
    expect(report.holdout.candidate.sectorConcentration).not.toBeNull();
    expect(report.holdout.candidate.capConcentration).not.toBeNull();
    expect(report.holdout.candidate.rankStabilityAgainstBaseline).not.toBeNull();
    expect(report.drift.blocked).toBe(false);
    expect(report.production).toEqual({
      publishedScorerChanged: false,
      publishedOrderChanged: false,
      orderExecutionPathAdded: false,
    });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("blocks when the final temporal holdout is not the final available window", () => {
    const source = input();
    source.split = {
      ...source.split,
      holdoutEndISO: `${day(39)}T23:59:59.999Z`,
    };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/last available decision day/i);
  });

  it("blocks model selection at or after the first final-holdout instant", () => {
    const source = input();
    source.split = {
      ...source.split,
      modelSelectedAtISO: source.split.holdoutStartISO,
    };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/model selection.*strictly before/i);
  });

  it("blocks a final-holdout freeze at or after the holdout begins", () => {
    const source = input();
    source.split = {
      ...source.split,
      frozenAtISO: source.split.holdoutStartISO,
    };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/holdout must be frozen strictly before/i);
  });

  it("blocks a report timestamp that precedes the final holdout end", () => {
    const source = input();
    source.reportAsOfISO = source.split.holdoutStartISO;
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/report as-of.*before.*holdout ends/i);
  });

  it("blocks when independently admitted universe evidence is missing", () => {
    const source = input();
    source.evidence = { ...source.evidence, verifiedUniverseArtifacts: [] };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/provenance|coverage/i);
  });

  it("blocks rather than inventing evaluation or promotion thresholds", () => {
    const source = input();
    source.evaluationPolicy = undefined;
    source.promotionPolicy = undefined;
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/pre-registered evaluation policy/i);
    expect(report.verdict.blockers.join(" ")).toMatch(/pre-registered promotion policy/i);
  });

  it("withholds performance pass/fail conclusions while evidence is unauthenticated", () => {
    const source = input();
    source.predictions = source.predictions.map((prediction) => ({
      ...prediction,
      shadowScore:
        prediction.shadowScore == null ? null : 110 - prediction.shadowScore,
      successProbability:
        prediction.successProbability == null ? null : 1 - prediction.successProbability,
    }));
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/promotion authentication is unavailable/i);
    expect(report.verdict.failedGates).toEqual([]);
  });

  it("blocks an incomplete probability stream in walk-forward evaluation", () => {
    const source = input();
    const index = source.predictions.findIndex(
      (prediction) => prediction.slice.kind === "walk_forward",
    );
    source.predictions = source.predictions.map((prediction, candidateIndex) =>
      candidateIndex === index ? { ...prediction, successProbability: null } : prediction,
    );
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/valid success probability/i);
  });

  it("binds drift timestamps to the report and frozen holdout model", () => {
    const source = input();
    source.drift = {
      ...source.drift,
      nowISO: "2026-02-28T00:00:00.000Z",
      trainedAtISO: "2026-01-29T00:00:00.000Z",
    };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/drift assessment time.*report as-of/i);
    expect(report.verdict.blockers.join(" ")).toMatch(/drift model-training time.*frozen/i);
  });

  it("blocks a prediction whose training cutoff crosses its test window", () => {
    const source = input();
    const first = source.predictions[0]!;
    source.predictions = [
      {
        ...first,
        slice: { ...first.slice, trainedThroughISO: first.decisionAtISO },
      },
      ...source.predictions.slice(1),
    ];
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/training cutoff/i);
  });

  it("blocks rolling retraining inside the frozen final holdout", () => {
    const source = input();
    const holdoutIndex = source.predictions.findIndex(
      (prediction) => prediction.slice.kind === "holdout",
    );
    const holdout = source.predictions[holdoutIndex]!;
    source.predictions = source.predictions.map((prediction, index) =>
      index === holdoutIndex
        ? {
            ...holdout,
            slice: {
              kind: "holdout" as const,
              trainedThroughISO: holdout.decisionAtISO,
            },
          }
        : prediction,
    );
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/frozen model cutoff/i);
  });
});
