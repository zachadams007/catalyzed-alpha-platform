// IMPORTANT: bootstrap MUST be the first import (see refinement_report.mts).
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";
import type { StockSignal } from "@/types";
import { fetchRecentSharedSignals, type SharedDailySignals } from "@/data/dailySignalsCache";
import { fetchXbrlPipelineByTicker } from "@/data/sec/xbrlPipeline";
import { computeOwnHistoryValuation } from "@/engine/valuationHistory";
import { scoreCompany } from "@/engine/scoring";
import { withdrawContradictoryFundamentals } from "@/data/fundamentals/publishInvariant";
import { toStockSignal } from "@/engine/enrich";
import { postProcessUniverse, type EngineVariantId } from "@/engine/challenger";
import {
  buildArchetypeContext,
  computeNormalizedScores,
  inferArchetypeFlags,
  INFLECTION_V2_NORMALIZATION,
  MISUNDERSTOOD_V6_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
  SYNTHESIS_V7_NORMALIZATION,
  type NormalizationContext,
} from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import { isAlpacaConfigured } from "@/data/http";
import { fetchAlpacaBarsForSymbols, fetchDailyBars, realizedBeta } from "@/data/alpaca/bars";
import {
  computeInflectionInputs,
  enrichTopNWithInflection,
  fetchQuarterlyMetrics,
  type QuarterlyMetrics,
} from "@/data/fundamentals/enrichInflection";
import { pooledMap } from "@/lib/concurrency";
import { fetchFinnhubEarningsCalendarMap } from "@/data/earnings/earningsCalendar";
import { applyEarningsToCompany } from "@/data/earnings/enrichCompanyEarnings";
import { loadCikIndex, USER_AGENT as SEC_USER_AGENT } from "@/data/sec/secFilings";
import { httpJson } from "@/data/http";
import {
  unknownRisk,
  unknownSocial,
  unknownVolatility,
} from "@/data/fundamentals/unknownNonFundamentals";

/**
 * scripts/diag_v6_ab.mts - A/B the LIVE V5 engine against the V6
 * misunderstood-quality engine on the SAME published board.
 *
 * V6 depends on SEC XBRL forward-pipeline inputs that the currently-published
 * board predates, so this script folds those disclosed figures in and RE-SCORES
 * before ranking - i.e. it simulates exactly what tomorrow's scan will publish
 * once `scan.mts`'s pipeline fold has run. Both arms see the identical enriched
 * universe, so the only difference measured is the model.
 *
 * READ-ONLY: never writes to Supabase, never promotes a variant.
 *
 *   vite-node scripts/diag_v6_ab.mts
 */

const TOP_N = 20;
/**
 * POINT-IN-TIME REPLAY. Set BOARD_DAY=YYYY-MM-DD to load THAT day's published
 * board instead of the latest, and to hold every other input to what was
 * public on that day:
 *   - the board's own price / priceHistory / momentum / fundamentals are already
 *     point-in-time (they were published that morning);
 *   - long price histories and SPY closes are truncated at BOARD_DAY;
 *   - SEC annual frames (revenue / net income by year) keep only fiscal years
 *     that ended before BOARD_DAY's year (their 10-Ks were filed months earlier);
 *   - quarterly order-book figures (RPO / contract liabilities) are DROPPED when
 *     their period end is within FILING_LAG_DAYS of BOARD_DAY, because a 10-Q
 *     for a quarter ending 06-30 is not public until ~late July / August.
 * This is a reconstruction, not a recording: the daily scan did not fold XBRL
 * data in July, so "what V7 would have shown" means "V7 over the inputs it
 * would have had if the XBRL fold had existed then" - stated as such.
 */
const BOARD_DAY = (process.env["BOARD_DAY"] ?? "").trim() || null;
const FILING_LAG_DAYS = 45;
/**
 * REFRESH_INFLECTION=1 re-derives every name's quarterly inflection inputs from
 * Finnhub instead of trusting the figures stored on the published board. Needed
 * whenever `computeInflectionInputs` changes (the board carries the OLD formula's
 * numbers) - e.g. the seasonally matched revAccelQoQ. Under BOARD_DAY the series
 * are censored to quarters public by then (period end ≥ FILING_LAG_DAYS before).
 */
const REFRESH_INFLECTION = (process.env["REFRESH_INFLECTION"] ?? "").trim() === "1";
/**
 * REFRESH_EARNINGS=1 wires the scheduled-earnings calendar (Finnhub bulk) into
 * every name exactly as tomorrow's scan will, so the catalyst dimension and the
 * graduated readiness relief can be measured. Under BOARD_DAY the window starts
 * on the board day (report dates are announced weeks ahead, so this is the
 * calendar a scan on that morning would have had).
 */
