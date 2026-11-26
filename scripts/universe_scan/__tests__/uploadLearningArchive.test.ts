import { describe, expect, it } from "vitest";

import {
  buildLearningUniversePayload,
  validateLearningUniversePayload,
} from "../../../src/engine/learningUniverseArtifact";
import { sealLearningUniverseArtifact } from "../learningArchive.mts";
import {
  computeArchivePayloadSha256,
  insertLearningUniverseArtifactWithClient,
  verifyArchiveEnvelope,
} from "../uploadLearningArchive.mjs";

function minimumCoverageTickers(): string[] {
  const tickers = ["AAPL"];
  for (let index = 0; tickers.length < 1_001; index++) {
    let value = index;
    let ticker = "";
    for (let place = 0; place < 4; place++) {
      ticker = String.fromCharCode(65 + (value % 26)) + ticker;
      value = Math.floor(value / 26);
    }
    if (!tickers.includes(ticker)) tickers.push(ticker);
  }
  return tickers;
}

function envelope({ minimumCoverage = false } = {}) {
  const tickers = minimumCoverage ? minimumCoverageTickers() : ["AAPL"];
  return sealLearningUniverseArtifact(
    buildLearningUniversePayload({
      sourceRunId: "scan_upload_test_123",
      codeRevision: "d".repeat(40),
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
          status: minimumCoverage ? "minimum_coverage_met" : "coverage_below_minimum",
          requestedAtISO: "2026-07-21T12:00:00.000Z",
          receivedAtISO: "2026-07-21T12:00:01.000Z",
          rawRowCount: tickers.length,
          eligibleEntryCount: tickers.length,
          minimumExpectedEligibleCount: 1_001,
        },
        alpaca: {
          provider: "alpaca",
          endpoint: "/v2/stocks/snapshots",
          feed: "iex",
          status: "complete",
          requestedAtISO: "2026-07-21T12:00:02.000Z",
          receivedAtISO: "2026-07-21T12:01:00.000Z",
          requestedCount: tickers.length,
          returnedCount: tickers.length,
          missingTickers: [],
          unexpectedTickers: [],
          batches: [
            {
              index: 0,
              status: "complete",
              requestedAtISO: "2026-07-21T12:00:02.000Z",
              receivedAtISO: "2026-07-21T12:01:00.000Z",
              requestedCount: tickers.length,
              returnedCount: tickers.length,
              missingTickers: [],
              unexpectedTickers: [],
            },
          ],
        },
      },
      eligibilityPolicy: {
        minPrice: 2,
        maxPrice: null,
        minDollarVolume: 2_000_000,
        alwaysIncludeTickers: minimumCoverage ? ["AAPL"] : [],
      },
      selectionTarget: 1,
      sourceUniverseTickers: tickers,
      snapshotRequestedTickers: tickers,
      selectedForEnrichmentTickers: ["AAPL"],
      candidates: tickers.map((ticker) => ({
          ticker,
          name: `${ticker} Inc`,
          price: 10,
          prevClose: 9,
          dayChange: 1 / 9,
          dollarVolume: 10_000_000,
          rangePct: 0.1,
          quoteAsOfISO: "2026-07-21T12:00:00.000Z",
          priceSource: "latest_trade",
          priceAsOfISO: "2026-07-21T12:00:00.000Z",
          prevCloseSource: "previous_daily_bar",
          prevCloseAsOfISO: "2026-07-20T20:00:00.000Z",
          liquiditySource: "previous_daily_bar",
          liquidityAsOfISO: "2026-07-20T20:00:00.000Z",
          rangeSource: "previous_daily_bar",
          rangeAsOfISO: "2026-07-20T20:00:00.000Z",
        })),
    }),
  );
}

