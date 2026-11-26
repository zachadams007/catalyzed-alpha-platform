import { describe, expect, it } from "vitest";

import { assessLearningDrift, populationStabilityIndex } from "@/engine/learningGuardrails";

describe("learning drift guardrails", () => {
  it("calculates PSI from fixed pre-registered bins", () => {
    const psi = populationStabilityIndex([1, 2, 3, 4], [8, 9, 10, 11], [0, 5, 10, 20]);
    expect(psi).not.toBeNull();
    expect(psi!).toBeGreaterThan(0.25);
  });

  it("fails closed for stale, under-covered, shifted candidates", () => {
    const assessment = assessLearningDrift({
      trainedAtISO: "2026-01-01T00:00:00Z",
      nowISO: "2026-02-15T00:00:00Z",
      baselineFeatureCoverage: 0.9,
      currentFeatureCoverage: 0.7,
      baselineValues: [1, 2, 3, 4],
      currentValues: [8, 9, 10, 11],
      binEdges: [0, 5, 10, 20],
    });
    expect(assessment.stale).toBe(true);
    expect(assessment.drifted).toBe(true);
    expect(assessment.blocked).toBe(true);
    expect(assessment.reasons.join(" ")).toMatch(/coverage dropped/i);
  });

  it("flags an impossible future training timestamp", () => {
    const assessment = assessLearningDrift({
      trainedAtISO: "2026-02-02T00:00:00Z",
      nowISO: "2026-02-01T00:00:00Z",
    });
    expect(assessment.drifted).toBe(true);
    expect(assessment.blocked).toBe(true);
    expect(assessment.reasons.join(" ")).toMatch(/after the evaluation/i);
  });

  it("blocks review when required drift evidence is missing", () => {
    const assessment = assessLearningDrift({ nowISO: "2026-02-01T00:00:00Z" });
    expect(assessment.drifted).toBe(false);
    expect(assessment.blocked).toBe(true);
    expect(assessment.reasons.join(" ")).toMatch(/training timestamp/i);
    expect(assessment.reasons.join(" ")).toMatch(/feature-coverage/i);
    expect(assessment.reasons.join(" ")).toMatch(/PSI/i);
  });

  it.each([
    [Number.NaN, 0.8],
    [0.9, Number.POSITIVE_INFINITY],
    [-0.1, 0.8],
    [0.9, 1.1],
  ])("blocks invalid feature coverage evidence (%s, %s)", (baseline, current) => {
    const assessment = assessLearningDrift({
      trainedAtISO: "2026-01-15T00:00:00Z",
      nowISO: "2026-02-01T00:00:00Z",
      baselineFeatureCoverage: baseline,
      currentFeatureCoverage: current,
      baselineValues: [1, 2, 3, 4],
      currentValues: [1, 2, 3, 4],
      binEdges: [0, 2, 4, 6],
    });
    expect(assessment.featureCoverageDrop).toBeNull();
    expect(assessment.blocked).toBe(true);
    expect(assessment.reasons.join(" ")).toMatch(/finite numbers between 0 and 1/i);
  });
});
