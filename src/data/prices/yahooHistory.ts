import type { CompanyData, PricePoint } from "@/types";
import { fetchYahooChart } from "@/data/prices/yahooChart";

/**
 * Real daily price history + momentum from the keyless Yahoo chart endpoint (the
 * free Finnhub tier gates candles). Thin wrapper over {@link fetchYahooChart}
 * that enforces a usable-history floor; discovery/research only, degrades to
 * modeled on failure.
 */

export interface YahooHistory {
  series: PricePoint[];
  closes: number[];
}

export async function fetchYahooHistory(ticker: string): Promise<YahooHistory | null> {
  const chart = await fetchYahooChart(ticker, "1y");
  if (!chart || chart.series.length < 30) return null;
  return { series: chart.series, closes: chart.closes };
}

function pctChange(closes: number[], lookback: number): number {
  if (closes.length <= lookback) return 0;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - lookback]!;
  return then > 0 ? (now - then) / then : 0;
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Wilder-style RSI(14). */
function rsi(closes: number[], period = 14): number {
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

/** Replace modeled momentum + price history with real Yahoo data. */
export function applyLiveHistoryToCompany(company: CompanyData, hist: YahooHistory | null): CompanyData {
  if (!hist || hist.closes.length < 30) return company;
  const { closes, series } = hist;
  const last = closes[closes.length - 1]!;
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const return3M = pctChange(closes, 63);

  return {
    ...company,
    priceSeries: series,
    priceHistory: closes,
    momentum: {
      ...company.momentum,
      return1M: pctChange(closes, 21),
      return3M,
      return6M: pctChange(closes, 126),
      rsi: rsi(closes),
      aboveSMA50: sma50 != null ? last > sma50 : company.momentum.aboveSMA50,
      aboveSMA200: sma200 != null ? last > sma200 : company.momentum.aboveSMA200,
      relativeStrength3M: return3M - 0.04, // vs ~4% broad-market proxy
    },
  };
}
