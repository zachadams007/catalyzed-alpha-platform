import { finnhubKey, httpJson } from "@/data/http";
import { isResearchFreshForToday } from "@/lib/researchSchedule";

/**
 * Stage 0 of the full-market funnel: the authoritative list of US common stocks.
 *
 * This is ONE Finnhub call (`/stock/symbol?exchange=US`) per research day. The
 * response is large (~10k rows) but we keep only the uppercase symbols of rows
 * typed "Common Stock" - a few tens of KB - cached in localStorage on the same
 * daily boundary the research engine uses (`isResearchFreshForToday`). Reopening
 * the app reuses the cached list for free; it refreshes at most once per day.
 *
 * The list gives the funnel two things: the honest TOTAL count of listed US
 * common stocks (the "screened N out of ~X listed" headline) and a membership
 * set used to strip ETFs / warrants / units that slip through the FMP screener.
 */

const FINNHUB = "https://finnhub.io/api/v1";
const SYMBOL_LIST_KEY = "catalyzed-alpha:symbol-list:v1";

interface FinnhubSymbolRow {
  symbol?: string;
  displaySymbol?: string;
  description?: string;
  type?: string;
  mic?: string;
}

interface CachedSymbolList {
  fetchedAtISO: string;
  symbols: string[];
  total: number;
}

export interface UsSymbolList {
  /** Uppercase common-stock symbols (deduped, sorted). Empty if unavailable. */
  symbols: string[];
  /** Count of listed US common stocks (the honest universe headline). */
  total: number;
  /** ISO timestamp the list was fetched. */
  fetchedAtISO: string;
  /** True when served from the daily localStorage cache (no API call spent). */
  fromCache: boolean;
}

function readCache(): CachedSymbolList | null {
  try {
    const raw = localStorage.getItem(SYMBOL_LIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSymbolList>;
    if (
      !parsed ||
      typeof parsed.fetchedAtISO !== "string" ||
      !Array.isArray(parsed.symbols) ||
      typeof parsed.total !== "number"
    ) {
      return null;
    }
    return {
      fetchedAtISO: parsed.fetchedAtISO,
      symbols: parsed.symbols.filter((s): s is string => typeof s === "string"),
      total: parsed.total,
    };
  } catch {
    return null;
  }
}

function writeCache(list: CachedSymbolList): void {
  try {
    localStorage.setItem(SYMBOL_LIST_KEY, JSON.stringify(list));
  } catch {
    /* storage full/unavailable - the funnel degrades to no common-stock filter */
  }
}

/**
 * Fetch (or reuse the daily cache of) the US common-stock symbol list. Returns
 * an empty list - never throws - when Finnhub isn't configured or the call
 * fails, so the funnel can still run off the FMP screener union alone (it just
 * loses the ETF/warrant strip and the "out of X listed" headline).
 */
export async function fetchUsSymbolList(now: Date = new Date()): Promise<UsSymbolList> {
  const cached = readCache();
  if (cached && isResearchFreshForToday(cached.fetchedAtISO, now)) {
    return { ...cached, fromCache: true };
  }

  const key = finnhubKey();
  if (!key) {
    // Stale cache is better than nothing for the membership filter.
    if (cached) return { ...cached, fromCache: true };
    return { symbols: [], total: 0, fetchedAtISO: now.toISOString(), fromCache: false };
  }

  try {
    const rows = await httpJson<FinnhubSymbolRow[]>(
      `${FINNHUB}/stock/symbol?exchange=US&token=${encodeURIComponent(key)}`,
      { timeoutMs: 30_000 },
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.type !== "Common Stock") continue;
      const sym = row.symbol?.trim().toUpperCase();
      if (!sym) continue;
      seen.add(sym);
    }
    const symbols = [...seen].sort();
    const fetchedAtISO = now.toISOString();
    writeCache({ fetchedAtISO, symbols, total: symbols.length });
    return { symbols, total: symbols.length, fetchedAtISO, fromCache: false };
  } catch {
    if (cached) return { ...cached, fromCache: true };
    return { symbols: [], total: 0, fetchedAtISO: now.toISOString(), fromCache: false };
  }
}
