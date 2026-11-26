import { describe, expect, it } from "vitest";

import { computeOwnHistoryValuation, MIN_YEARS } from "@/engine/valuationHistory";

/**
 * OWN-HISTORY VALUATION.
 *
 * This module shipped with an off-by-one-year bug that silently corrupted every
 * reading: it paired each fiscal year with a price roughly a year too old, so in
 * July 2026 fiscal 2024 was valued against a mid-2023 close. Amazon consequently
 * read as mid-range against its own earnings history when it was in fact at the
 * cheap end. These tests pin the year alignment directly so that class of error
 * cannot return silently.
 */

/** Daily closes, oldest→newest, that rise linearly from `from` to `to`. */
function ramp(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

const ASOF = new Date(Date.UTC(2026, 6, 15)); // 15 July 2026

describe("own-history valuation — year alignment", () => {
  it("prices a fiscal year against that year's END, not a year earlier", () => {
    // Flat revenue, and a price that DOUBLED during 2025 then held. If the year
    // alignment is right, today's multiple equals the CY2025 year-end multiple and
    // is far above the CY2023/CY2024 ones - so today reads as the most expensive.
    const closes = [
      ...ramp(100, 100, 700), // through end of 2024
      ...ramp(100, 200, 300), // 2025 doubling
      ...ramp(200, 200, 260), // 2026 flat
    ];
    const revenueByYear = [
      { period: "CY2025", revenue: 1_000_000_000 },
      { period: "CY2024", revenue: 1_000_000_000 },
      { period: "CY2023", revenue: 1_000_000_000 },
      { period: "CY2022", revenue: 1_000_000_000 },
    ];
    const out = computeOwnHistoryValuation(revenueByYear, closes, 200, ASOF);
    expect(out).not.toBeNull();
    expect(out!.salesPercentile).toBeGreaterThan(0.5);
  });

  it("reads a name whose revenue outgrew its price as CHEAP against itself", () => {
    // Revenue triples, price only doubles ⇒ the multiple compressed.
    const closes = [...ramp(100, 200, 1300)];
    const revenueByYear = [
      { period: "CY2025", revenue: 3_000_000_000 },
      { period: "CY2024", revenue: 2_400_000_000 },
      { period: "CY2023", revenue: 1_800_000_000 },
      { period: "CY2022", revenue: 1_000_000_000 },
    ];
    const out = computeOwnHistoryValuation(revenueByYear, closes, 200, ASOF);
    expect(out).not.toBeNull();
    expect(out!.salesPercentile).toBeLessThan(0.5);
    // The business compounded faster than the stock.
    expect(out!.divergence).toBeGreaterThan(0);
    expect(out!.revenueCagr).toBeGreaterThan(out!.priceCagr);
  });

  it("reads a name whose price outran its revenue as EXPENSIVE against itself", () => {
    const closes = [...ramp(50, 400, 1300)];
    const revenueByYear = [
      { period: "CY2025", revenue: 1_200_000_000 },
      { period: "CY2024", revenue: 1_100_000_000 },
      { period: "CY2023", revenue: 1_050_000_000 },
      { period: "CY2022", revenue: 1_000_000_000 },
    ];
    const out = computeOwnHistoryValuation(revenueByYear, closes, 400, ASOF);
    expect(out).not.toBeNull();
    expect(out!.salesPercentile).toBeGreaterThan(0.5);
    expect(out!.divergence).toBeLessThan(0);
  });
});

describe("own-history valuation — earnings leg", () => {
  const closes = ramp(100, 150, 1400);
  const revenueByYear = [
    { period: "CY2025", revenue: 5_000_000_000 },
    { period: "CY2024", revenue: 4_500_000_000 },
    { period: "CY2023", revenue: 4_000_000_000 },
    { period: "CY2022", revenue: 3_500_000_000 },
  ];

  it("ignores a SHORT profitable history — a recent turn is not a cheap multiple", () => {
    // The Palantir case: newly profitable, so every earlier P/E was more extreme
    // and today's very high multiple would otherwise score as "cheapest ever".
    const netIncomeByYear = [
      { period: "CY2025", netIncome: 400_000_000 },
      { period: "CY2024", netIncome: 100_000_000 },
      { period: "CY2023", netIncome: -50_000_000 },
      { period: "CY2022", netIncome: -200_000_000 },
    ];
    const out = computeOwnHistoryValuation(revenueByYear, closes, 150, ASOF, netIncomeByYear);
    expect(out).not.toBeNull();
    // Only one profitable historical year ⇒ earnings leg withheld entirely.
    expect(out!.earningsPercentile).toBeNull();
    expect(out!.percentile).toBe(out!.salesPercentile);
  });

  it("uses the earnings leg when the profitable history is real, and averages it", () => {
    const netIncomeByYear = [
      { period: "CY2025", netIncome: 900_000_000 },
      { period: "CY2024", netIncome: 500_000_000 },
      { period: "CY2023", netIncome: 300_000_000 },
      { period: "CY2022", netIncome: 200_000_000 },
    ];
    const out = computeOwnHistoryValuation(revenueByYear, closes, 150, ASOF, netIncomeByYear);
    expect(out).not.toBeNull();
    expect(out!.earningsPercentile).not.toBeNull();
    // Averaged, never the cheaper leg - see the blend-site note.
    expect(out!.percentile).toBeCloseTo(
      (out!.salesPercentile + out!.earningsPercentile!) / 2,
      6,
    );
  });
});

describe("own-history valuation — refuses to guess", () => {
  it("returns null without enough disclosed years", () => {
    const closes = ramp(100, 150, 1400);
    const short = [
      { period: "CY2025", revenue: 1_000_000_000 },
      { period: "CY2024", revenue: 900_000_000 },
    ];
    expect(short.length).toBeLessThan(MIN_YEARS);
    expect(computeOwnHistoryValuation(short, closes, 150, ASOF)).toBeNull();
  });

  it("returns null without a real multi-year price series", () => {
    const revenueByYear = [
      { period: "CY2025", revenue: 1_000_000_000 },
      { period: "CY2024", revenue: 900_000_000 },
      { period: "CY2023", revenue: 800_000_000 },
    ];
    expect(computeOwnHistoryValuation(revenueByYear, ramp(100, 150, 120), 150, ASOF)).toBeNull();
  });
});
