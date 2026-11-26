import type { CompanyData, CrossListing } from "@/types";
import { closesFromSeries, genPriceSeries } from "@/data/priceSeries";
import { fetchFinnhubCompany } from "@/data/finnhub/liveCompany";
import { fetchFinnhubMetrics, applyLiveFundamentalsToCompany } from "@/data/finnhub/liveFundamentals";
import { fetchYahooHistory, applyLiveHistoryToCompany } from "@/data/prices/yahooHistory";
import { fetchYahooChart } from "@/data/prices/yahooChart";
import { fetchLiveNews } from "@/data/news/liveNews";
import { applyLiveNewsToCompany } from "@/data/news/enrichCompanyNews";
import { finnhubKey } from "@/data/http";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";
import { isCuratedResearchTicker } from "@/data/realUniverse";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";
import { MOCK_UNIVERSE } from "@/data/mockSignals";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { MARKET_MAJORS } from "@/data/symbols/majors.generated";
import {
  resolveListings,
  listingCurrency,
  exchangeShortLabel,
  exchangeTier,
  type ListingResolution,
  type ResolvedListing,
} from "@/data/symbols/listingResolver";
import { finnhubSymbolUrl } from "@/lib/analystLinks";
import { yahooQuoteUrl } from "@/lib/links";

/** Dated-but-trusted market caps for the majors roster. On the keyless Yahoo path
 * (no live cap field), backfilling a KNOWN major's cap from this roster keeps a
 * megacap - e.g. an AI-discovered NVDA/MRVL - out of the "Unknown" bucket so cap
 * filters classify it correctly (Mega) instead of treating it as a data gap.
 * Mirrors heatmapModel's TRUSTED_CAP; majors only (no synthetic fabrication). */
const ROSTER_CAP = new Map<string, number>(
  MARKET_MAJORS.map((m) => [m.ticker.toUpperCase(), m.marketCap] as const),
);
function rosterCapFor(symbol: string): number {
  return ROSTER_CAP.get(symbol.toUpperCase()) ?? 0;
}

/** Source label that marks a card as directory-backed with no live market data. */
export const DIRECTORY_SOURCE_LABEL = "Offline symbol directory · live market data unavailable";

/** Source label that marks a card whose real quote + chart came from Yahoo Finance. */
export const YAHOO_SOURCE_LABEL = "Yahoo Finance · live quote & chart";

/** Map a listing resolution to the brokerage-style cross-listing surface. */
function crossListingsFrom(resolution: ListingResolution): CrossListing[] | undefined {
  if (resolution.alternates.length === 0) return undefined;
  const toEntry = (
    l: { symbol: string; exchangeLabel: string; country: "US" | "CA"; currency: string },
    isPrimary: boolean,
  ): CrossListing => ({
    symbol: l.symbol,
    exchangeLabel: l.exchangeLabel,
    country: l.country,
    currency: l.currency,
    isPrimary,
  });
  return [
    toEntry(resolution.primary, true),
    ...resolution.alternates.map((a) => toEntry(a, false)),
  ];
}

/**
 * Stamp a company with its headline-listing labels (exchange + currency) and the
 * dual-listing surface, so a US (Finnhub) lookup also advertises its TSX twin and
 * a TSX (Yahoo) lookup is clearly labeled CAD. Additive - leaves market data
 * untouched.
 */
function attachListings(company: CompanyData, resolution: ListingResolution | null): CompanyData {
  if (!resolution) return company;
  const { primary } = resolution;
  return {
    ...company,
    currency: company.currency ?? primary.currency,
    listingExchange: company.listingExchange ?? primary.exchangeLabel,
    listingCountry: company.listingCountry ?? primary.country,
    crossListings: company.crossListings ?? crossListingsFrom(resolution),
  };
}

/**
 * Build a REAL company from the keyless Yahoo chart endpoint for the resolution's
 * PRIMARY listing - the universal coverage path that finally prices TSX (.TO/.V)
 * names and any US listing without a keyed provider. ONE network call yields a
 * real spot price, day change, currency, exchange, the price series (→ chart +
 * real momentum) and the listed name. Fundamentals + market cap are honestly
 * marked unavailable (Yahoo's keyless chart doesn't expose them) - never
 * fabricated. Returns null when Yahoo has no usable quote for the symbol.
 */
