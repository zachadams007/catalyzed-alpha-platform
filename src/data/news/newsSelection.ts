import type { NewsItem } from "@/types";

export type LiveNewsSourceId =
  | "benzinga"
  | "finnhub"
  | "fmp"
  | "stocktwits"
  | "yahoo"
  | "alpaca"
  | "other";

export interface LiveNewsCandidate extends NewsItem {
  /** Provider/source bucket used only for filtering, dedupe, and diversity. */
  sourceId?: LiveNewsSourceId;
  /** Vendor-reported related symbols. If present, this is the relevance authority. */
  symbols?: string[];
  /** Optional body text used for strong ticker mention fallback. */
  summary?: string;
  body?: string;
}

interface SelectNewsOptions {
  limit?: number;
}

const SOURCE_LABELS: Record<LiveNewsSourceId, string> = {
  alpaca: "Alpaca",
  benzinga: "Benzinga",
  finnhub: "Finnhub",
  fmp: "FMP",
  stocktwits: "StockTwits",
  yahoo: "Yahoo Finance",
  other: "Other",
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "for",
  "from",
  "in",
  "into",
  "is",
  "its",
  "of",
  "on",
  "or",
  "over",
  "shares",
  "stock",
  "the",
  "to",
  "with",
]);

function normalizeTicker(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/^\$/, "");
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  return s.replace(/\s+/g, "");
}

function symbolMatches(candidateSymbol: string, requested: string): boolean {
  const normalized = normalizeTicker(candidateSymbol);
  return normalized === requested || normalized.replace(/[.-].+$/, "") === requested;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStrongTickerMention(text: string, ticker: string): boolean {
  if (!text.trim()) return false;

  const symbol = escapeRegExp(ticker);
  const tokenStart = "(^|[^A-Z0-9])";
  const tokenEnd = "(?=$|[^A-Z0-9])";

  const cashtag = new RegExp(`${tokenStart}\\$${symbol}${tokenEnd}`, "i");
  if (cashtag.test(text)) return true;

  const exchangePrefix = new RegExp(
    `${tokenStart}(NASDAQ|NYSE|AMEX|OTC|CBOE|NYSEAMERICAN|NYSE ARCA)\\s*[:/-]\\s*${symbol}${tokenEnd}`,
    "i",
  );
  if (exchangePrefix.test(text)) return true;

  const parenthetical = new RegExp(`[(\\[]\\s*${symbol}\\s*[)\\]]`);
  if (parenthetical.test(text)) return true;

  // Bare ticker tokens are only trusted when vendors omit symbol metadata but
  // the headline/body itself carries the uppercase market symbol.
  if (ticker.length >= 3) {
    const bareToken = new RegExp(`${tokenStart}${symbol}${tokenEnd}`);
    return bareToken.test(text);
  }

  return false;
}

export function isNewsRelevantToTicker(item: LiveNewsCandidate, ticker: string): boolean {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return false;

  const listedSymbols = item.symbols?.map(normalizeTicker).filter(Boolean) ?? [];
  if (listedSymbols.length > 0) {
    return listedSymbols.some((s) => symbolMatches(s, symbol));
  }

  const text = [item.headline, item.summary, item.body].filter(Boolean).join(" ");
  return hasStrongTickerMention(text, symbol);
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function headlineTokens(headline: string): Set<string> {
  const words = headline
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9$]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^\$/, ""))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap++;
  }
  return overlap / Math.min(a.size, b.size);
}

function nearDuplicate(a: LiveNewsCandidate, b: LiveNewsCandidate): boolean {
  if (canonicalUrl(a.url) === canonicalUrl(b.url)) return true;
  const aTokens = headlineTokens(a.headline);
  const bTokens = headlineTokens(b.headline);
  return tokenSimilarity(aTokens, bTokens) >= 0.82;
}

function sourceBucket(item: LiveNewsCandidate): LiveNewsSourceId | string {
  if (item.sourceId) return item.sourceId;
  const source = item.source.toLowerCase();
  if (source.includes("benzinga")) return "benzinga";
  if (source.includes("finnhub")) return "finnhub";
  if (source.includes("financial modeling prep") || /\bfmp\b/.test(source)) return "fmp";
  if (source.includes("stocktwits")) return "stocktwits";
  if (source.includes("yahoo")) return "yahoo";
  if (source.includes("alpaca")) return "alpaca";
  return source.replace(/[^a-z0-9]+/g, "-") || "other";
}

function displaySource(item: LiveNewsCandidate): string {
  if (item.source.trim()) return item.source.trim();
  return item.sourceId ? SOURCE_LABELS[item.sourceId] : SOURCE_LABELS.other;
}

function toNewsItem(item: LiveNewsCandidate): NewsItem {
  return {
    headline: item.headline,
    source: displaySource(item),
    url: item.url,
    publishedAt: item.publishedAt,
    sentiment: item.sentiment,
  };
}

function byNewest(a: NewsItem, b: NewsItem): number {
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

function dedupeNearStories(items: LiveNewsCandidate[]): LiveNewsCandidate[] {
  const out: LiveNewsCandidate[] = [];
  for (const item of items) {
    if (out.some((existing) => nearDuplicate(existing, item))) continue;
    out.push(item);
  }
  return out;
}

function balanceSources(items: LiveNewsCandidate[], limit: number): LiveNewsCandidate[] {
  const groups = new Map<string, LiveNewsCandidate[]>();
  for (const item of items) {
    const bucket = sourceBucket(item);
    const group = groups.get(bucket) ?? [];
    group.push(item);
    groups.set(bucket, group);
  }

  if (groups.size <= 1) return items.slice(0, limit);

  for (const group of groups.values()) {
    group.sort(byNewest);
  }

  const maxPerSource = Math.max(2, Math.ceil(limit * 0.5));
  const takenBySource = new Map<string, number>();
  const selected: LiveNewsCandidate[] = [];
  let madeProgress = true;

  while (selected.length < limit && madeProgress) {
    madeProgress = false;
    for (const [bucket, group] of groups) {
      if (selected.length >= limit) break;
      const taken = takenBySource.get(bucket) ?? 0;
      if (taken >= maxPerSource || group.length === 0) continue;
      selected.push(group.shift()!);
      takenBySource.set(bucket, taken + 1);
      madeProgress = true;
    }
  }

  return selected.sort(byNewest);
}

export function selectRelevantLiveNews(
  ticker: string,
  items: LiveNewsCandidate[],
  options: SelectNewsOptions = {},
): NewsItem[] {
  const limit = options.limit ?? 18;
  const relevant = items
    .filter((item) => item.headline.trim() && item.url.trim())
    .filter((item) => isNewsRelevantToTicker(item, ticker))
    .sort(byNewest);
  const deduped = dedupeNearStories(relevant);
  return balanceSources(deduped, limit).map(toNewsItem);
}
