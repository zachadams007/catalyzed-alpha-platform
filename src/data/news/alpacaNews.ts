import { alpacaKeyId, alpacaSecret, httpJson } from "@/data/http";
import type { LiveNewsCandidate, LiveNewsSourceId } from "@/data/news/newsSelection";

/**
 * Alpaca Market Data - real-time news wire.
 * Endpoint: https://data.alpaca.markets/v1beta1/news?symbols=AAPL
 * Auth: APCA-API-KEY-ID / APCA-API-SECRET-KEY headers (free with a paper account).
 *
 * Discovery/research only. Degrades gracefully (returns []) on any error so the
 * other news sources (Finnhub / FMP / Yahoo RSS) still populate the card.
 */

const ALPACA_NEWS = "https://data.alpaca.markets/v1beta1/news";

interface AlpacaArticle {
  id?: number;
  headline?: string;
  author?: string;
  source?: string;
  summary?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  symbols?: string[];
}

interface AlpacaNewsResponse {
  news?: AlpacaArticle[];
  next_page_token?: string | null;
}

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/** Tidy Alpaca's lowercase `source` slugs (e.g. "benzinga") into a display label. */
function prettySource(source?: string): string {
  const s = source?.trim();
  if (!s) return "Alpaca";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sourceId(source?: string): LiveNewsSourceId {
  return source?.trim().toLowerCase() === "benzinga" ? "benzinga" : "alpaca";
}

export async function fetchAlpacaNews(ticker: string): Promise<LiveNewsCandidate[]> {
  const symbol = ticker.trim().toUpperCase();
  const keyId = alpacaKeyId();
  const secret = alpacaSecret();
  if (!symbol || !keyId || !secret) return [];

  const url =
    `${ALPACA_NEWS}?symbols=${encodeURIComponent(symbol)}` +
    `&limit=20&sort=desc&exclude_contentless=true`;

  let res: AlpacaNewsResponse;
  try {
    res = await httpJson<AlpacaNewsResponse>(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
      },
      timeoutMs: 12_000,
    });
  } catch {
    return [];
  }

  const rows = res.news;
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r) => r.headline && r.url)
    .slice(0, 15)
    .map((r) => ({
      headline: r.headline!.trim(),
      source: prettySource(r.source),
      sourceId: sourceId(r.source),
      url: r.url!,
      publishedAt: safeIso(r.created_at),
      sentiment: 0,
      summary: r.summary,
      symbols: r.symbols ?? [],
    }));
}
