import { finnhubKey, httpJson, isFinnhubQueryable, isFmpQueryable, nextFmpKey } from "@/data/http";

/**
 * Earnings-calendar lane (challenger only).
 *
 * Source of the "see it before the move" countdown and the consensus-EPS series
 * that powers estimate-revision momentum. Two transports, FMP-first:
 *
 *   • FMP `/stable/earnings-calendar?from&to` - ONE call returns the WHOLE
 *     market's scheduled earnings (date + consensus `epsEstimated`) in the
 *     window, so the funnel's 150–300 names cost a single request. Preferred
 *     (the challenger funnel already needs FMP).
 *     NOTE: this was `/api/v3/earning_calendar` until 2026-09-03. FMP retired
 *     every legacy v3 route on 2025-08-31, so that call had been answering 403
 *     and this module's `catch` was swallowing it into an empty map - which is
 *     why the Terminal's Earnings pane read "No reports scheduled" every day
 *     while the endpoint was simply dead. Do not reintroduce a v3 path.
 *   • Finnhub `/calendar/earnings?from&to` WITHOUT a symbol - the whole
 *     market's scheduled reports in one call per two-week chunk (verified
 *     2026-09-20: 1,500 rows for the next six weeks, Amazon/Meta/Microsoft/
 *     SoFi/Lockheed all present, on the free key). This is the workhorse: the
 *     FMP free plan answers the bulk call with ~30 rows, so a fold that stopped
 *     at "FMP configured ⇒ done" published ZERO earnings catalysts for 500
 *     names on every scan through 2026-09-20.
 *   • Finnhub `/calendar/earnings?symbol=&from&to` - per-ticker last resort.
 *     Budget-gated by the shared HTTP layer; degrades to null.
 *
 * All return the SOONEST upcoming event per symbol within the window. Never
 * throws - a failure yields an empty map / null so the lane degrades silently.
 */

const FMP = "https://financialmodelingprep.com/stable";
const FINNHUB = "https://finnhub.io/api/v1";

/** One upcoming earnings event for a ticker. */
export interface EarningsEvent {
  /** ISO date (YYYY-MM-DD) of the scheduled report. */
  dateISO: string;
  /** Consensus forward EPS estimate (per share), or null when not reported. */
  epsEstimate: number | null;
}

interface FmpEarningRow {
  date?: string;
  symbol?: string;
  epsEstimated?: number | null;
  eps?: number | null;
}

interface FinnhubEarningRow {
  date?: string;
  symbol?: string;
  epsEstimate?: number | null;
  epsActual?: number | null;
}

