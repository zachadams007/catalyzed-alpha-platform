import type { ScoreCategoryKey, StockSignal } from "@/types";
import type { HoldingRow } from "@/engine/portfolioAnalytics";

/**
 * Portfolio insight engine. Reads each holding's live signal + position and
 * surfaces *research* prompts - never buy/sell orders (hard product constraint).
 * Pure and deterministic so it can be unit-tested and recomputed server-side.
 */

export type InsightTone = "opportunity" | "watch" | "risk" | "info";

export interface PortfolioInsight {
  id: string;
  ticker: string;
  tone: InsightTone;
  title: string;
  detail: string;
}

const TONE_RANK: Record<InsightTone, number> = {
  opportunity: 0,
  risk: 1,
  watch: 2,
  info: 3,
};

function cat(signal: StockSignal, key: ScoreCategoryKey): number {
  return signal.score.categories.find((c) => c.key === key)?.score ?? 50;
}

type Lookup = (ticker: string) => StockSignal | undefined;

export function derivePortfolioInsights(
  rows: HoldingRow[],
  lookup: Lookup,
  limit = 8,
): PortfolioInsight[] {
  const out: PortfolioInsight[] = [];

  for (const row of rows) {
    const signal = lookup(row.ticker);
    if (!signal) continue;

    const opp = signal.score.opportunityScore;
    const valuation = cat(signal, "valuation"); // high = discounted entry
    const catalyst = cat(signal, "catalyst");
    const day = row.dayChange ?? signal.dayChange ?? 0;
    const risk = signal.score.riskPenalty;
    const plPct = row.plPct;

    const push = (tone: InsightTone, title: string, detail: string) =>
      out.push({ id: `${row.ticker}-${tone}-${out.length}`, ticker: row.ticker, tone, title, detail });

    // Discounted entry + live catalyst - the setup the feed weights most.
    if (catalyst >= 65 && valuation >= 60) {
      push(
        "opportunity",
        `${row.ticker} · discount + catalyst`,
        `Trading at a healthy discount with a live catalyst (catalyst ${Math.round(catalyst)}, entry timing ${Math.round(valuation)}). This is the discounted-with-news setup you wanted weighted highest.`,
      );
    } else if (day <= -0.03 && opp >= 68) {
      // Pullback in an otherwise strong name.
      push(
        "opportunity",
        `${row.ticker} · pullback, signal intact`,
        `Down ${Math.abs(day * 100).toFixed(1)}% today but the overall signal is still strong (${opp}). Worth researching whether the thesis is unchanged.`,
      );
    }

    // Stretched / chasing a top.
    if (valuation <= 35 && day >= 0.02) {
      push(
        "watch",
        `${row.ticker} · entry looks stretched`,
        `Up ${(day * 100).toFixed(1)}% and trading near the top of its range (entry timing ${Math.round(valuation)}). Adding here means chasing strength.`,
      );
    } else if (day >= 0.03 && opp < 50) {
      push(
        "watch",
        `${row.ticker} · momentum ahead of setup`,
        `Up ${(day * 100).toFixed(1)}% today but the underlying signal is soft (${opp}). Momentum may be running ahead of the fundamentals.`,
      );
    }

    // Risk model flag.
    if (risk >= 12) {
      push(
        "risk",
        `${row.ticker} · risk model flag`,
        `The risk model is subtracting ${Math.round(risk)} pts (${signal.score.riskExplanation}). Review before adding to this position.`,
      );
    }

    // Position-level prompts (need a tracked position with P/L).
    if (plPct != null && plPct <= -0.15) {
      push(
        "watch",
        `${row.ticker} · position down ${Math.round(Math.abs(plPct) * 100)}%`,
        `Your position is down ${(plPct * 100).toFixed(1)}%. Decide whether the original thesis still applies or it's dead money.`,
      );
    } else if (plPct != null && plPct >= 0.3) {
      push(
        "info",
        `${row.ticker} · up ${Math.round(plPct * 100)}%`,
        `Your position is up ${(plPct * 100).toFixed(1)}%. Consider whether to trim into strength or let the winner run.`,
      );
    }
  }

  return out
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])
    .slice(0, limit);
}
