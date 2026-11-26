import type { CompanyData, Sector } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import {
  fmpCashFlowStatement,
  fmpFinancialGrowth,
  fmpIncomeStatement,
  fmpProfile,
  fmpQuote,
  fmpRatios,
  type FmpScreenerRow,
} from "@/data/fmp/fmpClient";
import { yahooQuoteUrl } from "@/lib/links";
import { isPlausibleMarketCap } from "@/lib/format";
import { unknownFundamentals } from "@/data/fundamentals/fundamentalsProvenance";
import { resolveSector } from "@/data/symbols/sectorOverrides";

const SECTOR_MAP: Record<string, Sector> = {
  technology: "Technology",
  "information technology": "Technology",
  healthcare: "Healthcare",
  "health care": "Healthcare",
  "financial services": "Financials",
  financials: "Financials",
  energy: "Energy",
  "consumer cyclical": "Consumer",
  "consumer defensive": "Consumer",
  industrials: "Industrials",
  "communication services": "Communications",
  "basic materials": "Materials",
  materials: "Materials",
  utilities: "Utilities",
  "real estate": "Real Estate",
};

function mapSector(ticker: string, raw?: string): Sector {
  const fallback = raw ? (SECTOR_MAP[raw.toLowerCase()] ?? "Technology") : "Technology";
  // A curated override wins over the raw provider mapping - see sectorOverrides.ts
  // for why (sector-neutralization integrity; some names' raw industry string
  // misses every SECTOR_MAP needle and silently falls back to "Technology").
  return resolveSector(ticker, fallback);
}