const REFRESH_EARNINGS = (process.env["REFRESH_EARNINGS"] ?? "").trim() === "1";
const VALUATION_HISTORY_TOP_N = 120;
const ownHistory = new Map<string, ReturnType<typeof computeOwnHistoryValuation>>();

async function fetchBoardDirect(): Promise<SharedDailySignals | null> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon = process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return null;
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("daily_signals")
    .select("market_day, signals, run, computed_at, meta")
    .order("market_day", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    marketDay: data.market_day,
    signals: data.signals as StockSignal[],
    run: data.run,
    computedAt: data.computed_at,
    meta: data.meta,
  } as SharedDailySignals;
}

async function fetchBoardForDay(day: string): Promise<SharedDailySignals | null> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon = process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return null;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client
    .from("daily_signals")
    .select("market_day, signals, run, computed_at, meta")
    .eq("market_day", day)
    .maybeSingle();
  if (error || !data) return null;
  return {
    marketDay: data.market_day,
    signals: data.signals as StockSignal[],
    run: data.run,
    computedAt: data.computed_at,
    meta: data.meta,
  } as SharedDailySignals;
}

/** Closes on/before `day` only - never a bar the replay could not have seen. */
async function closesUpTo(symbol: string, limit: number, day: string | null): Promise<number[]> {
  if (!day) return fetchDailyBars(symbol, limit).catch(() => [] as number[]);
  const out = await fetchAlpacaBarsForSymbols([symbol], { limit, end: day, concurrency: 1 }).catch(() => ({}));
  const series = out[symbol]?.series ?? [];
  return series.filter((p) => p.date <= day).map((p) => p.close);
}

async function buildContext(universe: StockSignal[]): Promise<NormalizationContext> {
  const archetypes = buildArchetypeContext(universe);
  if (!isAlpacaConfigured()) {
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals: universe }) };
  }
  const spyCloses = await closesUpTo("SPY", 260, BOARD_DAY);
  return { archetypes, regime: buildMarketRegimeContext({ spyCloses, signals: universe }) };
}

function rankOf(list: StockSignal[], ticker: string): number {
  return list.findIndex((s) => s.ticker === ticker) + 1;
}

/**
 * Drop every XBRL figure that was NOT yet public on `day`. Annual frames keep
 * fiscal years strictly before the day's year; a quarterly order-book figure is
 * kept only if its period end is at least FILING_LAG_DAYS before the day.
 */
function censorFactsAsOf(
  facts: Map<string, import("@/data/sec/xbrlPipeline").XbrlPipelineFacts>,
  day: string,
): Map<string, import("@/data/sec/xbrlPipeline").XbrlPipelineFacts> {
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  const year = Number(day.slice(0, 4));
  const cutoffMs = dayMs - FILING_LAG_DAYS * 86_400_000;
  const YEAR_MS = 365 * 86_400_000;
  const publicPoints = (series?: Array<{ end: string; val: number }>) =>
    (series ?? []).filter((p) => Date.parse(`${p.end}T00:00:00Z`) <= cutoffMs);
  const yoy = (pts: Array<{ end: string; val: number }>): number | undefined => {
    const latest = pts[pts.length - 1];
    if (!latest) return undefined;
    const target = Date.parse(`${latest.end}T00:00:00Z`) - YEAR_MS;
    let best: { end: string; val: number } | null = null;
    let gap = Number.POSITIVE_INFINITY;
    for (const p of pts.slice(0, -1)) {
      const g = Math.abs(Date.parse(`${p.end}T00:00:00Z`) - target);
      if (g < gap) { gap = g; best = p; }
    }
    if (!best || gap > 100 * 86_400_000 || best.val <= 0) return undefined;
    const r = latest.val / best.val - 1;
    return Number.isFinite(r) && r <= 12 ? r : undefined;
  };

  const out = new Map<string, import("@/data/sec/xbrlPipeline").XbrlPipelineFacts>();
  for (const [t, f] of facts) {
    const g = { ...f };
    // ORDER BOOK: step back to the last point that was public on `day`, and
    // recompute the ratios from it - rather than dropping the whole order book
    // because the NEWEST quarter had not been filed yet.
    const rpo = publicPoints(g.backlogSeries);
    const latest = rpo[rpo.length - 1];
    delete g.backlogToRevTTM; delete g.backlogYoY; delete g.backlogUsd; delete g.backlogAsOf;
    if (latest) {
      g.backlogUsd = latest.val;
      g.backlogAsOf = latest.end;
      if (g.revenueTTM && g.revenueTTM > 0) {
        const ratio = latest.val / g.revenueTTM;
        if (ratio > 0 && ratio <= 60) g.backlogToRevTTM = ratio;
      }
      const r = yoy(rpo);
      if (r != null) g.backlogYoY = r;
    }
    const dr = yoy(publicPoints(g.deferredSeries));
    delete g.deferredRevYoY;
    if (dr != null) g.deferredRevYoY = dr;
    // Annual frames: keep fiscal years strictly before the day's year.
    if (g.revenueByYear) g.revenueByYear = g.revenueByYear.filter((r) => Number(r.period.slice(2, 6)) < year);
    if (g.netIncomeByYear) g.netIncomeByYear = g.netIncomeByYear.filter((r) => Number(r.period.slice(2, 6)) < year);
    if ((g.revenueByYear?.length ?? 0) < 3) delete g.revenueByYear;
    if ((g.netIncomeByYear?.length ?? 0) < 3) delete g.netIncomeByYear;
    out.set(t, g);
  }
  return out;
}

