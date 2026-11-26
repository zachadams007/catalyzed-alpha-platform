import { alpacaKeyId, alpacaSecret, httpJson, isAlpacaConfigured } from "@/data/http";
import { isMarketProxyConfigured } from "@/data/marketProxy";
import type { TerminalEvent } from "@/types/terminal";
import { classifyNewsSeverity } from "./severity";

/**
 * Market-wide real-time catalyst wire from Alpaca Market Data.
 * Endpoint: https://data.alpaca.markets/v1beta1/news  (no `symbols` = whole market)
 * Auth: APCA-API-KEY-ID / APCA-API-SECRET-KEY headers (free with a paper account).
 *
 * Unlike `src/data/news/alpacaNews.ts` (per-symbol, for the stock detail card),
 * this fetches the latest headlines across the entire market and PRESERVES the
 * `symbols` tags + `summary` so the Terminal can flag catalysts as they break.
 *
 * Discovery/research only. Degrades to [] on any error. Reaches Alpaca EITHER
 * via a local key pair OR - on the keyless desktop/web build - through the hosted
 * market proxy, which injects the Alpaca credentials server-side (so the Catalyst
 * wire is live without shipping a key). `httpJson` → `resolveMarketRequest` does
 * the routing + strips any client headers when proxied.
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

function prettySource(source?: string): string {
  const s = source?.trim();
  if (!s) return "Alpaca";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function fetchAlpacaWire(limit = 50): Promise<TerminalEvent[]> {
  const keyId = alpacaKeyId();
  const secret = alpacaSecret();
  // Reachable with a LOCAL key pair, or via the hosted proxy (keyless build). Only
  // a build with neither has nothing to call - return [] so the chip reads "off"
  // honestly instead of erroring.
  const hasLocalKey = Boolean(keyId && secret);
  if (!hasLocalKey && !isMarketProxyConfigured()) return [];

  const url =
    `${ALPACA_NEWS}?limit=${Math.min(Math.max(limit, 1), 50)}` +
    `&sort=desc&exclude_contentless=true`;

  // In proxy mode the proxy injects the real Alpaca credentials (and strips these),
  // so only send the local headers when we actually have a local key.
  let res: AlpacaNewsResponse;
  res = await httpJson<AlpacaNewsResponse>(url, {
    headers:
      keyId && secret ? { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret } : undefined,
    timeoutMs: 12_000,
  });

  const rows = res.news;
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((r) => r.headline && r.url)
    .map((r) => {
      const symbols = (r.symbols ?? []).map((s) => s.toUpperCase());
      const { severity, reason } = classifyNewsSeverity(r.headline!, r.summary);
      const occurredAt = safeIso(r.created_at);
      return {
        id: `news-${r.id ?? r.url}`,
        kind: "catalyst_news" as const,
        severity,
        ticker: symbols[0] ?? "",
        relatedTickers: symbols.slice(1, 6),
        headline: r.headline!.trim(),
        summary: r.summary?.trim() || undefined,
        occurredAt,
        surfacedAt: occurredAt,
        source: { name: prettySource(r.source), url: r.url! },
        reason,
      } satisfies TerminalEvent;
    });
}

export { isAlpacaConfigured };
