import { alpacaKeyId, alpacaSecret } from "@/data/http";
import { pooledMap } from "@/lib/concurrency";
import type { CompanyData, PricePoint, RawMomentum } from "@/types";

/**
 * Alpaca daily-bars client - real price history + momentum for the broad-
 * universe scan.
 *
 * Why this instead of Yahoo Finance?  Yahoo's chart API blocks from the Node
 * environment on this machine (network-level).  Alpaca works fine - we already
 * use it for snapshots - and the multi-symbol bars endpoint is efficient: one
 * HTTP call returns 260 daily closes for up to 50 tickers at once.
 *
 * Endpoint: GET /v2/stocks/bars
 *   ?symbols=AAPL,MSFT,...
 *   &timeframe=1Day
 *   &limit=260        ← default bars PER symbol (≈ 1 year of trading days)
 *   &feed=iex
 *   &adjustment=split ← essential so splits don't corrupt momentum ratios
 *
 * Response: { bars: { AAPL: [{t,o,h,l,c,v,vw,n}, …], … }, next_page_token }
 *
 * Momentum math is co-located here (same as yahooHistory.ts) so the enricher
 * stays a thin adapter.
 *
 * Rate-limit strategy (Alpaca free plan ≈ 200 req/min):
 *   - A shared TokenBucket paces request starts to ≤ DEFAULT_RATE_PER_MIN
 *     (170/min) across all concurrent workers, so a 500-name scan never bursts
 *     into a 429 in the first place.
 *   - fetchBarsForOneTicker retries up to DEFAULT_MAX_RETRIES times on HTTP 429
 *     or 5xx with exponential back-off (~0.6s → 1.5s → 3s), honoring a
 *     Retry-After header when present.  A <20-bar "no data" response is NOT
 *     retried - that's a genuine data absence, not a transient error.
 *   - We use a direct `fetch` (not the shared httpJson helper) so we can read
 *     `res.status` and `Retry-After` before deciding whether to retry.
 */

const ALPACA_BARS_BASE = "https://data.alpaca.markets/v2/stocks";
const DEFAULT_LIMIT = 260;        // trading-day lookback ≈ 1 year
const DEFAULT_CONCURRENCY = 4;    // parallel workers - kept low so the bucket stays effective
const DEFAULT_RATE_PER_MIN = 170; // request starts per minute (Alpaca free ≈ 200/min; leave headroom)
const DEFAULT_MAX_RETRIES = 3;    // retry attempts on 429 / 5xx before giving up
// Base back-off delays (ms) per retry attempt (1-indexed: attempt 1, 2, 3).
const BACKOFF_MS = [600, 1500, 3000] as const;

// ── Rate-limit bucket ─────────────────────────────────────────────────────────

/**
 * A simple shared token-bucket that gates request starts to a maximum rate
 * (tokens per minute).  All concurrent workers in a single
 * `fetchAlpacaBarsForSymbols` call share one instance so the aggregate
 * throughput never exceeds `ratePerMin`.
 *
 * Each `acquire()` call waits until the minimum inter-request interval has
 * elapsed since the last grant, then records the grant timestamp and returns.
 * This is a "leaky bucket as a meter" - simple, deterministic, and sufficient
 * for a scan that runs in a single async context.
 */
class TokenBucket {
  private lastGrantMs = 0;
  private readonly intervalMs: number;

  constructor(ratePerMin: number) {
    // Spread 1 token over (60_000 / ratePerMin) ms.  Never divide by zero.
    this.intervalMs = ratePerMin > 0 ? 60_000 / ratePerMin : 0;
  }

