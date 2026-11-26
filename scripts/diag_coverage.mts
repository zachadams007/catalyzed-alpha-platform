// IMPORTANT: bootstrap MUST be the first import (see refinement_report.mts).
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";
import type { StockSignal } from "@/types";
import { fetchRecentSharedSignals, type SharedDailySignals } from "@/data/dailySignalsCache";
import { inferArchetypeFlags } from "@/engine/normalizeUniverse";
import { reversalReadiness } from "@/engine/reversalReadiness";

/**
 * scripts/diag_coverage.mts - INPUT-COVERAGE audit of the live published board.
 *
 * A scoring dimension can only rank names if its INPUTS exist. A dimension whose
 * inputs are absent everywhere returns the same neutral 50 for every name, which
 * carries ZERO cross-sectional spread - it is dead weight in the blend, silently.
 * This prints, per input group, how many of the published names actually carry it,
 * so an inert dimension is visible instead of being assumed live.
 *
 * READ-ONLY. `vite-node scripts/diag_coverage.mts`
 */

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

async function main(): Promise<void> {
  let board = await fetchRecentSharedSignals();
  if (!board) board = await fetchBoardDirect();
  if (!board) {
    console.error("ERROR: could not load daily_signals board.");
    process.exit(1);
  }
  const u = board.signals;
  const N = u.length;
  const pctOf = (k: number) => `${k}/${N} (${((k / N) * 100).toFixed(1)}%)`;
  const count = (fn: (s: StockSignal) => boolean) => u.filter(fn).length;

  console.log(`\nBoard ${board.marketDay} — ${N} published names\n`);

  console.log("== INPUT GROUPS (a dimension is inert where its group is absent) ==");
  console.log(`inflection present        ${pctOf(count((s) => s.inflection != null))}`);
  console.log(`pipeline present          ${pctOf(count((s) => s.pipeline != null))}`);
  console.log(`  bookToBill              ${pctOf(count((s) => s.pipeline?.bookToBill != null))}`);
  console.log(`  backlogToRevTTM         ${pctOf(count((s) => s.pipeline?.backlogToRevTTM != null))}`);
  console.log(`  namedContractPctRev     ${pctOf(count((s) => s.pipeline?.namedContractPctRev != null))}`);
  console.log(`valuation.peVsOwn5yrPctile ${pctOf(count((s) => s.valuation?.peVsOwn5yrPctile != null))}`);
  console.log(`sentimentSeries present   ${pctOf(count((s) => s.sentimentSeries != null))}`);
  console.log(`revenueTTM present        ${pctOf(count((s) => s.revenueTTM != null))}`);
  console.log(`strategicCapital present  ${pctOf(count((s) => s.strategicCapital != null))}`);
  console.log(`congressTrades present    ${pctOf(count((s) => (s.congressTrades?.length ?? 0) > 0))}`);
  console.log(`secActivity present       ${pctOf(count((s) => s.secActivity != null))}`);
  console.log(`analyst present           ${pctOf(count((s) => s.analyst != null))}`);
  console.log(`priceHistory >= 120       ${pctOf(count((s) => (s.priceHistory?.length ?? 0) >= 120))}`);

  console.log("\n== FUNDAMENTALS AVAILABILITY (per field, live-disclosed) ==");
  for (const f of [
    "revenueGrowthYoY",
    "epsGrowthYoY",
    "grossMargin",
    "netMargin",
    "peRatio",
    "pegRatio",
    "debtToEquity",
    "fcfMargin",
  ] as const) {
    console.log(`  ${f.padEnd(20)} ${pctOf(count((s) => s.fundamentalsAvailability?.[f] === true))}`);
  }

  console.log("\n== CATALYSTS ==");
  console.log(`catalystLive === true     ${pctOf(count((s) => s.catalystLive === true))}`);
  console.log(`catalyst.type !== None    ${pctOf(count((s) => s.catalyst?.type !== "None"))}`);
  console.log(`catalyst.magnitude>=0.35  ${pctOf(count((s) => (s.catalyst?.magnitude ?? 0) >= 0.35))}`);

  console.log("\n== ARCHETYPE COVERAGE (what the weight router actually tags) ==");
  const flags = u.map((s) => inferArchetypeFlags(s));
  console.log(`megaReversal              ${pctOf(flags.filter((f) => f.megaReversal).length)}`);
  console.log(`compounder                ${pctOf(flags.filter((f) => f.compounder).length)}`);
  console.log(`smallRunner               ${pctOf(flags.filter((f) => f.smallRunner).length)}`);
  console.log(
    `UNTAGGED (base curve)     ${pctOf(flags.filter((f) => !f.megaReversal && !f.compounder && !f.smallRunner).length)}`,
  );

  console.log("\n== REVERSAL READINESS ==");
  const rr = u.map((s) => reversalReadiness(s));
  console.log(`knifeVeto fired           ${pctOf(rr.filter((r) => r.fallingKnifeVeto).length)}`);
  console.log(`catalystBypass            ${pctOf(rr.filter((r) => r.catalystBypass).length)}`);
  console.log(`freshShock                ${pctOf(rr.filter((r) => r.freshShock).length)}`);
  console.log(`readiness === 0           ${pctOf(rr.filter((r) => r.readiness === 0).length)}`);
  console.log(`readiness === 1           ${pctOf(rr.filter((r) => r.readiness === 1).length)}`);

  console.log("\n== hasQualityFloor LEG FAILURES (large caps only, cap>$10B) ==");
  const large = u.filter((s) => s.marketCap > 10e9);
  const legFail = (s: StockSignal) => {
    const f = s.fundamentals;
    const inf = s.inflection;
    const revenueStable =
      (f?.revenueGrowthYoY ?? 0) > -0.08 ||
      (inf?.revYoYAccel != null && inf.revYoYAccel >= -0.02) ||
      (inf?.revAccelQoQ != null && inf.revAccelQoQ >= 0);
    const cashFlowOk =
      (f?.fcfMargin ?? 0) >= -0.02 || (f?.netMargin ?? 0) >= 0 || (f?.debtToEquity ?? 1) <= 0.8;
    const balanceSheetOk = (f?.debtToEquity ?? 1) <= 2.5 && (s.risk?.dilutionRisk ?? 0) < 0.45;
    return { revenueStable, cashFlowOk, balanceSheetOk };
  };
  const L = large.length;
  const lp = (k: number) => `${k}/${L} (${L ? ((k / L) * 100).toFixed(1) : "0"}%)`;
  console.log(`large caps on board       ${L}`);
  console.log(`  fails revenueStable     ${lp(large.filter((s) => !legFail(s).revenueStable).length)}`);
  console.log(`  fails cashFlowOk        ${lp(large.filter((s) => !legFail(s).cashFlowOk).length)}`);
  console.log(`  fails balanceSheetOk    ${lp(large.filter((s) => !legFail(s).balanceSheetOk).length)}`);
  console.log(
    `  D/E > 2.5 specifically  ${lp(large.filter((s) => (s.fundamentals?.debtToEquity ?? 1) > 2.5).length)}`,
  );

  console.log("");
  process.exit(0);
}

void main();
