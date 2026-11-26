// IMPORTANT: bootstrap MUST be the first import (see refinement_report.mts).
import "./universe_scan/bootstrap.mjs";

import { fetchXbrlPipelineByTicker } from "@/data/sec/xbrlPipeline";
import { computeOwnHistoryValuation } from "@/engine/valuationHistory";
import { fetchDailyBars } from "@/data/alpaca/bars";

/**
 * scripts/diag_valuation_history.mts - show the OWN-HISTORY valuation working
 * (or not) for named tickers, with every input it used.
 *
 * Built because Amazon came back "middling" against its own history, which
 * contradicted the expectation that it is cheap versus its past. This prints the
 * disclosed revenue/net-income series, the price the model paired with each
 * fiscal year, and both percentiles - so a wrong answer is attributable to a
 * specific input rather than argued about.
 *
 * READ-ONLY. `vite-node scripts/diag_valuation_history.mts AMZN MSFT NVDA`
 */

const TICKERS = (process.argv.slice(2).length ? process.argv.slice(2) : ["AMZN"]).map((t) =>
  t.trim().toUpperCase(),
);

const b = (v: number) => `$${(v / 1e9).toFixed(1)}B`;

async function main(): Promise<void> {
  console.log("Fetching SEC XBRL annual frames…");
  const facts = await fetchXbrlPipelineByTicker();
  const asOf = new Date();

  for (const ticker of TICKERS) {
    const f = facts.get(ticker);
    console.log(`\n${"=".repeat(70)}\n${ticker}\n${"=".repeat(70)}`);
    if (!f) {
      console.log("no XBRL facts at all");
      continue;
    }
    console.log("revenueByYear:  ", (f.revenueByYear ?? []).map((r) => `${r.period}=${b(r.revenue)}`).join("  ") || "—");
    console.log("netIncomeByYear:", (f.netIncomeByYear ?? []).map((r) => `${r.period}=${b(r.netIncome)}`).join("  ") || "—");

    const closes = await fetchDailyBars(ticker, 1500).catch(() => [] as number[]);
    console.log(`closes fetched: ${closes.length} (need >=400)`);
    if (closes.length === 0) continue;
    const price = closes[closes.length - 1]!;
    console.log(`latest close:   $${price.toFixed(2)}`);

    const own = computeOwnHistoryValuation(f.revenueByYear, closes, price, asOf, f.netIncomeByYear);
    if (!own) {
      console.log("RESULT: null — not enough disclosed history to say anything honest");
      continue;
    }
    console.log(
      `RESULT: percentile ${own.percentile.toFixed(2)} ` +
        `(sales ${own.salesPercentile.toFixed(2)}, earnings ${own.earningsPercentile?.toFixed(2) ?? "n/a"})`,
    );
    console.log(
      `  revenue CAGR ${(own.revenueCagr * 100).toFixed(1)}%  price CAGR ${(own.priceCagr * 100).toFixed(1)}%  ` +
        `divergence ${(own.divergence * 100).toFixed(1)}pp over ${own.years}y`,
    );
    console.log(
      `  0.00 = cheapest it has been vs itself · 1.00 = most expensive · feeds scoreValuation at weight 0.25`,
    );
  }
  console.log("");
  process.exit(0);
}

void main();
