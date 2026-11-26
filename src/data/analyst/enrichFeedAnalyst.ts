import type { AnalystCoverage, StockSignal } from "@/types";
import {
  buildFeedAnalystCoverage,
  fetchAnalystCoverage,
  linksOnlyCoverage,
} from "@/data/analyst/fetchAnalystCoverage";
import { isFinnhubConfigured } from "@/data/http";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";

const FINNHUB_GAP_MS = 420;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Attach analyst coverage to every feed signal and fill the session cache.
 * Uses Finnhub when keyed; otherwise keeps the sample baseline from enrich.
 */
export async function enrichSignalsWithAnalyst(signals: StockSignal[]): Promise<{
  signals: StockSignal[];
  cache: Record<string, AnalystCoverage>;
}> {
  const cache: Record<string, AnalystCoverage> = {};
  const enriched: StockSignal[] = [];
  const throttle = isFinnhubConfigured();

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    let coverage: AnalystCoverage;
    try {
      coverage = await fetchAnalystCoverage(s.ticker, s.price);
    } catch {
      // Live mode must NEVER fabricate seeded-random sample numbers on failure.
      // Keep any existing coverage; otherwise fall back to links-only (honest
      // empty consensus). Sample numbers only when Sample data mode is ON.
      coverage =
        s.analyst ??
        (isSampleDataModeEnabled()
          ? buildFeedAnalystCoverage(s.ticker, s.price)
          : linksOnlyCoverage(s.ticker, s.price));
    }
    cache[s.ticker] = coverage;
    enriched.push({ ...s, analyst: coverage });
    if (throttle && i < signals.length - 1) await delay(FINNHUB_GAP_MS);
  }

  return { signals: enriched, cache };
}
