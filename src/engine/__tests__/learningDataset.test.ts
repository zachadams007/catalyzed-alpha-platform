import { describe, expect, it } from "vitest";

import {
  LEARNING_DATASET_SCHEMA_VERSION,
  auditPointInTimeDataset,
  trainableRows,
  validatePointInTimeRow,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "@/engine/learningDataset";

function row(overrides: Partial<PointInTimeFeatureRow> = {}): PointInTimeFeatureRow {
  return {
    schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
    rowId: "2026-01-02:AAA",
    ticker: "AAA",
    decisionAtISO: "2026-01-02T16:00:00.000Z",
    universeId: "scan-2026-01-02",
    sector: "Industrials",
    capCohort: "mid",
    baselineScore: 74,
    features: {
      filingMomentum: {
        value: 0.4,
        source: "filing",
        publishedAtISO: "2026-01-02T12:00:00.000Z",
        observedAtISO: "2026-01-02T12:05:00.000Z",
      },
    },
    label: {
      horizonDays: 5,
      forwardReturn: 0.04,
      horizonCloseAtISO: "2026-01-09T20:00:00.000Z",
      observedAtISO: "2026-01-09T21:00:00.000Z",
    },
    ...overrides,
  };
}

function manifestsFor(rows: readonly PointInTimeFeatureRow[]): PointInTimeUniverseManifest[] {
  const groups = new Map<string, PointInTimeFeatureRow[]>();
  for (const entry of rows) {
    const group = groups.get(entry.universeId) ?? [];
    group.push(entry);
    groups.set(entry.universeId, group);
  }
  return [...groups.entries()].map(([universeId, members]) => ({
    schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
    universeId,
    captureScope: "full_candidate_universe",
    decisionAtISO: members[0]!.decisionAtISO,
    capturedAtISO: new Date(Date.parse(members[0]!.decisionAtISO) - 60_000).toISOString(),
    sourceRunId: `source-${universeId}`,
    universeDefinitionId: "catalyzed-us-equity-broad-v1",
    sourceArtifactId: `artifact-${universeId}`,
    sourceArtifactSha256: "a".repeat(64),
    eligibleTickers: members.map((entry) => entry.ticker),
  }));
}

function evidenceFor(
  rows: readonly PointInTimeFeatureRow[],
  manifests: readonly PointInTimeUniverseManifest[] = manifestsFor(rows),
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

describe("point-in-time learning dataset contract", () => {
  it("accepts a complete full-universe row with a later realized label", () => {
    const source = row();
    expect(validatePointInTimeRow(source, evidenceFor([source]))).toEqual({
      rowId: "2026-01-02:AAA",
      valid: true,
      errors: [],
    });
  });

  it("rejects a feature published after the decision, rather than leaking it into training", () => {
    const invalid = row({
      features: {
        futureFiling: {
          value: 1,
          source: "filing",
          publishedAtISO: "2026-01-03T08:00:00.000Z",
          observedAtISO: "2026-01-03T08:00:00.000Z",
        },
      },
    });
    const result = validatePointInTimeRow(invalid, evidenceFor([invalid]));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/after the decision time/i);
  });

  it("keeps unlabeled rows out of training instead of treating them as losses", () => {
    const pending = row({ rowId: "pending", ticker: "BBB", universeId: "scan-pending", label: undefined });
    const source = [pending, row()];
    const manifests = manifestsFor(source);
    const rows = trainableRows(source, manifests, evidenceFor(source, manifests));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rowId).toBe("2026-01-02:AAA");
  });

  it("fails closed without an exact pre-ranking universe manifest", () => {
    const source = [row()];
    expect(trainableRows(source, [], evidenceFor(source, []))).toEqual([]);
  });

  it("fails closed without an independently archived universe artifact", () => {
    const source = [row()];
    const manifests = manifestsFor(source);
    const evidence = { ...evidenceFor(source, manifests), verifiedUniverseArtifacts: [] };
    expect(trainableRows(source, manifests, evidence)).toEqual([]);
  });

  it("rejects a baseline score that does not match admitted pre-rank evidence", () => {
    const source = [row({ baselineScore: 75 })];
    const manifests = manifestsFor(source);
    const evidence = evidenceFor([row({ baselineScore: 74 })], manifests);
    const audit = auditPointInTimeDataset(source, manifests, evidence);

    expect(audit.coverageValid).toBe(false);
    expect(audit.universeValidations[0]!.errors.join(" ")).toMatch(/baselineScore.*pre-rank/i);
  });

  it("blocks the entire universe when manifest membership is incomplete", () => {
    const source = [row(), row({ rowId: "2026-01-02:BBB", ticker: "BBB" })];
    const incomplete = manifestsFor(source);
    const modified = [{ ...incomplete[0]!, eligibleTickers: ["AAA"] }];
    const evidence = evidenceFor(source, incomplete);
    const audit = auditPointInTimeDataset(source, modified, evidence);
    expect(audit.coverageValid).toBe(false);
    expect(trainableRows(source, modified, evidence)).toEqual([]);
    expect(audit.universeValidations[0]!.errors.join(" ")).toMatch(/not in the manifest/i);
  });

  it("audits valid labels, sectors, cap cohorts, and invalid rows separately", () => {
    const invalid = row({ rowId: "invalid", universeId: "" });
    const source = [row(), invalid];
    const manifests = manifestsFor(source);
    const audit = auditPointInTimeDataset(source, manifests, evidenceFor(source, manifests));
    expect(audit).toMatchObject({ totalRows: 2, validRows: 1, labeledRows: 1, invalidRows: 1, uniqueUniverseCount: 1 });
    expect(audit.bySector).toEqual({ Industrials: 1 });
    expect(audit.byCapCohort.mid).toBe(1);
  });

  it("rejects an unknown cap cohort from untrusted persisted input", () => {
    const source = row({ capCohort: "invalid" as never });
    const result = validatePointInTimeRow(source, evidenceFor([source]));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("capCohort is invalid.");
  });

  it("rejects an unknown feature source from untrusted persisted input", () => {
    const source = row({
      features: {
        bad: {
          value: 1,
          source: "social_post" as never,
          observedAtISO: "2026-01-02T12:00:00.000Z",
        },
      },
    });
    const result = validatePointInTimeRow(source, evidenceFor([source]));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("bad: source is invalid.");
  });

  it("rejects a multi-session label fabricated seconds after the decision", () => {
    const source = row({
      label: {
        horizonDays: 20,
        forwardReturn: 0.1,
        horizonCloseAtISO: "2026-01-02T16:00:01.000Z",
        observedAtISO: "2026-01-02T16:00:02.000Z",
      },
    });
    const result = validatePointInTimeRow(source, evidenceFor([source]));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/verified market-session calendar/i);
  });

  it("rejects a self-declared Sunday close absent from the verified calendar", () => {
    const source = row({
      label: {
        horizonDays: 5,
        forwardReturn: 0.1,
        horizonCloseAtISO: "2026-01-25T03:17:00.000Z",
        observedAtISO: "2026-01-25T03:18:00.000Z",
      },
    });
    const evidence = {
      ...evidenceFor([source]),
      eligibleMarketClosesISO: [
        "2026-01-19T21:00:00.000Z",
        "2026-01-20T21:00:00.000Z",
        "2026-01-21T21:00:00.000Z",
        "2026-01-22T21:00:00.000Z",
        "2026-01-23T21:00:00.000Z",
      ],
    };
    expect(validatePointInTimeRow(source, evidence).valid).toBe(false);
  });

  it("returns deep-frozen clones so callers cannot mutate validated training evidence", () => {
    const source = [row()];
    const manifests = manifestsFor(source);
    const trained = trainableRows(source, manifests, evidenceFor(source, manifests));
    expect(Object.isFrozen(trained)).toBe(true);
    expect(Object.isFrozen(trained[0])).toBe(true);
    expect(Object.isFrozen(trained[0]!.features.filingMomentum)).toBe(true);
    expect(Object.isFrozen(trained[0]!.label)).toBe(true);
    (source[0]!.features.filingMomentum as { value: number | null }).value = 99;
    expect(trained[0]!.features.filingMomentum.value).toBe(0.4);
  });
});
