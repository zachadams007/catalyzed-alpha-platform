// IMPORTANT: bootstrap MUST be the first import - it installs the Node
// localStorage/window shims and seeds sample-mode OFF + budgets OFF before any
// `@/` module reads them at load time.
import "./bootstrap.mjs";

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import type { CompanyData, ResearchRun, StockSignal } from "@/types";
import { isAlpacaConfigured, isFinnhubConfigured } from "@/data/http";
import { fetchUsCommonStockUniverseAudited } from "@/data/finnhub/symbolList";
import { fetchSnapshotQuotesAudited, type SnapshotQuote } from "@/data/alpaca/snapshots";
import { preRankUniverse, type PreRankInput } from "@/engine/preRank";
import { buildLearningUniversePayload } from "@/engine/learningUniverseArtifact";
import { REAL_UNIVERSE_TICKERS } from "@/data/realUniverse";
import { MARKET_MAJOR_TICKERS, MARKET_MAJORS } from "@/data/symbols/majors.generated";
import { fetchFinnhubCompany } from "@/data/finnhub/liveCompany";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  allFalseFundamentalsAvailability,
  unknownFundamentals,
} from "@/data/fundamentals/fundamentalsProvenance";
import { genPriceSeries, closesFromSeries } from "@/data/priceSeries";
import { enrichUniverseWithAlpacaBars } from "@/data/prices/enrichCompanyBars";
import { fetchDailyBars } from "@/data/alpaca/bars";
import { enrichUniverseWithLiveFundamentals } from "@/data/fundamentals/enrichCompanyFundamentals";
import { enrichUniverseWithMarketCap } from "@/data/fundamentals/enrichMarketCap";
import { enrichUniverseWithLiveNews } from "@/data/news/enrichCompanyNews";
import { enrichUniverseWithEarnings } from "@/data/earnings/enrichCompanyEarnings";
import { enrichTopNWithInflection } from "@/data/fundamentals/enrichInflection";
import { enrichScanUniverseWithCongressBuys } from "@/data/congress/scanCongressBuys";
import {
  enrichUniverseWithCatalystEvents,
  harvestCatalystActiveTickers,
} from "@/data/catalysts/enrichCatalystEvents";
import { noCatalyst, isRealCatalyst } from "@/data/catalysts/catalystState";
import { fetchXbrlPipelineByTicker } from "@/data/sec/xbrlPipeline";
import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import { getActiveVariant, postProcessUniverse } from "@/engine/challenger";
import { getGlobalControls, initGlobalControls } from "@/data/globalControls";
import { buildArchetypeContext } from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import { sanitizeSignalsAnalyst } from "@/data/analyst/sanitizeAnalystCoverage";
import { enforceFundamentalsPublishInvariant } from "@/data/fundamentals/publishInvariant";
import { uploadDailySignals } from "./upload.mjs";
import {
  sealLearningUniverseArtifact,
  writeLearningUniverseArtifact,
} from "./learningArchive.mts";
import { uploadLearningUniverseArtifact } from "./uploadLearningArchive.mjs";
import { discoverAndCacheCatalysts } from "./discoverCatalysts.mjs";
import { reportScanUsage } from "./reportUsage.mjs";

// ── Config (env-tunable; sensible defaults) ─────────────────────────────────
const TARGET = intEnv("UNIVERSE_TARGET", 500);
const SYMBOL_LIMIT = intEnv("SCAN_LIMIT_SYMBOLS", 0); // 0 = no cap (testing only)
const SEED_GAP_MS = intEnv("SEED_GAP_MS", 350);
const MIN_PRICE = floatEnv("SCAN_MIN_PRICE", 2);
// Hard market-cap floor (owner request 2026-06-29: a $4M shell like HCTI must NEVER appear).
// Applied AFTER enrichment, where marketCap is known. A name with unknown cap (0)
// is kept - the $2 price + $2M $-volume floors already screen most junk there.
const MIN_MARKET_CAP = floatEnv("SCAN_MIN_MARKET_CAP", 50_000_000);
const MIN_DOLLAR_VOLUME = floatEnv("SCAN_MIN_DOLLAR_VOLUME", 2_000_000);
const DRY_RUN = boolEnv("SCAN_DRY_RUN", false);
const CONGRESS_MAX = intEnv("SCAN_CONGRESS_MAX", 0); // 0 = no per-run cap (mapping is free, in-memory)
// Catalyst-driven inclusion: how many freshly-catalyst-active (8-K/insider-buy/13D)
// tickers to seed INTO the scored pool. They're added on top of the curated + majors
// seeds; bounded so they never crowd out all liquidity-discovery slots.
const CATALYST_SEED_MAX = intEnv("SCAN_CATALYST_SEED_MAX", 180);
// v2 inflection fold: pull Finnhub QUARTERLY metric series for the top-N names
// (the ones that will surface) so the inflection dimension uses REAL margin/sales
// trends. One Finnhub call each, paced for the 60/min free limit. 0 disables it;
// the rest of the universe stays cold-start-neutral (never faked).
//
// 500 = the whole published board (was 150). The top-N is chosen by the V5
// PRELIMINARY score, so the 350 names ranked below it by price action never got a
// fundamental-inflection read at all - Alphabet sat at a neutral 50 on the
// 2026-07-29 board for that reason, and the 2026-09-19 replay found 400+ of 470
// names with no or stale inputs. With the seven-key pool (420 calls/min) the
// extra 350 calls cost about a minute. SCAN_INFLECTION_TOP_N still overrides.
const INFLECTION_TOP_N = intEnv("SCAN_INFLECTION_TOP_N", 500);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEARNING_ARCHIVE_ROOT =
  process.env.LEARNING_ARCHIVE_ROOT?.trim() || join(SCRIPT_DIR, "learning-archive");

