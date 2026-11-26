import type { PricePoint } from "@/types";

export function formatChartDate(iso: string, mode: "axis" | "tooltip"): string {
  const d = new Date(iso);
  if (mode === "tooltip") {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Build dated points when only closes exist (uses signal generation time as series end). */
export function chartPointsFromCloses(closes: number[], endIso: string): PricePoint[] {
  const endMs = new Date(endIso).getTime();
  const dates: Date[] = [];
  const cursor = new Date(endMs);
  let guard = 0;
  while (dates.length < closes.length && guard < closes.length * 3) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) dates.unshift(new Date(cursor));
    cursor.setDate(cursor.getDate() - 1);
    guard++;
  }
  return closes.map((close, i) => ({
    date: (dates[i] ?? new Date(endMs)).toISOString(),
    close,
  }));
}

export function resolveChartSeries(signal: {
  priceSeries?: PricePoint[];
  priceHistory: number[];
  generatedAt: string;
}): PricePoint[] {
  if (signal.priceSeries?.length) return signal.priceSeries;
  return chartPointsFromCloses(signal.priceHistory, signal.generatedAt);
}
