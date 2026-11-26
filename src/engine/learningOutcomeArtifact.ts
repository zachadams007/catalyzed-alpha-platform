import type { RealizedOutcomeLabel } from "@/engine/learningDataset";

export const LEARNING_OUTCOME_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const LEARNING_OUTCOME_ARTIFACT_TYPE =
  "catalyzed.realized_outcome_observations" as const;

export interface LearningOutcomeArtifactObservation {
  readonly feedbackId: string;
  readonly rowId: string;
  readonly label: RealizedOutcomeLabel;
}

/**
 * Content-addressed bytes captured by the outcome-ingestion boundary. This
 * proves which exact observations were admitted; it does not by itself claim
 * that a provider's market data was economically correct.
 */
export interface LearningOutcomeArtifactPayload {
  readonly schemaVersion: typeof LEARNING_OUTCOME_ARTIFACT_SCHEMA_VERSION;
  readonly artifactType: typeof LEARNING_OUTCOME_ARTIFACT_TYPE;
  readonly sourceDatasetId: string;
  readonly capturedAtISO: string;
  readonly observations: readonly LearningOutcomeArtifactObservation[];
}

export interface LearningOutcomeArtifactEnvelope {
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly payload: LearningOutcomeArtifactPayload;
}

/** Only returned after schema validation and an independent digest recompute. */
export interface VerifiedLearningOutcomeArtifact {
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly sourceDatasetId: string;
  readonly capturedAtISO: string;
  readonly observations: readonly LearningOutcomeArtifactObservation[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid learning-outcome artifact: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  assert(
    actual.length === allowed.length && actual.every((key, index) => key === allowed[index]),
    `${path} has unexpected or missing fields`,
  );
}

function parseISO(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateLabel(value: unknown, path: string): asserts value is RealizedOutcomeLabel {
  assert(isRecord(value), `${path} must be an object`);
  assertExactKeys(
    value,
    ["horizonDays", "forwardReturn", "horizonCloseAtISO", "observedAtISO"],
    path,
  );
  assert(
    Number.isInteger(value.horizonDays) && (value.horizonDays as number) > 0,
    `${path}.horizonDays must be a positive integer`,
  );
  assert(
    typeof value.forwardReturn === "number" && Number.isFinite(value.forwardReturn),
    `${path}.forwardReturn must be finite`,
  );
  const horizonCloseMs = parseISO(value.horizonCloseAtISO);
  const observedMs = parseISO(value.observedAtISO);
  assert(horizonCloseMs != null, `${path}.horizonCloseAtISO must be a valid UTC instant`);
  assert(observedMs != null, `${path}.observedAtISO must be a valid UTC instant`);
  assert(observedMs >= horizonCloseMs, `${path} cannot be observed before its horizon close`);
}

export function validateLearningOutcomePayload(
  value: unknown,
): asserts value is LearningOutcomeArtifactPayload {
  assert(isRecord(value), "payload must be an object");
  assertExactKeys(
    value,
    ["schemaVersion", "artifactType", "sourceDatasetId", "capturedAtISO", "observations"],
    "payload",
  );
  assert(
    value.schemaVersion === LEARNING_OUTCOME_ARTIFACT_SCHEMA_VERSION,
    "schemaVersion is unsupported",
  );
  assert(value.artifactType === LEARNING_OUTCOME_ARTIFACT_TYPE, "artifactType is invalid");
  assert(
    typeof value.sourceDatasetId === "string" && value.sourceDatasetId.trim().length > 0,
    "sourceDatasetId is required",
  );
  const capturedMs = parseISO(value.capturedAtISO);
  assert(capturedMs != null, "capturedAtISO must be a valid UTC instant");
  assert(Array.isArray(value.observations) && value.observations.length > 0, "observations must be non-empty");

  const feedbackIds = new Set<string>();
  const rowIds = new Set<string>();
  let priorFeedbackId = "";
  value.observations.forEach((observation, index) => {
    const path = `observations[${index}]`;
    assert(isRecord(observation), `${path} must be an object`);
    assertExactKeys(observation, ["feedbackId", "rowId", "label"], path);
    assert(
      typeof observation.feedbackId === "string" && observation.feedbackId.trim().length > 0,
      `${path}.feedbackId is required`,
    );
    assert(
      typeof observation.rowId === "string" && observation.rowId.trim().length > 0,
      `${path}.rowId is required`,
    );
    assert(!feedbackIds.has(observation.feedbackId), `${path}.feedbackId is duplicated`);
    assert(!rowIds.has(observation.rowId), `${path}.rowId is duplicated`);
    assert(
      index === 0 || priorFeedbackId.localeCompare(observation.feedbackId) < 0,
      "observations must be sorted by feedbackId",
    );
    validateLabel(observation.label, `${path}.label`);
    assert(
      Date.parse(observation.label.observedAtISO) <= capturedMs,
      `${path} was captured before it became observable`,
    );
    feedbackIds.add(observation.feedbackId);
    rowIds.add(observation.rowId);
    priorFeedbackId = observation.feedbackId;
  });
}

export function validateLearningOutcomeEnvelope(
  value: unknown,
  recomputedSha256: string,
): asserts value is LearningOutcomeArtifactEnvelope {
  assert(isRecord(value), "envelope must be an object");
  assertExactKeys(value, ["artifactId", "artifactSha256", "payload"], "envelope");
  assert(
    typeof value.artifactSha256 === "string" && /^[0-9a-f]{64}$/.test(value.artifactSha256),
    "artifactSha256 is invalid",
  );
  assert(value.artifactId === `sha256:${value.artifactSha256}`, "artifactId does not match artifactSha256");
  assert(value.artifactSha256 === recomputedSha256.toLowerCase(), "artifact digest verification failed");
  validateLearningOutcomePayload(value.payload);
}

export function toVerifiedLearningOutcomeArtifact(
  envelope: unknown,
  recomputedSha256: string,
): VerifiedLearningOutcomeArtifact {
  validateLearningOutcomeEnvelope(envelope, recomputedSha256);
  return Object.freeze({
    artifactId: envelope.artifactId,
    artifactSha256: envelope.artifactSha256,
    sourceDatasetId: envelope.payload.sourceDatasetId,
    capturedAtISO: envelope.payload.capturedAtISO,
    observations: Object.freeze(
      envelope.payload.observations.map((observation) =>
        Object.freeze({
          feedbackId: observation.feedbackId,
          rowId: observation.rowId,
          label: Object.freeze({ ...observation.label }),
        }),
      ),
    ),
  });
}
