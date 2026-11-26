/**
 * Canonical bytes and domain-separated digests for admission subjects.
 *
 * The attestation tooling (`scripts/learning_evaluation/attest.mts`) and the
 * offline runner must agree byte-for-byte on what each admission subject is,
 * or a timestamp token could bind different bytes than the run evaluates.
 * This module is the single definition of those bytes.
 *
 * The `predictions` subject is deliberately a label-free commitment: realized
 * forward returns are stripped before hashing, because a commitment that
 * already contains outcomes could never honestly be attested before those
 * outcomes were observable.
 */

import type { AdmissionSubjectKind } from "@/engine/learningAdmission";
import type { LearningConfigLedger } from "@/engine/learningConfigLedger";
import type { PointInTimeFeatureRow } from "@/engine/learningDataset";
import type {
  LearningEvaluationSplit,
  OfflineLearningPrediction,
} from "@/engine/learningPromotion";
import { canonicalizeLearningUniverseJson } from "@/engine/learningUniverseArtifact";
import { sha256Hex } from "@/lib/sha256";

const DOMAIN_PREFIX = "catalyzed.learning-admission" as const;

function subjectSha256(kind: AdmissionSubjectKind, canonicalJson: string): string {
  return sha256Hex(`${DOMAIN_PREFIX}.${kind}.v1\0${canonicalJson}`);
}

export function featureRowsSubjectSha256(rows: readonly PointInTimeFeatureRow[]): string {
  return subjectSha256("feature_rows", canonicalizeLearningUniverseJson(rows));
}

export function marketCalendarSubjectSha256(eligibleMarketClosesISO: readonly string[]): string {
  return subjectSha256("market_calendar", canonicalizeLearningUniverseJson(eligibleMarketClosesISO));
}

export function evaluationSplitSubjectSha256(split: LearningEvaluationSplit): string {
  return subjectSha256("evaluation_split", canonicalizeLearningUniverseJson(split));
}

/** A prediction with its realized outcome removed; the pre-outcome commitment. */
export type PredictionCommitment = Omit<OfflineLearningPrediction, "forwardReturn">;

export function toPredictionCommitments(
  predictions: readonly OfflineLearningPrediction[],
): PredictionCommitment[] {
  return predictions.map(({ forwardReturn: _forwardReturn, ...commitment }) => commitment);
}

export function predictionsSubjectSha256(
  predictions: readonly OfflineLearningPrediction[],
): string {
  return subjectSha256(
    "predictions",
    canonicalizeLearningUniverseJson(toPredictionCommitments(predictions)),
  );
}

export function configurationLedgerSubjectSha256(ledger: LearningConfigLedger): string {
  return subjectSha256("configuration_ledger", canonicalizeLearningUniverseJson(ledger));
}

export interface AdmissionSubjectInputs {
  rows: readonly PointInTimeFeatureRow[];
  eligibleMarketClosesISO: readonly string[];
  split: LearningEvaluationSplit;
  predictions: readonly OfflineLearningPrediction[];
  configurationLedger: LearningConfigLedger;
}

export function computeAdmissionSubjectDigests(
  inputs: AdmissionSubjectInputs,
): Record<AdmissionSubjectKind, string> {
  return {
    feature_rows: featureRowsSubjectSha256(inputs.rows),
    market_calendar: marketCalendarSubjectSha256(inputs.eligibleMarketClosesISO),
    evaluation_split: evaluationSplitSubjectSha256(inputs.split),
    predictions: predictionsSubjectSha256(inputs.predictions),
    configuration_ledger: configurationLedgerSubjectSha256(inputs.configurationLedger),
  };
}
