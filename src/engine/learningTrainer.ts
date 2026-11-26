/**
 * Deterministic offline trainer for shadow evaluation.
 *
 * Two restrained model families are supported, chosen from the evidence
 * contract rather than fashion:
 *
 * - `ridge_baseline`: an interpretable L2-regularized linear model on
 *   standardized point-in-time features (closed-form normal equations).
 * - `gbm_challenger`: gradient-boosted regression trees restricted to depth
 *   <= 2, a bounded round count, and exhaustive deterministic split search -
 *   enough to capture the documented nonlinear cross-sectional interactions
 *   (Gu/Kelly/Xiu) without an unauditable model.
 *
 * Every function here is pure and deterministic: identical inputs produce
 * byte-identical outputs. There is no randomness, no I/O, and no access to
 * the production scorer. Predictions are shadow-only; nothing here can
 * change published scores, feed order, or state.
 *
 * Leakage rules mirror the walk-forward contract: a model may only fit rows
 * whose labels were observable at its training cutoff, imputation and
 * standardization statistics come from the training slice only, and
 * probability calibration is fit on training data only.
 */

import {
  auditPointInTimeDataset,
  trainableRows,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "@/engine/learningDataset";
import {
  configurationId,
  validateLearningModelConfiguration,
  type LearningModelConfiguration,
} from "@/engine/learningConfigLedger";
import type { LearningEvaluationSplit, OfflineLearningPrediction } from "@/engine/learningPromotion";
import { buildWalkForwardFolds, type WalkForwardConfig } from "@/engine/walkForward";

// ---------------------------------------------------------------------------
// Feature matrix
// ---------------------------------------------------------------------------

interface FeatureStats {
  /** Training-slice mean of observed values; imputation value for nulls. */
  means: number[];
  /** Training-slice standard deviation; 1 when degenerate so z stays 0. */
  stds: number[];
}

function rawFeature(row: PointInTimeFeatureRow, name: string): number | null {
  const feature = row.features[name];
  return feature && feature.value != null && Number.isFinite(feature.value) ? feature.value : null;
}

function computeStats(rows: readonly PointInTimeFeatureRow[], featureNames: readonly string[]): FeatureStats {
  const means: number[] = [];
  const stds: number[] = [];
  for (const name of featureNames) {
    const observed = rows
      .map((row) => rawFeature(row, name))
      .filter((value): value is number => value != null);
    const mean = observed.length === 0 ? 0 : observed.reduce((sum, value) => sum + value, 0) / observed.length;
    const variance =
      observed.length === 0
        ? 0
        : observed.reduce((sum, value) => sum + (value - mean) ** 2, 0) / observed.length;
    const std = Math.sqrt(variance);
    means.push(mean);
    stds.push(std > 1e-12 ? std : 1);
  }
  return { means, stds };
}

function designRow(
  row: PointInTimeFeatureRow,
  featureNames: readonly string[],
  stats: FeatureStats,
): number[] {
  return featureNames.map((name, index) => {
    const value = rawFeature(row, name);
    const imputed = value == null ? stats.means[index]! : value;
    return (imputed - stats.means[index]!) / stats.stds[index]!;
  });
}

// ---------------------------------------------------------------------------
// Ridge baseline (closed form, deterministic Gaussian elimination)
// ---------------------------------------------------------------------------

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index]!]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(a[pivot]![column]!) < 1e-12) {
      // Regularization keeps the system well-posed; a degenerate column means
      // the feature is constant - force its coefficient to zero.
      for (let k = 0; k <= n; k += 1) a[column]![k] = 0;
      a[column]![column] = 1;
      continue;
    }
    if (pivot !== column) {
      const swap = a[pivot]!;
      a[pivot] = a[column]!;
      a[column] = swap;
    }
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row]![column]! / a[column]![column]!;
      for (let k = column; k <= n; k += 1) a[row]![k]! -= factor * a[column]![k]!;
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row]![n]!;
    for (let k = row + 1; k < n; k += 1) sum -= a[row]![k]! * solution[k]!;
    solution[row] = Math.abs(a[row]![row]!) < 1e-12 ? 0 : sum / a[row]![row]!;
  }
  return solution;
}

