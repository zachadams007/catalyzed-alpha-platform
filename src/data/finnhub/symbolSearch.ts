import { preferredSymbolForQuery, searchQueriesForInput } from "@/data/finnhub/aliases";
import { finnhubKey, httpJson } from "@/data/http";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";

const FINNHUB = "https://finnhub.io/api/v1";

export interface FinnhubSymbolHit {
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string;
}

interface FinnhubSearchResponse {
  count: number;
  result: FinnhubSymbolHit[];
}

export class SymbolResolveError extends Error {
  readonly query: string;
  readonly suggestions: string[];

  constructor(message: string, query: string, suggestions: string[] = []) {
    super(message);
    this.name = "SymbolResolveError";
    this.query = query;
    this.suggestions = suggestions;
  }
}

/** Finnhub symbol search (U.S.-biased ranking applied client-side). */
export async function searchSymbols(query: string): Promise<FinnhubSymbolHit[]> {
  const key = finnhubKey();
  if (!key || !query.trim()) return [];

  const data = await httpJson<FinnhubSearchResponse>(
    `${FINNHUB}/search?q=${encodeURIComponent(query.trim())}&token=${encodeURIComponent(key)}`,
  );
  return data.result ?? [];
}

async function symbolHasLiveQuote(symbol: string): Promise<boolean> {
  const key = finnhubKey();
  if (!key) return false;
  try {
    const quote = await httpJson<{ c?: number }>(
      `${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
    );
    return Boolean(quote.c && quote.c > 0);
  } catch {
    return false;
  }
}

function rankHit(query: string, hit: FinnhubSymbolHit): number {
  const q = query.trim();
  const qUpper = q.toUpperCase();
  const sym = hit.symbol.toUpperCase();
  const base = sym.split(".")[0] ?? sym;
  const desc = hit.description.toLowerCase();
  const qLower = q.toLowerCase();

  let score = 0;

  const preferred = preferredSymbolForQuery(q);
  if (preferred && (sym === preferred || base === preferred)) score += 600;

  if (hit.type === "Common Stock") score += 40;
  else if (hit.type.includes("ETF") || hit.type === "ETP") score -= 30;
  else score -= 10;

  if (sym.includes(".") && !q.includes(".")) score -= 25;

  if (sym === qUpper || base === qUpper) score += 500;
  if (hit.displaySymbol.toUpperCase() === qUpper) score += 480;

  if (desc === qLower) score += 350;
  else if (desc.startsWith(`${qLower} `) || desc.startsWith(`${qLower},`)) score += 280;
  else if (desc.includes(qLower)) score += 120;

  if (base.length <= 5 && !sym.includes(".")) score += 15;

  return score;
}

function pickBestSymbol(originalQuery: string, hits: FinnhubSymbolHit[]): string {
  const best = [...hits].sort((a, b) => rankHit(originalQuery, b) - rankHit(originalQuery, a))[0]!;
  const sym = best.symbol.toUpperCase();
  if (sym.includes(".") && !originalQuery.includes(".")) {
    return (sym.split(".")[0] ?? sym).toUpperCase();
  }
  return sym;
}

function isTickerLike(raw: string): boolean {
  return /^[A-Za-z0-9.]{1,8}$/.test(raw.trim());
}

/** Map a name or ticker query to a real listed symbol (e.g. Google → GOOG, GCU.TO → GCU.TO). */
export async function resolveSymbolFromQuery(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new SymbolResolveError("Enter a ticker or company name.", "");

  const upper = trimmed.toUpperCase();

  // 1) Offline symbol directory FIRST - ~13.8k US + CA listings, suffix-aware
  //    and name-or-ticker. Return the directory's exact symbol; never strip a
  //    real exchange suffix (".TO" / ".V" / ".NE"). A directory-known query can
  //    never fall through to a "not found" error, with or without an API key.
  const known = resolveSymbol(trimmed);
  if (known) return known.symbol;

  const key = finnhubKey();
  if (!key) {
    if (isTickerLike(trimmed)) return upper.replace(/[^A-Z0-9.]/g, "").slice(0, 8);
    throw new SymbolResolveError(
      "Add VITE_FINNHUB_API_KEY in .env to look up real company names.",
      trimmed,
      ["TSLA", "AAPL", "GOOG"],
    );
  }

  // 2) Secondary: live Finnhub symbol search, for brand names and symbols the
  //    offline directory doesn't carry (e.g. "google" → GOOG via aliases).
  try {
    for (const searchTerm of searchQueriesForInput(trimmed)) {
      const hits = await searchSymbols(searchTerm);
      if (hits.length > 0) return pickBestSymbol(trimmed, hits);
    }

    if (isTickerLike(trimmed)) {
      const token = upper.replace(/[^A-Z0-9.]/g, "").slice(0, 8);
      if (await symbolHasLiveQuote(token)) return token;
    }

    const suggestions = preferredSymbolForQuery(trimmed)
      ? [preferredSymbolForQuery(trimmed)!]
      : isTickerLike(trimmed)
        ? []
        : ["Try the official ticker (e.g. GOOG for Google)."];

    throw new SymbolResolveError(
      `No listed symbol found for “${trimmed}”.`,
      trimmed,
      suggestions,
    );
  } catch (err) {
    if (err instanceof SymbolResolveError) throw err;
    throw new SymbolResolveError(
      "Could not reach Finnhub — check your API key and connection.",
      trimmed,
      ["AAPL", "TSLA", "GOOG"],
    );
  }
}
