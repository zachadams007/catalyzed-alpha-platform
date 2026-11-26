// IMPORTANT: bootstrap MUST be the first import - it installs the Node
// localStorage/window shims and seeds sample-mode OFF + budgets OFF before any
// `@/` module reads them at load time.
import "../universe_scan/bootstrap.mjs";

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompanyData, ScoreBreakdown, ScoreCategoryKey, Sector, StockSignal } from "@/types";
import { isAlpacaConfigured } from "@/data/http";
import { fetchAlpacaBarsForSymbols, applyAlpacaBarsToCompany } from "@/data/alpaca/bars";
import type { DailyBars } from "@/data/alpaca/bars";
import { MARKET_MAJORS } from "@/data/symbols/majors.generated";
import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import {
  buildArchetypeContext,
  computeNormalizedScores,
  INFLECTION_V2_NORMALIZATION,
  type NormalizationContext,
} from "@/engine/normalizeUniverse";
import { CATEGORY_CONFIG } from "@/engine/scoringConfig";
import { buildMarketRegimeContext } from "@/engine/regime";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  unknownFundamentals,
  allFalseFundamentalsAvailability,
} from "@/data/fundamentals/fundamentalsProvenance";
import { noCatalyst } from "@/data/catalysts/catalystState";
import { clamp, round } from "@/lib/math";

import {
  barsAsOf,
  forwardReturnOffset,
  roundRet,
} from "./replayCore";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_SYMBOLS = [
  // V4 winner-study growth / compounder / reversal examples
  "NVDA", "AVGO", "APP", "AXON", "DUOL", "CRWD", "PLTR", "HOOD", "SOFI",
  "DELL", "AMD", "INTC", "META", "GOOGL", "MSFT", "AMZN", "TSLA", "CVNA",
  "SMCI", "POWL", "AEHR", "SOUN", "RKLB", "IONQ", "ASTS", "LUNR", "ACHR",
  "MRNA", "CRSP", "NTLA", "BEAM", "MARA", "RIOT", "CLSK", "COIN", "ARM",
  "MRVL", "MU", "SNOW", "NET", "DDOG", "SHOP", "RBLX", "U",
  // Bear/correction winners and quality/low-vol contrasts
  "OXY", "XOM", "CVX", "MRO", "VLO", "MPC", "CCJ", "NEE", "SO", "DUK",
  "MCD", "WMT", "DG", "COST", "KO", "PG", "PEP", "ABBV", "MRK", "JNJ",
  "PFE", "UNH", "NEM", "AEM", "LMT", "NOC", "JPM", "BAC", "C", "CAT",
  // Current broad-board / the owner watchlist style names
  "CEG", "VST", "TLN", "BWXT", "GFS", "APLD", "QBTS", "QUBT", "OKLO",
  "AMBA", "NOK", "NOW", "IBM", "HON", "OBDC", "HUMA", "SERV", "NBIS",
];

const WINDOWS = [
  { id: "2018-Q4", regime: "bear/correction", start: "2018-10-01", end: "2018-12-31" },
  { id: "2020-Q1", regime: "bear/correction", start: "2020-01-02", end: "2020-03-31" },
  { id: "2020-H2", regime: "bull", start: "2020-07-01", end: "2020-12-31" },
  { id: "2022", regime: "bear/correction", start: "2022-01-03", end: "2022-12-30" },
  { id: "2023-24", regime: "bull", start: "2023-01-03", end: "2024-12-31" },
] as const;

const BACKTEST_SYMBOLS_RAW = process.env["BACKTEST_SYMBOLS"] ?? "";
const SYMBOLS: string[] = uniqueUpper(
  BACKTEST_SYMBOLS_RAW.trim()
    ? BACKTEST_SYMBOLS_RAW.split(",")
    : DEFAULT_SYMBOLS,
).filter((ticker) => ticker !== "SPY");

const TOP_N = intEnv("BACKTEST_TOP_N", 10);
const FORWARD_DAYS = intEnv("BACKTEST_FORWARD_DAYS", 21);
const REBALANCE_DAYS = intEnv("BACKTEST_REBALANCE_DAYS", 21);
const MIN_BARS_AT_T = intEnv("BACKTEST_MIN_BARS_AT_T", 200);
const BACKTEST_LIMIT = intEnv("BACKTEST_LIMIT", 2600);
const BACKTEST_START = process.env["BACKTEST_START"] ?? "2018-01-01";
const BACKTEST_CONCURRENCY = intEnv("BACKTEST_CONCURRENCY", 5);