async function buildYahooCompany(resolution: ListingResolution): Promise<CompanyData | null> {
  const primary = resolution.primary;
  const symbol = primary.symbol;
  const chart = await fetchYahooChart(symbol, "1y").catch(() => null);
  if (!chart) return null;

  const closes = chart.closes;
  const lastClose = closes.length ? closes[closes.length - 1]! : undefined;
  const price = chart.meta.regularMarketPrice ?? lastClose;
  if (!price || price <= 0) return null;

  // Day change vs the PRIOR daily close. meta.chartPreviousClose is the close
  // before the whole range window (i.e. ~1 year ago for range=1y), so it would
  // turn the "day change" into a 1-year return. Derive the prior close from the
  // series instead: the last bar tracks the current session, the bar before it
  // is the prior close. Fall back to the meta close only when there's no series.
  const priorClose =
    closes.length >= 2
      ? closes[closes.length - 2]!
      : (chart.meta.chartPreviousClose ?? chart.meta.previousClose ?? price);
  const dayChange = priorClose > 0 ? (price - priorClose) / priorClose : 0;
  const currency = chart.meta.currency || listingCurrency(primary.country);
  const exchangeLabel =
    chart.meta.fullExchangeName?.trim() || primary.exchangeLabel || exchangeShortLabel(primary.exchange);

  // Structurally-complete skeleton (modeled momentum/volatility/liquidity/risk),
  // then every fabricated *market* number is replaced or zeroed below.
  const skeleton = buildSyntheticCompany(symbol);
  const name =
    chart.meta.longName?.trim() ||
    chart.meta.shortName?.trim() ||
    getSymbol(symbol)?.name ||
    skeleton.name.replace(" (sample)", "");

  let company: CompanyData = {
    ...skeleton,
    ticker: symbol,
    name,
    price: Number(price.toFixed(price < 5 ? 4 : 2)),
    dayChange,
    // Yahoo's keyless chart has no market cap. For a KNOWN major we backfill the
    // dated trusted-roster cap (so an AI-discovered NVDA/MRVL classifies as Mega,
    // not "Unknown"); for everything else it stays 0 → "Unknown" (honest N/A,
    // never invented - the cap gate treats Unknown as N/A, not a fail).
    marketCap: rosterCapFor(symbol),
    currency,
    listingExchange: primary.exchangeLabel,
    listingCountry: primary.country,
    crossListings: crossListingsFrom(resolution),
    priceSeries: chart.series,
    priceHistory: chart.closes,
    // No live fundamentals on this path → scored neutral, rendered "N/A".
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
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 9_999 },
    social: {
      redditMentions24h: 0,
      xMentions24h: 0,
      politicalMentions: 0,
      sentiment: 0,
      trendDelta: 0,
      summary: "No live social data for this listing yet.",
    },
    socialPosts: [],
    catalyst: {
      ...skeleton.catalyst,
      description: `Live ${exchangeLabel} quote & chart via Yahoo Finance (${currency}); catalyst refreshes from headlines on the next research run.`,
    },
    catalystLive: false,
    sources: [
      {
        label: YAHOO_SOURCE_LABEL,
        url: yahooQuoteUrl(symbol),
        publishedAt: new Date().toISOString(),
      },
    ],
  };

  // Real momentum from the real series (needs ≥30 closes; else stays modeled).
  company = applyLiveHistoryToCompany(company, { series: chart.series, closes: chart.closes });
  return company;
}

/**
 * A real, directory-confirmed listing for which the live provider returned no
 * quote (common for Canadian listings Finnhub's free tier doesn't price). We
 * keep the real name + exchange and HONESTLY mark price, market cap, history,
 * fundamentals, news and social as unavailable - the engine then scores the
 * unavailable fundamentals as neutral, the card renders "N/A", and confidence
 * drops. This is the live-mode alternative to a fabricated synthetic price card.
 */
