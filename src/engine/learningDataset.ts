/**
 * Point-in-time learning dataset contract.
 *
 * The existing outcome ledger is useful for tracking published picks, but it is
 * not a training set: it is client-local, capped, and contains only names the
 * existing ranker selected.  A model trained from it would learn selection bias
 * and could silently use fields whose historical availability is unknown.
 *
 * This module defines the narrower contract required before an adaptive model
 * can be fitted.  It is deliberately data-source agnostic and pure: ingestion
 * owns persistence and network I/O; this module only rejects impossible or
 * temporally invalid records.
 */

import type { VerifiedUniverseArtifact } from "@/engine/learningUniverseArtifact";

export const LEARNING_DATASET_SCHEMA_VERSION = 1;

export type FeatureSourceKind =
  | "filing"
  | "earnings_call"
  | "market_data"
  | "provider"
  | "derived";

const LEARNING_FEATURE_SOURCES: ReadonlySet<FeatureSourceKind> = new Set([
  "filing",
  "earnings_call",
  "market_data",
  "provider",
  "derived",
]);

export type LearningCapCohort = "small" | "mid" | "large" | "mega" | "unknown";

const LEARNING_CAP_COHORTS: ReadonlySet<LearningCapCohort> = new Set([
  "small",
  "mid",
  "large",
  "mega",
  "unknown",
]);

export interface PointInTimeFeature {
  /** A finite numerical feature, or null when this feature was unavailable. */
  readonly value: number | null;
  /** When the data collector actually observed the value. */
  readonly observedAtISO: string;
  /** Original publication time when known (for example an EDGAR filing timestamp). */
  readonly publishedAtISO?: string;
  readonly source: FeatureSourceKind;
}

export interface RealizedOutcomeLabel {
  /** Trading-day horizon for this realized return. */
  readonly horizonDays: number;
  /** Return from the decision-time price to the first eligible horizon close. */
  readonly forwardReturn: number;
  /** Exact eligible market close used to compute the realized return. */
  readonly horizonCloseAtISO: string;
  /** The timestamp the label first became observable to a retraining job. */
  readonly observedAtISO: string;
}

/**
 * Immutable evidence that a run captured every eligible candidate before any
 * feed/ranking selection. Training fails closed without this exact membership
 * list; a row-level `universeId` alone is not completeness evidence.
 */
export interface PointInTimeUniverseManifest {
  readonly schemaVersion: typeof LEARNING_DATASET_SCHEMA_VERSION;
  readonly universeId: string;
  readonly captureScope: "full_candidate_universe";
  readonly decisionAtISO: string;
  /** When ingestion froze this membership list. Must not be after the decision. */
  readonly capturedAtISO: string;
  /** Stable ingestion/run identifier retained for provenance and erasure. */
  readonly sourceRunId: string;
  /** Versioned eligibility policy used before ranking (for example exchange/cap/liquidity rules). */
  readonly universeDefinitionId: string;
  /** Immutable source artifact whose digest is verified outside this pure module. */
  readonly sourceArtifactId: string;
  readonly sourceArtifactSha256: string;
  /** Complete eligible ticker membership before ranking or feed selection. */
  readonly eligibleTickers: readonly string[];
}

/**
 * External evidence required to make labeled rows trainable. The market-close
 * list must come from a sanctioned exchange-calendar capture. Persisted rows and
 * manifests cannot certify themselves by constructing this registry.
 */
export interface PointInTimeEvidenceRegistry {
  /** Values must come from the canonical fail-closed archive admission bridge. */
  readonly verifiedUniverseArtifacts: readonly VerifiedUniverseArtifact[];
  readonly eligibleMarketClosesISO: readonly string[];
}

/**
 * One row for every eligible name in a run's candidate universe. `universeId`
 * must identify the complete contemporaneous universe, not just the feed picks.
 */