const PRICE_REPLAY_KEYS: ReadonlySet<ScoreCategoryKey> = new Set([
  "momentum",
  "valuation",
  "volatility",
]);

const MAJOR_BY_TICKER = new Map(MARKET_MAJORS.map((m) => [m.ticker.toUpperCase(), m]));

// ---------------------------------------------------------------------------
// Logging / env helpers
// ---------------------------------------------------------------------------

const t0 = Date.now();
function log(msg: string): void {
  const secs = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, " ");
  console.log(`[+${secs}s] ${msg}`);
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function uniqueUpper(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const ticker = raw.trim().toUpperCase();
    if (!ticker || seen.has(ticker) || !/^[A-Z][A-Z.]{0,6}$/.test(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Point-in-time company construction
// ---------------------------------------------------------------------------

function neutralReplayBreakdown(breakdown: ScoreBreakdown): ScoreBreakdown {
  const categories = breakdown.categories.map((cat) => {
    if (PRICE_REPLAY_KEYS.has(cat.key)) return cat;
    return {
      ...cat,
      score: 50,
      contribution: round(50 * cat.weight, 1),
      explanation: "Point-in-time replay: historical input unavailable on the free feed; held neutral.",
    };
  });
  const blended = CATEGORY_CONFIG.reduce((sum, cfg) => {
    const score = categories.find((cat) => cat.key === cfg.key)?.score ?? 50;
    return sum + score * cfg.weight;
  }, 0);
  return {
    ...breakdown,
    categories,
    opportunityScore: clamp(round(blended - breakdown.riskPenalty), 0, 100),
  };
}

function pctChange(closes: readonly number[], lookback: number): number {
  if (closes.length <= lookback) return 0;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - lookback]!;
  return then > 0 ? (now - then) / then : 0;
}

function buildCompanyAtT(
  ticker: string,
  barsSlice: DailyBars,
  marketReturn3M: number,
): CompanyData {
  const last = barsSlice.closes[barsSlice.closes.length - 1] ?? 0;
  const synthetic = buildSyntheticCompany(ticker);
  const major = MAJOR_BY_TICKER.get(ticker);

  const seed: CompanyData = {
    ...synthetic,
    name: major?.name ?? synthetic.name.replace(" (sample)", ""),
    sector: (major?.sector ?? synthetic.sector) as Sector,
    marketCap: major?.marketCap ?? synthetic.marketCap,
    price: last,
    dayChange: 0,
    fundamentals: unknownFundamentals(),
    fundamentalsAvailability: allFalseFundamentalsAvailability(),
    catalyst: noCatalyst(),
    catalystLive: false,
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 168 },
    social: {
      redditMentions24h: 0,
      xMentions24h: 0,
      politicalMentions: 0,
      sentiment: 0,
      trendDelta: 0,
      summary: "No point-in-time social history in replay.",
    },
    socialPosts: [],
    liquidity: { avgDollarVolume: 10_000_000, floatShares: 100_000_000 },
    risk: {
      shortInterestPct: 0,
      dilutionRisk: 0,
      cashRunwayQuarters: 12,
      governanceFlag: 0,
    },
    sources: [],
    revenueTTM: undefined,
    inflection: undefined,
    pipeline: undefined,
    valuation: undefined,
    strategicCapital: undefined,
    secActivity: undefined,
  };

  return applyAlpacaBarsToCompany(seed, barsSlice, marketReturn3M);
}

// ---------------------------------------------------------------------------
// Return math
// ---------------------------------------------------------------------------

interface BacktestWindow {
  id: string;
  regime: "bull" | "bear/correction";
  start: string;
  end: string;
}

interface PickResult {
  ticker: string;
  score: number;
  forwardReturn: number;
}

interface PeriodResult {
  windowId: string;
  regime: BacktestWindow["regime"];
  asOf: string;
  riskOffness: number;
  picks: PickResult[];
  basketReturn: number;
  spyReturn: number;
  rankIC: number | null;
}

interface WindowSummary {
  id: string;
  regime: string;
  periods: number;
  cagr: number | null;
  spyCagr: number | null;
  excessCagr: number | null;
  totalReturn: number | null;
  spyTotalReturn: number | null;
  hitRate: number | null;
  maxDrawdown: number | null;
  rankIC: number | null;
  note: string;
}

function rebalanceDatesInWindow(
  spyBars: DailyBars,
  window: BacktestWindow,
): string[] {
  const dates: string[] = [];
  let lastIndex = -REBALANCE_DAYS;
  for (let i = 0; i < spyBars.series.length; i++) {
    const date = spyBars.series[i]!.date;
    if (date < window.start || date > window.end) continue;
    if (i < MIN_BARS_AT_T) continue;
    if (i + FORWARD_DAYS >= spyBars.series.length) continue;
    if (i - lastIndex < REBALANCE_DAYS) continue;
    dates.push(date);
    lastIndex = i;
  }
  return dates;
}

function rankValues(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i + 1;
    while (j < order.length && order[j]!.value === order[i]!.value) j++;
    const rank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[order[k]!.index] = rank;
    i = j;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

function spearmanRankIC(rows: Array<{ score: number; forwardReturn: number }>): number | null {
  const finite = rows.filter((row) => Number.isFinite(row.score) && Number.isFinite(row.forwardReturn));
  if (finite.length < 5) return null;
  return pearson(rankValues(finite.map((row) => row.score)), rankValues(finite.map((row) => row.forwardReturn)));
}

function maxDrawdown(returns: readonly number[]): number | null {
  if (returns.length === 0) return null;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const ret of returns) {
    equity *= 1 + ret;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity / peak - 1);
  }
  return maxDd;
}

