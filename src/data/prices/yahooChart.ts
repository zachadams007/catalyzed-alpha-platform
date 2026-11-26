import type { PricePoint } from "@/types";
import { httpJson } from "@/data/http";
import { isMarketProxyConfigured } from "@/data/marketProxy";

/**
 * Yahoo Finance public chart API - the app's KEYLESS, universal quote+chart
 * source. https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}
 *
 * WHY THIS IS THE COVERAGE LAYER
 * ------------------------------
 * Our keyed quote providers are US-only (Alpaca; the free Finnhub tier), so TSX
 * (`.TO`) / TSXV (`.V`) / Cboe-Canada (`.NE`) listings get nothing from them -
 * e.g. `GCU.TO` (Gunnison Copper) returned no price/chart at all. The Yahoo
 * chart endpoint, by contrast, returns a REAL quote + daily series for US AND
 * Canadian symbols with no API key, including the trading `currency` and the
 * exchange name. ONE call yields everything we need to render an honest card:
 * spot price, prior close (→ day change), the price series (→ chart + real
 * momentum), 52-week range, volume, the listed company name, currency, and
 * exchange. It does NOT expose market cap (that needs the crumb-gated quote
 * endpoints), so cap stays honestly "N/A" on this path - never fabricated.
 *
 * Discovery/research only; every caller degrades gracefully on failure.
 */

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: RawMeta;
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: unknown;
  };
}

interface RawMeta {
  symbol?: string;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longName?: string;
  shortName?: string;
  regularMarketTime?: number;
}

/** The slice of Yahoo chart `meta` the app consumes. */
export interface YahooChartMeta {
  symbol: string;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longName?: string;
  shortName?: string;
}

export interface YahooChart {
  meta: YahooChartMeta;
  /** Daily closes (oldest → newest); may be empty/short for brand-new listings. */
  series: PricePoint[];
  closes: number[];
}

const DIRECT_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

/**
 * Hosts to try for the chart call. Yahoo omits its CORS header when an Origin is
 * present, so a dev browser can't hit it directly (mirrors EDGAR in edgar8k.ts):
 *   - Tauri desktop → absolute URL via the HTTP plugin (no browser CORS).
 *   - hosted market proxy configured → absolute URL; resolveMarketRequest rewrites
 *     it to `<proxy>/yahoo/...` (see VENDOR_UPSTREAM.yahoo).
 *   - plain `npm run dev` browser → the `/__yahoo` Vite proxy (see vite.config.ts).
 */
function chartHosts(): string[] {
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;
  // Node (vite-node scripts) has no `/__yahoo` dev proxy → must use absolute hosts.
  const node = typeof window === "undefined";
  const direct = node || desktop || isMarketProxyConfigured();
  return direct ? DIRECT_HOSTS : ["/__yahoo"];
}

function parseSeries(ts: number[] | undefined, closesRaw: Array<number | null> | undefined): PricePoint[] {
  if (!ts || !closesRaw) return [];
  const series: PricePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = closesRaw[i];
    if (close == null || !Number.isFinite(close)) continue;
    series.push({
      date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
      close: Number(close.toFixed(close < 5 ? 4 : 2)),
    });
  }
  return series;
}

/** Supported chart timeframe ranges (mapped to Yahoo Finance range+interval). */
export type ChartTimeframe = "1d" | "1w" | "1m" | "3m" | "1y" | "max";

interface YahooRangeParams {
  range: string;
  interval: string;
}

/** Map our timeframe tokens to the Yahoo range+interval pair. */
export function timeframeToYahooParams(tf: ChartTimeframe): YahooRangeParams {
  switch (tf) {
    case "1d":
      return { range: "1d", interval: "5m" };
    case "1w":
      return { range: "5d", interval: "15m" };
    case "1m":
      return { range: "1mo", interval: "1d" };
    case "3m":
      return { range: "3mo", interval: "1d" };
    case "1y":
      return { range: "1y", interval: "1d" };
    case "max":
      return { range: "max", interval: "1wk" };
  }
}

/**
 * Fetch the Yahoo chart for one symbol - real meta (price/currency/exchange/
 * name) plus the daily close series. Tries both Yahoo hosts, returns null only
 * when neither yields a usable result (no meta price AND no series). Never throws.
 */
export async function fetchYahooChart(
  ticker: string,
  range = "1y",
  interval = "1d",
): Promise<YahooChart | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;

  for (const host of chartHosts()) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(
        range,
      )}&interval=${encodeURIComponent(interval)}`;
      // Tighter single-ticker budget than the global 15s safety ceiling so a
      // slow Yahoo host falls through to the next host / null promptly.
      const data = await httpJson<YahooChartResponse>(url, { timeoutMs: 10_000 });
      const result = data.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta ?? {};
      const series = parseSeries(result.timestamp, result.indicators?.quote?.[0]?.close);
      const hasPrice = typeof meta.regularMarketPrice === "number" && meta.regularMarketPrice > 0;
      if (!hasPrice && series.length === 0) continue;

      return {
        meta: {
          symbol: meta.symbol ?? symbol,
          currency: meta.currency,
          exchangeName: meta.exchangeName,
          fullExchangeName: meta.fullExchangeName,
          instrumentType: meta.instrumentType,
          regularMarketPrice: meta.regularMarketPrice,
          chartPreviousClose: meta.chartPreviousClose,
          previousClose: meta.previousClose,
          regularMarketVolume: meta.regularMarketVolume,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          longName: meta.longName,
          shortName: meta.shortName,
        },
        series,
        closes: series.map((p) => p.close),
      };
    } catch {
      /* try next host */
    }
  }
  return null;
}

/**
 * Fetch a Yahoo chart for a given ChartTimeframe token.
 * Automatically selects the correct range+interval pair for each timeframe.
 */
export async function fetchYahooChartForTimeframe(
  ticker: string,
  timeframe: ChartTimeframe,
): Promise<YahooChart | null> {
  const { range, interval } = timeframeToYahooParams(timeframe);
  return fetchYahooChart(ticker, range, interval);
}
