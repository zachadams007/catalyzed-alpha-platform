import { describe, expect, it } from "vitest";
import {
  LEARNING_DATASET_SCHEMA_VERSION,
  type PointInTimeFeatureRow,
} from "@/engine/learningDataset";
import {
  configurationId,
  LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
  type LearningModelConfiguration,
} from "@/engine/learningConfigLedger";
import { fitLearningModel, predictWithModel } from "@/engine/learningTrainer";
import {
  aggregatePostMortems,
  buildPickPostMortem,
} from "@/engine/learningPostMortem";

function labeledRow(
  id: string,
  momentum: number | null,
  other: number | null,
  forwardReturn: number,
  horizonDays = 1,
): PointInTimeFeatureRow {
  return {
    schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
    rowId: id,
    ticker: "AAA",
    decisionAtISO: "2026-01-05T22:00:00.000Z",
    universeId: "u-1",
    sector: "Industrials",
    capCohort: "mid",
    baselineScore: 50,
    features: {
      momentum: { value: momentum, source: "market_data", observedAtISO: "2026-01-05T21:00:00.000Z" },
      other: { value: other, source: "market_data", observedAtISO: "2026-01-05T21:00:00.000Z" },
    },
    label: {
      horizonDays,
      forwardReturn,
      horizonCloseAtISO: "2026-01-06T20:00:00.000Z",
      observedAtISO: "2026-01-06T21:00:00.000Z",
    },
  };
}

function ridgeConfiguration(): LearningModelConfiguration {
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum", "other"],
    hyperparameters: { family: "ridge_baseline", lambda: 0.001 },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
}

function gbmConfiguration(): LearningModelConfiguration {
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum", "other"],
    hyperparameters: { family: "gbm_challenger", rounds: 20, learningRate: 0.2, maxDepth: 2, minLeafSize: 2 },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
}

/** momentum drives returns up; `other` is uninformative noise. */
function trainingRows(): PointInTimeFeatureRow[] {
  return Array.from({ length: 40 }, (_, index) =>
    labeledRow(`t-${index}`, index / 10, (index % 7) / 10, index / 100 - 0.02),
  );
}

describe("buildPickPostMortem — per-pick attribution", () => {
  it("ridge: contributions decompose the score exactly (sum = score − neutral score)", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const pick = labeledRow("bad-pick", 3.5, 0.2, -0.08); // high momentum, bad outcome
    const report = buildPickPostMortem(fitted, configuration, pick);

    const allNeutral = labeledRow("neutral", null, null, -0.08);
    const neutralScore = predictWithModel(fitted, allNeutral).shadowScore;
    const contributionSum = report.attributions.reduce((sum, a) => sum + a.contribution, 0);
    expect(contributionSum).toBeCloseTo(report.shadowScore - neutralScore, 8);
  });

  it("names the feature that misled a bad pick", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    // Momentum screams "buy" (far above the training mean); the outcome missed.
    const report = buildPickPostMortem(fitted, configuration, labeledRow("bad", 3.5, 0.3, -0.08));
    expect(report.outcome).toBe("miss");
    expect(report.misleadingFeatures).toContain("momentum");
    expect(report.attributions[0]!.featureName).toBe("momentum");
    expect(report.attributions[0]!.contribution).toBeGreaterThan(0);
  });

  it("a hit carries no misleading features", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const report = buildPickPostMortem(fitted, configuration, labeledRow("good", 3.5, 0.3, 0.12));
    expect(report.outcome).toBe("hit");
    expect(report.misleadingFeatures).toEqual([]);
  });

  it("an unavailable feature is recorded as missing evidence with zero contribution", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const report = buildPickPostMortem(fitted, configuration, labeledRow("thin", 2.0, null, -0.04));
    expect(report.missingEvidence).toEqual(["other"]);
    const other = report.attributions.find((a) => a.featureName === "other")!;
    expect(other.value).toBeNull();
    expect(other.contribution).toBe(0);
  });

  it("works for the restrained GBM challenger too", () => {
    const configuration = gbmConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const report = buildPickPostMortem(fitted, configuration, labeledRow("bad", 3.5, 0.3, -0.08));
    expect(report.outcome).toBe("miss");
    for (const attribution of report.attributions) {
      expect(Number.isFinite(attribution.contribution)).toBe(true);
    }
  });

  it("is deterministic: identical inputs produce byte-identical reports", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const a = buildPickPostMortem(fitted, configuration, labeledRow("p", 1.5, 0.4, -0.02));
    const b = buildPickPostMortem(fitted, configuration, labeledRow("p", 1.5, 0.4, -0.02));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("fails closed on an unlabeled row (absent outcome is never a miss)", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const unlabeled = { ...labeledRow("u", 1, 1, 0), label: undefined };
    expect(() => buildPickPostMortem(fitted, configuration, unlabeled)).toThrow(/no realized label/);
  });

  it("fails closed on a horizon mismatch", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const wrongHorizon = labeledRow("h", 1, 1, -0.01, 5);
    expect(() => buildPickPostMortem(fitted, configuration, wrongHorizon)).toThrow(
      /does not match the configured horizon/,
    );
  });

  it("fails closed when the fitted model is not the configuration's candidate", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const otherConfiguration = { ...ridgeConfiguration(), successThreshold: 0.01 };
    expect(configurationId(otherConfiguration)).not.toBe(fitted.configurationId);
    expect(() =>
      buildPickPostMortem(fitted, otherConfiguration, labeledRow("p", 1, 1, -0.01)),
    ).toThrow(/content-addressed candidate/);
  });
});

describe("aggregatePostMortems — the recurring-misleader table", () => {
  it("counts how often each feature pushed misses upward, ranked", () => {
    const configuration = ridgeConfiguration();
    const fitted = fitLearningModel(configuration, trainingRows());
    const reports = [
      buildPickPostMortem(fitted, configuration, labeledRow("m1", 3.5, 0.1, -0.08)),
      buildPickPostMortem(fitted, configuration, labeledRow("m2", 3.0, 0.2, -0.05)),
      buildPickPostMortem(fitted, configuration, labeledRow("h1", 3.2, 0.3, 0.09)),
    ];
    const aggregate = aggregatePostMortems(reports);
    expect(aggregate.totalPicks).toBe(3);
    expect(aggregate.misses).toBe(2);
    const momentum = aggregate.recurringMisleaders.find((m) => m.featureName === "momentum")!;
    expect(momentum.missCount).toBe(2);
    expect(momentum.meanContributionInMisses).toBeGreaterThan(0);
  });

  it("refuses to blend post-mortems from different candidate configurations", () => {
    const configA = ridgeConfiguration();
    const configB = gbmConfiguration();
    const fittedA = fitLearningModel(configA, trainingRows());
    const fittedB = fitLearningModel(configB, trainingRows());
    const reports = [
      buildPickPostMortem(fittedA, configA, labeledRow("a", 3.5, 0.1, -0.08)),
      buildPickPostMortem(fittedB, configB, labeledRow("b", 3.5, 0.1, -0.08)),
    ];
    expect(() => aggregatePostMortems(reports)).toThrow(/different candidate configurations/);
  });

  it("refuses an empty input", () => {
    expect(() => aggregatePostMortems([])).toThrow(/zero post-mortems/);
  });
});
