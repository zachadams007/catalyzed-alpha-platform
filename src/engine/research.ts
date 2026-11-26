import type { DataProvider } from "@/data/providers";
import { enrichUniverseWithLiveNews } from "@/data/news/enrichCompanyNews";
import { enrichUniverseWithLiveSocial } from "@/data/social/enrichCompanySocial";
import { enrichUniverseWithCongress } from "@/data/congress/enrichCompanyCongress";
import { enrichUniverseWithSec } from "@/data/sec/enrichCompanySec";
import { enrichUniverseWithCatalystEvents } from "@/data/catalysts/enrichCatalystEvents";
import { enrichUniverseWithLiveHistory } from "@/data/prices/enrichCompanyHistory";
import { enrichUniverseWithLiveFundamentals } from "@/data/fundamentals/enrichCompanyFundamentals";
import { enrichUniverseWithEarnings } from "@/data/earnings/enrichCompanyEarnings";
import { isEarningsCalendarConfigured } from "@/data/earnings/earningsCalendar";
import { enforceFundamentalsPublishInvariant } from "@/data/fundamentals/publishInvariant";
import { readSignalHistory, writeSignalHistory } from "@/data/history/signalHistoryStore";
import { isFinnhubConfigured } from "@/data/http";
import type { ResearchRun, ResearchStage, StockSignal } from "@/types";
import { scoreCompany } from "./scoring";
import { toStockSignal } from "./enrich";
import {
  getActiveVariant,
  postProcessUniverse,
  runsCatalystDrivenProfile,
  type EngineVariantId,
} from "./challenger";
import type { NormalizationContext } from "./normalizeUniverse";
import {
  appendSnapshots,
  buildNormalizationContext,
  MAX_SERIES_LENGTH,
  type SnapshotInput,
} from "./signalHistory";

/**
 * The research pipeline.
 *
 * Mirrors what an early-morning automated job will eventually do:
 *   fetch universe -> score -> enrich -> rank -> publish.
 *
 * `runResearch` reports progress through an optional `onStage` callback so the
 * UI can animate the pipeline. In the MVP it runs on demand ("Scan the
 * Market"); see docs/feed-algorithm.md for the planned scheduled trigger.
 */

export interface ResearchResult {
  run: ResearchRun;
  signals: StockSignal[];
  /**
   * The time-aware normalization context the CATALYST-DRIVEN profile (the live
   * default champion) used this run (EWMA + estimate-revision), so the measurement
   * layer records the live model's view with the exact same inputs. Undefined for
   * the curated-base challenger and for offline (non-live) runs.
   */
  normalizationContext?: NormalizationContext;
}

/** Exported so the Algorithm tab's visualization renders the REAL stage list. */
export const STAGE_BLUEPRINT: Array<Pick<ResearchStage, "key" | "label">> = [
  { key: "ingest", label: "Ingesting market & fundamentals data" },
  { key: "news", label: "Scanning news & catalyst feeds" },
  { key: "social", label: "Measuring social & political attention" },
  { key: "score", label: "Scoring & risk-adjusting signals" },
  { key: "rank", label: "Ranking & assembling feeds" },
];

