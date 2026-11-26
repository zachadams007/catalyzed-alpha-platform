/**
 * learningPostMortem - deterministic per-pick "ask why" attribution.
 *
 * The owner's mandate (CAT-004): every time a pick's realized outcome is bad, the
 * system should ask WHY - which evidence pushed the score up when it should
 * not have - record that answer durably, and feed the correction into the
 * learning loop. This module is that answer's pure core:
 *
 *  1. `buildPickPostMortem` attributes one labeled prediction to its
 *     features by NEUTRALIZATION: each feature is replaced with "unavailable"
 *     (which the trainer imputes to the training mean, z = 0) and the model
 *     is re-scored. contribution = originalScore − neutralizedScore. For the
 *     ridge baseline this equals coefficient × standardized value exactly;
 *     for the restrained GBM it is the same deterministic effect measure.
 *  2. `aggregatePostMortems` rolls many post-mortems into the recurring-
 *     misleader table: which features repeatedly pushed misses upward. That
 *     table is precisely the evidence a NEW candidate configuration (with the
 *     offending feature dropped, capped, or re-specified) should cite when it
 *     is registered in the attempted-configuration ledger.
 *
 * The correction path is deliberately indirect: a post-mortem NEVER edits the
 * live scorer, weights, or feed. It produces evidence; a human (or a future
 * authorized job) registers a new challenger configuration from that
 * evidence; the challenger must win the fail-closed walk-forward/holdout
 * evaluation before promotion is even reviewable. Silent self-modification is
 * exactly the failure mode this design forbids.
 *
 * Everything here is pure and deterministic: no I/O, no randomness, no
 * production imports. Identical inputs produce byte-identical reports.
 */

import type { PointInTimeFeatureRow } from "@/engine/learningDataset";
import {
  configurationId,
  type LearningModelConfiguration,
} from "@/engine/learningConfigLedger";
import {
  predictWithModel,
  type FittedLearningModel,
} from "@/engine/learningTrainer";
import { round } from "@/lib/math";

export const LEARNING_POST_MORTEM_SCHEMA_VERSION = 1 as const;

/** Contributions smaller than this are noise, not an explanation. */
const CONTRIBUTION_EPSILON = 1e-9;

export interface FeatureAttribution {
  readonly featureName: string;
  /** The raw point-in-time value the model saw (null = unavailable/imputed). */
  readonly value: number | null;
  /** Score delta versus re-scoring with this feature neutralized to unavailable. */
  readonly contribution: number;
}

export interface PickPostMortem {
  readonly schemaVersion: typeof LEARNING_POST_MORTEM_SCHEMA_VERSION;
  readonly rowId: string;
  readonly ticker: string;
  readonly decisionAtISO: string;
  /** Content-addressed configuration that produced the pick. */
  readonly candidateId: string;
  readonly horizonDays: number;
  readonly forwardReturn: number;
  readonly successThreshold: number;
  /** miss = realized return at or below the configured success threshold. */
  readonly outcome: "hit" | "miss";
  readonly shadowScore: number;
  readonly successProbability: number;
  /** Every configured feature, sorted by |contribution| desc (name asc ties). */
  readonly attributions: readonly FeatureAttribution[];
  /**
   * The "why" of a bad pick: features whose contribution pushed the score UP
   * on a miss. Empty for hits.
   */
  readonly misleadingFeatures: readonly string[];
  /** Features that were unavailable at decision time (imputed, zero effect). */
  readonly missingEvidence: readonly string[];
}

export interface RecurringMisleader {
  readonly featureName: string;
  /** Number of misses in which this feature pushed the score upward. */
  readonly missCount: number;
  /** Mean upward contribution across those misses. */
  readonly meanContributionInMisses: number;
}

export interface PostMortemAggregate {
  readonly schemaVersion: typeof LEARNING_POST_MORTEM_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly totalPicks: number;
  readonly misses: number;
  /**
   * Features ranked by how often (then how strongly) they misled - the input
   * for the next registered challenger configuration.
   */
  readonly recurringMisleaders: readonly RecurringMisleader[];
}

/** Clone a row with one feature forced to "unavailable at decision time". */
function neutralizeFeature(row: PointInTimeFeatureRow, featureName: string): PointInTimeFeatureRow {
  const existing = row.features[featureName];
  if (existing == null || existing.value == null) return row;
  return {
    ...row,
    features: { ...row.features, [featureName]: { ...existing, value: null } },
  };
}

/**
 * Attribute one labeled pick to its features and classify the outcome.
 * Fails closed: the row must carry a label whose horizon matches the
 * configuration, and the fitted model must be the configuration's exact
 * content-addressed candidate.
 */
