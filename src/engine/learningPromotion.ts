import {
  admissionBlockers,
  type AdmissionEvidence,
  type VerifiedAdmissionRecord,
} from "@/engine/learningAdmission";
import {
  ledgerSplitBlockers,
  validateLearningConfigLedger,
  type LearningConfigLedger,
} from "@/engine/learningConfigLedger";
import {
  auditPointInTimeDataset,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "@/engine/learningDataset";
import {
  DEFAULT_LEARNING_EVALUATION_POLICY,
  evaluateLearningPredictions,
  type LearningEvaluation,
  type LearningEvaluationPolicy,
  type LearningPrediction,
} from "@/engine/learningEvaluation";
import {
  assessLearningDrift,
  type DriftAssessment,
  type DriftInput,
} from "@/engine/learningGuardrails";
import { spearman } from "@/engine/outcomeEval";
import {
  buildWalkForwardFolds,
  type WalkForwardConfig,
  type WalkForwardFold,
} from "@/engine/walkForward";
import { round } from "@/lib/math";

export const LEARNING_PROMOTION_REPORT_SCHEMA_VERSION = 3 as const;

export interface LearningEvaluationSplit {
  splitId: string;
  candidateId: string;
  frozenAtISO: string;
  modelSelectedAtISO: string;
  holdoutStartISO: string;
  holdoutEndISO: string;
  /** Frozen candidate training cutoff shared by every final-holdout prediction. */
  holdoutModelTrainedThroughISO: string;
  attemptedConfigurationIds: readonly string[];
}

export interface LearningPromotionPolicy {
  minWalkForwardFolds: number;
  minHoldoutDecisionDays: number;
  minHoldoutFraction: number;
  minLabelCoverage: number;
  minSelectedLabelCoverage: number;
  minRankICDelta: number;
  minMeanReturnDelta: number;
  minExpectancyDelta: number;
  maxBrierScore: number;
  maxExpectedCalibrationError: number;
  maxSectorShare: number;
  maxCapShare: number;
  minRankStabilityAgainstBaseline: number;
}

export const DEFAULT_LEARNING_PROMOTION_POLICY: LearningPromotionPolicy = {
  minWalkForwardFolds: 3,
  minHoldoutDecisionDays: 20,
  minHoldoutFraction: 0.2,
  minLabelCoverage: 0.9,
  minSelectedLabelCoverage: 0.9,
  minRankICDelta: 0,
  minMeanReturnDelta: 0,
  minExpectancyDelta: 0,
  maxBrierScore: 0.25,
  maxExpectedCalibrationError: 0.1,
  maxSectorShare: 0.5,
  maxCapShare: 0.6,
  minRankStabilityAgainstBaseline: 0.25,
};

export type LearningEvaluationSlice =
  | { kind: "walk_forward"; foldIndex: number; trainedThroughISO: string }
  | { kind: "holdout"; trainedThroughISO: string };

export interface OfflineLearningPrediction extends LearningPrediction {
  candidateId: string;
  slice: LearningEvaluationSlice;
}

export interface LearningPromotionInput {
  reportAsOfISO: string;
  rows: readonly PointInTimeFeatureRow[];
  manifests: readonly PointInTimeUniverseManifest[];
  evidence: PointInTimeEvidenceRegistry;
  predictions: readonly OfflineLearningPrediction[];
  split: LearningEvaluationSplit;
  walkForwardConfig: WalkForwardConfig;
  drift: DriftInput;
  evaluationPolicy?: LearningEvaluationPolicy;
  promotionPolicy?: LearningPromotionPolicy;
  /**
   * Independently timestamped admission evidence for the feature rows,
   * market calendar, frozen split, predictions, and configuration ledger.
   * Absent or invalid evidence fails closed with the canonical blocker.
   */
  admission?: AdmissionEvidence;
  /** The registered attempted-configuration ledger backing the split. */
  configurationLedger?: LearningConfigLedger;
}

export interface RankICComparison {
  candidate: number | null;
  baseline: number | null;
  delta: number | null;
  cohorts: number;
}

export interface LearningPromotionVerdict {
  status: "blocked" | "rejected" | "eligible_for_manual_review";
  automaticPromotion: false;
  productionMutationAllowed: false;
  blockers: string[];
  failedGates: string[];
}

export interface LearningPromotionReport {
  schemaVersion: typeof LEARNING_PROMOTION_REPORT_SCHEMA_VERSION;
  reportAsOfISO: string;
  split: LearningEvaluationSplit;
  policy: LearningPromotionPolicy;
  dataset: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    coverageValid: boolean;
    universeCount: number;
  };
  walkForward: {
    folds: number;
    foldRows: { index: number; trainRows: number; testRows: number }[];
    evaluation: LearningEvaluation;
    baseline: LearningEvaluation;
    rankIC: RankICComparison;
  };
  holdout: {
    decisionDays: number;
    fractionOfAllDecisionDays: number;
    candidate: LearningEvaluation;
    baseline: LearningEvaluation;
    rankIC: RankICComparison;
  };
  drift: DriftAssessment;
  admission: {
    verified: boolean;
    records: VerifiedAdmissionRecord[];
  };
  verdict: LearningPromotionVerdict;
  production: {
    publishedScorerChanged: false;
    publishedOrderChanged: false;
    orderExecutionPathAdded: false;
  };
}

