import type {
  CompanyData,
  KeyFundamental,
  ScoreBreakdown,
  ScoreCategory,
  StockSignal,
} from "@/types";
import {
  bucketForMarketCap,
  formatPct,
  formatPctPlain,
  freshnessLabel,
  riskLevelFromPenalty,
} from "@/lib/format";
import { buildFeedAnalystCoverage } from "@/data/analyst/fetchAnalystCoverage";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { describeCompany } from "@/data/symbols/companyDescriptions";
import { computeHype } from "./hype";

/**
 * Turn raw CompanyData + its ScoreBreakdown into a display-ready StockSignal.
 * All the human-facing copy (thesis, key stats, notes) is generated here so the
 * card/detail components stay purely presentational.
 */

function topCategories(categories: ScoreCategory[], n: number): ScoreCategory[] {
  return [...categories].sort((a, b) => b.score - a.score).slice(0, n);
}

function buildThesis(c: CompanyData, breakdown: ScoreBreakdown): string {
  // No live market data - don't manufacture a thesis from modeled inputs.
  if (c.marketDataUnavailable === "directory") {
    return `${c.name} is a real listing, but we have no live market data for it yet — price, fundamentals, sector, and catalyst are unavailable, so there's nothing to assess here right now. It populates once a research run can quote it.`;
  }
  if (c.marketDataUnavailable === "sample") {
    return `Sample profile for ${c.name} — illustrative figures only, not live market data. Add a market-data key to research this name for real.`;
  }

  const [first, second] = topCategories(breakdown.categories, 2);
  const strengths =
    first && second
      ? `${first.label.toLowerCase()} and ${second.label.toLowerCase()}`
      : (first?.label.toLowerCase() ?? "a balanced profile");

  // Live record with no dated catalyst yet - don't invent one.
  if (c.catalystLive === false) {
    return `${c.name} stands out on ${strengths}. No dated catalyst in the live feed yet — this read is driven by price action, fundamentals, and attention.`;
  }

  const cat = c.catalyst;
  const timing =
    cat.daysAway < 0
      ? `that fired ${Math.abs(cat.daysAway)}d ago`
      : cat.daysAway === 0
        ? "landing today"
        : `~${cat.daysAway}d out`;

  return `${c.name} stands out on ${strengths}, set against a ${cat.type.toLowerCase()} catalyst ${timing}. ${cat.description}`;
}

const NA_HINT = "Not in the live feed";

function buildKeyFundamentals(c: CompanyData): KeyFundamental[] {
  const f = c.fundamentals;
  const av = c.fundamentalsAvailability;
  // When availability is tracked (live record), only show fields the feed
  // actually returned. Sample/modeled universe (no map) renders as before.
  const live = (key: keyof typeof f): boolean => (av ? av[key] === true : true);
  const na: Pick<KeyFundamental, "value" | "tone" | "hint"> = {
    value: "N/A",
    tone: "neutral",
    hint: NA_HINT,
  };

  const out: KeyFundamental[] = [
    live("revenueGrowthYoY")
      ? {
          label: "Rev Growth",
          value: formatPct(f.revenueGrowthYoY),
          tone: f.revenueGrowthYoY > 0.2 ? "positive" : f.revenueGrowthYoY < 0 ? "negative" : "neutral",
        }
      : { label: "Rev Growth", ...na },
    live("epsGrowthYoY")
      ? {
          label: "EPS Growth",
          value: formatPct(f.epsGrowthYoY),
          tone: f.epsGrowthYoY > 0 ? "positive" : "negative",
        }
      : { label: "EPS Growth", ...na },
    live("grossMargin")
      ? {
          label: "Gross Margin",
          value: formatPctPlain(f.grossMargin),
          tone: f.grossMargin > 0.5 ? "positive" : "neutral",
        }
      : { label: "Gross Margin", ...na },
    live("netMargin")
      ? {
          label: "Net Margin",
          value: formatPctPlain(f.netMargin),
          tone: f.netMargin > 0 ? "positive" : "negative",
        }
      : { label: "Net Margin", ...na },
    live("peRatio")
      ? {
          label: "P/E",
          value: f.peRatio == null ? "N/A" : `${f.peRatio.toFixed(0)}x`,
          tone: "neutral",
        }
      : { label: "P/E", ...na },
    live("debtToEquity")
      ? {
          label: "Debt/Equity",
          value: `${f.debtToEquity.toFixed(2)}x`,
          tone: f.debtToEquity < 0.6 ? "positive" : f.debtToEquity > 1.5 ? "negative" : "neutral",
        }
      : { label: "Debt/Equity", ...na },
  ];
  return out;
}

function buildNewsInsight(c: CompanyData): string {
  const top = c.news.items[0];
  if (!top) return `${c.news.count7d} stories in the last 7 days.`;
  return `"${top.headline}" — ${top.source}, ${freshnessLabel(c.news.freshnessHours)}.`;
}

function buildMomentumNote(c: CompanyData): string {
  if (c.marketDataUnavailable === "directory") {
    return "Momentum unavailable — no live price history for this listing.";
  }
  const m = c.momentum;
  const structure =
    m.aboveSMA50 && m.aboveSMA200 ? "above 50/200-day" : m.aboveSMA50 ? "above 50-day" : "below 50-day";
  return `${formatPct(m.return3M)} 3M · RSI ${Math.round(m.rsi)} · ${structure} · ${(
    c.liquidity.avgDollarVolume / 1e6
  ).toFixed(0)}M/day`;
}

