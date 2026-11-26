/**
 * Append-only attempted-configuration ledger.
 *
 * Every attempted feature set, model family, hyperparameter choice, selection
 * threshold, and split must be recorded before its results are viewed, and
 * failed experiments remain part of the evidence. A configuration's identity
 * is the SHA-256 of its canonical bytes, so the ledger cannot silently
 * relabel a configuration after seeing results. The ledger's own canonical
 * bytes are attested through the independently timestamped admission bridge
 * (`configuration_ledger` subject), which is what makes "recorded before the
 * holdout was viewable" independently verifiable rather than self-asserted.
 */

import { canonicalizeLearningUniverseJson } from "@/engine/learningUniverseArtifact";
import { sha256Hex } from "@/lib/sha256";

export const LEARNING_CONFIG_LEDGER_SCHEMA_VERSION = 1 as const;

export interface RidgeBaselineHyperparameters {
  family: "ridge_baseline";
  /** L2 regularization strength applied to standardized features. */
  lambda: number;
}

export interface GbmChallengerHyperparameters {
  family: "gbm_challenger";
  rounds: number;
  learningRate: number;
  maxDepth: 1 | 2;
  minLeafSize: number;
}

export type LearningModelHyperparameters =
  | RidgeBaselineHyperparameters
  | GbmChallengerHyperparameters;

export interface LearningModelConfiguration {
  schemaVersion: typeof LEARNING_CONFIG_LEDGER_SCHEMA_VERSION;
  /** Ordered feature names consumed from `PointInTimeFeatureRow.features`. */
  featureNames: readonly string[];
  hyperparameters: LearningModelHyperparameters;
  /** Forward-return threshold defining a "success" for probability calibration. */
  successThreshold: number;
  probabilityCalibration: "isotonic";
  labelHorizonDays: number;
}

export interface LearningConfigLedgerEntry {
  configurationId: string;
  registeredAtISO: string;
  description: string;
  configuration: LearningModelConfiguration;
  /** Outcome note recorded after evaluation; failed attempts stay in evidence. */
  status: "registered" | "evaluated" | "abandoned";
}

export interface LearningConfigLedger {
  schemaVersion: typeof LEARNING_CONFIG_LEDGER_SCHEMA_VERSION;
  ledgerId: string;
  entries: readonly LearningConfigLedgerEntry[];
}