function buildDirectoryCompany(symbol: string): CompanyData {
  const key = symbol.trim().toUpperCase();
  const record = getSymbol(key);
  const ticker = record?.symbol ?? key;
  // Reuse the synthetic skeleton purely for a structurally-complete, NaN-free
  // shape (modeled momentum/volatility/liquidity/risk, same posture as a live
  // lookup) - then strip every fabricated *market* number below.
  const skeleton = buildSyntheticCompany(ticker);
  const name = record?.name ?? ticker;
  const exchange = record?.exchange ?? "its listing exchange";

  return {
    ...skeleton,
    ticker,
    name,
    // No live quote: zero the market data rather than inventing it.
    price: 0,
    dayChange: 0,
    marketCap: 0,
    priceHistory: [],
    priceSeries: [],
    // We have NO live data for this real listing - flag it so every
    // market-derived surface renders "unavailable" instead of a seeded value.
    marketDataUnavailable: "directory",
    // Neutralize the modeled blocks the skeleton seeded at random so nothing
    // (sector aside, which the UI suppresses) carries a fabricated number even
    // if a display gate is ever missed - the engine then scores it honestly flat.
    momentum: {
      return1M: 0,
      return3M: 0,
      return6M: 0,
      rsi: 50,
      aboveSMA50: false,
      aboveSMA200: false,
      relativeStrength3M: 0,
    },
    volatility: { beta: 1, atrPct: 0, impliedVol: 0 },
    liquidity: { avgDollarVolume: 0, floatShares: 0 },
    risk: {
      shortInterestPct: 0,
      dilutionRisk: 0,
      cashRunwayQuarters: 0,
      governanceFlag: 0,
    },
    // Flag all fundamentals unavailable → scored neutral, rendered "N/A".
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
    news: { items: [], sentiment: 0, count7d: 0, freshnessHours: 9_999 },
    social: {
      redditMentions24h: 0,
      xMentions24h: 0,
      politicalMentions: 0,
      sentiment: 0,
      trendDelta: 0,
      summary: "No live social data for this listing yet.",
    },
    socialPosts: [],
    catalyst: {
      type: skeleton.catalyst.type,
      // Neutral magnitude/timing - there is no real catalyst to characterize.
      magnitude: 0,
      daysAway: 0,
      description: `${name} is a real ${exchange} listing from the offline directory, but the live data provider returned no quote — price, fundamentals, and catalysts are unavailable for it right now.`,
    },
    catalystLive: false,
    sources: [
      {
        label: DIRECTORY_SOURCE_LABEL,
        url: finnhubSymbolUrl(ticker),
        publishedAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Upgrade a live Finnhub company with the same real data the research pipeline
 * uses (price history, fundamentals, headlines) so a one-off lookup is just as
 * honest as a universe run - fields the feed lacks read "N/A", never fabricated.
 */
async function enrichLiveCompany(company: CompanyData): Promise<CompanyData> {
  // Fetch all three live sources CONCURRENTLY - they're independent (price
  // history, fundamentals, headlines each touch different fields), so awaiting
  // them in series just stacked three round-trips of latency on the exact
  // "open a fresh ticker from the leaderboard" path flagged as slow. Each source
  // still degrades on its own: a failed history/news keeps modeled fallback, and
  // fetchFinnhubMetrics returns null -> all-N/A fundamentals.
  const [history, metrics, news] = await Promise.allSettled([
    fetchYahooHistory(company.ticker),
    fetchFinnhubMetrics(company.ticker),
    fetchLiveNews(company.ticker),
  ]);
  let enriched = company;
  if (history.status === "fulfilled") {
    enriched = applyLiveHistoryToCompany(enriched, history.value);
  }
  enriched = applyLiveFundamentalsToCompany(
    enriched,
    metrics.status === "fulfilled" ? metrics.value : null,
  );
  if (news.status === "fulfilled") {
    enriched = applyLiveNewsToCompany(enriched, news.value);
  }
  return enriched;
}

function curatedMockCompany(key: string): CompanyData | undefined {
  const hit = MOCK_UNIVERSE.find((c) => c.ticker === key);
  if (!hit) return undefined;
  const priceSeries = genPriceSeries(hit.ticker, hit.price, hit.momentum.return1M, hit.volatility.atrPct);
  return { ...hit, priceSeries, priceHistory: closesFromSeries(priceSeries) };
}

/** A fictional lookup profile, flagged so the UI labels it "SAMPLE - not live". */
function sampleCompany(key: string): CompanyData {
  return { ...buildSyntheticCompany(key), marketDataUnavailable: "sample" };
}

/** Mock demo ticker, Finnhub quote (when keyed), or a synthesized profile for ad-hoc symbols. */
export function companyForTicker(ticker: string): CompanyData {
  const key = ticker.trim().toUpperCase();
  if (!finnhubKey()) {
    const curated = curatedMockCompany(key);
    if (curated) return curated;
  }
  return sampleCompany(key);
}

/**
 * Async lookup. Order of preference for a REAL listed name:
 *   1. keyed US provider (Finnhub) - adds fundamentals/news on US tickers,
 *   2. keyless Yahoo chart - the universal coverage path that prices TSX
 *      (.TO/.V) and any US listing without a key (real quote + chart + momentum),
 *   3. honest directory-backed card (price/fundamentals "N/A") when nothing real
 *      is reachable. Synthetic profiles are reserved for unknown symbols / the
 *      Sample-data demo and are always clearly labeled.
 */
export async function companyForTickerAsync(ticker: string): Promise<CompanyData> {
  const key = ticker.trim().toUpperCase();
  const resolution = resolveListings(key);

  if (!finnhubKey()) {
    // Sample / keyless mode: curated demo first.
    const curated = curatedMockCompany(key);
    if (curated) return curated;
    // A real directory listing still gets REAL data, free, via Yahoo (US +
    // Canada) - unless the explicit Sample-data toggle forbids live requests.
    if (resolution && !isSampleDataModeEnabled()) {
      const yahoo = await buildYahooCompany(resolution);
      if (yahoo) return yahoo;
    }
    // Unknown symbol (or Yahoo had nothing): A's honest, clearly-labeled sample
    // (sets the "sample" flag so the UI shows the SAMPLE banner - never unlabeled).
    return sampleCompany(key);
  }

  // LIVE mode - keyed US provider first (fundamentals/news/analyst on US names).
  const live = await fetchFinnhubCompany(key);
  if (live) return attachListings(await enrichLiveCompany(live), resolution);

  // Keyless Yahoo path for everything the US-only free tier misses - most
  // importantly TSX (.TO/.V) listings like GCU.TO. Real quote + chart, labeled.
  if (resolution) {
    const yahoo = await buildYahooCompany(resolution);
    if (yahoo) return yahoo;
  }

  // Nothing real anywhere: honest directory-backed card (price/fundamentals N/A).
  return attachListings(buildDirectoryCompany(key), resolution);
}

export function isCuratedUniverseTicker(ticker: string): boolean {
  const key = ticker.trim().toUpperCase();
  if (finnhubKey()) return isCuratedResearchTicker(key);
  return MOCK_UNIVERSE.some((c) => c.ticker === key);
}
