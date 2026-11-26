import type { MarketCapBucket, RiskLevel } from "@/types";

/** Currency symbol/prefix for a price, defaulting to a bare "$" for USD. */
export function currencyPrefix(currency?: string): string {
  switch ((currency ?? "USD").toUpperCase()) {
    case "USD":
      return "$";
    case "CAD":
      return "C$";
    case "AUD":
      return "A$";
    case "GBP":
      return "£";
    case "EUR":
      return "€";
    default:
      return `${(currency ?? "").toUpperCase()} `;
  }
}

/**
 * Spot price with sensible precision for both penny stocks and mega-caps.
 * Pass `currency` to label non-USD listings (e.g. CAD → "C$0.43"); USD/omitted
 * keeps the bare "$" so every existing call site is unchanged.
 */
export function formatPrice(price: number, currency?: string): string {
  if (!Number.isFinite(price) || price <= 0) return "—";

  const decimals = price < 1 ? 4 : price < 100 ? 2 : 2;
  return `${currencyPrefix(currency)}${price.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** USD value for portfolio totals and holding market values. */
export function formatCurrency(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  });
}

/** Signed USD value with an explicit plus sign for gains. */
export function formatSignedCurrency(value: number, maximumFractionDigits = 0): string {
  const formatted = formatCurrency(Math.abs(value), maximumFractionDigits);
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

/** Locale-aware quantity formatting for shares and other non-currency values. */
export function formatNumber(value: number, maximumFractionDigits = 4): string {
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

/** A ratio (0.034) as a signed percentage string (+3.4%). */
export function formatPct(ratio: number, decimals = 1): string {
  const pct = ratio * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}

/** A ratio as an unsigned percentage (34.0%). */
export function formatPctPlain(ratio: number, decimals = 1): string {
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Compact market-cap label: $1.2T, $340.0B, $820.0M. Dash for missing/0/invalid. */
export function formatMarketCap(marketCap: number): string {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "—";
  if (marketCap >= 1e12) return `$${(marketCap / 1e12).toFixed(2)}T`;
  if (marketCap >= 1e9) return `$${(marketCap / 1e9).toFixed(1)}B`;
  if (marketCap >= 1e6) return `$${(marketCap / 1e6).toFixed(0)}M`;
  return `$${marketCap.toLocaleString("en-US")}`;
}

/** Compact dollar volume: $4.2B, $310M, $12M. */
export function formatVolume(dollars: number): string {
  if (dollars >= 1e9) return `$${(dollars / 1e9).toFixed(1)}B`;
  if (dollars >= 1e6) return `$${(dollars / 1e6).toFixed(0)}M`;
  if (dollars >= 1e3) return `$${(dollars / 1e3).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

/**
 * Hard upper bound on a single name's market cap, in USD. The largest real
 * public company on earth is ~$4T; anything above $5T is impossible and signals
 * bad data - a provider units bug, a missing field, or a fabricated/synthetic
 * fallback cap. Surfaces that size by cap (the Market Map treemap, hydration in
 * the live universe) clamp/drop against this so one absurd value can't dominate
 * or print garbage like "NNE $24.95T".
 */
export const MAX_PLAUSIBLE_MARKET_CAP = 5e12;

/**
 * Pseudo-tickers that are NOT tradeable public common stock - private companies
 * carried by some data providers (e.g. Finnhub) with a synthetic ticker and a
 * private-markets / pre-IPO "valuation" reported as `marketCapitalization`. These
 * are NOT public market caps and must NEVER reach a TRADEABLE surface (the
 * screener's buyable board, day-move quotes, the majors backbone, holdings) -
 * they have no quotable price and would masquerade as a buyable stock.
 *
 * NOTE: SpaceX (SPCX) is NOT here - it IPO'd on NASDAQ on 2026-06-12 and now
 * trades as a real public mega-cap (~$2.44T). It is treated like any other listed
 * stock: tradeable, lookup-able, and sized at its true public cap on the map.
 */
export const NON_PUBLIC_TICKERS: ReadonlySet<string> = new Set<string>([]);

/** True if a ticker is a known private/non-tradeable pseudo-ticker (see above). */
export function isNonPublicTicker(ticker: string): boolean {
  return NON_PUBLIC_TICKERS.has(ticker.trim().toUpperCase());
}

/** A finite, positive, sub-impossible market cap (real, sized-able data). */
export function isPlausibleMarketCap(marketCap: unknown): marketCap is number {
  return (
    typeof marketCap === "number" &&
    Number.isFinite(marketCap) &&
    marketCap > 0 &&
    marketCap <= MAX_PLAUSIBLE_MARKET_CAP
  );
}

/**
 * Standard US market-cap buckets. A missing / zero / non-finite cap is "Unknown",
 * NOT "Nano" - defaulting an absent cap to the smallest bucket is exactly the bug
 * that made NVDA (whose live cap field hadn't populated) match a small-cap screener
 * filter. Unknown matches no size criterion and is rendered explicitly.
 */
export function bucketForMarketCap(marketCap: number): MarketCapBucket {
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "Unknown";
  if (marketCap >= 2e11) return "Mega";
  if (marketCap >= 1e10) return "Large";
  if (marketCap >= 2e9) return "Mid";
  if (marketCap >= 3e8) return "Small";
  if (marketCap >= 5e7) return "Micro";
  return "Nano";
}

/** Map a 0..25 risk-penalty into a human risk level. */
export function riskLevelFromPenalty(penalty: number): RiskLevel {
  if (penalty >= 20) return "Extreme";
  if (penalty >= 14) return "High";
  if (penalty >= 9) return "Elevated";
  if (penalty >= 4) return "Moderate";
  return "Low";
}

/** "3h ago", "2d ago", "just now" from an ISO timestamp. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

/** Hours since -> friendly freshness label. */
export function freshnessLabel(hours: number): string {
  if (hours < 1) return "minutes ago";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Strip raw URLs out of model-written PROSE.
 *
 * The `ai-pick` function appends `" Source: <url>"` to its write-up, and when
 * Gemini grounds a claim that URL is an opaque
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/...` blob - a
 * 300-character internal artifact that rendered as a wall of base64 in the
 * middle of the Pick-of-the-Day thesis. It is also NOT a citation a reader can
 * trust: it is an ephemeral redirect, not the publisher.
 *
 * Surfaces that show a thesis already render `primary_source_url` as a real,
 * labelled link, so the in-prose copy is redundant as well as ugly. This drops
 * the trailing "Source: ..." clause and any bare URL left in the sentence, then
 * tidies the leftover whitespace/punctuation.
 *
 * Applied at RENDER time on purpose: rows already cached in `daily_signals`
 * carry the polluted text, so fixing only the generator would leave today's
 * picks broken until the next scan.
 */
export function stripSourceUrls(prose: string | null | undefined): string {
  if (!prose) return "";
  return prose
    // "Source: https://..." / "(Source: https://...)".
    // The URL character class is `[^\s)]`, NOT `\S`: a greedy `\S+` also eats the
    // closing paren AND the sentence's full stop, so "Beat on revenue (Source:
    // https://x/y)." came back as "Beat on revenue" with the period gone.
    .replace(/\(?\s*\bSources?\s*:\s*https?:\/\/[^\s)]+\)?/gi, " ")
    // Any other bare URL left inline.
    .replace(/https?:\/\/[^\s)]+/g, " ")
    // Tidy the gap the removal left behind. Note the trailing trim keeps a
    // legitimate full stop - only dangling separators go, so a sentence that
    // ended before the stripped clause still reads as a sentence.
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/[\s,;:]+$/, "")
    .trim();
}
