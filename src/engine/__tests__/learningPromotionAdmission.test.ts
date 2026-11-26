import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256";
import type { AdmissionEvidence, AdmissionSubjectKind } from "@/engine/learningAdmission";
import {
  configurationId,
  LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
  type LearningConfigLedger,
  type LearningModelConfiguration,
} from "@/engine/learningConfigLedger";
import { generateShadowPredictions } from "@/engine/learningTrainer";
import {
  evaluateLearningPromotion,
  type LearningPromotionInput,
} from "@/engine/learningPromotion";
import { buildLearningFixture } from "@/engine/__tests__/learningTestFixtures";

const KINDS: AdmissionSubjectKind[] = [
  "feature_rows",
  "market_calendar",
  "evaluation_split",
  "predictions",
  "configuration_ledger",
];

function day(value: number): string {
  return new Date(Date.UTC(2026, 0, value)).toISOString().slice(0, 10);
}

function digestOf(seed: string): string {
  return sha256Hex(seed);
}

function admissionEvidence(genTimes: Partial<Record<AdmissionSubjectKind, string>> = {}): AdmissionEvidence {
  const subjectDigests = Object.fromEntries(
    KINDS.map((kind) => [kind, digestOf(`subject:${kind}`)]),
  ) as Record<AdmissionSubjectKind, string>;
  return {
    subjectDigests,
    records: KINDS.map((kind) => ({
      subjectKind: kind,
      subjectSha256: subjectDigests[kind],
      genTimeISO: genTimes[kind] ?? `${day(30)}T12:00:00.000Z`,
      policyOid: "1.3.6.1.4.1.99999.1",
      serialNumberHex: "01",
      tsaUrl: "https://freetsa.org/tsr",
      tokenSha256: digestOf(`token:${kind}`),
      trustAnchors: { caCertSha256: "a".repeat(64), tsaCertSha256: "b".repeat(64) },
    })),
  };
}

