// IMPORTANT: bootstrap MUST be the first import - same import-order contract as
// scripts/refinement_report.mts (installs Node shims, sample-mode OFF, loads
// scripts/universe_scan/.scan.env into process.env).
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";

import type { StockSignal } from "@/types";
import { fetchRecentSharedSignals, type SharedDailySignals } from "@/data/dailySignalsCache";
import { getActiveVariant, postProcessUniverse } from "@/engine/challenger";
import { initGlobalControls, getGlobalControls } from "@/data/globalControls";
import {
  buildArchetypeContext,
  computeNormalizedScores,
  inferArchetypeFlags,
  INFLECTION_V2_NORMALIZATION,
  REVERSAL_V5_NORMALIZATION,
  type NormalizationContext,
} from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import { reversalReadiness } from "@/engine/reversalReadiness";
import { isAlpacaConfigured } from "@/data/http";
import { fetchDailyBars } from "@/data/alpaca/bars";

/**
 * scripts/diag_archetype.mts - per-name ENGINE X-RAY on the live published board.
 *
 * Answers "why is <TICKER> not surfacing?" with the ACTUAL numbers the live engine
 * saw: every raw sub-score, every cross-sectional z, every bounded tilt, the
 * archetype flags, the reversal-readiness components, and the individual boolean
 * legs of the archetype gates (so a single failing AND-clause is visible instead of
 * being buried in a `false`).
 *
 * READ-ONLY: loads the same `daily_signals` bytes the app reads and re-runs the
 * same pure normalization pass. Never mutates the board or any weight.
 *
 *   vite-node scripts/diag_archetype.mts ORCL MSFT META NVDA
 */

const TICKERS = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["ORCL"]).map((t) =>
  t.trim().toUpperCase(),
);

async function fetchBoardDirect(): Promise<SharedDailySignals | null> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon = process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return null;
  try {
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
  } catch {
    return null;
  }
}

async function buildContext(universe: StockSignal[]): Promise<NormalizationContext> {
  const archetypes = buildArchetypeContext(universe);
  if (!isAlpacaConfigured()) {
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals: universe }) };
  }
  const spyCloses = await fetchDailyBars("SPY", 260).catch(() => [] as number[]);
  return {
    archetypes,
    regime: buildMarketRegimeContext({ spyCloses, signals: universe }),
  };
}

const n = (v: unknown, d = 3): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : String(v ?? "—");
const pct = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";