/**
 * Specific industry phrases keyed off Finnhub's finer `finnhubIndustry` label
 * (e.g. "Semiconductors", "Aerospace & Defense", "Banking"). Ordered
 * most-specific-first so "semiconductor"/"software" win over the broad
 * "technology" catch-all. Substring/regex match keeps it resilient to Finnhub's
 * label variants. Anything unmapped falls back to the broad-sector phrase below,
 * so the grammar is always clean and we never fabricate.
 */
const INDUSTRY_PHRASES: Array<[RegExp, string]> = [
  [/semiconductor/i, "a semiconductor company"],
  [/aerospace|defense|defence/i, "an aerospace & defense company"],
  [/software|saas/i, "a software company"],
  [/biotech/i, "a biotechnology company"],
  [/pharmaceutic|pharma/i, "a pharmaceutical company"],
  [/medical|life sciences|health ?care/i, "a healthcare company"],
  [/bank/i, "a bank"],
  [/insurance/i, "an insurance company"],
  [/financial|asset management|capital markets|brokerage/i, "a financial-services company"],
  [/airline/i, "an airline"],
  [/automobil|auto manufact|vehicle|ev /i, "an automotive company"],
  [/oil|gas|energy|renewable/i, "an energy company"],
  [/retail/i, "a retail company"],
  [/restaurant|hotel|leisure|hospitality|gaming|travel/i, "a hospitality & leisure company"],
  [/food|beverage|tobacco/i, "a food & beverage company"],
  [/telecom/i, "a telecommunications company"],
  [/internet|media|entertainment|publishing|advertis/i, "an internet & media company"],
  [/real estate|reit/i, "a real estate company"],
  [/utilit/i, "a utilities company"],
  [/chemical|metals|mining|materials|steel|paper|forest/i, "a materials company"],
  [/transport|logistic|railroad|trucking|marine|shipping|airfreight/i, "a logistics & transportation company"],
  [/machinery|industrial|manufactur|construction|electrical equipment|engineering/i, "an industrials company"],
  [/technology/i, "a technology company"],
];

/**
 * One-sentence plain-English descriptor of what the company does. Prefers
 * Finnhub's specific industry (so "Rocket Lab is an aerospace & defense company",
 * not just "an industrials company"); falls back to the broad sector. Sourced
 * from real data only - returns undefined for no-data listings or sample
 * profiles, never fabricates.
 */
function buildCompanyBlurb(c: CompanyData): string | undefined {
  if (c.marketDataUnavailable) return undefined;
  const name = c.name?.trim();
  if (!name) return undefined;

  // Prefer a curated, factual "what this company does" line. The bulk scan's
  // finnhubIndustry is throttled to null for most names, so without this every
  // blurb collapses to the useless "X is a <sector> company" fallback below.
  const curated = describeCompany(c.ticker);
  if (curated) return curated;

  const industry = c.finnhubIndustry?.trim();
  if (industry) {
    for (const [re, phrase] of INDUSTRY_PHRASES) {
      if (re.test(industry)) return `${name} is ${phrase}.`;
    }
  }

  const sectorPhrases: Partial<Record<string, string>> = {
    Technology: "a technology company",
    Healthcare: "a healthcare and life sciences company",
    Financials: "a financial services company",
    Energy: "an energy company",
    Consumer: "a consumer company",
    Industrials: "an industrials company",
    Communications: "a communications and media company",
    Materials: "a materials company",
    Utilities: "a utilities company",
    "Real Estate": "a real estate company",
  };

  const phrase = sectorPhrases[c.sector];
  if (!phrase) return undefined;

  return `${name} is ${phrase}.`;
}

function buildSocialSummary(c: CompanyData): string {
  const political =
    c.social.politicalMentions > 0
      ? ` · ${c.social.politicalMentions} political/insider mention(s)`
      : "";
  return `${c.social.summary}${political}`;
}

export function toStockSignal(
  c: CompanyData,
  breakdown: ScoreBreakdown,
  generatedAt: string,
): StockSignal {
  return {
    ...c,
    // Sample-only flavor fields some live / shared-cache sources omit. Normalize
    // to empty arrays so every signal in the store carries a valid shape - the
    // engine (narrativeBlob, scoring) and UI can read them without guards.
    socialPosts: c.socialPosts ?? [],
    id: c.ticker,
    score: breakdown,
    marketCapBucket: bucketForMarketCap(c.marketCap),
    riskLevel: riskLevelFromPenalty(breakdown.riskPenalty),
    confidence: breakdown.confidence,
    catalystType: c.catalyst.type,
    generatedAt,
    thesis: buildThesis(c, breakdown),
    companyBlurb: buildCompanyBlurb(c),
    newsInsight: buildNewsInsight(c),
    momentumNote: buildMomentumNote(c),
    socialSummary: buildSocialSummary(c),
    keyFundamentals: buildKeyFundamentals(c),
    hype: computeHype(c, breakdown),
    // Seed the illustrative sample consensus ONLY in Sample data mode. In live
    // mode this MUST stay undefined so panels start empty/links-only and fill
    // from the real fetch - never seeded-random dollar targets under a live badge.
    analyst: isSampleDataModeEnabled() ? buildFeedAnalystCoverage(c.ticker, c.price) : undefined,
  };
}
