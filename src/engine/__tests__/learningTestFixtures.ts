import {
  LEARNING_DATASET_SCHEMA_VERSION,
  type PointInTimeEvidenceRegistry,
  type PointInTimeFeatureRow,
  type PointInTimeUniverseManifest,
} from "@/engine/learningDataset";
import type { OfflineLearningPrediction } from "@/engine/learningPromotion";
import { buildWalkForwardFolds, type WalkForwardConfig } from "@/engine/walkForward";
import type {
  LearningUniverseCandidate,
  VerifiedUniverseArtifact,
} from "@/engine/learningUniverseArtifact";

const TICKERS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"] as const;

function instant(day: number, hour: number): string {
  return new Date(Date.UTC(2026, 0, day, hour)).toISOString();
}

function candidate(ticker: string, decisionAtISO: string, score: number): LearningUniverseCandidate {
  return {
    ticker,
    name: ticker,
    price: 100,
    prevClose: 99,
    dayChange: 1,
    dollarVolume: 10_000_000,
    rangePct: 0.03,
    quoteAsOfISO: decisionAtISO,
    priceSource: "daily_bar",
    priceAsOfISO: decisionAtISO,
    prevCloseSource: "previous_daily_bar",
    prevCloseAsOfISO: decisionAtISO,
    liquiditySource: "previous_daily_bar",
    liquidityAsOfISO: decisionAtISO,
    rangeSource: "previous_daily_bar",
    rangeAsOfISO: decisionAtISO,
    floorPassed: true,
    seeded: false,
    seedBypass: false,
    eligible: true,
    preRankScore: score,
  };
}

export interface LearningFixture {
  rows: PointInTimeFeatureRow[];
  manifests: PointInTimeUniverseManifest[];
  evidence: PointInTimeEvidenceRegistry;
}

export function buildLearningFixture(decisionDays = 40): LearningFixture {
  const rows: PointInTimeFeatureRow[] = [];
  const manifests: PointInTimeUniverseManifest[] = [];
  const artifacts: VerifiedUniverseArtifact[] = [];
  const closes = new Set<string>();
  for (let day = 1; day <= decisionDays; day += 1) {
    const universeId = `scan-${String(day).padStart(2, "0")}`;
    const decisionAtISO = instant(day, 22);
    const capturedAtISO = instant(day, 21);
    const digest = day.toString(16).padStart(64, "0");
    const sourceRunId = `source-${universeId}`;
    const artifactId = `sha256:${digest}`;
    const baselineByIndex = [0, 1, 5, 3, 4, 2] as const;
    for (let index = 0; index < TICKERS.length; index += 1) {
      const ticker = TICKERS[index]!;
      const forwardReturn = (index - 2.5) / 100;
      rows.push({
        schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
        rowId: `${universeId}:${ticker}`,
        ticker,
        decisionAtISO,
        universeId,
        sector: index % 2 === 0 ? "Industrials" : "Health Care",
        capCohort: index % 2 === 0 ? "mid" : "large",
        baselineScore: 50 + baselineByIndex[index]!,
        features: {
          momentum: {
            value: index / 5,
            source: "market_data",
            observedAtISO: instant(day, 21),
          },
        },
        label: {
          horizonDays: 1,
          forwardReturn,
          horizonCloseAtISO: instant(day + 1, 20),
          observedAtISO: instant(day + 1, 21),
        },
      });
    }
    closes.add(instant(day + 1, 20));
    const manifest: PointInTimeUniverseManifest = {
      schemaVersion: LEARNING_DATASET_SCHEMA_VERSION,
      universeId,
      captureScope: "full_candidate_universe",
      decisionAtISO,
      capturedAtISO,
      sourceRunId,
      universeDefinitionId: "catalyzed-us-common-stock-prerank-minimum-coverage-v1",
      sourceArtifactId: artifactId,
      sourceArtifactSha256: digest,
      eligibleTickers: [...TICKERS],
    };
    const candidates = TICKERS.map((ticker, index) =>
      candidate(ticker, decisionAtISO, 50 + baselineByIndex[index]!),
    );
    manifests.push(manifest);
    artifacts.push({
      artifactId,
      artifactSha256: digest,
      sourceRunId,
      universeId,
      universeDefinitionId: manifest.universeDefinitionId,
      codeRevision: "c".repeat(40),
      capturedAtISO,
      decisionAtISO,
      eligibleTickers: [...TICKERS],
      candidates,
      eligibleCandidates: candidates,
    });
  }
  return {
    rows,
    manifests,
    evidence: {
      verifiedUniverseArtifacts: artifacts,
      eligibleMarketClosesISO: [...closes],
    },
  };
}

export function predictionForRow(
  row: PointInTimeFeatureRow,
  slice: OfflineLearningPrediction["slice"],
  candidateId = "candidate-v1",
): OfflineLearningPrediction {
  const feature = row.features.momentum?.value ?? 0;
  const positive = row.label != null && row.label.forwardReturn > 0;
  return {
    rowId: row.rowId,
    decisionAtISO: row.decisionAtISO,
    ticker: row.ticker,
    sector: row.sector,
    capCohort: row.capCohort,
    baselineScore: row.baselineScore,
    shadowScore: 50 + feature * 10,
    successProbability: positive ? 1 : 0,
    forwardReturn: row.label?.forwardReturn ?? null,
    candidateId,
    slice,
  };
}

export function buildEvaluationPredictions(
  fixture: LearningFixture,
  holdoutStartDay: string,
  config: WalkForwardConfig,
): OfflineLearningPrediction[] {
  const developmentRows = fixture.rows.filter(
    (row) => row.decisionAtISO.slice(0, 10) < holdoutStartDay,
  );
  const universeIds = new Set(developmentRows.map((row) => row.universeId));
  const folds = buildWalkForwardFolds(
    developmentRows,
    fixture.manifests.filter((manifest) => universeIds.has(manifest.universeId)),
    fixture.evidence,
    config,
  );
  const predictions = folds.flatMap((fold) =>
    fold.testRows.map((row) =>
      predictionForRow(row, {
        kind: "walk_forward",
        foldIndex: fold.index,
        trainedThroughISO: fold.trainEndISO,
      }),
    ),
  );
  const trainedThroughISO = new Date(
    Date.parse(`${holdoutStartDay}T00:00:00.000Z`) - 1,
  ).toISOString();
  predictions.push(
    ...fixture.rows
      .filter((row) => row.decisionAtISO.slice(0, 10) >= holdoutStartDay)
      .map((row) => predictionForRow(row, { kind: "holdout", trainedThroughISO })),
  );
  return predictions;
}
