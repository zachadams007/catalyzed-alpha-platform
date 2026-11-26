import { MOCK_UNIVERSE } from "@/data/mockSignals";

// Pure URL builders + predicates live in a dependency-free leaf module so
// `socialPosts` can use them without importing this file (which pulls in
// MOCK_UNIVERSE). Re-exported here so existing `@/lib/links` imports are
// unchanged. See src/lib/externalUrls.ts for why (import-cycle break).
export {
  externalNewsSearchUrl,
  externalWebSearchUrl,
  yahooQuoteUrl,
  externalXSearchUrl,
  isSampleResearchUrl,
  isDirectNewsUrl,
  newsItemHref,
  sourceItemHref,
  type NewsLinkContext,
} from "./externalUrls";

// Built lazily: mockSignals → socialPosts → links forms an import cycle, so
// reading MOCK_UNIVERSE at module-eval time crashes when links is loaded before
// mockSignals finishes initializing. Defer it to first call instead.
let sampleUniverseTickers: Set<string> | null = null;
function getSampleUniverseTickers(): Set<string> {
  if (sampleUniverseTickers === null) {
    sampleUniverseTickers = new Set(MOCK_UNIVERSE.map((c) => c.ticker.toUpperCase()));
  }
  return sampleUniverseTickers;
}

/** Tickers in the curated mock feed are fictional - not listed on TradingView. */
export function isSampleUniverseTicker(ticker: string): boolean {
  return getSampleUniverseTickers().has(ticker.trim().toUpperCase());
}

/** TradingView chart for a U.S. ticker. Sample-universe tickers open search instead. */
export function externalChartUrl(
  ticker: string,
  exchange: "NASDAQ" | "NYSE" | "AMEX" = "NASDAQ",
): string {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return "https://www.tradingview.com/";

  if (isSampleUniverseTicker(symbol)) {
    return `https://www.tradingview.com/symbols/?search=${encodeURIComponent(symbol)}`;
  }

  return `https://www.tradingview.com/chart/?symbol=${exchange}:${encodeURIComponent(symbol)}`;
}