  /** Wait until this request slot is available, then mark it taken. */
  async acquire(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    const wait = this.lastGrantMs + this.intervalMs - now;
    if (wait > 0) await delay(wait);
    this.lastGrantMs = Date.now();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Wire types ───────────────────────────────────────────────────────────────

interface AlpacaBarRaw {
  t: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
  n?: number;
}

interface AlpacaBarsResponse {
  /** Single-symbol endpoint: flat array.  Multi-symbol endpoint: keyed record. */
  bars?: AlpacaBarRaw[] | Record<string, AlpacaBarRaw[]>;
  next_page_token?: string | null;
  symbol?: string;
}

// ── Public shapes ─────────────────────────────────────────────────────────────

/** Parsed daily bars for one ticker (oldest → newest). */
export interface DailyBars {
  /** Dated OHLC-close points for interactive charts. */
  series: PricePoint[];
  /** Raw close array for momentum math. */
  closes: number[];
  /** Daily highs (parallel to closes) for true ATR. Absent on legacy/partial feeds. */
  highs?: number[];
  /** Daily lows (parallel to closes) for true ATR. Absent on legacy/partial feeds. */
  lows?: number[];
}

export interface BarsFetchOptions {
  /** Max parallel in-flight requests (default 4). */
  concurrency?: number;
  /** Max bars per symbol requested (default 260 ≈ 1 year). */
  limit?: number;
  /** Optional ISO start date (YYYY-MM-DD). Defaults to enough calendar days for `limit`. */
  start?: string;
  /** Optional ISO end date (YYYY-MM-DD). Omitted by default. */
  end?: string;
  /** Per-request timeout ms (default 15 000). */
  timeoutMs?: number;
  /**
   * Global rate cap - maximum request starts per minute across all workers
   * (default 170, well under Alpaca free-plan ≈ 200/min).  Set to 0 to
   * disable pacing (tests / local dev with no rate concern).
   */
  ratePerMin?: number;
  /**
   * Maximum retry attempts on HTTP 429 or transient 5xx errors (default 3).
   * Each attempt uses exponential back-off (~0.6s → 1.5s → 3s).  A genuine
   * "no data" response (<20 bars) is never retried.
   */
  maxRetries?: number;
  onProgress?: (done: number, total: number) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

/**
 * Parse a single-symbol Alpaca bars response into a DailyBars object.
 * The response arrives newest-first (sort=desc); we reverse to oldest-first.
 */
function parseSingleSymbolBars(json: unknown): DailyBars | null {
  if (!json || typeof json !== "object") return null;
  const resp = json as AlpacaBarsResponse;

  // Single-symbol endpoint wraps bars under `bars: { SYMBOL: [...] }`.
  let rawBars: AlpacaBarRaw[] | undefined;
  if (Array.isArray(resp.bars)) {
    // Single-symbol endpoint: { bars: [{...}, ...], symbol: "AAPL" }
    rawBars = resp.bars as AlpacaBarRaw[];
  } else if (resp.bars && typeof resp.bars === "object") {
    // Multi-symbol endpoint (fallback): { bars: { AAPL: [...] } }
    const vals = Object.values(resp.bars as Record<string, AlpacaBarRaw[]>);
    rawBars = vals[0] ?? [];
  }
  if (!rawBars || rawBars.length === 0) return null;

  const series: PricePoint[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (const bar of rawBars) {
    const c = num(bar.c);
    if (c == null || c <= 0 || !bar.t) continue;
    const close = Number(c.toFixed(c < 5 ? 4 : 2));
    series.push({ date: bar.t.slice(0, 10), close });
    // Real intraday high/low for true ATR; fall back to close when a bar omits them
    // (so the TR for that bar is 0, never a fabricated range).
    highs.push(num(bar.h) ?? close);
    lows.push(num(bar.l) ?? close);
  }
  if (series.length < 20) return null;

  // Newest-first from sort=desc → reverse to oldest-first for momentum math.
  series.reverse();
  highs.reverse();
  lows.reverse();
  return { series, closes: series.map((p) => p.close), highs, lows };
}

/**
 * Fetch up to `limit` daily bars for a single ticker.
 *
 * Uses a direct `fetch` (not the shared httpJson helper) so we can inspect
 * `res.status` and `Retry-After` to distinguish a transient throttle (429 /
 * 5xx - retryable) from a genuine no-data result (<20 bars - not retried).
 *
 * The `bucket` is acquired once before each attempt so the whole pool of
 * workers stays within the configured rate limit.
 *
 * Returns null after exhausting retries or on genuine data absence.
 */
async function fetchBarsForOneTicker(
  ticker: string,
  headers: Record<string, string>,
  limit: number,
  timeoutMs: number,
  start: string,
  end: string | undefined,
  bucket: TokenBucket,
  maxRetries: number,
): Promise<DailyBars | null> {
  const params = new URLSearchParams({
    timeframe: "1Day",
    limit: String(limit),
    sort: "desc",        // newest-first; parseSingleSymbolBars reverses
    adjustment: "split",
    start,
  });
  if (end) params.set("end", end);
  const url =
    `${ALPACA_BARS_BASE}/${encodeURIComponent(ticker)}/bars?` +
    params;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Pace request starts globally across all concurrent workers.
    await bucket.acquire();

    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetch(url, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network-level failure (timeout abort, DNS error, etc.) - treat as
      // transient and retry unless we've used up our attempts.
      if (attempt < maxRetries) {
        await delay(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
        continue;
      }
      return null;
    }

    // Transient server errors: 429 (rate-limited) or 5xx.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxRetries) {
        // Honor Retry-After when the server supplies one (in seconds).
        const retryAfterSec = Number(res.headers.get("Retry-After") ?? "");
        const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : (BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
        await delay(backoff);
        continue;
      }
      return null;
    }

    // Any other non-OK status (401 auth, 403 forbidden, 404 unknown ticker,
    // etc.) - not transient, no point retrying.
    if (!res.ok) return null;

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }

    // parseSingleSymbolBars returns null when bars < 20 - that's a genuine
    // data-absence, not a transient error, so we do NOT retry.
    return parseSingleSymbolBars(json);
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch daily bars for many symbols from Alpaca, each via its own request
 * (pooled for concurrency).  Returns a partial map - failures are skipped, never
 * fatal.  Returns an empty map when Alpaca isn't configured.
 *
 * Why single-symbol requests?  The Alpaca multi-symbol bars endpoint paginates at
 * ~260 data-points total - 1 symbol's worth - so batching brings no throughput
 * gain and adds pagination-follow complexity.  Single-symbol requests with N=3
 * in-flight are simpler and equivalent in wall-clock time.
 */
export async function fetchAlpacaBarsForSymbols(
  symbols: string[],
  opts: BarsFetchOptions = {},
): Promise<Record<string, DailyBars>> {
  const keyId = alpacaKeyId();
  const secret = alpacaSecret();
  if (!keyId || !secret) return {};

  const list = uniqueUpper(symbols);
  if (list.length === 0) return {};

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ratePerMin = opts.ratePerMin ?? DEFAULT_RATE_PER_MIN;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };

  // Shared bucket paces ALL workers to ≤ ratePerMin request starts/minute.
  const bucket = new TokenBucket(ratePerMin);

  // Look back enough calendar days to cover the requested trading-day limit plus
  // weekends/holidays. With sort=desc + limit, this ensures the MOST RECENT bars
  // are returned unless the caller pins an older historical `start`.
  const defaultCalendarDays = Math.ceil(limit * 1.6);
  const start =
    opts.start ??
    new Date(Date.now() - defaultCalendarDays * 86_400_000).toISOString().slice(0, 10);
  const end = opts.end;

  const results = await pooledMap(
    list,
    concurrency,
    async (ticker) => fetchBarsForOneTicker(ticker, headers, limit, timeoutMs, start, end, bucket, maxRetries),
    (done, total) => opts.onProgress?.(done, total),
  );

  const merged: Record<string, DailyBars> = {};
  for (let i = 0; i < list.length; i++) {
    const bars = results[i];
    if (bars) merged[list[i]!] = bars;
  }
  return merged;
}

// ── Momentum math (mirrors yahooHistory.ts) ───────────────────────────────────

function pctChange(closes: number[], lookback: number): number {
  if (closes.length <= lookback) return 0;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - lookback]!;
  return then > 0 ? (now - then) / then : 0;
}

function smaN(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * True ATR(14) as a fraction of the last close, Wilder-smoothed - replaces the
 * synthetic seed `atrPct` with a real value computed from the OHLC we already
 * fetch. Returns null when high/low aren't available or there's too little data
 * (caller then keeps the prior value rather than fabricating one).
 *
 * TR_i = max(high−low, |high−prevClose|, |low−prevClose|); ATR = Wilder average.
 */
function wilderAtrPct(highs: number[], lows: number[], closes: number[]): number | null {
  const period = 14;
  const n = closes.length;
  if (n < period + 1 || highs.length !== n || lows.length !== n) return null;

  const tr: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = highs[i]!;
    const l = lows[i]!;
    const prevClose = closes[i - 1]!;
    tr.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  if (tr.length < period) return null;

  // Seed with the simple average of the first 14 TRs, then Wilder-smooth.
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]!) / period;
  }
  const lastClose = closes[n - 1]!;
  if (!(lastClose > 0) || !Number.isFinite(atr)) return null;
  return atr / lastClose;
}

