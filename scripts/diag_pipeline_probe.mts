// IMPORTANT: bootstrap MUST be the first import (see refinement_report.mts).
import "./universe_scan/bootstrap.mjs";

import { createClient } from "@supabase/supabase-js";
import type { StockSignal } from "@/types";
import { fetchRecentSharedSignals, type SharedDailySignals } from "@/data/dailySignalsCache";
import { fetchXbrlPipelineByTicker } from "@/data/sec/xbrlPipeline";

/**
 * scripts/diag_pipeline_probe.mts - proves the SEC XBRL forward-pipeline fold
 * against the live published board BEFORE it is wired into the daily scan.
 *
 * Prints how many published names gain a real pipeline block, and the strongest
 * contracted-demand divergences (backlog growing far faster than recognized
 * revenue - the "bookings are ahead of the tape" signature).
 *
 * READ-ONLY. `vite-node scripts/diag_pipeline_probe.mts`
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
  const universe = board.signals;

  console.log(`Fetching SEC XBRL frames (RPO / contract liability / revenue)…`);
  const t0 = Date.now();
  const facts = await fetchXbrlPipelineByTicker((m) => console.log(m));
  console.log(
    `\nFetched ${facts.size} filers with disclosed pipeline facts in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
  );

  const matched = universe.filter((s) => facts.has(s.ticker));
  console.log(
    `Board coverage: ${matched.length}/${universe.length} (${((matched.length / universe.length) * 100).toFixed(1)}%) published names gain a pipeline block\n`,
  );

  const rows = matched
    .map((s) => {
      const f = facts.get(s.ticker)!;
      const revGrowth = s.fundamentals?.revenueGrowthYoY ?? 0;
      const divergence = f.backlogYoY != null ? f.backlogYoY - revGrowth : null;
      return { s, f, revGrowth, divergence };
    })
    .filter((r) => r.divergence != null)
    .sort((a, b) => (b.divergence ?? 0) - (a.divergence ?? 0));

  console.log("== TOP 25 contracted-demand divergence (backlog YoY − revenue YoY) ==");
  console.log(
    "ticker  cap$B   backlog     asOf        backlogYoY  revYoY   divergence  x-rev  offHigh",
  );
  for (const r of rows.slice(0, 25)) {
    const closes = r.s.priceHistory ?? [];
    const price = r.s.price > 0 ? r.s.price : (closes[closes.length - 1] ?? 0);
    const high = closes.length ? Math.max(price, ...closes) : 0;
    const offHigh = high > 0 ? (high - price) / high : 0;
    console.log(
      [
        r.s.ticker.padEnd(7),
        (r.s.marketCap / 1e9).toFixed(0).padStart(5),
        r.f.backlogUsd != null ? `$${(r.f.backlogUsd / 1e9).toFixed(1)}B`.padStart(9) : "        —",
        (r.f.backlogAsOf ?? "—").padStart(11),
        `${((r.f.backlogYoY ?? 0) * 100).toFixed(0)}%`.padStart(11),
        `${(r.revGrowth * 100).toFixed(0)}%`.padStart(8),
        `${((r.divergence ?? 0) * 100).toFixed(0)}pp`.padStart(11),
        r.f.backlogToRevTTM != null ? `${r.f.backlogToRevTTM.toFixed(1)}x`.padStart(6) : "     —",
        `${(offHigh * 100).toFixed(0)}%`.padStart(8),
      ].join(" "),
    );
  }

  console.log("\n== named checks ==");
  for (const t of ["ORCL", "MSFT", "META", "GOOGL", "NVDA", "BA", "LMT", "RTX"]) {
    const f = facts.get(t);
    const s = universe.find((x) => x.ticker === t);
    console.log(
      `${t.padEnd(6)} ${f ? JSON.stringify({ ...f, backlogUsd: f.backlogUsd != null ? `$${(f.backlogUsd / 1e9).toFixed(1)}B` : undefined }) : "no disclosed pipeline facts"}` +
        `${s ? `  | revYoY=${((s.fundamentals?.revenueGrowthYoY ?? 0) * 100).toFixed(1)}%` : "  | not on board"}`,
    );
  }
  console.log("");
  process.exit(0);
}

void main();
