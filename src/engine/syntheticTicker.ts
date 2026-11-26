import type { CatalystType, CompanyData, NewsItem, Sector, SourceLink } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { genSocialPosts } from "@/data/socialPosts";
import { seededRandom } from "@/lib/math";

const SECTORS: Sector[] = [
  "Technology",
  "Healthcare",
  "Financials",
  "Energy",
  "Consumer",
  "Industrials",
  "Communications",
  "Materials",
  "Utilities",
  "Real Estate",
];

const CATALYSTS: CatalystType[] = [
  "Earnings",
  "Product",
  "Regulatory",
  "Political",
  "Macro",
  "Technical",
  "Partnership",
  "Clinical",
];

function r(ticker: string, seed: string): number {
  return seededRandom(`${ticker}-${seed}`);
}

function src(label: string, ticker: string): SourceLink {
  return {
    label,
    url: `https://example-research.local/${ticker.toLowerCase()}/synthetic`,
    publishedAt: new Date().toISOString(),
  };
}

/**
 * Build fictional sample `CompanyData` for any ticker symbol.
 * Used by Ticker Lookup until a live market-data provider is connected.
 */
export function buildSyntheticCompany(ticker: string): CompanyData {
  const key = ticker.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 8);
  if (!key) throw new Error("Invalid ticker");

  const sector = SECTORS[Math.floor(r(key, "sector") * SECTORS.length)]!;
  const price = Math.max(1.2, 8 + r(key, "price") * 420);
  const return1M = (r(key, "r1m") - 0.35) * 0.55;
  const atrPct = 0.04 + r(key, "atr") * 0.12;
  const dayChange = (r(key, "day") - 0.48) * 0.08;
  const marketCap = price * (4e7 + r(key, "cap") * 8e10);
  const catalystType = CATALYSTS[Math.floor(r(key, "cat") * CATALYSTS.length)]!;
  const xMentions = Math.round(200 + r(key, "x") * 9000);
  const political = catalystType === "Political" ? Math.round(2 + r(key, "pol") * 5) : Math.round(r(key, "pol") * 3);
  const name = `${key} Holdings (sample)`;

  const priceSeries = genPriceSeries(key, price, return1M, atrPct);
  const headlines: NewsItem[] = [
    {
      headline: `${name} in focus as traders run the same signal model on ad-hoc names`,
      source: "Sample Wire",
      url: `https://example-research.local/${key.toLowerCase()}/headline-1`,
      publishedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      sentiment: 0.12,
    },
    {
      headline: `Analyst sample note: ${sector} peer relative strength mixed`,
      source: "Desk Research (fictional)",
      url: `https://example-research.local/${key.toLowerCase()}/headline-2`,
      publishedAt: new Date(Date.now() - 18 * 3600 * 1000).toISOString(),
      sentiment: 0.05,
    },
  ];

  const socialSummary =
    xMentions > 4000
      ? "Elevated X / retail mention velocity in sample social scan."
      : "Moderate social chatter in sample scan.";

  return {
    ticker: key,
    name,
    sector,
    price: Number(price.toFixed(price < 5 ? 3 : 2)),
    dayChange,
    marketCap,
    priceSeries,
    priceHistory: closesFromSeries(priceSeries),
    fundamentals: {
      revenueGrowthYoY: (r(key, "rev") - 0.2) * 0.8,
      epsGrowthYoY: (r(key, "eps") - 0.35) * 0.9,
      grossMargin: 0.25 + r(key, "gm") * 0.55,
      netMargin: (r(key, "nm") - 0.55) * 0.4,
      peRatio: r(key, "pe") > 0.25 ? 12 + r(key, "pe2") * 48 : null,
      pegRatio: r(key, "peg") > 0.4 ? 0.8 + r(key, "peg2") * 2.2 : null,
      debtToEquity: 0.2 + r(key, "de") * 1.8,
      fcfMargin: (r(key, "fcf") - 0.4) * 0.35,
    },
    momentum: {
      return1M,
      return3M: return1M * (0.6 + r(key, "r3")),
      return6M: return1M * (0.4 + r(key, "r6")),
      rsi: 28 + r(key, "rsi") * 58,
      aboveSMA50: r(key, "s50") > 0.4,
      aboveSMA200: r(key, "s200") > 0.45,
      relativeStrength3M: (r(key, "rs") - 0.5) * 0.4,
    },
    catalyst: {
      type: catalystType,
      description: `Sample ${catalystType.toLowerCase()} setup generated for lookup — not live market intelligence.`,
      daysAway: Math.round((r(key, "days") - 0.3) * 40),
      magnitude: 0.35 + r(key, "mag") * 0.55,
    },
    news: {
      items: headlines,
      sentiment: (r(key, "ns") - 0.5) * 0.6,
      count7d: Math.round(3 + r(key, "n7") * 18),
      freshnessHours: Math.round(2 + r(key, "nf") * 20),
    },
    social: {
      redditMentions24h: Math.round(xMentions * 0.35),
      xMentions24h: xMentions,
      politicalMentions: political,
      sentiment: (r(key, "ss") - 0.5) * 0.8,
      trendDelta: (r(key, "td") - 0.2) * 2.5,
      summary: socialSummary,
    },
    socialPosts: genSocialPosts({
      ticker: key,
      xMentions,
      political,
      socialSummary,
    }),
    volatility: {
      beta: 0.7 + r(key, "beta") * 1.8,
      atrPct,
      impliedVol: 0.35 + r(key, "iv") * 1.2,
    },
    liquidity: {
      avgDollarVolume: 5e6 + r(key, "liq") * 2e8,
      floatShares: 2e7 + r(key, "float") * 2e8,
    },
    risk: {
      shortInterestPct: r(key, "si") * 0.22,
      dilutionRisk: r(key, "dil") * 0.6,
      cashRunwayQuarters: 4 + r(key, "run") * 12,
      governanceFlag: r(key, "gov") * 0.35,
    },
    sources: [src("Synthetic lookup profile", key)],
  };
}