/** Wilder-style RSI(14) - same formula as yahooHistory.ts. Exported for unit tests. */
export function rsi14(closes: number[]): number {
  const period = 14;
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return Math.round(100 - 100 / (1 + rs));
}

// ── Exported pure helpers (also used by momentumFromCloses) ──────────────────

/** Exported for unit tests. */
export { pctChange, smaN };

// ── fetchDailyBars - single-ticker convenience ────────────────────────────────

/**
 * Fetch up to `days` (default 252) split-adjusted daily closes for a single
 * ticker from Alpaca, oldest → newest.
 *
 * Uses the SAME auth/proxy path as {@link fetchAlpacaBarsForSymbols}: keys via
 * `alpacaKeyId()`/`alpacaSecret()` with the PROXY_INJECTED_KEY sentinel on a
 * keyless web build.
 *
 * Returns an empty array on any failure - never throws, so a caller in the scan
 * can degrade gracefully.
 */
export async function fetchDailyBars(
  ticker: string,
  days = 252,
): Promise<number[]> {
  const keyId = alpacaKeyId();
  const secret = alpacaSecret();
  if (!keyId || !secret) return [];

  const headers = { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret };
  // Look back enough calendar days to cover the requested trading days plus
  // weekends/holidays (≈ 1.5× the trading-day count).
  const calendarDays = Math.ceil(days * 1.5);
  const start = new Date(Date.now() - calendarDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Single-ticker convenience: no rate bucket needed (bucket with ratePerMin=0
  // disables pacing), and a single retry is sufficient.
  const bucket = new TokenBucket(0);
  const bars = await fetchBarsForOneTicker(ticker, headers, days, 15_000, start, undefined, bucket, 1);
  return bars?.closes ?? [];
}

// ── momentumFromCloses - pure momentum from a close array ────────────────────

/**
 * Compute a {@link RawMomentum} from an oldest→newest close array.
 *
 * Lookback windows:
 *   - return1M  ≈ 21 trading days
 *   - return3M  ≈ 63 trading days
 *   - return6M  ≈ 126 trading days
 *   - rsi       14-period Wilder RSI
 *   - aboveSMA50 / aboveSMA200 from the last close
 *   - relativeStrength3M  the stock's own 3M return
 *     // TODO: subtract a real market (SPY) 3M return once available
 *
 * Returns null when `closes` has fewer than 30 entries so the caller can
 * detect insufficient data and fall back to a modeled momentum value.
 */
export function momentumFromCloses(closes: number[]): RawMomentum | null {
  if (closes.length < 30) return null;

  const last = closes[closes.length - 1]!;
  const sma50 = smaN(closes, 50);
  const sma200 = smaN(closes, 200);
  const return3M = pctChange(closes, 63);

  return {
    return1M: pctChange(closes, 21),
    return3M,
    return6M: pctChange(closes, 126),
    rsi: rsi14(closes),
    aboveSMA50: sma50 != null ? last > sma50 : false,
    aboveSMA200: sma200 != null ? last > sma200 : false,
    // TODO: subtract market (SPY) 3M return once a shared market-return feed exists
    relativeStrength3M: return3M,
  };
}

/**
 * Overlay real Alpaca daily bars onto a CompanyData - replaces synthetic
 * price history + modeled momentum with computed values.  The daily SCORE and
 * all other fields are untouched.  Falls through to the original company if
 * `bars` is null/undefined or has fewer than 20 closes.
 *
 * @param marketReturn3M  3M return of the broad market (SPY).  Used to compute
 *   relativeStrength3M = ticker3M - market3M.  Defaults to a ~4% proxy.
 */
/**
 * REALIZED beta of `closes` against the market, from overlapping daily returns.
 *
 * The beta on a live record used to come straight from the ticker-hash PRNG
 * (`0.7 + hash * 1.8`). This computes it from the same real closes the momentum
 * math already uses - cov(stock, market) / var(market) over the trailing window -
 * so the volatility dimension is scored on something observed. Returns null when
 * there is not enough overlapping history to measure it honestly.
 */
export function realizedBeta(
  closes: number[],
  marketCloses: number[],
  window = 120,
): number | null {
  const n = Math.min(closes.length, marketCloses.length);
  if (n < 40) return null;
  const take = Math.min(window, n - 1);
  const a: number[] = [];
  const b: number[] = [];
  for (let i = n - take; i < n; i++) {
    const p0 = closes[closes.length - n + i - 1];
    const p1 = closes[closes.length - n + i];
    const m0 = marketCloses[marketCloses.length - n + i - 1];
    const m1 = marketCloses[marketCloses.length - n + i];
    if (p0 == null || p1 == null || m0 == null || m1 == null || p0 <= 0 || m0 <= 0) continue;
    a.push((p1 - p0) / p0);
    b.push((m1 - m0) / m0);
  }
  if (a.length < 30) return null;
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i]! - meanA) * (b[i]! - meanB);
    varB += (b[i]! - meanB) ** 2;
  }
  if (varB <= 0) return null;
  const beta = cov / varB;
  // A measured beta outside this range is a data artifact, not a real exposure.
  return Number.isFinite(beta) && beta > -3 && beta < 6 ? beta : null;
}

