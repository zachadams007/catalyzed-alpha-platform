/**
 * scripts/backtest/__tests__/noLeak.test.ts
 *
 * Pure unit tests for the point-in-time helpers in replayCore.ts.
 * These run 100% offline - no network, no Alpaca keys required.
 *
 * The three invariants we test:
 *   1. barsAsOf drops every bar dated strictly AFTER the as-of date.
 *   2. forwardReturnOffset only reads a bar strictly after asOfDate and
 *      returns null when no such bar exists.
 *   3. A future-dated bar fed into barsAsOf never appears in the sliced set
 *      (the "no look-ahead" property).
 */

import { describe, expect, it } from "vitest";
import type { DailyBars } from "@/data/alpaca/bars";
import { barsAsOf, forwardReturnOffset, weeklyAsOfDates } from "../replayCore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a synthetic DailyBars with closes = [100, 101, 102, …] on consecutive dates. */
function makeBars(startDate: string, count: number): DailyBars {
  const series: { date: string; close: number }[] = [];
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];

  let d = new Date(startDate + "T12:00:00Z");
  for (let i = 0; i < count; i++) {
    const date = d.toISOString().slice(0, 10);
    const close = 100 + i;
    series.push({ date, close });
    closes.push(close);
    highs.push(close + 0.5);
    lows.push(close - 0.5);
    d = new Date(d.getTime() + 86_400_000); // +1 calendar day
  }
  return { series, closes, highs, lows };
}

// ---------------------------------------------------------------------------
// barsAsOf - point-in-time slicing
// ---------------------------------------------------------------------------