export function buildPickPostMortem(
  fitted: FittedLearningModel,
  configuration: LearningModelConfiguration,
  row: PointInTimeFeatureRow,
): PickPostMortem {
  const candidateId = configurationId(configuration);
  if (fitted.configurationId !== candidateId) {
    throw new Error(
      "Post-mortem refused: the fitted model is not the supplied configuration's content-addressed candidate.",
    );
  }
  if (row.label == null) {
    throw new Error(
      `Post-mortem refused: row '${row.rowId}' has no realized label; an absent outcome is never a miss.`,
    );
  }
  if (row.label.horizonDays !== configuration.labelHorizonDays) {
    throw new Error(
      `Post-mortem refused: row '${row.rowId}' label horizon ${row.label.horizonDays} does not match the configured horizon ${configuration.labelHorizonDays}.`,
    );
  }

  const base = predictWithModel(fitted, row);
  const attributions: FeatureAttribution[] = configuration.featureNames.map((featureName) => {
    const feature = row.features[featureName];
    const value = feature != null && feature.value != null && Number.isFinite(feature.value)
      ? feature.value
      : null;
    if (value == null) {
      return { featureName, value: null, contribution: 0 };
    }
    const neutralized = predictWithModel(fitted, neutralizeFeature(row, featureName));
    return {
      featureName,
      value,
      contribution: round(base.shadowScore - neutralized.shadowScore, 10),
    };
  });
  attributions.sort(
    (a, b) =>
      Math.abs(b.contribution) - Math.abs(a.contribution) ||
      a.featureName.localeCompare(b.featureName),
  );

  const outcome: PickPostMortem["outcome"] =
    row.label.forwardReturn > configuration.successThreshold ? "hit" : "miss";
  const misleadingFeatures =
    outcome === "miss"
      ? attributions
          .filter((attribution) => attribution.contribution > CONTRIBUTION_EPSILON)
          .map((attribution) => attribution.featureName)
      : [];
  const missingEvidence = attributions
    .filter((attribution) => attribution.value == null)
    .map((attribution) => attribution.featureName)
    .sort((a, b) => a.localeCompare(b));

  return {
    schemaVersion: LEARNING_POST_MORTEM_SCHEMA_VERSION,
    rowId: row.rowId,
    ticker: row.ticker,
    decisionAtISO: row.decisionAtISO,
    candidateId,
    horizonDays: row.label.horizonDays,
    forwardReturn: row.label.forwardReturn,
    successThreshold: configuration.successThreshold,
    outcome,
    shadowScore: round(base.shadowScore, 10),
    successProbability: round(base.successProbability, 10),
    attributions,
    misleadingFeatures,
    missingEvidence,
  };
}

/**
 * Roll per-pick post-mortems into the recurring-misleader table. All inputs
 * must come from one candidate configuration - mixing candidates would blur
 * accountability, so it fails closed.
 */
export function aggregatePostMortems(
  postMortems: readonly PickPostMortem[],
): PostMortemAggregate {
  if (postMortems.length === 0) {
    throw new Error("Cannot aggregate zero post-mortems.");
  }
  const candidateId = postMortems[0]!.candidateId;
  for (const postMortem of postMortems) {
    if (postMortem.candidateId !== candidateId) {
      throw new Error(
        "Cannot aggregate post-mortems across different candidate configurations.",
      );
    }
  }

  const sums = new Map<string, { missCount: number; contributionSum: number }>();
  let misses = 0;
  for (const postMortem of postMortems) {
    if (postMortem.outcome !== "miss") continue;
    misses += 1;
    for (const attribution of postMortem.attributions) {
      if (attribution.contribution <= CONTRIBUTION_EPSILON) continue;
      const entry = sums.get(attribution.featureName) ?? { missCount: 0, contributionSum: 0 };
      entry.missCount += 1;
      entry.contributionSum += attribution.contribution;
      sums.set(attribution.featureName, entry);
    }
  }

  const recurringMisleaders: RecurringMisleader[] = [...sums.entries()]
    .map(([featureName, entry]) => ({
      featureName,
      missCount: entry.missCount,
      meanContributionInMisses: round(entry.contributionSum / entry.missCount, 10),
    }))
    .sort(
      (a, b) =>
        b.missCount - a.missCount ||
        b.meanContributionInMisses - a.meanContributionInMisses ||
        a.featureName.localeCompare(b.featureName),
    );

  return {
    schemaVersion: LEARNING_POST_MORTEM_SCHEMA_VERSION,
    candidateId,
    totalPicks: postMortems.length,
    misses,
    recurringMisleaders,
  };
}