export function applyAlpacaBarsToCompany(
  company: CompanyData,
  bars: DailyBars | null | undefined,
  marketReturn3M = 0.04,
  marketCloses: number[] = [],
): CompanyData {
  if (!bars || bars.closes.length < 20) return company;

  const { closes, series, highs, lows } = bars;
  const last = closes[closes.length - 1]!;
  const sma50 = smaN(closes, 50);
  const sma200 = smaN(closes, 200);
  const return3M = pctChange(closes, 63);

  // Real ATR% from the OHLC (kills the synthetic seed value). Keep the prior value
  // when high/low aren't available rather than fabricating one.
  const realAtrPct = highs && lows ? wilderAtrPct(highs, lows, closes) : null;

  return {
    ...company,
    priceSeries: series,
    priceHistory: closes,
    momentum: {
      ...company.momentum,
      return1M: pctChange(closes, 21),
      return3M,
      return6M: pctChange(closes, 126),
      rsi: rsi14(closes),
      aboveSMA50: sma50 != null ? last > sma50 : company.momentum.aboveSMA50,
      aboveSMA200: sma200 != null ? last > sma200 : company.momentum.aboveSMA200,
      relativeStrength3M: return3M - marketReturn3M,
    },
    volatility: {
      ...company.volatility,
      ...(realAtrPct != null ? { atrPct: Number(realAtrPct.toFixed(4)) } : {}),
      // Real measured beta replaces the ticker-hash value; left untouched when
      // there is not enough overlapping market history to measure it.
      ...(() => {
        const beta = realizedBeta(closes, marketCloses);
        return beta != null ? { beta: Number(beta.toFixed(3)) } : {};
      })(),
    },
  };
}