export interface PointInTimeFeatureRow {
  readonly schemaVersion: typeof LEARNING_DATASET_SCHEMA_VERSION;
  readonly rowId: string;
  readonly ticker: string;
  /** Exact timestamp the model would have made its ranking decision. */
  readonly decisionAtISO: string;
  /** Immutable ID for the universe/run that produced this candidate. */
  readonly universeId: string;
  readonly sector: string;
  readonly capCohort: LearningCapCohort;
  /** Existing deterministic score, retained as the benchmark and a feature. */
  readonly baselineScore: number;
  /** Every feature carries its own availability/provenance timestamp. */
  readonly features: Readonly<Record<string, PointInTimeFeature>>;
  /** Filled only after a horizon closes. An absent label is never a negative label. */
  readonly label?: RealizedOutcomeLabel;
}

export interface DatasetValidation {
  rowId: string;
  valid: boolean;
  errors: string[];
}

export interface DatasetAudit {
  totalRows: number;
  validRows: number;
  labeledRows: number;
  invalidRows: number;
  uniqueUniverseCount: number;
  bySector: Record<string, number>;
  byCapCohort: Record<LearningCapCohort, number>;
  validations: DatasetValidation[];
  coverageValid: boolean;
  universeValidations: UniverseValidation[];
}

export interface UniverseValidation {
  universeId: string;
  valid: boolean;
  errors: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseISO(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validTimestamp(value: string | undefined): boolean {
  return parseISO(value) != null;
}

function validTicker(value: string): boolean {
  return /^[A-Z][A-Z.]{0,9}$/.test(value);
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function verifiedMarketCloseInstants(
  evidence: PointInTimeEvidenceRegistry | undefined,
): { instants: number[]; valid: boolean } {
  if (!evidence) return { instants: [], valid: false };
  const instants = evidence.eligibleMarketClosesISO.map((value) => parseISO(value));
  if (instants.some((value) => value == null)) return { instants: [], valid: false };
  const unique = [...new Set(instants as number[])].sort((a, b) => a - b);
  const utcDays = new Set(unique.map((value) => new Date(value).toISOString().slice(0, 10)));
  // The contract is for U.S. common-stock sessions: at most one eligible close
  // may exist per UTC calendar day. Duplicate instants are also invalid evidence.
  return {
    instants: unique,
    valid: unique.length === instants.length && utcDays.size === unique.length,
  };
}

/**
 * Validate a row mechanically. Invalid rows are excluded from fitting and must
 * be surfaced by the ingestion audit; they are never "repaired" by borrowing
 * a later source value.
 */
export function validatePointInTimeRow(
  row: PointInTimeFeatureRow,
  evidence?: PointInTimeEvidenceRegistry,
): DatasetValidation {
  const errors: string[] = [];
  const decisionMs = parseISO(row.decisionAtISO);

  if (row.schemaVersion !== LEARNING_DATASET_SCHEMA_VERSION) {
    errors.push(`Unsupported schema version ${row.schemaVersion}.`);
  }
  if (!row.rowId.trim()) errors.push("rowId is required.");
  if (!validTicker(row.ticker)) errors.push("ticker must be uppercase and valid.");
  if (!row.universeId.trim()) errors.push("universeId is required; selected-picks-only rows are not trainable.");
  if (!row.sector.trim()) errors.push("sector is required for concentration checks.");
  if (!LEARNING_CAP_COHORTS.has(row.capCohort)) errors.push("capCohort is invalid.");
  if (!validTimestamp(row.decisionAtISO)) errors.push("decisionAtISO is invalid.");
  if (!isFiniteNumber(row.baselineScore) || row.baselineScore < 0 || row.baselineScore > 100) {
    errors.push("baselineScore must be finite and between 0 and 100.");
  }

  for (const [name, feature] of Object.entries(row.features)) {
    if (!name.trim()) {
      errors.push("feature names must be non-empty.");
      continue;
    }
    if (feature.value != null && !isFiniteNumber(feature.value)) {
      errors.push(`${name}: value must be finite or null.`);
    }
    if (!LEARNING_FEATURE_SOURCES.has(feature.source)) {
      errors.push(`${name}: source is invalid.`);
    }
    const observedMs = parseISO(feature.observedAtISO);
    if (observedMs == null) {
      errors.push(`${name}: observedAtISO is invalid.`);
    } else if (decisionMs != null && observedMs > decisionMs) {
      errors.push(`${name}: observed after the decision time.`);
    }
    if (feature.publishedAtISO != null) {
      const publishedMs = parseISO(feature.publishedAtISO);
      if (publishedMs == null) {
        errors.push(`${name}: publishedAtISO is invalid.`);
      } else if (decisionMs != null && publishedMs > decisionMs) {
        errors.push(`${name}: published after the decision time.`);
      }
    }
  }

  if (row.label) {
    const observedMs = parseISO(row.label.observedAtISO);
    const horizonCloseMs = parseISO(row.label.horizonCloseAtISO);
    const marketCloses = verifiedMarketCloseInstants(evidence);
    if (!Number.isInteger(row.label.horizonDays) || row.label.horizonDays <= 0) {
      errors.push("label horizonDays must be a positive integer.");
    }
    if (!isFiniteNumber(row.label.forwardReturn)) errors.push("label forwardReturn must be finite.");
    if (observedMs == null) {
      errors.push("label observedAtISO is invalid.");
    } else if (decisionMs != null && observedMs <= decisionMs) {
      errors.push("label must become observable strictly after the decision time.");
    }
    if (horizonCloseMs == null) {
      errors.push("label horizonCloseAtISO is invalid.");
    } else if (decisionMs != null && horizonCloseMs <= decisionMs) {
      errors.push("label horizon close must be strictly after the decision time.");
    }
    if (!marketCloses.valid) {
      errors.push("verified market-session calendar evidence is required and must be valid.");
    } else if (
      decisionMs != null &&
      horizonCloseMs != null &&
      Number.isInteger(row.label.horizonDays) &&
      row.label.horizonDays > 0
    ) {
      const eligibleThroughHorizon = marketCloses.instants.filter(
        (closeMs) => closeMs > decisionMs && closeMs <= horizonCloseMs,
      );
      const exactHorizonClose =
        eligibleThroughHorizon[eligibleThroughHorizon.length - 1] === horizonCloseMs;
      if (!exactHorizonClose || eligibleThroughHorizon.length !== row.label.horizonDays) {
        errors.push("label horizon close does not match the verified market-session calendar.");
      }
    }
    if (observedMs != null && horizonCloseMs != null && observedMs < horizonCloseMs) {
      errors.push("label cannot be observed before its eligible horizon close.");
    }
  }

  return { rowId: row.rowId, valid: errors.length === 0, errors };
}

/**
 * Validate dataset-level universe completeness. The manifest must come from the
 * pre-ranking ingestion run and enumerate exact membership; selected picks with
 * only an arbitrary `universeId` therefore remain non-trainable.
 */
export function validateUniverseCoverage(
  rows: readonly PointInTimeFeatureRow[],
  manifests: readonly PointInTimeUniverseManifest[],
  evidence?: PointInTimeEvidenceRegistry,
): UniverseValidation[] {
  const rowGroups = new Map<string, PointInTimeFeatureRow[]>();
  const manifestGroups = new Map<string, PointInTimeUniverseManifest[]>();

  for (const row of rows) {
    const group = rowGroups.get(row.universeId) ?? [];
    group.push(row);
    rowGroups.set(row.universeId, group);
  }
  for (const manifest of manifests) {
    const group = manifestGroups.get(manifest.universeId) ?? [];
    group.push(manifest);
    manifestGroups.set(manifest.universeId, group);
  }

  const universeIds = [...new Set([...rowGroups.keys(), ...manifestGroups.keys()])].sort();
  return universeIds.map((universeId) => {
    const errors: string[] = [];
    const universeRows = rowGroups.get(universeId) ?? [];
    const universeManifests = manifestGroups.get(universeId) ?? [];
    if (!universeId.trim()) errors.push("universeId is required.");
    if (universeManifests.length !== 1) {
      errors.push(
        universeManifests.length === 0
          ? "exactly one full-universe manifest is required."
          : "duplicate manifests are not allowed.",
      );
      return { universeId, valid: false, errors };
    }

    const manifest = universeManifests[0]!;
    const decisionMs = parseISO(manifest.decisionAtISO);
    const capturedMs = parseISO(manifest.capturedAtISO);
    if (manifest.schemaVersion !== LEARNING_DATASET_SCHEMA_VERSION) {
      errors.push(`Unsupported manifest schema version ${manifest.schemaVersion}.`);
    }
    if (manifest.captureScope !== "full_candidate_universe") {
      errors.push("manifest captureScope must be full_candidate_universe.");
    }
    if (!manifest.sourceRunId.trim()) errors.push("manifest sourceRunId is required.");
    if (!manifest.universeDefinitionId.trim()) errors.push("manifest universeDefinitionId is required.");
    if (!manifest.sourceArtifactId.trim()) errors.push("manifest sourceArtifactId is required.");
    if (!validSha256(manifest.sourceArtifactSha256)) {
      errors.push("manifest sourceArtifactSha256 must be a SHA-256 digest.");
    }
    if (decisionMs == null) errors.push("manifest decisionAtISO is invalid.");
    if (capturedMs == null) {
      errors.push("manifest capturedAtISO is invalid.");
    } else if (decisionMs != null && capturedMs > decisionMs) {
      errors.push("manifest was captured after the decision time.");
    }
    if (manifest.eligibleTickers.length === 0) errors.push("manifest eligibleTickers is empty.");

    const expected = new Set<string>();
    for (const ticker of manifest.eligibleTickers) {
      if (!validTicker(ticker)) errors.push(`manifest ticker '${ticker}' is invalid.`);
      if (expected.has(ticker)) errors.push(`manifest ticker '${ticker}' is duplicated.`);
      expected.add(ticker);
    }

    const artifacts =
      evidence?.verifiedUniverseArtifacts.filter(
        (artifact) => artifact.artifactId === manifest.sourceArtifactId,
      ) ?? [];
    let verifiedArtifact: VerifiedUniverseArtifact | undefined;
    if (artifacts.length !== 1) {
      errors.push(
        artifacts.length === 0
          ? "exactly one independently verified universe artifact is required."
          : "verified universe artifact IDs must be unique.",
      );
    } else {
      const artifact = artifacts[0]!;
      verifiedArtifact = artifact;
      const artifactDecisionMs = parseISO(artifact.decisionAtISO);
      const artifactCapturedMs = parseISO(artifact.capturedAtISO);
      if (!validSha256(artifact.artifactSha256)) {
        errors.push("verified universe artifact digest is invalid.");
      }
      if (artifactDecisionMs == null || artifactCapturedMs == null) {
        errors.push("verified universe artifact timestamps are invalid.");
      } else if (artifactCapturedMs > artifactDecisionMs) {
        errors.push("verified universe artifact was captured after its decision time.");
      }
      if (
        artifact.artifactSha256 !== manifest.sourceArtifactSha256 ||
        artifact.universeDefinitionId !== manifest.universeDefinitionId ||
        artifact.universeId !== manifest.universeId ||
        artifact.sourceRunId !== manifest.sourceRunId ||
        artifactDecisionMs !== decisionMs ||
        artifactCapturedMs !== capturedMs
      ) {
        errors.push("manifest does not match its independently verified universe artifact.");
      }
      const artifactTickers = new Set(artifact.eligibleTickers);
      if (
        artifactTickers.size !== artifact.eligibleTickers.length ||
        artifactTickers.size !== expected.size ||
        [...artifactTickers].some((ticker) => !expected.has(ticker))
      ) {
        errors.push("manifest membership does not match its independently verified universe artifact.");
      }
    }

    const actual = new Set<string>();
    const rowIds = new Set<string>();
    for (const row of universeRows) {
      if (actual.has(row.ticker)) errors.push(`row ticker '${row.ticker}' is duplicated.`);
      actual.add(row.ticker);
      if (rowIds.has(row.rowId)) errors.push(`rowId '${row.rowId}' is duplicated.`);
      rowIds.add(row.rowId);
      const rowDecisionMs = parseISO(row.decisionAtISO);
      if (decisionMs != null && rowDecisionMs !== decisionMs) {
        errors.push(`row '${row.rowId}' decision time does not match its manifest.`);
      }
      const sourceCandidates =
        verifiedArtifact?.eligibleCandidates.filter((candidate) => candidate.ticker === row.ticker) ?? [];
      if (sourceCandidates.length !== 1) {
        errors.push(`row '${row.rowId}' requires exactly one admitted eligible source candidate.`);
      } else if (
        sourceCandidates[0]!.preRankScore == null ||
        sourceCandidates[0]!.preRankScore !== row.baselineScore
      ) {
        errors.push(`row '${row.rowId}' baselineScore does not match admitted pre-rank evidence.`);
      }
      if (!validatePointInTimeRow(row, evidence).valid) {
        errors.push(`row '${row.rowId}' failed point-in-time validation.`);
      }
    }
    for (const ticker of expected) {
      if (!actual.has(ticker)) errors.push(`manifest member '${ticker}' is missing.`);
    }
    for (const ticker of actual) {
      if (!expected.has(ticker)) errors.push(`row ticker '${ticker}' is not in the manifest.`);
    }

    return { universeId, valid: errors.length === 0, errors };
  });
}

/** A deterministic audit used to block training when provenance or coverage is weak. */
export function auditPointInTimeDataset(
  rows: readonly PointInTimeFeatureRow[],
  manifests: readonly PointInTimeUniverseManifest[],
  evidence?: PointInTimeEvidenceRegistry,
): DatasetAudit {
  const universeValidations = validateUniverseCoverage(rows, manifests, evidence);
  const universeById = new Map(universeValidations.map((validation) => [validation.universeId, validation]));
  const validations = rows.map((row) => {
    const rowValidation = validatePointInTimeRow(row, evidence);
    const coverage = universeById.get(row.universeId);
    const coverageErrors = coverage?.valid
      ? []
      : (coverage?.errors ?? ["exactly one full-universe manifest is required."]).map(
          (error) => `universe coverage: ${error}`,
        );
    const errors = [...rowValidation.errors, ...coverageErrors];
    return { rowId: row.rowId, valid: errors.length === 0, errors };
  });
  const validRows = rows.filter((_, index) => validations[index]!.valid);
  const bySector: Record<string, number> = {};
  const byCapCohort: Record<LearningCapCohort, number> = {
    small: 0,
    mid: 0,
    large: 0,
    mega: 0,
    unknown: 0,
  };

  for (const row of validRows) {
    bySector[row.sector] = (bySector[row.sector] ?? 0) + 1;
    byCapCohort[row.capCohort] += 1;
  }

  return {
    totalRows: rows.length,
    validRows: validRows.length,
    labeledRows: validRows.filter((row) => row.label != null).length,
    invalidRows: rows.length - validRows.length,
    uniqueUniverseCount: new Set(validRows.map((row) => row.universeId)).size,
    bySector,
    byCapCohort,
    validations,
    coverageValid: universeValidations.length > 0 && universeValidations.every((entry) => entry.valid),
    universeValidations,
  };
}

/**
 * Return only valid, labeled rows in chronological order. This is intentionally
 * not a trainer: callers must still partition it with `buildWalkForwardFolds`.
 */
export function trainableRows(
  rows: readonly PointInTimeFeatureRow[],
  manifests: readonly PointInTimeUniverseManifest[],
  evidence?: PointInTimeEvidenceRegistry,
): readonly PointInTimeFeatureRow[] {
  const audit = auditPointInTimeDataset(rows, manifests, evidence);
  const frozenRows = rows
    .filter((row, index) => audit.validations[index]!.valid && row.label != null)
    .map((row) => {
      const features = Object.freeze(
        Object.fromEntries(
          Object.entries(row.features).map(([name, feature]) => [name, Object.freeze({ ...feature })]),
        ),
      );
      const label = row.label ? Object.freeze({ ...row.label }) : undefined;
      return Object.freeze({ ...row, features, label });
    })
    .sort(
      (a, b) =>
        (parseISO(a.decisionAtISO) ?? 0) - (parseISO(b.decisionAtISO) ?? 0) ||
        a.rowId.localeCompare(b.rowId),
    );
  return Object.freeze(frozenRows);
}