/**
 * Re-derive the quarterly inflection inputs as they were knowable on `day`.
 *
 * Which quarter was public is NOT a fixed lag - Lockheed had reported Q2 a week
 * before 2026-07-29 while Amazon reported the day after - so the board itself is
 * the witness: its stored `opMarginNow` is the operating margin of the newest
 * quarter Finnhub had on the morning of `day`. Locate that value in today's
 * series and cut everything newer. A name the scan never enriched (it folds
 * only the top-N by preliminary score) has no witness and falls back to the
 * FILING_LAG_DAYS censor, which never leaks but can lag an early reporter.
 */
async function refreshInflectionPointInTime(universe: StockSignal[], day: string): Promise<StockSignal[]> {
  const slice = (q: QuarterlyMetrics, from: number): QuarterlyMetrics => ({
    grossMargin: q.grossMargin.slice(from),
    operatingMargin: q.operatingMargin.slice(from),
    salesPerShare: q.salesPerShare.slice(from),
    sgaToSale: q.sgaToSale.slice(from),
    // A live ratio with no history; unknowable in a replay.
    evToSalesTTM: undefined,
  });
  let witnessed = 0;
  let lagged = 0;
  const out = await pooledMap(universe, 6, async (s) => {
    const stored = s.inflection;
    const witness = stored?.opMarginNow;
    if (witness == null || !Number.isFinite(witness)) {
      lagged++;
      const censored = await fetchQuarterlyMetrics(s.ticker, { asOf: day, lagDays: FILING_LAG_DAYS });
      if (!censored) return s;
      return { ...s, inflection: computeInflectionInputs(censored) };
    }
    const raw = await fetchQuarterlyMetrics(s.ticker);
    if (!raw) return s;
    const idx = raw.operatingMargin.findIndex((v) => v != null && Math.abs(v - witness) <= 1e-6 + Math.abs(witness) * 1e-4);
    if (idx < 0) {
      lagged++;
      const censored = await fetchQuarterlyMetrics(s.ticker, { asOf: day, lagDays: FILING_LAG_DAYS });
      if (!censored) return s;
      return { ...s, inflection: computeInflectionInputs(censored) };
    }
    witnessed++;
    return { ...s, inflection: computeInflectionInputs(slice(raw, idx)) };
  });
  console.log(`  quarter located from the board's own inputs for ${witnessed} names; ${lagged} fell back to the ${FILING_LAG_DAYS}-day censor.`);
  return out;
}

interface SecRecentFilings {
  form?: string[];
  filingDate?: string[];
  items?: string[];
}

/** Next 8-K Item 2.02 filing date on/after `day` (and ≤ `to`) per ticker. */
async function earningsFromSecFilings(
  tickers: string[],
  day: string,
  to: string,
): Promise<Map<string, { dateISO: string; epsEstimate: number | null }>> {
  const out = new Map<string, { dateISO: string; epsEstimate: number | null }>();
  const index = await loadCikIndex();
  await pooledMap(tickers, 6, async (ticker) => {
    const cik10 = index.get(ticker.toUpperCase());
    if (!cik10) return;
    try {
      const data = await httpJson<{ filings?: { recent?: SecRecentFilings } }>(
        `https://data.sec.gov/submissions/CIK${cik10}.json`,
        { timeoutMs: 20_000, headers: { "User-Agent": SEC_USER_AGENT } },
      );
      const r = data.filings?.recent;
      if (!r?.form || !r.filingDate) return;
      let best: string | null = null;
      for (let i = 0; i < r.form.length; i++) {
        if (r.form[i] !== "8-K") continue;
        if (!(r.items?.[i] ?? "").includes("2.02")) continue;
        const d = r.filingDate[i]!;
        // A report on the board day itself (Microsoft and Meta filed their
        // 8-Ks after the 07-29 close) was on that morning's calendar: daysAway 0.
        if (d < day || d > to) continue;
        if (best == null || d < best) best = d;
      }
      if (best) out.set(ticker.toUpperCase(), { dateISO: best, epsEstimate: null });
    } catch {
      /* one filer's submissions unreachable - it simply keeps no date */
    }
  });
  return out;
}

