import {
  alpacaKeyId,
  alpacaSecret,
  finnhubKey,
  httpJson,
  isPlanBlocked,
  notePlanBlocked,
} from "@/data/http";

/**
 * Real stock-split (corporate-action) lookups - the data source that lets the
 * portfolio engine tell a genuine reverse/forward split apart from a garden-
 * variety price move, so a holding's `shares`/`costBasis` can be safely
 * rescaled (see `src/engine/portfolioSplits.ts`). NEVER inferred from price
 * alone - a legitimate ~10x single-day move can happen on real news (buyout,
 * FDA approval), and this app's "never fabricate / never silently corrupt
 * user data" rule means only a REAL corporate-action record may trigger a
 * rescale.
 *
 * Provider order + VERIFIED status (checked live 2026-07-10 against this
 * project's own keys):
 *   1. Finnhub `/stock/split` - attempted first (already the app's live-quote
 *      provider, same key pool). CONFIRMED on this plan tier it returns
 *      `{"error":"You don't have access to this resource."}` - a premium-only
 *      endpoint on the free tier this project uses. Kept wired (not deleted)
 *      so it starts working automatically if the plan is ever upgraded, and
 *      any transient/plan-specific failure degrades silently to step 2.
 *   2. Alpaca `/v1beta1/corporate-actions` - CONFIRMED WORKING. A live test
 *      against real tickers returned real split records, e.g.:
 *        AAPL forward split: old_rate=1, new_rate=4, ex_date=2020-08-31
 *        GE reverse split:   old_rate=8, new_rate=1, ex_date=2021-08-02
 *      (matches the actual historical AAPL 4-for-1 and GE 1-for-8 splits).
 *      This is the endpoint that actually powers split detection today.
 */

const FINNHUB = "https://finnhub.io/api/v1";
const ALPACA_CORPORATE_ACTIONS = "https://data.alpaca.markets/v1beta1/corporate-actions";

/** A single detected split event for one ticker. */
export interface StockSplitEvent {
  ticker: string;
  /** ISO effective date (YYYY-MM-DD) - Alpaca's `ex_date` / Finnhub's `date`. */
  effectiveDate: string;
  /** "Old" share baseline (e.g. 1 in a 4-for-1 split, 8 in a 1-for-8 reverse split). */
  oldRate: number;
  /** "New" share count for the same baseline. */
  newRate: number;
  /** Multiply PRE-split shares by this to get POST-split shares (newRate / oldRate).
   *  Divide cost-basis-per-share by the same factor. A reverse split → factor < 1. */
  factor: number;
  /** True when factor < 1 - a reverse split (this app's headline phantom-value bug case). */
  isReverse: boolean;
  /** Human label, e.g. "1-for-8 reverse split" or "4-for-1 split". */
  label: string;
}

