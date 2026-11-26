/**
 * Single proxy-able layer for market-data requests + the backup provider chain.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every market-data GET in the app funnels through `httpText`/`httpJson` in
 * `src/data/http.ts`. Today those calls embed `VITE_*` keys directly in the URL
 * (e.g. `?token=<finnhub key>`) and hit the vendor directly - which is fine in
 * the Tauri desktop shell (no CORS, keys live on the owner's machine) but is a
 * blocker for any hosted/PWA distribution: Vite inlines every `VITE_` value into
 * the client bundle, so the keys ship to anyone who unpacks it
 * (see `docs/program/distribution-and-limiter-plan.md` §"Keys off the client").
 *
 * This module makes the whole app *proxy-ready without deploying anything*:
 *   • When `VITE_MARKET_PROXY_URL` is UNSET (today's default), every call is
 *     returned untouched - direct-to-vendor, identical to current behavior.
 *   • When it is SET (the future hosted path), {@link resolveMarketRequest}
 *     rewrites every recognized vendor URL to route through one hosted proxy
 *     and strips client-side secrets, so the real keys can move server-side.
 *
 * Nothing here performs network I/O - it is pure URL/header rewriting plus the
 * fallback-chain policy, so it stays trivially testable and has no dependency on
 * the transport layer in `http.ts` (http.ts imports this; never the reverse).
 *
 * BACKUP PROVIDER CHAIN
 * ---------------------
 * Per the plan §4, when Finnhub rate-limits (HTTP 429) the request should fall
 * back in order: 2nd Finnhub key → Polygon.io → Tiingo. The 2nd-Finnhub-key hop
 * is a pure key swap and runs client-side today (see {@link finnhubRetryUrl},
 * wired into `http.ts`). The Polygon/Tiingo hops require translating between
 * vendor request shapes, which the plan assigns to the proxy - so they are
 * scaffolded here as chain policy ({@link planFallback}) that the hosted proxy
 * consults, with keys kept in `VITE_*` env only.
 */

import { vendorOf, type ApiVendorId } from "@/lib/apiUsage";

// ── Env readers (VITE_* only - never hardcode keys) ─────────────────────────

function readEnv(name: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[name]?.trim() || undefined;
}

/** URL of the hosted market-data proxy that re-attaches secret keys server-side. */
export function marketProxyUrl(): string | undefined {
  return readEnv("VITE_MARKET_PROXY_URL");
}

/** True once a hosted market-data proxy is configured (the future PWA path). */
export function isMarketProxyConfigured(): boolean {
  return Boolean(marketProxyUrl());
}

/** Optional second Finnhub key - doubles the free 60/min rate when key A 429s. */
export function secondFinnhubKey(): string | undefined {
  return readEnv("VITE_FINNHUB_API_KEY_2");
}

/** Optional Polygon.io key (price history / aggregates fallback). */
export function polygonKey(): string | undefined {
  return readEnv("VITE_POLYGON_API_KEY");
}

/** Optional Tiingo key (news + end-of-day price fallback). */
export function tiingoKey(): string | undefined {
  return readEnv("VITE_TIINGO_API_KEY");
}

// ── Vendor → upstream map (what the hosted proxy forwards to) ────────────────

/**
 * The upstream origin every recognized vendor is forwarded to. The hosted proxy
 * uses the FIRST path segment (the vendor id, e.g. `/finnhub/...`) to pick the
 * upstream, re-attach the secret key, and stream the response back. Keep this in
 * sync with `vendorOf()` in `src/lib/apiUsage.ts` and the proxy implementation
 * documented in `docs/program/hosted-proxy-readiness.md`.
 */
const VENDOR_UPSTREAM: Partial<Record<ApiVendorId, string>> = {
  finnhub: "https://finnhub.io",
  fmp: "https://financialmodelingprep.com",
  alpaca: "https://data.alpaca.markets",
  yahoo: "https://query1.finance.yahoo.com",
  // TODO(proxy): SEC fetchers also hit www.sec.gov and efts.sec.gov; when the
  // proxy is stood up, route /sec by path to the right subdomain (data/www/efts)
  // instead of collapsing all to data.sec.gov. Keyless, so no secret risk today.
  sec: "https://data.sec.gov",
  stocktwits: "https://api.stocktwits.com",
  apewisdom: "https://apewisdom.io",
};

/** Query params that carry a client-side secret - stripped before proxying. */
const SECRET_QUERY_PARAMS = ["token", "apikey", "apiKey", "api_key"];

/** Request headers that carry a client-side secret - dropped before proxying. */
const SECRET_HEADER_PREFIXES = ["apca-api-", "authorization", "x-api-key"];

/** True when this URL belongs to a vendor we know how to proxy. */
export function isProxyableVendor(url: string): boolean {
  return Boolean(VENDOR_UPSTREAM[vendorOf(url)]);
}

