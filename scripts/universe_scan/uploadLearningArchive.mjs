import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createClient } from "@supabase/supabase-js";

const HASH_DOMAIN = "catalyzed.learning-universe.v1\0";
const FINNHUB_MIN_EXPECTED_ELIGIBLE = 1_001;

function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid learning-universe archive: ${message}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value, path, minimum) {
  invariant(typeof value === "number" && Number.isFinite(value), `${path} must be finite`);
  if (minimum !== undefined) invariant(value >= minimum, `${path} must be >= ${minimum}`);
}

function nonNegativeInteger(value, path) {
  finiteNumber(value, path, 0);
  invariant(Number.isInteger(value), `${path} must be an integer`);
}

function utcTimestamp(value, path) {
  invariant(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value)),
    `${path} must be a valid UTC timestamp`,
  );
  return Date.parse(value);
}

function ticker(value, path) {
  invariant(typeof value === "string" && /^[A-Z][A-Z.]{0,6}$/.test(value), `${path} is invalid`);
}

function oneOf(value, allowed, path) {
  invariant(allowed.includes(value), `${path} is invalid`);
}

function exactKeys(value, expected, path) {
  invariant(isRecord(value), `${path} must be an object`);
  invariant(
    Object.keys(value).sort().join(",") === [...expected].sort().join(","),
    `${path} fields are invalid`,
  );
}

function sortedUniqueStrings(value, path) {
  invariant(Array.isArray(value) && value.every((entry) => typeof entry === "string"), `${path} must be strings`);
  invariant(value.join(",") === [...new Set(value)].sort().join(","), `${path} must be sorted and unique`);
}

function percentileRanks(values) {
  if (values.length <= 1) return values.map(() => (values.length === 1 ? 1 : 0));
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((value) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= value) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return (last + 1) / sorted.length;
  });
}

function recomputePreRank(payload) {
  const byTicker = new Map(payload.candidates.map((candidate) => [candidate.ticker, candidate]));
  const considered = payload.preRankInputTickers.map((ticker) => byTicker.get(ticker));
  const policy = payload.eligibilityPolicy;
  const maxPrice = policy.maxPrice ?? Infinity;
  const floorPassed = (candidate) =>
    candidate.price >= policy.minPrice &&
    candidate.price <= maxPrice &&
    candidate.prevClose > 0 &&
    candidate.dollarVolume >= policy.minDollarVolume;
  const seedSet = new Set(policy.alwaysIncludeTickers);
  const gated = considered.filter(floorPassed);
  const pool = considered.filter((candidate) => floorPassed(candidate) || seedSet.has(candidate.ticker));
  const moveRanks = percentileRanks(pool.map((candidate) => Math.abs(candidate.dayChange)));
  const rangeRanks = percentileRanks(pool.map((candidate) => Math.max(0, candidate.rangePct)));
  const liquidity = (dollarVolume) => {
    if (dollarVolume <= policy.minDollarVolume) return 0;
    const span = Math.log10(1_000_000_000) - Math.log10(policy.minDollarVolume);
    if (span <= 0) return 1;
    return Math.max(
      0,
      Math.min(1, (Math.log10(dollarVolume) - Math.log10(policy.minDollarVolume)) / span),
    );
  };
  const scored = pool.map((candidate, index) => ({
    ticker: candidate.ticker,
    score:
      0.45 * (rangeRanks[index] ?? 0) +
      0.35 * (moveRanks[index] ?? 0) +
      0.2 * liquidity(candidate.dollarVolume),
  }));
  const scoreByTicker = new Map(scored.map((candidate) => [candidate.ticker, candidate.score]));
  const selected = [];
  const taken = new Set();
  for (const ticker of policy.alwaysIncludeTickers) {
    if (scoreByTicker.has(ticker) && !taken.has(ticker)) {
      selected.push(ticker);
      taken.add(ticker);
    }
  }
  const rest = scored
    .filter((candidate) => !taken.has(candidate.ticker))
    .sort(
      (a, b) =>
        b.score - a.score ||
        byTicker.get(b.ticker).dollarVolume - byTicker.get(a.ticker).dollarVolume,
    );
  const target = Math.max(0, Math.floor(payload.selectionTarget));
  for (const candidate of rest) {
    if (selected.length >= target) break;
    selected.push(candidate.ticker);
  }
  return { considered, gated, scored, scoreByTicker, floorPassed, seedSet, selected };
}

