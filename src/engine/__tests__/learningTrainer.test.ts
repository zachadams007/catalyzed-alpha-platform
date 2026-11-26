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
import {
  fitLearningModel,
  generateShadowPredictions,
  predictWithModel,
} from "@/engine/learningTrainer";
import type { LearningEvaluationSplit } from "@/engine/learningPromotion";
import { buildLearningFixture } from "./learningTestFixtures";

function labeledRow(
  id: string,
  featureValue: number,
  forwardReturn: number,
  secondFeature: number | null = null,
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
      momentum: { value: featureValue, source: "market_data", observedAtISO: "2026-01-05T21:00:00.000Z" },
      other: { value: secondFeature, source: "market_data", observedAtISO: "2026-01-05T21:00:00.000Z" },
    },
    label: {
      horizonDays: 1,
      forwardReturn,
      horizonCloseAtISO: "2026-01-06T20:00:00.000Z",
      observedAtISO: "2026-01-06T21:00:00.000Z",
    },
  };
}

function ridgeConfiguration(features: string[] = ["momentum", "other"]): LearningModelConfiguration {
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: features,
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
    hyperparameters: { family: "gbm_challenger", rounds: 30, learningRate: 0.2, maxDepth: 2, minLeafSize: 2 },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
}

describe("fitLearningModel — ridge baseline", () => {
  it("recovers a monotone linear relationship and stays deterministic", () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      labeledRow(`r-${index}`, index / 10, index / 100 - 0.02, (index % 7) / 10),
    );
    const first = fitLearningModel(ridgeConfiguration(), rows);
    const second = fitLearningModel(ridgeConfiguration(), rows);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const low = predictWithModel(first, labeledRow("q-low", 0.1, 0));
    const high = predictWithModel(first, labeledRow("q-high", 3.5, 0));
    expect(high.shadowScore).toBeGreaterThan(low.shadowScore);
    expect(low.successProbability).toBeGreaterThanOrEqual(0);
    expect(high.successProbability).toBeLessThanOrEqual(1);
    expect(high.successProbability).toBeGreaterThanOrEqual(low.successProbability);
  });

  it("treats a missing feature as the training mean, never a penalty or a peek", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      labeledRow(`r-${index}`, index / 10, index / 100),
    );
    const fitted = fitLearningModel(ridgeConfiguration(["momentum", "missing_everywhere"]), rows);
    const prediction = predictWithModel(fitted, labeledRow("q", 1, 0));
    expect(Number.isFinite(prediction.shadowScore)).toBe(true);
  });

  it("refuses rows whose label horizon does not match the configuration", () => {
    const rows = [labeledRow("r-0", 1, 0.01)];
    const config = { ...ridgeConfiguration(), labelHorizonDays: 5 };
    expect(() => fitLearningModel(config, rows)).toThrow(/does not match the configured horizon/);
  });

  it("refuses an empty training set", () => {
    expect(() => fitLearningModel(ridgeConfiguration(), [])).toThrow(/zero labeled training rows/);
  });
});

