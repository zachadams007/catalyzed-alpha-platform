import { describe, it, expect, vi, beforeEach } from "vitest";
import { unknownFundamentals } from "@/data/fundamentals/fundamentalsProvenance";

/**
 * A-FMP - honest live fundamentals at the FMP seam (mirrors A-1 Finnhub).
 *
 * The bug class: fetchFmpCompany built fundamentals as
 * `{ ...synthetic.fundamentals, netMargin: netMargin ?? synthetic.fundamentals.netMargin, ... }`,
 * so when FMP returned NULL for a field the record KEPT its synthetic PRNG seed
 * while fundamentalsAvailability[field] (correctly `value != null`) was false -
 * violating the prime-directive invariant
 *   fundamentalsAvailability[X] === true  IFF  fundamentals.X is a real FMP value.
 *
 * The fix: start from a NEUTRAL placeholder (unknownFundamentals()) and overwrite
 * a field ONLY when its FMP value is non-null. A missing field stays neutral -
 * never a fabricated seed.
 *
 * No financial figures are encoded here: the all-null path asserts the absence of
 * fabricated data, so there is nothing to web-verify.
 */

const mocks = vi.hoisted(() => ({
  fmpQuote: vi.fn(),
  fmpProfile: vi.fn(),
  fmpRatios: vi.fn(),
  fmpFinancialGrowth: vi.fn(),
  fmpIncomeStatement: vi.fn(),
  fmpCashFlowStatement: vi.fn(),
}));

vi.mock("@/data/fmp/fmpClient", () => mocks);

import { fetchFmpCompany } from "@/data/fmp/fmpCompany";

beforeEach(() => {
  // A live, tradable quote (so the function builds a record), but FMP returns
  // NOTHING usable for any fundamentals field.
  mocks.fmpQuote.mockResolvedValue({
    symbol: "TEST",
    name: "Test Co",
    price: 100,
    changesPercentage: 1.2,
    marketCap: 5e10,
    avgVolume: 1_000_000,
  });
  mocks.fmpProfile.mockResolvedValue({ symbol: "TEST", sector: "Technology" });
  // All fundamentals sources empty/null → every derived field resolves to null.
  mocks.fmpRatios.mockResolvedValue(null);
  mocks.fmpFinancialGrowth.mockResolvedValue(null);
  mocks.fmpIncomeStatement.mockResolvedValue(null);
  mocks.fmpCashFlowStatement.mockResolvedValue(null);
});

describe("fetchFmpCompany — never retains a synthetic seed for a missing FMP field", () => {
  it("all-null growth/margin fields → all-false availability AND neutral values", async () => {
    const company = await fetchFmpCompany("TEST");
    expect(company).not.toBeNull();
    const c = company!;

    // Every availability flag is false (matches the `!= null` source rule).
    for (const [field, available] of Object.entries(c.fundamentalsAvailability ?? {})) {
      expect(available, `availability[${field}] must be false`).toBe(false);
    }

    // Every fundamentals value equals the NEUTRAL placeholder - proving NO
    // synthetic PRNG seed leaked through the `?? placeholder.X` fallbacks.
    const neutral = unknownFundamentals();
    expect(c.fundamentals).toEqual(neutral);
  });

  it("a real FMP value flips ONLY that field available; the rest stay neutral", async () => {
    // netMargin returned this run; all other fundamentals still null.
    mocks.fmpRatios.mockResolvedValue({ netProfitMarginTTM: 0.21 });

    const company = await fetchFmpCompany("TEST");
    expect(company).not.toBeNull();
    const c = company!;

    expect(c.fundamentalsAvailability?.netMargin).toBe(true);
    expect(c.fundamentals.netMargin).toBeCloseTo(0.21, 6);

    // Every OTHER field stays unavailable and neutral - no synthetic leak.
    const neutral = unknownFundamentals();
    for (const [field, available] of Object.entries(c.fundamentalsAvailability ?? {})) {
      if (field === "netMargin") continue;
      expect(available, `availability[${field}] must be false`).toBe(false);
      expect(
        c.fundamentals[field as keyof typeof neutral],
        `fundamentals.${field} must stay neutral`,
      ).toEqual(neutral[field as keyof typeof neutral]);
    }
  });
});
