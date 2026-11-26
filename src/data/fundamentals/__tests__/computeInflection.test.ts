import { describe, expect, it } from "vitest";

import { computeInflectionInputs, type QuarterlyMetrics } from "@/data/fundamentals/enrichInflection";

// Newest-first quarterly series: re-accelerating sales-per-share off a softer
// prior 2 quarters, with gross + operating margin improving YoY (idx 0 vs 4) and
// SG&A/sales falling YoY.
const RISING: QuarterlyMetrics = {
  grossMargin: [0.5, 0.48, 0.47, 0.46, 0.44, 0.43],
  operatingMargin: [0.08, 0.04, 0.02, 0.01, -0.03, -0.05],
  salesPerShare: [1.3, 1.15, 1.1, 1.08, 1.0, 0.96],
  sgaToSale: [0.3, 0.33, 0.35, 0.36, 0.38, 0.39],
  evToSalesTTM: 8,
};

describe("computeInflectionInputs (Finnhub quarterly metric series)", () => {
  it("computes re-acceleration, margin deltas, opex leverage + EV/Sales", () => {
    const inf = computeInflectionInputs(RISING)!;
    expect(inf).toBeDefined();
    // QoQ(0)=15/115≈0.130 against the same transition a year earlier
    // QoQ(4)=4/96≈0.042 → seasonally matched accel ≈ +0.089.
    expect(inf.revAccelQoQ!).toBeGreaterThan(0.05);
    // YoY(0)=0.30; YoY(1)≈0.198 → accel>0.
    expect(inf.revYoYAccel!).toBeGreaterThan(0);
    expect(inf.grossMarginDeltaYoY!).toBeCloseTo(0.06, 5); // 0.50 - 0.44
    expect(inf.opMarginNow!).toBeCloseTo(0.08, 5);
    expect(inf.opMarginPrevYearQ!).toBeCloseTo(-0.03, 5); // turned positive
    expect(inf.opexPctRevDeltaYoY!).toBeCloseTo(-0.08, 5); // 0.30 - 0.38 (improving)
    expect(inf.evToSales).toBe(8);
  });

  it("does not read a retailer's Q4→Q1 seasonal drop as a deceleration", () => {
    // Newest-first: Q1 (post-holiday) · Q4 (holiday) · Q3 · Q2 · Q1 · Q4 · Q3 · Q2.
    // Every quarter is up ~10% on the year-ago quarter; the only "moves" are the
    // calendar. The sequential read used to score this ≈ −0.27; the seasonally
    // matched read must be ≈ 0.
    const seasonal: QuarterlyMetrics = {
      grossMargin: [],
      operatingMargin: [],
      salesPerShare: [110, 143, 105, 100, 100, 130, 95.5, 91],
      sgaToSale: [],
    };
    const inf = computeInflectionInputs(seasonal)!;
    expect(Math.abs(inf.revAccelQoQ!)).toBeLessThan(0.02);
    // And a Q4→Q1 transition that holds up BETTER than last year's is a genuine
    // (positive) second derivative, even though the sequential growth is negative.
    const improving: QuarterlyMetrics = {
      ...seasonal,
      salesPerShare: [120, 143, 105, 100, 100, 130, 95.5, 91],
    };
    expect(computeInflectionInputs(improving)!.revAccelQoQ!).toBeGreaterThan(0.05);
  });

  it("returns undefined when there's nothing computable (never fabricates)", () => {
    expect(
      computeInflectionInputs({ grossMargin: [], operatingMargin: [], salesPerShare: [], sgaToSale: [] }),
    ).toBeUndefined();
  });

  it("omits fields whose required quarters are missing (partial history)", () => {
    // Only 2 quarters of margin → no YoY (needs idx 4); op margin now still set.
    const inf = computeInflectionInputs({
      grossMargin: [0.5, 0.48],
      operatingMargin: [0.08, 0.04],
      salesPerShare: [1.3, 1.15],
      sgaToSale: [0.3, 0.33],
    });
    expect(inf?.grossMarginDeltaYoY).toBeUndefined();
    expect(inf?.revAccelQoQ).toBeUndefined(); // needs 6 quarters of sps (seasonal match)
    expect(inf?.opMarginNow).toBeCloseTo(0.08, 5);
  });
});