describe("fitLearningModel — restrained GBM challenger", () => {
  it("captures a nonlinear (V-shaped) relationship a linear model cannot", () => {
    // forwardReturn is high at both feature extremes, low in the middle.
    const rows = Array.from({ length: 60 }, (_, index) => {
      const x = index / 30 - 1; // -1 .. ~1
      return labeledRow(`r-${index}`, x, Math.abs(x) * 0.1 - 0.03);
    });
    const gbm = fitLearningModel(gbmConfiguration(), rows);
    const ridge = fitLearningModel(ridgeConfiguration(), rows);

    const middle = labeledRow("q-mid", 0, 0);
    const edge = labeledRow("q-edge", -0.95, 0);
    const gbmGap = predictWithModel(gbm, edge).shadowScore - predictWithModel(gbm, middle).shadowScore;
    const ridgeGap =
      predictWithModel(ridge, edge).shadowScore - predictWithModel(ridge, middle).shadowScore;
    expect(gbmGap).toBeGreaterThan(0.02);
    expect(gbmGap).toBeGreaterThan(ridgeGap);
  });

  it("is deterministic across repeated fits", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      labeledRow(`r-${index}`, (index * 13) % 7, ((index * 7) % 5) / 100 - 0.02, (index % 3) / 2),
    );
    const first = fitLearningModel(gbmConfiguration(), rows);
    const second = fitLearningModel(gbmConfiguration(), rows);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("generateShadowPredictions — leakage-safe end-to-end generation", () => {
  const fixture = buildLearningFixture(40);
  const walkForwardConfig = {
    minTrainingDecisionDays: 10,
    testDecisionDays: 5,
    stepDecisionDays: 5,
    embargoDecisionDays: 1,
  };
  const configuration: LearningModelConfiguration = {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum"],
    hyperparameters: { family: "ridge_baseline", lambda: 0.01 },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
  const candidateId = configurationId(configuration);
  const split: LearningEvaluationSplit = {
    splitId: "split-1",
    candidateId,
    frozenAtISO: "2026-01-20T00:00:00.000Z",
    modelSelectedAtISO: "2026-01-30T00:00:00.000Z",
    holdoutStartISO: "2026-02-01T00:00:00.000Z",
    holdoutEndISO: "2026-02-09T23:59:59.999Z",
    holdoutModelTrainedThroughISO: "2026-01-31T23:59:59.999Z",
    attemptedConfigurationIds: [candidateId],
  };
  const reportAsOfISO = "2026-03-01T00:00:00.000Z";

  it("produces byte-identical predictions for identical inputs", () => {
    const first = generateShadowPredictions({
      rows: fixture.rows,
      manifests: fixture.manifests,
      evidence: fixture.evidence,
      split,
      walkForwardConfig,
      configuration,
      reportAsOfISO,
    });
    const second = generateShadowPredictions({
      rows: fixture.rows,
      manifests: fixture.manifests,
      evidence: fixture.evidence,
      split,
      walkForwardConfig,
      configuration,
      reportAsOfISO,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.length).toBeGreaterThan(0);
  });

  it("tags every prediction with the content-addressed candidate and a valid slice", () => {
    const predictions = generateShadowPredictions({
      rows: fixture.rows,
      manifests: fixture.manifests,
      evidence: fixture.evidence,
      split,
      walkForwardConfig,
      configuration,
      reportAsOfISO,
    });
    const holdout = predictions.filter((prediction) => prediction.slice.kind === "holdout");
    const walkForward = predictions.filter((prediction) => prediction.slice.kind === "walk_forward");
    expect(holdout.length).toBeGreaterThan(0);
    expect(walkForward.length).toBeGreaterThan(0);
    for (const prediction of predictions) {
      expect(prediction.candidateId).toBe(candidateId);
      expect(Number.isFinite(prediction.shadowScore)).toBe(true);
      expect(prediction.successProbability).toBeGreaterThanOrEqual(0);
      expect(prediction.successProbability).toBeLessThanOrEqual(1);
    }
    for (const prediction of holdout) {
      expect(prediction.slice.trainedThroughISO).toBe(split.holdoutModelTrainedThroughISO);
      expect(prediction.decisionAtISO.slice(0, 10) >= "2026-02-01").toBe(true);
    }
  });

  it("refuses a configuration that does not match the frozen split candidate", () => {
    const otherConfiguration = { ...configuration, hyperparameters: { family: "ridge_baseline" as const, lambda: 0.5 } };
    expect(() =>
      generateShadowPredictions({
        rows: fixture.rows,
        manifests: fixture.manifests,
        evidence: fixture.evidence,
        split,
        walkForwardConfig,
        configuration: otherConfiguration,
        reportAsOfISO,
      }),
    ).toThrow(/does not match the frozen split/);
  });

  it("never fits the holdout model on a label observed after the frozen cutoff", () => {
    // Rows whose labels land after holdoutModelTrainedThroughISO must not
    // influence the holdout model. Poison the late-label rows with an
    // enormous fake signal; if the model ingested them, holdout scores for
    // high-momentum rows would explode.
    const poisoned = fixture.rows.map((row) => {
      const observedMs = row.label ? Date.parse(row.label.observedAtISO) : 0;
      if (row.label && observedMs > Date.parse(split.holdoutModelTrainedThroughISO)) {
        return { ...row, label: { ...row.label, forwardReturn: 1000 } };
      }
      return row;
    });
    const predictions = generateShadowPredictions({
      rows: poisoned,
      manifests: fixture.manifests,
      evidence: fixture.evidence,
      split,
      walkForwardConfig,
      configuration,
      reportAsOfISO,
    });
    const holdout = predictions.filter((prediction) => prediction.slice.kind === "holdout");
    for (const prediction of holdout) {
      expect(prediction.shadowScore).not.toBeNull();
      expect(Math.abs(prediction.shadowScore!)).toBeLessThan(1);
    }
  });
});
