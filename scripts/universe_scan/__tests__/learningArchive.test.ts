import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLearningUniversePayload } from "../../../src/engine/learningUniverseArtifact";
import {
  computeLearningUniversePayloadSha256,
  readAndVerifyLearningUniverseArtifact,
  sealLearningUniverseArtifact,
  writeLearningUniverseArtifact,
} from "../learningArchive.mts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = resolve(root);
    if (!resolved.startsWith(resolve(tmpdir()))) throw new Error("Refusing to remove non-temporary test data");
    await rm(resolved, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catalyzed-learning-archive-"));
  roots.push(root);
  return root;
}

function payload(price = 10) {
  return buildLearningUniversePayload({
    sourceRunId: "scan_archive_test_123",
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
        batches: [
          {
            index: 0,
            status: "complete",
            requestedAtISO: "2026-07-21T12:00:02.000Z",
            receivedAtISO: "2026-07-21T12:01:00.000Z",
            requestedCount: 1,
            returnedCount: 1,
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
    sourceUniverseTickers: ["AAPL"],
    snapshotRequestedTickers: ["AAPL"],
    selectedForEnrichmentTickers: ["AAPL"],
    candidates: [
      {
        ticker: "AAPL",
        name: "Apple Inc",
        price,
        prevClose: 9,
        dayChange: (price - 9) / 9,
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
      },
    ],
  });
}

describe("learning-universe local archive", () => {
  it("stages, exclusively publishes, rehashes, and idempotently retries exact bytes", async () => {
    const root = await tempRoot();
    const envelope = sealLearningUniverseArtifact(payload());
    const [first, concurrent] = await Promise.all([
      writeLearningUniverseArtifact(root, envelope),
      writeLearningUniverseArtifact(root, envelope),
    ]);
    expect(new Set([first.status, concurrent.status])).toEqual(
      new Set(["local_verified", "local_idempotent"]),
    );
    const verified = await readAndVerifyLearningUniverseArtifact(first.filePath);
    expect(verified).toEqual(envelope);
    expect(await readFile(first.filePath, "utf8")).toMatch(/\n$/);
  });

  it("keeps verified local evidence when downstream enrichment faults", async () => {
    const root = await tempRoot();
    const envelope = sealLearningUniverseArtifact(payload());
    let persistedPath = "";

    const runWithInjectedEnrichmentFault = async () => {
      const local = await writeLearningUniverseArtifact(root, envelope);
      persistedPath = local.filePath;
      throw new Error("injected enrichment failure");
    };

    await expect(runWithInjectedEnrichmentFault()).rejects.toThrow(
      /injected enrichment failure/,
    );
    await expect(readAndVerifyLearningUniverseArtifact(persistedPath)).resolves.toEqual(
      envelope,
    );

    const scanSource = await readFile(
      resolve(process.cwd(), "scripts/universe_scan/scan.mts"),
      "utf8",
    );
    const firstLocalPersistence = scanSource.indexOf(
      "await persistLearningArchiveLocally();",
    );
    const enrichmentBoundary = scanSource.indexOf("// 4. Build scoring seeds");
    expect(firstLocalPersistence).toBeGreaterThan(-1);
    expect(enrichmentBoundary).toBeGreaterThan(-1);
    expect(firstLocalPersistence).toBeLessThan(enrichmentBoundary);
  });

  it("changes the digest for one-field mutation and forbids sourceRunId rebinding", async () => {
    const root = await tempRoot();
    const first = sealLearningUniverseArtifact(payload(10));
    const changed = sealLearningUniverseArtifact(payload(11));
    expect(changed.artifactSha256).not.toBe(first.artifactSha256);
    await writeLearningUniverseArtifact(root, first);
    await expect(writeLearningUniverseArtifact(root, changed)).rejects.toThrow(/different digest/);
  });

  it("rejects tampered bytes and filename/digest mismatch", async () => {
    const root = await tempRoot();
    const result = await writeLearningUniverseArtifact(root, sealLearningUniverseArtifact(payload()));
    const parsed = JSON.parse(await readFile(result.filePath, "utf8"));
    parsed.payload.candidates[0].price = 999;
    await writeFile(result.filePath, JSON.stringify(parsed), "utf8");
    await expect(readAndVerifyLearningUniverseArtifact(result.filePath)).rejects.toThrow(/digest/);
  });

  it("rejects semantically identical but non-canonical file bytes", async () => {
    const root = await tempRoot();
    const result = await writeLearningUniverseArtifact(root, sealLearningUniverseArtifact(payload()));
    const parsed = JSON.parse(await readFile(result.filePath, "utf8"));
    await writeFile(result.filePath, JSON.stringify(parsed, null, 2), "utf8");
    await expect(readAndVerifyLearningUniverseArtifact(result.filePath)).rejects.toThrow(/canonical/);
  });

  it("uses the same domain-separated digest helper as sealing", () => {
    const built = payload();
    expect(sealLearningUniverseArtifact(built).artifactSha256).toBe(
      computeLearningUniversePayloadSha256(built),
    );
  });
});
