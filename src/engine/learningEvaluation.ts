import { round } from "@/lib/math";
import { spearman } from "./outcomeEval";
import type { LearningCapCohort } from "./learningDataset";

export interface LearningPrediction {
  rowId: string;
  decisionAtISO: string;
  ticker: string;
  sector: string;
  capCohort: LearningCapCohort;
  baselineScore: number;
  shadowScore: number | null;
  /** Calibrated probability of a positive forward return, 0..1. */
  successProbability: number | null;
  forwardReturn: number | null;
}
export interface LearningEvaluationPolicy {
  topNPerDecisionDay: number;
  positiveReturnThreshold: number;
  calibrationBins: number;
}

export const DEFAULT_LEARNING_EVALUATION_POLICY: LearningEvaluationPolicy = {
  topNPerDecisionDay: 8,
  positiveReturnThreshold: 0,
  calibrationBins: 5,
};

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanPrediction: number;
  observedHitRate: number;
}

export interface LearningEvaluation {
  totalPredictions: number;
  scoredPredictions: number;
  /** Scored predictions carrying a finite probability in [0, 1]. */
  calibratedPredictions: number;
  labelCoverage: number;
  selectedCount: number;
  /** Fraction of the model's selected names whose outcome label has landed. */
  selectedLabelCoverage: number;
  selectedHitRate: number | null;
  /** Mean selected return, including losses; no trading-cost claim is implied. */
  selectedMeanReturn: number | null;
  /** Win-rate-weighted average win/loss, the ordinary expectancy decomposition. */
  selectedExpectancy: number | null;
  brierScore: number | null;
  expectedCalibrationError: number | null;
  calibration: CalibrationBin[];
  sectorConcentration: { maxShare: number; hhi: number } | null;
  capConcentration: { maxShare: number; hhi: number } | null;
  /** Mean within-day rank correlation between shadow and baseline score. */
  rankStabilityAgainstBaseline: number | null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function concentration(values: readonly string[]): { maxShare: number; hhi: number } | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const shares = [...counts.values()].map((count) => count / values.length);
  return {
    maxShare: round(Math.max(...shares), 4),
    hhi: round(shares.reduce((sum, share) => sum + share ** 2, 0), 4),
  };
}

function selectedPredictions(
  predictions: readonly LearningPrediction[],
  policy: LearningEvaluationPolicy,
): LearningPrediction[] {
  const byDay = new Map<string, LearningPrediction[]>();
  for (const prediction of predictions) {
    if (prediction.shadowScore == null || !Number.isFinite(prediction.shadowScore)) continue;
    const key = dayKey(prediction.decisionAtISO);
    const entries = byDay.get(key) ?? [];
    entries.push(prediction);
    byDay.set(key, entries);
  }
  return [...byDay.values()].flatMap((entries) =>
    [...entries]
      .sort((a, b) => b.shadowScore! - a.shadowScore! || a.ticker.localeCompare(b.ticker))
      .slice(0, policy.topNPerDecisionDay),
  );
}

function calibrationMetrics(
  predictions: readonly LearningPrediction[],
  policy: LearningEvaluationPolicy,
): Pick<LearningEvaluation, "brierScore" | "expectedCalibrationError" | "calibration"> {
  const eligible = predictions.filter(
    (prediction) =>
      prediction.successProbability != null &&
      prediction.forwardReturn != null &&
      Number.isFinite(prediction.successProbability) &&
      Number.isFinite(prediction.forwardReturn) &&
      prediction.successProbability >= 0 &&
      prediction.successProbability <= 1,
  );
  if (eligible.length === 0) return { brierScore: null, expectedCalibrationError: null, calibration: [] };

  const bins: CalibrationBin[] = Array.from({ length: policy.calibrationBins }, (_, index) => ({
    lower: index / policy.calibrationBins,
    upper: (index + 1) / policy.calibrationBins,
    count: 0,
    meanPrediction: 0,
    observedHitRate: 0,
  }));
  const predictionSums = new Array(policy.calibrationBins).fill(0);
  const outcomeSums = new Array(policy.calibrationBins).fill(0);
  let brierTotal = 0;

  for (const prediction of eligible) {
    const probability = prediction.successProbability!;
    const outcome = prediction.forwardReturn! > policy.positiveReturnThreshold ? 1 : 0;
    const index = Math.min(policy.calibrationBins - 1, Math.floor(probability * policy.calibrationBins));
    const bin = bins[index]!;
    bin.count += 1;
    predictionSums[index] += probability;
    outcomeSums[index] += outcome;
    brierTotal += (probability - outcome) ** 2;
  }

  let ece = 0;
  for (let index = 0; index < bins.length; index++) {
    const bin = bins[index]!;
    if (bin.count === 0) continue;
    bin.meanPrediction = round(predictionSums[index] / bin.count, 4);
    bin.observedHitRate = round(outcomeSums[index] / bin.count, 4);
    ece += (bin.count / eligible.length) * Math.abs(bin.meanPrediction - bin.observedHitRate);
  }

  return {
    brierScore: round(brierTotal / eligible.length, 5),
    expectedCalibrationError: round(ece, 5),
    calibration: bins.filter((bin) => bin.count > 0),
  };
}

