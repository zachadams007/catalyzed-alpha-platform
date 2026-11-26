import {
  companyForTickerAsync,
  isCuratedUniverseTicker,
  DIRECTORY_SOURCE_LABEL,
  YAHOO_SOURCE_LABEL,
} from "@/data/companyLookup";
import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import type { StockSignal } from "@/types";

export function isCuratedTicker(ticker: string): boolean {
  return isCuratedUniverseTicker(ticker);
}

function hasSource(company: { sources: { label: string }[] }, needle: string): boolean {
  return company.sources.some((s) => s.label.toLowerCase().includes(needle.toLowerCase()));
}

function enrichLookupSignal(company: Awaited<ReturnType<typeof companyForTickerAsync>>, key: string): StockSignal {
  const generatedAt = new Date().toISOString();
  const signal = toStockSignal(company, scoreCompany(company), generatedAt);
  const curated = isCuratedTicker(key);
  const finnhubLive = !curated && hasSource(company, "finnhub") && company.price > 0;
  const yahooLive = !curated && hasSource(company, YAHOO_SOURCE_LABEL) && company.price > 0;
  const directoryBacked = !curated && hasSource(company, DIRECTORY_SOURCE_LABEL);

  // A directory-confirmed listing with no live quote is neither synthetic nor
  // curated. Label it honestly by omitting provenance (no false "live Finnhub"
  // or "sample" banner) - the card already carries the "live market data
  // unavailable" source, N/A fundamentals, and a $0 (unavailable) price.
  // A Yahoo-sourced quote (the keyless TSX / coverage path) is real market data,
  // so it gets its own honest "yahoo" provenance.
  const lookupProvenance: StockSignal["lookupProvenance"] = curated
    ? "curated"
    : finnhubLive
      ? "finnhub"
      : yahooLive
        ? "yahoo"
        : directoryBacked
          ? undefined
          : "synthetic";

  return {
    ...signal,
    isLookup: !curated,
    lookupProvenance,
  };
}

/** Async lookup - resolves Finnhub quote/profile when configured. */
export async function lookupSignalAsync(ticker: string): Promise<StockSignal> {
  const key = ticker.trim().toUpperCase();
  const company = await companyForTickerAsync(key);
  return enrichLookupSignal(company, key);
}
