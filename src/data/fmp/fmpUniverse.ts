import type { CompanyData } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { fmpScreener, type FmpScreenerRow } from "@/data/fmp/fmpClient";
import { yahooQuoteUrl } from "@/lib/links";
import { isPlausibleMarketCap } from "@/lib/format";

/**
 * Niche-discovery screens. FMP returns active, real tickers - this is how we
 * surface names beyond a hardcoded list (small/micro growth, themed sectors).
 */
const DISCOVERY_SCREENS: Array<{ label: string } & Parameters<typeof fmpScreener>[0]> = [
  { label: "Micro tech growth", marketCapMoreThan: 25_000_000, marketCapLowerThan: 2_000_000_000, betaMoreThan: 1.05, volumeMoreThan: 150_000, sector: "Technology", limit: 45 },
  { label: "Small tech growth", marketCapMoreThan: 2_000_000_000, marketCapLowerThan: 10_000_000_000, betaMoreThan: 1.0, volumeMoreThan: 200_000, sector: "Technology", limit: 30 },
  { label: "Healthcare niche", marketCapMoreThan: 25_000_000, marketCapLowerThan: 5_000_000_000, volumeMoreThan: 150_000, sector: "Healthcare", limit: 30 },
  { label: "Industrials robotics", marketCapMoreThan: 50_000_000, marketCapLowerThan: 10_000_000_000, volumeMoreThan: 150_000, sector: "Industrials", limit: 24 },
  { label: "Space aerospace", marketCapMoreThan: 50_000_000, marketCapLowerThan: 12_000_000_000, volumeMoreThan: 150_000, sector: "Industrials", limit: 18 },
  { label: "Energy clean", marketCapMoreThan: 25_000_000, marketCapLowerThan: 8_000_000_000, volumeMoreThan: 150_000, sector: "Energy", limit: 20 },
  { label: "High-beta movers", marketCapMoreThan: 25_000_000, marketCapLowerThan: 20_000_000_000, betaMoreThan: 1.7, volumeMoreThan: 300_000, limit: 36 },
  { label: "All micro liquid", marketCapMoreThan: 25_000_000, marketCapLowerThan: 1_000_000_000, volumeMoreThan: 250_000, limit: 36 },
];

function clampPrice(p: number): number {
  return Number(p.toFixed(p < 5 ? 3 : 2));
}

/** Build CompanyData from a screener row + modeled baseline (cheap, no extra calls). */
export function companyFromScreenerRow(row: FmpScreenerRow): CompanyData | null {
  const ticker = row.symbol?.trim().toUpperCase();
  const price = row.price;
  if (!ticker || !price || price <= 0) return null;

  // LIVE universe: a name must carry a REAL, sane market cap. We must never
  // fabricate one from the synthetic baseline - a synthetic cap is
  // price × (4e7 + rand × 8e10), which lands in the trillions and would paint a
  // garbage tile on the Market Map (the "NNE $24.95T" bug). A screener row with
  // no usable cap is dropped: better to omit a name than to size it on a lie.
  if (!isPlausibleMarketCap(row.marketCap)) return null;
  const realCap = row.marketCap;

  const synthetic = buildSyntheticCompany(ticker);
  const priceSeries = genPriceSeries(ticker, price, synthetic.momentum.return1M, synthetic.volatility.atrPct);
  if (priceSeries.length) {
    const last = priceSeries[priceSeries.length - 1]!.close;
    const scale = last > 0 ? price / last : 1;
    for (const pt of priceSeries) pt.close = clampPrice(pt.close * scale);
  }

  return {
    ...synthetic,
    ticker,
    name: row.companyName?.trim() || synthetic.name.replace(" (sample)", ""),
    price: clampPrice(price),
    marketCap: realCap,
    priceSeries,
    priceHistory: closesFromSeries(priceSeries),
    volatility: { ...synthetic.volatility, beta: row.beta ?? synthetic.volatility.beta },
    liquidity: {
      ...synthetic.liquidity,
      avgDollarVolume: row.volume ? row.volume * price : synthetic.liquidity.avgDollarVolume,
    },
    fundamentalsAvailability: {
      revenueGrowthYoY: false,
      epsGrowthYoY: false,
      grossMargin: false,
      netMargin: false,
      peRatio: false,
      pegRatio: false,
      debtToEquity: false,
      fcfMargin: false,
    },
    catalyst: {
      ...synthetic.catalyst,
      description: "Discovered via FMP screener; fundamentals & news refresh on the research run.",
    },
    catalystLive: false,
    sources: [
      { label: "FMP screener", url: yahooQuoteUrl(ticker), publishedAt: new Date().toISOString() },
    ],
  };
}

/** Run the discovery screens and de-dupe into a niche universe. */
export async function discoverFmpUniverse(maxNames = 60): Promise<CompanyData[]> {
  const seen = new Set<string>();
  const companies: CompanyData[] = [];

  for (const screen of DISCOVERY_SCREENS) {
    const rows = await fmpScreener(screen);
    for (const row of rows) {
      const sym = row.symbol?.trim().toUpperCase();
      if (!sym || seen.has(sym)) continue;
      const company = companyFromScreenerRow(row);
      if (!company) continue;
      seen.add(sym);
      companies.push(company);
      if (companies.length >= maxNames) return companies;
    }
  }

  return companies;
}
