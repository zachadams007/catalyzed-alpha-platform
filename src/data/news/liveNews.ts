import type { NewsItem } from "@/types";
import {
  finnhubKey,
  isFmpKeyPresent,
  isPlanBlocked,
  httpJson,
  httpText,
  nextFmpKey,
  notePlanBlocked,
} from "@/data/http";
import { fetchAlpacaNews } from "@/data/news/alpacaNews";
import { selectRelevantLiveNews, type LiveNewsCandidate } from "@/data/news/newsSelection";
import { isSampleUniverseTicker } from "@/lib/links";

const FINNHUB = "https://finnhub.io/api/v1";
const FMP = "https://financialmodelingprep.com/stable";
const YAHOO_RSS = "https://feeds.finance.yahoo.com/rss/2.0/headline";
const STOCKTWITS = "https://api.stocktwits.com/api/2/streams/symbol";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function parseYahooRss(xml: string): LiveNewsCandidate[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];

  return Array.from(doc.querySelectorAll("item"))
    .slice(0, 10)
    .map((item) => {
      const headline = item.querySelector("title")?.textContent?.trim() ?? "";
      const url = item.querySelector("link")?.textContent?.trim() ?? "";
      const pub = item.querySelector("pubDate")?.textContent?.trim() ?? "";
      const publishedAt = pub ? new Date(pub).toISOString() : new Date().toISOString();
      return {
        headline,
        source: "Yahoo Finance",
        sourceId: "yahoo" as const,
        url,
        publishedAt,
        sentiment: 0,
      };
    })
    .filter((n) => n.headline.length > 0 && n.url.startsWith("http"));
}

interface FinnhubArticle {
  headline?: string;
  source?: string;
  url?: string;
  datetime?: number;
  summary?: string;
  related?: string;
}

interface FmpArticle {
  symbol?: string;
  title?: string;
  site?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
}

interface StockTwitsMessage {
  id?: number;
  body?: string;
  created_at?: string;
  user?: { username?: string };
}

interface StockTwitsResponse {
  symbol?: { symbol?: string };
  messages?: StockTwitsMessage[];
}

function splitRelatedSymbols(input?: string): string[] {
  return input
    ? input
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function providerSource(provider: "finnhub" | "fmp", publisher?: string): string {
  const clean = publisher?.trim();
  const label = provider === "finnhub" ? "Finnhub" : "FMP";
  return clean && clean.toLowerCase() !== label.toLowerCase() ? `${label} / ${clean}` : label;
}

async function fetchFinnhubNews(ticker: string, key: string): Promise<LiveNewsCandidate[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 86_400_000);
  const url =
    `${FINNHUB}/company-news?symbol=${encodeURIComponent(ticker)}` +
    `&from=${isoDate(from)}&to=${isoDate(to)}&token=${encodeURIComponent(key)}`;

  const rows = await httpJson<FinnhubArticle[] | { error?: string }>(url);
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r) => r.headline && r.url)
    .slice(0, 10)
    .map((r) => ({
      headline: r.headline!,
      source: providerSource("finnhub", r.source),
      sourceId: "finnhub" as const,
      url: r.url!,
      publishedAt: new Date((r.datetime ?? 0) * 1000).toISOString(),
      sentiment: 0,
      summary: r.summary,
      symbols: splitRelatedSymbols(r.related),
    }));
}

