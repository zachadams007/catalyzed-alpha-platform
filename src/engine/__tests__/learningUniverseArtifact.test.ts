import { describe, expect, it } from "vitest";

import {
  buildLearningUniversePayload,
  canonicalizeLearningUniverseJson,
  toValidatedUniverseEvidence,
  toVerifiedUniverseArtifact,
  validateLearningUniversePayload,
  type BuildLearningUniversePayloadInput,
  type LearningUniverseCandidateInput,
} from "@/engine/learningUniverseArtifact";

const T0 = "2026-07-21T12:00:00.000Z";
const T1 = "2026-07-21T12:01:00.000Z";
const T2 = "2026-07-21T12:02:00.000Z";

function generatedTicker(index: number): string {
  let value = index;
  let ticker = "";
  for (let place = 0; place < 4; place++) {
    ticker = String.fromCharCode(65 + (value % 26)) + ticker;
    value = Math.floor(value / 26);
  }
  return ticker;
}

function candidate(
  ticker: string,
  overrides: Partial<LearningUniverseCandidateInput> = {},
): LearningUniverseCandidateInput {
  return {
    ticker,
    name: `${ticker} Corp`,
    price: 10,
    prevClose: 9,
    dayChange: 1 / 9,
    dollarVolume: 10_000_000,
    rangePct: 0.1,
    quoteAsOfISO: T1,
    priceSource: "latest_trade",
    priceAsOfISO: T1,
    prevCloseSource: "previous_daily_bar",
    prevCloseAsOfISO: T0,
    liquiditySource: "previous_daily_bar",
    liquidityAsOfISO: T0,
    rangeSource: "previous_daily_bar",
    rangeAsOfISO: T0,
    ...overrides,
  };
}