function clampPrice(p: number): number {
  return Number(p.toFixed(p < 5 ? 3 : 2));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ratio(numerator?: number, denominator?: number): number | null {
  const n = finite(numerator);
  const d = finite(denominator);
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

/**
 * Build CompanyData from FMP quote + profile + ratios. Live fields: price,
 * day change, market cap, sector, fundamentals, beta, volume. Momentum / news /
 * social remain modeled (news is refreshed live in the research pipeline).
 */
export async function fetchFmpCompany(
  symbol: string,
  seed?: Partial<FmpScreenerRow>,
): Promise<CompanyData | null> {
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;

  const [quote, profile, ratios, growth, income, cashFlow] = await Promise.all([
    fmpQuote(ticker),
    fmpProfile(ticker),
    fmpRatios(ticker),
    fmpFinancialGrowth(ticker),
    fmpIncomeStatement(ticker),
    fmpCashFlowStatement(ticker),
  ]);

  const price = quote?.price ?? profile?.price ?? seed?.price;
  if (!price || price <= 0) return null;

  const synthetic = buildSyntheticCompany(ticker);
  // `/stable` renamed several fields. Read the stable name FIRST and keep the
  // legacy `/api/v3` alias as the fallback, so a grandfathered legacy key and a
  // current stable key both resolve through this one reader.
  const rawDayChangePct = quote?.changePercentage ?? quote?.changesPercentage;
  const dayChange = rawDayChangePct != null ? rawDayChangePct / 100 : synthetic.dayChange;
  // REAL cap only - never fall back to the synthetic baseline (price × random ×
  // 8e10 lands in the trillions and paints a garbage Market Map tile, the
  // "$24.95T" bug). When no live source has a sane cap, leave it 0 (honest
  // "unknown"); the heatmap filters 0 out and other surfaces show "unknown".
  const rawCap = quote?.marketCap ?? profile?.marketCap ?? profile?.mktCap ?? seed?.marketCap;
  const marketCap = isPlausibleMarketCap(rawCap) ? rawCap : 0;
  const beta = profile?.beta ?? seed?.beta ?? synthetic.volatility.beta;
  const avgVol = quote?.avgVolume ?? profile?.averageVolume ?? profile?.volAvg ?? seed?.volume;
  const revenueGrowthYoY = finite(growth?.revenueGrowth);
  const epsGrowthYoY = finite(growth?.epsdilutedGrowth) ?? finite(growth?.epsgrowth);
  const grossMargin = finite(ratios?.grossProfitMarginTTM) ?? ratio(income?.grossProfit, income?.revenue);
  const netMargin = finite(ratios?.netProfitMarginTTM) ?? ratio(income?.netIncome, income?.revenue);
  const fcfMargin = ratio(cashFlow?.freeCashFlow, income?.revenue);
  const peRatio = finite(ratios?.priceToEarningsRatioTTM) ?? finite(ratios?.peRatioTTM);
  const pegRatio =
    finite(ratios?.priceToEarningsGrowthRatioTTM) ?? finite(ratios?.priceEarningsToGrowthRatioTTM);
  const debtToEquity = finite(ratios?.debtToEquityRatioTTM) ?? finite(ratios?.debtEquityRatioTTM);

  // Honest fundamentals (A-1 invariant): start from a NEUTRAL placeholder, never
  // the synthetic PRNG seed. A field is overwritten ONLY when its FMP value is
  // non-null, so a missing field stays neutral (and reads "N/A" via the
  // all-gated-off availability map below) instead of leaking a fabricated seed.
  // fundamentalsAvailability[X] === true  IFF  fundamentals.X is a real FMP value.
  const placeholder = unknownFundamentals();

  const priceSeries = genPriceSeries(ticker, price, synthetic.momentum.return1M, synthetic.volatility.atrPct).map(
    (pt) => ({ ...pt }),
  );
  // anchor last close to live spot
  if (priceSeries.length) {
    const last = priceSeries[priceSeries.length - 1]!.close;
    const scale = last > 0 ? price / last : 1;
    for (const pt of priceSeries) pt.close = clampPrice(pt.close * scale);
  }

  return {
    ...synthetic,
    ticker,
    name: quote?.name ?? profile?.companyName ?? seed?.companyName ?? synthetic.name.replace(" (sample)", ""),
    sector: mapSector(ticker, profile?.sector ?? quote?.sector ?? seed?.sector),
    price: clampPrice(price),
    dayChange,
    marketCap,
    priceSeries,
    priceHistory: closesFromSeries(priceSeries),
    fundamentals: {
      ...placeholder,
      revenueGrowthYoY: revenueGrowthYoY ?? placeholder.revenueGrowthYoY,
      epsGrowthYoY: epsGrowthYoY ?? placeholder.epsGrowthYoY,
      grossMargin: grossMargin ?? placeholder.grossMargin,
      netMargin: netMargin ?? placeholder.netMargin,
      peRatio: peRatio ?? placeholder.peRatio,
      pegRatio: pegRatio ?? placeholder.pegRatio,
      debtToEquity: debtToEquity ?? placeholder.debtToEquity,
      fcfMargin: fcfMargin ?? placeholder.fcfMargin,
    },
    fundamentalsAvailability: {
      revenueGrowthYoY: revenueGrowthYoY != null,
      epsGrowthYoY: epsGrowthYoY != null,
      grossMargin: grossMargin != null,
      netMargin: netMargin != null,
      peRatio: peRatio != null,
      pegRatio: pegRatio != null,
      debtToEquity: debtToEquity != null,
      fcfMargin: fcfMargin != null,
    },
    volatility: { ...synthetic.volatility, beta },
    liquidity: {
      ...synthetic.liquidity,
      avgDollarVolume: avgVol ? avgVol * price : synthetic.liquidity.avgDollarVolume,
    },
    catalyst: {
      ...synthetic.catalyst,
      description: "Live FMP fundamentals; catalyst refreshes from headlines on the research run.",
    },
    catalystLive: false,
    sources: [
      {
        label: "Financial Modeling Prep",
        url: yahooQuoteUrl(ticker),
        publishedAt: new Date().toISOString(),
      },
    ],
  };
}