function verifyPayloadContract(payload) {
  exactKeys(
    payload,
    [
      "schemaVersion", "artifactType", "sourceRunId", "universeId", "universeDefinitionId",
      "codeRevision", "capturedAtISO", "decisionAtISO", "universeSource", "captureTrigger",
      "runAttempt", "inputWasLimited", "dryRun", "providerAudits", "eligibilityPolicy",
      "consideredCount", "gatedCount", "selectionTarget", "sourceUniverseTickers",
      "snapshotRequestedTickers", "preRankInputTickers", "eligibleTickers", "selectedForEnrichmentTickers",
      "candidates", "admissible", "quarantineReasons",
    ],
    "payload",
  );
  invariant(payload.schemaVersion === 1, "unsupported schema version");
  invariant(
    payload.artifactType === "catalyzed.minimum_coverage_candidate_universe",
    "artifact type mismatch",
  );
  invariant(
    typeof payload.sourceRunId === "string" && /^[A-Za-z0-9_.:-]{8,160}$/.test(payload.sourceRunId),
    "sourceRunId is invalid",
  );
  invariant(payload.universeId === `${payload.sourceRunId}:eligible`, "universeId mismatch");
  invariant(
    payload.universeDefinitionId === "catalyzed-us-common-stock-prerank-minimum-coverage-v1",
    "universeDefinitionId mismatch",
  );
  invariant(typeof payload.codeRevision === "string" && payload.codeRevision.length > 0, "codeRevision is invalid");
  const capturedAtMs = utcTimestamp(payload.capturedAtISO, "capturedAtISO");
  const decisionAtMs = utcTimestamp(payload.decisionAtISO, "decisionAtISO");
  invariant(capturedAtMs <= decisionAtMs, "timestamp order is invalid");
  oneOf(payload.universeSource, ["finnhub_us_common_stocks", "curated_fallback"], "universeSource");
  oneOf(payload.captureTrigger, ["github_actions", "manual", "local"], "captureTrigger");
  invariant(
    typeof payload.runAttempt === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(payload.runAttempt),
    "runAttempt is invalid",
  );
  invariant(typeof payload.inputWasLimited === "boolean", "inputWasLimited must be boolean");
  invariant(typeof payload.dryRun === "boolean", "dryRun must be boolean");
  exactKeys(payload.providerAudits, ["finnhub", "alpaca"], "providerAudits");
  exactKeys(
    payload.providerAudits.finnhub,
    [
      "provider", "endpoint", "status", "requestedAtISO", "receivedAtISO", "rawRowCount",
      "eligibleEntryCount", "minimumExpectedEligibleCount",
    ],
    "providerAudits.finnhub",
  );
  const finnhub = payload.providerAudits.finnhub;
  invariant(finnhub.provider === "finnhub", "Finnhub provider is invalid");
  invariant(finnhub.endpoint === "/stock/symbol?exchange=US", "Finnhub endpoint is invalid");
  oneOf(
    finnhub.status,
    [
      "minimum_coverage_met", "not_configured", "request_failed", "invalid_payload", "empty_payload",
      "empty_eligible", "coverage_below_minimum",
    ],
    "Finnhub status",
  );
  const finnhubRequestedAt = utcTimestamp(finnhub.requestedAtISO, "Finnhub requestedAtISO");
  const finnhubReceivedAt = utcTimestamp(finnhub.receivedAtISO, "Finnhub receivedAtISO");
  invariant(finnhubRequestedAt <= finnhubReceivedAt, "Finnhub timestamps are reversed");
  nonNegativeInteger(finnhub.rawRowCount, "Finnhub rawRowCount");
  nonNegativeInteger(finnhub.eligibleEntryCount, "Finnhub eligibleEntryCount");
  nonNegativeInteger(finnhub.minimumExpectedEligibleCount, "Finnhub minimumExpectedEligibleCount");
  invariant(finnhub.minimumExpectedEligibleCount > 0, "Finnhub minimumExpectedEligibleCount must be positive");
  invariant(finnhub.rawRowCount >= finnhub.eligibleEntryCount, "Finnhub eligible count exceeds raw rows");
  if (finnhub.status === "minimum_coverage_met") {
    invariant(
      finnhub.minimumExpectedEligibleCount >= FINNHUB_MIN_EXPECTED_ELIGIBLE &&
        finnhub.rawRowCount > 0 &&
        finnhub.eligibleEntryCount >= finnhub.minimumExpectedEligibleCount,
      "Finnhub coverage is below its production minimum",
    );
  } else if (["not_configured", "request_failed", "invalid_payload", "empty_payload"].includes(finnhub.status)) {
    invariant(
      finnhub.rawRowCount === 0 && finnhub.eligibleEntryCount === 0,
      `Finnhub ${finnhub.status} status has unexpected membership`,
    );
  } else if (finnhub.status === "empty_eligible") {
    invariant(finnhub.rawRowCount > 0 && finnhub.eligibleEntryCount === 0, "Finnhub empty_eligible shape is invalid");
  } else {
    invariant(
      finnhub.eligibleEntryCount > 0 && finnhub.eligibleEntryCount < finnhub.minimumExpectedEligibleCount,
      "Finnhub coverage_below_minimum shape is invalid",
    );
  }
  exactKeys(
    payload.providerAudits.alpaca,
    [
      "provider", "endpoint", "feed", "status", "requestedAtISO", "receivedAtISO",
      "requestedCount", "returnedCount", "missingTickers", "unexpectedTickers", "batches",
    ],
    "providerAudits.alpaca",
  );
  const alpaca = payload.providerAudits.alpaca;
  invariant(alpaca.provider === "alpaca", "Alpaca provider is invalid");
  invariant(alpaca.endpoint === "/v2/stocks/snapshots", "Alpaca endpoint is invalid");
  invariant(alpaca.feed === "iex", "Alpaca feed is invalid");
  oneOf(alpaca.status, ["complete", "partial", "not_configured", "empty_request"], "Alpaca status");
  const alpacaRequestedAt = utcTimestamp(alpaca.requestedAtISO, "Alpaca requestedAtISO");
  const alpacaReceivedAt = utcTimestamp(alpaca.receivedAtISO, "Alpaca receivedAtISO");
  invariant(alpacaRequestedAt <= alpacaReceivedAt, "Alpaca timestamps are reversed");
  nonNegativeInteger(alpaca.requestedCount, "Alpaca requestedCount");
  nonNegativeInteger(alpaca.returnedCount, "Alpaca returnedCount");
  invariant(Array.isArray(alpaca.missingTickers), "Alpaca missingTickers must be an array");
  alpaca.missingTickers.forEach((value, index) => ticker(value, `Alpaca missingTickers[${index}]`));
  sortedUniqueStrings(alpaca.missingTickers, "providerAudits.alpaca.missingTickers");
  invariant(Array.isArray(alpaca.unexpectedTickers), "Alpaca unexpectedTickers must be an array");
  alpaca.unexpectedTickers.forEach((value, index) => ticker(value, `Alpaca unexpectedTickers[${index}]`));
  sortedUniqueStrings(alpaca.unexpectedTickers, "providerAudits.alpaca.unexpectedTickers");
  invariant(Array.isArray(alpaca.batches), "Alpaca batches must be an array");
  alpaca.batches.forEach((batch, index) => {
    exactKeys(
      batch,
      [
        "index", "status", "requestedAtISO", "receivedAtISO", "requestedCount",
        "returnedCount", "missingTickers", "unexpectedTickers",
      ],
      `providerAudits.alpaca.batches[${index}]`,
    );
    nonNegativeInteger(batch.index, `Alpaca batch ${index}.index`);
    invariant(batch.index === index, `Alpaca batch ${index}.index is not contiguous`);
    oneOf(
      batch.status,
      ["complete", "request_failed", "invalid_payload", "incomplete_payload"],
      `Alpaca batch ${index}.status`,
    );
    const requestedAt = utcTimestamp(batch.requestedAtISO, `Alpaca batch ${index}.requestedAtISO`);
    const receivedAt = utcTimestamp(batch.receivedAtISO, `Alpaca batch ${index}.receivedAtISO`);
    invariant(requestedAt <= receivedAt, `Alpaca batch ${index} timestamps are reversed`);
    nonNegativeInteger(batch.requestedCount, `Alpaca batch ${index}.requestedCount`);
    nonNegativeInteger(batch.returnedCount, `Alpaca batch ${index}.returnedCount`);
    invariant(Array.isArray(batch.missingTickers), `Alpaca batch ${index}.missingTickers must be an array`);
    batch.missingTickers.forEach((value, tickerIndex) => ticker(value, `Alpaca batch ${index}.missingTickers[${tickerIndex}]`));
    sortedUniqueStrings(batch.missingTickers, `Alpaca batch ${index}.missingTickers`);
    invariant(Array.isArray(batch.unexpectedTickers), `Alpaca batch ${index}.unexpectedTickers must be an array`);
    batch.unexpectedTickers.forEach((value, tickerIndex) => ticker(value, `Alpaca batch ${index}.unexpectedTickers[${tickerIndex}]`));
    sortedUniqueStrings(batch.unexpectedTickers, `Alpaca batch ${index}.unexpectedTickers`);
    invariant(
      batch.returnedCount + batch.missingTickers.length === batch.requestedCount,
      `Alpaca batch ${index} membership mismatch`,
    );
    const batchHasCompleteMembership =
      batch.returnedCount === batch.requestedCount &&
      batch.missingTickers.length === 0 &&
      batch.unexpectedTickers.length === 0;
    invariant(
      (batch.status === "complete") === batchHasCompleteMembership,
      `Alpaca batch ${index} status does not match membership`,
    );
  });
  invariant(
    finnhubReceivedAt <= capturedAtMs &&
      alpacaReceivedAt <= capturedAtMs &&
      alpaca.batches.every((batch) => Date.parse(batch.receivedAtISO) <= capturedAtMs,
      ),
    "provider evidence is after capture",
  );
  const batchRequestedCount = alpaca.batches.reduce(
    (sum, batch) => sum + batch.requestedCount,
    0,
  );
  const batchReturnedCount = alpaca.batches.reduce(
    (sum, batch) => sum + batch.returnedCount,
    0,
  );
  const batchMissing = [...new Set(alpaca.batches.flatMap((batch) => batch.missingTickers))].sort();
  const batchUnexpected = [...new Set(alpaca.batches.flatMap((batch) => batch.unexpectedTickers))].sort();
  if (alpaca.batches.length > 0) {
    invariant(
      batchRequestedCount === alpaca.requestedCount && batchReturnedCount === alpaca.returnedCount,
      "Alpaca batch aggregate mismatch",
    );
    invariant(batchMissing.join(",") === alpaca.missingTickers.join(","), "Alpaca missingTickers do not match batches");
    invariant(batchUnexpected.join(",") === alpaca.unexpectedTickers.join(","), "Alpaca unexpectedTickers do not match batches");
  }
  if (alpaca.status === "complete") {
    invariant(
      alpaca.requestedCount > 0 &&
        alpaca.batches.length > 0 &&
        alpaca.returnedCount === alpaca.requestedCount &&
        alpaca.missingTickers.length === 0 &&
        alpaca.unexpectedTickers.length === 0 &&
        alpaca.batches.every((batch) => batch.status === "complete"),
      "Alpaca complete status has incomplete membership",
    );
  } else if (alpaca.status === "partial") {
    invariant(
      alpaca.requestedCount > 0 && alpaca.batches.length > 0 && alpaca.batches.some((batch) => batch.status !== "complete"),
      "Alpaca partial status has no incomplete batch",
    );
  } else if (alpaca.status === "empty_request") {
    invariant(
      alpaca.requestedCount === 0 && alpaca.returnedCount === 0 && alpaca.batches.length === 0 &&
        alpaca.missingTickers.length === 0 && alpaca.unexpectedTickers.length === 0,
      "Alpaca empty_request status has membership",
    );
  } else {
    invariant(
      alpaca.returnedCount === 0 && alpaca.batches.length === 0 &&
        alpaca.missingTickers.length === alpaca.requestedCount && alpaca.unexpectedTickers.length === 0,
      "Alpaca not_configured status has invalid membership",
    );
  }
  exactKeys(
    payload.eligibilityPolicy,
    [
      "minPrice", "maxPrice", "minDollarVolume", "alwaysIncludeTickers", "tickerPattern",
      "securityTypes", "currency", "preRankVersion",
    ],
    "eligibilityPolicy",
  );
  const policy = payload.eligibilityPolicy;
  finiteNumber(policy.minPrice, "eligibilityPolicy.minPrice", 0);
  invariant(
    policy.maxPrice === null ||
      (typeof policy.maxPrice === "number" &&
        Number.isFinite(policy.maxPrice) &&
        policy.maxPrice >= policy.minPrice),
    "eligibilityPolicy.maxPrice is invalid",
  );
  finiteNumber(policy.minDollarVolume, "eligibilityPolicy.minDollarVolume", 0);
  invariant(policy.minDollarVolume > 0, "eligibilityPolicy.minDollarVolume must be positive");
  invariant(Array.isArray(policy.alwaysIncludeTickers), "alwaysIncludeTickers must be an array");
  policy.alwaysIncludeTickers.forEach((value, index) => ticker(value, `alwaysIncludeTickers[${index}]`));
  invariant(
    new Set(policy.alwaysIncludeTickers).size === policy.alwaysIncludeTickers.length,
    "alwaysIncludeTickers must be unique",
  );
  invariant(policy.tickerPattern === "^[A-Z]{1,5}$", "tickerPattern is invalid");
  invariant(
    JSON.stringify(policy.securityTypes) === JSON.stringify(["Common Stock", "ADR", "REIT"]),
    "securityTypes are invalid",
  );
  invariant(policy.currency === "USD", "currency is invalid");
  invariant(policy.preRankVersion === "pre_rank_v1", "preRankVersion is invalid");
  nonNegativeInteger(payload.consideredCount, "consideredCount");
  nonNegativeInteger(payload.gatedCount, "gatedCount");
  nonNegativeInteger(payload.selectionTarget, "selectionTarget");

  for (const [path, values] of [
    ["sourceUniverseTickers", payload.sourceUniverseTickers],
    ["snapshotRequestedTickers", payload.snapshotRequestedTickers],
    ["eligibleTickers", payload.eligibleTickers],
  ]) {
    invariant(Array.isArray(values), `${path} must be an array`);
    values.forEach((value, index) => ticker(value, `${path}[${index}]`));
    sortedUniqueStrings(values, path);
  }
  invariant(Array.isArray(payload.selectedForEnrichmentTickers), "selectedForEnrichmentTickers must be an array");
  payload.selectedForEnrichmentTickers.forEach((value, index) => ticker(value, `selectedForEnrichmentTickers[${index}]`));
  invariant(new Set(payload.selectedForEnrichmentTickers).size === payload.selectedForEnrichmentTickers.length, "selection has duplicates");
  invariant(Array.isArray(payload.preRankInputTickers), "preRankInputTickers must be an array");
  payload.preRankInputTickers.forEach((value, index) => ticker(value, `preRankInputTickers[${index}]`));
  invariant(new Set(payload.preRankInputTickers).size === payload.preRankInputTickers.length, "preRankInputTickers has duplicates");
  invariant(Array.isArray(payload.candidates), "candidates must be an array");
  const candidateKeys = [
    "ticker", "name", "price", "prevClose", "dayChange", "dollarVolume", "rangePct",
    "quoteAsOfISO", "priceSource", "priceAsOfISO", "prevCloseSource", "prevCloseAsOfISO",
    "liquiditySource", "liquidityAsOfISO", "rangeSource", "rangeAsOfISO", "floorPassed",
    "seeded", "seedBypass", "eligible", "preRankScore",
  ];
  payload.candidates.forEach((candidate, index) => {
    exactKeys(candidate, candidateKeys, `candidates[${index}]`);
    const path = `candidates[${index}]`;
    ticker(candidate.ticker, `${path}.ticker`);
    invariant(typeof candidate.name === "string" && candidate.name.length > 0, `${path}.name is invalid`);
    finiteNumber(candidate.price, `${path}.price`, 0);
    invariant(candidate.price > 0, `${path}.price must be positive`);
    finiteNumber(candidate.prevClose, `${path}.prevClose`, 0);
    invariant(candidate.prevClose > 0, `${path}.prevClose must be positive`);
    finiteNumber(candidate.dayChange, `${path}.dayChange`);
    finiteNumber(candidate.dollarVolume, `${path}.dollarVolume`, 0);
    finiteNumber(candidate.rangePct, `${path}.rangePct`, 0);
    invariant(utcTimestamp(candidate.quoteAsOfISO, `${path}.quoteAsOfISO`) <= capturedAtMs, `${path}.quoteAsOfISO is after capture`);
    oneOf(candidate.priceSource, ["latest_trade", "daily_bar", "minute_bar", "previous_daily_bar"], `${path}.priceSource`);
    oneOf(candidate.prevCloseSource, ["previous_daily_bar", "price_fallback"], `${path}.prevCloseSource`);
    oneOf(candidate.liquiditySource, ["previous_daily_bar", "daily_bar", "imputed"], `${path}.liquiditySource`);
    oneOf(candidate.rangeSource, ["previous_daily_bar", "daily_bar", "imputed"], `${path}.rangeSource`);
    for (const [field, timestamp] of [
      ["priceAsOfISO", candidate.priceAsOfISO],
      ["prevCloseAsOfISO", candidate.prevCloseAsOfISO],
      ["liquidityAsOfISO", candidate.liquidityAsOfISO],
      ["rangeAsOfISO", candidate.rangeAsOfISO],
    ]) {
      invariant(timestamp === null || typeof timestamp === "string", `${path}.${field} is invalid`);
      if (timestamp !== null) {
        invariant(utcTimestamp(timestamp, `${path}.${field}`) <= capturedAtMs, `${path}.${field} is after capture`);
      }
    }
    invariant(
      candidate.liquiditySource !== "imputed" || candidate.liquidityAsOfISO === null,
      `${path}.liquidityAsOfISO must be null when imputed`,
    );
    invariant(
      candidate.rangeSource !== "imputed" || candidate.rangeAsOfISO === null,
      `${path}.rangeAsOfISO must be null when imputed`,
    );
    invariant(typeof candidate.floorPassed === "boolean", `${path}.floorPassed must be boolean`);
    invariant(typeof candidate.seeded === "boolean", `${path}.seeded must be boolean`);
    invariant(typeof candidate.seedBypass === "boolean", `${path}.seedBypass must be boolean`);
    invariant(typeof candidate.eligible === "boolean", `${path}.eligible must be boolean`);
    invariant(candidate.preRankScore === null || typeof candidate.preRankScore === "number", `${path}.preRankScore is invalid`);
    if (candidate.preRankScore !== null) {
      finiteNumber(candidate.preRankScore, `${path}.preRankScore`, 0);
      invariant(candidate.preRankScore <= 1, `${path}.preRankScore must be <= 1`);
    }
  });
  const candidateTickers = payload.candidates.map((candidate) => candidate.ticker);
  sortedUniqueStrings(candidateTickers, "candidate membership");
  const eligible = new Set(payload.eligibleTickers);
  const requested = new Set(payload.snapshotRequestedTickers);
  const source = new Set(payload.sourceUniverseTickers);
  const missing = new Set(payload.providerAudits?.alpaca?.missingTickers ?? []);
  invariant(
    payload.snapshotRequestedTickers.every((value) => source.has(value)),
    "snapshot request contains a ticker outside the source universe",
  );
  invariant(payload.providerAudits?.alpaca?.requestedCount === requested.size, "Alpaca requested membership mismatch");
  invariant(
    payload.providerAudits?.alpaca?.returnedCount + missing.size === requested.size,
    "Alpaca returned/missing membership mismatch",
  );
  invariant([...missing].every((ticker) => requested.has(ticker)), "Alpaca missing membership is unrequested");
  invariant(
    payload.providerAudits.alpaca.unexpectedTickers.every((value) => !requested.has(value)),
    "Alpaca unexpected membership contains a requested ticker",
  );
  const expectedReturned = payload.snapshotRequestedTickers.filter((ticker) => !missing.has(ticker));
  invariant(candidateTickers.join(",") === expectedReturned.join(","), "candidate membership mismatch");
  invariant(payload.candidates.length === payload.providerAudits.alpaca.returnedCount, "candidate count mismatch");
  invariant(payload.consideredCount === payload.candidates.length, "consideredCount mismatch");
  invariant(
    payload.preRankInputTickers.length === candidateTickers.length &&
      candidateTickers.every((ticker) => new Set(payload.preRankInputTickers).has(ticker)),
    "preRankInputTickers membership mismatch",
  );
  if (payload.universeSource === "finnhub_us_common_stocks") {
    invariant(
      payload.sourceUniverseTickers.length === payload.providerAudits.finnhub.eligibleEntryCount,
      "Finnhub/source membership mismatch",
    );
  }
  if (!payload.inputWasLimited) {
    invariant(
      payload.sourceUniverseTickers.join(",") === payload.snapshotRequestedTickers.join(","),
      "uncapped source/request membership mismatch",
    );
  }
  const recomputed = recomputePreRank(payload);
  invariant(recomputed.considered.length === payload.consideredCount, "recomputed consideredCount mismatch");
  invariant(recomputed.gated.length === payload.gatedCount, "recomputed gatedCount mismatch");
  const recomputedEligible = [...recomputed.scoreByTicker.keys()].sort();
  invariant(recomputedEligible.join(",") === payload.eligibleTickers.join(","), "eligible membership does not recompute");
  invariant(recomputed.selected.join(",") === payload.selectedForEnrichmentTickers.join(","), "selection does not recompute");
  for (const candidate of payload.candidates) {
    const floorPassed = recomputed.floorPassed(candidate);
    const seeded = recomputed.seedSet.has(candidate.ticker);
    const score = recomputed.scoreByTicker.get(candidate.ticker);
    invariant(candidate.floorPassed === floorPassed, `${candidate.ticker} floorPassed mismatch`);
    invariant(candidate.seeded === seeded, `${candidate.ticker} seeded mismatch`);
    invariant(candidate.seedBypass === (seeded && !floorPassed), `${candidate.ticker} seedBypass mismatch`);
    invariant(candidate.eligible === (score !== undefined), `${candidate.ticker} eligibility mismatch`);
    invariant(candidate.preRankScore === (score ?? null), `${candidate.ticker} preRankScore mismatch`);
  }
  invariant(payload.selectedForEnrichmentTickers.every((ticker) => eligible.has(ticker)), "selection is outside eligibility");

  invariant(typeof payload.admissible === "boolean", "admissible must be boolean");
  invariant(Array.isArray(payload.quarantineReasons), "quarantineReasons must be an array");
  const allowedReasons = new Set([
    "finnhub_universe_incomplete",
    "finnhub_universe_completeness_unproven",
    "curated_universe_fallback",
    "universe_input_limited",
    "alpaca_snapshots_incomplete",
    "incomplete_field_provenance",
    "unverified_code_revision",
    "empty_eligible_universe",
    "dry_run",
  ]);
  invariant(
    payload.quarantineReasons.every((reason) => allowedReasons.has(reason)),
    "quarantine reason is invalid",
  );
  const reasons = [];
  if (payload.providerAudits?.finnhub?.status === "minimum_coverage_met") {
    reasons.push("finnhub_universe_completeness_unproven");
  } else {
    reasons.push("finnhub_universe_incomplete");
  }
  if (payload.universeSource === "curated_fallback") reasons.push("curated_universe_fallback");
  if (payload.inputWasLimited) reasons.push("universe_input_limited");
  if (payload.providerAudits?.alpaca?.status !== "complete") reasons.push("alpaca_snapshots_incomplete");
  if (
    payload.candidates.some(
      (candidate) =>
        candidate.priceAsOfISO === null ||
        candidate.prevCloseSource === "price_fallback" ||
        candidate.prevCloseAsOfISO === null ||
        candidate.liquiditySource === "imputed" ||
        candidate.liquidityAsOfISO === null ||
        candidate.rangeSource === "imputed" ||
        candidate.rangeAsOfISO === null,
    )
  ) reasons.push("incomplete_field_provenance");
  if (!/^[0-9a-f]{40}$/i.test(payload.codeRevision)) reasons.push("unverified_code_revision");
  if (payload.eligibleTickers.length === 0) reasons.push("empty_eligible_universe");
  if (payload.dryRun) reasons.push("dry_run");
  reasons.sort();
  sortedUniqueStrings(payload.quarantineReasons, "quarantineReasons");
  invariant(reasons.join(",") === payload.quarantineReasons.join(","), "quarantine reasons mismatch");
  invariant(payload.admissible === (reasons.length === 0), "admissibility mismatch");

  const forbiddenKey = /(authorization|headers?|api.?key|api.?secret|secret|token|password|error|stack|url|signals|news|socialposts|priceseries|labels?|outcomes?|fundamentals|catalysts?)/i;
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      invariant(!forbiddenKey.test(key), `forbidden field ${key}`);
      walk(nested);
    }
  };
  walk(payload);
}

