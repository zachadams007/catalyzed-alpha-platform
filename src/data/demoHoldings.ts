import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { genSocialPosts } from "@/data/socialPosts";
import { scoreCompany } from "@/engine/scoring";
import { toStockSignal } from "@/engine/enrich";
import type {
  CatalystType,
  CompanyData,
  PortfolioHolding,
  Sector,
  StockSignal,
} from "@/types";

/**
 * Self-contained demo dataset for the shipped "TESTING" sample book.
 *
 * The sample research universe ({@link import("@/data/mockSignals").MOCK_UNIVERSE})
 * is intentionally fictional/niche, so it can't classify or value a book built on
 * REAL, recognizable tickers. To keep the TESTING demo honest AND legible for
 * demos, we author the seven demo holdings here as real-ticker {@link CompanyData}
 * specs spread across seven sectors, run them through the SAME scoring pipeline as
 * the rest of the app, and expose:
 *   • {@link TESTING_HOLDINGS} - the tracked lots (shares × cost basis),
 *   • {@link DEMO_HOLDING_SIGNALS} - full scored signals keyed by ticker, and
 *   • {@link demoHoldingPriceSeries} / {@link resolveDemoSignal} - resolvers the
 *     analytics + value-history engines fall back to.
 *
 * This guarantees the allocation rings show real sectors (never "Unclassified"),
 * every lot carries a live price + P/L, and the progression chart bakes a real,
 * non-linear curve - regardless of which research universe is loaded. It is
 * sample-only: a live tester never sees the TESTING book at all.
 */

interface DemoSpec {
  ticker: string;
  name: string;
  sector: Sector;
  price: number;
  dayChange: number;
  marketCap: number;
  /** 1-month total return - drives the baked price-series shape (curve, not line). */
  return1M: number;
  atrPct: number;
  catalystType: CatalystType;
  catalystDescription: string;
  catalystDaysAway: number;
  /** Tracked position. */
  shares: number;
  costBasis: number;
}

// Real, recognizable names - one per sector - with cost bases tuned around the
// quoted price so the book reads as a believable mix of winners and laggards.
const DEMO_SPECS: DemoSpec[] = [
  {
    ticker: "AAPL",
    name: "Apple Inc.",
    sector: "Technology",
    price: 232.4,
    dayChange: 0.011,
    marketCap: 3.5e12,
    return1M: 0.067,
    atrPct: 0.018,
    catalystType: "Product",
    catalystDescription: "Fall hardware cycle + on-device AI rollout drawing upgrade demand.",
    catalystDaysAway: 12,
    shares: 60,
    costBasis: 198.0, // winner
  },
  {
    ticker: "JNJ",
    name: "Johnson & Johnson",
    sector: "Healthcare",
    price: 158.2,
    dayChange: 0.004,
    marketCap: 3.8e11,
    return1M: 0.021,
    atrPct: 0.012,
    catalystType: "Clinical",
    catalystDescription: "Late-stage pipeline readouts and steady dividend support.",
    catalystDaysAway: 21,
    shares: 90,
    costBasis: 151.5, // modest winner
  },
  {
    ticker: "JPM",
    name: "JPMorgan Chase & Co.",
    sector: "Financials",
    price: 244.9,
    dayChange: 0.008,
    marketCap: 6.9e11,
    return1M: 0.038,
    atrPct: 0.014,
    catalystType: "Earnings",
    catalystDescription: "Net-interest-income beat expected; capital-return commentary in focus.",
    catalystDaysAway: 9,
    shares: 45,
    costBasis: 225.0, // winner
  },
  {
    ticker: "XOM",
    name: "Exxon Mobil Corporation",
    sector: "Energy",
    price: 113.6,
    dayChange: -0.006,
    marketCap: 5.0e11,
    return1M: -0.028,
    atrPct: 0.016,
    catalystType: "Macro",
    catalystDescription: "Crude pulled back on demand worries; buyback pace a swing factor.",
    catalystDaysAway: 17,
    shares: 120,
    costBasis: 121.0, // laggard
  },
  {
    ticker: "NEE",
    name: "NextEra Energy, Inc.",
    sector: "Utilities",
    price: 78.4,
    dayChange: 0.003,
    marketCap: 1.6e11,
    return1M: 0.014,
    atrPct: 0.013,
    catalystType: "Regulatory",
    catalystDescription: "Rate-case progress and renewables backlog underpin the growth story.",
    catalystDaysAway: 28,
    shares: 150,
    costBasis: 72.5, // winner
  },
  {
    ticker: "CAT",
    name: "Caterpillar Inc.",
    sector: "Industrials",
    price: 392.7,
    dayChange: 0.015,
    marketCap: 1.9e11,
    return1M: 0.052,
    atrPct: 0.02,
    catalystType: "Earnings",
    catalystDescription: "Infrastructure + data-center build-out lifting machinery backlog.",
    catalystDaysAway: 14,
    shares: 24,
    costBasis: 348.0, // winner
  },
  {
    ticker: "AMZN",
    name: "Amazon.com, Inc.",
    sector: "Consumer",
    price: 219.3,
    dayChange: -0.009,
    marketCap: 2.3e12,
    return1M: -0.015,
    atrPct: 0.022,
    catalystType: "Earnings",
    catalystDescription: "AWS reacceleration vs. retail-margin questions into the print.",
    catalystDaysAway: 6,
    shares: 70,
    costBasis: 205.0, // modest winner / near flat
  },
];