export interface ResolvedRequest {
  /** The URL to actually fetch (rewritten to the proxy, or the original). */
  url: string;
  /** Headers to send (secret headers stripped when routing through the proxy). */
  headers?: Record<string, string>;
  /** True when the request was rewritten to flow through the hosted proxy. */
  proxied: boolean;
}

/**
 * Resolve a direct vendor request into the request the transport should make.
 *
 * Direct mode (no `VITE_MARKET_PROXY_URL`, or an unrecognized host): returns the
 * URL and headers unchanged - today's exact behavior.
 *
 * Proxy mode: rewrites `https://finnhub.io/api/v1/quote?symbol=AAPL&token=SECRET`
 * to `<PROXY>/finnhub/api/v1/quote?symbol=AAPL` (vendor id as the first path
 * segment, secret query params + secret headers stripped). The hosted proxy
 * re-attaches the real key server-side. This is the seam that lets keys move off
 * the client without touching a single vendor-fetch call site.
 */
export function resolveMarketRequest(
  url: string,
  headers?: Record<string, string>,
): ResolvedRequest {
  const proxyBase = marketProxyUrl();
  if (!proxyBase) return { url, headers, proxied: false };

  const vendor = vendorOf(url);
  const upstream = VENDOR_UPSTREAM[vendor];
  if (!upstream) return { url, headers, proxied: false };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, headers, proxied: false };
  }

  // Strip client secrets from the query - the proxy injects the real key.
  for (const param of SECRET_QUERY_PARAMS) parsed.searchParams.delete(param);

  const base = proxyBase.replace(/\/+$/, "");
  const path = parsed.pathname.replace(/^\/+/, "");
  const search = parsed.searchParams.toString();
  const proxiedUrl = `${base}/${vendor}/${path}${search ? `?${search}` : ""}`;

  return { url: proxiedUrl, headers: stripSecretHeaders(headers), proxied: true };
}

function stripSecretHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (SECRET_HEADER_PREFIXES.some((p) => lower.startsWith(p))) continue;
    kept[name] = value;
  }
  return kept;
}

// ── Backup provider chain ────────────────────────────────────────────────────

/** Members of the Finnhub-served fallback chain, in escalation order. */
export type FallbackProviderId = "finnhub" | "finnhub2" | "polygon" | "tiingo";

/**
 * The fallback order the plan §4 prescribes for Finnhub-served data when the
 * primary key rate-limits. `finnhub` (key A) is the head; each subsequent member
 * is only attempted if its key is configured.
 */
export const FINNHUB_FALLBACK_CHAIN: FallbackProviderId[] = [
  "finnhub",
  "finnhub2",
  "polygon",
  "tiingo",
];

/** True when an HTTP status means "rate limited / backed off" (trigger fallback). */
export function isRateLimitStatus(status: number): boolean {
  // 429 is the canonical rate-limit; 418 is sometimes used by aggressive WAFs.
  return status === 429 || status === 418;
}

/** Whether a given fallback provider currently has a usable key configured. */
export function isFallbackConfigured(id: FallbackProviderId): boolean {
  switch (id) {
    case "finnhub":
      return Boolean(readEnv("VITE_FINNHUB_API_KEY"));
    case "finnhub2":
      return Boolean(secondFinnhubKey());
    case "polygon":
      return Boolean(polygonKey());
    case "tiingo":
      return Boolean(tiingoKey());
  }
}

/**
 * The escalation plan after a Finnhub 429: the configured providers to try, in
 * order, AFTER the primary key. Excludes `finnhub` (the head that just failed)
 * and any provider whose key is missing. Pure policy - consulted by the hosted
 * proxy (Polygon/Tiingo translation lives server-side) and unit-tested here.
 *
 * Example: with `VITE_FINNHUB_API_KEY_2` + `VITE_TIINGO_API_KEY` set but no
 * Polygon key → `["finnhub2", "tiingo"]`.
 */
export function planFallback(): FallbackProviderId[] {
  return FINNHUB_FALLBACK_CHAIN.filter((id) => id !== "finnhub" && isFallbackConfigured(id));
}

/**
 * Client-side hop #1: given a Finnhub URL that just 429'd on key A, return the
 * same URL signed with the second key, or `null` when no usable second key
 * exists (or the URL already uses it, or it isn't a Finnhub URL). This is the
 * one fallback step that runs in the client today - a pure token swap, no new
 * provider code, exactly as the plan describes. Polygon/Tiingo hops happen at
 * the proxy.
 */
export function finnhubRetryUrl(url: string): string | null {
  if (vendorOf(url) !== "finnhub") return null;
  const keyB = secondFinnhubKey();
  if (!keyB) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const current = parsed.searchParams.get("token");
  if (!current || current === keyB) return null; // nothing to swap to
  parsed.searchParams.set("token", keyB);
  return parsed.toString();
}