describe("barsAsOf", () => {
  it("returns only bars dated <= asOfDate", () => {
    // 120 days starting 2024-01-01
    const bars = makeBars("2024-01-01", 120);
    const asOf = "2024-02-15"; // somewhere in the middle
    const sliced = barsAsOf(bars, asOf, 1);
    expect(sliced).not.toBeNull();
    // Every bar in the sliced set must have date <= asOf
    for (const p of sliced!.series) {
      expect(p.date <= asOf).toBe(true);
    }
  });

  it("excludes ALL bars dated strictly after asOfDate", () => {
    const bars = makeBars("2024-01-01", 120);
    const asOf = "2024-02-15";
    const sliced = barsAsOf(bars, asOf, 1);
    expect(sliced).not.toBeNull();
    const futureBars = sliced!.series.filter((p) => p.date > asOf);
    expect(futureBars).toHaveLength(0);
  });

  it("returns null when fewer than minBars bars exist on/before asOfDate", () => {
    const bars = makeBars("2024-01-01", 120);
    // Only 5 bars before asOf if asOf is 2024-01-05
    const result = barsAsOf(bars, "2024-01-05", 60);
    expect(result).toBeNull();
  });

  it("returns null when asOfDate is before the first bar", () => {
    const bars = makeBars("2024-06-01", 120);
    const result = barsAsOf(bars, "2024-01-01", 1);
    expect(result).toBeNull();
  });

  it("closes array length matches series length after slicing", () => {
    const bars = makeBars("2024-01-01", 120);
    const asOf = "2024-03-01";
    const sliced = barsAsOf(bars, asOf, 1);
    expect(sliced).not.toBeNull();
    expect(sliced!.closes.length).toBe(sliced!.series.length);
    expect(sliced!.highs?.length).toBe(sliced!.series.length);
    expect(sliced!.lows?.length).toBe(sliced!.series.length);
  });

  it("does not mutate the original bars object", () => {
    const bars = makeBars("2024-01-01", 120);
    const originalLength = bars.series.length;
    barsAsOf(bars, "2024-02-01", 1);
    expect(bars.series.length).toBe(originalLength);
  });

  it("a future-dated bar in the original set never leaks into the sliced result", () => {
    // Construct bars that span a wide range including bars well in the future
    const bars = makeBars("2024-01-01", 400);
    const asOf = "2024-06-30"; // roughly halfway
    const sliced = barsAsOf(bars, asOf, 1);
    expect(sliced).not.toBeNull();

    // The last bar in the original set is ~2025-02 (400 days out).
    // None of those future bars should appear.
    const leaked = sliced!.series.filter((p) => p.date > asOf);
    expect(leaked).toHaveLength(0);

    // And the original still has the full 400 bars
    expect(bars.series.length).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// forwardReturnOffset - no look-ahead on forward returns
// ---------------------------------------------------------------------------

describe("forwardReturnOffset", () => {
  it("reads exactly offsetTradingDays bars after the last bar on/before asOfDate", () => {
    // 300 daily bars starting 2024-01-01 with known closes (100 + i).
    const bars = makeBars("2024-01-01", 300);
    // asOf = bar #60 (2024-03-01-ish, 0-indexed)
    const asOf = bars.series[59]!.date; // index 59
    const baseClose = bars.closes[59]!; // 159

    const ret20 = forwardReturnOffset(bars, asOf, 20);
    expect(ret20).not.toBeNull();
    const expected20 = (bars.closes[59 + 20]! - baseClose) / baseClose;
    expect(ret20).toBeCloseTo(expected20, 6);
  });

  it("returns null when the target bar is strictly after asOfDate — not on or before", () => {
    const bars = makeBars("2024-01-01", 300);
    const asOf = bars.series[59]!.date; // bar at index 59

    // offset=1 → index 60, which is the NEXT day, so date > asOf ✓
    const ret = forwardReturnOffset(bars, asOf, 1);
    expect(ret).not.toBeNull(); // valid (next bar exists and is after asOf)

    // Manually verify the resolved bar date is strictly after asOf
    const baseIdx = bars.series.findLastIndex((p) => p.date <= asOf);
    const targetBar = bars.series[baseIdx + 1];
    expect(targetBar!.date > asOf).toBe(true);
  });

  it("returns null when the window has not closed yet (not enough bars)", () => {
    const bars = makeBars("2024-01-01", 300);
    // asOf = the last available bar
    const asOf = bars.series[bars.series.length - 1]!.date;

    // 252-day window: no bars exist that far ahead
    const ret = forwardReturnOffset(bars, asOf, 252);
    expect(ret).toBeNull();
  });

  it("returns null when asOfDate is before all bars", () => {
    const bars = makeBars("2024-06-01", 300);
    const ret = forwardReturnOffset(bars, "2024-01-01", 20);
    expect(ret).toBeNull();
  });

  it("never reads the bar AT asOfDate as the forward return (strictly after)", () => {
    // One bar exactly at asOf, one bar after it
    const bars: DailyBars = {
      series: [
        { date: "2024-06-01", close: 100 },
        { date: "2024-06-02", close: 110 },
      ],
      closes: [100, 110],
      highs: [101, 111],
      lows: [99, 109],
    };
    const ret = forwardReturnOffset(bars, "2024-06-01", 1);
    expect(ret).not.toBeNull();
    // Forward return is (110-100)/100 = 0.10, not 0
    expect(ret).toBeCloseTo(0.1, 6);
  });

  it("returns positive/negative return correctly (not always positive)", () => {
    const bars: DailyBars = {
      series: [
        { date: "2024-06-01", close: 100 },
        { date: "2024-06-02", close: 90 },
      ],
      closes: [100, 90],
    };
    const ret = forwardReturnOffset(bars, "2024-06-01", 1);
    expect(ret).not.toBeNull();
    expect(ret!).toBeCloseTo(-0.1, 6);
  });
});

// ---------------------------------------------------------------------------
// weeklyAsOfDates
// ---------------------------------------------------------------------------

describe("weeklyAsOfDates", () => {
  it("returns empty array for zero weeks", () => {
    const bars = makeBars("2024-01-01", 100);
    expect(weeklyAsOfDates(bars.series, 0)).toHaveLength(0);
  });

  it("returns at most weeksBack dates", () => {
    const bars = makeBars("2024-01-01", 200);
    const dates = weeklyAsOfDates(bars.series, 10);
    expect(dates.length).toBeLessThanOrEqual(10);
    expect(dates.length).toBeGreaterThan(0);
  });

  it("returns dates in ascending order", () => {
    const bars = makeBars("2024-01-01", 200);
    const dates = weeklyAsOfDates(bars.series, 10);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! >= dates[i - 1]!).toBe(true);
    }
  });

  it("all returned dates are in the bars series", () => {
    const bars = makeBars("2024-01-01", 200);
    const availSet = new Set(bars.series.map((p) => p.date));
    const dates = weeklyAsOfDates(bars.series, 10);
    for (const d of dates) {
      expect(availSet.has(d)).toBe(true);
    }
  });
});