function input(overrides: Partial<BuildLearningUniversePayloadInput> = {}): BuildLearningUniversePayloadInput {
  return {
    sourceRunId: "scan_12345678",
    codeRevision: "a".repeat(40),
    capturedAtISO: T1,
    decisionAtISO: T2,
    universeSource: "finnhub_us_common_stocks",
    captureTrigger: "github_actions",
    runAttempt: "123:1",
    inputWasLimited: false,
    dryRun: false,
    providerAudits: {
      finnhub: {
        provider: "finnhub",
        endpoint: "/stock/symbol?exchange=US",
        status: "coverage_below_minimum",
        requestedAtISO: T0,
        receivedAtISO: T0,
        rawRowCount: 2,
        eligibleEntryCount: 2,
        minimumExpectedEligibleCount: 1_001,
      },
      alpaca: {
        provider: "alpaca",
        endpoint: "/v2/stocks/snapshots",
        feed: "iex",
        status: "complete",
        requestedAtISO: T0,
        receivedAtISO: T1,
        requestedCount: 2,
        returnedCount: 2,
        missingTickers: [],
        unexpectedTickers: [],
        batches: [
          {
            index: 0,
            status: "complete",
            requestedAtISO: T0,
            receivedAtISO: T1,
            requestedCount: 2,
            returnedCount: 2,
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
      alwaysIncludeTickers: [],
    },
    selectionTarget: 1,
    sourceUniverseTickers: ["AAPL", "MSFT"],
    snapshotRequestedTickers: ["AAPL", "MSFT"],
    selectedForEnrichmentTickers: ["AAPL"],
    candidates: [candidate("AAPL"), candidate("MSFT")],
    ...overrides,
  };
}

function minimumCoverageInput(
  overrides: Partial<BuildLearningUniversePayloadInput> = {},
): BuildLearningUniversePayloadInput {
  const tickers = ["AAPL"];
  for (let index = 0; tickers.length < 1_001; index++) {
    const ticker = generatedTicker(index);
    if (!tickers.includes(ticker)) tickers.push(ticker);
  }
  const candidates = tickers.map((ticker) => candidate(ticker));
  const base = input({
    providerAudits: {
      finnhub: {
        ...input().providerAudits.finnhub,
        status: "minimum_coverage_met",
        rawRowCount: tickers.length,
        eligibleEntryCount: tickers.length,
        minimumExpectedEligibleCount: 1_001,
      },
      alpaca: {
        ...input().providerAudits.alpaca,
        status: "complete",
        requestedCount: tickers.length,
        returnedCount: tickers.length,
        batches: [
          {
            ...input().providerAudits.alpaca.batches[0]!,
            requestedCount: tickers.length,
            returnedCount: tickers.length,
          },
        ],
      },
    },
    eligibilityPolicy: {
      ...input().eligibilityPolicy,
      alwaysIncludeTickers: ["AAPL"],
    },
    sourceUniverseTickers: tickers,
    snapshotRequestedTickers: tickers,
    selectedForEnrichmentTickers: ["AAPL"],
    candidates,
  });
  return { ...base, ...overrides };
}

describe("learning-universe artifact contract", () => {
  it("canonicalizes object, set-like membership, candidate, and batch order deterministically", () => {
    const first = buildLearningUniversePayload(input());
    const second = buildLearningUniversePayload(
      input({
        sourceUniverseTickers: ["MSFT", "AAPL"],
        snapshotRequestedTickers: ["MSFT", "AAPL"],
      }),
    );
    expect(canonicalizeLearningUniverseJson(first)).toBe(canonicalizeLearningUniverseJson(second));
    expect(first.selectedForEnrichmentTickers).toEqual(["AAPL"]);
    expect(first.eligibleTickers).toEqual(["AAPL", "MSFT"]);
  });

  it("quarantines minimum coverage because provider completeness is unproven", () => {
    const payload = buildLearningUniversePayload(minimumCoverageInput());
    expect(payload.admissible).toBe(false);
    expect(payload.quarantineReasons).toEqual([
      "finnhub_universe_completeness_unproven",
    ]);
  });

  it("retains floor-rejected observations while separating eligible membership", () => {
    const payload = buildLearningUniversePayload(
      input({
        candidates: [candidate("AAPL"), candidate("MSFT", { price: 1 })],
      }),
    );
    expect(payload.candidates.map((entry) => entry.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(payload.eligibleTickers).toEqual(["AAPL"]);
    expect(payload.candidates.find((entry) => entry.ticker === "MSFT")).toMatchObject({
      floorPassed: false,
      eligible: false,
      preRankScore: null,
    });
  });

  it("quarantines fallback, caps, partial batches, dry runs, unverified revisions, and imputed fields", () => {
    const partialAudit = input().providerAudits.alpaca;
    const payload = buildLearningUniversePayload(
      input({
        codeRevision: "unverified",
        universeSource: "curated_fallback",
        inputWasLimited: true,
        dryRun: true,
        providerAudits: {
          ...input().providerAudits,
          finnhub: {
            ...input().providerAudits.finnhub,
            status: "request_failed",
            rawRowCount: 0,
            eligibleEntryCount: 0,
          },
          alpaca: {
            ...partialAudit,
            status: "partial",
            returnedCount: 1,
            missingTickers: ["MSFT"],
            batches: [
              {
                ...partialAudit.batches[0]!,
                status: "incomplete_payload",
                returnedCount: 1,
                missingTickers: ["MSFT"],
              },
            ],
          },
        },
        candidates: [
          candidate("AAPL", {
            prevCloseSource: "price_fallback",
            prevCloseAsOfISO: null,
          }),
        ],
      }),
    );
    expect(payload.admissible).toBe(false);
    expect(payload.quarantineReasons).toEqual([
      "alpaca_snapshots_incomplete",
      "curated_universe_fallback",
      "dry_run",
      "finnhub_universe_incomplete",
      "incomplete_field_provenance",
      "universe_input_limited",
      "unverified_code_revision",
    ]);
  });

  it("rejects duplicate candidates, selection outside eligibility, future capture, and unknown fields", () => {
    expect(() => buildLearningUniversePayload(input({ candidates: [candidate("AAPL"), candidate("AAPL")] }))).toThrow();
    expect(() =>
      buildLearningUniversePayload(input({ selectedForEnrichmentTickers: ["NVDA"] })),
    ).toThrow();
    expect(() => buildLearningUniversePayload(input({ capturedAtISO: T2, decisionAtISO: T1 }))).toThrow();
    expect(() =>
      buildLearningUniversePayload(
        input({ candidates: [{ ...candidate("AAPL"), authorization: "secret-canary" } as never, candidate("MSFT")] }),
      ),
    ).toThrow();
    expect(() =>
      buildLearningUniversePayload(
        input({
          providerAudits: {
            ...input().providerAudits,
            finnhub: {
              ...input().providerAudits.finnhub,
              status: "minimum_coverage_met",
              rawRowCount: 2,
              eligibleEntryCount: 2,
              minimumExpectedEligibleCount: 2,
            },
          },
        }),
      ),
    ).toThrow(/production floor/);
  });

  it("rejects unsupported canonical values", () => {
    expect(() => canonicalizeLearningUniverseJson({ bad: undefined })).toThrow();
    expect(() => canonicalizeLearningUniverseJson({ bad: Number.NaN })).toThrow();
    expect(() => canonicalizeLearningUniverseJson({ bad: "\u0000" })).toThrow(/NUL/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalizeLearningUniverseJson(cycle)).toThrow();
    expect(() => canonicalizeLearningUniverseJson({ bad: "\ud800" })).toThrow(/Unicode/);
    expect(canonicalizeLearningUniverseJson({ name: "e\u0301" })).toBe('{"name":"é"}');
  });

  it("exposes rejected and eligible evidence while keeping quarantine out of the learning bridge", () => {
    const payload = buildLearningUniversePayload(
      input({ candidates: [candidate("AAPL"), candidate("MSFT", { price: 1 })] }),
    );
    const digest = "b".repeat(64);
    const envelope = { artifactId: `sha256:${digest}`, artifactSha256: digest, payload };
    const evidence = toValidatedUniverseEvidence(envelope, digest);
    expect(evidence.candidates.map((entry) => entry.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(evidence.candidates.find((entry) => entry.ticker === "MSFT")).toMatchObject({
      floorPassed: false,
      eligible: false,
    });
    expect(evidence.eligibleCandidates.map((entry) => entry.ticker)).toEqual(["AAPL"]);
    expect(evidence.admissible).toBe(false);
    expect(() => toVerifiedUniverseArtifact(envelope, digest)).toThrow(/quarantined/);
  });

  it("preserves provider timestamps across a weekend without inventing a session label", () => {
    const fridayClose = "2026-07-24T20:00:00.000Z";
    const sundayCapture = "2026-07-26T14:01:00.000Z";
    const sundayDecision = "2026-07-26T14:02:00.000Z";
    const minimumCoverage = minimumCoverageInput();
    const payload = buildLearningUniversePayload(
      {
        ...minimumCoverage,
        capturedAtISO: sundayCapture,
        decisionAtISO: sundayDecision,
        candidates: minimumCoverage.candidates.map((entry) =>
          candidate(entry.ticker, {
            quoteAsOfISO: fridayClose,
            priceAsOfISO: fridayClose,
            prevCloseAsOfISO: fridayClose,
            liquidityAsOfISO: fridayClose,
            rangeAsOfISO: fridayClose,
          }),
        ),
      },
    );
    const digest = "c".repeat(64);
    const bridge = toValidatedUniverseEvidence(
      { artifactId: `sha256:${digest}`, artifactSha256: digest, payload },
      digest,
    );

    expect(bridge.decisionAtISO).toBe(sundayDecision);
    expect(bridge.eligibleCandidates[0]?.priceAsOfISO).toBe(fridayClose);
    expect(bridge.eligibleCandidates[0]?.liquidityAsOfISO).toBe(fridayClose);
    expect(Object.keys(bridge)).not.toContain("sessionDate");
  });

  it("re-validates an artifact read as unknown", () => {
    const payload: unknown = buildLearningUniversePayload(input());
    expect(() => validateLearningUniversePayload(payload)).not.toThrow();
  });
});
