import { describe, it, expect } from "vitest";

import {
  cleanupPortfolios,
  FAKE_TEST_PORTFOLIO_ID,
  SEED_PORTFOLIOS,
} from "@/data/seedPortfolios";
import { resolveDemoSignal } from "@/data/demoHoldings";
import { computePortfolioAnalytics } from "@/engine/portfolioAnalytics";
import { derivePortfolioHistory } from "@/engine/portfolioHistory";
import type { Portfolio, PortfolioHolding } from "@/types";

function makeBook(overrides: Partial<Portfolio> & { id: string }): Portfolio {
  return {
    name: overrides.name ?? overrides.id,
    mode: "Custom",
    description: "",
    owner: "me",
    isPublic: false,
    holdings: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const lot = (ticker: string): PortfolioHolding => ({
  ticker,
  addedAt: "2026-05-01T00:00:00.000Z",
  shares: 10,
  costBasis: 50,
});

/** A watch-only holding - added with no shares/value (a common imported shape). */
const watchLot = (ticker: string): PortfolioHolding => ({
  ticker,
  addedAt: "2026-05-01T00:00:00.000Z",
});

function isStraightLine(values: number[]): boolean {
  if (values.length < 3) return true;
  const slopes = new Set<number>();
  for (let i = 1; i < values.length; i++) slopes.add(Math.round(values[i]! - values[i - 1]!));
  return slopes.size <= 1;
}

describe("SEED_PORTFOLIOS — the TESTING demo book", () => {
  const seed = SEED_PORTFOLIOS.find((p) => p.id === FAKE_TEST_PORTFOLIO_ID)!;

  it("ships exactly one owned, fully-tracked TESTING book", () => {
    expect(SEED_PORTFOLIOS).toHaveLength(1);
    expect(seed.name).toBe("TESTING");
    expect(seed.owner).toBe("me");
    expect(seed.holdings.length).toBeGreaterThanOrEqual(5);
    expect(seed.holdings.every((h) => (h.shares ?? 0) > 0 && (h.costBasis ?? 0) > 0)).toBe(true);
  });

  it("bakes a real, non-linear value history", () => {
    const history = seed.valueHistory ?? [];
    expect(history.length).toBeGreaterThanOrEqual(10);
    expect(history.every((p) => Number.isFinite(p.value) && p.value > 0)).toBe(true);
    expect(isStraightLine(history.map((p) => p.value))).toBe(false);
    // Strictly ascending dates.
    for (let i = 1; i < history.length; i++) {
      expect(history[i]!.date > history[i - 1]!.date).toBe(true);
    }
  });

  it("renders a true (non-straight) progression chart out of the box", () => {
    const result = derivePortfolioHistory(seed, () => undefined);
    expect(result.source).toBe("recorded");
    expect(result.series.length).toBeGreaterThanOrEqual(10);
    expect(isStraightLine(result.series.map((p) => p.close))).toBe(false);
  });

  it("is built on REAL tickers that each resolve a real sector (no 'Unclassified')", () => {
    const analytics = computePortfolioAnalytics(seed, (t) => resolveDemoSignal(t));
    // Every holding classifies - nothing falls through to the Unclassified bucket.
    expect(analytics.rows.every((r) => Boolean(r.sector))).toBe(true);
    expect(analytics.sectorAllocation.some((s) => s.label === "Unclassified")).toBe(false);
    // A real, diversified book: several distinct sectors, full holdings valued.
    expect(analytics.sectorAllocation.length).toBeGreaterThanOrEqual(5);
    expect(analytics.totalValue).toBeGreaterThan(0);
    expect(analytics.rows.every((r) => (r.marketValue ?? 0) > 0)).toBe(true);
    // Sector weights sum to ~100%.
    const sum = analytics.sectorAllocation.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThan(1.001);
  });
});

describe("cleanupPortfolios", () => {
  const brokerage = makeBook({
    id: "pf_abc123real",
    name: "Brokerage",
    holdings: [lot("NVDA"), lot("AAPL")],
  });

  it("keeps a real upload byte-for-byte and drops empty junk", () => {
    const junk = makeBook({ id: "pf_emptyjunk", name: "half deleted", holdings: [] });
    const result = cleanupPortfolios([brokerage, junk], { sampleMode: true });
    const kept = result.find((p) => p.id === brokerage.id);
    expect(kept).toBe(brokerage); // same reference - never mutated
    expect(result.some((p) => p.id === "pf_emptyjunk")).toBe(false);
  });

  it("collapses the messy tab down to exactly the real book + a repaired TESTING", () => {
    const halfDeletedTesting = makeBook({ id: "pf_xyzTest", name: "TESTING", holdings: [] });
    const emptyJunk = makeBook({ id: "pf_junk2", name: "scratch", holdings: [] });
    const publicBook = makeBook({ id: "pf_public", name: "Public", owner: "friend", holdings: [lot("TSLA")] });

    const result = cleanupPortfolios(
      [brokerage, halfDeletedTesting, emptyJunk, publicBook],
      { sampleMode: true },
    );

    expect(result).toHaveLength(2);
    expect(result.find((p) => p.id === brokerage.id)).toBe(brokerage); // byte-for-byte
    // Empty junk + public sample dropped.
    expect(result.some((p) => p.id === "pf_junk2")).toBe(false);
    expect(result.some((p) => p.owner !== "me")).toBe(false);

    // The half-deleted TESTING is repaired in place (id preserved, holdings filled).
    const testing = result.find((p) => p.id === "pf_xyzTest");
    expect(testing).toBeDefined();
    expect(testing!.name).toBe("TESTING");
    expect(testing!.holdings.length).toBeGreaterThanOrEqual(5);
    expect((testing!.valueHistory ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("preserves a real test book that already has holdings", () => {
    const workingTesting = makeBook({
      id: "pf_realtest",
      name: "testing",
      holdings: [lot("MSFT"), lot("GOOG")],
    });
    const result = cleanupPortfolios([workingTesting], { sampleMode: false });
    const kept = result.find((p) => p.id === "pf_realtest");
    expect(kept).toBe(workingTesting); // byte-for-byte
    expect(kept!.holdings.map((h) => h.ticker)).toEqual(["MSFT", "GOOG"]);
    expect(kept!.name).toBe("testing");
  });

  // The critical data-loss case the review caught: a real book a tester named
  // "Testing" must NEVER be deleted (live) or overwritten with demo lots (sample),
  // including the common watch-only (no-shares) imported shape.
  it("never deletes a real watch-only book named 'testing' in live mode", () => {
    const watchOnly = makeBook({ id: "pf_userreal", name: "testing", holdings: [watchLot("AAPL"), watchLot("NVDA")] });
    const result = cleanupPortfolios([watchOnly], { sampleMode: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(watchOnly); // byte-for-byte, never mutated
  });

  it("never overwrites a real watch-only 'Testing' book with demo lots in sample mode", () => {
    const watchOnly = makeBook({ id: "pf_userreal2", name: "Testing", holdings: [watchLot("TSLA")] });
    const result = cleanupPortfolios([watchOnly], { sampleMode: true });
    const kept = result.find((p) => p.id === "pf_userreal2");
    expect(kept).toBe(watchOnly); // real holdings preserved, not replaced by ZGIGA/ZAETHR/…
    expect(kept!.holdings.map((h) => h.ticker)).toEqual(["TSLA"]);
  });

  it("keeps a real book named TESTING and never overwrites it with the demo", () => {
    const realTesting = makeBook({ id: "pf_real", name: "TESTING", holdings: [lot("MSFT")] });
    const shippedDemo = makeBook({
      id: FAKE_TEST_PORTFOLIO_ID,
      name: "TESTING",
      holdings: [lot("ZAETHR"), lot("ZMEDX"), lot("ZVOLT")],
    });
    const result = cleanupPortfolios([realTesting, shippedDemo], { sampleMode: true });
    const kept = result.find((p) => p.id === "pf_real");
    expect(kept).toBe(realTesting); // user's real book preserved byte-for-byte
    expect(kept!.holdings.map((h) => h.ticker)).toEqual(["MSFT"]);
  });

  it("drops an empty real-id TESTING in live mode without injecting fiction", () => {
    const emptyTesting = makeBook({ id: "pf_empty", name: "TESTING", holdings: [] });
    const result = cleanupPortfolios([emptyTesting], { sampleMode: false });
    expect(result).toHaveLength(0);
  });

  it("never injects the demo into a live (sample-off) tab", () => {
    const result = cleanupPortfolios([brokerage], { sampleMode: false });
    expect(result).toHaveLength(1);
    expect(result.some((p) => p.id === FAKE_TEST_PORTFOLIO_ID)).toBe(false);
  });

  it("injects the canonical TESTING book into an empty sample tab", () => {
    const result = cleanupPortfolios([], { sampleMode: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(FAKE_TEST_PORTFOLIO_ID);
    expect(result[0]!.name).toBe("TESTING");
    expect((result[0]!.valueHistory ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("refreshes the shipped demo and de-dupes multiple TESTING copies", () => {
    const staleDemo = makeBook({ id: FAKE_TEST_PORTFOLIO_ID, name: "TESTING", holdings: [lot("ZAETHR")] });
    const dupeTesting = makeBook({ id: "pf_dupe", name: "Testing", holdings: [] });
    const result = cleanupPortfolios([staleDemo, dupeTesting], { sampleMode: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(FAKE_TEST_PORTFOLIO_ID);
    expect(result[0]!.holdings.length).toBeGreaterThanOrEqual(5);
  });
});
