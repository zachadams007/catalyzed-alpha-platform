/**
 * Leaf module: pure external-URL builders + URL predicates with ZERO imports.
 *
 * These were split out of `src/lib/links.ts` to break a real import cycle:
 *   mockSignals → socialPosts → links → mockSignals
 * `socialPosts` only needs `externalXSearchUrl`, but importing it from `links`
 * dragged in `MOCK_UNIVERSE` (a heavy module that builds the sample universe at
 * load), so any entry through `socialPosts`/`syntheticTicker` (e.g. the headless
 * daily scan under vite-node) crashed with `genSocialPosts is not a function`.
 *
 * Keeping these here - with no dependencies - means `socialPosts` imports a pure
 * leaf and the cycle is gone for every consumer (app, tests, and Node scripts).
 * `links.ts` re-exports everything below, so existing `@/lib/links` imports are
 * unchanged.
 */

export function externalNewsSearchUrl(ticker: string, extra?: string): string {
  const t = ticker.trim().toUpperCase();
  const q = extra?.trim() ? `${t} stock ${extra.trim()}` : `${t} stock news`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=nws`;
}

export function externalWebSearchUrl(ticker: string, extra?: string): string {
  const t = ticker.trim().toUpperCase();
  const q = extra?.trim() ? `${t} stock ${extra.trim()}` : `${t} stock`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** Yahoo Finance quote page - works for real tickers without an API key. */
export function yahooQuoteUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(ticker.trim().toUpperCase())}/`;
}

export function externalXSearchUrl(ticker: string, queryExtra?: string): string {
  const q = queryExtra ? `${ticker} ${queryExtra}` : `${ticker} stock`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
}

export function isSampleResearchUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "example-research.local";
  } catch {
    return false;
  }
}

/** True when the item already has a real publisher URL (Finnhub / Yahoo RSS, etc.). */
export function isDirectNewsUrl(url: string): boolean {
  if (isSampleResearchUrl(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export interface NewsLinkContext {
  source?: string;
  companyName?: string;
}

/** Use the article URL when live; otherwise no Google fallback (returns empty to signal non-link). */
export function newsItemHref(ticker: string, url: string, _ctx?: NewsLinkContext): string {
  if (isDirectNewsUrl(url)) return url;
  return "";
}

/** Source / IR links - real tickers open Yahoo Finance. */
export function sourceItemHref(ticker: string, url: string, _label?: string): string {
  if (!isSampleResearchUrl(url)) return url;
  return yahooQuoteUrl(ticker);
}