function nowIso(): string {
  return new Date().toISOString();
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runResearch(
  provider: DataProvider,
  trigger: "manual" | "scheduled" = "manual",
  onStage?: (run: ResearchRun) => void,
  variant: EngineVariantId = getActiveVariant(),
): Promise<ResearchResult> {
  const startedAt = nowIso();
  const start = performance.now();

  const stages: ResearchStage[] = STAGE_BLUEPRINT.map((s) => ({ ...s, status: "pending" }));
  const run: ResearchRun = {
    id: `run_${Date.now()}`,
    startedAt,
    provider: provider.name,
    universeSize: 0,
    signalsGenerated: 0,
    trigger,
    status: "running",
    stages,
  };

  const advance = (index: number, detail?: string) => {
    if (index > 0) stages[index - 1].status = "done";
    if (index < stages.length) {
      stages[index].status = "running";
      if (detail) stages[index].detail = detail;
    }
    onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
  };

  try {
    advance(0);
    const universe = await provider.fetchUniverse();
    run.universeSize = universe.length;
    // Honest funnel telemetry (e.g. "5,182 listed → 2,140 passed → top 240"),
    // when the provider offers it. Persisted on the run and shown as the live
    // discovery line; the per-name enrichment progress then takes over the detail.
    const discoverySummary = provider.telemetry?.();
    if (discoverySummary) {
      run.discoverySummary = discoverySummary;
      stages[0].detail = discoverySummary;
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
    }

    let enriched = universe;
    if (provider.isLive) {
      stages[0].detail = "Live price history & momentum (Yahoo)";
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      enriched = await enrichUniverseWithLiveHistory(enriched, (p) => {
        stages[0].detail = `${p.done}/${p.total} · price history`;
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      });
      if (isFinnhubConfigured()) {
        // Real fundamentals (margins, growth, valuation, beta, volume). Fields
        // Finnhub doesn't return are flagged "N/A" downstream, never fabricated.
        enriched = await enrichUniverseWithLiveFundamentals(enriched, (p) => {
          stages[0].detail = `${p.done}/${p.total} · fundamentals`;
          onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
        });
      }
      advance(1, `Fetching headlines for ${enriched.length} names`);
      enriched = await enrichUniverseWithLiveNews(enriched, (p) => {
        if (p.ticker) stages[1].detail = `${p.done + 1}/${p.total} · ${p.ticker}`;
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      });
      // Real SEC EDGAR activity (insider Form 4 + 8-K material events) - free,
      // keyless. One-time ticker->CIK load, then one submissions fetch per name.
      stages[1].detail = "Pulling SEC insider & 8-K filings";
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      enriched = await enrichUniverseWithSec(enriched, (p) => {
        stages[1].detail = `${p.done}/${p.total} · SEC filings`;
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      });
      // Earnings-date countdown - wires the next scheduled earnings into
      // catalyst.daysAway ("see it before the move") and attaches the consensus
      // EPS estimate for the revision-momentum snapshot. Runs for BOTH models so
      // they see identical inputs and differ only by algorithm (both use the
      // earnings DATE via catalyst timing; the catalyst-driven profile - the live
      // default CHAMPION - additionally consumes the EPS revision tilt below via the
      // NormalizationContext, while the curated-base challenger runs with it off).
      // No model-specific universe/capability narrowing - that is the explicit
      // contract now.
      if (isEarningsCalendarConfigured()) {
        stages[1].detail = "Earnings calendar — next dates & EPS estimates";
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
        enriched = await enrichUniverseWithEarnings(enriched, (p) => {
          stages[1].detail = `${p.done}/${p.total} · earnings calendar`;
          onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
        });
      }
      // Structured REAL catalyst events (keyless): SEC 8-K item codes + insider
      // BUY clusters / material SELLS folded into catalyst + secActivity, so the
      // engine's catalyst sub-score, smart-money boost, and material-sell signal
      // weight real filings - not just keyword-inferred news. One market-wide
      // fetch per source; degrades to the input universe unchanged on failure.
      stages[1].detail = "Structured catalysts — 8-K items & insider clusters";
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      enriched = await enrichUniverseWithCatalystEvents(enriched, {
        onProgress: (p) => {
          stages[1].detail = `${p.done}/${p.total} · catalyst events`;
          onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
        },
      });
    } else {
      advance(1, `${universe.length} candidates (sample news)`);
      await wait(250);
    }

    advance(2);
    if (provider.isLive) {
      stages[2].detail = "Live StockTwits attention & sentiment";
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      enriched = await enrichUniverseWithLiveSocial(enriched, (p) => {
        stages[2].detail = `${p.done}/${p.total} · StockTwits`;
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      });
      // Free, keyless congressional-trade disclosures (House/Senate Stock
      // Watcher) → political-attention signal. One-time dataset load, cached.
      stages[2].detail = "Cross-referencing congressional disclosures";
      onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      enriched = await enrichUniverseWithCongress(enriched, (p) => {
        stages[2].detail = `${p.done}/${p.total} · Congress trades`;
        onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
      });
    } else {
      await wait(250);
    }

    advance(3, `scoring ${enriched.length} names`);
    // PRE-PUBLISH HONEST-FUNDAMENTALS INVARIANT - the SAME seam the offline daily
    // scan runs (scripts/universe_scan/scan.mts). Before scoring, normalize every
    // in-app record: add a missing availability map, downgrade any field flagged
    // available but lacking a fresh as-of, and clear the as-of when nothing real
    // remains. Without this, the live in-app pipeline diverged from the scan and
    // could surface a stale/seeded fundamental as a live figure (keyFundamentals
    // would show a number instead of N/A). Runs on BOTH live and sample paths so
    // the two seams never drift.
    const { companies: normalized } = enforceFundamentalsPublishInvariant(enriched);
    const generatedAt = nowIso();
    const scored = normalized.map((company) =>
      toStockSignal(company, scoreCompany(company), generatedAt),
    );
    await wait(200);

    // Daily signal-history snapshot (LIVE only): record each name's news/social
    // sub-score + consensus EPS so the catalyst-driven profile's EWMA smoothing and
    // estimate-revision tilt have a real time series. The snapshot WRITE is
    // unconditional for every live run (outside the variant guard below) so the
    // series exists no matter which variant is active. Write-only - it never alters
    // the cached feed - and deduped by day so a same-day re-run is idempotent. The
    // context is built from PAST days, then today is appended.
    let normalizationContext: NormalizationContext | undefined;
    if (provider.isLive) {
      const day = generatedAt.slice(0, 10);
      const history = readSignalHistory();
      const todaySnapshots: SnapshotInput[] = scored.map((s) => ({
        ticker: s.ticker,
        news: s.score.categories.find((c) => c.key === "news")?.score ?? 50,
        social: s.score.categories.find((c) => c.key === "social")?.score ?? 50,
        eps: s.nextEarnings?.epsEstimate ?? null,
      }));
      // Build the time-aware context for the CATALYST-DRIVEN profile (the live
      // default champion) - that's the consumer: postProcessUniverse / challenger.ts
      // feeds `ctx` to CATALYST_DRIVEN_NORMALIZATION and passes `undefined` to the
      // curated-base challenger. Guarding on `=== "challenger"` inverted this, so the
      // live champion ran with ctx undefined and its EWMA-smoothed news/social and the
      // estimate-revision tilt were dead. Track the ALGORITHM, not the slot name.
      if (runsCatalystDrivenProfile(variant)) {
        normalizationContext = buildNormalizationContext(history, todaySnapshots, day);
      }
      const pruneBeforeDay = new Date(Date.parse(day) - MAX_SERIES_LENGTH * 86_400_000)
        .toISOString()
        .slice(0, 10);
      writeSignalHistory(appendSnapshots(history, todaySnapshots, day, pruneBeforeDay));
    }

    advance(4);
    // BOTH variants get the same cap-balanced cross-sectional re-score here - it
    // rewrites the ranking key before the sort (so neither feed is mega-cap heavy)
    // while leaving the raw per-dimension scores untouched. They differ ONLY in the
    // normalization profile: the challenger runs the SAME gentle small/mid tilt plus
    // the soft thesis gate and the size-balanced catalyst/discount blend, and folds
    // in the time-aware context (EWMA-smoothed news/social + the revision tilt, M4);
    // the champion runs the gentle base with that context off.
    const signals = postProcessUniverse(scored, variant, normalizationContext);
    signals.sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);
    stages[stages.length - 1].status = "done";

    run.signalsGenerated = signals.length;
    run.finishedAt = nowIso();
    run.durationMs = Math.round(performance.now() - start);
    run.status = "complete";
    onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });

    return { run, signals, normalizationContext };
  } catch (err) {
    run.status = "error";
    run.finishedAt = nowIso();
    run.durationMs = Math.round(performance.now() - start);
    onStage?.({ ...run, stages: stages.map((s) => ({ ...s })) });
    throw err;
  }
}