interface FinnhubEarningsResponse {
  earningsCalendar?: FinnhubEarningRow[];
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Keep only valid future-or-today rows; return the soonest by date. */
function soonest<T extends { dateISO: string }>(events: T[], fromISO: string): T | null {
  let best: T | null = null;
  for (const e of events) {
    if (!e.dateISO || e.dateISO < fromISO) continue;
    if (!best || e.dateISO < best.dateISO) best = e;
  }
  return best;
}

/**
 * Whole-market earnings calendar via FMP, mapped symbol → soonest event in
 * [fromISO, toISO]. One API call. Empty map when FMP isn't configured or fails.
 */
export async function fetchEarningsCalendarMap(
  fromISO: string,
  toISO: string,
): Promise<Map<string, EarningsEvent>> {
  const map = new Map<string, EarningsEvent>();
  if (!isFmpQueryable()) return map;
  const key = nextFmpKey(); // undefined in proxy mode - the proxy injects the key
  try {
    const url = key
      ? `${FMP}/earnings-calendar?from=${fromISO}&to=${toISO}&apikey=${encodeURIComponent(key)}`
      : `${FMP}/earnings-calendar?from=${fromISO}&to=${toISO}`;
    const rows = await httpJson<FmpEarningRow[]>(url, { timeoutMs: 30_000 });
    if (!Array.isArray(rows)) return map;
    // Group by symbol, keep the soonest in-window date.
    const bySymbol = new Map<string, EarningsEvent[]>();
    for (const row of rows) {
      const symbol = row.symbol?.trim().toUpperCase();
      const dateISO = typeof row.date === "string" ? row.date.slice(0, 10) : "";
      if (!symbol || !dateISO) continue;
      const list = bySymbol.get(symbol) ?? [];
      list.push({ dateISO, epsEstimate: finiteOrNull(row.epsEstimated) });
      bySymbol.set(symbol, list);
    }
    for (const [symbol, events] of bySymbol) {
      const next = soonest(events, fromISO);
      if (next) map.set(symbol, next);
    }
    return map;
  } catch {
    return map;
  }
}

/** Finnhub caps a bulk calendar response; two-week chunks stay well under it. */
const FINNHUB_BULK_CHUNK_DAYS = 14;

/**
 * Bulk upcoming earnings via Finnhub - every symbol in [fromISO, toISO], keyed
 * by UPPERCASE ticker, soonest event per symbol. One request per two-week chunk.
 */
export async function fetchFinnhubEarningsCalendarMap(
  fromISO: string,
  toISO: string,
): Promise<Map<string, EarningsEvent>> {
  const map = new Map<string, EarningsEvent>();
  if (!isFinnhubQueryable()) return map;
  const key = finnhubKey(); // undefined in proxy mode - the proxy injects the token
  const startMs = Date.parse(`${fromISO}T00:00:00Z`);
  const endMs = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return map;
  const bySymbol = new Map<string, EarningsEvent[]>();
  for (let chunkStart = startMs; chunkStart <= endMs; chunkStart += FINNHUB_BULK_CHUNK_DAYS * 86_400_000) {
    const chunkEnd = Math.min(endMs, chunkStart + (FINNHUB_BULK_CHUNK_DAYS - 1) * 86_400_000);
    const from = new Date(chunkStart).toISOString().slice(0, 10);
    const to = new Date(chunkEnd).toISOString().slice(0, 10);
    try {
      const base = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}`;
      const data = await httpJson<FinnhubEarningsResponse>(
        key ? `${base}&token=${encodeURIComponent(key)}` : base,
        { timeoutMs: 30_000 },
      );
      for (const row of data.earningsCalendar ?? []) {
        const symbol = row.symbol?.trim().toUpperCase();
        const dateISO = typeof row.date === "string" ? row.date.slice(0, 10) : "";
        if (!symbol || !dateISO) continue;
        const list = bySymbol.get(symbol) ?? [];
        list.push({ dateISO, epsEstimate: finiteOrNull(row.epsEstimate) });
        bySymbol.set(symbol, list);
      }
    } catch {
      // One failed chunk loses two weeks of dates, not the whole calendar.
    }
  }
  for (const [symbol, events] of bySymbol) {
    const next = soonest(events, fromISO);
    if (next) map.set(symbol, next);
  }
  return map;
}

/**
 * Per-ticker upcoming earnings via Finnhub (the last-resort fallback). Returns the
 * soonest event in [fromISO, toISO], or null.
 */
export async function fetchFinnhubNextEarnings(
  symbol: string,
  fromISO: string,
  toISO: string,
): Promise<EarningsEvent | null> {
  if (!isFinnhubQueryable()) return null;
  const key = finnhubKey(); // undefined in proxy mode - the proxy injects the token
  const ticker = symbol.trim().toUpperCase();
  if (!ticker) return null;
  try {
    const base = `${FINNHUB}/calendar/earnings?from=${fromISO}&to=${toISO}&symbol=${encodeURIComponent(ticker)}`;
    const data = await httpJson<FinnhubEarningsResponse>(
      key ? `${base}&token=${encodeURIComponent(key)}` : base,
    );
    const events: EarningsEvent[] = (data.earningsCalendar ?? [])
      .map((row) => ({
        dateISO: typeof row.date === "string" ? row.date.slice(0, 10) : "",
        epsEstimate: finiteOrNull(row.epsEstimate),
      }))
      .filter((e) => e.dateISO);
    return soonest(events, fromISO);
  } catch {
    return null;
  }
}

/** True when any earnings transport is reachable - a local key OR the hosted
 *  proxy (so the lane runs on a keyless web/phone build too). */
export function isEarningsCalendarConfigured(): boolean {
  return isFmpQueryable() || isFinnhubQueryable();
}