export interface FittedRidgeModel {
  family: "ridge_baseline";
  featureNames: readonly string[];
  stats: FeatureStats;
  intercept: number;
  /** Coefficients on standardized features - directly interpretable. */
  coefficients: number[];
}

function fitRidge(
  rows: readonly PointInTimeFeatureRow[],
  featureNames: readonly string[],
  lambda: number,
): FittedRidgeModel {
  const stats = computeStats(rows, featureNames);
  const design = rows.map((row) => designRow(row, featureNames, stats));
  const targets = rows.map((row) => row.label!.forwardReturn);
  const n = rows.length;
  const k = featureNames.length;
  const meanTarget = targets.reduce((sum, value) => sum + value, 0) / n;
  const centered = targets.map((value) => value - meanTarget);
  const gram: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const moment = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    const x = design[i]!;
    for (let a = 0; a < k; a += 1) {
      moment[a]! += x[a]! * centered[i]!;
      for (let b = a; b < k; b += 1) gram[a]![b]! += x[a]! * x[b]!;
    }
  }
  for (let a = 0; a < k; a += 1) {
    for (let b = 0; b < a; b += 1) gram[a]![b] = gram[b]![a]!;
    gram[a]![a]! += lambda * n;
  }
  const coefficients = solveLinearSystem(gram, moment);
  return { family: "ridge_baseline", featureNames, stats, intercept: meanTarget, coefficients };
}

