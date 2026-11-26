import {
  alpacaKeyId,
  alpacaSecret,
  httpJson,
  isAlpacaConfigured,
  type HttpGetOptions,
} from "@/data/http";
import type { PortfolioQuote } from "@/types";

/**
 * Alpaca bulk-snapshot client - the shared live-price + pre-rank seam.
 *
 * Endpoint: `https://data.alpaca.markets/v2/stocks/snapshots?symbols=A,B,C&feed=iex`
 * Auth: `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers (free with a paper
 * account). On the keyless web/phone build the headers carry the stripped
 * {@link PROXY_INJECTED_KEY} placeholder and {@link resolveMarketRequest} routes
 * the call through the hosted proxy, which re-attaches the real keys server-side.
 *
 * ONE call returns a fresh quote for MANY symbols, so it powers two surfaces with
 * a tiny request budget:
 *   • the live-price overlay (watchlist + visible feed + detail + portfolio), and
 *   • the daily broad-universe scan's cheap cross-sectional pre-rank.
 *
 * Honest caveat: `feed=iex` is the free single-venue feed - effectively real-time
 * for liquid names, but thin micro-caps can lag the consolidated tape, and names
 * with no recent IEX print return no `latestTrade` (we fall back to the daily
 * bar). The full SIP feed is a commercial-tier upgrade.
 *
 * Pure parsing is exported separately so it stays unit-testable; the fetchers
 * degrade to partial/empty results and NEVER throw, so a dead lane never blanks a
 * price or aborts a scan.
 */

const ALPACA_SNAPSHOTS = "https://data.alpaca.markets/v2/stocks/snapshots";

/** Alpaca's per-request symbol cap is generous; we batch well under any URL limit. */
const DEFAULT_BATCH = 200;

interface AlpacaBar {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
  t?: string;
}

interface AlpacaTrade {
  p?: number;
  t?: string;
}

