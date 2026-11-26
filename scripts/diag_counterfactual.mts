// IMPORTANT: bootstrap MUST be the first import (see refinement_report.mts).
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";
import type { StockSignal } from "@/types";
import { fetchRecentSharedSignals, type SharedDailySignals } from "@/data/dailySignalsCache";
import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import { postProcessUniverse } from "@/engine/challenger";
import { buildArchetypeContext, type NormalizationContext } from "@/engine/normalizeUniverse";
import { buildMarketRegimeContext } from "@/engine/regime";
import { reversalReadiness } from "@/engine/reversalReadiness";
import { isAlpacaConfigured } from "@/data/http";
import { fetchDailyBars } from "@/data/alpaca/bars";

/**
 * scripts/diag_counterfactual.mts - "where would this name rank AT A DIFFERENT
 * PRICE?"
 *
 * The owner asked whether Microsoft would be top-ten if it were still ~$375 rather than
 * the ~$465 it has run to. That is a testable question, not a matter of opinion,
 * so this answers it by re-pricing the name and re-running the identical ranking
 * pass - every other input held constant.
 *
 * It rewrites `price` and rescales the trailing closes by the same factor, so the
 * drawdown, RSI-band and own-high readings all move consistently with the new
 * price rather than being left describing the old one.
 *
 * READ-ONLY.
 *   vite-node scripts/diag_counterfactual.mts MSFT=375 SOFI=25
 */

const ARGS = process.argv.slice(2);

async function fetchBoardDirect(): Promise<SharedDailySignals | null> {
  const url = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const anon = process.env["VITE_SUPABASE_ANON_KEY"] || process.env["SUPABASE_ANON_KEY"] || "";
  if (!url || !anon) return null;
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
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

async function buildContext(universe: StockSignal[]): Promise<NormalizationContext> {
  const archetypes = buildArchetypeContext(universe);
  if (!isAlpacaConfigured()) {
    return { archetypes, regime: buildMarketRegimeContext({ spyCloses: [], signals: universe }) };
  }
  const spyCloses = await fetchDailyBars("SPY", 260).catch(() => [] as number[]);
  return { archetypes, regime: buildMarketRegimeContext({ spyCloses, signals: universe }) };
}

function rankIn(list: StockSignal[], ticker: string): number {
  return list.findIndex((s) => s.ticker === ticker) + 1;
}

async function main(): Promise<void> {
  let board = await fetchRecentSharedSignals();
  if (!board) board = await fetchBoardDirect();
  if (!board) {
    console.error("ERROR: could not load daily_signals board.");
    process.exit(1);
  }
  const base = board.signals;
  const generatedAt = new Date().toISOString();
  const ctx = await buildContext(base);
  const ranked = [...postProcessUniverse(base, "v6", ctx)].sort(
    (a, b) => b.score.opportunityScore - a.score.opportunityScore,
  );

  console.log(`Board ${board.marketDay} — ${base.length} names\n`);

  for (const arg of ARGS) {
    const [rawTicker, rawPrice] = arg.split("=");
    const ticker = (rawTicker ?? "").trim().toUpperCase();
    const newPrice = Number(rawPrice);
    const current = base.find((s) => s.ticker === ticker);
    if (!current || !Number.isFinite(newPrice) || newPrice <= 0) {
      console.log(`${ticker}: not on the board, or bad price argument\n`);
      continue;
    }

    // Re-price: scale the trailing closes by the same factor so the drawdown and
    // range readings describe the counterfactual price, not the real one.
    const factor = newPrice / current.price;
    const repriced = {
      ...current,
      price: newPrice,
      priceSeries: current.priceSeries ?? [],
      priceHistory: (current.priceHistory ?? []).map((c, i, arr) =>
        // Leave the far history untouched and taper the recent window toward the
        // counterfactual, so we model "it never ran" rather than "the whole chart
        // shifted".
        i > arr.length - 60 ? c * factor : c,
      ),
      marketCap: current.marketCap * factor,
    };
    const scenario = base.map((s) =>
      s.ticker === ticker ? toStockSignal(repriced, scoreCompany(repriced), generatedAt) : s,
    );
    const scenarioCtx = await buildContext(scenario);
    const scenarioRanked = [...postProcessUniverse(scenario, "v6", scenarioCtx)].sort(
      (a, b) => b.score.opportunityScore - a.score.opportunityScore,
    );

    const before = rankIn(ranked, ticker);
    const after = rankIn(scenarioRanked, ticker);
    const beforeScore = ranked.find((s) => s.ticker === ticker)?.score.opportunityScore;
    const afterScore = scenarioRanked.find((s) => s.ticker === ticker)?.score.opportunityScore;
    const rr = reversalReadiness(repriced);

    console.log(`${ticker}: $${current.price.toFixed(2)} → $${newPrice.toFixed(2)}`);
    console.log(`  rank  #${before} (${beforeScore}) → #${after} (${afterScore})`);
    console.log(
      `  readiness ${rr.readiness.toFixed(2)}  knifeVeto ${rr.fallingKnifeVeto}  ` +
        `deceleration ${rr.deceleration.toFixed(2)}  basing ${rr.basing.toFixed(2)}\n`,
    );
  }

  // Always report the CURRENT readiness diagnostics for anything named, since a
  // zeroed readiness is the usual reason a cheap name is not ranking.
  console.log("== current reversal-readiness for the named tickers ==");
  for (const arg of ARGS) {
    const ticker = (arg.split("=")[0] ?? "").trim().toUpperCase();
    const s = base.find((x) => x.ticker === ticker);
    if (!s) continue;
    const rr = reversalReadiness(s);
    console.log(
      `${ticker.padEnd(6)} readiness ${rr.readiness.toFixed(2)}  knifeVeto ${rr.fallingKnifeVeto}  ` +
        `decel ${rr.deceleration.toFixed(2)}  basing ${rr.basing.toFixed(2)}  ` +
        `freshShock ${rr.freshShock}  1M ${((s.momentum?.return1M ?? 0) * 100).toFixed(0)}%  RSI ${Math.round(s.momentum?.rsi ?? 0)}`,
    );
  }
  console.log("");
  process.exit(0);
}

void main();
