/**
 * Finnhub symbol search often returns no hits for brand names (e.g. "google").
 * Extra search terms and preferred tickers map common queries to real symbols.
 */
const COMPANY_SEARCH_ALIASES: Record<string, string[]> = {
  google: ["alphabet", "GOOG"],
  goog: ["GOOG", "alphabet"],
  googl: ["GOOGL", "alphabet"],
  alphabet: ["GOOGL", "GOOG"],
  facebook: ["meta", "META"],
  meta: ["META"],
  amazon: ["AMZN"],
  apple: ["AAPL"],
  microsoft: ["MSFT"],
  nvidia: ["NVDA"],
  tesla: ["TSLA"],
  netflix: ["NFLX"],
  disney: ["DIS"],
  walmart: ["WMT"],
  jpmorgan: ["JPM"],
  "jp morgan": ["JPM"],
  berkshire: ["BRK.B", "BRK.A"],
  coinbase: ["COIN"],
  uber: ["UBER"],
  airbnb: ["ABNB"],
  starbucks: ["SBUX"],
  boeing: ["BA"],
  intel: ["INTC"],
  amd: ["AMD"],
};

/** When multiple hits match, prefer this symbol for a normalized query key. */
const PREFERRED_SYMBOL: Record<string, string> = {
  google: "GOOG",
  goog: "GOOG",
  alphabet: "GOOG",
};

export function preferredSymbolForQuery(query: string): string | undefined {
  return PREFERRED_SYMBOL[query.trim().toLowerCase()];
}

/** Search terms to try in order (deduped). */
export function searchQueriesForInput(input: string): string[] {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (q: string) => {
    const t = q.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };

  push(trimmed);
  const extra = COMPANY_SEARCH_ALIASES[key];
  if (extra) extra.forEach(push);

  return out;
}