const NOW = Date.now();
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

/** Expand a compact demo spec into a full {@link CompanyData} record. */
function buildDemoCompany(spec: DemoSpec): CompanyData {
  const priceSeries = genPriceSeries(spec.ticker, spec.price, spec.return1M, spec.atrPct);
  const up = spec.return1M >= 0;
  return {
    ticker: spec.ticker,
    name: spec.name,
    sector: spec.sector,
    price: spec.price,
    dayChange: spec.dayChange,
    marketCap: spec.marketCap,
    priceSeries,
    priceHistory: closesFromSeries(priceSeries),
    fundamentals: {
      revenueGrowthYoY: up ? 0.12 : 0.04,
      epsGrowthYoY: up ? 0.15 : 0.03,
      grossMargin: 0.42,
      netMargin: 0.18,
      peRatio: 24,
      pegRatio: 1.6,
      debtToEquity: 0.5,
      fcfMargin: 0.16,
    },
    momentum: {
      return1M: spec.return1M,
      return3M: spec.return1M * 2.4,
      return6M: spec.return1M * 3.6,
      rsi: up ? 58 : 44,
      aboveSMA50: up,
      aboveSMA200: spec.return1M > -0.05,
      relativeStrength3M: spec.return1M,
    },
    catalyst: {
      type: spec.catalystType,
      description: spec.catalystDescription,
      daysAway: spec.catalystDaysAway,
      magnitude: 0.6,
    },
    news: {
      items: [
        {
          headline: `${spec.name} in focus ahead of ${spec.catalystType.toLowerCase()} catalyst`,
          source: "MarketWire",
          url: `https://example-research.local/${spec.ticker.toLowerCase()}/focus`,
          publishedAt: iso(0),
          sentiment: up ? 0.4 : -0.1,
        },
      ],
      sentiment: up ? 0.35 : -0.05,
      count7d: 14,
      freshnessHours: 4,
    },
    social: {
      redditMentions24h: 600,
      xMentions24h: 2400,
      politicalMentions: 0,
      sentiment: up ? 0.3 : 0.05,
      trendDelta: up ? 0.2 : -0.1,
      summary: `Steady investor attention on ${spec.ticker}.`,
    },
    socialPosts: genSocialPosts({
      ticker: spec.ticker,
      xMentions: 2400,
      political: 0,
      socialSummary: `Steady investor attention on ${spec.ticker}.`,
    }),
    volatility: {
      beta: 1.0,
      atrPct: spec.atrPct,
      impliedVol: 0.28,
    },
    liquidity: {
      avgDollarVolume: 3e9,
      floatShares: spec.marketCap / spec.price,
    },
    risk: {
      shortInterestPct: 0.02,
      dilutionRisk: 0.02,
      cashRunwayQuarters: 40,
      governanceFlag: 0,
    },
    sources: [
      { label: "Company investor relations", url: `https://example-research.local/${spec.ticker.toLowerCase()}/ir` },
    ],
  };
}

const DEMO_COMPANIES: CompanyData[] = DEMO_SPECS.map(buildDemoCompany);

const GENERATED_AT = new Date(NOW).toISOString();

/** Full scored signals for the demo holdings, keyed by (upper-case) ticker. */
export const DEMO_HOLDING_SIGNALS: Record<string, StockSignal> = Object.fromEntries(
  DEMO_COMPANIES.map((company) => [
    company.ticker,
    toStockSignal(company, scoreCompany(company), GENERATED_AT),
  ]),
);

const DEMO_PRICE_SERIES = new Map(DEMO_COMPANIES.map((c) => [c.ticker, c.priceSeries]));

/** The tracked demo lots, in display order (one recognizable name per sector). */
export const TESTING_HOLDINGS: PortfolioHolding[] = DEMO_SPECS.map((spec) => ({
  ticker: spec.ticker,
  addedAt: iso(10),
  shares: spec.shares,
  costBasis: spec.costBasis,
}));

/** Fallback signal resolver - lets analytics classify/value the demo book. */
export function resolveDemoSignal(ticker: string): StockSignal | undefined {
  return DEMO_HOLDING_SIGNALS[ticker.trim().toUpperCase()];
}

/** Fallback price-series resolver - feeds the baked value-history reconstruction. */
export function demoHoldingPriceSeries(ticker: string) {
  return DEMO_PRICE_SERIES.get(ticker.trim().toUpperCase());
}