function compoundReturn(returns: readonly number[]): number {
  return returns.reduce((equity, ret) => equity * (1 + ret), 1) - 1;
}

function cagrFromPeriodReturns(returns: readonly number[]): number | null {
  if (returns.length === 0) return null;
  const total = compoundReturn(returns);
  const years = (returns.length * FORWARD_DAYS) / 252;
  if (years <= 0 || total <= -1) return null;
  return (1 + total) ** (1 / years) - 1;
}

function summarizeWindow(id: string, regime: string, periods: PeriodResult[], note = ""): WindowSummary {
  if (periods.length === 0) {
    return {
      id,
      regime,
      periods: 0,
      cagr: null,
      spyCagr: null,
      excessCagr: null,
      totalReturn: null,
      spyTotalReturn: null,
      hitRate: null,
      maxDrawdown: null,
      rankIC: null,
      note: note || "Unavailable in fetched Alpaca history.",
    };
  }

  const basketReturns = periods.map((p) => p.basketReturn);
  const spyReturns = periods.map((p) => p.spyReturn);
  const cagr = cagrFromPeriodReturns(basketReturns);
  const spyCagr = cagrFromPeriodReturns(spyReturns);
  const rankICs = periods.map((p) => p.rankIC).filter((v): v is number => v != null && Number.isFinite(v));

  return {
    id,
    regime,
    periods: periods.length,
    cagr,
    spyCagr,
    excessCagr: cagr != null && spyCagr != null ? cagr - spyCagr : null,
    totalReturn: compoundReturn(basketReturns),
    spyTotalReturn: compoundReturn(spyReturns),
    hitRate: periods.filter((p) => p.basketReturn > p.spyReturn).length / periods.length,
    maxDrawdown: maxDrawdown(basketReturns),
    rankIC: rankICs.length > 0 ? rankICs.reduce((a, b) => a + b, 0) / rankICs.length : null,
    note,
  };
}

