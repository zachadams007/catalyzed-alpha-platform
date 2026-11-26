import {
  validatePointInTimeRow,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type RealizedOutcomeLabel,
} from "@/engine/learningDataset";
import type { VerifiedLearningOutcomeArtifact } from "@/engine/learningOutcomeArtifact";

export const LEARNING_OUTCOME_FEEDBACK_SCHEMA_VERSION = 1 as const;

/**
 * A separately captured, append-only outcome observation. The caller owns the
 * durable source bytes; this pure reducer only admits an exact, calendar-valid
 * label and refuses conflicting rewrites.
 */
export interface LearningOutcomeFeedback {
  schemaVersion: typeof LEARNING_OUTCOME_FEEDBACK_SCHEMA_VERSION;
  feedbackId: string;
  rowId: string;
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  label: RealizedOutcomeLabel;
}

export interface LearningOutcomeFeedbackResult {
  rows: readonly PointInTimeFeatureRow[];
  appliedFeedbackIds: readonly string[];
  idempotentFeedbackIds: readonly string[];
}

export interface LearningOutcomeEvidenceRegistry {
  /** Entries must come from the digest-recomputing outcome-artifact bridge. */
  readonly verifiedOutcomeArtifacts: readonly VerifiedLearningOutcomeArtifact[];
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function sameLabel(left: RealizedOutcomeLabel, right: RealizedOutcomeLabel): boolean {
  return (
    left.horizonDays === right.horizonDays &&
    left.forwardReturn === right.forwardReturn &&
    Date.parse(left.horizonCloseAtISO) === Date.parse(right.horizonCloseAtISO) &&
    Date.parse(left.observedAtISO) === Date.parse(right.observedAtISO)
  );
}

function cloneRow(row: PointInTimeFeatureRow): PointInTimeFeatureRow {
  return {
    ...row,
    features: Object.fromEntries(
      Object.entries(row.features).map(([name, feature]) => [name, { ...feature }]),
    ),
    label: row.label ? { ...row.label } : undefined,
  };
}

function freezeRow(row: PointInTimeFeatureRow): PointInTimeFeatureRow {
  const features = Object.freeze(
    Object.fromEntries(
      Object.entries(row.features).map(([name, feature]) => [name, Object.freeze({ ...feature })]),
    ),
  );
  const label = row.label ? Object.freeze({ ...row.label }) : undefined;
  return Object.freeze({ ...row, features, label });
}

/**
 * Apply outcome observations without mutating source rows. Exact retries are
 * idempotent; a second value for the same row is a fatal provenance conflict.
 */
export function applyLearningOutcomeFeedback(
  sourceRows: readonly PointInTimeFeatureRow[],
  feedback: readonly LearningOutcomeFeedback[],
  evidence: PointInTimeEvidenceRegistry,
  outcomeEvidence: LearningOutcomeEvidenceRegistry,
): LearningOutcomeFeedbackResult {
  const rows = sourceRows.map(cloneRow);
  const rowIndexes = new Map<string, number>();
  rows.forEach((row, index) => {
    if (rowIndexes.has(row.rowId)) {
      throw new Error(`Duplicate learning rowId '${row.rowId}'.`);
    }
    rowIndexes.set(row.rowId, index);
  });

  const feedbackById = new Map<string, LearningOutcomeFeedback>();
  for (const observation of feedback) {
    if (observation.schemaVersion !== LEARNING_OUTCOME_FEEDBACK_SCHEMA_VERSION) {
      throw new Error(`Unsupported outcome-feedback schema ${observation.schemaVersion}.`);
    }
    if (!observation.feedbackId.trim()) throw new Error("Outcome feedbackId is required.");
    if (!observation.sourceArtifactId.trim() || !validSha256(observation.sourceArtifactSha256)) {
      throw new Error("Outcome feedback requires a source artifact ID and SHA-256.");
    }
    const prior = feedbackById.get(observation.feedbackId);
    if (
      prior &&
      (
        prior.rowId !== observation.rowId ||
        prior.sourceArtifactId !== observation.sourceArtifactId ||
        prior.sourceArtifactSha256 !== observation.sourceArtifactSha256 ||
        !sameLabel(prior.label, observation.label)
      )
    ) {
      throw new Error(`Conflicting bytes for outcome feedback '${observation.feedbackId}'.`);
    }
    feedbackById.set(observation.feedbackId, observation);
  }

  const appliedFeedbackIds: string[] = [];
  const idempotentFeedbackIds: string[] = [];
  for (const observation of feedbackById.values()) {
    const sourceArtifacts = outcomeEvidence.verifiedOutcomeArtifacts.filter(
      (artifact) => artifact.artifactId === observation.sourceArtifactId,
    );
    if (sourceArtifacts.length !== 1) {
      throw new Error(
        `Outcome feedback '${observation.feedbackId}' requires exactly one independently verified source artifact.`,
      );
    }
    const sourceArtifact = sourceArtifacts[0]!;
    if (sourceArtifact.artifactSha256 !== observation.sourceArtifactSha256) {
      throw new Error(
        `Outcome feedback '${observation.feedbackId}' source artifact digest does not match admitted bytes.`,
      );
    }
    const sourceObservations = sourceArtifact.observations.filter(
      (entry) => entry.feedbackId === observation.feedbackId,
    );
    if (
      sourceObservations.length !== 1 ||
      sourceObservations[0]!.rowId !== observation.rowId ||
      !sameLabel(sourceObservations[0]!.label, observation.label)
    ) {
      throw new Error(
        `Outcome feedback '${observation.feedbackId}' does not exactly match its admitted source artifact.`,
      );
    }
    const index = rowIndexes.get(observation.rowId);
    if (index == null) {
      throw new Error(`Outcome feedback references unknown row '${observation.rowId}'.`);
    }
    const row = rows[index]!;
    if (row.label) {
      if (!sameLabel(row.label, observation.label)) {
        throw new Error(`Outcome feedback conflicts with the existing label for '${row.rowId}'.`);
      }
      const validation = validatePointInTimeRow(row, evidence);
      if (!validation.valid) {
        throw new Error(
          `Existing outcome label for '${row.rowId}' is not admissible: ${validation.errors.join(" ")}`,
        );
      }
      idempotentFeedbackIds.push(observation.feedbackId);
      continue;
    }
    const updated = { ...row, label: { ...observation.label } };
    const validation = validatePointInTimeRow(updated, evidence);
    if (!validation.valid) {
      throw new Error(
        `Outcome feedback for '${row.rowId}' is not admissible: ${validation.errors.join(" ")}`,
      );
    }
    rows[index] = updated;
    appliedFeedbackIds.push(observation.feedbackId);
  }

  return {
    rows: Object.freeze(rows.map(freezeRow)),
    appliedFeedbackIds: Object.freeze(appliedFeedbackIds),
    idempotentFeedbackIds: Object.freeze(idempotentFeedbackIds),
  };
}
