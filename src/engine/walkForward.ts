import {
  trainableRows,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "./learningDataset";

/** A chronological train/retrain/test partition with a non-overlapping out-of-sample test window. */
export interface WalkForwardFold {
  readonly index: number;
  readonly trainEndISO: string;
  readonly testStartISO: string;
  readonly testEndISO: string;
  readonly trainRows: readonly PointInTimeFeatureRow[];
  readonly testRows: readonly PointInTimeFeatureRow[];
}
export interface WalkForwardConfig {
  /** Distinct decision days required before the first retrain point. */
  minTrainingDecisionDays: number;
  /** Number of eligible decision days evaluated in each out-of-sample fold. */
  testDecisionDays: number;
  /** Decision-day gap between retraining points. */
  stepDecisionDays: number;
  /** Extra decision days skipped after training to limit overlapping-label leakage. */
  embargoDecisionDays: number;
}

export const DEFAULT_WALK_FORWARD_CONFIG: WalkForwardConfig = {
  minTrainingDecisionDays: 60,
  testDecisionDays: 20,
  stepDecisionDays: 20,
  embargoDecisionDays: 5,
};

function decisionDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

function uniqueDecisionDays(rows: readonly PointInTimeFeatureRow[]): string[] {
  return [...new Set(rows.map((row) => decisionDay(row.decisionAtISO)))].sort();
}

function assertConfig(config: WalkForwardConfig): void {
  const values = Object.values(config);
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Walk-forward configuration values must be non-negative integers.");
  }
  if (config.minTrainingDecisionDays < 1 || config.testDecisionDays < 1 || config.stepDecisionDays < 1) {
    throw new Error("Walk-forward training, test, and step windows must be at least one decision day.");
  }
  if (config.stepDecisionDays < config.testDecisionDays) {
    throw new Error("stepDecisionDays must be at least testDecisionDays so out-of-sample windows do not overlap.");
  }
}

/**
 * Build leakage-safe chronological folds. A training row is included only when
 * its realized label was observable by the retrain cutoff, not simply because
 * its decision date is before that cutoff. The post-train embargo prevents
 * labels that overlap the boundary from leaking into the immediate test period.
 */
export function buildWalkForwardFolds(
  sourceRows: readonly PointInTimeFeatureRow[],
  universeManifests: readonly PointInTimeUniverseManifest[],
  evidence: PointInTimeEvidenceRegistry,
  config: WalkForwardConfig = DEFAULT_WALK_FORWARD_CONFIG,
): readonly WalkForwardFold[] {
  assertConfig(config);
  const rows = trainableRows(sourceRows, universeManifests, evidence);
  const days = uniqueDecisionDays(rows);
  const folds: WalkForwardFold[] = [];

  for (
    let trainEndIndex = config.minTrainingDecisionDays - 1;
    trainEndIndex < days.length;
    trainEndIndex += config.stepDecisionDays
  ) {
    const testStartIndex = trainEndIndex + 1 + config.embargoDecisionDays;
    const testEndIndex = testStartIndex + config.testDecisionDays - 1;
    if (testEndIndex >= days.length) break;

    const trainEndDay = days[trainEndIndex]!;
    const testStartDay = days[testStartIndex]!;
    const testEndDay = days[testEndIndex]!;
    const trainCutoffISO = `${trainEndDay}T23:59:59.999Z`;
    const trainRows = Object.freeze(
      rows.filter(
        (row) =>
          decisionDay(row.decisionAtISO) <= trainEndDay &&
          row.label != null &&
          Date.parse(row.label.observedAtISO) <= Date.parse(trainCutoffISO),
      ),
    );
    const testRows = Object.freeze(
      rows.filter((row) => {
        const day = decisionDay(row.decisionAtISO);
        return day >= testStartDay && day <= testEndDay;
      }),
    );
    if (trainRows.length === 0 || testRows.length === 0) continue;

    const trainIds = new Set(trainRows.map((row) => row.rowId));
    if (testRows.some((row) => trainIds.has(row.rowId))) {
      throw new Error("Walk-forward fold reuses a row in both train and test sets.");
    }

    folds.push(Object.freeze({
      index: folds.length,
      trainEndISO: trainCutoffISO,
      testStartISO: `${testStartDay}T00:00:00.000Z`,
      testEndISO: `${testEndDay}T23:59:59.999Z`,
      trainRows,
      testRows,
    }));
  }

  return Object.freeze(folds);
}
