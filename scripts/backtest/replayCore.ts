/**
 * scripts/backtest/replayCore.ts - pure, network-free helpers for the
 * point-in-time backtest replay harness.
 *
 * Everything here is a pure function: same input → same output, no side
 * effects, no clocks, no network. That makes these trivially unit-testable
 * offline (the no-leak test never touches Alpaca) and keeps look-ahead bias
 * mechanical rather than disciplinary.
 *
 * The key invariants:
 *   • barsAsOf(bars, T) - drops every bar dated strictly AFTER T. Point-in-time
 *     safe by construction: the caller never sees a future close.
 *   • forwardReturnOffset(bars, T, offsetTradingDays) - reads the bar at exactly
 *     `offset` trading days after T (the first bar with date > T counts as day 1).
 *     Returns null when no such bar exists (window not yet closed) and ASSERTS
 *     the bar's date is strictly after T (no look-ahead).
 */

import type { DailyBars } from "@/data/alpaca/bars";

// Re-export so callers import from one place.
export type { DailyBars };

// ---------------------------------------------------------------------------
// Bar slicing - the point-in-time gate
// ---------------------------------------------------------------------------

/**
 * Return a copy of `bars` containing only bars dated on or before `asOfDate`
 * (YYYY-MM-DD). Never mutates the input. If fewer than `minBars` bars remain,
 * returns null - the caller should skip this ticker at this date.
 */
export function barsAsOf(
  bars: DailyBars,
  asOfDate: string,
  minBars = 60,
): DailyBars | null {
  // bars.series is oldest-first (guaranteed by Alpaca parser + reverse()).
  const cutIdx = bars.series.findLastIndex((p) => p.date <= asOfDate);
  if (cutIdx < 0) return null;
  const count = cutIdx + 1;
  if (count < minBars) return null;

  return {
    series: bars.series.slice(0, count),
    closes: bars.closes.slice(0, count),
    highs: bars.highs?.slice(0, count),
    lows: bars.lows?.slice(0, count),
  };
}

// ---------------------------------------------------------------------------
// Forward return calculation - no look-ahead
// ---------------------------------------------------------------------------

/**
 * Read the close `offsetTradingDays` trading days after `asOfDate` from `bars`
 * (which must already be full, not sliced - we are reading FUTURE bars here
 * deliberately, for filling forward returns AFTER all cohorts are built).
 *
 * Returns null when:
 *   • no bar exists at that offset (window not yet closed in available history)
 *   • the resolved bar's date is not strictly after asOfDate (safety assertion)
 *
 * @param bars  Full (unsliced) bar history for this ticker.
 * @param asOfDate  The cohort date (YYYY-MM-DD).
 * @param offsetTradingDays  How many trading-day bars ahead to read (e.g. 20 or 252).
 */
export function forwardReturnOffset(
  bars: DailyBars,
  asOfDate: string,
  offsetTradingDays: number,
): number | null {
  if (offsetTradingDays <= 0) return null;

  // Find the last bar on/before asOfDate (the publish-time close).
  const baseIdx = bars.series.findLastIndex((p) => p.date <= asOfDate);
  if (baseIdx < 0) return null;

  const basePrice = bars.closes[baseIdx];
  if (basePrice == null || basePrice <= 0) return null;

  // The target bar is `offsetTradingDays` bars ahead in the series.
  const targetIdx = baseIdx + offsetTradingDays;
  if (targetIdx >= bars.series.length) return null; // window not closed yet

  const targetBar = bars.series[targetIdx];
  const targetClose = bars.closes[targetIdx];

  // Safety assertion: the target bar MUST be strictly after asOfDate.
  // This is automatic (we step forward), but make it explicit.
  if (!targetBar || targetBar.date <= asOfDate) return null;
  if (targetClose == null || targetClose <= 0) return null;

  return (targetClose - basePrice) / basePrice;
}

// ---------------------------------------------------------------------------
// Weekly cohort date generator
// ---------------------------------------------------------------------------

/**
 * Generate a list of weekly as-of dates (every Friday, or the nearest prior
 * bar date) going backward from `latestDate` for `weeksBack` weeks.
 * Returns dates in ascending order (oldest first).
 *
 * We use actual bar dates so the as-of is always a real trading day.
 * The series must be passed in to extract real trading-day Fridays.
 */
export function weeklyAsOfDates(
  series: Array<{ date: string }>,
  weeksBack: number,
): string[] {
  if (series.length === 0 || weeksBack <= 0) return [];

  // Build a set of all available dates for quick lookup.
  const availDates = series.map((p) => p.date);

  // Walk backward from the most recent bar, picking one date per week.
  // Strategy: step back 7 calendar days at a time from the last bar date,
  // then snap to the nearest available trading day on or before that date.
  const lastDate = availDates[availDates.length - 1]!;
  const results: string[] = [];
  let cursor = new Date(lastDate + "T12:00:00Z");

  for (let w = 0; w < weeksBack; w++) {
    // Find the last available date on or before cursor.
    const cursorStr = cursor.toISOString().slice(0, 10);
    const snapped = availDates.findLast((d) => d <= cursorStr);
    if (!snapped) break;
    // Only add if not a duplicate.
    if (results[results.length - 1] !== snapped) {
      results.push(snapped);
    }
    // Step back 7 calendar days.
    cursor = new Date(cursor.getTime() - 7 * 86_400_000);
  }

  // Return ascending (oldest first) for ledger chronological order.
  results.reverse();
  return results;
}

// ---------------------------------------------------------------------------
// Round helper (mirrors outcomeLedger usage)
// ---------------------------------------------------------------------------

export function roundRet(v: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}