async function main(): Promise<void> {
  await initGlobalControls().catch(() => undefined);
  const controls = getGlobalControls();
  const activeVariant = controls?.activeVariant ?? getActiveVariant();

  let board = await fetchRecentSharedSignals();
  if (!board) board = await fetchBoardDirect();
  if (!board) {
    console.error("ERROR: could not load daily_signals board.");
    process.exit(1);
  }
  const universe = board.signals;
  const context = await buildContext(universe);

  const options =
    activeVariant === "challenger" ? REVERSAL_V5_NORMALIZATION : INFLECTION_V2_NORMALIZATION;
  const reranked = postProcessUniverse(universe, activeVariant, context);
  const ranked = [...reranked].sort((a, b) => b.score.opportunityScore - a.score.opportunityScore);
  const norm = computeNormalizedScores(universe, context, options);
  const normByTicker = new Map(norm.map((x) => [x.ticker, x]));

  console.log(
    `\nBoard ${board.marketDay} — ${universe.length} names — live variant: ${activeVariant}` +
      ` (regime riskOffness ${n(context.regime?.riskOffness, 2)})\n`,
  );

  for (const ticker of TICKERS) {
    const raw = universe.find((s) => s.ticker === ticker);
    if (!raw) {
      console.log(`\n=== ${ticker} — NOT ON THE PUBLISHED BOARD ===\n`);
      continue;
    }
    const rank = ranked.findIndex((s) => s.ticker === ticker) + 1;
    const live = ranked[rank - 1]!;
    const nz = normByTicker.get(ticker);
    const flags = inferArchetypeFlags(raw);
    const rr = reversalReadiness(raw);

    const f = raw.fundamentals;
    const inf = raw.inflection;
    const pipe = raw.pipeline;
    const mom = raw.momentum;
    const closes = raw.priceHistory ?? [];
    const price = raw.price > 0 ? raw.price : (closes[closes.length - 1] ?? 0);
    const high = closes.length ? Math.max(price, ...closes) : 0;
    const low = closes.length ? Math.min(price, ...closes) : 0;
    const offHigh = high > 0 ? (high - price) / high : 0;
    const runFromLow = low > 0 ? (price - low) / low : 0;

    // The individual boolean legs of hasQualityFloor (normalizeUniverse.ts).
    const revenueStable =
      (f?.revenueGrowthYoY ?? 0) > -0.08 ||
      (inf?.revYoYAccel != null && inf.revYoYAccel >= -0.02) ||
      (inf?.revAccelQoQ != null && inf.revAccelQoQ >= 0);
    const cashFlowOk =
      (f?.fcfMargin ?? 0) >= -0.02 || (f?.netMargin ?? 0) >= 0 || (f?.debtToEquity ?? 1) <= 0.8;
    const balanceSheetOk =
      (f?.debtToEquity ?? 1) <= 2.5 && (raw.risk?.dilutionRisk ?? 0) < 0.45;

    const cat = (k: string) => raw.score.categories.find((c) => c.key === k)?.score;

    console.log(`\n${"=".repeat(78)}`);
    console.log(
      `${ticker} — ${raw.name} | ${raw.sector} | cap $${(raw.marketCap / 1e9).toFixed(1)}B | $${raw.price}`,
    );
    console.log(`${"=".repeat(78)}`);
    console.log(
      `RANK ${rank}/${ranked.length}   live score ${live.score.opportunityScore}   ` +
        `published ${raw.score.opportunityScore}   confidence ${raw.confidence}   risk ${raw.riskLevel}`,
    );

    console.log(`\n-- raw sub-scores (0..100) --`);
    console.log(
      raw.score.categories
        .map((c) => `${c.key}=${Math.round(c.score)}`)
        .join("  "),
    );

    console.log(`\n-- cross-sectional z --`);
    console.log(
      Object.entries(nz?.dimensionZ ?? {})
        .map(([k, v]) => `${k}=${n(v, 2)}`)
        .join("  "),
    );

    console.log(`\n-- tilts (display points) --`);
    console.log(
      `catalyst=${n(nz?.catalystTilt, 2)}  discount=${n(nz?.discountTilt, 2)}  ` +
        `reversal=${n((nz as Record<string, unknown> | undefined)?.reversalTilt, 2)}  ` +
        `qualityCompounder=${n((nz as Record<string, unknown> | undefined)?.qualityCompounderTilt, 2)}  ` +
        `size=${n(nz?.sizeTilt, 2)}  sizeBalance=${n(nz?.sizeBalanceTilt, 2)}  ` +
        `sellWatch=${n(nz?.sellWatchTilt, 2)}  revision=${n(nz?.revisionTilt, 2)}`,
    );
    console.log(`thesis: cleared=${nz?.thesisCleared} — ${nz?.thesisReason}`);

    console.log(`\n-- archetype flags --`);
    console.log(
      `megaReversal=${flags.megaReversal}  compounder=${flags.compounder}  smallRunner=${flags.smallRunner}`,
    );
    console.log(
      `  hasQualityFloor legs: revenueStable=${revenueStable} cashFlowOk=${cashFlowOk} balanceSheetOk=${balanceSheetOk}`,
    );
    console.log(
      `  offHigh=${pct(offHigh)} (megaReversal wants 30–75%)  runFromLow=${pct(runFromLow)}  history=${closes.length}d`,
    );

    console.log(`\n-- reversal readiness --`);
    console.log(
      `readiness=${n(rr.readiness)}  deceleration=${n(rr.deceleration)}  basing=${n(rr.basing)}  ` +
        `catalystBypass=${rr.catalystBypass}  knifeVeto=${rr.fallingKnifeVeto}  freshShock=${rr.freshShock}`,
    );

    console.log(`\n-- fundamentals --`);
    console.log(
      `revGrowthYoY=${pct(f?.revenueGrowthYoY)}  epsGrowthYoY=${pct(f?.epsGrowthYoY)}  ` +
        `grossMargin=${pct(f?.grossMargin)}  netMargin=${pct(f?.netMargin)}  fcfMargin=${pct(f?.fcfMargin)}`,
    );
    console.log(
      `debtToEquity=${n(f?.debtToEquity, 2)}  peRatio=${n(f?.peRatio, 1)}  pegRatio=${n(f?.pegRatio, 2)}  ` +
        `revenueTTM=${raw.revenueTTM != null ? `$${(raw.revenueTTM / 1e9).toFixed(1)}B` : "—"}`,
    );
    console.log(
      `availability=${JSON.stringify(raw.fundamentalsAvailability ?? {})}  asOf=${raw.fundamentalsAsOf ?? "—"}`,
    );

    console.log(`\n-- inflection --`);
    console.log(inf ? JSON.stringify(inf) : "ABSENT (scores neutral 50)");
    console.log(`-- pipeline --`);
    console.log(pipe ? JSON.stringify(pipe) : "ABSENT (scores neutral 50)");
    console.log(`-- valuation(own-history) --`);
    console.log(raw.valuation ? JSON.stringify(raw.valuation) : "ABSENT");

    console.log(`\n-- momentum --`);
    console.log(
      `rsi=${n(mom?.rsi, 1)}  1M=${pct(mom?.return1M)}  3M=${pct(mom?.return3M)}  6M=${pct(mom?.return6M)}  ` +
        `aboveSMA50=${mom?.aboveSMA50}  aboveSMA200=${mom?.aboveSMA200}  rs3M=${pct(mom?.relativeStrength3M)}`,
    );

    console.log(`\n-- catalyst / news --`);
    console.log(
      `catalystLive=${raw.catalystLive}  type=${raw.catalyst?.type}  daysAway=${raw.catalyst?.daysAway}  ` +
        `magnitude=${n(raw.catalyst?.magnitude, 2)}`,
    );
    console.log(`  "${raw.catalyst?.description ?? ""}"`);
    console.log(
      `news: count7d=${raw.news?.count7d}  sentiment=${n(raw.news?.sentiment, 2)}  freshnessHours=${n(raw.news?.freshnessHours, 1)}`,
    );

    console.log(`\n-- gate check: qualityCompounderTilt (V5) --`);
    const fundS = cat("fundamentals") ?? 50;
    const valS = cat("valuation") ?? 50;
    const convS = cat("conviction") ?? 50;
    console.log(
      `cap>=50B? ${raw.marketCap >= 50e9}  sectorAllowed? ${!/materials|energy|utilities|real estate/i.test(String(raw.sector))}  ` +
        `fundamentals>=72? ${fundS >= 72} (${Math.round(fundS)})  valuation>=56? ${valS >= 56} (${Math.round(valS)})  ` +
        `conviction>=55? ${convS >= 55} (${Math.round(convS)})`,
    );
  }
  console.log("");
  process.exit(0);
}

void main();