function parseISO(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayKey(value: string): string {
  const parsed = parseISO(value);
  return parsed == null ? "" : new Date(parsed).toISOString().slice(0, 10);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rankIC(predictions: readonly LearningPrediction[], score: "baseline" | "candidate"): {
  value: number | null;
  cohorts: number;
} {
  const byDay = new Map<string, LearningPrediction[]>();
  for (const prediction of predictions) {
    if (prediction.forwardReturn == null || !Number.isFinite(prediction.forwardReturn)) continue;
    const scoreValue = score === "baseline" ? prediction.baselineScore : prediction.shadowScore;
    if (scoreValue == null || !Number.isFinite(scoreValue)) continue;
    const entries = byDay.get(dayKey(prediction.decisionAtISO)) ?? [];
    entries.push(prediction);
    byDay.set(dayKey(prediction.decisionAtISO), entries);
  }
  const values: number[] = [];
  for (const entries of byDay.values()) {
    if (entries.length < 2) continue;
    const correlation = spearman(
      entries.map((entry) => score === "baseline" ? entry.baselineScore : entry.shadowScore!),
      entries.map((entry) => entry.forwardReturn!),
    );
    if (correlation != null) values.push(correlation);
  }
  const average = mean(values);
  return { value: average == null ? null : round(average, 5), cohorts: values.length };
}

function baselinePredictions(predictions: readonly LearningPrediction[]): LearningPrediction[] {
  return predictions.map((prediction) => ({
    ...prediction,
    shadowScore: prediction.baselineScore,
    successProbability: null,
  }));
}

function validatePromotionPolicy(policy: LearningPromotionPolicy): void {
  const integerFields = [policy.minWalkForwardFolds, policy.minHoldoutDecisionDays];
  if (integerFields.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error("Promotion fold/day minimums must be positive integers.");
  }
  const unitFields = [
    policy.minHoldoutFraction,
    policy.minLabelCoverage,
    policy.minSelectedLabelCoverage,
    policy.maxBrierScore,
    policy.maxExpectedCalibrationError,
    policy.maxSectorShare,
    policy.maxCapShare,
    policy.minRankStabilityAgainstBaseline,
  ];
  if (unitFields.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Promotion probability/share thresholds must be finite values in [0, 1].");
  }
  const deltaFields = [
    policy.minRankICDelta,
    policy.minMeanReturnDelta,
    policy.minExpectancyDelta,
  ];
  if (deltaFields.some((value) => !Number.isFinite(value))) {
    throw new Error("Promotion delta thresholds must be finite.");
  }
}

function splitBlockers(
  split: LearningEvaluationSplit,
  reportAsOfISO: string,
  allDecisionDays: readonly string[],
  policy: LearningPromotionPolicy,
): { blockers: string[]; holdoutDays: string[]; holdoutFraction: number } {
  const blockers: string[] = [];
  const frozenMs = parseISO(split.frozenAtISO);
  const selectedMs = parseISO(split.modelSelectedAtISO);
  const startMs = parseISO(split.holdoutStartISO);
  const endMs = parseISO(split.holdoutEndISO);
  const holdoutTrainedThroughMs = parseISO(split.holdoutModelTrainedThroughISO);
  const reportMs = parseISO(reportAsOfISO);
  if (!split.splitId.trim() || !split.candidateId.trim()) blockers.push("Split and candidate IDs are required.");
  if (
    [frozenMs, selectedMs, startMs, endMs, holdoutTrainedThroughMs, reportMs].some(
      (value) => value == null,
    )
  ) {
    blockers.push("Split and report timestamps must be valid ISO instants.");
  } else {
    if (frozenMs! > selectedMs!) blockers.push("Final holdout was not frozen before model selection.");
    if (frozenMs! >= startMs!) {
      blockers.push("Final holdout must be frozen strictly before the holdout begins.");
    }
    if (selectedMs! >= startMs!) {
      blockers.push("Model selection must finish strictly before the final holdout begins.");
    }
    if (selectedMs! > reportMs!) blockers.push("Model selection occurs after the report as-of time.");
    if (startMs! > endMs!) blockers.push("Holdout start is after holdout end.");
    if (endMs! > reportMs!) blockers.push("Report as-of time occurs before the final holdout ends.");
    if (holdoutTrainedThroughMs! >= startMs!) {
      blockers.push("Final-holdout model training cutoff must be strictly before the holdout.");
    }
    if (holdoutTrainedThroughMs! > selectedMs!) {
      blockers.push("Model selection occurs before the final-holdout training cutoff.");
    }
  }
  const attempted = new Set(split.attemptedConfigurationIds);
  if (attempted.size !== split.attemptedConfigurationIds.length || attempted.size === 0) {
    blockers.push("Attempted configuration IDs must be a non-empty unique set.");
  }
  if (!attempted.has(split.candidateId)) {
    blockers.push("Candidate ID is missing from the attempted-configuration ledger.");
  }
  const holdoutDays =
    startMs == null || endMs == null
      ? []
      : allDecisionDays.filter(
          (day) => day >= dayKey(split.holdoutStartISO) && day <= dayKey(split.holdoutEndISO),
        );
  if (
    allDecisionDays.length > 0 &&
    dayKey(split.holdoutEndISO) !== allDecisionDays[allDecisionDays.length - 1]
  ) {
    blockers.push("Final holdout must end on the last available decision day.");
  }
  const holdoutFraction = allDecisionDays.length === 0 ? 0 : holdoutDays.length / allDecisionDays.length;
  if (holdoutDays.length < policy.minHoldoutDecisionDays) {
    blockers.push(
      `Final holdout has ${holdoutDays.length} decision days; requires ${policy.minHoldoutDecisionDays}.`,
    );
  }
  if (holdoutFraction < policy.minHoldoutFraction) {
    blockers.push(
      `Final holdout is ${(holdoutFraction * 100).toFixed(1)}% of decision days; requires at least ${(policy.minHoldoutFraction * 100).toFixed(1)}%.`,
    );
  }
  return { blockers, holdoutDays, holdoutFraction };
}

function predictionBlockers(
  predictions: readonly OfflineLearningPrediction[],
  split: LearningEvaluationSplit,
  rowById: ReadonlyMap<string, PointInTimeFeatureRow>,
  folds: readonly WalkForwardFold[],
  holdoutIds: ReadonlySet<string>,
  reportAsOfISO: string,
): string[] {
  const blockers: string[] = [];
  const predictionIds = new Set<string>();
  const expectedWalkForward = new Map<string, WalkForwardFold>();
  for (const fold of folds) {
    for (const row of fold.testRows) expectedWalkForward.set(row.rowId, fold);
  }
  const expectedIds = new Set([...expectedWalkForward.keys(), ...holdoutIds]);
  for (const prediction of predictions) {
    if (predictionIds.has(prediction.rowId)) blockers.push(`Duplicate prediction for '${prediction.rowId}'.`);
    predictionIds.add(prediction.rowId);
    const row = rowById.get(prediction.rowId);
    if (!row) {
      blockers.push(`Prediction references unknown row '${prediction.rowId}'.`);
      continue;
    }
    if (prediction.candidateId !== split.candidateId) {
      blockers.push(`Prediction '${prediction.rowId}' uses the wrong candidate ID.`);
    }
    if (prediction.shadowScore == null || !Number.isFinite(prediction.shadowScore)) {
      blockers.push(`Prediction '${prediction.rowId}' is missing a finite shadow score.`);
    }
    if (
      prediction.successProbability == null ||
      !Number.isFinite(prediction.successProbability) ||
      prediction.successProbability < 0 ||
      prediction.successProbability > 1
    ) {
      blockers.push(`Prediction '${prediction.rowId}' is missing a valid success probability.`);
    }
    if (
      prediction.ticker !== row.ticker ||
      parseISO(prediction.decisionAtISO) !== parseISO(row.decisionAtISO) ||
      prediction.sector !== row.sector ||
      prediction.capCohort !== row.capCohort ||
      prediction.baselineScore !== row.baselineScore
    ) {
      blockers.push(`Prediction '${prediction.rowId}' does not match its immutable row.`);
    }
    const labelObservable =
      row.label != null && Date.parse(row.label.observedAtISO) <= Date.parse(reportAsOfISO);
    const expectedReturn = labelObservable ? row.label!.forwardReturn : null;
    if (prediction.forwardReturn !== expectedReturn) {
      blockers.push(`Prediction '${prediction.rowId}' has a mismatched or prematurely visible label.`);
    }
    const fold = expectedWalkForward.get(prediction.rowId);
    if (prediction.slice.kind === "walk_forward") {
      if (!fold || prediction.slice.foldIndex !== fold.index) {
        blockers.push(`Prediction '${prediction.rowId}' is assigned to the wrong walk-forward fold.`);
      } else if (parseISO(prediction.slice.trainedThroughISO) !== parseISO(fold.trainEndISO)) {
        blockers.push(`Prediction '${prediction.rowId}' has an invalid training cutoff.`);
      }
    } else {
      if (!holdoutIds.has(prediction.rowId)) {
        blockers.push(`Prediction '${prediction.rowId}' is not in the frozen holdout.`);
      }
      if (
        parseISO(prediction.slice.trainedThroughISO) !==
        parseISO(split.holdoutModelTrainedThroughISO)
      ) {
        blockers.push(`Holdout prediction '${prediction.rowId}' does not use the frozen model cutoff.`);
      }
    }
  }
  for (const rowId of expectedIds) {
    if (!predictionIds.has(rowId)) blockers.push(`Missing required out-of-sample prediction for '${rowId}'.`);
  }
  for (const rowId of predictionIds) {
    if (!expectedIds.has(rowId)) blockers.push(`Prediction '${rowId}' is outside all evaluation slices.`);
  }
  return blockers;
}

function metricBlockers(
  evaluation: LearningEvaluation,
  rankComparison: RankICComparison,
  sliceName: string,
): string[] {
  const blockers: string[] = [];
  if (evaluation.totalPredictions === 0) blockers.push(`${sliceName} has no predictions.`);
  if (evaluation.scoredPredictions !== evaluation.totalPredictions) {
    blockers.push(`${sliceName} does not have a finite score for every prediction.`);
  }
  if (evaluation.calibratedPredictions !== evaluation.scoredPredictions) {
    blockers.push(`${sliceName} does not have a valid probability for every scored prediction.`);
  }
  if (evaluation.selectedCount === 0) blockers.push(`${sliceName} selects no candidates.`);
  if (evaluation.selectedMeanReturn == null || evaluation.selectedExpectancy == null) {
    blockers.push(`${sliceName} return and expectancy metrics are incomplete.`);
  }
  if (evaluation.brierScore == null || evaluation.expectedCalibrationError == null) {
    blockers.push(`${sliceName} calibration metrics are incomplete.`);
  }
  if (evaluation.sectorConcentration == null || evaluation.capConcentration == null) {
    blockers.push(`${sliceName} concentration metrics are incomplete.`);
  }
  if (evaluation.rankStabilityAgainstBaseline == null) {
    blockers.push(`${sliceName} rank-stability metric is incomplete.`);
  }
  if (rankComparison.candidate == null || rankComparison.baseline == null || rankComparison.delta == null) {
    blockers.push(`${sliceName} rank-IC comparison is incomplete.`);
  }
  return blockers;
}

function failedPerformanceGates(
  candidate: LearningEvaluation,
  baseline: LearningEvaluation,
  rankComparison: RankICComparison,
  policy: LearningPromotionPolicy,
): string[] {
  const failures: string[] = [];
  if (candidate.labelCoverage < policy.minLabelCoverage) failures.push("Label coverage is below policy.");
  if (candidate.selectedLabelCoverage < policy.minSelectedLabelCoverage) {
    failures.push("Selected-label coverage is below policy.");
  }
  if (rankComparison.delta != null && rankComparison.delta < policy.minRankICDelta) {
    failures.push("Rank-IC delta is below policy.");
  }
  if (
    candidate.selectedMeanReturn != null &&
    baseline.selectedMeanReturn != null &&
    candidate.selectedMeanReturn - baseline.selectedMeanReturn < policy.minMeanReturnDelta
  ) {
    failures.push("Selected mean-return delta is below policy.");
  }
  if (
    candidate.selectedExpectancy != null &&
    baseline.selectedExpectancy != null &&
    candidate.selectedExpectancy - baseline.selectedExpectancy < policy.minExpectancyDelta
  ) {
    failures.push("Selected expectancy delta is below policy.");
  }
  if (candidate.brierScore != null && candidate.brierScore > policy.maxBrierScore) {
    failures.push("Brier score exceeds policy.");
  }
  if (
    candidate.expectedCalibrationError != null &&
    candidate.expectedCalibrationError > policy.maxExpectedCalibrationError
  ) {
    failures.push("Expected calibration error exceeds policy.");
  }
  if (
    candidate.sectorConcentration != null &&
    candidate.sectorConcentration.maxShare > policy.maxSectorShare
  ) {
    failures.push("Sector concentration exceeds policy.");
  }
  if (
    candidate.capConcentration != null &&
    candidate.capConcentration.maxShare > policy.maxCapShare
  ) {
    failures.push("Cap-cohort concentration exceeds policy.");
  }
  if (
    candidate.rankStabilityAgainstBaseline != null &&
    candidate.rankStabilityAgainstBaseline < policy.minRankStabilityAgainstBaseline
  ) {
    failures.push("Rank stability versus baseline is below policy.");
  }
  return failures;
}

/**
 * Produce a deterministic, machine-readable review verdict. This function can
 * never activate a model or alter the published scorer; even a passing report
 * is only eligible for an independent root-owned review.
 */
export function evaluateLearningPromotion(input: LearningPromotionInput): LearningPromotionReport {
  const policy = input.promotionPolicy ?? DEFAULT_LEARNING_PROMOTION_POLICY;
  const evaluationPolicy = input.evaluationPolicy ?? DEFAULT_LEARNING_EVALUATION_POLICY;
  validatePromotionPolicy(policy);
  const dataset = auditPointInTimeDataset(input.rows, input.manifests, input.evidence);
  const validRows = input.rows.filter((_, index) => dataset.validations[index]!.valid);
  const rowById = new Map<string, PointInTimeFeatureRow>();
  const blockers: string[] = [];
  if (!input.evaluationPolicy) {
    blockers.push("An explicit pre-registered evaluation policy is required.");
  }
  if (!input.promotionPolicy) {
    blockers.push("An explicit pre-registered promotion policy is required.");
  }
  for (const row of validRows) {
    if (rowById.has(row.rowId)) blockers.push(`Duplicate valid rowId '${row.rowId}'.`);
    rowById.set(row.rowId, row);
  }
  if (!dataset.coverageValid || dataset.invalidRows > 0) {
    blockers.push("Dataset provenance or full-universe coverage is invalid.");
  }

  const allDecisionDays = [...new Set(validRows.map((row) => dayKey(row.decisionAtISO)))].filter(Boolean).sort();
  const split = splitBlockers(input.split, input.reportAsOfISO, allDecisionDays, policy);
  blockers.push(...split.blockers);
  const holdoutDaySet = new Set(split.holdoutDays);
  const holdoutStartDay = dayKey(input.split.holdoutStartISO);
  const developmentRows = validRows.filter((row) => dayKey(row.decisionAtISO) < holdoutStartDay);
  const holdoutRows = validRows.filter((row) => holdoutDaySet.has(dayKey(row.decisionAtISO)));
  const developmentIds = new Set(developmentRows.map((row) => row.universeId));
  const developmentManifests = input.manifests.filter((manifest) => developmentIds.has(manifest.universeId));
  const folds = buildWalkForwardFolds(
    developmentRows,
    developmentManifests,
    input.evidence,
    input.walkForwardConfig,
  );
  if (folds.length < policy.minWalkForwardFolds) {
    blockers.push(`Walk-forward produced ${folds.length} folds; requires ${policy.minWalkForwardFolds}.`);
  }
  // Independently timestamped admission: the split and configuration ledger
  // must be attested strictly before the holdout begins, and the prediction
  // commitment before any holdout label became observable. Absent evidence
  // fails closed with the canonical blocker.
  const holdoutLabelObservations = holdoutRows
    .filter((row) => row.label != null)
    .map((row) => Date.parse(row.label!.observedAtISO))
    .filter((ms) => Number.isFinite(ms));
  const earliestHoldoutLabelObservedAtISO =
    holdoutLabelObservations.length === 0
      ? null
      : new Date(Math.min(...holdoutLabelObservations)).toISOString();
  blockers.push(
    ...admissionBlockers(input.admission, {
      holdoutStartISO: input.split.holdoutStartISO,
      earliestHoldoutLabelObservedAtISO,
      reportAsOfISO: input.reportAsOfISO,
    }),
  );
  let verifiedLedger: LearningConfigLedger | null = null;
  if (input.configurationLedger == null) {
    blockers.push("A registered attempted-configuration ledger is required.");
  } else {
    try {
      verifiedLedger = validateLearningConfigLedger(input.configurationLedger);
      blockers.push(...ledgerSplitBlockers(verifiedLedger, input.split));
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : "Configuration ledger validation failed.");
    }
  }

  const holdoutIds = new Set(holdoutRows.map((row) => row.rowId));
  blockers.push(
    ...predictionBlockers(
      input.predictions,
      input.split,
      rowById,
      folds,
      holdoutIds,
      input.reportAsOfISO,
    ),
  );

  const walkForwardPredictions = input.predictions.filter(
    (prediction) => prediction.slice.kind === "walk_forward",
  );
  const holdoutPredictions = input.predictions.filter(
    (prediction) => prediction.slice.kind === "holdout",
  );
  const walkForwardEvaluation = evaluateLearningPredictions(walkForwardPredictions, evaluationPolicy);
  const walkForwardBaselineEvaluation = evaluateLearningPredictions(
    baselinePredictions(walkForwardPredictions),
    evaluationPolicy,
  );
  const holdoutEvaluation = evaluateLearningPredictions(holdoutPredictions, evaluationPolicy);
  const baselineEvaluation = evaluateLearningPredictions(
    baselinePredictions(holdoutPredictions),
    evaluationPolicy,
  );
  const candidateRank = rankIC(holdoutPredictions, "candidate");
  const baselineRank = rankIC(holdoutPredictions, "baseline");
  const rankComparison: RankICComparison = {
    candidate: candidateRank.value,
    baseline: baselineRank.value,
    delta:
      candidateRank.value == null || baselineRank.value == null
        ? null
        : round(candidateRank.value - baselineRank.value, 5),
    cohorts: Math.min(candidateRank.cohorts, baselineRank.cohorts),
  };
  const walkForwardCandidateRank = rankIC(walkForwardPredictions, "candidate");
  const walkForwardBaselineRank = rankIC(walkForwardPredictions, "baseline");
  const walkForwardRankComparison: RankICComparison = {
    candidate: walkForwardCandidateRank.value,
    baseline: walkForwardBaselineRank.value,
    delta:
      walkForwardCandidateRank.value == null || walkForwardBaselineRank.value == null
        ? null
        : round(walkForwardCandidateRank.value - walkForwardBaselineRank.value, 5),
    cohorts: Math.min(walkForwardCandidateRank.cohorts, walkForwardBaselineRank.cohorts),
  };
  blockers.push(...metricBlockers(walkForwardEvaluation, walkForwardRankComparison, "Walk-forward evaluation"));
  blockers.push(...metricBlockers(holdoutEvaluation, rankComparison, "Final holdout"));
  if (parseISO(input.drift.nowISO) !== parseISO(input.reportAsOfISO)) {
    blockers.push("Drift assessment time must exactly match the report as-of time.");
  }
  if (parseISO(input.drift.trainedAtISO) !== parseISO(input.split.holdoutModelTrainedThroughISO)) {
    blockers.push("Drift model-training time must match the frozen final-holdout model cutoff.");
  }
  const drift = assessLearningDrift(input.drift);
  if (drift.blocked) blockers.push(...drift.reasons.map((reason) => `Drift guard: ${reason}`));
  const uniqueBlockers = [...new Set(blockers)];
  const diagnosticPerformanceFailures = [
    ...failedPerformanceGates(
      walkForwardEvaluation,
      walkForwardBaselineEvaluation,
      walkForwardRankComparison,
      policy,
    ).map((failure) => `Walk-forward: ${failure}`),
    ...failedPerformanceGates(
      holdoutEvaluation,
      baselineEvaluation,
      rankComparison,
      policy,
    ).map((failure) => `Final holdout: ${failure}`),
  ];
  // Performance pass/fail conclusions are not valid while provenance is
  // blocked. The underlying metrics remain visible for debugging only.
  const failedGates = uniqueBlockers.length === 0 ? diagnosticPerformanceFailures : [];
  const status =
    uniqueBlockers.length > 0
      ? "blocked"
      : failedGates.length > 0
        ? "rejected"
        : "eligible_for_manual_review";

  return {
    schemaVersion: LEARNING_PROMOTION_REPORT_SCHEMA_VERSION,
    reportAsOfISO: input.reportAsOfISO,
    split: { ...input.split, attemptedConfigurationIds: [...input.split.attemptedConfigurationIds] },
    policy: { ...policy },
    dataset: {
      totalRows: dataset.totalRows,
      validRows: dataset.validRows,
      invalidRows: dataset.invalidRows,
      coverageValid: dataset.coverageValid,
      universeCount: dataset.uniqueUniverseCount,
    },
    walkForward: {
      folds: folds.length,
      foldRows: folds.map((fold) => ({
        index: fold.index,
        trainRows: fold.trainRows.length,
        testRows: fold.testRows.length,
      })),
      evaluation: walkForwardEvaluation,
      baseline: walkForwardBaselineEvaluation,
      rankIC: walkForwardRankComparison,
    },
    holdout: {
      decisionDays: split.holdoutDays.length,
      fractionOfAllDecisionDays: round(split.holdoutFraction, 4),
      candidate: holdoutEvaluation,
      baseline: baselineEvaluation,
      rankIC: rankComparison,
    },
    drift,
    admission: {
      verified:
        input.admission != null &&
        admissionBlockers(input.admission, {
          holdoutStartISO: input.split.holdoutStartISO,
          earliestHoldoutLabelObservedAtISO,
          reportAsOfISO: input.reportAsOfISO,
        }).length === 0,
      records: input.admission == null ? [] : input.admission.records.map((record) => ({ ...record })),
    },
    verdict: {
      status,
      automaticPromotion: false,
      productionMutationAllowed: false,
      blockers: uniqueBlockers,
      failedGates,
    },
    production: {
      publishedScorerChanged: false,
      publishedOrderChanged: false,
      orderExecutionPathAdded: false,
    },
  };
}