function toEvent(ticker: string, effectiveDate: string, oldRate: number, newRate: number): StockSplitEvent | null {
  if (!(oldRate > 0) || !(newRate > 0) || !effectiveDate) return null;
  const factor = newRate / oldRate;
  const isReverse = factor < 1;
  return {
    ticker: ticker.toUpperCase(),
    effectiveDate: effectiveDate.slice(0, 10),
    oldRate,
    newRate,
    factor,
    isReverse,
    label: isReverse ? `1-for-${round2(oldRate / newRate)} reverse split` : `${round2(newRate / oldRate)}-for-1 split`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mergeEvent(out: Record<string, StockSplitEvent[]>, event: StockSplitEvent | null): void {
  if (!event) return;
  const arr = out[event.ticker] ?? (out[event.ticker] = []);
  // De-dupe by effective date - a ticker should only ever have one recorded
  // event per calendar date.
  if (!arr.some((e) => e.effectiveDate === event.effectiveDate)) arr.push(event);
}

// ── Finnhub (attempted first; see file header re: plan gating) ──────────────

interface FinnhubSplitRaw {
  symbol?: string;
  date?: string;
  fromFactor?: number;
  toFactor?: number;
}

/**
 * Fetch splits for ONE ticker from Finnhub. Finnhub's split endpoint is
 * single-symbol only (no batch form), mirroring the per-ticker
 * `fetchFinnhubPortfolioQuote` pattern already used for portfolio quotes.
 * Returns an empty array on ANY failure (missing key, plan-gated 403-style
 * body, network error, malformed response) - never throws, never fabricates.
 */
async function fetchFinnhubSplitsForTicker(
  ticker: string,
  start: string,
  end: string,
): Promise<StockSplitEvent[]> {
  const key = finnhubKey();
  if (!key) return [];
  // `/stock/split` is paid-plan-only on Finnhub now (403 for every ticker on a
  // free key). Alpaca below is the working primary, so trip this lane off after
  // the first refusal rather than spending a failed call per ticker.
  if (isPlanBlocked("finnhub", "/stock/split")) return [];
  try {
    const rows = await httpJson<FinnhubSplitRaw[] | { error?: string }>(
      `${FINNHUB}/stock/split?symbol=${encodeURIComponent(ticker)}&from=${start}&to=${end}&token=${encodeURIComponent(key)}`,
      { timeoutMs: 10_000 },
    );
    if (!Array.isArray(rows)) return []; // e.g. {"error": "..."} on a plan-gated key
    const out: StockSplitEvent[] = [];
    for (const row of rows) {
      const event = toEvent(row.symbol ?? ticker, row.date ?? "", row.fromFactor ?? 0, row.toFactor ?? 0);
      if (event) out.push(event);
    }
    return out;
  } catch (err) {
    const e = err as { status?: number; body?: string };
    // Endpoint-level plan gate (see aggregateCoverage) - Alpaca carries splits.
    if (e?.status === 401 || e?.status === 403) {
      notePlanBlocked("finnhub", "/stock/split", e.status, "restricted endpoint");
    }
    return [];
  }
}

// ── Alpaca (confirmed working - the effective primary path today) ───────────

interface AlpacaSplitRaw {
  symbol: string;
  ex_date: string;
  old_rate: number;
  new_rate: number;
}

interface AlpacaCorporateActionsResponse {
  corporate_actions?: {
    forward_splits?: AlpacaSplitRaw[];
    reverse_splits?: AlpacaSplitRaw[];
  };
  next_page_token?: string | null;
}

/**
 * Batch-fetch splits for many tickers in ONE request - Alpaca's endpoint
 * accepts a comma-separated `symbols` list. Returns an empty map on any
 * failure (missing key, network error) - never throws.
 */
async function fetchAlpacaSplits(
  tickers: string[],
  start: string,
  end: string,
): Promise<Record<string, StockSplitEvent[]>> {
  const keyId = alpacaKeyId();
  const secret = alpacaSecret();
  if (!keyId || !secret || tickers.length === 0) return {};

  const params = new URLSearchParams({
    symbols: tickers.join(","),
    types: "forward_split,reverse_split",
    start,
    end,
  });
  try {
    const json = await httpJson<AlpacaCorporateActionsResponse>(
      `${ALPACA_CORPORATE_ACTIONS}?${params}`,
      { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret }, timeoutMs: 15_000 },
    );
    const out: Record<string, StockSplitEvent[]> = {};
    for (const row of json.corporate_actions?.forward_splits ?? []) {
      mergeEvent(out, toEvent(row.symbol, row.ex_date, row.old_rate, row.new_rate));
    }
    for (const row of json.corporate_actions?.reverse_splits ?? []) {
      mergeEvent(out, toEvent(row.symbol, row.ex_date, row.old_rate, row.new_rate));
    }
    return out;
  } catch {
    return {};
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch real split events for a set of tickers over `[start, end]`
 * (YYYY-MM-DD). Tries Finnhub per-ticker first (works automatically if/when
 * the plan supports it); any ticker Finnhub didn't answer falls back to a
 * single batched Alpaca call. Never throws - a provider outage degrades to
 * "no splits found" for the affected tickers rather than blocking the caller.
 */
export async function fetchStockSplits(
  tickers: string[],
  opts: { start: string; end?: string } = { start: "2000-01-01" },
): Promise<Record<string, StockSplitEvent[]>> {
  const list = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) return {};
  const start = opts.start;
  const end = opts.end ?? new Date().toISOString().slice(0, 10);

  const out: Record<string, StockSplitEvent[]> = {};

  if (finnhubKey()) {
    const finnhubResults = await Promise.all(
      list.map(async (ticker) => [ticker, await fetchFinnhubSplitsForTicker(ticker, start, end)] as const),
    );
    for (const [, events] of finnhubResults) for (const event of events) mergeEvent(out, event);
  }

  const stillMissing = list.filter((ticker) => !out[ticker]);
  if (stillMissing.length > 0) {
    const alpacaResults = await fetchAlpacaSplits(stillMissing, start, end);
    for (const events of Object.values(alpacaResults)) for (const event of events) mergeEvent(out, event);
  }

  for (const events of Object.values(out)) events.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  return out;
}