interface AlpacaSnapshot {
  latestTrade?: AlpacaTrade;
  latestQuote?: { ap?: number; bp?: number; t?: string };
  minuteBar?: AlpacaBar;
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

/** A normalized, snapshot-derived quote - the shape the app actually consumes. */
export interface SnapshotQuote {
  ticker: string;
  /** Best available last price (latest trade → daily close → minute close). */
  price: number;
  /** Prior session close (from prevDailyBar). */
  prevClose: number;
  /** Day change as a ratio vs prevClose (0.034 = +3.4%). */
  dayChange: number;
  /** Most recent COMPLETE-session dollar volume (prevDailyBar v × vwap/close). */
  dollarVolume: number;
  /** Prior session high-low range as a fraction of close (a realized-vol proxy). */
  rangePct: number;
  /** ISO timestamp of the freshest data point in this snapshot. */
  asOf: string;
  /** Exact source/timestamp for each composite field, for prospective audit use. */
  priceSource: "latest_trade" | "daily_bar" | "minute_bar" | "previous_daily_bar";
  priceAsOfISO: string | null;
  prevCloseSource: "previous_daily_bar" | "price_fallback";
  prevCloseAsOfISO: string | null;
  liquiditySource: "previous_daily_bar" | "daily_bar" | "imputed";
  liquidityAsOfISO: string | null;
  rangeSource: "previous_daily_bar" | "daily_bar" | "imputed";
  rangeAsOfISO: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Derive a normalized {@link SnapshotQuote} from one Alpaca snapshot. Returns null
 * when there isn't enough to anchor a price + prior close (the gate the pre-rank
 * and overlay both rely on). Pure.
 */
export function snapshotToQuote(ticker: string, snap: AlpacaSnapshot | null | undefined): SnapshotQuote | null {
  if (!snap || typeof snap !== "object") return null;
  const prevClose = num(snap.prevDailyBar?.c);
  const latestTradePrice = num(snap.latestTrade?.p);
  const dailyBarPrice = num(snap.dailyBar?.c);
  const minuteBarPrice = num(snap.minuteBar?.c);
  const price = latestTradePrice ?? dailyBarPrice ?? minuteBarPrice ?? prevClose;
  if (price == null || price <= 0) return null;
  const priceSource: SnapshotQuote["priceSource"] =
    latestTradePrice != null
      ? "latest_trade"
      : dailyBarPrice != null
        ? "daily_bar"
        : minuteBarPrice != null
          ? "minute_bar"
          : "previous_daily_bar";
  const priceAsOfISO =
    priceSource === "latest_trade"
      ? snap.latestTrade?.t ?? null
      : priceSource === "daily_bar"
        ? snap.dailyBar?.t ?? null
        : priceSource === "minute_bar"
          ? snap.minuteBar?.t ?? null
          : snap.prevDailyBar?.t ?? null;

  const baseClose = prevClose ?? price;
  const dayChange = baseClose > 0 ? (price - baseClose) / baseClose : 0;

  // Prefer the prior COMPLETE session for liquidity (today's bar is partial /
  // empty pre-market). Fall back to today's forming bar if that's all we have.
  const liqBar = snap.prevDailyBar ?? snap.dailyBar;
  const liquidityAsOfISO = liqBar?.t ?? null;
  const observedVolume = num(liqBar?.v);
  const observedVwap = num(liqBar?.vw) ?? num(liqBar?.c);
  const liquidityComplete =
    observedVolume != null && observedVolume >= 0 && observedVwap != null && observedVwap > 0;
  const liquiditySource: SnapshotQuote["liquiditySource"] = liquidityComplete
    ? snap.prevDailyBar
      ? "previous_daily_bar"
      : "daily_bar"
    : "imputed";
  const vol = observedVolume ?? 0;
  const vwap = observedVwap ?? price;
  const dollarVolume = vol * vwap;

  const hi = num(liqBar?.h);
  const lo = num(liqBar?.l);
  const observedRangeClose = num(liqBar?.c);
  const cl = observedRangeClose ?? price;
  const rangeComplete =
    hi != null &&
    hi >= 0 &&
    lo != null &&
    lo >= 0 &&
    observedRangeClose != null &&
    observedRangeClose > 0 &&
    hi >= lo;
  const rangePct = hi != null && lo != null && cl > 0 ? (hi - lo) / cl : 0;

  const asOf =
    snap.latestTrade?.t ??
    snap.minuteBar?.t ??
    snap.dailyBar?.t ??
    snap.prevDailyBar?.t ??
    new Date().toISOString();

  return {
    ticker: ticker.toUpperCase(),
    price: Number(price.toFixed(price < 5 ? 4 : 2)),
    prevClose: Number((prevClose ?? price).toFixed(price < 5 ? 4 : 2)),
    dayChange,
    dollarVolume: Math.max(0, Math.round(dollarVolume)),
    rangePct: Math.max(0, rangePct),
    asOf,
    priceSource,
    priceAsOfISO,
    prevCloseSource: prevClose != null ? "previous_daily_bar" : "price_fallback",
    prevCloseAsOfISO: prevClose != null ? snap.prevDailyBar?.t ?? null : priceAsOfISO,
    liquiditySource,
    liquidityAsOfISO: liquidityComplete ? liquidityAsOfISO : null,
    rangeSource: rangeComplete
      ? snap.prevDailyBar
        ? "previous_daily_bar"
        : "daily_bar"
      : "imputed",
    rangeAsOfISO: rangeComplete ? liquidityAsOfISO : null,
  };
}

/**
 * Pull the per-symbol snapshot map out of an Alpaca response, tolerating both the
 * top-level `{ AAPL: {...} }` shape and the wrapped `{ snapshots: { AAPL: {...} } }`
 * shape different Alpaca API versions return. Pure.
 */
export function extractSnapshotMap(json: unknown): Record<string, AlpacaSnapshot> {
  if (!json || typeof json !== "object") return {};
  const obj = json as Record<string, unknown>;
  const inner =
    obj.snapshots && typeof obj.snapshots === "object"
      ? (obj.snapshots as Record<string, unknown>)
      : obj;
  const out: Record<string, AlpacaSnapshot> = {};
  for (const [sym, snap] of Object.entries(inner)) {
    // Skip envelope fields (next_page_token, message, currency, etc.).
    if (snap && typeof snap === "object" && !Array.isArray(snap)) {
      const s = snap as AlpacaSnapshot;
      if (s.latestTrade || s.dailyBar || s.prevDailyBar || s.minuteBar) {
        out[sym.toUpperCase()] = s;
      }
    }
  }
  return out;
}

/** Parse a full Alpaca snapshot response into normalized quotes. Pure. */
export function parseSnapshotQuotes(json: unknown): Record<string, SnapshotQuote> {
  const map = extractSnapshotMap(json);
  const out: Record<string, SnapshotQuote> = {};
  for (const [ticker, snap] of Object.entries(map)) {
    const quote = snapshotToQuote(ticker, snap);
    if (quote) out[ticker] = quote;
  }
  return out;
}

function uniqueUpper(symbols: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const t = raw?.trim().toUpperCase();
    if (t && /^[A-Z][A-Z.]{0,6}$/.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface SnapshotFetchOptions {
  /** Symbols per request (defaults to 200; stays well under Alpaca's URL limits). */
  batchSize?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Optional pacing between batches (ms) - gentle on the shared free key. */
  gapMs?: number;
  /** Progress callback for the long broad-universe sweep. */
  onProgress?: (done: number, total: number) => void;
}

export type SnapshotBatchFetchStatus =
  | "complete"
  | "request_failed"
  | "invalid_payload"
  | "incomplete_payload";

/** Sanitized evidence for one Alpaca batch. Never includes headers or URLs. */
export interface SnapshotBatchAudit {
  index: number;
  status: SnapshotBatchFetchStatus;
  requestedAtISO: string;
  receivedAtISO: string;
  requestedCount: number;
  returnedCount: number;
  missingTickers: string[];
  unexpectedTickers: string[];
}

export type SnapshotFetchAuditStatus =
  | "complete"
  | "partial"
  | "not_configured"
  | "empty_request";

/** Sanitized evidence for a bulk snapshot attempt. */
export interface SnapshotFetchAudit {
  provider: "alpaca";
  endpoint: "/v2/stocks/snapshots";
  feed: "iex";
  status: SnapshotFetchAuditStatus;
  requestedAtISO: string;
  receivedAtISO: string;
  requestedCount: number;
  returnedCount: number;
  missingTickers: string[];
  unexpectedTickers: string[];
  batches: SnapshotBatchAudit[];
}

export interface AuditedSnapshotQuotes {
  quotes: Record<string, SnapshotQuote>;
  audit: SnapshotFetchAudit;
}

interface SnapshotFetchDeps {
  getKeyId?: () => string | undefined;
  getSecret?: () => string | undefined;
  fetchJson?: (url: string, opts?: HttpGetOptions) => Promise<unknown>;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch normalized snapshot quotes for many symbols, batched. Returns a partial
 * map on any per-batch failure (a dead batch is skipped, never fatal). Returns an
 * empty map when Alpaca isn't configured/queryable.
 */
export async function fetchSnapshotQuotesAudited(
  symbols: string[],
  opts: SnapshotFetchOptions = {},
  deps: SnapshotFetchDeps = {},
): Promise<AuditedSnapshotQuotes> {
  const getKeyId = deps.getKeyId ?? alpacaKeyId;
  const getSecret = deps.getSecret ?? alpacaSecret;
  const fetchJson = deps.fetchJson ?? ((url, requestOpts) => httpJson<unknown>(url, requestOpts));
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? delay;
  const requestedAtISO = now().toISOString();
  const list = uniqueUpper(symbols);
  const finish = (
    status: SnapshotFetchAuditStatus,
    quotes: Record<string, SnapshotQuote> = {},
    batches: SnapshotBatchAudit[] = [],
  ): AuditedSnapshotQuotes => {
    const missingTickers = batches.length > 0
      ? [...new Set(batches.flatMap((batch) => batch.missingTickers))].sort()
      : status === "empty_request"
        ? []
        : [...list].sort();
    const unexpectedTickers = [
      ...new Set(batches.flatMap((batch) => batch.unexpectedTickers)),
    ].sort();
    return {
      quotes,
      audit: {
        provider: "alpaca",
        endpoint: "/v2/stocks/snapshots",
        feed: "iex",
        status,
        requestedAtISO,
        receivedAtISO: now().toISOString(),
        requestedCount: list.length,
        returnedCount: Object.keys(quotes).length,
        missingTickers,
        unexpectedTickers,
        batches,
      },
    };
  };

  if (list.length === 0) return finish("empty_request");

  const keyId = getKeyId();
  const secret = getSecret();
  if (!keyId || !secret) return finish("not_configured");

  const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH, 1000));
  const batches = chunk(list, batchSize);
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
  const merged: Record<string, SnapshotQuote> = {};
  const batchAudits: SnapshotBatchAudit[] = [];
  let done = 0;

  for (const [index, batch] of batches.entries()) {
    const url =
      `${ALPACA_SNAPSHOTS}?symbols=${encodeURIComponent(batch.join(","))}&feed=iex`;
    const batchRequestedAtISO = now().toISOString();
    try {
      const json = await fetchJson(url, {
        headers,
        timeoutMs: opts.timeoutMs ?? 15_000,
      });
      const responseIsObject = Boolean(json) && typeof json === "object" && !Array.isArray(json);
      const responseMembership = responseIsObject ? Object.keys(extractSnapshotMap(json)) : [];
      const parsed = responseIsObject ? parseSnapshotQuotes(json) : {};
      const requestedSet = new Set(batch);
      const unexpectedTickers = responseMembership
        .filter((ticker) => !requestedSet.has(ticker))
        .sort();
      const accepted = Object.fromEntries(
        Object.entries(parsed).filter(([ticker]) => requestedSet.has(ticker)),
      );
      const missingTickers = batch.filter((ticker) => !accepted[ticker]).sort();
      Object.assign(merged, accepted);
      const status: SnapshotBatchFetchStatus = !responseIsObject
        ? "invalid_payload"
        : missingTickers.length > 0 || unexpectedTickers.length > 0
          ? "incomplete_payload"
          : "complete";
      batchAudits.push({
        index,
        status,
        requestedAtISO: batchRequestedAtISO,
        receivedAtISO: now().toISOString(),
        requestedCount: batch.length,
        returnedCount: Object.keys(accepted).length,
        missingTickers,
        unexpectedTickers,
      });
    } catch {
      batchAudits.push({
        index,
        status: "request_failed",
        requestedAtISO: batchRequestedAtISO,
        receivedAtISO: now().toISOString(),
        requestedCount: batch.length,
        returnedCount: 0,
        missingTickers: [...batch].sort(),
        unexpectedTickers: [],
      });
    }
    done += batch.length;
    opts.onProgress?.(done, list.length);
    if (opts.gapMs && done < list.length) await wait(opts.gapMs);
  }

  const status = batchAudits.some((batch) => batch.status !== "complete")
    ? "partial"
    : "complete";
  return finish(status, merged, batchAudits);
}

export async function fetchSnapshotQuotes(
  symbols: string[],
  opts: SnapshotFetchOptions = {},
): Promise<Record<string, SnapshotQuote>> {
  return (await fetchSnapshotQuotesAudited(symbols, opts)).quotes;
}

/**
 * Live-price overlay convenience: fetch fresh {@link PortfolioQuote}s (price +
 * dayChange + updatedAt) for the on-screen tickers. The displayed price ticks;
 * the daily research score is never touched. Never throws.
 */
export async function fetchLiveQuotes(tickers: string[]): Promise<Record<string, PortfolioQuote>> {
  const snaps = await fetchSnapshotQuotes(tickers, { batchSize: 200 });
  const out: Record<string, PortfolioQuote> = {};
  for (const [ticker, q] of Object.entries(snaps)) {
    out[ticker] = {
      ticker,
      price: q.price,
      dayChange: q.dayChange,
      updatedAt: new Date().toISOString(),
      // The REAL data timestamp (latest trade/bar), so the UI can tell a live print
      // from a prior-session close fetched overnight. Distinct from updatedAt above.
      asOf: q.asOf,
    };
  }
  return out;
}

export { isAlpacaConfigured };
