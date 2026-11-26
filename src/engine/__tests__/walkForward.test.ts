import { describe, expect, it } from "vitest";

import {
  LEARNING_DATASET_SCHEMA_VERSION,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "@/engine/learningDataset";
import { buildWalkForwardFolds } from "@/engine/walkForward";

function iso(day: number, hour = 22): string {
  return new Date(Date.UTC(2026, 0, day, hour)).toISOString();
}

function row(day: number): PointInTimeFeatureRow {
  return {
    schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
    rowId: `row-${day}`,
    ticker: `T${String.fromCharCode(65 + day)}`,
    decisionAtISO: iso(day),
    universeId: `scan-${day}`,
    sector: day % 2 === 0 ? "Energy" : "Health Care",
    capCohort: "mid",
    baselineScore: 50 + day,
    features: { momentum: { value: day, source: "market_data", observedAtISO: iso(day, 21) } },
    // A five-day label must not enter a train fold before it has landed.
    label: {
      horizonDays: 5,
      forwardReturn: day / 100,
      horizonCloseAtISO: iso(day + 5, 20),
      observedAtISO: iso(day + 5, 21),
    },
  };
}

function manifestsFor(rows: readonly PointInTimeFeatureRow[]): PointInTimeUniverseManifest[] {
  return rows.map((entry) => ({
    schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
    universeId: entry.universeId,
    captureScope: "full_candidate_universe",
    decisionAtISO: entry.decisionAtISO,
    capturedAtISO: new Date(Date.parse(entry.decisionAtISO) - 60_000).toISOString(),
    sourceRunId: `source-${entry.universeId}`,
    universeDefinitionId: "catalyzed-us-equity-broad-v1",
    sourceArtifactId: `artifact-${entry.universeId}`,
    sourceArtifactSha256: "b".repeat(64),
    eligibleTickers: [entry.ticker],
  }));
}

function evidenceFor(
  rows: readonly PointInTimeFeatureRow[],
  manifests: readonly PointInTimeUniverseManifest[],
): PointInTimeEvidenceRegistry {
  const eligibleMarketCloses = new Set<string>();
  for (const entry of rows) {
    if (!entry.label) continue;
    const closeMs = Date.parse(entry.label.horizonCloseAtISO);
    for (let offset = entry.label.horizonDays - 1; offset >= 0; offset -= 1) {
      eligibleMarketCloses.add(new Date(closeMs - offset * 24 * 60 * 60 * 1000).toISOString());
    }
  }
  return {
    verifiedUniverseArtifacts: manifests.map((manifest) => ({
      artifactId: manifest.sourceArtifactId,
      artifactSha256: manifest.sourceArtifactSha256,
      universeDefinitionId: manifest.universeDefinitionId,
      universeId: manifest.universeId,
      sourceRunId: manifest.sourceRunId,
      codeRevision: "c".repeat(40),
      decisionAtISO: manifest.decisionAtISO,
      capturedAtISO: manifest.capturedAtISO,
      eligibleTickers: [...manifest.eligibleTickers],
      candidates: manifest.eligibleTickers.map((ticker) => ({
        ticker,
        name: ticker,
        price: 100,
        prevClose: 99,
        dayChange: 1,
        dollarVolume: 10_000_000,
        rangePct: 0.03,
        quoteAsOfISO: manifest.decisionAtISO,
        priceSource: "daily_bar" as const,
        priceAsOfISO: manifest.decisionAtISO,
        prevCloseSource: "previous_daily_bar" as const,
        prevCloseAsOfISO: manifest.decisionAtISO,
        liquiditySource: "previous_daily_bar" as const,
        liquidityAsOfISO: manifest.decisionAtISO,
        rangeSource: "previous_daily_bar" as const,
        rangeAsOfISO: manifest.decisionAtISO,
        floorPassed: true,
        seeded: false,
        seedBypass: false,
        eligible: true,
        preRankScore:
          rows.find(
            (entry) => entry.universeId === manifest.universeId && entry.ticker === ticker,
          )?.baselineScore ?? null,
      })),
      eligibleCandidates: manifest.eligibleTickers.map((ticker) => ({
        ticker,
        name: ticker,
        price: 100,
        prevClose: 99,
        dayChange: 1,
        dollarVolume: 10_000_000,
        rangePct: 0.03,
        quoteAsOfISO: manifest.decisionAtISO,
        priceSource: "daily_bar" as const,
        priceAsOfISO: manifest.decisionAtISO,
        prevCloseSource: "previous_daily_bar" as const,
        prevCloseAsOfISO: manifest.decisionAtISO,
        liquiditySource: "previous_daily_bar" as const,
        liquidityAsOfISO: manifest.decisionAtISO,
        rangeSource: "previous_daily_bar" as const,
        rangeAsOfISO: manifest.decisionAtISO,
        floorPassed: true,
        seeded: false,
        seedBypass: false,
        eligible: true,
        preRankScore:
          rows.find(
            (entry) => entry.universeId === manifest.universeId && entry.ticker === ticker,
          )?.baselineScore ?? null,
      })),
    })),
    eligibleMarketClosesISO: [...eligibleMarketCloses],
  };
}

describe("buildWalkForwardFolds", () => {
  it("uses only labels observable by the training cutoff and embargoes the next decision day", () => {
    const rows = Array.from({ length: 16 }, (_, index) => row(index + 1));
    const manifests = manifestsFor(rows);
    const folds = buildWalkForwardFolds(rows, manifests, evidenceFor(rows, manifests), {
      minTrainingDecisionDays: 8,
      testDecisionDays: 2,
      stepDecisionDays: 2,
      embargoDecisionDays: 1,
    });
    expect(folds.length).toBeGreaterThan(0);
    const first = folds[0]!;
    expect(first.trainEndISO).toContain("2026-01-08");
    expect(first.testStartISO).toContain("2026-01-10");
    expect(
      first.trainRows.every(
        (entry) => Date.parse(entry.label!.observedAtISO) <= Date.parse(first.trainEndISO),
      ),
    ).toBe(true);
    expect(first.testRows.map((entry) => entry.rowId)).toEqual(["row-10", "row-11"]);
    expect(Object.isFrozen(folds)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.trainRows)).toBe(true);
    expect(Object.isFrozen(first.testRows)).toBe(true);
    expect(() => (first.trainRows as PointInTimeFeatureRow[]).push(row(30))).toThrow();
  });

  it("returns no folds rather than inventing an in-sample result when history is insufficient", () => {
    const rows = [row(1), row(2), row(3)];
    const manifests = manifestsFor(rows);
    const folds = buildWalkForwardFolds(rows, manifests, evidenceFor(rows, manifests), {
      minTrainingDecisionDays: 3,
      testDecisionDays: 2,
      stepDecisionDays: 2,
      embargoDecisionDays: 0,
    });
    expect(folds).toEqual([]);
  });

  it("rejects a step smaller than the test window to prevent overlapping out-of-sample folds", () => {
    const rows = Array.from({ length: 16 }, (_, index) => row(index + 1));
    const manifests = manifestsFor(rows);
    expect(() =>
      buildWalkForwardFolds(
        rows,
        manifests,
        evidenceFor(rows, manifests),
        {
          minTrainingDecisionDays: 8,
          testDecisionDays: 3,
          stepDecisionDays: 2,
          embargoDecisionDays: 1,
        },
      ),
    ).toThrow(/out-of-sample windows do not overlap/i);
  });

  it("compares label instants numerically so timezone offsets cannot cross the cutoff", () => {
    const rows = Array.from({ length: 16 }, (_, index) => row(index + 1));
    rows[0] = {
      ...rows[0]!,
      label: {
        ...rows[0]!.label!,
        observedAtISO: "2026-01-08T20:00:00-05:00",
      },
    };
    const manifests = manifestsFor(rows);
    const folds = buildWalkForwardFolds(rows, manifests, evidenceFor(rows, manifests), {
      minTrainingDecisionDays: 8,
      testDecisionDays: 2,
      stepDecisionDays: 2,
      embargoDecisionDays: 1,
    });
    expect(folds[0]!.trainEndISO).toBe("2026-01-08T23:59:59.999Z");
    expect(folds[0]!.trainRows.map((entry) => entry.rowId)).not.toContain("row-1");
  });
});
