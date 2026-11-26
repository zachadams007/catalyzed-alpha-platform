import { describe, expect, it } from "vitest";
import { computeSplitAdjustment, formatSplitRatio } from "@/engine/portfolioSplits";
import type { StockSplitEvent } from "@/data/corporateActions/splits";
import type { PortfolioHolding } from "@/types";

/**
 * Split-adjustment engine - covers the exact bug reported: a held position
 * keeps its OLD share count after a reverse split, so `shares × post-split
 * price` produces a phantom ~10x market value (and the same inflated value
 * feeds "Today"'s dollar change, every day). `computeSplitAdjustment` is the
 * pure decision function that rescales `shares`/`costBasis` - never silently:
 * every rescale carries an audit trail (`splitAdjustment`) the UI must surface
 * with Undo (see `SplitAdjustmentNote.tsx`).
 */

const reverseEvent: StockSplitEvent = {
  ticker: "GE",
  effectiveDate: "2021-08-02",
  oldRate: 8,
  newRate: 1,
  factor: 1 / 8,
  isReverse: true,
  label: "1-for-8 reverse split",
};

const forwardEvent: StockSplitEvent = {
  ticker: "AAPL",
  effectiveDate: "2020-08-31",
  oldRate: 1,
  newRate: 4,
  factor: 4,
  isReverse: false,
  label: "4-for-1 split",
};

function holding(overrides: Partial<PortfolioHolding> & { ticker: string; addedAt: string }): PortfolioHolding {
  return { ...overrides };
}

describe("computeSplitAdjustment", () => {
  it("rescales shares/costBasis for a reverse split when the lot predates it", () => {
    const h = holding({ ticker: "GE", addedAt: "2020-01-01T00:00:00.000Z", shares: 1000, costBasis: 10 });
    const patch = computeSplitAdjustment(h, [reverseEvent]);
    expect(patch).not.toBeNull();
    expect(patch!.shares).toBeCloseTo(125); // 1000 * (1/8) - fixes the phantom-value bug
    expect(patch!.costBasis).toBeCloseTo(80); // 10 / (1/8) - total cost basis preserved
    expect(patch!.splitAdjustment.factor).toBeCloseTo(1 / 8);
    expect(patch!.splitAdjustment.originalShares).toBe(1000);
    expect(patch!.splitAdjustment.originalCostBasis).toBe(10);
    expect(patch!.splitAdjustment.appliedDates).toEqual(["2021-08-02"]);
  });

  it("rescales shares/costBasis UP for a forward split", () => {
    const h = holding({ ticker: "AAPL", addedAt: "2019-01-01T00:00:00.000Z", shares: 10, costBasis: 400 });
    const patch = computeSplitAdjustment(h, [forwardEvent]);
    expect(patch).not.toBeNull();
    expect(patch!.shares).toBeCloseTo(40); // 10 * 4
    expect(patch!.costBasis).toBeCloseTo(100); // 400 / 4
  });

  it("does NOT adjust a lot added AFTER the split — already post-split terms", () => {
    const h = holding({ ticker: "GE", addedAt: "2022-01-01T00:00:00.000Z", shares: 125, costBasis: 80 });
    expect(computeSplitAdjustment(h, [reverseEvent])).toBeNull();
  });

  it("is idempotent — a date already in appliedDates is never re-applied", () => {
    const h = holding({
      ticker: "GE",
      addedAt: "2020-01-01T00:00:00.000Z",
      shares: 125,
      costBasis: 80,
      splitAdjustment: {
        factor: 1 / 8,
        appliedDates: ["2021-08-02"],
        label: "1-for-8 reverse split",
        appliedAt: "2026-01-01T00:00:00.000Z",
        originalShares: 1000,
        originalCostBasis: 10,
      },
    });
    expect(computeSplitAdjustment(h, [reverseEvent])).toBeNull();
  });

  it("permanently skips a split date the user explicitly rejected via Undo", () => {
    const h = holding({
      ticker: "GE",
      addedAt: "2020-01-01T00:00:00.000Z",
      shares: 1000,
      costBasis: 10,
      rejectedSplitDates: ["2021-08-02"],
    });
    expect(computeSplitAdjustment(h, [reverseEvent])).toBeNull();
  });

  it("returns null for a holding with no shares tracked", () => {
    const h = holding({ ticker: "GE", addedAt: "2020-01-01T00:00:00.000Z" });
    expect(computeSplitAdjustment(h, [reverseEvent])).toBeNull();
  });

  it("compounds multiple pending splits since the last check", () => {
    const secondReverse: StockSplitEvent = {
      ticker: "GE",
      effectiveDate: "2023-01-01",
      oldRate: 2,
      newRate: 1,
      factor: 0.5,
      isReverse: true,
      label: "1-for-2 reverse split",
    };
    const h = holding({ ticker: "GE", addedAt: "2020-01-01T00:00:00.000Z", shares: 1000, costBasis: 10 });
    const patch = computeSplitAdjustment(h, [reverseEvent, secondReverse]);
    expect(patch).not.toBeNull();
    expect(patch!.shares).toBeCloseTo(62.5); // 1000 * (1/8) * (1/2)
    expect(patch!.splitAdjustment.appliedDates).toEqual(["2021-08-02", "2023-01-01"]);
  });
});

describe("formatSplitRatio", () => {
  it("formats a reverse split as 1:X", () => {
    expect(formatSplitRatio(1 / 8)).toBe("1:8");
    expect(formatSplitRatio(0.1)).toBe("1:10");
  });

  it("formats a forward split as X:1", () => {
    expect(formatSplitRatio(4)).toBe("4:1");
  });
});