function fail(message: string): never {
  throw new Error(`Invalid configuration ledger: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validISO(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateHyperparameters(value: unknown): asserts value is LearningModelHyperparameters {
  assert(isRecord(value), "hyperparameters must be an object");
  if (value.family === "ridge_baseline") {
    assert(
      typeof value.lambda === "number" && Number.isFinite(value.lambda) && value.lambda >= 0,
      "ridge lambda must be a non-negative finite number",
    );
    assert(Object.keys(value).length === 2, "ridge hyperparameters have unexpected fields");
    return;
  }
  if (value.family === "gbm_challenger") {
    assert(
      Number.isInteger(value.rounds) && (value.rounds as number) >= 1 && (value.rounds as number) <= 200,
      "gbm rounds must be an integer in [1, 200]",
    );
    assert(
      typeof value.learningRate === "number" &&
        Number.isFinite(value.learningRate) &&
        value.learningRate > 0 &&
        value.learningRate <= 1,
      "gbm learningRate must be in (0, 1]",
    );
    assert(value.maxDepth === 1 || value.maxDepth === 2, "gbm maxDepth must be 1 or 2 (restrained challenger)");
    assert(
      Number.isInteger(value.minLeafSize) && (value.minLeafSize as number) >= 1,
      "gbm minLeafSize must be a positive integer",
    );
    assert(Object.keys(value).length === 5, "gbm hyperparameters have unexpected fields");
    return;
  }
  fail("hyperparameters family is unsupported");
}

export function validateLearningModelConfiguration(
  value: unknown,
): asserts value is LearningModelConfiguration {
  assert(isRecord(value), "configuration must be an object");
  const keys = Object.keys(value).sort();
  const expected = [
    "featureNames",
    "hyperparameters",
    "labelHorizonDays",
    "probabilityCalibration",
    "schemaVersion",
    "successThreshold",
  ];
  assert(
    keys.length === expected.length && keys.every((key, index) => key === expected[index]),
    "configuration has unexpected or missing fields",
  );
  assert(value.schemaVersion === LEARNING_CONFIG_LEDGER_SCHEMA_VERSION, "configuration schemaVersion is unsupported");
  assert(Array.isArray(value.featureNames) && value.featureNames.length > 0, "featureNames must be non-empty");
  const names = value.featureNames as unknown[];
  for (const name of names) {
    assert(typeof name === "string" && name.trim().length > 0, "featureNames must be non-empty strings");
  }
  assert(new Set(names).size === names.length, "featureNames must be unique");
  validateHyperparameters(value.hyperparameters);
  assert(
    typeof value.successThreshold === "number" && Number.isFinite(value.successThreshold),
    "successThreshold must be finite",
  );
  assert(value.probabilityCalibration === "isotonic", "probabilityCalibration must be 'isotonic'");
  assert(
    Number.isInteger(value.labelHorizonDays) && (value.labelHorizonDays as number) >= 1,
    "labelHorizonDays must be a positive integer",
  );
}

/** Content-addressed identity: the configuration IS its canonical bytes. */
export function configurationId(configuration: LearningModelConfiguration): string {
  validateLearningModelConfiguration(configuration);
  return `cfg:sha256:${sha256Hex(canonicalizeLearningUniverseJson(configuration))}`;
}

export function canonicalLedgerBytes(ledger: LearningConfigLedger): string {
  return canonicalizeLearningUniverseJson(ledger);
}

export function ledgerSha256(ledger: LearningConfigLedger): string {
  return sha256Hex(canonicalLedgerBytes(ledger));
}

/**
 * Validate ledger integrity: content-addressed IDs recompute, registration
 * order is chronological, and entries are unique. Returns the validated
 * ledger so callers use the checked shape.
 */
export function validateLearningConfigLedger(value: unknown): LearningConfigLedger {
  assert(isRecord(value), "ledger must be an object");
  const keys = Object.keys(value).sort();
  assert(
    keys.length === 3 && keys[0] === "entries" && keys[1] === "ledgerId" && keys[2] === "schemaVersion",
    "ledger has unexpected or missing fields",
  );
  assert(value.schemaVersion === LEARNING_CONFIG_LEDGER_SCHEMA_VERSION, "ledger schemaVersion is unsupported");
  assert(
    typeof value.ledgerId === "string" && /^[A-Za-z0-9_.:-]{8,160}$/.test(value.ledgerId),
    "ledgerId is invalid",
  );
  assert(Array.isArray(value.entries) && value.entries.length > 0, "ledger must record at least one attempt");
  const seenIds = new Set<string>();
  let previousMs = Number.NEGATIVE_INFINITY;
  for (const [index, entry] of (value.entries as unknown[]).entries()) {
    assert(isRecord(entry), `entry ${index} must be an object`);
    const entryKeys = Object.keys(entry).sort();
    const expected = ["configuration", "configurationId", "description", "registeredAtISO", "status"];
    assert(
      entryKeys.length === expected.length && entryKeys.every((key, keyIndex) => key === expected[keyIndex]),
      `entry ${index} has unexpected or missing fields`,
    );
    validateLearningModelConfiguration(entry.configuration);
    const expectedId = configurationId(entry.configuration as LearningModelConfiguration);
    assert(entry.configurationId === expectedId, `entry ${index} configurationId does not recompute`);
    assert(!seenIds.has(expectedId), `entry ${index} duplicates configuration '${expectedId}'`);
    seenIds.add(expectedId);
    assert(validISO(entry.registeredAtISO), `entry ${index} registeredAtISO is invalid`);
    const registeredMs = Date.parse(entry.registeredAtISO as string);
    assert(registeredMs >= previousMs, `entry ${index} breaks append-only chronological order`);
    previousMs = registeredMs;
    assert(
      typeof entry.description === "string" && entry.description.trim().length > 0,
      `entry ${index} description is required`,
    );
    assert(
      entry.status === "registered" || entry.status === "evaluated" || entry.status === "abandoned",
      `entry ${index} status is invalid`,
    );
  }
  return value as unknown as LearningConfigLedger;
}

/**
 * Cross-check the ledger against an evaluation split: the candidate must be
 * registered, the attempted-configuration set must exactly match the ledger,
 * and every registration must precede model selection.
 */
export function ledgerSplitBlockers(
  ledger: LearningConfigLedger,
  split: { candidateId: string; modelSelectedAtISO: string; attemptedConfigurationIds: readonly string[] },
): string[] {
  const blockers: string[] = [];
  const ledgerIds = ledger.entries.map((entry) => entry.configurationId);
  const ledgerSet = new Set(ledgerIds);
  if (!ledgerSet.has(split.candidateId)) {
    blockers.push("Candidate configuration is not registered in the attempted-configuration ledger.");
  }
  const attemptedSet = new Set(split.attemptedConfigurationIds);
  if (
    attemptedSet.size !== ledgerSet.size ||
    [...attemptedSet].some((id) => !ledgerSet.has(id))
  ) {
    blockers.push("Split attempted-configuration IDs do not exactly match the registered ledger.");
  }
  const selectedMs = Date.parse(split.modelSelectedAtISO);
  for (const entry of ledger.entries) {
    if (!Number.isFinite(selectedMs) || Date.parse(entry.registeredAtISO) > selectedMs) {
      blockers.push(
        `Configuration '${entry.configurationId}' was registered after model selection.`,
      );
    }
  }
  return blockers;
}
