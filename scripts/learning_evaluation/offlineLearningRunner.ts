import {
  toVerifiedAdmissionRecord,
  type AdmissionAttestationEnvelope,
  type AdmissionEvidence,
} from "../../src/engine/learningAdmission";
import { computeAdmissionSubjectDigests } from "../../src/engine/learningAdmissionSubjects";
import {
  validateLearningConfigLedger,
  type LearningConfigLedger,
  type LearningModelConfiguration,
} from "../../src/engine/learningConfigLedger";
import { generateShadowPredictions } from "../../src/engine/learningTrainer";
import {
  applyLearningOutcomeFeedback,
  type LearningOutcomeFeedback,
} from "../../src/engine/learningOutcomeFeedback";
import {
  toVerifiedLearningOutcomeArtifact,
  type LearningOutcomeArtifactEnvelope,
  type VerifiedLearningOutcomeArtifact,
} from "../../src/engine/learningOutcomeArtifact";
import {
  evaluateLearningPromotion,
  type LearningPromotionInput,
  type LearningPromotionReport,
} from "../../src/engine/learningPromotion";
import {
  toVerifiedUniverseArtifact,
  type LearningUniverseArtifactEnvelope,
  type VerifiedUniverseArtifact,
} from "../../src/engine/learningUniverseArtifact";
import { computeLearningUniversePayloadSha256 } from "../universe_scan/learningArchive.mts";
import { computeLearningOutcomePayloadSha256 } from "./outcomeArchive.mts";

export const OFFLINE_LEARNING_REPORT_SCHEMA_VERSION = 3 as const;

export interface OfflineLearningBundle
  extends Omit<LearningPromotionInput, "rows" | "evidence" | "admission" | "configurationLedger"> {
  schemaVersion: typeof OFFLINE_LEARNING_REPORT_SCHEMA_VERSION;
  rows: LearningPromotionInput["rows"];
  archiveEnvelopes: readonly LearningUniverseArtifactEnvelope[];
  outcomeEnvelopes?: readonly LearningOutcomeArtifactEnvelope[];
  eligibleMarketClosesISO: readonly string[];
  feedback?: readonly LearningOutcomeFeedback[];
  /**
   * When supplied with an empty `predictions` array, the deterministic
   * offline trainer generates every required out-of-sample prediction for the
   * split's candidate configuration. The configuration must be registered in
   * `configurationLedger` and match `split.candidateId`.
   */
  trainer?: { configuration: LearningModelConfiguration };
  /** Registered attempted-configuration ledger backing the split. */
  configurationLedger?: LearningConfigLedger;
  /**
   * RFC 3161 attestation envelopes for the five admission subjects. Digests
   * are recomputed here from the exact evaluated bytes before any envelope
   * is admitted; a missing or invalid envelope keeps the verdict blocked.
   */
  admissionAttestations?: readonly AdmissionAttestationEnvelope[];
}

export interface OfflineLearningRunReport {
  schemaVersion: typeof OFFLINE_LEARNING_REPORT_SCHEMA_VERSION;
  reportAsOfISO: string;
  admission: {
    suppliedArtifacts: number;
    admittedArtifacts: number;
    admittedArtifactIds: string[];
    suppliedOutcomeArtifacts: number;
    admittedOutcomeArtifacts: number;
    admittedOutcomeArtifactIds: string[];
  };
  feedback: {
    applied: number;
    idempotent: number;
  };
  trainer: {
    generatedPredictions: number;
    candidateId: string;
  } | null;
  promotion: LearningPromotionReport | null;
  verdict: {
    status: "blocked" | "rejected" | "eligible_for_manual_review";
    automaticPromotion: false;
    productionMutationAllowed: false;
    blockers: string[];
    failedGates: string[];
  };
}

function admissionBlockedReport(
  reportAsOfISO: string,
  suppliedArtifacts: number,
  admitted: readonly VerifiedUniverseArtifact[],
  reason: string,
  suppliedOutcomeArtifacts = 0,
  admittedOutcomeArtifacts: readonly VerifiedLearningOutcomeArtifact[] = [],
): OfflineLearningRunReport {
  return {
    schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
    reportAsOfISO,
    admission: {
      suppliedArtifacts,
      admittedArtifacts: admitted.length,
      admittedArtifactIds: admitted.map((artifact) => artifact.artifactId),
      suppliedOutcomeArtifacts,
      admittedOutcomeArtifacts: admittedOutcomeArtifacts.length,
      admittedOutcomeArtifactIds: admittedOutcomeArtifacts.map((artifact) => artifact.artifactId),
    },
    feedback: { applied: 0, idempotent: 0 },
    trainer: null,
    promotion: null,
    verdict: {
      status: "blocked",
      automaticPromotion: false,
      productionMutationAllowed: false,
      blockers: [reason],
      failedGates: [],
    },
  };
}