function rankStability(predictions: readonly LearningPrediction[]): number | null {
  const byDay = new Map<string, LearningPrediction[]>();
  for (const prediction of predictions) {
    if (prediction.shadowScore == null) continue;
    const entries = byDay.get(dayKey(prediction.decisionAtISO)) ?? [];
    entries.push(prediction);
    byDay.set(dayKey(prediction.decisionAtISO), entries);
  }
  const correlations: number[] = [];
  for (const entries of byDay.values()) {
    const correlation = spearman(
      entries.map((entry) => entry.baselineScore),
      entries.map((entry) => entry.shadowScore!),
    );
    if (correlation != null) correlations.push(correlation);
  }
  const average = mean(correlations);
  return average == null ? null : round(average, 4);
}

/**
 * Evaluate shadow predictions with return, calibration, coverage,
 * concentration, and stability metrics. It deliberately makes no profitability
 * or tradability claim: costs, slippage, and real execution are outside this
 * research-only product's scope.
 */
export function evaluateLearningPredictions(
  predictions: readonly LearningPrediction[],
  policy: LearningEvaluationPolicy = DEFAULT_LEARNING_EVALUATION_POLICY,
): LearningEvaluation {
  if (!Number.isInteger(policy.topNPerDecisionDay) || policy.topNPerDecisionDay < 1) {
    throw new Error("topNPerDecisionDay must be a positive integer.");
  }
  if (!Number.isInteger(policy.calibrationBins) || policy.calibrationBins < 1) {
    throw new Error("calibrationBins must be a positive integer.");
  }
  if (!Number.isFinite(policy.positiveReturnThreshold)) {
    throw new Error("positiveReturnThreshold must be finite.");
  }
  const scored = predictions.filter(
    (prediction) => prediction.shadowScore != null && Number.isFinite(prediction.shadowScore),
  );
  const selected = selectedPredictions(scored, policy);
  const labeledCount = predictions.filter(
    (prediction) => prediction.forwardReturn != null && Number.isFinite(prediction.forwardReturn),
  ).length;
  const selectedLabeled = selected.filter(
    (prediction) => prediction.forwardReturn != null && Number.isFinite(prediction.forwardReturn),
  );
  const returns = selectedLabeled.map((prediction) => prediction.forwardReturn!);
  const wins = returns.filter((value) => value > policy.positiveReturnThreshold);
  const losses = returns.filter((value) => value <= policy.positiveReturnThreshold);
  const winRate = returns.length > 0 ? wins.length / returns.length : null;
  const averageWin = mean(wins);
  const averageLoss = mean(losses);
  const expectancy =
    winRate != null
      ? winRate * (averageWin ?? 0) + (1 - winRate) * (averageLoss ?? 0)
      : null;
  const calibration = calibrationMetrics(scored, policy);
  const calibratedPredictions = scored.filter(
    (prediction) =>
      prediction.successProbability != null &&
      Number.isFinite(prediction.successProbability) &&
      prediction.successProbability >= 0 &&
      prediction.successProbability <= 1,
  ).length;

  return {
    totalPredictions: predictions.length,
    scoredPredictions: scored.length,
    calibratedPredictions,
    labelCoverage: predictions.length === 0 ? 0 : round(labeledCount / predictions.length, 4),
    selectedCount: selected.length,
    selectedLabelCoverage: selected.length === 0 ? 0 : round(selectedLabeled.length / selected.length, 4),
    selectedHitRate: winRate == null ? null : round(winRate, 4),
    selectedMeanReturn: mean(returns) == null ? null : round(mean(returns)!, 5),
    selectedExpectancy: expectancy == null ? null : round(expectancy, 5),
    ...calibration,
    sectorConcentration: concentration(selected.map((prediction) => prediction.sector)),
    capConcentration: concentration(selected.map((prediction) => prediction.capCohort)),
    rankStabilityAgainstBaseline: rankStability(scored),
  };
}
