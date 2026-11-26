import { describe, expect, it } from "vitest";

import { buildLearningFixture } from "@/engine/__tests__/learningTestFixtures";
import {
  LEARNING_OUTCOME_FEEDBACK_SCHEMA_VERSION,
  applyLearningOutcomeFeedback,
  type LearningOutcomeEvidenceRegistry,
  type LearningOutcomeFeedback,
} from "@/engine/learningOutcomeFeedback";

function admittedFeedback(
  rowId: string,
  labelOverrides: Partial<LearningOutcomeFeedback["label"]> = {},
): {
  observation: LearningOutcomeFeedback;
  outcomeEvidence: LearningOutcomeEvidenceRegistry;
} {
  const label = {
    horizonDays: 1,
    forwardReturn: 0.025,
    horizonCloseAtISO: "2026-01-02T20:00:00.000Z",
    observedAtISO: "2026-01-02T21:00:00.000Z",
    ...labelOverrides,
  };
  const feedbackId = `feedback:${rowId}`;
  const artifactSha256 = "d".repeat(64);
  const artifactId = `sha256:${artifactSha256}`;
  return {
    observation: {
      schemaVersion: LEARNING_OUTCOME_FEEDBACK_SCHEMA_VERSION,
      feedbackId,
      rowId,
      sourceArtifactId: artifactId,
      sourceArtifactSha256: artifactSha256,
      label,
    },
    outcomeEvidence: {
      verifiedOutcomeArtifacts: [{
        artifactId,
        artifactSha256,
        sourceDatasetId: "sanctioned-close-fixture-v1",
        capturedAtISO: "2026-01-10T00:00:00.000Z",
        observations: [{ feedbackId, rowId, label }],
      }],
    },
  };
}

describe("applyLearningOutcomeFeedback", () => {
  it("applies once, then treats an exact authenticated retry as idempotent without mutation", () => {
    const fixture = buildLearningFixture(1);
    const source = fixture.rows.map((row) => ({ ...row, label: undefined }));
    const before = JSON.stringify(source);
    const { observation, outcomeEvidence } = admittedFeedback(source[0]!.rowId);
    const first = applyLearningOutcomeFeedback(
      source,
      [observation],
      fixture.evidence,
      outcomeEvidence,
    );
    const second = applyLearningOutcomeFeedback(
      first.rows,
      [observation],
      fixture.evidence,
      outcomeEvidence,
    );

    expect(first.appliedFeedbackIds).toEqual([observation.feedbackId]);
    expect(first.idempotentFeedbackIds).toEqual([]);
    expect(second.appliedFeedbackIds).toEqual([]);
    expect(second.idempotentFeedbackIds).toEqual([observation.feedbackId]);
    expect(second.rows).toEqual(first.rows);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.isFrozen(first.rows)).toBe(true);
    expect(Object.isFrozen(first.rows[0])).toBe(true);
    expect(Object.isFrozen(first.rows[0]!.features)).toBe(true);
    expect(Object.isFrozen(first.rows[0]!.label)).toBe(true);
  });

  it("fails closed when no independently digest-verified outcome artifact exists", () => {
    const fixture = buildLearningFixture(1);
    const source = fixture.rows.map((row) => ({ ...row, label: undefined }));
    const { observation } = admittedFeedback(source[0]!.rowId);
    expect(() =>
      applyLearningOutcomeFeedback(source, [observation], fixture.evidence, {
        verifiedOutcomeArtifacts: [],
      }),
    ).toThrow(/exactly one independently verified source artifact/i);
  });

  it("rejects an artifact ID with a different digest than the feedback declaration", () => {
    const fixture = buildLearningFixture(1);
    const source = fixture.rows.map((row) => ({ ...row, label: undefined }));
    const { observation, outcomeEvidence } = admittedFeedback(source[0]!.rowId);
    expect(() =>
      applyLearningOutcomeFeedback(
        source,
        [{ ...observation, sourceArtifactSha256: "e".repeat(64) }],
        fixture.evidence,
        outcomeEvidence,
      ),
    ).toThrow(/digest does not match admitted bytes/i);
  });

  it("rejects feedback bytes that do not exactly match the admitted artifact", () => {
    const fixture = buildLearningFixture(1);
    const source = fixture.rows.map((row) => ({ ...row, label: undefined }));
    const { observation, outcomeEvidence } = admittedFeedback(source[0]!.rowId);
    expect(() =>
      applyLearningOutcomeFeedback(
        source,
        [{ ...observation, label: { ...observation.label, forwardReturn: 0.99 } }],
        fixture.evidence,
        outcomeEvidence,
      ),
    ).toThrow(/does not exactly match its admitted source artifact/i);
  });

  it("rejects a conflicting rewrite for an already labeled row", () => {
    const fixture = buildLearningFixture(1);
    const row = fixture.rows[0]!;
    const { observation, outcomeEvidence } = admittedFeedback(row.rowId, {
      forwardReturn: 0.99,
    });
    expect(() =>
      applyLearningOutcomeFeedback([row], [observation], fixture.evidence, outcomeEvidence),
    ).toThrow(/conflicts with the existing label/i);
  });

  it("rejects an invalid market-session horizon before adding a label", () => {
    const fixture = buildLearningFixture(1);
    const source = [{ ...fixture.rows[0]!, label: undefined }];
    const { observation, outcomeEvidence } = admittedFeedback(source[0]!.rowId, {
      horizonCloseAtISO: "2026-01-03T03:17:00.000Z",
      observedAtISO: "2026-01-03T03:18:00.000Z",
    });
    expect(() =>
      applyLearningOutcomeFeedback(source, [observation], fixture.evidence, outcomeEvidence),
    ).toThrow(/market-session calendar/i);
  });

  it("rejects conflicting bytes under one feedback ID", () => {
    const fixture = buildLearningFixture(1);
    const source = fixture.rows.map((row) => ({ ...row, label: undefined }));
    const { observation, outcomeEvidence } = admittedFeedback(source[0]!.rowId);
    expect(() =>
      applyLearningOutcomeFeedback(
        source,
        [
          observation,
          { ...observation, label: { ...observation.label, forwardReturn: -0.2 } },
        ],
        fixture.evidence,
        outcomeEvidence,
      ),
    ).toThrow(/conflicting bytes/i);
  });
});
