import { describe, expect, it } from "vitest";

import {
  buildLearningUniversePayload,
  type LearningUniverseArtifactEnvelope,
} from "../../../src/engine/learningUniverseArtifact";
import {
  LEARNING_DATASET_SCHEMA_VERSION,
  type PointInTimeFeatureRow,
} from "../../../src/engine/learningDataset";
import { sealLearningUniverseArtifact } from "../../universe_scan/learningArchive.mts";
import {
  OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
  runOfflineLearningEvaluation,
  type OfflineLearningBundle,
} from "../offlineLearningRunner";

function quarantinedEnvelope(): LearningUniverseArtifactEnvelope {
  const payload = buildLearningUniversePayload({
    sourceRunId: "offline_quarantine_test",
    codeRevision: "c".repeat(40),
    capturedAtISO: "2026-07-21T12:01:00.000Z",
    decisionAtISO: "2026-07-21T12:02:00.000Z",
    universeSource: "finnhub_us_common_stocks",
    captureTrigger: "local",
    runAttempt: "test:1",
    inputWasLimited: false,
    dryRun: false,
    providerAudits: {
      finnhub: {
        provider: "finnhub",
        endpoint: "/stock/symbol?exchange=US",
        status: "coverage_below_minimum",
        requestedAtISO: "2026-07-21T12:00:00.000Z",
        receivedAtISO: "2026-07-21T12:00:01.000Z",
        rawRowCount: 1,
        eligibleEntryCount: 1,
        minimumExpectedEligibleCount: 1_001,
      },
      alpaca: {
        provider: "alpaca",
        endpoint: "/v2/stocks/snapshots",
        feed: "iex",
        status: "complete",
        requestedAtISO: "2026-07-21T12:00:02.000Z",
        receivedAtISO: "2026-07-21T12:01:00.000Z",
        requestedCount: 1,
        returnedCount: 1,
        missingTickers: [],
        unexpectedTickers: [],
        batches: [{
          index: 0,
          status: "complete",
          requestedAtISO: "2026-07-21T12:00:02.000Z",
          receivedAtISO: "2026-07-21T12:01:00.000Z",
          requestedCount: 1,
          returnedCount: 1,
          missingTickers: [],
          unexpectedTickers: [],
        }],
      },
    },
    eligibilityPolicy: {
      minPrice: 2,
      maxPrice: null,
      minDollarVolume: 2_000_000,
      alwaysIncludeTickers: [],
    },
    selectionTarget: 1,
    sourceUniverseTickers: ["AAPL"],
    snapshotRequestedTickers: ["AAPL"],
    selectedForEnrichmentTickers: ["AAPL"],
    candidates: [{
      ticker: "AAPL",
      name: "Apple Inc",
      price: 100,
      prevClose: 99,
      dayChange: 1 / 99,
      dollarVolume: 10_000_000,
      rangePct: 0.03,
      quoteAsOfISO: "2026-07-21T12:00:00.000Z",
      priceSource: "latest_trade",
      priceAsOfISO: "2026-07-21T12:00:00.000Z",
      prevCloseSource: "previous_daily_bar",
      prevCloseAsOfISO: "2026-07-20T20:00:00.000Z",
      liquiditySource: "previous_daily_bar",
      liquidityAsOfISO: "2026-07-20T20:00:00.000Z",
      rangeSource: "previous_daily_bar",
      rangeAsOfISO: "2026-07-20T20:00:00.000Z",
    }],
  });
  return sealLearningUniverseArtifact(payload);
}

describe("offline learning CLI contract", () => {
  it("blocks an invalid report as-of instant before artifact admission or evaluation", () => {
    const envelope = quarantinedEnvelope();
    const bundle = {
      schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
      reportAsOfISO: "not-an-instant",
      archiveEnvelopes: [envelope],
      eligibleMarketClosesISO: [],
      rows: [],
      manifests: [],
      predictions: [],
      split: {},
      walkForwardConfig: {},
      drift: {},
    } as unknown as OfflineLearningBundle;

    const report = runOfflineLearningEvaluation(bundle);

    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/reportAsOfISO.*valid UTC ISO/i);
    expect(report.admission).toMatchObject({ admittedArtifacts: 0, admittedOutcomeArtifacts: 0 });
    expect(report.promotion).toBeNull();
  });

  it("blocks a bundle that supplies both external predictions and a trainer configuration", () => {
    const envelope = quarantinedEnvelope();
    const bundle = {
      schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
      reportAsOfISO: "2026-07-22T00:00:00.000Z",
      archiveEnvelopes: [envelope],
      eligibleMarketClosesISO: [],
      rows: [],
      manifests: [],
      predictions: [{ rowId: "external" }],
      trainer: { configuration: {} },
      split: {},
      walkForwardConfig: {},
      drift: {},
    } as unknown as OfflineLearningBundle;

    const report = runOfflineLearningEvaluation(bundle);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/not both/i);
    expect(report.trainer).toBeNull();
  });

  it("blocks admission attestations that arrive without a configuration ledger", () => {
    const envelope = quarantinedEnvelope();
    const bundle = {
      schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
      reportAsOfISO: "2026-07-22T00:00:00.000Z",
      archiveEnvelopes: [envelope],
      eligibleMarketClosesISO: [],
      rows: [],
      manifests: [],
      predictions: [],
      admissionAttestations: [{ subjectKind: "feature_rows" }],
      split: {},
      walkForwardConfig: {},
      drift: {},
    } as unknown as OfflineLearningBundle;

    const report = runOfflineLearningEvaluation(bundle);
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(
      /configuration ledger is required when admission attestations are supplied/i,
    );
  });

  it("stops at canonical admission and never evaluates rows from a quarantined artifact", () => {
    const envelope = quarantinedEnvelope();
    const row: PointInTimeFeatureRow = {
      schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
      rowId: "quarantined:AAPL",
      ticker: "AAPL",
      decisionAtISO: envelope.payload.decisionAtISO,
      universeId: envelope.payload.universeId,
      sector: "Technology",
      capCohort: "mega",
      baselineScore: 80,
      features: {},
    };
    const bundle = {
      schemaVersion: OFFLINE_LEARNING_REPORT_SCHEMA_VERSION,
      reportAsOfISO: "2026-07-22T00:00:00.000Z",
      archiveEnvelopes: [envelope],
      eligibleMarketClosesISO: [],
      rows: [row],
      manifests: [],
      predictions: [],
      split: {},
      walkForwardConfig: {},
      drift: {},
    } as unknown as OfflineLearningBundle;
    const before = JSON.stringify(bundle);
    const report = runOfflineLearningEvaluation(bundle);

    expect(envelope.payload.admissible).toBe(false);
    expect(report.admission).toMatchObject({
      suppliedArtifacts: 1,
      admittedArtifacts: 0,
    });
    expect(report.promotion).toBeNull();
    expect(report.feedback).toEqual({ applied: 0, idempotent: 0 });
    expect(report.verdict.status).toBe("blocked");
    expect(report.verdict.blockers.join(" ")).toMatch(/quarantined artifact cannot enter/i);
    expect(JSON.stringify(bundle)).toBe(before);
  });
});