function buildAdmittedInput(): LearningPromotionInput {
  const fixture = buildLearningFixture(40);
  const walkForwardConfig = {
    minTrainingDecisionDays: 10,
    testDecisionDays: 5,
    stepDecisionDays: 5,
    embargoDecisionDays: 1,
  };
  const ridge: LearningModelConfiguration = {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum"],
    hyperparameters: { family: "ridge_baseline", lambda: 0.01 },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
  const gbm: LearningModelConfiguration = {
    ...ridge,
    hyperparameters: { family: "gbm_challenger", rounds: 10, learningRate: 0.2, maxDepth: 2, minLeafSize: 3 },
  };
  const candidateId = configurationId(ridge);
  const configurationLedger: LearningConfigLedger = {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    ledgerId: "ledger-admitted-fixture",
    entries: [
      {
        configurationId: candidateId,
        registeredAtISO: `${day(20)}T00:00:00.000Z`,
        description: "Interpretable regularized baseline.",
        configuration: ridge,
        status: "evaluated",
      },
      {
        configurationId: configurationId(gbm),
        registeredAtISO: `${day(20)}T00:01:00.000Z`,
        description: "Restrained nonlinear challenger (results also recorded).",
        configuration: gbm,
        status: "evaluated",
      },
    ],
  };
  const holdoutStart = day(31);
  const split = {
    splitId: "split-admitted-v1",
    candidateId,
    frozenAtISO: `${day(29)}T23:59:59.999Z`,
    modelSelectedAtISO: `${day(30)}T23:59:59.999Z`,
    holdoutStartISO: `${holdoutStart}T00:00:00.000Z`,
    holdoutEndISO: `${day(40)}T23:59:59.999Z`,
    holdoutModelTrainedThroughISO: `${day(30)}T23:59:59.999Z`,
    attemptedConfigurationIds: [candidateId, configurationId(gbm)],
  };
  const reportAsOfISO = "2026-03-01T00:00:00.000Z";
  const predictions = generateShadowPredictions({
    rows: fixture.rows,
    manifests: fixture.manifests,
    evidence: fixture.evidence,
    split,
    walkForwardConfig,
    configuration: ridge,
    reportAsOfISO,
  });
  return {
    reportAsOfISO,
    ...fixture,
    predictions,
    split,
    walkForwardConfig,
    evaluationPolicy: {
      topNPerDecisionDay: 2,
      positiveReturnThreshold: 0,
      calibrationBins: 2,
    },
    promotionPolicy: {
      minWalkForwardFolds: 3,
      minHoldoutDecisionDays: 10,
      minHoldoutFraction: 0.2,
      minLabelCoverage: 1,
      minSelectedLabelCoverage: 1,
      minRankICDelta: 0.01,
      minMeanReturnDelta: 0.001,
      minExpectancyDelta: 0.001,
      maxBrierScore: 0.05,
      maxExpectedCalibrationError: 0.05,
      maxSectorShare: 0.6,
      maxCapShare: 0.6,
      minRankStabilityAgainstBaseline: 0.2,
    },
    drift: {
      trainedAtISO: `${day(30)}T23:59:59.999Z`,
      nowISO: "2026-03-01T00:00:00.000Z",
      baselineFeatureCoverage: 0.95,
      currentFeatureCoverage: 0.94,
      baselineValues: [0.1, 0.2, 0.7, 0.8],
      currentValues: [0.12, 0.22, 0.72, 0.82],
      binEdges: [0, 0.5, 1],
    },
    admission: admissionEvidence(),
    configurationLedger,
  };
}

describe("evaluateLearningPromotion — admitted trainer path", () => {
  it("reaches a non-blocked verdict only when admission, ledger, and trainer predictions all hold", () => {
    const source = buildAdmittedInput();
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.blockers).toEqual([]);
    expect(report.admission.verified).toBe(true);
    expect(report.admission.records).toHaveLength(5);
    expect(["rejected", "eligible_for_manual_review"]).toContain(report.verdict.status);
    // Even a fully admitted, gate-passing report can never self-promote.
    expect(report.verdict.automaticPromotion).toBe(false);
    expect(report.verdict.productionMutationAllowed).toBe(false);
    expect(report.production).toEqual({
      publishedScorerChanged: false,
      publishedOrderChanged: false,
      orderExecutionPathAdded: false,
    });
  });

  it("is deterministic: identical admitted inputs produce byte-identical reports", () => {
    const first = evaluateLearningPromotion(buildAdmittedInput());
    const second = evaluateLearningPromotion(buildAdmittedInput());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("blocks when the prediction commitment was attested after a holdout label was observable", () => {
    const source = buildAdmittedInput();
    source.admission = admissionEvidence({ predictions: `2026-02-05T00:00:00.000Z` });
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.admission.verified).toBe(false);
    expect(report.verdict.blockers.join(" ")).toMatch(/attested after a holdout label became observable/);
  });

  it("blocks when the split attestation happens inside the holdout", () => {
    const source = buildAdmittedInput();
    source.admission = admissionEvidence({ evaluation_split: `${day(35)}T00:00:00.000Z` });
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/not attested strictly before the final holdout/);
  });

  it("blocks when the candidate configuration is missing from the registered ledger", () => {
    const source = buildAdmittedInput();
    const [, gbmEntry] = source.configurationLedger!.entries;
    source.configurationLedger = { ...source.configurationLedger!, entries: [gbmEntry!] };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/not registered in the attempted-configuration ledger/);
  });

  it("blocks when a subject digest does not bind the evaluated bytes", () => {
    const source = buildAdmittedInput();
    source.admission = {
      ...source.admission!,
      subjectDigests: {
        ...source.admission!.subjectDigests,
        feature_rows: "e".repeat(64),
      },
    };
    const report = evaluateLearningPromotion(source);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/does not bind the evaluated bytes/);
  });
});
