import type { PricePoint } from "@/types";
import { round, seededRandom } from "@/lib/math";

const TRADING_DAYS = 30;

/** Walk backward from `endMs`, collecting business days (oldest → newest). */
export function tradingDayDates(endMs: number, count: number): Date[] {
  const out: Date[] = [];
  const cursor = new Date(endMs);
  let guard = 0;
  while (out.length < count && guard < count * 3) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) out.unshift(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
    guard++;
  }
  return out;
}

/** Fictional OHLC-style closes for charts (sample data only). */
export function genPriceSeries(
  ticker: string,
  current: number,
  return1M: number,
  atrPct: number,
  endMs = Date.now(),
): PricePoint[] {
  const start = current / (1 + return1M);
  const dates = tradingDayDates(endMs, TRADING_DAYS);
  const closes: number[] = [];

  for (let i = 0; i < TRADING_DAYS; i++) {
    const t = i / (TRADING_DAYS - 1);
    const base = start + (current - start) * t;
    const noise = (seededRandom(`${ticker}-${i}`) - 0.5) * atrPct * base * 1.4;
    closes.push(round(Math.max(0.01, base + noise), current < 5 ? 3 : 2));
  }
  closes[TRADING_DAYS - 1] = round(current, current < 5 ? 3 : 2);

  return dates.map((date, i) => ({
    date: date.toISOString(),
    close: closes[i] ?? current,
  }));
}

export function closesFromSeries(series: PricePoint[]): number[] {
  return series.map((p) => p.close);
}