// ---------------------------------------------------------------------------
// Main replay
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Catalyzed Alpha V4 - return-vs-SPY replay");
  log(`Symbols: ${SYMBOLS.length}; topN=${TOP_N}; forward=${FORWARD_DAYS} trading days; rebalance=${REBALANCE_DAYS} trading days`);
  log(`Requested history: start=${BACKTEST_START}, limit=${BACKTEST_LIMIT}`);

  if (!isAlpacaConfigured()) {
    console.log(
      "\nAlpaca not configured - set VITE_ALPACA_API_KEY / VITE_ALPACA_SECRET to run the price backtest.\n" +
        "The no-leak unit test (scripts/backtest/__tests__/noLeak.test.ts) still passes offline.\n",
    );
    process.exit(0);
  }

  const requested = uniqueUpper([...SYMBOLS, "SPY"]);
  log(`Fetching Alpaca daily bars for ${requested.length} symbols...`);
  const fullBars = await fetchAlpacaBarsForSymbols(requested, {
    concurrency: BACKTEST_CONCURRENCY,
    limit: BACKTEST_LIMIT,
    start: BACKTEST_START,
    onProgress: (done, total) => {
      if (done % 10 === 0 || done === total) log(`  bars: ${done}/${total}`);
    },
  });

  const spyBars = fullBars["SPY"];
  if (!spyBars) {
    throw new Error("SPY bars were not returned; cannot benchmark against SPY.");
  }

  const fetchedSymbols = SYMBOLS.filter((ticker) => fullBars[ticker]);
  const dataStart = spyBars.series[0]?.date ?? "?";
  const dataEnd = spyBars.series[spyBars.series.length - 1]?.date ?? "?";
  log(`Bars received for ${fetchedSymbols.length}/${SYMBOLS.length} universe symbols. SPY window: ${dataStart} -> ${dataEnd}.`);

  const allPeriods: PeriodResult[] = [];
  const summaries: WindowSummary[] = [];

  for (const window of WINDOWS) {
    const dates = rebalanceDatesInWindow(spyBars, window);
    if (dates.length === 0) {
      summaries.push(summarizeWindow(window.id, window.regime, [], `No eligible rebalance dates in fetched SPY window (${dataStart} -> ${dataEnd}).`));
      continue;
    }

    const windowPeriods: PeriodResult[] = [];
    for (const asOf of dates) {
      const spySlice = barsAsOf(spyBars, asOf, MIN_BARS_AT_T);
      const spyReturn = forwardReturnOffset(spyBars, asOf, FORWARD_DAYS);
      if (!spySlice || spyReturn == null) continue;

      const marketReturn3M = pctChange(spySlice.closes, 63);
      const cohortSignals: StockSignal[] = [];
      const returnsByTicker = new Map<string, number>();

      for (const ticker of fetchedSymbols) {
        const bars = fullBars[ticker]!;
        const slice = barsAsOf(bars, asOf, MIN_BARS_AT_T);
        const forwardReturn = forwardReturnOffset(bars, asOf, FORWARD_DAYS);
        if (!slice || forwardReturn == null) continue;

        const company = buildCompanyAtT(ticker, slice, marketReturn3M);
        const scored = neutralReplayBreakdown(scoreCompany(company));
        cohortSignals.push(toStockSignal(company, scored, `${asOf}T00:00:00.000Z`));
        returnsByTicker.set(ticker, forwardReturn);
      }

      if (cohortSignals.length < Math.max(TOP_N, 8)) continue;

      const ctx: NormalizationContext = {
        archetypes: buildArchetypeContext(cohortSignals),
        regime: buildMarketRegimeContext({ spyCloses: spySlice.closes, signals: cohortSignals }),
      };
      const normalized = computeNormalizedScores(cohortSignals, ctx, INFLECTION_V2_NORMALIZATION);
      const rows = normalized
        .map((score) => ({
          ticker: score.ticker,
          score: score.opportunityScore,
          forwardReturn: returnsByTicker.get(score.ticker),
        }))
        .filter((row): row is { ticker: string; score: number; forwardReturn: number } => row.forwardReturn != null);

      const ranked = [...rows].sort((a, b) => b.score - a.score);
      const picks = ranked.slice(0, TOP_N).map((row) => ({
        ticker: row.ticker,
        score: row.score,
        forwardReturn: roundRet(row.forwardReturn),
      }));
      if (picks.length === 0) continue;

      const basketReturn = picks.reduce((sum, pick) => sum + pick.forwardReturn, 0) / picks.length;
      windowPeriods.push({
        windowId: window.id,
        regime: window.regime,
        asOf,
        riskOffness: ctx.regime?.riskOffness ?? 0,
        picks,
        basketReturn: roundRet(basketReturn),
        spyReturn: roundRet(spyReturn),
        rankIC: spearmanRankIC(rows),
      });
    }

    allPeriods.push(...windowPeriods);
    summaries.push(summarizeWindow(window.id, window.regime, windowPeriods));
    log(`${window.id}: ${windowPeriods.length} rebalance period(s).`);
  }

  const bull = summarizeWindow("BULL aggregate", "bull", allPeriods.filter((p) => p.regime === "bull"));
  const bear = summarizeWindow("BEAR aggregate", "bear/correction", allPeriods.filter((p) => p.regime === "bear/correction"));
  const aggregateSummaries = [bull, bear];
  const beatsBoth =
    (bull.excessCagr ?? Number.NEGATIVE_INFINITY) > 0 &&
    (bear.excessCagr ?? Number.NEGATIVE_INFINITY) > 0;

  const stamp =
    process.env["BACKTEST_STAMP"] ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const report = buildReport({
    stamp,
    symbols: SYMBOLS,
    fetchedSymbols,
    dataStart,
    dataEnd,
    summaries,
    aggregateSummaries,
    allPeriods,
    beatsBoth,
  });

  console.log("\n" + report);
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../catalyzed-research");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `backtest-report-${stamp}.md`);
  writeFileSync(outPath, report, "utf8");
  log(`Report written to ${outPath}`);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return `${(v * 100).toFixed(digits)}%`;
}