describe("learning-universe remote uploader", () => {
  it("rejects digest-valid contract mutations, including fabricated candidate provenance", () => {
    const mutations: Array<[string, (payload: any) => void]> = [
      ["provider", (payload) => { payload.providerAudits.finnhub.provider = "other"; }],
      ["provider status", (payload) => { payload.providerAudits.alpaca.status = "invented"; }],
      ["endpoint", (payload) => { payload.providerAudits.alpaca.endpoint = "/wrong"; }],
      ["negative count", (payload) => { payload.providerAudits.alpaca.returnedCount = -1; }],
      ["policy", (payload) => { payload.eligibilityPolicy.tickerPattern = ".*"; }],
      ["candidate type", (payload) => { payload.candidates[0].price = "10"; }],
      ["candidate source", (payload) => { payload.candidates[0].priceSource = "fabricated"; }],
      ["imputed timestamp", (payload) => {
        payload.candidates[0].liquiditySource = "imputed";
        payload.candidates[0].liquidityAsOfISO = "2026-07-20T20:00:00.000Z";
      }],
      ["admissibility type", (payload) => { payload.admissible = "true"; }],
      ["quarantine reason", (payload) => { payload.quarantineReasons = ["invented_reason"]; }],
    ];

    for (const [name, mutate] of mutations) {
      const payload = structuredClone(envelope().payload) as any;
      mutate(payload);
      const digest = computeArchivePayloadSha256(payload);
      const mutated = { artifactId: `sha256:${digest}`, artifactSha256: digest, payload };
      expect(() => verifyArchiveEnvelope(mutated), name).toThrow();
      expect(() => validateLearningUniversePayload(payload), `${name} TS parity`).toThrow();
    }
  });

  it("matches PostgreSQL by rejecting Unicode NUL before hashing", () => {
    const payload = structuredClone(envelope().payload);
    payload.candidates[0]!.name = "bad\u0000name";
    expect(() => computeArchivePayloadSha256(payload)).toThrow(/NUL/);
    expect(() => sealLearningUniverseArtifact(payload)).toThrow(/NUL/);
  });

  it("rejects a fabricated source on a minimum-coverage 1,001-member envelope", () => {
    const valid = envelope({ minimumCoverage: true });
    expect(valid.payload.admissible).toBe(false);
    expect(valid.payload.quarantineReasons).toContain(
      "finnhub_universe_completeness_unproven",
    );
    const payload = structuredClone(valid.payload) as any;
    payload.candidates[0].priceSource = "fabricated";
    const digest = computeArchivePayloadSha256(payload);
    expect(() =>
      verifyArchiveEnvelope({ artifactId: `sha256:${digest}`, artifactSha256: digest, payload }),
    ).toThrow(/priceSource/);
  });

  it("uses insert-only semantics and verifies the returned canonical bytes", async () => {
    let inserted: Record<string, unknown> | undefined;
    let upsertCalled = false;
    const client = {
      from: () => ({
        upsert: () => {
          upsertCalled = true;
        },
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return {
            select: () => ({ single: async () => ({ data: row, error: null }) }),
          };
        },
      }),
    };
    const result = await insertLearningUniverseArtifactWithClient(client, envelope());
    expect(result.status).toBe("remote_verified");
    expect(inserted?.artifact_id).toMatch(/^sha256:/);
    expect(upsertCalled).toBe(false);
  });

  it("accepts only an exact-byte duplicate retry", async () => {
    let inserted: Record<string, unknown> | undefined;
    const client = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted = row;
          return {
            select: () => ({
              single: async () => ({ data: null, error: { code: "23505" } }),
            }),
          };
        },
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: inserted, error: null }) }),
        }),
      }),
    };
    const result = await insertLearningUniverseArtifactWithClient(client, envelope());
    expect(result.status).toBe("remote_idempotent");

    const conflictClient = {
      from: () => ({
        insert: () => ({
          select: () => ({ single: async () => ({ data: null, error: { code: "23505" } }) }),
        }),
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { ...inserted, canonical_payload: "different" },
              error: null,
            }),
          }),
        }),
      }),
    };
    await expect(insertLearningUniverseArtifactWithClient(conflictClient, envelope())).rejects.toThrow(
      /different bytes/,
    );
  });

  it("resolves an insert transport throw by exact source-run readback", async () => {
    let attempted: Record<string, unknown> | undefined;
    const client = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          attempted = row;
          return {
            select: () => ({
              single: async () => {
                throw new Error("transport closed after commit");
              },
            }),
          };
        },
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: attempted, error: null }) }),
        }),
      }),
    };
    const result = await insertLearningUniverseArtifactWithClient(client, envelope());
    expect(result.status).toBe("remote_idempotent");
  });

  it("rejects secret/enriched fields even if a caller recomputes the digest", () => {
    const valid = envelope();
    const payload = { ...valid.payload, authorization: "secret-canary" };
    const digest = computeArchivePayloadSha256(payload);
    expect(() =>
      verifyArchiveEnvelope({ artifactId: `sha256:${digest}`, artifactSha256: digest, payload }),
    ).toThrow(/fields|forbidden/);
  });
});