async function main(): Promise<void> {
  let board = BOARD_DAY ? await fetchBoardForDay(BOARD_DAY) : await fetchRecentSharedSignals();
  if (!board && !BOARD_DAY) board = await fetchBoardDirect();
  if (!board) {
    console.error("ERROR: could not load daily_signals board.");
    process.exit(1);
  }

  const spyCloses = await closesUpTo("SPY", 260, BOARD_DAY);
  console.log(`Board ${board.marketDay}: ${board.signals.length} names${BOARD_DAY ? "  [POINT-IN-TIME REPLAY as of " + BOARD_DAY + "]" : ""}`);
  console.log("Folding SEC XBRL forward-pipeline facts (simulating tomorrow's scan)…");
  const factsRaw = await fetchXbrlPipelineByTicker();
  const facts = BOARD_DAY ? censorFactsAsOf(factsRaw, BOARD_DAY) : factsRaw;
  const factsByTicker = facts;
  console.log(`  ${facts.size} filers with disclosed pipeline facts\n`);

  let folded = 0;
  const generatedAt = new Date().toISOString();
  // EVERY name is rebuilt and re-scored the same way - only the pipeline group
  // differs - so the comparison never confounds "gained pipeline data" with
  // "was re-scored". `priceSeries` is stripped from the published payload to keep
  // it small, and `scoreCompany` reads its length, so restore it as empty; the
  // 260-close `priceHistory` is what actually carries the price evidence.
  const universe: StockSignal[] = board.signals.map((s) => {
    const f = facts.get(s.ticker.toUpperCase());
    if (f) folded++;
    // Faithfully simulate tomorrow's scan, which no longer inherits the synthetic
    // ticker-hash PRNG for risk / volatility / social. The published board still
    // carries those fabricated values, so strip them here or the comparison would
    // measure yesterday's noise. `atrPct` on the board IS real (the Alpaca bars
    // stage overwrote it), so it is preserved; beta is re-measured from the real
    // closes and implied vol is simply absent, as it will be after the fix.
    const beta = realizedBeta(s.priceHistory ?? [], spyCloses);
    const rebuilt = {
      ...s,
      priceSeries: s.priceSeries ?? [],
      risk: unknownRisk(),
      social: unknownSocial(),
      socialPosts: [],
      volatility: {
        ...unknownVolatility(),
        atrPct: s.volatility?.atrPct ?? 0,
        ...(beta != null ? { beta } : {}),
      },
      ...(f
        ? {
            pipeline: {
              ...s.pipeline,
              ...(f.backlogToRevTTM != null ? { backlogToRevTTM: f.backlogToRevTTM } : {}),
              ...(f.backlogYoY != null ? { backlogYoY: f.backlogYoY } : {}),
              ...(f.deferredRevYoY != null ? { deferredRevYoY: f.deferredRevYoY } : {}),
            },
            ...(f.fcfMargin != null || f.netMargin != null || f.revenueGrowthYoY != null
              ? {
                  fundamentals: {
                    ...s.fundamentals,
                    ...(f.fcfMargin != null ? { fcfMargin: f.fcfMargin } : {}),
                    ...(f.netMargin != null ? { netMargin: f.netMargin } : {}),
                    ...(f.revenueGrowthYoY != null
                      ? { revenueGrowthYoY: f.revenueGrowthYoY }
                      : {}),
                  },
                  fundamentalsAvailability: {
                    ...s.fundamentalsAvailability,
                    ...(f.fcfMargin != null ? { fcfMargin: true } : {}),
                    ...(f.netMargin != null ? { netMargin: true } : {}),
                    ...(f.revenueGrowthYoY != null ? { revenueGrowthYoY: true } : {}),
                  },
                }
              : {}),
            ...(s.revenueTTM == null && f.revenueTTM != null ? { revenueTTM: f.revenueTTM } : {}),
          }
        : {}),
    };
    // Apply the SAME internal-consistency rule the scan's publish invariant runs,
    // so the simulation cannot rank on a figure production would have withdrawn.
    const fundamentals = { ...rebuilt.fundamentals };
    const availability = { ...(rebuilt.fundamentalsAvailability ?? {}) };
    withdrawContradictoryFundamentals(fundamentals, availability);
    const checked = { ...rebuilt, fundamentals, fundamentalsAvailability: availability };
    return toStockSignal(checked, scoreCompany(checked), generatedAt);
  });
  console.log(`Pipeline folded into ${folded}/${universe.length} names; all re-scored.\n`);

  if (REFRESH_EARNINGS) {
    const day = BOARD_DAY ?? new Date().toISOString().slice(0, 10);
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    const to = new Date(dayMs + 90 * 86_400_000).toISOString().slice(0, 10);
    // Finnhub's free tier carries no calendar HISTORY, so a replay reads each
    // filer's next 8-K Item 2.02 (results release) filing date from SEC
    // submissions instead. Report dates are announced two to four weeks ahead,
    // so "the next 2.02 after the board day" is what a scan that morning would
    // have had on its calendar - stated as a reconstruction all the same.
    const calendar = BOARD_DAY
      ? await earningsFromSecFilings(universe.map((s) => s.ticker), day, to)
      : await fetchFinnhubEarningsCalendarMap(day, to);
    let wired = 0;
    for (let i = 0; i < universe.length; i++) {
      const s = universe[i]!;
      const event = calendar.get(s.ticker.toUpperCase());
      if (!event) continue;
      const daysAway = Math.max(0, Math.round((Date.parse(`${event.dateISO}T00:00:00Z`) - dayMs) / 86_400_000));
      const applied = applyEarningsToCompany(s, event, daysAway);
      if (applied.catalyst?.type === "Earnings" && applied.catalystLive) wired++;
      universe[i] = toStockSignal(applied, scoreCompany(applied), generatedAt);
    }
    console.log(`Earnings calendar: ${calendar.size} symbols in [${day}, ${to}]; earnings catalyst wired for ${wired}/${universe.length} names.
`);
  }

  if (REFRESH_INFLECTION) {
    console.log(`Refreshing quarterly inflection inputs for ${universe.length} names${BOARD_DAY ? ` (point-in-time as of ${BOARD_DAY})` : ""}…`);
    const refreshed = BOARD_DAY
      ? await refreshInflectionPointInTime(universe, BOARD_DAY)
      : await enrichTopNWithInflection(universe, undefined, 6);
    let changed = 0;
    for (let i = 0; i < universe.length; i++) {
      const before = universe[i]!;
      const after = refreshed[i]!;
      if (JSON.stringify(before.inflection ?? null) === JSON.stringify(after.inflection ?? null)) continue;
      changed++;
      universe[i] = toStockSignal(after, scoreCompany(after), generatedAt);
    }
    console.log(`  inflection inputs changed for ${changed}/${universe.length} names; re-scored.\n`);
  }

  // OWN-HISTORY VALUATION: needs multi-year closes, which the published board does
  // not carry (it ships ~260). Fetch a long window for the names that could
  // plausibly surface, so the reading is real rather than extrapolated.
  // Cover EVERY name that has a disclosed multi-year revenue series, not just the
  // ones already ranking well. Selecting candidates by the CURRENT score is
  // circular: Amazon is exactly the name whose own-history multiple should rescue
  // it, and it can only do that if the reading is computed before the ranking.
  const candidates = universe.filter((s) =>
    (factsByTicker.get(s.ticker.toUpperCase())?.revenueByYear?.length ?? 0) >= 3,
  );
  console.log(`Fetching ${candidates.length} long price histories for own-history valuation…`);
  const asOf = BOARD_DAY ? new Date(`${BOARD_DAY}T00:00:00Z`) : new Date();
  let valued = 0;
  const longCloses = new Map<string, number[]>();
  {
    const syms = candidates.map((c) => c.ticker);
    const opts = BOARD_DAY ? { limit: 1500, end: BOARD_DAY, concurrency: 4 } : { limit: 1500, concurrency: 4 };
    const all = await fetchAlpacaBarsForSymbols(syms, opts).catch(() => ({} as Record<string, { series: Array<{date:string;close:number}> }>));
    for (const t of syms) {
      const series = (all[t]?.series ?? []).filter((p) => !BOARD_DAY || p.date <= BOARD_DAY);
      if (series.length >= 400) longCloses.set(t, series.map((p) => p.close));
    }
  }
  for (let i = 0; i < universe.length; i++) {
    const sig = universe[i]!;
    const facts = factsByTicker.get(sig.ticker.toUpperCase());
    const closes = longCloses.get(sig.ticker);
    if (!facts?.revenueByYear || !closes) continue;
    const own = computeOwnHistoryValuation(
      facts.revenueByYear,
      closes,
      sig.price,
      asOf,
      facts.netIncomeByYear,
    );
    if (!own) continue;
    valued++;
    const withValuation = {
      ...sig,
      valuation: {
        ...sig.valuation,
        peVsOwn5yrPctile: own.percentile,
        revenueVsPriceDivergence: own.divergence,
      },
    };
    universe[i] = toStockSignal(withValuation, scoreCompany(withValuation), generatedAt);
    ownHistory.set(sig.ticker, own);
  }
  console.log(`Own-history valuation computed for ${valued} names.
`);

  const context = await buildContext(universe);

  const arms: Array<{ id: EngineVariantId; label: string }> = [
    { id: "challenger", label: "V5 (live)" },
    { id: "v6", label: "V6 (July final)" },
    { id: "v7", label: "V7 (synthesis)" },
  ];

  const ranked: Record<string, StockSignal[]> = {};
  for (const arm of arms) {
    ranked[arm.id] = [...postProcessUniverse(universe, arm.id, context)].sort(
      (a, b) => b.score.opportunityScore - a.score.opportunityScore,
    );
  }

  const flags = universe.map((s) => inferArchetypeFlags(s));
  const pct = (k: number) => `${k}/${universe.length} (${((k / universe.length) * 100).toFixed(1)}%)`;
  console.log("== ARCHETYPE COVERAGE after the pipeline fold ==");
  console.log(`megaReversal          ${pct(flags.filter((f) => f.megaReversal).length)}`);
  console.log(`compounder            ${pct(flags.filter((f) => f.compounder).length)}`);
  console.log(`smallRunner           ${pct(flags.filter((f) => f.smallRunner).length)}`);
  console.log(`misunderstoodQuality  ${pct(flags.filter((f) => f.misunderstoodQuality).length)}`);
  console.log(
    `UNTAGGED              ${pct(flags.filter((f) => !f.megaReversal && !f.compounder && !f.smallRunner && !f.misunderstoodQuality).length)}`,
  );

  console.log("\n== T4 misunderstood-quality names ==");
  const v6norm = computeNormalizedScores(universe, context, SYNTHESIS_V7_NORMALIZATION);
  const v6by = new Map(v6norm.map((x) => [x.ticker, x]));
  universe.forEach((s, i) => {
    if (!flags[i]!.misunderstoodQuality) return;
    const closes = s.priceHistory ?? [];
    const price = s.price > 0 ? s.price : (closes[closes.length - 1] ?? 0);
    const high = closes.length ? Math.max(price, ...closes) : 0;
    const offHigh = high > 0 ? (high - price) / high : 0;
    const p = s.pipeline;
    // Mirror the engine exactly: it takes the BEST of the two visibility series,
    // so displaying only `backlogYoY` mislabelled names that qualified on deferred
    // revenue instead.
    const visibility = Math.max(
      p?.backlogYoY ?? Number.NEGATIVE_INFINITY,
      p?.deferredRevYoY ?? Number.NEGATIVE_INFINITY,
    );
    const lead = (Number.isFinite(visibility) ? visibility : 0) - (s.fundamentals?.revenueGrowthYoY ?? 0);
    console.log(
      `  ${s.ticker.padEnd(6)} cap $${(s.marketCap / 1e9).toFixed(0).padStart(4)}B  offHigh ${(offHigh * 100).toFixed(0).padStart(2)}%  ` +
        `demandLead ${(lead * 100).toFixed(0).padStart(4)}pp  tilt +${(v6by.get(s.ticker)?.misunderstoodTilt ?? 0).toFixed(1)}  ` +
        `V5 #${String(rankOf(ranked["challenger"]!, s.ticker)).padStart(3)} → V6 #${String(rankOf(ranked["v7"]!, s.ticker)).padStart(3)}`,
    );
  });

  for (const arm of arms) {
    console.log(`\n== TOP ${TOP_N} — ${arm.label} ==`);
    ranked[arm.id]!.slice(0, TOP_N).forEach((s, i) => {
      const f = inferArchetypeFlags(s);
      const tags = [
        f.misunderstoodQuality ? "T4" : null,
        f.megaReversal ? "T1" : null,
        f.compounder ? "T2" : null,
        f.smallRunner ? "T3" : null,
      ]
        .filter(Boolean)
        .join("/");
      console.log(
        `${String(i + 1).padStart(2)}. ${s.ticker.padEnd(6)} ${String(s.score.opportunityScore).padStart(3)}  ` +
          `${(s.marketCapBucket ?? "").padEnd(6)} ${String(s.sector ?? "").padEnd(14)} ${tags}`,
      );
    });
  }

  console.log("\n" + "=".repeat(78));
  console.log("TOP 10 — V7, with the evidence behind each pick");
  console.log("=".repeat(78));
  ranked["v7"]!.slice(0, 10).forEach((s, i) => {
    const nz = v6by.get(s.ticker);
    const f = inferArchetypeFlags(s);
    const tags =
      [
        f.misunderstoodQuality ? "T4 misunderstood-quality" : null,
        f.megaReversal ? "T1 washed-out reversal" : null,
        f.compounder ? "T2 re-accelerating compounder" : null,
        f.smallRunner ? "T3 small-cap runner" : null,
      ]
        .filter(Boolean)
        .join(" + ") || "no archetype (base cohort curve)";
    const closes = s.priceHistory ?? [];
    const price = s.price > 0 ? s.price : (closes[closes.length - 1] ?? 0);
    const high = closes.length ? Math.max(price, ...closes) : 0;
    const offHigh = high > 0 ? (high - price) / high : 0;
    const p = s.pipeline;
    const cat = (k: string) => Math.round(s.score.categories.find((c) => c.key === k)?.score ?? 50);

    console.log(
      `\n${String(i + 1).padStart(2)}. ${s.ticker} — ${s.name}  [${s.score.opportunityScore}/100]`,
    );
    console.log(
      `    ${s.sector} · ${s.marketCapBucket} · $${(s.marketCap / 1e9).toFixed(0)}B · $${s.price} · risk ${s.riskLevel} · confidence ${s.confidence}`,
    );
    console.log(`    archetype: ${tags}`);
    console.log(`    thesis:    ${nz?.thesisReason ?? "—"}`);
    console.log(
      `    entry:     ${(offHigh * 100).toFixed(0)}% off its high · RSI ${Math.round(s.momentum?.rsi ?? 0)} · ` +
        `1M ${((s.momentum?.return1M ?? 0) * 100).toFixed(0)}% · 3M ${((s.momentum?.return3M ?? 0) * 100).toFixed(0)}%`,
    );
    console.log(
      `    business:  rev ${((s.fundamentals?.revenueGrowthYoY ?? 0) * 100).toFixed(0)}% YoY · ` +
        `net margin ${((s.fundamentals?.netMargin ?? 0) * 100).toFixed(0)}% · ` +
        `D/E ${(s.fundamentals?.debtToEquity ?? 0).toFixed(1)}x · P/E ${s.fundamentals?.peRatio?.toFixed(0) ?? "—"}`,
    );
    if (p?.backlogToRevTTM != null || p?.backlogYoY != null) {
      console.log(
        `    order book: ${p.backlogToRevTTM != null ? `${p.backlogToRevTTM.toFixed(1)}x revenue` : "—"} · ` +
          `${p.backlogYoY != null ? `backlog ${(p.backlogYoY * 100).toFixed(0)}% YoY` : ""}` +
          `${p.deferredRevYoY != null ? ` · deferred rev ${(p.deferredRevYoY * 100).toFixed(0)}% YoY` : ""}`,
      );
    }
    console.log(
      `    dims:      pipeline ${cat("pipeline")} · valuation ${cat("valuation")} · fundamentals ${cat("fundamentals")} · ` +
        `inflection ${cat("inflection")} · momentum ${cat("momentum")} · catalyst ${cat("catalyst")}`,
    );
    console.log(
      `    tilts:     catalyst ${nz?.catalystTilt?.toFixed(1) ?? 0} · discount ${nz?.discountTilt?.toFixed(1) ?? 0} · ` +
        `reversal ${nz?.reversalTilt?.toFixed(1) ?? 0} · compounder ${nz?.qualityCompounderTilt?.toFixed(1) ?? 0} · ` +
        `misunderstood ${nz?.misunderstoodTilt?.toFixed(1) ?? 0} · asym ${nz?.asymmetryTilt?.toFixed(1) ?? 0} · ownHist ${nz?.ownHistoryTilt?.toFixed(1) ?? 0} · absPE ${nz?.absoluteMultipleTilt?.toFixed(1) ?? 0} · readiness ${nz?.reversalReadiness?.toFixed(2) ?? "—"}`,
    );
    if (s.catalystLive) console.log(`    catalyst:  ${s.catalyst?.description ?? ""}`);
  });

  // Any tickers passed on argv get the SAME full evidence block the top 10 gets,
  // so "why is X ranked where it is" is answerable with the engine's own numbers.
  const probes = process.argv.slice(2).map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (probes.length > 0) {
    console.log("\n" + "=".repeat(78));
    console.log("PROBES — where these rank under V7 and why");
    console.log("=".repeat(78));
    for (const t of probes) {
      const idx = rankOf(ranked["v7"]!, t);
      if (idx === 0) {
        console.log(`\n${t} — NOT ON THE PUBLISHED BOARD (did not survive the daily funnel)`);
        continue;
      }
      const s = ranked["v7"]![idx - 1]!;
      const nz = v6by.get(t);
      const f = inferArchetypeFlags(s);
      const tags =
        [
          f.misunderstoodQuality ? "T4" : null,
          f.megaReversal ? "T1" : null,
          f.compounder ? "T2" : null,
          f.smallRunner ? "T3" : null,
        ]
          .filter(Boolean)
          .join("+") || "untagged";
      const closes = s.priceHistory ?? [];
      const price = s.price > 0 ? s.price : (closes[closes.length - 1] ?? 0);
      const high = closes.length ? Math.max(price, ...closes) : 0;
      const offHigh = high > 0 ? (high - price) / high : 0;
      const p = s.pipeline;
      const cat = (k: string) => Math.round(s.score.categories.find((c) => c.key === k)?.score ?? 50);
      console.log(
        `\n#${idx}/${ranked["v7"]!.length}  ${t} — ${s.name}  [${s.score.opportunityScore}/100]  ${tags}`,
      );
      console.log(
        `   ${s.sector} · $${(s.marketCap / 1e9).toFixed(0)}B · ${(offHigh * 100).toFixed(0)}% off high · RSI ${Math.round(s.momentum?.rsi ?? 0)} · ` +
          `3M ${((s.momentum?.return3M ?? 0) * 100).toFixed(0)}% · risk ${s.riskLevel} (penalty ${s.score.riskPenalty ?? 0}) · conf ${s.confidence}`,
      );
      console.log(
        `   rev ${((s.fundamentals?.revenueGrowthYoY ?? 0) * 100).toFixed(0)}% · net margin ${((s.fundamentals?.netMargin ?? 0) * 100).toFixed(0)}% · ` +
          `P/E ${s.fundamentals?.peRatio?.toFixed(0) ?? "—"} · PEG ${s.fundamentals?.pegRatio?.toFixed(2) ?? "—"} · D/E ${(s.fundamentals?.debtToEquity ?? 0).toFixed(1)}x`,
      );
      console.log(
        `   order book: ${p?.backlogToRevTTM != null ? `${p.backlogToRevTTM.toFixed(1)}x rev` : "none disclosed"}` +
          `${p?.backlogYoY != null ? ` · backlog ${(p.backlogYoY * 100).toFixed(0)}% YoY` : ""}` +
          `${p?.deferredRevYoY != null ? ` · deferred ${(p.deferredRevYoY * 100).toFixed(0)}% YoY` : ""}`,
      );
      console.log(
        `   dims: pipeline ${cat("pipeline")} · valuation ${cat("valuation")} · fundamentals ${cat("fundamentals")} · ` +
          `inflection ${cat("inflection")} · growth ${cat("growth")} · momentum ${cat("momentum")} · catalyst ${cat("catalyst")} · ` +
          `sentShift ${cat("sentimentShift")} · conviction ${cat("conviction")}`,
      );
      console.log(
        `   tilts: catalyst ${nz?.catalystTilt?.toFixed(1)} · discount ${nz?.discountTilt?.toFixed(1)} · reversal ${nz?.reversalTilt?.toFixed(1)} · ` +
          `compounder ${nz?.qualityCompounderTilt?.toFixed(1)} · misunderstood ${nz?.misunderstoodTilt?.toFixed(1)} · asym ${nz?.asymmetryTilt?.toFixed(1)} · ownHist ${nz?.ownHistoryTilt?.toFixed(1)} · absPE ${nz?.absoluteMultipleTilt?.toFixed(1)} · ` +
          `size ${nz?.sizeTilt?.toFixed(1)} · readiness ${nz?.reversalReadiness?.toFixed(2)}`,
      );
      console.log(`   thesis: ${nz?.thesisReason ?? "—"}`);
    }
  }

  console.log("\n== named movement ==");
  for (const t of ["ORCL", "MSFT", "META", "GOOGL", "AVGO", "CRWV", "NVDA", "PLTR", "WPM", "AEM", "NEM"]) {
    const a = rankOf(ranked["challenger"]!, t);
    const b = rankOf(ranked["v7"]!, t);
    if (a === 0 && b === 0) continue;
    const sa = ranked["challenger"]!.find((s) => s.ticker === t)?.score.opportunityScore;
    const sb = ranked["v7"]!.find((s) => s.ticker === t)?.score.opportunityScore;
    console.log(
      `  ${t.padEnd(6)} V5 #${String(a).padStart(3)} (${sa}) → V6 #${String(b).padStart(3)} (${sb})  ${b < a ? `▲ +${a - b}` : b > a ? `▼ -${b - a}` : "="}`,
    );
  }
  console.log("");
  process.exit(0);
}

void main();
