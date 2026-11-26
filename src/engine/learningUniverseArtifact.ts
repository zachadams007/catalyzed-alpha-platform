import type { SnapshotFetchAudit } from "@/data/alpaca/snapshots";
import {
  FINNHUB_MIN_EXPECTED_ELIGIBLE,
  type FinnhubUniverseFetchAudit,
} from "@/data/finnhub/symbolList";
import { preRankUniverse } from "@/engine/preRank";

export const LEARNING_UNIVERSE_SCHEMA_VERSION = 1 as const;
export const LEARNING_UNIVERSE_ARTIFACT_TYPE =
  "catalyzed.minimum_coverage_candidate_universe" as const;
export const LEARNING_UNIVERSE_DEFINITION_ID =
  "catalyzed-us-common-stock-prerank-minimum-coverage-v1" as const;

export type UniverseSource = "finnhub_us_common_stocks" | "curated_fallback";

export type LearningUniverseQuarantineReason =
  | "finnhub_universe_incomplete"
  | "finnhub_universe_completeness_unproven"
  | "curated_universe_fallback"
  | "universe_input_limited"
  | "alpaca_snapshots_incomplete"
  | "incomplete_field_provenance"
  | "unverified_code_revision"
  | "empty_eligible_universe"
  | "dry_run";

export interface LearningUniverseEligibilityPolicy {
  minPrice: number;
  maxPrice: number | null;
  minDollarVolume: number;
  alwaysIncludeTickers: string[];
  tickerPattern: "^[A-Z]{1,5}$";
  securityTypes: ["Common Stock", "ADR", "REIT"];
  currency: "USD";
  preRankVersion: "pre_rank_v1";
}

/** Raw snapshot observation supplied at the pre-rank boundary. */
export interface LearningUniverseCandidateInput {
  ticker: string;
  name: string;
  price: number;
  prevClose: number;
  dayChange: number;
  dollarVolume: number;
  rangePct: number;
  quoteAsOfISO: string;
  priceSource: "latest_trade" | "daily_bar" | "minute_bar" | "previous_daily_bar";
  priceAsOfISO: string | null;
  prevCloseSource: "previous_daily_bar" | "price_fallback";
  prevCloseAsOfISO: string | null;
  liquiditySource: "previous_daily_bar" | "daily_bar" | "imputed";
  liquidityAsOfISO: string | null;
  rangeSource: "previous_daily_bar" | "daily_bar" | "imputed";
  rangeAsOfISO: string | null;
}

/** Raw evidence plus mechanically recomputed eligibility/decision metadata. */
export interface LearningUniverseCandidate extends LearningUniverseCandidateInput {
  floorPassed: boolean;
  seeded: boolean;
  seedBypass: boolean;
  eligible: boolean;
  preRankScore: number | null;
}

export interface LearningUniverseArtifactPayload {
  schemaVersion: typeof LEARNING_UNIVERSE_SCHEMA_VERSION;
  artifactType: typeof LEARNING_UNIVERSE_ARTIFACT_TYPE;
  sourceRunId: string;
  universeId: string;
  universeDefinitionId: typeof LEARNING_UNIVERSE_DEFINITION_ID;
  codeRevision: string;
  capturedAtISO: string;
  decisionAtISO: string;
  universeSource: UniverseSource;
  captureTrigger: "github_actions" | "manual" | "local";
  runAttempt: string;
  inputWasLimited: boolean;
  dryRun: boolean;
  providerAudits: {
    finnhub: FinnhubUniverseFetchAudit;
    alpaca: SnapshotFetchAudit;
  };
  eligibilityPolicy: LearningUniverseEligibilityPolicy;
  consideredCount: number;
  gatedCount: number;
  selectionTarget: number;
  sourceUniverseTickers: string[];
  snapshotRequestedTickers: string[];
  preRankInputTickers: string[];
  eligibleTickers: string[];
  selectedForEnrichmentTickers: string[];
  candidates: LearningUniverseCandidate[];
  admissible: boolean;
  quarantineReasons: LearningUniverseQuarantineReason[];
}

export interface LearningUniverseArtifactEnvelope {
  artifactId: string;
  artifactSha256: string;
  payload: LearningUniverseArtifactPayload;
}

export interface BuildLearningUniversePayloadInput {
  sourceRunId: string;
  codeRevision: string;
  capturedAtISO: string;
  decisionAtISO: string;
  universeSource: UniverseSource;
  captureTrigger: LearningUniverseArtifactPayload["captureTrigger"];
  runAttempt: string;
  inputWasLimited: boolean;
  dryRun: boolean;
  providerAudits: LearningUniverseArtifactPayload["providerAudits"];
  eligibilityPolicy: Pick<
    LearningUniverseEligibilityPolicy,
    "minPrice" | "maxPrice" | "minDollarVolume" | "alwaysIncludeTickers"
  >;
  selectionTarget: number;
  sourceUniverseTickers: string[];
  snapshotRequestedTickers: string[];
  selectedForEnrichmentTickers: string[];
  candidates: LearningUniverseCandidateInput[];
}

/** The only artifact shape a future labeling/training bridge is allowed to consume. */
export interface VerifiedUniverseArtifact {
  artifactId: string;
  artifactSha256: string;
  sourceRunId: string;
  universeId: string;
  universeDefinitionId: string;
  codeRevision: string;
  capturedAtISO: string;
  decisionAtISO: string;
  eligibleTickers: string[];
  /** Every observed candidate, including floor failures, with eligibility flags. */
  candidates: LearningUniverseCandidate[];
  eligibleCandidates: LearningUniverseCandidate[];
}