function num(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  return v.toFixed(digits);
}

function summaryRow(s: WindowSummary): string {
  return `| ${s.id} | ${s.regime} | ${s.periods} | ${pct(s.cagr)} | ${pct(s.spyCagr)} | ${pct(s.excessCagr)} | ${pct(s.totalReturn)} | ${pct(s.spyTotalReturn)} | ${pct(s.hitRate)} | ${pct(s.maxDrawdown)} | ${num(s.rankIC)} | ${s.note || ""} |`;
}

function picksSample(periods: PeriodResult[], limit = 6): string {
  const chosen = [...periods]
    .sort((a, b) => a.asOf.localeCompare(b.asOf))
    .filter((p) => p.picks.length > 0)
    .slice(-limit);
  if (chosen.length === 0) return "_No eligible periods._";
  return chosen
    .map((period) => {
      const picks = period.picks
        .slice(0, 10)
        .map((pick) => `${pick.ticker} ${pick.score}/${pct(pick.forwardReturn, 1)}`)
        .join(", ");
      return `- ${period.windowId} ${period.asOf} (riskOff ${period.riskOffness.toFixed(2)}): ${picks}; basket ${pct(period.basketReturn)}, SPY ${pct(period.spyReturn)}`;
    })
    .join("\n");
}

interface BuildReportArgs {
  stamp: string;
  symbols: string[];
  fetchedSymbols: string[];
  dataStart: string;
  dataEnd: string;
  summaries: WindowSummary[];
  aggregateSummaries: WindowSummary[];
  allPeriods: PeriodResult[];
  beatsBoth: boolean;
}

function buildReport(a: BuildReportArgs): string {
  return `# Catalyzed Alpha V4 - Return-vs-SPY Backtest

Generated: ${a.stamp}

## Run Parameters
- Universe requested: ${a.symbols.length} current tickers (${a.fetchedSymbols.length} returned bars)
- Benchmark: SPY
- Fetched SPY window: ${a.dataStart} -> ${a.dataEnd}
- Requested history start: ${BACKTEST_START}; Alpaca limit: ${BACKTEST_LIMIT} daily bars
- Rebalance: every ${REBALANCE_DAYS} trading days; forward return: ${FORWARD_DAYS} trading days; basket: equal-weight top ${TOP_N}
- V4 context: archetype flags + market regime computed from point-in-time slices only

## Honest Data Note
This is a free-data replay, not an institutional CRSP/Compustat backtest. Alpaca returned the available daily-bar window above; any requested regime window outside it is marked unavailable. Fundamentals, catalysts, filings, estimates, and valuation-history cannot be reconstructed point-in-time for $0, so the replay holds those dimensions neutral at 50 and ranks on point-in-time price-derived dimensions plus V4 cohort/archetype/regime routing. The universe is the current requested ticker set, so delisted-name survivorship bias remains.

## Aggregate By Regime
| Regime | Type | Periods | CAGR | SPY CAGR | Excess CAGR vs SPY | Total Return | SPY Total Return | Hit Rate vs SPY | Max Drawdown | Rank-IC | Note |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${a.aggregateSummaries.map(summaryRow).join("\n")}

V4 ${a.beatsBoth ? "beat SPY in both available bull and bear/correction aggregates." : "did not beat SPY in both available aggregates on this free-data replay."}

## Window Results
| Window | Regime | Periods | CAGR | SPY CAGR | Excess CAGR vs SPY | Total Return | SPY Total Return | Hit Rate vs SPY | Max Drawdown | Rank-IC | Note |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${a.summaries.map(summaryRow).join("\n")}

## Recent Period Pick Samples
Score/forward-return for the top names selected in the latest eligible periods:

${picksSample(a.allPeriods)}

## Bear/Correction Pick Samples

${picksSample(a.allPeriods.filter((period) => period.regime === "bear/correction"), 24)}

## Bull Pick Samples

${picksSample(a.allPeriods.filter((period) => period.regime === "bull"))}
`;
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