interface LearningArchiveMeta {
  sourceRunId: string;
  artifactId: string | null;
  artifactSha256: string | null;
  relativePath: string | null;
  admissible: boolean | null;
  quarantineReasons: string[];
  archiveStatus: "admissible" | "quarantined" | "capture_failed";
  localStatus: "not_attempted" | "local_verified" | "local_idempotent" | "local_failed";
  remoteStatus: "not_attempted" | "remote_verified" | "remote_idempotent" | "remote_failed";
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function floatEnv(name: string, fallback: number): number {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off") return false;
  return fallback;
}

const t0 = Date.now();
function log(msg: string): void {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, " ");
  console.log(`[+${secs}s] ${msg}`);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build a scoring-ready seed for one ticker. Prefers the canonical Finnhub
 * builder (real name / sector / market-cap / price); falls back to an
 * Alpaca-priced synthetic so a throttled name still publishes with a REAL price.
 * Either way the real Alpaca dollar-volume is overlaid onto liquidity.
 */
async function buildSeed(
  ticker: string,
  snap: SnapshotQuote | undefined,
  fallbackName?: string,
): Promise<CompanyData | null> {
  let company = await fetchFinnhubCompany(ticker).catch(() => null);

  if (!company) {
    if (!snap) return null; // no Finnhub AND no snapshot price → nothing real to show
    const synthetic = buildSyntheticCompany(ticker);
    const series = genPriceSeries(ticker, snap.price, snap.dayChange, synthetic.volatility.atrPct);
    company = {
      ...synthetic,
      // Prefer the real company name from the Finnhub symbol list (free, already
      // fetched) over the synthetic placeholder when the profile call is throttled.
      name: fallbackName?.trim() || synthetic.name.replace(" (sample)", ""),
      price: snap.price,
      dayChange: snap.dayChange,
      priceSeries: series,
      priceHistory: closesFromSeries(series),
      // Real Alpaca price, but NO real fundamentals on this throttled-fallback
      // seed: start with the neutral placeholder + all-false availability so the
      // synthetic PRNG block never leaks as live. The fundamentals stage layers
      // in real values when it can; the pre-publish invariant is the backstop.
      fundamentals: unknownFundamentals(),
      fundamentalsAvailability: allFalseFundamentalsAvailability(),
      // No catalyst on the throttled-fallback seed either - never inherit the
      // synthetic PRNG catalyst, and catalysts are never inferred from news. Only
      // a REAL structured event (catalyst-events stage) sets one.
      catalyst: noCatalyst(),
      catalystLive: false,
      sources: [],
    };
  }

  if (snap && snap.dollarVolume > 0) {
    company.liquidity = { ...company.liquidity, avgDollarVolume: snap.dollarVolume };
  }
  return overlayTrustedMajor(company);
}

/**
 * For a name on the trusted majors backbone, overlay its REAL, curated sector and
 * a trustworthy market cap. WHY: when a major's Finnhub profile2 call is throttled
 * during the scan, buildSeed falls back to a SYNTHETIC company whose sector is
 * hashed from the ticker and whose cap is a placeholder - that's how TSLA shipped
 * as "Real Estate / $5.4T" and JPM as "$11.9T". The majors roster (regenerated
 * weekly from real Finnhub industry + cap, curated overrides) is the source of
 * truth for these names, so we ALWAYS take its sector, and take its cap unless the
 * live cap is a believable ≤±50% drift (a real cap can't move more in a week).
 */
function overlayTrustedMajor(company: CompanyData): CompanyData {
  const major = MAJOR_BY_TICKER.get(company.ticker.trim().toUpperCase());
  if (!major) return company;
  const live = company.marketCap;
  const capOk =
    Number.isFinite(live) && live > 0 && live >= major.marketCap * 0.5 && live <= major.marketCap * 1.6;
  return {
    ...company,
    sector: major.sector,
    marketCap: capOk ? live : major.marketCap,
  };
}
const MAJOR_BY_TICKER = new Map(MARKET_MAJORS.map((m) => [m.ticker.toUpperCase(), m]));

async function main(): Promise<void> {
  const sourceRunId = `scan_${randomUUID()}`;
  try {
    writeFileSync(
      join(SCRIPT_DIR, "last-attempt.json"),
      JSON.stringify({ sourceRunId, startedAtISO: new Date(t0).toISOString() }),
      { flag: "w" },
    );
  } catch {
    log("WARN: could not persist scan-attempt identity; stale-board recovery will be disabled.");
  }
  log(`Catalyzed daily broad-universe scan — target ${TARGET} names.`);

  // Preserve the pre-existing provider-gate calls (including Finnhub key-pool
  // cursor advancement) so adding audit capture cannot shift enrichment keys.
  if (!isFinnhubConfigured()) throw new Error("Finnhub not configured (need VITE_FINNHUB_API_KEY).");
  if (!isAlpacaConfigured()) throw new Error("Alpaca not configured (need VITE_ALPACA_API_KEY/SECRET).");

  // 1. A broad US common-stock response (one Finnhub call). Fall back to the
  //    curated set if the list call fails so the scan never produces nothing.
  const universeFetch = await fetchUsCommonStockUniverseAudited();
  const universe = universeFetch.entries;
  const names = new Map<string, string>(universe.map((e) => [e.symbol, e.name]));
  let symbols = universe.map((e) => e.symbol);
  let universeSource: "finnhub_us_common_stocks" | "curated_fallback" =
    "finnhub_us_common_stocks";
  if (symbols.length === 0) {
    log("WARN: Finnhub symbol list empty — falling back to the curated universe.");
    symbols = [...REAL_UNIVERSE_TICKERS];
    universeSource = "curated_fallback";
  }
  const sourceUniverseTickers = [...symbols];
  let inputWasLimited = false;
  if (SYMBOL_LIMIT > 0 && symbols.length > SYMBOL_LIMIT) {
    // Testing cap: keep the curated names + a slice so the funnel still has variety.
    const seedSet = new Set<string>(REAL_UNIVERSE_TICKERS);
    const seeds = symbols.filter((s) => seedSet.has(s));
    const rest = symbols.filter((s) => !seedSet.has(s)).slice(0, Math.max(0, SYMBOL_LIMIT - seeds.length));
    symbols = [...new Set([...seeds, ...rest])];
    inputWasLimited = true;
    log(`Symbol list capped to ${symbols.length} for testing (SCAN_LIMIT_SYMBOLS=${SYMBOL_LIMIT}).`);
  }
  const snapshotRequestedTickers = [...symbols];
  log(`US common-stock universe: ${symbols.length} symbols.`);

  // 2. Bulk snapshots (price/prev-close/volume/range) for the whole list.
  const snapshotFetch = await fetchSnapshotQuotesAudited(symbols, {
    batchSize: 200,
    gapMs: 120,
    onProgress: (done, total) => {
      if (done % 1000 === 0 || done === total) log(`  snapshots ${done}/${total}`);
    },
  });
  const snaps = snapshotFetch.quotes;
  const snapList = Object.values(snaps);
  log(`Snapshots returned for ${snapList.length} symbols.`);

  // 3. Cheap cross-sectional pre-rank → the names worth a full scoring pass.
  const preInputs: PreRankInput[] = snapList.map((q) => ({
    ticker: q.ticker,
    price: q.price,
    prevClose: q.prevClose,
    dayChange: q.dayChange,
    dollarVolume: q.dollarVolume,
    rangePct: q.rangePct,
  }));
  // 3a. ⭐ CATALYST-DRIVEN INCLUSION - harvest the market-wide catalyst sources
  //     (8-K filers, insider BUYERS, SC 13D/13G stakes) BEFORE the pool is chosen
  //     and seed the ones that have a real Alpaca snapshot (priced + tradeable).
  //     This is the fix for "no catalysts / no small-caps on the board": those
  //     sources are market-wide, but folding them only into the already-picked
  //     (large-cap-heavy) 500 dropped every catalyst-active small-cap that wasn't
  //     already in the pool. Seeding them makes a fresh INSIDER BUY / 13D / 8-K on
  //     a small-cap actually pull it INTO the scored pool, where the catalyst tilt
  //     + cap-curve can lift it. Additive - the majors backbone (the Map) stays.
  let catalystSeeds: string[] = [];
  try {
    log("Harvesting catalyst-active tickers (8-K, insider buys, 13D) for inclusion…");
    const harvest = await harvestCatalystActiveTickers();
    // Keep only catalyst names with a live snapshot (real, priced, liquid-ish) so
    // we seed tradeable names, not OTC/illiquid filer noise. Cap so seeds never
    // crowd out all discovery (env-tunable).
    catalystSeeds = [...harvest.tickers].filter((t) => snaps[t] != null).slice(0, CATALYST_SEED_MAX);
    log(
      `  catalyst-active: ${harvest.tickers.size} filed (8-K ${harvest.bySource.eightK}, insider ${harvest.bySource.insider}, 13D ${harvest.bySource.thirteenD}) → ${catalystSeeds.length} with a live snapshot, seeded into the pool.`,
    );
  } catch (err) {
    log(`  catalyst harvest failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // Seeds = the curated research universe + the market-majors backbone + the
  // freshly-catalyst-active names. The majors guarantee the biggest-cap names
  // (and fresh mega-cap IPOs like SPCX) are always scored, so the DAY-move Market
  // Map reads like a classic market map; the catalyst seeds inject small/mid names
  // with a REAL fresh catalyst. preRankUniverse dedupes + takes seeds first.
  const seedTickers = [
    ...new Set([...REAL_UNIVERSE_TICKERS, ...MARKET_MAJOR_TICKERS, ...catalystSeeds]),
  ];
  const ranked = preRankUniverse(preInputs, {
    target: TARGET,
    minPrice: MIN_PRICE,
    minDollarVolume: MIN_DOLLAR_VOLUME,
    alwaysInclude: seedTickers,
  });
  log(
    `Pre-rank: ${ranked.consideredCount} considered → ${ranked.gatedCount} liquid (≥$${(
      MIN_DOLLAR_VOLUME / 1e6
    ).toFixed(1)}M/day, ≥$${MIN_PRICE}) → selected ${ranked.tickers.length} (${seedTickers.length} seeds: ${REAL_UNIVERSE_TICKERS.length} curated + ${MARKET_MAJOR_TICKERS.length} majors + ${catalystSeeds.length} catalyst-active).`,
  );

  // Prospective learning evidence is captured at the pre-rank boundary, before
  // synthetic seed construction, enrichment, full scoring, labels, or UI shaping.
  let learningArchive: LearningArchiveMeta = {
    sourceRunId,
    artifactId: null,
    artifactSha256: null,
    relativePath: null,
    admissible: null,
    quarantineReasons: [],
    archiveStatus: "capture_failed",
    localStatus: "not_attempted",
    remoteStatus: "not_attempted",
  };
  let learningArchiveEnvelope: ReturnType<typeof sealLearningUniverseArtifact> | null = null;
  let learningArchiveCaptureAttempted = false;
  const learningDecisionAtISO = new Date().toISOString();
  const learningCandidateInputs = snapList.map((quote) => ({
    ticker: quote.ticker,
    name: names.get(quote.ticker)?.trim() || quote.ticker,
    price: quote.price,
    prevClose: quote.prevClose,
    dayChange: quote.dayChange,
    dollarVolume: quote.dollarVolume,
    rangePct: quote.rangePct,
    quoteAsOfISO: quote.asOf,
    priceSource: quote.priceSource,
    priceAsOfISO: quote.priceAsOfISO,
    prevCloseSource: quote.prevCloseSource,
    prevCloseAsOfISO: quote.prevCloseAsOfISO,
    liquiditySource: quote.liquiditySource,
    liquidityAsOfISO: quote.liquidityAsOfISO,
    rangeSource: quote.rangeSource,
    rangeAsOfISO: quote.rangeAsOfISO,
  }));
  const captureLearningArchiveInMemory = () => {
    if (learningArchiveCaptureAttempted) return;
    learningArchiveCaptureAttempted = true;
    try {
      const payload = buildLearningUniversePayload({
        sourceRunId,
        codeRevision:
          process.env.CATALYZED_CODE_REVISION?.trim() ||
          process.env.GITHUB_SHA?.trim() ||
          "unverified",
        capturedAtISO: snapshotFetch.audit.receivedAtISO,
        decisionAtISO: learningDecisionAtISO,
        universeSource,
        captureTrigger:
          process.env.GITHUB_ACTIONS === "true"
            ? "github_actions"
            : process.env.SCAN_TRIGGER === "manual"
              ? "manual"
              : "local",
        runAttempt: `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
        inputWasLimited,
        dryRun: DRY_RUN,
        providerAudits: {
          finnhub: universeFetch.audit,
          alpaca: snapshotFetch.audit,
        },
        eligibilityPolicy: {
          minPrice: MIN_PRICE,
          maxPrice: null,
          minDollarVolume: MIN_DOLLAR_VOLUME,
          alwaysIncludeTickers: seedTickers,
        },
        selectionTarget: TARGET,
        sourceUniverseTickers,
        snapshotRequestedTickers,
        selectedForEnrichmentTickers: ranked.tickers,
        candidates: learningCandidateInputs,
      });
      const envelope = sealLearningUniverseArtifact(payload);
      learningArchive = {
        ...learningArchive,
        artifactId: envelope.artifactId,
        artifactSha256: envelope.artifactSha256,
        admissible: payload.admissible,
        quarantineReasons: payload.quarantineReasons,
        archiveStatus: payload.admissible ? "admissible" : "quarantined",
      };
      learningArchiveEnvelope = envelope;
      log(
        `Learning-universe evidence captured in memory: ` +
          `${payload.eligibleTickers.length}/${payload.candidates.length} eligible observations, ` +
          `${payload.admissible ? "admissible" : "quarantined"}.`,
      );
    } catch {
      log("WARN: learning-universe artifact validation failed; daily signal computation will continue.");
    }
  };

  const persistLearningArchiveLocally = async () => {
    if (!learningArchiveEnvelope) return null;
    if (
      learningArchive.localStatus === "local_verified" ||
      learningArchive.localStatus === "local_idempotent"
    ) {
      return learningArchiveEnvelope;
    }
    try {
      const local = await writeLearningUniverseArtifact(
        LEARNING_ARCHIVE_ROOT,
        learningArchiveEnvelope,
      );
      learningArchive.localStatus = local.status;
      learningArchive.relativePath = relative(LEARNING_ARCHIVE_ROOT, local.filePath).replace(
        /\\/g,
        "/",
      );
      learningArchiveEnvelope = local.envelope;
      return local.envelope;
    } catch {
      learningArchive.localStatus = "local_failed";
      log("WARN: learning-universe local persistence failed; daily signal publish will continue.");
      return null;
    }
  };

  // Seal and locally persist the exact pre-rank evidence before any expensive
  // enrichment can fail. This write is nonfatal to the board, but once verified
  // it survives every later seed/enrichment/scoring exception. Remote publication
  // stays deferred until the independent daily-board computation is fixed.
  captureLearningArchiveInMemory();
  await persistLearningArchiveLocally();

  if (snapList.length === 0) {
    throw new Error("No snapshots returned from Alpaca — aborting after quarantined archive attempt.");
  }

  // 4. Build scoring seeds (paced for Finnhub's 60/min free tier).
  const seeds: CompanyData[] = [];
  for (let i = 0; i < ranked.tickers.length; i++) {
    const ticker = ranked.tickers[i]!;
    const seed = await buildSeed(ticker, snaps[ticker], names.get(ticker));
    if (seed) seeds.push(seed);
    if ((i + 1) % 50 === 0 || i === ranked.tickers.length - 1) {
      log(`  seeds ${i + 1}/${ranked.tickers.length} (kept ${seeds.length})`);
    }
    if (i < ranked.tickers.length - 1) await delay(SEED_GAP_MS);
  }
  log(`Built ${seeds.length} seeds.`);

  // 5. Real enrichment - the same lanes the live curated feed uses. Each degrades
  //    gracefully per name (a throttled name keeps its modeled value + real price).
  let enriched = seeds;
  log("Enriching: price history & momentum (Alpaca daily bars)…");
  enriched = await enrichUniverseWithAlpacaBars(enriched, (p) => {
    if (p.done % 100 === 0) log(`  bars ${p.done}/${p.total}`);
  });
  log("Enriching: fundamentals (Finnhub)…");
  enriched = await enrichUniverseWithLiveFundamentals(enriched, (p) => {
    if (p.done % 100 === 0) log(`  fundamentals ${p.done}/${p.total}`);
  });
  // Foreign listings / ADRs come back from Finnhub in their LOCAL currency, so
  // their cap is discarded there rather than mis-converted; FMP's US line has it
  // in USD. Without this a $1.26T name sizes as "Unknown" and slips straight
  // through the user's market-cap filter. Single digits of calls in practice.
  log("Enriching: market-cap backfill for unsized names (FMP)…");
  enriched = await enrichUniverseWithMarketCap(enriched);

  log("Enriching: news & catalysts (Finnhub)…");
  enriched = await enrichUniverseWithLiveNews(enriched, (p) => {
    if (p.done % 100 === 0) log(`  news ${p.done}/${p.total}`);
  });

  // 5a-ii. Forward EARNINGS calendar (one bulk FMP call; Finnhub fallback). Powers
  //   the "see it before the move" catalyst countdown AND snapshots consensus EPS so
  //   the estimate-revision signal has a real series. Degrades to the universe
  //   unchanged when no earnings transport is configured (no fabrication).
  log("Enriching: forward earnings calendar (FMP bulk → Finnhub fallback)…");
  enriched = await enrichUniverseWithEarnings(enriched, (p) => {
    if (p.done % 100 === 0) log(`  earnings ${p.done}/${p.total}`);
  });

  // 5b. Smart-money tilt - attach RECENT disclosed congressional open-market BUYS
  //     so the bounded smart-money catalyst boost (src/engine/smartMoney.ts)
  //     actually fires on the daily board. One keyless House Stock Watcher fetch,
  //     then pure Map lookups across the universe - no per-ticker EDGAR/Form 4
  //     XML, no rate-limit exposure; degrades silently to no boost on any failure.
  log("Enriching: congressional buys (House Stock Watcher)…");
  const congress = await enrichScanUniverseWithCongressBuys(enriched, {
    maxCompanies: CONGRESS_MAX > 0 ? CONGRESS_MAX : undefined,
  });
  enriched = congress.companies;
  log(`  smart-money: congressional buys attached to ${congress.enrichedCount}/${enriched.length} names.`);

  // 5c. Structured REAL catalyst events (keyless): SEC 8-K item codes, insider
  //     BUY clusters / material SELLS, SC 13D/13G activist+institutional stakes,
  //     USASpending federal contracts, openFDA new-drug approvals, and (when a
  //     research proxy + feeds are configured) newsletter/RSS → Gemini events.
  //     Folded into c.catalyst + secActivity so the daily board's catalyst
  //     sub-score, smart-money boost, and material-sell signal weight REAL
  //     filings - not just keyword-inferred news. One market-wide fetch per
  //     source; degrades to the input universe unchanged on any failure.
  // 5c-0. AUTONOMOUS CATALYST DISCOVERY (the engine). Run the grounded edge-fn
  //     scan FIRST and cache it, so THIS run's structured-catalyst fold (5c) reads
  //     today's fresh discoveries - political callouts/trades, notable insider
  //     buys, M&A/FDA/guidance/contracts - and weighs them in scoring, while the
  //     Terminal reads the same cache. Non-fatal: a discovery blip never costs the
  //     universe compute (falls back to yesterday's cache + the static seed).
  log("Discovering market-wide catalysts (grounded edge scan: political, insider buys, M&A/FDA/guidance/contracts)…");
  try {
    await discoverAndCacheCatalysts(log);
  } catch (err) {
    log(`  catalyst discovery failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  log("Enriching: structured catalysts (8-K, insider, 13D/G, contracts, FDA, feeds + discovered)…");
  const beforeCat = enriched;
  enriched = await enrichUniverseWithCatalystEvents(enriched);
  const catChanged = enriched.reduce((n, c, i) => (c !== beforeCat[i] ? n + 1 : n), 0);
  log(`  catalysts: structured events folded into ${catChanged}/${enriched.length} names.`);

  // 5d. PRE-PUBLISH HONEST-FUNDAMENTALS INVARIANT. The last line of defence: no
  //     record may carry a fundamental flagged real unless it's truly real
  //     (present map + flagged true + fresh as-of). A throttled fallback seed, a
  //     record that skipped the fundamentals stage, or a stale figure is
  //     normalized to "N/A" HERE - before scoring/display - so a synthetic or
  //     stale number can never be published to daily_signals as a live figure.
  const invariant = enforceFundamentalsPublishInvariant(enriched);
  enriched = invariant.companies;
  log(
    `Honest-fundamentals invariant: ${invariant.repaired} record(s) repaired ` +
      `(${invariant.missingMap} missing an availability map) — all publish records now carry a map.`,
  );

  // NOTE ON ORDERING: this fold runs AFTER the freshness invariant above, and that
  // is deliberate. The invariant exists to stop a STALE VENDOR SNAPSHOT being
  // published as a live figure, and it enforces that with a recency window. These
  // values are not vendor snapshots - they are primary-source figures read straight
  // out of the filer's own XBRL, each carrying the period it covers. An annual free
  // cash flow being older than the vendor window does not make it wrong; it means
  // the company has not filed a newer one, which is exactly the most recent truth
  // available. Folding before the invariant would have silently deleted it.
  // 5e. FORWARD PIPELINE + REAL FREE CASH FLOW (SEC XBRL frames). The `pipeline` dimension carries a
  //     real blend weight (0.10 flat, up to 0.18 on the small-cap curve) but was
  //     scoring a flat neutral 50 for 100% of the published board - nothing ever
  //     populated `CompanyData.pipeline`, so the dimension had weight and zero
  //     information (proved by scripts/diag_coverage.mts). This folds in the
  //     DISCLOSED remaining-performance-obligation / contract-liability figures
  //     straight from us-gaap XBRL, which is where contracted demand shows up
  //     BEFORE it is recognized as revenue - e.g. Oracle's RPO $137.8B → $638.0B
  //     while recognized revenue grew ~17%. ~20 bulk `frames` requests cover the
  //     entire universe. Best-effort: SEC unreachable ⇒ empty map ⇒ every name
  //     keeps today's cold-start neutral, never a fabricated or penalized value.
  log("Enriching: forward pipeline (SEC XBRL remaining performance obligations)…");
  try {
    const pipelineFacts = await fetchXbrlPipelineByTicker();
    let pipelineFolded = 0;
    enriched = enriched.map((c) => {
      const facts = pipelineFacts.get(c.ticker.toUpperCase());
      if (!facts) return c;
      pipelineFolded++;
      return {
        ...c,
        pipeline: {
          ...c.pipeline,
          ...(facts.backlogToRevTTM != null ? { backlogToRevTTM: facts.backlogToRevTTM } : {}),
          ...(facts.backlogYoY != null ? { backlogYoY: facts.backlogYoY } : {}),
          ...(facts.deferredRevYoY != null ? { deferredRevYoY: facts.deferredRevYoY } : {}),
        },
        // REAL free cash flow, from disclosed operating cash flow minus capex.
        // `fcfMargin` was disclosed for 0% of the board by the vendor feed, which
        // silently disabled the solvency risk penalty for every name - a micro-cap
        // burning several times its revenue was rated "Low risk". Marking
        // availability TRUE is correct here: this is a filed figure, not a model.
        // PRIMARY SOURCE WINS over the vendor for the fields we can read straight
        // from the filer's own XBRL. Finnhub returned SoFi at a -19.79% net margin
        // beside a POSITIVE 36.6 P/E (arithmetically impossible) and a 205% revenue
        // growth against an actual ~41%. Where SEC has the number, SEC is the number.
        ...(facts.fcfMargin != null || facts.netMargin != null || facts.revenueGrowthYoY != null
          ? {
              fundamentals: {
                ...c.fundamentals,
                ...(facts.fcfMargin != null ? { fcfMargin: facts.fcfMargin } : {}),
                ...(facts.netMargin != null ? { netMargin: facts.netMargin } : {}),
                ...(facts.revenueGrowthYoY != null
                  ? { revenueGrowthYoY: facts.revenueGrowthYoY }
                  : {}),
              },
              fundamentalsAvailability: {
                ...c.fundamentalsAvailability,
                ...(facts.fcfMargin != null ? { fcfMargin: true } : {}),
                ...(facts.netMargin != null ? { netMargin: true } : {}),
                ...(facts.revenueGrowthYoY != null ? { revenueGrowthYoY: true } : {}),
              },
            }
          : {}),
        // Only adopt the XBRL annual revenue when the scan has nothing better -
        // it is the same disclosed figure the backlog ratio is computed against.
        ...(c.revenueTTM == null && facts.revenueTTM != null
          ? { revenueTTM: facts.revenueTTM }
          : {}),
      };
    });
    log(`  pipeline: disclosed RPO/backlog folded into ${pipelineFolded}/${enriched.length} names.`);
  } catch (err) {
    log(`  pipeline fold failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }


  // 6. Score with the REAL engine (champion) and rank.
  const generatedAt = new Date().toISOString();
  let scored: StockSignal[] = enriched
    .map((c) => toStockSignal(c, scoreCompany(c), generatedAt))
    .sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);

  // 6a. v2 INFLECTION FOLD - fetch REAL quarterly fundamentals for the top-N names
  //     (the ones that will surface) from Finnhub's FREE quarterly metric series
  //     (/stock/metric?metric=all → series.quarterly: gross/operating margin,
  //     sales-per-share, SG&A/sales) and re-score with the inflection dimension live
  //     instead of the cold-start neutral. One Finnhub call per name, top-N only; the
  //     rest keep the inert neutral (never faked). Uses the same free Finnhub pool as
  //     the rest of the scan - NO paid/FMP key needed (FMP's free quarterly statement
  //     endpoint was deprecated, which is why this was rewired to Finnhub). The prelim
  //     ranking above picks WHICH names get the pull, so the work lands on what shows.
  if (INFLECTION_TOP_N > 0) {
    const topTickers = new Set(scored.slice(0, INFLECTION_TOP_N).map((s) => s.ticker));
    const topCompanies = enriched.filter((c) => topTickers.has(c.ticker));
    log(`Enriching: v2 inflection (Finnhub quarterly metrics) for top ${topCompanies.length}…`);
    const folded = await enrichTopNWithInflection(topCompanies, (p) => {
      if (p.done % 50 === 0) log(`  inflection ${p.done}/${p.total}`);
    });
    const foldedMap = new Map(folded.map((c) => [c.ticker, c]));
    let withInflection = 0;
    enriched = enriched.map((c) => {
      const f = foldedMap.get(c.ticker);
      if (f && (f.inflection || f.revenueTTM != null)) {
        withInflection++;
        return f;
      }
      return c;
    });
    log(`  inflection: real quarterly inputs folded into ${withInflection}/${topCompanies.length} names.`);
    // Re-score now that the inflection inputs are present (pure + cheap).
    scored = enriched
      .map((c) => toStockSignal(c, scoreCompany(c), generatedAt))
      .sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);
  }

  // 6b. ANALYST PRIME-DIRECTIVE INVARIANT. `toStockSignal` seeds the illustrative
  //     `buildFeedAnalystCoverage` baseline whenever `isSampleDataModeEnabled()`
  //     is true - and in this headless Node job it fails closed to TRUE (no
  //     operator-controls cache), so EVERY signal would otherwise ship a
  //     `status: "sample"` / "Sample consensus" coverage into the public
  //     daily_signals cache, where live-mode clients render it under a "Live
  //     data" badge. This trusted scan publishes REAL data, so strip any
  //     sample-origin analyst coverage before upload (sampleMode=false). Real
  //     analyst coverage (if a vendor key ever fills it) passes through untouched;
  //     stripped names re-enrich client-side to honest links-only.
  const beforeAnalyst = scored.filter((s) => s.analyst != null).length;
  const cleaned = sanitizeSignalsAnalyst(scored, false);
  const afterAnalyst = cleaned.filter((s) => s.analyst != null).length;
  log(
    `Analyst honesty invariant: stripped sample-origin analyst coverage from ` +
      `${beforeAnalyst - afterAnalyst}/${cleaned.length} signal(s) before publish.`,
  );

  // 6c. V3 - rank the PUBLISHED feed by the live CHAMPION normalization (INFLECTION_V2),
  //     NOT the flat scoreCompany average. The champion is what actually weighs EVERY
  //     catalyst type (the catalystStrength tilt: earnings, partnerships, FDA/M&A,
  //     guidance, contracts, analyst, insider/CEO buys, political) PLUS the discount/
  //     entry tilt, cap-cohort weighting, and the inflection/growth/momentum/hype dims -
  //     so a reader's feed finally reflects ALL of them instead of catalysts at a flat
  //     0.15 weight. postProcessUniverse recomputes opportunityScore from the preserved
  //     raw per-category scores (idempotent) and re-sorts. (Fixes catalyzed-feed-not-
  //     running-v2: the published board was scoreCompany, never the champion.)
  // FLOOR: drop sub-$50M-cap junk (HCTI etc.) before ranking/publishing. Keep names
  // with an unknown cap (0) - those are gated by the $2 price + $-volume floors already.
  const capFloored = cleaned.filter((s) => !(s.marketCap > 0) || s.marketCap >= MIN_MARKET_CAP);
  log(
    `Market-cap floor ($${(MIN_MARKET_CAP / 1e6).toFixed(0)}M): ${cleaned.length} → ${capFloored.length} ` +
      `(dropped ${cleaned.length - capFloored.length} sub-cap name(s)).`,
  );
  log("Computing market regime once (SPY vs 200-DMA + universe breadth + fear/greed)...");
  const spyCloses = await fetchDailyBars("SPY", 260);
  // Live CNN Fear & Greed (P9): best-effort, never a dependency - the internal
  // composite in engine/regime.ts is the always-available fallback. Unofficial
  // endpoint, so any failure/shape-change degrades silently to "internal".
  const externalFearGreed = await (async (): Promise<number | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (catalyzed-scan)" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = (await res.json()) as { fear_and_greed?: { score?: number } };
      const score = json?.fear_and_greed?.score;
      return typeof score === "number" && Number.isFinite(score) ? score : null;
    } catch {
      return null;
    }
  })();
  const normalizationContext = {
    archetypes: buildArchetypeContext(capFloored),
    regime: buildMarketRegimeContext({ spyCloses, signals: capFloored, externalFearGreed }),
  };
  log(
    `Market regime: ${normalizationContext.regime.label ?? "neutral"} ` +
      `(riskOffness ${(normalizationContext.regime.riskOffness ?? 0).toFixed(2)}, ` +
      `fear/greed ${normalizationContext.regime.fearGreed ?? "n/a"} ` +
      `[${normalizationContext.regime.fearGreedLabel ?? "n/a"}, ${normalizationContext.regime.fearGreedSource ?? "n/a"}]) - ` +
      `${normalizationContext.regime.reason ?? "no regime detail"}`,
  );
  // Rank the PUBLISHED board with the variant the operator has actually promoted,
  // read from the same `app_controls.active_variant` row the app reads. This used
  // to be hardcoded to "champion" while the live app ran the challenger, so the
  // stored `opportunityScore` in daily_signals disagreed with what every client
  // rendered after its own re-rank - and any surface that reads the stored number
  // directly showed a score from a model nobody was running.
  await initGlobalControls().catch(() => undefined);
  const publishVariant = getGlobalControls()?.activeVariant ?? getActiveVariant();
  const signals = postProcessUniverse(capFloored, publishVariant, normalizationContext);
  log(
    `Scored ${signals.length} signals (ranked with the live variant: ${publishVariant}). ` +
      `Top: ${signals.slice(0, 8).map((s) => `${s.ticker} ${s.score.opportunityScore}`).join(", ")}`,
  );

  // Cap-cohort + catalyst-fold telemetry (the owner's small/mid-cap representation ask).
  // Measured on the PUBLISHED set so we can prove the mix shifted, not just claim it.
  const capOf = new Map(enriched.map((c) => [c.ticker, c.marketCap]));
  const tier = (cap: number): "micro" | "small" | "mid" | "large" | "mega" =>
    cap >= 200e9 ? "mega" : cap >= 10e9 ? "large" : cap >= 3e9 ? "mid" : cap >= 3e8 ? "small" : "micro";
  const cohort = { micro: 0, small: 0, mid: 0, large: 0, mega: 0 };
  for (const s of signals) cohort[tier(capOf.get(s.ticker) ?? 0)]++;
  const n = Math.max(1, signals.length);
  const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`;
  const smallMid = cohort.micro + cohort.small + cohort.mid;
  const largeMega = cohort.large + cohort.mega;
  // Count names carrying a REAL catalyst signal - a structured catalyst OR disclosed
  // insider activity (the fold writes both `catalyst` and `secActivity`).
  const withCatalyst = enriched.filter(
    (c) =>
      isRealCatalyst(c.catalyst) ||
      (c.secActivity != null && (c.secActivity.form4Count90d > 0 || c.secActivity.eightKCount90d > 0)),
  ).length;
  log(
    `Cap mix (published ${signals.length}): micro+small ${pct(cohort.micro + cohort.small)} · mid ${pct(cohort.mid)} · large ${pct(cohort.large)} · mega ${pct(cohort.mega)} ` +
      `→ small/mid ${pct(smallMid)} vs large/mega ${pct(largeMega)}. Names with a catalyst/insider signal: ${withCatalyst}/${signals.length}.`,
  );

  // Catalyst-breakdown telemetry (coverage fix, 2026-07-02): split the real-catalyst
  // count by source so a future scan makes it obvious whether earnings coverage is
  // actually flowing, vs. only real structured events (8-K/insider/13D/FDA/etc.).
  const earningsCatalystCount = enriched.filter(
    (c) => isRealCatalyst(c.catalyst) && c.catalyst.type === "Earnings",
  ).length;
  const realEventCatalystCount = enriched.filter(
    (c) => isRealCatalyst(c.catalyst) && c.catalyst.type !== "Earnings",
  ).length;
  log(
    `Catalyst breakdown (scored ${enriched.length}): ${earningsCatalystCount} earnings · ` +
      `${realEventCatalystCount} real events (8-K/insider/13D/FDA/etc.) · ${enriched.length} total scored.`,
  );

  // 7. Synthesize the run + publish.
  const discoverySummary = `${symbols.length} US listings → ${ranked.gatedCount} liquid → top ${signals.length} scored`;
  const run: ResearchRun = {
    id: `scan_${generatedAt.slice(0, 10)}`,
    startedAt: new Date(t0).toISOString(),
    finishedAt: generatedAt,
    durationMs: Date.now() - t0,
    provider: "Scheduled broad-universe scan",
    universeSize: symbols.length,
    signalsGenerated: signals.length,
    trigger: "scheduled",
    status: "complete",
    stages: [],
    discoverySummary,
  };

  // The evidence was sealed and locally verified before enrichment. Retry a
  // transient local failure once here, then defer only remote persistence until
  // signal values/order/scores and the run are fixed.
  if (learningArchiveEnvelope) {
    const locallyVerifiedEnvelope = await persistLearningArchiveLocally();
    if (!DRY_RUN && locallyVerifiedEnvelope) {
      try {
        const remote = await uploadLearningUniverseArtifact(locallyVerifiedEnvelope);
        learningArchive.remoteStatus = remote.status;
        log(`Learning-universe archive ${learningArchive.localStatus}; ${remote.status}.`);
      } catch {
        learningArchive.remoteStatus = "remote_failed";
        log("WARN: learning-universe remote archive failed; verified local artifact retained.");
      }
    }
  }

  if (DRY_RUN) {
    log("DRY RUN — not publishing. Top 20:");
    for (const s of signals.slice(0, 20)) {
      log(`   ${s.ticker.padEnd(6)} ${String(s.score.opportunityScore).padStart(3)}  $${s.price}  ${s.name}`);
    }
    return;
  }

  // Persist BEFORE publishing so a transient upload failure never costs the
  // (expensive) compute - publish.mjs can push the saved file from plain node.
  // Persist the scan's market-regime read (incl. the fear & greed value that scored
  // this board) in the shared meta so the CLIENT can render the panic-mode banner
  // from the same numbers the ranking actually used - no client-side re-derivation.
  const regimeMeta = {
    riskOffness: normalizationContext.regime.riskOffness ?? 0,
    label: normalizationContext.regime.label ?? "neutral",
    fearGreed: normalizationContext.regime.fearGreed,
    fearGreedLabel: normalizationContext.regime.fearGreedLabel,
    fearGreedSource: normalizationContext.regime.fearGreedSource,
    reason: normalizationContext.regime.reason,
  };
  const scanMeta = {
    funnel: discoverySummary,
    regime: regimeMeta,
    learningArchive,
  };
  const outFile = join(SCRIPT_DIR, "last-scan.json");
  writeFileSync(outFile, JSON.stringify({ signals, run, meta: scanMeta }));
  log(`Saved ${signals.length} signals → ${outFile}`);

  try {
    const result = await uploadDailySignals(signals, run, scanMeta);
    log(`Published ${result.count} signals to daily_signals for ${result.day}. ✅`);
  } catch (err) {
    log(`Upload failed: ${err instanceof Error ? err.message : err}`);
    log("Recover without recomputing: node scripts/universe_scan/publish.mjs");
    throw err;
  }

  await reportScanUsage(log).catch(() => {});
}

main()
  .then(() => {
    log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Scan failed:", err);
    process.exit(1);
  });