function predictRidge(model: FittedRidgeModel, row: PointInTimeFeatureRow): number {
  const x = designRow(row, model.featureNames, model.stats);
  let value = model.intercept;
  for (let index = 0; index < model.coefficients.length; index += 1) {
    value += model.coefficients[index]! * x[index]!;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Restrained gradient-boosted trees (depth <= 2, deterministic splits)
// ---------------------------------------------------------------------------

interface TreeNode {
  featureIndex: number;
  threshold: number;
  left: TreeNode | { value: number };
  right: TreeNode | { value: number };
}

type TreeOrLeaf = TreeNode | { value: number };

export interface FittedGbmModel {
  family: "gbm_challenger";
  featureNames: readonly string[];
  stats: FeatureStats;
  baseValue: number;
  learningRate: number;
  trees: TreeOrLeaf[];
}

interface SplitChoice {
  featureIndex: number;
  threshold: number;
  sse: number;
}

function leafValue(residuals: readonly number[], indices: readonly number[]): number {
  if (indices.length === 0) return 0;
  return indices.reduce((sum, index) => sum + residuals[index]!, 0) / indices.length;
}

function sseAround(residuals: readonly number[], indices: readonly number[], mean: number): number {
  return indices.reduce((sum, index) => sum + (residuals[index]! - mean) ** 2, 0);
}

function bestSplit(
  design: readonly number[][],
  residuals: readonly number[],
  indices: readonly number[],
  featureCount: number,
  minLeafSize: number,
): SplitChoice | null {
  let best: SplitChoice | null = null;
  for (let feature = 0; feature < featureCount; feature += 1) {
    const ordered = [...indices].sort(
      (a, b) => design[a]![feature]! - design[b]![feature]! || a - b,
    );
    let leftSum = 0;
    let leftCount = 0;
    const total = ordered.reduce((sum, index) => sum + residuals[index]!, 0);
    for (let position = 0; position < ordered.length - 1; position += 1) {
      const index = ordered[position]!;
      leftSum += residuals[index]!;
      leftCount += 1;
      const current = design[index]![feature]!;
      const next = design[ordered[position + 1]!]![feature]!;
      if (current === next) continue;
      const rightCount = ordered.length - leftCount;
      if (leftCount < minLeafSize || rightCount < minLeafSize) continue;
      const leftMean = leftSum / leftCount;
      const rightMean = (total - leftSum) / rightCount;
      // SSE decomposition: total squared error given the two child means.
      let sse = 0;
      for (let p = 0; p <= position; p += 1) sse += (residuals[ordered[p]!]! - leftMean) ** 2;
      for (let p = position + 1; p < ordered.length; p += 1) {
        sse += (residuals[ordered[p]!]! - rightMean) ** 2;
      }
      const threshold = (current + next) / 2;
      if (
        best == null ||
        sse < best.sse - 1e-15 ||
        (Math.abs(sse - best.sse) <= 1e-15 &&
          (feature < best.featureIndex ||
            (feature === best.featureIndex && threshold < best.threshold)))
      ) {
        best = { featureIndex: feature, threshold, sse };
      }
    }
  }
  return best;
}

function growTree(
  design: readonly number[][],
  residuals: readonly number[],
  indices: readonly number[],
  depthRemaining: number,
  minLeafSize: number,
): TreeOrLeaf {
  const mean = leafValue(residuals, indices);
  if (depthRemaining === 0 || indices.length < minLeafSize * 2) return { value: mean };
  const split = bestSplit(design, residuals, indices, design[0]?.length ?? 0, minLeafSize);
  if (!split) return { value: mean };
  const parentSse = sseAround(residuals, indices, mean);
  if (split.sse >= parentSse - 1e-15) return { value: mean };
  const leftIndices = indices.filter((index) => design[index]![split.featureIndex]! <= split.threshold);
  const rightIndices = indices.filter((index) => design[index]![split.featureIndex]! > split.threshold);
  return {
    featureIndex: split.featureIndex,
    threshold: split.threshold,
    left: growTree(design, residuals, leftIndices, depthRemaining - 1, minLeafSize),
    right: growTree(design, residuals, rightIndices, depthRemaining - 1, minLeafSize),
  };
}

function evalTree(node: TreeOrLeaf, x: readonly number[]): number {
  if ("value" in node) return node.value;
  return x[node.featureIndex]! <= node.threshold ? evalTree(node.left, x) : evalTree(node.right, x);
}

function fitGbm(
  rows: readonly PointInTimeFeatureRow[],
  featureNames: readonly string[],
  rounds: number,
  learningRate: number,
  maxDepth: 1 | 2,
  minLeafSize: number,
): FittedGbmModel {
  const stats = computeStats(rows, featureNames);
  const design = rows.map((row) => designRow(row, featureNames, stats));
  const targets = rows.map((row) => row.label!.forwardReturn);
  const baseValue = targets.reduce((sum, value) => sum + value, 0) / targets.length;
  const predictions = new Array<number>(rows.length).fill(baseValue);
  const indices = rows.map((_, index) => index);
  const trees: TreeOrLeaf[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const residuals = targets.map((target, index) => target - predictions[index]!);
    const tree = growTree(design, residuals, indices, maxDepth, minLeafSize);
    trees.push(tree);
    for (let index = 0; index < rows.length; index += 1) {
      predictions[index]! += learningRate * evalTree(tree, design[index]!);
    }
  }
  return { family: "gbm_challenger", featureNames, stats, baseValue, learningRate, trees };
}

function predictGbm(model: FittedGbmModel, row: PointInTimeFeatureRow): number {
  const x = designRow(row, model.featureNames, model.stats);
  let value = model.baseValue;
  for (const tree of model.trees) value += model.learningRate * evalTree(tree, x);
  return value;
}

// ---------------------------------------------------------------------------
// Isotonic probability calibration (pool-adjacent-violators, deterministic)
// ---------------------------------------------------------------------------

export interface IsotonicCalibration {
  /** Ascending block upper score boundaries and their pooled probabilities. */
  thresholds: number[];
  probabilities: number[];
}

function fitIsotonic(scores: readonly number[], successes: readonly number[]): IsotonicCalibration {
  const order = scores
    .map((score, index) => ({ score, success: successes[index]! }))
    .sort((a, b) => a.score - b.score || a.success - b.success);
  interface Block {
    sum: number;
    count: number;
    maxScore: number;
  }
  const blocks: Block[] = [];
  for (const point of order) {
    blocks.push({ sum: point.success, count: 1, maxScore: point.score });
    while (
      blocks.length >= 2 &&
      blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.count >=
        blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.count
    ) {
      const top = blocks.pop()!;
      const beneath = blocks.pop()!;
      blocks.push({
        sum: beneath.sum + top.sum,
        count: beneath.count + top.count,
        maxScore: top.maxScore,
      });
    }
  }
  return {
    thresholds: blocks.map((block) => block.maxScore),
    probabilities: blocks.map((block) => block.sum / block.count),
  };
}

function calibratedProbability(calibration: IsotonicCalibration, score: number): number {
  if (calibration.thresholds.length === 0) return 0.5;
  for (let index = 0; index < calibration.thresholds.length; index += 1) {
    if (score <= calibration.thresholds[index]!) {
      return Math.min(1, Math.max(0, calibration.probabilities[index]!));
    }
  }
  return Math.min(1, Math.max(0, calibration.probabilities[calibration.probabilities.length - 1]!));
}

// ---------------------------------------------------------------------------
// Model facade
// ---------------------------------------------------------------------------

export interface FittedLearningModel {
  configurationId: string;
  model: FittedRidgeModel | FittedGbmModel;
  calibration: IsotonicCalibration;
}

/** Fit a model on labeled training rows. Callers own the leakage boundary. */
export function fitLearningModel(
  configuration: LearningModelConfiguration,
  labeledTrainRows: readonly PointInTimeFeatureRow[],
): FittedLearningModel {
  validateLearningModelConfiguration(configuration);
  if (labeledTrainRows.length === 0) {
    throw new Error("Cannot fit a learning model with zero labeled training rows.");
  }
  for (const row of labeledTrainRows) {
    if (row.label == null) throw new Error(`Training row '${row.rowId}' is missing its label.`);
    if (row.label.horizonDays !== configuration.labelHorizonDays) {
      throw new Error(
        `Training row '${row.rowId}' label horizon ${row.label.horizonDays} does not match the configured horizon ${configuration.labelHorizonDays}.`,
      );
    }
  }
  const hp = configuration.hyperparameters;
  const model =
    hp.family === "ridge_baseline"
      ? fitRidge(labeledTrainRows, configuration.featureNames, hp.lambda)
      : fitGbm(
          labeledTrainRows,
          configuration.featureNames,
          hp.rounds,
          hp.learningRate,
          hp.maxDepth,
          hp.minLeafSize,
        );
  const rawScores = labeledTrainRows.map((row) =>
    model.family === "ridge_baseline" ? predictRidge(model, row) : predictGbm(model, row),
  );
  const successes = labeledTrainRows.map((row) =>
    row.label!.forwardReturn > configuration.successThreshold ? 1 : 0,
  );
  return {
    configurationId: configurationId(configuration),
    model,
    calibration: fitIsotonic(rawScores, successes),
  };
}

export interface ShadowPrediction {
  shadowScore: number;
  successProbability: number;
}

export function predictWithModel(
  fitted: FittedLearningModel,
  row: PointInTimeFeatureRow,
): ShadowPrediction {
  const shadowScore =
    fitted.model.family === "ridge_baseline"
      ? predictRidge(fitted.model, row)
      : predictGbm(fitted.model, row);
  return {
    shadowScore,
    successProbability: calibratedProbability(fitted.calibration, shadowScore),
  };
}

// ---------------------------------------------------------------------------
// End-to-end shadow prediction generation (walk-forward + frozen holdout)
// ---------------------------------------------------------------------------

export interface TrainerRunInput {
  rows: readonly PointInTimeFeatureRow[];
  manifests: readonly PointInTimeUniverseManifest[];
  evidence: PointInTimeEvidenceRegistry;
  split: LearningEvaluationSplit;
  walkForwardConfig: WalkForwardConfig;
  configuration: LearningModelConfiguration;
  reportAsOfISO: string;
}

function dayKey(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

/**
 * Deterministically generate every required out-of-sample shadow prediction:
 * one per walk-forward test row (model fit per fold on that fold's training
 * slice only) and one per frozen-holdout row (model fit once at the frozen
 * cutoff). The candidate ID is the content-addressed configuration ID, so a
 * prediction can never claim a configuration other than the one that made it.
 */
export function generateShadowPredictions(input: TrainerRunInput): OfflineLearningPrediction[] {
  const candidateId = configurationId(input.configuration);
  if (candidateId !== input.split.candidateId) {
    throw new Error(
      "Trainer configuration does not match the frozen split's candidate configuration ID.",
    );
  }
  const reportMs = Date.parse(input.reportAsOfISO);
  const holdoutStartDay = dayKey(input.split.holdoutStartISO);
  const holdoutEndDay = dayKey(input.split.holdoutEndISO);
  const audit = auditPointInTimeDataset(input.rows, input.manifests, input.evidence);
  const validRows = input.rows.filter((_, index) => audit.validations[index]!.valid);
  const developmentRows = validRows.filter((row) => dayKey(row.decisionAtISO) < holdoutStartDay);
  const holdoutRows = validRows.filter((row) => {
    const day = dayKey(row.decisionAtISO);
    return day >= holdoutStartDay && day <= holdoutEndDay;
  });
  const developmentUniverseIds = new Set(developmentRows.map((row) => row.universeId));
  const developmentManifests = input.manifests.filter((manifest) =>
    developmentUniverseIds.has(manifest.universeId),
  );

  const toPrediction = (
    row: PointInTimeFeatureRow,
    fitted: FittedLearningModel,
    slice: OfflineLearningPrediction["slice"],
  ): OfflineLearningPrediction => {
    const { shadowScore, successProbability } = predictWithModel(fitted, row);
    const labelObservable =
      row.label != null && Date.parse(row.label.observedAtISO) <= reportMs;
    return {
      rowId: row.rowId,
      decisionAtISO: row.decisionAtISO,
      ticker: row.ticker,
      sector: row.sector,
      capCohort: row.capCohort,
      baselineScore: row.baselineScore,
      shadowScore,
      successProbability,
      forwardReturn: labelObservable ? row.label!.forwardReturn : null,
      candidateId,
      slice,
    };
  };

  const predictions: OfflineLearningPrediction[] = [];
  const folds = buildWalkForwardFolds(
    developmentRows,
    developmentManifests,
    input.evidence,
    input.walkForwardConfig,
  );
  for (const fold of folds) {
    const fitted = fitLearningModel(input.configuration, fold.trainRows);
    for (const row of fold.testRows) {
      predictions.push(
        toPrediction(row, fitted, {
          kind: "walk_forward",
          foldIndex: fold.index,
          trainedThroughISO: fold.trainEndISO,
        }),
      );
    }
  }

  const frozenCutoffMs = Date.parse(input.split.holdoutModelTrainedThroughISO);
  const orderedTrainable = trainableRows(developmentRows, developmentManifests, input.evidence);
  const holdoutTrainRows = orderedTrainable.filter(
    (row) => row.label != null && Date.parse(row.label.observedAtISO) <= frozenCutoffMs,
  );
  const holdoutModel = fitLearningModel(input.configuration, holdoutTrainRows);
  for (const row of holdoutRows) {
    predictions.push(
      toPrediction(row, holdoutModel, {
        kind: "holdout",
        trainedThroughISO: input.split.holdoutModelTrainedThroughISO,
      }),
    );
  }
  return predictions;
}