async function fetchYahooNews(ticker: string): Promise<LiveNewsCandidate[]> {
  const url = `${YAHOO_RSS}?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  const xml = await httpText(url);
  return parseYahooRss(xml);
}

/**
 * FMP company news. `/stable/news/stock` is a PAID endpoint - a free key gets
 * HTTP 402 for every ticker (and the old `/api/v3/stock_news` route is retired
 * entirely, HTTP 403). Finnhub company-news + Yahoo RSS + StockTwits already
 * cover this surface, so the lane trips off after the first refusal instead of
 * spending a failed call per scanned name.
 */
async function fetchFmpNews(ticker: string, key: string): Promise<LiveNewsCandidate[]> {
  if (isPlanBlocked("fmp", "/news/stock")) return [];
  const url =
    `${FMP}/news/stock?symbols=${encodeURIComponent(ticker)}` +
    `&limit=12&apikey=${encodeURIComponent(key)}`;
  let rows: FmpArticle[] | { "Error Message"?: string };
  try {
    rows = await httpJson<FmpArticle[] | { "Error Message"?: string }>(url);
  } catch (err) {
    const e = err as { status?: number; body?: string };
    if (e?.status === 402 || e?.status === 403) {
      notePlanBlocked("fmp", "/news/stock", e.status, e.body ?? "");
    }
    return [];
  }
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r) => r.title && r.url)
    .slice(0, 12)
    .map((r) => ({
      headline: r.title!.trim(),
      source: providerSource("fmp", r.site),
      sourceId: "fmp" as const,
      url: r.url!,
      publishedAt: safeIso(r.publishedDate),
      sentiment: 0,
      body: r.text,
      symbols: r.symbol ? [r.symbol] : [],
    }));
}

async function fetchStockTwitsNews(ticker: string): Promise<LiveNewsCandidate[]> {
  const symbol = ticker.trim().toUpperCase();
  const res = await httpJson<StockTwitsResponse>(`${STOCKTWITS}/${encodeURIComponent(symbol)}.json`);
  const messages = res.messages ?? [];

  return messages
    .filter((m) => m.body && m.id && m.user?.username)
    .slice(0, 8)
    .map((m) => ({
      headline: m.body!.trim().slice(0, 220),
      source: "StockTwits",
      sourceId: "stocktwits" as const,
      url: `https://stocktwits.com/${m.user!.username}/message/${m.id}`,
      publishedAt: safeIso(m.created_at),
      sentiment: 0,
      body: m.body,
      symbols: [res.symbol?.symbol ?? symbol],
    }));
}

export interface FetchLiveNewsOptions {
  /**
   * Detail/ticker-click calls can fan out to every proxy-backed source. Broad
   * universe enrichment keeps this false to avoid spending FMP + StockTwits once
   * per scanned name.
   */
  includeHighFanoutSources?: boolean;
  limit?: number;
}

/**
 * Pull recent headlines with real article URLs, filtered to the requested ticker.
 * Fictional sample-universe tickers usually return nothing from vendors.
 */
export async function fetchLiveNews(
  ticker: string,
  options: FetchLiveNewsOptions = {},
): Promise<NewsItem[]> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return [];

  const includeHighFanoutSources = options.includeHighFanoutSources ?? true;
  const batches: LiveNewsCandidate[][] = [];

  // Alpaca first - a real-time wire (Benzinga et al.) with direct article URLs.
  try {
    batches.push(await fetchAlpacaNews(symbol));
  } catch {
    /* keep other sources available */
  }

  const fhKey = finnhubKey();
  if (fhKey) {
    try {
      batches.push(await fetchFinnhubNews(symbol, fhKey));
    } catch {
      /* keep other sources available */
    }
  }

  // FMP company-news is per-name. Broad scans keep the old local-key-only
  // behavior; detail/ticker-click calls may use the proxy for multi-source coverage.
  const fmKey = nextFmpKey();
  if (fmKey && (includeHighFanoutSources || isFmpKeyPresent())) {
    try {
      batches.push(await fetchFmpNews(symbol, fmKey));
    } catch {
      /* keep other sources available */
    }
  }

  if (includeHighFanoutSources) {
    try {
      batches.push(await fetchStockTwitsNews(symbol));
    } catch {
      /* keep other sources available */
    }
  }

  try {
    batches.push(await fetchYahooNews(symbol));
  } catch {
    /* no RSS fallback */
  }

  return selectRelevantLiveNews(symbol, batches.flat(), { limit: options.limit ?? 18 });
}

export function isLikelyLiveTicker(ticker: string): boolean {
  return !isSampleUniverseTicker(ticker);
}