function normalizeCanonical(value, path = "$", seen = new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      invariant(unit !== 0, `${path} contains a PostgreSQL-incompatible NUL`);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        invariant(next >= 0xdc00 && next <= 0xdfff, `${path} contains invalid Unicode`);
        index++;
      } else {
        invariant(!(unit >= 0xdc00 && unit <= 0xdfff), `${path} contains invalid Unicode`);
      }
    }
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    invariant(Number.isFinite(value), `${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  invariant(typeof value === "object", `${path} contains an unsupported value`);
  invariant(!seen.has(value), `${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((entry, index) => normalizeCanonical(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return normalized;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    invariant(value[key] !== undefined, `${path}.${key} is undefined`);
    normalized[key] = normalizeCanonical(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return normalized;
}

export function canonicalizeArchiveJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

export function computeArchivePayloadSha256(payload) {
  return createHash("sha256")
    .update(`${HASH_DOMAIN}${canonicalizeArchiveJson(payload)}`, "utf8")
    .digest("hex");
}

export function verifyArchiveEnvelope(envelope, expectedFileName) {
  invariant(envelope && typeof envelope === "object" && !Array.isArray(envelope), "envelope must be an object");
  invariant(
    Object.keys(envelope).sort().join(",") === "artifactId,artifactSha256,payload",
    "envelope fields are invalid",
  );
  const digest = computeArchivePayloadSha256(envelope.payload);
  invariant(envelope.artifactSha256 === digest, "payload digest mismatch");
  invariant(envelope.artifactId === `sha256:${digest}`, "artifact ID mismatch");
  verifyPayloadContract(envelope.payload);
  if (expectedFileName) {
    invariant(basename(expectedFileName).endsWith(`--${digest}.json`), "filename digest mismatch");
  }
  return { envelope, digest, canonicalPayload: canonicalizeArchiveJson(envelope.payload) };
}

export async function readAndVerifyArchiveEnvelope(filePath) {
  const bytes = await readFile(filePath, "utf8");
  const envelope = JSON.parse(bytes);
  const verified = verifyArchiveEnvelope(envelope, filePath);
  invariant(bytes === `${canonicalizeArchiveJson(envelope)}\n`, "archive bytes are not canonical");
  return verified;
}

function rowFromVerifiedArchive(verified) {
  const { envelope, canonicalPayload } = verified;
  const payload = envelope.payload;
  return {
    artifact_id: envelope.artifactId,
    artifact_sha256: envelope.artifactSha256,
    source_run_id: payload.sourceRunId,
    universe_id: payload.universeId,
    universe_definition_id: payload.universeDefinitionId,
    schema_version: payload.schemaVersion,
    code_revision: payload.codeRevision,
    captured_at: payload.capturedAtISO,
    decision_at: payload.decisionAtISO,
    admissible: payload.admissible,
    quarantine_reasons: payload.quarantineReasons,
    canonical_payload: canonicalPayload,
  };
}

function exactStoredMatch(stored, expected) {
  return (
    stored?.artifact_id === expected.artifact_id &&
    stored?.artifact_sha256 === expected.artifact_sha256 &&
    stored?.source_run_id === expected.source_run_id &&
    stored?.canonical_payload === expected.canonical_payload
  );
}

async function readExistingSourceRun(client, row) {
  try {
    const result = await client
      .from("learning_universe_artifacts")
      .select("artifact_id, artifact_sha256, source_run_id, canonical_payload")
      .eq("source_run_id", row.source_run_id)
      .maybeSingle();
    return !result.error && exactStoredMatch(result.data, row);
  } catch {
    return false;
  }
}

/** Insert only, then read back exact canonical bytes. Conflicting bytes are fatal. */
export async function insertLearningUniverseArtifactWithClient(client, envelope) {
  const verified = verifyArchiveEnvelope(envelope);
  const row = rowFromVerifiedArchive(verified);
  let insertResult;
  try {
    insertResult = await client
      .from("learning_universe_artifacts")
      .insert(row)
      .select("artifact_id, artifact_sha256, source_run_id, canonical_payload")
      .single();
  } catch {
    if (await readExistingSourceRun(client, row)) {
      return { status: "remote_idempotent", artifactId: row.artifact_id };
    }
    throw new Error("learning_universe_artifacts insert outcome could not be verified");
  }

  if (insertResult.error) {
    if (await readExistingSourceRun(client, row)) {
      return { status: "remote_idempotent", artifactId: row.artifact_id };
    }
    if (insertResult.error.code === "23505") {
      throw new Error("Learning-universe sourceRunId already exists with different bytes");
    }
    throw new Error(`learning_universe_artifacts insert failed (${insertResult.error.code ?? "unknown"})`);
  }

  if (!exactStoredMatch(insertResult.data, row)) {
    if (await readExistingSourceRun(client, row)) {
      return { status: "remote_verified", artifactId: row.artifact_id };
    }
    throw new Error("Learning-universe remote readback did not match canonical bytes");
  }
  return { status: "remote_verified", artifactId: row.artifact_id };
}

export async function uploadLearningUniverseArtifact(envelope) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL (or VITE_SUPABASE_URL) is required to archive.");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required to archive.");
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return insertLearningUniverseArtifactWithClient(client, envelope);
}