/** Integrity-verified evidence, including quarantined runs, for audit/recovery use. */
export interface ValidatedUniverseEvidence extends VerifiedUniverseArtifact {
  admissible: boolean;
  quarantineReasons: LearningUniverseQuarantineReason[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid learning-universe artifact: ${message}`);
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

function assertFiniteNumber(value: unknown, path: string, minimum?: number): asserts value is number {
  assert(typeof value === "number" && Number.isFinite(value), `${path} must be finite`);
  if (minimum !== undefined) assert(value >= minimum, `${path} must be >= ${minimum}`);
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  assertFiniteNumber(value, path, 0);
  assert(Number.isInteger(value), `${path} must be an integer`);
}

function assertISO(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value), `${path} must be UTC ISO`);
  assert(Number.isFinite(Date.parse(value)), `${path} must be a valid timestamp`);
}

function assertTicker(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string" && /^[A-Z][A-Z.]{0,6}$/.test(value), `${path} is invalid`);
}

function assertSortedUnique(values: string[], path: string): void {
  const sorted = [...new Set(values)].sort();
  assert(
    values.length === sorted.length && values.every((value, index) => value === sorted[index]),
    `${path} must be sorted and unique`,
  );
}

function sortedUniqueTickers(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))].sort();
}

function uniqueTickersInOrder(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))];
}

function deriveQuarantineReasons(
  input: Pick<
    BuildLearningUniversePayloadInput,
    | "universeSource"
    | "inputWasLimited"
    | "dryRun"
    | "providerAudits"
    | "codeRevision"
  >,
  candidates: LearningUniverseCandidate[],
  eligibleCount: number,
): LearningUniverseQuarantineReason[] {
  const reasons: LearningUniverseQuarantineReason[] = [];
  if (input.providerAudits.finnhub.status === "minimum_coverage_met") {
    reasons.push("finnhub_universe_completeness_unproven");
  } else {
    reasons.push("finnhub_universe_incomplete");
  }
  if (input.universeSource === "curated_fallback") {
    reasons.push("curated_universe_fallback");
  }
  if (input.inputWasLimited) reasons.push("universe_input_limited");
  if (input.providerAudits.alpaca.status !== "complete") {
    reasons.push("alpaca_snapshots_incomplete");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.codeRevision)) {
    reasons.push("unverified_code_revision");
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.priceAsOfISO === null ||
        candidate.prevCloseSource === "price_fallback" ||
        candidate.prevCloseAsOfISO === null ||
        candidate.liquiditySource === "imputed" ||
        candidate.liquidityAsOfISO === null ||
        candidate.rangeSource === "imputed" ||
        candidate.rangeAsOfISO === null,
    )
  ) {
    reasons.push("incomplete_field_provenance");
  }
  if (eligibleCount === 0) reasons.push("empty_eligible_universe");
  if (input.dryRun) reasons.push("dry_run");
  return reasons.sort();
}

/** Build and validate the canonical, prospective minimum-coverage payload. Pure. */
export function buildLearningUniversePayload(
  input: BuildLearningUniversePayloadInput,
): LearningUniverseArtifactPayload {
  const normalizedInputs = input.candidates.map((candidate) => ({
    ...candidate,
    ticker: candidate.ticker.trim().toUpperCase(),
  }));
  const alwaysIncludeTickers = uniqueTickersInOrder(input.eligibilityPolicy.alwaysIncludeTickers);
  const ranked = preRankUniverse(
    normalizedInputs.map(({ ticker, price, prevClose, dayChange, dollarVolume, rangePct }) => ({
      ticker,
      price,
      prevClose,
      dayChange,
      dollarVolume,
      rangePct,
    })),
    {
      target: input.selectionTarget,
      minPrice: input.eligibilityPolicy.minPrice,
      maxPrice: input.eligibilityPolicy.maxPrice ?? undefined,
      minDollarVolume: input.eligibilityPolicy.minDollarVolume,
      alwaysInclude: alwaysIncludeTickers,
    },
  );
  const scoredByTicker = new Map(ranked.eligibleRows.map((row) => [row.ticker, row]));
  const alwaysIncludeSet = new Set(alwaysIncludeTickers);
  const maxPrice = input.eligibilityPolicy.maxPrice ?? Infinity;
  const candidates: LearningUniverseCandidate[] = normalizedInputs
    .map((candidate) => {
      const floorPassed =
        candidate.price >= input.eligibilityPolicy.minPrice &&
        candidate.price <= maxPrice &&
        candidate.prevClose > 0 &&
        candidate.dollarVolume >= input.eligibilityPolicy.minDollarVolume;
      const seeded = alwaysIncludeSet.has(candidate.ticker);
      const scored = scoredByTicker.get(candidate.ticker);
      return {
        ...candidate,
        floorPassed,
        seeded,
        seedBypass: seeded && !floorPassed,
        eligible: Boolean(scored),
        preRankScore: scored?.score ?? null,
      };
    })
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  const eligibleTickers = sortedUniqueTickers(ranked.eligibleRows.map((candidate) => candidate.ticker));
  const quarantineReasons = deriveQuarantineReasons(input, candidates, eligibleTickers.length);
  const sourceRunId = input.sourceRunId.trim();
  const payload: LearningUniverseArtifactPayload = {
    schemaVersion: LEARNING_UNIVERSE_SCHEMA_VERSION,
    artifactType: LEARNING_UNIVERSE_ARTIFACT_TYPE,
    sourceRunId,
    universeId: `${sourceRunId}:eligible`,
    universeDefinitionId: LEARNING_UNIVERSE_DEFINITION_ID,
    codeRevision: input.codeRevision.trim().toLowerCase() || "unverified",
    capturedAtISO: input.capturedAtISO,
    decisionAtISO: input.decisionAtISO,
    universeSource: input.universeSource,
    captureTrigger: input.captureTrigger,
    runAttempt: input.runAttempt.trim(),
    inputWasLimited: input.inputWasLimited,
    dryRun: input.dryRun,
    providerAudits: {
      finnhub: { ...input.providerAudits.finnhub },
      alpaca: {
        ...input.providerAudits.alpaca,
        missingTickers: sortedUniqueTickers(input.providerAudits.alpaca.missingTickers),
        unexpectedTickers: sortedUniqueTickers(input.providerAudits.alpaca.unexpectedTickers),
        batches: [...input.providerAudits.alpaca.batches]
          .map((batch) => ({
            ...batch,
            missingTickers: sortedUniqueTickers(batch.missingTickers),
            unexpectedTickers: sortedUniqueTickers(batch.unexpectedTickers),
          }))
          .sort((a, b) => a.index - b.index),
      },
    },
    eligibilityPolicy: {
      minPrice: input.eligibilityPolicy.minPrice,
      maxPrice: input.eligibilityPolicy.maxPrice,
      minDollarVolume: input.eligibilityPolicy.minDollarVolume,
      alwaysIncludeTickers,
      tickerPattern: "^[A-Z]{1,5}$",
      securityTypes: ["Common Stock", "ADR", "REIT"],
      currency: "USD",
      preRankVersion: "pre_rank_v1",
    },
    consideredCount: ranked.consideredCount,
    gatedCount: ranked.gatedCount,
    selectionTarget: input.selectionTarget,
    sourceUniverseTickers: sortedUniqueTickers(input.sourceUniverseTickers),
    snapshotRequestedTickers: sortedUniqueTickers(input.snapshotRequestedTickers),
    preRankInputTickers: normalizedInputs.map((candidate) => candidate.ticker),
    eligibleTickers,
    selectedForEnrichmentTickers: input.selectedForEnrichmentTickers.map((ticker) =>
      ticker.trim().toUpperCase(),
    ),
    candidates,
    admissible: quarantineReasons.length === 0,
    quarantineReasons,
  };
  validateLearningUniversePayload(payload);
  return payload;
}

function validateFinnhubAudit(value: unknown): asserts value is FinnhubUniverseFetchAudit {
  assert(isRecord(value), "providerAudits.finnhub must be an object");
  assertExactKeys(
    value,
    [
      "provider",
      "endpoint",
      "status",
      "requestedAtISO",
      "receivedAtISO",
      "rawRowCount",
      "eligibleEntryCount",
      "minimumExpectedEligibleCount",
    ],
    "providerAudits.finnhub",
  );
  assert(value.provider === "finnhub", "Finnhub provider is invalid");
  assert(value.endpoint === "/stock/symbol?exchange=US", "Finnhub endpoint is invalid");
  assert(
    [
      "minimum_coverage_met",
      "not_configured",
      "request_failed",
      "invalid_payload",
      "empty_payload",
      "empty_eligible",
      "coverage_below_minimum",
    ].includes(
      value.status as string,
    ),
    "Finnhub status is invalid",
  );
  assertISO(value.requestedAtISO, "Finnhub requestedAtISO");
  assertISO(value.receivedAtISO, "Finnhub receivedAtISO");
  assert(Date.parse(value.requestedAtISO) <= Date.parse(value.receivedAtISO), "Finnhub timestamps are reversed");
  assertNonNegativeInteger(value.rawRowCount, "Finnhub rawRowCount");
  assertNonNegativeInteger(value.eligibleEntryCount, "Finnhub eligibleEntryCount");
  assert(value.rawRowCount >= value.eligibleEntryCount, "Finnhub eligible count exceeds raw rows");
  assertNonNegativeInteger(value.minimumExpectedEligibleCount, "Finnhub minimumExpectedEligibleCount");
  assert(value.minimumExpectedEligibleCount > 0, "Finnhub minimumExpectedEligibleCount must be positive");
  if (value.status === "minimum_coverage_met") {
    assert(
      value.rawRowCount > 0 &&
        value.eligibleEntryCount > 0 &&
        value.minimumExpectedEligibleCount >= FINNHUB_MIN_EXPECTED_ELIGIBLE &&
        value.eligibleEntryCount >= value.minimumExpectedEligibleCount,
      "minimum-coverage Finnhub audit is below its production floor",
    );
  } else if (
    ["not_configured", "request_failed", "invalid_payload", "empty_payload"].includes(
      value.status as string,
    )
  ) {
    assert(
      value.rawRowCount === 0 && value.eligibleEntryCount === 0,
      `${value.status} Finnhub audit has unexpected membership`,
    );
  } else if (value.status === "empty_eligible") {
    assert(value.rawRowCount > 0 && value.eligibleEntryCount === 0, "empty_eligible Finnhub audit is invalid");
  } else {
    assert(
      value.eligibleEntryCount > 0 && value.eligibleEntryCount < value.minimumExpectedEligibleCount,
      "coverage_below_minimum Finnhub audit is invalid",
    );
  }
}

function validateAlpacaAudit(value: unknown): asserts value is SnapshotFetchAudit {
  assert(isRecord(value), "providerAudits.alpaca must be an object");
  assertExactKeys(
    value,
    [
      "provider",
      "endpoint",
      "feed",
      "status",
      "requestedAtISO",
      "receivedAtISO",
      "requestedCount",
      "returnedCount",
      "missingTickers",
      "unexpectedTickers",
      "batches",
    ],
    "providerAudits.alpaca",
  );
  assert(value.provider === "alpaca", "Alpaca provider is invalid");
  assert(value.endpoint === "/v2/stocks/snapshots", "Alpaca endpoint is invalid");
  assert(value.feed === "iex", "Alpaca feed is invalid");
  assert(
    ["complete", "partial", "not_configured", "empty_request"].includes(value.status as string),
    "Alpaca status is invalid",
  );
  assertISO(value.requestedAtISO, "Alpaca requestedAtISO");
  assertISO(value.receivedAtISO, "Alpaca receivedAtISO");
  assert(Date.parse(value.requestedAtISO) <= Date.parse(value.receivedAtISO), "Alpaca timestamps are reversed");
  assertNonNegativeInteger(value.requestedCount, "Alpaca requestedCount");
  assertNonNegativeInteger(value.returnedCount, "Alpaca returnedCount");
  assert(Array.isArray(value.missingTickers), "Alpaca missingTickers must be an array");
  value.missingTickers.forEach((ticker, index) => assertTicker(ticker, `Alpaca missingTickers[${index}]`));
  assertSortedUnique(value.missingTickers as string[], "Alpaca missingTickers");
  assert(Array.isArray(value.unexpectedTickers), "Alpaca unexpectedTickers must be an array");
  value.unexpectedTickers.forEach((ticker, index) => assertTicker(ticker, `Alpaca unexpectedTickers[${index}]`));
  assertSortedUnique(value.unexpectedTickers as string[], "Alpaca unexpectedTickers");
  assert(Array.isArray(value.batches), "Alpaca batches must be an array");
  value.batches.forEach((batch, index) => {
    assert(isRecord(batch), `Alpaca batch ${index} must be an object`);
    assertExactKeys(
      batch,
      [
        "index",
        "status",
        "requestedAtISO",
        "receivedAtISO",
        "requestedCount",
        "returnedCount",
        "missingTickers",
        "unexpectedTickers",
      ],
      `Alpaca batch ${index}`,
    );
    assertNonNegativeInteger(batch.index, `Alpaca batch ${index}.index`);
    assert(batch.index === index, `Alpaca batch ${index}.index is not contiguous`);
    assert(
      ["complete", "request_failed", "invalid_payload", "incomplete_payload"].includes(
        batch.status as string,
      ),
      `Alpaca batch ${index}.status is invalid`,
    );
    assertISO(batch.requestedAtISO, `Alpaca batch ${index}.requestedAtISO`);
    assertISO(batch.receivedAtISO, `Alpaca batch ${index}.receivedAtISO`);
    assert(Date.parse(batch.requestedAtISO) <= Date.parse(batch.receivedAtISO), `Alpaca batch ${index} timestamps are reversed`);
    assertNonNegativeInteger(batch.requestedCount, `Alpaca batch ${index}.requestedCount`);
    assertNonNegativeInteger(batch.returnedCount, `Alpaca batch ${index}.returnedCount`);
    assert(Array.isArray(batch.missingTickers), `Alpaca batch ${index}.missingTickers must be an array`);
    batch.missingTickers.forEach((ticker, tickerIndex) =>
      assertTicker(ticker, `Alpaca batch ${index}.missingTickers[${tickerIndex}]`),
    );
    assertSortedUnique(batch.missingTickers as string[], `Alpaca batch ${index}.missingTickers`);
    assert(Array.isArray(batch.unexpectedTickers), `Alpaca batch ${index}.unexpectedTickers must be an array`);
    batch.unexpectedTickers.forEach((ticker, tickerIndex) =>
      assertTicker(ticker, `Alpaca batch ${index}.unexpectedTickers[${tickerIndex}]`),
    );
    assertSortedUnique(batch.unexpectedTickers as string[], `Alpaca batch ${index}.unexpectedTickers`);
    assert(
      batch.returnedCount + batch.missingTickers.length === batch.requestedCount,
      `Alpaca batch ${index} membership does not cover its request`,
    );
    const hasCompleteMembership =
      batch.returnedCount === batch.requestedCount &&
      batch.missingTickers.length === 0 &&
      batch.unexpectedTickers.length === 0;
    assert(
      (batch.status === "complete") === hasCompleteMembership,
      `Alpaca batch ${index} status does not match membership`,
    );
  });
  const batchMissing = [...new Set(value.batches.flatMap((batch) => batch.missingTickers))].sort();
  const batchUnexpected = [
    ...new Set(value.batches.flatMap((batch) => batch.unexpectedTickers)),
  ].sort();
  if (value.batches.length > 0) {
    assert(JSON.stringify(value.missingTickers) === JSON.stringify(batchMissing), "Alpaca missingTickers do not match batches");
    assert(JSON.stringify(value.unexpectedTickers) === JSON.stringify(batchUnexpected), "Alpaca unexpectedTickers do not match batches");
  }
  const batchRequestedCount = value.batches.reduce((sum, batch) => sum + batch.requestedCount, 0);
  const batchReturnedCount = value.batches.reduce((sum, batch) => sum + batch.returnedCount, 0);
  if (value.batches.length > 0) {
    assert(batchRequestedCount === value.requestedCount, "Alpaca batch requested counts do not match aggregate");
    assert(batchReturnedCount === value.returnedCount, "Alpaca batch returned counts do not match aggregate");
  }
  if (value.status === "complete") {
    assert(value.requestedCount > 0 && value.batches.length > 0, "complete Alpaca audit has no request batches");
    assert(value.batches.every((batch) => batch.status === "complete"), "complete Alpaca audit contains an incomplete batch");
    assert(value.missingTickers.length === 0, "complete Alpaca audit contains missing tickers");
    assert(value.unexpectedTickers.length === 0, "complete Alpaca audit contains unexpected tickers");
    assert(value.returnedCount === value.requestedCount, "complete Alpaca audit has incomplete membership");
  }
  if (value.status === "partial") {
    assert(
      value.requestedCount > 0 &&
        value.batches.length > 0 &&
        value.batches.some((batch) => batch.status !== "complete"),
      "partial Alpaca audit has no incomplete batch",
    );
  }
  if (value.status === "empty_request") {
    assert(
      value.requestedCount === 0 &&
        value.returnedCount === 0 &&
        value.batches.length === 0 &&
        value.missingTickers.length === 0 &&
        value.unexpectedTickers.length === 0,
      "empty_request Alpaca audit has membership",
    );
  }
  if (value.status === "not_configured") {
    assert(
      value.returnedCount === 0 &&
        value.batches.length === 0 &&
        value.missingTickers.length === value.requestedCount &&
        value.unexpectedTickers.length === 0,
      "not_configured Alpaca audit has invalid membership",
    );
  }
}

/** Runtime validation for data read from disk or a remote archive. Pure. */
export function validateLearningUniversePayload(
  value: unknown,
): asserts value is LearningUniverseArtifactPayload {
  assert(isRecord(value), "payload must be an object");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "artifactType",
      "sourceRunId",
      "universeId",
      "universeDefinitionId",
      "codeRevision",
      "capturedAtISO",
      "decisionAtISO",
      "universeSource",
      "captureTrigger",
      "runAttempt",
      "inputWasLimited",
      "dryRun",
      "providerAudits",
      "eligibilityPolicy",
      "consideredCount",
      "gatedCount",
      "selectionTarget",
      "sourceUniverseTickers",
      "snapshotRequestedTickers",
      "preRankInputTickers",
      "eligibleTickers",
      "selectedForEnrichmentTickers",
      "candidates",
      "admissible",
      "quarantineReasons",
    ],
    "payload",
  );
  assert(value.schemaVersion === LEARNING_UNIVERSE_SCHEMA_VERSION, "schemaVersion is unsupported");
  assert(value.artifactType === LEARNING_UNIVERSE_ARTIFACT_TYPE, "artifactType is invalid");
  assert(typeof value.sourceRunId === "string" && /^[A-Za-z0-9_.:-]{8,160}$/.test(value.sourceRunId), "sourceRunId is invalid");
  assert(value.universeId === `${value.sourceRunId}:eligible`, "universeId is invalid");
  assert(value.universeDefinitionId === LEARNING_UNIVERSE_DEFINITION_ID, "universeDefinitionId is invalid");
  assert(typeof value.codeRevision === "string" && value.codeRevision.length > 0, "codeRevision is invalid");
  assertISO(value.capturedAtISO, "capturedAtISO");
  assertISO(value.decisionAtISO, "decisionAtISO");
  assert(Date.parse(value.capturedAtISO) <= Date.parse(value.decisionAtISO), "capturedAtISO is after decisionAtISO");
  assert(
    value.universeSource === "finnhub_us_common_stocks" || value.universeSource === "curated_fallback",
    "universeSource is invalid",
  );
  assert(
    value.captureTrigger === "github_actions" || value.captureTrigger === "manual" || value.captureTrigger === "local",
    "captureTrigger is invalid",
  );
  assert(typeof value.runAttempt === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value.runAttempt), "runAttempt is invalid");
  assert(typeof value.inputWasLimited === "boolean", "inputWasLimited must be boolean");
  assert(typeof value.dryRun === "boolean", "dryRun must be boolean");
  assert(isRecord(value.providerAudits), "providerAudits must be an object");
  assertExactKeys(value.providerAudits, ["finnhub", "alpaca"], "providerAudits");
  validateFinnhubAudit(value.providerAudits.finnhub);
  validateAlpacaAudit(value.providerAudits.alpaca);
  const capturedAtMs = Date.parse(value.capturedAtISO);
  assert(Date.parse(value.providerAudits.finnhub.receivedAtISO) <= capturedAtMs, "Finnhub evidence is after capture");
  assert(Date.parse(value.providerAudits.alpaca.receivedAtISO) <= capturedAtMs, "Alpaca evidence is after capture");
  value.providerAudits.alpaca.batches.forEach((batch, index) =>
    assert(Date.parse(batch.receivedAtISO) <= capturedAtMs, `Alpaca batch ${index} is after capture`),
  );

  assert(isRecord(value.eligibilityPolicy), "eligibilityPolicy must be an object");
  assertExactKeys(
    value.eligibilityPolicy,
    [
      "minPrice",
      "maxPrice",
      "minDollarVolume",
      "alwaysIncludeTickers",
      "tickerPattern",
      "securityTypes",
      "currency",
      "preRankVersion",
    ],
    "eligibilityPolicy",
  );
  assertFiniteNumber(value.eligibilityPolicy.minPrice, "eligibilityPolicy.minPrice", 0);
  assert(
    value.eligibilityPolicy.maxPrice === null ||
      (typeof value.eligibilityPolicy.maxPrice === "number" &&
        Number.isFinite(value.eligibilityPolicy.maxPrice) &&
        value.eligibilityPolicy.maxPrice >= value.eligibilityPolicy.minPrice),
    "eligibilityPolicy.maxPrice is invalid",
  );
  assertFiniteNumber(value.eligibilityPolicy.minDollarVolume, "eligibilityPolicy.minDollarVolume", 0);
  assert(value.eligibilityPolicy.minDollarVolume > 0, "eligibilityPolicy.minDollarVolume must be positive");
  assert(Array.isArray(value.eligibilityPolicy.alwaysIncludeTickers), "alwaysIncludeTickers must be an array");
  value.eligibilityPolicy.alwaysIncludeTickers.forEach((ticker, index) =>
    assertTicker(ticker, `alwaysIncludeTickers[${index}]`),
  );
  assert(
    new Set(value.eligibilityPolicy.alwaysIncludeTickers).size ===
      value.eligibilityPolicy.alwaysIncludeTickers.length,
    "alwaysIncludeTickers must be unique",
  );
  assert(value.eligibilityPolicy.tickerPattern === "^[A-Z]{1,5}$", "tickerPattern is invalid");
  assert(
    JSON.stringify(value.eligibilityPolicy.securityTypes) === JSON.stringify(["Common Stock", "ADR", "REIT"]),
    "securityTypes are invalid",
  );
  assert(value.eligibilityPolicy.currency === "USD", "currency is invalid");
  assert(value.eligibilityPolicy.preRankVersion === "pre_rank_v1", "preRankVersion is invalid");
  assertNonNegativeInteger(value.consideredCount, "consideredCount");
  assertNonNegativeInteger(value.gatedCount, "gatedCount");
  assertNonNegativeInteger(value.selectionTarget, "selectionTarget");

  assert(Array.isArray(value.sourceUniverseTickers), "sourceUniverseTickers must be an array");
  value.sourceUniverseTickers.forEach((ticker, index) => assertTicker(ticker, `sourceUniverseTickers[${index}]`));
  assertSortedUnique(value.sourceUniverseTickers as string[], "sourceUniverseTickers");
  assert(Array.isArray(value.snapshotRequestedTickers), "snapshotRequestedTickers must be an array");
  value.snapshotRequestedTickers.forEach((ticker, index) => assertTicker(ticker, `snapshotRequestedTickers[${index}]`));
  assertSortedUnique(value.snapshotRequestedTickers as string[], "snapshotRequestedTickers");
  assert(Array.isArray(value.preRankInputTickers), "preRankInputTickers must be an array");
  value.preRankInputTickers.forEach((ticker, index) => assertTicker(ticker, `preRankInputTickers[${index}]`));
  assert(
    new Set(value.preRankInputTickers).size === value.preRankInputTickers.length,
    "preRankInputTickers must be unique",
  );
  assert(Array.isArray(value.eligibleTickers), "eligibleTickers must be an array");
  value.eligibleTickers.forEach((ticker, index) => assertTicker(ticker, `eligibleTickers[${index}]`));
  assertSortedUnique(value.eligibleTickers as string[], "eligibleTickers");
  assert(Array.isArray(value.selectedForEnrichmentTickers), "selectedForEnrichmentTickers must be an array");
  value.selectedForEnrichmentTickers.forEach((ticker, index) =>
    assertTicker(ticker, `selectedForEnrichmentTickers[${index}]`),
  );
  assert(
    new Set(value.selectedForEnrichmentTickers).size === value.selectedForEnrichmentTickers.length,
    "selectedForEnrichmentTickers must be unique",
  );

  assert(Array.isArray(value.candidates), "candidates must be an array");
  value.candidates.forEach((candidate, index) => {
    assert(isRecord(candidate), `candidates[${index}] must be an object`);
    assertExactKeys(
      candidate,
      [
        "ticker",
        "name",
        "price",
        "prevClose",
        "dayChange",
        "dollarVolume",
        "rangePct",
        "quoteAsOfISO",
        "priceSource",
        "priceAsOfISO",
        "prevCloseSource",
        "prevCloseAsOfISO",
        "liquiditySource",
        "liquidityAsOfISO",
        "rangeSource",
        "rangeAsOfISO",
        "floorPassed",
        "seeded",
        "seedBypass",
        "eligible",
        "preRankScore",
      ],
      `candidates[${index}]`,
    );
    assertTicker(candidate.ticker, `candidates[${index}].ticker`);
    assert(typeof candidate.name === "string" && candidate.name.length > 0, `candidates[${index}].name is invalid`);
    assertFiniteNumber(candidate.price, `candidates[${index}].price`, 0);
    assert(candidate.price > 0, `candidates[${index}].price must be positive`);
    assertFiniteNumber(candidate.prevClose, `candidates[${index}].prevClose`, 0);
    assert(candidate.prevClose > 0, `candidates[${index}].prevClose must be positive`);
    assertFiniteNumber(candidate.dayChange, `candidates[${index}].dayChange`);
    assertFiniteNumber(candidate.dollarVolume, `candidates[${index}].dollarVolume`, 0);
    assertFiniteNumber(candidate.rangePct, `candidates[${index}].rangePct`, 0);
    assertISO(candidate.quoteAsOfISO, `candidates[${index}].quoteAsOfISO`);
    assert(Date.parse(candidate.quoteAsOfISO) <= capturedAtMs, `candidates[${index}].quoteAsOfISO is after capture`);
    assert(
      ["latest_trade", "daily_bar", "minute_bar", "previous_daily_bar"].includes(candidate.priceSource as string),
      `candidates[${index}].priceSource is invalid`,
    );
    assert(candidate.priceAsOfISO === null || typeof candidate.priceAsOfISO === "string", `candidates[${index}].priceAsOfISO is invalid`);
    if (candidate.priceAsOfISO !== null) {
      assertISO(candidate.priceAsOfISO, `candidates[${index}].priceAsOfISO`);
      assert(Date.parse(candidate.priceAsOfISO) <= capturedAtMs, `candidates[${index}].priceAsOfISO is after capture`);
    }
    assert(
      candidate.prevCloseSource === "previous_daily_bar" || candidate.prevCloseSource === "price_fallback",
      `candidates[${index}].prevCloseSource is invalid`,
    );
    assert(candidate.prevCloseAsOfISO === null || typeof candidate.prevCloseAsOfISO === "string", `candidates[${index}].prevCloseAsOfISO is invalid`);
    if (candidate.prevCloseAsOfISO !== null) {
      assertISO(candidate.prevCloseAsOfISO, `candidates[${index}].prevCloseAsOfISO`);
      assert(Date.parse(candidate.prevCloseAsOfISO) <= capturedAtMs, `candidates[${index}].prevCloseAsOfISO is after capture`);
    }
    assert(
      ["previous_daily_bar", "daily_bar", "imputed"].includes(candidate.liquiditySource as string),
      `candidates[${index}].liquiditySource is invalid`,
    );
    assert(candidate.liquidityAsOfISO === null || typeof candidate.liquidityAsOfISO === "string", `candidates[${index}].liquidityAsOfISO is invalid`);
    if (candidate.liquidityAsOfISO !== null) {
      assertISO(candidate.liquidityAsOfISO, `candidates[${index}].liquidityAsOfISO`);
      assert(Date.parse(candidate.liquidityAsOfISO) <= capturedAtMs, `candidates[${index}].liquidityAsOfISO is after capture`);
    }
    assert(
      candidate.liquiditySource !== "imputed" || candidate.liquidityAsOfISO === null,
      `candidates[${index}].liquidityAsOfISO must be null when imputed`,
    );
    assert(
      ["previous_daily_bar", "daily_bar", "imputed"].includes(candidate.rangeSource as string),
      `candidates[${index}].rangeSource is invalid`,
    );
    assert(candidate.rangeAsOfISO === null || typeof candidate.rangeAsOfISO === "string", `candidates[${index}].rangeAsOfISO is invalid`);
    if (candidate.rangeAsOfISO !== null) {
      assertISO(candidate.rangeAsOfISO, `candidates[${index}].rangeAsOfISO`);
      assert(Date.parse(candidate.rangeAsOfISO) <= capturedAtMs, `candidates[${index}].rangeAsOfISO is after capture`);
    }
    assert(
      candidate.rangeSource !== "imputed" || candidate.rangeAsOfISO === null,
      `candidates[${index}].rangeAsOfISO must be null when imputed`,
    );
    assert(typeof candidate.floorPassed === "boolean", `candidates[${index}].floorPassed must be boolean`);
    assert(typeof candidate.seeded === "boolean", `candidates[${index}].seeded must be boolean`);
    assert(typeof candidate.seedBypass === "boolean", `candidates[${index}].seedBypass must be boolean`);
    assert(typeof candidate.eligible === "boolean", `candidates[${index}].eligible must be boolean`);
    assert(candidate.preRankScore === null || typeof candidate.preRankScore === "number", `candidates[${index}].preRankScore is invalid`);
    if (candidate.preRankScore !== null) {
      assertFiniteNumber(candidate.preRankScore, `candidates[${index}].preRankScore`, 0);
      assert(candidate.preRankScore <= 1, `candidates[${index}].preRankScore must be <= 1`);
    }
  });
  const candidateTickers = value.candidates.map((candidate) => candidate.ticker as string);
  assertSortedUnique(candidateTickers, "candidates");
  const eligibleSet = new Set(value.eligibleTickers);
  const requestedSet = new Set(value.snapshotRequestedTickers);
  const sourceSet = new Set(value.sourceUniverseTickers);
  assert(
    value.snapshotRequestedTickers.every((ticker) => sourceSet.has(ticker)),
    "snapshotRequestedTickers contains a ticker outside the source universe",
  );
  assert(
    value.snapshotRequestedTickers.length === value.providerAudits.alpaca.requestedCount,
    "snapshotRequestedTickers do not match the Alpaca requested count",
  );
  if (value.universeSource === "finnhub_us_common_stocks") {
    assert(
      value.sourceUniverseTickers.length === value.providerAudits.finnhub.eligibleEntryCount,
      "sourceUniverseTickers do not match Finnhub eligible membership",
    );
  }
  if (!value.inputWasLimited) {
    assert(
      JSON.stringify(value.snapshotRequestedTickers) === JSON.stringify(value.sourceUniverseTickers),
      "uncapped snapshot membership must equal source membership",
    );
  }
  assert(
    value.providerAudits.alpaca.missingTickers.every((ticker) => requestedSet.has(ticker)),
    "Alpaca missingTickers contains an unrequested ticker",
  );
  assert(
    value.providerAudits.alpaca.unexpectedTickers.every((ticker) => !requestedSet.has(ticker)),
    "Alpaca unexpectedTickers contains a requested ticker",
  );
  assert(
    value.providerAudits.alpaca.returnedCount + value.providerAudits.alpaca.missingTickers.length ===
      value.providerAudits.alpaca.requestedCount,
    "Alpaca returned and missing membership do not cover the request",
  );
  assert(
    value.eligibleTickers.every((ticker) => requestedSet.has(ticker)),
    "eligibleTickers contains a ticker that was not requested from Alpaca",
  );
  const missingSet = new Set(value.providerAudits.alpaca.missingTickers);
  const expectedReturnedTickers = value.snapshotRequestedTickers.filter((ticker) => !missingSet.has(ticker));
  assert(
    JSON.stringify(candidateTickers) === JSON.stringify(expectedReturnedTickers),
    "candidates must exactly match returned Alpaca membership",
  );
  assert(value.candidates.length === value.providerAudits.alpaca.returnedCount, "candidate count does not match Alpaca returnedCount");
  assert(value.consideredCount === value.candidates.length, "consideredCount must match all returned normalized quotes");
  const preRankInputSet = new Set(value.preRankInputTickers);
  assert(
    preRankInputSet.size === candidateTickers.length && candidateTickers.every((ticker) => preRankInputSet.has(ticker)),
    "preRankInputTickers must exactly match candidates",
  );
  const candidateByTicker = new Map(
    value.candidates.map((candidate) => [candidate.ticker as string, candidate as unknown as LearningUniverseCandidate]),
  );
  const orderedCandidates = value.preRankInputTickers.map((ticker) => candidateByTicker.get(ticker)!);
  const recomputed = preRankUniverse(
    orderedCandidates.map(({ ticker, price, prevClose, dayChange, dollarVolume, rangePct }) => ({
      ticker,
      price,
      prevClose,
      dayChange,
      dollarVolume,
      rangePct,
    })),
    {
      target: value.selectionTarget,
      minPrice: value.eligibilityPolicy.minPrice,
      maxPrice: value.eligibilityPolicy.maxPrice ?? undefined,
      minDollarVolume: value.eligibilityPolicy.minDollarVolume,
      alwaysInclude: value.eligibilityPolicy.alwaysIncludeTickers,
    },
  );
  assert(recomputed.consideredCount === value.consideredCount, "consideredCount does not recompute");
  assert(recomputed.gatedCount === value.gatedCount, "gatedCount does not recompute");
  const recomputedEligibleTickers = sortedUniqueTickers(
    recomputed.eligibleRows.map((candidate) => candidate.ticker),
  );
  assert(
    JSON.stringify(recomputedEligibleTickers) === JSON.stringify(value.eligibleTickers),
    "eligibleTickers do not recompute from the full observed universe",
  );
  assert(
    JSON.stringify(recomputed.tickers) === JSON.stringify(value.selectedForEnrichmentTickers),
    "selectedForEnrichmentTickers do not recompute",
  );
  const recomputedScores = new Map(recomputed.eligibleRows.map((candidate) => [candidate.ticker, candidate.score]));
  const seedSet = new Set(value.eligibilityPolicy.alwaysIncludeTickers);
  const maxPrice = value.eligibilityPolicy.maxPrice ?? Infinity;
  for (const candidate of value.candidates as unknown as LearningUniverseCandidate[]) {
    const floorPassed =
      candidate.price >= value.eligibilityPolicy.minPrice &&
      candidate.price <= maxPrice &&
      candidate.prevClose > 0 &&
      candidate.dollarVolume >= value.eligibilityPolicy.minDollarVolume;
    const seeded = seedSet.has(candidate.ticker);
    const expectedScore = recomputedScores.get(candidate.ticker);
    assert(candidate.floorPassed === floorPassed, `${candidate.ticker} floorPassed is false provenance`);
    assert(candidate.seeded === seeded, `${candidate.ticker} seeded is false provenance`);
    assert(candidate.seedBypass === (seeded && !floorPassed), `${candidate.ticker} seedBypass is false provenance`);
    assert(candidate.eligible === (expectedScore !== undefined), `${candidate.ticker} eligible is false provenance`);
    assert(candidate.preRankScore === (expectedScore ?? null), `${candidate.ticker} preRankScore does not recompute`);
  }
  assert(
    value.selectedForEnrichmentTickers.every((ticker) => eligibleSet.has(ticker)),
    "selectedForEnrichmentTickers contains an ineligible ticker",
  );

  assert(typeof value.admissible === "boolean", "admissible must be boolean");
  assert(Array.isArray(value.quarantineReasons), "quarantineReasons must be an array");
  const allowedReasons: LearningUniverseQuarantineReason[] = [
    "finnhub_universe_incomplete",
    "finnhub_universe_completeness_unproven",
    "curated_universe_fallback",
    "universe_input_limited",
    "alpaca_snapshots_incomplete",
    "incomplete_field_provenance",
    "unverified_code_revision",
    "empty_eligible_universe",
    "dry_run",
  ];
  value.quarantineReasons.forEach((reason) =>
    assert(allowedReasons.includes(reason as LearningUniverseQuarantineReason), "quarantine reason is invalid"),
  );
  assertSortedUnique(value.quarantineReasons as string[], "quarantineReasons");
  const expectedReasons = deriveQuarantineReasons(
    value as unknown as BuildLearningUniversePayloadInput,
    value.candidates as LearningUniverseCandidate[],
    value.eligibleTickers.length,
  );
  assert(JSON.stringify(value.quarantineReasons) === JSON.stringify(expectedReasons), "quarantineReasons were not derived from provenance");
  assert(value.admissible === (expectedReasons.length === 0), "admissible was not derived from provenance");
}

function normalizeCanonicalValue(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      assert(unit !== 0, `${path} contains a PostgreSQL-incompatible NUL`);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        assert(next >= 0xdc00 && next <= 0xdfff, `${path} contains invalid Unicode`);
        index++;
      } else {
        assert(!(unit >= 0xdc00 && unit <= 0xdfff), `${path} contains invalid Unicode`);
      }
    }
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  assert(typeof value === "object", `${path} contains an unsupported value`);
  assert(!seen.has(value), `${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((entry, index) => normalizeCanonicalValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return normalized;
  }
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    assert(record[key] !== undefined, `${path}.${key} is undefined`);
    normalized[key] = normalizeCanonicalValue(record[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return normalized;
}

/** RFC-8259 JSON with recursively sorted object keys and preserved array order. */
export function canonicalizeLearningUniverseJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value, "$", new WeakSet<object>()));
}

export function validateLearningUniverseEnvelope(
  value: unknown,
  recomputedSha256: string,
): asserts value is LearningUniverseArtifactEnvelope {
  assert(isRecord(value), "envelope must be an object");
  assertExactKeys(value, ["artifactId", "artifactSha256", "payload"], "envelope");
  assert(typeof value.artifactSha256 === "string" && /^[0-9a-f]{64}$/.test(value.artifactSha256), "artifactSha256 is invalid");
  assert(value.artifactId === `sha256:${value.artifactSha256}`, "artifactId does not match artifactSha256");
  assert(value.artifactSha256 === recomputedSha256.toLowerCase(), "artifact digest verification failed");
  validateLearningUniversePayload(value.payload);
}

/**
 * Validate bytes and expose the complete observed candidate evidence for audit.
 * Quarantine state is retained and callers must not treat this as learning-ready.
 */
export function toValidatedUniverseEvidence(
  envelope: unknown,
  recomputedSha256: string,
): ValidatedUniverseEvidence {
  validateLearningUniverseEnvelope(envelope, recomputedSha256);
  const candidates = envelope.payload.candidates.map((candidate) => ({ ...candidate }));
  return {
    artifactId: envelope.artifactId,
    artifactSha256: envelope.artifactSha256,
    sourceRunId: envelope.payload.sourceRunId,
    universeId: envelope.payload.universeId,
    universeDefinitionId: envelope.payload.universeDefinitionId,
    codeRevision: envelope.payload.codeRevision,
    capturedAtISO: envelope.payload.capturedAtISO,
    decisionAtISO: envelope.payload.decisionAtISO,
    eligibleTickers: [...envelope.payload.eligibleTickers],
    candidates,
    eligibleCandidates: candidates.filter((candidate) => candidate.eligible),
    admissible: envelope.payload.admissible,
    quarantineReasons: [...envelope.payload.quarantineReasons],
  };
}

/** Refuse quarantined data at the future learning-data boundary. */
export function toVerifiedUniverseArtifact(
  envelope: unknown,
  recomputedSha256: string,
): VerifiedUniverseArtifact {
  const evidence = toValidatedUniverseEvidence(envelope, recomputedSha256);
  assert(evidence.admissible, "quarantined artifact cannot enter the learning bridge");
  const { admissible: _admissible, quarantineReasons: _quarantineReasons, ...verified } = evidence;
  return verified;
}