/**
 * Run the offline contract. Artifact bytes cross the canonical admission bridge
 * before any row can reach feedback, walk-forward folds, or evaluation.
 */
export function runOfflineLearningEvaluation(bundle: OfflineLearningBundle): OfflineLearningRunReport {
  const rawReportAsOfISO = (bundle as { reportAsOfISO?: unknown }).reportAsOfISO;
  const reportAsOfISO = typeof rawReportAsOfISO === "string" ? rawReportAsOfISO : "";
  const suppliedArtifacts = Array.isArray(bundle.archiveEnvelopes)
    ? bundle.archiveEnvelopes.length
    : 0;
  const suppliedOutcomeArtifacts = Array.isArray(bundle.outcomeEnvelopes)
    ? bundle.outcomeEnvelopes.length
    : 0;
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(reportAsOfISO) || !Number.isFinite(Date.parse(reportAsOfISO))) {
    return admissionBlockedReport(
      reportAsOfISO,
      suppliedArtifacts,
      [],
      "reportAsOfISO must be a valid UTC ISO instant.",
      suppliedOutcomeArtifacts,
    );
  }
  if (bundle.schemaVersion !== OFFLINE_LEARNING_REPORT_SCHEMA_VERSION) {
    return admissionBlockedReport(
      reportAsOfISO,
      suppliedArtifacts,
      [],
      `Unsupported offline-learning bundle schema ${bundle.schemaVersion}.`,
      suppliedOutcomeArtifacts,
    );
  }
  if (!Array.isArray(bundle.archiveEnvelopes) || bundle.archiveEnvelopes.length === 0) {
    return admissionBlockedReport(
      reportAsOfISO,
      0,
      [],
      "At least one authenticated candidate-universe artifact is required.",
      suppliedOutcomeArtifacts,
    );
  }
  if (
    bundle.trainer != null &&
    Array.isArray(bundle.predictions) &&
    bundle.predictions.length > 0
  ) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      [],
      "A bundle must supply either externally generated predictions or a trainer configuration, not both.",
      suppliedOutcomeArtifacts,
    );
  }
  if (bundle.admissionAttestations != null) {
    if (!Array.isArray(bundle.admissionAttestations) || bundle.admissionAttestations.length === 0) {
      return admissionBlockedReport(
        reportAsOfISO,
        bundle.archiveEnvelopes.length,
        [],
        "admissionAttestations must be a non-empty array when supplied.",
        suppliedOutcomeArtifacts,
      );
    }
    if (bundle.configurationLedger == null) {
      return admissionBlockedReport(
        reportAsOfISO,
        bundle.archiveEnvelopes.length,
        [],
        "A configuration ledger is required when admission attestations are supplied.",
        suppliedOutcomeArtifacts,
      );
    }
  }

  const admitted: VerifiedUniverseArtifact[] = [];
  try {
    for (const envelope of bundle.archiveEnvelopes) {
      const recomputed = computeLearningUniversePayloadSha256(envelope.payload);
      admitted.push(toVerifiedUniverseArtifact(envelope, recomputed));
    }
  } catch (error) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      admitted,
      error instanceof Error ? error.message : "Candidate-universe artifact admission failed.",
      suppliedOutcomeArtifacts,
    );
  }

  if (bundle.outcomeEnvelopes != null && !Array.isArray(bundle.outcomeEnvelopes)) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      admitted,
      "Outcome artifact envelopes must be an array.",
    );
  }
  const admittedOutcomeArtifacts: VerifiedLearningOutcomeArtifact[] = [];
  try {
    for (const envelope of bundle.outcomeEnvelopes ?? []) {
      const recomputed = computeLearningOutcomePayloadSha256(envelope.payload);
      admittedOutcomeArtifacts.push(toVerifiedLearningOutcomeArtifact(envelope, recomputed));
    }
  } catch (error) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      admitted,
      error instanceof Error ? error.message : "Outcome artifact admission failed.",
      suppliedOutcomeArtifacts,
      admittedOutcomeArtifacts,
    );
  }

  const evidence = {
    verifiedUniverseArtifacts: admitted,
    eligibleMarketClosesISO: Array.isArray(bundle.eligibleMarketClosesISO)
      ? [...bundle.eligibleMarketClosesISO]
      : [],
  };
  let feedbackResult;
  try {
    feedbackResult = applyLearningOutcomeFeedback(
      bundle.rows,
      bundle.feedback ?? [],
      evidence,
      { verifiedOutcomeArtifacts: admittedOutcomeArtifacts },
    );
  } catch (error) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      admitted,
      error instanceof Error ? error.message : "Outcome feedback admission failed.",
      suppliedOutcomeArtifacts,
      admittedOutcomeArtifacts,
    );
  }
  // Deterministic trainer path: fit the frozen candidate configuration and
  // generate every required out-of-sample prediction from admitted rows.
  let predictions = bundle.predictions;
  let trainerSummary: OfflineLearningRunReport["trainer"] = null;
  if (bundle.trainer != null) {
    try {
      predictions = generateShadowPredictions({
        rows: feedbackResult.rows,
        manifests: bundle.manifests,
        evidence,
        split: bundle.split,
        walkForwardConfig: bundle.walkForwardConfig,
        configuration: bundle.trainer.configuration,
        reportAsOfISO,
      });
      trainerSummary = {
        generatedPredictions: predictions.length,
        candidateId: bundle.split.candidateId,
      };
    } catch (error) {
      return admissionBlockedReport(
        reportAsOfISO,
        bundle.archiveEnvelopes.length,
        admitted,
        error instanceof Error ? error.message : "Deterministic training failed closed.",
        suppliedOutcomeArtifacts,
        admittedOutcomeArtifacts,
      );
    }
  }

  // Independently timestamped admission: recompute each subject digest from
  // the exact bytes this run evaluates, then verify every attestation
  // envelope against its recomputed digest. Missing pieces leave `admission`
  // undefined so the promotion evaluator fails closed with the canonical
  // blocker instead of a synthetic pass.
  let admissionEvidence: AdmissionEvidence | undefined;
  if (bundle.admissionAttestations != null && bundle.configurationLedger != null) {
    try {
      const ledger = validateLearningConfigLedger(bundle.configurationLedger);
      const subjectDigests = computeAdmissionSubjectDigests({
        rows: feedbackResult.rows,
        eligibleMarketClosesISO: evidence.eligibleMarketClosesISO,
        split: bundle.split,
        predictions,
        configurationLedger: ledger,
      });
      const records = bundle.admissionAttestations.map((envelope) =>
        toVerifiedAdmissionRecord(envelope, subjectDigests[envelope.subjectKind] ?? ""),
      );
      admissionEvidence = { records, subjectDigests };
    } catch (error) {
      return admissionBlockedReport(
        reportAsOfISO,
        bundle.archiveEnvelopes.length,
        admitted,
        error instanceof Error ? error.message : "Admission attestation verification failed closed.",
        suppliedOutcomeArtifacts,
        admittedOutcomeArtifacts,
      );
    }
  }

  let promotion: LearningPromotionReport;
  try {
    promotion = evaluateLearningPromotion({
      reportAsOfISO,
      rows: feedbackResult.rows,
      manifests: bundle.manifests,
      evidence,
      predictions,
      split: bundle.split,
      walkForwardConfig: bundle.walkForwardConfig,
      drift: bundle.drift,
      evaluationPolicy: bundle.evaluationPolicy,
      promotionPolicy: bundle.promotionPolicy,
      admission: admissionEvidence,
      configurationLedger: bundle.configurationLedger,
    });
  } catch (error) {
    return admissionBlockedReport(
      reportAsOfISO,
      bundle.archiveEnvelopes.length,
      admitted,
      error instanceof Error ? error.message : "Offline learning evaluation failed closed.",
      suppliedOutcomeArtifacts,
      admittedOutcomeArtifacts,
    );
  }
  return {
    schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
    reportAsOfISO,
    admission: {
      suppliedArtifacts: bundle.archiveEnvelopes.length,
      admittedArtifacts: admitted.length,
      admittedArtifactIds: admitted.map((artifact) => artifact.artifactId),
      suppliedOutcomeArtifacts,
      admittedOutcomeArtifacts: admittedOutcomeArtifacts.length,
      admittedOutcomeArtifactIds: admittedOutcomeArtifacts.map((artifact) => artifact.artifactId),
    },
    feedback: {
      applied: feedbackResult.appliedFeedbackIds.length,
      idempotent: feedbackResult.idempotentFeedbackIds.length,
    },
    trainer: trainerSummary,
    promotion,
    verdict: promotion.verdict,
  };
}
