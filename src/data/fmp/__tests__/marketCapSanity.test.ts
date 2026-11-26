import { describe, expect, it } from "vitest";
import { companyFromScreenerRow } from "@/data/fmp/fmpUniverse";
import { MAX_PLAUSIBLE_MARKET_CAP, isPlausibleMarketCap } from "@/lib/format";
import { buildSyntheticCompany } from "@/engine/syntheticTicker";

/**
 * Regression guard for the "NNE $24.95T" Market-Map bug. The live universe used
 * to fall back to a SYNTHETIC market cap (price × random × 8e10 → trillions)
 * whenever a provider omitted the real cap, painting a giant garbage tile on the
 * heatmap. The live hydration must now use the REAL cap only, and drop a name
 * that has no usable cap rather than fabricate one.
 */
describe("companyFromScreenerRow — real market cap only (no synthetic fallback)", () => {
  it("uses the screener row's real market cap when sane", () => {
    const c = companyFromScreenerRow({
      symbol: "LCID",
      companyName: "Lucid Group",
      price: 2.4,
      marketCap: 6.2e9, // Lucid's real ~$6B cap
      volume: 30_000_000,
    });
    expect(c).not.toBeNull();
    expect(c!.marketCap).toBe(6.2e9);
  });

  it("DROPS a name with a missing market cap (never invents a synthetic one)", () => {
    // The exact failure mode: a row with no cap. The old code returned a company
    // sized at the synthetic baseline (trillions); the fix returns null.
    const synthetic = buildSyntheticCompany("NNE");
    expect(synthetic.marketCap).toBeGreaterThan(1e12); // proves the old fallback WAS garbage
    const c = companyFromScreenerRow({ symbol: "NNE", price: 30, volume: 1_000_000 });
    expect(c).toBeNull();
  });

  it("DROPS a name with an absurd (impossible) market cap", () => {
    const c = companyFromScreenerRow({
      symbol: "NNE",
      price: 30,
      marketCap: 24.95e12, // the reported garbage value
      volume: 1_000_000,
    });
    expect(c).toBeNull();
  });

  it("DROPS a name with a zero / non-positive market cap", () => {
    expect(companyFromScreenerRow({ symbol: "X", price: 10, marketCap: 0 })).toBeNull();
    expect(companyFromScreenerRow({ symbol: "Y", price: 10, marketCap: -5 })).toBeNull();
  });
});

describe("isPlausibleMarketCap", () => {
  it("accepts a real cap and rejects impossible / non-finite ones", () => {
    expect(isPlausibleMarketCap(3.4e9)).toBe(true);
    expect(isPlausibleMarketCap(4.5e12)).toBe(true); // a real megacap
    expect(isPlausibleMarketCap(MAX_PLAUSIBLE_MARKET_CAP)).toBe(true);
    expect(isPlausibleMarketCap(MAX_PLAUSIBLE_MARKET_CAP + 1)).toBe(false);
    expect(isPlausibleMarketCap(24.95e12)).toBe(false);
    expect(isPlausibleMarketCap(0)).toBe(false);
    expect(isPlausibleMarketCap(-1)).toBe(false);
    expect(isPlausibleMarketCap(NaN)).toBe(false);
    expect(isPlausibleMarketCap(null)).toBe(false);
    expect(isPlausibleMarketCap(undefined)).toBe(false);
  });
});
