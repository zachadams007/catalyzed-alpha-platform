import { describe, expect, it } from "vitest";

import {
  LEARNING_OUTCOME_ARTIFACT_SCHEMA_VERSION,
  LEARNING_OUTCOME_ARTIFACT_TYPE,
  toVerifiedLearningOutcomeArtifact,
  type LearningOutcomeArtifactPayload,
} from "../../../src/engine/learningOutcomeArtifact";
import {
  computeLearningOutcomePayloadSha256,
  sealLearningOutcomeArtifact,
} from "../outcomeArchive.mts";

function payload(): LearningOutcomeArtifactPayload {
  return {
    schemaVersion: LEARNING_OUTCOME_ARTIFACT_SCHEMA_VERSION,
    artifactType: LEARNING_OUTCOME_ARTIFACT_TYPE,
    sourceDatasetId: "sanctioned-close-fixture-v1",
    capturedAtISO: "2026-01-03T00:00:00.000Z",
    observations: [{
      feedbackId: "feedback:scan-01:AAA",
      rowId: "scan-01:AAA",
      label: {
        horizonDays: 1,
        forwardReturn: 0.025,
        horizonCloseAtISO: "2026-01-02T20:00:00.000Z",
        observedAtISO: "2026-01-02T21:00:00.000Z",
      },
    }],
  };
}

describe("learning outcome artifact admission", () => {
  it("rehashes and exposes immutable exact outcome observations", () => {
    const envelope = sealLearningOutcomeArtifact(payload());
    const verified = toVerifiedLearningOutcomeArtifact(
      envelope,
      computeLearningOutcomePayloadSha256(envelope.payload),
    );

    expect(verified.artifactId).toBe(`sha256:${verified.artifactSha256}`);
    expect(verified.observations[0]!.feedbackId).toBe("feedback:scan-01:AAA");
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.observations)).toBe(true);
    expect(Object.isFrozen(verified.observations[0]!.label)).toBe(true);
  });

  it("rejects payload tampering after an envelope was sealed", () => {
    const envelope = sealLearningOutcomeArtifact(payload());
    const tampered = {
      ...envelope,
      payload: {
        ...envelope.payload,
        observations: [{
          ...envelope.payload.observations[0]!,
          label: {
            ...envelope.payload.observations[0]!.label,
            forwardReturn: 0.99,
          },
        }],
      },
    };

    expect(() =>
      toVerifiedLearningOutcomeArtifact(
        tampered,
        computeLearningOutcomePayloadSha256(tampered.payload),
      ),
    ).toThrow(/digest verification failed/i);
  });

  it("rejects outcome artifacts captured before their observations exist", () => {
    expect(() =>
      sealLearningOutcomeArtifact({
        ...payload(),
        capturedAtISO: "2026-01-02T20:30:00.000Z",
      }),
    ).toThrow(/captured before it became observable/i);
  });
});
